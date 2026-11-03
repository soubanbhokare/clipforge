# CLIPFORGE — Backup & Restore (Phase 13, §7)

- **Date:** 2026-11-02 (IST)
- **Tool:** `server/scripts/backup.mjs` (new in Phase 13; dependency-free, Node ≥ 22,
  uses built-in `node:sqlite`)
- **Restore test:** performed for real, in isolation under `/tmp` — see §4 for the
  exact commands and outputs. The real `server/data/` was never used as a backup
  source or restore target in the test.

---

## 1. What a CLIPFORGE backup must contain

A database-only backup is **not** a full backup. The SQLite file holds metadata and
`storage_key` references; the actual binaries live in the data dir's storage trees:

| Component | Location (defaults) | Config variable |
|---|---|---|
| SQLite database | `server/data/clipforge.db` (+ `-wal`/`-shm` while running) | `DATABASE_FILE` |
| Uploaded / derived media | `server/data/media/` | `MEDIA_DIR` |
| Processing scratch/outputs | `server/data/processing/` | `PROCESSING_DIR` |
| Analytics report files | `server/data/reports/` | `ANALYTICS_REPORTS_DIR` |
| Avatars | `server/data/avatars/` | `AVATARS_DIR` |
| Data-export ZIPs | `server/data/data-exports/` | `DATA_EXPORTS_DIR` |
| Workspace logos | `server/data/workspace-logos/` | `WORKSPACE_LOGOS_DIR` |

Deliberately **excluded**: `server/data/outbox/` (development mail spool — e-mail
is re-derivable and the spool contains one-time token links that should not be
archived), and the live `-wal`/`-shm` files (the snapshot method below makes them
unnecessary).

**Not covered by any file backup:** environment secrets/configuration
(`TOKEN_ENCRYPTION_KEY`, OAuth client secrets, SMTP, `ADMIN_EMAILS`, …). Without
`TOKEN_ENCRYPTION_KEY` a restored database cannot decrypt its stored OAuth tokens
(`oauth_token_records` are AES-256-GCM ciphertext). The operator must keep the
production environment configuration in a separate, secure location — the backup
script and manifest intentionally contain **no secrets and no env values**.

---

## 2. The backup script

```
node server/scripts/backup.mjs [--source-dir DIR] [--dest-dir DIR]
                               [--db-file FILE] [--label TEXT]
```

Configuration (first match wins):

| Setting | Sources | Default |
|---|---|---|
| Source data dir | `--source-dir` · `BACKUP_SOURCE_DIR` · `CLIPFORGE_DATA_DIR` · dir of `DATABASE_FILE` | `server/data` |
| Database file | `--db-file` · `DATABASE_FILE` | `<source-dir>/clipforge.db` |
| Destination | `--dest-dir` · `BACKUP_DEST_DIR` | `server/backups` |

Behaviour:

1. **Consistent snapshot** — opens the source DB and runs
   `VACUUM INTO '<backup>/clipforge.db'`. This is transactionally consistent
   (it includes everything committed in the WAL) and safe to run while the server
   is up; the source file is never written. (Copying `clipforge.db` with `cp`
   while the server runs would *not* be safe — un-checkpointed WAL content would
   be missed.)
2. **Storage copy** — copies each existing storage tree (`media`, `avatars`,
   `workspace-logos`, `reports`, `data-exports`, `processing`) into the backup
   with the same relative layout, so restore is a straight copy back.
3. **Manifest** — writes `manifest.json`: creation timestamp, label, DB size,
   DB SHA-256, `user_version`, integrity result, and for every storage file its
   relative path, size and SHA-256. No secrets, no credentials, no env values.
4. **Self-verification** — re-opens the snapshot read-only and runs
   `PRAGMA integrity_check` + `PRAGMA foreign_key_check`. Output layout:

```
<dest>/clipforge-backup-2026-11-02T14-14-40-622Z-<label>/
├── clipforge.db
├── manifest.json
└── media/  avatars/  …        (whichever storage trees exist)
```

5. **Failure semantics** — missing source DB, a destination inside the source
   dir, or a failed verification all exit **non-zero** (a failed-verification
   backup directory is kept and clearly reported as failed). Exit code is the
   contract a scheduler/alert wrapper should watch (§6).

---

## 3. Restore runbook

> Preconditions: you have a backup directory whose `manifest.json` shows
> `"integrity_check": ["ok"]`. You have the production env configuration
> (notably `TOKEN_ENCRYPTION_KEY`) available from its separate secure store.

1. **Stop the server** (and its in-process workers — they are the same process).
   Confirm nothing holds the database: no `node … src/index.ts` process running.
2. **Preserve the current state** before overwriting anything — even if it looks
   broken, move it aside, do not delete it:
   ```bash
   mv server/data/clipforge.db server/data/clipforge.db.pre-restore-$(date +%s)
   # if present, also move clipforge.db-wal / clipforge.db-shm aside with it
   ```
3. **Copy the snapshot in:**
   ```bash
   cp <backup-dir>/clipforge.db server/data/clipforge.db
   ```
   Make sure **no stale `clipforge.db-wal` / `clipforge.db-shm`** from the old
   database remains next to it — a leftover WAL belongs to the old file and must
   never be paired with the restored one.
4. **Restore the storage trees** the same way, per directory present in the backup:
   ```bash
   cp -r <backup-dir>/media/.        server/data/media/
   cp -r <backup-dir>/avatars/.      server/data/avatars/
   # … workspace-logos, reports, data-exports, processing likewise
   ```
   (Spot-check a few files against the SHA-256 values in `manifest.json` with
   `sha256sum`.)
5. **Verify before starting** (read-only, no server needed):
   ```bash
   node -e "const {DatabaseSync}=require('node:sqlite'); \
     const db=new DatabaseSync('server/data/clipforge.db',{readOnly:true}); \
     console.log(db.prepare('PRAGMA integrity_check').all()); \
     console.log(db.prepare('PRAGMA user_version').get()); db.close();"
   # expected: integrity_check 'ok', user_version = the manifest's value (14)
   ```
   Note: the snapshot's `journal_mode` reads `delete` until first boot — that is
   an artefact of `VACUUM INTO`; `getDb()` re-applies WAL on startup. Not an error.
6. **Start the server** with the production env configuration in place. On boot,
   `getDb()` will re-run the (idempotent) migration chain and stamp
   `user_version = 14`; workers will run their normal boot recovery for any jobs
   that were mid-flight in the snapshot.
7. **Smoke-check:** sign in, open one project, confirm one media file plays/
   downloads, and confirm one connected publishing account still shows CONNECTED
   (this also proves the token-encryption key matches the restored data).
8. **If verification fails at step 5:** do not start the server. Try the previous
   backup instead, and keep the failed directory untouched for diagnosis.

**Pre-migration rule (from the database audit):** before deploying any build that
changes `server/src/db.ts`, run a backup first. Migrations are forward-only; this
backup *is* the rollback.

---

## 4. Restore test — actually performed (evidence)

Isolated test, 2026-11-02, entirely under `/tmp/cf13-restore/` (the surviving
artefacts are the backup directory and the step logs in that folder).

**Step 1 — Initialise a throwaway data dir with the project's own `getDb()`:**

```bash
cd ~/workspace/CLIPFORGE/server
DATABASE_FILE=/tmp/cf13-restore/src-data/clipforge.db \
MEDIA_DIR=/tmp/cf13-restore/src-data/media \
PROCESSING_DIR=/tmp/cf13-restore/src-data/processing \
ANALYTICS_REPORTS_DIR=/tmp/cf13-restore/src-data/reports \
AVATARS_DIR=/tmp/cf13-restore/src-data/avatars \
DATA_EXPORTS_DIR=/tmp/cf13-restore/src-data/data-exports \
WORKSPACE_LOGOS_DIR=/tmp/cf13-restore/src-data/workspace-logos \
NODE_ENV=test ./node_modules/.bin/tsx <fresh-init script calling getDb()>
# → "user_version": 14, "table_count": 102
```

**Step 2 — Insert recognisable probe rows directly (node:sqlite) + probe media:**

```sql
INSERT INTO users    (id, …) VALUES ('probe-user-13', 'Phase13 Probe',
                                     'probe13@example.invalid', …);
INSERT INTO projects (id, user_id, name, …)
  VALUES ('probe-project-13', 'probe-user-13', 'PROBE13-RESTORE-PROJECT', …);
-- probe user:    { id: 'probe-user-13',    email: 'probe13@example.invalid' }
-- probe project: { id: 'probe-project-13', name: 'PROBE13-RESTORE-PROJECT' }
-- integrity before backup: ok
```
Probe media file `media/probe13/hello.txt` (44 bytes):
`sha256 = a3e036c80bf0e78b0a36ec65c6c31d152aec6b0a06e07150a6f68b002d12269c`

**Step 3 — Back up with the new script:**

```bash
node ~/workspace/CLIPFORGE/server/scripts/backup.mjs \
  --source-dir /tmp/cf13-restore/src-data \
  --dest-dir   /tmp/cf13-restore/backups --label restore-test
```
Output (key lines):
```json
{ "ok": true,
  "backup_dir": "/tmp/cf13-restore/backups/clipforge-backup-2026-11-02T14-14-40-622Z-restore-test",
  "database": { "file": "clipforge.db", "size_bytes": 1556480,
    "sha256": "7a257f2b260be2d2fbf0211d0de4da12cd9cef9f474240bb458c511b7d4529b4",
    "user_version": 14, "integrity_check": ["ok"], "foreign_key_violations": 0 },
  "storage_dirs": ["media"] }
```
Manifest records the media file with the same SHA-256 as the source
(`probe13/hello.txt`, 44 bytes, `a3e036c8…2269c`).

**Step 4 — Simulated loss:** `rm -rf /tmp/cf13-restore/src-data` (source dir wiped;
only `backups/` and logs remained).

**Step 5 — Restore** into a fresh `restored/` dir by copying `clipforge.db` and the
`media/` tree back out of the backup (the §3 runbook steps, against the temp dirs).

**Step 6 — Verification of the restored copy:**

```
tables: 102, views: 1, indexes: 253
user_version: 14
integrity_check: ok
foreign_key_check: 0 violations
restored probe user:    { id: 'probe-user-13',    email: 'probe13@example.invalid' }
restored probe project: { id: 'probe-project-13', name: 'PROBE13-RESTORE-PROJECT' }
restored media sha256sum:
  a3e036c80bf0e78b0a36ec65c6c31d152aec6b0a06e07150a6f68b002d12269c  restored/media/probe13/hello.txt
  → identical to source and to the manifest entry
```

**Verdict: PASS** — every check held after a full wipe: integrity ok, probe rows
present, `user_version` still 14, media checksum identical.

**Measured timings (single data point, tiny data — see §7 caveats):** in a second
timing run against the same 1,556,480-byte database + one 44-byte media file,
backup (snapshot + manifest + verification) took **0.54 s** and the restore copy
step took **0.004 s** on this machine. These numbers say the *mechanism* is fast
at development scale and nothing about production media volumes.

Also verified: `node --check server/scripts/backup.mjs` passes, and the script
exits `1` with a clear message when the source database does not exist.

---

## 5. Retention policy (proposal)

No retention exists today — this is a **proposal for the operator to adopt**, not
a description of running behaviour:

- **Hourly** backups kept for **24 h** (24 copies) — protects against same-day
  bad deploys/migrations.
- **Daily** backups kept for **14 days**.
- **Weekly** backups kept for **8 weeks**; one **monthly** archive kept for
  **12 months**.
- Prune by the timestamp in the backup directory name; never prune the most
  recent backup, and never prune a backup whose manifest verification failed
  until a human has looked at it (it may be the only copy of that state).
- **Copy backups off the server** (object storage / another machine). Backups
  sitting on the same disk as `server/data/` do not survive disk loss — today
  the default destination `server/backups/` is exactly that same disk, which is
  acceptable for migration safety and operator mistakes only.
- Before any schema-changing deploy: one extra labelled backup
  (`--label pre-deploy-<version>`), exempt from pruning until the deploy is
  confirmed good.

## 6. Schedule proposal + failure alerting (honest status)

**Schedule (proposal):** nothing schedules backups today. The intended shape is a
system cron entry on the host, for example:

```cron
# CLIPFORGE backup — hourly snapshot, daily prune (operator installs this;
# it is NOT installed by this phase)
17 * * * *  cd /path/to/CLIPFORGE/server && /usr/bin/node scripts/backup.mjs --label cron-hourly >> /var/log/clipforge-backup.log 2>&1
23 3 * * *  find /path/to/CLIPFORGE/server/backups -maxdepth 1 -name 'clipforge-backup-*' -mtime +14 -type d -exec rm -rf {} +
```

**Failure alerts — what exists vs what an operator must add:**

- *Exists:* the script exits non-zero on any failure (missing source, failed
  integrity check) and prints a JSON/`[backup] failed:` line; success prints
  `"ok": true`. Cron mail or a log file therefore captures failures verbatim.
- *Does not exist (operator must add):* there is **no** alerting integration in
  the codebase — no e-mail/webhook/pager hook, no "backup age" health check, no
  admin-UI surface for backup status. Until the operator wires one, the minimum
  viable alerting is: cron's own mail on non-zero exit, **plus** a dead-man's
  check that a backup directory newer than the schedule interval exists (a job
  that never runs fails silently otherwise — exit-code watching alone misses
  that case). Both are host-level configuration, deliberately not invented
  inside the app in this phase.

## 7. RPO / RTO

> **These are PROPOSED TARGETS — not measured.** CLIPFORGE has never run with
> production data or a production backup schedule, so no recovery objective has
> ever been demonstrated at production scale.

| Objective | Proposed target (not measured) | Basis / caveat |
|---|---|---|
| **RPO** (max data loss) | **≤ 1 hour** | Follows directly from the proposed hourly schedule in §6 — with hourly snapshots, worst-case loss is everything since the last good backup. Tightening RPO means shortening the interval; WAL archiving/continuous replication does not exist in this codebase. |
| **RTO** (max downtime to restored service) | **≤ 30 minutes** for a single-host restore at modest media volume | The restore *mechanism* measured 0.004 s for the copy step and the whole test restore+verify completed in seconds — but on a **1,556,480-byte database + one 44-byte media file**. At real media volumes the copy time is dominated by media size and disk/network speed, which have never been measured here; the 30-minute target is an operator commitment to validate with a timed drill on realistic data, not a result. |

Recommended practice (proposal): run the §3 runbook as a **timed restore drill
quarterly** against the newest real backup, and record the measured duration —
that drill, repeated, is what turns the targets above into evidence.
