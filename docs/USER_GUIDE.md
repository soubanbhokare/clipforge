# CLIPFORGE — User Guide

For people using the app, not running the server. Steps describe the
real product behaviour. Where a step needs provider configuration,
that is stated at the step — the app itself also says so on screen
instead of pretending to work.

> Running locally? The app only works with the backend server running
> (see [SETUP.md](SETUP.md)). The hosted preview copy has no live
> backend, so account and processing features cannot complete there.

## 1. Account

1. **Sign up** with your name, email and a password (10+ characters,
   with upper-case, lower-case and a number). You are signed in
   immediately.
2. **Verify your email.** A verification link is emailed to you.
   *Honest note:* if the deployment has no SMTP configured, that email
   is **not delivered** — it sits in the server's outbox and the
   screen tells you email is not configured. Ask whoever runs the
   server, or (locally) read the link from `server/data/outbox/`.
   Unless the server requires verification, you can keep working
   while unverified.
3. **Sign in / sign out** from the auth pages. "Remember me" extends
   the session from 12 hours to 30 days.
4. **Forgot password** always shows the same message whether or not
   the account exists (by design, so the form can't be used to probe
   for accounts). Reset links expire after 30 minutes and work once.
5. **Google sign-in is not configured** in this deployment — the
   button is shown disabled and labelled, on purpose.
6. **Guest mode** lets you look around the UI without an account. It
   grants nothing on the server: uploads, analysis and everything
   account-backed still require signing in.

## 2. Workspaces

- Every account gets a personal workspace. **Settings → Workspace**
  (or the workspace switcher) lets you create more, switch the active
  one, set a default, upload a logo, and archive/delete workspaces.
- **Roles:** Owner, Admin, Editor, Viewer. Viewers can look but
  cannot change projects or brand kits — the server refuses, not just
  the button.
- **Inviting people:** Workspace → Members → Invite by email. The
  invitee accepts from their own account (Invitations / the accept
  link). Invitation emails follow the same delivery rule as §1: no
  SMTP ⇒ outbox only, and the UI says the email was not delivered.
- Projects and brand kits belong to the workspace that was active
  when they were created.

## 3. Upload a video (Studio)

1. Go to **Studio** → choose **Create Multiple Shorts** (long video →
   shorts) or **Enhance Existing Video**, name the project, create it.
2. **Upload your own file** (`.mp4`, `.mov` or `.webm`; default limit
   500 MB). The upload is verified with FFprobe — a file with no real
   video stream is rejected as corrupted, with the reason shown.
3. A **YouTube link** can be pasted for validation/metadata. The
   validator itself never downloads — but from the validated link
   (or the **Import from URL** tab, which accepts any video page
   URL or a direct media link) you can import the video itself:
   the server downloads it with yt-dlp, verifies it like an
   upload, and it becomes the project's source for clip detection,
   captions and editing. Some sites block server IPs or require
   sign-in for some videos — those imports fail with the reason
   shown, never silently. Only import videos you own or are
   authorized to process.
4. Cloud *storage* import (Drive/Dropbox) is shown as **not
   configured** — it is not available in this deployment.
5. Your source's real metadata (duration, resolution, codecs, whether
   it has audio) and a real extracted thumbnail appear on the project.

## 4. Find clips (AI clip detection)

1. On the project, start **Analysis**. The job runs on the server
   through visible stages (validating → extracting audio →
   transcribing → analyzing → detecting → ranking → previews). You
   can leave the page — job status is stored, and cancelling/retrying
   works from the same screen.
2. Transcription is done by a **local Whisper model** on the server
   by default. There are **no speaker labels** — the transcript says
   speaker identification is unavailable, because the provider does
   not diarize.
3. A video with no detectable speech finishes honestly with
   **"no speech"** and zero clips — nothing is invented.
4. **Candidates** are ranked 0–100 from measurable signals, each with
   its reasons shown. Titles are suggested from the candidate's own
   first sentence; you can rename them. Use the checkboxes to
   **select/deselect**, or remove candidates you don't want. (An
   optional instruction when starting analysis can boost candidates
   that genuinely match keywords/intents in the transcript.)
5. Each candidate has a **real preview cut** (original audio
   preserved) once its preview is verified ready.

## 5. Edit (Editor)

1. Open a candidate/project in the **Editor**: a multi-track timeline
   (main, B-roll, caption, audio, overlay tracks) with a preview
   canvas and inspector.
2. Trim, split, reorder, adjust speed/volume/fades — every operation
   supports **undo/redo**, and you can save **named versions** and
   restore them.
3. Add **project media** (extra audio/video) from the media panel.
4. **Face Lock / reframing:** run a **tracking job** on the project,
   then in the Reframe panel pick a mode (e.g. smart-auto), aspect
   (9:16 etc.), fit and subject. Subjects are anonymous faces/people
   in *this* video ("face-1", …) — the system never identifies who
   someone is. Computed crop keyframes follow the subject; your own
   manual keyframes are never overwritten. Per-scene overrides and
   split-screen layouts are available here. *Note:* active-speaker
   choices are evidence-based estimates (speech activity + mouth
   movement proxies); accuracy on real two-person conversations is
   unverified — check the preview before exporting.
5. **B-roll:** open the B-roll panel to get recommendations matched
   from **your own media library** against the transcript. Nothing is
   inserted until you press **Accept** (accepted B-roll starts
   muted). Stock search, AI generation and background removal are
   shown as **not configured** in this deployment — they need a
   provider the server does not have. Split-screen B-roll is not
   offered.
6. **Enhancement:** standard FFmpeg processing (denoise, sharpen,
   colour/audio cleanup, upscale-by-resize, frame interpolation) with
   a before/after preview. It is labelled as standard processing,
   not "AI enhancement", and upscaling cannot invent detail.
7. **Render** from the editor for a quick file, or use Export Studio
   (§7) for full control.

## 6. Captions + brand kit

1. In the editor's **Captions Studio**, captions come from the
   transcript. Edit text and timings, restyle (font, size, colours,
   outline, position, animation), and preview.
2. **Templates:** 10 built-in presets plus your own saved templates.
   *Known quirk:* the **line-spacing** control affects the preview
   only — the renderer (libass) cannot change line height in the
   exported file.
3. **Multiple tracks:** keep the original-language track, add manual
   tracks, or import/export subtitle files (SRT/VTT/ASS). Overlapping
   captions can be stored; the **export preflight** is what flags a
   timing problem before a render.
4. **Automatic translation is not configured** in this deployment —
   starting a translation job fails with a clear configuration error.
   Typing or uploading your own translation always works.
5. **Brand kits** (Templates & Brand Kit): colours, font, caption
   style/template, logo, intro, outro, music and overlay assets. A
   seeded "CLIPFORGE Brand" kit exists. **Applying** a kit copies its
   caption style into the document — later kit edits don't rewrite
   existing documents. *Known limit:* intro/outro/music are stored on
   the kit but are **not composited into renders** in this build.

## 7. Export (Export Studio)

1. Choose a target (editor document, a saved version, or a candidate
   clip), a preset (including platform presets) or custom settings:
   MP4/WebM, H.264/H.265/VP9, resolution/aspect, AAC/Opus audio, or
   MP3 audio-only.
2. **Preflight** runs first and lists real problems (including
   caption-timing and B-roll media checks) — fix those before the
   encode starts rather than after.
3. Jobs join the **render queue**: watch real progress, change
   priority, pause (queued jobs only), cancel, retry, or "start now"
   a paused job.
4. A finished export has passed an **FFprobe quality gate**; download
   it from the job or from **History** — which also honestly lists
   failed exports with their reasons. Several finished outputs can be
   downloaded together as a **ZIP bundle**.

## 8. Publishing

*Needs provider configuration:* a platform can only be connected
after whoever runs the server has registered a developer app for it
(see [PROVIDERS.md](PROVIDERS.md)). Until then each platform shows
**"not configured"** naming the missing server variables, Connect is
disabled, and nothing can be posted. There are no simulated accounts
or posts.

1. **Publishing → Accounts → Connect** takes you to the platform's
   own OAuth page; tokens are stored encrypted on the server and
   never shown to you or the browser.
2. Create a publishing job from a **completed export**, choose the
   account, and fill in that platform's metadata (title, description,
   privacy, …). YouTube jobs can add a custom thumbnail.
3. **Validate** checks the job against the platform's *live* limits.
   A failed validation stays in Draft and cannot be submitted.
4. **Approve** — you must confirm you have the rights to publish.
   Editing metadata after approval sends the job back to Draft on
   purpose: re-validate, re-approve.
5. **Publish now**, or **schedule**: YouTube + private posts use
   YouTube's own scheduling; everything else is scheduled inside
   CLIPFORGE — the screen labels which one you got. Manage scheduled
   posts in the **Calendar**, watch progress in the **Queue**, and
   review outcomes (including failures and retries) in **History**.
   A post only reads **Published** when the platform itself confirmed
   it.

## 9. Analytics

*Same configuration dependency as Publishing:* analytics reads through
your connected platform accounts. With no accounts connected you get
honest empty states, not sample charts.

1. **Sync** an account to pull performance snapshots. Syncs run in
   the background with a visible state history; you can set an
   automatic frequency in Analytics settings (off / 6 h / daily /
   weekly).
2. **Overview / Trends / Platform comparison:** platforms are shown
   side by side and never merged into one fake total; views and reach
   are never added together.
3. **"Unavailable" means unavailable.** If a platform cannot provide
   a metric — or the scope for it wasn't granted when you connected
   (YouTube Analytics scope, Instagram insights scope, TikTok
   `video.list`) — the value shows as Unavailable **with the reason**,
   never as 0. Reconnecting with the scope granted is the fix.
4. **Engagement rate** is always shown with its formula,
   (likes + comments + shares [+ saves where exposed]) ÷ reach or
   ÷ views; if a component is missing the rate is N/A with the
   reason, not 0%.
5. **Posts** shows per-post performance with full snapshot history;
   **Top Content**, **Content Analysis** and **Posting Times** work
   from the same saved data (Posting Times needs at least 10
   published posts before it says anything).
6. **Insights** are deterministic rules over your stored data — each
   carries its evidence, sample size and limitations. Nothing
   predicts virality, and no external AI writes them.
7. **Reports:** build CSV/XLSX/PDF reports from saved records in the
   background; every report includes the metric definitions and
   last-sync times so a reader can audit the numbers.

## 10. Settings

**Settings** tabs cover, in order: **Profile** (name, avatar,
verified email-change flow), **Security** (password change, TOTP
setup/disable with recovery codes, login activity), **Sessions**
(every signed-in device; revoke one or all others), **Connected
accounts**, **Notifications** (in-app centre + preferences;
notifications come only from real events), **Preferences** (language,
timezone, formats, default aspect/resolution/caption language/
template/brand kit/workspace — all stored on the server, not in the
browser), **Workspace**, **Usage & plan** (your plan and the usage
ledger; plan prices are set by an admin and may show as "not set";
checkout is disabled in this deployment), **Privacy** (download a
full data export; request account deletion — deletion closes the
account immediately and runs as a background job), and **Support**.

## 11. Support

**Settings → Support** (or the support section in your account area):
open a ticket, follow the thread, and reply in-app. Tickets are
answered by an admin in the Admin Console — there is no email-based
support flow in this deployment, so check back in-app for replies.
