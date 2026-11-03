// CLIPFORGE Phase 4 — AI clip detection end-to-end tests.
//
// Boots the real server on PORT=3103 with a temp SQLite DB, temp media
// + processing dirs, generates REAL speech fixtures with espeak-ng +
// ffmpeg, uploads them through the Phase 3 flow, and exercises the
// analysis pipeline over HTTP exactly like the frontend does.
//
// Transcription runs the real local faster-whisper "small" model, so
// the first job in the suite can take a while; polling timeouts are
// generous on purpose. Hindi assertions check pipeline completion and
// non-empty output ONLY — wording quality on synthetic espeak speech
// is not asserted (see suite output for the actual transcript).
//
// Run: npm run test:clips   (from the server/ directory)

import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3103;
const BASE = `http://localhost:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-clips-e2e-"));
const dbFile = path.join(tmpDir, "test.db");
const mediaDir = path.join(tmpDir, "media");
const processingDir = path.join(tmpDir, "processing");
const fixturesDir = path.join(tmpDir, "fixtures");
fs.mkdirSync(fixturesDir, { recursive: true });
fs.mkdirSync(mediaDir, { recursive: true });

const EMAIL_A = "clips-a@example.com";
const EMAIL_B = "clips-b@example.com";
const PASSWORD = "Str0ngPassw0rd";

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

const sha256File = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fixtures: real speech videos via espeak-ng + ffmpeg -----------------

function ffmpeg(args) {
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "pipe" });
}

function buildSpeechMp4(sentences, voice, outName, repeats = 1) {
  const work = fs.mkdtempSync(path.join(fixturesDir, "build-"));
  const parts = [];
  let idx = 0;
  const silence = path.join(work, "sil.wav");
  ffmpeg(["-f", "lavfi", "-i", "anullsrc=r=22050:cl=mono", "-t", "0.7", silence]);
  for (let r = 0; r < repeats; r += 1) {
    for (const sentence of sentences) {
      idx += 1;
      const wav = path.join(work, `s${idx}.wav`);
      execFileSync("espeak-ng", ["-v", voice, "-s", "150", "-w", wav, sentence], { stdio: "pipe" });
      parts.push(wav, silence);
    }
  }
  const listFile = path.join(work, "list.txt");
  fs.writeFileSync(listFile, parts.map((p) => `file '${p}'`).join("\n"));
  const audioWav = path.join(work, "audio.wav");
  ffmpeg(["-f", "concat", "-safe", "0", "-i", listFile, "-ar", "16000", "-ac", "1", audioWav]);
  const out = path.join(fixturesDir, outName);
  ffmpeg([
    "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30",
    "-i", audioWav,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", out,
  ]);
  return out;
}

const EN_SENTENCES = [
  "Listen carefully.",
  "This is the most important moment of the entire video.",
  "Today we will learn how captions actually work.",
  "Captions help every creator reach more viewers.",
  "Why does this matter for your channel?",
  "Because clear captions keep people watching longer.",
];
const HI_SENTENCES = [
  "यह वीडियो बहुत महत्वपूर्ण है।",
  "आज हम सीखेंगे कि कैप्शन कैसे काम करते हैं।",
  "कैप्शन हर दर्शक के लिए उपयोगी होते हैं।",
  "इसलिए हर क्रिएटर को कैप्शन का उपयोग करना चाहिए।",
  "यह जानकारी आपके चैनल के लिए जरूरी है।",
];

console.log("Generating speech fixtures (espeak-ng + ffmpeg)…");
const enMp4 = buildSpeechMp4(EN_SENTENCES, "en", "en.mp4");

// URL-import fixture server: serves the speech fixtures over
// loopback HTTP so the import test downloads en.mp4 through
// yt-dlp's real generic-extractor path. Reachable from the server
// under test only because the suite boots with
// URL_IMPORT_ALLOW_PRIVATE=1 (production keeps loopback blocked).
const fixtureServer = http.createServer((req, res) => {
  const name = decodeURIComponent((req.url ?? "/").split("/").pop() ?? "");
  const file = path.join(fixturesDir, name);
  if (!name || !file.startsWith(fixturesDir) || !fs.existsSync(file)) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Length": fs.statSync(file).size,
  });
  fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => fixtureServer.listen(0, "127.0.0.1", resolve));
const fixtureBase = `http://127.0.0.1:${fixtureServer.address().port}`;
const hiMp4 = buildSpeechMp4(HI_SENTENCES, "hi", "hi.mp4");
const longMp4 = buildSpeechMp4(EN_SENTENCES, "en", "long.mp4", 6);
const silentMp4 = path.join(fixturesDir, "silent.mp4");
ffmpeg([
  "-f", "lavfi", "-i", "testsrc2=duration=6:size=320x240:rate=30",
  "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", silentMp4,
]);

function probe(file) {
  const out = execFileSync(
    "ffprobe",
    ["-v", "error", "-show_format", "-show_streams", "-of", "json", file],
    { encoding: "utf8" },
  );
  const data = JSON.parse(out);
  return {
    duration: Number(data.format.duration),
    hasVideo: data.streams.some((s) => s.codec_type === "video"),
    hasAudio: data.streams.some((s) => s.codec_type === "audio"),
  };
}

// ---- http helpers -----------------------------------------------------------

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
}

async function call(jar, method, urlPath, { body, csrf } = {}) {
  const headers = {};
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
  return { status: res.status, json };
}

async function getCsrf(jar) {
  const { json } = await call(jar, "GET", "/api/auth/csrf");
  return json.csrfToken;
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

/** Create a project, upload a real file into it, return ids. */
async function projectWithUpload(jar, csrf, name, filePath, filename) {
  const created = await call(jar, "POST", "/api/projects", {
    body: { name, workflowType: "LONG_VIDEO_TO_SHORTS" },
    csrf,
  });
  if (created.status !== 201) throw new Error(`project ${name}: ${created.status}`);
  const projectId = created.json.project.id;
  const size = fs.statSync(filePath).size;
  const session = await call(jar, "POST", `/api/projects/${projectId}/upload-session`, {
    body: { filename, size },
    csrf,
  });
  if (session.status !== 201) throw new Error(`session ${name}: ${session.status} ${JSON.stringify(session.json)}`);
  const up = await upload(jar, csrf, session.json.session.id, filePath, filename);
  if (up.status !== 200) throw new Error(`upload ${name}: ${up.status} ${JSON.stringify(up.json)}`);
  return { projectId, assetId: up.json.asset.id };
}

async function createJob(jar, csrf, projectId, body) {
  return call(jar, "POST", `/api/projects/${projectId}/analysis`, { body, csrf });
}

async function waitForPhase8Job(jar, jobId, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const res = await call(jar, "GET", `/api/phase8-jobs/${jobId}`);
    last = res.json?.job ?? null;
    if (last && ["COMPLETED", "FAILED", "CANCELLED"].includes(last.status)) return last;
    await sleep(1000);
  }
  throw new Error(`phase8 job ${jobId} did not finish (last=${JSON.stringify(last)})`);
}

const TERMINAL = ["COMPLETED", "FAILED", "CANCELLED"];
async function waitForJob(jar, jobId, timeoutMs = 600_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const res = await call(jar, "GET", `/api/analysis/${jobId}`);
    last = res.json?.job ?? null;
    if (last && TERMINAL.includes(last.status)) return last;
    await sleep(1500);
  }
  throw new Error(`job ${jobId} did not finish in time (last=${JSON.stringify(last)})`);
}

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

function startServer() {
  const proc = spawn(path.join(serverDir, "node_modules", ".bin", "tsx"), ["src/index.ts"], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: "test",
      DATABASE_FILE: dbFile,
      MEDIA_DIR: mediaDir,
      PROCESSING_DIR: processingDir,
      URL_IMPORT_ALLOW_PRIVATE: "1",
      APP_BASE_URL: "http://localhost:5173",
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

// ---- suite --------------------------------------------------------------------

async function main() {
  const proc = startServer();
  try {
    await waitForServer(proc);
    const A = await registerUser(EMAIL_A);
    const B = await registerUser(EMAIL_B);
    const { jar, csrf } = A;

    // (0) Provider configuration is real and honest.
    const cfgAnon = await call(null, "GET", "/api/analysis/config");
    check("config endpoint requires auth (401)", cfgAnon.status === 401, `got ${cfgAnon.status}`);
    const cfg = await call(jar, "GET", "/api/analysis/config");
    check(
      "0. STT config: local-faster-whisper configured, model small, no diarization claimed",
      cfg.status === 200 &&
        cfg.json.provider === "local-faster-whisper" &&
        cfg.json.configured === true &&
        cfg.json.model === "small" &&
        cfg.json.speakerDiarization === false,
      JSON.stringify(cfg.json),
    );

    // ---- (1) English analysis, end to end ----
    const en = await projectWithUpload(jar, csrf, "EN Clips", enMp4, "en.mp4");
    const enStoredPath = path.join(mediaDir, A.user.id, `${en.assetId}.mp4`);
    const enHashBefore = sha256File(enStoredPath);
    const enJobRes = await createJob(jar, csrf, en.projectId, {
      sourceAssetId: en.assetId,
      prompt: "Find powerful statements and questions and answers.",
    });
    check("1a. EN analysis job created (201, QUEUED)", enJobRes.status === 201 && enJobRes.json.job?.status === "QUEUED", `status=${enJobRes.status} body=${JSON.stringify(enJobRes.json)}`);
    const enJob = await waitForJob(jar, enJobRes.json.job.id);
    check(
      "1b. EN analysis COMPLETED with CLIPS_FOUND",
      enJob.status === "COMPLETED" && enJob.outcome === "CLIPS_FOUND",
      JSON.stringify(enJob),
    );
    const enTranscript = await call(jar, "GET", `/api/projects/${en.projectId}/transcript`);
    const enText = enTranscript.json?.transcript?.fullText ?? "";
    console.log(`      EN transcript: ${enText.slice(0, 160)}`);
    check(
      "1c. EN transcript contains the real spoken words",
      enTranscript.status === 200 &&
        enText.toLowerCase().includes("captions") &&
        enText.toLowerCase().includes("important"),
      enText.slice(0, 200),
    );
    check(
      "1d. transcript metadata honest: language en, word timestamps, no speaker labels",
      enTranscript.json?.transcript?.language === "en" &&
        enTranscript.json?.transcript?.hasWordTimestamps === true &&
        enTranscript.json?.transcript?.speakerIdentificationAvailable === false &&
        enTranscript.json.transcript.segments.every((s) => s.speaker === null),
      JSON.stringify(enTranscript.json?.transcript?.language),
    );
    const enCandidates = await call(jar, "GET", `/api/projects/${en.projectId}/candidates?sort=score`);
    const candidates = enCandidates.json?.candidates ?? [];
    check(
      "1e. candidates >= 1 with score in range, reasons and excerpt",
      candidates.length >= 1 &&
        candidates.every(
          (c) =>
            c.score >= 0 &&
            c.score <= 100 &&
            Array.isArray(c.reasons) &&
            c.reasons.length >= 3 &&
            c.transcriptExcerpt.length > 0 &&
            c.duration >= 5,
        ),
      JSON.stringify(candidates.map((c) => ({ score: c.score, duration: c.duration }))),
    );
    const top = candidates[0];
    check(
      "1f. prompt influence: top candidate cites the instruction match in its reasons",
      candidates.some((c) => c.reasons.some((r) => r.includes("Matches your instruction"))),
      JSON.stringify(candidates.map((c) => c.reasons)),
    );

    // (1h/1i) Spec §6 sorts: shortest + longest duration must return
    // the same candidate set, correctly ordered by duration.
    const shortestRes = await call(jar, "GET", `/api/projects/${en.projectId}/candidates?sort=shortest`);
    const longestRes = await call(jar, "GET", `/api/projects/${en.projectId}/candidates?sort=longest`);
    const shortest = shortestRes.json?.candidates ?? [];
    const longest = longestRes.json?.candidates ?? [];
    const sameIdSet = (a, b) => a.length === b.length && a.every((c) => b.some((d) => d.id === c.id));
    check(
      "1h. sort=shortest returns the same candidates ordered by duration ascending",
      shortestRes.status === 200 &&
        sameIdSet(shortest, candidates) &&
        shortest.every((c, i) => i === 0 || shortest[i - 1].duration <= c.duration + 1e-9),
      JSON.stringify(shortest.map((c) => c.duration)),
    );
    check(
      "1i. sort=longest returns the same candidates ordered by duration descending",
      longestRes.status === 200 &&
        sameIdSet(longest, candidates) &&
        longest.every((c, i) => i === 0 || longest[i - 1].duration >= c.duration - 1e-9),
      JSON.stringify(longest.map((c) => c.duration)),
    );
    // Preview: real file, verified by ffprobe here in the test.
    const previewRes = await fetch(`${BASE}/api/candidates/${top.id}/preview`, {
      headers: { Cookie: jar.header() },
    });
    const previewFile = path.join(tmpDir, "preview.mp4");
    fs.writeFileSync(previewFile, Buffer.from(await previewRes.arrayBuffer()));
    const previewProbe = previewRes.status === 200 ? probe(previewFile) : { duration: 0, hasVideo: false, hasAudio: false };
    check(
      "1g. preview streams (200) and ffprobe verifies video+audio, duration within 1.5s of candidate",
      previewRes.status === 200 &&
        top.previewStatus === "READY" &&
        previewProbe.hasVideo &&
        previewProbe.hasAudio &&
        Math.abs(previewProbe.duration - top.duration) <= 1.5,
      `status=${previewRes.status} probe=${JSON.stringify(previewProbe)} candidate=${top.duration}`,
    );

    // (7) Refresh recovery: re-reading returns identical persisted state.
    const enJobAgain = await call(jar, "GET", `/api/analysis/${enJob.id}`);
    check(
      "7. job state persists across re-reads (refresh recovery)",
      enJobAgain.json?.job?.status === "COMPLETED" &&
        enJobAgain.json?.job?.candidateCount === enJob.candidateCount &&
        enJobAgain.json?.job?.transcriptId === enJob.transcriptId,
      JSON.stringify(enJobAgain.json?.job),
    );

    // (8) Candidate editing + cross-user protection.
    const patched = await call(jar, "PATCH", `/api/candidates/${top.id}`, {
      body: { title: "My edited hook title" },
      csrf,
    });
    const removed = await call(jar, "PATCH", `/api/candidates/${top.id}`, {
      body: { status: "REMOVED" },
      csrf,
    });
    check(
      "8a. PATCH candidate title + remove works",
      patched.status === 200 &&
        patched.json.candidate?.title === "My edited hook title" &&
        removed.status === 200 &&
        removed.json.candidate?.status === "REMOVED",
      `patch=${patched.status} remove=${removed.status}`,
    );
    const crossList = await call(B.jar, "GET", `/api/projects/${en.projectId}/candidates`);
    const crossPatch = await call(B.jar, "PATCH", `/api/candidates/${top.id}`, {
      body: { title: "Hijack" },
      csrf: B.csrf,
    });
    const crossPreview = await fetch(`${BASE}/api/candidates/${top.id}/preview`, {
      headers: { Cookie: B.jar.header() },
    });
    check(
      "8b. another user gets 404 on candidates list, PATCH and preview",
      crossList.status === 404 && crossPatch.status === 404 && crossPreview.status === 404,
      `list=${crossList.status} patch=${crossPatch.status} preview=${crossPreview.status}`,
    );

    // ---- (1c) Three candidate states: SELECTED / DESELECTED / REMOVED.
    // The English top candidate is REMOVED by now (8a). The PATCH
    // route accepts the widened enum (migration v10): restore it,
    // DESELECT it, and prove the deselect persists on reload as
    // DESELECTED — not REMOVED — then reselect.
    let rr = await call(jar, "PATCH", `/api/candidates/${top.id}`, { body: { status: "SELECTED" }, csrf });
    check(
      "8c. a REMOVED candidate can be restored to SELECTED",
      rr.status === 200 && rr.json?.candidate?.status === "SELECTED",
      JSON.stringify(rr.json).slice(0, 200),
    );
    rr = await call(jar, "PATCH", `/api/candidates/${top.id}`, { body: { status: "DESELECTED" }, csrf });
    check(
      "8d. deselect sets DESELECTED (not REMOVED)",
      rr.status === 200 && rr.json?.candidate?.status === "DESELECTED",
      JSON.stringify(rr.json).slice(0, 200),
    );
    rr = await call(jar, "GET", `/api/projects/${en.projectId}/candidates`);
    const afterDeselect = rr.json?.candidates?.find((c) => c.id === top.id);
    check(
      "8d2. DESELECTED persists on reload and is distinct from REMOVED",
      rr.status === 200 && afterDeselect?.status === "DESELECTED",
      JSON.stringify(afterDeselect).slice(0, 200),
    );
    rr = await call(jar, "PATCH", `/api/candidates/${top.id}`, { body: { status: "SELECTED" }, csrf });
    const reselectOk = rr.status === 200 && rr.json?.candidate?.status === "SELECTED";
    rr = await call(jar, "GET", `/api/projects/${en.projectId}/candidates`);
    const afterReselect = rr.json?.candidates?.find((c) => c.id === top.id);
    check(
      "8e. reselect from DESELECTED works and persists",
      reselectOk && afterReselect?.status === "SELECTED",
      JSON.stringify(afterReselect).slice(0, 200),
    );

    // ---- (2) Hindi analysis with language hint ----
    const hi = await projectWithUpload(jar, csrf, "HI Clips", hiMp4, "hi.mp4");
    await call(jar, "PATCH", `/api/projects/${hi.projectId}`, {
      body: { settings: { language: "hi" } },
      csrf,
    });
    const hiJobRes = await createJob(jar, csrf, hi.projectId, { sourceAssetId: hi.assetId, language: "hi" });
    const hiJob = await waitForJob(jar, hiJobRes.json.job.id);
    const hiTranscript = await call(jar, "GET", `/api/projects/${hi.projectId}/transcript`);
    const hiText = hiTranscript.json?.transcript?.fullText ?? "";
    // Actual output is logged for the completion report; wording
    // quality on synthetic speech is deliberately NOT asserted.
    console.log(`      HI transcript (small model, hi hint): ${hiText.slice(0, 200)}`);
    check(
      "2. Hindi job COMPLETES, language=hi, non-empty transcript",
      hiJob.status === "COMPLETED" &&
        hiTranscript.json?.transcript?.language === "hi" &&
        hiText.trim().length > 0,
      `job=${JSON.stringify(hiJob)} lang=${hiTranscript.json?.transcript?.language} textLen=${hiText.trim().length}`,
    );

    // ---- (3) Silent video → NO_SPEECH ----
    const silent = await projectWithUpload(jar, csrf, "Silent", silentMp4, "silent.mp4");
    const silentJobRes = await createJob(jar, csrf, silent.projectId, { sourceAssetId: silent.assetId });
    const silentJob = await waitForJob(jar, silentJobRes.json.job.id);
    check(
      "3. silent video COMPLETED with NO_SPEECH and 0 candidates",
      silentJob.status === "COMPLETED" && silentJob.outcome === "NO_SPEECH" && silentJob.candidateCount === 0,
      JSON.stringify(silentJob),
    );

    // ---- (4)+(5) Corrupted source → FAILED, retry re-fails cleanly ----
    const corrupt = await projectWithUpload(jar, csrf, "Corrupt", enMp4, "en.mp4");
    const corruptPath = path.join(mediaDir, A.user.id, `${corrupt.assetId}.mp4`);
    fs.writeFileSync(corruptPath, crypto.randomBytes(4096)); // corruption after a valid upload
    const corruptJobRes = await createJob(jar, csrf, corrupt.projectId, { sourceAssetId: corrupt.assetId });
    const corruptJob = await waitForJob(jar, corruptJobRes.json.job.id);
    check(
      "4. corrupted source -> job FAILED with stage + error message",
      corruptJob.status === "FAILED" && typeof corruptJob.error === "string" && corruptJob.error.length > 0,
      JSON.stringify(corruptJob),
    );
    const retryRes = await call(jar, "POST", `/api/analysis/${corruptJob.id}/retry`, { body: {}, csrf });
    check(
      "5a. retry of a FAILED job re-queues it (200, QUEUED)",
      retryRes.status === 200 && retryRes.json.job?.status === "QUEUED",
      `status=${retryRes.status} body=${JSON.stringify(retryRes.json)}`,
    );
    const retriedJob = await waitForJob(jar, corruptJob.id);
    check(
      "5b. retried corrupt job fails again cleanly (state machine correct)",
      retriedJob.status === "FAILED" && typeof retriedJob.error === "string" && retriedJob.error.length > 0,
      JSON.stringify(retriedJob),
    );

    // ---- (9)+(6) Duplicate protection + cancellation on a long job ----
    const longProj = await projectWithUpload(jar, csrf, "Long", longMp4, "long.mp4");
    const longJobRes = await createJob(jar, csrf, longProj.projectId, { sourceAssetId: longProj.assetId });
    const longJobId = longJobRes.json.job.id;
    const dupRes = await createJob(jar, csrf, longProj.projectId, { sourceAssetId: longProj.assetId });
    check(
      "9. duplicate job creation while active returns the existing job (200, deduplicated)",
      longJobRes.status === 201 &&
        dupRes.status === 200 &&
        dupRes.json.deduplicated === true &&
        dupRes.json.job?.id === longJobId,
      `first=${longJobRes.status} dup=${dupRes.status} body=${JSON.stringify(dupRes.json)}`,
    );
    // Wait until the worker has picked the job up, then cancel it.
    let pickedUp = false;
    for (let i = 0; i < 120; i += 1) {
      const res = await call(jar, "GET", `/api/analysis/${longJobId}`);
      if (res.json?.job && res.json.job.status !== "QUEUED") {
        pickedUp = true;
        break;
      }
      await sleep(250);
    }
    const cancelRes = await call(jar, "POST", `/api/analysis/${longJobId}/cancel`, { body: {}, csrf });
    const cancelledJob = await waitForJob(jar, longJobId, 180_000);
    check(
      "6. cancelling a running job ends in CANCELLED",
      pickedUp && cancelRes.status === 200 && cancelledJob.status === "CANCELLED",
      `pickedUp=${pickedUp} cancel=${cancelRes.status} final=${JSON.stringify(cancelledJob)}`,
    );

    // (10) The original EN source file is byte-identical after everything.
    check(
      "10. original uploaded source file unchanged (SHA-256 identical)",
      sha256File(enStoredPath) === enHashBefore,
      `before=${enHashBefore} after=${sha256File(enStoredPath)}`,
    );

    // (11) URL import → clip detection: the owner's core flow
    // ("URL dalne se clips aana"). The speech fixture is downloaded
    // by yt-dlp from the loopback fixture server, lands as the
    // project's source, and analysis runs on it unchanged.
    const impProjRes = await call(jar, "POST", "/api/projects", {
      body: { name: "URL Import Clips", workflowType: "LONG_VIDEO_TO_SHORTS" },
      csrf,
    });
    const impProjectId = impProjRes.json.project.id;
    const impRes = await call(jar, "POST", `/api/projects/${impProjectId}/url-import`, {
      body: { url: `${fixtureBase}/en.mp4` },
      csrf,
    });
    check(
      "11a. URL import accepted (201, URL_IMPORT job)",
      impRes.status === 201 && impRes.json.job?.kind === "URL_IMPORT",
      `status=${impRes.status} body=${JSON.stringify(impRes.json).slice(0, 300)}`,
    );
    const impJob = await waitForPhase8Job(jar, impRes.json.job.id);
    const impAssetId = impJob.result?.assetId;
    check(
      "11b. URL import COMPLETED via a real yt-dlp download of the speech fixture",
      impJob.status === "COMPLETED" && typeof impAssetId === "string",
      JSON.stringify(impJob).slice(0, 300),
    );
    const impAnalysisRes = await createJob(jar, csrf, impProjectId, {
      sourceAssetId: impAssetId,
      prompt: "Find powerful statements and questions and answers.",
    });
    check(
      "11c. analysis job created on the URL-imported source (201, QUEUED)",
      impAnalysisRes.status === 201 && impAnalysisRes.json.job?.status === "QUEUED",
      `status=${impAnalysisRes.status} body=${JSON.stringify(impAnalysisRes.json).slice(0, 300)}`,
    );
    const impAnalysisJob = await waitForJob(jar, impAnalysisRes.json.job.id);
    const impCandidates = await call(jar, "GET", `/api/projects/${impProjectId}/candidates?sort=score`);
    check(
      "11d. clip detection COMPLETED on the imported source and produced candidates",
      impAnalysisJob.status === "COMPLETED" && (impCandidates.json?.candidates?.length ?? 0) >= 1,
      `job=${JSON.stringify(impAnalysisJob).slice(0, 200)} candidates=${impCandidates.json?.candidates?.length}`,
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
  console.error("Clips E2E suite crashed:", err);
  process.exit(1);
});
