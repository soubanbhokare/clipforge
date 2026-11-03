// Phase 9 Export Studio / batch export / rendering-queue e2e checks.
//
// Runs against a REAL spawned server (fresh temp DB + media dir).
// Fixtures mirror the Phase 8 suite: a 3-sentence espeak speaker
// video (transcript rows inserted with the SAME sentences), a music
// loop, a B-roll clip, plus the Phase 7 photographic-face fixture
// (tests/fixtures/tracking/one-face.mp4) for the reframing export.
//
// What is asserted (spec §21): single/edited/full-project exports,
// batch exports from per-target saved states (outputs must DIFFER),
// aspect + resolution probes, MP4/H.264 + WebM/VP9, audio preserved
// / music-only / all-off, burned captions (server QC pixel check +
// validation rows), separate SRT/VTT + ZIP bundle downloads, Hindi
// (Devanagari) subtitle export, B-roll visible in output, reframing
// reflected (YuNet re-detect), enhancement reflected (brightness
// delta), invalid settings 400s, the FRONTEND CLIENT's exact default
// settings object accepted (the Phase 8 wire-shape lesson),
// missing-source preflight FAILED job with persisted diagnostics,
// failed-render retry, cancellation (queued + running), pause-hold,
// priority, queue persistence, worker-restart recovery (a RUNNING
// job is marked FAILED/INTERRUPTED at boot; completed exports
// survive), download authorization (cross-user 404, anonymous 401,
// deleted output 410), export deletion leaving the source untouched
// (SHA-256) and requiring API-level confirmation (409
// CONFIRMATION_REQUIRED without ?confirm=true / { confirm: true }),
// FFprobe verification and A/V sync on real outputs.
//
// Run: npm run test:export

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const PORT = 3231;
const BASE = `http://localhost:${PORT}`;
const FACE_MODEL = path.join(serverDir, "models", "face_detection_yunet_2023mar.onnx");
const ONE_FACE = path.join(serverDir, "tests", "fixtures", "tracking", "one-face.mp4");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-export-"));
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

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** Mean luma of one frame (0..255). */
function frameGrayMean(file, tSec) {
  const png = path.join(tmp, `frame-${Math.random().toString(36).slice(2)}.png`);
  run("ffmpeg", ["-v", "error", "-y", "-ss", String(tSec), "-i", file, "-frames:v", "1", png]);
  const out = run(
    "ffmpeg",
    ["-v", "error", "-i", png, "-vf", "format=gray", "-f", "rawvideo", "-"],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
  if (out.length === 0) return 0;
  let sum = 0;
  for (const b of out) sum += b;
  return sum / out.length;
}

/** Fraction of pixels whose luma differs by > 30 between two videos at t. */
function frameDiffRatio(fileA, fileB, tSec) {
  const grab = (file) => {
    const png = path.join(tmp, `diff-${Math.random().toString(36).slice(2)}.png`);
    run("ffmpeg", ["-v", "error", "-y", "-ss", String(tSec), "-i", file, "-frames:v", "1", "-vf", "scale=240:-2", png]);
    return run(
      "ffmpeg",
      ["-v", "error", "-i", png, "-vf", "format=gray", "-f", "rawvideo", "-"],
      { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
    );
  };
  const a = grab(fileA);
  const b = grab(fileB);
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let diff = 0;
  for (let i = 0; i < n; i += 1) if (Math.abs(a[i] - b[i]) > 30) diff += 1;
  return diff / n;
}

function meanVolumeDb(file, fromSec, toSec) {
  const res = spawnSync(
    "ffmpeg",
    ["-v", "info", "-ss", String(fromSec), "-i", file, "-t", String(toSec - fromSec), "-af", "volumedetect", "-f", "null", "-"],
    { encoding: "utf8" },
  );
  const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(res.stderr || "");
  return m ? Number(m[1]) : null;
}

/** YuNet face detection on a still image — returns [[x,y,w,h,conf]]. */
function detectFacesInImage(jpg) {
  const code = [
    "import cv2,sys,json",
    `d=cv2.FaceDetectorYN.create(r'${FACE_MODEL}','',(320,320),0.6,0.3,5000)`,
    "img=cv2.imread(sys.argv[1])",
    "d.setInputSize((img.shape[1],img.shape[0]))",
    "_,f=d.detect(img)",
    "print(json.dumps([] if f is None else [[float(v) for v in row[:4]]+[float(row[14])] for row in f]))",
  ].join("\n");
  return JSON.parse(run("python3", ["-c", code, jpg]));
}

class Client {
  constructor() {
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
    const res = await fetch(`${BASE}${url}`, {
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
      body: { displayName: "Export Tester", email, password: pw, confirmPassword: pw, termsAccepted: true },
    });
    if (res.status !== 201) throw new Error(`register failed: ${JSON.stringify(res.data)}`);
    return res.data.user;
  }
}

async function waitForHealth(timeoutMs = 60000) {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() - start > timeoutMs) throw new Error("server did not start in time");
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function waitForExport(client, jobId, timeoutMs = 900000) {
  const start = Date.now();
  for (;;) {
    const res = await client.call("GET", `/api/export-jobs/${jobId}`);
    const job = res.data?.job;
    if (job && ["COMPLETED", "FAILED", "CANCELLED"].includes(job.status)) return job;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`export job ${jobId} did not finish (status ${job?.status}, stage ${job?.stage})`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function waitForStatus(client, jobId, wanted, timeoutMs = 60000) {
  const start = Date.now();
  for (;;) {
    const res = await client.call("GET", `/api/export-jobs/${jobId}`);
    const job = res.data?.job;
    if (job && job.status === wanted) return job;
    if (Date.now() - start > timeoutMs) throw new Error(`job ${jobId} never reached ${wanted} (now ${job?.status})`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function downloadExport(client, jobId, file = "video") {
  const res = await client.raw("GET", `/api/export-jobs/${jobId}/download?file=${file}`);
  return res;
}

async function downloadToFile(client, jobId, name, file = "video") {
  const res = await downloadExport(client, jobId, file);
  if (res.status !== 200) throw new Error(`download ${jobId}/${file} failed: ${res.status}`);
  const out = path.join(tmp, name);
  fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  return out;
}

// The FRONTEND CLIENT'S default settings object, copied verbatim
// from src/services/export.ts (DEFAULT_EXPORT_SETTINGS). If the
// panel's wire shape ever drifts from the server schema again (the
// Phase 8 bug), the create call below fails and this suite catches it.
const CLIENT_DEFAULT_SETTINGS = {
  container: "mp4",
  videoCodec: "libx264",
  audioCodec: "aac",
  audioOnly: false,
  resolution: "original",
  aspect: "original",
  customWidth: null,
  customHeight: null,
  qualityMode: "preset",
  qualityPreset: "standard",
  crf: null,
  videoBitrateKbps: null,
  encoderPreset: "veryfast",
  fps: null,
  keyframeInterval: null,
  includeOriginalAudio: true,
  includeMusic: true,
  includeBrollAudio: true,
  audioBitrateKbps: 160,
  audioSampleRate: 48000,
  audioChannels: 2,
  normalizeAudio: false,
  captionMode: "burn",
  captionFormat: "both",
  includeEnhancement: false,
  includeReframe: false,
  namingPattern: "project-clip-resolution",
  customName: null,
  rangeStart: null,
  rangeEnd: null,
};

const small = (over = {}) => ({
  ...CLIENT_DEFAULT_SETTINGS,
  resolution: "480p",
  captionMode: "none",
  ...over,
});

// ---- fixtures ---------------------------------------------------------------

const SENTENCES = [
  "Today we review the new electric car in the city.",
  "The dashboard shows the battery level and the technology inside.",
  "Later we cook pasta with tomato sauce at home.",
];

function buildFixtures() {
  const dir = path.join(tmp, "fixtures");
  fs.mkdirSync(dir, { recursive: true });
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

  const brollClip = path.join(dir, "broll.mp4");
  run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "smptebars=s=640x360:r=30:d=6",
    "-f", "lavfi", "-i", "sine=frequency=220:d=6",
    "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", brollClip]);
  const music = path.join(dir, "music.mp3");
  run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:d=8", "-f", "lavfi", "-i", "sine=frequency=554:d=8",
    "-filter_complex", "[0:a][1:a]amix=inputs=2:normalize=0", "-c:a", "libmp3lame", music]);
  return { dir, speaker, bounds, brollClip, music };
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

async function getDoc(client, projectId, query = "") {
  const res = await client.call("GET", `/api/projects/${projectId}/editor${query}`);
  if (res.status !== 200 && res.status !== 201) throw new Error(`editor doc failed: ${res.status}`);
  return res.data;
}

function spawnServer() {
  const srv = spawn(path.join(serverDir, "node_modules", ".bin", "tsx"), ["src/index.ts"], {
    cwd: serverDir,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  srv.log = "";
  srv.stdout.on("data", (d) => (srv.log += d));
  srv.stderr.on("data", (d) => (srv.log += d));
  return srv;
}

console.log("Phase 9 export e2e — spawning server on", BASE);
const fx = buildFixtures();
let server = spawnServer();

try {
  await waitForHealth();
  const alice = new Client();
  const bob = new Client();
  await alice.register("alice-export@example.com");
  await bob.register("bob-export@example.com");

  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(process.env.DATABASE_FILE);
  const aliceRow = db.prepare("SELECT id FROM users WHERE email = ?").get("alice-export@example.com");
  const aliceId = aliceRow.id;

  // ============================ capabilities =================================
  const capRes = await alice.call("GET", "/api/exports/capabilities");
  check("capabilities: probed encoders report x264/x265/vp9/aac/opus/mp3 present",
    capRes.status === 200 &&
      ["libx264", "libx265", "libvpx-vp9", "aac", "libopus", "libmp3lame"].every((k) => capRes.data.encoders[k] === true),
    JSON.stringify(capRes.data?.encoders));
  check("capabilities: mp4 + webm containers supported",
    capRes.data.containers?.some((c) => c.id === "mp4" && c.supported) &&
      capRes.data.containers?.some((c) => c.id === "webm" && c.supported));
  check("capabilities: MP4 advertises VP9 alongside H.264/H.265 (the schema accepts VP9-in-MP4 and QC verifies it)",
    capRes.data.containers?.some((c) => c.id === "mp4" && c.videoCodecs?.includes("libvpx-vp9")),
    JSON.stringify(capRes.data.containers));
  const anonCap = await new Client().call("GET", "/api/exports/capabilities");
  check("capabilities require auth (401)", anonCap.status === 401, `got ${anonCap.status}`);

  // ============================ main project setup ============================
  const proj = await alice.call("POST", "/api/projects", {
    body: { name: "Export Main", workflowType: "LONG_VIDEO_TO_SHORTS" },
  });
  const projectId = proj.data.project.id;
  const sourceAsset = await uploadSource(alice, projectId, fx.speaker, "speaker.mp4");
  const brollMedia = await uploadMedia(alice, projectId, fx.brollClip, "broll-bars.mp4", "video/mp4");
  const musicMedia = await uploadMedia(alice, projectId, fx.music, "background-music.mp3", "audio/mpeg");
  const sourceRow = db.prepare("SELECT storage_key FROM source_assets WHERE id = ?").get(sourceAsset.id);
  const sourceDiskPath = path.join(process.env.MEDIA_DIR, sourceRow.storage_key);
  const sourceShaBefore = sha256File(sourceDiskPath);

  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO processing_tasks (id, user_id, project_id, source_asset_id, status, stage, created_at, updated_at) VALUES ('exp-task-1', ?, ?, ?, 'COMPLETED', 'COMPLETED', ?, ?)",
  ).run(aliceId, projectId, sourceAsset.id, now, now);
  db.prepare(
    "INSERT INTO transcripts (id, task_id, project_id, source_asset_id, language, language_probability, duration, full_text, provider, model, created_at) VALUES ('exp-transcript-1', 'exp-task-1', ?, ?, 'en', 0.95, ?, ?, 'local-faster-whisper', 'small', ?)",
  ).run(projectId, sourceAsset.id, fx.bounds[2].end, SENTENCES.join(" "), now);
  SENTENCES.forEach((text, i) => {
    db.prepare(
      "INSERT INTO transcript_segments (id, transcript_id, idx, start_sec, end_sec, text, words_json) VALUES (?, 'exp-transcript-1', ?, ?, ?, ?, NULL)",
    ).run(`exp-seg-${i}`, i, fx.bounds[i].start, fx.bounds[i].end, text);
  });
  const candA = { id: "exp-candidate-a", start: 0, end: fx.bounds[1].end, title: "Opening Review" };
  const candB = { id: "exp-candidate-b", start: fx.bounds[1].start, end: fx.bounds[2].end, title: "Dashboard And Cooking" };
  for (const c of [candA, candB]) {
    db.prepare(
      "INSERT INTO candidate_clips (id, task_id, project_id, source_asset_id, user_id, start_sec, end_sec, duration, score, reasons_json, suggested_title, title, transcript_excerpt, status, preview_status, created_at) VALUES (?, 'exp-task-1', ?, ?, ?, ?, ?, ?, 85, '[]', ?, ?, '', 'SELECTED', 'READY', ?)",
    ).run(c.id, projectId, sourceAsset.id, aliceId, c.start, c.end, c.end - c.start, c.title, c.title, now);
  }

  // Seed the editor document from candidate A, then snapshot V1
  // BEFORE the full edit (music + B-roll + styled captions) so the
  // batch test can prove per-state exports differ.
  let docRes = await getDoc(alice, projectId, `?seedCandidateId=${candA.id}`);
  let doc = docRes.document;
  check("doc seeded from candidate A with captions", doc.items.length >= 1 && doc.captions.length >= 2,
    `items=${doc.items.length} captions=${doc.captions.length}`);
  const docDuration = candA.end;
  const versionRes = await alice.call("POST", `/api/editor/${doc.id}/versions`, { body: { name: "V1 Plain" } });
  check("version snapshot V1 created", versionRes.status === 201 && Boolean(versionRes.data.version?.id));
  const versionId = versionRes.data.version.id;

  // Full edit: music on the audio track + B-roll overlay via the
  // normal editor operations API.
  const audioTrack = doc.tracks.find((t) => t.kind === "audio");
  const brollTrack = doc.tracks.find((t) => t.kind === "broll");
  const musicDur = musicMedia.duration ?? 8;
  const editedState = {
    canvas: doc.canvas, settings: doc.settings, tracks: doc.tracks,
    items: [
      ...doc.items,
      {
        id: crypto.randomUUID(), trackId: audioTrack.id, assetKind: "media", assetId: musicMedia.id,
        start: 0, duration: Math.min(musicDur, docDuration), sourceIn: 0, sourceOut: Math.min(musicDur, docDuration),
        transform: { crop: null, x: 0, y: 0, scale: 1, zoom: 1, rotation: 0, fit: "fill" },
        speed: 1, volume: 0.8, fadeIn: 0, fadeOut: 0, layerOrder: 0,
      },
      {
        id: crypto.randomUUID(), trackId: brollTrack.id, assetKind: "media", assetId: brollMedia.id,
        start: 0.5, duration: 2.5, sourceIn: 0, sourceOut: 2.5,
        transform: { crop: null, x: 0, y: 0, scale: 1, zoom: 1, rotation: 0, fit: "fill" },
        speed: 1, volume: 0.8, fadeIn: 0, fadeOut: 0, layerOrder: 0,
      },
    ],
    captions: doc.captions, sceneOverrides: doc.sceneOverrides,
  };
  const opRes = await alice.call("POST", `/api/editor/${doc.id}/operations`, {
    body: { type: "test_full_edit", state: editedState, operationId: crypto.randomUUID(), baseCursor: doc.undoCursor },
  });
  check("full edit (music + B-roll) applied via operations", opRes.status === 200, JSON.stringify(opRes.data).slice(0, 200));
  doc = opRes.data.document;

  // Large high-contrast caption style so the burn-in is unambiguous.
  const styleRes = await alice.call("PATCH", `/api/editor/${doc.id}/settings`, {
    body: {
      settings: {
        captionStyle: { ...doc.settings.captionStyle, fontSize: 92, backgroundOpacity: 0.9, textColor: "#FFFFFF", animation: "none" },
        showCaptions: true,
      },
    },
  });
  check("caption style updated for burn-in checks", styleRes.status === 200);
  doc = styleRes.data.document;

  // ============================ presets =======================================
  const presetsRes = await alice.call("GET", "/api/export-presets");
  check("presets: built-ins are listed", presetsRes.status === 200 && presetsRes.data.presets.some((p) => p.id === "builtin:shorts-vertical" && p.builtin));
  const customPreset = await alice.call("POST", "/api/export-presets", {
    body: { name: "My Small Square", settings: { ...CLIENT_DEFAULT_SETTINGS, aspect: "1:1", resolution: "480p" } },
  });
  check("presets: custom preset created with the client's wire shape", customPreset.status === 201, JSON.stringify(customPreset.data).slice(0, 200));
  const customPresetId = customPreset.data.preset.id;
  const badPreset = await alice.call("POST", "/api/export-presets", {
    body: { name: "Broken", settings: { ...CLIENT_DEFAULT_SETTINGS, container: "webm", videoCodec: "libx264" } },
  });
  check("presets: incompatible combo rejected (400)", badPreset.status === 400, `got ${badPreset.status}`);
  const dupBuiltin = await alice.call("POST", "/api/export-presets/builtin:youtube-1080p/duplicate", { body: {} });
  check("presets: built-in can be duplicated", dupBuiltin.status === 201 && dupBuiltin.data.preset.builtin === false);
  const editBuiltin = await alice.call("PUT", "/api/export-presets/builtin:youtube-1080p", {
    body: { name: "Hacked", settings: CLIENT_DEFAULT_SETTINGS },
  });
  check("presets: built-in cannot be edited (400)", editBuiltin.status === 400, `got ${editBuiltin.status}`);
  const delBuiltin = await alice.call("DELETE", "/api/export-presets/builtin:youtube-1080p");
  check("presets: built-in cannot be deleted (400)", delBuiltin.status === 400, `got ${delBuiltin.status}`);
  const updCustom = await alice.call("PUT", `/api/export-presets/${customPresetId}`, {
    body: { name: "My Small Square v2", settings: { ...CLIENT_DEFAULT_SETTINGS, aspect: "1:1", resolution: "720p" } },
  });
  check("presets: custom preset updated", updCustom.status === 200 && updCustom.data.preset.name === "My Small Square v2");
  const bobPreset = await bob.call("GET", "/api/export-presets");
  check("presets: another user's preset list does not leak customs", bobPreset.status === 200 && !bobPreset.data.presets.some((p) => p.id === customPresetId));

  // ============================ targets + preflight =============================
  const targetsRes = await alice.call("GET", `/api/projects/${projectId}/export-targets`);
  check("targets: document + version + both candidates listed",
    targetsRes.status === 200 && targetsRes.data.versions.length === 1 && targetsRes.data.candidates.length === 2,
    JSON.stringify(targetsRes.data).slice(0, 200));
  const bobTargets = await bob.call("GET", `/api/projects/${projectId}/export-targets`);
  check("targets: cross-user project is 404", bobTargets.status === 404, `got ${bobTargets.status}`);

  const pfRes = await alice.call("POST", `/api/projects/${projectId}/exports/preflight`, {
    body: { target: { kind: "document" }, settings: CLIENT_DEFAULT_SETTINGS },
  });
  check("preflight: default settings pass", pfRes.status === 200 && pfRes.data.ok === true, JSON.stringify(pfRes.data).slice(0, 300));
  check("preflight: summary names the expected output",
    pfRes.data.summary?.outputName?.endsWith(".mp4") &&
      pfRes.data.summary?.width === 1080 && pfRes.data.summary?.height === 1920 &&
      pfRes.data.summary?.captionCount >= 2,
    JSON.stringify(pfRes.data.summary));
  check("preflight: no size estimate in preset quality mode (honest omission)",
    pfRes.data.summary?.estimatedSizeBytes === null);
  const pfBitrate = await alice.call("POST", `/api/projects/${projectId}/exports/preflight`, {
    body: { target: { kind: "document" }, settings: { ...CLIENT_DEFAULT_SETTINGS, qualityMode: "bitrate", videoBitrateKbps: 8000 } },
  });
  check("preflight: bitrate mode yields a LABELLED estimate",
    pfBitrate.data.summary?.estimatedSizeBytes > 0 && /estimate/i.test(pfBitrate.data.summary?.estimateNote ?? ""),
    JSON.stringify(pfBitrate.data.summary));

  // CSRF guard on export creation.
  {
    const noCsrf = new Client();
    noCsrf.cookies = alice.cookies;
    const res = await noCsrf.raw("POST", `/api/projects/${projectId}/exports`, {
      body: { targets: [{ kind: "document" }], settings: CLIENT_DEFAULT_SETTINGS },
    });
    check("export create without CSRF is rejected (403)", res.status === 403, `got ${res.status}`);
  }

  // ============================ E1: default export ==============================
  // The payload is the frontend client's default object VERBATIM.
  const e1Res = await alice.call("POST", `/api/projects/${projectId}/exports`, {
    body: { targets: [{ kind: "document" }], settings: CLIENT_DEFAULT_SETTINGS },
  });
  check("E1: export created from the client's exact default settings (201)",
    e1Res.status === 201 && e1Res.data.jobs.length === 1, JSON.stringify(e1Res.data).slice(0, 300));
  const e1Id = e1Res.data.jobs[0].id;
  check("E1: job is an EXPORT with a computed output name",
    e1Res.data.jobs[0].kind === "EXPORT" && /\.mp4$/.test(e1Res.data.jobs[0].outputName ?? ""));
  check("E1: creation response carries the passing preflight", e1Res.data.jobs[0].preflight?.every((c) => c.ok || c.level === "warning"));
  const e1 = await waitForExport(alice, e1Id);
  check("E1: default export COMPLETED", e1.status === "COMPLETED", e1.error ?? "");
  check("E1: progress was recorded from real encoder output", e1.progress !== null && e1.progress.percent > 90,
    JSON.stringify(e1.progress));
  const e1File = await downloadToFile(alice, e1Id, "e1.mp4");
  const e1Probe = ffprobeJson(e1File);
  const e1Video = e1Probe.streams.find((s) => s.codec_type === "video");
  const e1Audio = e1Probe.streams.find((s) => s.codec_type === "audio");
  check("E1: MP4 container with H.264 video", /mp4/.test(e1Probe.format.format_name) && e1Video?.codec_name === "h264",
    `${e1Probe.format.format_name}/${e1Video?.codec_name}`);
  check("E1: AAC audio stream present (A/V together)", e1Audio?.codec_name === "aac");
  check("E1: output is the edited canvas 1080x1920", e1Video?.width === 1080 && e1Video?.height === 1920,
    `${e1Video?.width}x${e1Video?.height}`);
  check("E1: duration within 1.0s of the edited timeline",
    Math.abs(Number(e1Probe.format.duration) - docDuration) <= 1.0,
    `${e1Probe.format.duration} vs ${docDuration}`);
  check("A/V sync: audio and video stream durations agree within 0.5s",
    Math.abs(Number(e1Video.duration) - Number(e1Audio.duration)) <= 0.5,
    `v=${e1Video.duration} a=${e1Audio.duration}`);
  const e1Speech = meanVolumeDb(e1File, 0.2, Math.min(3, docDuration - 0.5));
  check("E1: mixed audio is audible (speech + music + B-roll)", e1Speech !== null && e1Speech > -45, `mean=${e1Speech}`);
  const e1Detail = await alice.call("GET", `/api/export-jobs/${e1Id}`);
  const e1Qc = e1Detail.data.validation.find((v) => v.phase === "QC");
  check("E1: QC validation row persisted and passed", Boolean(e1Qc) && e1Qc.ok === true, JSON.stringify(e1Detail.data.validation).slice(0, 200));
  check("E1: QC includes the burned-captions pixel check, passed",
    e1Qc?.checks?.some((c) => c.id === "captions-burned" && c.ok === true), JSON.stringify(e1Qc?.checks));
  const e1Pf = e1Detail.data.validation.find((v) => v.phase === "PREFLIGHT");
  check("E1: preflight validation row persisted", Boolean(e1Pf) && e1Pf.ok === true);
  const histRes = await alice.call("GET", "/api/exports/history");
  check("history: E1 recorded with format/size/duration",
    histRes.data.outputs.some((o) => o.jobId === e1Id && o.status === "COMPLETED" && o.fileSize > 1024 && o.format === "mp4"),
    JSON.stringify(histRes.data.outputs[0]).slice(0, 200));

  // ============================ E2: batch, per-state ============================
  const batchRes = await alice.call("POST", `/api/projects/${projectId}/exports`, {
    body: {
      targets: [{ kind: "document" }, { kind: "version", id: versionId }, { kind: "candidate", id: candB.id }],
      settings: small(),
    },
  });
  check("batch: three jobs created in one call", batchRes.status === 201 && batchRes.data.jobs.length === 3,
    JSON.stringify(batchRes.data).slice(0, 300));
  const batchJobs = [];
  for (const j of batchRes.data.jobs) batchJobs.push(await waitForExport(alice, j.id));
  check("batch: all three COMPLETED", batchJobs.every((j) => j.status === "COMPLETED"),
    batchJobs.map((j) => `${j.status}:${j.error ?? ""}`).join(" | "));
  const batchDocJob = batchJobs.find((j) => /Edited project/.test(j.exportSettings?.targetLabel ?? ""));
  const batchVerJob = batchJobs.find((j) => /V1 Plain/.test(j.exportSettings?.targetLabel ?? ""));
  const batchCandJob = batchJobs.find((j) => /Dashboard And Cooking/.test(j.exportSettings?.targetLabel ?? ""));
  check("batch: jobs map to document / version / candidate targets", Boolean(batchDocJob && batchVerJob && batchCandJob));
  const batchDocFile = await downloadToFile(alice, batchDocJob.id, "batch-doc.mp4");
  const batchVerFile = await downloadToFile(alice, batchVerJob.id, "batch-ver.mp4");
  const batchCandFile = await downloadToFile(alice, batchCandJob.id, "batch-cand.mp4");
  check("batch: document output DIFFERS from the V1 snapshot output (own saved states)",
    sha256File(batchDocFile) !== sha256File(batchVerFile));
  const candProbe = ffprobeJson(batchCandFile);
  check("batch: candidate output duration matches the candidate's own window",
    Math.abs(Number(candProbe.format.duration) - (candB.end - candB.start)) <= 1.0,
    `${candProbe.format.duration} vs ${candB.end - candB.start}`);
  const brollDiff = frameDiffRatio(batchDocFile, batchVerFile, 1.5);
  check("B-roll overlay is visible in the edited output (frame differs inside the B-roll window)",
    brollDiff > 0.01, `diffRatio=${brollDiff.toFixed(4)}`);

  // ============================ E3: WebM / VP9 ==================================
  const webmRes = await alice.call("POST", `/api/projects/${projectId}/exports`, {
    body: {
      targets: [{ kind: "candidate", id: candB.id }],
      settings: small({ container: "webm", videoCodec: "libvpx-vp9", audioCodec: "libopus", aspect: "16:9" }),
    },
  });
  const webmJob = await waitForExport(alice, webmRes.data.jobs[0].id);
  check("WebM export COMPLETED", webmJob.status === "COMPLETED", webmJob.error ?? "");
  const webmFile = await downloadToFile(alice, webmJob.id, "cand.webm");
  const webmProbe = ffprobeJson(webmFile);
  const webmVideo = webmProbe.streams.find((s) => s.codec_type === "video");
  const webmAudio = webmProbe.streams.find((s) => s.codec_type === "audio");
  check("WebM: matroska/webm container with VP9 + Opus",
    /webm|matroska/.test(webmProbe.format.format_name) && webmVideo?.codec_name === "vp9" && webmAudio?.codec_name === "opus",
    `${webmProbe.format.format_name}/${webmVideo?.codec_name}/${webmAudio?.codec_name}`);
  check("WebM: 16:9 at 480p class is 854x480 (1920 scaled by 480/1080, even-rounded)", webmVideo?.width === 854 && webmVideo?.height === 480,
    `${webmVideo?.width}x${webmVideo?.height}`);

  // ============================ aspect / resolution probes ======================
  const aspectCases = [
    { over: { aspect: "9:16", resolution: "1080p" }, want: [1080, 1920], label: "9:16 1080p" },
    { over: { aspect: "16:9", resolution: "720p" }, want: [1280, 720], label: "16:9 720p" },
    { over: { aspect: "1:1", resolution: "720p" }, want: [720, 720], label: "1:1 720p" },
    { over: { aspect: "16:9", resolution: "1440p" }, want: [2560, 1440], label: "16:9 1440p (higher-res)" },
  ];
  for (const c of aspectCases) {
    const res = await alice.call("POST", `/api/projects/${projectId}/exports`, {
      body: { targets: [{ kind: "candidate", id: candB.id }], settings: small(c.over) },
    });
    const job = await waitForExport(alice, res.data.jobs[0].id);
    check(`aspect: ${c.label} export COMPLETED`, job.status === "COMPLETED", job.error ?? "");
    const file = await downloadToFile(alice, job.id, `aspect-${c.label.replace(/[^a-z0-9]+/gi, "-")}.mp4`);
    const probe = ffprobeJson(file);
    const v = probe.streams.find((s) => s.codec_type === "video");
    check(`aspect: ${c.label} probes at ${c.want[0]}x${c.want[1]}`, v?.width === c.want[0] && v?.height === c.want[1],
      `${v?.width}x${v?.height}`);
  }

  // ============================ E4: subtitles ===================================
  const sepRes = await alice.call("POST", `/api/projects/${projectId}/exports`, {
    body: { targets: [{ kind: "document" }], settings: small({ captionMode: "separate", captionFormat: "both" }) },
  });
  const sepJob = await waitForExport(alice, sepRes.data.jobs[0].id);
  check("separate-subtitles export COMPLETED", sepJob.status === "COMPLETED", sepJob.error ?? "");
  const srtRes = await downloadExport(alice, sepJob.id, "srt");
  const srtText = await srtRes.text();
  check("SRT download: 200 with real cues + timing",
    srtRes.status === 200 && srtText.includes("00:00:") && srtText.includes("electric car"), srtText.slice(0, 120));
  const vttRes = await downloadExport(alice, sepJob.id, "vtt");
  const vttText = await vttRes.text();
  check("VTT download: 200 with WEBVTT header + cues",
    vttRes.status === 200 && vttText.startsWith("WEBVTT") && vttText.includes("dashboard"), vttText.slice(0, 120));
  const bundleRes = await alice.call("POST", `/api/projects/${projectId}/exports`, {
    body: { targets: [{ kind: "candidate", id: candB.id }], settings: small({ captionMode: "bundle", captionFormat: "both" }) },
  });
  const bundleJob = await waitForExport(alice, bundleRes.data.jobs[0].id);
  check("bundle-mode export COMPLETED", bundleJob.status === "COMPLETED", bundleJob.error ?? "");
  const zipFile = await downloadToFile(alice, bundleJob.id, "bundle.zip", "video");
  const zipList = run("python3", ["-c", "import zipfile,sys; print('\\n'.join(zipfile.ZipFile(sys.argv[1]).namelist()))", zipFile]);
  check("bundle download is a ZIP containing video + SRT + VTT",
    /\.mp4/.test(zipList) && /\.srt/.test(zipList) && /\.vtt/.test(zipList), zipList);

  // ============================ E6: audio-only ==================================
  const aoRes = await alice.call("POST", `/api/projects/${projectId}/exports`, {
    body: { targets: [{ kind: "document" }], settings: small({ audioOnly: true, audioCodec: "libmp3lame", captionMode: "none" }) },
  });
  const aoJob = await waitForExport(alice, aoRes.data.jobs[0].id);
  check("audio-only MP3 export COMPLETED", aoJob.status === "COMPLETED", aoJob.error ?? "");
  const aoFile = await downloadToFile(alice, aoJob.id, "audio.mp3");
  const aoProbe = ffprobeJson(aoFile);
  check("audio-only: no video stream, MP3 audio, duration matches",
    !aoProbe.streams.some((s) => s.codec_type === "video") &&
      aoProbe.streams.find((s) => s.codec_type === "audio")?.codec_name === "mp3" &&
      Math.abs(Number(aoProbe.format.duration) - docDuration) <= 1.0,
    JSON.stringify(aoProbe.streams.map((s) => s.codec_name)));

  // ============================ E7: range export ================================
  const rangeRes = await alice.call("POST", `/api/projects/${projectId}/exports`, {
    body: { targets: [{ kind: "document" }], settings: small({ rangeStart: 1, rangeEnd: 3 }) },
  });
  const rangeJob = await waitForExport(alice, rangeRes.data.jobs[0].id);
  check("range export COMPLETED", rangeJob.status === "COMPLETED", rangeJob.error ?? "");
  const rangeFile = await downloadToFile(alice, rangeJob.id, "range.mp4");
  const rangeProbe = ffprobeJson(rangeFile);
  check("range export is ~2s (the selected range only)",
    Math.abs(Number(rangeProbe.format.duration) - 2) <= 1.0, `${rangeProbe.format.duration}`);

  // ============================ E8: enhancement pair ============================
  const cfgPut = await alice.call("PUT", `/api/editor/${doc.id}/enhancement`, {
    body: {
      videoEnabled: true, audioEnabled: false,
      video: { brightness: 0.3 }, audio: {},
      scope: "project", itemIds: [],
    },
  });
  check("enhancement config saved for the export pair", cfgPut.status === 200, JSON.stringify(cfgPut.data).slice(0, 200));
  const plainRes = await alice.call("POST", `/api/projects/${projectId}/exports`, {
    body: { targets: [{ kind: "document" }], settings: small({ keyframeInterval: 2 }) },
  });
  const plainExp = await waitForExport(alice, plainRes.data.jobs[0].id);
  const enhRes = await alice.call("POST", `/api/projects/${projectId}/exports`, {
    body: { targets: [{ kind: "document" }], settings: small({ keyframeInterval: 2, includeEnhancement: true }) },
  });
  const enhExp = await waitForExport(alice, enhRes.data.jobs[0].id);
  check("enhancement pair: both COMPLETED", plainExp.status === "COMPLETED" && enhExp.status === "COMPLETED",
    `${plainExp.error ?? ""} ${enhExp.error ?? ""}`);
  const plainFile2 = await downloadToFile(alice, plainExp.id, "plain2.mp4");
  const enhFile = await downloadToFile(alice, enhExp.id, "enhanced.mp4");
  const tSafe = Math.max(3.2, docDuration - 1.2);
  const plainMean = frameGrayMean(plainFile2, tSafe);
  const enhMean = frameGrayMean(enhFile, tSafe);
  check("enhancement is reflected in the export (brightness delta > 6)",
    enhMean - plainMean > 6, `plain=${plainMean.toFixed(1)} enhanced=${enhMean.toFixed(1)}`);

  // ============================ E22: audio toggles ==============================
  const musicOnlyRes = await alice.call("POST", `/api/projects/${projectId}/exports`, {
    body: {
      targets: [{ kind: "document" }],
      settings: small({ includeOriginalAudio: false, includeMusic: true, includeBrollAudio: false, keyframeInterval: 3 }),
    },
  });
  const musicOnly = await waitForExport(alice, musicOnlyRes.data.jobs[0].id);
  check("music-only export COMPLETED", musicOnly.status === "COMPLETED", musicOnly.error ?? "");
  const musicOnlyFile = await downloadToFile(alice, musicOnly.id, "music-only.mp4");
  const moVol = meanVolumeDb(musicOnlyFile, 0.2, Math.min(3, docDuration - 0.5));
  check("music-only: the music track is audible without the original audio", moVol !== null && moVol > -45, `mean=${moVol}`);
  const allOffRes = await alice.call("POST", `/api/projects/${projectId}/exports`, {
    body: {
      targets: [{ kind: "document" }],
      settings: small({ includeOriginalAudio: false, includeMusic: false, includeBrollAudio: false, keyframeInterval: 4 }),
    },
  });
  const allOff = await waitForExport(alice, allOffRes.data.jobs[0].id);
  check("all-audio-off export COMPLETED (QC expects silence)", allOff.status === "COMPLETED", allOff.error ?? "");
  const allOffFile = await downloadToFile(alice, allOff.id, "all-off.mp4");
  const allOffProbe = ffprobeJson(allOffFile);
  check("all-audio-off: output has NO audio stream, as configured",
    !allOffProbe.streams.some((s) => s.codec_type === "audio"));

  // ============================ E5: Hindi captions ==============================
  const hiProj = await alice.call("POST", "/api/projects", {
    body: { name: "Hindi Export", workflowType: "LONG_VIDEO_TO_SHORTS" },
  });
  const hiProjectId = hiProj.data.project.id;
  const hiAsset = await uploadSource(alice, hiProjectId, fx.speaker, "speech.mp4");
  db.prepare(
    "INSERT INTO processing_tasks (id, user_id, project_id, source_asset_id, status, stage, created_at, updated_at) VALUES ('exp-hi-task', ?, ?, ?, 'COMPLETED', 'COMPLETED', ?, ?)",
  ).run(aliceId, hiProjectId, hiAsset.id, now, now);
  db.prepare(
    "INSERT INTO transcripts (id, task_id, project_id, source_asset_id, language, language_probability, duration, full_text, provider, model, created_at) VALUES ('exp-hi-transcript', 'exp-hi-task', ?, ?, 'hi', 0.9, 4.8, ?, 'local-faster-whisper', 'small', ?)",
  ).run(hiProjectId, hiAsset.id, "नमस्ते यह एक हिंदी वाक्य है", now);
  db.prepare(
    "INSERT INTO transcript_segments (id, transcript_id, idx, start_sec, end_sec, text, words_json) VALUES ('exp-hi-seg-1', 'exp-hi-transcript', 0, 0.0, 4.8, ?, NULL)",
  ).run("नमस्ते यह एक हिंदी वाक्य है");
  db.prepare(
    "INSERT INTO candidate_clips (id, task_id, project_id, source_asset_id, user_id, start_sec, end_sec, duration, score, reasons_json, suggested_title, title, transcript_excerpt, status, preview_status, created_at) VALUES ('exp-hi-candidate', 'exp-hi-task', ?, ?, ?, 0.0, 4.8, 4.8, 80, '[]', 'Hindi clip', 'Hindi clip', ?, 'SELECTED', 'READY', ?)",
  ).run(hiProjectId, hiAsset.id, aliceId, "नमस्ते यह एक हिंदी वाक्य है", now);
  const hiRes = await alice.call("POST", `/api/projects/${hiProjectId}/exports`, {
    body: {
      targets: [{ kind: "candidate", id: "exp-hi-candidate" }],
      settings: small({ captionMode: "separate", captionFormat: "srt" }),
    },
  });
  const hiJob = await waitForExport(alice, hiRes.data.jobs[0].id);
  check("Hindi export COMPLETED", hiJob.status === "COMPLETED", hiJob.error ?? "");
  const hiSrtRes = await downloadExport(alice, hiJob.id, "srt");
  const hiSrt = await hiSrtRes.text();
  check("Hindi SRT download carries the Devanagari text intact",
    hiSrtRes.status === 200 && hiSrt.includes("नमस्ते यह एक हिंदी वाक्य है"), hiSrt.slice(0, 120));

  // ============================ E9: reframing ===================================
  const missingReframe = await alice.call("POST", `/api/projects/${projectId}/exports`, {
    body: { targets: [{ kind: "document" }], settings: small({ includeReframe: true, keyframeInterval: 11 }) },
  });
  check("reframe requested without tracking data → FAILED job with diagnostics (not a silent success)",
    missingReframe.status === 201 && missingReframe.data.jobs[0].status === "FAILED" &&
      /refram/i.test(missingReframe.data.jobs[0].error ?? ""),
    JSON.stringify(missingReframe.data).slice(0, 300));
  const missingReframeJobId = missingReframe.data.jobs[0].id;

  const rfProj = await alice.call("POST", "/api/projects", {
    body: { name: "Reframe Export", workflowType: "LONG_VIDEO_TO_SHORTS" },
  });
  const rfProjectId = rfProj.data.project.id;
  await uploadSource(alice, rfProjectId, ONE_FACE, "one-face.mp4");
  const rfDocRes = await getDoc(alice, rfProjectId);
  const rfDoc = rfDocRes.document;
  const trackRes = await alice.call("POST", `/api/projects/${rfProjectId}/tracking-jobs`, { body: {} });
  check("tracking job created for the reframe project", trackRes.status === 201 || trackRes.status === 200,
    JSON.stringify(trackRes.data).slice(0, 200));
  {
    const start = Date.now();
    let tJob = null;
    for (;;) {
      const res = await alice.call("GET", `/api/tracking-jobs/${trackRes.data.job.id}`);
      tJob = res.data.job;
      if (tJob && ["COMPLETED", "FAILED", "CANCELLED"].includes(tJob.status)) break;
      if (Date.now() - start > 300000) throw new Error("tracking job did not finish");
      await new Promise((r) => setTimeout(r, 750));
    }
    check("tracking COMPLETED on the face fixture", tJob.status === "COMPLETED", tJob.error ?? "");
  }
  const cfgRes = await alice.call("PUT", `/api/editor/${rfDoc.id}/reframe/config`, {
    body: { mode: "face-lock", aspect: "custom", outWidth: 360, outHeight: 640 },
  });
  check("face-lock reframe config saved (360x640)", cfgRes.status === 200, JSON.stringify(cfgRes.data).slice(0, 200));
  const rfRes = await alice.call("POST", `/api/projects/${rfProjectId}/exports`, {
    body: {
      targets: [{ kind: "document" }],
      settings: small({ includeReframe: true, resolution: "original", aspect: "original" }),
    },
  });
  const rfJob = await waitForExport(alice, rfRes.data.jobs[0].id);
  check("reframed export COMPLETED", rfJob.status === "COMPLETED", rfJob.error ?? "");
  const rfFile = await downloadToFile(alice, rfJob.id, "reframed.mp4");
  const rfProbe = ffprobeJson(rfFile);
  const rfVideo = rfProbe.streams.find((s) => s.codec_type === "video");
  check("reframed export uses the reframe canvas 360x640", rfVideo?.width === 360 && rfVideo?.height === 640,
    `${rfVideo?.width}x${rfVideo?.height}`);
  check("reframed export keeps its audio", rfProbe.streams.some((s) => s.codec_type === "audio"));
  const rfFrame = path.join(tmp, "reframed-frame.jpg");
  run("ffmpeg", ["-v", "error", "-y", "-ss", "2", "-i", rfFile, "-frames:v", "1", rfFrame]);
  const rfFaces = detectFacesInImage(rfFrame);
  check("YuNet re-detects the locked face in the reframed export", rfFaces.length >= 1, JSON.stringify(rfFaces));

  // ============================ invalid settings ================================
  const badCombo = await alice.call("POST", `/api/projects/${projectId}/exports`, {
    body: { targets: [{ kind: "document" }], settings: { ...CLIENT_DEFAULT_SETTINGS, container: "webm" } },
  });
  check("invalid: WebM + H.264 rejected 400 naming the VP9 alternative",
    badCombo.status === 400 && /VP9/i.test(JSON.stringify(badCombo.data)), `got ${badCombo.status}: ${JSON.stringify(badCombo.data).slice(0, 200)}`);
  const badCrf = await alice.call("POST", `/api/projects/${projectId}/exports`, {
    body: { targets: [{ kind: "document" }], settings: { ...CLIENT_DEFAULT_SETTINGS, qualityMode: "crf", crf: 60 } },
  });
  check("invalid: CRF 60 for H.264 rejected 400", badCrf.status === 400, `got ${badCrf.status}`);
  const badMp3 = await alice.call("POST", `/api/projects/${projectId}/exports`, {
    body: { targets: [{ kind: "document" }], settings: { ...CLIENT_DEFAULT_SETTINGS, audioCodec: "libmp3lame" } },
  });
  check("invalid: MP3 without audio-only rejected 400", badMp3.status === 400, `got ${badMp3.status}`);
  const badField = await alice.call("POST", `/api/projects/${projectId}/exports`, {
    body: { targets: [{ kind: "document" }], settings: { ...CLIENT_DEFAULT_SETTINGS, surpriseField: 1 } },
  });
  check("invalid: unknown settings field rejected 400 (strict schema)", badField.status === 400, `got ${badField.status}`);
  const badTarget = await alice.call("POST", `/api/projects/${projectId}/exports`, {
    body: { targets: [{ kind: "bogus" }], settings: CLIENT_DEFAULT_SETTINGS },
  });
  check("invalid: unknown target kind rejected 400", badTarget.status === 400, `got ${badTarget.status}`);

  // ============================ queue controls ==================================
  // A deliberately slow job (1080p, maximum quality, slow encoder)
  // so the queue controls can be exercised while it is RUNNING. (Not
  // 2160p: this suite's /tmp is a 512 MB tmpfs and the storage
  // preflight — correctly — refuses a 4K job there; the 2160p path
  // itself was verified separately on the real disk.)
  const bigRes = await alice.call("POST", `/api/projects/${projectId}/exports`, {
    body: {
      targets: [{ kind: "document" }],
      settings: small({ aspect: "16:9", resolution: "1080p", qualityPreset: "maximum", encoderPreset: "slow", keyframeInterval: 12 }),
    },
  });
  const bigJobId = bigRes.data.jobs[0].id;
  await waitForStatus(alice, bigJobId, "RUNNING", 120000);
  check("queue: the big export is RUNNING (worker claimed it)", true);
  const pauseRunning = await alice.call("POST", `/api/export-jobs/${bigJobId}/pause`, { body: {} });
  check("queue: pausing a RUNNING export is refused honestly (409)",
    pauseRunning.status === 409 && pauseRunning.data.error?.code === "CANNOT_PAUSE_RUNNING",
    `got ${pauseRunning.status}: ${JSON.stringify(pauseRunning.data).slice(0, 160)}`);

  const smallRes = await alice.call("POST", `/api/projects/${projectId}/exports`, {
    body: { targets: [{ kind: "candidate", id: candB.id }], settings: small({ keyframeInterval: 5 }) },
  });
  const smallJobId = smallRes.data.jobs[0].id;
  const pauseRes = await alice.call("POST", `/api/export-jobs/${smallJobId}/pause`, { body: {} });
  check("queue: a QUEUED export can be held (PAUSED)", pauseRes.status === 200 && pauseRes.data.job.status === "PAUSED",
    JSON.stringify(pauseRes.data).slice(0, 200));
  const pausedList = await alice.call("GET", "/api/exports/queue?status=paused");
  check("queue: held job listed under the Paused filter with no queue position",
    pausedList.data.jobs.some((j) => j.id === smallJobId && j.queuePosition === null && j.held === true));

  const p1Res = await alice.call("POST", `/api/projects/${projectId}/exports`, {
    body: { targets: [{ kind: "candidate", id: candB.id }], settings: small({ keyframeInterval: 6 }) },
  });
  const p2Res = await alice.call("POST", `/api/projects/${projectId}/exports`, {
    body: { targets: [{ kind: "candidate", id: candB.id }], settings: small({ keyframeInterval: 7 }) },
  });
  const p1Id = p1Res.data.jobs[0].id;
  const p2Id = p2Res.data.jobs[0].id;
  const prioRes = await alice.call("PATCH", `/api/export-jobs/${p2Id}/priority`, { body: { priority: 5 } });
  check("queue: priority change accepted on a queued job", prioRes.status === 200 && prioRes.data.job.priority === 5);
  const posList = await alice.call("GET", "/api/exports/queue?sort=position&status=queued");
  const posP1 = posList.data.jobs.find((j) => j.id === p1Id)?.queuePosition;
  const posP2 = posList.data.jobs.find((j) => j.id === p2Id)?.queuePosition;
  check("queue: boosted job now sits ahead in queue position",
    typeof posP1 === "number" && typeof posP2 === "number" && posP2 < posP1, `p1=${posP1} p2=${posP2}`);
  const cancelP1 = await alice.call("POST", `/api/export-jobs/${p1Id}/cancel`, { body: {} });
  check("queue: cancelling a QUEUED job lands CANCELLED", cancelP1.status === 200 && cancelP1.data.job.status === "CANCELLED");
  const cancelP2 = await alice.call("POST", `/api/export-jobs/${p2Id}/cancel`, { body: {} });
  check("queue: second queued cancel also works", cancelP2.status === 200 && cancelP2.data.job.status === "CANCELLED");

  const cancelBig = await alice.call("POST", `/api/export-jobs/${bigJobId}/cancel`, { body: {} });
  check("queue: cancel request accepted for the RUNNING job", cancelBig.status === 200, JSON.stringify(cancelBig.data).slice(0, 160));
  const bigFinal = await waitForExport(alice, bigJobId, 300000);
  check("queue: RUNNING job ends CANCELLED (FFmpeg child killed)", bigFinal.status === "CANCELLED", bigFinal.status);

  const resumeRes = await alice.call("POST", `/api/export-jobs/${smallJobId}/resume`, { body: {} });
  check("queue: resume un-holds the paused job", resumeRes.status === 200 && resumeRes.data.job.status === "QUEUED");
  const smallFinal = await waitForExport(alice, smallJobId);
  check("queue: resumed job renders to COMPLETED (the hold was real)", smallFinal.status === "COMPLETED", smallFinal.error ?? "");

  // ============================ missing source → retry ==========================
  fs.rmSync(sourceDiskPath);
  const missRes = await alice.call("POST", `/api/projects/${projectId}/exports`, {
    body: { targets: [{ kind: "document" }], settings: small({ keyframeInterval: 9 }) },
  });
  check("missing source: job is created as FAILED (preflight), not a silent 200 success",
    missRes.status === 201 && missRes.data.jobs[0].status === "FAILED" && missRes.data.jobs[0].stage === "VALIDATING",
    JSON.stringify(missRes.data).slice(0, 300));
  const missJobId = missRes.data.jobs[0].id;
  const missDetail = await alice.call("GET", `/api/export-jobs/${missJobId}`);
  const missPf = missDetail.data.validation.find((v) => v.phase === "PREFLIGHT");
  check("missing source: preflight diagnostics persisted (assets-exist failed)",
    missPf?.ok === false && missPf?.checks?.some((c) => c.id === "assets-exist" && c.ok === false),
    JSON.stringify(missPf).slice(0, 300));
  check("missing source: the render was never attempted (no start time)",
    missDetail.data.job.startedAt === null && missDetail.data.errors.length >= 1);
  const missHistory = await alice.call("GET", "/api/exports/history");
  check("missing source: history records the failure with a reason",
    missHistory.data.outputs.some((o) => o.jobId === missJobId && o.status === "FAILED" && o.failureReason));

  fs.copyFileSync(fx.speaker, sourceDiskPath);
  const retryRes = await alice.call("POST", `/api/export-jobs/${missJobId}/retry`, { body: {} });
  check("retry: failed job re-queued with retryCount 1",
    retryRes.status === 200 && retryRes.data.job.status === "QUEUED" && retryRes.data.job.retryCount === 1,
    JSON.stringify(retryRes.data).slice(0, 200));
  const retried = await waitForExport(alice, missJobId);
  check("retry: after restoring the source the export COMPLETES", retried.status === "COMPLETED", retried.error ?? "");

  // ============================ download security ===============================
  const bobDownload = await bob.raw("GET", `/api/export-jobs/${e1Id}/download`);
  check("security: cross-user download is 404", bobDownload.status === 404, `got ${bobDownload.status}`);
  const bobDetail = await bob.call("GET", `/api/export-jobs/${e1Id}`);
  check("security: cross-user job detail is 404", bobDetail.status === 404, `got ${bobDetail.status}`);
  const anonDownload = await new Client().raw("GET", `/api/export-jobs/${e1Id}/download`);
  check("security: unauthenticated download is 401", anonDownload.status === 401, `got ${anonDownload.status}`);
  const notReady = await alice.raw("GET", `/api/export-jobs/${missJobId}/download`);
  check("security: download of a retried-then-completed job works (200)", notReady.status === 200, `got ${notReady.status}`);

  const goneRes = await alice.call("POST", `/api/projects/${projectId}/exports`, {
    body: { targets: [{ kind: "candidate", id: candB.id }], settings: small({ keyframeInterval: 8 }) },
  });
  const goneJob = await waitForExport(alice, goneRes.data.jobs[0].id);
  check("410 setup: dedicated export COMPLETED", goneJob.status === "COMPLETED", goneJob.error ?? "");
  const goneRow = db.prepare("SELECT storage_key FROM export_outputs WHERE job_id = ?").get(goneJob.id);
  fs.rmSync(path.join(process.env.MEDIA_DIR, goneRow.storage_key));
  const goneDownload = await alice.raw("GET", `/api/export-jobs/${goneJob.id}/download`);
  check("security: a deleted output file is a 410 OUTPUT_MISSING, not a broken stream",
    goneDownload.status === 410 && (await goneDownload.clone().json().catch(() => ({})))?.error?.code === "OUTPUT_MISSING",
    `got ${goneDownload.status}`);

  const delNoConfirm = await alice.call("DELETE", `/api/export-jobs/${e1Id}`);
  check("delete: export job delete without confirmation is refused (409 CONFIRMATION_REQUIRED)",
    delNoConfirm.status === 409 && delNoConfirm.data?.error?.code === "CONFIRMATION_REQUIRED",
    `got ${delNoConfirm.status} ${JSON.stringify(delNoConfirm.data).slice(0, 160)}`);
  const stillThere = await alice.call("GET", `/api/export-jobs/${e1Id}`);
  check("delete: the refused delete left the job intact (still COMPLETED)",
    stillThere.status === 200 && stillThere.data.job.status === "COMPLETED",
    `got ${stillThere.status} ${stillThere.data?.job?.status}`);
  const stillDownloads = await alice.raw("GET", `/api/export-jobs/${e1Id}/download`);
  check("delete: the refused delete left the output file downloadable (200)",
    stillDownloads.status === 200, `got ${stillDownloads.status}`);
  const delRes = await alice.call("DELETE", `/api/export-jobs/${e1Id}?confirm=true`);
  check("delete: confirmed export job removed (204)", delRes.status === 204, `got ${delRes.status}`);
  const delDownload = await alice.raw("GET", `/api/export-jobs/${e1Id}/download`);
  check("delete: its download is gone (404)", delDownload.status === 404, `got ${delDownload.status}`);
  check("delete: the project SOURCE file is untouched (SHA-256 unchanged)",
    sha256File(sourceDiskPath) === sourceShaBefore);

  // ==================== history delete confirmation ============================
  const histBefore = await alice.call("GET", "/api/exports/history");
  const goneOutput = histBefore.data.outputs.find((o) => o.jobId === goneJob.id);
  check("history delete setup: the dedicated export has a history entry", Boolean(goneOutput));
  const histNoConfirm = await alice.call("DELETE", `/api/exports/history/${goneOutput.id}`);
  check("history delete: without confirmation is refused (409 CONFIRMATION_REQUIRED)",
    histNoConfirm.status === 409 && histNoConfirm.data?.error?.code === "CONFIRMATION_REQUIRED",
    `got ${histNoConfirm.status} ${JSON.stringify(histNoConfirm.data).slice(0, 160)}`);
  const histMid = await alice.call("GET", "/api/exports/history");
  check("history delete: the refused delete left the history entry intact",
    histMid.data.outputs.some((o) => o.id === goneOutput.id));
  const histDel = await alice.call("DELETE", `/api/exports/history/${goneOutput.id}`, { body: { confirm: true } });
  check("history delete: confirmed via JSON body { confirm: true } succeeds (204)",
    histDel.status === 204, `got ${histDel.status}`);
  const histAfter = await alice.call("GET", "/api/exports/history");
  check("history delete: the entry is gone after confirmation",
    !histAfter.data.outputs.some((o) => o.id === goneOutput.id));
  check("history delete: the project SOURCE file is still untouched (SHA-256 unchanged)",
    sha256File(sourceDiskPath) === sourceShaBefore);

  // ============================ preset-driven export ============================
  const presetExport = await alice.call("POST", `/api/projects/${projectId}/exports`, {
    body: { targets: [{ kind: "candidate", id: candB.id }], presetId: customPresetId },
  });
  check("preset export: created from presetId alone", presetExport.status === 201, JSON.stringify(presetExport.data).slice(0, 200));
  const presetJob = await waitForExport(alice, presetExport.data.jobs[0].id);
  check("preset export COMPLETED", presetJob.status === "COMPLETED", presetJob.error ?? "");
  const presetFile = await downloadToFile(alice, presetJob.id, "preset.mp4");
  const presetProbe = ffprobeJson(presetFile);
  const presetVideo = presetProbe.streams.find((s) => s.codec_type === "video");
  check("preset export honours the preset (1:1 at 720p class = 720x720)",
    presetVideo?.width === 720 && presetVideo?.height === 720, `${presetVideo?.width}x${presetVideo?.height}`);
  const delPreset = await alice.call("DELETE", `/api/export-presets/${customPresetId}`);
  check("presets: custom preset deleted (204)", delPreset.status === 204, `got ${delPreset.status}`);

  // ============================ ZIP bundle API ==================================
  const bundleApiRes = await alice.call("POST", "/api/exports/bundles", {
    body: { jobIds: [batchDocJob.id, webmJob.id] },
  });
  check("bundle: created for two completed exports (201)", bundleApiRes.status === 201, JSON.stringify(bundleApiRes.data).slice(0, 200));
  const bundleId = bundleApiRes.data.bundle.id;
  let bundleState = null;
  {
    const start = Date.now();
    for (;;) {
      const res = await alice.call("GET", `/api/export-bundles/${bundleId}`);
      bundleState = res.data.bundle;
      if (["COMPLETED", "FAILED"].includes(bundleState.status)) break;
      if (Date.now() - start > 120000) throw new Error("bundle did not finish");
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  check("bundle: zipping job COMPLETED", bundleState.status === "COMPLETED", bundleState.error ?? "");
  const bundleDl = await alice.raw("GET", `/api/export-bundles/${bundleId}/download`);
  const bundleZipPath = path.join(tmp, "api-bundle.zip");
  fs.writeFileSync(bundleZipPath, Buffer.from(await bundleDl.arrayBuffer()));
  const apiZipList = run("python3", ["-c", "import zipfile,sys; print('\\n'.join(zipfile.ZipFile(sys.argv[1]).namelist()))", bundleZipPath]);
  check("bundle: ZIP contains both exports under their output names",
    apiZipList.includes(batchDocJob.outputName) && apiZipList.includes(webmJob.outputName), apiZipList);
  const badBundle = await alice.call("POST", "/api/exports/bundles", { body: { jobIds: [missingReframeJobId] } });
  check("bundle: bundling a FAILED export is refused (400)", badBundle.status === 400, `got ${badBundle.status}`);
  const bobBundle = await bob.call("GET", `/api/export-bundles/${bundleId}`);
  check("bundle: cross-user bundle is 404", bobBundle.status === 404, `got ${bobBundle.status}`);

  // ==================== audit fixes (migration v10) ===========================
  // Platform presets: TikTok / X / LinkedIn join the original six.
  const presetsAll = await alice.call("GET", "/api/export-presets");
  check("presets: TikTok, X/Twitter and LinkedIn built-ins are listed",
    ["builtin:tiktok", "builtin:x-twitter", "builtin:linkedin"].every((id) => presetsAll.data.presets.some((p) => p.id === id && p.builtin)),
    JSON.stringify(presetsAll.data.presets.map((p) => p.id)));
  const tiktokPf = await alice.call("POST", `/api/projects/${projectId}/exports/preflight`, {
    body: { target: { kind: "candidate", id: candB.id }, presetId: "builtin:tiktok" },
  });
  check("presets: applying TikTok yields a 1080x1920 MP4/H.264 canvas in preflight",
    tiktokPf.status === 200 && tiktokPf.data.summary?.width === 1080 && tiktokPf.data.summary?.height === 1920 &&
    tiktokPf.data.summary?.videoCodec === "libx264" && tiktokPf.data.summary?.container === "mp4",
    JSON.stringify(tiktokPf.data?.summary).slice(0, 200));
  const tiktokRes = await alice.call("POST", `/api/projects/${projectId}/exports`, {
    body: { targets: [{ kind: "candidate", id: candB.id }], presetId: "builtin:tiktok" },
  });
  const tiktokJob = await waitForExport(alice, tiktokRes.data.jobs[0].id);
  check("presets: TikTok export COMPLETED", tiktokJob.status === "COMPLETED", tiktokJob.error ?? "");
  const tiktokFile = await downloadToFile(alice, tiktokJob.id, "tiktok.mp4");
  const tiktokVideo = ffprobeJson(tiktokFile).streams.find((s) => s.codec_type === "video");
  check("presets: TikTok output probes at 1080x1920",
    tiktokVideo?.width === 1080 && tiktokVideo?.height === 1920, `${tiktokVideo?.width}x${tiktokVideo?.height}`);

  // Export target persistence (migration v10): the batch jobs above
  // know what they were made from, and History reports it.
  const histV10 = await alice.call("GET", "/api/exports/history");
  const candEntry = histV10.data.outputs.find((o) => o.jobId === batchCandJob.id);
  const docEntry = histV10.data.outputs.find((o) => o.jobId === batchDocJob.id);
  check("target persistence: a candidate export remembers its candidate (kind + id)",
    candEntry?.targetKind === "candidate" && candEntry?.targetId === candB.id,
    JSON.stringify(candEntry).slice(0, 220));
  check("target persistence: a document export records kind=document with no target id",
    docEntry?.targetKind === "document" && docEntry?.targetId === null,
    JSON.stringify(docEntry).slice(0, 220));

  // Queue thumbnails: poster frame extracted at completion, served
  // owner-only through the thumbnail route.
  check("thumbnail: a completed export exposes a poster-frame URL",
    Boolean(batchCandJob.output?.thumbnailUrl), JSON.stringify(batchCandJob.output).slice(0, 220));
  const thumbRes = await alice.raw("GET", `/api/export-jobs/${batchCandJob.id}/thumbnail`);
  const thumbBuf = Buffer.from(await thumbRes.arrayBuffer());
  check("thumbnail: served to the owner as a JPEG",
    thumbRes.status === 200 && (thumbRes.headers.get("content-type") ?? "").includes("image/jpeg") &&
    thumbBuf[0] === 0xff && thumbBuf[1] === 0xd8,
    `status=${thumbRes.status} ct=${thumbRes.headers.get("content-type")}`);
  const bobThumb = await bob.raw("GET", `/api/export-jobs/${batchCandJob.id}/thumbnail`);
  check("thumbnail: cross-user request is 404", bobThumb.status === 404, `got ${bobThumb.status}`);
  const anonThumb = await new Client().raw("GET", `/api/export-jobs/${batchCandJob.id}/thumbnail`);
  check("thumbnail: unauthenticated request is 401", anonThumb.status === 401, `got ${anonThumb.status}`);

  // Preflight additions: the B-roll media check runs (and passes)
  // on the main document, which carries a B-roll placement.
  const docPf = await alice.call("POST", `/api/projects/${projectId}/exports/preflight`, {
    body: { target: { kind: "document" }, settings: small() },
  });
  check("preflight: the B-roll media check runs when the document has B-roll placements",
    docPf.data.checks?.some((c) => c.id === "broll-media" && c.ok === true),
    JSON.stringify(docPf.data.checks?.map((c) => c.id)));

  // Preflight additions: caption timing. A fresh project whose
  // stored captions OVERLAP beyond tolerance (editor validation
  // allows overlaps; export preflight must not) fails the check
  // with the cues named, and creating the export records a FAILED
  // job at VALIDATING with the same check persisted.
  const ctProj = await alice.call("POST", "/api/projects", { body: { name: "Caption Timing", workflowType: "LONG_VIDEO_TO_SHORTS" } });
  const ctProjectId = ctProj.data.project.id;
  const ctAsset = await uploadSource(alice, ctProjectId, fx.speaker, "speaker.mp4");
  const ctNow = new Date().toISOString();
  db.prepare("INSERT INTO processing_tasks (id, user_id, project_id, source_asset_id, status, stage, created_at, updated_at) VALUES ('ct-task-1', ?, ?, ?, 'COMPLETED', 'COMPLETED', ?, ?)").run(aliceId, ctProjectId, ctAsset.id, ctNow, ctNow);
  db.prepare("INSERT INTO transcripts (id, task_id, project_id, source_asset_id, language, language_probability, duration, full_text, provider, model, created_at) VALUES ('ct-transcript-1', 'ct-task-1', ?, ?, 'en', 0.95, ?, ?, 'local-faster-whisper', 'small', ?)").run(ctProjectId, ctAsset.id, fx.bounds[2].end, SENTENCES.join(" "), ctNow);
  SENTENCES.forEach((text, i) => {
    db.prepare("INSERT INTO transcript_segments (id, transcript_id, idx, start_sec, end_sec, text, words_json) VALUES (?, 'ct-transcript-1', ?, ?, ?, ?, NULL)").run(`ct-seg-${i}`, i, fx.bounds[i].start, fx.bounds[i].end, text);
  });
  db.prepare("INSERT INTO candidate_clips (id, task_id, project_id, source_asset_id, user_id, start_sec, end_sec, duration, score, reasons_json, suggested_title, title, transcript_excerpt, status, preview_status, created_at) VALUES ('ct-candidate-a', 'ct-task-1', ?, ?, ?, 0, ?, ?, 85, '[]', 'Timing Clip', 'Timing Clip', '', 'SELECTED', 'READY', ?)").run(ctProjectId, ctAsset.id, aliceId, fx.bounds[1].end, fx.bounds[1].end, ctNow);
  const ctDoc = (await getDoc(alice, ctProjectId, "?seedCandidateId=ct-candidate-a")).document;
  check("caption-timing setup: seeded doc carries captions", ctDoc.captions.length >= 2, `captions=${ctDoc.captions.length}`);
  const overlapped = ctDoc.captions.map((c, i) => (i === 1 ? { ...c, start: Math.max(0, ctDoc.captions[0].end - 0.5) } : c));
  const ctOp = await alice.call("POST", `/api/editor/${ctDoc.id}/operations`, {
    body: {
      type: "test_caption_overlap",
      state: { canvas: ctDoc.canvas, settings: ctDoc.settings, tracks: ctDoc.tracks, items: ctDoc.items, captions: overlapped, sceneOverrides: ctDoc.sceneOverrides },
      operationId: crypto.randomUUID(),
      baseCursor: ctDoc.undoCursor,
    },
  });
  check("caption-timing setup: overlapping captions are storable editor state", ctOp.status === 200, JSON.stringify(ctOp.data).slice(0, 200));
  const ctPf = await alice.call("POST", `/api/projects/${ctProjectId}/exports/preflight`, {
    body: { target: { kind: "document" }, settings: small({ captionMode: "burn" }) },
  });
  const ctCheckRow = ctPf.data.checks?.find((c) => c.id === "caption-timing");
  check("preflight: overlapping cues fail caption-timing with the cues named",
    ctPf.data.ok === false && ctCheckRow?.ok === false && /overlaps cue 1/.test(ctCheckRow?.detail ?? ""),
    JSON.stringify(ctCheckRow).slice(0, 260));
  const ctCreate = await alice.call("POST", `/api/projects/${ctProjectId}/exports`, {
    body: { targets: [{ kind: "document" }], settings: small({ captionMode: "burn" }) },
  });
  check("preflight: the bad-timing export is created FAILED at VALIDATING (never rendered)",
    ctCreate.status === 201 && ctCreate.data.jobs[0].status === "FAILED" && ctCreate.data.jobs[0].stage === "VALIDATING",
    JSON.stringify(ctCreate.data).slice(0, 240));

  // Test #24 refresh-during-render: poll job detail + queue WHILE a
  // real export renders. Reads must never error, the final encode's
  // progress must be monotonic, and the job completes.
  const liveRes = await alice.call("POST", `/api/projects/${projectId}/exports`, {
    body: { targets: [{ kind: "document" }], settings: small({ resolution: "720p", keyframeInterval: 7 }) },
  });
  const liveJobId = liveRes.data.jobs[0].id;
  let liveFinal = null;
  {
    let polls = 0;
    let badReads = 0;
    let sawRunning = false;
    const encodePercents = [];
    const start = Date.now();
    for (;;) {
      const [detail, queue] = await Promise.all([
        alice.call("GET", `/api/export-jobs/${liveJobId}`),
        alice.call("GET", "/api/exports/queue?status=all"),
      ]);
      polls += 1;
      if (detail.status !== 200 || queue.status !== 200 || !detail.data?.job) badReads += 1;
      const job = detail.data?.job;
      if (job?.status === "RUNNING") sawRunning = true;
      if (job?.stage === "ENCODING" && job?.progress?.percent != null) encodePercents.push(job.progress.percent);
      if (job && ["COMPLETED", "FAILED", "CANCELLED"].includes(job.status)) { liveFinal = job; break; }
      if (Date.now() - start > 300000) throw new Error("live-poll export did not finish");
      await new Promise((r) => setTimeout(r, 120));
    }
    check("refresh-during-render: polling job + queue mid-render never errored",
      badReads === 0 && polls >= 3 && sawRunning, `polls=${polls} badReads=${badReads} sawRunning=${sawRunning}`);
    check("refresh-during-render: final-encode progress is monotonic while polled",
      encodePercents.length >= 2 && encodePercents.every((p, i) => i === 0 || p >= encodePercents[i - 1] - 0.001),
      encodePercents.join(","));
    check("refresh-during-render: the export COMPLETED under polling",
      liveFinal?.status === "COMPLETED", liveFinal?.error ?? "");
  }
  check("progress detail: expectedFrames + elapsedSec recorded from the real encode",
    typeof liveFinal?.progress?.expectedFrames === "number" && liveFinal.progress.expectedFrames > 0 &&
    typeof liveFinal?.progress?.elapsedSec === "number" && liveFinal.progress.elapsedSec >= 0,
    JSON.stringify(liveFinal?.progress));
  check("worker id: the claiming worker is recorded on the job",
    typeof liveFinal?.workerId === "string" && /^worker-\d+-\d+$/.test(liveFinal.workerId),
    liveFinal?.workerId ?? "null");

  // Test #22 encode-stage failure + retry: block the deliverable
  // store AFTER every render pass by replacing the renders directory
  // with a regular file (the final mkdir/copy then throws past
  // VALIDATING, at VERIFYING_OUTPUT), assert FAILED + diagnostics,
  // restore, retry -> COMPLETED.
  const rendersDir = path.join(process.env.MEDIA_DIR, aliceId, "renders");
  const rendersBak = `${rendersDir}.bak`;
  let victimId = null;
  let victimFinal = null;
  fs.renameSync(rendersDir, rendersBak);
  fs.writeFileSync(rendersDir, "blocked");
  try {
    const victimRes = await alice.call("POST", `/api/projects/${projectId}/exports`, {
      body: { targets: [{ kind: "candidate", id: candA.id }], settings: small({ keyframeInterval: 6 }) },
    });
    victimId = victimRes.data.jobs[0].id;
    victimFinal = await waitForExport(alice, victimId);
  } finally {
    fs.rmSync(rendersDir, { force: true });
    fs.renameSync(rendersBak, rendersDir);
  }
  check("encode-stage failure: job FAILED when the finished output could not be stored",
    victimFinal?.status === "FAILED", victimFinal?.error ?? "");
  check("encode-stage failure: the failure is PAST preflight (stage is not VALIDATING)",
    victimFinal?.stage !== "VALIDATING" && victimFinal?.stage !== "QUEUED", `stage=${victimFinal?.stage}`);
  const victimDetail = await alice.call("GET", `/api/export-jobs/${victimId}`);
  check("encode-stage failure: diagnostics persisted (QC validation row + error message)",
    victimDetail.data.validation.some((v) => v.phase === "QC") && Boolean(victimFinal?.error),
    JSON.stringify(victimDetail.data.validation).slice(0, 220));
  const victimRetry = await alice.call("POST", `/api/export-jobs/${victimId}/retry`, { body: {} });
  check("encode-stage failure: retry re-queues the job",
    victimRetry.status === 200 && victimRetry.data.job.status === "QUEUED", `got ${victimRetry.status}`);
  const victimRetried = await waitForExport(alice, victimId);
  check("encode-stage failure: after restoring storage the retry COMPLETES",
    victimRetried.status === "COMPLETED", victimRetried.error ?? "");

  // ZIP bundle from History: create from a history OUTPUT id (the
  // server maps it to its job) and download a real ZIP.
  const histBundleRes = await alice.call("POST", "/api/exports/bundles", { body: { outputIds: [candEntry.id] } });
  check("history bundle: created from a history output id (201)",
    histBundleRes.status === 201, JSON.stringify(histBundleRes.data).slice(0, 200));
  let histBundleState = null;
  {
    const start = Date.now();
    for (;;) {
      const res = await alice.call("GET", `/api/export-bundles/${histBundleRes.data.bundle.id}`);
      histBundleState = res.data.bundle;
      if (["COMPLETED", "FAILED"].includes(histBundleState.status)) break;
      if (Date.now() - start > 120000) throw new Error("history bundle did not finish");
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  check("history bundle: zipping COMPLETED", histBundleState.status === "COMPLETED", histBundleState.error ?? "");
  const histBundleDl = await alice.raw("GET", `/api/export-bundles/${histBundleRes.data.bundle.id}/download`);
  const histZipPath = path.join(tmp, "history-bundle.zip");
  fs.writeFileSync(histZipPath, Buffer.from(await histBundleDl.arrayBuffer()));
  const histZipList = run("python3", ["-c", "import zipfile,sys; print('\\n'.join(zipfile.ZipFile(sys.argv[1]).namelist()))", histZipPath]);
  check("history bundle: ZIP contains the selected export under its output name",
    histZipList.includes(batchCandJob.outputName), histZipList);

  // ============================ restart recovery ================================
  const queueBefore = await alice.call("GET", "/api/exports/queue?status=completed");
  const completedBefore = queueBefore.data.jobs.map((j) => j.id);
  db.prepare(
    `INSERT INTO render_jobs (id, version_id, project_id, user_id, status, stage, settings_json, output_path, error, cancel_requested, created_at, updated_at, started_at, finished_at, kind, priority, retry_count, progress_json, output_name)
     VALUES ('exp-fake-running', ?, ?, ?, 'RUNNING', 'COMPOSING', '{"state":null}', NULL, NULL, 0, ?, ?, ?, NULL, 'EXPORT', 0, 0, NULL, 'fake.mp4')`,
  ).run(doc.id, projectId, aliceId, now, now, now);
  db.prepare(
    `INSERT INTO export_bundles (id, user_id, status, stage, job_ids_json, output_path, error, created_at, updated_at, finished_at)
     VALUES ('exp-fake-bundle', ?, 'RUNNING', 'ZIPPING', '[]', NULL, NULL, ?, ?, NULL)`,
  ).run(aliceId, now, now);
  db.close();
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  await new Promise((r) => setTimeout(r, 1200));
  server = spawnServer();
  await waitForHealth();
  const fakeDetail = await alice.call("GET", "/api/export-jobs/exp-fake-running");
  check("restart: a job left RUNNING is marked FAILED at worker boot",
    fakeDetail.status === 200 && fakeDetail.data.job.status === "FAILED", JSON.stringify(fakeDetail.data?.job).slice(0, 200));
  check("restart: the interruption is recorded honestly",
    /interrupt/i.test(fakeDetail.data.job.error ?? ""), fakeDetail.data.job.error ?? "");
  const fakeBundle = await alice.call("GET", "/api/export-bundles/exp-fake-bundle");
  check("restart: a RUNNING bundle is marked FAILED at boot",
    fakeBundle.data.bundle.status === "FAILED", JSON.stringify(fakeBundle.data.bundle));
  const queueAfter = await alice.call("GET", "/api/exports/queue?status=completed");
  check("restart: completed exports survive a server restart",
    completedBefore.every((id) => queueAfter.data.jobs.some((j) => j.id === id)),
    `${completedBefore.length} completed before`);
  const surviveDl = await alice.raw("GET", `/api/export-jobs/${batchCandJob.id}/download`);
  check("restart: a completed export still downloads after restart", surviveDl.status === 200, `got ${surviveDl.status}`);
  const queueAgain = await alice.call("GET", "/api/exports/queue?status=completed");
  check("queue: repeated reads are stable (persistence across refresh)",
    JSON.stringify(queueAfter.data.jobs.map((j) => j.id)) === JSON.stringify(queueAgain.data.jobs.map((j) => j.id)));

  console.log(`\nPhase 9 export e2e: ${passed} passed, ${failed} failed`);
  if (failures.length) console.log("failures:", failures.join(" | "));
  process.exitCode = failed > 0 ? 1 : 0;
} catch (err) {
  console.error("SUITE ERROR:", err);
  console.log((server.log ?? "").slice(-3000));
  process.exitCode = 1;
} finally {
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
}
