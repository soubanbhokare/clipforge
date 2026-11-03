# CLIPFORGE — Local Setup Guide

End-to-end setup for the application **as implemented**: a Vite
frontend, an Express + SQLite backend, and in-process workers.
There is no Docker step, no database server to install, and no
separate worker process to run — if a guide or comment elsewhere
mentions PostgreSQL/Redis/BullMQ, that is the documented production
path, not this setup.

## 1. Prerequisites

| Requirement | Version / check | Needed for |
| --- | --- | --- |
| Node.js | 24.x (`node --version`) — the server uses the built-in `node:sqlite` module | Frontend + backend |
| npm | Ships with Node | Installs |
| FFmpeg + FFprobe | 8.x verified on this machine (`ffmpeg -version`, `ffprobe -version` must both succeed) | Probing, thumbnails, previews, renders, exports — the app is not functional without them |
| Python 3 | 3.12 verified (`python3 --version`) | STT + tracking child processes |
| Python packages | `faster-whisper`, `numpy`, `opencv-python` (`cv2`), `onnxruntime` — must be importable by the `python3` the server spawns (`PYTHON_BIN` can point elsewhere) | `faster-whisper` + `numpy`: transcription. `cv2` + `onnxruntime`: face/person tracking |
| ONNX models | `server/models/face_detection_yunet_2023mar.onnx` and `server/models/yolov8n.onnx` (present in this repo checkout) | Tracking jobs; missing models → tracking fails with a `CONFIGURATION` error, never a simulation |
| espeak-ng | **Tests only** (`espeak-ng --version`) | The e2e suites synthesise speech fixtures with it. Not needed to run the app. See Troubleshooting — it lives on the ephemeral apt overlay on this VM and may need reinstalling after a restart |
| Disk space | Media, DB and scratch all live under `server/data/`; heavy test runs also use `/tmp` (512 MB tmpfs here — see Troubleshooting) | — |

There is **no `requirements.txt`** in `server/` — install the Python
packages into the interpreter the server will use, e.g.:

```bash
pip3 install faster-whisper numpy opencv-python onnxruntime
python3 -c "import faster_whisper, numpy, cv2, onnxruntime; print('ok')"
```

## 2. Install

```bash
# Frontend dependencies (project root)
cd CLIPFORGE
npm install

# Backend dependencies (separate package)
cd server
npm install
cd ..
```

## 3. Configure environment (optional for local dev)

Sensible development defaults exist, so this step is optional until
you need SMTP, a different port, or provider credentials.

```bash
cp server/.env.example server/.env   # server variables (see docs/PROVIDERS.md)
cp .env.example .env                 # frontend: only the optional VITE_API_URL override
```

Key defaults (from `server/src/config.ts`): API port `3001`,
database `server/data/clipforge.db`, media `server/data/media`,
max upload 500 MB, STT provider `local-faster-whisper` with model
`small`, session TTL 12 h / 30 days remember-me.

## 4. Run the dev servers

Two terminals — both must be running:

```bash
# Terminal 1 — backend (port 3001)
cd CLIPFORGE/server
npm run dev        # tsx watch src/index.ts
# or: npm start    # same server without watch

# Terminal 2 — frontend (port 5173)
cd CLIPFORGE
npm run dev        # Vite; proxies /api → http://localhost:3001
```

Open `http://localhost:5173`. The proxy is defined in
`vite.config.ts`; because the app is same-origin through it, the
HttpOnly session cookie works without CORS configuration.

Production-style run:

```bash
cd CLIPFORGE && npm run build        # tsc + vite build → dist/
cd server && npm run build           # tsc → server/dist/
npm start                            # serve the API (NODE_ENV=production marks cookies Secure)
```

## 5. Database setup + migrations

**There is no manual migration step.** Migrations are SQL blocks in
`server/src/db.ts` (v1–v14) executed idempotently by `getDb()` on
every boot, before the server accepts traffic. First boot creates
`server/data/clipforge.db` automatically (WAL mode, foreign keys on).

Check the applied schema version:

```bash
# With the sqlite3 CLI, if installed:
sqlite3 server/data/clipforge.db "PRAGMA user_version;"
# Expected: 14

# Without the CLI, via Node's built-in module:
node --input-type=module -e \
  "import {DatabaseSync} from 'node:sqlite'; \
   const db = new DatabaseSync('server/data/clipforge.db', {readOnly: true}); \
   console.log(db.prepare('PRAGMA user_version').get());"
```

To start from a clean database in development, stop the server and
delete `server/data/clipforge.db` (+ `-wal`/`-shm`) — the next boot
recreates the full schema. This also deletes all local accounts and
project metadata (media files under `server/data/media/` are separate
and are not recreated).

## 6. Workers

**Nothing separate to run.** All background workers are in-process
loops started by `server/src/index.ts` when the API server boots:
analysis, render, tracking, Phase 8, export bundles, publishing,
analytics, and account (data export/deletion). Starting the server
(step 4) starts every worker; stopping the server stops them all.
Interrupted jobs are reconciled on the next boot (see
[ARCHITECTURE.md](ARCHITECTURE.md#worker-model--db-backed-queues-in-process)).

## 7. FFmpeg setup / verification

```bash
ffmpeg -version    # expect 8.x
ffprobe -version   # expect 8.x

# The same checks the app itself performs:
ffmpeg -hide_banner -encoders 2>/dev/null | grep -E "libx264|libvpx|libopus|aac"
ffprobe -v error -show_streams -show_format <any-real-video.mp4>
```

If `ffmpeg`/`ffprobe` are not on `PATH`, uploads fail verification,
and the Admin Console → System Health check reports FFmpeg as
`UNAVAILABLE` (it really executes the binary).

## 8. Verify the setup

1. `curl http://localhost:3001/api/health` → `{"ok":true}`.
2. Open `http://localhost:5173`, create an account. With no SMTP
   configured, the verification email is a JSON file under
   `server/data/outbox/` — that is expected local behaviour, not a
   bug (see [PROVIDERS.md](PROVIDERS.md#email)).
3. Create a project, upload a short `.mp4` with speech, run analysis:
   the job should progress through its stages and produce a
   transcript + candidate clips. If it fails at a `CONFIGURATION`
   stage, the Python/STT prerequisites in step 1 are the cause.
4. (Optional) Run a backend suite, e.g. `cd server && npm run test:e2e`.
   Speech-fixture suites additionally need `espeak-ng` (step 1).
