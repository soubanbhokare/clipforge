# CLIPFORGE — Providers

Every external capability is provider-based and configured **only**
through server environment variables (`server/.env`, read by
`server/src/config.ts`). Secrets never live in frontend code and are
never returned by the API — status endpoints report variable **names**
that are missing, never values.

The honesty rule everywhere: a provider that is not configured fails
with `422 CONFIGURATION_ERROR` (or a job in a `CONFIGURATION` stage)
naming what is missing. Nothing is scraped, simulated or faked.

## Speech-to-text (STT) — `server/src/stt.ts`

Selected with `STT_PROVIDER`:

| Variable | Meaning |
| --- | --- |
| `STT_PROVIDER` | `local-faster-whisper` (default) or `openai-compatible`. |
| `WHISPER_MODEL` | Local: faster-whisper model name, default `small` (the `base` model misdetects Hindi and is not recommended). OpenAI-compatible: model sent to the endpoint, default `whisper-1`. |
| `PYTHON_BIN` | Interpreter for the local provider, default `python3`. |
| `STT_API_BASE` | OpenAI-compatible base URL (falls back to `OPENAI_API_BASE`, then `https://api.openai.com/v1`). The adapter POSTs to `<base>/audio/transcriptions`. |
| `OPENAI_API_KEY` (or `STT_API_KEY`) | Key for the OpenAI-compatible provider. Without it that provider reports itself not configured. |
| `PROCESSING_DIR` | Per-job scratch directory, default `server/data/processing`. |

- **Local provider** is "configured" only when the configured Python
  can actually import `faster_whisper` — verified by the code, not
  assumed. It spawns `server/scripts/transcribe.py`; the server first
  extracts a 16 kHz mono WAV with FFmpeg.
- **Neither provider diarizes.** Transcripts carry no speaker labels;
  `speaker` is stored `NULL` and the UI says speaker identification
  is unavailable.
- Check live status: `GET /api/analysis/config` (signed in) returns
  `{ provider, configured, model, speakerDiarization: false, … }`.

## Caption translation — `server/src/captions.ts`

| Variable | Meaning |
| --- | --- |
| `TRANSLATION_PROVIDER` | Provider name (empty by default). |
| `TRANSLATION_API_KEY` | Provider key. |
| `TRANSLATION_API_BASE` | Provider base URL. |

No provider is configured in this environment, so automatic
translation jobs fail honestly with a `CONFIGURATION` error.
**Manual** translations (typed or uploaded by the user) are stored
separately and always work.

## Phase 8 media providers — `server/src/broll.ts`

| Capability | Variables the code reads | Status |
| --- | --- | --- |
| Stock media search/import | `PEXELS_API_KEY` (selects the implemented Pexels adapter; `STOCK_PROVIDER=pexels` names it explicitly, any other `STOCK_PROVIDER` value has no adapter) | **Implemented** (Pexels Videos API). Configured exactly when `PEXELS_API_KEY` is set. |
| AI media generation | `AI_GENERATION_PROVIDER`, `AI_GENERATION_API_KEY` | Adapter `implemented: false`. |
| Background removal | `BACKGROUND_REMOVAL_PROVIDER`, `BACKGROUND_REMOVAL_API_KEY`, or `BACKGROUND_MODEL_PATH` (local segmentation model) | Adapter `implemented: false`. |

**Stock media — Pexels (real adapter):** with `PEXELS_API_KEY` set
(a **free** key from pexels.com/api), provider search
(`POST /api/projects/:id/broll/search` with `source: "provider"`)
queries the official Pexels Videos API, and import
(`POST /api/projects/:id/broll/import`) queues a real job that
downloads the chosen rendition (widest MP4 ≤ 1920 px) into the
project's media library as a B-roll asset. Imported assets persist
the credit metadata Pexels' licence terms call for: provider
(`pexels`) + provider asset id, licence name (`Pexels License`),
attribution (`Video by <creator> on Pexels`) on the asset, and the
video's Pexels page URL as the source URL of its licence record.
Without the key, search and import keep the exact pre-adapter
behaviour: `422 CONFIGURATION_ERROR` naming the missing key, plus a
persisted FAILED job for imports. `PEXELS_API_BASE` overrides the
API base for testing/sandbox only (default
`https://api.pexels.com`) — the e2e suite points it at a local mock
and exercises the real adapter code against it.

## URL import — yt-dlp (`server/src/urlImport.ts`)

Pasting a video URL into the Studio (**Import from URL** tab, or
"Import this video" on a validated YouTube link) imports the video
itself — this is separate from the Phase 3 YouTube *validator*,
which still only checks a link and never downloads.

| Capability | Variables the code reads | Status |
| --- | --- | --- |
| Import a video from a URL (YouTube + any yt-dlp-supported site, or a direct media link) | `YTDLP_BIN` (default `yt-dlp` on `PATH`), `URL_IMPORT_ENABLED` (default on when the binary resolves), `URL_IMPORT_ALLOW_PRIVATE` (default off — e2e fixtures only) | **Implemented** (open-source yt-dlp; free; no API key, no cookies, no account logins — ever). |

How it works: `POST /api/projects/:id/url-import` queues a
`URL_IMPORT` job on the same Phase 8 job machinery as the Pexels
import (persisted queue, dedupe, cancel — cancelling kills the
downloader process — retry, usage ledger, notifications). The job
downloads the best MP4 up to 1080p, single video only
(`--no-playlist`), byte-capped at `MAX_UPLOAD_MB` (`--max-filesize`
plus a post-download byte check), then runs the **same**
post-processing as an upload: strict FFprobe validation, container
check, thumbnail, probe metadata on the `source_assets` row
(`source_type = 'URL_IMPORT'`, migration v15). From there the asset
is an ordinary project source — AI clip detection, captions, the
editor and export treat it exactly like an upload (the analysis
pipeline gates on "has a verified local file", not on upload
origin). Provenance is recorded on `media_asset_meta` +
`media_license_records`: provider (the yt-dlp extractor, e.g.
`youtube` / `generic`), the source page URL, title/uploader when
reported, and a rights note stating the URL was user-supplied and
the user is responsible for having the rights to process the video.

Safety and honesty rules:

- **SSRF guard:** http/https only; the target host must not be or
  resolve to a private/loopback/link-local/documentation address
  (blocked up front with `400 URL_BLOCKED`). `URL_IMPORT_ALLOW_PRIVATE=1`
  lifts this for the e2e suites' loopback fixture server **only** —
  never set it in production. The downloaded file is then validated
  as media exactly like an upload, whatever the URL claimed.
- **Missing dependency:** with `URL_IMPORT_ENABLED=false` or no
  resolvable yt-dlp binary, the endpoint returns the honest
  `422 CONFIGURATION_ERROR` naming the dependency (plus a persisted
  FAILED job) and `/api/studio/config` reports
  `urlImport.enabled: false` with the same explanation for the UI.
- **Classified failures, never fake success:** unsupported URL,
  video unavailable, sign-in/age wall (`SIGN_IN_REQUIRED` — CLIPFORGE
  never uses accounts or cookies, so those videos cannot be
  imported), geo-block, HTTP 403 / platform block, too large,
  timeout, unreachable host — each fails the job with a stable
  `error_code` and a human-readable reason.
- **Platform reality:** some platforms (notably YouTube) block
  datacenter/server IPs or demand sign-in for *some* videos. Those
  imports fail honestly per video; the same link may work for
  another video. This is a platform restriction, not an app bug,
  and there is no bypass in the code.

**Read this before setting the generation/background variables:**
the status surface computes `configured = (env names a provider +
credential) AND implemented`. The generation and background-removal
adapters are still interface stubs in this build, so setting those
env vars alone does **not** enable anything — the provider still
reports not configured, its operations still return
`CONFIGURATION_ERROR`, and the status text says the adapter is not
implemented. There is **no genuinely free production API** for AI
media generation or background removal, so both stay honestly gated
until a provider key exists *and* the adapter body is implemented.
Check live status: `GET /api/phase8/status` (signed in).

What works without any of these: B-roll **recommendations from your
own media library** (transcript-driven matching over uploaded/project
media) and all FFmpeg-based enhancement.

## Free-tier map — what unlocks what

| Integration | Cost to go live | What the owner must do |
| --- | --- | --- |
| Stock B-roll (Pexels) | Free API key | Create a free Pexels API key at pexels.com/api and set `PEXELS_API_KEY`. Code-complete now. |
| URL import (yt-dlp) | Free, no key | Install the open-source `yt-dlp` binary on the server (or set `YTDLP_BIN` to its path). Code-complete now; some platforms block server IPs per video (see URL import above). |
| Transactional email (SMTP) | Free tier | Create a free SMTP account — e.g. **Brevo** (free, 300 emails/day) or **Resend** (free tier) — and set `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM`. Code-complete now (see Email below). |
| YouTube / Instagram / TikTok publishing + analytics | Free developer apps | Create the **owner's own** developer apps (Google Cloud / Meta / TikTok) with his logins and pass each platform's review (Google verification, Meta App Review, TikTok audit). The adapters are **code-complete already**; only the owner's credentials + approvals are missing. |
| AI media generation, background removal | No genuinely free production API | Stay honestly gated (`implemented: false`) until a paid provider key exists and an adapter is implemented. |
| Payments | — | No adapter is integrated at all (see Payments below); free tiers of Stripe/Razorpay do not change that. |

## OAuth providers — Publishing + Analytics

One set of connected accounts serves both publishing (Phase 10) and
analytics (Phase 11) — analytics introduces **no new credentials**,
only scope requirements (below). Adapters live in
`server/src/providers.ts`; tokens are AES-256-GCM-encrypted at rest
(`server/src/tokenCrypto.ts`) and never reach the frontend.

Shared variables:

| Variable | Meaning |
| --- | --- |
| `PUBLIC_APP_URL` | App origin the server redirects the browser to after OAuth (falls back to `APP_BASE_URL`, then `http://localhost:5173`). |
| `TOKEN_ENCRYPTION_KEY` | Base64 of exactly 32 random bytes (`openssl rand -base64 32`). If unset, a dev key file is generated at `server/data/.token-key` (0600) and a warning is logged. **Production must set this.** |

### YouTube (Google)

| Variable | Value |
| --- | --- |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | Web OAuth client from a Google Cloud project with **YouTube Data API v3** enabled. Separate from the Phase 2 Google *sign-in* variables below. |
| `GOOGLE_OAUTH_REDIRECT_URI` | Must match the client exactly. Local: `http://localhost:3001/api/publishing/oauth/youtube/callback` |
| Scopes requested by the code | `https://www.googleapis.com/auth/youtube.upload`, `https://www.googleapis.com/auth/youtube.readonly` — with state + PKCE (S256), `access_type=offline`. |

Notes: unverified Google apps are capped, and uploads may be locked
private until Google's API verification/audit completes.
Separately, `YOUTUBE_API_KEY` (a plain API key, not OAuth) only powers
metadata lookup in the Studio YouTube-URL validator — CLIPFORGE never
downloads media from YouTube, key or no key.

**Analytics scope gap (important):** YouTube Analytics API metrics
need `https://www.googleapis.com/auth/yt-analytics.readonly`, which
the connect flow above does **not** request. Until an account is
connected with that scope granted, those metrics are "unavailable"
(with the scope named) and only Data API lifetime counters sync.

### Instagram (Meta)

| Variable | Value |
| --- | --- |
| `META_APP_ID`, `META_APP_SECRET` | Meta developer app with the **Instagram API product (Instagram Login)** added. |
| `META_REDIRECT_URI` | Local: `http://localhost:3001/api/publishing/oauth/instagram/callback` |
| `META_WEBHOOK_VERIFY_TOKEN` | Your chosen verify token for the webhook challenge; webhook POSTs are HMAC-verified with the app secret (503 when `META_APP_SECRET` is unset). |
| Scopes requested by the code | `instagram_business_basic`, `instagram_business_content_publish` — state-based flow. |

Only Business/Creator accounts can publish; Meta App Review is
required for public use. **Analytics scope gap:** insights need
`instagram_business_manage_insights`, deliberately not requested
(minimal scopes), so Instagram metrics stay "unavailable" until a
reconnect grants it.

### TikTok

| Variable | Value |
| --- | --- |
| `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | TikTok developer app with **Login Kit + Content Posting API**. |
| `TIKTOK_REDIRECT_URI` | Must match the app exactly. Local: `http://localhost:3001/api/publishing/oauth/tiktok/callback` |
| Scopes requested by the code | `user.info.basic`, `video.publish` — with state + PKCE (S256). Webhooks: `POST /api/publishing/webhooks/tiktok` (TikTok-Signature HMAC). |

Until TikTok's audit approves the app, posts are restricted to
private (`SELF_ONLY`) — CLIPFORGE reads the allowed privacy levels
from `creator_info` and enforces them. **Analytics scope gap:** post
metrics need the Display API `video.list` scope, not requested at
connect time; without it only profile counters (followers) sync.
TikTok exposes no reach/saves/watch-time via the Display API — those
are "unsupported", and the Research API is not used as a substitute.

### Testing overrides (not for production)

The `*_API_BASE` / `*_AUTH_BASE` / `*_TOKEN_URL` variables
(`YOUTUBE_API_BASE`, `META_GRAPH_BASE`, `TIKTOK_API_BASE`, …) exist so
the e2e suites can point the **real** adapter code at a local mock
provider, and staging can target sandboxes. Defaults are the official
production endpoints. Mock-based test results are labelled as such
and are not evidence of real-platform acceptance.

## Google sign-in (Phase 2, separate from publishing)

| Variable | Meaning |
| --- | --- |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | All three must be set before the "Continue with Google" control becomes functional. |

Not active in this build: `GET /api/auth/config` reports
`googleConfigured` from these variables and the UI renders a disabled,
clearly labelled control. There is no fake OAuth flow.

## Email — `server/src/email.ts`

| Variable | Meaning |
| --- | --- |
| `SMTP_HOST` | Presence of this variable selects the SMTP adapter. |
| `SMTP_PORT` | Default 587 (465 implies TLS in nodemailer config). |
| `SMTP_USER`, `SMTP_PASS` | SMTP credentials (optional auth). |
| `SMTP_FROM` | From header, default `CLIPFORGE <no-reply@localhost>`. |
| `APP_BASE_URL` | Frontend base used to build links inside emails, default `http://localhost:5173`. |

**Outbox fallback behaviour:** with `SMTP_HOST` empty, every outgoing
email (verification, password reset, email-change, workspace
invitation, notifications) is written as a JSON file under
`server/data/outbox/` and logged — **nothing is delivered to a real
inbox**, and the API/UI say so (`GET /api/auth/config` reports
`emailConfigured: false`; the forgot-password screen shows a
not-configured note). For local development, read the token/link from
the newest outbox file to complete verification/reset flows.

**Going live for free:** the SMTP adapter is provider-agnostic —
any SMTP host works. Free options: **Brevo** (free plan, 300
emails/day; SMTP host `smtp-relay.brevo.com`, port 587) or
**Resend**'s free tier (SMTP host `smtp.resend.com`, port 587).
Set `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` /
`SMTP_FROM` from that account and all mail paths (verification,
password reset, email-change, invitations, notifications — all of
them call the single `sendEmail` in `src/email.ts`) deliver for
real. The account e2e suite proves the hand-off: it boots the
server against a local SMTP sink and asserts the verification mail
is received by the transport (and that nothing lands in the outbox
for that recipient), while the unconfigured boots assert the
outbox behaviour is unchanged.

## Payments — flag-disabled foundation — `server/src/account.ts`

| Variable | Meaning |
| --- | --- |
| `PAYMENTS_ENABLED` | Must be exactly `true` — and that alone is not sufficient. |
| `PAYMENT_PROVIDER` | Provider name. |
| `PAYMENT_MERCHANT_KEY_ID`, `PAYMENT_MERCHANT_SECRET` | Merchant credentials. |
| `PAYMENT_WEBHOOK_SECRET` | HMAC secret for `POST /api/payments/webhook/:provider`. |

`paymentsStatus()` reports a provider as enabled only when the flag
**and** provider **and** all credentials are present. In this
environment none are set, and — per `server/.env.example` — no payment
provider adapter is integrated in this build at all: checkout
(`POST /api/subscription/checkout`) answers an honest
`CONFIGURATION_ERROR`, no charge is ever attempted, and no invoice is
fabricated. Setting the variables feeds the status surface and webhook
signature verification for a future adapter; it does not by itself
enable real charging.
