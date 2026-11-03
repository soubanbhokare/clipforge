# CLIPFORGE — Known Limitations

> Finalised by the Phase 13 lead, 2026-11-02. Every item below was
> verified against the code, the test evidence, or the recorded
> project history. Nothing here is padded: an item is listed because
> it is true of this deployment today.

## Infrastructure

1. **No PostgreSQL, Redis, BullMQ or Docker in this deployment.** The
   app runs on SQLite (`node:sqlite`, WAL) with DB-backed in-process
   workers and local-disk storage. PostgreSQL/BullMQ/object storage
   are documented production paths in the code comments and
   `server/README.md` — they are not running, are not tested here,
   and the Admin Console labels them `NOT_USED`.
2. **Single-process ceiling.** API + all workers share one Node
   process and one SQLite file; renders default to one at a time
   (`RENDER_CONCURRENCY` 1–4). This is a local/single-machine
   deployment shape, not a scaled production topology.
3. **Local-disk media storage only.** Uploads, previews, renders and
   reports live under `server/data/`; there is no object storage,
   CDN or replication. Backups exist as an operator-run script
   (`server/scripts/backup.mjs`, restore-tested in Phase 13 — see
   BACKUP_RESTORE.md); there is no built-in scheduled/automatic
   backup.

## Providers and integrations

4. **Real-account publishing is untested.** The YouTube/Instagram/
   TikTok adapters are real, official-API implementations, but **no
   provider credentials exist on this machine**, so no real account
   has ever been connected, posted to, or scheduled against. The e2e
   suites exercise the mechanics against a clearly labelled local
   mock provider — that is not platform acceptance. Platform app
   review/audit outcomes (Google verification, Meta App Review,
   TikTok audit incl. its private-only posting restriction) are
   outside this codebase's control.
5. **Real-account analytics is untested for the same reason**, and
   additionally scope-gated: the connect flow does not request
   `yt-analytics.readonly` (YouTube), `instagram_business_manage_insights`
   (Instagram) or `video.list` (TikTok), so those metric families
   report "unavailable" until a reconnect grants them.
6. **Stock search/import, AI media generation and background removal
   are stubs.** Their adapters carry `implemented: false`; setting
   their env vars does not enable them. Only library-based B-roll
   recommendations and FFmpeg enhancement actually work.
7. **Automatic caption translation has no provider configured** and
   fails with `CONFIGURATION_ERROR`. Manual translations work.
8. **Email is outbox-only unless SMTP is configured.** Without SMTP,
   verification/reset/invitation mail is written to
   `server/data/outbox/` and never delivered.
9. **Google sign-in is not configured** (no Google OAuth credentials;
   the control is enabled and explains this honestly when used; no
   sign-in occurs).
10. **Payments are disabled.** Flag-gated foundation + webhook
    verification surface only; no provider adapter is integrated,
    checkout returns `CONFIGURATION_ERROR`, and no charging exists.
11. **URL import works, with platform limits.** Pasting a video
    URL (YouTube, any other yt-dlp-supported site, or a direct
    media link) downloads the video via yt-dlp as the project's
    source (best MP4 ≤ 1080p, capped at `MAX_UPLOAD_MB`), verified
    exactly like an upload. Limits: (a) some platforms — notably
    YouTube — block datacenter/server IPs or demand sign-in for
    *some* videos; those imports fail honestly per video with a
    classified reason (`SIGN_IN_REQUIRED`, `ACCESS_BLOCKED`, …)
    and are never faked or bypassed (no cookies, no logins);
    (b) live-platform downloads are **not verified** from this
    environment — the e2e suites verify real downloads from a
    local fixture through yt-dlp's generic extractor; (c) the
    separate YouTube *validator* still never downloads (metadata
    only, via `YOUTUBE_API_KEY`); (d) cloud *storage* import
    (Drive/Dropbox) remains unconfigured.

## AI / media accuracy — unverified areas

12. **Hindi STT accuracy on real speech is unverified.** The local
    faster-whisper pipeline is real and the default model is `small`,
    but no accuracy claim has been validated against real Hindi
    recordings. (The `base` model is known to misdetect Hindi.)
13. **No speaker diarization.** Transcripts never carry speaker
    labels; `speaker` is stored `NULL`.
14. **Active-speaker accuracy on a real two-person conversation is
    unverified.** The association is evidence-based (Silero VAD +
    YuNet mouth-motion proxies + detection continuity) and labelled
    with confidence, but it has not been validated on real
    conversations.
15. **Person-follow rendering is unverified** as a rendered output
    path (tracking-job boot recovery likewise rests on the shared
    worker pattern rather than a dedicated live test) — verify a
    person-follow render end-to-end before relying on it.
16. **Enhancement is standard FFmpeg filtering, not AI.** Upscaling
    resizes (lanczos) and cannot reconstruct detail; interpolation is
    `minterpolate`. The UI labels it accordingly.

## Feature-level limits

17. **Brand intro/outro/music are stored but NOT composited into
    renders.** Applying a brand kit copies its caption style/template
    into documents; the intro/outro/music assets do not appear in
    exported video in this build.
18. **Split-screen B-roll is not offered** (labelled in the UI).
    Split-screen exists only as a reframe layout in Phase 7.
19. **Caption `lineSpacing` is preview-only** — libass cannot change
    line height, so the value does not affect rendered output.
20. **Deleting all brand kits re-seeds the default** "CLIPFORGE
    Brand" kit — there is no persistent zero-kit state.
21. **Stabilization and upscale are per-asset jobs only** (Phase 8),
    not document-wide render settings.
22. **Publishing ambiguity is handled, not eliminated:** if a network
    failure occurs after a submission may have reached a platform,
    the job is marked ambiguous and recovered from the platform's own
    status — a human may still need to verify on the platform in the
    `FAILED` "verify on the platform" case after a restart mid-upload.
23. **Landing-page media slots are empty by owner instruction.** All
    landing image/video areas are reserved placeholders
    (`src/config/landingAssets.ts`); this is intentional, not a bug.

## Preview / distribution

24. **The Muse-hosted preview artifact has no live backend.** It
    demonstrates the UI; accounts, uploads, jobs, publishing and
    analytics only work against the locally running server
    ([SETUP.md](SETUP.md)).
25. **Test-fixture dependency:** several e2e suites synthesise speech
    with `espeak-ng`. On this VM it is provided by a workspace-contained
    install (`~/workspace/.tools/bin/espeak-ng`); suite runs must prefix
    `PATH` with that directory (see [TROUBLESHOOTING.md](TROUBLESHOOTING.md)).
    `/tmp` here is a 512 MB tmpfs and must be cleared between heavy
    suite batches.

## Phase 13 audit findings (2026-11-02)

26. **"My Clips" page is a placeholder.** `src/pages/ClipsPage.tsx`
    renders a "Not built yet" placeholder even though the clips
    backend is complete and reachable via Project Detail — the
    clearest unfinished integration in the UI.
27. **Cloud *storage* import is UI-only.** The Studio tab is now
    "Import from URL" (URL import itself works — see 11), but
    importing from Google Drive/Dropbox/etc. still has no adapter:
    the backend hard-codes `cloudImportConfigured: false`, the tab
    labels it not configured, and adding keys cannot enable it.
28. **Notifications have no e2e coverage.** Fully implemented
    (endpoints + panel) but zero suite checks exercise them.
29. **Crash recovery fails interrupted renders — deliberately, and
    with two rough edges.** On boot, a render interrupted by a crash
    is marked FAILED with the recorded reason (not silently resumed);
    "Start the render again" completes it, and usage is charged
    exactly once (verified by crash simulation, RUNTIME_VERIFICATION.md).
    Rough edges: the crashed job's processing directory is not swept
    at boot (it is cleaned when the job is retried), and an orphaned
    FFmpeg child can briefly outlive a hard kill.
30. **Media validation whitelists containers, not codecs.** An MP4
    containing MPEG-4 Part 2 video is accepted as valid; only the
    first audio stream's codec is recorded in asset metadata (extra
    audio streams are not described).
31. **Plan limits are not enforced.** Entitlement limits are seeded
    NULL and are reported in usage views but never gate work; there
    is no storage quota (a 500 MB per-file cap only), and CPU time /
    bandwidth are not metered in the usage ledger (COST_MANAGEMENT.md).
32. **Observability stops at the admin console.** No alerting, no
    structured logging, no request/correlation IDs, no metrics or
    error tracking; beyond the public `{ok:true}` liveness endpoint,
    health is only visible when an admin opens the console
    (OBSERVABILITY.md).
33. **Accessibility gaps remain** (static WCAG 2.2 AA audit,
    ACCESSIBILITY.md): no skip link anywhere; timeline editing is
    pointer-first (the keyboard alternative is the numeric fields in
    the inspector/caption studio); the shared modal has no focus
    trap/restoration; some routes render two `<h1>` elements.
34. **Only Chromium is verified.** Firefox, Safari, Edge, iOS and
    physical devices have never run this app in testing
    (COMPATIBILITY.md) — no cross-browser support is claimed.
35. **Legal documents do not exist yet.** The landing footer's
    Privacy/Terms are explicit placeholders, yet signup enforces a
    `termsAccepted` checkbox against that unpublished text. Reviewed
    privacy policy / terms must be published before any public
    launch; all required documents are listed in PRIVACY_LEGAL.md,
    each marked as requiring professional legal review.
36. **Deployment is prepared, not executed.** Dockerfile/compose are
    statically reviewed only (no Docker on this machine); the ARM64
    build for the free target (Oracle A1) is unverified; the project
    is not under git, so there are no commit ids and the CI workflow
    has never run (DEPLOYMENT.md, CI_CD.md).
37. **The online dependency audit could not be executed from here.**
    `npm audit`'s endpoint is blocked by this machine's network
    policy; advisories were cross-checked manually against
    GHSA/NVD instead (0 critical/high in production; two moderate
    dev-only findings in vite 5 / esbuild remain). Re-run
    `npm audit` from an unrestricted network before production
    (DEPENDENCY_AUDIT.md). `exceljs` is unmaintained upstream.
38. **The shipped dev database is a stale, empty pre-migration
    file** (`user_version = 0`, 7 tables, 0 rows). The first real
    boot migrates it v1→v14 in one pass; nothing is at risk today
    (it is empty), but a backup before any first production boot is
    a hard rule (DATABASE_AUDIT.md R1).
39. **Registration discloses account existence** (a duplicate email
    returns a distinct 409). Accepted as a Low risk for usability;
    login and recovery stay generic (SECURITY_AUDIT.md F-04).
40. **Email verification is off by default**
    (`REQUIRE_EMAIL_VERIFICATION=false`, so registration opens a
    session immediately). Production should enable it; the server
    now warns loudly at boot in production when it is off
    (SECURITY_AUDIT.md F-05).
