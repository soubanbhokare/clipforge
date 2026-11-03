// CLIPFORGE Phase 3 — Studio / projects / uploads end-to-end tests.
//
// Boots the real server on PORT=3102 with a temp SQLite DB, a temp
// media directory and MAX_UPLOAD_MB=2, generates REAL video fixtures
// with ffmpeg, and exercises the HTTP API the way the frontend does
// (cookie jar + CSRF header + multipart uploads). Ground truth for
// metadata comes from ffprobe run against the fixtures themselves.
//
// Run: npm run test:studio   (from the server/ directory)

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3102;
const BASE = `http://localhost:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-studio-e2e-"));
const dbFile = path.join(tmpDir, "test.db");
const mediaDir = path.join(tmpDir, "media");
const fixturesDir = path.join(tmpDir, "fixtures");
fs.mkdirSync(fixturesDir, { recursive: true });
fs.mkdirSync(mediaDir, { recursive: true });

const EMAIL_A = "studio-a@example.com";
const EMAIL_B = "studio-b@example.com";
const PASSWORD = "Str0ngPassw0rd";
const YT_ID = "dQw4w9WgXcQ";

let passed = 0;
let failed = 0;
function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---- fixtures (real videos, generated with ffmpeg) ----------------------
function ffmpeg(args) {
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "pipe" });
}
const validMp4 = path.join(fixturesDir, "valid.mp4");
ffmpeg([
  "-f", "lavfi", "-i", "testsrc2=duration=3:size=320x240:rate=30",
  "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", validMp4,
]);
const noAudioMp4 = path.join(fixturesDir, "noaudio.mp4");
ffmpeg([
  "-f", "lavfi", "-i", "testsrc2=duration=2:size=320x240:rate=30",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", noAudioMp4,
]);
const validWebm = path.join(fixturesDir, "valid.webm");
ffmpeg([
  "-f", "lavfi", "-i", "testsrc2=duration=2:size=320x240:rate=30",
  "-f", "lavfi", "-i", "sine=frequency=330:duration=2",
  "-c:v", "libvpx", "-b:v", "200k", "-c:a", "libvorbis", "-shortest", validWebm,
]);
const corruptMp4 = path.join(fixturesDir, "corrupt.mp4");
fs.writeFileSync(corruptMp4, "this is not a video file at all, just text bytes");
const pageHtml = path.join(fixturesDir, "page.html");
fs.writeFileSync(pageHtml, "<html><head><title>Not a video</title></head><body>no media here</body></html>");

// URL-import fixture server: serves the fixture files over loopback
// HTTP so yt-dlp downloads them through its REAL generic-extractor
// path (no mocks). The server under test may only reach it because
// the suite boots with URL_IMPORT_ALLOW_PRIVATE=1 (see startServer
// calls in main) — production keeps loopback blocked.
const fixtureServer = http.createServer((req, res) => {
  const name = decodeURIComponent((req.url ?? "/").split("/").pop() ?? "");
  const file = path.join(fixturesDir, name);
  if (!name || !file.startsWith(fixturesDir) || !fs.existsSync(file)) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type": name.endsWith(".html") ? "text/html" : "application/octet-stream",
    "Content-Length": fs.statSync(file).size,
  });
  fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => fixtureServer.listen(0, "127.0.0.1", resolve));
const fixtureBase = `http://127.0.0.1:${fixtureServer.address().port}`;
const bigMp4 = path.join(fixturesDir, "big.mp4");
fs.copyFileSync(validMp4, bigMp4);
fs.appendFileSync(bigMp4, Buffer.alloc(3 * 1024 * 1024));

function probeGroundTruth(file) {
  const out = execFileSync(
    "ffprobe",
    ["-v", "error", "-show_format", "-show_streams", "-of", "json", file],
    { encoding: "utf8" },
  );
  const data = JSON.parse(out);
  const video = data.streams.find((s) => s.codec_type === "video");
  const audio = data.streams.find((s) => s.codec_type === "audio");
  return {
    duration: Number(data.format.duration),
    width: video.width,
    height: video.height,
    videoCodec: video.codec_name,
    hasAudio: Boolean(audio),
  };
}
const truth = probeGroundTruth(validMp4);

// ---- http helpers ---------------------------------------------------------
class Jar {
  constructor() {
    this.cookies = new Map();
  }
  absorb(res) {
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const line of set) {
      const [pair] = line.split(";");
      const idx = pair.indexOf("=");
      if (idx > 0) this.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }
  header() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  get(name) {
    return this.cookies.get(name);
  }
}

async function call(jar, method, urlPath, { body, csrf, headers: extra } = {}) {
  const headers = { ...(extra ?? {}) };
  if (jar && jar.header()) headers.Cookie = jar.header();
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (csrf) headers["X-CSRF-Token"] = csrf;
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (jar) jar.absorb(res);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* binary or empty */
  }
  return { status: res.status, json, headers: res.headers };
}

async function getCsrf(jar) {
  const { json } = await call(jar, "GET", "/api/auth/csrf");
  return json.csrfToken;
}

async function upload(jar, csrf, sessionId, filePath, filename) {
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(filePath)]), filename);
  const res = await fetch(`${BASE}/api/upload-sessions/${sessionId}/file`, {
    method: "POST",
    headers: { Cookie: jar.header(), "X-CSRF-Token": csrf },
    body: form,
  });
  jar.absorb(res);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* leave null */
  }
  return { status: res.status, json };
}

async function registerUser(email) {
  const jar = new Jar();
  const csrf = await getCsrf(jar);
  const res = await call(jar, "POST", "/api/auth/register", {
    body: {
      displayName: `User ${email}`,
      email,
      password: PASSWORD,
      confirmPassword: PASSWORD,
      termsAccepted: true,
    },
    csrf,
  });
  if (res.status !== 201) throw new Error(`register ${email} failed: ${res.status} ${JSON.stringify(res.json)}`);
  return { jar, csrf, user: res.json.user };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(proc) {
  for (let i = 0; i < 60; i += 1) {
    if (proc.exitCode !== null) throw new Error(`server exited early with ${proc.exitCode}`);
    try {
      const res = await fetch(`${BASE}/api/auth/config`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error("server did not start in time");
}

function startServer(extraEnv = {}) {
  const proc = spawn(path.join(serverDir, "node_modules", ".bin", "tsx"), ["src/index.ts"], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: "test",
      DATABASE_FILE: dbFile,
      MEDIA_DIR: mediaDir,
      MAX_UPLOAD_MB: "2",
      APP_BASE_URL: "http://localhost:5173",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  return proc;
}

async function stopServer(proc) {
  proc.kill("SIGTERM");
  await sleep(400);
}

async function waitForPhase8Job(jar, jobId, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const res = await call(jar, "GET", `/api/phase8-jobs/${jobId}`);
    last = res.json?.job ?? null;
    if (last && ["COMPLETED", "FAILED", "CANCELLED"].includes(last.status)) return last;
    await sleep(750);
  }
  throw new Error(`phase8 job ${jobId} did not finish (last=${JSON.stringify(last)})`);
}

async function main() {
  // URL_IMPORT_ALLOW_PRIVATE=1 is the documented e2e-only escape
  // hatch that lets the SSRF guard accept the loopback fixture
  // server above; the blocked-without-the-flag behaviour is verified
  // on a separate boot at the end of this suite.
  let proc = startServer({ URL_IMPORT_ALLOW_PRIVATE: "1" });
  try {
    await waitForServer(proc);
    const A = await registerUser(EMAIL_A);
    const B = await registerUser(EMAIL_B);
    const { jar, csrf } = A;

    const studioCfg = await call(jar, "GET", "/api/studio/config");
    check(
      "studio config: local storage, 2MB test limit, formats listed, cloud off",
      studioCfg.status === 200 &&
        studioCfg.json.storageProvider === "local" &&
        studioCfg.json.maxUploadMb === 2 &&
        studioCfg.json.allowedExtensions.includes("mp4") &&
        studioCfg.json.cloudImportConfigured === false,
      JSON.stringify(studioCfg.json),
    );

    // (1) Create long-video project.
    const p1 = await call(jar, "POST", "/api/projects", {
      body: { name: "Podcast Long", workflowType: "LONG_VIDEO_TO_SHORTS" },
      csrf,
      headers: { "Idempotency-Key": "e2e-key-p1" },
    });
    check(
      "1. create LONG_VIDEO_TO_SHORTS project -> 201 DRAFT",
      p1.status === 201 && p1.json.project?.workflowType === "LONG_VIDEO_TO_SHORTS" && p1.json.project?.status === "DRAFT",
      `status=${p1.status} body=${JSON.stringify(p1.json)}`,
    );
    const project1 = p1.json.project.id;

    // (2) Create short-enhancement project.
    const p2 = await call(jar, "POST", "/api/projects", {
      body: { name: "Teaser Enhance", workflowType: "SHORT_VIDEO_ENHANCEMENT" },
      csrf,
    });
    check("2. create SHORT_VIDEO_ENHANCEMENT project -> 201", p2.status === 201 && p2.json.project?.workflowType === "SHORT_VIDEO_ENHANCEMENT", `status=${p2.status}`);
    const project2 = p2.json.project.id;

    // (7) Duplicate submission with the same Idempotency-Key.
    const dup = await call(jar, "POST", "/api/projects", {
      body: { name: "Podcast Long", workflowType: "LONG_VIDEO_TO_SHORTS" },
      csrf,
      headers: { "Idempotency-Key": "e2e-key-p1" },
    });
    const listAll = await call(jar, "GET", "/api/projects?pageSize=50");
    const dupCount = listAll.json.projects.filter((p) => p.name === "Podcast Long").length;
    check(
      "7. duplicate create (same Idempotency-Key) returns same project, no duplicate row",
      dup.status === 200 && dup.json.project?.id === project1 && dupCount === 1,
      `dup=${dup.status} id=${dup.json.project?.id} count=${dupCount}`,
    );

    // (3) Rename.
    const renamed = await call(jar, "PATCH", `/api/projects/${project1}`, {
      body: { name: "Podcast Long Renamed" },
      csrf,
    });
    check("3. rename project -> 200 with new name", renamed.status === 200 && renamed.json.project?.name === "Podcast Long Renamed", `status=${renamed.status}`);

    // Settings round-trip (Workflow A) + invalid enum rejected.
    const settingsA = {
      clipCount: "custom",
      customClipCount: 7,
      clipDuration: "30",
      aspectRatio: "9:16",
      resolution: "1080p",
      targetPlatform: "tiktok",
      language: "hi",
      captions: { enabled: true, style: "highlight", animatedHighlight: true },
      tracking: "active-speaker",
      zoom: "dynamic",
      audio: ["preserve", "voice-emphasis"],
      discoveryPrompt: "Find strong podcast statements.",
      transcriptionContext: "CLIPFORGE, Souban",
    };
    const patched = await call(jar, "PATCH", `/api/projects/${project1}`, { body: { settings: settingsA }, csrf });
    const fetched = await call(jar, "GET", `/api/projects/${project1}`);
    check(
      "settings PATCH round-trip (A): enums, captions, prompt -> aiInstruction",
      patched.status === 200 &&
        fetched.json.project?.settings?.clipCount === "custom" &&
        fetched.json.project?.settings?.customClipCount === 7 &&
        fetched.json.project?.settings?.captions?.style === "highlight" &&
        fetched.json.project?.aiInstruction === "Find strong podcast statements.",
      `patched=${patched.status} body=${JSON.stringify(fetched.json?.project?.settings)}`,
    );
    const badSettings = await call(jar, "PATCH", `/api/projects/${project1}`, {
      body: { settings: { aspectRatio: "21:9" } },
      csrf,
    });
    check("settings PATCH with invalid enum -> 400", badSettings.status === 400, `got ${badSettings.status}`);
    const settingsB = { reframeAspect: "1:1", faceTracking: "follow-speaker", captionsMode: "preserve", audio: ["preserve", "normalization"], visual: ["zoom"] };
    const patchedB = await call(jar, "PATCH", `/api/projects/${project2}`, { body: { settings: settingsB }, csrf });
    check("settings PATCH round-trip (B): enhancement preferences saved", patchedB.status === 200 && patchedB.json.project?.settings?.reframeAspect === "1:1", `status=${patchedB.status}`);

    // (5) Search projects.
    const pAlpha = await call(jar, "POST", "/api/projects", {
      body: { name: "Alpha Unique Project", workflowType: "LONG_VIDEO_TO_SHORTS" },
      csrf,
    });
    const searchHit = await call(jar, "GET", "/api/projects?search=Alpha");
    const searchMiss = await call(jar, "GET", "/api/projects?search=zzz-no-match");
    check(
      "5. search projects: hit returns only matches, miss returns 0",
      searchHit.json?.total === 1 && searchHit.json.projects[0]?.id === pAlpha.json.project.id && searchMiss.json?.total === 0,
      `hit=${searchHit.json?.total} miss=${searchMiss.json?.total}`,
    );

    // ---- YouTube validation (19-26) ----
    const ytWatch = await call(jar, "POST", "/api/youtube/validate", { body: { url: `https://www.youtube.com/watch?v=${YT_ID}` }, csrf });
    check("19. valid watch URL -> urlValid + videoId", ytWatch.status === 200 && ytWatch.json?.urlValid === true && ytWatch.json?.videoId === YT_ID, `status=${ytWatch.status} body=${JSON.stringify(ytWatch.json)}`);
    const ytShort = await call(jar, "POST", "/api/youtube/validate", { body: { url: `https://youtu.be/${YT_ID}` }, csrf });
    check("20. valid youtu.be URL -> urlValid", ytShort.status === 200 && ytShort.json?.videoId === YT_ID, `status=${ytShort.status}`);
    const ytShorts = await call(jar, "POST", "/api/youtube/validate", { body: { url: `https://www.youtube.com/shorts/${YT_ID}` }, csrf });
    check("21. valid Shorts URL -> urlValid", ytShorts.status === 200 && ytShorts.json?.videoId === YT_ID, `status=${ytShorts.status}`);
    const ytBad = await call(jar, "POST", "/api/youtube/validate", { body: { url: "not a url at all" }, csrf });
    check("22. malformed URL -> 400", ytBad.status === 400, `got ${ytBad.status}`);
    const ytHost = await call(jar, "POST", "/api/youtube/validate", { body: { url: "https://vimeo.com/12345678901" }, csrf });
    check("23. unrelated hostname -> 400", ytHost.status === 400, `got ${ytHost.status}`);
    check(
      "24-26. statuses stay distinct & honest: no metadata (API unconfigured), not authorised, not imported",
      ytWatch.json?.metadataAvailable === false &&
        ytWatch.json?.authorizationVerified === false &&
        ytWatch.json?.mediaAvailable === false &&
        ytWatch.json?.imported === false,
      JSON.stringify(ytWatch.json),
    );
    const ytProject = await call(jar, "POST", "/api/projects", {
      body: {
        name: "YT Source Project",
        workflowType: "LONG_VIDEO_TO_SHORTS",
        sourceType: "YOUTUBE_URL",
        youtube: { url: `https://www.youtube.com/watch?v=${YT_ID}`, videoId: YT_ID },
      },
      csrf,
    });
    check(
      "25b. YouTube project is REQUIRES_SOURCE_FILE, never 'imported'",
      ytProject.status === 201 &&
        ytProject.json.project?.status === "REQUIRES_SOURCE_FILE" &&
        ytProject.json.project?.sourceAsset?.validationStatus === "REQUIRES_SOURCE_FILE",
      `status=${ytProject.status} body=${JSON.stringify(ytProject.json?.project?.status)}`,
    );

    // ---- Uploads ----
    const mkSession = async (projectId, filePath, name) => {
      const size = fs.statSync(filePath).size;
      return call(jar, "POST", `/api/projects/${projectId}/upload-session`, { body: { filename: name, size }, csrf });
    };

    // (10) Unsupported extension rejected at session creation.
    const badExt = await call(jar, "POST", `/api/projects/${project1}/upload-session`, {
      body: { filename: "movie.avi", size: 1000 },
      csrf,
    });
    check("10. unsupported format (.avi) -> 400 with supported list", badExt.status === 400 && /mp4/.test(badExt.json?.error ?? ""), `status=${badExt.status} body=${JSON.stringify(badExt.json)}`);

    // (11) Oversized rejected (declared size above the 2MB test limit).
    const bigSession = await mkSession(project1, bigMp4, "big.mp4");
    check("11. oversized file -> 413 at session creation", bigSession.status === 413, `got ${bigSession.status}`);

    // (8, 13, 14, 18) Valid MP4 with audio.
    const s1 = await mkSession(project1, validMp4, "valid.mp4");
    check("upload session created -> 201 PENDING", s1.status === 201 && s1.json.session?.status === "PENDING", `status=${s1.status}`);
    const up1 = await upload(jar, csrf, s1.json.session.id, validMp4, "valid.mp4");
    const asset1 = up1.json?.asset;
    check(
      "8. valid MP4 upload -> 200, asset VALID, project READY_FOR_ANALYSIS",
      up1.status === 200 && asset1?.validationStatus === "VALID" && up1.json.project?.status === "READY_FOR_ANALYSIS",
      `status=${up1.status} body=${JSON.stringify(up1.json)}`,
    );
    check(
      "13. metadata extraction matches ffprobe ground truth",
      Math.abs((asset1?.duration ?? 0) - truth.duration) < 0.6 &&
        asset1?.width === truth.width &&
        asset1?.height === truth.height &&
        asset1?.videoCodec === truth.videoCodec,
      `asset=${JSON.stringify(asset1)} truth=${JSON.stringify(truth)}`,
    );
    check(
      "14. audio stream detected (hasAudio=true, aac)",
      asset1?.hasAudio === true && asset1?.audioCodec === "aac",
      `asset=${JSON.stringify(asset1)}`,
    );
    const storedPath1 = path.join(mediaDir, A.user.id, `${asset1.id}.mp4`);
    check("18. uploaded file actually exists in server storage", fs.existsSync(storedPath1), storedPath1);
    const thumbRes = await fetch(`${BASE}/api/source-assets/${asset1.id}/thumbnail`, { headers: { Cookie: jar.header() } });
    check("thumbnail endpoint serves a real frame (200, jpeg)", thumbRes.status === 200 && (thumbRes.headers.get("content-type") ?? "").includes("image/jpeg"), `status=${thumbRes.status}`);
    await thumbRes.arrayBuffer();
    const streamRes = await fetch(`${BASE}/api/source-assets/${asset1.id}/stream`, { headers: { Cookie: jar.header() } });
    check("stream endpoint serves the media to its owner (200, video/mp4)", streamRes.status === 200 && (streamRes.headers.get("content-type") ?? "").includes("video/mp4"), `status=${streamRes.status}`);
    await streamRes.arrayBuffer();

    // (27, 28) Cross-user access.
    const crossGet = await call(B.jar, "GET", `/api/projects/${project1}`);
    const crossPatch = await call(B.jar, "PATCH", `/api/projects/${project1}`, { body: { name: "Hijacked" }, csrf: B.csrf });
    const crossDelete = await call(B.jar, "DELETE", `/api/projects/${project1}`, { csrf: B.csrf });
    check("27. another user cannot read/patch/delete the project (404s)", crossGet.status === 404 && crossPatch.status === 404 && crossDelete.status === 404, `get=${crossGet.status} patch=${crossPatch.status} del=${crossDelete.status}`);
    const crossThumb = await fetch(`${BASE}/api/source-assets/${asset1.id}/thumbnail`, { headers: { Cookie: B.jar.header() } });
    const crossStream = await fetch(`${BASE}/api/source-assets/${asset1.id}/stream`, { headers: { Cookie: B.jar.header() } });
    check("28. another user cannot fetch thumbnail or media (404s)", crossThumb.status === 404 && crossStream.status === 404, `thumb=${crossThumb.status} stream=${crossStream.status}`);

    // (9) Valid WebM on the enhancement project.
    const s2 = await mkSession(project2, validWebm, "valid.webm");
    const up2 = await upload(jar, csrf, s2.json.session.id, validWebm, "valid.webm");
    check(
      "9. valid WebM upload -> VALID (container webm, vp8)",
      up2.status === 200 && up2.json.asset?.validationStatus === "VALID" && /webm/.test(up2.json.asset?.container ?? "") && up2.json.asset?.videoCodec === "vp8",
      `status=${up2.status} body=${JSON.stringify(up2.json?.asset)}`,
    );

    // (14b) MP4 without audio.
    const p3 = await call(jar, "POST", "/api/projects", { body: { name: "Silent Project", workflowType: "LONG_VIDEO_TO_SHORTS" }, csrf });
    const project3 = p3.json.project.id;
    const s3 = await mkSession(project3, noAudioMp4, "noaudio.mp4");
    const up3 = await upload(jar, csrf, s3.json.session.id, noAudioMp4, "noaudio.mp4");
    check("14b. no-audio MP4 -> hasAudio=false, audioCodec=null", up3.status === 200 && up3.json.asset?.hasAudio === false && up3.json.asset?.audioCodec === null, `status=${up3.status} body=${JSON.stringify(up3.json?.asset)}`);

    // (12) Corrupted file rejected, project FAILED with actionable error.
    const p4 = await call(jar, "POST", "/api/projects", { body: { name: "Corrupt Project", workflowType: "LONG_VIDEO_TO_SHORTS" }, csrf });
    const project4 = p4.json.project.id;
    const s4 = await mkSession(project4, corruptMp4, "corrupt.mp4");
    const up4 = await upload(jar, csrf, s4.json.session.id, corruptMp4, "corrupt.mp4");
    const afterCorrupt = await call(jar, "GET", `/api/projects/${project4}`);
    check(
      "12. corrupted file -> 422, asset FAILED, project FAILED",
      up4.status === 422 &&
        afterCorrupt.json.project?.status === "FAILED" &&
        afterCorrupt.json.project?.sourceAsset?.validationStatus === "FAILED",
      `upload=${up4.status} project=${JSON.stringify(afterCorrupt.json?.project?.status)}`,
    );

    // (16) Retry: a NEW session on the same project succeeds.
    const s4b = await mkSession(project4, validMp4, "valid.mp4");
    const up4b = await upload(jar, csrf, s4b.json.session.id, validMp4, "valid.mp4");
    check("16. retry with a new session after failure -> VALID", up4b.status === 200 && up4b.json.asset?.validationStatus === "VALID", `status=${up4b.status}`);

    // (15) Cancel: session cancelled, further upload rejected.
    const s5 = await mkSession(project3, validMp4, "valid.mp4");
    const cancel = await call(jar, "POST", `/api/upload-sessions/${s5.json.session.id}/cancel`, { body: {}, csrf });
    const sessionAfter = await call(jar, "GET", `/api/upload-sessions/${s5.json.session.id}`);
    const upAfterCancel = await upload(jar, csrf, s5.json.session.id, validMp4, "valid.mp4");
    check(
      "15. cancel upload session -> CANCELLED, file POST afterwards -> 409",
      cancel.status === 200 && sessionAfter.json.session?.status === "CANCELLED" && upAfterCancel.status === 409,
      `cancel=${cancel.status} after=${sessionAfter.json.session?.status} upload=${upAfterCancel.status}`,
    );

    // (29) Expired upload session rejected.
    const s6 = await mkSession(project3, validMp4, "valid.mp4");
    const db = new DatabaseSync(dbFile);
    db.prepare("UPDATE upload_sessions SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 60_000).toISOString(), s6.json.session.id);
    db.close();
    const upExpired = await upload(jar, csrf, s6.json.session.id, validMp4, "valid.mp4");
    check("29. expired upload session -> 410", upExpired.status === 410, `got ${upExpired.status}`);

    // (17) Replace source safely on project 1.
    const oldAssetId = asset1.id;
    const s7 = await mkSession(project1, noAudioMp4, "noaudio.mp4");
    const up7 = await upload(jar, csrf, s7.json.session.id, noAudioMp4, "noaudio.mp4");
    const afterReplace = await call(jar, "GET", `/api/projects/${project1}`);
    const oldStream = await fetch(`${BASE}/api/source-assets/${oldAssetId}/stream`, { headers: { Cookie: jar.header() } });
    check(
      "17. replace source: new asset active, old asset + old file gone",
      up7.status === 200 &&
        afterReplace.json.project?.sourceAsset?.id === up7.json.asset.id &&
        afterReplace.json.project?.sourceAsset?.originalFilename === "noaudio.mp4" &&
        oldStream.status === 404 &&
        !fs.existsSync(storedPath1),
      `upload=${up7.status} oldStream=${oldStream.status} oldFileExists=${fs.existsSync(storedPath1)}`,
    );

    // (4) Delete project (+ its files).
    const pDel = await call(jar, "POST", "/api/projects", { body: { name: "Delete Me", workflowType: "SHORT_VIDEO_ENHANCEMENT" }, csrf });
    const delId = pDel.json.project.id;
    const sDel = await mkSession(delId, validMp4, "valid.mp4");
    const upDel = await upload(jar, csrf, sDel.json.session.id, validMp4, "valid.mp4");
    const delFile = path.join(mediaDir, A.user.id, `${upDel.json.asset.id}.mp4`);
    const del = await call(jar, "DELETE", `/api/projects/${delId}`, { csrf });
    const getDeleted = await call(jar, "GET", `/api/projects/${delId}`);
    check(
      "4. delete project -> 200, then 404, stored file removed",
      del.status === 200 && getDeleted.status === 404 && !fs.existsSync(delFile),
      `del=${del.status} get=${getDeleted.status} fileExists=${fs.existsSync(delFile)}`,
    );

    // Guest / unauthenticated + CSRF discipline.
    const anonList = await call(null, "GET", "/api/projects");
    check("guest: GET /api/projects without session -> 401", anonList.status === 401, `got ${anonList.status}`);
    const jarAnon = new Jar();
    const csrfAnon = await getCsrf(jarAnon);
    const anonCreate = await call(jarAnon, "POST", "/api/projects", { body: { name: "Nope", workflowType: "LONG_VIDEO_TO_SHORTS" }, csrf: csrfAnon });
    check("guest: POST /api/projects with CSRF but no session -> 401", anonCreate.status === 401, `got ${anonCreate.status}`);
    const noCsrf = await call(jar, "POST", "/api/projects", { body: { name: "Nope", workflowType: "LONG_VIDEO_TO_SHORTS" } });
    check("CSRF: studio mutation without X-CSRF-Token -> 403", noCsrf.status === 403, `got ${noCsrf.status}`);

    // ---- URL import (yt-dlp) ----
    const urlCfg = await call(jar, "GET", "/api/studio/config");
    check(
      "U0. studio config reports URL import enabled (yt-dlp resolvable)",
      urlCfg.status === 200 && urlCfg.json.urlImport?.enabled === true && typeof urlCfg.json.urlImport?.detail === "string",
      JSON.stringify(urlCfg.json?.urlImport),
    );

    const pImp = await call(jar, "POST", "/api/projects", { body: { name: "URL Import", workflowType: "LONG_VIDEO_TO_SHORTS" }, csrf });
    const impProject = pImp.json.project.id;
    const impCreate = await call(jar, "POST", `/api/projects/${impProject}/url-import`, {
      body: { url: `${fixtureBase}/valid.mp4` },
      csrf,
    });
    check(
      "U1. URL import accepted (201, URL_IMPORT job + URL_IMPORT asset)",
      impCreate.status === 201 &&
        impCreate.json.job?.kind === "URL_IMPORT" &&
        impCreate.json.asset?.sourceType === "URL_IMPORT",
      `status=${impCreate.status} body=${JSON.stringify(impCreate.json).slice(0, 300)}`,
    );
    const impJob = await waitForPhase8Job(jar, impCreate.json.job.id);
    check(
      "U2. URL import job COMPLETED via a real yt-dlp download (generic extractor)",
      impJob.status === "COMPLETED" && impJob.result?.provider === "generic",
      JSON.stringify(impJob).slice(0, 300),
    );
    const impAfter = await call(jar, "GET", `/api/projects/${impProject}`);
    const impAsset = impAfter.json.project?.sourceAsset;
    check(
      "U3. imported asset is the project source: VALID, probe matches the fixture ground truth, project READY_FOR_ANALYSIS",
      impAsset?.sourceType === "URL_IMPORT" &&
        impAsset?.validationStatus === "VALID" &&
        impAsset?.width === truth.width &&
        impAsset?.height === truth.height &&
        impAsset?.videoCodec === truth.videoCodec &&
        impAsset?.hasAudio === truth.hasAudio &&
        Math.abs((impAsset?.duration ?? 0) - truth.duration) < 0.6 &&
        impAfter.json.project?.status === "READY_FOR_ANALYSIS",
      JSON.stringify(impAsset),
    );
    const impStream = await fetch(`${BASE}/api/source-assets/${impAsset.id}/stream`, { headers: { Cookie: jar.header() } });
    check(
      "U4. imported asset streams (200) and has a thumbnail",
      impStream.status === 200 && impAsset.hasThumbnail === true,
      `stream=${impStream.status} thumb=${impAsset.hasThumbnail}`,
    );
    const provDb = new DatabaseSync(dbFile, { readOnly: true });
    const metaRow = provDb.prepare("SELECT provider, source_type FROM media_asset_meta WHERE asset_ref = ?").get(`source:${impAsset.id}`);
    const licRow = provDb.prepare("SELECT source_url, license_name FROM media_license_records WHERE asset_ref = ?").get(`source:${impAsset.id}`);
    provDb.close();
    check(
      "U5. provenance stored: meta row (provider generic, URL_IMPORT) + licence record with the source URL and the user-supplied rights note",
      metaRow?.provider === "generic" &&
        metaRow?.source_type === "URL_IMPORT" &&
        licRow?.source_url === `${fixtureBase}/valid.mp4` &&
        /user-supplied/i.test(licRow?.license_name ?? ""),
      JSON.stringify({ metaRow, licRow }),
    );

    // One-click "Generate Clips" contract: the frontend chains
    // POST /analysis (with the page's prompt + the project's
    // language) onto the imported asset the moment the import job
    // completes. The clips suite proves candidates on a speech
    // fixture (11a-d); here the sine-tone fixture proves the chain
    // reaches an honest terminal state whose candidate count agrees
    // with the candidates endpoint (NO_SPEECH -> 0 candidates).
    const chainRes = await call(jar, "POST", `/api/projects/${impProject}/analysis`, {
      body: { sourceAssetId: impAsset.id, prompt: "Find the most engaging moments.", language: "en" },
      csrf,
    });
    check(
      "U11a. one-click chain: analysis accepted on the URL-imported asset with prompt + language (201, QUEUED)",
      chainRes.status === 201 && chainRes.json.job?.status === "QUEUED",
      `status=${chainRes.status} body=${JSON.stringify(chainRes.json).slice(0, 300)}`,
    );
    let chainJob = chainRes.json.job;
    const chainDeadline = Date.now() + 300_000;
    while (chainJob && !["COMPLETED", "FAILED", "CANCELLED"].includes(chainJob.status) && Date.now() < chainDeadline) {
      await sleep(1500);
      const poll = await call(jar, "GET", `/api/analysis/${chainJob.id}`);
      chainJob = poll.json?.job ?? chainJob;
    }
    const chainCandidates = await call(jar, "GET", `/api/projects/${impProject}/candidates?sort=score`);
    check(
      "U11b. one-click chain: analysis reaches COMPLETED with an honest outcome and a candidate count matching the candidates endpoint",
      chainJob?.status === "COMPLETED" &&
        typeof chainJob?.outcome === "string" &&
        chainJob.outcome.length > 0 &&
        chainJob.candidateCount === (chainCandidates.json?.candidates?.length ?? -1),
      `job=${JSON.stringify(chainJob).slice(0, 300)} candidates=${chainCandidates.json?.candidates?.length}`,
    );

    // Double-submit protection the Generate button relies on: a
    // second POST of the same URL while the first import is still
    // active returns the SAME job (200, deduplicated) instead of
    // starting a parallel download.
    const pDup = await call(jar, "POST", "/api/projects", { body: { name: "URL Import Dedupe", workflowType: "LONG_VIDEO_TO_SHORTS" }, csrf });
    const dupFirst = await call(jar, "POST", `/api/projects/${pDup.json.project.id}/url-import`, {
      body: { url: `${fixtureBase}/valid.mp4` },
      csrf,
    });
    const dupSecond = await call(jar, "POST", `/api/projects/${pDup.json.project.id}/url-import`, {
      body: { url: `${fixtureBase}/valid.mp4` },
      csrf,
    });
    check(
      "U12. re-submitting the same URL while its import is active -> 200 deduplicated, same job id (no parallel download)",
      dupFirst.status === 201 &&
        dupSecond.status === 200 &&
        dupSecond.json?.deduplicated === true &&
        dupSecond.json?.job?.id === dupFirst.json?.job?.id,
      `first=${dupFirst.status} second=${dupSecond.status} body=${JSON.stringify(dupSecond.json).slice(0, 300)}`,
    );
    await waitForPhase8Job(jar, dupFirst.json.job.id);

    const badUrl = await call(jar, "POST", `/api/projects/${impProject}/url-import`, { body: { url: "not a url" }, csrf });
    check(
      "U6. invalid URL -> 400 VALIDATION_ERROR (never queued)",
      badUrl.status === 400 && badUrl.json?.error?.code === "VALIDATION_ERROR",
      `status=${badUrl.status} body=${JSON.stringify(badUrl.json)}`,
    );
    const ftpUrlRes = await call(jar, "POST", `/api/projects/${impProject}/url-import`, { body: { url: "ftp://example.com/video.mp4" }, csrf });
    check(
      "U6b. non-http(s) URL -> 400 VALIDATION_ERROR",
      ftpUrlRes.status === 400 && ftpUrlRes.json?.error?.code === "VALIDATION_ERROR",
      `status=${ftpUrlRes.status} body=${JSON.stringify(ftpUrlRes.json)}`,
    );

    const pFail = await call(jar, "POST", "/api/projects", { body: { name: "URL Import Non-Media", workflowType: "LONG_VIDEO_TO_SHORTS" }, csrf });
    const failCreate = await call(jar, "POST", `/api/projects/${pFail.json.project.id}/url-import`, {
      body: { url: `${fixtureBase}/page.html` },
      csrf,
    });
    const failJob = await waitForPhase8Job(jar, failCreate.json.job.id);
    const failAfter = await call(jar, "GET", `/api/projects/${pFail.json.project.id}`);
    check(
      "U7. non-media URL -> FAILED job (UNSUPPORTED_URL), asset marked FAILED, project FAILED — never a fake success",
      failCreate.status === 201 &&
        failJob.status === "FAILED" &&
        failJob.errorCode === "UNSUPPORTED_URL" &&
        typeof failJob.error === "string" && failJob.error.length > 0 &&
        failAfter.json.project?.sourceAsset?.validationStatus === "FAILED" &&
        failAfter.json.project?.status === "FAILED",
      `job=${JSON.stringify(failJob).slice(0, 300)} project=${JSON.stringify(failAfter.json?.project).slice(0, 200)}`,
    );

    const pBig = await call(jar, "POST", "/api/projects", { body: { name: "URL Import Oversized", workflowType: "LONG_VIDEO_TO_SHORTS" }, csrf });
    const bigCreate = await call(jar, "POST", `/api/projects/${pBig.json.project.id}/url-import`, {
      body: { url: `${fixtureBase}/big.mp4` },
      csrf,
    });
    const bigJob = await waitForPhase8Job(jar, bigCreate.json.job.id);
    check(
      "U8. oversized download (fixture > MAX_UPLOAD_MB=2) -> FAILED job with TOO_LARGE",
      bigCreate.status === 201 && bigJob.status === "FAILED" && bigJob.errorCode === "TOO_LARGE",
      `job=${JSON.stringify(bigJob).slice(0, 300)}`,
    );

    // (6) Persistence across a real server restart (same DB + media).
    await stopServer(proc);
    proc = startServer({ URL_IMPORT_ALLOW_PRIVATE: "1" });
    await waitForServer(proc);
    const jarRelogin = new Jar();
    const csrfRelogin = await getCsrf(jarRelogin);
    const relogin = await call(jarRelogin, "POST", "/api/auth/login", {
      body: { email: EMAIL_A, password: PASSWORD },
      csrf: csrfRelogin,
    });
    const persisted = await call(jarRelogin, "GET", `/api/projects/${project1}`);
    check(
      "6. persistence: project + replaced source survive a server restart",
      relogin.status === 200 &&
        persisted.status === 200 &&
        persisted.json.project?.name === "Podcast Long Renamed" &&
        persisted.json.project?.sourceAsset?.originalFilename === "noaudio.mp4",
      `login=${relogin.status} get=${persisted.status}`,
    );

    // SSRF guard WITHOUT the test escape hatch: a fresh boot with
    // URL_IMPORT_ALLOW_PRIVATE unset must refuse loopback/private
    // targets up front (400 URL_BLOCKED, nothing queued).
    await stopServer(proc);
    proc = startServer({ URL_IMPORT_ALLOW_PRIVATE: "0" });
    await waitForServer(proc);
    const jarBlocked = new Jar();
    const csrfBlocked = await getCsrf(jarBlocked);
    const loginBlocked = await call(jarBlocked, "POST", "/api/auth/login", {
      body: { email: EMAIL_A, password: PASSWORD },
      csrf: csrfBlocked,
    });
    const pBlocked = await call(jarBlocked, "POST", "/api/projects", {
      body: { name: "URL Import Blocked", workflowType: "LONG_VIDEO_TO_SHORTS" },
      csrf: csrfBlocked,
    });
    const blockedLoop = await call(jarBlocked, "POST", `/api/projects/${pBlocked.json.project.id}/url-import`, {
      body: { url: `${fixtureBase}/valid.mp4` },
      csrf: csrfBlocked,
    });
    check(
      "U9. loopback URL without URL_IMPORT_ALLOW_PRIVATE -> 400 URL_BLOCKED (SSRF guard, production default)",
      loginBlocked.status === 200 && blockedLoop.status === 400 && blockedLoop.json?.error?.code === "URL_BLOCKED",
      `login=${loginBlocked.status} status=${blockedLoop.status} body=${JSON.stringify(blockedLoop.json)}`,
    );
    const blockedLiteral = await call(jarBlocked, "POST", `/api/projects/${pBlocked.json.project.id}/url-import`, {
      body: { url: "http://192.168.1.10/video.mp4" },
      csrf: csrfBlocked,
    });
    check(
      "U10. private IP literal -> 400 URL_BLOCKED",
      blockedLiteral.status === 400 && blockedLiteral.json?.error?.code === "URL_BLOCKED",
      `status=${blockedLiteral.status} body=${JSON.stringify(blockedLiteral.json)}`,
    );
  } finally {
    await stopServer(proc);
    fixtureServer.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Studio E2E suite crashed:", err);
  process.exit(1);
});
