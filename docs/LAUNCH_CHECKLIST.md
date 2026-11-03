# CLIPFORGE — Launch Checklist (Phase 13, §25)

> **DRAFT — from the §25 acceptance criteria. The Phase 13 lead
> finalises this file and records the sign-off.**
>
> **How to use this checklist:** tick an item **only** when the
> evidence named in it exists and has been looked at (a test run
> output, a probe result, a screenshot of a real state, a document).
> "It builds" is evidence for exactly one item below and nothing
> else. Leave an item unticked and note why rather than ticking on
> intention.

## A. Build and automated verification

- [ ] Frontend production build passes (`npm run build`: tsc + vite)
      — *evidence: build output from the final tree.*
- [ ] Server production build passes (`server: npm run build`) —
      *evidence: build output from the final tree.*
- [ ] All e2e suites pass on the final tree (auth, studio, clips,
      editor, captions, tracking, broll, export, publish, analytics,
      account) — *evidence: each suite's pass counts; any suite not
      run is listed here by name with the reason.*
- [ ] Database reports `PRAGMA user_version = 14` on a migrated
      existing database **and** on a fresh first boot —
      *evidence: both query results.*
- [ ] Hygiene checks pass: zero `localStorage` usages in `src/`;
      approved logo gradient/artwork present in the shipped assets;
      no secrets or real `.env` values in the tree —
      *evidence: grep/command output.*

## B. Core workflows, exercised end-to-end by a human

- [ ] Register → verify (or outbox, honestly reported) → sign in →
      MFA enable → sign out → MFA sign-in — *evidence: run log.*
- [ ] Create workspace → invite → accept from a second account →
      Viewer-role mutation is refused server-side — *evidence: run log.*
- [ ] Upload a real video → probe metadata correct → analysis →
      transcript present → candidates ranked with reasons → preview
      cuts play with source audio — *evidence: project + job ids.*
- [ ] Edit a candidate (trim/split/captions) → undo/redo → save and
      restore a named version — *evidence: run log.*
- [ ] Tracking job on a real clip → reframe preview matches the
      persisted keyframes → reframe render downloads and matches the
      preview framing — *evidence: FFprobe + visual check of output.*
- [ ] Export (MP4 + one platform preset) → preflight shown → QC gate
      passed → file downloads and probes correctly (streams,
      duration, dimensions) — *evidence: FFprobe output of the file.*
- [ ] Data export downloads a complete ZIP; account-deletion request
      blocks sign-in immediately and the job completes —
      *evidence: run log with a throwaway account.*

## C. Honesty surfaces (the product must not overclaim)

- [ ] With no SMTP: verification/reset/invitation flows visibly state
      email is not configured, and outbox files are the only copies —
      *evidence: screen + outbox listing.*
- [ ] With no platform credentials: Publishing shows each platform
      "not configured" naming the missing variables, Connect disabled,
      connect API returns 422 — *evidence: API response + screen.*
- [ ] Analytics with a scope-limited account shows the affected
      metrics as Unavailable **with the scope named**, never 0 —
      *evidence: capability + overview responses (mock or real).*
- [ ] Stock / AI generation / background removal show
      `implemented: false` status and fail with `CONFIGURATION_ERROR`
      even with env vars set — *evidence: `/api/phase8/status`.*
- [ ] Checkout returns `CONFIGURATION_ERROR`; seeded plans show
      prices as "not set" — *evidence: API response + Plans screen.*
- [ ] Landing page contains zero `<img>`/`<video>`/external media —
      every slot is a `MediaPlaceholder` — *evidence: source grep.*
- [ ] Admin System Health labels PostgreSQL/Redis/BullMQ/object
      storage `NOT_USED`, and FFmpeg `OPERATIONAL` from a real
      execution — *evidence: health response.*

## D. Documentation set (§23)

- [ ] `README.md` describes Phases 1–12 truthfully with the honest
      status table — *evidence: this file set, read against the code.*
- [ ] `docs/ARCHITECTURE.md`, `SETUP.md`, `PROVIDERS.md`, `API.md`
      verified against the actual code (module map, env vars, route
      surface) — *evidence: reviewer pass recorded by the lead.*
- [ ] `docs/USER_GUIDE.md` + `ADMIN_GUIDE.md` walkthroughs match the
      shipped UI — *evidence: walkthrough run.*
- [ ] `docs/TROUBLESHOOTING.md` covers the known operational traps
      (espeak-ng overlay, `/tmp` tmpfs, outbox, ports, DB locking,
      Hindi STT note) — *evidence: file read.*
- [ ] `docs/KNOWN_LIMITATIONS.md` finalised by the lead — every
      credential-gated and unverified item still listed, nothing
      silently dropped — *evidence: finalised file.*

## E. Production-readiness gaps (must be closed or explicitly accepted)

- [ ] SMTP configured and a real verification email delivered to a
      real inbox — *evidence: delivered message.* (Otherwise the
      launch is local-only by definition.)
- [ ] `TOKEN_ENCRYPTION_KEY` set from the environment (not the dev
      key file) — *evidence: server config status, value not shown.*
- [ ] `NODE_ENV=production` behaviour verified (Secure cookies, no
      dev CORS) — *evidence: response headers.*
- [ ] Platform developer apps registered + approved and a **real**
      post published and a **real** analytics sync completed per
      platform claimed at launch — *evidence: platform post URLs +
      sync job records.* (Without this, publishing/analytics must be
      launched as "pending credentials", not as working features.)
- [ ] Data directory backed up / a restore has been rehearsed —
      *evidence: restore log.*
- [ ] Decision recorded for the documented production path
      (PostgreSQL/object storage) — either migrated and re-verified,
      or explicitly accepted as a post-launch item —
      *evidence: decision note.*

## Sign-off — readiness classification

Tick **exactly one**, based only on the ticked evidence above. A
classification may never be awarded on build success alone.

- [ ] **READY FOR PRODUCTION** — every section A–E item ticked with
      evidence, including real-platform acceptance (E).
- [ ] **READY WITH LIMITATIONS** — A–D ticked; the unticked E items
      are named here and are honestly described to users in-product
      and in `KNOWN_LIMITATIONS.md`:
      _Limitations accepted: ______________________________
- [ ] **READY FOR LOCAL / DEMO USE ONLY** — A–C ticked on the local
      stack; external delivery (SMTP) and/or real-platform items in E
      remain open, and the deployment is presented only as a local /
      demo system.
- [ ] **NOT READY** — any A–C item unticked. Blocking items:
      _Blockers: ______________________________

Signed off by: ______________  Date: ______________
