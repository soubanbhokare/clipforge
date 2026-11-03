# CLIPFORGE Server — Phase 2 (Authentication) + Phase 3 (Studio) + Phase 4 (AI Clip Detection)

Express + TypeScript API for CLIPFORGE accounts, sessions, email
verification and password recovery (Phase 2), Studio projects,
real video uploads with FFprobe metadata, and YouTube URL validation
(Phase 3), plus the Phase 4 AI clip-detection pipeline: real
transcription, sentence/pause/scene analysis, measurable ranking and
FFmpeg-generated candidate preview clips.

## Run it

```bash
cd server
cp .env.example .env   # optional; sensible dev defaults exist
npm install
npm run dev            # tsx watch, http://localhost:3001
npm start              # same server without watch
npm run build          # type-check + emit dist/
npm run test:e2e       # end-to-end auth suite (starts its own server)
```

Migrations run automatically on boot. The frontend dev server proxies
`/api` to this server (see `vite.config.ts`), so with both running the
app is same-origin: `npm run dev` in the project root (port 5173) plus
`npm run dev` here (port 3001).

## Endpoints (all under `/api/auth`)

| Method | Path                  | Notes |
| ------ | --------------------- | ----- |
| GET    | `/config`             | `{ emailConfigured, googleConfigured, requireEmailVerification }` — honest integration status, booleans only |
| GET    | `/csrf`               | Sets `cf_csrf` cookie, returns `{ csrfToken }` |
| POST   | `/register`           | Creates an unverified account, issues a verification email |
| POST   | `/verify-email`       | `{ token }` — single-use, expiring, hash-stored |
| POST   | `/resend-verification`| Auth required, rate-limited, generic response |
| POST   | `/login`              | Generic 401 on any credential failure |
| POST   | `/logout`             | Revokes the session row, clears the cookie |
| GET    | `/me`                 | Current user or 401 |
| POST   | `/forgot-password`    | Always the same generic 200 response |
| POST   | `/reset-password`     | Validates token, rotates password, revokes all sessions |

Every mutating request must carry the CSRF double-submit header
`X-CSRF-Token` matching the `cf_csrf` cookie (see `GET /csrf`).

## Endpoints — Phase 3 Studio (all require a session)

| Method | Path                              | Notes |
| ------ | --------------------------------- | ----- |
| GET    | `/api/studio/config`              | Upload limits, formats, integration status |
| POST   | `/api/projects`                   | Create project; `Idempotency-Key` header prevents duplicates |
| GET    | `/api/projects`                   | List own projects: `search`, `workflow`, `status`, `sort`, `page`, `pageSize` |
| GET    | `/api/projects/:id`               | Project + current source asset (404 for other users) |
| PATCH  | `/api/projects/:id`               | Rename, settings (Zod-validated per workflow), AI instruction |
| DELETE | `/api/projects/:id`               | Deletes the project AND its stored files |
| DELETE | `/api/projects/:id/source`        | Remove source files/assets/sessions, back to DRAFT |
| POST   | `/api/projects/:id/upload-session`| Declares filename+size; validates format and `MAX_UPLOAD_MB` |
| GET    | `/api/upload-sessions/:id`        | Session status (lazy-expires stale sessions) |
| POST   | `/api/upload-sessions/:id/cancel` | Cancels; the pending asset is removed |
| POST   | `/api/upload-sessions/:id/file`   | Multipart upload → FFprobe verification → metadata + thumbnail |
| GET    | `/api/source-assets/:id/stream`   | Media bytes, owner only (404 otherwise) |
| GET    | `/api/source-assets/:id/thumbnail`| Real extracted frame, owner only |
| POST   | `/api/youtube/validate`           | URL validation + honest 5-status report; NEVER imports media |

Run the Phase 3 suite with `npm run test:studio`.

## Upload & storage model (Phase 3)

- Uploads use a clearly identified **local development storage
  adapter**: binaries live under `MEDIA_DIR` (default
  `server/data/media/<userId>/<assetId>.<ext>`, gitignored) — never
  in the database, which stores only the storage key + metadata.
- An upload only succeeds after FFprobe verifies a real video stream;
  duration, codecs, resolution, frame rate, bitrate and audio-stream
  presence are stored as source metadata. Corrupted files are marked
  FAILED with an actionable error and the binary is deleted.
- A real thumbnail frame is extracted with FFmpeg and served only
  through the ownership-checked thumbnail endpoint.
- Supported input formats: `.mp4`, `.mov`, `.webm` (what FFprobe here
  verifies). `MAX_UPLOAD_MB` (default 500) is enforced both when the
  session is created and by the multipart parser.
- Upload sessions expire after 30 minutes (`UPLOAD_SESSION_TTL_MINUTES`).
- YouTube: only URL parsing/validation plus optional Data API
  *metadata* (`YOUTUBE_API_KEY`) exists. There is deliberately no
  scraping, stream extraction or importing — a validated link leaves
  the project in `REQUIRES_SOURCE_FILE` until the user uploads their
  own original file.
- Cloud import is not configured: the API reports
  `cloudImportConfigured: false` and the UI shows a labelled
  not-configured state.

## Security model

- Passwords: Argon2id hashes (`@node-rs/argon2`). Raw passwords are
  never stored or logged.
- Sessions: the `cf_session` cookie is HttpOnly, SameSite=Lax, Secure
  in production. Its value is a 32-byte random token; the database
  stores only the token's SHA-256 hash plus a server-side expiry
  (12 hours, or 30 days with "remember me").
- Verification/reset tokens: random, single-use, expiring (24h / 30m),
  stored only as SHA-256 hashes, never returned by the API.
- Rate limits on login, registration, password reset and resend.
- Zod validation on every input; 100kb JSON body limit; security
  headers; CORS (credentials) only for the localhost dev frontend.
- Ordinary signup can never create an admin — there is no role column
  and no privileged account path in this phase.

## Email

`src/email.ts` is a replaceable adapter with two implementations:

- **SMTP (nodemailer)** when `SMTP_HOST` is set in `.env`.
- **Outbox (default in development)**: each email is written as a JSON
  file under `server/data/outbox/` (gitignored, server-only) and
  logged. Nothing is delivered in this mode, and the API/UI say so:
  `/api/auth/config` reports `emailConfigured: false`, and the
  forgot-password screen shows an honest "email delivery is not
  configured" note instead of claiming a send.

## Google OAuth

Not active. `/api/auth/config` reports `googleConfigured` from the
environment; the UI renders a disabled, clearly labelled
"Google sign-in is not configured" control until real credentials, a
valid redirect URI and a server-side callback flow are all in place.
There is deliberately no fake OAuth flow.

## Endpoints — Phase 4 AI Clip Detection (all require a session)

| Method | Path                              | Notes |
| ------ | --------------------------------- | ----- |
| GET    | `/api/analysis/config`            | `{ provider, configured, model, detail, speakerDiarization: false, wordTimestamps }` — honest provider status |
| POST   | `/api/projects/:id/analysis`      | Create job `{ sourceAssetId, prompt?, language? }`; an identical active job is returned instead of duplicated (200, `deduplicated: true`) |
| GET    | `/api/projects/:id/analysis`      | The project's jobs, newest first |
| GET    | `/api/analysis/:jobId`            | Persisted job status/stage/outcome (refresh recovery) |
| POST   | `/api/analysis/:jobId/cancel`     | Cancels a queued or running job (running child processes are killed) |
| POST   | `/api/analysis/:jobId/retry`      | Re-queues a FAILED/CANCELLED job after removing its prior artifacts |
| GET    | `/api/projects/:id/transcript`    | Latest transcript + segments (speaker always null) + topic segments, or `{ transcript: null }` |
| GET    | `/api/projects/:id/candidates`    | Candidate clips; `?sort=score` (default) or `?sort=start` |
| PATCH  | `/api/candidates/:id`             | Edit title, or `status` SELECTED/REMOVED (owner only, 404 otherwise) |
| GET    | `/api/candidates/:id/preview`     | The verified FFmpeg preview cut, owner only |

Run the Phase 4 suite with `npm run test:clips`.

## Clip-detection pipeline (Phase 4)

Jobs are rows in `processing_tasks` (migration v3, `src/db.ts`),
executed one at a time by an in-process worker (`src/analysis.ts`,
started from `src/index.ts`) through the persisted stages
`QUEUED → VALIDATING → EXTRACTING_AUDIO → TRANSCRIBING → ANALYZING →
DETECTING_CLIPS → RANKING → GENERATING_PREVIEWS → COMPLETED`
(`FAILED` / `CANCELLED` from any stage). Jobs left mid-flight by a
server restart are marked FAILED ("interrupted by server restart")
so they can be retried — never silently shown as running.
Production path: the same job rows map to PostgreSQL drained by
BullMQ/Redis workers; Redis/BullMQ do **not** run in this environment.

- **Transcription** (`src/stt.ts`): provider adapter. Default
  `local-faster-whisper` spawns `scripts/transcribe.py`, which decodes
  the FFmpeg-extracted 16 kHz mono WAV itself (stdlib `wave` + numpy →
  float32 array) because faster-whisper's PyAV decode path is broken
  on this machine. `WHISPER_MODEL` defaults to `small`; the project
  language setting is passed as a hint. An `openai-compatible`
  provider (STT_API_BASE + OPENAI_API_KEY) is available; when the
  selected provider is not configured the job fails at a
  CONFIGURATION stage with the reason — transcripts are never faked.
  Neither provider diarizes: `speaker` is stored NULL and the UI says
  speaker identification is unavailable.
- **Analysis**: sentence units come from real word timestamps;
  pauses from `ffmpeg silencedetect`; scene changes from
  `ffmpeg select='gt(scene,0.4)',showinfo`. Clip windows start and end
  on sentence boundaries only — never fixed-interval, never
  mid-sentence.
- **Ranking**: 0–100 from measurable signals only (speech density,
  sentence completeness, pause-aligned boundaries, duration fit,
  average word confidence when the provider reports it, opening-hook
  pattern). Every candidate stores its reasons. The user's optional
  instruction adds a bounded boost when its keywords or a known intent
  pattern (questions & answers, educational markers, motivational
  language, …) actually match the transcript, with a reason citing
  the match. Suggested titles are taken from the candidate's own
  first sentence.
- **Previews**: genuine FFmpeg cuts (H.264 + AAC, source audio
  preserved) under `MEDIA_DIR/<userId>/clips/`, each verified with
  FFprobe (streams present, duration within 1s) before being marked
  READY; failures mark the candidate's preview FAILED with the error.
  A `GeneratedClip` is a candidate whose preview is READY. The
  original upload is never modified.
- A video with no detectable speech completes honestly with outcome
  `NO_SPEECH` and zero candidates.

## Production database path

Development uses **SQLite** via Node's built-in `node:sqlite`
(`DatabaseSync`) because this machine has no PostgreSQL. The schema in
`src/db.ts` is portable SQL modelling exactly the spec's tables
(`users`, `sessions`, `email_verification_tokens`,
`password_reset_tokens`). For production, provision PostgreSQL, create
the same tables (timestamps become `timestamptz`, `COLLATE NOCASE`
becomes a citext/lower-index on email), and re-point `src/db.ts` —
no API or frontend changes are needed.

## Endpoints — Phase 10 Publishing (all require a session unless noted)

- `GET /api/publishing/providers` — per-platform implemented/configured
  status + missing env variable NAMES.
- `GET /api/publishing/settings` — configuration summary (names only),
  token-encryption mode, public app URL.
- `GET /api/publishing/accounts` — the caller's connected accounts
  (status/scopes/expiry only — never token material).
- `POST /api/publishing/accounts/:platform/connect` — starts OAuth:
  returns the official authorize URL (state + PKCE S256 for
  Google/TikTok; state for Instagram Login). 422 CONFIGURATION_ERROR
  when the provider's credentials are not configured.
- `GET /api/publishing/oauth/:platform/callback` — top-level OAuth
  callback (no session; the server-stored state is the protection).
  Exchanges the code server-side, stores AES-256-GCM-encrypted tokens,
  and redirects back to the app with `pub_connected` / `pub_error`.
- `DELETE /api/publishing/accounts/:accountId?confirm=true` —
  disconnect: best-effort provider revocation, stored tokens deleted,
  the account row is kept as DISCONNECTED so history survives.
- `POST /api/publishing/accounts/:accountId/refresh` — forces a real
  token refresh round-trip.
- `GET /api/publishing/accounts/:accountId/capabilities?fresh=1` —
  live platform capabilities (YouTube categories, TikTok creator info,
  Instagram eligibility), snapshotted to
  `platform_capability_snapshots`.
- `POST /api/publishing/jobs` — create a DRAFT from a COMPLETED Phase 9
  export + a connected account (+ optional clip). `Idempotency-Key`
  header dedupes.
- `GET /api/publishing/jobs/:jobId`, `PUT .../metadata`,
  `DELETE ...?confirm=true`, `POST/DELETE .../thumbnail` (YouTube
  custom thumbnail, PNG/JPEG magic-byte sniffed, 2 MB cap).
- `POST /api/publishing/jobs/:jobId/validate` — §6 validation against
  LIVE platform limits; results persist in `post_validation_results`.
  A failed validation leaves the job in DRAFT — it can never submit.
- `GET /api/publishing/jobs/:jobId/preview` — the approval-screen
  payload (job + account + validation + capabilities).
- `POST /api/publishing/jobs/:jobId/approve` — requires
  `rightsConfirmed: true` (§15); only from AWAITING_APPROVAL with a
  passing validation.
- `POST /api/publishing/jobs/:jobId/submit` — publish now (approved
  jobs only; a second submit is a 409).
- `POST /api/publishing/jobs/:jobId/schedule` — body
  `{ scheduledForUtc }` or `{ scheduledForLocal, timezone }` (stored
  as UTC). YouTube + private ⇒ native scheduling via
  `status.publishAt` (labelled "Scheduled on YouTube"); everything
  else is CLIPFORGE-scheduled (labelled "Scheduled in CLIPFORGE").
- `PATCH /api/publishing/schedules/:scheduleId`, `POST
  /api/publishing/jobs/:jobId/cancel-schedule`, `.../cancel`,
  `.../retry`, `.../status-check`.
- `GET /api/publishing/queue?status&platform&accountId&projectId`,
  `GET /api/publishing/calendar?from&to&...` (events carry stored UTC;
  `publishing_calendar_events` is a VIEW over scheduled_posts +
  publish_jobs), `GET /api/publishing/history`,
  `GET /api/publishing/jobs/:jobId/attempts`,
  `GET/POST /api/publishing/jobs/:jobId/metrics[/sync]`.
- Webhooks (CSRF-exempt; the provider signature is the auth):
  `GET/POST /api/publishing/webhooks/meta` (hub challenge +
  X-Hub-Signature-256 HMAC; 503 when META_APP_SECRET is unset) and
  `POST /api/publishing/webhooks/tiktok` (TikTok-Signature HMAC).
  Events are stored idempotently in `platform_webhook_events`.

## Publishing engine (Phase 10)

- **Providers** (`src/providers.ts`): one adapter interface over the
  official APIs only — YouTube Data API v3 (resumable upload with
  session recovery, `videos.insert` + `status.publishAt`,
  `thumbnails.set`, `videos.list` status/statistics), Instagram
  (Instagram Login → long-lived token, resumable container upload →
  status → `media_publish` → permalink; Business/Creator only),
  TikTok Content Posting API (`creator_info/query` FIRST — privacy
  options and limits come from its response — then init → chunked
  FILE_UPLOAD → status/fetch). No scraping, no browser automation.
- **Configuration honesty**: a provider with missing credentials is
  reported `configured: false` with the missing variable names, its
  connect endpoint returns 422 CONFIGURATION_ERROR, and the UI
  disables Connect. There are no simulated accounts or posts.
- **Tokens** (`src/tokenCrypto.ts`): AES-256-GCM envelopes in
  `oauth_token_records`; key from `TOKEN_ENCRYPTION_KEY` (base64,
  32 bytes) or a generated `server/data/.token-key` dev file (0600,
  warning logged). Token values never appear in API responses, logs
  (payloads are redacted before persistence) or the frontend.
- **Approval gate**: nothing submits without validation PASS +
  explicit approval with a rights confirmation. Editing metadata
  after approval resets the job to DRAFT — re-validate, re-approve.
- **Scheduler**: the publishing worker follows the project's
  DB-backed worker pattern (SQLite; BullMQ/Redis is the documented
  production path). It atomically claims due jobs (conditional
  UPDATE), re-validates at submission time, and at boot recovers
  interrupted jobs: VALIDATING → QUEUED; an UPLOADING job with a
  recorded provider id becomes SUBMITTED (status-polled); one without
  becomes FAILED with an explicit "verify on the platform" error —
  never silently re-sent.
- **Ambiguity rule**: if the network fails after a submission may
  have reached the platform, the job is marked ambiguous and the
  engine recovers the outcome from the platform (YouTube resumable
  session status query, TikTok status by publish_id, Instagram
  container status) before any retry. A blind re-upload never
  happens. Transient errors retry with exponential backoff (max 3).
  A 401/invalid_grant moves the job AND the account to AUTH_REQUIRED.
- **Analytics foundation**: `post_analytics_snapshots` rows are
  created at publish with NULL metrics and status "unavailable" —
  unavailable is never rendered as zero. YouTube statistics sync via
  `videos.list?part=statistics`. Instagram metrics stay unavailable
  (the insights scope is deliberately not requested) and TikTok
  metrics require the separate Research API — both say so plainly.

## Registering the real platform apps (required before any real use)

Nothing in this phase can touch a real platform until the owner
registers developer apps and the platforms approve them:

- **YouTube**: Google Cloud project → enable YouTube Data API v3 →
  OAuth consent screen + Web OAuth client. Redirect URI:
  `http://localhost:3001/api/publishing/oauth/youtube/callback`
  (or your deployed server origin). Scopes:
  `https://www.googleapis.com/auth/youtube.upload` +
  `https://www.googleapis.com/auth/youtube.readonly`. Set
  `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`.
  Unverified apps are capped and uploads may be locked private until
  Google's API verification/audit is complete.
- **Instagram**: Meta developer app → add the Instagram API product
  (Instagram Login). Redirect URI:
  `http://localhost:3001/api/publishing/oauth/instagram/callback`.
  Scopes: `instagram_business_basic`,
  `instagram_business_content_publish`. Set `META_APP_ID` /
  `META_APP_SECRET` (+ `META_WEBHOOK_VERIFY_TOKEN` for webhooks).
  Only Business/Creator accounts can publish; App Review is required
  for public use.
- **TikTok**: TikTok developer app → Login Kit + Content Posting API.
  Redirect URI: `http://localhost:3001/api/publishing/oauth/tiktok/callback`.
  Scopes: `user.info.basic`, `video.publish`. Set
  `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET`. Until TikTok's audit
  approves the app, the API restricts posts to private (SELF_ONLY) —
  CLIPFORGE reads that from creator info and enforces it.
- Set `PUBLIC_APP_URL` to the app origin the server redirects to
  after OAuth, and `TOKEN_ENCRYPTION_KEY` in production.

**Unavailable until those credentials + approvals exist**: real
account connections, real uploads to all three platforms, real
native YouTube scheduling against a real channel, real webhook
delivery (needs a public HTTPS URL), and TikTok public posting
(needs the audit). The e2e suite (`npm run test:publish`) exercises
the full mechanics against a local MOCK provider and is labelled as
such — it is not evidence of real platform acceptance.

## Endpoints — Phase 11 Analytics (all require a session)

Base `/api/analytics`. Every record is ownership-checked; one user
can never read, sync, compare or download another user's analytics.

- `GET /definitions` — the metric catalogue (name, unit, definition,
  platform meaning, source) that reports and formulas cite.
- `GET /capabilities`, `POST /capabilities/refresh` — per-account
  capability detection (§6): endpoints, metrics, dimensions,
  required permissions and limitations, computed from the granted
  scopes + account type BEFORE any metric request is made.
- `GET /overview` — KPI totals for a range with previous-period
  comparison, the engagement rate (formula shown), publishing
  summary, per-account last-sync and data-quality warnings. Totals
  carry their basis (`range_activity`, `daily_activity`,
  `counter_delta`, `lifetime_counter`, `gauge`).
- `GET /platform-comparison` — platforms side by side, never merged;
  views and reach are never added together; differing engagement
  component sets are flagged, not blended.
- `GET /trends` — time series from SAVED records only (daily
  activity rows + per-day counter deltas). Missing days are gaps,
  never invented points.
- `GET /posts`, `GET /posts/:id`, `GET /posts/:id/history`,
  `POST /posts/compare`, `GET/POST/DELETE /posts/comparison-groups`
  — published-post performance, full snapshot history (including
  availability rows and correction flags) and same-range comparison.
- `GET /top-content` — ranking by a chosen available metric;
  posts missing that metric are listed separately as unavailable.
- `GET /content-analysis` — CLIPFORGE production attributes (source
  project, template, hook text presence, reframe mode, B-roll and
  enhancement use, platform, publish time, duration, aspect ratio)
  grouped against saved outcomes. Small groups are flagged; the API
  states correlation is not causation.
- `GET /posting-times` — best observed day/hour buckets in the
  account timezone. Below 10 published posts it returns an honest
  insufficient-sample response instead of a recommendation.
- `GET /insights`, `GET /insights/:id`, `POST /insights/generate`,
  `POST /insights/:id/dismiss`, `POST /insights/:id/save` —
  deterministic, rule-based insights over stored data. Every insight
  carries its evidence rows, sample size, comparison basis and
  limitations. Rules: post ≥1.5× the account median (≥5 posts),
  period metric change ≥20% between complete equal periods, platform
  publishing volume, recurring title terms among top posts (≥8
  posts, labelled correlation), and a posting-time observation when
  the sample gate passes. No external AI API is used, no explanation
  is invented, and no insight predicts performance or virality.
- `POST /sync`, `GET /sync/jobs`, `GET /sync/jobs/:id`,
  `POST /sync/jobs/:id/retry`, `POST /sync/jobs/:id/cancel`,
  `GET /sync/history` — the sync system (§17/§18).
- `GET/PUT /settings` — automatic sync frequency (off / 6h / daily /
  weekly) + default report format.
- `POST /reports`, `GET /reports`, `GET /reports/:id`,
  `GET /reports/exports/:exportId/download` (owner-checked),
  `DELETE /reports/:id?confirm=true` — the report builder: CSV
  (native), XLSX (`exceljs`) and PDF (`pdfkit`), generated in the
  background worker from saved records only, with metric
  definitions, source notes and last-sync timestamps included.

## Analytics engine (Phase 11)

- **Sources are never mixed.** YouTube Analytics `reports.query`
  (date-scoped activity) and YouTube Data API statistics (lifetime
  counters) are stored as separate rows with separate source labels;
  a metric the Data API does not expose (e.g. shares) is stored as
  `unavailable` with the reason, next to the Analytics value — never
  merged, never zero.
- **Unavailable ≠ zero, structurally.** `analytics_metric_values`
  enforces it by convention verified in tests: unavailable rows
  always have a NULL value + a reason; ok rows always have a value.
  The UI renders unavailable as "Unavailable" with the reason.
- **Engagement (§10)** is computed exactly as
  `(likes + comments + shares [+ saves where the platform exposes
  them]) / reach × 100` or `/ views × 100`. The formula is always
  displayed; a missing component or a zero denominator yields N/A
  with the reason — never 0%, never an estimate.
- **Snapshots (§9/§19)** are append-only history with full
  provenance (user, platform, account, post, metric, unit,
  definition, date range, collection time, source, API version,
  availability). A sync's own rows are replaced idempotently on
  retry; date-scoped activity rows are replaced by the newest
  collection for the same day/range (no double counting);
  cumulative-counter decreases are stored with `correction_flag = 1`
  and contribute 0 growth, never negative growth.
- **Sync (§17/§18)** runs on the DB-backed worker with the spec's
  state machine (QUEUED → VALIDATING_ACCOUNT →
  FETCHING_ACCOUNT_DATA → FETCHING_POST_DATA → FETCHING_METRICS →
  NORMALIZING_DATA → SAVING_SNAPSHOTS → COMPLETED / PARTIAL_SUCCESS /
  FAILED / CANCELLED / AUTH_REQUIRED, plus GENERATING_REPORT for
  report jobs). Only transient failures (rate limits, network, 5xx)
  retry, with exponential backoff; 429s are classified RATE_LIMITED.
  A revoked/expired grant moves the job AND the account to
  AUTH_REQUIRED. Duplicate active syncs for the same scope are
  deduplicated. Interrupted jobs are recovered at boot — analytics
  syncs are read-only, so re-running one is always safe.
- **Per-platform truth today**: YouTube analytics metrics need the
  `yt-analytics.readonly` scope (Phase 10 connected with upload +
  readonly only, so until a reconnect grants it, those metrics are
  "unavailable" with the scope named and only Data API counters
  sync); Instagram insights need
  `instagram_business_manage_insights` (deliberately not requested in
  Phase 10 — same honest state); TikTok post metrics need
  `video.list` (not requested in Phase 10). Followers sync on all
  three with the existing scopes. TikTok exposes no reach, saves or
  watch time via the Display API — those are "unsupported", and the
  Research API is not used as a substitute.
- **Credentials pending**: §22 items 1–11 (real YouTube/Instagram/
  TikTok account acceptance) require the registered developer apps
  from the Phase 10 section above plus the additional scopes listed
  here. The e2e suite (`npm run test:analytics`) exercises the full
  mechanics against a clearly-labelled LOCAL MOCK analytics
  provider — it is not evidence of real platform acceptance.
