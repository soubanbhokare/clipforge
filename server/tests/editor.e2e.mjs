// CLIPFORGE Phase 5 — video editor & timeline end-to-end tests.
//
// Boots the real server on PORT=3104 with a temp SQLite DB + temp
// media/processing dirs, generates a real speech fixture with
// espeak-ng + ffmpeg, uploads it, runs the real Phase 4 analysis to
// obtain a generated candidate clip, then exercises the editor API
// exactly like the frontend does: document seeding, operations,
// undo/redo, captions, canvas, music upload, versions, and a REAL
// FFmpeg render verified with FFprobe.
//
// Browser-only behaviours (drag gestures, live playback) are NOT
// covered here by design — they are verified by code review + the
// frontend build, as the Phase 5 brief requires reporting honestly.
//
// Run: npm run test:editor   (from the server/ directory)

import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3104;
const BASE = `http://localhost:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-editor-e2e-"));
const dbFile = path.join(tmpDir, "test.db");
const mediaDir = path.join(tmpDir, "media");
const processingDir = path.join(tmpDir, "processing");
const fixturesDir = path.join(tmpDir, "fixtures");
fs.mkdirSync(fixturesDir, { recursive: true });
fs.mkdirSync(mediaDir, { recursive: true });

const EMAIL_A = "editor-a@example.com";
const EMAIL_B = "editor-b@example.com";
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
const clone = (v) => JSON.parse(JSON.stringify(v));
const approx = (a, b, tol) => Math.abs(a - b) <= tol;

// ---- fixtures -----------------------------------------------------------------

function ffmpeg(args) {
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "pipe" });
}

function buildSpeechMp4(sentences, voice, outName) {
  const work = fs.mkdtempSync(path.join(fixturesDir, "build-"));
  const parts = [];
  let idx = 0;
  const silence = path.join(work, "sil.wav");
  ffmpeg(["-f", "lavfi", "-i", "anullsrc=r=22050:cl=mono", "-t", "0.7", silence]);
  for (const sentence of sentences) {
    idx += 1;
    const wav = path.join(work, `s${idx}.wav`);
    execFileSync("espeak-ng", ["-v", voice, "-s", "150", "-w", wav, sentence], { stdio: "pipe" });
    parts.push(wav, silence);
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

console.log("Generating fixtures (espeak-ng + ffmpeg)…");
const enMp4 = buildSpeechMp4(EN_SENTENCES, "en", "en.mp4");
const toneMp3 = path.join(fixturesDir, "tone.mp3");
ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-c:a", "libmp3lame", toneMp3]);

function probe(file) {
  const out = execFileSync(
    "ffprobe",
    ["-v", "error", "-show_format", "-show_streams", "-of", "json", file],
    { encoding: "utf8" },
  );
  const data = JSON.parse(out);
  const video = data.streams.find((s) => s.codec_type === "video");
  return {
    duration: Number(data.format.duration),
    width: video?.width ?? null,
    height: video?.height ?? null,
    hasVideo: Boolean(video),
    hasAudio: data.streams.some((s) => s.codec_type === "audio"),
  };
}

// ---- http helpers (same pattern as the Phase 4 suite) ----------------------------

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

async function uploadToSession(jar, csrf, sessionId, filePath, filename) {
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
  if (session.status !== 201) throw new Error(`session ${name}: ${session.status}`);
  const up = await uploadToSession(jar, csrf, session.json.session.id, filePath, filename);
  if (up.status !== 200) throw new Error(`upload ${name}: ${up.status} ${JSON.stringify(up.json)}`);
  return { projectId, assetId: up.json.asset.id };
}

const TERMINAL = ["COMPLETED", "FAILED", "CANCELLED"];
async function waitForAnalysis(jar, jobId, timeoutMs = 600_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const res = await call(jar, "GET", `/api/analysis/${jobId}`);
    last = res.json?.job ?? null;
    if (last && TERMINAL.includes(last.status)) return last;
    await sleep(1500);
  }
  throw new Error(`analysis job ${jobId} did not finish (last=${JSON.stringify(last)})`);
}

async function waitForRender(jar, jobId, timeoutMs = 420_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const res = await call(jar, "GET", `/api/render-jobs/${jobId}`);
    last = res.json?.job ?? null;
    if (last && TERMINAL.includes(last.status)) return last;
    await sleep(1500);
  }
  throw new Error(`render job ${jobId} did not finish (last=${JSON.stringify(last)})`);
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

// ---- editor helpers ------------------------------------------------------------------

const DEFAULT_TRANSFORM = { crop: null, x: 0, y: 0, scale: 1, zoom: 1, rotation: 0, fit: "fill" };

function stateOf(doc) {
  return clone({
    canvas: doc.canvas,
    settings: doc.settings,
    tracks: doc.tracks,
    items: doc.items,
    captions: doc.captions,
    sceneOverrides: doc.sceneOverrides,
  });
}

async function applyOp(jar, csrf, docId, type, state) {
  const res = await call(jar, "POST", `/api/editor/${docId}/operations`, {
    body: { type, state },
    csrf,
  });
  if (res.status !== 200) {
    throw new Error(`op ${type} failed: ${res.status} ${JSON.stringify(res.json)}`);
  }
  return res.json.document;
}

async function getDoc(jar, projectId) {
  const res = await call(jar, "GET", `/api/projects/${projectId}/editor`);
  if (res.status !== 200) throw new Error(`getDoc failed: ${res.status} ${JSON.stringify(res.json)}`);
  return res.json.document;
}

const trackOf = (doc, kind) => doc.tracks.find((t) => t.kind === kind);
const itemsOn = (doc, trackId) => doc.items.filter((i) => i.trackId === trackId);

// ---- suite ------------------------------------------------------------------------------

async function main() {
  const proc = startServer();
  try {
    await waitForServer(proc);
    const A = await registerUser(EMAIL_A);
    const B = await registerUser(EMAIL_B);
    const { jar, csrf } = A;

    // Unauthenticated + CSRF behaviour on the new surface.
    const anonDoc = await call(null, "GET", "/api/projects/whatever/editor");
    check("0a. editor document requires auth (401)", anonDoc.status === 401, `got ${anonDoc.status}`);

    // ---- Real Phase 4 candidate to seed from ----
    const { projectId, assetId } = await projectWithUpload(jar, csrf, "Editor EN", enMp4, "en.mp4");
    const sourcePath = path.join(mediaDir, A.user.id, `${assetId}.mp4`);
    const sourceHashBefore = sha256File(sourcePath);
    const jobRes = await call(jar, "POST", `/api/projects/${projectId}/analysis`, {
      body: { sourceAssetId: assetId },
      csrf,
    });
    if (jobRes.status !== 201) throw new Error(`analysis create: ${jobRes.status} ${JSON.stringify(jobRes.json)}`);
    const job = await waitForAnalysis(jar, jobRes.json.job.id);
    check("setup. analysis COMPLETED with CLIPS_FOUND", job.status === "COMPLETED" && job.outcome === "CLIPS_FOUND", JSON.stringify(job));
    const candRes = await call(jar, "GET", `/api/projects/${projectId}/candidates?sort=score`);
    const candidate = (candRes.json?.candidates ?? []).find((c) => c.previewStatus === "READY");
    if (!candidate) throw new Error("no READY candidate to seed the editor from");
    const previewPath = path.join(mediaDir, A.user.id, "clips", `${candidate.id}.mp4`);
    const previewHashBefore = sha256File(previewPath);

    // ---- (1) Document seeded from the Phase 4 candidate ----
    const created = await call(jar, "GET", `/api/projects/${projectId}/editor?seedCandidateId=${candidate.id}`);
    check("1a. editor document created (201)", created.status === 201, `got ${created.status} ${JSON.stringify(created.json)?.slice(0, 200)}`);
    let doc = created.json.document;
    const docId = doc.id;
    const mainTrack = trackOf(doc, "main");
    const seedItem = doc.items.find((i) => i.trackId === mainTrack.id);
    check(
      "1b. main track seeded with the candidate clip",
      Boolean(seedItem) &&
        seedItem.assetKind === "candidate" &&
        seedItem.assetId === candidate.id &&
        approx(seedItem.sourceIn, candidate.startSec, 0.01) &&
        approx(seedItem.sourceOut, candidate.endSec, 0.01) &&
        doc.tracks.length === 5,
      JSON.stringify(seedItem),
    );
    check(
      "1c. captions seeded from the real transcript",
      doc.captions.length >= 1 && doc.captions.every((c) => c.text.length > 0 && c.end > c.start),
      `captions=${doc.captions.length}`,
    );
    check(
      "1d. library lists source, candidates and scenes",
      created.json.library?.sourceAsset?.id === assetId &&
        (created.json.library?.candidates?.length ?? 0) >= 1 &&
        Array.isArray(created.json.library?.topics),
      JSON.stringify(created.json.library?.sourceAsset?.id),
    );

    // CSRF: a mutation without the header is rejected.
    const noCsrf = await call(jar, "POST", `/api/editor/${docId}/operations`, {
      body: { type: "trim_item", state: stateOf(doc) },
    });
    check("0b. operation without CSRF token -> 403", noCsrf.status === 403, `got ${noCsrf.status}`);

    // ---- (2) Trim persists across a fresh GET (refresh recovery) ----
    const trimmedIn = seedItem.sourceIn + 2;
    const trimmedOut = seedItem.sourceOut - 2;
    {
      const state = stateOf(doc);
      const item = state.items.find((i) => i.id === seedItem.id);
      item.sourceIn = trimmedIn;
      item.sourceOut = trimmedOut;
      item.duration = trimmedOut - trimmedIn;
      doc = await applyOp(jar, csrf, docId, "trim_item", state);
    }
    const afterTrim = await getDoc(jar, projectId);
    const trimItem = afterTrim.items.find((i) => i.id === seedItem.id);
    check(
      "2. trim op changes source in/out and persists across GET",
      approx(trimItem.sourceIn, trimmedIn, 0.01) && approx(trimItem.sourceOut, trimmedOut, 0.01),
      JSON.stringify(trimItem),
    );
    doc = afterTrim;

    // ---- (3) Split at t produces two items with correct ranges ----
    const mid = (trimmedIn + trimmedOut) / 2;
    let itemA;
    let itemB;
    {
      const state = stateOf(doc);
      const idx = state.items.findIndex((i) => i.id === seedItem.id);
      const orig = state.items[idx];
      itemA = { ...clone(orig), sourceOut: mid, duration: mid - orig.sourceIn };
      itemB = {
        ...clone(orig),
        id: crypto.randomUUID(),
        sourceIn: mid,
        start: orig.start + (mid - orig.sourceIn),
        duration: orig.sourceOut - mid,
      };
      state.items.splice(idx, 1, itemA, itemB);
      doc = await applyOp(jar, csrf, docId, "split_item", state);
    }
    const mainItemsAfterSplit = itemsOn(doc, mainTrack.id);
    check(
      "3. split produces two items with contiguous source ranges",
      mainItemsAfterSplit.length === 2 &&
        approx(mainItemsAfterSplit[0].sourceOut, mid, 0.01) &&
        approx(mainItemsAfterSplit[1].sourceIn, mid, 0.01) &&
        approx(mainItemsAfterSplit[1].start, itemB.start, 0.01),
      JSON.stringify(mainItemsAfterSplit.map((i) => [i.sourceIn, i.sourceOut, i.start])),
    );

    // ---- (4) Duplicate + move + merge ----
    const brollTrack = trackOf(doc, "broll");
    const overlayTrack = trackOf(doc, "overlay");
    let cloneId;
    {
      const state = stateOf(doc);
      const src = state.items.find((i) => i.id === itemB.id);
      cloneId = crypto.randomUUID();
      state.items.push({ ...clone(src), id: cloneId, trackId: brollTrack.id, start: 0 });
      doc = await applyOp(jar, csrf, docId, "duplicate_item", state);
    }
    check(
      "4a. duplicate adds a copy of the item on the b-roll track",
      itemsOn(doc, brollTrack.id).some((i) => i.id === cloneId && i.assetId === itemB.assetId),
      JSON.stringify(itemsOn(doc, brollTrack.id)),
    );
    {
      const state = stateOf(doc);
      state.items.find((i) => i.id === cloneId).trackId = overlayTrack.id;
      doc = await applyOp(jar, csrf, docId, "move_item", state);
    }
    check(
      "4b. move reassigns the item to the overlay track",
      itemsOn(doc, overlayTrack.id).some((i) => i.id === cloneId) && itemsOn(doc, brollTrack.id).length === 0,
      "",
    );
    {
      const state = stateOf(doc);
      const a = state.items.find((i) => i.id === itemA.id);
      const merged = {
        ...clone(a),
        sourceOut: trimmedOut,
        duration: trimmedOut - trimmedIn,
      };
      state.items = state.items.filter((i) => i.id !== itemA.id && i.id !== itemB.id);
      state.items.push(merged);
      doc = await applyOp(jar, csrf, docId, "merge_items", state);
    }
    const mainAfterMerge = itemsOn(doc, mainTrack.id);
    check(
      "4c. merge recombines adjacent items into one with the full range",
      mainAfterMerge.length === 1 &&
        approx(mainAfterMerge[0].sourceIn, trimmedIn, 0.01) &&
        approx(mainAfterMerge[0].sourceOut, trimmedOut, 0.01),
      JSON.stringify(mainAfterMerge),
    );
    const mergedItemId = mainAfterMerge[0].id;

    // ---- (5) Undo x2, redo x1 ----
    // Ops so far: 1 trim, 2 split, 3 duplicate, 4 move, 5 merge.
    const undo1 = await call(jar, "POST", `/api/editor/${docId}/undo`, { body: {}, csrf });
    const undo2 = await call(jar, "POST", `/api/editor/${docId}/undo`, { body: {}, csrf });
    const stateAfterUndo2 = undo2.json.document;
    check(
      "5a. undo x2 returns the post-duplicate state (split items, clone on b-roll)",
      undo1.status === 200 &&
        undo2.status === 200 &&
        stateAfterUndo2.undoCursor === 3 &&
        itemsOn(stateAfterUndo2, mainTrack.id).length === 2 &&
        itemsOn(stateAfterUndo2, brollTrack.id).some((i) => i.id === cloneId) &&
        itemsOn(stateAfterUndo2, overlayTrack.id).length === 0,
      `cursor=${stateAfterUndo2.undoCursor}`,
    );
    const redo1 = await call(jar, "POST", `/api/editor/${docId}/redo`, { body: {}, csrf });
    doc = redo1.json.document;
    check(
      "5b. redo x1 reapplies the move (clone back on overlay)",
      redo1.status === 200 &&
        doc.undoCursor === 4 &&
        itemsOn(doc, overlayTrack.id).some((i) => i.id === cloneId) &&
        itemsOn(doc, mainTrack.id).length === 2,
      `cursor=${doc.undoCursor}`,
    );

    // ---- (6) Caption edit + split persist; other timings unchanged ----
    const caption0 = doc.captions[0];
    const caption1Before = doc.captions[1] ? clone(doc.captions[1]) : null;
    {
      const state = stateOf(doc);
      const cap = state.captions.find((c) => c.id === caption0.id);
      cap.text = "Edited caption line.";
      doc = await applyOp(jar, csrf, docId, "caption_update", state);
    }
    {
      const state = stateOf(doc);
      const idx = state.captions.findIndex((c) => c.id === caption0.id);
      const orig = state.captions[idx];
      const half = (orig.start + orig.end) / 2;
      const first = { ...clone(orig), end: half, words: null };
      const second = { ...clone(orig), id: crypto.randomUUID(), start: half, text: "Second half.", words: null };
      state.captions.splice(idx, 1, first, second);
      doc = await applyOp(jar, csrf, docId, "caption_split", state);
    }
    const editedCap = doc.captions.find((c) => c.id === caption0.id);
    const caption1After = caption1Before ? doc.captions.find((c) => c.id === caption1Before.id) : null;
    check(
      "6. caption edit + split persist; neighbouring caption timing unchanged",
      editedCap?.text === "Edited caption line." &&
        doc.captions.some((c) => c.text === "Second half.") &&
        (!caption1Before ||
          (approx(caption1After.start, caption1Before.start, 0.001) &&
            approx(caption1After.end, caption1Before.end, 0.001))),
      JSON.stringify({ edited: editedCap, count: doc.captions.length }),
    );

    // ---- (7) Canvas change persists ----
    const patched = await call(jar, "PATCH", `/api/editor/${docId}/settings`, {
      body: { canvas: { aspect: "custom", width: 720, height: 1280, custom: true } },
      csrf,
    });
    doc = patched.json.document;
    check(
      "7. canvas change to a custom 720x1280 persists",
      patched.status === 200 && doc.canvas.width === 720 && doc.canvas.height === 1280 && doc.canvas.custom === true,
      JSON.stringify(doc.canvas),
    );

    // ---- (8) Music: upload an audio asset and add it to the audio track ----
    const mediaForm = new FormData();
    mediaForm.append("file", new Blob([fs.readFileSync(toneMp3)], { type: "audio/mpeg" }), "tone.mp3");
    const mediaRes = await fetch(`${BASE}/api/projects/${projectId}/media`, {
      method: "POST",
      headers: { Cookie: jar.header(), "X-CSRF-Token": csrf },
      body: mediaForm,
    });
    const mediaJson = await mediaRes.json().catch(() => null);
    check(
      "8a. audio upload accepted as an AUDIO project asset (no video stream required)",
      mediaRes.status === 201 &&
        mediaJson?.media?.kind === "AUDIO" &&
        mediaJson?.media?.hasAudio === true &&
        mediaJson?.media?.hasVideo === false,
      `status=${mediaRes.status} body=${JSON.stringify(mediaJson)}`,
    );
    const toneId = mediaJson.media.id;
    const audioTrack = trackOf(doc, "audio");
    {
      const state = stateOf(doc);
      state.items.push({
        id: crypto.randomUUID(),
        trackId: audioTrack.id,
        assetKind: "media",
        assetId: toneId,
        start: 0,
        duration: 6,
        sourceIn: 0,
        sourceOut: 6,
        transform: { ...DEFAULT_TRANSFORM },
        speed: 1,
        volume: 0.5,
        fadeIn: 0.5,
        fadeOut: 0.5,
        layerOrder: 0,
      });
      doc = await applyOp(jar, csrf, docId, "add_item", state);
    }
    check(
      "8b. music item sits on the audio track and persists",
      itemsOn(doc, audioTrack.id).some((i) => i.assetId === toneId && approx(i.volume, 0.5, 0.001)),
      JSON.stringify(itemsOn(doc, audioTrack.id)),
    );

    // Expected render duration: the main track currently holds the two
    // split items covering the trimmed candidate range.
    const expectedDuration = itemsOn(doc, mainTrack.id).reduce((sum, i) => sum + i.duration, 0);

    // ---- (9) Render completes and FFprobe verifies the output ----
    const renderRes = await call(jar, "POST", `/api/editor/${docId}/render`, { body: {}, csrf });
    check("9a. render job created (201, QUEUED)", renderRes.status === 201 && renderRes.json.job?.status === "QUEUED", `status=${renderRes.status} ${JSON.stringify(renderRes.json)}`);
    const renderJob = await waitForRender(jar, renderRes.json.job.id);
    check(
      "9b. render job COMPLETED",
      renderJob.status === "COMPLETED",
      JSON.stringify(renderJob),
    );
    const dlRes = await fetch(`${BASE}/api/render-jobs/${renderJob.id}/download`, {
      headers: { Cookie: jar.header() },
    });
    const renderFile = path.join(tmpDir, "render.mp4");
    if (dlRes.status === 200) fs.writeFileSync(renderFile, Buffer.from(await dlRes.arrayBuffer()));
    const renderProbe = dlRes.status === 200 ? probe(renderFile) : { duration: 0, width: 0, height: 0, hasVideo: false, hasAudio: false };
    console.log(`      render probe: ${JSON.stringify(renderProbe)} expected duration ≈ ${expectedDuration.toFixed(2)}s, candidate duration ${candidate.duration.toFixed(2)}s`);
    check(
      "9c. output is 720x1280 (canvas honoured), has video+audio, duration within 0.75s of the timeline",
      dlRes.status === 200 &&
        renderProbe.width === 720 &&
        renderProbe.height === 1280 &&
        renderProbe.hasVideo &&
        renderProbe.hasAudio &&
        approx(renderProbe.duration, expectedDuration, 0.75),
      JSON.stringify(renderProbe),
    );
    check(
      "9d. trimmed render is shorter than the untrimmed candidate (trim really applied)",
      renderProbe.duration < candidate.duration - 3,
      `render=${renderProbe.duration} candidate=${candidate.duration}`,
    );

    // ---- (10) Cross-user protection ----
    const crossDoc = await call(B.jar, "GET", `/api/projects/${projectId}/editor`);
    const crossRender = await call(B.jar, "GET", `/api/render-jobs/${renderJob.id}`);
    const crossDownload = await fetch(`${BASE}/api/render-jobs/${renderJob.id}/download`, {
      headers: { Cookie: B.jar.header() },
    });
    const crossOp = await call(B.jar, "POST", `/api/editor/${docId}/operations`, {
      body: { type: "trim_item", state: stateOf(doc) },
      csrf: B.csrf,
    });
    check(
      "10. another user gets 404 on document, render job, download and operations",
      crossDoc.status === 404 && crossRender.status === 404 && crossDownload.status === 404 && crossOp.status === 404,
      `doc=${crossDoc.status} job=${crossRender.status} dl=${crossDownload.status} op=${crossOp.status}`,
    );

    // ---- (12) Named version snapshot + restore ----
    const versionRes = await call(jar, "POST", `/api/editor/${docId}/versions`, {
      body: { name: "Before extra trim" },
      csrf,
    });
    check("12a. version snapshot created", versionRes.status === 201 && Boolean(versionRes.json.version?.id), `status=${versionRes.status}`);
    const versionId = versionRes.json.version.id;
    const preTrimState = stateOf(await getDoc(jar, projectId));
    const mainItemNow = preTrimState.items.find((i) => i.trackId === mainTrack.id);
    const sourceInBeforeExtraTrim = mainItemNow.sourceIn;
    {
      const state = preTrimState;
      state.items.find((i) => i.id === mainItemNow.id).sourceIn += 1;
      state.items.find((i) => i.id === mainItemNow.id).duration -= 1;
      doc = await applyOp(jar, csrf, docId, "trim_item", state);
    }
    const restored = await call(jar, "POST", `/api/editor/${docId}/versions/${versionId}/restore`, {
      body: {},
      csrf,
    });
    const restoredMain = restored.json.document.items.find((i) => i.trackId === mainTrack.id);
    check(
      "12b. restoring the version brings back the pre-trim state",
      restored.status === 200 && approx(restoredMain.sourceIn, sourceInBeforeExtraTrim, 0.01),
      `status=${restored.status} sourceIn=${restoredMain?.sourceIn} expected=${sourceInBeforeExtraTrim}`,
    );

    // ---- (11) Originals untouched ----
    check(
      "11. original source + candidate preview files unchanged (SHA-256 identical)",
      sha256File(sourcePath) === sourceHashBefore && sha256File(previewPath) === previewHashBefore,
      "",
    );

    // ---- Bonus: unseeded project gets a source-seeded document ----
    const second = await projectWithUpload(jar, csrf, "Editor Source Seed", enMp4, "en.mp4");
    const secondDocRes = await call(jar, "GET", `/api/projects/${second.projectId}/editor`);
    const secondMain = secondDocRes.json?.document?.items?.find(
      (i) => i.trackId === trackOf(secondDocRes.json.document, "main").id,
    );
    check(
      "13. document without a seed candidate is seeded from the project source",
      secondDocRes.status === 201 && secondMain?.assetKind === "source" && secondMain?.assetId === second.assetId,
      `status=${secondDocRes.status} main=${JSON.stringify(secondMain)}`,
    );

    // ---- (14) Operation idempotency + optimistic concurrency ----
    const docForIdem = await getDoc(jar, projectId);
    const cursorBeforeIdem = docForIdem.undoCursor;
    const opCountBeforeIdem = docForIdem.opCount;
    const idemItemId = docForIdem.items.find((i) => i.trackId === mainTrack.id).id;
    const idemState = stateOf(docForIdem);
    idemState.items.find((i) => i.id === idemItemId).volume = 0.75;
    const operationId = crypto.randomUUID();
    const idemBody = { type: "update_item", state: idemState, operationId, baseCursor: cursorBeforeIdem };
    const idemFirst = await call(jar, "POST", `/api/editor/${docId}/operations`, { body: idemBody, csrf });
    check(
      "14a. operation with operationId + matching baseCursor commits exactly once",
      idemFirst.status === 200 &&
        idemFirst.json?.document?.opCount === opCountBeforeIdem + 1 &&
        idemFirst.json?.document?.undoCursor === cursorBeforeIdem + 1 &&
        approx(idemFirst.json?.document?.items?.find((i) => i.id === idemItemId)?.volume, 0.75, 0.001),
      `status=${idemFirst.status} opCount=${idemFirst.json?.document?.opCount} cursor=${idemFirst.json?.document?.undoCursor}`,
    );
    // A network retry of the SAME request (same operationId, same —
    // now stale — baseCursor, same state) must not append a second op.
    const idemRetry = await call(jar, "POST", `/api/editor/${docId}/operations`, { body: idemBody, csrf });
    check(
      "14b. retrying the same operationId appends no duplicate and returns the same state",
      idemRetry.status === 200 &&
        idemRetry.json?.document?.opCount === opCountBeforeIdem + 1 &&
        idemRetry.json?.document?.undoCursor === cursorBeforeIdem + 1 &&
        JSON.stringify(idemRetry.json?.document?.items) === JSON.stringify(idemFirst.json?.document?.items),
      `status=${idemRetry.status} opCount=${idemRetry.json?.document?.opCount} cursor=${idemRetry.json?.document?.undoCursor}`,
    );
    const staleState = stateOf(idemRetry.json.document);
    staleState.items.find((i) => i.id === idemItemId).volume = 0.5;
    const staleRes = await call(jar, "POST", `/api/editor/${docId}/operations`, {
      body: { type: "update_item", state: staleState, baseCursor: cursorBeforeIdem },
      csrf,
    });
    const docAfterStale = await getDoc(jar, projectId);
    check(
      "14c. a stale baseCursor is rejected with 409 and changes nothing",
      staleRes.status === 409 &&
        docAfterStale.opCount === opCountBeforeIdem + 1 &&
        docAfterStale.undoCursor === cursorBeforeIdem + 1 &&
        approx(docAfterStale.items.find((i) => i.id === idemItemId)?.volume, 0.75, 0.001),
      `status=${staleRes.status} opCount=${docAfterStale.opCount} volume=${docAfterStale.items.find((i) => i.id === idemItemId)?.volume}`,
    );

    // ---- (15) Scene override in the exact server shape round-trips ----
    const overrideId = crypto.randomUUID();
    const overrideState = stateOf(docAfterStale);
    overrideState.sceneOverrides = [
      {
        id: overrideId,
        topicSegmentId: null,
        rangeStart: 1,
        rangeEnd: 3,
        overrides: { zoom: 1.5, x: 0.1, fit: "fit" },
      },
    ];
    const docWithOverride = await applyOp(jar, csrf, docId, "scene_override", overrideState);
    const roundTripped = docWithOverride.sceneOverrides.find((o) => o.id === overrideId);
    check(
      "15. scene override {id, topicSegmentId, rangeStart, rangeEnd, overrides} round-trips unchanged",
      Boolean(roundTripped) &&
        approx(roundTripped.rangeStart, 1, 0.001) &&
        approx(roundTripped.rangeEnd, 3, 0.001) &&
        approx(roundTripped.overrides.zoom, 1.5, 0.001) &&
        approx(roundTripped.overrides.x, 0.1, 0.001) &&
        roundTripped.overrides.fit === "fit",
      JSON.stringify(docWithOverride.sceneOverrides),
    );

    // ---- (16) Phase 5 §12: add / remove tracks as operations ----
    let tdoc = docWithOverride;
    const trackCountBefore = tdoc.tracks.length;
    const addedTrackId = crypto.randomUUID();
    const addState = stateOf(tdoc);
    addState.tracks.push({
      id: addedTrackId,
      kind: "broll",
      label: "B-roll 2",
      order: 5,
      locked: false,
      visible: true,
      muted: false,
      solo: false,
    });
    tdoc = await applyOp(jar, csrf, docId, "track_add", addState);
    check(
      "16a. track_add appends one empty track",
      tdoc.tracks.length === trackCountBefore + 1 &&
        tdoc.tracks.some((t) => t.id === addedTrackId) &&
        !tdoc.items.some((i) => i.trackId === addedTrackId),
      JSON.stringify(tdoc.tracks.map((t) => t.kind)),
    );
    const rereadAfterAdd = await getDoc(jar, projectId);
    check(
      "16b. added track persists across re-reads",
      rereadAfterAdd.tracks.some((t) => t.id === addedTrackId),
    );
    // Adding two tracks in one operation is refused.
    const addTwoState = stateOf(tdoc);
    addTwoState.tracks.push(
      { id: crypto.randomUUID(), kind: "overlay", label: "Overlay 2", order: 6, locked: false, visible: true, muted: false, solo: false },
      { id: crypto.randomUUID(), kind: "audio", label: "Audio 2", order: 7, locked: false, visible: true, muted: false, solo: false },
    );
    const addTwoRes = await call(jar, "POST", `/api/editor/${docId}/operations`, {
      body: { type: "track_add", state: addTwoState },
      csrf,
    });
    check(
      "16c. track_add of two tracks at once is refused (400)",
      addTwoRes.status === 400,
      `status=${addTwoRes.status} ${JSON.stringify(addTwoRes.json)}`,
    );
    // Removing a NON-empty track is refused: pick whichever non-main
    // track currently holds items (the overlay track holds the moved
    // clone from the earlier sections) and propose removing it along
    // with its items — the guard judges the PERSISTED state, so the
    // refusal must cite the empty-only rule.
    const nonEmptyTrack16 = tdoc.tracks.find(
      (t) => t.kind !== "main" && t.kind !== "caption" && tdoc.items.some((i) => i.trackId === t.id),
    );
    const removeBusyState = stateOf(tdoc);
    removeBusyState.tracks = removeBusyState.tracks.filter((t) => t.id !== nonEmptyTrack16.id);
    removeBusyState.items = removeBusyState.items.filter((i) => i.trackId !== nonEmptyTrack16.id);
    const removeBusyRes = await call(jar, "POST", `/api/editor/${docId}/operations`, {
      body: { type: "track_remove", state: removeBusyState },
      csrf,
    });
    check(
      "16d. track_remove of a non-empty track is refused with the empty-only reason",
      Boolean(nonEmptyTrack16) &&
        removeBusyRes.status === 400 &&
        /empty/i.test(removeBusyRes.json?.error ?? ""),
      `status=${removeBusyRes.status} ${JSON.stringify(removeBusyRes.json)}`,
    );
    // Removing the ONLY caption track is refused.
    const captionTrack16 = trackOf(tdoc, "caption");
    const removeCaptionState = stateOf(tdoc);
    removeCaptionState.tracks = removeCaptionState.tracks.filter((t) => t.id !== captionTrack16.id);
    const removeCaptionRes = await call(jar, "POST", `/api/editor/${docId}/operations`, {
      body: { type: "track_remove", state: removeCaptionState },
      csrf,
    });
    check(
      "16e. track_remove of the only caption track is refused",
      removeCaptionRes.status === 400 && /caption/i.test(removeCaptionRes.json?.error ?? ""),
      `status=${removeCaptionRes.status} ${JSON.stringify(removeCaptionRes.json)}`,
    );
    // Removing the added EMPTY track works…
    const removeAddedState = stateOf(tdoc);
    removeAddedState.tracks = removeAddedState.tracks.filter((t) => t.id !== addedTrackId);
    tdoc = await applyOp(jar, csrf, docId, "track_remove", removeAddedState);
    check(
      "16f. track_remove removes the empty added track",
      tdoc.tracks.length === trackCountBefore && !tdoc.tracks.some((t) => t.id === addedTrackId),
      JSON.stringify(tdoc.tracks.map((t) => t.kind)),
    );
    // …and undo restores it (operations are undoable like any other).
    const undoTrack = await call(jar, "POST", `/api/editor/${docId}/undo`, { body: {}, csrf });
    check(
      "16g. undo restores the removed track",
      undoTrack.status === 200 && undoTrack.json.document.tracks.some((t) => t.id === addedTrackId),
      `status=${undoTrack.status}`,
    );
    const redoTrack = await call(jar, "POST", `/api/editor/${docId}/redo`, { body: {}, csrf });
    tdoc = redoTrack.json.document;
    check(
      "16h. redo removes it again (state consistent for later sections)",
      redoTrack.status === 200 && !tdoc.tracks.some((t) => t.id === addedTrackId),
    );

    // ---- (17) Phase 5: scene override RANGE is honoured by the render ----
    // Oracle: a fit:"fit" override letterboxes the (landscape) source
    // inside the portrait canvas — black bars appear ONLY where the
    // override applies. Raw frame-diffing across two renders is NOT a
    // valid oracle here (subdivision re-segments the encode, so even
    // untouched frames re-encode differently); bar presence is.
    async function renderCurrentDoc(tag) {
      const res = await call(jar, "POST", `/api/editor/${docId}/render`, { body: {}, csrf });
      if (res.status !== 201) throw new Error(`render ${tag} start failed: ${res.status} ${JSON.stringify(res.json)}`);
      const job = await waitForRender(jar, res.json.job.id);
      if (job.status !== "COMPLETED") throw new Error(`render ${tag} ended ${job.status}: ${job.error ?? ""}`);
      const dl = await fetch(`${BASE}/api/render-jobs/${job.id}/download`, {
        headers: { Cookie: jar.header() },
      });
      if (dl.status !== 200) throw new Error(`render ${tag} download failed: ${dl.status}`);
      const file = path.join(tmpDir, `range-${tag}.mp4`);
      fs.writeFileSync(file, Buffer.from(await dl.arrayBuffer()));
      return file;
    }
    const framePng = (video, t, name) => {
      const out = path.join(tmpDir, name);
      ffmpeg(["-ss", String(t), "-i", video, "-frames:v", "1", out]);
      return out;
    };
    // Mean luma of the top 6% band of a frame (the letterbox bar zone).
    const topBandLuma = (png, tag) => {
      const metaFile = path.join(tmpDir, `band-${tag}.txt`);
      execFileSync(
        "ffmpeg",
        ["-v", "info", "-i", png, "-vf", `crop=iw:ih*0.06:0:0,signalstats,metadata=print:file=${metaFile}`, "-f", "null", "-"],
        { stdio: "pipe" },
      );
      const meta = fs.readFileSync(metaFile, "utf8");
      const match = meta.match(/lavfi\.signalstats\.YAVG=([0-9.]+)/);
      return match ? Number(match[1]) : Number.NaN;
    };

    let rdoc = await applyOp(jar, csrf, docId, "scene_override_set", (() => {
      const s = stateOf(tdoc);
      s.sceneOverrides = [];
      // Isolate the main track for these two renders: b-roll/overlay
      // items composite OVER the main picture and would paint over
      // the very letterbox bars this section probes (in the full doc
      // the overlay clone covers the frame at the probe times, which
      // is correct editor behaviour — just useless as an oracle).
      const mainId = s.tracks.find((t) => t.kind === "main")?.id;
      s.items = s.items.filter((i) => i.trackId === mainId);
      return s;
    })());
    const mainTrack17 = trackOf(rdoc, "main");
    const mainItem17 = itemsOn(rdoc, mainTrack17.id).sort((a, b) => b.duration - a.duration)[0];
    const rangeStart = mainItem17.sourceIn + mainItem17.duration * 0.1;
    const rangeEnd = mainItem17.sourceIn + mainItem17.duration * 0.5;
    const srcInRange = mainItem17.sourceIn + mainItem17.duration * 0.3;
    const srcOutside = mainItem17.sourceIn + mainItem17.duration * 0.8;
    const tIn = mainItem17.start + (srcInRange - mainItem17.sourceIn) / mainItem17.speed;
    const tOut = mainItem17.start + (srcOutside - mainItem17.sourceIn) / mainItem17.speed;
    const renderA = await renderCurrentDoc("a");
    const rangeState = stateOf(rdoc);
    rangeState.sceneOverrides = [
      {
        id: crypto.randomUUID(),
        topicSegmentId: null,
        rangeStart: Math.round(rangeStart * 1000) / 1000,
        rangeEnd: Math.round(rangeEnd * 1000) / 1000,
        overrides: { fit: "fit" },
      },
    ];
    rdoc = await applyOp(jar, csrf, docId, "scene_override_set", rangeState);
    const persistedRange = rdoc.sceneOverrides[0];
    check(
      "17a. custom scene range persists through the operations endpoint",
      Boolean(persistedRange) &&
        approx(persistedRange.rangeStart, rangeStart, 0.01) &&
        approx(persistedRange.rangeEnd, rangeEnd, 0.01),
      JSON.stringify(rdoc.sceneOverrides),
    );
    const renderB = await renderCurrentDoc("b");
    const aInTop = topBandLuma(framePng(renderA, tIn, "a-in.png"), "a-in");
    const bInTop = topBandLuma(framePng(renderB, tIn, "b-in.png"), "b-in");
    const bOutTop = topBandLuma(framePng(renderB, tOut, "b-out.png"), "b-out");
    console.log(
      `      scene-range letterbox: A-inside top=${aInTop} B-inside top=${bInTop} B-outside top=${bOutTop} (tIn=${tIn.toFixed(2)} tOut=${tOut.toFixed(2)})`,
    );
    check(
      "17b. render honours the scene range: INSIDE the range the fit override letterboxes (black bar appears)",
      bInTop < 40 && aInTop > 80,
      `A-inside=${aInTop} B-inside=${bInTop}`,
    );
    check(
      "17c. render honours the scene range: OUTSIDE the range there is no letterbox bar",
      bOutTop > 80,
      `B-outside=${bOutTop}`,
    );

    // ---- (18) Centre-guides setting persists + defaults to guides ----
    const cgRes = await call(jar, "PATCH", `/api/editor/${docId}/settings`, {
      body: { settings: { centerGuides: false } },
      csrf,
    });
    check(
      "18a. centre-guides setting persists independently of showGuides",
      cgRes.status === 200 &&
        cgRes.json.document.settings.centerGuides === false &&
        cgRes.json.document.settings.showGuides === rdoc.settings.showGuides,
      JSON.stringify(cgRes.json?.document?.settings),
    );
    const freshProject = await projectWithUpload(jar, csrf, "Centre Guides Fresh", enMp4, "en.mp4");
    const freshDocRes = await call(jar, "GET", `/api/projects/${freshProject.projectId}/editor`);
    check(
      "18b. a fresh document's centreGuides defaults to its showGuides value",
      (freshDocRes.status === 200 || freshDocRes.status === 201) &&
        freshDocRes.json.document.settings.centerGuides === freshDocRes.json.document.settings.showGuides,
      `status=${freshDocRes.status} ${JSON.stringify(freshDocRes.json?.document?.settings)}`,
    );
  } finally {
    await stopServer(proc);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Editor E2E suite crashed:", err);
  process.exit(1);
});
