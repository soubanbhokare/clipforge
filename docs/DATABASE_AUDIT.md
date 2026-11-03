# CLIPFORGE — Database Audit (Phase 13, §6)

- **Date of audit:** 2026-11-02 (IST)
- **Scope:** `server/src/db.ts` (schema + migrations, 3,242 lines), `server/src/config.ts`
  (data-dir selection), and two databases opened **read-only / as copies** — the live
  `server/data/clipforge.db` was copied to `/tmp` before any inspection and was never
  opened in place, modified, or deleted. No e2e suites were run for this audit.
- **Engine:** SQLite via Node's built-in `node:sqlite` (`DatabaseSync`), Node v24.22.1.
- **Current schema version:** `PRAGMA user_version = 14` (set unconditionally at the end
  of `getDb()`).

---

## 1. Headline results

| Check | Result |
|---|---|
| Fresh-init (project's own `getDb()`, temp dir) | **PASS** — `user_version = 14`, 102 tables + 1 view + 253 index entries (132 explicit `CREATE INDEX` + 121 SQLite auto-indexes from PK/UNIQUE), `integrity_check = ok`, 0 FK violations |
| Fresh-init idempotency (second boot on same file) | **PASS** — identical counts, still version 14, plans still exactly 5 rows / 55 entitlement rows (backfill did not duplicate) |
| Integrity of a **copy** of the live DB | `PRAGMA integrity_check` → **`ok`**; `PRAGMA foreign_key_check` → **0 violations** |
| Live DB state (important, see §2) | The on-disk `server/data/clipforge.db` is a **stale, empty, pre-migration file**: 7 tables, 0 rows in every table, `user_version = 0`. It is *not* a v14 database. |
| Duplicate-job / idempotency constraints | Present and real (see §7) — partial UNIQUE indexes for project creation and publish jobs, UNIQUE idempotency key on the usage ledger, atomic conditional-UPDATE job claims in every worker |
| Rollback support | **None, by design** — migrations are forward-only; recovery is backup-restore or a new forward-fix migration (see §5) |

---

## 2. The live database file — read this first

Evidence (copy opened read-only at `/tmp/cf13-evidence/live-copy.db`,
135,168 bytes, file mtime 2026-11-01 19:28):

```
tables (7): email_verification_tokens, password_reset_tokens, projects,
            sessions, source_assets, upload_sessions, users
user_version: 0
journal_mode: wal
integrity_check: ok
foreign_key_check: 0 violations
row counts: 0 in all 7 tables
```

Interpretation, stated plainly:

- Only the v1 + v2 tables exist. `user_version` was never stamped — `getDb()` in the
  current code stamps 14 on *every* boot, so this file has **not been opened by the
  current server code** since it was created. It is almost certainly a leftover from an
  early-phase run; all later development and every e2e suite use temp databases
  (`DATABASE_FILE` pointing into `/tmp`), which is why the real file never moved.
- This is **not data loss**: the file contains no rows at all. There is no production
  user data in it to lose.
- Consequence for operations: the *first* real boot of the current server against
  `server/data/` will run the full v1→v14 chain against this file in one go. The
  fresh-init test (§4) proves that chain converges cleanly from empty, and the chain
  is written to converge from any intermediate state (`CREATE TABLE IF NOT EXISTS`,
  introspection-guarded `ALTER TABLE`, introspection-guarded rebuilds), so this is
  expected to be safe — but it has never actually been exercised against *this* file.
  **Recommendation:** take a backup (even of this empty file) before the first
  production boot, and treat that first boot as a migration event, not a routine start.
- The rest of `server/data/` is also mostly test residue: `media/` is empty,
  `outbox/` (~2.6 MB) is the dev mail spool written by e2e runs, `avatars/` and
  `data-exports/` hold test-run artefacts. Nothing in the audit treated these as
  production data.

---

## 3. Schema inventory (v14, from a fresh-initialised database)

- **102 tables, 1 view** (`publishing_calendar_events` — a projection over
  `scheduled_posts ⋈ publish_jobs`, deliberately not a second store),
  **132 explicit indexes** plus 121 auto-indexes backing PKs/UNIQUE constraints.
- The DDL table set and the fresh-init table set match **exactly** (diff = ∅ in both
  directions).
- **Primary keys:** every table has one. Most are `id TEXT PRIMARY KEY` (UUID strings).
  Exceptions: composite PKs on `analytics_metric_definitions (metric_key, platform)`,
  `workspace_members (workspace_id, user_id)`, `notification_preferences (user_id,
  category)`; single non-`id` PKs on `media_asset_meta (asset_ref)`,
  `user_preferences / user_totp / analytics_settings (user_id)`; `INTEGER PRIMARY KEY
  AUTOINCREMENT` on the three token tables (`email_verification_tokens`,
  `password_reset_tokens`, `email_change_tokens`).
- **Foreign keys:** 163 FK references across the schema — **150 `ON DELETE CASCADE`,
  12 `ON DELETE SET NULL`, 1 `ON DELETE NO ACTION`**. The single `NO ACTION` is
  `user_subscriptions.plan_id → plans(id)`: a plan with subscriptions cannot be
  deleted, which is the safe behaviour. The `SET NULL` set is deliberate: optional
  links (`clip_versions.base_candidate_id`, `upload_sessions.source_asset_id`,
  `brand_kits` logo/intro/outro/music/overlay assets, `oauth_connections.account_id`,
  `reframe_configurations.job_id`, `tracking_keyframes.job_id`,
  `login_events.user_id` — audit survives account deletion) and, since v14,
  `usage_ledger.user_id` (ledger rows survive, anonymised).
- **Tables with no FKs (10):** `users` (root), `plans`, `analytics_metric_definitions`
  (reference data), `admin_audit_log`, `account_deletion_jobs`,
  `payment_provider_records`, `payment_webhook_events`, `platform_webhook_events`,
  `provider_configurations`, `system_health_checks`. For the audit/deletion/webhook
  tables this is a deliberate survivability choice (rows must outlive the user they
  describe); it is documented here so it is a decision, not an oversight.
- **UNIQUE constraints beyond PKs** (selection; full list in Appendix A):
  `users.email COLLATE NOCASE`; hashed-token uniqueness on all token tables;
  `oauth_token_records.account_id` (one token record per account);
  `platform_accounts (user_id, platform, platform_account_id)`;
  `platform_webhook_events / payment_webhook_events (provider, event_id)`;
  `usage_ledger.idempotency_key`; `plans.key`; `plan_entitlements (plan_id, key)`;
  `provider_configurations.provider_key`; `payment_provider_records.provider`;
  single-row-per-parent uniques on `post_metadata.job_id`, `scheduled_posts.job_id`,
  `platform_posts.job_id`, `export_outputs.job_id`,
  `post_analytics_snapshots.platform_post_id`.
- **Partial UNIQUE indexes** (the idempotency/dedup backbone — see §7):
  `idx_projects_user_idempotency (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL`;
  `idx_publish_jobs_idem (user_id, client_request_id) WHERE client_request_id IS NOT NULL`;
  `idx_caption_tracks_active (version_id) WHERE is_active = 1` (one active caption
  track per document); `idx_analytics_acct_snap_job (sync_job_id) WHERE … IS NOT NULL`
  and `idx_analytics_post_snap_job (sync_job_id, platform_post_id) WHERE … IS NOT NULL`
  (a retried sync cannot duplicate snapshots).

The full per-table inventory (PK, FK targets + ON DELETE behaviour, UNIQUE
constraints, explicit indexes) is **Appendix A** at the end of this document,
generated mechanically from `PRAGMA table_info / foreign_key_list / index_list`
on the fresh v14 database — not hand-transcribed from the DDL.

---

## 4. Fresh-init test (evidence)

How tests/the server select the data dir (from `server/src/config.ts`, verified in
the test files): there is no single "data dir" variable — each location is its own
env var, all defaulting under `server/data/`:

| Env var | Default |
|---|---|
| `DATABASE_FILE` | `server/data/clipforge.db` |
| `MEDIA_DIR` | `server/data/media` |
| `PROCESSING_DIR` | `server/data/processing` |
| `ANALYTICS_REPORTS_DIR` | `server/data/reports` |
| `AVATARS_DIR` | `server/data/avatars` |
| `DATA_EXPORTS_DIR` | `server/data/data-exports` |
| `WORKSPACE_LOGOS_DIR` | `server/data/workspace-logos` |

Every e2e suite isolates itself exactly this way (`fs.mkdtempSync(os.tmpdir()…)` +
`DATABASE_FILE`/`MEDIA_DIR` into the temp dir).

Test performed (2026-11-02, in `/tmp/cf13-evidence/`): pointed all seven
variables at a fresh temp dir and imported the project's own `getDb()` via `tsx`
(`server/node_modules/.bin/tsx`, script `/tmp/cf13-evidence/fresh-init.mts`):

```
"user_version": 14
"journal_mode": "wal"
"foreign_keys": 1
"table_count": 102        (full list in the run log; matches DDL set exactly)
"view_count": 1           (publishing_calendar_events)
"index_count": 253        (132 explicit + 121 auto-indexes)
"integrity_check": "ok"
"foreign_key_check_rows": 0
seeded rows after init: plans = 5, plan_entitlements = 55 (v12 backfill)
```

A second `getDb()` boot on the same file reproduced every number (idempotency),
including no duplicate plan seeding.

---

## 5. Migration chain v1 → v14

There is **no migration table and no per-version runner**: `getDb()` executes every
migration block in order on every boot, and safety comes from idempotency guards,
not from version bookkeeping. `user_version` is stamped `14` unconditionally at the
end — it is a label of "current code ran", not a record of which steps ran.

| Version | Phase | Tables added | Style | Idempotency guard | Rollback |
|---|---|---|---|---|---|
| v1 | 2 — Auth | 4 (`users`, `sessions`, `email_verification_tokens`, `password_reset_tokens`), 6 indexes | Additive | `CREATE TABLE/INDEX IF NOT EXISTS` | None |
| v2 | 3 — Studio | 3 (`projects`, `source_assets`, `upload_sessions`), 8 indexes | Additive | `IF NOT EXISTS` | None |
| v3 | 4 — Clip detection | 5 (`processing_tasks`, `transcripts`, `transcript_segments`, `topic_segments`, `candidate_clips`), 10 indexes | Additive | `IF NOT EXISTS` | None |
| v4 | 5 — Editor | 9 (`clip_versions` … `render_jobs`), 14 indexes | Additive | `IF NOT EXISTS` | None |
| v5 | 6 — Captions/Brand | 6 (`caption_tracks` … `translation_jobs`), 8 indexes | Additive + 2 guarded columns on `caption_segments` (`style_json`, `language`) | `IF NOT EXISTS` + `ensureColumn()` introspection | None |
| v6 | 7 — Tracking/Reframe | 8 (`tracking_jobs` … `split_screen_layouts`), 14 indexes | Additive | `IF NOT EXISTS` | None |
| v7 | 8 — B-roll/Enhance | 9 (`media_asset_meta` … `asset_usage_records`), 17 indexes | Additive | `IF NOT EXISTS` | None |
| v8 | 9 — Export | 5 (`export_presets`, `export_outputs`, `render_validation_results`, `render_error_log`, `export_bundles`), 6 indexes | Additive + 5 guarded columns on `render_jobs` (`kind`, `priority`, `retry_count`, `progress_json`, `output_name`) | `IF NOT EXISTS` + `ensureColumn()` | None |
| v9 | 10 — Publishing | 13 (`platform_accounts` … `post_analytics_snapshots`) + 1 view, 11 indexes | Additive | `IF NOT EXISTS` (incl. `CREATE VIEW IF NOT EXISTS`) | None |
| v10 | Audit fixes | 0 new tables | **Table rebuild**: `candidate_clips` recreated with widened status CHECK (`SELECTED/DESELECTED/REMOVED`), all rows/ids copied; + guarded columns `export_outputs.target_kind/target_id`, `render_jobs.worker_id` | Introspection: rebuild runs **only** while live DDL lacks `'DESELECTED'`; transactional `BEGIN IMMEDIATE`, `PRAGMA foreign_keys` OFF *outside* the transaction, `foreign_key_check` verified before return | **Forward-fix only** — the old table is dropped in the same transaction |
| v11 | 11 — Analytics | 14 (`analytics_metric_definitions` … `analytics_audit_log`), 16 indexes | Additive | `IF NOT EXISTS` | None |
| v12 | 12 — Accounts/Workspaces/Admin | 26 (`user_preferences` … `account_deletion_jobs`), 22 indexes | Additive + 10 guarded columns (`users.avatar_path/status/is_admin/last_login_at/active_workspace_id`, `sessions.ip/user_agent/last_active_at`, `projects.workspace_id`, `brand_kits.workspace_id`) + per-row **backfill** (`migrateV12Backfill`: plan seeding, personal workspace per user, memberships, default subscriptions, project/brand-kit workspace assignment) | `IF NOT EXISTS` + `ensureColumn()`; backfill checks for existing rows first (`INSERT OR IGNORE`, existence probes) — re-runs converge, verified in §4 | None |
| v13 | Fix pass | 0 | One guarded column: `user_totp.last_used_step` (TOTP replay prevention). **There is no `MIGRATION_V13_SQL` constant** — v13 exists only as this `ensureColumn` call + comment. | `ensureColumn()` introspection | None |
| v14 | Fix pass | 0 | **Table rebuild**: `usage_ledger` recreated with `user_id` nullable + `ON DELETE SET NULL` (same UNIQUE idempotency key + indexes), rows copied | Introspection: runs **only** while live DDL still contains `ON DELETE CASCADE`; same transactional + FK-check pattern as v10 | **Forward-fix only** |

**Forward-fix strategy (the project's actual rollback plan, stated honestly):**
SQLite cannot alter CHECK constraints, column nullability, or FK actions in place,
so v10/v14 *had* to be rebuilds; a rebuild that has committed cannot be "rolled
back" by the migration system because there is no down-migration code at all.
Recovery from a bad migration is therefore, in order: (1) restore the pre-boot
backup (see `BACKUP_RESTORE.md`) — this is the only true rollback; (2) or ship a
new forward migration (v15+) that rebuilds/corrects again, following the v10/v14
pattern (introspection guard → transactional rebuild → `foreign_key_check` gate).
Operators must treat "take a backup before deploying a schema-changing build" as
a hard rule, because the code will migrate on first boot with no prompt.

---

## 6. Integrity

| Database | `integrity_check` | `foreign_key_check` | `user_version` |
|---|---|---|---|
| Copy of live `server/data/clipforge.db` | `ok` | 0 violations | 0 (stale file, §2) |
| Fresh-init v14 (temp) | `ok` | 0 violations | 14 |
| Restored backup (Phase 13 restore test) | `ok` | 0 violations | 14 |

No corruption, no orphaned FK references found anywhere that was checked. Note the
limit of this evidence: the live file is empty, so integrity on *real user data*
has never been tested — there is no real user data on this machine.

---

## 7. Isolation, transactions, duplicate prevention, crash behaviour

### Workspace + ownership isolation
- Isolation is primarily **per-user**: almost every domain table carries a
  `user_id … REFERENCES users(id) ON DELETE CASCADE` column, and route code scopes
  queries by the authenticated user (the e2e suites exercise cross-user denial;
  re-running them was out of scope for this audit).
- **Workspace scoping is thin**: `workspace_id` exists on only four tables —
  `projects` and `brand_kits` (added in v12), `usage_ledger` (nullable, plain column,
  no FK), `admin_audit_log` (nullable, no FK) — plus the pointer
  `users.active_workspace_id`. All other content (clips, editor documents, exports,
  publishing, analytics) is reachable only *through* its owning project/user, not
  scoped by workspace directly. `workspace_members (workspace_id, user_id, role)`
  with its composite PK is the membership source of truth.
- ⚠️ `projects.workspace_id`, `brand_kits.workspace_id` and
  `users.active_workspace_id` were added by `ensureColumn` **without FK
  constraints** — nothing at the database level prevents a dangling workspace id.
  Application code assigns them from real workspace rows, but the DB will not catch
  a bug that writes a bad id. (Risk R3, §8.)

### Transactions
- `getDb()` sets exactly two pragmas: `PRAGMA journal_mode = WAL` and
  `PRAGMA foreign_keys = ON`. Nothing else — no `synchronous`, no `busy_timeout`
  anywhere in `server/src` (grep-verified), so both keep SQLite defaults.
- Explicit multi-statement transactions exist where correctness needs them:
  `editor.ts` and `tracking.ts` each have a local `transaction()` helper
  (`BEGIN … COMMIT/ROLLBACK`) used for document-state replacement and tracking
  result commits; `account.ts` uses `BEGIN IMMEDIATE` for the export/deletion
  workflow; `analytics.ts` uses `BEGIN IMMEDIATE`; the v10/v14 rebuilds are
  transactional. Most other writes are single statements (atomic by themselves
  in SQLite autocommit mode).
- **Job claiming is race-safe within this architecture**: every worker claims with
  a conditional UPDATE and checks `changes` — e.g.
  `UPDATE render_jobs SET status='RUNNING', …, worker_id=? WHERE id=? AND status='QUEUED'`
  (same pattern in `processing_tasks`, `tracking_jobs`, `phase8_jobs`,
  `analytics_sync_jobs`, publish scheduler). Two claimers cannot both win one row.
- **Duplicate-job prevention**: uniqueness, not just code discipline —
  projects: partial UNIQUE `(user_id, idempotency_key)`; publish jobs: partial
  UNIQUE `(user_id, client_request_id)`; usage ledger: UNIQUE `idempotency_key`
  written with `INSERT OR IGNORE`; analytics snapshots: partial UNIQUE on
  `sync_job_id` (see §3); webhook events: UNIQUE `(provider, event_id)`;
  `export_outputs.job_id` UNIQUE (one output record per job).
  ⚠️ One exception: `phase8_jobs.dedupe_key` has only a **non-unique** index
  (`idx_p8jobs_dedupe`); dedupe there is application-level (look for an existing
  QUEUED/RUNNING row with the same key before inserting, and a second check at
  claim time in `broll.ts`). Two truly simultaneous creates could both insert.
  Single-process server + in-process workers make this unlikely, not impossible.
  (Risk R4, §8.)

### Interrupted transactions / crashes
- WAL mode: a crash mid-transaction leaves the `-wal` file to be replayed/rolled
  back on next open; committed transactions survive, uncommitted ones do not.
  Because `synchronous` is left at the SQLite default, durability follows the
  platform default — no stronger guarantee is claimed or configured.
- There is **no `busy_timeout`**: if a second process (e.g. the backup script, an
  operator's sqlite shell) holds the DB while the server writes, the writer can
  get `SQLITE_BUSY` immediately instead of waiting. With the single-process,
  single-connection (`DatabaseSync` singleton) design this does not arise
  internally; it is an operational caveat for multi-process access.
- **Boot recovery is implemented per worker** (verified in code): interrupted
  analysis/render/tracking/Phase-8/bundle/analytics-sync/report/account-export/
  account-deletion jobs are re-queued or failed honestly on startup (e.g.
  analytics re-queues stuck syncs, bundle jobs left `RUNNING` are marked FAILED
  with "The server restarted…", account jobs left `RUNNING` return to `QUEUED`).
  Job state therefore survives restarts; in-flight *encoder/CV subprocess* work
  does not — it restarts from the persisted job row.

---

## 8. Schema risks (findings)

| # | Severity | Finding |
|---|---|---|
| R1 | **High (operational)** | The on-disk live DB is a stale empty v0 file (§2). First real boot performs the entire v1→v14 migration at once, untested against that exact file, with **no automatic pre-migration backup** anywhere in the codebase. Mitigation: backup-before-boot rule + the new `server/scripts/backup.mjs`. |
| R2 | Medium | No down-migrations and no migration-history table; `user_version` is stamped unconditionally, so a partially-failed boot cannot be diagnosed from the version number alone — diagnosis must use DDL introspection (which is, to be fair, exactly what the guarded migrations themselves do). |
| R3 | Medium | `projects.workspace_id`, `brand_kits.workspace_id`, `users.active_workspace_id`, `usage_ledger.workspace_id`, `usage_ledger.project_id/job_id`, `broll_recommendations.job_id/transcript_id`, `broll_placements.recommendation_id`, `asset_usage_records.project_id`, `support_ticket_messages.author_user_id`, `admin_audit_log.*` carry **no FK** — dangling references are possible at the DB level. Most are nullable-by-design or backfill-assigned, but a future code bug would not be caught by `foreign_key_check`. |
| R4 | Low–Medium | `phase8_jobs.dedupe_key` is not UNIQUE (see §7) — duplicate Phase-8 jobs are prevented by application checks, not by the schema, unlike every other idempotency path in the system. |
| R5 | Low | Missing indexes on some plausible hot columns (mechanical scan of the v14 schema; parent-FK indexes cover most real query paths, so these are *watch items*, not proven bottlenecks): `platform_posts` has **no explicit index at all** beyond PK + UNIQUE(job_id) — lookups by `user_id`/`account_id`/`platform_post_id` scan; `projects.workspace_id` and `brand_kits.workspace_id` unindexed (workspace listing queries); `mfa_challenges.user_id` unindexed (login-time lookup; table is small and short-lived); `translation_jobs.status`, `data_export_jobs.status`, `account_deletion_jobs.status` unindexed (worker polls by status alone — currently mitigated by tiny row counts); `analytics_comparison_groups.user_id` unindexed. Job-status polling for the main queues *is* properly indexed (`idx_tasks_status`, `idx_render_status`, `idx_tkjobs_status`, `idx_p8jobs_status`, `idx_publish_jobs_due`, `idx_analytics_sync_jobs_due`, `idx_scheduled_posts_due`). |
| R6 | Low | No `busy_timeout` / `synchronous` tuning (see §7) — fine for the current single-process design, must be revisited before any multi-process deployment. |
| R7 | Info | Backup snapshots produced by `VACUUM INTO` carry `journal_mode = delete` until the next server boot re-applies WAL in `getDb()`. Harmless, but an operator checking a restored file standalone should not mistake it for corruption. |
| R8 | Info | `PRAGMA user_version` on the live file being 0 while code expects 14 means any external tooling that trusts `user_version` alone will misread this deployment. The DDL-introspection guards are the reliable signal. |

No finding in this audit indicates corruption, missing FK enforcement on the main
ownership chains, or a broken migration: the fresh chain converges, is idempotent,
and preserves rows through both table rebuilds (v10/v14 copy every column by name
and gate on `foreign_key_check`).

---

## Appendix A — Per-table inventory (v14, machine-generated)

Columns: **PK** = primary key column(s). **FKs** = `column→target(ON DELETE)`.
**UNIQUE** = unique indexes/constraints other than the PK (partial = partial index).
**Indexes** = explicit `CREATE INDEX` indexes only (auto-indexes backing PK/UNIQUE
are not repeated).

| Table | PK | FKs | UNIQUE | Explicit indexes |
|---|---|---|---|---|
| `account_deletion_jobs` | id | — (none) | — | 1: idx_deletion_user |
| `admin_audit_log` | id | — (none) | — | 3: idx_audit_type, idx_audit_actor, idx_audit_time |
| `analytics_account_snapshots` | id | account_id→platform_accounts(CASCADE); user_id→users(CASCADE) | idx_analytics_acct_snap_job(sync_job_id) partial | 2: idx_analytics_acct_snap_account, idx_analytics_acct_snap_job |
| `analytics_audit_log` | id | user_id→users(CASCADE) | — | 1: idx_analytics_audit_user |
| `analytics_capabilities` | id | account_id→platform_accounts(CASCADE); user_id→users(CASCADE) | sqlite_autoindex_analytics_capabilities_2(account_id) | 1: idx_analytics_capabilities_user |
| `analytics_comparison_groups` | id | user_id→users(CASCADE) | — | 0: — |
| `analytics_insight_evidence` | id | insight_id→analytics_insights(CASCADE); user_id→users(CASCADE) | — | 1: idx_analytics_evidence_insight |
| `analytics_insights` | id | user_id→users(CASCADE) | — | 1: idx_analytics_insights_user |
| `analytics_metric_definitions` | metric_key, platform | — (none) | — | 0: — |
| `analytics_metric_values` | id | account_id→platform_accounts(CASCADE); platform_post_id→platform_posts(CASCADE); user_id→users(CASCADE) | — | 3: idx_analytics_values_user_metric, idx_analytics_values_post, idx_analytics_values_account |
| `analytics_post_snapshots` | id | account_id→platform_accounts(CASCADE); platform_post_id→platform_posts(CASCADE); user_id→users(CASCADE) | idx_analytics_post_snap_job(sync_job_id, platform_post_id) partial | 2: idx_analytics_post_snap_post, idx_analytics_post_snap_job |
| `analytics_report_exports` | id | report_id→analytics_reports(CASCADE); user_id→users(CASCADE) | sqlite_autoindex_analytics_report_exports_2(report_id, format) | 1: idx_analytics_report_exports_report |
| `analytics_reports` | id | user_id→users(CASCADE) | — | 1: idx_analytics_reports_user |
| `analytics_settings` | user_id | user_id→users(CASCADE) | — | 0: — |
| `analytics_sync_attempts` | id | job_id→analytics_sync_jobs(CASCADE); user_id→users(CASCADE) | — | 1: idx_analytics_sync_attempts_job |
| `analytics_sync_jobs` | id | account_id→platform_accounts(CASCADE); user_id→users(CASCADE) | — | 2: idx_analytics_sync_jobs_due, idx_analytics_sync_jobs_user |
| `asset_usage_records` | id | user_id→users(CASCADE) | — | 2: idx_usage_project, idx_usage_asset |
| `brand_assets` | id | user_id→users(CASCADE) | — | 1: idx_brand_assets_user |
| `brand_kits` | id | intro_asset_id→brand_assets(SET NULL); logo_asset_id→brand_assets(SET NULL); music_asset_id→brand_assets(SET NULL); outro_asset_id→brand_assets(SET NULL); overlay_asset_id→brand_assets(SET NULL); user_id→users(CASCADE) | — | 1: idx_brand_kits_user |
| `broll_placements` | id | project_id→projects(CASCADE); user_id→users(CASCADE); version_id→clip_versions(CASCADE) | — | 2: idx_brollplace_project, idx_brollplace_version |
| `broll_recommendations` | id | project_id→projects(CASCADE); user_id→users(CASCADE) | — | 2: idx_brollrec_job, idx_brollrec_project |
| `candidate_clips` | id | project_id→projects(CASCADE); source_asset_id→source_assets(CASCADE); task_id→processing_tasks(CASCADE); user_id→users(CASCADE) | — | 3: idx_candidates_user_id, idx_candidates_task_id, idx_candidates_project_id |
| `caption_segments` | id | version_id→clip_versions(CASCADE) | — | 1: idx_captions_version |
| `caption_templates` | id | user_id→users(CASCADE) | — | 1: idx_ctemplates_user |
| `caption_track_segments` | id | track_id→caption_tracks(CASCADE) | — | 1: idx_ctsegments_track |
| `caption_tracks` | id | project_id→projects(CASCADE); user_id→users(CASCADE); version_id→clip_versions(CASCADE) | idx_caption_tracks_active(version_id) partial | 2: idx_caption_tracks_active, idx_caption_tracks_version |
| `clip_versions` | id | base_candidate_id→candidate_clips(SET NULL); project_id→projects(CASCADE); user_id→users(CASCADE) | idx_clip_versions_project(project_id) | 2: idx_clip_versions_user, idx_clip_versions_project |
| `data_export_jobs` | id | user_id→users(CASCADE) | — | 1: idx_data_exports_user |
| `editing_operations` | id | version_id→clip_versions(CASCADE) | idx_ops_version_seq(version_id, seq) | 1: idx_ops_version_seq |
| `effect_presets` | id | user_id→users(CASCADE) | — | 1: idx_epresets_user |
| `email_change_tokens` | id | user_id→users(CASCADE) | sqlite_autoindex_email_change_tokens_1(hashed_token) | 1: idx_ect_user_id |
| `email_verification_tokens` | id | user_id→users(CASCADE) | sqlite_autoindex_email_verification_tokens_1(hashed_token) | 2: idx_evt_expires_at, idx_evt_user_id |
| `enhancement_configs` | id | project_id→projects(CASCADE); user_id→users(CASCADE); version_id→clip_versions(CASCADE) | idx_enhcfg_version(version_id) | 1: idx_enhcfg_version |
| `export_bundles` | id | user_id→users(CASCADE) | — | 1: idx_bundles_user |
| `export_outputs` | id | job_id→render_jobs(CASCADE); project_id→projects(CASCADE); user_id→users(CASCADE) | sqlite_autoindex_export_outputs_2(job_id) | 2: idx_export_outputs_project, idx_export_outputs_user |
| `export_presets` | id | user_id→users(CASCADE) | — | 1: idx_export_presets_user |
| `invoices` | id | user_id→users(CASCADE) | — | 1: idx_invoices_user |
| `login_events` | id | user_id→users(SET NULL) | — | 2: idx_login_events_email, idx_login_events_user |
| `media_asset_meta` | asset_ref | project_id→projects(CASCADE); user_id→users(CASCADE) | — | 3: idx_mmeta_category, idx_mmeta_project, idx_mmeta_user |
| `media_library_folders` | id | user_id→users(CASCADE) | — | 1: idx_mfolders_user |
| `media_license_records` | id | user_id→users(CASCADE) | — | 1: idx_mlic_asset |
| `mfa_challenges` | id | user_id→users(CASCADE) | — | 0: — |
| `mfa_recovery_codes` | id | user_id→users(CASCADE) | — | 1: idx_mfa_codes_user |
| `notification_preferences` | user_id, category | user_id→users(CASCADE) | — | 0: — |
| `notifications` | id | user_id→users(CASCADE) | — | 1: idx_notifications_user |
| `oauth_connections` | id | account_id→platform_accounts(SET NULL); user_id→users(CASCADE) | sqlite_autoindex_oauth_connections_2(state_hash) | 1: idx_oauth_connections_user |
| `oauth_token_records` | id | account_id→platform_accounts(CASCADE); user_id→users(CASCADE) | sqlite_autoindex_oauth_token_records_2(account_id) | 0: — |
| `password_reset_tokens` | id | user_id→users(CASCADE) | sqlite_autoindex_password_reset_tokens_1(hashed_token) | 2: idx_prt_expires_at, idx_prt_user_id |
| `payment_provider_records` | id | — (none) | sqlite_autoindex_payment_provider_records_2(provider) | 0: — |
| `payment_webhook_events` | id | — (none) | sqlite_autoindex_payment_webhook_events_2(provider, event_id) | 0: — |
| `phase8_jobs` | id | project_id→projects(CASCADE); user_id→users(CASCADE) | — | 4: idx_p8jobs_dedupe, idx_p8jobs_status, idx_p8jobs_user_status, idx_p8jobs_project |
| `plan_entitlements` | id | plan_id→plans(CASCADE) | sqlite_autoindex_plan_entitlements_2(plan_id, key) | 0: — |
| `plans` | id | — (none) | sqlite_autoindex_plans_2(key) | 0: — |
| `platform_accounts` | id | user_id→users(CASCADE) | sqlite_autoindex_platform_accounts_2(user_id, platform, platform_account_id) | 1: idx_platform_accounts_user |
| `platform_capability_snapshots` | id | account_id→platform_accounts(CASCADE); user_id→users(CASCADE) | — | 1: idx_cap_snapshots_account |
| `platform_posts` | id | account_id→platform_accounts(CASCADE); job_id→publish_jobs(CASCADE); user_id→users(CASCADE) | sqlite_autoindex_platform_posts_2(job_id) | 0: — |
| `platform_webhook_events` | id | — (none) | sqlite_autoindex_platform_webhook_events_2(provider, event_id) | 1: idx_webhook_events_provider |
| `post_analytics_snapshots` | id | platform_post_id→platform_posts(CASCADE); user_id→users(CASCADE) | sqlite_autoindex_post_analytics_snapshots_2(platform_post_id) | 0: — |
| `post_metadata` | id | job_id→publish_jobs(CASCADE); user_id→users(CASCADE) | sqlite_autoindex_post_metadata_2(job_id) | 0: — |
| `post_validation_results` | id | job_id→publish_jobs(CASCADE); user_id→users(CASCADE) | — | 1: idx_post_validation_job |
| `processing_tasks` | id | project_id→projects(CASCADE); source_asset_id→source_assets(CASCADE); user_id→users(CASCADE) | — | 3: idx_tasks_status, idx_tasks_user_status, idx_tasks_project_id |
| `project_media` | id | project_id→projects(CASCADE); user_id→users(CASCADE) | — | 2: idx_pmedia_user, idx_pmedia_project |
| `project_versions` | id | version_id→clip_versions(CASCADE) | — | 1: idx_pversions_version |
| `projects` | id | user_id→users(CASCADE) | idx_projects_user_idempotency(user_id, idempotency_key) partial | 3: idx_projects_user_idempotency, idx_projects_user_status, idx_projects_user_id |
| `provider_configurations` | id | — (none) | sqlite_autoindex_provider_configurations_2(provider_key) | 0: — |
| `publish_attempts` | id | job_id→publish_jobs(CASCADE); user_id→users(CASCADE) | — | 1: idx_publish_attempts_job |
| `publish_jobs` | id | account_id→platform_accounts(CASCADE); export_output_id→export_outputs(CASCADE); project_id→projects(CASCADE); user_id→users(CASCADE) | idx_publish_jobs_idem(user_id, client_request_id) partial | 3: idx_publish_jobs_idem, idx_publish_jobs_due, idx_publish_jobs_user |
| `publishing_error_log` | id | job_id→publish_jobs(CASCADE); user_id→users(CASCADE) | — | 1: idx_publishing_errors_job |
| `reframe_configurations` | id | job_id→tracking_jobs(SET NULL); project_id→projects(CASCADE); user_id→users(CASCADE); version_id→clip_versions(CASCADE) | idx_reframe_version(version_id) | 2: idx_reframe_user, idx_reframe_version |
| `render_error_log` | id | job_id→render_jobs(CASCADE); user_id→users(CASCADE) | — | 1: idx_render_errors_job |
| `render_jobs` | id | project_id→projects(CASCADE); user_id→users(CASCADE); version_id→clip_versions(CASCADE) | — | 3: idx_render_status, idx_render_user_status, idx_render_project |
| `render_validation_results` | id | job_id→render_jobs(CASCADE); user_id→users(CASCADE) | — | 1: idx_validation_job |
| `scene_overrides` | id | version_id→clip_versions(CASCADE) | — | 1: idx_overrides_version |
| `scene_tracking_overrides` | id | config_id→reframe_configurations(CASCADE) | — | 1: idx_scene_tovr_config |
| `scheduled_posts` | id | job_id→publish_jobs(CASCADE); user_id→users(CASCADE) | sqlite_autoindex_scheduled_posts_2(job_id) | 1: idx_scheduled_posts_due |
| `sessions` | id | user_id→users(CASCADE) | — | 2: idx_sessions_expires_at, idx_sessions_user_id |
| `source_assets` | id | project_id→projects(CASCADE); user_id→users(CASCADE) | — | 2: idx_assets_user_id, idx_assets_project_id |
| `split_screen_layouts` | id | config_id→reframe_configurations(CASCADE) | idx_split_config(config_id) | 1: idx_split_config |
| `subject_associations` | id | job_id→tracking_jobs(CASCADE); subject_id→tracked_subjects(CASCADE) | — | 2: idx_assoc_subject, idx_assoc_job |
| `subscription_events` | id | user_id→users(CASCADE) | — | 1: idx_sub_events_user |
| `support_ticket_messages` | id | ticket_id→support_tickets(CASCADE) | — | 1: idx_ticket_msgs |
| `support_tickets` | id | user_id→users(CASCADE) | — | 1: idx_tickets_user |
| `system_health_checks` | id | — (none) | — | 1: idx_health_key_time |
| `timeline_items` | id | track_id→timeline_tracks(CASCADE); version_id→clip_versions(CASCADE) | — | 2: idx_items_track, idx_items_version |
| `timeline_tracks` | id | version_id→clip_versions(CASCADE) | — | 1: idx_tracks_version |
| `topic_segments` | id | transcript_id→transcripts(CASCADE) | — | 1: idx_topics_transcript_id |
| `tracked_subjects` | id | job_id→tracking_jobs(CASCADE) | idx_subjects_job_key(job_id, subject_key) | 2: idx_subjects_job, idx_subjects_job_key |
| `tracking_frames` | id | job_id→tracking_jobs(CASCADE); subject_id→tracked_subjects(CASCADE) | — | 2: idx_tframes_job, idx_tframes_subject |
| `tracking_jobs` | id | project_id→projects(CASCADE); source_asset_id→source_assets(CASCADE); user_id→users(CASCADE) | — | 3: idx_tkjobs_status, idx_tkjobs_user_status, idx_tkjobs_project |
| `tracking_keyframes` | id | config_id→reframe_configurations(CASCADE); job_id→tracking_jobs(SET NULL) | — | 1: idx_tkeyframes_config |
| `transcript_segments` | id | transcript_id→transcripts(CASCADE) | — | 1: idx_tsegments_transcript_id |
| `transcripts` | id | project_id→projects(CASCADE); source_asset_id→source_assets(CASCADE); task_id→processing_tasks(CASCADE) | — | 2: idx_transcripts_task_id, idx_transcripts_project_id |
| `translation_jobs` | id | project_id→projects(CASCADE); user_id→users(CASCADE); version_id→clip_versions(CASCADE) | — | 2: idx_tjobs_user, idx_tjobs_version |
| `upload_sessions` | id | project_id→projects(CASCADE); source_asset_id→source_assets(SET NULL); user_id→users(CASCADE) | — | 3: idx_uploads_expires_at, idx_uploads_project_id, idx_uploads_user_id |
| `usage_ledger` | id | user_id→users(SET NULL) | sqlite_autoindex_usage_ledger_2(idempotency_key) | 2: idx_usage_user_op, idx_usage_user_time |
| `user_preferences` | user_id | user_id→users(CASCADE) | — | 0: — |
| `user_subscriptions` | id | plan_id→plans(NO ACTION); user_id→users(CASCADE) | — | 1: idx_subs_user |
| `user_totp` | user_id | user_id→users(CASCADE) | — | 0: — |
| `users` | id | — (none) | sqlite_autoindex_users_2(email) | 0: — |
| `workspace_invitations` | id | invited_by→users(CASCADE); workspace_id→workspaces(CASCADE) | sqlite_autoindex_workspace_invitations_2(hashed_token) | 2: idx_ws_invites_email, idx_ws_invites_ws |
| `workspace_members` | workspace_id, user_id | user_id→users(CASCADE); workspace_id→workspaces(CASCADE) | — | 1: idx_ws_members_user |
| `workspaces` | id | owner_user_id→users(CASCADE) | — | 1: idx_workspaces_owner |
