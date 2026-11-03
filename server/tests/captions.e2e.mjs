// Phase 6 Captions Studio & Brand Kit end-to-end checks.
//
// Runs against a REAL spawned server (fresh temp DB + media dir on a
// scratch port) and REAL media, following the pattern of the earlier
// suites:
//   * a 12s speech video is synthesised (espeak-ng + FFmpeg) and
//     uploaded through the real upload endpoints;
//   * the REAL Phase 4 pipeline transcribes it locally (faster-
//     whisper) so captions are generated from a genuine transcript
//     with genuine word timestamps;
//   * a Hindi transcript fixture is inserted directly (the Phase 4
//     suite's approach) to exercise Devanagari captions without
//     claiming anything about Hindi STT accuracy;
//   * rendering REALLY burns captions in via libass — position is
//     verified by extracting frames and comparing pixel rows between
//     a bottom-position and a top-position render.
//
// Covers the Phase 6 spec §13 list: caption generation from a real
// transcript, text/timing edits, all 10 templates applied, position
// reflected in render, SRT/VTT import (valid + invalid) and export
// round-trip, Hindi captions, translation honest CONFIGURATION
// failure + manual translation stored separately, Brand Kit CRUD +
// apply to multiple documents, burned-in render verified, persistence
// after reload, cross-user 404s, CSRF.
//
// Run: npm run test:captions

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const PORT = 3226;
const BASE = `http://localhost:${PORT}`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-captions-"));
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

/** Mean brightness of a horizontal band of a PNG frame (0..255ish). */
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
    if (body !== undefined && !formData) {
      finalHeaders["Content-Type"] = "application/json";
    }
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
    const res = await this.call("POST", "/api/auth/register", {
      body: {
        displayName: "Caption Tester",
        email,
        password: "Str0ngPassw0rd",
        confirmPassword: "Str0ngPassw0rd",
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

async function waitForJob(client, jobId, timeoutMs = 300000) {
  const start = Date.now();
  for (;;) {
    const res = await client.call("GET", `/api/render-jobs/${jobId}`);
    const status = res.data.job.status;
    if (status === "COMPLETED" || status === "FAILED" || status === "CANCELLED") return res.data.job;
    if (Date.now() - start > timeoutMs) throw new Error(`render job ${jobId} did not finish`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function waitForAnalysis(client, jobId, timeoutMs = 600000) {
  const start = Date.now();
  for (;;) {
    const res = await client.call("GET", `/api/analysis/${jobId}`);
    const job = res.data.job;
    if (job && (job.status === "COMPLETED" || job.status === "FAILED" || job.status === "CANCELLED")) {
      return job;
    }
    if (Date.now() - start > timeoutMs) throw new Error("analysis job did not finish");
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/** Upload a media file through the REAL Phase 3 upload endpoints. */
async function uploadMedia(client, projectId, buf, filename, mime) {
  const session = await client.call("POST", `/api/projects/${projectId}/upload-session`, {
    body: { filename, size: buf.length },
  });
  if (session.status !== 201) throw new Error(`upload session failed: ${JSON.stringify(session.data)}`);
  const form = new FormData();
  form.append("file", new Blob([buf], { type: mime }), filename);
  const res = await client.raw("POST", `/api/upload-sessions/${session.data.session.id}/file`, { formData: form });
  const data = await res.json().catch(() => null);
  if (res.status !== 200) throw new Error(`upload failed ${res.status}: ${JSON.stringify(data)}`);
  return data.asset;
}

function makeSpeechVideo(text, outPath) {
  const wav = outPath + ".wav";
  run("espeak-ng", ["-v", "en", "-s", "130", "-w", wav, text]);
  const probe = ffprobeJson(wav);
  const dur = Number(probe.format.duration);
  run("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", `color=c=0x101418:s=640x360:r=25:d=${dur.toFixed(2)}`,
    "-i", wav,
    "-shortest",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-ar", "48000",
    outPath,
  ]);
  return dur;
}

/** Build an editor state mutation locally and post it as an op. */
async function postOp(client, doc, type, mutate) {
  const state = {
    canvas: doc.canvas,
    settings: doc.settings,
    tracks: doc.tracks,
    items: doc.items,
    captions: doc.captions,
    sceneOverrides: doc.sceneOverrides,
  };
  mutate(state);
  const res = await client.call("POST", `/api/editor/${doc.id}/operations`, {
    body: { type, state, baseCursor: doc.undoCursor },
  });
  if (res.status !== 200) throw new Error(`operation ${type} failed: ${JSON.stringify(res.data).slice(0, 300)}`);
  return res.data.document;
}

console.log("Phase 6 captions e2e — spawning server on", BASE);
const server = spawn(path.join(serverDir, "node_modules", ".bin", "tsx"), ["src/index.ts"], {
  cwd: serverDir,
  env: { ...process.env },
  stdio: ["ignore", "pipe", "pipe"],
  // tsx spawns the real server as a child — a process group lets the
  // teardown kill the whole tree (a surviving server would hold the
  // port + its deleted-but-open test DB and poison the next run).
  detached: true,
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

try {
  await waitForHealth();

  const alice = new Client();
  const bob = new Client();
  await alice.register("alice-cap@example.com");
  await bob.register("bob-cap@example.com");
  console.log("registered two users");

  // ---- fixtures: real speech video → real Phase 4 analysis -------------
  // Long enough (>15s minimum clip window in the project defaults)
  // for the real detection stage to produce candidates.
  const speechText =
    "Welcome to the caption studio. Today we test bold captions and karaoke highlights for short videos. " +
    "Good captions help every viewer follow along, even with the sound turned off. " +
    "In this demo we change colours, fonts and positions, and the render must follow. " +
    "Finally we export the finished clip and check the captions are really burned in.";
  const videoPath = path.join(tmp, "speech.mp4");
  makeSpeechVideo(speechText, videoPath);
  const videoBuf = fs.readFileSync(videoPath);

  const projRes = await alice.call("POST", "/api/projects", {
    body: { name: "Captions Project", workflowType: "LONG_VIDEO_TO_SHORTS" },
  });
  check("project created", projRes.status === 201, JSON.stringify(projRes.data).slice(0, 200));
  const projectId = projRes.data.project.id;

  const asset = await uploadMedia(alice, projectId, videoBuf, "speech.mp4", "video/mp4");
  check("speech video uploaded + probe-verified", asset.validationStatus === "VALID", JSON.stringify(asset).slice(0, 200));

  const analysis = await alice.call("POST", `/api/projects/${projectId}/analysis`, {
    body: { sourceAssetId: asset.id },
  });
  check("analysis job created", analysis.status === 201 && !!analysis.data.job?.id, JSON.stringify(analysis.data).slice(0, 200));
  const analysisJob = await waitForAnalysis(alice, analysis.data.job.id);
  const candidatesRes = await alice.call("GET", `/api/projects/${projectId}/candidates`);
  check(
    "analysis finished with candidates (real pipeline output)",
    (candidatesRes.data.candidates?.length ?? 0) > 0,
    `jobStatus=${analysisJob.status} jobError=${analysisJob.error ?? ""} candidates=${candidatesRes.data.candidates?.length}`,
  );

  const transcript = await alice.call("GET", `/api/projects/${projectId}/transcript`);
  check(
    "transcript has genuine word timestamps",
    transcript.data.transcript?.hasWordTimestamps === true && transcript.data.transcript.segments.length > 0,
    JSON.stringify(transcript.data).slice(0, 300),
  );

  // Editor document (seeded from the top candidate) carries captions.
  const docRes = await alice.call("GET", `/api/projects/${projectId}/editor`);
  let doc = docRes.data.document;
  check("editor document seeded", !!doc?.id);
  check(
    "seeded captions carry words + language + style fields",
    doc.captions.length > 0 &&
      doc.captions.every((c) => "style" in c && "language" in c) &&
      doc.captions.some((c) => Array.isArray(c.words) && c.words.length > 0),
    JSON.stringify(doc.captions[0]).slice(0, 300),
  );
  check(
    "document settings carry the Phase 6 caption style",
    !!doc.settings.captionStyle && doc.settings.captionStyle.animation === "minimal",
  );

  // ---- 1. caption-studio state + fonts ----------------------------------
  const studioRes = await alice.call("GET", `/api/editor/${doc.id}/caption-studio`);
  check("caption-studio state loads", studioRes.status === 200, JSON.stringify(studioRes.data).slice(0, 200));
  check(
    "studio reports word timestamps + unconfigured translation",
    studioRes.data.studio.hasWordTimestamps === true &&
      studioRes.data.studio.translationConfigured === false &&
      studioRes.data.studio.activeTrack.kind === "original",
    JSON.stringify(studioRes.data.studio).slice(0, 300),
  );

  const fontsRes = await alice.call("GET", "/api/captions/fonts");
  check(
    "fonts endpoint lists real server fonts incl. Noto Sans + Devanagari",
    fontsRes.status === 200 &&
      fontsRes.data.fonts.includes("Noto Sans") &&
      (fontsRes.data.devanagariFont ?? "").includes("Devanagari"),
    JSON.stringify(fontsRes.data).slice(0, 200),
  );

  // ---- 2. regenerate from transcript ------------------------------------
  const regen = await alice.call("POST", `/api/editor/${doc.id}/captions/regenerate`, { body: { confirm: true } });
  check("regenerate returns captions from the transcript", regen.status === 200 && regen.data.generated > 0, JSON.stringify(regen.data).slice(0, 200));
  doc = regen.data.document;
  const firstCaption = doc.captions[0];
  check(
    "regenerated captions keep word timings + probabilities",
    Array.isArray(firstCaption.words) &&
      firstCaption.words.length > 0 &&
      firstCaption.words.every((w) => typeof w.start === "number" && "probability" in w),
    JSON.stringify(firstCaption).slice(0, 300),
  );

  // ---- 3. text + timing edits persist ------------------------------------
  doc = await postOp(alice, doc, "caption_update", (state) => {
    const c = state.captions[0];
    c.text = "Edited caption text for testing";
    c.start = Math.max(0, c.start);
    c.end = c.start + 2.5;
  });
  const reload1 = await alice.call("GET", `/api/projects/${projectId}/editor`);
  const persisted = reload1.data.document.captions.find((c) => c.id === firstCaption.id);
  check(
    "caption text + timing edits persist after reload",
    persisted?.text === "Edited caption text for testing" && Math.abs(persisted.end - persisted.start - 2.5) < 0.01,
    JSON.stringify(persisted).slice(0, 200),
  );
  doc = reload1.data.document;

  // ---- 3b. regenerate confirmation contract ------------------------------
  // The document now holds a user edit (section 3). Regenerating would
  // destroy it, so the API must refuse without an explicit confirm,
  // replace on confirm, and no-op when nothing would change.
  const editedSnapshot = doc.captions.map((c) => ({ text: c.text, start: c.start, end: c.end, language: c.language }));
  const guardRes = await alice.call("POST", `/api/editor/${doc.id}/captions/regenerate`, { body: {} });
  check(
    "regenerate over edited captions without confirm is refused 409 CONFIRMATION_REQUIRED",
    guardRes.status === 409 && guardRes.data.code === "CONFIRMATION_REQUIRED",
    `${guardRes.status} ${JSON.stringify(guardRes.data).slice(0, 200)}`,
  );
  const afterGuard = await alice.call("GET", `/api/projects/${projectId}/editor`);
  check(
    "refused regenerate leaves captions + undo cursor untouched",
    afterGuard.data.document.undoCursor === doc.undoCursor &&
      JSON.stringify(
        afterGuard.data.document.captions.map((c) => ({ text: c.text, start: c.start, end: c.end, language: c.language })),
      ) === JSON.stringify(editedSnapshot),
    `cursor=${afterGuard.data.document.undoCursor} expected=${doc.undoCursor}`,
  );
  doc = afterGuard.data.document;

  const confirmed = await alice.call("POST", `/api/editor/${doc.id}/captions/regenerate`, {
    body: { confirm: true },
  });
  check(
    "regenerate with confirm:true replaces the edited captions with the transcript set",
    confirmed.status === 200 &&
      confirmed.data.generated > 0 &&
      !confirmed.data.document.captions.some((c) => c.text === "Edited caption text for testing"),
    `${confirmed.status} ${JSON.stringify(confirmed.data).slice(0, 200)}`,
  );
  doc = confirmed.data.document;

  const noopRes = await alice.call("POST", `/api/editor/${doc.id}/captions/regenerate`, { body: {} });
  check(
    "regenerate when captions already match the transcript is a 200 no-op (no new operation)",
    noopRes.status === 200 && noopRes.data.document.undoCursor === doc.undoCursor,
    `${noopRes.status} cursor=${noopRes.data.document?.undoCursor} expected=${doc.undoCursor}`,
  );
  doc = noopRes.data.document;

  // Restore the section-3 edit so the template/export/render sections
  // see the same document state they were written against.
  doc = await postOp(alice, doc, "caption_update", (state) => {
    const c = state.captions[0];
    c.text = "Edited caption text for testing";
    c.end = c.start + 2.5;
  });

  // ---- 4. all 10 templates apply -----------------------------------------
  const templatesRes = await alice.call("GET", "/api/caption-templates");
  const templates = templatesRes.data.templates;
  check(
    "exactly 10 built-in templates incl. CLIPFORGE Signature with brand colours",
    templates.length === 10 &&
      templates.every((t) => t.builtin) &&
      templates.some(
        (t) =>
          t.id === "builtin:clipforge-signature" &&
          t.style.highlightColor === "#D4FF24" &&
          t.style.backgroundColor === "#030407",
      ),
    templates.map((t) => t.id).join(","),
  );
  let allApplied = true;
  for (const t of templates) {
    const res = await alice.call("PATCH", `/api/editor/${doc.id}/settings`, {
      body: { settings: { captionStyle: t.style, captionTemplateId: t.id } },
    });
    if (
      res.status !== 200 ||
      res.data.document.settings.captionTemplateId !== t.id ||
      res.data.document.settings.captionStyle.fontFamily !== t.style.fontFamily
    ) {
      allApplied = false;
      console.log("   template apply failed:", t.id, JSON.stringify(res.data).slice(0, 200));
    }
    doc = res.data.document ?? doc;
  }
  check("all 10 templates apply to the document", allApplied);

  // custom template lifecycle
  const custom = await alice.call("POST", "/api/caption-templates", {
    body: { name: "My Test Template", style: templates[0].style, basedOn: templates[0].id },
  });
  check("custom template created", custom.status === 201 && custom.data.template.builtin === false);
  const customId = custom.data.template.id;
  const dup = await alice.call("POST", `/api/caption-templates/${customId}/duplicate`, { body: {} });
  check("custom template duplicated", dup.status === 201 && dup.data.template.id !== customId);
  const upd = await alice.call("PATCH", `/api/caption-templates/${customId}`, {
    body: { name: "Renamed Template" },
  });
  check("custom template renamed", upd.status === 200 && upd.data.template.name === "Renamed Template");
  const delBuiltin = await alice.call("DELETE", "/api/caption-templates/builtin:karaoke");
  check("built-in template delete refused (400)", delBuiltin.status === 400, `status=${delBuiltin.status}`);
  const del = await alice.call("DELETE", `/api/caption-templates/${customId}`);
  check("custom template deleted", del.status === 200);

  // built-in patch refused
  const patchBuiltin = await alice.call("PATCH", "/api/caption-templates/builtin:karaoke", {
    body: { name: "Hacked" },
  });
  check("built-in template edit refused (400)", patchBuiltin.status === 400, `status=${patchBuiltin.status}`);

  // Edit-as-copy: the UI's Edit action on a built-in duplicates it
  // under an "(edited)" name; the copy is a normal editable template
  // and the built-in itself stays byte-identical.
  const karaokeBefore = templates.find((t) => t.id === "builtin:karaoke");
  const editCopy = await alice.call("POST", "/api/caption-templates/builtin:karaoke/duplicate", {
    body: { name: `${karaokeBefore.name} (edited)` },
  });
  check(
    "edit-as-copy creates a distinct non-built-in template named '<Name> (edited)'",
    editCopy.status === 201 &&
      editCopy.data.template.builtin === false &&
      editCopy.data.template.id !== "builtin:karaoke" &&
      editCopy.data.template.name === `${karaokeBefore.name} (edited)` &&
      JSON.stringify(editCopy.data.template.style) === JSON.stringify(karaokeBefore.style),
    JSON.stringify(editCopy.data).slice(0, 240),
  );
  const editedCopyId = editCopy.data.template.id;
  const copyPatch = await alice.call("PATCH", `/api/caption-templates/${editedCopyId}`, {
    body: { style: { ...karaokeBefore.style, textColor: "#FF0000" } },
  });
  check(
    "the (edited) copy is itself editable via PATCH",
    copyPatch.status === 200 && copyPatch.data.template.style.textColor === "#FF0000",
    `status=${copyPatch.status}`,
  );
  const templatesAfterEdit = (await alice.call("GET", "/api/caption-templates")).data.templates;
  const karaokeAfter = templatesAfterEdit.find((t) => t.id === "builtin:karaoke");
  check(
    "built-in is unchanged after edit-as-copy (style + name intact)",
    karaokeAfter.name === karaokeBefore.name &&
      JSON.stringify(karaokeAfter.style) === JSON.stringify(karaokeBefore.style),
  );

  // invalid style rejected
  const badStyle = await alice.call("POST", "/api/caption-templates", {
    body: { name: "Bad", style: { ...templates[0].style, textColor: "red" } },
  });
  check("invalid style colour rejected (400)", badStyle.status === 400, `status=${badStyle.status}`);

  // ---- 5. per-segment style apply + reset --------------------------------
  const karaokeStyle = templates.find((t) => t.id === "builtin:karaoke").style;
  doc = await alice.call("PATCH", `/api/editor/${doc.id}/settings`, {
    body: { settings: { captionStyle: karaokeStyle, captionTemplateId: "builtin:karaoke" } },
  }).then((r) => r.data.document);
  const targetId = doc.captions[0].id;
  doc = await postOp(alice, doc, "caption_style_apply", (state) => {
    const c = state.captions.find((x) => x.id === targetId);
    if (c) c.style = { ...state.settings.captionStyle };
  });
  check(
    "per-segment style override stored",
    doc.captions.find((c) => c.id === targetId)?.style?.animation === "karaoke",
  );
  doc = await postOp(alice, doc, "caption_style_reset", (state) => {
    const c = state.captions.find((x) => x.id === targetId);
    if (c) c.style = null;
  });
  check(
    "per-segment style reset to document style",
    doc.captions.find((c) => c.id === targetId)?.style === null,
  );

  // ---- 6. SRT/VTT export + import round-trip ------------------------------
  const srtRes = await alice.raw("GET", `/api/editor/${doc.id}/captions/export?format=srt`);
  const srtText = await srtRes.text();
  check(
    "SRT export is well-formed and matches edited captions",
    srtRes.status === 200 &&
      srtText.includes("-->") &&
      srtText.includes("Edited caption text for testing"),
    srtText.slice(0, 200),
  );
  const vttRes = await alice.raw("GET", `/api/editor/${doc.id}/captions/export?format=vtt`);
  const vttText = await vttRes.text();
  check("VTT export starts with WEBVTT", vttRes.status === 200 && vttText.startsWith("WEBVTT"), vttText.slice(0, 60));

  const badFormatRes = await alice.raw("GET", `/api/editor/${doc.id}/captions/export?format=xml`);
  check("export with an unsupported format is rejected 400 (no silent coercion to SRT)", badFormatRes.status === 400, `status=${badFormatRes.status}`);

  const importSrt = "1\n00:00:01,000 --> 00:00:03,500\nImported line one\n\n2\n00:00:04,000 --> 00:00:06,000\nImported line two\n";
  const importForm = new FormData();
  importForm.append("file", new Blob([importSrt], { type: "application/x-subrip" }), "import.srt");
  importForm.append("mode", "new-track");
  importForm.append("language", "en");
  importForm.append("kind", "manual");
  const importRes = await alice.raw("POST", `/api/editor/${doc.id}/captions/import`, { formData: importForm });
  const importData = await importRes.json().catch(() => null);
  check(
    "SRT import as a new track imports 2 segments",
    importRes.status === 201 && importData?.imported === 2,
    JSON.stringify(importData).slice(0, 300),
  );

  const badSrt = "1\n00:00:05,000 --> 00:00:03,000\nBackwards cue\n";
  const badForm = new FormData();
  badForm.append("file", new Blob([badSrt], { type: "application/x-subrip" }), "bad.srt");
  badForm.append("mode", "replace-active");
  const badRes = await alice.raw("POST", `/api/editor/${doc.id}/captions/import`, { formData: badForm });
  check("invalid SRT (end before start) rejected 422", badRes.status === 422, `status=${badRes.status}`);

  const junkForm = new FormData();
  junkForm.append("file", new Blob(["not a subtitle file at all"], { type: "text/plain" }), "junk.srt");
  junkForm.append("mode", "replace-active");
  const junkRes = await alice.raw("POST", `/api/editor/${doc.id}/captions/import`, { formData: junkForm });
  check("junk subtitle file rejected 422", junkRes.status === 422, `status=${junkRes.status}`);

  // A new-track import past the 2000-cue cap is refused (422),
  // mirroring the editor-state caption cap on the replace path.
  const srtStamp = (sec) => {
    const ms = Math.round(sec * 1000);
    const p = (v, l = 2) => String(v).padStart(l, "0");
    return `${p(Math.floor(ms / 3600000))}:${p(Math.floor((ms % 3600000) / 60000))}:${p(Math.floor((ms % 60000) / 1000))},${p(ms % 1000, 3)}`;
  };
  let manyCues = "";
  for (let i = 0; i < 2001; i += 1) {
    const start = i * 0.5;
    manyCues += `${i + 1}\n${srtStamp(start)} --> ${srtStamp(start + 0.4)}\nx\n\n`;
  }
  const manyForm = new FormData();
  manyForm.append("file", new Blob([manyCues], { type: "application/x-subrip" }), "many.srt");
  manyForm.append("mode", "new-track");
  manyForm.append("language", "en");
  manyForm.append("kind", "manual");
  const manyRes = await alice.raw("POST", `/api/editor/${doc.id}/captions/import`, { formData: manyForm });
  check("new-track import over 2000 cues rejected 422", manyRes.status === 422, `status=${manyRes.status}`);

  // activate the imported track → document captions swap
  const studioAfterImport = await alice.call("GET", `/api/editor/${doc.id}/caption-studio`);
  const importedTrack = studioAfterImport.data.studio.tracks.find((t) => t.kind === "manual");
  check("imported track listed alongside the original", !!importedTrack && studioAfterImport.data.studio.tracks.length >= 2);
  const activate = await alice.call("POST", `/api/editor/${doc.id}/caption-tracks/${importedTrack.id}/activate`, { body: {} });
  check(
    "activating the imported track swaps document captions",
    activate.status === 200 && activate.data.document.captions.some((c) => c.text === "Imported line one"),
    JSON.stringify(activate.data).slice(0, 200),
  );
  doc = activate.data.document;
  // switch back to the original track for the render tests
  const originalTrack = activate.data.studio.tracks.find((t) => t.kind === "original");
  const back = await alice.call("POST", `/api/editor/${doc.id}/caption-tracks/${originalTrack.id}/activate`, { body: {} });
  doc = back.data.document;
  check(
    "switching back restores the original captions (nothing overwritten)",
    doc.captions.some((c) => c.text === "Edited caption text for testing"),
  );

  // A blank line inside a cue's text must not corrupt the export's
  // cue-block structure (a blank line would end the cue early and the
  // tail would be dropped on re-import).
  const captionCount = doc.captions.length;
  doc = await postOp(alice, doc, "caption_update", (state) => {
    state.captions[0].text = "Blank line one\n\nBlank line two";
  });
  const blankRes = await alice.raw("GET", `/api/editor/${doc.id}/captions/export?format=srt`);
  const blankText = await blankRes.text();
  const cueBlocks = blankText.trim().split(/\n\s*\n/).filter((b) => b.includes("-->"));
  check(
    "export collapses blank lines inside cue text (no cue block is split)",
    blankRes.status === 200 &&
      cueBlocks.length === captionCount &&
      cueBlocks.some((b) => b.includes("Blank line one") && b.includes("Blank line two")),
    blankText.slice(0, 300),
  );
  const roundtripForm = new FormData();
  roundtripForm.append("file", new Blob([blankText], { type: "application/x-subrip" }), "roundtrip.srt");
  roundtripForm.append("mode", "new-track");
  roundtripForm.append("language", "en");
  roundtripForm.append("kind", "manual");
  const roundtripRes = await alice.raw("POST", `/api/editor/${doc.id}/captions/import`, { formData: roundtripForm });
  const roundtripData = await roundtripRes.json().catch(() => null);
  check(
    "re-importing the export yields the same number of cues",
    roundtripRes.status === 201 && roundtripData?.imported === captionCount,
    JSON.stringify(roundtripData).slice(0, 200),
  );
  // Restore the edited caption for the translation/render sections.
  doc = await postOp(alice, doc, "caption_update", (state) => {
    state.captions[0].text = "Edited caption text for testing";
  });

  // ---- 7. translation: honest failure + manual separation -----------------
  const jobRes = await alice.call("POST", `/api/editor/${doc.id}/translation-jobs`, {
    body: { targetLanguage: "hi" },
  });
  check(
    "translation job without a provider fails honestly (422 CONFIGURATION_ERROR)",
    jobRes.status === 422 && jobRes.data.code === "CONFIGURATION_ERROR",
    `${jobRes.status} ${JSON.stringify(jobRes.data).slice(0, 200)}`,
  );
  const jobsList = await alice.call("GET", `/api/editor/${doc.id}/translation-jobs`);
  const failedJob = jobsList.data.jobs.find((j) => j.targetLanguage === "hi");
  check(
    "failed translation job is persisted with its error",
    !!failedJob && failedJob.status === "FAILED" && !!failedJob.error,
    JSON.stringify(jobsList.data).slice(0, 300),
  );
  const jobAgain = await alice.call("POST", `/api/editor/${doc.id}/translation-jobs`, {
    body: { targetLanguage: "hi" },
  });
  const jobsList2 = await alice.call("GET", `/api/editor/${doc.id}/translation-jobs`);
  check(
    "duplicate translation request is deduplicated (same job returned, no second row)",
    jobAgain.status === 422 &&
      jobAgain.data.deduplicated === true &&
      jobAgain.data.job?.id === failedJob.id &&
      jobsList2.data.jobs.filter((j) => j.targetLanguage === "hi").length === 1,
    `jobs=${jobsList2.data.jobs.length} again=${JSON.stringify(jobAgain.data).slice(0, 160)}`,
  );

  const manual = await alice.call("POST", `/api/editor/${doc.id}/caption-tracks`, {
    body: {
      language: "hi",
      kind: "translation",
      label: "Hindi (manual)",
      segments: doc.captions.map((c) => ({ start: c.start, end: c.end, text: "यह एक मैन्युअल अनुवाद है" })),
    },
  });
  check("manual translation track created", manual.status === 201, JSON.stringify(manual.data).slice(0, 200));
  const studioAfterManual = await alice.call("GET", `/api/editor/${doc.id}/caption-studio`);
  const manualTrack = studioAfterManual.data.studio.tracks.find((t) => t.id === manual.data.track.id);
  check(
    "manual translation stored separately (original track untouched)",
    !!manualTrack &&
      studioAfterManual.data.studio.tracks.find((t) => t.kind === "original")?.segmentCount === doc.captions.length,
  );
  const manualExport = await alice.raw(
    "GET",
    `/api/editor/${doc.id}/captions/export?format=srt&trackId=${manual.data.track.id}`,
  );
  const manualExportText = await manualExport.text();
  check(
    "manual track exports its own Devanagari text",
    manualExport.status === 200 && manualExportText.includes("यह एक मैन्युअल अनुवाद है"),
    manualExportText.slice(0, 120),
  );

  // ---- 8. Hindi captions from a hi transcript fixture ----------------------
  // The Phase 4 suite inserts Devanagari transcript rows directly for
  // a second project: the pipeline path (transcript → captions →
  // render) is exercised with real Devanagari text; STT accuracy for
  // Hindi is NOT what is being tested here.
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(process.env.DATABASE_FILE);
  const hiProject = await alice.call("POST", "/api/projects", {
    body: { name: "Hindi Captions Project", workflowType: "LONG_VIDEO_TO_SHORTS" },
  });
  const hiProjectId = hiProject.data.project.id;
  await uploadMedia(alice, hiProjectId, videoBuf, "speech.mp4", "video/mp4");
  const hiAsset = db
    .prepare("SELECT id FROM source_assets WHERE project_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(hiProjectId);
  const aliceRow = db.prepare("SELECT id FROM users WHERE email = ?").get("alice-cap@example.com");
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO processing_tasks (id, user_id, project_id, source_asset_id, status, stage, created_at, updated_at) VALUES ('hi-task-fixture', ?, ?, ?, 'COMPLETED', 'COMPLETED', ?, ?)",
  ).run(aliceRow.id, hiProjectId, hiAsset.id, now, now);
  db.prepare(
    "INSERT INTO transcripts (id, task_id, project_id, source_asset_id, language, language_probability, duration, full_text, provider, model, created_at) VALUES ('hi-transcript-fixture', 'hi-task-fixture', ?, ?, 'hi', 0.9, 4.8, ?, 'local-whisper', 'small', ?)",
  ).run(hiProjectId, hiAsset.id, "नमस्ते यह एक हिंदी वाक्य है", now);
  const hiWords = [
    { start: 0.0, end: 0.8, word: "नमस्ते", probability: 0.9 },
    { start: 0.8, end: 1.4, word: "यह", probability: 0.9 },
    { start: 1.4, end: 2.0, word: "एक", probability: 0.9 },
    { start: 2.0, end: 3.0, word: "हिंदी", probability: 0.9 },
    { start: 3.0, end: 4.0, word: "वाक्य", probability: 0.9 },
    { start: 4.0, end: 4.8, word: "है", probability: 0.9 },
  ];
  db.prepare(
    "INSERT INTO transcript_segments (id, transcript_id, idx, start_sec, end_sec, text, words_json) VALUES ('hi-seg-1', 'hi-transcript-fixture', 0, 0.0, 4.8, ?, ?)",
  ).run("नमस्ते यह एक हिंदी वाक्य है", JSON.stringify(hiWords));
  db.prepare(
    "INSERT INTO candidate_clips (id, task_id, project_id, source_asset_id, user_id, start_sec, end_sec, duration, score, reasons_json, suggested_title, title, transcript_excerpt, status, preview_status, created_at) VALUES ('hi-candidate-1', 'hi-task-fixture', ?, ?, ?, 0.0, 4.8, 4.8, 80, '[]', 'Hindi clip', 'Hindi clip', ?, 'SELECTED', 'READY', ?)",
  ).run(hiProjectId, hiAsset.id, aliceRow.id, "नमस्ते यह एक हिंदी वाक्य है", now);
  db.close();

  const hiDocRes = await alice.call("GET", `/api/projects/${hiProjectId}/editor?seedCandidateId=hi-candidate-1`);
  const hiDoc = hiDocRes.data.document;
  check(
    "Hindi editor doc seeds Devanagari captions with word timings",
    !!hiDoc &&
      hiDoc.captions.length > 0 &&
      hiDoc.captions[0].text.includes("नमस्ते") &&
      hiDoc.captions[0].language === "hi" &&
      Array.isArray(hiDoc.captions[0].words),
    JSON.stringify(hiDoc?.captions?.[0]).slice(0, 300),
  );
  const hiExportRes = await alice.raw("GET", `/api/editor/${hiDoc.id}/captions/export?format=vtt`);
  const hiExportText = await hiExportRes.text();
  check("Hindi captions export as VTT with Devanagari intact", hiExportText.includes("नमस्ते यह एक हिंदी वाक्य है"), hiExportText.slice(0, 120));

  // ---- 9. burned-in render: position really moves the captions ------------
  async function renderAndDownload(docId) {
    const start = await alice.call("POST", `/api/editor/${docId}/render`, { body: {} });
    if (start.status !== 202 && start.status !== 201 && start.status !== 200) {
      throw new Error(`render start failed: ${JSON.stringify(start.data).slice(0, 300)}`);
    }
    const job = await waitForJob(alice, start.data.job.id);
    if (job.status !== "COMPLETED") throw new Error(`render ${job.status}: ${job.error ?? ""}`);
    const res = await alice.raw("GET", `/api/render-jobs/${job.id}/download`);
    const buf = Buffer.from(await res.arrayBuffer());
    const file = path.join(tmp, `render-${job.id}.mp4`);
    fs.writeFileSync(file, buf);
    return { job, file };
  }

  const frameAt = (video, t, name) => {
    const out = path.join(tmp, name);
    run("ffmpeg", ["-v", "error", "-y", "-ss", String(t), "-i", video, "-frames:v", "1", out]);
    return out;
  };

  // Big, high-contrast captions so the pixel check is unambiguous.
  const baseStyle = {
    ...templates.find((t) => t.id === "builtin:clean-minimal").style,
    fontSize: 92,
    animation: "none",
    backgroundOpacity: 0.9,
    textColor: "#FFFFFF",
  };
  const captionAt = doc.captions.find((c) => c.text === "Edited caption text for testing") ?? doc.captions[0];
  const midTime = captionAt.start + Math.min(1, (captionAt.end - captionAt.start) / 2);

  doc = (await alice.call("PATCH", `/api/editor/${doc.id}/settings`, {
    body: { settings: { captionStyle: { ...baseStyle, position: "bottom" }, showCaptions: true } },
  })).data.document;
  const renderBottom = await renderAndDownload(doc.id);
  const frameBottom = frameAt(renderBottom.file, midTime, "frame-bottom.png");
  const bottomBandA = bandBrightness(frameBottom, 0.78, 0.97);
  const topBandA = bandBrightness(frameBottom, 0.03, 0.22);
  check(
    "bottom-position render: caption pixels in the bottom band, not the top",
    bottomBandA > topBandA + 3,
    `bottom=${bottomBandA.toFixed(1)} top=${topBandA.toFixed(1)}`,
  );
  const probeA = ffprobeJson(renderBottom.file);
  check(
    "captioned render keeps video + audio streams",
    probeA.streams.some((s) => s.codec_type === "video") && probeA.streams.some((s) => s.codec_type === "audio"),
  );

  doc = (await alice.call("PATCH", `/api/editor/${doc.id}/settings`, {
    body: { settings: { captionStyle: { ...baseStyle, position: "top" } } },
  })).data.document;
  const renderTop = await renderAndDownload(doc.id);
  const frameTop = frameAt(renderTop.file, midTime, "frame-top.png");
  const bottomBandB = bandBrightness(frameTop, 0.78, 0.97);
  const topBandB = bandBrightness(frameTop, 0.03, 0.22);
  check(
    "top-position render: captions move to the top band (render preserves placement)",
    topBandB > bottomBandB + 3 && topBandB > topBandA + 3,
    `top=${topBandB.toFixed(1)} bottom=${bottomBandB.toFixed(1)} prevTop=${topBandA.toFixed(1)}`,
  );

  doc = (await alice.call("PATCH", `/api/editor/${doc.id}/settings`, {
    body: { settings: { showCaptions: false } },
  })).data.document;
  const renderOff = await renderAndDownload(doc.id);
  const frameOff = frameAt(renderOff.file, midTime, "frame-off.png");
  const topBandC = bandBrightness(frameOff, 0.03, 0.22);
  const bottomBandC = bandBrightness(frameOff, 0.78, 0.97);
  check(
    "captions-off render has no caption pixels in either band (renders genuinely differ)",
    topBandB > topBandC + 3 && bottomBandA > bottomBandC + 3,
    `offTop=${topBandC.toFixed(1)} offBottom=${bottomBandC.toFixed(1)}`,
  );
  // restore captions on
  await alice.call("PATCH", `/api/editor/${doc.id}/settings`, { body: { settings: { showCaptions: true } } });

  // Hindi render completes with the Devanagari caption burned in.
  // Use a large, high-contrast style so the pixel check is decisive.
  await alice.call("PATCH", `/api/editor/${hiDoc.id}/settings`, {
    body: {
      settings: {
        captionStyle: {
          ...templates.find((t) => t.id === "builtin:clean-minimal").style,
          fontFamily: "Noto Sans Devanagari",
          fontSize: 84,
          animation: "none",
          backgroundOpacity: 0.9,
          position: "bottom",
        },
        showCaptions: true,
      },
    },
  });
  const hiRender = await renderAndDownload(hiDoc.id);
  const hiFrame = frameAt(hiRender.file, 1.2, "frame-hi.png");
  const hiBottom = bandBrightness(hiFrame, 0.6, 0.97);
  const hiTop = bandBrightness(hiFrame, 0.03, 0.3);
  check(
    "Hindi render COMPLETED and its caption band is lit (Devanagari burned in)",
    hiBottom > hiTop + 2,
    `bottom=${hiBottom.toFixed(1)} top=${hiTop.toFixed(1)}`,
  );

  // ---- 9b. Marathi captions from an mr transcript fixture -----------------
  // Same shape as the Hindi section above: Devanagari Marathi rows are
  // inserted directly as a transcript fixture, so the pipeline path
  // (transcript → captions/track → export → burn-in render) is
  // exercised with real Marathi text. This says nothing about Marathi
  // STT accuracy — no real Marathi speech is transcribed here.
  const db2 = new DatabaseSync(process.env.DATABASE_FILE);
  const mrProject = await alice.call("POST", "/api/projects", {
    body: { name: "Marathi Captions Project", workflowType: "LONG_VIDEO_TO_SHORTS" },
  });
  const mrProjectId = mrProject.data.project.id;
  await uploadMedia(alice, mrProjectId, videoBuf, "speech.mp4", "video/mp4");
  const mrAsset = db2
    .prepare("SELECT id FROM source_assets WHERE project_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(mrProjectId);
  const mrNow = new Date().toISOString();
  db2.prepare(
    "INSERT INTO processing_tasks (id, user_id, project_id, source_asset_id, status, stage, created_at, updated_at) VALUES ('mr-task-fixture', ?, ?, ?, 'COMPLETED', 'COMPLETED', ?, ?)",
  ).run(aliceRow.id, mrProjectId, mrAsset.id, mrNow, mrNow);
  db2.prepare(
    "INSERT INTO transcripts (id, task_id, project_id, source_asset_id, language, language_probability, duration, full_text, provider, model, created_at) VALUES ('mr-transcript-fixture', 'mr-task-fixture', ?, ?, 'mr', 0.9, 4.8, ?, 'local-whisper', 'small', ?)",
  ).run(mrProjectId, mrAsset.id, "नमस्कार हा एक मराठी वाक्य आहे", mrNow);
  const mrWords = [
    { start: 0.0, end: 0.9, word: "नमस्कार", probability: 0.9 },
    { start: 0.9, end: 1.3, word: "हा", probability: 0.9 },
    { start: 1.3, end: 1.8, word: "एक", probability: 0.9 },
    { start: 1.8, end: 2.8, word: "मराठी", probability: 0.9 },
    { start: 2.8, end: 3.8, word: "वाक्य", probability: 0.9 },
    { start: 3.8, end: 4.8, word: "आहे", probability: 0.9 },
  ];
  db2.prepare(
    "INSERT INTO transcript_segments (id, transcript_id, idx, start_sec, end_sec, text, words_json) VALUES ('mr-seg-1', 'mr-transcript-fixture', 0, 0.0, 4.8, ?, ?)",
  ).run("नमस्कार हा एक मराठी वाक्य आहे", JSON.stringify(mrWords));
  db2.prepare(
    "INSERT INTO candidate_clips (id, task_id, project_id, source_asset_id, user_id, start_sec, end_sec, duration, score, reasons_json, suggested_title, title, transcript_excerpt, status, preview_status, created_at) VALUES ('mr-candidate-1', 'mr-task-fixture', ?, ?, ?, 0.0, 4.8, 4.8, 80, '[]', 'Marathi clip', 'Marathi clip', ?, 'SELECTED', 'READY', ?)",
  ).run(mrProjectId, mrAsset.id, aliceRow.id, "नमस्कार हा एक मराठी वाक्य आहे", mrNow);
  db2.close();

  const mrDocRes = await alice.call("GET", `/api/projects/${mrProjectId}/editor?seedCandidateId=mr-candidate-1`);
  const mrDoc = mrDocRes.data.document;
  check(
    "Marathi editor doc seeds Devanagari captions with word timings (language mr)",
    !!mrDoc &&
      mrDoc.captions.length > 0 &&
      mrDoc.captions[0].text.includes("नमस्कार") &&
      mrDoc.captions[0].language === "mr" &&
      Array.isArray(mrDoc.captions[0].words),
    JSON.stringify(mrDoc?.captions?.[0]).slice(0, 300),
  );

  // A caption track created explicitly in Marathi on that document.
  const mrTrack = await alice.call("POST", `/api/editor/${mrDoc.id}/caption-tracks`, {
    body: {
      language: "mr",
      kind: "translation",
      label: "Marathi (manual)",
      segments: mrDoc.captions.map((c) => ({ start: c.start, end: c.end, text: "हा एक मराठी अनुवाद आहे" })),
    },
  });
  check("Marathi caption track created in mr", mrTrack.status === 201, JSON.stringify(mrTrack.data).slice(0, 200));
  const mrStudio = await alice.call("GET", `/api/editor/${mrDoc.id}/caption-studio`);
  check(
    "Marathi track is stored with language mr",
    mrStudio.data.studio.tracks.some((t) => t.id === mrTrack.data.track.id && t.language === "mr"),
  );

  const mrVttRes = await alice.raw("GET", `/api/editor/${mrDoc.id}/captions/export?format=vtt`);
  const mrVttText = await mrVttRes.text();
  check(
    "Marathi captions export as VTT with Devanagari intact",
    mrVttText.includes("नमस्कार हा एक मराठी वाक्य आहे"),
    mrVttText.slice(0, 120),
  );
  const mrSrtRes = await alice.raw(
    "GET",
    `/api/editor/${mrDoc.id}/captions/export?format=srt&trackId=${mrTrack.data.track.id}`,
  );
  const mrSrtText = await mrSrtRes.text();
  check(
    "Marathi track exports as SRT with its own Devanagari text",
    mrSrtRes.status === 200 && mrSrtText.includes("नमस्कार हा एक मराठी वाक्य आहे"),
    mrSrtText.slice(0, 120),
  );

  // Marathi burn-in render, same decisive pixel check as Hindi.
  await alice.call("PATCH", `/api/editor/${mrDoc.id}/settings`, {
    body: {
      settings: {
        captionStyle: {
          ...templates.find((t) => t.id === "builtin:clean-minimal").style,
          fontFamily: "Noto Sans Devanagari",
          fontSize: 84,
          animation: "none",
          backgroundOpacity: 0.9,
          position: "bottom",
        },
        showCaptions: true,
      },
    },
  });
  const mrRender = await renderAndDownload(mrDoc.id);
  const mrFrame = frameAt(mrRender.file, 1.2, "frame-mr.png");
  const mrBottom = bandBrightness(mrFrame, 0.6, 0.97);
  const mrTop = bandBrightness(mrFrame, 0.03, 0.3);
  check(
    "Marathi render COMPLETED and its caption band is lit (Devanagari burned in)",
    mrBottom > mrTop + 2,
    `bottom=${mrBottom.toFixed(1)} top=${mrTop.toFixed(1)}`,
  );

  // ---- 10. brand kits ------------------------------------------------------
  const kitsRes = await alice.call("GET", "/api/brand-kits");
  const seeded = kitsRes.data.kits.find((k) => k.isDefault);
  check(
    "seeded default CLIPFORGE kit with exact brand colours + logo asset",
    !!seeded &&
      seeded.primaryColor === "#1558C9" &&
      seeded.secondaryColor === "#030407" &&
      seeded.accentColor === "#D4FF24" &&
      !!seeded.logoAssetId,
    JSON.stringify(kitsRes.data.kits[0]).slice(0, 300),
  );
  const logoStream = await alice.raw("GET", `/api/brand-assets/${seeded.logoAssetId}/stream`);
  const logoText = await logoStream.text();
  check(
    "seeded logo asset streams the owner's approved SVG (gradient intact, untouched)",
    logoStream.status === 200 && logoText.includes("0860E9") && logoText.includes("D4FF24"),
    logoText.slice(0, 120),
  );

  const kitCreate = await alice.call("POST", "/api/brand-kits", {
    body: {
      name: "Launch Kit",
      brandName: "Launch Brand",
      primaryColor: "#112233",
      secondaryColor: "#445566",
      accentColor: "#D4FF24",
      fontFamily: "Noto Sans",
      captionTemplateId: "builtin:clipforge-signature",
    },
  });
  check("brand kit created", kitCreate.status === 201, JSON.stringify(kitCreate.data).slice(0, 200));
  const kitId = kitCreate.data.kit.id;

  const kitUpdate = await alice.call("PATCH", `/api/brand-kits/${kitId}`, {
    body: { name: "Launch Kit v2" },
  });
  check("brand kit updated", kitUpdate.status === 200 && kitUpdate.data.kit.name === "Launch Kit v2");
  const kitDup = await alice.call("POST", `/api/brand-kits/${kitId}/duplicate`, { body: {} });
  check("brand kit duplicated", kitDup.status === 201 && kitDup.data.kit.id !== kitId);
  const kitDefault = await alice.call("POST", `/api/brand-kits/${kitId}/default`, { body: {} });
  check("brand kit set as default", kitDefault.status === 200 && kitDefault.data.kit.isDefault === true);

  // music asset upload (real mp3 via ffmpeg sine)
  const mp3Path = path.join(tmp, "tone.mp3");
  run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "libmp3lame", mp3Path]);
  const mp3Buf = fs.readFileSync(mp3Path);
  const assetForm = new FormData();
  assetForm.append("file", new Blob([mp3Buf], { type: "audio/mpeg" }), "tone.mp3");
  assetForm.append("kind", "MUSIC");
  const assetRes = await alice.raw("POST", "/api/brand-assets", { formData: assetForm });
  const assetData = await assetRes.json().catch(() => null);
  check(
    "music brand asset uploaded + probed (audio, duration)",
    assetRes.status === 201 && assetData?.asset?.hasAudio === true && (assetData?.asset?.duration ?? 0) > 1,
    JSON.stringify(assetData).slice(0, 300),
  );
  const badAssetForm = new FormData();
  badAssetForm.append("file", new Blob(["plain text"], { type: "text/plain" }), "notes.txt");
  badAssetForm.append("kind", "MUSIC");
  const badAssetRes = await alice.raw("POST", "/api/brand-assets", { formData: badAssetForm });
  check("unsupported brand asset extension rejected 400", badAssetRes.status === 400, `status=${badAssetRes.status}`);

  // attach the music asset + apply to BOTH projects
  await alice.call("PATCH", `/api/brand-kits/${kitId}`, { body: { musicAssetId: assetData.asset.id } });
  const apply = await alice.call("POST", `/api/brand-kits/${kitId}/apply`, {
    body: { projectIds: [projectId, hiProjectId] },
  });
  check(
    "brand kit applied to multiple projects",
    apply.status === 200 && apply.data.results.length === 2 && apply.data.results.every((r) => r.ok),
    JSON.stringify(apply.data).slice(0, 300),
  );
  const hiDocAfter = await alice.call("GET", `/api/projects/${hiProjectId}/editor`);
  check(
    "applied kit lands in the target document (brandKitId + template style)",
    hiDocAfter.data.document.settings.brandKitId === kitId &&
      hiDocAfter.data.document.settings.captionTemplateId === "builtin:clipforge-signature" &&
      hiDocAfter.data.document.settings.captionStyle.highlightColor === "#D4FF24",
    JSON.stringify(hiDocAfter.data.document.settings).slice(0, 300),
  );

  const kitDelete = await alice.call("DELETE", `/api/brand-kits/${kitDup.data.kit.id}`);
  check("brand kit deleted", kitDelete.status === 200);

  // ---- 11. cross-user isolation + CSRF -------------------------------------
  const bobStudio = await bob.call("GET", `/api/editor/${doc.id}/caption-studio`);
  check("cross-user caption-studio is 404", bobStudio.status === 404, `status=${bobStudio.status}`);
  const bobExport = await bob.raw("GET", `/api/editor/${doc.id}/captions/export?format=srt`);
  check("cross-user subtitle export is 404", bobExport.status === 404, `status=${bobExport.status}`);
  const bobKit = await bob.call("PATCH", `/api/brand-kits/${kitId}`, { body: { name: "Stolen" } });
  check("cross-user brand kit edit is 404", bobKit.status === 404, `status=${bobKit.status}`);
  const bobApply = await bob.call("POST", `/api/brand-kits/${kitId}/apply`, { body: { projectIds: [projectId] } });
  check("cross-user brand kit apply is 404", bobApply.status === 404, `status=${bobApply.status}`);
  const bobKits = await bob.call("GET", "/api/brand-kits");
  check(
    "each user sees only their own kits (bob has his own seeded kit)",
    bobKits.data.kits.length >= 1 && bobKits.data.kits.every((k) => k.id !== kitId),
  );

  // CSRF: a mutation without the token must be refused even with a
  // valid session cookie.
  const csrfLess = await fetch(`${BASE}/api/brand-kits`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: alice.cookieHeader() },
    body: JSON.stringify({
      name: "No CSRF",
      brandName: "No CSRF",
      primaryColor: "#112233",
      secondaryColor: "#445566",
      accentColor: "#D4FF24",
    }),
  });
  check("mutation without CSRF token is rejected (403)", csrfLess.status === 403, `status=${csrfLess.status}`);

  console.log(`\nPhase 6 captions e2e: ${passed} passed, ${failed} failed`);
  if (failures.length) console.log("failures:", failures.join(" | "));
} catch (err) {
  failed += 1;
  console.error("SUITE ERROR", err);
  console.error(serverLog.slice(-3000));
} finally {
  try {
    process.kill(-server.pid, "SIGKILL");
  } catch {
    server.kill("SIGKILL");
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

process.exit(failed > 0 ? 1 : 0);
