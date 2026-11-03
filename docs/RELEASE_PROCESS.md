# CLIPFORGE — Release Process

Phase 13 deliverable (§20). This process is **defined, not yet
exercised**: the project is not under git, has no remote, and no
staging/production host exists. The first real release follows this
document and its record becomes the worked example.

## Release record (required fields)

Every release gets one record (a file under `docs/releases/` once
releases begin, or an issue in the tracker — pick one home and keep
it). A record is complete only when every field is filled; "unknown"
is an acceptable entry, a blank is not.

| Field | Notes for this project |
|---|---|
| Version | `package.json` version (root and server both currently `0.1.0` — bump both together until they are unified). |
| Date | Release date + timezone. |
| Build id | CI run id / artifact names (`frontend-dist-<sha>`, `server-dist-<sha>`); for a manual build, the ZIP/backup filename used (e.g. the `workspace/your_files/clipforge-*.zip` convention). |
| Commit id | **See below — currently not available.** |
| Schema version | `PRAGMA user_version` after deploy (currently **14**); record the before/after pair when a release migrates. |
| Config changes | Any environment variable added/changed for this release (name only, never values). |
| Staging smoke test | Result + date + who ran it (checklist below). |
| Production approval | Who approved, when, via what (GitHub Environment approval once CI exists; until then, the user's explicit word). |
| Rollback outcome | `not needed` / the restored build id + DB action taken. |
| Known limitations | Carried-forward honest notes (e.g. unconfigured providers, stub adapters). |

### Commit ids — the git gap, stated plainly

**The project is not currently under git** (no `.git` in
`~/workspace/CLIPFORGE`). Consequences:

- There is no commit id, no tag, and no diff for any build produced
  to date — including every Phase 1–13 backup ZIP. Those ZIPs
  (filename + date + the file counts recorded at delivery) are the
  only build identity that exists for past work.
- A release record made today must write `commit: none — pre-git
  build, identified by <backup filename + sha256>`. Compute the
  sha256 of the exact ZIP deployed (`sha256sum <file>`) so the build
  is at least content-addressed.
- Before the first production release, initialise git, verify
  `.env`/`server/.env`/`server/data/` are untracked (`.gitignore`
  already covers them), and make the first commit the baseline.
  From then on, commit id + tag (`v<version>`) are mandatory fields.

## Process

1. **Freeze & build.** Stop feature work for the release scope.
   Run the full local/CI gates: both builds, migration-check, the
   11 e2e suites, `npm audit`. Any red gate stops the release.
2. **Deploy to staging** (DEPLOYMENT.md runbook) with the exact
   artifacts that will go to production — never a staging-only build.
3. **Staging smoke tests** (below) on the staging domain, with
   staging-only secrets. Record results in the release record.
4. **Production approval.** Explicit approval against the completed
   record — in CI, the `production` Environment's required
   reviewers; outside CI, the user's explicit go-ahead naming this
   release. No approval, no deploy. There is no auto-deploy.
5. **Pre-deploy backup.** Stop the api service (or use a hot
   `sqlite3 .backup`) and copy the **entire** data volume. Note the
   backup location in the record. A release without a restorable
   backup does not proceed.
6. **Deploy production.** Same artifacts, production secrets from
   the host's secret store. Confirm `/api/health`, schema version,
   and the System Health admin section.
7. **Post-deploy watch.** Re-run the smoke checklist's read-only
   items against production; watch the api container health and the
   first real jobs (upload → export) end to end.
8. **Close the record.** Fill rollback outcome (`not needed` if so)
   and known limitations.

## Staging smoke test checklist

Read/write items run on staging only; production gets the read-only
subset after deploy.

- [ ] `GET /api/health` returns `{"ok":true}` over HTTPS.
- [ ] Sign up → sign in → sign out; session persists on refresh.
- [ ] Email behaviour matches the environment (SMTP delivers, or the
      outbox file appears and the UI says delivery is not configured).
- [ ] Upload a short video; analysis/transcription reaches a terminal
      state (or an honest `CONFIGURATION_ERROR` where a provider is
      intentionally unset).
- [ ] Create a clip, edit captions, run an export; the exported MP4
      plays **with its audio track** and matching A/V durations
      (project standing rule).
- [ ] Publishing Center shows each platform's true state
      (configured / not-configured with the missing variable names).
- [ ] Admin Console → System Health: FFmpeg/FFprobe OPERATIONAL,
      disk reported, unused components labelled NOT_USED.
- [ ] A worker job survives an api restart (restart mid-queue; the
      job completes or is visibly recovered, not lost).

## Rollback

### Code rollback

1. Stop the api service (prevents workers claiming jobs against a
   half-rolled-back state).
2. Redeploy the previous release's artifacts / compose build.
3. Start, verify `/api/health` + smoke read-only items.
4. Record: failed build id, restored build id, timestamps.

### Database rollback / forward-fix

Migrations in `server/src/db.ts` are **forward-only and idempotent**
(they apply on boot, guarded by `PRAGMA user_version`, currently 14).
There are **no down-migrations**. Therefore:

- If the failed release did **not** change `user_version`: code
  rollback alone is sufficient.
- If it **did**: either (a) restore the pre-deploy volume backup
  taken in step 5 — losing any data written since, which must be
  stated in the record — or (b) keep the new schema and ship a
  **forward-fix** release. Never hand-edit the DB or rewind
  `user_version`; the migration code trusts it.
- **Worker compatibility:** workers and schema move together. Never
  run an older binary against a newer schema (job-row shapes are
  read by the binary that wrote them is *not* guaranteed across
  versions), and never run two api processes against one SQLite
  file. During any rollback, exactly one api process exists, started
  only after code and DB are a matched pair.
