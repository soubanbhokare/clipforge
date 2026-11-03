# CLIPFORGE — Privacy & Legal Readiness (Phase 13, §18)

Status: **implementation inventory, 2026-11-02**, from `server/src/`,
`server/src/db.ts` (schema/migrations), and `src/`.

> **This document is not legal advice and claims no compliance with any
> law** — not the GDPR, not India's DPDP Act, not CCPA/CPRA, not platform
> policies. It inventories what the code actually stores and does, so that
> a qualified professional can assess it. Every legal document listed in
> §8 is marked **REQUIRES PROFESSIONAL LEGAL REVIEW**. The product itself
> currently publishes **no privacy policy and no terms** — the landing
> footer's Privacy and Terms buttons are explicit placeholders that say
> exactly that (`src/pages/HomePage.tsx`). That is honest, and it is also
> the single biggest legal gap: signup already collects a terms
> acceptance against a text that does not exist (§7).

---

## 1. Personal data actually stored

All storage is in one SQLite database (`server/data/clipforge.db`) plus
files under `server/data/` on the same machine. There is no third-party
analytics, telemetry, crash reporting, or advertising code anywhere in the
repo (grep-verified: no gtag/PostHog/Mixpanel/Segment/Plausible/beacon).

### 1.1 Account & identity

| Data | Where | Notes |
|---|---|---|
| Display name, email address | `users` | Email is unique, case-insensitive. |
| Password | `users.password_hash` | Argon2id hash only. Never stored or logged in plaintext. |
| Avatar image | `users.avatar_path` + `server/data/avatars/` | User-uploaded. |
| Email-verification / password-reset / email-change state | `email_verification_tokens`, `password_reset_tokens`, `email_change_tokens` | Tokens stored **only as SHA-256 hashes**, single-use, expiring (24 h verification, 30 min reset). |
| MFA (TOTP) secret, recovery codes | `user_totp` (secret stored encrypted), `mfa_recovery_codes` (SHA-256 hashes, used-at), `mfa_challenges` | `last_used_step` prevents TOTP replay. |
| Preferences | `user_preferences`, `notification_preferences` | Language, timezone, formats, editor defaults, per-category notification choices. |

### 1.2 Sessions & security history

| Data | Where | Notes |
|---|---|---|
| Sessions | `sessions` | Cookie value is a 32-byte random token; DB stores its SHA-256 hash, expiry, **IP address, user-agent**, last-active timestamp (§3). TTL 12 h, or 30 days with "remember me". |
| Login history | `login_events` | user id (nullable), **email address as typed**, event type, **IP, user-agent**, timestamp. Written for login/security events via `recordLoginEvent` in `accountCore.ts`. No automatic expiry/purge exists (§5). |
| Audit log | `admin_audit_log` | Append-only by design: actor user id (nullable, **no foreign key on the actor — deliberately, so rows survive account deletion**), workspace id, event type, target type/id, result, metadata JSON, **IP**, timestamp. Written for admin actions, provider config changes, plan changes, data-export and deletion events, and similar. No UPDATE/DELETE path exists in the application code for this table. |
| Support tickets | `support_tickets`, `support_ticket_messages` | User-authored content + admin replies. |

### 1.3 Content & work product

Projects, uploaded source media (files in `server/data/media/<userId>/`,
metadata in `source_assets`: filename, source URL if a YouTube link was
validated, duration/codecs/resolution/bitrate, file size), transcripts and
transcript segments (`transcripts`, `transcript_segments` — **the full text
of what was said in a user's videos**), candidate clips, timelines, caption
tracks and translations, brand kits/assets, tracking data
(`tracking_frames`, `tracked_subjects` — face/person detection results
derived from user video), enhancement/B-roll records, render jobs and
outputs, export bundles, and generated analytics reports
(`server/data/reports/`). Transcripts and face-tracking data are called
out specifically because they are the most sensitive content-derived data
the system creates, and any future privacy policy must name them.

### 1.4 Platform (social) data

For each connected YouTube/Instagram/TikTok account (`platform_accounts`):
platform account id, username, display name, profile image URL, account
type, connection status, **granted OAuth scopes**, token expiry; OAuth
access/refresh tokens in `oauth_token_records`, **AES-256-GCM-encrypted**
(`server/src/tokenCrypto.ts`), never sent to the frontend. Publishing
records (jobs, attempts, scheduled posts, platform post ids,
webhook events, error log) and analytics records (account/post snapshots,
metric values, sync jobs/attempts, insights + evidence, comparison groups)
are stored per user.

### 1.5 Usage & billing-adjacent

| Data | Where | Notes |
|---|---|---|
| Usage ledger | `usage_ledger` | Immutable, idempotency-keyed rows: user/workspace/project/job ids, operation, provider, resource, unit, quantity, status, entitlement key, timestamp. See §5 for its special deletion behaviour. |
| Subscriptions & plans | `user_subscriptions`, `subscription_events`, `plans`, `plan_entitlements` | Plan assignment history. **Prices are NULL until an admin sets them — no price is invented.** |
| Payments scaffolding | `payment_provider_records`, `payment_webhook_events`, `invoices` | Provider records store secret **references** only. Webhook events store the raw payload JSON + signature-valid flag, deduplicated on (provider, event_id). **No card data is ever received or stored** — and payments are disabled (§6). |

### 1.6 Email outbox (development mode)

With no SMTP configured, every outgoing email (verification, reset,
notifications) is written as a JSON file under `server/data/outbox/`
containing recipient, subject, and full body — **including live
verification/reset links**. This directory is server-only and gitignored,
but it is personal data (plus live tokens) at rest and must be handled
accordingly until SMTP replaces it.

---

## 2. Data export — exists

- **Route:** `POST /api/privacy/data-export` queues a background job;
  `GET /api/privacy/data-exports` lists the user's jobs;
  `GET /api/privacy/data-exports/:id/download` serves the file (owner-only;
  the job is looked up by id **and** user id). UI: Settings → Privacy & Data.
- **Format:** a ZIP containing JSON files — `profile.json`,
  `preferences.json`, `workspaces.json`, `projects.json`, `usage.json`
  (the user's full usage-ledger rows), `notifications.json`,
  `subscription.json`, `support-tickets.json` — plus a `README.txt`
  stating the scope.
- **Scope limits, disclosed in the export itself:** media files are **not**
  included (the README tells the user to download media from the app before
  deleting their account). Also not included: transcripts as standalone
  files, login history, session records, audit rows, OAuth tokens
  (correctly — secrets are not exportable), analytics snapshots, and
  publishing history. A requester expecting "all my data" will not get all
  of it from this export; the README's list is accurate about what *is*
  inside, but nothing tells the user what is *excluded* beyond media.
- Export request and completion are audit-logged
  (`DATA_EXPORT_REQUESTED`, `DATA_EXPORT_COMPLETED`).

## 3. Cookies & browser storage

| Item | Type | Purpose | Attributes |
|---|---|---|---|
| `cf_session` | First-party cookie | Session. Value is a random token; server stores only its hash. | HttpOnly, SameSite=Lax, Secure **in production only**, path `/`, 12 h / 30 d (remember-me) |
| `cf_csrf` | First-party cookie | CSRF double-submit token; client reads it and echoes it as `X-CSRF-Token`. | **Not** HttpOnly (by design of the double-submit pattern), SameSite=Lax, Secure in production, session-scoped |
| Guest flag | `sessionStorage` (`AuthContext.tsx`) | Marks UI-only demo/guest mode. No personal data. | Tab-scoped |

- **No analytics cookies. No advertising/tracking cookies. No third-party
  cookies are set by this application**, and the frontend loads no
  third-party scripts, fonts, or trackers (the only external URL in `src/`
  is a YouTube placeholder string in a form field).
- **No cookie-consent banner exists.** Whether one is legally required
  depends on jurisdiction and on the "strictly necessary" status of the
  two cookies above (the CSRF cookie's non-essentiality is a question for
  counsel) — flagged in §8, not decided here.
- **`localStorage` is not used at all** in the frontend (grep-verified) —
  no durable client-side personal-data store exists to disclose.

## 4. Account deletion — exists; what actually happens

**Route:** `POST /api/privacy/account-deletion` (Settings → Privacy &
Data). Requires the current password **and** typing `DELETE`; queues an
`account_deletion_jobs` row. From the moment deletion is queued,
`hasPendingAccountDeletion` makes existing sessions stop working.
Executed by the account worker (`processAccountDeletion`,
`server/src/account.ts`):

1. **Cancels queued work:** render jobs (QUEUED/PAUSED), publish jobs and
   scheduled posts, analytics sync jobs.
2. **Disconnects platform accounts:** OAuth token records are **deleted
   first**, then accounts are marked DISCONNECTED. Recorded in the
   deletion detail: `externalPostsDeleted: false` — **posts already
   published to YouTube/Instagram/TikTok are NOT deleted**, and the UI
   says this before the user confirms.
3. **Deletes files (best effort):** the user's media directory, render
   outputs, avatar, owned workspace logos, and their data-export ZIPs.
4. **Writes the retention record:** an `ACCOUNT_DELETED` audit row with a
   **null actor**, whose metadata contains only the **email domain** (not
   the address) plus deletion counts.
5. **Anonymises login history:** `login_events.email` is rewritten to the
   literal `'deleted-account'` for that user (the rows remain, with IP /
   user-agent / timestamps — see the retention note in §5).
6. **Deletes user-owned rows** via a dynamic sweep of every table with a
   `user_id` column, **except** a skip set
   (`account_deletion_jobs`, `admin_audit_log`, `login_events`,
   `usage_ledger`, `users`), then deletes owned workspaces and finally
   the `users` row; foreign-key cascades clear the rest.

### The usage-ledger retention — verified in code

This was a known defect class and was fixed by **migration v14**
(`server/src/db.ts`, `MIGRATION_V14_SQL`, `migrateV14()`): the v12 ledger
declared `user_id TEXT NOT NULL … ON DELETE CASCADE`, which would have
cascade-deleted a user's ledger rows with their account. V14 rebuilds the
table with **`user_id TEXT NULL … ON DELETE SET NULL`**, guarded by
introspection (it only runs while the live table still has the CASCADE
form) and re-verified with `foreign_key_check`. Resulting behaviour today:

- The deletion sweep **deliberately skips** `usage_ledger`
  (`account.ts`, step 6 comment block).
- The final `DELETE FROM users` therefore **anonymises rather than
  deletes** ledger rows: they survive with `user_id = NULL`, retaining
  operation/resource/unit/quantity/status/timestamps (and workspace /
  project / job ids, which are opaque UUIDs not joined to any surviving
  user record).
- **Stale in-code comment:** `processAccountDeletion` still contains a
  comment block saying full retention "is still blocked by the schema …
  outside this module" — that text predates v14 and no longer describes
  the schema. The *behaviour* is the migrated one above; the comment
  should be corrected so a future reader does not "fix" the sweep back
  into deleting the ledger.
- Note the admin usage report's per-user aggregation
  (`GET /api/admin/usage`) joins the ledger to `users`, so anonymised
  rows drop out of the per-user view but remain in the by-operation
  totals (which do not join). That is the correct shape for retained,
  anonymised accounting data.

## 5. Retention behaviour — mostly "indefinite by default"

There is **no retention schedule and no automatic purge job** for personal
data. Specifically:

| Data | Retention today |
|---|---|
| Accounts, projects, media, transcripts, tracking data | Until the user deletes the project/account. No inactivity expiry. |
| Sessions | Expired rows are deleted lazily (on read when expired; a user's expired sessions are purged when they view their session list). No global sweeper. |
| Verification/reset/email-change tokens | Marked used / superseded; expired rows are not proactively deleted. |
| `login_events` | **Kept indefinitely**, including after anonymisation on deletion (IP and user-agent survive anonymisation — only the email is rewritten). |
| `admin_audit_log` | **Kept indefinitely by design** (append-only). After account deletion it retains event types, targets, IPs, and metadata for that user's id. |
| `usage_ledger` | **Kept indefinitely by design**; anonymised to `user_id NULL` on deletion (§4). |
| `system_health_checks` | A row per check per admin health view — grows unbounded, no purge. Low sensitivity (statuses/details), real growth. |
| Webhook events (`platform_webhook_events`, `payment_webhook_events`) | Kept indefinitely; payment webhook payloads can contain provider-side personal data when payments are eventually configured. |
| Data-export ZIPs | On disk until account deletion or manual cleanup. **No expiry on a completed export's download.** |
| Email outbox files | **Never cleaned up by the application.** Accumulate indefinitely in dev mode (and contain live-token links until used/expired). |
| Backups | None exist in this codebase/deployment to describe — backup retention is an operator decision that has not been made or documented. |

Whether indefinite retention of login events, audit rows, and anonymised
ledger rows is lawful for a given deployment is a §8 question. What can be
said factually: the retention is a *consequence of design choices*
(immutability, append-only audit), it is disclosed in this document, and
no code currently enforces any maximum age for any of it.

## 6. Billing disclosures

- **Payments are disabled.** `paymentsStatus()` (`server/src/config.ts`)
  requires `PAYMENTS_ENABLED=true` **and** a provider name **and**
  merchant key id, merchant secret, and webhook secret. None exist in
  this environment; checkout (`POST /api/subscription/checkout`) honestly
  fails with `CONFIGURATION_ERROR`. **No money can be taken, no card data
  is collected, no paid subscription can start.**
- Plan prices are NULL until an admin sets them; the plans API says so in
  its own response note ("CLIPFORGE never invents pricing"). Plan
  *entitlements* are likewise NULL/unconfigured by default — and note for
  §8: entitlement limits are **reported** in the usage overview but a
  general pre-flight enforcement gate was not found in this review;
  nothing currently blocks an over-limit operation. Do not market limits
  as enforced.
- Consequence for disclosure duties: there is currently nothing to
  disclose about charges, renewal, or refunds — because there is no
  charging. The moment a payment provider is configured, refund/renewal/
  tax wording becomes required (§8) **before** the flag is flipped, not after.

## 7. Third-party disclosures — what flows where

### 7.1 Configured and active in this deployment

| Recipient | What is disclosed | When |
|---|---|---|
| *(none external)* | — | With no SMTP and no provider credentials, user data does not leave this machine in the current configuration. Media processing (FFmpeg, local faster-whisper STT, local CV models) is entirely local. |

### 7.2 Would-be disclosures when an operator configures each provider

Each of these is currently a stub or an unconfigured adapter; **the
disclosure happens only if the operator configures it**, and a privacy
policy must be updated *at that moment*:

| Provider (config gate) | Data that WOULD be disclosed | Code |
|---|---|---|
| SMTP provider (`SMTP_HOST`…) | Recipient email, subject, full body incl. verification/reset links | `email.ts` |
| Google sign-in (`GOOGLE_CLIENT_ID`…) | Standard OAuth identity flow with Google | `config.ts`, `app.ts` |
| YouTube URL metadata (`YOUTUBE_API_KEY`) | The video URL/ID the user pastes (metadata lookup only; no import) | `studio.ts` |
| OpenAI-compatible STT (`STT_PROVIDER=openai-compatible` + key) | **The user's audio** (extracted WAV) + language hint — i.e. the spoken content of their video | `stt.ts` |
| Translation provider (`TRANSLATION_PROVIDER` + key) | **Caption/transcript text** for translation | `captions.ts` path, config in `config.ts` |
| Stock media provider (Phase 8 stub — adapter body **not implemented**) | Search queries derived from transcript/B-roll context | `broll.ts` |
| AI generation provider (Phase 8 stub — not implemented) | Prompts derived from the project/transcript | `broll.ts` |
| Background-removal provider (Phase 8 stub — not implemented) | **Video frames / media** for processing | `broll.ts` |
| YouTube / Instagram / TikTok publishing + analytics (OAuth credentials) | The user's exported video, post metadata, and account identity on publish; account/post metrics read back on sync | `providers.ts`, `publishing.ts`, `analyticsProviders.ts` |

### 7.3 OAuth scopes requested per provider (`server/src/providers.ts`)

Requested at connect time (minimal-scope pattern; what is *granted* is
stored per account):

| Platform | Scopes requested for publishing | Notes |
|---|---|---|
| YouTube (Google, PKCE, offline access) | `https://www.googleapis.com/auth/youtube.upload`, `https://www.googleapis.com/auth/youtube.readonly` | Analytics additionally needs `https://www.googleapis.com/auth/yt-analytics.readonly`, which is **not** in the connect-time request — YouTube Analytics metrics depend on the granted scopes recorded on the account (`analyticsProviders.ts` capability detection treats missing scope as *unavailable*, never zero). |
| Instagram | `instagram_business_basic`, `instagram_business_content_publish` | Insights require `instagram_business_manage_insights`, deliberately **not** requested in Phase 10; Instagram analytics therefore stays unavailable until a reconnect grants it. |
| TikTok | `user.info.basic`, `video.publish` | Post metrics would need `video.list` (Display API), not requested at connect. |

Platform terms angle for §8: each platform's developer terms impose their
own duties (data deletion callbacks, scope justification, privacy-policy
URL *required by the platforms themselves* to approve the OAuth apps).
Without a published privacy policy, the OAuth applications themselves
generally cannot complete platform review — an operational blocker, not
just a legal nicety.

## 8. Legal documents the operator still needs

**Every item below: REQUIRES PROFESSIONAL LEGAL REVIEW.** None of these
documents exists today (the footer placeholders are the proof), and none
should be generated from a template and shipped without counsel qualified
in the jurisdictions the service operates in and takes users from.

| Document / duty | Why, concretely for this codebase |
|---|---|
| **Privacy policy** — REQUIRES PROFESSIONAL LEGAL REVIEW | Must cover §1's inventory (incl. transcripts, face-tracking data, login IPs, audit/ledger retention), §5's indefinite retentions, §7's per-provider disclosures, and the export/deletion rights that §2/§4 actually implement. Also a practical prerequisite for platform OAuth app approval (§7.3). |
| **Terms of service / terms of use** — REQUIRES PROFESSIONAL LEGAL REVIEW | Signup already requires ticking "I agree to the CLIPFORGE terms of use" (`SignupPage.tsx`, enforced server-side as `termsAccepted: z.literal(true)` in `app.ts`) **against a document that does not exist**. Until it does, that acceptance is hollow. The ToS must also cover user content ownership/licence for processing, acceptable use, and the fact that published posts are not deleted by account deletion. |
| **Cookie notice** — REQUIRES PROFESSIONAL LEGAL REVIEW | §3: two first-party cookies + sessionStorage. Whether a banner/consent is required (esp. the non-HttpOnly CSRF cookie) is jurisdiction-dependent. |
| **Data processing agreements (DPAs) with each configured provider** — REQUIRES PROFESSIONAL LEGAL REVIEW | SMTP, STT, translation, stock/generation/background providers, and the three social platforms, per §7.2 — executed at configuration time. |
| **Retention schedule** — REQUIRES PROFESSIONAL LEGAL REVIEW | §5: login events, audit log, usage ledger, webhook payloads, health-check rows, outbox files, export ZIPs currently have no maximum age. Someone qualified must decide each period; engineering then implements the purges that do not yet exist. |
| **Data-breach response plan** — REQUIRES PROFESSIONAL LEGAL REVIEW | Nothing in the repo addresses breach detection/notification. The outbox directory (live tokens) and the single-file SQLite database are the obvious assets to plan around. |
| **Children / age eligibility position** — REQUIRES PROFESSIONAL LEGAL REVIEW | No age gate or eligibility statement exists in signup. |
| **Payments legal pack (before enabling)** — REQUIRES PROFESSIONAL LEGAL REVIEW | Pricing, renewal, cancellation, refund, and tax wording; the payments flag must stay off until it exists (§6). |
| **Platform compliance pack** — REQUIRES PROFESSIONAL LEGAL REVIEW | YouTube API Services terms, Meta/Instagram platform terms, TikTok developer terms: privacy-policy URL, data-deletion callback/endpoint duties, scope-use limits, and branding rules attach to the OAuth apps in §7.3. |
| **Accessibility statement** (jurisdiction-dependent) — REQUIRES PROFESSIONAL LEGAL REVIEW | Pairs with `ACCESSIBILITY.md`; several jurisdictions require a published statement + feedback route for public services. |
| **Sub-processor / third-party list** (living document) — REQUIRES PROFESSIONAL LEGAL REVIEW | §7.2 as a user-facing page, updated whenever an operator configures a provider. |

## 9. Bottom line

The engineering substrate for privacy rights is unusually real for a
project at this stage — hashed-token auth, encrypted OAuth tokens, a
working data export, a working deletion workflow whose ledger
anonymisation is verified in the migration code, and no trackers at all.
What is missing is everything *around* it: no published policy or terms
(while signup already collects terms acceptance), no retention limits, no
DPAs, and no breach plan. **Do not onboard real users beyond the current
testing circle until §8's first two items exist.**
