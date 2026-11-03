# CLIPFORGE — Observability Review (Phase 13, §14)

Status: **static code review, 2026-11-02.** Every claim below is from reading
`server/src/` and `src/` in this repository. No e2e suite was run for this
review, and no running server was probed. Where something does not exist, this
document says so — absence is a finding, not a detail to smooth over.

**Headline verdict: PARTIAL.** Real, honest health and queue visibility exists
*inside* the product (admin-gated, database-backed), but there is no
operational observability *outside* it: no structured logs, no request
correlation, no metrics, no error tracking, and no alerting at all. An operator
running this in production today would find out about most failures from a
user, not from the system.

---

## 1. Health and readiness endpoints — what exists

| Endpoint | Auth | What it actually does | Evidence |
|---|---|---|---|
| `GET /api/health` | **None (public)** | Returns exactly `{ ok: true }`. It does **not** touch the database, disk, FFmpeg, or any worker. It proves only that the Express process is up and routing. | `server/src/app.ts` — `app.get("/api/health", (_req, res) => res.json({ ok: true }))`, registered after all route modules |
| `GET /api/auth/config` | None (public) | Returns three booleans only: `emailConfigured`, `googleConfigured`, `requireEmailVerification`. No values, no internals. | `server/src/app.ts` (`auth.get("/config", …)`) |
| `GET /api/admin/system-health` | **Admin only** | Runs the full live check suite (below) and returns `{ checks, checkedAt }`. Each run is also persisted to the `system_health_checks` table. | `server/src/admin.ts` — `router.get("/admin/system-health", admin, …)`, `runSystemHealth()` |
| `POST /api/admin/providers/:key/test` | Admin only | Runs one provider's real probe (spawns binaries / HTTP probe with a 5 s timeout), stores `last_health_status` / `last_health_at` / `last_error` on `provider_configurations`, and writes a `PROVIDER_HEALTH_TESTED` audit row. | `server/src/admin.ts` |
| `GET /api/admin/overview` | Admin only | Live count queries (users, projects, jobs, failed jobs, storage bytes, open tickets, connected accounts). Not a health endpoint, but it is the closest thing to an ops summary. | `server/src/admin.ts` |

### What `/api/admin/system-health` checks (`runSystemHealth`, `server/src/admin.ts`)

Each check is **really executed**, not inferred:

- `api` — OPERATIONAL if the response is being served (tautological, but labelled as such).
- `database` — runs `SELECT 1` and reports the SQLite schema `user_version`.
- `postgresql`, `redis`, `bullmq`, `object_storage` — reported **`NOT_USED`** with an
  explanation (SQLite + in-process DB-backed workers + local disk). They are never
  faked green or red.
- `ffmpeg`, `ffprobe` — actually spawns `ffmpeg -version` / `ffprobe -version` (5 s timeout).
- `disk` — `statfs` on the database directory's volume; OPERATIONAL above 200 MB free,
  DEGRADED at or below it. **This is a status string in a response — nothing acts on it.**
- `storage` — creates (if needed) and write-tests `MEDIA_DIR`.
- `email` — OPERATIONAL if SMTP is configured (the detail explicitly says this reflects
  *configuration, not a test send*); DEGRADED in outbox mode, with the detail stating
  mail is written to server files and not delivered.
- `oauth_youtube` / `oauth_instagram` / `oauth_tiktok` — OPERATIONAL if all OAuth env
  credentials are present, otherwise `NOT_CONFIGURED` naming the **missing variable
  names** (never values).
- `token_encryption` — AES-256-GCM readiness and key mode from `tokenCrypto.ts`.
- `payments` — OPERATIONAL only when the full payments gate passes, else `NOT_CONFIGURED`
  with the missing variable names.
- `workers` — always OPERATIONAL ("workers run inside this API process") plus the
  current queue depth for **render jobs and analysis tasks only**.

### Who can see internal detail — verified

Ordinary users **cannot** see internal detail:

- The only unauthenticated health surface is `/api/health` (`{ ok: true }`) and
  `/api/auth/config` (three booleans). Neither leaks versions, paths, counts, or errors.
- Every `/api/admin/*` route sits behind `requireAdmin` (`server/src/admin.ts`), which
  first runs the normal session auth, then **re-reads the caller's user row from the
  database** and requires `is_admin = 1` and a non-suspended status. Non-admins get
  `403 { error: "Administrator access is required." }`. The frontend `isAdmin` flag
  only controls whether the console entry is *shown*; it grants nothing.
- Admin user payloads (`adminPublicUser`) deliberately exclude password hashes and
  tokens. Provider configuration stores only a secret **reference** (an env-var name,
  validated by regex); the admin PATCH route rejects secret values outright.
- The global error handler (`server/src/app.ts`) returns a generic
  `"Something went wrong on the server."` (or `"Invalid request body."` for a JSON
  syntax error) — no stack traces or SQL detail reach the client. The real error is
  logged server-side only.

**Caveat — there is no separate readiness endpoint.** `/api/health` is a liveness
probe only. There is no `/readyz`-style endpoint that fails when the database is
unreachable, the disk is full, or workers are wedged, and no health endpoint is
checked on a schedule: `system-health` runs **only when an admin opens or refreshes
that console section**. A dead database between admin visits is invisible to any
load balancer or uptime checker pointed at `/api/health`, because that route never
touches the database.

---

## 2. Structured logging — **absent**

There is no logger. No `pino`, `winston`, `bunyan`, or any logging library appears
in `server/package.json`, and no log abstraction exists in `server/src/`.

What exists instead is ~35 ad-hoc `console.*` calls:

| Form | Count / examples |
|---|---|
| Boot banner | `server/src/index.ts`: listening line + one `[config]` line (email mode, Google OAuth configured yes/no, email-verification flag) |
| Errors | `console.error("[api] unhandled error:", err)`, `"[auth] verification email failed:"`, `"[analysis] worker tick failed:"`, `"[editor] render job failed:"`, `"[publishing] worker tick failed:"`, `"[analytics] worker tick failed:"`, `"[account] audit write failed:"`, `"[account] usage write failed:"`, `"[admin] recovery email failed:"`, upload/import handler failures in `studio.ts`, `editor.ts`, `captions.ts`, `broll.ts` |
| Warnings | One: `server/src/tokenCrypto.ts` warns when token encryption falls back to its non-production key mode |
| Info | `server/src/email.ts`: `[email:outbox] wrote "<subject>" for <recipient> -> <file path>`; `server/src/analytics.ts`: boot-recovery count of re-queued sync jobs |

Properties of this logging, stated plainly:

- **Not structured.** Plain text lines with a bracketed subsystem prefix
  (`[analysis]`, `[editor]`, …). No JSON, no machine-readable fields, no severity
  field beyond which `console` method was used.
- **No timestamps in the messages themselves.** Any timestamp on a captured line
  comes from whatever captures stdout, not from the application.
- **No correlation or request IDs.** A grep for `requestId`, `correlation`,
  `X-Request-Id`, and trace headers across `server/src/` returns nothing. There is
  no request-logging middleware: HTTP method, path, status code, and duration are
  **never logged at all**. A user-reported failure cannot be traced through the
  logs; it can only be correlated after the fact via database rows (job IDs,
  audit rows, error-log tables — §4).
- **No log levels, sampling, rotation, or shipping configuration in the repo.**
  Retention and rotation are entirely the host's problem.

---

## 3. Error tracking — **absent (external); partial (in-database)**

- **No external error tracking exists.** No Sentry, Bugsnag, Rollbar, or equivalent
  SDK, DSN, or configuration anywhere in `server/src/`, `src/`, or either
  `package.json`. Unhandled errors go to `console.error` and nowhere else. Nobody
  is notified when the 500 handler fires.
- **What does exist is in-product failure records**, which are genuinely useful and
  are the reason this area is "partial" rather than empty:
  - `render_error_log` — per-render-job stage + message (`server/src/db.ts`).
  - `publishing_error_log` — per-publish-job platform, stage, code, message.
  - Job rows themselves carry `status`, `stage`, `error` / `error_code`,
    `started_at`, `finished_at` (`render_jobs`, `processing_tasks`, `tracking_jobs`,
    `phase8_jobs`, `publish_jobs`, `analytics_sync_jobs` + `analytics_sync_attempts`).
  - `system_health_checks` — history of every admin-triggered health run.
  - `provider_configurations.last_error` — last provider probe failure.
  - `admin_audit_log` — append-only record of admin and account-security events.
  - `login_events` — login/MFA/security events with IP and user-agent.
- These records are only visible to someone who goes and looks (admin console or
  direct DB access). Nothing aggregates, counts-over-time, or escalates them.

---

## 4. Metrics — **absent as metrics; counts exist as queries**

- No metrics library, no `/metrics` endpoint, no Prometheus/OpenTelemetry, no
  histograms or counters for request rate, latency, or error rate.
- No latency is measured anywhere: no response-time middleware, no per-job
  duration metric is exported (job rows do carry `started_at`/`finished_at`, so a
  duration *can* be derived per job from the database, but nothing computes or
  charts it).
- The admin **Overview** (`GET /api/admin/overview`) computes point-in-time counts
  on demand: total/active/suspended users, workspaces, projects, media assets,
  analysis/tracking/export job totals, completed exports, **failed jobs (render +
  analysis + publishing summed)**, published posts, connected accounts, storage
  bytes (summed from `source_assets` + completed `export_outputs` + `project_media`
  file sizes), and open support tickets. These are snapshots at page-load, not a
  time series; there is no history, threshold, or trend.

---

## 5. Worker and queue visibility

Eight in-process, DB-backed workers are started in `server/src/index.ts`:
analysis, render, tracking, Phase 8 (B-roll/enhancement), export-bundle,
publishing, analytics, and account (data-export/deletion). All poll the SQLite
database on short interval timers (1 s ticks for publishing/analytics/account;
500 ms for renders); all perform boot recovery for interrupted jobs.

**Admin visibility (Admin Console → Jobs):**

| View | Backend | Shows |
|---|---|---|
| Processing jobs | `GET /api/admin/jobs` | Latest 60 each of analysis, tracking, and Phase 8 jobs: id, user, project, status, created/updated |
| Render queue | `GET /api/admin/render-queue` | Latest 200 render/export jobs incl. `stage`, `worker_id`, started/finished times |
| Publishing jobs | `GET /api/admin/publishing-jobs` | Latest 200 publish jobs incl. platform, status, scheduled time |
| Overview + System health | above | Failed-job total; render + analysis queue depth |

**User visibility (own data only):** users see their own render/export queue
(Export Studio → Rendering queue, with stage and progress), their own publishing
queue/calendar/history, and their own analytics sync status. This is per-user
product UI, not operations tooling.

**Limits:** the admin Jobs views are capped lists, not a queue console — there is
no aggregate queue-depth number per queue (except render + analysis inside the
health check), no oldest-waiting-job age, no per-worker liveness/heartbeat (the
`worker_id` on a render job identifies *which process claimed it*, not whether
that process is still alive), no retry/dead-letter view, and no way to act on a
job from the admin Jobs screens. Analytics sync jobs, account jobs
(data-export/deletion), translation jobs, and export-bundle jobs have **no admin
list view at all**.

---

## 6. Log redaction

- **No password, token, secret, or Authorization value is logged anywhere found.**
  A grep for logging calls near credential terms across `server/src/` returns no
  offending call. Passwords are Argon2id-hashed; session/verification/reset tokens
  are stored only as SHA-256 hashes; OAuth tokens are AES-256-GCM-encrypted at rest
  (`tokenCrypto.ts`) and never returned to the frontend; provider config stores env
  var *names*, not values; health output names missing env vars, never their values.
- **There is, however, no redaction layer** — safety here is by author discipline
  at each call site, not by a formatter that strips known-sensitive keys. Two
  things an operator should know:
  1. The outbox log line includes the **recipient email address** and the mail
     subject, and the outbox JSON files on disk contain the full message body —
     including verification/reset **links with live tokens** (`server/src/email.ts`).
     That directory (`server/data/outbox/`) must be treated as secret-bearing.
  2. `console.error(..., err)` logs whole error objects. Today the error paths are
     internal (FFmpeg, DB, mail), but a future provider error object that echoes a
     request header would land in stdout unfiltered.

---

## 7. Alerting — **does not exist**

There is no alerting of any kind: no alert rules, no thresholds evaluated in code,
no webhook/PagerDuty/Opsgenie/Slack/email-to-operator path, and no scheduled
health evaluation. `runSystemHealth` executes only on an admin's request. The
in-app notification system (`accountCore.notify`) notifies *end users about their
own jobs*; it never notifies an operator about system state.

### What an operator must add before calling this production-observed

1. **External uptime/readiness probing** — probe a database-touching endpoint (or
   add one); `/api/health` alone will report "ok" over a dead database.
2. **Log capture and search** — ship stdout somewhere retained and searchable, and
   alert at minimum on `[api] unhandled error` and every `* tick failed` /
   `* job failed` pattern.
3. **Scheduled health evaluation** — call `GET /api/admin/system-health` on a timer
   from outside (with an admin session) or add a scheduler in-process, and alert on
   any `UNAVAILABLE` / `NOT_CONFIGURED`-unexpected / disk `DEGRADED` result.
4. **Queue and failure watchers** — periodic SQL or API checks for: render/analysis
   queue depth and oldest QUEUED age, jobs stuck in RUNNING beyond a sane bound,
   failed-job rate, analytics sync jobs exhausting retries, and platform accounts
   whose `token_expires_at` has passed while still marked CONNECTED.
5. **Disk watermark alerting** — the health check knows free MB; nothing acts at
   200 MB, and renders/uploads will fail ungracefully at 0.

Do not claim alerts work until each of the above exists and has fired in a test.

---

## 8. Gap list against the §14 monitoring list

| Spec item | State | Notes |
|---|---|---|
| API errors | **Gap** | 500s are `console.error` only. No count, rate, endpoint breakdown, or tracking service. |
| API latency | **Gap** | Not measured anywhere — no middleware, no percentiles, no per-route timing. |
| Queue depth | **Partial** | Render + analysis depth appears in the admin health check; other queues (tracking, Phase 8, publishing, analytics, account, bundles) have list views at best, no depth/age metric. |
| Failed jobs | **Partial** | Counted in admin Overview (render + analysis + publishing); per-job errors are stored (`render_error_log`, `publishing_error_log`, job `error` fields). No rate, no alert, no admin view for analytics/account/Phase 8 failures in one place. |
| FFmpeg failures | **Partial** | FFmpeg *availability* is health-checked by really spawning it; FFmpeg *job* failures land in render job `error` + `render_error_log`. No aggregation by failure stage or code. |
| Storage capacity | **Partial** | Health check reports free MB on the data volume with a 200 MB DEGRADED line; Overview reports bytes used by three media tables. No growth trend, no per-directory breakdown (media vs processing vs reports vs exports vs outbox), no alert, no quota enforcement. |
| OAuth token expiry | **Partial** | `token_expires_at` is stored per platform account and tokens are refreshed lazily on use (`publishing.ts`), with a user-triggered account refresh. Health checks only verify that OAuth *credentials* exist — **no check lists accounts whose tokens have expired or whose refresh has failed**, and a CONNECTED-but-dead account is discovered at publish/sync time, not before. |
| Analytics sync failures | **Partial** | Sync jobs/attempts, retry with backoff (max attempts + base delay in config), and per-metric availability are recorded in the DB and visible to the owning user; the admin console has no analytics-sync view and nothing alerts on exhausted retries. |
| Worker liveness | **Gap** | Workers are loops in the API process — if the process lives, they are assumed live. No heartbeat rows; a wedged tick surfaces only as its `console.error` line. |
| Request correlation | **Gap** | No request IDs anywhere; logs, audit rows, and job rows cannot be joined by a single ID from an HTTP request. |
| Error tracking / alerting | **Gap** | Neither exists (see §3, §7). |

---

## 9. Bottom line for the operator

What you have: an honest, admin-gated, in-product health/queue/usage console and
good per-job failure records in the database. What you do not have: anything that
notices a problem before a human opens that console. Treat §7's five additions as
launch blockers for any deployment whose failures matter.
