# CLIPFORGE — Runtime Verification (Phase 13: §8, §9, §10, §2)

- **Date of run:** 2026-11-02 (Asia/Calcutta)
- **Machine:** 4 CPUs, ~7.9 GB RAM, `/tmp` is a 512 MB tmpfs
- **Method:** throwaway server instances only (ports 3220–3225), each with its
  own temp `DATABASE_FILE` / `MEDIA_DIR` / `PROCESSING_DIR` under `/tmp/rtv`.
  Instances were started exactly like the project's e2e suites do:
  `server/node_modules/.bin/tsx src/index.ts`, `cwd=server/`,
  `NODE_ENV=test`. The real `server/data` was never touched, no project e2e
  suite was run, and no application code was edited. Every number below was
  measured in this run; the setup is stated next to each measurement. No
  capacity extrapolations are made.
- **Concurrency/latency tool:** a Node `fetch` loop in the verification
  scripts (`/tmp/rtv/phaseA.mjs`, `phaseA2.mjs`, `phaseB.mjs`, `phaseB2.mjs`,
  `phaseC.mjs` during the run).

---

## §8 — Performance & load measurement

### Setup

- Instance A (port 3220) for latency + upload; instance A2 (port 3222) for the
  clean login re-measurement; instance B (port 3223) for the job batch;
  instance B2 (port 3225) for the resource snapshot.
- `MAX_UPLOAD_MB=200` on the test instances (the production default is 500;
  the Phase 3 suite uses 2 to exercise the limit path).
- **Rate-limit caveat (measured, then corrected):** with the default
  `LOGIN_RATE_MAX=10`, repeated logins past the tenth return fast `429`s, so
  a naive 50-sample login run measures the limiter, not login. The login
  numbers below are from instance A2, booted with the supported config knobs
  `LOGIN_RATE_MAX=10000` / `REGISTER_RATE_MAX=10000`
  (`server/src/config.ts`); **all 70 login responses were status-checked
  200**. The config/project-list numbers are from instance A and were not
  affected by the login limiter.

### API latency (median / p95 / max, ms)

| Endpoint | Mode | n | Median | p95 | Max |
|---|---|---:|---:|---:|---:|
| `GET /api/auth/config` | sequential | 50 | 1.5 | 2.3 | 3.0 |
| `GET /api/auth/config` | 20 concurrent | 20 | 11.0 | 13.5 | 13.7 |
| `POST /api/auth/login` (valid credentials, A2) | sequential | 50 | 14.6 | **17.4** | 20.8 |
| `POST /api/auth/login` (valid credentials, A2) | 20 concurrent | 20 | 232.0 | **257.5** | 262.9 |
| `GET /api/projects?pageSize=20` (authenticated) | sequential | 50 | 1.6 | 7.8 | 31.1 |
| `GET /api/projects?pageSize=20` (authenticated) | 20 concurrent | 20 | 8.5 | 26.2 | 26.8 |

Notes: sequential login (~15 ms) is dominated by the Argon2 password
verification. Under 20-way concurrency, login latency rises ~15× (median
232 ms) — the verifications are CPU-bound and the machine has 4 cores.
Cross-check on A2: config sequential median 1.4 ms / p95 10.9 ms;
project-list sequential median 1.4 ms / p95 1.8 ms.

### Upload throughput

- File: 19,908,781 bytes (**18.99 MB**) MP4 generated with ffmpeg
  (`testsrc2` 1280×720@30, 20 s, `libx264` at 8 Mb/s + AAC sine).
- Path: the real API flow — `POST /api/projects/:id/upload-session`, then
  multipart `POST /api/upload-sessions/:id/file`. The measured total covers
  both requests, and the file POST's response time includes the server-side
  ffprobe validation and thumbnail generation.
- **Result: HTTP 200, asset `VALID`, total 613 ms → 30.97 MB/s end-to-end.**

### Job throughput (instance B, all 7 jobs submitted concurrently)

Concurrency limits in effect (defaults, verified in code): the analysis
worker is a **single** in-process worker (`analysis.ts` `workerBusy` flag);
the render/export worker runs **`RENDER_CONCURRENCY` = 1** by default
(`editor.ts` `renderConcurrency()`, env unset). Both queues therefore
serialised, which is exactly what the queue-wait pattern shows.

Analysis jobs (real local faster-whisper `small` pipeline; source = ~5 s
espeak speech clip per job, own project each). Times from
`processing_tasks.created_at / started_at / finished_at`:

| Job | Queue wait | Processing | Total | Final status |
|---|---:|---:|---:|---|
| analysis #1 (first claimed) | 0.3 s | 22.6 s | 22.9 s | COMPLETED |
| analysis #2 | 23.0 s | 12.1 s | 35.0 s | COMPLETED |
| analysis #3 | 35.5 s | 10.7 s | 46.2 s | COMPLETED |
| analysis #4 | 46.6 s | 10.8 s | 57.4 s | COMPLETED |

The first job's processing includes the one-time whisper model load; the
steady-state processing time for a ~5 s clip was ~11–12 s on this machine.

Export jobs (480p MP4, candidate targets of one seeded project; times from
`render_jobs`):

| Job | Queue wait | Processing | Total | Final status |
|---|---:|---:|---:|---|
| export #1 | 0.1 s | 3.3 s | 3.4 s | COMPLETED |
| export #2 | 3.4 s | 3.9 s | 7.3 s | COMPLETED |
| export #3 | 7.3 s | 10.7 s | 18.0 s | COMPLETED |

**Whole batch (4 analysis + 3 exports submitted together): wall time
58,508 ms, all 7 jobs COMPLETED.**

### Resource snapshot (instance B2: 2 exports + 1 analysis job, 500 ms sampling of `/proc/<pid>/stat` + `VmRSS`, summed over the real server node process and all descendants — ffmpeg/python children included; CPU accounting is cumulative per-PID so short-lived children are not lost)

| Metric | Measured |
|---|---:|
| Server node RSS, idle (after boot + register) | 162.2 MB |
| Process-tree RSS, batch average | 531.0 MB |
| Process-tree RSS, batch peak | **850.9 MB** |
| Process-tree CPU, batch average | 120.1 % (≈1.2 cores) |
| Process-tree CPU, batch peak (500 ms window) | 149.1 % |
| Max tree size during batch | 3 processes (server + 1 worker child at a time) |
| Batch wall time (B2) | 23,717 ms |

Storage growth (instance B batch): media dir 2,202,625 → 3,298,399 bytes
(+1,095,774 bytes ≈ +1.04 MB: 7 outputs/thumbnails for the batch);
processing dir 0 → 0 bytes after the batch (all job temp dirs cleaned);
`/tmp` free space 433.3 MB → 432.3 MB over the same window.

---

## §9 — Video-processing stability matrix

All cases went through the app's **real upload path** (upload-session +
multipart file POST, server-side ffprobe validation) on instance A, one
project per case. Ground truth is ffprobe run against the fixture file
itself. The app's accepted container list (from `server/src/media.ts`,
`ALLOWED_EXTENSIONS`, also served by `GET /api/studio/config`) is
**mp4, mov, webm** — enforced at upload-session creation.

| Case | Fixture (ffprobe ground truth) | App result | Metadata match |
|---|---|---|---|
| 2 s clip | 2.00 s, 320×240, h264, 30 fps, 1×AAC | 200, asset `VALID` | duration ✓, dimensions ✓, codec ✓, hasAudio ✓, fps ✓ |
| 120 s video | 120.00 s, 320×180, h264, 15 fps, 1×AAC | 200, asset `VALID` | all ✓ |
| 1080p landscape | 3.00 s, 1920×1080, h264, 30 fps, 1×AAC | 200, asset `VALID` | all ✓ |
| Portrait 720×1280 | 3.00 s, 720×1280, h264, 30 fps, 1×AAC | 200, asset `VALID` | all ✓ |
| No-audio video | 3.00 s, 320×240, h264, 30 fps, 0 audio streams | 200, asset `VALID`, `hasAudio=false`, `audioCodec=null` | all ✓ |
| Two-audio-stream video | 4.00 s, 320×240, h264, 30 fps, **2×AAC streams** | 200, asset `VALID`, `hasAudio=true`, `audioCodec=aac` | ✓ except stream count — see note 1 |
| 24 fps | 4.00 s, h264, avg fps 24 | 200, `VALID`, `frameRate=24` | ✓ |
| 60 fps | 4.00 s, h264, avg fps 60 | 200, `VALID`, `frameRate=60` | ✓ |
| VFR source | 3.97 s, h264, avg fps 20.17 (r_frame_rate 20) | 200, `VALID`, `frameRate=20.17`, duration 3.966667 s | ✓ — app stores the average frame rate |
| MPEG-4 Part 2 codec in MP4 container | 3.00 s, **mpeg4** video, 30 fps, 1×AAC | 200, asset `VALID`, `videoCodec=mpeg4` | metadata ✓ — see note 2 |
| Truncated MP4 (first 40 % of a valid file; ffprobe: "moov atom not found") | unprobeable | **422**, error `FFprobe could not read this file.` | rejected as expected |
| Corrupt MP4 (text bytes with .mp4 name) | unprobeable | **422**, error `FFprobe could not read this file.` | rejected as expected |
| Unsupported container `.avi` | — | **400 at session creation**: "This video format is not supported … Supported formats: .mp4, .mov, .webm." | rejected as expected |
| Unsupported container `.mkv` | — | **400 at session creation** (same message) | rejected as expected |

**Note 1 — two audio streams:** the asset model stores a single
`audioCodec`/`hasAudio` pair taken from the *first* audio stream
(`media.ts` `probeFile` uses `streams.find(codec_type === "audio")`). The
second stream is not recorded anywhere in the asset metadata. Detection
("has audio") is correct; per-stream detail is lost by design of the
current schema.

**Note 2 — codec policy:** the app whitelists **containers/extensions**,
not codecs. An MP4 containing MPEG-4 Part 2 video is accepted and probed
correctly. That is consistent behaviour for an ffmpeg-based pipeline
(it can decode it), but anyone expecting a codec allow-list should note
there is none at upload time.

### End-to-end export (instance A)

Flow (the export suite's minimal API path): upload an 11.83 s espeak
speech video → editor document seeded from a candidate clip via
`GET /api/projects/:id/editor?seedCandidateId=…` → `POST
/api/projects/:id/exports` with a candidate target (first two sentences,
8.15 s — a cut of the source), 480p MP4, `captionMode: "burn"`.

- Job: **COMPLETED** in 7,332 ms (creation → terminal poll).
- Downloaded output, ffprobe: **MP4, H.264 video 480×854 @ 30 fps, 1×AAC
  audio stream, duration 8.166 s** (Δ +0.02 s vs the 8.15 s timeline —
  within tolerance).
- Audio is present **and audible**: ffmpeg `volumedetect` on the output
  measured **mean_volume −23.3 dB, max_volume −4.4 dB** (not silent).
- Server QC validation row for the job: **passed**, including
  `video-stream`, `resolution`, `audio-stream`, `duration`, `file-size`,
  `video-codec`, `container`, `audio-codec`, and **`captions-burned`**
  (pixel-verified burn-in).

---

## §10 — Background-job / queue reliability (crash simulation)

Instance C (port 3224), own temp DB/media/processing. Job under test: an
export deliberately made slow (1080p, 9:16, `maximum` quality preset,
`slow` encoder preset) so it could be killed mid-flight.

### State sequence (measured)

1. `POST /api/projects/:id/exports` → job created, status **QUEUED**.
2. Polled at
...[truncated 9200 chars]