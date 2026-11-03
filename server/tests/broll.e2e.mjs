// Phase 8 B-roll / Enhancement / Background-processing e2e checks.
//
// Runs against a REAL spawned server (fresh temp DB + media dir).
// Fixtures are built with FFmpeg + espeak-ng in a temp dir:
//   speaker.mp4   — 3 spoken sentences (electric car / dashboard /
//                   cooking) over testsrc2; the transcript rows
//                   inserted for it carry the SAME sentences (the
//                   Phase 4/6 suites cover real STT provenance; this
//                   suite tests what Phase 8 does with transcript
//                   segments, incl. a Devanagari fixture inserted the
//                   same way the Phase 6 suite inserts its Hindi one).
//   car assets    — filenames carry the topical terms the matcher is
//                   expected to find in the transcript.
//   ocean asset   — no topical overlap: must NEVER be recommended.
//   shaky.mp4     — oscillating crop, for the vidstab two-pass job.
//
// Provider honesty is asserted, not assumed: stock import, AI
// generation and background removal all have NO provider configured
// on the main test server, so the suite expects 422
// CONFIGURATION_ERROR plus a persisted FAILED job — and would fail
// if any of them ever "succeeded" without a provider. A final
// section boots a SECOND server with PEXELS_API_KEY set and
// PEXELS_API_BASE pointed at a local mock Pexels API, and exercises
// the REAL adapter code (search → import job → download → library
// asset with credit metadata) against it — labelled mock coverage,
// not evidence of a real Pexels account.
//
// Run: npm run test:broll

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const PORT = 3231;
const BASE = `http://localhost:${PORT}`;

// NOTE: the scratch prefix deliberately does NOT match
// /tmp/clipforge-*: other suites and agents clean that glob
// between runs, and a cleanup landing mid-run would wipe this
// suite's live fixtures/DB/media (observed in practice).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cf8-broll-"));
process.env.PORT = String(PORT);
process.env.NODE_ENV = "test";
process.env.DATABASE_FILE = path.join(tmp, "test.db");
process.env.MEDIA_DIR = path.join(tmp, "media");
process.env.PROCESSING_DIR = path.join(tmp, "processing");

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, extra = "") {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`FAIL  ${name} ${extra}`);
  }
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed: ${(res.stderr || "").slice(-600)}`);
  }
  return res.stdout;
}

function ffprobeJson(file) {
  return JSON.parse(run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]));
}

function sha256Buffer(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** Mean luma of one frame (0..255) — the measurable brightness probe. */
function frameGrayMean(file, tSec) {
  run("ffmpeg", ["-v", "error", "-y", "-ss", String(tSec), "-i", file, "-frames:v", "1", path.join(tmp, "frame.png")]);
  const out = run(
    "ffmpeg",
    ["-v", "error", "-i", path.join(tmp, "frame.png"), "-vf", "format=gray", "-f", "rawvideo", "-"],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
  if (out.length === 0) return 0;
  let sum = 0;
  for (const b of out) sum += b;
  return sum / out.length;
}

function meanVolumeDb(file, fromSec, toSec) {
  const res = spawnSync(
    "ffmpeg",
    // volumedetect reports at info level — "-v error" would hide it.
    ["-v", "info", "-ss", String(fromSec), "-i", file, "-t", String(toSec - fromSec), "-af", "volumedetect", "-f", "null", "-"],
    { encoding: "utf8" },
  );
  const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(res.stderr || "");
  return m ? Number(m[1]) : null;
}

/** Mean volume of ONE narrow frequency band — isolates a test tone
 *  inside a mix (the ducking measurement: the music fixture is a
 *  440+554 Hz tone pair under broadband speech). */
function meanBandVolumeDb(file, fromSec, toSec, freq) {
  const res = spawnSync(
    "ffmpeg",
    ["-v", "info", "-ss", String(fromSec), "-i", file, "-t", String(toSec - fromSec),
     "-af", `bandpass=f=${freq}:width_type=h:w=40,volumedetect`, "-f", "null", "-"],
    { encoding: "utf8" },
  );
  const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(res.stderr || "");
  return m ? Number(m[1]) : null;
}

/** Mean volume of a single channel of a stereo file (balance test).
 *  Returns null for digital silence (volumedetect prints -inf) or a
 *  probe failure — callers treat null accordingly. */
function channelMeanVolumeDb(file, channelIdx) {
  const res = spawnSync(
    "ffmpeg",
    ["-v", "info", "-i", file,
     "-af", `channelsplit=channel_layout=stereo:channels=${channelIdx === 0 ? "FL" : "FR"},volumedetect`,
     "-f", "null", "-"],
    { encoding: "utf8" },
  );
  const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(res.stderr || "");
  return m ? Number(m[1]) : null;
}

class Client {
  constructor(base = BASE) {
    this.base = base;
    this.cookies = new Map();
    this.csrf = null;
  }
  cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  storeCookies(res) {
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const line of set) {
      const [pair] = line.split(";");
      const idx = pair.indexOf("=");
      if (idx > 0) this.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }
  async raw(method, url, { body, headers = {}, formData } = {}) {
    const finalHeaders = { ...headers };
    if (this.cookies.size) finalHeaders.Cookie = this.cookieHeader();
    if (body !== undefined && !formData) finalHeaders["Content-Type"] = "application/json";
    if (method !== "GET" && this.csrf) finalHeaders["X-CSRF-Token"] = this.csrf;
    const res = await fetch(`${this.base}${url}`, {
      method,
      headers: finalHeaders,
      body: formData ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
    this.storeCookies(res);
    return res;
  }
  async call(method, url, opts = {}) {
    const res = await this.raw(method, url, opts);
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    return { status: res.status, data };
  }
  async getCsrf() {
    const { data } = await this.call("GET", "/api/auth/csrf");
    this.csrf = data.csrfToken;
    return this.csrf;
  }
  async register(email) {
    await this.getCsrf();
    const pw = ["Str0ng", "Pass", "w0rd!"].join("");
    const res = await this.call("POST", "/api/auth/register", {
      body: { displayName: "Broll Tester", email, password: pw, confirmPassword: pw, termsAccepted: true },
    });
    if (res.status !== 201) throw new Error(`register failed: ${JSON.stringify(res.data)}`);
    return res.data.user;
  }
}

async function waitForHealth(timeoutMs = 30000, base = BASE) {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() - start > timeoutMs) throw new Error("server did not start in time");
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function waitForPhase8(client, jobId, timeoutMs = 300000) {
  const start = Date.now();
  for (;;) {
    const res = await client.call("GET", `/api/phase8-jobs/${jobId}`);
    const job = res.data.job;
    if (job && ["COMPLETED", "FAILED", "CANCELLED"].includes(job.status)) return job;
    if (Date.now() - start > timeoutMs) throw new Error(`phase8 job ${jobId} did not finish (stage ${job?.stage})`);
    await new Promise((r) => setTimeout(r, 600));
  }
}

async function waitForRender(client, jobId, timeoutMs = 600000) {
  const start = Date.now();
  for (;;) {
    const res = await client.call("GET", `/api/render-jobs/${jobId}`);
    const job = res.data.job;
    if (job && ["COMPLETED", "FAILED", "CANCELLED"].includes(job.status)) return job;
    if (Date.now() - start > timeoutMs) throw new Error(`render job ${jobId} did not finish`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// ---- fixtures ---------------------------------------------------------------

const SENTENCES = [
  "Today we review the new electric car in the city.",
  "The dashboard shows the battery level and the technology inside.",
  "Later we cook pasta with tomato sauce at home.",
];

function buildFixtures() {
  const dir = path.join(tmp, "fixtures");
  fs.mkdirSync(dir, { recursive: true });
  // Speaker: one clip per sentence so transcript segment boundaries
  // are the clips' real durations.
  const bounds = [];
  const parts = [];
  let cursor = 0;
  SENTENCES.forEach((text, i) => {
    const wav = path.join(dir, `sent${i}.wav`);
    run("espeak-ng", ["-v", "en", "-s", "140", "-w", wav, text]);
    const dur = Number(ffprobeJson(wav).format.duration);
    const clip = path.join(dir, `seg${i}.mp4`);
    run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=s=640x360:r=30:d=${dur.toFixed(2)}`, "-i", wav,
      "-map", "0:v", "-map", "1:a", "-t", dur.toFixed(2), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", clip]);
    bounds.push({ start: cursor, end: cursor + dur });
    cursor += dur;
    parts.push(clip);
  });
  fs.writeFileSync(path.join(dir, "list.txt"), parts.map((p) => `file '${p}'`).join("\n"));
  const speaker = path.join(dir, "speaker.mp4");
  run("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", path.join(dir, "list.txt"), "-c", "copy", speaker]);

  const plain = (name, pattern, seconds = 6) => {
    const out = path.join(dir, name);
    run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `${pattern}=s=640x360:r=30:d=${seconds}`,
      "-f", "lavfi", "-i", `sine=frequency=220:d=${seconds}`,
      "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", out]);
    return out;
  };
  const carDrive = plain("carDrive.mp4", "smptebars");
  const carInterior = plain("carInterior.mp4", "testsrc2");
  const ocean = plain("ocean.mp4", "rgbtestsrc");
  const hindi = plain("hindi.mp4", "smptehdbars");
  // Music: two-tone loop, audio only.
  const music = path.join(dir, "music.mp3");
  run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:d=8", "-f", "lavfi", "-i", "sine=frequency=554:d=8",
    "-filter_complex", "[0:a][1:a]amix=inputs=2:normalize=0", "-c:a", "libmp3lame", music]);
  // Shaky: oscillating crop window over a larger test pattern.
  const shaky = path.join(dir, "shaky.mp4");
  run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi",
    "-i", "testsrc2=s=800x450:r=30:d=8",
    "-f", "lavfi", "-i", "sine=frequency=330:d=8",
    "-vf", "crop=640:360:x='80+35*sin(2*PI*t*1.4)':y='45+22*cos(2*PI*t*1.1)'",
    "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", shaky]);
  return { dir, speaker, bounds, carDrive, carInterior, ocean, hindi, music, shaky };
}

async function uploadSource(client, projectId, filePath, filename) {
  const buf = fs.readFileSync(filePath);
  const session = await client.call("POST", `/api/projects/${projectId}/upload-session`, {
    body: { filename, size: buf.length },
  });
  if (session.status !== 201) throw new Error(`upload session failed: ${JSON.stringify(session.data)}`);
  const form = new FormData();
  form.append("file", new Blob([buf], { type: "video/mp4" }), filename);
  const res = await client.raw("POST", `/api/upload-sessions/${session.data.session.id}/file`, { formData: form });
  const data = await res.json().catch(() => null);
  if (res.status !== 200) throw new Error(`source upload failed ${res.status}: ${JSON.stringify(data)}`);
  return data.asset;
}

async function uploadMedia(client, projectId, filePath, filename, mime) {
  const buf = fs.readFileSync(filePath);
  const form = new FormData();
  form.append("file", new Blob([buf], { type: mime }), filename);
  const res = await client.raw("POST", `/api/projects/${projectId}/media`, { formData: form });
  const data = await res.json().catch(() => null);
  if (res.status !== 201) throw new Error(`media upload failed ${res.status}: ${JSON.stringify(data)}`);
  return data.media;
}

async function getDoc(client, projectId) {
  const res = await client.call("GET", `/api/projects/${projectId}/editor`);
  if (res.status !== 200 && res.status !== 201) throw new Error(`editor doc failed: ${res.status}`);
  return res.data;
}

console.log("Phase 8 broll e2e — spawning server on", BASE);
const fx = buildFixtures();
const server = spawn(path.join(serverDir, "node_modules", ".bin", "tsx"), ["src/index.ts"], {
  cwd: serverDir,
  env: { ...process.env },
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

try {
  await waitForHealth();
  const alice = new Client();
  const bob = new Client();
  await alice.register("alice-broll@example.com");
  await bob.register("bob-broll@example.com");

  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(process.env.DATABASE_FILE);
  const aliceRow = db.prepare("SELECT id FROM users WHERE email = ?").get("alice-broll@example.com");

  // ============================ EN project ==================================
  const proj = await alice.call("POST", "/api/projects", {
    body: { name: "EV Review", workflowType: "LONG_VIDEO_TO_SHORTS" },
  });
  const projectId = proj.data.project.id;
  const sourceAsset = await uploadSource(alice, projectId, fx.speaker, "speaker.mp4");
  const carDrive = await uploadMedia(alice, projectId, fx.carDrive, "electric-car-city-drive.mp4", "video/mp4");
  const carInterior = await uploadMedia(alice, projectId, fx.carInterior, "car-dashboard-interior.mp4", "video/mp4");
  const ocean = await uploadMedia(alice, projectId, fx.ocean, "ocean-waves-sunset.mp4", "video/mp4");
  const music = await uploadMedia(alice, projectId, fx.music, "background-music.mp3", "audio/mpeg");
  const shaky = await uploadMedia(alice, projectId, fx.shaky, "shaky-handheld.mp4", "video/mp4");
  let docRes = await getDoc(alice, projectId);
  let doc = docRes.document;
  check("editor doc seeded from the uploaded source", doc.items.length >= 1);

  // Insert the transcript fixture (same sentences the audio speaks).
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO processing_tasks (id, user_id, project_id, source_asset_id, status, stage, created_at, updated_at) VALUES ('en-task-8', ?, ?, ?, 'COMPLETED', 'COMPLETED', ?, ?)",
  ).run(aliceRow.id, projectId, sourceAsset.id, now, now);
  db.prepare(
    "INSERT INTO transcripts (id, task_id, project_id, source_asset_id, language, language_probability, duration, full_text, provider, model, created_at) VALUES ('en-transcript-8', 'en-task-8', ?, ?, 'en', 0.95, ?, ?, 'local-faster-whisper', 'small', ?)",
  ).run(projectId, sourceAsset.id, fx.bounds[2].end, SENTENCES.join(" "), now);
  SENTENCES.forEach((text, i) => {
    db.prepare(
      "INSERT INTO transcript_segments (id, transcript_id, idx, start_sec, end_sec, text, words_json) VALUES (?, 'en-transcript-8', ?, ?, ?, ?, NULL)",
    ).run(`en-seg-${i}`, i, fx.bounds[i].start, fx.bounds[i].end, text);
  });
  db.prepare(
    "INSERT INTO topic_segments (id, transcript_id, start_sec, end_sec, label, summary_text) VALUES ('en-topic-1', 'en-transcript-8', ?, ?, 'Electric car review', 'Reviewing the electric car, its dashboard and battery technology')",
  ).run(fx.bounds[0].start, fx.bounds[1].end);

  // ============================ provider status =============================
  const statusRes = await alice.call("GET", "/api/phase8/status");
  check("status: stock provider honestly not configured", statusRes.data.providers.stock.configured === false);
  check("status: generation provider honestly not configured", statusRes.data.providers.generation.configured === false);
  check("status: background removal honestly not configured", statusRes.data.providers.backgroundRemoval.configured === false);
  check("status: background detail names the missing model/provider", /segmentation|provider/i.test(statusRes.data.providers.backgroundRemoval.detail));
  check("status: stock adapter is implemented in this build (Pexels) but NOT configured without a key", statusRes.data.providers.stock.implemented === true && statusRes.data.providers.stock.id === "pexels", JSON.stringify(statusRes.data.providers.stock));
  check("status: generation adapter honestly reports implemented:false", statusRes.data.providers.generation.implemented === false, JSON.stringify(statusRes.data.providers.generation));
  check("status: background adapter honestly reports implemented:false", statusRes.data.providers.backgroundRemoval.implemented === false, JSON.stringify(statusRes.data.providers.backgroundRemoval));
  check("status: FFmpeg enhancement configured", statusRes.data.providers.enhancement.configured === true);

  // CSRF guard on a Phase 8 mutation.
  {
    const noCsrf = new Client();
    noCsrf.cookies = alice.cookies;
    const res = await noCsrf.raw("POST", `/api/projects/${projectId}/broll/recommendations`, { body: {} });
    check("recommendation create without CSRF is rejected (403)", res.status === 403, `got ${res.status}`);
  }

  // ============================ recommendations =============================
  const recJobRes = await alice.call("POST", `/api/projects/${projectId}/broll/recommendations`, { body: {} });
  check("recommendation job created (201)", recJobRes.status === 201, JSON.stringify(recJobRes.data).slice(0, 200));
  const recJob = await waitForPhase8(alice, recJobRes.data.job.id);
  check("recommendation job COMPLETED", recJob.status === "COMPLETED", recJob.error ?? "");
  check("job reports the windows analysed", (recJob.result.windowsAnalysed ?? 0) >= 3, JSON.stringify(recJob.result));

  const recsRes = await alice.call("GET", `/api/projects/${projectId}/broll/recommendations?status=PENDING`);
  const recs = recsRes.data.recommendations;
  check("exactly the two genuinely-matching windows get recommendations", recs.length === 2, `got ${recs.length}: ${recs.map((r) => r.assetFilename).join(", ")}`);
  const carRec = recs.find((r) => r.assetId === carDrive.id);
  const dashRec = recs.find((r) => r.assetId === carInterior.id);
  check("car window recommends the car-drive asset", Boolean(carRec));
  check("recommendation carries its matched terms as evidence", (carRec?.matchedTerms ?? []).includes("car"), JSON.stringify(carRec?.matchedTerms));
  check("recommendation quotes the real transcript passage", (carRec?.passage ?? "").includes("electric car"));
  check("recommendation score is a real overlap score (> 0.3)", (carRec?.score ?? 0) > 0.3, `score=${carRec?.score}`);
  check("dashboard window recommends the interior asset", Boolean(dashRec), JSON.stringify(recs.map((r) => r.assetFilename)));
  check("irrelevant ocean asset is never recommended", !recs.some((r) => r.assetId === ocean.id));
  check("cooking window yields no filler recommendation", !recs.some((r) => /pasta/i.test(r.passage)));
  check("recommendation exposes a real thumbnail URL", typeof carRec?.thumbnailUrl === "string" && carRec.thumbnailUrl.includes("/api/"));
  if (carRec?.thumbnailUrl) {
    const thumb = await alice.raw("GET", carRec.thumbnailUrl);
    check("recommendation thumbnail streams a real JPEG frame", thumb.status === 200 && (thumb.headers.get("content-type") ?? "").includes("image/jpeg"), `got ${thumb.status}`);
  }

  // ---- dismiss -------------------------------------------------------------
  const dismissRes = await alice.call("POST", `/api/broll-recommendations/${dashRec.id}/dismiss`, { body: {} });
  check("dismiss works", dismissRes.status === 200 && dismissRes.data.recommendation.status === "DISMISSED");
  const dismissAgain = await alice.call("POST", `/api/broll-recommendations/${dashRec.id}/dismiss`, { body: {} });
  check("double dismiss is a 409", dismissAgain.status === 409, `got ${dismissAgain.status}`);

  // ---- replace -------------------------------------------------------------
  const replaceRes = await alice.call("POST", `/api/broll-recommendations/${carRec.id}/replace`, { body: {} });
  check("replace returns the genuine alternative asset", replaceRes.status === 201 && replaceRes.data.recommendation.assetId === carInterior.id, JSON.stringify(replaceRes.data).slice(0, 200));
  const replacement = replaceRes.data.recommendation;
  const replaceAgain = await alice.call("POST", `/api/broll-recommendations/${replacement.id}/replace`, { body: {} });
  check("replace with no remaining alternative is a 409", replaceAgain.status === 409 && replaceAgain.data.error?.code === "NO_ALTERNATIVE", JSON.stringify(replaceAgain.data).slice(0, 200));

  // ---- accept -> placement ---------------------------------------------------
  const acceptRes = await alice.call("POST", `/api/broll-recommendations/${replacement.id}/accept`, { body: {} });
  check("accept creates a placement (201)", acceptRes.status === 201, JSON.stringify(acceptRes.data).slice(0, 240));
  const placement = acceptRes.data.placement;
  check("placement start was mapped from source time", acceptRes.data.mappedFromSourceTime === true);
  docRes = await getDoc(alice, projectId);
  doc = docRes.document;
  const brollTrack = doc.tracks.find((t) => t.kind === "broll");
  const placedItem = doc.items.find((i) => i.id === placement.itemId);
  check("timeline gained the B-roll item on the B-roll track", Boolean(placedItem) && placedItem.trackId === brollTrack.id);
  check("placed B-roll starts muted so speech is uninterrupted", placedItem?.volume === 0);
  const acceptAgain = await alice.call("POST", `/api/broll-recommendations/${replacement.id}/accept`, { body: {} });
  check("double accept is a 409", acceptAgain.status === 409, `got ${acceptAgain.status}`);

  // ---- placement edit + delete ----------------------------------------------
  const patchRes = await alice.call("PATCH", `/api/broll-placements/${placement.id}`, {
    body: { startSec: 0.5, durationSec: 2, displayMode: "PIP" },
  });
  check("placement edit persists", patchRes.status === 200 && patchRes.data.placement.displayMode === "PIP" && patchRes.data.placement.durationSec === 2);
  docRes = await getDoc(alice, projectId);
  const pipItem = docRes.document.items.find((i) => i.id === placement.itemId);
  check("PiP mode reached the timeline transform (scale 0.35)", pipItem?.transform.scale === 0.35, JSON.stringify(pipItem?.transform));
  check("placement edit moved the item start", pipItem?.start === 0.5);
  const delPlacement = await alice.call("DELETE", `/api/broll-placements/${placement.id}`);
  check("placement delete works", delPlacement.status === 200);
  docRes = await getDoc(alice, projectId);
  check("deleted placement's item is gone from the timeline", !docRes.document.items.some((i) => i.id === placement.itemId));
  const afterDelete = await alice.call("GET", `/api/projects/${projectId}/broll/recommendations?status=PENDING`);
  check("recommendation returns to PENDING after placement removal", afterDelete.data.recommendations.some((r) => r.id === replacement.id));

  // Re-accept for the render + delete-in-use tests (fullscreen, at 0.5s, 3s).
  const accept2 = await alice.call("POST", `/api/broll-recommendations/${replacement.id}/accept`, {
    body: { startSec: 0.5, durationSec: 3, displayMode: "FULLSCREEN" },
  });
  check("re-accept after delete works", accept2.status === 201, JSON.stringify(accept2.data).slice(0, 200));
  const placement2 = accept2.data.placement;

  // ---- add music to the audio track via a normal editor operation -----------
  docRes = await getDoc(alice, projectId);
  doc = docRes.document;
  const audioTrack = doc.tracks.find((t) => t.kind === "audio");
  const musicDur = music.duration ?? 8;
  const state = {
    canvas: doc.canvas, settings: doc.settings, tracks: doc.tracks,
    items: [...doc.items, {
      id: crypto.randomUUID(), trackId: audioTrack.id, assetKind: "media", assetId: music.id,
      start: 0, duration: musicDur, sourceIn: 0, sourceOut: musicDur,
      transform: { crop: null, x: 0, y: 0, scale: 1, zoom: 1, rotation: 0, fit: "fill" },
      speed: 1, volume: 0.8, fadeIn: 0, fadeOut: 0, layerOrder: 0,
    }],
    captions: doc.captions, sceneOverrides: doc.sceneOverrides,
  };
  const opRes = await alice.call("POST", `/api/editor/${doc.id}/operations`, {
    body: { type: "test_add_music", state, operationId: crypto.randomUUID(), baseCursor: doc.undoCursor },
  });
  check("music item added through the editor operations API", opRes.status === 200, JSON.stringify(opRes.data).slice(0, 200));
  doc = opRes.data.document;

  // ---- plain render (brightness baseline) ------------------------------------
  const plainRender = await alice.call("POST", `/api/editor/${doc.id}/render`, { body: {} });
  const plainJob = await waitForRender(alice, plainRender.data.job.id);
  check("plain render COMPLETED", plainJob.status === "COMPLETED", plainJob.error ?? "");
  check("plain render is not flagged enhanced", plainJob.settings.enhanced === false);
  const plainFile = path.join(tmp, "plain.mp4");
  {
    const res = await alice.raw("GET", `/api/render-jobs/${plainJob.id}/download`);
    fs.writeFileSync(plainFile, Buffer.from(await res.arrayBuffer()));
  }
  const plainMean = frameGrayMean(plainFile, 1);
  const plainSpeech = meanVolumeDb(plainFile, 0.6, 3.4);
  check("plain render keeps speech audible under B-roll", plainSpeech !== null && plainSpeech > -45, `mean=${plainSpeech}`);

  // ---- enhancement config + enhanced render ----------------------------------
  const cfgPut = await alice.call("PUT", `/api/editor/${doc.id}/enhancement`, {
    body: {
      videoEnabled: true,
      audioEnabled: true,
      video: { brightness: 0.3 },
      audio: { denoise: 0.5, normalize: "loudnorm", ducking: { enabled: true, amount: 0.7 } },
      scope: "project",
      itemIds: [],
    },
  });
  check("enhancement config saves", cfgPut.status === 200 && cfgPut.data.config.videoEnabled === true, JSON.stringify(cfgPut.data).slice(0, 240));
  check("config merges with defaults honestly", cfgPut.data.config.video.contrast === 1 && cfgPut.data.config.audio.ducking.enabled === true);
  const cfgGet = await alice.call("GET", `/api/editor/${doc.id}/enhancement`);
  check("enhancement config reads back", cfgGet.data.config.video.brightness === 0.3);

  const enhRender = await alice.call("POST", `/api/editor/${doc.id}/render-enhanced`, { body: {} });
  check("enhanced render created", enhRender.status === 201, JSON.stringify(enhRender.data).slice(0, 200));
  const enhJob = await waitForRender(alice, enhRender.data.job.id);
  check("enhanced render COMPLETED (ducking graph + chains valid)", enhJob.status === "COMPLETED", enhJob.error ?? "");
  check("enhanced render is flagged enhanced", enhJob.settings.enhanced === true, JSON.stringify(enhJob.settings));
  const enhFile = path.join(tmp, "enhanced.mp4");
  {
    const res = await alice.raw("GET", `/api/render-jobs/${enhJob.id}/download`);
    fs.writeFileSync(enhFile, Buffer.from(await res.arrayBuffer()));
  }
  const enhProbe = ffprobeJson(enhFile);
  check("enhanced render has an audio stream (never discarded)", enhProbe.streams.some((s) => s.codec_type === "audio"));
  const enhMean = frameGrayMean(enhFile, 1);
  check("brightness enhancement measurably changes the picture", enhMean > plainMean + 3, `plain=${plainMean.toFixed(1)} enhanced=${enhMean.toFixed(1)}`);
  const enhSpeech = meanVolumeDb(enhFile, 0.6, 3.4);
  check("speech stays audible under B-roll + ducked music (A/V sync kept)", enhSpeech !== null && enhSpeech > -45, `mean=${enhSpeech}`);
  const totalDur = fx.bounds[2].end;
  check(
    "enhanced render duration matches the timeline (sync)",
    Math.abs(Number(enhProbe.format.duration) - totalDur) <= 1.0,
    `${enhProbe.format.duration} vs ${totalDur}`,
  );

  // ============ client wire-shape settings (Phase 8 gap fixes) ============
  // These payloads mirror src/services/phase8.ts + EnhancePanel.tsx
  // EXACTLY: complete settings objects with the client's field
  // names/nesting — whiteBalanceK as a NUMBER (the client's neutral
  // 6500), nested upscale/fps/stabilization/hum/ducking objects, and
  // the gap-fix fields (detail, cropCompensation, echoReduction,
  // balance, volumeAutomation) — never server-shaped partials, so a
  // client/server contract drift fails here first.
  const clientVideoSettings = (patch = {}) => ({
    denoise: 0, sharpen: 0, detail: 0, artifactReduction: 0,
    brightness: 0, contrast: 1, saturation: 1, exposure: 0, gamma: 1,
    temperature: 0, tint: 0, highlights: 0, shadows: 0, whiteBalanceK: 6500,
    blur: 0, vignette: 0, grayscale: false,
    upscale: { enabled: false, width: 1920, height: 1080 },
    fps: { target: null, interpolate: false },
    stabilization: { enabled: false, strength: 0.5, smoothing: 15, cropCompensation: 0.5 },
    ...patch,
  });
  const clientAudioSettings = (patch = {}) => ({
    denoise: 0, normalize: "off", targetLufs: -16, clarity: 0,
    hum: { enabled: false, freq: 50 },
    gainDb: 0, fadeInSec: 0, fadeOutSec: 0,
    echoReduction: 0, balance: 0, volumeAutomation: [],
    ducking: { enabled: false, amount: 0.5 },
    ...patch,
  });

  // ---- ducking MEASURED (gap fix: completion alone proved nothing) --------
  // Two renders of the SAME timeline (speech on the main track, the
  // music stem on the audio track), identical except ducking on/off.
  // A narrow bandpass at 440 Hz isolates the music tone inside the
  // mix; the speech content is identical in both renders, so the
  // band-level difference IS the ducking gain.
  const duckWindow = { from: 0.4, to: Math.max(1.4, fx.bounds[0].end - 0.3) };
  const renderWithDucking = async (ducking) => {
    const put = await alice.call("PUT", `/api/editor/${doc.id}/enhancement`, {
      body: {
        videoEnabled: false,
        audioEnabled: true,
        video: clientVideoSettings(),
        audio: clientAudioSettings({ ducking }),
        scope: "project",
        itemIds: [],
      },
    });
    check(`ducking ${ducking.enabled ? "ON" : "OFF"} config saves (client wire shape)`, put.status === 200, JSON.stringify(put.data).slice(0, 200));
    const created = await alice.call("POST", `/api/editor/${doc.id}/render-enhanced`, { body: {} });
    const job = await waitForRender(alice, created.data.job.id);
    const file = path.join(tmp, ducking.enabled ? "duck-on.mp4" : "duck-off.mp4");
    const res = await alice.raw("GET", `/api/render-jobs/${job.id}/download`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    return { job, file };
  };
  const duckOff = await renderWithDucking({ enabled: false, amount: 0.5 });
  check("ducking-OFF comparison render COMPLETED", duckOff.job.status === "COMPLETED", duckOff.job.error ?? "");
  const duckOn = await renderWithDucking({ enabled: true, amount: 1 });
  check("ducking-ON render COMPLETED", duckOn.job.status === "COMPLETED", duckOn.job.error ?? "");
  const musicBandOff = meanBandVolumeDb(duckOff.file, duckWindow.from, duckWindow.to, 440);
  const musicBandOn = meanBandVolumeDb(duckOn.file, duckWindow.from, duckWindow.to, 440);
  check("music band level is measurable in both renders", musicBandOff !== null && musicBandOn !== null, `off=${musicBandOff} on=${musicBandOn}`);
  check(
    "ducking MEASURABLY lowers the music under speech (>= 3 dB at 440 Hz)",
    musicBandOff !== null && musicBandOn !== null && musicBandOn <= musicBandOff - 3,
    `off=${musicBandOff} dB on=${musicBandOn} dB`,
  );

  // ---- before/after preview job ----------------------------------------------
  const previewRes = await alice.call("POST", `/api/projects/${projectId}/enhancement-jobs`, {
    body: { assetRef: `source:${sourceAsset.id}`, video: { brightness: 0.4 }, preview: true },
  });
  check("preview job created", previewRes.status === 201, JSON.stringify(previewRes.data).slice(0, 200));
  const previewJob = await waitForPhase8(alice, previewRes.data.job.id);
  check("preview job COMPLETED", previewJob.status === "COMPLETED", previewJob.error ?? "");
  const beforeFile = path.join(tmp, "before.mp4");
  const afterFile = path.join(tmp, "after.mp4");
  {
    const b = await alice.raw("GET", previewJob.result.beforeUrl);
    const a = await alice.raw("GET", previewJob.result.afterUrl);
    check("before/after previews stream", b.status === 200 && a.status === 200, `${b.status}/${a.status}`);
    fs.writeFileSync(beforeFile, Buffer.from(await b.arrayBuffer()));
    fs.writeFileSync(afterFile, Buffer.from(await a.arrayBuffer()));
  }
  const beforeMean = frameGrayMean(beforeFile, 1);
  const afterMean = frameGrayMean(afterFile, 1);
  check("after-preview is measurably brighter than before", afterMean > beforeMean + 3, `before=${beforeMean.toFixed(1)} after=${afterMean.toFixed(1)}`);
  check("preview result lists the real filters applied", (previewJob.result.appliedVideoFilters ?? []).some((f) => f.startsWith("eq=")), JSON.stringify(previewJob.result.appliedVideoFilters));

  // ---- asset enhancement job: upscale (scale-only) + sharpen ------------------
  const carStreamBefore = await alice.raw("GET", `/api/project-media/${carDrive.id}/stream`);
  const carShaBefore = sha256Buffer(Buffer.from(await carStreamBefore.arrayBuffer()));
  const upRes = await alice.call("POST", `/api/projects/${projectId}/enhancement-jobs`, {
    body: {
      assetRef: `media:${carDrive.id}`,
      video: { sharpen: 0.5, upscale: { enabled: true, width: 1280, height: 720 } },
    },
  });
  const upJob = await waitForPhase8(alice, upRes.data.job.id);
  check("upscale enhancement job COMPLETED", upJob.status === "COMPLETED", upJob.error ?? "");
  check("upscaled output really is 1280x720", upJob.result.width === 1280 && upJob.result.height === 720, JSON.stringify(upJob.result).slice(0, 200));
  check("upscale carries the no-detail-reconstruction note", /does not reconstruct detail/i.test(upJob.result.note ?? ""), upJob.result.note ?? "(no note)");
  check("derived asset registered as a media asset", typeof upJob.result.derivedMediaId === "string");
  const libGen = await alice.call("GET", `/api/media-library?category=${encodeURIComponent("Generated Assets")}`);
  check("derived asset appears in the library under Generated Assets", libGen.data.assets.some((a) => a.ref === upJob.result.derivedRef));
  const carStreamAfter = await alice.raw("GET", `/api/project-media/${carDrive.id}/stream`);
  const carShaAfter = sha256Buffer(Buffer.from(await carStreamAfter.arrayBuffer()));
  check("original B-roll file is byte-identical after enhancement", carShaBefore === carShaAfter);

  // ---- stabilization job (vidstab two-pass) ------------------------------------
  const stabRes = await alice.call("POST", `/api/projects/${projectId}/enhancement-jobs`, {
    body: { assetRef: `media:${shaky.id}`, video: { stabilization: { enabled: true, strength: 0.7, smoothing: 20 } } },
  });
  const stabJobId = stabRes.data.job.id;
  // While it runs, queue a second job and cancel it deterministically.
  const queuedRes = await alice.call("POST", `/api/projects/${projectId}/enhancement-jobs`, {
    body: { assetRef: `media:${ocean.id}`, video: { brightness: 0.1 } },
  });
  const cancelRes = await alice.call("POST", `/api/phase8-jobs/${queuedRes.data.job.id}/cancel`, { body: {} });
  const cancelledJob = await waitForPhase8(alice, queuedRes.data.job.id).catch(() => cancelRes.data.job);
  check(
    "queued job can be cancelled",
    cancelRes.status === 200 && (cancelRes.data.job.status === "CANCELLED" || cancelledJob.status === "CANCELLED"),
    JSON.stringify(cancelRes.data).slice(0, 200),
  );
  const midGet = await alice.call("GET", `/api/phase8-jobs/${stabJobId}`);
  check("job state is persisted and readable mid-flight (refresh recovery)", midGet.status === 200 && typeof midGet.data.job.stage === "string");
  const stabJob = await waitForPhase8(alice, stabJobId);
  check("stabilization job COMPLETED", stabJob.status === "COMPLETED", stabJob.error ?? "");
  check("stabilization reports the two-pass transform was applied", stabJob.result.stabilized === true);
  check("stabilized output is a valid video of the same length", stabJob.result.hasVideo === true && Math.abs((stabJob.result.duration ?? 0) - 8) <= 1.0, JSON.stringify(stabJob.result).slice(0, 200));

  // ---- audio enhancement job on the music asset ---------------------------------
  const audioRes = await alice.call("POST", `/api/projects/${projectId}/enhancement-jobs`, {
    body: { assetRef: `media:${music.id}`, audio: { denoise: 0.6, normalize: "loudnorm", targetLufs: -16 } },
  });
  const audioJob = await waitForPhase8(alice, audioRes.data.job.id);
  check("audio enhancement job COMPLETED", audioJob.status === "COMPLETED", audioJob.error ?? "");
  check("audio job applied afftdn + loudnorm for real", (audioJob.result.appliedAudioFilters ?? []).some((f) => f.startsWith("afftdn=")) && (audioJob.result.appliedAudioFilters ?? []).some((f) => f.startsWith("loudnorm=")), JSON.stringify(audioJob.result.appliedAudioFilters));
  check("enhanced audio keeps its duration", Math.abs((audioJob.result.duration ?? 0) - musicDur) <= 0.7, `${audioJob.result.duration} vs ${musicDur}`);

  // ---- failing job + retry -------------------------------------------------------
  const badPreview = await alice.call("POST", `/api/projects/${projectId}/enhancement-jobs`, {
    body: { assetRef: `media:${music.id}`, preview: true },
  });
  const badJob = await waitForPhase8(alice, badPreview.data.job.id);
  check("preview of an audio-only asset fails honestly (NO_VIDEO)", badJob.status === "FAILED" && badJob.errorCode === "NO_VIDEO", JSON.stringify(badJob).slice(0, 200));
  const retryRes = await alice.call("POST", `/api/phase8-jobs/${badJob.id}/retry`, { body: {} });
  check("failed job can be retried", retryRes.status === 200 && retryRes.data.job.status === "QUEUED");
  const retriedJob = await waitForPhase8(alice, badJob.id);
  check("retried job fails the same honest way (no fake success)", retriedJob.status === "FAILED" && retriedJob.errorCode === "NO_VIDEO");

  // ---- dedupe of identical active jobs --------------------------------------------
  const dupA = alice.call("POST", `/api/projects/${projectId}/enhancement-jobs`, {
    body: { assetRef: `media:${shaky.id}`, video: { stabilization: { enabled: true, strength: 0.5, smoothing: 15 }, upscale: { enabled: true, width: 1280, height: 720 } } },
  });
  const dupB = alice.call("POST", `/api/projects/${projectId}/enhancement-jobs`, {
    body: { assetRef: `media:${shaky.id}`, video: { stabilization: { enabled: true, strength: 0.5, smoothing: 15 }, upscale: { enabled: true, width: 1280, height: 720 } } },
  });
  const [dupARes, dupBRes] = await Promise.all([dupA, dupB]);
  check(
    "identical simultaneous jobs are deduplicated",
    dupARes.data.job.id === dupBRes.data.job.id && (dupARes.data.deduplicated || dupBRes.data.deduplicated),
    `${dupARes.data.job.id} vs ${dupBRes.data.job.id}`,
  );
  await waitForPhase8(alice, dupARes.data.job.id);

  // ---- provider operations: honest 422s --------------------------------------------
  const importRes = await alice.call("POST", `/api/projects/${projectId}/broll/import`, {
    body: { provider: "pexels", providerAssetId: "abc123" },
  });
  check("stock import without a provider is 422 CONFIGURATION_ERROR", importRes.status === 422 && importRes.data.error?.code === "CONFIGURATION_ERROR", JSON.stringify(importRes.data).slice(0, 200));
  check("failed import leaves a persisted FAILED job", importRes.data.job?.status === "FAILED" && importRes.data.job?.kind === "PROVIDER_IMPORT");
  const genRes = await alice.call("POST", `/api/projects/${projectId}/broll/generate`, {
    body: { prompt: "A red car driving through a city at dusk", mediaKind: "video" },
  });
  check("AI generation without a provider is 422 CONFIGURATION_ERROR", genRes.status === 422 && genRes.data.error?.code === "CONFIGURATION_ERROR");
  check("failed generation leaves a persisted FAILED job", genRes.data.job?.status === "FAILED" && genRes.data.job?.kind === "AI_GENERATION");
  const bgRes = await alice.call("POST", `/api/projects/${projectId}/background-jobs`, {
    body: { assetRef: `source:${sourceAsset.id}`, mode: "blur" },
  });
  check("background removal without a model is 422 CONFIGURATION_ERROR", bgRes.status === 422 && bgRes.data.error?.code === "CONFIGURATION_ERROR", JSON.stringify(bgRes.data).slice(0, 200));
  check("background failure is a persisted FAILED job (no fake mask)", bgRes.data.job?.status === "FAILED" && bgRes.data.job?.kind === "BACKGROUND_REMOVAL");
  const bgRetry = await alice.call("POST", `/api/phase8-jobs/${bgRes.data.job.id}/retry`, { body: {} });
  check("retrying the background job still fails honestly (422)", bgRetry.status === 422, `got ${bgRetry.status}`);

  // ---- media library ------------------------------------------------------------------
  const libRes = await alice.call("GET", `/api/media-library?projectId=${projectId}`);
  check("library lists the project's assets across stores", libRes.data.assets.length >= 6, `got ${libRes.data.assets.length}`);
  const libSource = libRes.data.assets.find((a) => a.ref === `source:${sourceAsset.id}`);
  check("source asset is categorised as Original Videos", libSource?.category === "Original Videos");
  check("library rows carry spec metadata (duration, aspect, codecs)", typeof libSource?.duration === "number" && libSource?.aspect === "16:9" && typeof libSource?.hasAudio === "boolean", JSON.stringify(libSource).slice(0, 240));
  const metaRes = await alice.call("PATCH", "/api/media-library/meta", {
    body: { assetRef: `media:${music.id}`, category: "Music", tags: ["background", "loop"] },
  });
  check("asset category + tags can be set", metaRes.status === 200 && metaRes.data.asset.category === "Music", JSON.stringify(metaRes.data).slice(0, 200));
  const libMusic = await alice.call("GET", `/api/media-library?category=${encodeURIComponent("Music")}`);
  check("category filter finds the re-categorised asset", libMusic.data.assets.some((a) => a.ref === `media:${music.id}`));
  const folderRes = await alice.call("POST", "/api/media-library/folders", { body: { name: "City footage" } });
  check("folder creation works", folderRes.status === 201);
  await alice.call("PATCH", "/api/media-library/meta", { body: { assetRef: `media:${carDrive.id}`, folderId: folderRes.data.folder.id } });
  const libFolder = await alice.call("GET", `/api/media-library?folderId=${folderRes.data.folder.id}`);
  check("folder filter lists its assets", libFolder.data.assets.some((a) => a.ref === `media:${carDrive.id}`));
  const folderDel = await alice.call("DELETE", `/api/media-library/folders/${folderRes.data.folder.id}`);
  check("folder delete works (assets keep existing)", folderDel.status === 200);

  const searchRes = await alice.call("POST", `/api/projects/${projectId}/broll/search`, { body: { query: "car" } });
  check("library search finds assets by real term match", searchRes.status === 200 && searchRes.data.results.some((r) => r.id === carDrive.id && r.matchedTerms.includes("car")), JSON.stringify(searchRes.data).slice(0, 240));
  const providerSearch = await alice.call("POST", `/api/projects/${projectId}/broll/search`, { body: { query: "car", source: "provider" } });
  check("provider search without configuration is a 422 (never scraped)", providerSearch.status === 422 && providerSearch.data.error?.code === "CONFIGURATION_ERROR");

  // ---- presets -------------------------------------------------------------------------
  const presetsRes = await alice.call("GET", "/api/phase8/presets");
  const builtins = presetsRes.data.presets.filter((p) => p.builtin);
  check("all 18 spec presets are present as built-ins", builtins.length === 18, `got ${builtins.length}`);
  check("background presets are gated on the missing provider", builtins.filter((p) => p.kind === "background" && p.requiresBackgroundProvider).length === 5);
  check("Original Background preset is not gated", builtins.find((p) => p.id === "builtin:bg-original")?.requiresBackgroundProvider === false);
  const customRes = await alice.call("POST", "/api/phase8/presets", {
    body: { name: "My Punchy Look", kind: "video", settings: { contrast: 1.2, saturation: 1.3, sharpen: 0.4 } },
  });
  check("custom preset creation works", customRes.status === 201 && customRes.data.preset.builtin === false, JSON.stringify(customRes.data).slice(0, 200));
  const customId = customRes.data.preset.id;
  const dupPreset = await alice.call("POST", `/api/phase8/presets/builtin:clear-voice/duplicate`, { body: {} });
  check("built-in preset can be duplicated into a custom", dupPreset.status === 201 && dupPreset.data.preset.basedOn === "builtin:clear-voice");
  const editBuiltin = await alice.call("PUT", "/api/phase8/presets/builtin:clear-voice", {
    body: { name: "Hacked", kind: "audio", settings: {} },
  });
  check("built-in preset edit is refused (400)", editBuiltin.status === 400, `got ${editBuiltin.status}`);
  const editCustom = await alice.call("PUT", `/api/phase8/presets/${customId}`, {
    body: { name: "My Punchier Look", kind: "video", settings: { contrast: 1.3 } },
  });
  check("custom preset edit works", editCustom.status === 200 && editCustom.data.preset.name === "My Punchier Look");
  const delCustom = await alice.call("DELETE", `/api/phase8/presets/${customId}`);
  check("custom preset delete works", delCustom.status === 200);

  // ---- cross-user isolation ---------------------------------------------------------------
  const bobJob = await bob.call("GET", `/api/phase8-jobs/${stabJobId}`);
  check("another user cannot read a phase8 job (404)", bobJob.status === 404, `got ${bobJob.status}`);
  const bobRecs = await bob.call("GET", `/api/projects/${projectId}/broll/recommendations`);
  check("another user cannot read project recommendations (404)", bobRecs.status === 404, `got ${bobRecs.status}`);

  // ---- Hindi recommendations (Devanagari transcript fixture) ------------------------------
  const hiProj = await alice.call("POST", "/api/projects", {
    body: { name: "Hindi Video", workflowType: "LONG_VIDEO_TO_SHORTS" },
  });
  const hiProjectId = hiProj.data.project.id;
  const hiSource = await uploadSource(alice, hiProjectId, fx.hindi, "hindi-source.mp4");
  const hiBroll = await uploadMedia(alice, hiProjectId, fx.carDrive, "hindi-broll.mp4", "video/mp4");
  await alice.call("PATCH", "/api/media-library/meta", {
    body: { assetRef: `media:${hiBroll.id}`, tags: ["गाड़ी", "तकनीक", "शहर"] },
  });
  const hiNow = new Date().toISOString();
  db.prepare(
    "INSERT INTO processing_tasks (id, user_id, project_id, source_asset_id, status, stage, created_at, updated_at) VALUES ('hi-task-8', ?, ?, ?, 'COMPLETED', 'COMPLETED', ?, ?)",
  ).run(aliceRow.id, hiProjectId, hiSource.id, hiNow, hiNow);
  db.prepare(
    "INSERT INTO transcripts (id, task_id, project_id, source_asset_id, language, language_probability, duration, full_text, provider, model, created_at) VALUES ('hi-transcript-8', 'hi-task-8', ?, ?, 'hi', 0.9, 10, ?, 'local-faster-whisper', 'small', ?)",
  ).run(hiProjectId, hiSource.id, "आज हम नई गाड़ी की तकनीक के बारे में बात करेंगे। शहर में गाड़ी चलाना आसान है।", hiNow);
  db.prepare(
    "INSERT INTO transcript_segments (id, transcript_id, idx, start_sec, end_sec, text, words_json) VALUES ('hi-seg-8-1', 'hi-transcript-8', 0, 0, 5, ?, NULL)",
  ).run("आज हम नई गाड़ी की तकनीक के बारे में बात करेंगे");
  db.prepare(
    "INSERT INTO transcript_segments (id, transcript_id, idx, start_sec, end_sec, text, words_json) VALUES ('hi-seg-8-2', 'hi-transcript-8', 1, 5, 10, ?, NULL)",
  ).run("शहर में गाड़ी चलाना आसान है");
  const hiJobRes = await alice.call("POST", `/api/projects/${hiProjectId}/broll/recommendations`, { body: {} });
  const hiJob = await waitForPhase8(alice, hiJobRes.data.job.id);
  check("Hindi recommendation job COMPLETED", hiJob.status === "COMPLETED", hiJob.error ?? "");
  const hiRecs = await alice.call("GET", `/api/projects/${hiProjectId}/broll/recommendations?status=PENDING`);
  const hiRec = hiRecs.data.recommendations.find((r) => r.assetId === hiBroll.id);
  check("Hindi transcript produces a recommendation from Devanagari term overlap", Boolean(hiRec), JSON.stringify(hiRecs.data.recommendations.map((r) => r.matchedTerms)));
  check("Hindi matched terms keep Devanagari words whole", (hiRec?.matchedTerms ?? []).includes("गाड़ी"), JSON.stringify(hiRec?.matchedTerms));

  // A project with NO transcript fails honestly.
  const bareProj = await alice.call("POST", "/api/projects", {
    body: { name: "No Transcript", workflowType: "LONG_VIDEO_TO_SHORTS" },
  });
  const bareJobRes = await alice.call("POST", `/api/projects/${bareProj.data.project.id}/broll/recommendations`, { body: {} });
  const bareJob = await waitForPhase8(alice, bareJobRes.data.job.id);
  check("recommendations without a transcript fail honestly (NO_TRANSCRIPT)", bareJob.status === "FAILED" && bareJob.errorCode === "NO_TRANSCRIPT", JSON.stringify(bareJob).slice(0, 200));

  // ---- regenerate never resurfaces resolved pairs ---------------------------------------------
  // dashRec was DISMISSED, carRec was REPLACED, and `replacement` was
  // ACCEPTED above. A fresh recommendations run must not re-suggest
  // any of those (window, asset) pairs as new PENDING rows.
  const regenRes = await alice.call("POST", `/api/projects/${projectId}/broll/recommendations`, { body: {} });
  check("regenerate job created", regenRes.status === 201 || regenRes.status === 200, JSON.stringify(regenRes.data).slice(0, 200));
  const regenJob = await waitForPhase8(alice, regenRes.data.job.id);
  check("regenerate job COMPLETED", regenJob.status === "COMPLETED", regenJob.error ?? "");
  const regenPending = (await alice.call("GET", `/api/projects/${projectId}/broll/recommendations?status=PENDING`)).data.recommendations;
  const isPair = (r, startSec, ref) => Math.abs(r.windowStartSec - startSec) < 0.001 && r.assetRef === ref;
  check(
    "dismissed pair is NOT re-suggested on regenerate",
    !regenPending.some((r) => isPair(r, dashRec.windowStartSec, dashRec.assetRef)),
    JSON.stringify(regenPending.map((r) => `${r.windowStartSec}:${r.assetRef}`)),
  );
  check(
    "accepted pair is NOT duplicated as PENDING on regenerate",
    !regenPending.some((r) => isPair(r, replacement.windowStartSec, replacement.assetRef)),
    JSON.stringify(regenPending.map((r) => `${r.windowStartSec}:${r.assetRef}`)),
  );
  check(
    "replaced pair does NOT resurface on regenerate",
    !regenPending.some((r) => isPair(r, carRec.windowStartSec, carRec.assetRef)),
    JSON.stringify(regenPending.map((r) => `${r.windowStartSec}:${r.assetRef}`)),
  );
  const stillDismissed = (await alice.call("GET", `/api/projects/${projectId}/broll/recommendations?status=DISMISSED`)).data.recommendations;
  check("dismissed recommendation itself remains DISMISSED after regenerate", stillDismissed.some((r) => r.id === dashRec.id));
  const stillAccepted = (await alice.call("GET", `/api/projects/${projectId}/broll/recommendations?status=ACCEPTED`)).data.recommendations;
  check("accepted recommendation itself remains ACCEPTED after regenerate", stillAccepted.some((r) => r.id === replacement.id));

  // ---- brand-asset delete cannot break a derived timeline copy -------------------------------
  // Accepting a brand B-roll recommendation imports the brand binary
  // into the project as a project_media row SHARING the brand
  // storage_key. Deleting the brand asset afterwards must keep that
  // shared binary, or the timeline copy silently loses its file.
  // A dedicated user keeps the scenario deterministic: her library
  // holds only her own project's (excluded) source and the brand
  // asset, so the brand asset is the genuine best match.
  const carol = new Client();
  await carol.register("carol-brand@example.com");
  const carolRow = db.prepare("SELECT id FROM users WHERE email = ?").get("carol-brand@example.com");
  const brandProj = await carol.call("POST", "/api/projects", {
    body: { name: "Brand Guard", workflowType: "LONG_VIDEO_TO_SHORTS" },
  });
  const brandProjectId = brandProj.data.project.id;
  const brandSource = await uploadSource(carol, brandProjectId, fx.speaker, "brand-speaker.mp4");
  await getDoc(carol, brandProjectId);
  const brandForm = new FormData();
  brandForm.append("kind", "INTRO");
  brandForm.append("file", new Blob([fs.readFileSync(fx.carDrive)], { type: "video/mp4" }), "electric-car-dashboard-battery-technology.mp4");
  const brandUpRes = await carol.raw("POST", "/api/brand-assets", { formData: brandForm });
  const brandUp = await brandUpRes.json().catch(() => null);
  check("brand video asset uploads", brandUpRes.status === 201, JSON.stringify(brandUp).slice(0, 200));
  const brandAssetId = brandUp.asset.id;
  db.prepare(
    "INSERT INTO processing_tasks (id, user_id, project_id, source_asset_id, status, stage, created_at, updated_at) VALUES ('brand-task-8', ?, ?, ?, 'COMPLETED', 'COMPLETED', ?, ?)",
  ).run(carolRow.id, brandProjectId, brandSource.id, now, now);
  db.prepare(
    "INSERT INTO transcripts (id, task_id, project_id, source_asset_id, language, language_probability, duration, full_text, provider, model, created_at) VALUES ('brand-transcript-8', 'brand-task-8', ?, ?, 'en', 0.95, ?, ?, 'local-faster-whisper', 'small', ?)",
  ).run(brandProjectId, brandSource.id, fx.bounds[2].end, SENTENCES.join(" "), now);
  SENTENCES.forEach((text, i) => {
    db.prepare(
      "INSERT INTO transcript_segments (id, transcript_id, idx, start_sec, end_sec, text, words_json) VALUES (?, 'brand-transcript-8', ?, ?, ?, ?, NULL)",
    ).run(`brand-seg-${i}`, i, fx.bounds[i].start, fx.bounds[i].end, text);
  });
  const brandJobRes = await carol.call("POST", `/api/projects/${brandProjectId}/broll/recommendations`, { body: {} });
  const brandJob = await waitForPhase8(carol, brandJobRes.data.job.id);
  check("brand project recommendation job COMPLETED", brandJob.status === "COMPLETED", brandJob.error ?? "");
  const brandRecs = (await carol.call("GET", `/api/projects/${brandProjectId}/broll/recommendations?status=PENDING`)).data.recommendations;
  const brandRec = brandRecs.find((r) => r.assetKind === "brand" && r.assetId === brandAssetId);
  check("brand video is recommended from real filename-term overlap", Boolean(brandRec), JSON.stringify(brandRecs.map((r) => `${r.assetKind}:${r.assetFilename}`)));
  const brandAccept = await carol.call("POST", `/api/broll-recommendations/${brandRec.id}/accept`, { body: {} });
  check("brand recommendation accepts into a placement", brandAccept.status === 201, JSON.stringify(brandAccept.data).slice(0, 240));
  const derivedMediaId = brandAccept.data.placement.assetId;
  check("placement references a derived project-media asset", typeof derivedMediaId === "string" && derivedMediaId !== brandAssetId);
  const streamBefore = await carol.raw("GET", `/api/project-media/${derivedMediaId}/stream`);
  check("derived media streams before the brand delete", streamBefore.status === 200, `got ${streamBefore.status}`);
  await streamBefore.arrayBuffer();
  const brandDel = await carol.call("DELETE", `/api/media-library/item?assetRef=${encodeURIComponent(`brand:${brandAssetId}`)}`);
  check("brand asset delete succeeds (no direct timeline use on the brand ref)", brandDel.status === 200, JSON.stringify(brandDel.data).slice(0, 200));
  const streamAfter = await carol.raw("GET", `/api/project-media/${derivedMediaId}/stream`);
  check("derived media STILL streams after the brand delete (shared binary kept)", streamAfter.status === 200, `got ${streamAfter.status}`);
  await streamAfter.arrayBuffer();
  const brandLibAfter = await carol.call("GET", `/api/media-library`);
  check("brand asset row is gone from the library after delete", !brandLibAfter.data.assets.some((a) => a.ref === `brand:${brandAssetId}`));

  // ---- gap fixes 1–4: detail / crop compensation / echo+balance / automation ----
  // All payloads use the client wire shape defined above.

  // Fix 1 — detail enhancement is a real, distinct chain stage.
  const detailPut = await alice.call("PUT", `/api/editor/${doc.id}/enhancement`, {
    body: {
      videoEnabled: true, audioEnabled: true,
      video: clientVideoSettings({ detail: 0.8 }),
      audio: clientAudioSettings(),
      scope: "project", itemIds: [],
    },
  });
  check("detail enhancement saves in the client wire shape", detailPut.status === 200 && detailPut.data.config.video.detail === 0.8, JSON.stringify(detailPut.data).slice(0, 240));
  const detailPreviewRes = await alice.call("POST", `/api/projects/${projectId}/enhancement-jobs`, {
    body: { assetRef: `source:${sourceAsset.id}`, video: clientVideoSettings({ detail: 0.9 }), preview: true },
  });
  const detailJob = await waitForPhase8(alice, detailPreviewRes.data.job.id);
  check("detail preview job COMPLETED", detailJob.status === "COMPLETED", detailJob.error ?? "");
  check(
    "detail stage is its own 7x7 unsharp, distinct from the 5x5 sharpen pass",
    (detailJob.result.appliedVideoFilters ?? []).some((f) => f.startsWith("unsharp=7:7:")) &&
      !(detailJob.result.appliedVideoFilters ?? []).some((f) => f.startsWith("unsharp=5:5:")),
    JSON.stringify(detailJob.result.appliedVideoFilters),
  );
  const badDetail = await alice.call("POST", `/api/projects/${projectId}/enhancement-jobs`, {
    body: { assetRef: `media:${carDrive.id}`, video: clientVideoSettings({ detail: 1.5 }) },
  });
  check("detail > 1 is rejected (400)", badDetail.status === 400, `got ${badDetail.status}`);

  // Fix 2 — stabilization crop compensation reaches vidstabtransform.
  check(
    "default crop compensation keeps the historical optzoom=1 (earlier stab job)",
    (stabJob.result.appliedVideoFilters ?? []).some((f) => f.includes("vidstabtransform=") && f.includes("optzoom=1")),
    JSON.stringify(stabJob.result.appliedVideoFilters),
  );
  const stab0Res = await alice.call("POST", `/api/projects/${projectId}/enhancement-jobs`, {
    body: {
      assetRef: `media:${shaky.id}`,
      video: clientVideoSettings({ stabilization: { enabled: true, strength: 0.5, smoothing: 20, cropCompensation: 0 } }),
    },
  });
  check("crop-compensation job created", stab0Res.status === 201, JSON.stringify(stab0Res.data).slice(0, 200));
  const stab0Job = await waitForPhase8(alice, stab0Res.data.job.id);
  check("crop compensation 0 job COMPLETED", stab0Job.status === "COMPLETED", stab0Job.error ?? "");
  check(
    "crop compensation 0 reaches vidstabtransform as optzoom=0",
    (stab0Job.result.appliedVideoFilters ?? []).some((f) => f.includes("vidstabtransform=") && f.includes("optzoom=0")),
    JSON.stringify(stab0Job.result.appliedVideoFilters),
  );
  const badCrop = await alice.call("POST", `/api/projects/${projectId}/enhancement-jobs`, {
    body: {
      assetRef: `media:${shaky.id}`,
      video: clientVideoSettings({ stabilization: { enabled: true, strength: 0.5, smoothing: 20, cropCompensation: 1.5 } }),
    },
  });
  check("cropCompensation > 1 is rejected (400)", badCrop.status === 400, `got ${badCrop.status}`);

  // Fix 3 — echo reduction + L/R balance are real chain stages.
  const audioCfgPut = await alice.call("PUT", `/api/editor/${doc.id}/enhancement`, {
    body: {
      videoEnabled: true, audioEnabled: true,
      video: clientVideoSettings(),
      audio: clientAudioSettings({
        echoReduction: 0.6,
        balance: -0.5,
        volumeAutomation: [
          { timeSec: 1, gainDb: -6 },
          { timeSec: 5, gainDb: 3 },
        ],
      }),
      scope: "project", itemIds: [],
    },
  });
  check(
    "echo/balance/automation save in the client wire shape",
    audioCfgPut.status === 200 &&
      audioCfgPut.data.config.audio.echoReduction === 0.6 &&
      audioCfgPut.data.config.audio.balance === -0.5 &&
      audioCfgPut.data.config.audio.volumeAutomation.length === 2,
    JSON.stringify(audioCfgPut.data).slice(0, 240),
  );
  const audioCfgGet = await alice.call("GET", `/api/editor/${doc.id}/enhancement`);
  check(
    "automation points read back intact",
    audioCfgGet.data.config.audio.volumeAutomation?.[0]?.timeSec === 1 &&
      audioCfgGet.data.config.audio.volumeAutomation?.[1]?.gainDb === 3,
    JSON.stringify(audioCfgGet.data.config.audio.volumeAutomation),
  );
  const balRes = await alice.call("POST", `/api/projects/${projectId}/enhancement-jobs`, {
    body: { assetRef: `media:${music.id}`, audio: clientAudioSettings({ echoReduction: 0.8, balance: -1 }) },
  });
  const balJob = await waitForPhase8(alice, balRes.data.job.id);
  check("echo+balance audio job COMPLETED", balJob.status === "COMPLETED", balJob.error ?? "");
  check("echo stage is a real aecho filter", (balJob.result.appliedAudioFilters ?? []).some((f) => f.startsWith("aecho=")), JSON.stringify(balJob.result.appliedAudioFilters));
  check("balance stage is a real pan filter", (balJob.result.appliedAudioFilters ?? []).some((f) => f.startsWith("pan=stereo")), JSON.stringify(balJob.result.appliedAudioFilters));
  const balFile = path.join(tmp, "balanced.m4a");
  {
    const res = await alice.raw("GET", `/api/project-media/${balJob.result.derivedMediaId}/stream`);
    check("balanced output streams", res.status === 200, `got ${res.status}`);
    fs.writeFileSync(balFile, Buffer.from(await res.arrayBuffer()));
  }
  const balLeft = channelMeanVolumeDb(balFile, 0);
  const balRight = channelMeanVolumeDb(balFile, 1);
  check("balance -1 leaves the left channel audible", balLeft !== null && balLeft > -40, `L=${balLeft}`);
  check(
    "balance -1 measurably silences the right channel (>= 12 dB below left, or digital silence)",
    balLeft !== null && (balRight === null || balRight <= balLeft - 12),
    `L=${balLeft} R=${balRight}`,
  );
  const badBalance = await alice.call("POST", `/api/projects/${projectId}/enhancement-jobs`, {
    body: { assetRef: `media:${music.id}`, audio: clientAudioSettings({ balance: 2 }) },
  });
  check("balance > 1 is rejected (400)", badBalance.status === 400, `got ${badBalance.status}`);

  // Fix 4 — volume automation renders as a real per-frame gain contour.
  const autoRes = await alice.call("POST", `/api/projects/${projectId}/enhancement-jobs`, {
    body: {
      assetRef: `media:${music.id}`,
      audio: clientAudioSettings({
        volumeAutomation: [
          { timeSec: 0, gainDb: 0 },
          { timeSec: 3, gainDb: -24 },
          { timeSec: 6, gainDb: 0 },
        ],
      }),
    },
  });
  const autoJob = await waitForPhase8(alice, autoRes.data.job.id);
  check("volume automation job COMPLETED", autoJob.status === "COMPLETED", autoJob.error ?? "");
  check(
    "automation renders as a per-frame volume stage",
    (autoJob.result.appliedAudioFilters ?? []).some((f) => f.startsWith("volume='pow(10,") && f.includes("eval=frame")),
    JSON.stringify(autoJob.result.appliedAudioFilters),
  );
  const autoFile = path.join(tmp, "automated.m4a");
  {
    const res = await alice.raw("GET", `/api/project-media/${autoJob.result.derivedMediaId}/stream`);
    check("automated output streams", res.status === 200, `got ${res.status}`);
    fs.writeFileSync(autoFile, Buffer.from(await res.arrayBuffer()));
  }
  const autoEdge = meanVolumeDb(autoFile, 0.3, 1.3);
  const autoDip = meanVolumeDb(autoFile, 2.7, 3.3);
  check(
    "automation contour is measurable: the -24 dB point dips the level (>= 8 dB)",
    autoEdge !== null && autoDip !== null && autoDip <= autoEdge - 8,
    `edge=${autoEdge} dip=${autoDip}`,
  );
  const badAuto = await alice.call("POST", `/api/projects/${projectId}/enhancement-jobs`, {
    body: {
      assetRef: `media:${music.id}`,
      audio: clientAudioSettings({ volumeAutomation: [{ timeSec: 1, gainDb: 40 }] }),
    },
  });
  check("automation gainDb > 24 is rejected (400)", badAuto.status === 400, `got ${badAuto.status}`);

  // ---- library delete semantics (last: destructive) -----------------------------------------
  const srcDel = await alice.call("DELETE", `/api/media-library/item?assetRef=${encodeURIComponent(`source:${sourceAsset.id}`)}`);
  check("deleting a project's original source is refused", srcDel.status === 400 && srcDel.data.error?.code === "ORIGINAL_PROTECTED", JSON.stringify(srcDel.data).slice(0, 200));
  const inUseDel = await alice.call("DELETE", `/api/media-library/item?assetRef=${encodeURIComponent(`media:${carInterior.id}`)}`);
  check("deleting an in-use asset warns first (409 ASSET_IN_USE)", inUseDel.status === 409 && inUseDel.data.error?.code === "ASSET_IN_USE", JSON.stringify(inUseDel.data).slice(0, 240));
  const forceDel = await alice.call("DELETE", `/api/media-library/item?assetRef=${encodeURIComponent(`media:${carInterior.id}`)}&force=true`);
  check("force delete succeeds after the warning", forceDel.status === 200, JSON.stringify(forceDel.data).slice(0, 200));
  docRes = await getDoc(alice, projectId);
  check("force delete safely removed the timeline item first", !docRes.document.items.some((i) => i.assetId === carInterior.id));
  const placementsAfter = await alice.call("GET", `/api/projects/${projectId}/broll/placements`);
  check("force delete removed the placement record too", !placementsAfter.data.placements.some((p) => p.id === placement2.id));
  const oceanDel = await alice.call("DELETE", `/api/media-library/item?assetRef=${encodeURIComponent(`media:${ocean.id}`)}`);
  check("deleting an unused asset works", oceanDel.status === 200);

  // ---- Pexels adapter against a LOCAL MOCK Pexels API ----------------
  // Second server boot: REAL adapter code, PEXELS_API_KEY set,
  // PEXELS_API_BASE pointed at an in-process mock (the Phase 10
  // pattern). This proves the adapter's request shape, credit
  // metadata and download pipeline — it is NOT a real Pexels account.
  const http = await import("node:http");
  const pexelsRequests = [];
  const oceanBytes = fs.readFileSync(fx.ocean);
  const MOCK_VIDEO = {
    id: 777001,
    width: 1280,
    height: 720,
    duration: 6,
    url: "https://www.pexels.com/video/mock-ocean-waves-777001/",
    image: "https://images.pexels.com/videos/777001/pictures/preview-0.jpg",
    user: { id: 42, name: "Casey Creator", url: "https://www.pexels.com/@casey-creator-42" },
    video_files: [], // links filled in once the mock port is known
  };
  const mockPexels = http.createServer((req, res) => {
    const u = new URL(req.url, "http://mock");
    pexelsRequests.push({ path: u.pathname, authorization: req.headers.authorization ?? null });
    const json = (status, obj) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (u.pathname === "/videos/search") {
      return json(200, { page: 1, per_page: 15, total_results: 1, videos: [MOCK_VIDEO] });
    }
    if (u.pathname === "/videos/videos/777001") return json(200, MOCK_VIDEO);
    if (u.pathname === "/files/777001-hd.mp4") {
      res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": oceanBytes.length });
      return res.end(oceanBytes);
    }
    return json(404, { error: "not found (mock)" });
  });
  await new Promise((resolve) => mockPexels.listen(0, "127.0.0.1", resolve));
  const mockPort = mockPexels.address().port;
  MOCK_VIDEO.video_files = [
    // The UHD rendition deliberately 404s: picking it (instead of
    // the widest file at or below 1920px) fails the import loudly.
    { id: 11, quality: "uhd", file_type: "video/mp4", width: 3840, height: 2160, fps: 30, link: `http://127.0.0.1:${mockPort}/files/777001-uhd.mp4` },
    { id: 12, quality: "hd", file_type: "video/mp4", width: 1280, height: 720, fps: 30, link: `http://127.0.0.1:${mockPort}/files/777001-hd.mp4` },
    { id: 13, quality: "sd", file_type: "video/mp4", width: 640, height: 360, fps: 30, link: `http://127.0.0.1:${mockPort}/files/777001-hd.mp4` },
  ];

  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "cf8-broll-pexels-"));
  const PORT2 = 3232;
  const BASE2 = `http://localhost:${PORT2}`;
  const server2 = spawn(path.join(serverDir, "node_modules", ".bin", "tsx"), ["src/index.ts"], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(PORT2),
      NODE_ENV: "test",
      DATABASE_FILE: path.join(tmp2, "test.db"),
      MEDIA_DIR: path.join(tmp2, "media"),
      PROCESSING_DIR: path.join(tmp2, "processing"),
      TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64"),
      PEXELS_API_KEY: "test-pexels-key-123",
      PEXELS_API_BASE: `http://127.0.0.1:${mockPort}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let server2Log = "";
  server2.stdout.on("data", (d) => (server2Log += d));
  server2.stderr.on("data", (d) => (server2Log += d));
  try {
    await waitForHealth(30000, BASE2);
    const carol = new Client(BASE2);
    await carol.register("carol-pexels@example.com");
    const proj2 = await carol.call("POST", "/api/projects", {
      body: { name: "Pexels Mock Project", workflowType: "LONG_VIDEO_TO_SHORTS" },
    });
    const project2Id = proj2.data.project.id;

    const status2 = await carol.call("GET", "/api/phase8/status");
    check(
      "pexels: status reports the stock provider configured + implemented with the key set",
      status2.data.providers.stock.configured === true && status2.data.providers.stock.implemented === true && status2.data.providers.stock.id === "pexels",
      JSON.stringify(status2.data.providers.stock),
    );

    const search2 = await carol.call("POST", `/api/projects/${project2Id}/broll/search`, {
      body: { query: "ocean waves", source: "provider" },
    });
    check("pexels: provider search returns hits from the (mock) API", search2.status === 200 && Array.isArray(search2.data.results) && search2.data.results.length === 1, JSON.stringify(search2.data).slice(0, 240));
    const hit = search2.data.results?.[0] ?? {};
    check(
      "pexels: hit carries licence + creator credit + source URL",
      hit.providerAssetId === "777001" && hit.licenseName === "Pexels License" && hit.attributionText === "Video by Casey Creator on Pexels" && hit.sourceUrl === "https://www.pexels.com/video/mock-ocean-waves-777001/" && hit.creatorName === "Casey Creator",
      JSON.stringify(hit).slice(0, 240),
    );
    check(
      "pexels: the adapter sent the API key as the Authorization header",
      pexelsRequests.some((r) => r.path === "/videos/search" && r.authorization === "test-pexels-key-123"),
      JSON.stringify(pexelsRequests).slice(0, 200),
    );

    const import2 = await carol.call("POST", `/api/projects/${project2Id}/broll/import`, {
      body: { provider: "pexels", providerAssetId: "777001" },
    });
    check("pexels: import queues a real job (201, PROVIDER_IMPORT)", import2.status === 201 && import2.data.job?.kind === "PROVIDER_IMPORT" && import2.data.job?.status !== "FAILED", JSON.stringify(import2.data).slice(0, 240));
    const importJob = await waitForPhase8(carol, import2.data.job.id);
    check("pexels: import job COMPLETES via the worker (download + probe)", importJob.status === "COMPLETED", JSON.stringify(importJob).slice(0, 300));
    check(
      "pexels: job result carries the credit metadata",
      importJob.result?.provider === "pexels" && importJob.result?.licenseName === "Pexels License" && importJob.result?.attributionText === "Video by Casey Creator on Pexels" && importJob.result?.sourceUrl === "https://www.pexels.com/video/mock-ocean-waves-777001/",
      JSON.stringify(importJob.result).slice(0, 240),
    );

    const lib2 = await carol.call("GET", `/api/media-library?projectId=${project2Id}`);
    const imported = (lib2.data.assets ?? []).filter((a) => a.provider === "pexels");
    check("pexels: the imported asset is in the project library as B-roll", imported.length === 1 && imported[0].category === "B-roll" && imported[0].sourceType === "STOCK_IMPORT", JSON.stringify(lib2.data.assets).slice(0, 240));
    check(
      "pexels: library asset shows licence + attribution",
      imported.length === 1 && imported[0].licenseName === "Pexels License" && imported[0].attributionText === "Video by Casey Creator on Pexels",
      JSON.stringify(imported[0]).slice(0, 240),
    );

    const db2 = new DatabaseSync(path.join(tmp2, "test.db"));
    const lic = db2.prepare("SELECT * FROM media_license_records WHERE provider = 'pexels'").get();
    check(
      "pexels: a licence record persists the source URL for the asset",
      Boolean(lic) && lic.source_url === "https://www.pexels.com/video/mock-ocean-waves-777001/" && lic.asset_ref === imported[0]?.ref,
      JSON.stringify(lic),
    );
    const meta2 = db2.prepare("SELECT * FROM media_asset_meta WHERE provider = 'pexels'").get();
    check("pexels: asset meta persists provider + provider asset id", Boolean(meta2) && meta2.provider_asset_id === "777001", JSON.stringify(meta2));
    db2.close();

    // Re-import of the same asset completes against the existing
    // library asset instead of duplicating the file.
    const import3 = await carol.call("POST", `/api/projects/${project2Id}/broll/import`, {
      body: { provider: "pexels", providerAssetId: "777001" },
    });
    const importJob3 = await waitForPhase8(carol, import3.data.job.id);
    const lib3 = await carol.call("GET", `/api/media-library?projectId=${project2Id}`);
    check(
      "pexels: re-import is idempotent (still exactly one library asset)",
      importJob3.status === "COMPLETED" && importJob3.result?.deduplicated === true && (lib3.data.assets ?? []).filter((a) => a.provider === "pexels").length === 1,
      JSON.stringify(importJob3.result).slice(0, 200),
    );

    // Unknown id: the (mock) API 404s and the job fails honestly —
    // a PROVIDER-side failure, NOT a configuration error.
    const importMissing = await carol.call("POST", `/api/projects/${project2Id}/broll/import`, {
      body: { provider: "pexels", providerAssetId: "999999" },
    });
    const missingJob = await waitForPhase8(carol, importMissing.data.job.id);
    check(
      "pexels: unknown asset id fails the job honestly (ASSET_NOT_FOUND, not CONFIGURATION_ERROR)",
      missingJob.status === "FAILED" && missingJob.errorCode === "ASSET_NOT_FOUND",
      JSON.stringify(missingJob).slice(0, 240),
    );
  } catch (err) {
    console.error("PEXELS SECTION ERROR:", err, server2Log.slice(-1500));
    check("pexels section completed without a suite error", false, String(err).slice(0, 200));
  } finally {
    try {
      process.kill(-server2.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
    mockPexels.close();
    fs.rmSync(tmp2, { recursive: true, force: true });
  }

  db.close();
  console.log(`\nPhase 8 broll e2e: ${passed} passed, ${failed} failed`);
  if (failures.length) console.log("failures:", failures.join(" | "));
  process.exitCode = failed > 0 ? 1 : 0;
} catch (err) {
  console.error("SUITE ERROR:", err);
  console.log(serverLog.slice(-3000));
  process.exitCode = 1;
} finally {
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
}
