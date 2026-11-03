# CLIPFORGE — Cost & Resource Management (Phase 13, §19)

Status: **code-grounded inventory, 2026-11-02.** Deployment shape being
costed: a single server process (Express + eight in-process DB-backed
workers) on one machine, SQLite, all media on local disk, local AI
(STT + CV) on local CPU. There is no cloud bill today — so this document
maps **resource consumption surfaces** to **what is actually measured**,
and is explicit about what is not measured. **No monetary cost estimates
are given**: the only honest inputs would be a chosen host's CPU/disk
prices and real per-provider API prices, none of which are fixed in this
repo. Where a formula is possible without inventing prices, the unit math
is stated instead (§6).

**Headline verdict: measurement is good for *accounting*, absent for
*enforcement*.** The immutable usage ledger records the main billable-style
units with idempotency protection, and admin/user reporting over it
exists — but plan entitlement limits are seeded as NULL and are not
enforced as a pre-flight gate, storage has no quota, and several real cost
surfaces (CPU time, caption work, bandwidth) are not recorded at all.

---

## 1. Cost surfaces → what the ledger actually records

The ledger (`usage_ledger`, written only via `recordUsage()` in
`server/src/accountCore.ts`) has columns: user/workspace/project/job ids,
`operation`, `provider`, `resource`, `unit`, `quantity`, `status`
(COMPLETED / FAILED / PARTIAL_SUCCESS), `entitlement_key`, a **UNIQUE
`idempotency_key`**, and timestamp. Writes use `INSERT OR IGNORE` on that
key — a retry or double-completion path records **exactly one row**, and a
failed operation is recorded with quantity 0 and status FAILED (never
billed as success). Ledger writes never throw into the user flow; a write
failure is `console.error`'d (and therefore, per `OBSERVABILITY.md`, not
alerted on).

Every operation the codebase records (verified by enumerating all
`recordUsage` call sites):

| Cost surface | Operation(s) in the ledger | Unit / quantity | Call sites |
|---|---|---|---|
| Storage — uploads | `upload` ×3 rows per asset | `videos` = 1 (`videos_uploaded`); `seconds` = source duration (`source_duration`); `bytes` = file size (`storage_bytes`, the only row carrying an `entitlement_key`) | `studio.ts` (on completed, FFprobe-verified upload only) |
| Analysis pipeline (scene/speech analysis) | `analysis` | `jobs` = 1 completed / 0 failed | `analysis.ts` |
| Speech-to-text | `transcription` | `minutes` = source duration ÷ 60 (3-dp) | `analysis.ts` |
| Clip generation | `clips` | `clips` = number of candidate clips generated | `analysis.ts` |
| Face/person tracking + reframing (CV) | `tracking` | `jobs` = 1 / 0 | `tracking.ts` |
| Rendering & export (FFmpeg encode) | `render` / `export` | `jobs` = 1 / 0 per render job | `editor.ts` |
| B-roll recommendations | `broll` | `jobs` = 1 / 0 | `broll.ts` |
| Enhancement / stabilisation / FFmpeg filter jobs | `enhancement` | `jobs` = 1 / 0 | `broll.ts` |
| Background removal (provider job, refused) | `background_removal` | `jobs` = 0, FAILED | `broll.ts` |
| Stock search (provider job, refused) | `stock_search` | `jobs` = 0, FAILED | `broll.ts` |
| AI generation (provider job, refused) | `ai_generation` | `jobs` = 0, FAILED | `broll.ts` |
| Publishing | `publish_attempt` (per attempt: 1 succeeded / 0 failed), `publish` (per published post) | `attempts`, `posts` | `publishing.ts` |
| Analytics sync | `analytics_sync` | `metrics` = number of metric values saved (0 on failure; status PARTIAL_SUCCESS when partial), with `provider` = platform | `analytics.ts` |
| Analytics report generation (PDF/CSV/XLSX) | `analytics_report` | `reports` = 1 / 0 | `analyticsReports.ts` |

Also recorded, but **not** in the usage ledger (a different table):
per-asset media usage events in `asset_usage_records`
(`broll.ts`'s own `recordUsage` — IMPORTED_INTO_PROJECT, PLACED_ON_TIMELINE,
ENHANCED). Anyone auditing "what does the ledger know" must not confuse
the two.

### What is NOT recorded (real costs with no ledger row)

| Surface | Reality | Ledger? |
|---|---|---|
| **CPU seconds / wall-clock per job** (FFmpeg encodes, Whisper transcription, CV tracking, enhancement) | The dominant real cost on this single-machine deployment. Job rows carry `started_at`/`finished_at`, so duration is *derivable per job from job tables*, but it is never converted into a usage quantity. A 10-second render and a 40-minute 4K render both record `jobs = 1`. | ❌ |
| **Caption work** — caption generation from transcript, caption editing, translation jobs | `server/src/captions.ts` contains **zero** ledger writes. Translation attempts against a (future) paid provider would be a per-call external cost with no accounting row; today the provider is unconfigured so attempts fail fast and free. | ❌ |
| **Storage beyond the upload row** — render outputs, previews, thumbnails, B-roll media, reports, export ZIPs/bundles, data-export ZIPs | Only the *source upload* writes a `storage_bytes` row. Everything the system subsequently *generates* grows the disk without a ledger entry. (Current totals are still *measurable* — §3 — they are just not ledger events.) | ❌ |
| **Bandwidth / egress** — media streaming to the browser, export downloads, publishing uploads to platforms | Nothing measures bytes served anywhere. On local-disk hosting this is a host-capacity question; on any future metered host it becomes a bill with no internal accounting. | ❌ |
| **Email volume** | SMTP sends (when configured) are uncounted; outbox files in dev are uncounted. | ❌ |
| **Platform API quota consumption** (YouTube Data/Analytics quota units etc.) | Sync/publish calls are counted as jobs/metrics, not as provider quota units. Quota exhaustion is handled correctly as an error state (and, per the Phase 11 fix record, no longer disconnects the account), but no quota budget is tracked. | ❌ |
| **Failed-work cost** | Failed jobs record quantity 0 — right for *user accounting*, but a failed 30-minute encode still burned 30 minutes of CPU. Failure cost is invisible in the ledger by design; it is only visible in job tables + error logs. | ⚠️ by design |

## 2. Storage growth — where the bytes actually accumulate

All under `server/data/` on one volume (paths from `config.ts`):

| Directory / table basis | Grows with | Bounded by |
|---|---|---|
| `data/media/<userId>/` (source uploads + project media + render outputs) | Uploads (max **500 MB per file**, `MAX_UPLOAD_MB`), imports, renders | Nothing automatic. No per-user quota, no total cap, no expiry. |
| `data/processing/` (analysis working files, preview clips) | Every analysis run | Job cleanup paths exist per-job; no global sweeper or age cap was found. |
| `data/reports/` (analytics report files) | Every generated report/export file | Nothing. |
| `data/data-exports/` (privacy export ZIPs) | Every data-export request | Nothing — ZIPs persist until account deletion/manual cleanup (see `PRIVACY_LEGAL.md` §5). |
| `data/avatars/`, `data/workspace-logos/` | Profile/workspace images | User actions only; small. |
| `data/outbox/` (dev email) | Every email while SMTP is unconfigured | Nothing. Unbounded one-JSON-per-email growth. |
| The SQLite DB itself | Transcripts, tracking frames, analytics snapshots/metric values, audit log, health-check rows, webhook events, ledger | Nothing. Analytics snapshots and `system_health_checks` grow with use/admin views respectively; no purge jobs exist. |

The only disk early-warning in the system is the admin health check's
free-space status (DEGRADED ≤ 200 MB free, `admin.ts`) — a label a human
sees when they open the page, not a guard. **Uploads and renders will run
the disk to zero if usage grows unchecked**; FFmpeg/DB failures at 0 MB
are the de-facto quota today.

## 3. Reporting that exists

| Report | Audience | Contents |
|---|---|---|
| `GET /api/admin/usage` → Admin Console "Usage & Reports" | Admin | Ledger aggregated **by operation/resource/unit** (sum of quantities + row counts) and **by user** (entries + total quantity, top 50), plus total ledger entries. |
| Admin Overview | Admin | Storage bytes *now* = Σ `source_assets.file_size` + Σ completed `export_outputs.file_size` + Σ `project_media.file_size`; job totals; failed-job total. |
| `GET /api/usage/overview` → Settings usage views | The user themselves | Their ledger totals + a period view (default 30 d, max 365), per-day history, failed-operation count, **live-measured storage** (source/output/project-media bytes, measured from the tables at request time — so generated-output storage is visible here even though it is not a ledger event), published-post and connected-account counts, and their plan's limits *where configured* (`limitsConfigured` flag; limits are shown as unset when NULL rather than invented). |
| `GET /api/usage/history` | The user | Their ledger rows, paginated, filterable by operation. |

There is **no** cost report in currency, no per-workspace cost roll-up in
the admin view (the ledger *has* `workspace_id`, the admin aggregation
does not group by it), no export of usage data for billing, and no
scheduled reporting.

## 4. Duplicate / runaway expensive-job prevention

What genuinely exists:

- **Ledger idempotency** (§1): UNIQUE idempotency keys per job outcome —
  double-completion cannot double-count usage.
- **Job-creation idempotency:** project creation honours an
  `Idempotency-Key` header backed by a UNIQUE (user, key) index
  (`studio.ts`, `db.ts`); publishing job creation accepts a client request
  id (`publishing.ts`); editor document operations carry an operation-id
  idempotent-retry path (`editor.ts`); payment webhook events (scaffolding)
  dedupe on (provider, event_id).
- **Queue-claim atomicity:** workers claim jobs with conditional UPDATEs
  (`… WHERE status = 'QUEUED'`), so two ticks cannot run the same job;
  analytics sync dedupes concurrent refreshes for the same post/account
  (the user is told "a refresh is already queued").
- **Concurrency caps:** renders default to **1 at a time**,
  `RENDER_CONCURRENCY` env, clamped 1–4 (`editor.ts`); analysis, tracking,
  and Phase 8 workers each process one job at a time by design (their
  comments state the CPU-bound reason). Publishing/analytics/account
  workers are 1 s tick loops with boot recovery and, for analytics,
  bounded retry (`ANALYTICS_MAX_SYNC_ATTEMPTS`, default 3, with backoff).
- **Preflight before encode:** export preflight (Phase 9) validates
  settings, media, captions, and encoder availability *before* FFmpeg
  runs, so a doomed 4K encode is refused cheaply; renders are QC-gated by
  FFprobe before being marked COMPLETED.
- **Failed ≠ billed:** every processor records FAILED with quantity 0
  (§1) — a user is never charged usage for the system's failure.

What does **not** exist:

- **No entitlement enforcement gate.** Plan entitlements are seeded with
  NULL limits for every plan (`db.ts` PLAN_SEED / ENTITLEMENT_KEYS:
  `storage_bytes`, `ai_processing_minutes`, `exports_per_month`,
  `connected_accounts`, `team_members`; FEATURE_KEYS: `publishing`,
  `analytics`, `ai_captions`, `face_lock`, `broll`, `priority_rendering`).
  The usage overview *compares* usage to limits when an admin has set
  them, but this review found **no pre-flight check that refuses an
  upload/render/transcription for exceeding a limit**. Cost control today
  is physics (one CPU, one disk), not policy.
- **No per-user rate/concurrency limit on job creation.** A single user
  can queue arbitrarily many renders/analyses; the queue is fair-ish
  (priority then FIFO for renders) but unbounded. (Auth endpoints *are*
  rate-limited; job endpoints are not.)
- **No job timeouts / cost ceilings per job** were found for FFmpeg,
  Whisper, or CV child processes — a pathological input can occupy the
  single render slot until it finishes or errors.
- **No automatic retry of expensive media jobs** (renders fail terminally
  with a message and must be re-queued by the user — which is the
  cost-safe default; publishing/analytics retries are bounded as above).

## 5. Expensive optional providers — disabled until configured (verified)

The codebase's standing pattern is "no credentials ⇒ honest
`CONFIGURATION_ERROR`, never a simulated result". Verified state:

| Capability | Gate | State in this environment |
|---|---|---|
| Stock media search | `STOCK_PROVIDER` + `STOCK_API_KEY`, **and the adapter body is an unimplemented stub** (`config.ts` Phase 8 note: dropping in a key is *not sufficient* — `implemented: false` until the body exists) | **Disabled; cannot spend** |
| AI image/video generation | `AI_GENERATION_PROVIDER` + key; stub adapter | **Disabled; cannot spend** (no video-generation provider is integrated at all) |
| Background removal | Provider+key *or* local model path; stub adapter | **Disabled; cannot spend** |
| Caption translation | `TRANSLATION_PROVIDER` + key | **Not configured; jobs fail with CONFIGURATION_ERROR** |
| OpenAI-compatible STT | `STT_PROVIDER=openai-compatible` + `OPENAI_API_KEY`/`STT_API_KEY` | **Not selected** — default is local faster-whisper (CPU cost only, no per-call charge) |
| YouTube/Instagram/TikTok APIs | Per-platform OAuth env sets | **Not configured; connect/publish/analytics fail honestly** |
| SMTP email | `SMTP_HOST`… | **Not configured; outbox files instead** |
| Payments | `PAYMENTS_ENABLED` + provider + 3 secrets | **Disabled (see `PRIVACY_LEGAL.md` §6)** |
| LLM clip analysis | No provider integrated at all | **Does not exist; clip detection is the local transcript/scene/silence pipeline** |

Admin visibility matches: the Providers console reports each of these as
not-configured from real signals, and a provider *toggle* in the admin UI
never makes an unconfigured provider show as configured (`admin.ts`).

## 6. Unit economics — the only math stated, with its assumptions

No prices are asserted. Under explicitly stated assumptions, an operator
can derive unit costs from data the system *does* keep:

- **Transcription minutes** per user/period: directly in the ledger
  (`transcription`, unit `minutes`). If a paid STT provider is ever
  selected, `cost ≈ minutes × provider's per-minute price` — the minutes
  side is already measured; the price side is the provider's contract.
- **Storage GB-months**: *not* derivable from the ledger alone (only
  upload events are rows). It is derivable from the live byte totals in
  the usage overview / admin overview sampled over time:
  `GB-months ≈ average total GB × months`. Nobody samples it today.
- **Encode load**: derivable per job from `render_jobs.started_at →
  finished_at` (and likewise for tracking/analysis jobs) — the raw data
  for CPU-hour accounting exists in job tables, unaggregated.
- **Everything else in §1's "not recorded" table has no measured side to
  multiply**; any spreadsheet claiming those costs today would be
  estimating from outside the system.

## 7. Recommendations (not implemented by this review)

1. Enforce entitlements at job creation (storage bytes is the natural
   first gate — it is already the one entitlement-keyed ledger resource),
   or stop presenting limits in plan language until enforcement exists.
2. Add per-job duration (seconds) as a second quantity row for render /
   transcription / tracking / enhancement, so CPU — the real scarce
   resource — becomes accountable without changing the user-facing units.
3. Ledger the missing surfaces before enabling their paid providers:
   caption translation calls (per job/segment count) **before**
   `TRANSLATION_PROVIDER` is ever configured in production.
4. Add retention/cleanup for generated storage (reports, data-export
   ZIPs, processing scratch, outbox) and a disk watermark action, not
   just a status (pairs with `OBSERVABILITY.md` §7).
5. Bound job creation per user (queue depth per user) while renders are
   single-concurrency — one user's batch should not starve everyone else.
