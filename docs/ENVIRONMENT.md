# CLIPFORGE — Environment Configuration

Phase 13 deliverable. This is the authoritative configuration
reference, produced by grepping the entire codebase
(`src/`, `server/src/`, `vite.config.ts`) for every
`process.env.*`, `intEnv("…")` and `import.meta.env.*` read.

## Inventory summary

| Scope | Count |
|---|---|
| Application variables (total) | **85** |
| — Frontend (`import.meta.env`) | 1 (`VITE_API_URL`) |
| — Server (`server/src/config.ts` + 3 direct reads) | 84 |
| OS-provided, not application config | 1 (`HOME`, fallback in `server/src/tracking.ts:240`) |
| **Required in production** | **2 hard + 4 operational** (see below) |

Almost everything is centralised in `server/src/config.ts`. Only
three variables are read outside it:

| Variable | Read at | Default | Notes |
|---|---|---|---|
| `RENDER_CONCURRENCY` | `server/src/editor.ts:3143` | 1 (clamped 1–4, invalid → 1) | Duplicates the config.ts pattern instead of using `config` — harmless, but a second source of truth. |
| `PUBLISH_STATUS_POLL_MS` | `server/src/publishing.ts:1261` | 5000 | Module-level constant; changing it needs a restart (true of all vars). |
| `SILERO_VAD_MODEL` | `server/src/tracking.ts:238` | `""` → falls back to the faster-whisper-bundled model path | Also reads `HOME` for that fallback path. |

### Required in production

**Hard-required (the deployment must supply them; the app does not
enforce this — see gap G1):**

1. `TOKEN_ENCRYPTION_KEY` — base64 of exactly 32 random bytes
   (`openssl rand -base64 32`). AES-256-GCM key for OAuth tokens and
   TOTP secrets at rest (`server/src/tokenCrypto.ts`). Without it the
   server silently generates/uses `server/data/.token-key` (0600) and
   only logs a warning — acceptable in dev, not in production: losing
   or rotating that file makes every stored token undecryptable.
2. `NODE_ENV=production` — controls the `Secure` flag on the session
   cookie (`server/src/app.ts`, `secure: config.isProduction`). Any
   other value (including a typo) silently disables it (gap G3).

**Operationally required (app boots without them, but the deployment
is wrong without them):**

3. `APP_BASE_URL` — public frontend origin; used for email links and
   as the fallback for `PUBLIC_APP_URL`. Default `http://localhost:5173`.
4. `PUBLIC_APP_URL` — public origin used to build OAuth callbacks /
   post-connect redirects. Falls back to `APP_BASE_URL`.
5. `ADMIN_EMAILS` — comma-separated; the **only** way anyone becomes
   admin (checked at registration and every login). Empty = no
   admins exist. Note: removing an address later does **not** revoke
   an already-granted flag.
6. `DATABASE_FILE` + the storage dirs (`MEDIA_DIR`, `PROCESSING_DIR`,
   `ANALYTICS_REPORTS_DIR`, `AVATARS_DIR`, `DATA_EXPORTS_DIR`,
   `WORKSPACE_LOGOS_DIR`) — defaults live under `server/data/`; in a
   container/host deployment they must point at persistent storage or
   data is lost on redeploy.

**There is no `SESSION_SECRET`** — by design, not omission. Sessions
are server-side rows: the cookie holds a 32-byte random token and the
DB stores only its SHA-256 hash (`server/src/app.ts:61-63`). Nothing
needs a signing secret, so nothing validates one.

## Full server variable list

Defaults are the code defaults in `server/src/config.ts` unless a
different file is named. "Breaks without it" = the honest failure
mode today (gates return `422 CONFIGURATION_ERROR` naming the
missing variables; nothing is faked).

### Core

| Var | Default | Required? | Breaks without it |
|---|---|---|---|
| `PORT` | 3001 | No | — (dev proxy expects 3001) |
| `NODE_ENV` | `development` | **Yes (=production)** | Secure cookie off; see G3 |
| `APP_BASE_URL` | `http://localhost:5173` | Operational | Email links / OAuth redirects point at localhost |
| `PUBLIC_APP_URL` | falls back to `APP_BASE_URL` | Operational | Same as above for publishing OAuth |
| `DATABASE_FILE` | `server/data/clipforge.db` | Operational | Data lands wherever the process was started from |
| `SESSION_TTL_HOURS` | 12 | No | — |
| `REMEMBER_ME_TTL_DAYS` | 30 | No | — |
| `REQUIRE_EMAIL_VERIFICATION` | `false` | No | When `false`, unverified users can sign in (UI shows state honestly) |
| `LOGIN_RATE_MAX` / `REGISTER_RATE_MAX` / `RESET_RATE_MAX` / `RESEND_RATE_MAX` | 10 / 10 / 5 / 3 per window | No | — |
| `ADMIN_EMAILS` | *(empty)* | Operational | No admin can ever exist |

### Email

| Var | Default | Notes |
|---|---|---|
| `SMTP_HOST` | *(empty)* | The gate: empty ⇒ dev **outbox** adapter writes JSON files to `server/data/outbox/` (hard-coded path, `server/src/email.ts:27`); nothing is delivered and the UI says so. Set ⇒ real delivery via nodemailer; free hosts include Brevo (`smtp-relay.brevo.com`, free 300 emails/day) and Resend (`smtp.resend.com`, free tier) |
| `SMTP_PORT` | 587 | |
| `SMTP_USER` / `SMTP_PASS` | *(empty)* | Not validated even when host is set (gap G6) |
| `SMTP_FROM` | `CLIPFORGE <no-reply@localhost>` | |

### Storage / media / workers

| Var | Default |
|---|---|
| `MEDIA_DIR` | `server/data/media` |
| `MAX_UPLOAD_MB` | 500 |
| `UPLOAD_SESSION_TTL_MINUTES` | 30 |
| `PROCESSING_DIR` | `server/data/processing` |
| `ANALYTICS_REPORTS_DIR` | `server/data/reports` |
| `AVATARS_DIR` | `server/data/avatars` |
| `DATA_EXPORTS_DIR` | `server/data/data-exports` |
| `WORKSPACE_LOGOS_DIR` | `server/data/workspace-logos` |
| `RENDER_CONCURRENCY` | 1 (1–4) |
| `PUBLISH_TICK_MS` / `ANALYTICS_TICK_MS` / `ACCOUNT_TICK_MS` | 1000 each |
| `PUBLISH_STATUS_POLL_MS` | 5000 |
| `ANALYTICS_MAX_SYNC_ATTEMPTS` / `ANALYTICS_BACKOFF_BASE_SEC` | 3 / 30 |

FFmpeg/FFprobe have **no** variables — they are invoked by bare name
from `PATH`. The binary knobs are `PYTHON_BIN` (default `python3`)
and `YTDLP_BIN` (default `yt-dlp`, URL import — see Providers & AI).

### Providers & AI

| Group | Vars | Gate behaviour |
|---|---|---|
| YouTube metadata | `YOUTUBE_API_KEY` | Empty ⇒ URL validator reports not configured. The key only ever fetches metadata for the validator; downloading a video the user pastes is the separate URL-import path below (yt-dlp, no key) |
| URL import (yt-dlp) | `YTDLP_BIN` (default `yt-dlp`), `URL_IMPORT_ENABLED` (default on when the binary resolves), `URL_IMPORT_ALLOW_PRIVATE` (default off) | Binary missing or feature disabled ⇒ `POST /projects/:id/url-import` returns `422 CONFIGURATION_ERROR` naming the dependency and `/studio/config` reports `urlImport.enabled: false`. `URL_IMPORT_ALLOW_PRIVATE=1` lifts the SSRF private-address block for the e2e fixture server ONLY — never in production |
| STT | `STT_PROVIDER` (default `local-faster-whisper`), `WHISPER_MODEL` (default `small` / `whisper-1`), `STT_API_BASE`, `OPENAI_API_BASE`, `OPENAI_API_KEY`, `STT_API_KEY`, `PYTHON_BIN` | OpenAI-compatible mode without a key ⇒ jobs fail `CONFIGURATION_ERROR`; local mode probes the Python import at runtime |
| Translation | `TRANSLATION_PROVIDER`, `TRANSLATION_API_KEY`, `TRANSLATION_API_BASE` | Unset ⇒ translation jobs fail honestly; manual tracks always work |
| Tracking | `TRACKING_MODELS_DIR`, `TRACKING_FACE_MODEL`, `TRACKING_PERSON_MODEL`, `SILERO_VAD_MODEL` | Missing model files ⇒ `CONFIGURATION_ERROR`, detection never simulated |
| Phase 8 — stock (Pexels, implemented) | `PEXELS_API_KEY`, `PEXELS_API_BASE` (testing override, default `https://api.pexels.com`), `STOCK_PROVIDER` (unset or `pexels` selects the Pexels adapter; any other value has no adapter) | `PEXELS_API_KEY` set ⇒ stock search/import run for real against the Pexels Videos API (free key from pexels.com/api); unset ⇒ `422 CONFIGURATION_ERROR` naming the key, exactly as before |
| Phase 8 — generation / background (stubs) | `AI_GENERATION_PROVIDER`, `AI_GENERATION_API_KEY`, `BACKGROUND_REMOVAL_PROVIDER`, `BACKGROUND_REMOVAL_API_KEY`, `BACKGROUND_MODEL_PATH` | Adapters are `implemented:false` stubs (`server/src/broll.ts`) — setting keys alone does **not** enable them; no genuinely free production API exists for either |

### OAuth — sign-in vs publishing (separate clients, do not mix)

| Purpose | Vars |
|---|---|
| Google sign-in (Phase 2) | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` — all three or the control shows not-configured |
| YouTube publishing (Phase 10) | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI` |
| Instagram publishing | `META_APP_ID`, `META_APP_SECRET`, `META_REDIRECT_URI`, `META_WEBHOOK_VERIFY_TOKEN` |
| TikTok publishing | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_REDIRECT_URI` |
| Token encryption | `TOKEN_ENCRYPTION_KEY` (see Hard-required) |
| Analytics | reuses Phase 10 tokens; only override: `YOUTUBE_ANALYTICS_API_BASE` |

### Endpoint overrides (testing / sandbox ONLY)

`YOUTUBE_AUTH_BASE`, `YOUTUBE_TOKEN_URL`, `YOUTUBE_REVOKE_URL`,
`YOUTUBE_API_BASE`, `META_AUTH_BASE`, `META_TOKEN_URL`,
`META_GRAPH_BASE`, `TIKTOK_AUTH_BASE`, `TIKTOK_API_BASE`,
`PEXELS_API_BASE`.
Defaults are the official production endpoints. They exist so e2e
suites can point the real adapters at a local mock. **Leave unset in
production.**

### Payments (foundation, disabled)

`PAYMENTS_ENABLED` (default `false`), `PAYMENT_PROVIDER`,
`PAYMENT_MERCHANT_KEY_ID`, `PAYMENT_MERCHANT_SECRET`,
`PAYMENT_WEBHOOK_SECRET`. The gate (`paymentsStatus()` in config.ts)
requires the flag AND provider AND all three credentials; no provider
adapter exists in this build, so checkout returns
`CONFIGURATION_ERROR` regardless. Setting these does not enable real
charging.

## Startup validation — what is actually checked (Phase 13 audit)

`server/src/config.ts` performs **no startup validation at all**:
no required-variable check, no `process.exit`, no throw. Every value
falls back to a default or an empty string, and `server/src/index.ts`
boots unconditionally (it logs only email/Google/verification status).
Features then fail **per-request** with honest `CONFIGURATION_ERROR`s.
That is safe for feature gates, but it is **not** fail-safe for
production-critical settings:

| # | Gap | Location | Risk |
|---|---|---|---|
| G1 | `TOKEN_ENCRYPTION_KEY` not required in production; falls back to a dev key file with only a `console.warn`. The 32-byte length is validated **lazily**, on first encrypt/decrypt — not at boot. | `server/src/tokenCrypto.ts:29-68` (validation at :35-38; fallback at :41-68); `config.ts:143` | Production can run indefinitely on a key stored next to the database it protects; a malformed key crashes the first publishing/MFA request instead of the boot. **Mitigated at the deployment layer**: `docker-compose.yml` refuses to start without the variable (`:?` form). App fix (fail at boot when `isProduction && !key`) is recommended for lead coordination. |
| G2 | No config-validation function exists anywhere; nothing cross-checks related vars (e.g. `PUBLIC_APP_URL` vs OAuth redirect URIs). | `server/src/config.ts` (whole file); `server/src/index.ts:14-55` | Misconfiguration surfaces as user-facing errors, not a boot failure. |
| G3 | `NODE_ENV` accepts any string; `isProduction` is true only for the exact value `production`. A typo (`prod`, `Production`) silently yields a non-production boot — session cookie loses `Secure`. | `config.ts:18-20`; cookie at `server/src/app.ts:206-212` | Silent security downgrade. |
| G4 | `ADMIN_EMAILS` unvalidated and unaudited at boot (no log of how many admins were bootstrapped). Empty is fail-closed (no admins) — safe, but silent. | `config.ts:209-212` | Operator may believe an admin exists when the variable was mistyped/not loaded. |
| G5 | `intEnv()` silently falls back on any non-positive/non-numeric value for every numeric knob (`PORT`, TTLs, rate limits, ticks, `MAX_UPLOAD_MB`). | `config.ts:9-14` | A typo'd `MAX_UPLOAD_MB` or rate limit silently becomes the default. |
| G6 | `emailConfigured` is `Boolean(SMTP_HOST)` only; `SMTP_USER`/`SMTP_PASS`/`SMTP_FROM` are never checked, so a partial SMTP config reports "configured" and fails later at send time inside nodemailer. | `config.ts` (`emailConfigured`, end of file); `server/src/email.ts:32-45` | Misleading status surface. |
| G7 | `APP_BASE_URL` / `PUBLIC_APP_URL` are never URL-validated; any string is concatenated into email/OAuth links. | `config.ts:21,142` | Broken links discovered by users, not by the server. |
| G8 | What **does** fail fast (credit where due): migrations throw on `foreign_key_check` violations and set `PRAGMA user_version` transactionally. | `server/src/db.ts:1928,1964,2034` | — (positive finding) |

No real-looking secret values were found anywhere in the codebase
during this audit (scan for common key prefixes/PEM headers across
`src/`, `server/src/`, `server/scripts/` and both `.env.example`
files: clean). All credential variables default to empty strings.

## Per-environment matrix

| Setting | Local dev | Test (e2e/CI) | Staging | Production |
|---|---|---|---|---|
| Frontend `VITE_API_URL` | unset (`/api` via Vite proxy → :3001) | unset | unset (same-origin via proxy) | unset (same-origin via proxy); set only for a split-origin deploy, then rebuild |
| `NODE_ENV` | `development` | `test` | `production` | `production` |
| `PORT` | 3001 | suite-assigned | 3001 (container-internal) | 3001 (container-internal) |
| Host | this machine | CI runner | Oracle Cloud Always Free A1 instance (free route — see DEPLOYMENT.md) | same free instance until the paid upgrade (own domain and/or bigger host) |
| DB | `server/data/clipforge.db` | throwaway file per suite (`DATABASE_FILE` in tmp) | SQLite file in the `clipforge-data` volume | SQLite file in the persistent volume — **single-host only** (see DEPLOYMENT.md scaling limits) |
| Storage dirs | defaults under `server/data/` | tmp dirs | volume paths (compose sets them) | volume / mounted-disk paths, backed up |
| FFmpeg | from `PATH` (host install) | CI apt install | in the api image | in the api image |
| Email | outbox (no SMTP) | outbox | real SMTP if deliverability is under test, else outbox | real SMTP (`SMTP_HOST/USER/PASS/FROM` all set) |
| `TOKEN_ENCRYPTION_KEY` | unset (dev key file) | unset | **set, staging-only value** | **set, production-only value, from the secret store** |
| `ADMIN_EMAILS` | dev address | unset | staging operator | production operator(s) |
| OAuth / providers | all unset (gates show not-configured) | unset — suites use a **local mock** via the endpoint-override vars | sandbox apps where the platform offers them | real developer apps; redirect URIs registered exactly as deployed |
| Payments | disabled | disabled | disabled | disabled (no adapter exists) |
| Public URLs | `http://localhost:5173` | n/a | free subdomain (DuckDNS) over HTTPS — see DEPLOYMENT.md | free subdomain (HTTPS); own domain `clipforge.io` on the paid upgrade |
| CORS | dev origins `localhost:5173` / `127.0.0.1:5173` only (`server/src/app.ts:285-300`) | same | **same-origin only — the backend serves no CORS for other origins; a split-origin staging will not work without a code change** | same-origin only (same note) |
| Webhooks | n/a (no public URL) | mock | Meta verify token = staging value | `META_WEBHOOK_VERIFY_TOKEN` + provider secrets; signatures verified over the raw body |

## Secret management

- **Never** in git, never in a Docker image, never in a `VITE_*`
  variable (bundled into public JS), never in this repo's docs.
- Local dev: `server/.env` (gitignored) or shell exports. The root
  `.gitignore` already covers `.env`, `.env.local`, `server/data/`.
  The project is **not currently under git** — the moment it is,
  verify `.env` files are untracked before the first commit (see
  RELEASE_PROCESS.md).
- CI: GitHub Actions secrets / Environment secrets; the workflow in
  `.github/workflows/ci.yml` needs **no** secrets for its build/test
  gates (suites run against local mocks and the outbox).
- Staging/production host: environment supplied to the container by
  the operator (host env file outside the repo, mode 0600, owned by
  the deploy user) — `docker-compose.yml` reads `TOKEN_ENCRYPTION_KEY`
  and `ADMIN_EMAILS` from the host environment and `server/.env` as an
  optional `env_file`. On a larger target, substitute the platform's
  secret manager (cloud KMS/secret store, Vault) — the app only ever
  reads plain environment variables, so any injector works.
- Rotation: `TOKEN_ENCRYPTION_KEY` rotation **invalidates every
  stored OAuth token and TOTP secret** (single-key design, no key
  versioning in the envelope beyond `v:1`). Plan rotations as
  "all users reconnect accounts + re-enrol MFA" events. SMTP/OAuth
  client secrets rotate freely (restart required; all config is read
  once at boot).
- Generation: `openssl rand -base64 32` for the encryption key;
  provider secrets come from each provider's developer console only.
