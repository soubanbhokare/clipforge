# CLIPFORGE

AI-powered platform that turns long videos into shorts and reels:
upload → transcribe → detect the best moments → edit on a multi-track
timeline → captions and brand kit → smart reframing → export →
schedule/publish → measure performance.

**Status: Phases 1–12 built and verified. Phase 13 is documentation,
audit and launch-readiness only — no new features.**
The full application (frontend + Express API + SQLite database +
in-process background workers) runs locally. What is real, what is
stubbed, and what needs credentials is stated plainly below and in
[`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md). Nothing in
this README claims a stub is a working integration.

## Documentation

| Document | Contents |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System diagram, module map, request flow, workers, storage, media pipeline, auth model |
| [docs/SETUP.md](docs/SETUP.md) | End-to-end local setup, prerequisites, migrations, FFmpeg verification |
| [docs/PROVIDERS.md](docs/PROVIDERS.md) | STT, OAuth, email, translation and payments provider configuration |
| [docs/API.md](docs/API.md) | The actual HTTP route surface, grouped by module |
| [docs/USER_GUIDE.md](docs/USER_GUIDE.md) | End-user workflows |
| [docs/ADMIN_GUIDE.md](docs/ADMIN_GUIDE.md) | Admin bootstrap and Admin Console guide |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Symptom → cause → fix |
| [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md) | Honest known limitations (draft — lead to finalise) |
| [docs/LAUNCH_CHECKLIST.md](docs/LAUNCH_CHECKLIST.md) | Evidence-based launch checklist (draft) |
| [server/README.md](server/README.md) | Backend deep notes per phase (endpoints, pipelines, platform-app registration) |

## Feature summary — honest status

| Area | Status |
| --- | --- |
| Accounts, sessions, email verification, password reset | **Real.** Argon2id passwords, server-side sessions, single-use hashed tokens. Email delivery needs SMTP; without it mail goes to a server-side outbox file and is **not delivered** (see Providers). |
| TOTP two-factor (MFA) + recovery codes | **Real.** RFC 6238 TOTP, replay prevention, encrypted secret at rest. Email MFA is not offered. |
| Workspaces, roles, invitations | **Real.** Owner/Admin/Editor/Viewer enforced server-side; projects and brand kits are workspace-scoped. Invitation email follows the same SMTP/outbox rule. |
| Studio: projects + uploads | **Real.** Local-disk storage adapter, FFprobe-verified uploads (`.mp4`/`.mov`/`.webm`, default max 500 MB), real thumbnails. YouTube URLs are validated only — media is **never** downloaded from YouTube. Cloud import is not configured. |
| AI clip detection | **Real, local.** faster-whisper transcription (local by default), sentence/pause/scene analysis, measurable 0–100 ranking, verified FFmpeg preview cuts. No speaker diarization. An OpenAI-compatible STT endpoint can be selected instead. |
| Video editor + multi-track timeline | **Real.** Snapshot-based undo/redo, named versions, project media, render jobs. |
| Captions Studio + Brand Kit | **Real.** Styles, templates, tracks, SRT/VTT/ASS import/export, brand kits. **Automatic translation is not configured** (no provider key) and fails honestly; manual translations always work. Brand intro/outro/music are stored but **not composited into renders**. |
| Face Lock / active speaker / auto-reframe | **Real CV stack** (YuNet + YOLOv8-nano ONNX + Silero VAD via Python). Subjects are anonymous per video; no identity matching. Accuracy on real two-person conversations is **unverified**. |
| B-roll recommendations + enhancement | **Real for local media.** Transcript-driven recommendations from your own library; FFmpeg filter-chain enhancement. **Stock search, AI generation and background removal are interface stubs** (`implemented: false`) — they return `CONFIGURATION_ERROR` even if you set their env vars. Split-screen B-roll is not offered. |
| Export Studio + render queue | **Real.** MP4/WebM, H.264/H.265/VP9, AAC/Opus, MP3 audio-only, preflight + FFprobe QC gate, priority queue, ZIP bundles. |
| Publishing (YouTube / Instagram / TikTok) | **Real adapters, credential-gated.** Official APIs only, OAuth + PKCE, AES-256-GCM token storage, validation → approval → submit/schedule flow. **No provider credentials exist on this machine**, so connect/publish return `422 CONFIGURATION_ERROR` until you register developer apps (see Providers). E2E tests run against a clearly labelled local mock — not evidence of real-platform acceptance. |
| Analytics | **Real engine, credential-gated.** Capability-aware snapshots via the same platform connections; unavailable metrics are stored/displayed as unavailable, never zero. Deterministic rule-based insights (no external AI). Same credential caveat as Publishing. |
| Plans, usage, admin console | **Real.** Immutable usage ledger, admin-entered plans (seeded plans carry **no prices**), append-only audit log, live system-health checks. |
| Payments | **Disabled.** Flag-gated foundation only; checkout returns `CONFIGURATION_ERROR`. No real charging, no fake invoices. |
| Landing page media | **Empty by instruction.** Every landing image/video area is a reserved `MediaPlaceholder` (see `src/config/landingAssets.ts`). Do not re-insert demo media until the owner says to add assets. |

## Tech — as actually deployed

- **Frontend:** React 18 + TypeScript + Vite, CSS Modules, lightweight
  hash routing in `src/App.tsx` (no router dependency).
- **Backend:** Node.js + Express + TypeScript (`server/`), SQLite via
  Node's built-in `node:sqlite` (`DatabaseSync`, WAL mode).
- **Workers:** DB-backed, in-process loops started from
  `server/src/index.ts`. There is **no** PostgreSQL, Redis, BullMQ or
  Docker in this deployment — those are documented production paths
  only, and the Admin Console labels them `NOT_USED`.
- **Media:** FFmpeg / FFprobe 8.x required. STT and tracking run as
  Python child processes (`server/scripts/transcribe.py`,
  `server/scripts/track.py`).
- **Email:** nodemailer SMTP when configured, otherwise a JSON-file
  outbox under `server/data/outbox/`.

## Brand

Central tokens live in `src/styles/tokens.css` and are the only place
brand colours are defined:

- Midnight Black: `#030407` — `--midnight`
- Electric Cobalt Blue: `#1558C9` — `--cobalt`
- Acid Lime: `#D4FF24` — `--lime`

The approved logo artwork is used verbatim in code (components,
favicon, brand kit seed) — see `src/components/Logo.tsx`.

## Quick start

Prerequisites: Node.js 24, npm, FFmpeg + FFprobe on `PATH`, and (for
transcription/tracking) Python 3 with `faster-whisper`, `numpy`,
`opencv-python` and `onnxruntime` importable. Full guide:
[docs/SETUP.md](docs/SETUP.md).

```bash
# Frontend (terminal 1)
cd CLIPFORGE
npm install
npm run dev            # http://localhost:5173 — proxies /api to :3001

# Backend (terminal 2)
cd CLIPFORGE/server
npm install
cp .env.example .env   # optional; sensible dev defaults exist
npm run dev            # http://localhost:3001 — migrations run on boot
```

Other commands:

```bash
npm run build          # frontend: tsc + production build into dist/
npm run preview        # serve the production build on :4173
# in server/: npm run build | npm start | npm run test:e2e (and the
# per-phase suites test:studio, test:clips, test:editor, …)
```

## Environment

- Frontend: copy `.env.example` to `.env`. It only documents the
  optional `VITE_API_URL` override; by default the frontend calls
  `/api` same-origin via the Vite proxy.
- Server: copy `server/.env.example` to `server/.env`. It documents
  every variable the code reads (ports, SMTP, STT, OAuth, payments,
  `ADMIN_EMAILS`, …). Never put secrets in frontend files, and never
  commit a real `.env`.

## Project structure

```
CLIPFORGE/
  src/                  # React frontend (pages/, components/, services/, config/, features/)
  server/
    src/                # Express API — one module per phase (see docs/ARCHITECTURE.md)
    scripts/            # transcribe.py (faster-whisper), track.py (YuNet/YOLO/VAD)
    models/             # ONNX models: YuNet face detector, YOLOv8-nano
    data/               # SQLite DB, media, outbox, exports — local only, gitignored
    tests/              # per-phase e2e suites (node tests/*.e2e.mjs)
  docs/                 # this documentation set
  public/assets/
```

## Honest scope notes

- No fake projects, clips, views, uploads, notifications, publishing
  results or analytics are shown anywhere. Empty states say so
  plainly; unavailable metrics render as "Unavailable" with a reason.
- Progress is shown only when a real job reports it.
- The Muse-hosted preview artifact of this app has **no live
  backend** — interactive account/API features only work against the
  locally running server described above.
- Guest mode in the frontend is a UI mode only (a `sessionStorage`
  flag); it grants no server access. Application state is never kept
  in `localStorage`.
