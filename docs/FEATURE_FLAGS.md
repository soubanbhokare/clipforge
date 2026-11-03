# CLIPFORGE — Feature Flags & Configuration Gates (§22 Assessment)

Phase 13 deliverable. CLIPFORGE has **no feature-flag system** in the
product sense (no flag service, no percentage rollouts, no per-user
targeting). What it has is a consistent, honest system of
**configuration gates**: a capability exists exactly when its real
prerequisites exist, the server computes that truth, and the UI
surfaces it — including the *names of the missing variables* — instead
of faking availability. This document inventories every gate and
gives the verdict on §22's intent.

## Gate inventory

All gates are computed server-side. "Restart to change" applies to
every env-based gate: config is read once at boot in
`server/src/config.ts`.

| # | Gate | Where it lives | Controls | How the unavailable state is surfaced |
|---|---|---|---|---|
| F1 | `emailConfigured = Boolean(SMTP_HOST)` | `server/src/config.ts` (exported const); adapter in `server/src/email.ts` | SMTP delivery vs file outbox | UI states the verification email "was written to the server outbox, not delivered" (`src/components/AppShell.tsx`); boot log prints `email=SMTP` or `email=outbox (dev)` |
| F2 | `googleConfigured` (all 3 Google sign-in vars) | `server/src/config.ts` | "Continue with Google" | Control shows a labelled not-configured state; boot log prints the status |
| F3 | `youtubeConfigured = Boolean(YOUTUBE_API_KEY)` | `server/src/config.ts` | YouTube URL metadata validation | API/UI report not configured; no metadata is invented |
| F4 | STT provider gate (`sttProviderStatus()`: local probe or API-key presence) | `server/src/stt.ts:47-120`; config in `config.ts` (Phase 4 block) | Transcription / clip detection | Jobs fail with a persisted `CONFIGURATION_ERROR` and the provider's own detail string; never a fake transcript |
| F5 | `translationConfigured` (provider + key) | `server/src/config.ts` (`translationConfigured` export) | Caption translation | Caption Studio states translation is not configured and offers manual tracks instead (`Captions` UI + `server/src/captions.ts`) |
| F6 | Tracking model presence (YuNet / YOLO files on disk, OpenCV importable) | `server/src/tracking.ts`, `server/src/config.ts` (Phase 7 block) | Face lock / active speaker / reframing | Panel disables with the server's detail (`src/components/editor/ReframePanel.tsx`); jobs fail `CONFIGURATION_ERROR` |
| F7 | Phase 8 provider gates ×3 — `configured = envGate && ADAPTER_IMPLEMENTED` | `server/src/broll.ts:145-235` (status builders), env side in `config.ts` (`stockProviderConfigured` etc.) | Stock import, AI generation, background removal | Enhance Panel shows each provider as "not configured — <detail>"; operations fail honestly. Adapters are stubs (`implemented:false`), so **no env change can open these gates today** — by design, the status can never claim readiness the code lacks |
| F8 | Publishing provider gates ×3 — `publishingProviderStatus(platform)` returns `{configured, missing[]}` | `server/src/config.ts:245-276` | YouTube / Instagram / TikTok connect + publish | Publishing Center lists each platform with `Missing: VAR, VAR` (`src/pages/PublishingPage.tsx:302,1951`); connect/publish endpoints return `422 CONFIGURATION_ERROR` |
| F9 | Per-account **capability** records (scopes actually granted) | `server/src/analyticsProviders.ts` (detection), `server/src/analytics.ts:1248-1290` (`GET /capabilities`) | Which analytics metrics may be requested per connected account | Unavailable metrics are stored/shown as **unavailable — never 0**; the capability panel names the missing scope; unconfigured platforms appear as `{configured:false, missing:[…]}` entries (`src/pages/AnalyticsPage.tsx:1110-1255`) |
| F10 | `paymentsStatus()` — enabled flag AND provider AND 3 credentials | `server/src/config.ts` (`paymentsStatus()`) | Payments foundation / checkout | Status surface lists every missing item incl. `PAYMENTS_ENABLED`; checkout returns `CONFIGURATION_ERROR`. No adapter exists, so this gate cannot open to real charging |
| F11 | `REQUIRE_EMAIL_VERIFICATION` | `server/src/config.ts:26-27` | Whether unverified users may sign in | Verification state shown honestly in the UI either way |
| F12 | Admin bootstrap `ADMIN_EMAILS` | `server/src/config.ts:209-212`, `isAdminEmail()` | Who receives `is_admin` (at registration + every login) | No UI surface (deliberately); the Admin Console itself is gated server-side per request |
| F13 | **Admin provider toggles** — `provider_configurations.enabled` + `secret_ref`, per provider key (stt, translation, llm_clip_analysis, tracking, active_speaker, enhancement, background_removal, image_generation, video_generation, stock_media, …) | `server/src/admin.ts:84-…` (registry + routes), table in `server/src/db.ts:1691` | An admin can **disable** a configured provider at runtime and run/record live health checks | Admin Console → Integrations & Health (`src/pages/AdminPage.tsx:576-…`): Configured / Enabled / Last health check per provider. The layering rule is enforced in code: *a toggle never makes an unconfigured provider look configured* — enable only subtracts, never fabricates |
| F14 | Plan entitlements (`plan_entitlements.feature_enabled`, limits) | `server/src/db.ts` (Phase 12 plans) | Per-plan feature availability / quotas for workspaces | Settings/usage surfaces read the entitlement rows; seeded plans carry `NULL` prices (no invented pricing) |

## Verdict against §22's intent

§22's intent — features must be switchable without a code change,
unavailable features must present honestly, and an operator must be
able to see and control what is live — is **substantially satisfied
for capability gating, and not satisfied as a general flag system**:

**What satisfies the intent**

- Every external capability is gated on its real prerequisites, the
  gate is computed in exactly one server-side place, and the
  unavailable state is a first-class UI state (named missing
  variables/scopes, persisted `CONFIGURATION_ERROR` jobs) rather
  than a hidden failure or a fake success. This is stronger than a
  typical boolean flag: the flag *cannot* disagree with reality for
  F4–F9.
- F13 is a genuine runtime control: an admin can disable a provider
  without a redeploy, with health checks persisted alongside.
- F14 gives per-plan feature switches in data, not code.

**What is missing (explicit gaps)**

1. **No runtime toggle for env gates.** F1–F12 change only by editing
   the environment and restarting. There is no admin UI to flip, say,
   `REQUIRE_EMAIL_VERIFICATION` or to maintenance-mode the app.
2. **No general-purpose flag store.** There is no table/registry for
   arbitrary product flags (e.g. "new editor beta"), no per-user /
   per-workspace targeting, no percentage rollout, no flag audit
   history beyond the admin audit log entries for provider updates.
   Adding a new experimental feature today means shipping code with
   its own ad-hoc gate.
3. **No frontend-only flags.** The frontend has exactly one env var
   (`VITE_API_URL`, build-time); UI experiments cannot be toggled
   without a rebuild.
4. **Kill-switch asymmetry.** F13 can disable providers, but core
   flows (uploads, exports, sign-up) have no equivalent operator
   kill-switch short of stopping the service.

**Recommendation (for the lead, not implemented here):** if §22 must
be met literally, extend the F13 pattern — a small
`feature_flags` table (key, enabled, scope, updated_by/at) read by
the server and exposed read-only to the frontend, seeded from the
existing env gates — rather than adopting an external flag service.
That preserves this codebase's best property: a flag may hide a
feature, but the *configured* truth underneath stays computed from
real prerequisites and can never be toggled into existence.
