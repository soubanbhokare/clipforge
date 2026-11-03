# CLIPFORGE — Troubleshooting

Symptom → cause → fix, for behaviours that are actually known in this
codebase and on this machine. General rule first: the app is designed
to fail **honestly** — a `CONFIGURATION_ERROR`, an "Unavailable" or a
"not configured" label usually means the system is correctly reporting
a missing prerequisite, not that it is broken.

## Speech-fixture tests fail / `espeak-ng: command not found`

- **Symptom:** e2e suites that synthesise speech (clips, captions,
  editor, tracking, broll, export) fail while "Generating speech
  fixtures", or error with `espeak-ng` not found.
- **Cause:** those suites build their test videos with `espeak-ng` +
  FFmpeg. On this VM, `espeak-ng` was installed via apt onto an
  **ephemeral overlay** — it disappears when the VM restarts/replaced.
  The application itself does not use espeak-ng; only the test
  fixtures do.
- **Fix:** reinstall it, then re-run the suite:
  `sudo apt-get update && sudo apt-get install -y espeak-ng`, verify
  with `espeak-ng --version`.

## Heavy test runs fail partway / disk or temp errors mid-suite

- **Symptom:** a suite (notably export, 165 checks) fails late with
  temp-file/space errors after earlier suites passed, or results
  differ between runs on a full scratch area.
- **Cause:** on this machine `/tmp` is a **512 MB tmpfs**. Heavy
  suites write fixtures and scratch under `/tmp/clipforge-*`, and a
  full tmpfs fails jobs that would otherwise pass.
- **Fix:** between heavy suite batches, stop any running suite and
  clear the scratch: `rm -rf /tmp/clipforge-*`, check headroom with
  `df -h /tmp`, then re-run the affected suite alone before concluding
  anything is broken.

## `CONFIGURATION_ERROR` — what it means, per provider

A `422 CONFIGURATION_ERROR` (or a job dying in a `CONFIGURATION`
stage) always names what is missing. It is never a bug report by
itself.

| Where you see it | Cause | Fix |
| --- | --- | --- |
| Publishing → Connect / submit (YouTube, Instagram, TikTok) | That platform's OAuth env vars are unset (the response/UI names them). | Register the developer app and set the variables in [PROVIDERS.md](PROVIDERS.md#oauth-providers--publishing--analytics). |
| Analysis job fails at transcription | Selected STT provider unusable: local provider can't import `faster_whisper` in `PYTHON_BIN`, or the OpenAI-compatible provider has no key. | Install the Python packages for the server's interpreter, or set `STT_PROVIDER`/`OPENAI_API_KEY` correctly. Check `GET /api/analysis/config`. |
| Translation job | No translation provider is configured in this environment — expected. | None available in this build's environment; use manual translations. (Setting `TRANSLATION_PROVIDER` + `TRANSLATION_API_KEY` + `TRANSLATION_API_BASE` is the intended configuration surface.) |
| Stock search / import, AI generation, background removal | The adapters are **stubs** (`implemented: false`) — not merely unconfigured. | No env fix exists; the adapter must be implemented. Use library B-roll + FFmpeg enhancement meanwhile. |
| Tracking job | YuNet model file or OpenCV missing. | Ensure `server/models/face_detection_yunet_2023mar.onnx` exists and `cv2`/`onnxruntime` import in the server's Python. Check `GET /api/tracking/status`. |
| Checkout | Payments are flag-disabled and no adapter is integrated. | Expected in this deployment; do not "fix" by inventing a provider. |
| YouTube URL validator reports metadata unavailable | `YOUTUBE_API_KEY` unset (metadata lookup only). | Optionally set the key. Uploading your own file works regardless. |

## Verification / reset / invitation email never arrives

- **Symptom:** "Check your email" but nothing in the inbox.
- **Cause:** with `SMTP_HOST` unset the server uses the **outbox
  adapter**: the message is a JSON file under `server/data/outbox/`,
  deliberately **not delivered**. The UI and `GET /api/auth/config`
  (`emailConfigured: false`) say this.
- **Fix:** for local use, open the newest file in
  `server/data/outbox/` and use its link/token. For real delivery,
  set `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/`SMTP_FROM` in
  `server/.env` and restart.

## Port already in use (`EADDRINUSE` on 3001 or 5173)

- **Symptom:** `npm run dev` exits saying the port is taken.
- **Cause:** an earlier dev server is still running (common after a
  backgrounded run).
- **Fix:** find and stop it — `ss -ltnp | grep -E '3001|5173'` (or
  `lsof -i :3001`), kill that PID, restart. To run a second instance
  instead, set `PORT` in `server/.env` **and** update the Vite proxy
  target in `vite.config.ts` to match — the frontend proxy is fixed
  to `http://localhost:3001` in code.

## Database is locked / `SQLITE_BUSY` expectations

- **Symptom:** occasional `database is locked` errors under load.
- **What is normal:** the DB is a single SQLite file in **WAL mode**
  (`node:sqlite`), written by one Node process that also runs all
  workers. Brief lock contention is retried by the runtime pattern;
  jobs are claimed with conditional UPDATEs precisely so two workers
  ticks cannot take the same job.
- **When it is not normal:** a *second* server process pointed at the
  same `DATABASE_FILE`, or an external tool holding a write
  transaction open. **Fix:** run exactly one server per database
  file; don't open the live DB for writes in a GUI/CLI while the
  server runs. For a separate instance, give it its own
  `DATABASE_FILE` and data directories.

## Hindi (or other language) transcripts look wrong

- **Symptom:** Hindi speech transcribed poorly or detected as another
  language.
- **Status:** **Hindi STT accuracy on real speech is unverified** —
  this is a known limitation, not a diagnosed bug in your setup. What
  is known from the code/config: the default model is `small` (the
  `base` model misdetects Hindi and is explicitly not recommended),
  and the project's language setting is passed to Whisper as a hint —
  set the project language to Hindi rather than auto-detect when the
  source is Hindi.
- **Fix options:** set the language hint; try a larger `WHISPER_MODEL`
  if the machine can bear it; or select the OpenAI-compatible provider
  (`STT_PROVIDER=openai-compatible` + key) and compare on the same
  clip. Do not present either result as verified accuracy.

## Analytics numbers show "Unavailable" after connecting an account

- **Cause:** capability detection runs from the **granted scopes**:
  YouTube Analytics metrics need `yt-analytics.readonly` (not in the
  connect flow), Instagram insights need
  `instagram_business_manage_insights` (deliberately not requested),
  TikTok post metrics need `video.list` (not requested). The value is
  stored as `NULL` + reason — by design, never as 0.
- **Fix:** reconnect the account granting the named scope (requires
  the provider code/config to request it). Followers/profile counters
  sync without those scopes. See [PROVIDERS.md](PROVIDERS.md).

## A job looks stuck in a running state after a server restart

- **Cause/fix by design:** workers reconcile on boot — analysis jobs
  left mid-flight become `FAILED` ("interrupted by server restart",
  retry them); publishing `UPLOADING` jobs are recovered from the
  platform, never blindly re-sent; analytics syncs re-run safely. If
  a job still shows running **while the server is up**, check the
  Admin Console → Jobs view and the server console log for that job's
  stage before restarting anything.

## Frontend loads but every API call 401s / CSRF 403s

- **401 everywhere:** the backend is not running, or you are opening
  the hosted preview (which has **no live backend**). Start the server
  (SETUP §4) and use `http://localhost:5173`.
- **403 "CSRF token missing or invalid":** the page was loaded against
  a different origin/server than the API (cookie mismatch). Reload
  through the Vite dev origin so `GET /api/auth/csrf` sets the cookie
  for the same origin, and don't mix `localhost` and `127.0.0.1`
  tabs — they are different origins for cookies.

## Uploads fail verification on a "good" video

- The file must be `.mp4`, `.mov` or `.webm`, within `MAX_UPLOAD_MB`
  (default 500), and FFprobe must find a real video stream. A renamed
  non-video, an audio-only file, or a truncated download is marked
  `FAILED` with the reason and the binary deleted — re-export the
  source properly rather than renaming extensions.
