# CLIPFORGE — CI/CD Pipeline

Phase 13 deliverable (§13). Pipeline definition:
`.github/workflows/ci.yml`.

**Status: prepared, not executed.** The project is not currently
under git and has no GitHub remote, so this workflow has never run.
It activates when the repository is first pushed to GitHub. Nothing
in this document claims a green pipeline run.

## Pipeline shape

```text
push / PR ──┬─ build            typecheck + production builds (frontend & server)
            ├─ audit            npm audit (both packages)
            └─ (needs build) ─┬─ migration-check   fresh-DB boot + schema validation
                              └─ e2e               11 server suites, sequential

workflow_dispatch (manual only)
            ├─ deploy-staging      needs ALL gates; GitHub Environment: staging
            └─ deploy-production   needs ALL gates; GitHub Environment: production
```

### Jobs

| Job | What it does | Gate |
|---|---|---|
| `build` | `npm ci` + `npm run build` at root (`tsc -b && vite build`) and in `server/` (`tsc`). Uploads `frontend-dist-<sha>` and `server-dist-<sha>` deployment artifacts. | Type errors or a failed build fail the pipeline. |
| `migration-check` | Boots the compiled server against a throwaway `DATABASE_FILE`, waits for `/api/health`, then asserts `PRAGMA user_version = 14` and a clean `PRAGMA foreign_key_check`. | A migration that doesn't apply cleanly from scratch fails here, before e2e. |
| `audit` | `npm audit --audit-level=high` for root and server. | High/critical advisories fail the pipeline. |
| `e2e` | Installs FFmpeg + the Python stack (faster-whisper, onnxruntime, opencv) and runs the 11 suites sequentially: auth, studio, clips, editor, captions, tracking, broll, export, publish, analytics, account. Scratch is cleared between suites (the media suites write large files to `/tmp`). | Any failing suite fails the pipeline. Suites use local mock providers + the file outbox — no real credentials are needed or permitted. |
| `deploy-staging` | **Placeholder.** Manual (`workflow_dispatch` with `deploy_target=staging`) + `environment: staging`. | Requires all gates green. Real steps get wired when a staging host exists (DEPLOYMENT.md). |
| `deploy-production` | **Placeholder.** Manual only + `environment: production`. **There is no automatic production deployment on any trigger.** | Requires all gates green AND the Environment's required reviewers. |

### Missing tooling — stated honestly

There is **no lint or format gate** because the project has none:
neither `package.json` defines `lint`/`format` scripts, and no
ESLint/Prettier config exists anywhere in the repo. TypeScript's
`strict` mode (both tsconfigs) is the only static gate today.
Follow-up (lead decision): adopt ESLint + Prettier, add the scripts,
then add one step to the `build` job — the workflow has a natural
place for it, it is not silently omitted.

Also absent today, by the same honesty rule: coverage thresholds,
container image build/scan (the Dockerfile cannot be built on the
dev machine — add a `docker build` job once the repo is on GitHub;
GitHub runners have Docker), and SBOM generation.

### Environment protection (must be configured outside the workflow)

The workflow references GitHub **Environments** named `staging` and
`production`, but required-reviewer rules live in repository
Settings → Environments — the YAML cannot create them. Before the
deploy jobs mean anything, a repo admin must:

1. Create the `production` environment with **required reviewers**
   (and, optionally, a wait timer).
2. Create the `staging` environment (reviewers optional).
3. Put any deploy credentials in **Environment secrets**, never in
   repository secrets shared with PR builds. (Today there are no
   deploy credentials at all.)

## Rollback

- **Code:** redeploy the previous release's artifacts
  (`frontend-dist-<sha>` / `server-dist-<sha>` are retained per run)
  or `docker compose up -d` with the previous image/build. Record
  both the failed and restored build ids in the release record.
- **Database:** migrations are **forward-only** (see
  RELEASE_PROCESS.md). A code rollback is safe only while the schema
  version is unchanged; if the failed release migrated the DB, the
  rollback is: restore the pre-release volume backup, or ship a
  forward-fix migration — never hand-edit `user_version`.
- **Workers:** job rows are versioned by the schema, not the worker
  binary; an older worker must not be pointed at a newer schema.
  If in doubt, stop the api service during rollback so no worker
  claims jobs mid-restore, then start it once the DB and code match.
