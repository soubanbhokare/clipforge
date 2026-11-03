// Phase 7 Face Lock / Active Speaker / Smart Auto-Reframing e2e checks.
//
// Runs against a REAL spawned server (fresh temp DB + media dir on a
// scratch port) with REAL photographic-face fixtures:
//   server/tests/fixtures/tracking/*.mp4 are built from AI-generated
//   photographic portraits animated with FFmpeg (pan/zoom for the
//   single-face clip, a side-by-side composite for two faces, a
//   sliding overlay for the moving-person clip, a hard cut between
//   two portraits for the scene-change clip, testsrc2 for no-face).
// YuNet ACTUALLY detects the faces in these fixtures (verified at
// build time: 1 face @ ~0.95 confidence in each portrait); if a
// fixture is missing it is rebuilt from the committed portrait JPGs.
//
// The suite exercises the real pipeline end to end: tracking jobs
// (Python CV child process), subject association, persisted crop
// keyframes, and reframe renders through the Phase 5/6 FFmpeg
// pipeline — including a YuNet re-detection on a rendered frame to
// prove the face actually lands in the output frame.
//
// NOT covered (reported UNVERIFIED, never faked): active-speaker
// ACCURACY on a real two-person conversation (fixtures are still
// portraits with synthetic speech; the suite only checks that
// associations carry their evidence), and boot recovery (same code
// pattern as Phase 4's verified recovery; not re-tested here).
//
// Run: npm run test:tracking

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const PORT = 3227;
const BASE = `http://localhost:${PORT}`;
const FIXTURES = path.join(serverDir, "tests", "fixtures", "tracking");
const FACE_MODEL = path.join(serverDir, "models", "face_detection_yunet_2023mar.onnx");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-tracking-"));
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
    throw new Error(`${cmd} ${args.join(" ")} failed: ${res.stderr?.slice(-800) ?? res.stdout?.slice(-800)}`);
  }
  return res.stdout;
}

function ffprobeJson(file) {
  return JSON.parse(
    run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]),
  );
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** Rebuild any missing fixture videos from the committed portraits. */
function ensureFixtures() {
  const need = ["one-face.mp4", "two-face.mp4", "moving.mp4", "scene-change.mp4", "no-face.mp4"];
  if (need.every((f) => fs.existsSync(path.join(FIXTURES, f)))) return;
  const build = path.join(FIXTURES, "build");
  fs.mkdirSync(build, { recursive: true });
  const speech = (text, out) => run("espeak-ng", ["-v", "en", "-s", "135", "-w", out, text]);
  const seg = (img, text, out) => {
    const wav = out + ".wav";
    speech(text, wav);
    const dur = Number(ffprobeJson(wav).format.duration);
    run("ffmpeg", ["-v", "error", "-y", "-loop", "1", "-i", img, "-i", wav,
      "-filter_complex", `[0:v]crop=1280:720:0:160,zoompan=z='1+0.13*on/90':d=90:s=640x360:fps=30[v]`,
      "-map", "[v]", "-map", "1:a", "-t", dur.toFixed(2), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", out]);
    return dur;
  };
  if (!fs.existsSync(path.join(FIXTURES, "one-face.mp4"))) {
    seg(path.join(FIXTURES, "portrait-a.jpg"), "The quick brown fox jumps over the lazy dog near the river bank today.", path.join(FIXTURES, "one-face.mp4"));
  }
  if (!fs.existsSync(path.join(FIXTURES, "scene-change.mp4"))) {
    const a = path.join(build, "scene-a.mp4");
    const b = path.join(build, "scene-b.mp4");
    seg(path.join(FIXTURES, "portrait-a.jpg"), "First scene speaker talks about morning plans.", a);
    seg(path.join(FIXTURES, "portrait-b.jpg"), "Second scene begins after the cut right here.", b);
    fs.writeFileSync(path.join(build, "list.txt"), `file '${a}'\nfile '${b}'\n`);
    run("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", path.join(build, "list.txt"), "-c", "copy", path.join(FIXTURES, "scene-change.mp4")]);
  }
  if (!fs.existsSync(path.join(FIXTURES, "two-face.mp4"))) {
    const wav = path.join(build, "two.wav");
    speech("Two people are having a conversation about the weekend plans together.", wav);
    const dur = Number(ffprobeJson(wav).format.duration);
    run("ffmpeg", ["-v", "error", "-y", "-loop", "1", "-i", path.join(FIXTURES, "portrait-a.jpg"), "-loop", "1", "-i", path.join(FIXTURES, "portrait-b.jpg"), "-i", wav,
      "-filter_complex", "[0:v]crop=640:720:320:160,scale=320:360[a];[1:v]crop=640:720:320:160,scale=320:360[b];[a][b]hstack[v]",
      "-map", "[v]", "-map", "2:a", "-t", dur.toFixed(2), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", path.join(FIXTURES, "two-face.mp4")]);
  }
  if (!fs.existsSync(path.join(FIXTURES, "moving.mp4"))) {
    const wav = path.join(build, "moving.wav");
    speech("The quick brown fox jumps over the lazy dog near the river bank today.", wav);
    const dur = Number(ffprobeJson(wav).format.duration);
    const frames = Math.round(dur * 30);
    run("ffmpeg", ["-v", "error", "-y", "-loop", "1", "-i", path.join(FIXTURES, "portrait-a.jpg"), "-i", wav,
      "-filter_complex", `[0:v]crop=720:720:280:80,scale=240:240[fg];color=c=0x101418:s=640x360:r=30:d=${dur.toFixed(2)}[bg];[bg][fg]overlay=x='20+360*n/${frames}':y=60[v]`,
      "-map", "[v]", "-map", "1:a", "-t", dur.toFixed(2), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", path.join(FIXTURES, "moving.mp4")]);
  }
  if (!fs.existsSync(path.join(FIXTURES, "no-face.mp4"))) {
    const wav = path.join(build, "noface.wav");
    speech("This video has speech but no people in it at all.", wav);
    const dur = Number(ffprobeJson(wav).format.duration);
    run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=s=640x360:r=30:d=${dur.toFixed(2)}`, "-i", wav,
      "-map", "0:v", "-map", "1:a", "-t", dur.toFixed(2), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", path.join(FIXTURES, "no-face.mp4")]);
  }
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

function bandBrightness(png, y0frac, y1frac) {
  const out = run(
    "ffmpeg",
    ["-v", "error", "-i", png, "-vf", `crop=iw:ih*${(y1frac - y0frac).toFixed(3)}:0:ih*${y0frac.toFixed(3)},format=gray`, "-f", "rawvideo", "-"],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
  if (out.length === 0) return 0;
  let sum = 0;
  for (const b of out) sum += b;
  return sum / out.length;
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
      body: {
        displayName: "Tracking Tester",
        email,
        password: pw,
        confirmPassword: pw,
        termsAccepted: true,
      },
    });
    if (res.status !== 201) throw new Error(`register failed: ${JSON.stringify(res.data)}`);
    return res.data.user;
  }
}

async function waitForHealth(timeoutMs = 30000) {
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

async function waitForTracking(client, jobId, timeoutMs = 300000) {
  const start = Date.now();
  for (;;) {
    const res = await client.call("GET", `/api/tracking-jobs/${jobId}`);
    const job = res.data.job;
    if (job && ["COMPLETED", "FAILED", "CANCELLED"].includes(job.status)) return job;
    if (Date.now() - start > timeoutMs) throw new Error(`tracking job ${jobId} did not finish`);
    await new Promise((r) => setTimeout(r, 750));
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

async function projectWithUpload(client, name, fixture) {
  const created = await client.call("POST", "/api/projects", {
    body: { name, workflowType: "LONG_VIDEO_TO_SHORTS" },
  });
  if (created.status !== 201) throw new Error(`project failed: ${JSON.stringify(created.data)}`);
  const projectId = created.data.project.id;
  const buf = fs.readFileSync(path.join(FIXTURES, fixture));
  const session = await client.call("POST", `/api/projects/${projectId}/upload-session`, {
    body: { filename: fixture, size: buf.length },
  });
  if (session.status !== 201) throw new Error(`upload session failed: ${JSON.stringify(session.data)}`);
  const form = new FormData();
  form.append("file", new Blob([buf], { type: "video/mp4" }), fixture);
  const res = await client.raw("POST", `/api/upload-sessions/${session.data.session.id}/file`, { formData: form });
  const data = await res.json().catch(() => null);
  if (res.status !== 200) throw new Error(`upload failed ${res.status}: ${JSON.stringify(data)}`);
  const docRes = await client.call("GET", `/api/projects/${projectId}/editor`);
  if (docRes.status !== 200 && docRes.status !== 201) {
    throw new Error(`editor doc failed: ${docRes.status} ${JSON.stringify(docRes.data).slice(0, 200)}`);
  }
  return { projectId, assetId: data.asset.id, doc: docRes.data.document };
}

async function runTracking(client, projectId) {
  const res = await client.call("POST", `/api/projects/${projectId}/tracking-jobs`, { body: {} });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`tracking create failed: ${JSON.stringify(res.data)}`);
  }
  return waitForTracking(client, res.data.job.id);
}

async function getReframe(client, docId) {
  const res = await client.call("GET", `/api/editor/${docId}/reframe`);
  if (res.status !== 200) throw new Error(`reframe state failed: ${JSON.stringify(res.data)}`);
  return res.data;
}

async function downloadRender(client, jobId, outPath) {
  const res = await client.raw("GET", `/api/render-jobs/${jobId}/download`);
  if (res.status !== 200) throw new Error(`render download failed: ${res.status}`);
  fs.writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
  return outPath;
}


console.log("Phase 7 tracking e2e — spawning server on", BASE);
ensureFixtures();
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
  await alice.register("alice-track@example.com");
  await bob.register("bob-track@example.com");
  console.log("registered two users");

  const fixtureHashes = Object.fromEntries(
    ["one-face.mp4", "two-face.mp4", "moving.mp4", "scene-change.mp4", "no-face.mp4"].map((f) => [
      f,
      sha256(path.join(FIXTURES, f)),
    ]),
  );

  // ---- provider status -----------------------------------------------------
  const statusRes = await alice.call("GET", "/api/tracking/status");
  check("provider status: face model configured", statusRes.data.configured === true, JSON.stringify(statusRes.data));
  check("provider status: YuNet model named", /yunet/i.test(statusRes.data.faceModel ?? ""));
  const personConfigured = statusRes.data.personConfigured === true;
  console.log(`  ..  person model configured: ${personConfigured} (${statusRes.data.personModel ?? "absent"})`);

  // ---- CSRF ------------------------------------------------------------------
  {
    const noCsrf = new Client();
    noCsrf.cookies = alice.cookies; // session but no CSRF token
    const res = await noCsrf.raw("POST", "/api/projects/whatever/tracking-jobs", { body: {} });
    check("tracking job create without CSRF token is rejected (403)", res.status === 403, `got ${res.status}`);
  }

  // ============================ ONE FACE =====================================
  console.log("— one-face fixture —");
  const one = await projectWithUpload(alice, "One Face", "one-face.mp4");
  const create1 = await alice.call("POST", `/api/projects/${one.projectId}/tracking-jobs`, { body: {} });
  check("tracking job created (201)", create1.status === 201, JSON.stringify(create1.data));
  const create2 = await alice.call("POST", `/api/projects/${one.projectId}/tracking-jobs`, { body: {} });
  check(
    "duplicate active job is deduplicated",
    create2.data.deduplicated === true && create2.data.job.id === create1.data.job.id,
    JSON.stringify(create2.data).slice(0, 200),
  );
  const oneJob = await waitForTracking(alice, create1.data.job.id);
  check("one-face job COMPLETED", oneJob.status === "COMPLETED", JSON.stringify(oneJob).slice(0, 300));
  check("one-face outcome SUBJECTS_FOUND", oneJob.outcome === "SUBJECTS_FOUND");

  let state = await getReframe(alice, one.doc.id);
  const oneFaces = state.subjects.filter((s) => s.kind === "face");
  check("one-face: exactly 1 face subject", oneFaces.length === 1, `got ${oneFaces.length}`);
  const faceSubject = oneFaces[0];
  check(
    "one-face: real detector confidence > 0.8",
    (faceSubject?.bestConfidence ?? 0) > 0.8,
    `conf=${faceSubject?.bestConfidence}`,
  );
  check(
    "one-face: subject auto-selected when exactly one face",
    state.config.subjectKey === faceSubject?.key,
    `config.subjectKey=${state.config.subjectKey}`,
  );
  check("one-face: crop keyframes computed", state.keyframes.length >= 5, `got ${state.keyframes.length}`);
  check(
    "one-face: associations carry mouth-motion proxy evidence",
    state.associations.length > 0 &&
      state.associations.every((a) => typeof a.evidence?.note === "string" && a.evidence.note.includes("proxy")),
    `associations=${state.associations.length}`,
  );
  if (faceSubject?.hasThumbnail) {
    const thumb = await alice.raw("GET", `/api/tracking-jobs/${state.job.id}/subjects/${faceSubject.id}/thumbnail`);
    check("subject thumbnail streams (200, jpeg)", thumb.status === 200 && (thumb.headers.get("content-type") ?? "").includes("image/jpeg"));
    const bobThumb = await bob.raw("GET", `/api/tracking-jobs/${state.job.id}/subjects/${faceSubject.id}/thumbnail`);
    check("thumbnail cross-user is 404", bobThumb.status === 404, `got ${bobThumb.status}`);
  } else {
    check("subject thumbnail exists", false, "hasThumbnail was false");
  }

  // Face Lock + 9:16 render, verified by re-detecting the face in the output.
  const flState = await alice.call("PUT", `/api/editor/${one.doc.id}/reframe/config`, {
    body: { mode: "face-lock", aspect: "9:16" },
  });
  check("config: face-lock + 9:16 accepted", flState.status === 200, JSON.stringify(flState.data).slice(0, 200));
  check(
    "config: output dims follow the 9:16 preset",
    flState.data.config.outWidth === 1080 && flState.data.config.outHeight === 1920,
  );
  const renderRes = await alice.call("POST", `/api/editor/${one.doc.id}/reframe-render`, { body: {} });
  check("reframe render created", renderRes.status === 201 || renderRes.status === 200, JSON.stringify(renderRes.data).slice(0, 200));
  const renderJob = await waitForRender(alice, renderRes.data.job.id);
  check("face-lock render COMPLETED", renderJob.status === "COMPLETED", renderJob.error ?? "");
  const outFile = await downloadRender(alice, renderJob.id, path.join(tmp, "facelock-916.mp4"));
  const outProbe = ffprobeJson(outFile);
  const outVideo = outProbe.streams.find((s) => s.codec_type === "video");
  const outAudio = outProbe.streams.find((s) => s.codec_type === "audio");
  check("render is 1080x1920", outVideo?.width === 1080 && outVideo?.height === 1920, `${outVideo?.width}x${outVideo?.height}`);
  check("render preserves audio (A/V together)", Boolean(outAudio));
  const srcProbe = ffprobeJson(path.join(FIXTURES, "one-face.mp4"));
  check(
    "render duration within 1.0s of source",
    Math.abs(Number(outProbe.format.duration) - Number(srcProbe.format.duration)) <= 1.0,
    `${outProbe.format.duration} vs ${srcProbe.format.duration}`,
  );
  const framePng = path.join(tmp, "facelock-frame.jpg");
  run("ffmpeg", ["-v", "error", "-y", "-ss", "2", "-i", outFile, "-frames:v", "1", framePng]);
  const facesInRender = detectFacesInImage(framePng);
  check("YuNet re-detects a face in the reframed render", facesInRender.length >= 1, JSON.stringify(facesInRender));
  if (facesInRender.length >= 1) {
    const [fx, , fw] = facesInRender[0];
    const cxFrac = (fx + fw / 2) / 1080;
    check(
      "reframed face sits in the central 60% of the output",
      cxFrac > 0.2 && cxFrac < 0.8,
      `centre=${cxFrac.toFixed(2)}`,
    );
  }

  // Caption burn-in still works on a reframed render (small canvas for speed).
  await alice.call("PUT", `/api/editor/${one.doc.id}/reframe/config`, {
    body: { aspect: "custom", outWidth: 360, outHeight: 640 },
  });
  const docNow = (await alice.call("GET", `/api/projects/${one.projectId}/editor`)).data.document;
  const opRes = await alice.call("POST", `/api/editor/${one.doc.id}/operations`, {
    body: {
      type: "caption_update",
      baseCursor: docNow.undoCursor,
      state: {
        canvas: docNow.canvas,
        settings: docNow.settings,
        tracks: docNow.tracks,
        items: docNow.items,
        captions: [
          { id: "cap-reframe", start: 0.5, end: 3.5, text: "REFRAME CAPTION CHECK", words: null, style: null, language: "en" },
        ],
        sceneOverrides: docNow.sceneOverrides,
      },
    },
  });
  check("caption added to the document", opRes.status === 200, JSON.stringify(opRes.data).slice(0, 200));
  // No caption background box + a large font, so burned-in text only
  // ADDS brightness to the bottom band (the default style's dark box
  // would darken it and confound the on/off comparison).
  const docStyled = (await alice.call("GET", `/api/projects/${one.projectId}/editor`)).data.document;
  await alice.call("PATCH", `/api/editor/${one.doc.id}/settings`, {
    body: {
      settings: {
        captionStyle: { ...docStyled.settings.captionStyle, backgroundOpacity: 0, fontSize: 64 },
        showCaptions: true,
      },
    },
  });
  const capRender = await alice.call("POST", `/api/editor/${one.doc.id}/reframe-render`, { body: {} });
  const capJob = await waitForRender(alice, capRender.data.job.id);
  check("caption reframe render COMPLETED", capJob.status === "COMPLETED", capJob.error ?? "");
  const capFile = await downloadRender(alice, capJob.id, path.join(tmp, "cap-on.mp4"));
  await alice.call("PATCH", `/api/editor/${one.doc.id}/settings`, { body: { settings: { showCaptions: false } } });
  const noCapRender = await alice.call("POST", `/api/editor/${one.doc.id}/reframe-render`, { body: {} });
  const noCapJob = await waitForRender(alice, noCapRender.data.job.id);
  const noCapFile = await downloadRender(alice, noCapJob.id, path.join(tmp, "cap-off.mp4"));
  const capFrame = path.join(tmp, "cap-on.jpg");
  const noCapFrame = path.join(tmp, "cap-off.jpg");
  run("ffmpeg", ["-v", "error", "-y", "-ss", "1.5", "-i", capFile, "-frames:v", "1", capFrame]);
  run("ffmpeg", ["-v", "error", "-y", "-ss", "1.5", "-i", noCapFile, "-frames:v", "1", noCapFrame]);
  // ASS Alignment 2 default = bottom-centre in the Phase 6 renderer.
  const brightOn = bandBrightness(capFrame, 0.8, 0.98);
  const brightOff = bandBrightness(noCapFrame, 0.8, 0.98);
  check(
    "caption burn-in visible on reframed render (bottom band brighter)",
    brightOn > brightOff + 2,
    `on=${brightOn.toFixed(1)} off=${brightOff.toFixed(1)}`,
  );
  await alice.call("PATCH", `/api/editor/${one.doc.id}/settings`, { body: { settings: { showCaptions: true } } });

  // Manual keyframe override.
  const mkRes = await alice.call("POST", `/api/editor/${one.doc.id}/reframe/keyframes`, {
    body: { t: 2, crop: { x: 0.05, y: 0.05, w: 0.4, h: 0.4 } },
  });
  check("manual keyframe accepted", mkRes.status === 201, JSON.stringify(mkRes.data).slice(0, 200));
  const atTwo = mkRes.data.keyframes.find((k) => Math.abs(k.t - 2) < 0.01);
  check(
    "manual keyframe overrides AI crop at its timestamp",
    atTwo?.crop && Math.abs(atTwo.crop.x - 0.05) < 0.01 && Math.abs(atTwo.crop.w - 0.4) < 0.01,
    JSON.stringify(atTwo?.crop),
  );
  const manualId = mkRes.data.manualKeyframes[0]?.id;
  const delRes = await alice.call("DELETE", `/api/editor/${one.doc.id}/reframe/keyframes/${manualId}`);
  check("manual keyframe deleted", delRes.status === 200 && delRes.data.manualKeyframes.length === 0);
  const atTwoAfter = delRes.data.keyframes.find((k) => Math.abs(k.t - 2) < 0.01);
  check(
    "AI crop restored after manual keyframe removal",
    !atTwoAfter?.crop || Math.abs(atTwoAfter.crop.x - 0.05) > 0.01 || Math.abs(atTwoAfter.crop.w - 0.4) > 0.01,
  );

  // ============================ TWO FACES ====================================
  console.log("— two-face fixture —");
  const two = await projectWithUpload(alice, "Two Faces", "two-face.mp4");
  const twoJob = await runTracking(alice, two.projectId);
  check("two-face job COMPLETED", twoJob.status === "COMPLETED", JSON.stringify(twoJob).slice(0, 200));
  const twoState = await getReframe(alice, two.doc.id);
  const twoFaces = twoState.subjects.filter((s) => s.kind === "face");
  check("two-face: exactly 2 face subjects", twoFaces.length === 2, `got ${twoFaces.length}: ${twoState.subjects.map((s) => s.key).join(",")}`);
  check(
    "two-face: no auto-selection with multiple faces",
    twoState.config.subjectKey === null,
    `subjectKey=${twoState.config.subjectKey}`,
  );
  const pick = twoFaces[1] ?? twoFaces[0];
  const selRes = await alice.call("PUT", `/api/editor/${two.doc.id}/reframe/config`, {
    body: { mode: "face-lock", subjectKey: pick.key },
  });
  check("manual subject selection accepted", selRes.status === 200);
  const locked = selRes.data.keyframes.filter((k) => k.subjectKey);
  check(
    "face-lock keyframes follow the SELECTED subject",
    locked.length > 0 && locked.every((k) => k.subjectKey === pick.key),
    `subjects in path: ${[...new Set(locked.map((k) => k.subjectKey))].join(",")}`,
  );

  // Split screen with 2 subjects renders stacked output of config dims.
  const splitRes = await alice.call("PUT", `/api/editor/${two.doc.id}/reframe/split`, {
    body: { layout: "side-by-side" },
  });
  check("split layout accepted with 2 subjects", splitRes.status === 200, JSON.stringify(splitRes.data).slice(0, 200));
  check("split regions reference both subjects", (splitRes.data.split?.regions?.length ?? 0) === 2);
  const splitRender = await alice.call("POST", `/api/editor/${two.doc.id}/reframe-render`, { body: {} });
  const splitJob = await waitForRender(alice, splitRender.data.job.id);
  check("split render COMPLETED", splitJob.status === "COMPLETED", splitJob.error ?? "");
  const splitFile = await downloadRender(alice, splitJob.id, path.join(tmp, "split.mp4"));
  const splitProbe = ffprobeJson(splitFile);
  const splitVideo = splitProbe.streams.find((s) => s.codec_type === "video");
  check(
    "split render matches config canvas",
    splitVideo?.width === splitRes.data.config.outWidth && splitVideo?.height === splitRes.data.config.outHeight,
    `${splitVideo?.width}x${splitVideo?.height} vs ${splitRes.data.config.outWidth}x${splitRes.data.config.outHeight}`,
  );
  check("split render keeps audio", splitProbe.streams.some((s) => s.codec_type === "audio"));

  // Split refused on the one-face doc (fewer than 2 subjects).
  const splitDeny = await alice.call("PUT", `/api/editor/${one.doc.id}/reframe/config`, {
    body: { mode: "split-screen" },
  });
  check(
    "split-screen refused with <2 DISTINCT people (face+its own person box = 1 human, 422)",
    splitDeny.status === 422,
    `got ${splitDeny.status}`,
  );

  // Split layout must reject the same subject in two regions (the
  // route's error message has always claimed this; it is enforced).
  const dupSplit = await alice.call("PUT", `/api/editor/${two.doc.id}/reframe/split`, {
    body: {
      layout: "custom",
      regions: [
        { subjectKey: twoFaces[0].key, rect: { x: 0, y: 0, w: 0.5, h: 1 } },
        { subjectKey: twoFaces[0].key, rect: { x: 0.5, y: 0, w: 0.5, h: 1 } },
      ],
    },
  });
  check(
    "split layout with a duplicate subject is rejected (400)",
    dupSplit.status === 400,
    `got ${dupSplit.status}: ${JSON.stringify(dupSplit.data).slice(0, 160)}`,
  );

  // Face Lock with several faces and NO selection must NOT silently
  // follow the dominant face: the path holds one static framing until
  // the user picks a subject, then it follows the picked subject.
  const noPickRes = await alice.call("PUT", `/api/editor/${two.doc.id}/reframe/config`, {
    body: { mode: "face-lock", subjectKey: null },
  });
  check("face-lock with no selection accepted", noPickRes.status === 200, JSON.stringify(noPickRes.data).slice(0, 200));
  const noPickCrops = new Set(noPickRes.data.keyframes.filter((k) => k.crop).map((k) => JSON.stringify(k.crop)));
  check(
    "multi-face + no selection: crop path is one static framing (no silent auto-pick)",
    noPickRes.data.keyframes.length > 0 && noPickCrops.size === 1,
    `distinct crops=${noPickCrops.size}`,
  );
  check(
    "multi-face + no selection: no keyframe claims a followed subject",
    noPickRes.data.keyframes.every((k) => !k.subjectKey),
    `subjects: ${[...new Set(noPickRes.data.keyframes.map((k) => k.subjectKey))].join(",")}`,
  );
  const rePickRes = await alice.call("PUT", `/api/editor/${two.doc.id}/reframe/config`, {
    body: { subjectKey: pick.key },
  });
  const rePickCrops = new Set(rePickRes.data.keyframes.filter((k) => k.crop).map((k) => JSON.stringify(k.crop)));
  check(
    "selecting a subject after no-pick makes the path follow it (crops differ from static)",
    rePickRes.status === 200 &&
      rePickRes.data.keyframes.some((k) => k.subjectKey === pick.key) &&
      !(rePickCrops.size === 1 && noPickCrops.size === 1 && [...rePickCrops][0] === [...noPickCrops][0]),
    `distinct crops after pick=${rePickCrops.size}`,
  );

  // ============================ MOVING =======================================
  console.log("— moving fixture —");
  const moving = await projectWithUpload(alice, "Moving", "moving.mp4");
  const movingJob = await runTracking(alice, moving.projectId);
  check("moving job COMPLETED", movingJob.status === "COMPLETED");
  const movingState = await getReframe(alice, moving.doc.id);
  await alice.call("PUT", `/api/editor/${moving.doc.id}/reframe/config`, {
    body: { mode: "face-lock", subjectKey: movingState.subjects.find((s) => s.kind === "face")?.key ?? null },
  });
  const movingState2 = await getReframe(alice, moving.doc.id);
  const xs = movingState2.keyframes.filter((k) => k.crop).map((k) => Math.round(k.crop.x * 50) / 50);
  const distinctX = new Set(xs).size;
  const rangeX = xs.length ? Math.max(...xs) - Math.min(...xs) : 0;
  check("moving: crop path actually moves (>=3 distinct x positions)", distinctX >= 3, `distinct=${distinctX}`);
  check("moving: crop x range > 0.15 (follows across the frame)", rangeX > 0.15, `range=${rangeX.toFixed(2)}`);
  if (personConfigured) {
    check(
      "moving: person detector also finds the person",
      movingState.subjects.some((s) => s.kind === "person"),
      `subjects: ${movingState.subjects.map((s) => `${s.key}:${s.kind}`).join(",")}`,
    );
  }

  // Sensitivity is a REAL control: at sensitivity = 1 the confidence
  // floor (0.98) sits above every stored sample (faces ~0.93-0.94,
  // persons ~0.91-0.92), so the followed path collapses to one static
  // framing; restoring the default (0.5) makes it follow again.
  const sensRes = await alice.call("PUT", `/api/editor/${moving.doc.id}/reframe/config`, {
    body: { controls: { sensitivity: 1 } },
  });
  check("sensitivity=1 config accepted", sensRes.status === 200, JSON.stringify(sensRes.data).slice(0, 200));
  const sensCrops = sensRes.data.keyframes.filter((k) => k.crop);
  const sensDistinct = new Set(sensCrops.map((k) => JSON.stringify(k.crop)));
  check(
    "sensitivity=1: followed path collapses to one static framing",
    sensCrops.length > 0 && sensDistinct.size === 1,
    `distinct crops=${sensDistinct.size} of ${sensCrops.length}`,
  );
  check(
    "sensitivity=1: no keyframe follows a subject",
    sensRes.data.keyframes.every((k) => !k.subjectKey),
    `subjects: ${[...new Set(sensRes.data.keyframes.map((k) => k.subjectKey))].join(",")}`,
  );
  const sensBack = await alice.call("PUT", `/api/editor/${moving.doc.id}/reframe/config`, {
    body: { controls: { sensitivity: 0.5 } },
  });
  const backXs = new Set(sensBack.data.keyframes.filter((k) => k.crop).map((k) => Math.round(k.crop.x * 50) / 50));
  check(
    "sensitivity restored to default: path follows the moving face again (>=3 distinct x)",
    sensBack.status === 200 && backXs.size >= 3,
    `distinct x=${backXs.size}`,
  );

  // ===================== PHASE 7 GAP FIXES ===================================
  console.log("— gap fixes: controls / enabled / paused / manual-crop / split-crop / reset —");
  const pathSig = (kfs) => kfs.filter((k) => k.crop).map((k) => JSON.stringify(k.crop)).join("|");
  const meanArea = (kfs) => {
    const c = kfs.filter((k) => k.crop);
    return c.length ? c.reduce((a, k) => a + k.crop.w * k.crop.h, 0) / c.length : 0;
  };

  // Every Auto-Follow control (sensitivity is covered above) measurably
  // changes the computed path on the moving-face doc. Probes run at a
  // 1:1 output aspect: at 9:16 these fixtures' large faces saturate
  // the crop against the frame height (w clamps to the full-height
  // slice), which would hide zoom/margin/aggressiveness entirely —
  // at 1:1 the crop stays inside the frame and every control shows.
  const mvConfigUrl = `/api/editor/${moving.doc.id}/reframe/config`;
  await alice.call("PUT", mvConfigUrl, { body: { aspect: "1:1" } });
  // Probe arms pin the OTHER controls where the crop stays inside
  // the frame: at the default margin (0.5) this fixture's face crop
  // saturates against the frame at every zoom, hiding the very
  // controls being measured. At margin 0 the crop is unsaturated and
  // zoom/aggressiveness move it measurably.
  const controlProbes = [
    ["zoom", { margin: 0, zoom: 0 }, { margin: 0, zoom: 1 }],
    ["margin", { margin: 0 }, { margin: 1 }],
    ["smoothing", { smoothing: 0 }, { smoothing: 1 }],
    ["followSpeed", { followSpeed: 0 }, { followSpeed: 1 }],
    // smoothing 0 maximises the size-adaptation contrast aggressiveness drives.
    ["aggressiveness", { margin: 0, zoom: 1, smoothing: 0, aggressiveness: 0 }, { margin: 0, zoom: 1, smoothing: 0, aggressiveness: 1 }],
  ];
  for (const [name, lo, hi] of controlProbes) {
    const loRes = await alice.call("PUT", mvConfigUrl, { body: { controls: lo } });
    const hiRes = await alice.call("PUT", mvConfigUrl, { body: { controls: hi } });
    check(
      `control ${name}: low vs high produce measurably different crop paths`,
      loRes.status === 200 && hiRes.status === 200 && pathSig(loRes.data.keyframes) !== pathSig(hiRes.data.keyframes),
      `${name}: paths identical`,
    );
    if (name === "zoom" || name === "margin") {
      check(
        `control ${name}: mean crop area changes`,
        Math.abs(meanArea(loRes.data.keyframes) - meanArea(hiRes.data.keyframes)) > 0.01,
        `${name}: area ${meanArea(loRes.data.keyframes).toFixed(3)} vs ${meanArea(hiRes.data.keyframes).toFixed(3)}`,
      );
    }
  }
  await alice.call("PUT", mvConfigUrl, {
    body: {
      aspect: "9:16",
      controls: { sensitivity: 0.5, followSpeed: 0.6, smoothing: 0.6, margin: 0.5, zoom: 0.5, aggressiveness: 0.5 },
    },
  });

  // Face Lock OFF: the persisted path itself must go static (the
  // preview reads these keyframes), and the render gate still refuses.
  const oneConfigUrl = `/api/editor/${one.doc.id}/reframe/config`;
  const offRes = await alice.call("PUT", oneConfigUrl, { body: { mode: "face-lock", enabled: false } });
  check("face-lock OFF accepted", offRes.status === 200, JSON.stringify(offRes.data).slice(0, 200));
  const offCrops = new Set(offRes.data.keyframes.filter((k) => k.crop).map((k) => JSON.stringify(k.crop)));
  check(
    "face-lock OFF: persisted path is one static framing",
    offRes.data.keyframes.length > 0 && offCrops.size === 1,
    `distinct crops=${offCrops.size}`,
  );
  check(
    "face-lock OFF: no keyframe follows a subject",
    offRes.data.keyframes.every((k) => !k.subjectKey),
  );
  const offRender = await alice.call("POST", `/api/editor/${one.doc.id}/reframe-render`, { body: {} });
  check(
    "face-lock OFF: render still refused (400 FACE_LOCK_OFF)",
    offRender.status === 400 && JSON.stringify(offRender.data).includes("FACE_LOCK_OFF"),
    `got ${offRender.status}: ${JSON.stringify(offRender.data).slice(0, 160)}`,
  );
  const onRes = await alice.call("PUT", oneConfigUrl, { body: { enabled: true } });
  check(
    "face-lock back ON: path follows the face again",
    onRes.status === 200 && onRes.data.keyframes.some((k) => k.subjectKey),
  );

  // Persisted Auto-Follow pause: static path, survives reload, resume
  // restores following. (Previously a preview-only local toggle.)
  const pauseRes = await alice.call("PUT", oneConfigUrl, { body: { paused: true } });
  check(
    "pause auto-follow accepted and reported on the config",
    pauseRes.status === 200 && pauseRes.data.config.paused === true,
    JSON.stringify(pauseRes.data?.config).slice(0, 200),
  );
  const pauseCrops = new Set(pauseRes.data.keyframes.filter((k) => k.crop).map((k) => JSON.stringify(k.crop)));
  check(
    "paused: persisted path is one static framing with no followed subject",
    pauseRes.data.keyframes.length > 0 && pauseCrops.size === 1 && pauseRes.data.keyframes.every((k) => !k.subjectKey),
    `distinct crops=${pauseCrops.size}`,
  );
  const pauseReload = await getReframe(alice, one.doc.id);
  check("paused survives a reload (persisted, not preview-only)", pauseReload.config.paused === true);
  const resumeRes = await alice.call("PUT", oneConfigUrl, { body: { paused: false } });
  check(
    "resume restores the following path",
    resumeRes.status === 200 && resumeRes.data.config.paused === false && resumeRes.data.keyframes.some((k) => k.subjectKey),
  );

  // Manual Crop fit: the path IS the user's rectangle; without one it
  // never silently smart-crops (no followed subject).
  const manualRect = { x: 0.1, y: 0.2, w: 0.3, h: 0.5 };
  const mcRes = await alice.call("PUT", oneConfigUrl, { body: { fitMode: "manual-crop", manualCrop: manualRect } });
  check(
    "manual-crop fit + rectangle accepted",
    mcRes.status === 200 && mcRes.data.config.fitMode === "manual-crop",
    JSON.stringify(mcRes.data).slice(0, 200),
  );
  check(
    "manual-crop: every keyframe crop equals the manual rectangle",
    mcRes.data.keyframes.length > 0 &&
      mcRes.data.keyframes.every(
        (k) =>
          k.crop &&
          Math.abs(k.crop.x - manualRect.x) < 0.011 &&
          Math.abs(k.crop.y - manualRect.y) < 0.011 &&
          Math.abs(k.crop.w - manualRect.w) < 0.011 &&
          Math.abs(k.crop.h - manualRect.h) < 0.011,
      ),
    JSON.stringify(mcRes.data.keyframes[0]?.crop),
  );
  const mcClear = await alice.call("PUT", oneConfigUrl, { body: { manualCrop: null } });
  check(
    "manual-crop with no rectangle set: no subject is followed (no silent smart-crop)",
    mcClear.status === 200 && mcClear.data.keyframes.every((k) => !k.subjectKey),
    `subjects: ${[...new Set(mcClear.data.keyframes.map((k) => k.subjectKey))].join(",")}`,
  );
  await alice.call("PUT", oneConfigUrl, { body: { fitMode: "smart-crop" } });

  // Split: custom arrangement (order/assignment) + per-subject crop.
  const [subjA, subjB] = twoFaces;
  const baseSplit = await alice.call("PUT", `/api/editor/${two.doc.id}/reframe/split`, {
    body: { layout: "side-by-side" },
  });
  check("split baseline (side-by-side) re-accepted", baseSplit.status === 200, JSON.stringify(baseSplit.data).slice(0, 160));
  const baseRegionA = baseSplit.data.regionKeyframes[subjA.key] ?? [];
  const customRes = await alice.call("PUT", `/api/editor/${two.doc.id}/reframe/split`, {
    body: {
      layout: "custom",
      regions: [
        { subjectKey: subjB.key, rect: { x: 0, y: 0, w: 0.5, h: 1 }, crop: { zoom: 0.5 } },
        { subjectKey: subjA.key, rect: { x: 0.5, y: 0, w: 0.5, h: 1 }, crop: { zoom: 1, offsetX: 0.05 } },
      ],
    },
  });
  check("split custom arrangement accepted", customRes.status === 200, JSON.stringify(customRes.data).slice(0, 200));
  check(
    "split custom: region order/assignment stored as sent",
    customRes.data.split?.regions?.[0]?.subjectKey === subjB.key &&
      customRes.data.split?.regions?.[1]?.subjectKey === subjA.key,
    JSON.stringify(customRes.data.split?.regions?.map((r) => r.subjectKey)),
  );
  check(
    "split custom: per-subject crop settings persisted on the region",
    customRes.data.split?.regions?.[1]?.crop?.zoom === 1,
    JSON.stringify(customRes.data.split?.regions?.[1]),
  );
  const customRegionA = customRes.data.regionKeyframes[subjA.key] ?? [];
  check(
    "split per-subject zoom/offset changes that subject's region path",
    baseRegionA.length > 0 && customRegionA.length > 0 && pathSig(baseRegionA) !== pathSig(customRegionA),
  );

  // Reset tracking: configuration + keyframes back to defaults, as a
  // dedicated action (not Reset-to-AI, not Reset-all-scenes).
  await alice.call("PUT", `/api/editor/${two.doc.id}/reframe/config`, { body: { controls: { zoom: 0.95 } } });
  await alice.call("POST", `/api/editor/${two.doc.id}/reframe/keyframes`, {
    body: { t: 1, crop: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 } },
  });
  await alice.call("PUT", `/api/editor/${two.doc.id}/reframe/scene-overrides`, {
    body: { overrides: [{ rangeStart: 0, rangeEnd: 2, mode: "face-lock", subjectKey: subjA.key }] },
  });
  const resetRes = await alice.call("POST", `/api/editor/${two.doc.id}/reframe/reset-tracking`, { body: {} });
  check("reset-tracking endpoint succeeds", resetRes.status === 200, JSON.stringify(resetRes.data).slice(0, 200));
  check("reset-tracking: mode back to the smart-auto default", resetRes.data.config.mode === "smart-auto", `mode=${resetRes.data.config.mode}`);
  check(
    "reset-tracking: controls + pause back to defaults",
    resetRes.data.config.controls.zoom === 0.5 && resetRes.data.config.paused === false,
    `zoom=${resetRes.data.config.controls.zoom} paused=${resetRes.data.config.paused}`,
  );
  check("reset-tracking: manual keyframes cleared", resetRes.data.manualKeyframes.length === 0);
  check("reset-tracking: scene overrides cleared", resetRes.data.sceneOverrides.length === 0);
  check("reset-tracking: split layout cleared", resetRes.data.split === null);
  check("reset-tracking: crop keyframes recomputed from the default config", resetRes.data.keyframes.length >= 5, `got ${resetRes.data.keyframes.length}`);
  const bobReset = await bob.call("POST", `/api/editor/${two.doc.id}/reframe/reset-tracking`, { body: {} });
  check("reset-tracking cross-user is 404", bobReset.status === 404, `got ${bobReset.status}`);

  // ============================ NO FACE ======================================
  console.log("— no-face fixture —");
  const noface = await projectWithUpload(alice, "No Face", "no-face.mp4");
  const nofaceJob = await runTracking(alice, noface.projectId);
  check("no-face job COMPLETED (not a fake error)", nofaceJob.status === "COMPLETED", JSON.stringify(nofaceJob).slice(0, 200));
  check("no-face outcome is honestly NO_SUBJECTS", nofaceJob.outcome === "NO_SUBJECTS");
  const nofaceState = await getReframe(alice, noface.doc.id);
  check("no-face: zero subjects", nofaceState.subjects.length === 0);

  // ============================ SCENE CHANGE =================================
  console.log("— scene-change fixture —");
  const sceneProj = await projectWithUpload(alice, "Scene Change", "scene-change.mp4");
  const sceneJob = await runTracking(alice, sceneProj.projectId);
  check("scene-change job COMPLETED", sceneJob.status === "COMPLETED");
  check("scene-change: >= 2 scenes detected", (sceneJob.scenes?.length ?? 0) >= 2, JSON.stringify(sceneJob.scenes));
  const sceneState = await getReframe(alice, sceneProj.doc.id);
  const sceneFaces = sceneState.subjects.filter((s) => s.kind === "face");
  const early = sceneFaces.find((s) => s.lastSeenSec < 4.6);
  const late = sceneFaces.find((s) => s.firstSeenSec > 3.4);
  check(
    "scene-change: subjects do not carry across the cut",
    Boolean(early) && Boolean(late) && early.key !== late.key,
    `subjects: ${sceneFaces.map((s) => `${s.key}@${s.firstSeenSec}-${s.lastSeenSec}`).join(", ")}`,
  );
  if (sceneJob.scenes?.length >= 2 && late) {
    const scene2 = sceneJob.scenes[1];
    const beforeKf = sceneState.keyframes.find((k) => Math.abs(k.t - 1) < 0.26);
    const ovrRes = await alice.call("PUT", `/api/editor/${sceneProj.doc.id}/reframe/scene-overrides`, {
      body: {
        overrides: [
          { rangeStart: scene2.start, rangeEnd: scene2.end, mode: "face-lock", subjectKey: late.key },
        ],
      },
    });
    check("scene override accepted", ovrRes.status === 200, JSON.stringify(ovrRes.data).slice(0, 200));
    const afterKfScene1 = ovrRes.data.keyframes.find((k) => Math.abs(k.t - 1) < 0.26);
    check(
      "scene override leaves the other scene untouched",
      JSON.stringify(beforeKf?.crop) === JSON.stringify(afterKfScene1?.crop),
      `before=${JSON.stringify(beforeKf?.crop)} after=${JSON.stringify(afterKfScene1?.crop)}`,
    );
    const scene2Kfs = ovrRes.data.keyframes.filter((k) => k.t >= scene2.start + 0.5 && k.subjectKey);
    check(
      "scene override applies inside its own scene",
      scene2Kfs.length > 0 && scene2Kfs.every((k) => k.subjectKey === late.key),
      `found ${scene2Kfs.length}`,
    );
  }

  // Subset apply: an override for ONLY scene 1 (chosen subset) must
  // affect exactly that scene and leave scene 2 on its auto path.
  if (sceneJob.scenes?.length >= 2 && early) {
    const scene1 = sceneJob.scenes[0];
    const scene2 = sceneJob.scenes[1];
    await alice.call("PUT", `/api/editor/${sceneProj.doc.id}/reframe/scene-overrides`, { body: { overrides: [] } });
    const snap = await getReframe(alice, sceneProj.doc.id);
    const snapScene2 = snap.keyframes.filter((k) => k.t >= scene2.start).map((k) => JSON.stringify(k.crop));
    const subRes = await alice.call("PUT", `/api/editor/${sceneProj.doc.id}/reframe/scene-overrides`, {
      body: {
        overrides: [{ rangeStart: scene1.start, rangeEnd: scene1.end, mode: "face-lock", subjectKey: early.key }],
      },
    });
    check("subset apply (scene 1 only) accepted", subRes.status === 200, JSON.stringify(subRes.data).slice(0, 200));
    check("subset apply stores exactly the chosen scenes' overrides", subRes.data.sceneOverrides.length === 1, `got ${subRes.data.sceneOverrides.length}`);
    const subScene1 = subRes.data.keyframes.filter((k) => k.t >= scene1.start + 0.3 && k.t < scene1.end - 0.2);
    check(
      "subset apply affects the chosen scene (it follows its subject)",
      subScene1.some((k) => k.subjectKey === early.key),
      `scene1 subjects: ${[...new Set(subScene1.map((k) => k.subjectKey))].join(",")}`,
    );
    const subScene2 = subRes.data.keyframes.filter((k) => k.t >= scene2.start).map((k) => JSON.stringify(k.crop));
    check(
      "subset apply leaves the unchosen scene's path unchanged",
      JSON.stringify(subScene2) === JSON.stringify(snapScene2),
    );
  }

  // ============================ CANCEL + RETRY ================================
  console.log("— cancel + retry —");
  const cancelProj = await projectWithUpload(alice, "Cancel Test", "moving.mp4");
  const cancelCreate = await alice.call("POST", `/api/projects/${cancelProj.projectId}/tracking-jobs`, { body: {} });
  const cancelRes = await alice.call("POST", `/api/tracking-jobs/${cancelCreate.data.job.id}/cancel`, { body: {} });
  check("cancel accepted", cancelRes.status === 200, JSON.stringify(cancelRes.data).slice(0, 200));
  const cancelledJob = await waitForTracking(alice, cancelCreate.data.job.id, 60000);
  check("job reaches CANCELLED", cancelledJob.status === "CANCELLED", `got ${cancelledJob.status}`);
  const retryRes = await alice.call("POST", `/api/tracking-jobs/${cancelledJob.id}/retry`, { body: {} });
  check("retry creates a new job", retryRes.status === 201 && retryRes.data.job.id !== cancelledJob.id);
  const retriedJob = await waitForTracking(alice, retryRes.data.job.id);
  check("retried job COMPLETED", retriedJob.status === "COMPLETED", JSON.stringify(retriedJob).slice(0, 200));

  // ============================ CROSS-USER ====================================
  console.log("— cross-user isolation —");
  const bobReframe = await bob.call("GET", `/api/editor/${one.doc.id}/reframe`);
  check("cross-user reframe state is 404", bobReframe.status === 404, `got ${bobReframe.status}`);
  const bobJob = await bob.call("GET", `/api/tracking-jobs/${oneJob.id}`);
  check("cross-user tracking job is 404", bobJob.status === 404);
  const bobCreate = await bob.call("POST", `/api/projects/${one.projectId}/tracking-jobs`, { body: {} });
  check("cross-user job create is 404", bobCreate.status === 404);
  const bobConfig = await bob.call("PUT", `/api/editor/${one.doc.id}/reframe/config`, { body: { mode: "manual" } });
  check("cross-user config write is 404", bobConfig.status === 404);

  // ============================ SOURCE INTEGRITY ===============================
  for (const [name, hash] of Object.entries(fixtureHashes)) {
    check(`source fixture untouched: ${name}`, sha256(path.join(FIXTURES, name)) === hash);
  }

  console.log(`\nPhase 7 tracking e2e: ${passed} passed, ${failed} failed`);
  if (failures.length) console.log("failures:", failures.join(" | "));
  process.exitCode = failed > 0 ? 1 : 0;
} catch (err) {
  console.error("SUITE ERROR:", err);
  console.error(serverLog.slice(-3000));
  process.exitCode = 1;
} finally {
  try {
    process.kill(-server.pid, "SIGKILL");
  } catch {
    /* already gone */
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
