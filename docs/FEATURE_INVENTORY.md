# CLIPFORGE — Feature Inventory (Phase 13 Audit)

- **Audit type:** static codebase audit (read-only). No e2e suite was executed by this agent — the lead's regression battery was running concurrently. "Tests executed" evidence below is therefore *suite-source inspection*: what each suite in `server/tests/*.e2e.mjs` actually covers, counted from its `check(...)` call sites. Executed pass/fail counts are cited from the lead's fresh regression run in the main Phase 13 report.
- **Date / state:** 2026-11-02 · DB `PRAGMA user_version = 14` (`server/src/db.ts`) · 103 tables · ~300 HTTP route registrations across 13 route modules.
- **Architecture (one line):** React 18 + TypeScript + Vite frontend (`src/`, hash routing in `src/App.tsx`) · Express + TypeScript backend (`server/src/`) · SQLite via `node:sqlite` · DB-backed **in-process** workers started in `server/src/index.ts` (analysis, render, tracking, Phase 8, export bundles, publishing, analytics, account) · local-disk media storage (`server/data/media`), no object storage.

## Classification key

| # | Class |
|---|---|
| 1 | Implemented and verified (real implementation + a real e2e suite exercising it) |
| 2 | Implemented but partially tested (real implementation; coverage is mock-only, fixture-only, browser-only, or incomplete) |
| 3 | UI only (surface exists; no working backend capability behind it) |
| 4 | Backend only (working backend capability with no user-facing UI) |
| 5 | Requires external credentials (real adapter/gate; honestly returns `422 CONFIGURATION_ERROR` until credentials exist — **not broken**) |
| 6 | Broken (implemented and demonstrably failing) |
| 7 | Missing (no implementation) |

## Tally

| Class | Count |
|---|---|
| 1 — Implemented and verified | **24** |
| 2 — Implemented but partially tested | **9** |
| 3 — UI only | **5** |
| 4 — Backend only | **1** |
| 5 — Requires external credentials | **9** |
| 6 — Broken | **0** |
| 7 — Missing | **5** |
| **Total features inventoried** | **53** |

No feature was found provably **Broken (class 6)** by static audit: every "not configured" surface traced to an honest credential gate (class 5), a labelled preview-only control (class 3), or an explicitly unbuilt item (class 7). This is *not* a runtime verdict — it defers to the lead's regression run.

---

## Inventory (F01–F53)

### Landing & shell

| ID | Feature | Class | Evidence |
|---|---|---|---|
| F01 | Landing page structure — hero, problem/solution, features, how-it-works, templates, use-cases, B-roll gallery, publishing, social proof, testimonials, FAQ, final CTA | 2 | `src/pages/HomePage.tsx` (361 LOC) + `src/components/landing/*`; only coverage is the preservation checks inside `auth.e2e.mjs` (§18–20) — no dedicated landing suite, rendering is browser-verified only |
| F02 | Landing media (all image/video areas) | 3 | By explicit user override (2026-11-02): every slot is an empty `MediaPlaceholder`. Central map `src/config/landingAssets.ts` — 40 slots / 26 locations; component `src/components/landing/MediaPlaceholder.tsx`. No `<img>`/`<video>`/external media in landing code. **UI only by design, not a defect** |
| F03 | Landing legal pages (Privacy / Terms) | 3 | `HomePage.tsx`: both open an in-page notice stating the page "is a placeholder in this phase — no privacy policy / terms have been published yet" |
| F07 | Guest / demo mode | 2 | `src/features/auth/AuthContext.tsx` — `sessionStorage` flag `cf_guest`, UI-only (no session, no data); `src/components/studio/GuestRestriction.tsx` blocks real actions on Studio/Editor/Project pages. No e2e suite exercises guest flows |

### Auth & account foundation

| ID | Feature | Class | Evidence |
|---|---|---|---|
| F04 | Auth core — register, login, logout, `/me`, email verification, password reset, sessions, CSRF double-submit, rate limiting, Argon2id | 1 | `server/src/app.ts` (auth routes: `/config`, `/csrf`, `/register`, `/verify-email`, `/resend-verification`, `/login`, `/logout`, `/me`, `/forgot-password`, `/reset-password`, `GET /api/health`); tables `users`, `sessions`, `email_verification_tokens`, `password_reset_tokens` (migration v1). Suite: `auth.e2e.mjs` |
| F05 | Google sign-in | 5 | `server/src/config.ts` `googleConfigured` (needs `GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI`); `LoginPage.tsx` renders "Google sign-in is not configured" and cannot sign in |
| F06 | Transactional email delivery (verification, reset, email-change, invitations) | 5 | `server/src/email.ts`; without `SMTP_*` env, mail is written to the dev outbox (`server/data/outbox`) and the UI says exactly that (`AppShell.tsx`, `SettingsPage.tsx`). Outbox path is exercised by `auth`/`account` suites; real inbox delivery requires SMTP credentials |
| F45 | Profile, preferences, avatar, password change, sessions list/revoke, login activity, verified email change | 1 | `server/src/account.ts` + `accountCore.ts`; `SettingsPage.tsx`; tables `user_preferences`, `login_events`, `email_change_tokens` (+ v12 columns on `users`/`sessions`). Suite: `account.e2e.mjs` (§#1–#6 area) |
| F46 | MFA — TOTP (RFC 6238) + 10 recovery codes + login challenge; replay prevention (migration v13 `user_totp.last_used_step`) | 1 | `account.ts` `/account/mfa/*`, `/auth/login/mfa`; tables `user_totp`, `mfa_recovery_codes`, `mfa_challenges`. Suite: `account.e2e.mjs` computes real TOTP codes. Note: *email* MFA reports honestly unavailable without SMTP (asserted in-suite) |
| F43 | Notifications + notification preferences | 2 | Full stack exists — `account.ts` `GET /notifications`, `POST /notifications/:id/read`, `POST /notifications/read-all`, `DELETE /notifications`, `GET/PUT /notifications/preferences`; producer in `accountCore.ts`; UI `NotificationPanel.tsx` in `AppShell`. **Gap: `grep -i notif server/tests/account.e2e.mjs` returns zero checks** — no e2e coverage found |

### Studio, upload & sources (Phase 3)

| ID | Feature | Class | Evidence |
|---|---|---|---|
| F08 | Projects — create (idempotent), list, rename, settings round-trip, delete, two workflow types (`LONG_VIDEO_TO_SHORTS`, `SHORT_VIDEO_ENHANCEMENT`) | 1 | `server/src/studio.ts`; `src/pages/StudioPage.tsx`, `ProjectsPage.tsx`, `pages/studio/CreateShortsPage.tsx`, `EnhanceVideoPage.tsx`; table `projects` (v2). Suite: `studio.e2e.mjs` |
| F09 | File upload — upload sessions, multipart file endpoint, container/FFprobe validation, metadata, thumbnails, streaming, source replacement, restart persistence | 1 | `studio.ts` `/projects/:id/upload-session`, `/upload-sessions/:id/file`, `/source-assets/:id/stream|thumbnail`; `media.ts`; tables `source_assets`, `upload_sessions`. Suite: `studio.e2e.mjs` (real FFmpeg fixtures, ffprobe ground truth) |
| F10 | YouTube URL validation + attach as project source | 2 | `studio.ts` `POST /youtube/validate` (needs `YOUTUBE_API_KEY` for metadata; URL parsing/validation is local); `SourcePanel.tsx` states verbatim: the link "is NOT imported — upload the original file below to make it processable". Covered in `studio.e2e.mjs` config/validation checks. Validation itself still never downloads; downloading a pasted URL is the separate F11 path |
| F11 | URL media import / download (YouTube + any yt-dlp site + direct media links) | 2 | **Implemented with limits** (URL-import pass, 2026-11-02). `server/src/urlImport.ts`: `POST /projects/:id/url-import` queues a `URL_IMPORT` phase8 job (migration v15 widened `source_assets.source_type` + `phase8_jobs.kind`); yt-dlp downloads best MP4 ≤1080p, `--no-playlist`, capped at `MAX_UPLOAD_MB`; then the upload post-processing (strict FFprobe, thumbnail, `source_type='URL_IMPORT'`) so analysis/captions/editor/export treat it as an ordinary source (analysis gate = has a verified local file). Provenance on `media_asset_meta`/`media_license_records` with a user-supplied-URL rights note. SSRF guard (private/loopback blocked; `URL_IMPORT_ALLOW_PRIVATE=1` is e2e-only). Env-gated by `YTDLP_BIN`/`URL_IMPORT_ENABLED` with honest `422 CONFIGURATION_ERROR`. Suites: `studio.e2e.mjs` U0–U10 (real downloads from a loopback fixture via the generic extractor; failure classes; SSRF blocked without the flag) + `clips.e2e.mjs` 11a–d (import → clip detection → candidates). **Limits:** downloads are verified locally only — live-platform downloads (e.g. real YouTube from this server) are NOT verified here, and platforms may block server IPs or require sign-in per video; those fail honestly per video (see KNOWN_LIMITATIONS 11) |
| F12 | Cloud import (Drive/Dropbox/etc.) | 3 | The `SourcePanel.tsx` tab is now "Import from URL" and contains the working F11 URL form; cloud *storage* import remains unconfigured and is labelled as such inside that tab. Backend still returns the hard-coded flag `studio.ts` `cloudImportConfigured: false` for storage providers; no storage adapter code exists at all |

### Transcription & clip detection (Phase 4)

| ID | Feature | Class | Evidence |
|---|---|---|---|
| F13 | Speech-to-text — local faster-whisper (`small` model, `server/scripts/transcribe.py`), word timestamps, transcript + segments + topics | 1 | `server/src/stt.ts`, `analysis.ts`; tables `transcripts`, `transcript_segments`, `topic_segments`. Suites: `clips.e2e.mjs` (real espeak-ng speech fixtures, real model), `captions.e2e.mjs` |
| F14 | Speech-to-text — OpenAI-compatible Whisper HTTP provider | 5 | `stt.ts` provider branch selected by `STT_PROVIDER=openai-compatible`; `configured` = presence of `OPENAI_API_KEY`/`STT_API_KEY`. Code exists; no suite exercises the remote path; unusable without a key |
| F15 | AI clip detection — analysis jobs (queue/cancel/retry), scoring, reasons, suggested titles, candidate select/deselect/remove, title edit, FFmpeg preview cuts | 1 | `analysis.ts` (10 routes); worker `startAnalysisWorker`; tables `processing_tasks`, `candidate_clips` (v3; v10 rebuild adds `DESELECTED` status). UI: `ProjectDetailPage.tsx` "Find Clips" panel. Suite: `clips.e2e.mjs` |
| F16 | Speaker diarization / speaker labels | 7 | **Missing, and honestly not claimed:** `clips.e2e.mjs` asserts "no diarization claimed", transcript segments carry `speaker = NULL`; `stt.ts` config reports diarization unsupported. (Active-speaker *video* detection is a separate Phase 7 feature, F25) |

### Editor & timeline (Phase 5)

| ID | Feature | Class | Evidence |
|---|---|---|---|
| F17 | Editor document — multi-track timeline (main/broll/caption/audio/overlay), operations, snapshot undo/redo, named versions + restore, project media (music) upload, canvas/settings | 1 | `server/src/editor.ts` (18 routes); tables `clip_versions`, `timeline_tracks`, `timeline_items`, `editing_operations`, `caption_segments`, `scene_overrides`, `project_versions`, `project_media` (v4). UI: `pages/studio/VideoEditorPage.tsx` + `components/editor/{Timeline,PreviewCanvas,Inspector,MediaLibrary}.tsx`. Suite: `editor.e2e.mjs`. Browser-only gestures/playback are *not* e2e-covered (suite header says so) |
| F18 | Editor render (Phase 5 render jobs, FFmpeg, FFprobe-verified, download, cancel) | 1 | `editor.ts` `/editor/:docId/render`, `/render-jobs/:jobId[/cancel|/download]`; `startRenderWorker`; table `render_jobs`. Suite: `editor.e2e.mjs` real render + probe |
| F36 | "My Clips" top-level page (`#/app/clips`) | 3 | `src/pages/ClipsPage.tsx` (10 LOC) renders only `PlaceholderPage` ("Not built yet"). **Unfinished integration, not a missing capability:** clips themselves are fully implemented (F15) and reviewed inside `ProjectDetailPage`; the standalone nav page was never wired to them |

### Captions & Brand Kit (Phase 6)

| ID | Feature | Class | Evidence |
|---|---|---|---|
| F19 | Captions Studio — caption tracks, regeneration from transcript, import/export (SRT/VTT/ASS family), templates (built-in + custom CRUD/duplicate), fonts, full ASS style model | 1 | `server/src/captions.ts` (26 routes) + `captionStyle.ts`; tables `caption_tracks`, `caption_track_segments`, `caption_templates` (v5; note `caption_segments` itself is v4). UI: `components/editor/CaptionStudio.tsx` (1,175 LOC). Suite: `captions.e2e.mjs` (real transcript incl. a Devanagari fixture) |
| F20 | Caption `lineSpacing` in burned-in renders | 3 | **Preview-only by design, labelled in UI:** `captionStyle.ts` — "PREVIEW ONLY — libass cannot change line height"; `captions.ts` header and `CaptionStudio.tsx` both disclose it. Every other style control does reach the render |
| F21 | Automatic caption translation | 5 | `captions.ts` translation jobs; `config.ts` `TRANSLATION_PROVIDER`/`TRANSLATION_API_KEY` unset → jobs fail with `CONFIGURATION_ERROR`, UI says so. Manual translations (typed/imported) are stored as separate tracks and **do** work (class 1 sub-path, covered in `captions.e2e.mjs`) |
| F22 | Brand Kit — kits CRUD/duplicate/default/apply, seeded "CLIPFORGE Brand" kit with the approved logo, brand assets (logo/intro/outro/music/overlay upload + streaming) | 1 | `captions.ts` `/brand-kits/*`, `/brand-assets/*`; tables `brand_kits`, `brand_assets` (v5). UI: `TemplatesPage.tsx`. Suite: `captions.e2e.mjs`; workspace-scoped seeding re-verified in `account.e2e.mjs`. Known behaviour: deleting all kits re-seeds the default kit |
| F23 | Brand intro / outro / music **compositing into renders** | 7 | **Missing.** Kit intro/outro/music asset IDs are stored (`brand_kits` columns, `TemplatesPage` form) but `grep -i "intro\|outro" server/src/export.ts server/src/editor.ts` returns **no render-path handling** — applying a kit writes caption style/template/settings only. Disclosed known quirk since Phase 6 |

### Face Lock, active speaker & reframing (Phase 7)

| ID | Feature | Class | Evidence |
|---|---|---|---|
| F24 | Face/person tracking jobs — YuNet face detection + YOLOv8-nano person detection (ONNX, `server/models/face_detection_yunet_2023mar.onnx`, `yolov8n.onnx`), Python CV worker (`server/scripts/track.py`), subjects, thumbnails, cancel/retry, dedup | 1 | `server/src/tracking.ts` (17 routes, `/api/tracking/*`, `/api/editor/:docId/reframe*`); tables `tracking_jobs`, `tracked_subjects`, `tracking_frames`, `subject_associations` (v6). Suite: `tracking.e2e.mjs` with real photographic-face fixtures YuNet actually detects |
| F25 | Active speaker detection | 2 | Implemented in the tracking pipeline (Silero VAD via faster-whisper stack + face/mouth heuristics in `track.py`) and exercised on synthetic two-face fixtures in `tracking.e2e.mjs`. **Accuracy on a real two-person conversation is unverified** — no real-conversation fixture exists |
| F26 | Auto-reframing — reframe config, crop keyframes (edit/delete), scene overrides, split-screen reframe layouts, reset-tracking | 1 | `tracking.ts` reframe routes; tables `reframe_configurations`, `tracking_keyframes`, `scene_tracking_overrides`, `split_screen_layouts` (v6). UI: `components/editor/ReframePanel.tsx` (1,428 LOC). Suite: `tracking.e2e.mjs` incl. split-crop / manual-crop / scene-change cases |
| F27 | Person-follow **render** (reframed render using persisted keyframes) | 2 | Route exists (`POST /api/editor/:docId/reframe-render`) and Phase 9 export of a reframed target is covered in `export.e2e.mjs`; a dedicated person-follow render acceptance on real moving-subject footage is not in any suite |

### B-roll, enhancement & background jobs (Phase 8)

| ID | Feature | Class | Evidence |
|---|---|---|---|
| F28 | Media library — project media + library metadata, folders, thumbnails, usage/license records, delete | 1 | `server/src/broll.ts` `/media-library/*`; tables `media_asset_meta`, `media_library_folders`, `media_license_records`, `asset_usage_records` (v7). UI: `components/editor/MediaLibrary.tsx`, `EnhancePanel.tsx`. Suite: `broll.e2e.mjs` |
| F29 | B-roll recommendations (transcript-driven matching against the user's own library) + placements (accept is the only timeline-insert path; placements start muted; dismiss/replace) | 1 | `broll.ts` `/projects/:id/broll/recommendations`, `/broll-recommendations/:recId/{accept,dismiss,replace}`, `/broll-placements/:placementId`; tables `broll_recommendations`, `broll_placements`. Suite: `broll.e2e.mjs` (topical fixtures incl. Devanagari) |
| F30 | Stock B-roll search / import | 5 | Adapter in `broll.ts` is an **interface stub** (`implemented: false` in `config.ts` Phase 8 note and in `/phase8/status`); needs `STOCK_PROVIDER` + `STOCK_API_KEY` *and* an adapter body. Status surface honestly reports both flags; operations fail `422 CONFIGURATION_ERROR`. Suite asserts exactly that |
| F31 | AI B-roll generation | 5 | Same pattern: `AI_GENERATION_PROVIDER` + `AI_GENERATION_API_KEY`, adapter stub, honest `CONFIGURATION_ERROR` (`broll.ts` `/projects/:id/broll/generate`; UI in `EnhancePanel.tsx`) |
| F32 | Background removal / replacement | 5 | Same pattern: `BACKGROUND_REMOVAL_PROVIDER`/`_API_KEY` or `BACKGROUND_MODEL_PATH`; job machinery is real — a request persists a FAILED job with `CONFIGURATION_ERROR` (asserted in `broll.e2e.mjs` and used to feed the usage-ledger failure case in `account.e2e.mjs`) — but no provider/model exists on this machine |
| F33 | Enhancement jobs + effect presets (local FFmpeg filter chain: colour/denoise/sharpen/stabilisation/upscale class operations, per-asset jobs, preset CRUD/duplicate, enhanced render) | 1 | `server/src/enhance.ts` (shared filter-chain builder) + `broll.ts` `/projects/:id/enhancement-jobs`, `/editor/:docId/enhancement`, `/phase8/presets/*`; tables `phase8_jobs`, `enhancement_configs`, `effect_presets` (v7). UI: `EnhancePanel.tsx` (1,600 LOC). Suite: `broll.e2e.mjs`. Note: stabilisation/upscale are per-asset jobs only, not timeline-wide |
| F34 | Split-screen **B-roll** layout | 7 | **Missing, labelled in UI.** Phase 8 offers no split-screen B-roll placement (`EnhancePanel` discloses it). Do not confuse with F26: split-screen *reframing* of tracked subjects (Phase 7) **is** implemented |

### Export Studio & render queue (Phase 9)

| ID | Feature | Class | Evidence |
|---|---|---|---|
| F35 | Export Studio — capabilities probe, per-target preflight (incl. caption-timing + broll-media checks), single/batch exports, queue (atomic priority claim, pause/resume/start-now/retry/cancel/delete), MP4/WebM · H.264/H.265/VP9 · AAC/Opus + MP3 audio-only, platform presets (incl. TikTok/X/LinkedIn *export* presets), ZIP bundles, history, output viewer/thumbnails, FFprobe QC gate before `COMPLETED` | 1 | `server/src/export.ts` (25 routes under `/api/exports*`, `/api/export-jobs*`, `/api/export-presets*`, `/api/export-bundles*`); tables `export_presets`, `export_outputs`, `render_validation_results`, `render_error_log`, `export_bundles` (v8) + v10 columns (`export_outputs.target_kind/target_id`, `render_jobs.worker_id`); worker concurrency via `RENDER_CONCURRENCY` (default 1). UI: `ExportsPage.tsx` (1,537 LOC). Suite: `export.e2e.mjs` — the largest-format suite (real encodes, aspect/resolution/audio/caption-burn probes) |

### Publishing & scheduling (Phase 10)

| ID | Feature | Class | Evidence |
|---|---|---|---|
| F37 | Platform accounts — official OAuth (state + PKCE) for YouTube, Instagram, TikTok; AES-256-GCM token storage; connect/disconnect/refresh/capabilities | 5 | Real adapters in `server/src/providers.ts` + `publishing.ts` (34 routes); `tokenCrypto.ts`; tables `platform_accounts`, `oauth_connections`, `oauth_token_records`, `platform_capability_snapshots` (v9). **No provider credentials exist on this machine** (`GOOGLE_OAUTH_*`, `META_*`, `TIKTOK_*` all unset) → connect/publish return `422 CONFIGURATION_ERROR` naming the missing variables. End-to-end mechanics are mock-verified (F38) |
| F38 | Publishing jobs, validation, approval, scheduling engine, calendar, queue, history, attempts, metrics sync stub-path | 2 | `publishing.ts`; tables `publish_jobs`, `post_metadata`, `post_validation_results`, `scheduled_posts`, `publish_attempts`, `platform_posts`, `publishing_error_log`, `post_analytics_snapshots` (v9); DB-backed scheduler worker. UI: `PublishingPage.tsx` (2,077 LOC, Accounts/Publish/Calendar/Queue/History/Settings). Suite: `publishing.e2e.mjs` — **against a clearly-labelled LOCAL MOCK provider**; real-account acceptance (§22/§23-type items) remains credentials-pending |
| F39 | Platform webhooks (Meta verify + events, TikTok events) | 4 | **Backend only — no UI exists or is needed:** `GET/POST /api/publishing/webhooks/meta`, `POST /api/publishing/webhooks/tiktok`; table `platform_webhook_events`. Covered in `publishing.e2e.mjs` (incl. no-secret → `503 CONFIGURATION_ERROR`) |
| F40 | Publishing to X (Twitter) / LinkedIn | 7 | **Missing.** `providers.ts`: `PLATFORMS = ["youtube", "instagram", "tiktok"]` — no X/LinkedIn adapter, account type, or route. (X/LinkedIn names appear only as Phase 9 *export* presets, F35) |

### Analytics (Phase 11)

| ID | Feature | Class | Evidence |
|---|---|---|---|
| F41 | Analytics — capability-aware per-platform metrics, overview/comparison/trends/posts/history, comparison groups, posting-time analysis, deterministic insights with evidence, sync jobs (state machine, retry/cancel, boot recovery), PDF/CSV/XLSX report builder on the background worker | 2 | `server/src/analytics.ts` (34 routes) + `analyticsCore.ts`, `analyticsProviders.ts`, `analyticsReports.ts`; tables: 14 `analytics_*` tables (v11). UI: `AnalyticsPage.tsx` (1,320 LOC, 9 tabs) + hand-rolled SVG `components/analytics/Charts.tsx`. Suite: `analytics.e2e.mjs` against a **LOCAL MOCK analytics provider**. Design rule verified in-suite: unavailable ≠ zero (NULL + availability status), transparent engagement formulas. Real-account data requires F37 credentials **plus** extra scopes Phase 10 deliberately did not request (YouTube `yt-analytics.readonly` is the exception path; Instagram insights scope and TikTok Display API scope require reconnect) — see `config.ts` Phase 11 note |

### Workspaces, usage, plans, admin (Phase 12)

| ID | Feature | Class | Evidence |
|---|---|---|---|
| F42 | Workspaces — Personal + team workspaces, switch/default/archive/delete, logos, members, role enforcement (OWNER/EDITOR/VIEWER), invitations (pending/accept/reject) + accept-invitation page | 1 | `account.ts` `/workspaces/*`, `/invitations/*` (21 routes in this group); tables `workspaces`, `workspace_members`, `workspace_invitations` (v12); role guard `accountCore.ts`. UI: `SettingsPage.tsx` workspace sections + `AppShell` switcher + `pages/auth/AcceptInvitationPage.tsx`. Suite: `account.e2e.mjs` (cross-workspace 404s, VIEWER mutation 403s) |
| F44 | Usage ledger — immutable append-only ledger fed by real operations (upload, export, background jobs…), overview + history, plan-limit surfacing; ledger rows survive account deletion anonymised (v14: `ON DELETE SET NULL`) | 1 | `account.ts` `/usage/overview`, `/usage/history`; `accountCore.ts` ledger writers; table `usage_ledger` (v12, rebuilt v14). Suite: `account.e2e.mjs` — ledger is fed by a *real* upload and asserts failed usage never enters successful totals |
| F47 | Plans & entitlements — plan records (prices NULL — never invented), entitlements, user subscriptions, subscription events, cancel-request | 1 | `account.ts` `/plans`, `/subscription`, `/subscription/cancel-request`; admin side in `admin.ts` `/admin/plans/*`; tables `plans`, `plan_entitlements`, `user_subscriptions`, `subscription_events`, `invoices` (v12). Suite: `account.e2e.mjs` |
| F48 | Payments — checkout + provider webhook foundation | 5 | Adapter foundation exists (provider records, signed-webhook verification, idempotent event log): tables `payment_provider_records`, `payment_webhook_events`; `POST /api/payments/webhook/:provider`; `POST /subscription/checkout`. Gate: `paymentsStatus()` requires `PAYMENTS_ENABLED=true` + `PAYMENT_PROVIDER` + merchant key/secret + webhook secret — none present → checkout honestly returns `CONFIGURATION_ERROR`. Webhook idempotency itself is suite-tested (`account.e2e.mjs` §#20 checks) |
| F49 | Admin Console — overview, users (suspend/reactivate/recovery/plan), workspaces, projects, jobs, render queue, publishing jobs, providers (test/patch), integrations, usage, plans, reports, audit log (append-only), system health, support queue | 1 | `server/src/admin.ts` (28 routes, all gated server-side by `is_admin`; bootstrap only via `ADMIN_EMAILS` env); tables `admin_audit_log`, `system_health_checks`, `provider_configurations` (v12). UI: `AdminPage.tsx` (1,255 LOC). Suite: `account.e2e.mjs` admin sections (incl. "never secrets" user-detail check) |
| F50 | Support tickets — user create/list/detail/messages; admin queue/reply/status | 1 | `account.ts` `/support/tickets/*` + `admin.ts` `/admin/support/tickets/*`; tables `support_tickets`, `support_ticket_messages`. Delivery is honestly "stored in CLIPFORGE only" (no email/helpdesk integration — asserted in-suite) |
| F51 | Privacy data export — request, background ZIP generation, download (ZIP contents verified in-suite: `profile.json`, `projects.json`, `usage.json`, …) | 1 | `account.ts` `/privacy/data-export(s)`; worker in `startAccountWorker`; table `data_export_jobs`. Suite: `account.e2e.mjs` opens and inspects the real ZIP |
| F52 | Account deletion — request, pending-state login/session block, background deletion workflow, status | 1 | `account.ts` `/privacy/account-deletion`, `/privacy/deletion-status`; table `account_deletion_jobs`; `app.ts` session check refuses deleted-pending accounts. Suite: `account.e2e.mjs` |

### Platform architecture (spec-named infrastructure)

| ID | Feature | Class | Evidence |
|---|---|---|---|
| F53 | Redis / BullMQ / PostgreSQL / S3 (as named in the original phase specs) | 7 | **Not present — substituted, documented everywhere, never claimed.** Evidence: root `package.json` deps are only `react`, `react-dom`; `server/package.json` deps are `@node-rs/argon2`, `cookie-parser`, `exceljs`, `express`, `express-rate-limit`, `multer`, `nodemailer`, `pdfkit`, `zod` — no `pg`, `redis`, `bullmq`, or AWS SDK. `server/src/db.ts` uses `node:sqlite` (`DatabaseSync`) with the header decision note: *"this development machine has no PostgreSQL, so the server runs on SQLite with portable, standard SQL."* Every worker module repeats the same note (e.g. `analysis.ts`: "Redis/BullMQ do NOT run in this environment and are not claimed to"; `broll.ts`, `export.ts`, `publishing.ts` idem). Media is local disk (`config.mediaDir`), not S3. The functional substitutes — SQLite job tables + in-process workers with boot recovery — are class 1 (see F15/F18/F35/F38/F41/F51) |

---

## Duplicate components & overlapping surfaces

| Finding | Detail |
|---|---|
| `ProjectCard` vs `ProjectCardView` | `src/components/ProjectCard.tsx` is a generic Phase 2 shell card (title/detail/status props, comment: "Used only with real projects in later phases"); the real project card used everywhere is `src/components/studio/ProjectCardView.tsx` (thumbnail, workflow, source, status, rename/delete). Two card components for one concept; the generic one survives only via `StudioPage`/`ProjectsPage` import lists — verify before deleting, its `StatusIndicator` styling is shared |
| Publishing route aliases | `src/App.tsx` maps `publishing`, `publishing-calendar` to the *same* `PublishingPage variant="calendar"` (legacy hash kept deliberately, comment in code). Not a bug; one redundant route entry |
| Editor entry vs editor | `src/pages/EditorPage.tsx` is a project *chooser* (78 LOC); the real editor is `src/pages/studio/VideoEditorPage.tsx`. Intentional, but the nav label "AI Editor" lands on a list, not an editor |
| Templates page naming | `TemplatesPage.tsx` is titled "Templates & Brand Kit" but caption templates are only listed/duplicated/deleted there — template *editing* lives in `CaptionStudio` inside the editor. Documented in the file header; still a discoverability overlap |
| Two render paths | Phase 5 editor render (`editor.ts` `/editor/:docId/render`) and Phase 9 Export Studio (`export.ts`) share the `render_jobs` table and worker (Phase 9 added `kind`/`priority`/`progress_json` columns). Deliberate unification, but two UI surfaces create/export renders |
| Empty feature folders | `src/features/{analytics,clips,editor,projects,publishing,video-input}/` are **empty directories**; `src/features/README.md` still describes them as "future homes… no feature code lives here yet" — stale: the real code lives in `src/pages/`, `src/components/`, `src/services/`. Only `features/auth/` and `features/studio/` contain code |

## Dead code (verified by grep — no importers)

| Item | Verification |
|---|---|
| `src/components/VideoCard.tsx` (23 LOC, default export `VideoCard`) | Zero import statements anywhere in `src/` reference it (`grep` for `VideoCard` returns only its own file). **Dead** |
| `src/components/WorkflowStrip.tsx` (44 LOC) + `src/components/WorkflowStrip.module.css` | Zero importers. Root `README.md` itself notes: "The Phase 1 `WorkflowStrip` file remains on disk but is no longer rendered on the Phase 3 landing page". **Dead (self-acknowledged)** |
| `src/types/project.ts` (`WorkflowStep`, `FutureProject`) | Its only importer is the dead `WorkflowStrip.tsx`. Milestone-1 planning types; nothing in the live app uses them. **Dead by transitivity** |

No dead **backend** modules: every file in `server/src/` is imported by at least one other module (full import graph checked; entry point is `index.ts` → `app.ts` + 8 worker starters). All other frontend default exports have ≥1 importer, including the editor sub-panels (`CaptionStudio`, `EnhancePanel`, `ReframePanel` are named exports consumed via `Inspector.tsx`).

## TODO / FIXME / stub markers

- `TODO`, `FIXME`, `XXX`, `HACK`: **0 occurrences** in `src/` and `server/src/` (grep-verified).
- The word "stub" appears exactly 3 times, all describing the honest Phase 8 provider adapters: `server/src/config.ts` (Phase 8 note), `server/src/broll.ts` (status detail), `server/src/admin.ts` (background-removal provider detail).
- "Placeholder" occurrences are either (a) the intentional landing `MediaPlaceholder` system (F02), (b) `PlaceholderPage`/`ClipsPage` (F36), (c) form input `placeholder=` attributes, or (d) SQL parameter placeholders. No hidden placeholder logic masquerading as a feature.

## Honest-stub providers — all class 5, none broken

| Provider | Gate (env) | Behaviour when unset |
|---|---|---|
| SMTP email | `SMTP_HOST/USER/PASS/FROM` | Outbox file write + UI disclosure |
| Google sign-in | `GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI` | Button labelled not-configured |
| YouTube metadata (Studio) | `YOUTUBE_API_KEY` | URL validation still works; metadata unavailable |
| STT remote | `OPENAI_API_KEY` / `STT_API_KEY` (+ `STT_PROVIDER`) | Local faster-whisper is the default and works |
| Caption translation | `TRANSLATION_PROVIDER` + `TRANSLATION_API_KEY` | Job fails `CONFIGURATION_ERROR`; manual translation works |
| Stock B-roll | `STOCK_PROVIDER` + `STOCK_API_KEY` (+ adapter body) | `422 CONFIGURATION_ERROR`, `implemented:false` |
| AI generation | `AI_GENERATION_PROVIDER` + `AI_GENERATION_API_KEY` (+ adapter body) | Same |
| Background removal | `BACKGROUND_REMOVAL_PROVIDER`/`_API_KEY` or `BACKGROUND_MODEL_PATH` (+ adapter body) | Persisted FAILED job, `CONFIGURATION_ERROR` |
| YouTube publishing/analytics | `GOOGLE_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI` + `TOKEN_ENCRYPTION_KEY` | `422 CONFIGURATION_ERROR` naming missing vars |
| Instagram publishing/analytics | `META_APP_ID/SECRET/REDIRECT_URI` (+ webhook verify token) | Same |
| TikTok publishing/analytics | `TIKTOK_CLIENT_KEY/SECRET/REDIRECT_URI` | Same |
| Payments | `PAYMENTS_ENABLED` + `PAYMENT_PROVIDER` + merchant + webhook secrets | Checkout `CONFIGURATION_ERROR`; webhook idempotency still tested |
| Cloud storage import | — (no adapter exists) | Class 3, see F12 — the one "not configured" surface with *no* adapter behind it |
| URL import | `YTDLP_BIN` (default `yt-dlp` on PATH); `URL_IMPORT_ENABLED=false` disables | Class 2, see F11 — implemented (yt-dlp); disabled/missing binary ⇒ `422 CONFIGURATION_ERROR` naming the dependency |
| Admin bootstrap | `ADMIN_EMAILS` | No admin exists until an email is listed; gate is server-side on every `/api/admin/*` request |

## Unfinished integrations (summary)

1. **F36** — My Clips nav page never wired to the (complete) clips backend.
2. **F23** — Brand intro/outro/music stored, never composited into any render.
3. **F02/F03** — Landing media + legal pages await real assets/text (user-directed hold on media).
4. **F30–F32** — Phase 8 provider adapters are interfaces only; adding an API key alone will **not** enable them (adapter body must be implemented — stated in `config.ts`).
5. **F37/F41** — Publishing/analytics real-account acceptance is blocked on platform credentials *and*, for analytics, on wider OAuth scopes than Phase 10 requested.
6. **README drift** — root `README.md` still describes the project as "Phase 3 complete… upload, AI analysis, captions, editing, export, publishing and analytics are not implemented yet", which has been false since Phase 4. `server/README.md` and `src/features/README.md` carry similar stale passages. Documentation only; no code impact.
