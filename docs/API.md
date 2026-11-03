# CLIPFORGE — API Documentation

Derived from the router code in `server/src/` (this document was
written by reading the registrations, not from a spec). All paths are
relative to the server origin (`http://localhost:3001` locally; the
frontend reaches them same-origin via the Vite `/api` proxy).

## Conventions

- **Auth column.** `Session` = a valid `cf_session` cookie is required
  (`401 {"error":"Not signed in."}` otherwise). `Public` = no session.
  `Admin` = session **and** `users.is_admin`, re-checked server-side
  per request. Ownership is checked on every resource: another user's
  resource returns **404**, not 403.
- **CSRF.** Every mutating request (`POST/PUT/PATCH/DELETE`) must send
  the `X-CSRF-Token` header matching the `cf_csrf` cookie obtained
  from `GET /api/auth/csrf` — except the signature-authenticated
  webhook endpoints, which are noted individually.
- **Errors.** JSON `{ "error": string }`, plus a `code` field where
  the code defines one (e.g. `CONFIGURATION_ERROR` with HTTP 422 for
  unconfigured providers, `WORKSPACE_ROLE_FORBIDDEN`,
  `ACCOUNT_SUSPENDED`). Validation failures are 400 with the first
  Zod message. JSON body limit is 100 KB (file uploads use the
  multipart upload-session endpoints instead).
- **Idempotency.** Project creation, publishing-job creation and
  similar POSTs honour the `Idempotency-Key` header where noted in
  `server/README.md`.

## Health

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/health` | Public | Liveness: `{ ok: true }`. |

## Auth — `app.ts`, mounted at `/api/auth`

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/auth/config` | Public | Honest integration status: `{ emailConfigured, googleConfigured, requireEmailVerification }` (booleans only). |
| GET | `/api/auth/csrf` | Public | Sets the `cf_csrf` cookie, returns `{ csrfToken }`. |
| POST | `/api/auth/register` | Public, rate-limited | Create an unverified account; issues a verification email (or outbox file); also opens a session. 409 on duplicate email (generic message). |
| POST | `/api/auth/verify-email` | Public | Redeem a verification token (single-use, expiring, hash-stored). |
| POST | `/api/auth/resend-verification` | Session, rate-limited | Re-issue a verification email; generic response. |
| POST | `/api/auth/login` | Public, rate-limited | Sign in. Generic 401 for unknown email/wrong password. May return `{ mfaRequired, challengeToken }` instead of a session when TOTP is enabled. |
| POST | `/api/auth/login/mfa` | Public (challenge) | Complete login with a TOTP code or recovery code against the 5-minute challenge (registered in `account.ts`, mounted under `/api`). |
| POST | `/api/auth/logout` | Public | Revokes the session row and clears the cookie. |
| GET | `/api/auth/me` | Public* | Current user or 401. (*Resolves the session itself; used by the frontend to mirror auth state.) |
| POST | `/api/auth/forgot-password` | Public, rate-limited | Always the same generic 200 response, whether or not the account exists. |
| POST | `/api/auth/reset-password` | Public, rate-limited | Redeem a reset token, rotate the password (Argon2id), revoke all sessions. |

## Account, workspaces, usage, privacy, support — `account.ts`, mounted at `/api`

All `Session` unless noted. A workspace-role guard additionally
requires Editor+ for mutations on projects/brand kits (see
Architecture).

| Method | Path | Purpose |
| --- | --- | --- |
| GET / PATCH | `/api/account/profile` | Read/update own profile (display name, etc.). |
| POST / DELETE / GET | `/api/account/avatar` | Upload / remove / fetch own avatar image. |
| POST | `/api/account/email-change` | Start a verified email change (requires current password; old address is notified). |
| POST | `/api/account/email-change/confirm` | Confirm an email change with the token sent to the new address. |
| GET / PUT | `/api/account/preferences` | Read/replace own preferences (language, timezone, formats, defaults) — stored server-side. |
| POST | `/api/account/change-password` | Change password with re-authentication. |
| GET | `/api/account/sessions` | List own sessions/devices. |
| DELETE | `/api/account/sessions/:id` | Revoke one session. |
| POST | `/api/account/sessions/revoke-others` | Revoke every session except the current one. |
| GET | `/api/account/login-activity` | Own login history (successes, failures, MFA, blocks). |
| GET | `/api/account/mfa` | Own MFA status. |
| POST | `/api/account/mfa/setup` | Begin TOTP enrolment (password required). |
| POST | `/api/account/mfa/confirm` | Confirm enrolment with a code; issues recovery codes. |
| POST | `/api/account/mfa/disable` | Disable TOTP (password + code required). |
| POST | `/api/account/mfa/recovery-codes/regenerate` | Replace recovery codes (password + code required). |
| GET | `/api/account/connected-accounts` | Own Phase 10 platform accounts (status/scopes only, never tokens). |
| GET / POST | `/api/workspaces` | List own workspaces / create one. |
| GET / PATCH | `/api/workspaces/:id` | Read/update a workspace (member-only). |
| POST / GET | `/api/workspaces/:id/logo` | Upload / fetch workspace logo. |
| POST | `/api/workspaces/:id/switch` | Make it the active workspace. |
| POST | `/api/workspaces/:id/default` | Make it the default workspace at sign-in. |
| POST | `/api/workspaces/:id/archive` | Archive a workspace. |
| DELETE | `/api/workspaces/:id` | Delete a workspace. |
| GET | `/api/workspaces/:id/members` | List members + roles + pending invitations. |
| PATCH / DELETE | `/api/workspaces/:id/members/:userId` | Change a member's role / remove a member. |
| POST | `/api/workspaces/:id/invitations` | Invite by email (delivered via SMTP or outbox — see Providers). |
| DELETE | `/api/workspaces/:id/invitations/:inviteId` | Revoke an invitation. |
| GET | `/api/invitations/pending` | Invitations addressed to the caller. |
| POST | `/api/invitations/accept` / `/api/invitations/reject` | Accept / reject an invitation. |
| GET | `/api/notifications` | Own in-app notifications (real events only). |
| POST | `/api/notifications/:id/read` / `/api/notifications/read-all` | Mark read. |
| DELETE | `/api/notifications` | Clear own notifications. |
| GET / PUT | `/api/notifications/preferences` | Notification channel/category preferences. |
| GET | `/api/usage/overview` / `/api/usage/history` | Own usage from the immutable ledger. |
| GET | `/api/plans` | Plans as configured by admins (prices may be unset). |
| GET | `/api/subscription` | Own current plan/subscription. |
| POST | `/api/subscription/cancel-request` | Request cancellation. |
| POST | `/api/subscription/checkout` | Start checkout — returns `CONFIGURATION_ERROR` while payments are disabled (see Providers). |
| POST | `/api/payments/webhook/:provider` | **No session, no CSRF** — HMAC-verified over the raw body. Foundation only; no provider is integrated. |
| POST | `/api/privacy/data-export` | Queue a data-export job (background ZIP). |
| GET | `/api/privacy/data-exports` | List own export jobs. |
| GET | `/api/privacy/data-exports/:id/download` | Download a finished export (owner only). |
| POST | `/api/privacy/account-deletion` | Queue account deletion (closes the account immediately for sign-in). |
| GET | `/api/privacy/deletion-status` | Own deletion job status. |
| POST / GET | `/api/support/tickets` | Create / list own support tickets. |
| GET | `/api/support/tickets/:id` | Ticket + message thread. |
| POST | `/api/support/tickets/:id/messages` | Reply on own ticket. |

## Admin — `admin.ts`, mounted at `/api` — all **Admin**

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/admin/overview` | Platform counts/overview. |
| GET | `/api/admin/users` / `/api/admin/users/:id` | User list (search/status filter) / detail. |
| POST | `/api/admin/users/:id/suspend` / `/reactivate` | Suspend (sessions die immediately) / restore an account. |
| POST | `/api/admin/users/:id/recovery` | Issue an account-recovery action for a user. |
| POST | `/api/admin/users/:id/plan` | Assign a plan to a user. |
| GET | `/api/admin/workspaces` / `/api/admin/projects` | Cross-user workspace / project lists. |
| GET | `/api/admin/jobs` / `/api/admin/render-queue` / `/api/admin/publishing-jobs` | Job oversight across workers. |
| GET | `/api/admin/providers` | Provider status surface (implemented/configured per provider). |
| POST | `/api/admin/providers/:key/test` | Run a provider's live check. |
| PATCH | `/api/admin/providers/:key` | Enable/disable a provider record. |
| GET | `/api/admin/integrations` | Integration configuration summary (names only). |
| GET | `/api/admin/usage` / `/api/admin/reports` | Ledger aggregates / generated report list. |
| GET / POST | `/api/admin/plans` | List / create plans. |
| PATCH | `/api/admin/plans/:id` | Edit a plan (prices are admin-entered; empty = not set). |
| PUT | `/api/admin/plans/:id/entitlements` | Replace a plan's entitlements. |
| GET | `/api/admin/audit-logs` | Append-only audit log (filterable by event type). |
| GET | `/api/admin/system-health` | Live checks: FFmpeg/FFprobe really executed, disk really measured; unused components report `NOT_USED`. |
| GET | `/api/admin/support/tickets` / `/api/admin/support/tickets/:id` | Support queue / thread. |
| POST | `/api/admin/support/tickets/:id/messages` | Reply as support. |
| PATCH | `/api/admin/support/tickets/:id` | Change ticket status/priority. |

## Studio — `studio.ts`, mounted at `/api` — all Session

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/studio/config` | Upload limits, formats, integration status (incl. `cloudImportConfigured: false`). |
| POST / GET | `/api/projects` | Create (`Idempotency-Key` honoured) / list own projects (`search`, `workflow`, `status`, `sort`, `page`, `pageSize`). |
| GET / PATCH / DELETE | `/api/projects/:id` | Read / rename + settings / delete a project **and its stored files**. |
| DELETE | `/api/projects/:id/source` | Remove source files/assets/sessions; project returns to `DRAFT`. |
| POST | `/api/projects/:id/upload-session` | Declare filename+size; validates format and `MAX_UPLOAD_MB`. |
| GET | `/api/upload-sessions/:id` | Session status (stale sessions lazy-expire; TTL 30 min). |
| POST | `/api/upload-sessions/:id/cancel` | Cancel; pending asset removed. |
| POST | `/api/upload-sessions/:id/file` | Multipart upload → FFprobe verification → metadata + thumbnail. |
| POST | `/api/projects/:id/url-import` | Import a video from a pasted URL (yt-dlp): SSRF-guarded up front (`400 URL_BLOCKED` / `VALIDATION_ERROR`), queues a `URL_IMPORT` phase8 job (poll `/api/phase8-jobs/:id`) that downloads best MP4 ≤1080p capped at `MAX_UPLOAD_MB` and lands a verified `URL_IMPORT` source asset; `422 CONFIGURATION_ERROR` when yt-dlp is unavailable/disabled. |
| GET | `/api/source-assets/:id/stream` / `/thumbnail` | Media bytes / extracted frame, owner only. |
| POST | `/api/youtube/validate` | URL validation + honest status report; **never imports media**. |

## Clips / analysis — `analysis.ts`, mounted at `/api` — all Session

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/analysis/config` | STT provider status: `{ provider, configured, model, speakerDiarization: false, … }`. |
| POST / GET | `/api/projects/:id/analysis` | Create a detection job (an identical active job is returned with `deduplicated: true`) / list the project's jobs. |
| GET | `/api/analysis/:jobId` | Persisted job status/stage/outcome (refresh recovery). |
| POST | `/api/analysis/:jobId/cancel` / `/retry` | Cancel (running children are killed) / re-queue a failed or cancelled job after removing its artifacts. |
| GET | `/api/projects/:id/transcript` | Latest transcript + segments (speaker always `null`) + topic segments, or `{ transcript: null }`. |
| GET | `/api/projects/:id/candidates` | Candidate clips; `?sort=score` (default) or `?sort=start`. |
| PATCH | `/api/candidates/:id` | Edit title, or set `status` `SELECTED`/`DESELECTED`/`REMOVED`. |
| GET | `/api/candidates/:id/preview` | The verified FFmpeg preview cut, owner only. |

## Editor — `editor.ts`, mounted at `/api` — all Session

| Method | Path | Purpose |
| --- | --- | --- |
| GET / POST | `/api/projects/:id/editor` | Read / get-or-create the project's editor document. |
| POST | `/api/editor/:docId/operations` | Apply an editing operation (full before/after state stored for undo). |
| POST | `/api/editor/:docId/undo` / `/redo` | Move the undo cursor. |
| PATCH | `/api/editor/:docId/settings` | Update document/canvas settings. |
| GET / POST | `/api/editor/:docId/versions` | List / create named snapshots. |
| POST | `/api/editor/:docId/versions/:versionId/restore` | Restore a snapshot. |
| GET / POST | `/api/projects/:id/media` | List / upload project media (audio/video) via FFprobe verification. |
| GET / DELETE | `/api/project-media/:id/stream` , `/api/project-media/:id` | Stream / delete project media, owner only. (Delete is on `/api/project-media/:id`.) |
| POST | `/api/editor/:docId/render` | Queue a render job on the shared render worker. |
| GET | `/api/editor/:docId/renders` | The document's render jobs. |
| GET | `/api/render-jobs/:jobId` | Render job status. |
| POST | `/api/render-jobs/:jobId/cancel` | Cancel a queued/running render. |
| GET | `/api/render-jobs/:jobId/download` | Download a completed render, owner only. |

## Captions + Brand Kit — `captions.ts`, mounted at `/api` — all Session

| Method | Path | Purpose |
| --- | --- | --- |
| GET / POST | `/api/caption-templates` | List (10 built-ins + own) / save a custom template. |
| PATCH / DELETE | `/api/caption-templates/:id` | Edit / delete an own template. |
| POST | `/api/caption-templates/:id/duplicate` | Duplicate a template. |
| GET | `/api/captions/fonts` | Fonts actually available to the renderer. |
| GET | `/api/editor/:docId/caption-studio` | The document's caption-studio state (tracks, active style). |
| POST | `/api/editor/:docId/captions/regenerate` | Regenerate captions from the transcript. |
| POST | `/api/editor/:docId/captions/import` | Import subtitles (SRT/VTT/ASS parsed server-side). |
| GET | `/api/editor/:docId/captions/export` | Export the active track as a subtitle file. |
| POST | `/api/editor/:docId/caption-tracks` | Create a caption track/variant. |
| POST | `/api/editor/:docId/caption-tracks/:trackId/activate` | Make a variant the active track. |
| GET / POST | `/api/editor/:docId/translation-jobs` | List / create translation jobs — creation fails with `CONFIGURATION_ERROR` while no translation provider is set; manual tracks are unaffected. |
| POST / GET | `/api/brand-assets` | Upload / list brand assets (logo, intro, outro, music, overlay). |
| GET / DELETE | `/api/brand-assets/:id/stream` , `/api/brand-assets/:id` | Stream / delete a brand asset, owner only. |
| GET / POST | `/api/brand-kits` | List / create brand kits (workspace-scoped). |
| GET / PATCH / DELETE | `/api/brand-kits/:id` | Read / edit / delete a kit. |
| POST | `/api/brand-kits/:id/duplicate` / `/default` / `/apply` | Duplicate / set default / apply a kit to a document (copies style in; later kit edits do not rewrite documents). |

## Tracking / reframing — `tracking.ts` — all Session (paths registered in full)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/tracking/status` | CV stack status (models/OpenCV availability). |
| POST / GET | `/api/projects/:projectId/tracking-jobs` | Create / list tracking jobs for a project. |
| GET | `/api/tracking-jobs/:jobId` | Job status, stages, subjects, result. |
| POST | `/api/tracking-jobs/:jobId/cancel` / `/retry` | Cancel / retry a tracking job. |
| GET | `/api/tracking-jobs/:jobId/subjects/:subjectId/thumbnail` | A subject's best-frame thumbnail, owner only. |
| GET | `/api/editor/:docId/reframe` | The document's reframe configuration + keyframes. |
| PUT | `/api/editor/:docId/reframe/config` | Update reframe config (mode, aspect, fit, subject, controls). |
| POST | `/api/editor/:docId/reframe/reset-tracking` | Reset computed tracking data for the config. |
| POST | `/api/editor/:docId/reframe/keyframes` | Add a manual keyframe (never overwritten by the system). |
| PUT / DELETE | `/api/editor/:docId/reframe/keyframes/:keyframeId` | Edit / delete a keyframe. |
| PUT / DELETE | `/api/editor/:docId/reframe/scene-overrides(/:overrideId)` | Set / remove per-scene reframe overrides. |
| PUT | `/api/editor/:docId/reframe/split` | Set the split-screen layout for the config. |
| POST | `/api/editor/:docId/reframe-render` | Queue a render using the persisted reframe keyframes. |

## B-roll / enhancement (Phase 8) — `broll.ts`, mounted at `/api` — all Session

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/phase8/status` | Per-capability provider status (`implemented` + `configured` for stock/generation/background). |
| GET | `/api/media-library` | Unified library view over source/project/candidate/brand assets. |
| PATCH / DELETE | `/api/media-library/meta` , `/api/media-library/item` | Update library metadata / remove an item. |
| GET | `/api/media-library/thumbnail` | Library item thumbnail, owner only. |
| GET / POST | `/api/media-library/folders` | List / create library folders. |
| DELETE | `/api/media-library/folders/:id` | Delete a folder. |
| POST / GET | `/api/projects/:id/broll/recommendations` | Generate (queues a job) / list transcript-driven recommendations from the local library. |
| POST | `/api/broll-recommendations/:recId/dismiss` / `/replace` / `/accept` | Dismiss / swap the suggested asset / **accept — the only path that inserts onto the timeline** (starts muted). |
| GET | `/api/projects/:id/broll/placements` | B-roll placements on the project's document. |
| PATCH / DELETE | `/api/broll-placements/:placementId` | Adjust / remove a placement. |
| POST | `/api/projects/:id/broll/search` | Stock search — `CONFIGURATION_ERROR` in this build (stub adapter). |
| POST | `/api/projects/:id/broll/import` | Stock import — same stub status as search. |
| POST | `/api/projects/:id/broll/generate` | AI generation — same stub status. |
| POST | `/api/projects/:id/background-jobs` | Background removal — same stub status (no segmentation model/provider). |
| POST | `/api/projects/:id/enhancement-jobs` | Queue an FFmpeg enhancement/preview job (real). |
| GET | `/api/projects/:id/phase8-jobs` / `/api/phase8-jobs/:jobId` | List / read Phase 8 jobs. |
| POST | `/api/phase8-jobs/:jobId/cancel` / `/retry` | Cancel / retry (provider jobs fail honestly again). |
| GET | `/api/phase8-jobs/:jobId/preview/:which` | Before/after preview media for an enhancement job. |
| GET / PUT | `/api/editor/:docId/enhancement` | Read / save the document's enhancement configuration. |
| POST | `/api/editor/:docId/render-enhanced` | Queue a render with the saved enhancement config. |
| GET / POST | `/api/phase8/presets` | List (built-ins + own) / create effect presets. |
| PUT / DELETE | `/api/phase8/presets/:presetId` | Edit / delete an own preset. |
| POST | `/api/phase8/presets/:presetId/duplicate` | Duplicate a preset. |

## Export — `export.ts` — all Session (paths registered in full)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/exports/capabilities` | Encoders/formats this FFmpeg build actually supports (probed). |
| GET | `/api/projects/:projectId/export-targets` | Exportable targets (document / version / candidate) for a project. |
| POST | `/api/projects/:projectId/exports/preflight` | Run export preflight checks without encoding. |
| POST | `/api/projects/:projectId/exports` | Create an export job (preflight runs before encode). |
| GET | `/api/exports/queue` | Own render/export queue. |
| GET | `/api/export-jobs/:jobId` | Job status incl. progress from real FFmpeg output. |
| POST | `/api/export-jobs/:jobId/cancel` / `/pause` / `/resume` / `/start` / `/retry` | Lifecycle controls (pause holds `QUEUED` jobs only; retry re-runs preflight). |
| PATCH | `/api/export-jobs/:jobId/priority` | Change queue priority (atomic claim order). |
| DELETE | `/api/export-jobs/:jobId` | Remove a job. |
| GET | `/api/export-jobs/:jobId/download` / `/thumbnail` | Download a QC-passed output / its thumbnail, owner only. |
| GET | `/api/exports/history` | Own export history (successes **and** failures with reasons). |
| DELETE | `/api/exports/history/:outputId` | Remove a history entry/output. |
| POST | `/api/exports/bundles` | Queue a ZIP bundle of finished outputs. |
| GET | `/api/export-bundles/:bundleId` / `/download` | Bundle status / download the ZIP. |
| GET / POST | `/api/export-presets` | List (built-ins incl. platform presets + own) / create a preset. |
| PUT / DELETE | `/api/export-presets/:id` | Edit / delete an own preset. |
| POST | `/api/export-presets/:id/duplicate` | Duplicate a preset. |

## Publishing — `publishing.ts`, mounted at `/api/publishing` — Session unless noted

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/publishing/providers` | Per-platform implemented/configured status + missing env variable **names**. |
| GET / PUT | `/api/publishing/settings` | Configuration summary (names only), token-encryption mode, public app URL / update settings. |
| GET | `/api/publishing/accounts` | Own connected accounts (status/scopes/expiry only — never token material). |
| POST | `/api/publishing/accounts/:platform/connect` | Start OAuth; returns the official authorize URL. `422 CONFIGURATION_ERROR` when unconfigured. |
| GET | `/api/publishing/oauth/:platform/callback` | **Public** (top-level browser redirect; server-stored state + PKCE are the protection). Exchanges the code server-side, stores encrypted tokens, redirects to the app. |
| DELETE | `/api/publishing/accounts/:accountId?confirm=true` | Disconnect: best-effort provider revocation, tokens deleted, row kept as `DISCONNECTED` so history survives. |
| POST | `/api/publishing/accounts/:accountId/refresh` | Force a real token-refresh round-trip. |
| GET | `/api/publishing/accounts/:accountId/capabilities?fresh=1` | Live platform capabilities, snapshotted server-side. |
| POST | `/api/publishing/jobs` | Create a `DRAFT` from a `COMPLETED` export + connected account (`Idempotency-Key` dedupes; `clip_id` derived server-side from the export target). |
| GET / DELETE | `/api/publishing/jobs/:jobId` | Read / delete a job. |
| PUT | `/api/publishing/jobs/:jobId/metadata` | Edit per-platform metadata (editing after approval resets the job to `DRAFT`). |
| POST / DELETE | `/api/publishing/jobs/:jobId/thumbnail` | Set/remove a custom thumbnail (YouTube; PNG/JPEG sniffed, 2 MB cap). |
| POST | `/api/publishing/jobs/:jobId/validate` | Validate against **live** platform limits; persists results. A failed validation can never submit. |
| GET | `/api/publishing/jobs/:jobId/preview` | Approval-screen payload (job + account + validation + capabilities). |
| POST | `/api/publishing/jobs/:jobId/approve` | Approve — requires `rightsConfirmed: true`, passing validation, state `AWAITING_APPROVAL`. |
| POST | `/api/publishing/jobs/:jobId/submit` | Publish now (approved jobs only; second submit is 409). |
| POST | `/api/publishing/jobs/:jobId/schedule` | Schedule by UTC instant or local time + timezone. YouTube+private ⇒ native scheduling; otherwise CLIPFORGE-scheduled — the response says which. |
| PATCH | `/api/publishing/schedules/:scheduleId` | Reschedule. |
| POST | `/api/publishing/jobs/:jobId/cancel-schedule` / `/cancel` / `/retry` / `/status-check` | Cancel schedule / cancel job / retry / poll platform status now. |
| GET | `/api/publishing/queue` | Queue view (`status`, `platform`, `accountId`, `projectId` filters). |
| GET | `/api/publishing/calendar?from&to` | Calendar events (a DB view over real schedule + job rows; times stored in UTC). |
| GET | `/api/publishing/history` | Publishing history. |
| GET | `/api/publishing/jobs/:jobId/attempts` | Attempt log (provider responses redacted). |
| GET / POST | `/api/publishing/jobs/:jobId/metrics` , `/api/publishing/jobs/:jobId/metrics/sync` | Read / sync post metrics (unavailable stays unavailable — never zero). |
| GET / POST | `/api/publishing/webhooks/meta` | **Public, no CSRF** — hub challenge + `X-Hub-Signature-256` HMAC (503 when `META_APP_SECRET` unset). Events stored idempotently. |
| POST | `/api/publishing/webhooks/tiktok` | **Public, no CSRF** — TikTok-Signature HMAC. Events stored idempotently. |

## Analytics — `analytics.ts`, mounted at `/api/analytics` — all Session

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/analytics/definitions` | Metric catalogue: name, unit, definition, platform meaning, source. |
| GET | `/api/analytics/capabilities` / POST `/api/analytics/capabilities/refresh` | Per-account capability detection (from granted scopes, before any metric request) / recompute. |
| GET | `/api/analytics/overview` | KPI totals for a range with previous-period comparison, engagement rate **with its formula**, data-quality warnings. |
| GET | `/api/analytics/platform-comparison` | Platforms side by side — views and reach are never added together. |
| GET | `/api/analytics/trends` | Time series from saved records only; missing days are gaps, never invented points. |
| GET | `/api/analytics/posts` / `/posts/:id` / `/posts/:id/history` / `/posts/:id/thumbnail` | Published-post performance, full snapshot history (incl. availability rows), thumbnail. |
| POST | `/api/analytics/posts/compare` | Compare posts over the same range. |
| POST / GET | `/api/analytics/comparison-groups` | Create / list comparison groups. (Groups are managed via these two routes in the current router.) |
| GET | `/api/analytics/top-content` | Ranking by a chosen available metric; posts missing it are listed separately as unavailable. |
| GET | `/api/analytics/content-analysis` | Production attributes vs saved outcomes; small groups flagged; correlation ≠ causation stated. |
| GET | `/api/analytics/posting-times` | Best observed day/hour buckets; below 10 published posts returns an honest insufficient-sample response. |
| POST | `/api/analytics/sync` | Queue a sync job. |
| GET | `/api/analytics/sync/jobs` / `/sync/jobs/:id` / `/sync/history` | Sync jobs and history. |
| POST | `/api/analytics/sync/jobs/:id/retry` / `/cancel` | Retry (transient failures only) / cancel. |
| GET / PUT | `/api/analytics/settings` | Automatic sync frequency (off / 6h / daily / weekly) + default report format. |
| POST | `/api/analytics/insights/generate` | Generate deterministic rule-based insights over stored data (no external AI). |
| GET | `/api/analytics/insights` / `/insights/:id` | Insights with evidence, sample size and limitations. |
| POST | `/api/analytics/insights/:id/dismiss` / `/save` | Dismiss / save an insight. |
| POST / GET | `/api/analytics/reports` | Create (background) / list reports — CSV, XLSX, PDF from saved records only. |
| GET / DELETE | `/api/analytics/reports/:id` | Report detail / delete (`?confirm=true`). |
| GET | `/api/analytics/report-exports/:exportId/download` | Download a generated report file, owner only. |
