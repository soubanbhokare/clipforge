# CLIPFORGE — Admin Guide

For whoever operates this deployment. The Admin Console lives at the
`admin` route (`#/admin`) and is backed by `/api/admin/*`. Every
admin route re-checks the `is_admin` flag **server-side** on every
request — the frontend flag only decides whether the menu entry is
shown, so there is no way to reach admin data by editing the client.

## 1. Bootstrap: `ADMIN_EMAILS`

Admin access is granted by exactly one mechanism:

1. In `server/.env`, set a comma-separated list:
   `ADMIN_EMAILS=you@example.com,ops@example.com`.
2. Restart the server.
3. The flag is applied **at registration** (a new account with a
   listed email is created as admin) and **re-checked at every
   login** (an existing account whose email is listed is promoted on
   its next sign-in).

Rules from the code (`server/src/config.ts`, `app.ts`, `account.ts`):

- Ordinary signup can never create an admin by itself; there is no
  admin-granting endpoint callable by non-admins and no frontend path.
- **Removing an email from `ADMIN_EMAILS` does not revoke** an
  already-granted flag. To revoke, clear `users.is_admin` for that
  account directly in the database.
- Case is ignored (emails are compared lower-cased/trimmed).

## 2. Console sections

The console has ten tabs (matching `AdminPage.tsx`):

| Tab | What it shows / does |
| --- | --- |
| **Overview** | Platform counts (users, workspaces, projects, jobs) for a quick sanity read. |
| **Users** | Search by name/email, filter by status (Active/Suspended). Open a user for detail; **suspend/reactivate** (suspension kills API access immediately, even with a live session cookie), issue a **recovery** action, and **assign a plan**. |
| **Workspaces & Projects** | Cross-user lists of workspaces and projects for support and abuse checks. |
| **Jobs** | Background-job oversight across the workers, plus the **render queue** and **publishing jobs** views for stuck or failing work. |
| **Providers** | Per-provider status (implemented vs configured — see §4), a **Test** action that runs the provider's live check, and enable/disable of provider records. |
| **Integrations & Health** | Integration configuration summary (variable **names** only, never values) and the live **System Health** panel (§5). |
| **Usage & Reports** | Aggregates over the immutable usage ledger and the list of generated (analytics) reports. |
| **Plans** | Plan management (§3). |
| **Audit Log** | The append-only audit trail (§6). Filter by exact event type. |
| **Support** | The support-ticket queue (§7). |

## 3. Plans management

- Plans are **admin records**: key, name, description, entitlements,
  and prices in cents (monthly/annual).
- **Prices are only ever what an admin types in.** The seeded plans
  ship with **no prices** — the price fields are `NULL` and the UI
  shows "not set". No price in this system was invented by the code,
  and you should not "fill in" a plausible-looking one: leave a price
  unset until the business actually sets it.
- Entitlements per plan are set as unset / included / not included
  per key via **Plans → entitlements**.
- Assign or change a user's plan from **Users → (user) → Assign
  plan**. Users see their plan and the usage ledger in Settings →
  Usage & plan.
- **Payments are disabled** regardless of plans: checkout returns
  `CONFIGURATION_ERROR` until a real payment adapter exists (see
  [PROVIDERS.md](PROVIDERS.md#payments--flag-disabled-foundation--server-src-accountts)).
  Plans therefore describe entitlements only — assigning one never
  charges anyone, and no invoice is generated.

## 4. Providers — reading the status correctly

Each provider reports two independent facts:

- **Implemented** — a working adapter exists in this build.
- **Configured** — the required server credentials are present.

Publishing (YouTube/Instagram/TikTok) and STT are implemented but
report *not configured* until their env vars are set. Stock search,
AI generation and background removal report **implemented: false** —
they stay unavailable **even with env vars set**, and the status text
says so. Do not tell users a Phase 8 provider is "just a key away";
it also needs its adapter implemented. Full variable lists:
[PROVIDERS.md](PROVIDERS.md).

## 5. System health — how to read it

**Integrations & Health → System health** (`GET /api/admin/system-health`)
runs its checks **live** when you open or refresh the section:

- **FFmpeg / FFprobe — really executed.** `OPERATIONAL` means the
  binary actually ran on this server; `UNAVAILABLE` means it could
  not be executed (fix `PATH`/install before anything media-related
  can work).
- **Disk — really measured** for the data directory.
- **Database** — the live SQLite database.
- **Email** — reflects whether SMTP is configured; outbox mode is
  reported as what it is (files, not delivery).
- **Entries labelled `NOT_USED`** — you will see, verbatim in spirit:
  *"NOT USED BY THIS DEPLOYMENT"* for **PostgreSQL** ("the application
  runs on SQLite"), **Redis** ("queues are DB-backed tables"),
  **BullMQ** ("workers are in-process loops in this server") and
  **object storage** ("media lives on local disk"). These are
  **expected, healthy states for this deployment**, not faults: the
  panel deliberately never shows an unused component as healthy or
  as broken. Only act on a `NOT_USED` entry if you have deliberately
  migrated the deployment to that component.

## 6. Audit log

- Append-only: account registration, password resets/changes, MFA
  events, suspensions, plan changes, admin actions and more are
  recorded with actor, target, timestamp and IP (`accountCore.ts`
  `audit()`). Audit writes are defensive — a failed audit write is
  logged server-side but never breaks the user action it describes.
- There is **no delete/edit endpoint** for audit rows. Treat the log
  as evidence; if you need retention limits, enforce them at the
  database level outside the app and document that you did.

## 7. Support tickets

- Users open tickets in-app (Settings → Support). Admins work the
  queue in **Support**: open a ticket to read the full thread,
  **reply as support**, and set status/priority.
- There is no email notification of replies while SMTP is
  unconfigured — users check in-app. If timely responses matter,
  configure SMTP (see [PROVIDERS.md](PROVIDERS.md#email)) and tell
  users replies still live in the ticket thread.

## 8. Operational notes

- **Usage ledger is immutable and idempotent**; rows survive account
  deletion in anonymized form (`user_id` set to `NULL`, migration
  v14) so platform totals stay auditable.
- **Account deletion** is a background job: queueing it immediately
  blocks sign-in, then the account worker performs the erasure. A
  `FAILED` deletion job leaves the account usable again (the user can
  re-request) — check the Jobs tab if a user reports a stuck state.
- For day-to-day server operation (ports, env, restarts) see
  [SETUP.md](SETUP.md) and [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
