# CLIPFORGE — Deployment

Phase 13 deliverable (§12). Everything in this document is
**prepared, not executed**: Docker is not installed on the
development machine, the project has no git remote, and no staging
or production host exists yet. The `Dockerfile` and
`docker-compose.yml` in the repo root are statically reviewed only —
the first real `docker compose up --build` is itself a verification
step and must be recorded in the release record.

**Deployment target (owner decision, 2026-11-02): the FREE route.**
Primary target is an **Oracle Cloud Always Free** instance — a real
VPS with persistent disk, the only free tier that fits this app's
SQLite + local-media + in-process-worker architecture — reached on a
**free subdomain at ₹0 recurring cost**. Render / Railway free tiers
are documented below as demo-only fallbacks. The paid upgrade path
is the owner's own domain (**clipforge.io** — availability checked
by the owner on 2026-11-02) and/or a bigger host. Full details in
"Deployment target — the FREE route". No deployment has happened
yet.

## Current architecture (what is actually being deployed)

- Frontend: React + Vite SPA, built to static files (`dist/`).
- Backend: one Express + TypeScript process (`server/`), compiled to
  `server/dist/`, entry `node dist/index.js`. **The backend does not
  serve the frontend** — there is no `express.static` for the SPA; a
  reverse proxy serves the files and forwards `/api`.
- Database: **SQLite** via `node:sqlite` (`server/data/clipforge.db`,
  WAL mode, schema version `user_version = 14`). No PostgreSQL, no
  Redis anywhere in the codebase.
- Workers: 8 background workers run **in-process** in the same Node
  process (analysis, render, tracking, Phase-8, export, publishing,
  analytics, account — all started in `server/src/index.ts`). They
  claim jobs from SQLite tables and recover interrupted jobs at boot.
- Media pipeline: FFmpeg/FFprobe from `PATH`; Python 3 child
  processes for faster-whisper STT (`server/scripts/transcribe.py`)
  and CV tracking (`server/scripts/track.py`, ONNX models in
  `server/models/`).
- Email: SMTP via nodemailer when `SMTP_HOST` is set, otherwise a
  file outbox under `server/data/outbox/`. Configuration reference:
  `docs/ENVIRONMENT.md`.

## Files

| File | Purpose |
|---|---|
| `Dockerfile` | Multi-stage: `frontend-build`, `server-build`, `api` runtime (Node 24.22.1-bookworm-slim pinned by tag, FFmpeg + Python installed, production deps only, non-root `node` user, healthcheck on `/api/health`), `web` (Caddy 2.8.4-alpine + built SPA) |
| `docker-compose.yml` | `api` + `web` services, named volume `clipforge-data` for all of `server/data`, Caddy config inlined via compose `configs:`, restart `unless-stopped`, api not published to the host (only `web` binds 80/443) |

Known Dockerfile caveats for the first real build:

1. Base images are pinned by **tag**, not digest (no registry access
   when written). Resolve digests and pin them before production.
2. Python packages are pinned in `server/requirements.txt` (versions
   verified on the dev machine, 2026-11-02) and the `api` image
   installs from it. The pins were verified on x86-64; the ARM64
   wheel set (the free target is ARM — see below) must be confirmed
   on the first build there.
3. The repo's `npm start` (`tsx src/index.ts`) cannot run with
   production-only `node_modules` because `tsx` is a devDependency.
   The image therefore runs the compiled `dist/index.js`. (Either fix
   works long-term: keep compiled entry, or move `tsx` to dependencies
   — a code decision for the lead, noted here, not made here.)

## Deployment target — the FREE route (owner decision, 2026-11-02)

### Primary — Oracle Cloud Always Free (₹0 recurring)

Why it fits: it is a real VPS with persistent block storage. The
SQLite file, the media tree and the 8 in-process workers all live on
one always-on machine — the same single-host shape as the rest of
this document assumes.

What Always Free includes (Oracle's published allowances — re-check
them at signup; Oracle changes these terms):

- Ampere A1 (ARM) compute: up to 4 OCPU + 24 GB RAM in total across
  Always Free A1 instances.
- 2× AMD E2.1.Micro instances (x86, 1 GB RAM each).
- 200 GB block storage in total; 10 TB/month outbound data transfer.

**Chosen shape:** ONE A1 instance using the full free A1 allocation
(4 OCPU / 24 GB RAM), Ubuntu 24.04 ARM image, the block volume
carrying the repo plus the `clipforge-data` volume.

- The x86 Micro (1 GB RAM) is **not viable** for this app: Node +
  the faster-whisper model + FFmpeg renders exceed a 1 GB working
  set. Do not plan around it.
- **ARM caveat (honest):** the whole native stack must resolve on
  linux/arm64 — Node 24 (arm64 build), FFmpeg (apt), the Python
  wheels in `server/requirements.txt` (faster-whisper/ctranslate2,
  onnxruntime, opencv-python-headless, numpy, tokenizers, PyAV) and
  `@node-rs/argon2` (ships arm64 prebuilds). All of these publish
  arm64 artifacts, but this combination has **not been built or
  tested on ARM for this project**. The first
  `docker compose up --build` on the instance is a verification
  step: if a wheel is missing, the fallback is building that one
  package from source on the instance (slower, still free). Record
  the outcome in the release record.
- **Speed expectation:** A1 cores are slower per core than a modern
  x86 VPS; Whisper transcription and FFmpeg renders will take
  longer. `RENDER_CONCURRENCY` stays at 1.

**Signup — the card requirement, stated plainly:** Oracle requires
a payment card for identity verification at signup. Always Free
resources are not charged. A small temporary authorization hold may
appear during verification and is released. Staying on an Always
Free (non-upgraded) account means Oracle cannot bill you — but you
also cannot exceed the free allowances. Do **not** upgrade to
Pay-As-You-Go unless deliberately moving to the paid path: PAYG
accounts are charged for anything beyond the Always Free limits.

**Idle-reclamation risk (documented Oracle policy):** Always Free
compute instances that stay idle — low CPU / network / memory
utilization over a 7-day window, per Oracle's published thresholds —
may be stopped and reclaimed. Mitigations: the app is a real
always-on service (HTTP traffic, worker ticks, health checks), and,
regardless, **backups must live off the instance** (run
`server/scripts/backup.mjs` on a schedule and copy the output
off-box — see BACKUP_RESTORE.md), so a reclaimed instance is an
inconvenience, not data loss. With the backups plus this runbook, a
fresh instance can be stood up again without data loss.

**Free domain (₹0):** Oracle provides no friendly subdomain for a
VM. Use **DuckDNS**: register `<name>.duckdns.org` (free), point it
at the instance's public IP (DuckDNS offers a simple update URL that
can be cron'd on the instance in case the IP ever changes). Set
`APP_DOMAIN=<name>.duckdns.org` — the compose `web` service (Caddy)
then obtains a real Let's Encrypt certificate for it automatically,
as it does for any real domain. HTTPS matters: production session
cookies are `Secure`, and OAuth redirect URIs (when providers are
configured later) need a stable https origin.

**First-deploy steps:**

1. Create the Oracle account (card verification — see above). Pick
   a home region with A1 capacity; if A1 shows out-of-capacity in
   one availability domain, retry another AD or later — free A1
   capacity is the known friction point, and this step can take
   retries.
2. Create the A1 instance (4 OCPU / 24 GB RAM, Ubuntu 24.04), SSH
   key auth only. Take a reserved public IP if offered — it keeps
   the DuckDNS target stable.
3. Open ports in **both** places: the VCN security list (ingress
   80 and 443 from `0.0.0.0/0`; 22 from your own IP only) **and**
   the host firewall — Oracle's Ubuntu images ship restrictive
   iptables rules, so add host-side accepts for 80/443 too (the
   classic "instance up, site unreachable" gotcha).
4. Register the DuckDNS name → instance IP; verify DNS resolves.
5. Install Docker Engine + the Compose plugin (arm64) from Docker's
   official apt repo; create a non-root deploy user in the `docker`
   group.
6. Copy the repo to the instance (release ZIP until the project is
   under git — see RELEASE_PROCESS.md for what that means for
   commit ids).
7. Create the secrets on the host only: `openssl rand -base64 32`
   for this instance's own `TOKEN_ENCRYPTION_KEY`; `ADMIN_EMAILS`
   set to the operator. Store them in a 0600 file outside the repo —
   never in the repo. Compose refuses to start if
   `TOKEN_ENCRYPTION_KEY` is unset (deliberate; see ENVIRONMENT.md
   G1), and the server itself now also fails fast in production
   without a valid key.
8. `APP_DOMAIN=<name>.duckdns.org docker compose up -d --build` —
   this first build also verifies the ARM wheel set (see caveat).
9. Smoke test: `docker compose ps` (api healthy);
   `curl https://<name>.duckdns.org/api/health` → `{"ok":true}`;
   open the site, sign up, upload a short video, run one export,
   confirm the exported file plays **with audio** (the project's
   standing A/V rule); check Admin → System Health.
10. Schedule backups: cron `server/scripts/backup.mjs` and copy
    the output **off the instance**. Rehearse one restore
    (BACKUP_RESTORE.md) before calling the instance production.

**Cost:** ₹0 recurring. The real costs are constraints, not money:
ARM build verification, slower renders, idle-reclamation risk, and
a single small host (see "Production path — and its honest limits").

### Fallback — Render / Railway free tiers (demo-only for this app)

| | Render (free web service) | Railway |
|---|---|---|
| Compute | Free instance; **spins down after ~15 min idle**, cold start on the next request | **No permanent free tier** — a trial credit, then paid (~$5/mo Hobby) |
| Disk | **Ephemeral** — the filesystem resets on restart/redeploy | Volumes only on paid plans |
| Consequence for CLIPFORGE | The SQLite DB, uploaded media and exports are wiped on every spin-down/restart; the in-process workers die with the web process | Same persistence problem during the trial; cost starts when the trial ends |
| Verdict | OK for a clickable demo link with throwaway data. **Not a deployment.** | OK for a time-boxed demo. **Not a free deployment.** |

The blocker is architectural, not preference: this app requires
persistent local disk, always-on in-process workers, and long
FF
...[truncated 6732 chars]