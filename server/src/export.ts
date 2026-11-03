// CLIPFORGE API — Phase 9: Export Studio, batch export & the
// rendering queue.
//
// Architecture (extends, never forks, the Phase 5 pipeline):
//  - An export is a render_jobs row with kind='EXPORT' whose
//    settings carry an `export` block next to the timeline snapshot.
//    The SAME worker (editor.ts renderTick, one job at a time) drains
//    it; processRenderJob composes exactly as Phases 5–8 do, then —
//    for export jobs only — runs a final ENCODING pass to the
//    requested container/codecs/quality/audio shape, the extended QC
//    gate and the export_outputs history write.
//  - Queue discipline (priority, pause-hold for QUEUED jobs, retry
//    count, real encoder progress) lives on render_jobs columns added
//    by migration v8. Pause is deliberately NOT offered for RUNNING
//    jobs: an in-flight FFmpeg encode cannot be paused safely, so a
//    queued job can be held (status PAUSED, the worker never claims
//    it) and a running one can only be cancelled — the UI says so.
//  - Progress is parsed from ffmpeg's own -progress output in
//    editor.ts (frame / out_time / speed); the percentage is
//    processed duration ÷ the known duration of the media being
//    encoded. No timers, no invented percentages.
//  - Preflight runs BEFORE a job is created: a target whose assets,
//    codecs, dimensions or dependencies fail validation becomes a
//    FAILED job at stage VALIDATING with the check list persisted in
//    render_validation_results — it never reaches the renderer.
//  - Downloads are owner-checked endpoints over private local
//    storage; there are no public/permanent URLs. Production path
//    (documented, NOT running here): PostgreSQL + BullMQ/Redis
//    workers + private object storage, as in earlier phases.

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { config } from "./config.js";
import {
  getDb,
  type CandidateClipRow,
  type ClipVersionRow,
  type ExportBundleRow,
  type ExportOutputRow,
  type ExportPresetRow,
  type ProjectRow,
  type ProjectVersionRow,
  type ReframeConfigurationRow,
  type RenderJobRow,
  type UserRow,
} from "./db.js";
import {
  ASPECT_PRESETS,
  candidateState,
  docById,
  getOrCreateDoc,
  killRenderChildren,
  ownedProject,
  publicRenderJob,
  readState,
  renderConcurrency,
  resolveAsset,
  timelineDurationOf,
  validateState,
  type EditorState,
} from "./editor.js";
import { mediaPath, probeAnyFile } from "./media.js";
import {
  DEFAULT_AUDIO_ENHANCE,
  DEFAULT_VIDEO_ENHANCE,
  normalizeAudio,
  normalizeVideo,
} from "./enhance.js";
import { buildReframePayload, type ReframeRenderPayload } from "./tracking.js";
import { fontAvailable } from "./captions.js";

// ---- shared helpers ---------------------------------------------------------

const nowIso = (): string => new Date().toISOString();
const newId = (): string => crypto.randomUUID();
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

interface AuthedRequest extends Request {
  user?: UserRow;
}
type RequireAuth = (req: AuthedRequest, res: Response, next: NextFunction) => void;

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

/** Destructive export deletes require an explicit confirmation at
 *  the API level (the Phase 6 precedent: 409 CONFIRMATION_REQUIRED
 *  when it is missing) — a UI dialog alone is not a contract. The
 *  `?confirm=true` query parameter is the primary path because
 *  DELETE bodies are unreliable through some clients; a JSON body
 *  `{ "confirm": true }` is accepted too. */
function deleteConfirmed(req: AuthedRequest): boolean {
  if (req.query.confirm === "true") return true;
  const body = (req.body ?? {}) as { confirm?: unknown };
  return body.confirm === true;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// ---- export settings: THE wire shape ---------------------------------------
// The frontend client (src/services/export.ts) mirrors this schema
// field for field, including DEFAULT_EXPORT_SETTINGS below — the
// Phase 8 lesson: any drift between the panel's shape and this
// schema silently kills controls, so the e2e suite posts the
// client's exact default object.

export const EXPORT_ENCODER_PRESETS = [
  "ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow",
] as const;

export const exportSettingsSchema = z
  .object({
    container: z.enum(["mp4", "webm"]),
    videoCodec: z.enum(["libx264", "libx265", "libvpx-vp9"]),
    audioCodec: z.enum(["aac", "libopus", "libmp3lame"]),
    audioOnly: z.boolean(),
    resolution: z.enum(["original", "480p", "720p", "1080p", "1440p", "2160p"]),
    aspect: z.enum(["original", "9:16", "16:9", "1:1", "4:5", "custom"]),
    customWidth: z.number().int().min(16).max(7680).nullable(),
    customHeight: z.number().int().min(16).max(7680).nullable(),
    qualityMode: z.enum(["preset", "crf", "bitrate"]),
    qualityPreset: z.enum(["low", "standard", "high", "maximum"]),
    crf: z.number().int().min(0).max(63).nullable(),
    videoBitrateKbps: z.number().int().min(100).max(100_000).nullable(),
    encoderPreset: z.enum(EXPORT_ENCODER_PRESETS),
    fps: z.number().int().min(1).max(120).nullable(),
    keyframeInterval: z.number().min(0.5).max(60).nullable(),
    includeOriginalAudio: z.boolean(),
    includeMusic: z.boolean(),
    includeBrollAudio: z.boolean(),
    audioBitrateKbps: z.number().int().min(32).max(320),
    audioSampleRate: z.union([z.literal(44100), z.literal(48000)]),
    audioChannels: z.union([z.literal(1), z.literal(2)]),
    normalizeAudio: z.boolean(),
    captionMode: z.enum(["burn", "separate", "bundle", "none"]),
    captionFormat: z.enum(["srt", "vtt", "both"]),
    includeEnhancement: z.boolean(),
    includeReframe: z.boolean(),
    namingPattern: z.enum(["project-clip-date", "project-clip-resolution", "clip-aspect-format", "custom"]),
    customName: z.string().trim().max(160).nullable(),
    rangeStart: z.number().min(0).max(86400).nullable(),
    rangeEnd: z.number().min(0).max(86400).nullable(),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (!s.audioOnly && s.container === "webm" && s.videoCodec !== "libvpx-vp9") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["videoCodec"],
        message: "WebM requires the VP9 video codec. Switch the codec to VP9 or the container to MP4.",
      });
    }
    if (!s.audioOnly && s.container === "webm" && s.audioCodec !== "libopus") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["audioCodec"],
        message: "WebM requires the Opus audio codec. Switch the audio codec to Opus or the container to MP4.",
      });
    }
    if (s.audioCodec === "libmp3lame" && !s.audioOnly) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["audioCodec"],
        message: "MP3 audio is only available for audio-only exports. Enable audio-only or choose AAC/Opus.",
      });
    }
    if (s.aspect === "custom" && (s.customWidth === null || s.customHeight === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["customWidth"],
        message: "Custom aspect needs both a width and a height.",
      });
    }
    if (s.qualityMode === "crf" && s.crf === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["crf"],
        message: "CRF quality mode needs a CRF value.",
      });
    }
    if (s.qualityMode === "crf" && s.crf !== null && s.videoCodec !== "libvpx-vp9" && s.crf > 51) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["crf"],
        message: "CRF for H.264/H.265 must be between 0 and 51.",
      });
    }
    if (s.qualityMode === "bitrate" && s.videoBitrateKbps === null && !s.audioOnly) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["videoBitrateKbps"],
        message: "Bitrate quality mode needs a video bitrate.",
      });
    }
    if (s.rangeStart !== null && s.rangeEnd !== null && s.rangeEnd - s.rangeStart < 0.5) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rangeEnd"],
        message: "The export range must be at least half a second long.",
      });
    }
    if (s.namingPattern === "custom" && (!s.customName || s.customName.trim().length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["customName"],
        message: "Custom naming needs a name template (tokens: {project} {clip} {date} {resolution} {aspect} {format}).",
      });
    }
  });

export type ExportSettingsInput = z.infer<typeof exportSettingsSchema>;

/** The settings as stored on a job: the validated client input plus
 *  server-computed fields clients never set (display filename,
 *  target label, attached snapshots live as siblings in
 *  RenderSettings, not here). */
export interface ExportSettings extends ExportSettingsInput {
  outputName?: string;
  targetLabel?: string;
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettingsInput = {
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

/** Merge a (possibly partial) client payload over the defaults and
 *  validate the result against the strict schema. */
export function normalizeExportSettings(
  input: unknown,
): { ok: true; settings: ExportSettingsInput } | { ok: false; error: string } {
  if (input === undefined || input === null) {
    return { ok: true, settings: { ...DEFAULT_EXPORT_SETTINGS } };
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Export settings must be an object." };
  }
  const merged = { ...DEFAULT_EXPORT_SETTINGS, ...(input as Record<string, unknown>) };
  const parsed = exportSettingsSchema.safeParse(merged);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first ? `${first.path.join(".") || "settings"}: ${first.message}` : "Invalid export settings.",
    };
  }
  return { ok: true, settings: parsed.data };
}

// ---- encoder probe (runtime truth, spec §2/§12) ------------------------------

interface EncoderSupport {
  libx264: boolean;
  libx265: boolean;
  "libvpx-vp9": boolean;
  aac: boolean;
  libopus: boolean;
  libmp3lame: boolean;
  ffmpegVersion: string | null;
}

let encoderCache: EncoderSupport | null = null;
let encoderProbe: Promise<EncoderSupport> | null = null;

export function probeEncoders(): Promise<EncoderSupport> {
  if (encoderCache) return Promise.resolve(encoderCache);
  if (!encoderProbe) {
    encoderProbe = new Promise<EncoderSupport>((resolve) => {
      execFile("ffmpeg", ["-hide_banner", "-encoders"], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        const text = err ? "" : stdout;
        const support: EncoderSupport = {
          libx264: /\blibx264\b/.test(text),
          libx265: /\blibx265\b/.test(text),
          "libvpx-vp9": /\blibvpx-vp9\b/.test(text),
          aac: /\baac\b/.test(text),
          libopus: /\blibopus\b/.test(text),
          libmp3lame: /\blibmp3lame\b/.test(text),
          ffmpegVersion: null,
        };
        execFile("ffmpeg", ["-version"], { maxBuffer: 1024 * 1024 }, (err2, out2) => {
          if (!err2) support.ffmpegVersion = out2.split("\n")[0]?.trim() ?? null;
          encoderCache = support;
          resolve(support);
        });
      });
    });
  }
  return encoderProbe;
}

// ---- builtin export presets (spec §1/§4) -------------------------------------

export interface BuiltinExportPreset {
  id: string;
  name: string;
  description: string;
  settings: Partial<ExportSettingsInput>;
}

export const BUILTIN_EXPORT_PRESETS: BuiltinExportPreset[] = [
  {
    id: "builtin:youtube-1080p",
    name: "YouTube HD 1080p",
    description: "MP4 · H.264 · AAC, 1920×1080 (or your aspect at 1080p class), high quality, captions burned in.",
    settings: { container: "mp4", videoCodec: "libx264", audioCodec: "aac", resolution: "1080p", qualityPreset: "high", captionMode: "burn" },
  },
  {
    id: "builtin:shorts-vertical",
    name: "Shorts / Reels Vertical",
    description: "MP4 · H.264 · AAC, 9:16 at 1080×1920, high quality, captions burned in.",
    settings: { container: "mp4", videoCodec: "libx264", audioCodec: "aac", resolution: "1080p", aspect: "9:16", qualityPreset: "high", captionMode: "burn" },
  },
  {
    id: "builtin:square-social",
    name: "Square Social 1:1",
    description: "MP4 · H.264 · AAC, 1:1 at 1080×1080, standard quality, captions burned in.",
    settings: { container: "mp4", videoCodec: "libx264", audioCodec: "aac", resolution: "1080p", aspect: "1:1", qualityPreset: "standard", captionMode: "burn" },
  },
  {
    id: "builtin:webm-web",
    name: "WebM for Web",
    description: "WebM · VP9 · Opus, 720p class, standard quality, subtitles as a separate VTT file.",
    settings: { container: "webm", videoCodec: "libvpx-vp9", audioCodec: "libopus", resolution: "720p", qualityPreset: "standard", captionMode: "separate", captionFormat: "vtt" },
  },
  {
    id: "builtin:maximum-quality",
    name: "Maximum Quality",
    description: "MP4 · H.265 · AAC, 2160p class in your edit's aspect, maximum quality preset. Larger files, slower encodes.",
    settings: { container: "mp4", videoCodec: "libx265", audioCodec: "aac", resolution: "2160p", qualityPreset: "maximum", encoderPreset: "medium", captionMode: "burn" },
  },
  {
    id: "builtin:podcast-audio",
    name: "Podcast Audio (MP3)",
    description: "Audio only · MP3 at 192 kbps, loudness normalization on, no captions.",
    settings: { audioOnly: true, audioCodec: "libmp3lame", audioBitrateKbps: 192, normalizeAudio: true, captionMode: "none" },
  },
  {
    id: "builtin:tiktok",
    name: "TikTok",
    description: "MP4 · H.264 · AAC, 9:16 at 1080×1920, high quality, captions burned in.",
    settings: { container: "mp4", videoCodec: "libx264", audioCodec: "aac", resolution: "1080p", aspect: "9:16", qualityPreset: "high", captionMode: "burn" },
  },
  {
    id: "builtin:instagram-feed",
    name: "Instagram Feed (4:5)",
    description: "MP4 · H.264 · AAC, 4:5 at 1080×1350, high quality, captions burned in.",
    settings: { container: "mp4", videoCodec: "libx264", audioCodec: "aac", resolution: "1080p", aspect: "4:5", qualityPreset: "high", captionMode: "burn" },
  },
  {
    id: "builtin:x-twitter",
    name: "X / Twitter",
    description: "MP4 · H.264 · AAC, 16:9 at 1920×1080, high quality, captions burned in.",
    settings: { container: "mp4", videoCodec: "libx264", audioCodec: "aac", resolution: "1080p", aspect: "16:9", qualityPreset: "high", captionMode: "burn" },
  },
  {
    id: "builtin:linkedin",
    name: "LinkedIn",
    description: "MP4 · H.264 · AAC, 16:9 at 1920×1080, high quality, captions burned in.",
    settings: { container: "mp4", videoCodec: "libx264", audioCodec: "aac", resolution: "1080p", aspect: "16:9", qualityPreset: "high", captionMode: "burn" },
  },
];

// ---- canvas resolution (spec §3) ----------------------------------------------

const RESOLUTION_SCALE: Record<string, number> = {
  "480p": 480 / 1080,
  "720p": 720 / 1080,
  "1080p": 1,
  "1440p": 1440 / 1080,
  "2160p": 2160 / 1080,
};

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);

export interface ExportCanvas {
  aspect: string;
  width: number;
  height: number;
  custom: boolean;
}

/** Resolve the output canvas for an export. "Original" keeps the
 *  document canvas untouched; an aspect preset swaps in the Phase 5
 *  preset dims at 1080p class, scaled by the resolution class. The
 *  pipeline's fit/fill + background behaviour then composes into the
 *  new canvas exactly as if the user had set it in the editor —
 *  nothing is ever stretched. */
export function resolveExportCanvas(
  docCanvas: { aspect: string; width: number; height: number; custom: boolean },
  settings: ExportSettingsInput,
): ExportCanvas {
  if (settings.aspect === "custom" && settings.customWidth && settings.customHeight) {
    return {
      aspect: "custom",
      width: even(settings.customWidth),
      height: even(settings.customHeight),
      custom: true,
    };
  }
  const base =
    settings.aspect !== "original" && ASPECT_PRESETS[settings.aspect]
      ? { aspect: settings.aspect, ...ASPECT_PRESETS[settings.aspect]! }
      : { aspect: docCanvas.aspect, width: docCanvas.width, height: docCanvas.height };
  if (settings.resolution === "original") {
    return { aspect: base.aspect, width: even(base.width), height: even(base.height), custom: settings.aspect === "custom" };
  }
  const scale = RESOLUTION_SCALE[settings.resolution] ?? 1;
  return {
    aspect: base.aspect,
    width: even(base.width * scale),
    height: even(base.height * scale),
    custom: false,
  };
}

export function exportExtension(settings: ExportSettingsInput): string {
  if (settings.audioOnly) {
    if (settings.audioCodec === "libmp3lame") return "mp3";
    if (settings.audioCodec === "libopus") return "opus";
    return "m4a";
  }
  return settings.container;
}

// ---- targets ------------------------------------------------------------------

export interface ExportTargetRef {
  kind: "document" | "version" | "candidate";
  id?: string;
}

export interface ResolvedTarget {
  label: string;
  state: EditorState;
}

/** Resolve a target to the editing state it exports from. Every
 *  target kind uses its OWN saved state: the live document, a named
 *  project_versions snapshot, or a candidate's own seed state. */
export function resolveTargetState(
  userId: string,
  project: ProjectRow,
  doc: ClipVersionRow,
  target: ExportTargetRef,
): { ok: true; resolved: ResolvedTarget } | { ok: false; error: string } {
  if (target.kind === "document") {
    return { ok: true, resolved: { label: `${project.name} — Edited project`, state: readState(doc) } };
  }
  if (target.kind === "version") {
    if (!target.id) return { ok: false, error: "A version target needs a version id." };
    const row = getDb()
      .prepare("SELECT * FROM project_versions WHERE id = ? AND version_id = ?")
      .get(target.id, doc.id) as ProjectVersionRow | undefined;
    if (!row) return { ok: false, error: "That saved version was not found for this project." };
    const checked = validateState(userId, project.id, parseJson<unknown>(row.snapshot_json, null));
    if (!checked.ok) return { ok: false, error: `That version can no longer be exported: ${checked.error}` };
    return { ok: true, resolved: { label: `${project.name} — ${row.name}`, state: checked.state } };
  }
  // candidate
  if (!target.id) return { ok: false, error: "A candidate target needs a candidate id." };
  const candidate = getDb()
    .prepare("SELECT * FROM candidate_clips WHERE id = ? AND user_id = ? AND project_id = ?")
    .get(target.id, userId, project.id) as CandidateClipRow | undefined;
  if (!candidate) return { ok: false, error: "That generated clip was not found for this project." };
  const state = candidateState(userId, project, candidate.id);
  if (!state) return { ok: false, error: "That generated clip could not be prepared for export." };
  return {
    ok: true,
    resolved: { label: `${project.name} — ${candidate.title || "Generated clip"}`, state },
  };
}

/** Clip a state to [rangeStart, rangeEnd): items are trimmed in
 *  source time (speed-aware), captions and scene overrides shift
 *  with the range. This is the "selected timeline range" export. */
export function clipStateToRange(state: EditorState, rangeStart: number, rangeEnd: number): EditorState {
  const rs = rangeStart;
  const re = rangeEnd;
  const items: EditorState["items"] = [];
  for (const item of state.items) {
    const itemEnd = item.start + item.duration;
    const os = Math.max(item.start, rs);
    const oe = Math.min(itemEnd, re);
    if (oe - os <= 0.01) continue;
    const shift = os - item.start;
    const sourceIn = item.sourceIn + shift * item.speed;
    const duration = oe - os;
    items.push({
      ...item,
      start: round3(os - rs),
      duration: round3(duration),
      sourceIn: round3(sourceIn),
      sourceOut: round3(sourceIn + duration * item.speed),
      fadeIn: Math.min(item.fadeIn, duration),
      fadeOut: Math.min(item.fadeOut, duration),
    });
  }
  const captions = state.captions
    .filter((c) => c.end > rs && c.start < re)
    .map((c) => ({
      ...c,
      start: round3(Math.max(c.start, rs) - rs),
      end: round3(Math.min(c.end, re) - rs),
      words: c.words
        ? c.words
            .filter((w) => w.end > rs && w.start < re)
            .map((w) => ({
              ...w,
              start: round3(Math.max(w.start, rs) - rs),
              end: round3(Math.min(w.end, re) - rs),
            }))
        : null,
    }));
  const sceneOverrides = state.sceneOverrides
    .filter((o) => o.rangeEnd > rs && o.rangeStart < re)
    .map((o) => ({
      ...o,
      rangeStart: round3(Math.max(o.rangeStart, rs) - rs),
      rangeEnd: round3(Math.min(o.rangeEnd, re) - rs),
    }));
  return { ...state, items, captions, sceneOverrides };
}

/** Apply the export-only derivations to a target state: range,
 *  audio include toggles (as track mutes / item volumes — the mix
 *  itself is the Phase 5/8 mix, untouched), caption forcing and the
 *  export canvas. */
export function deriveExportState(base: EditorState, settings: ExportSettingsInput): EditorState {
  let state = base;
  const fullDuration = timelineDurationOf(state);
  if (settings.rangeStart !== null || settings.rangeEnd !== null) {
    const rs = Math.max(0, settings.rangeStart ?? 0);
    const re = Math.min(fullDuration, settings.rangeEnd ?? fullDuration);
    if (re - rs >= 0.5) state = clipStateToRange(state, rs, re);
  }
  const tracks = state.tracks.map((t) => {
    if (t.kind === "main" && !settings.includeOriginalAudio) return { ...t, muted: true };
    if (t.kind === "audio" && !settings.includeMusic) return { ...t, muted: true };
    return t;
  });
  const items = state.items.map((item) => {
    const track = state.tracks.find((t) => t.id === item.trackId);
    if ((track?.kind === "broll" || track?.kind === "overlay") && !settings.includeBrollAudio) {
      return { ...item, volume: 0 };
    }
    return item;
  });
  return {
    ...state,
    tracks,
    items,
    canvas: resolveExportCanvas(state.canvas, settings),
    settings: {
      ...state.settings,
      showCaptions: settings.captionMode === "burn",
    },
  };
}

// ---- Phase 8 / Phase 7 snapshots (attached when requested) ---------------------

interface EnhanceConfigRow {
  video_enabled: number;
  audio_enabled: number;
  video_json: string;
  audio_json: string;
  scope: string;
  item_ids_json: string;
}

/** The document's stored Phase 8 enhancement config as a render
 *  snapshot — the same construction broll.ts uses for
 *  /render-enhanced, so exports cannot drift from enhanced renders. */
export function enhancementSnapshot(docId: string, userId: string) {
  const row = getDb()
    .prepare("SELECT * FROM enhancement_configs WHERE version_id = ? AND user_id = ?")
    .get(docId, userId) as EnhanceConfigRow | undefined;
  if (!row || (row.video_enabled !== 1 && row.audio_enabled !== 1)) return null;
  return {
    video: row.video_enabled === 1 ? normalizeVideo(parseJson(row.video_json, {})) : { ...DEFAULT_VIDEO_ENHANCE },
    audio: row.audio_enabled === 1 ? normalizeAudio(parseJson(row.audio_json, {})) : { ...DEFAULT_AUDIO_ENHANCE },
    scope: (row.scope === "items" ? "items" : "project") as "project" | "items",
    itemIds: row.scope === "items" ? parseJson<string[]>(row.item_ids_json, []) : [],
  };
}

/** The document's Phase 7 reframe configuration + render payload. */
export function reframeSnapshot(
  doc: ClipVersionRow,
  userId: string,
): { ok: true; payload: ReframeRenderPayload; config: ReframeConfigurationRow }
  | { ok: false; error: string } {
  const row = getDb()
    .prepare("SELECT * FROM reframe_configurations WHERE version_id = ? AND user_id = ?")
    .get(doc.id, userId) as ReframeConfigurationRow | undefined;
  if (!row) {
    return { ok: false, error: "No reframing configuration exists for this edit yet. Run tracking in the editor first." };
  }
  if (row.mode === "face-lock" && row.enabled !== 1) {
    return { ok: false, error: "Face Lock is switched off for this edit's reframing configuration." };
  }
  const built = buildReframePayload(row);
  if ("error" in built) return { ok: false, error: built.error };
  return { ok: true, payload: built.payload, config: row };
}

// ---- preflight (spec §12) -------------------------------------------------------

export interface PreflightCheck {
  id: string;
  ok: boolean;
  level: "error" | "warning";
  detail: string;
}

export interface PreparedExport {
  state: EditorState;
  timelineDuration: number;
  enhance: ReturnType<typeof enhancementSnapshot>;
  reframe: ReframeRenderPayload | null;
  reframeConfig: ReframeConfigurationRow | null;
}

/** Build the full render snapshot for one target: derived state +
 *  the Phase 7/8 snapshots the settings ask for. */
export function prepareExport(
  userId: string,
  doc: ClipVersionRow,
  baseState: EditorState,
  settings: ExportSettingsInput,
): { ok: true; prepared: PreparedExport } | { ok: false; error: string } {
  let state = deriveExportState(baseState, settings);
  let reframe: PreparedExport["reframe"] = null;
  let reframeConfig: ReframeConfigurationRow | null = null;
  if (settings.includeReframe) {
    const snap = reframeSnapshot(doc, userId);
    if (!snap.ok) return { ok: false, error: snap.error };
    reframe = snap.payload;
    reframeConfig = snap.config;
    // Reframe canvas wins when the user left format at "original"
    // (the same precedence the Phase 7 reframe-render route uses).
    if (settings.aspect === "original" && settings.resolution === "original") {
      state = {
        ...state,
        canvas: {
          aspect: snap.config.aspect,
          width: snap.config.out_width,
          height: snap.config.out_height,
          custom: snap.config.aspect === "custom",
        },
      };
    }
  }
  const enhance = settings.includeEnhancement ? enhancementSnapshot(doc.id, userId) : null;
  if (settings.includeEnhancement && !enhance) {
    return {
      ok: false,
      error: "Enhancement was requested but is switched off for this edit. Enable it in the Enhance panel and save the configuration first.",
    };
  }
  return {
    ok: true,
    prepared: { state, timelineDuration: timelineDurationOf(state), enhance, reframe, reframeConfig },
  };
}

/** Real preflight validation. Error-level failures block the render
 *  (the job is created FAILED at VALIDATING with these checks
 *  persisted); warnings are reported but never block. */
export async function runPreflight(args: {
  userId: string;
  project: ProjectRow;
  state: EditorState;
  settings: ExportSettingsInput;
  prepared: PreparedExport;
}): Promise<PreflightCheck[]> {
  const { userId, project, state, settings, prepared } = args;
  const checks: PreflightCheck[] = [];
  const push = (id: string, ok: boolean, detail: string, level: "error" | "warning" = "error") =>
    checks.push({ id, ok, level, detail });

  // Codecs available on THIS FFmpeg build (probed at runtime).
  const encoders = await probeEncoders();
  if (settings.audioOnly) {
    push(
      "codec-audio",
      encoders[settings.audioCodec],
      encoders[settings.audioCodec]
        ? `audio encoder ${settings.audioCodec} is available`
        : `audio encoder ${settings.audioCodec} is NOT available in this FFmpeg build — choose AAC or Opus instead`,
    );
  } else {
    push(
      "codec-video",
      encoders[settings.videoCodec],
      encoders[settings.videoCodec]
        ? `video encoder ${settings.videoCodec} is available`
        : `video encoder ${settings.videoCodec} is NOT available in this FFmpeg build — choose H.264 (libx264) instead`,
    );
    push(
      "codec-audio",
      encoders[settings.audioCodec],
      encoders[settings.audioCodec]
        ? `audio encoder ${settings.audioCodec} is available`
        : `audio encoder ${settings.audioCodec} is NOT available in this FFmpeg build — choose AAC instead`,
    );
  }

  // Timeline structure + assets.
  if (prepared.timelineDuration <= 0) {
    push("timeline", false, "the timeline has no main-track clips to export");
  } else {
    push("timeline", true, `timeline duration ${prepared.timelineDuration}s`);
  }
  const trackIds = new Set(state.tracks.map((t) => t.id));
  const badRefs = state.items.filter((i) => !trackIds.has(i.trackId));
  push(
    "timeline-refs",
    badRefs.length === 0,
    badRefs.length === 0
      ? "every timeline item references an existing track"
      : `${badRefs.length} timeline item(s) reference a missing track`,
  );
  const missing: string[] = [];
  let anyAudio = false;
  for (const item of state.items) {
    const media = resolveAsset(userId, project.id, item.assetKind, item.assetId);
    if (!media || !media.path || !fs.existsSync(mediaPath(media.path))) {
      missing.push(`asset ${item.assetId}`);
    } else if (media.hasAudio) {
      anyAudio = true;
    }
  }
  push(
    "assets-exist",
    missing.length === 0,
    missing.length === 0
      ? "all timeline media files exist"
      : `missing media for: ${missing.join(", ")}`,
  );

  // B-roll placements (distinct from the general asset check): every
  // B-roll item's media must not only exist but probe as readable
  // media, because the composition pass decodes it as an overlay.
  const brollItems = state.items.filter(
    (item) => state.tracks.find((t) => t.id === item.trackId)?.kind === "broll",
  );
  if (brollItems.length > 0) {
    const brollProblems: string[] = [];
    for (const item of brollItems) {
      const media = resolveAsset(userId, project.id, item.assetKind, item.assetId);
      if (!media || !media.path || !fs.existsSync(mediaPath(media.path))) {
        brollProblems.push(`B-roll placement ${item.id} (asset ${item.assetId}): file is missing`);
        continue;
      }
      try {
        await probeAnyFile(mediaPath(media.path));
      } catch {
        brollProblems.push(`B-roll placement ${item.id} (asset ${item.assetId}): file could not be probed as readable media`);
      }
    }
    push(
      "broll-media",
      brollProblems.length === 0,
      brollProblems.length === 0
        ? `B-roll media: ${brollItems.length} placement(s) present and readable`
        : `B-roll media problems: ${brollProblems.join("; ")}`,
    );
  }

  // Dimensions.
  const { width, height } = state.canvas;
  const dimsOk =
    width >= 16 && height >= 16 && width <= 7680 && height <= 7680 && width % 2 === 0 && height % 2 === 0;
  push("dimensions", dimsOk, `output dimensions ${width}×${height}${dimsOk ? "" : " are unsupported (need even, 16–7680)"}`);

  // Captions + fonts.
  const captionCount = state.captions.filter((c) => c.text.trim().length > 0).length;
  if (settings.captionMode !== "none") {
    if (captionCount === 0) {
      push("captions", true, "no captions exist in this edit — nothing will be burned or exported", "warning");
    } else {
      const font = state.settings.captionStyle.fontFamily;
      const hasFont = fontAvailable(font);
      push(
        "captions",
        true,
        hasFont
          ? `${captionCount} caption cue(s); font "${font}" is available`
          : `${captionCount} caption cue(s); font "${font}" is not installed — the renderer will fall back to a default font`,
        hasFont ? "error" : "warning",
      );
    }
  }

  // Caption timing/syntax validity for the cues that will actually
  // be used (burned or written as sidecars): each cue must end after
  // it starts, and consecutive cues must not overlap beyond a small
  // tolerance (0.1s) — libass would stack overlapping cues on screen
  // and sidecar players garble them. The offending cue is named.
  // Two populations are NOT errors, matching how the caption
  // builders treat them: empty-text cues (skipped by buildAss and
  // the sidecar writer alike) and seed-clamp slivers — candidate
  // seeding clamps transcript segments to the candidate window,
  // which can leave a cue of a few milliseconds at the window edge;
  // the builders emit it as a zero-length event that renders as
  // nothing. A cue whose end is BEFORE its start is corrupt data
  // (the editor's own state validation forbids saving one) and
  // fails, as does any real overlap.
  if (settings.captionMode !== "none" && captionCount > 0) {
    const cues = state.captions
      .filter((c) => c.text.trim().length > 0)
      .filter((c) => !(c.end >= c.start && c.end - c.start < 0.02))
      .slice()
      .sort((a, b) => a.start - b.start);
    const timingProblems: string[] = [];
    cues.forEach((cue, i) => {
      if (!(cue.end > cue.start)) {
        timingProblems.push(
          `cue ${i + 1} ("${cue.text.trim().slice(0, 40)}", ${cue.start.toFixed(2)}s–${cue.end.toFixed(2)}s) ends before it starts`,
        );
      }
    });
    for (let i = 1; i < cues.length; i += 1) {
      const overlap = cues[i - 1]!.end - cues[i]!.start;
      if (overlap > 0.1) {
        timingProblems.push(`cue ${i + 1} overlaps cue ${i} by ${overlap.toFixed(2)}s`);
      }
    }
    push(
      "caption-timing",
      timingProblems.length === 0,
      timingProblems.length === 0
        ? "caption cue timings are valid (every cue ends after it starts; no overlaps beyond 0.1s)"
        : `caption timing problems: ${timingProblems.join("; ")}`,
    );
  }

  // Reframing data (prepareExport already failed hard without it;
  // this records the positive check for the diagnostics view).
  if (settings.includeReframe) {
    push("reframe", Boolean(prepared.reframe), prepared.reframe ? "reframing data is attached" : "reframing data missing");
  }
  if (settings.includeEnhancement) {
    push("enhancement", Boolean(prepared.enhance), prepared.enhance ? "enhancement configuration is attached" : "enhancement configuration missing");
  }

  // Audio expectations (spec §5: warn, never silently drop).
  const audioExpected = settings.includeOriginalAudio || settings.includeMusic || settings.includeBrollAudio;
  if (!audioExpected) {
    push("audio", true, "all audio includes are off — the export will have no audio track, as configured", "warning");
  } else if (!anyAudio) {
    push("audio", true, "this project has no usable audio — the export will be silent", "warning");
  } else {
    push("audio", true, "audio sources are present and will be mixed");
  }

  // Storage (where measurable): intermediates need roughly 3× the
  // deliverable; the deliverable estimate uses the bitrate when the
  // user gave one, else a conservative 12 Mbps at 1080p scaled by
  // pixel count.
  try {
    const stat = fs.statfsSync(config.mediaDir);
    const freeBytes = Number(stat.bavail) * Number(stat.bsize);
    const pixels = width * height;
    const estMbps =
      settings.qualityMode === "bitrate" && settings.videoBitrateKbps
        ? settings.videoBitrateKbps / 1000
        : 12 * (pixels / (1920 * 1080));
    const needed = Math.ceil(((estMbps * 1_000_000) / 8) * prepared.timelineDuration * 3);
    push(
      "storage",
      freeBytes > needed,
      freeBytes > needed
        ? `${Math.round(freeBytes / 1e9)} GB free, about ${Math.max(1, Math.round(needed / 1e6))} MB needed`
        : `only ${Math.round(freeBytes / 1e6)} MB free, about ${Math.round(needed / 1e6)} MB needed for this export`,
    );
  } catch {
    push("storage", true, "free disk space could not be measured on this server", "warning");
  }

  return checks;
}

// ---- naming (spec §14) ------------------------------------------------------------

function sanitizeNamePart(raw: string): string {
  return raw
    .replace(/[^A-Za-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function buildOutputName(args: {
  project: ProjectRow;
  targetLabel: string;
  settings: ExportSettingsInput;
  canvas: ExportCanvas;
  taken: Set<string>;
}): string {
  const { project, targetLabel, settings, canvas, taken } = args;
  const ext = exportExtension(settings);
  const projectPart = sanitizeNamePart(project.name) || "project";
  const clipPart = sanitizeNamePart(targetLabel.replace(/^.*—\s*/, "")) || "clip";
  const date = new Date().toISOString().slice(0, 10);
  const resolution = `${canvas.width}x${canvas.height}`;
  const aspectLabel = (canvas.aspect === "custom" ? `${canvas.width}x${canvas.height}` : canvas.aspect).replace(":", "x");
  let base: string;
  switch (settings.namingPattern) {
    case "project-clip-date":
      base = `${projectPart}_${clipPart}_${date}`;
      break;
    case "clip-aspect-format":
      base = `${clipPart}_${aspectLabel}_${ext}`;
      break;
    case "custom": {
      const template = settings.customName ?? "{project}_{clip}";
      base = template
        .replaceAll("{project}", projectPart)
        .replaceAll("{clip}", clipPart)
        .replaceAll("{date}", date)
        .replaceAll("{resolution}", resolution)
        .replaceAll("{aspect}", aspectLabel)
        .replaceAll("{format}", ext)
        .replace(/[^A-Za-z0-9-_]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 120);
      break;
    }
    case "project-clip-resolution":
    default:
      base = `${projectPart}_${clipPart}_${resolution}`;
      break;
  }
  if (!base) base = "export";
  let name = `${base}.${ext}`;
  let n = 2;
  while (taken.has(name)) {
    name = `${base}-${n}.${ext}`;
    n += 1;
  }
  taken.add(name);
  return name;
}

// ---- job creation -------------------------------------------------------------------

export interface CreatedExport {
  job: RenderJobRow;
  deduplicated: boolean;
  preflight: PreflightCheck[] | null;
}

function insertRenderJobRow(args: {
  userId: string;
  projectId: string;
  docId: string;
  settingsJson: string;
  status: string;
  stage: string;
  error: string | null;
  outputName: string | null;
}): RenderJobRow {
  const now = nowIso();
  const job: RenderJobRow = {
    id: newId(),
    version_id: args.docId,
    project_id: args.projectId,
    user_id: args.userId,
    status: args.status,
    stage: args.stage,
    settings_json: args.settingsJson,
    output_path: null,
    error: args.error,
    cancel_requested: 0,
    created_at: now,
    updated_at: now,
    started_at: null,
    finished_at: args.status === "FAILED" ? now : null,
    kind: "EXPORT",
    priority: 0,
    retry_count: 0,
    progress_json: null,
    output_name: args.outputName,
  };
  getDb()
    .prepare(
      `INSERT INTO render_jobs (id, version_id, project_id, user_id, status, stage, settings_json, output_path, error, cancel_requested, created_at, updated_at, started_at, finished_at, kind, priority, retry_count, progress_json, output_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, ?, ?, NULL, ?, 'EXPORT', 0, 0, NULL, ?)`,
    )
    .run(
      job.id, job.version_id, job.project_id, job.user_id, job.status, job.stage,
      job.settings_json, job.error, now, now, job.finished_at, args.outputName,
    );
  return job;
}

function recordFailedExport(args: {
  job: RenderJobRow;
  userId: string;
  projectId: string;
  targetLabel: string;
  targetKind: string;
  targetId: string | null;
  outputName: string;
  format: string;
  reason: string;
}): void {
  const db = getDb();
  try {
    db.prepare(
      "INSERT INTO render_error_log (id, job_id, user_id, stage, message, created_at) VALUES (?, ?, ?, 'VALIDATING', ?, ?)",
    ).run(newId(), args.job.id, args.userId, args.reason.slice(0, 1000), nowIso());
    db.prepare(
      `INSERT OR REPLACE INTO export_outputs (id, job_id, user_id, project_id, target_label, filename, storage_key, format, video_codec, audio_codec, width, height, duration, file_size, status, failure_reason, created_at, target_kind, target_id)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, NULL, NULL, NULL, 'FAILED', ?, ?, ?, ?)`,
    ).run(
      newId(), args.job.id, args.userId, args.projectId, args.targetLabel,
      args.outputName, args.format, args.reason.slice(0, 1000), nowIso(),
      args.targetKind, args.targetId,
    );
  } catch {
    /* best-effort diagnostics */
  }
}

/** Create one export job for one target (used by single + batch). */
export async function createExportJob(args: {
  userId: string;
  project: ProjectRow;
  doc: ClipVersionRow;
  target: ExportTargetRef;
  settings: ExportSettingsInput;
  takenNames: Set<string>;
}): Promise<{ ok: true; created: CreatedExport } | { ok: false; error: string }> {
  const { userId, project, doc, target, settings, takenNames } = args;
  const resolved = resolveTargetState(userId, project, doc, target);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const preparedResult = prepareExport(userId, doc, resolved.resolved.state, settings);
  if (!preparedResult.ok) {
    // A hard preparation failure (no reframe config, enhancement
    // off) is a preflight failure: a FAILED job with diagnostics.
    const outputName = buildOutputName({
      project,
      targetLabel: resolved.resolved.label,
      settings,
      canvas: resolveExportCanvas(resolved.resolved.state.canvas, settings),
      taken: takenNames,
    });
    const storedSettings: ExportSettings = { ...settings, outputName, targetLabel: resolved.resolved.label };
    const job = insertRenderJobRow({
      userId, projectId: project.id, docId: doc.id,
      settingsJson: JSON.stringify({
        state: deriveExportState(resolved.resolved.state, settings),
        timelineDuration: 0,
        stateHash: "",
        export: storedSettings,
        target: { kind: target.kind, id: target.id ?? null },
      }),
      status: "FAILED",
      stage: "VALIDATING",
      error: preparedResult.error,
      outputName,
    });
    const check: PreflightCheck = { id: "prepare", ok: false, level: "error", detail: preparedResult.error };
    getDb()
      .prepare(
        "INSERT INTO render_validation_results (id, job_id, user_id, phase, ok, checks_json, created_at) VALUES (?, ?, ?, 'PREFLIGHT', 0, ?, ?)",
      )
      .run(newId(), job.id, userId, JSON.stringify([check]), nowIso());
    recordFailedExport({
      job, userId, projectId: project.id, targetLabel: resolved.resolved.label,
      targetKind: target.kind, targetId: target.id ?? null,
      outputName, format: exportExtension(settings), reason: preparedResult.error,
    });
    return { ok: true, created: { job, deduplicated: false, preflight: [check] } };
  }
  const prepared = preparedResult.prepared;
  const preflight = await runPreflight({ userId, project, state: prepared.state, settings, prepared });
  const outputName = buildOutputName({
    project,
    targetLabel: resolved.resolved.label,
    settings,
    canvas: prepared.state.canvas,
    taken: takenNames,
  });
  const storedSettings: ExportSettings = { ...settings, outputName, targetLabel: resolved.resolved.label };
  const settingsJson = (stateHash: string) =>
    JSON.stringify({
      state: prepared.state,
      timelineDuration: prepared.timelineDuration,
      stateHash,
      enhance: prepared.enhance,
      reframe: prepared.reframe,
      export: storedSettings,
      target: { kind: target.kind, id: target.id ?? null },
    });
  const stateHash = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        state: prepared.state,
        export: settings,
        enhance: prepared.enhance,
        reframe: prepared.reframe,
      }),
    )
    .digest("hex");

  const failures = preflight.filter((c) => !c.ok && c.level === "error");
  const db = getDb();
  if (failures.length > 0) {
    const reason = `Preflight failed: ${failures.map((f) => f.detail).join("; ")}`;
    const job = insertRenderJobRow({
      userId, projectId: project.id, docId: doc.id,
      settingsJson: settingsJson(stateHash),
      status: "FAILED",
      stage: "VALIDATING",
      error: reason,
      outputName,
    });
    db.prepare(
      "INSERT INTO render_validation_results (id, job_id, user_id, phase, ok, checks_json, created_at) VALUES (?, ?, ?, 'PREFLIGHT', 0, ?, ?)",
    ).run(newId(), job.id, userId, JSON.stringify(preflight), nowIso());
    recordFailedExport({
      job, userId, projectId: project.id, targetLabel: resolved.resolved.label,
      targetKind: target.kind, targetId: target.id ?? null,
      outputName, format: exportExtension(settings), reason,
    });
    return { ok: true, created: { job, deduplicated: false, preflight } };
  }

  // Dedupe: an identical export already queued/running is returned,
  // never duplicated (spec §16/§20 duplicate-job protection).
  const active = db
    .prepare(
      "SELECT * FROM render_jobs WHERE version_id = ? AND user_id = ? AND status IN ('QUEUED', 'RUNNING', 'PAUSED') ORDER BY created_at DESC LIMIT 25",
    )
    .all(doc.id, userId) as unknown as RenderJobRow[];
  for (const j of active) {
    try {
      const parsed = JSON.parse(j.settings_json) as { stateHash?: string };
      if (parsed.stateHash === stateHash) {
        return { ok: true, created: { job: j, deduplicated: true, preflight } };
      }
    } catch {
      /* ignore malformed rows */
    }
  }
  const job = insertRenderJobRow({
    userId, projectId: project.id, docId: doc.id,
    settingsJson: settingsJson(stateHash),
    status: "QUEUED",
    stage: "QUEUED",
    error: null,
    outputName,
  });
  db.prepare(
    "INSERT INTO render_validation_results (id, job_id, user_id, phase, ok, checks_json, created_at) VALUES (?, ?, ?, 'PREFLIGHT', 1, ?, ?)",
  ).run(newId(), job.id, userId, JSON.stringify(preflight), nowIso());
  return { ok: true, created: { job, deduplicated: false, preflight } };
}

// ---- serializers ---------------------------------------------------------------------

function outputForJob(jobId: string): ExportOutputRow | undefined {
  return getDb().prepare("SELECT * FROM export_outputs WHERE job_id = ?").get(jobId) as
    | ExportOutputRow
    | undefined;
}

/** Owner-checked poster-frame URL for a job, present only when the
 *  completion-time extraction actually produced the file. */
function thumbnailUrlFor(userId: string, jobId: string): string | null {
  return fs.existsSync(mediaPath(`${userId}/renders/${jobId}.jpg`))
    ? `/api/export-jobs/${jobId}/thumbnail`
    : null;
}

function publicExportOutput(row: ExportOutputRow) {
  return {
    id: row.id,
    jobId: row.job_id,
    projectId: row.project_id,
    targetLabel: row.target_label,
    targetKind: row.target_kind ?? null,
    targetId: row.target_id ?? null,
    filename: row.filename,
    format: row.format,
    videoCodec: row.video_codec,
    audioCodec: row.audio_codec,
    width: row.width,
    height: row.height,
    duration: row.duration,
    fileSize: row.file_size,
    status: row.status,
    failureReason: row.failure_reason,
    thumbnailUrl: row.status === "COMPLETED" ? thumbnailUrlFor(row.user_id, row.job_id) : null,
    createdAt: row.created_at,
  };
}

/** Queue positions for a user's QUEUED export jobs (1-based, in
 *  claim order: priority DESC, then created order). PAUSED jobs are
 *  held outside the queue and get position null. */
function queuePositions(userId: string): Map<string, number> {
  const rows = getDb()
    .prepare(
      "SELECT id FROM render_jobs WHERE user_id = ? AND kind = 'EXPORT' AND status = 'QUEUED' ORDER BY priority DESC, created_at ASC, rowid ASC",
    )
    .all(userId) as unknown as Array<{ id: string }>;
  const map = new Map<string, number>();
  rows.forEach((r, i) => map.set(r.id, i + 1));
  return map;
}

function publicExportJob(job: RenderJobRow, positions: Map<string, number>) {
  const base = publicRenderJob(job);
  const output = outputForJob(job.id);
  const settings = base.settings as { export?: ExportSettings | null } | null;
  return {
    ...base,
    held: job.status === "PAUSED",
    queuePosition: job.status === "QUEUED" ? positions.get(job.id) ?? null : null,
    exportSettings: settings?.export ?? null,
    output: output
      ? {
          id: output.id,
          filename: output.filename,
          format: output.format,
          width: output.width,
          height: output.height,
          duration: output.duration,
          fileSize: output.file_size,
          status: output.status,
          failureReason: output.failure_reason,
          thumbnailUrl: output.status === "COMPLETED" ? thumbnailUrlFor(output.user_id, output.job_id) : null,
        }
      : null,
  };
}

function ownedExportJob(userId: string, jobId: string): RenderJobRow | null {
  const row = getDb()
    .prepare("SELECT * FROM render_jobs WHERE id = ? AND user_id = ? AND kind = 'EXPORT'")
    .get(jobId, userId) as RenderJobRow | undefined;
  return row ?? null;
}

function takenNames(userId: string): Set<string> {
  const names = new Set<string>();
  const outs = getDb()
    .prepare("SELECT filename FROM export_outputs WHERE user_id = ?")
    .all(userId) as unknown as Array<{ filename: string }>;
  for (const o of outs) names.add(o.filename);
  const jobs = getDb()
    .prepare("SELECT output_name FROM render_jobs WHERE user_id = ? AND output_name IS NOT NULL")
    .all(userId) as unknown as Array<{ output_name: string }>;
  for (const j of jobs) names.add(j.output_name);
  return names;
}

/** Delete a job's stored deliverables (only ever inside the user's
 *  own renders directory) — sources and projects are never touched. */
function deleteJobFiles(userId: string, job: RenderJobRow): void {
  const rendersDir = path.resolve(mediaPath(`${userId}/renders`));
  const rels: string[] = [];
  if (job.output_path) rels.push(job.output_path);
  rels.push(`${userId}/renders/${job.id}.zip`);
  rels.push(`${userId}/renders/${job.id}.srt`);
  rels.push(`${userId}/renders/${job.id}.vtt`);
  rels.push(`${userId}/renders/${job.id}.jpg`);
  let ext = "mp4";
  try {
    const s = JSON.parse(job.settings_json) as { export?: ExportSettings };
    if (s.export) ext = exportExtension(s.export);
  } catch {
    /* default */
  }
  rels.push(`${userId}/renders/failed/${job.id}.${ext}`);
  for (const rel of rels) {
    const abs = path.resolve(mediaPath(rel));
    if (abs.startsWith(rendersDir)) {
      try {
        fs.rmSync(abs, { force: true });
      } catch {
        /* best effort */
      }
    }
  }
}

function presetSettingsFor(presetId: string, userId: string): ExportSettingsInput | null {
  const builtin = BUILTIN_EXPORT_PRESETS.find((p) => p.id === presetId);
  if (builtin) return { ...DEFAULT_EXPORT_SETTINGS, ...builtin.settings };
  const row = getDb()
    .prepare("SELECT * FROM export_presets WHERE id = ? AND user_id = ?")
    .get(presetId, userId) as ExportPresetRow | undefined;
  if (!row) return null;
  const parsed = normalizeExportSettings(parseJson(row.settings_json, null));
  return parsed.ok ? parsed.settings : null;
}

function publicPreset(args: { id: string; name: string; description: string | null; builtin: boolean; settings: ExportSettingsInput; createdAt: string | null; updatedAt: string | null }) {
  return args;
}

// ---- routes ---------------------------------------------------------------------------

export function registerExportRoutes(app: express.Express, requireAuth: RequireAuth): void {
  // Runtime capabilities: what THIS FFmpeg build can really encode.
  app.get("/api/exports/capabilities", requireAuth, async (_req, res) => {
    const encoders = await probeEncoders();
    res.json({
      ffmpegVersion: encoders.ffmpegVersion,
      renderConcurrency: renderConcurrency(),
      encoders,
      containers: [
        { id: "mp4", videoCodecs: ["libx264", "libx265", "libvpx-vp9"], audioCodecs: ["aac", "libopus"], supported: encoders.libx264 || encoders.libx265 || encoders["libvpx-vp9"] },
        { id: "webm", videoCodecs: ["libvpx-vp9"], audioCodecs: ["libopus"], supported: encoders["libvpx-vp9"] && encoders.libopus },
      ],
      audioOnlyCodecs: ["aac", "libopus", "libmp3lame"].filter(
        (c) => encoders[c as keyof EncoderSupport] === true,
      ),
      qualityPresets: [
        { id: "low", description: "Smaller files, visibly softer — good for quick previews and messaging." },
        { id: "standard", description: "Balanced quality and file size — the everyday default." },
        { id: "high", description: "Sharper detail for publishing; somewhat larger files." },
        { id: "maximum", description: "Best quality this encoder offers here; largest files and slowest encodes. It cannot add detail the source does not have." },
      ],
    });
  });

  // Export targets for a project (document, saved versions, clips).
  app.get("/api/projects/:projectId/export-targets", requireAuth, (req: AuthedRequest, res) => {
    const project = ownedProject(req.user!.id, String(req.params.projectId));
    if (!project) return fail(res, 404, "NOT_FOUND", "Project not found.");
    const { doc } = getOrCreateDoc(req.user!.id, project, null);
    const state = readState(doc);
    const versions = getDb()
      .prepare("SELECT * FROM project_versions WHERE version_id = ? ORDER BY created_at DESC")
      .all(doc.id) as unknown as ProjectVersionRow[];
    const candidates = getDb()
      .prepare(
        "SELECT * FROM candidate_clips WHERE project_id = ? AND user_id = ? AND status = 'SELECTED' ORDER BY score DESC, created_at ASC",
      )
      .all(project.id, req.user!.id) as unknown as CandidateClipRow[];
    res.json({
      document: {
        kind: "document",
        docId: doc.id,
        label: `${project.name} — Edited project`,
        duration: timelineDurationOf(state),
        canvas: state.canvas,
      },
      versions: versions.map((v) => ({ kind: "version", id: v.id, label: v.name, createdAt: v.created_at })),
      candidates: candidates.map((c) => ({
        kind: "candidate",
        id: c.id,
        label: c.title || "Generated clip",
        duration: c.duration,
        score: c.score,
        startSec: c.start_sec,
        endSec: c.end_sec,
      })),
    });
  });

  // Preflight + expected-output summary for one target (no job created).
  app.post("/api/projects/:projectId/exports/preflight", requireAuth, async (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const project = ownedProject(userId, String(req.params.projectId));
    if (!project) return fail(res, 404, "NOT_FOUND", "Project not found.");
    const body = (req.body ?? {}) as { target?: ExportTargetRef; settings?: unknown; presetId?: string };
    const base = body.presetId ? presetSettingsFor(body.presetId, userId) : null;
    if (body.presetId && !base) return fail(res, 404, "NOT_FOUND", "Export preset not found.");
    const normalized = normalizeExportSettings(base ? { ...base, ...((body.settings as object) ?? {}) } : body.settings);
    if (!normalized.ok) return fail(res, 400, "INVALID_SETTINGS", normalized.error);
    const settings = normalized.settings;
    const target: ExportTargetRef =
      body.target && (body.target.kind === "document" || body.target.kind === "version" || body.target.kind === "candidate")
        ? body.target
        : { kind: "document" };
    const { doc } = getOrCreateDoc(userId, project, null);
    const resolved = resolveTargetState(userId, project, doc, target);
    if (!resolved.ok) return fail(res, 400, "INVALID_TARGET", resolved.error);
    const preparedResult = prepareExport(userId, doc, resolved.resolved.state, settings);
    if (!preparedResult.ok) {
      return res.json({
        ok: false,
        checks: [{ id: "prepare", ok: false, level: "error", detail: preparedResult.error }],
        summary: null,
      });
    }
    const prepared = preparedResult.prepared;
    const checks = await runPreflight({ userId, project, state: prepared.state, settings, prepared });
    const taken = takenNames(userId);
    const outputName = buildOutputName({
      project, targetLabel: resolved.resolved.label, settings, canvas: prepared.state.canvas, taken,
    });
    const duration = prepared.timelineDuration;
    const estimatedSizeBytes =
      settings.qualityMode === "bitrate"
        ? Math.ceil(
            (((settings.videoBitrateKbps ?? 0) + (settings.audioOnly ? 0 : settings.audioBitrateKbps)) * 1000) / 8 * duration +
              (settings.audioOnly ? (settings.audioBitrateKbps * 1000) / 8 * duration : 0),
          )
        : null;
    res.json({
      ok: checks.every((c) => c.ok || c.level === "warning"),
      checks,
      summary: {
        outputName,
        targetLabel: resolved.resolved.label,
        durationSec: Math.round(duration * 10) / 10,
        width: prepared.state.canvas.width,
        height: prepared.state.canvas.height,
        aspect: prepared.state.canvas.aspect,
        fps: settings.fps,
        container: settings.audioOnly ? exportExtension(settings) : settings.container,
        videoCodec: settings.audioOnly ? null : settings.videoCodec,
        audioCodec: settings.audioCodec,
        audioOnly: settings.audioOnly,
        captionMode: settings.captionMode,
        captionFormat: settings.captionFormat,
        captionCount: prepared.state.captions.filter((c) => c.text.trim().length > 0).length,
        includeEnhancement: settings.includeEnhancement,
        includeReframe: settings.includeReframe,
        qualityMode: settings.qualityMode,
        qualityPreset: settings.qualityPreset,
        estimatedSizeBytes,
        estimateNote:
          estimatedSizeBytes !== null
            ? "Estimate from the chosen bitrates — the real size depends on the picture content."
            : null,
      },
    });
  });

  // Create export jobs: single target or a batch (each target keeps
  // its own saved state; per-target overrides are supported).
  app.post("/api/projects/:projectId/exports", requireAuth, async (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const project = ownedProject(userId, String(req.params.projectId));
    if (!project) return fail(res, 404, "NOT_FOUND", "Project not found.");
    const body = (req.body ?? {}) as {
      targets?: ExportTargetRef[];
      settings?: unknown;
      presetId?: string;
      overrides?: Record<string, unknown>;
      priority?: unknown;
    };
    const targets = Array.isArray(body.targets) ? body.targets.slice(0, 50) : [];
    if (targets.length === 0) {
      return fail(res, 400, "NO_TARGETS", "Choose at least one clip, version or the edited project to export.");
    }
    const base = body.presetId ? presetSettingsFor(body.presetId, userId) : null;
    if (body.presetId && !base) return fail(res, 404, "NOT_FOUND", "Export preset not found.");
    const baseNormalized = normalizeExportSettings(
      base ? { ...base, ...((body.settings as object) ?? {}) } : body.settings,
    );
    if (!baseNormalized.ok) return fail(res, 400, "INVALID_SETTINGS", baseNormalized.error);
    const { doc } = getOrCreateDoc(userId, project, null);
    const taken = takenNames(userId);
    const jobs: Array<Record<string, unknown>> = [];
    const errors: Array<{ target: ExportTargetRef; error: string }> = [];
    for (const target of targets) {
      if (!target || (target.kind !== "document" && target.kind !== "version" && target.kind !== "candidate")) {
        errors.push({ target, error: "Unknown export target kind." });
        continue;
      }
      const key = `${target.kind}:${target.id ?? "document"}`;
      const override = body.overrides?.[key];
      const perTarget = normalizeExportSettings(
        override ? { ...baseNormalized.settings, ...(override as object) } : baseNormalized.settings,
      );
      if (!perTarget.ok) {
        errors.push({ target, error: perTarget.error });
        continue;
      }
      const created = await createExportJob({ userId, project, doc, target, settings: perTarget.settings, takenNames: taken });
      if (!created.ok) {
        errors.push({ target, error: created.error });
        continue;
      }
      let job = created.created.job;
      if (typeof body.priority === "number" && Number.isInteger(body.priority) && job.status === "QUEUED") {
        getDb()
          .prepare("UPDATE render_jobs SET priority = ? WHERE id = ?")
          .run(Math.max(-100, Math.min(100, body.priority)), job.id);
        job = ownedExportJob(userId, job.id) ?? job;
      }
      jobs.push({
        ...publicExportJob(job, queuePositions(userId)),
        deduplicated: created.created.deduplicated,
        preflight: created.created.preflight,
      });
    }
    if (jobs.length === 0) {
      return fail(res, 400, "EXPORT_FAILED", errors[0]?.error ?? "No export jobs could be created.");
    }
    res.status(201).json({ jobs, errors });
  });

  // The rendering queue (export jobs only).
  app.get("/api/exports/queue", requireAuth, (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const statusParam = String(req.query.status ?? "all").toLowerCase();
    const sort = String(req.query.sort ?? "newest");
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : null;
    const statusMap: Record<string, string | null> = {
      all: null,
      queued: "QUEUED",
      paused: "PAUSED",
      processing: "RUNNING",
      running: "RUNNING",
      completed: "COMPLETED",
      failed: "FAILED",
      cancelled: "CANCELLED",
    };
    const wanted = statusMap[statusParam] ?? null;
    let rows = getDb()
      .prepare("SELECT * FROM render_jobs WHERE user_id = ? AND kind = 'EXPORT'")
      .all(userId) as unknown as RenderJobRow[];
    if (wanted) rows = rows.filter((r) => r.status === wanted);
    if (projectId) rows = rows.filter((r) => r.project_id === projectId);
    const byCreatedDesc = (a: RenderJobRow, b: RenderJobRow) => b.created_at.localeCompare(a.created_at);
    switch (sort) {
      case "oldest":
        rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
        break;
      case "position":
        rows.sort(
          (a, b) =>
            (b.priority ?? 0) - (a.priority ?? 0) || a.created_at.localeCompare(b.created_at),
        );
        break;
      case "project":
        rows.sort((a, b) => a.project_id.localeCompare(b.project_id) || byCreatedDesc(a, b));
        break;
      case "status":
        rows.sort((a, b) => a.status.localeCompare(b.status) || byCreatedDesc(a, b));
        break;
      default:
        rows.sort(byCreatedDesc);
    }
    const positions = queuePositions(userId);
    res.json({ jobs: rows.slice(0, 200).map((j) => publicExportJob(j, positions)) });
  });

  // Job detail: job + validation results + error log.
  app.get("/api/export-jobs/:jobId", requireAuth, (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const job = ownedExportJob(userId, String(req.params.jobId));
    if (!job) return fail(res, 404, "NOT_FOUND", "Export job not found.");
    const validation = getDb()
      .prepare("SELECT * FROM render_validation_results WHERE job_id = ? ORDER BY created_at ASC")
      .all(job.id) as unknown as Array<{ id: string; phase: string; ok: number; checks_json: string; created_at: string }>;
    const errors = getDb()
      .prepare("SELECT * FROM render_error_log WHERE job_id = ? ORDER BY created_at ASC")
      .all(job.id) as unknown as Array<{ id: string; stage: string; message: string; created_at: string }>;
    res.json({
      job: publicExportJob(job, queuePositions(userId)),
      validation: validation.map((v) => ({
        id: v.id,
        phase: v.phase,
        ok: v.ok === 1,
        checks: parseJson(v.checks_json, []),
        createdAt: v.created_at,
      })),
      errors,
    });
  });

  // Cancel (running exports are cancelled, never paused).
  app.post("/api/export-jobs/:jobId/cancel", requireAuth, (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const job = ownedExportJob(userId, String(req.params.jobId));
    if (!job) return fail(res, 404, "NOT_FOUND", "Export job not found.");
    const db = getDb();
    const now = nowIso();
    if (job.status === "PAUSED") {
      db.prepare(
        "UPDATE render_jobs SET status = 'CANCELLED', stage = 'CANCELLED', finished_at = ?, updated_at = ? WHERE id = ?",
      ).run(now, now, job.id);
    } else if (job.status === "QUEUED") {
      db.prepare(
        "UPDATE render_jobs SET status = 'CANCELLED', stage = 'CANCELLED', finished_at = ?, updated_at = ? WHERE id = ? AND status = 'QUEUED'",
      ).run(now, now, job.id);
    } else if (job.status === "RUNNING") {
      db.prepare("UPDATE render_jobs SET cancel_requested = 1, updated_at = ? WHERE id = ?").run(now, job.id);
      killRenderChildren(job.id);
    } else {
      return fail(res, 409, "NOT_CANCELLABLE", `A ${job.status.toLowerCase()} export cannot be cancelled.`);
    }
    res.json({ job: publicExportJob(ownedExportJob(userId, job.id) ?? job, queuePositions(userId)) });
  });

  // Pause = hold a QUEUED job (the worker skips PAUSED jobs). There
  // is deliberately no pause for RUNNING jobs.
  app.post("/api/export-jobs/:jobId/pause", requireAuth, (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const job = ownedExportJob(userId, String(req.params.jobId));
    if (!job) return fail(res, 404, "NOT_FOUND", "Export job not found.");
    if (job.status === "RUNNING") {
      return fail(
        res, 409, "CANNOT_PAUSE_RUNNING",
        "A running render cannot be paused safely — cancel it instead, or let it finish.",
      );
    }
    if (job.status !== "QUEUED") {
      return fail(res, 409, "NOT_PAUSABLE", `A ${job.status.toLowerCase()} export cannot be paused.`);
    }
    getDb().prepare("UPDATE render_jobs SET status = 'PAUSED', updated_at = ? WHERE id = ?").run(nowIso(), job.id);
    res.json({ job: publicExportJob(ownedExportJob(userId, job.id) ?? job, queuePositions(userId)) });
  });

  app.post("/api/export-jobs/:jobId/resume", requireAuth, (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const job = ownedExportJob(userId, String(req.params.jobId));
    if (!job) return fail(res, 404, "NOT_FOUND", "Export job not found.");
    if (job.status !== "PAUSED") return fail(res, 409, "NOT_PAUSED", "Only a paused (held) export can be resumed.");
    getDb().prepare("UPDATE render_jobs SET status = 'QUEUED', updated_at = ? WHERE id = ?").run(nowIso(), job.id);
    res.json({ job: publicExportJob(ownedExportJob(userId, job.id) ?? job, queuePositions(userId)) });
  });

  // Start now: un-hold a paused job, or boost a queued job to the
  // front of the queue. (Queued jobs are auto-claimed by the worker;
  // this is the real, honest "start" that exists.)
  app.post("/api/export-jobs/:jobId/start", requireAuth, (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const job = ownedExportJob(userId, String(req.params.jobId));
    if (!job) return fail(res, 404, "NOT_FOUND", "Export job not found.");
    const db = getDb();
    if (job.status === "PAUSED") {
      // Un-hold AND jump the queue: "Start now" must differ from a
      // plain Resume (which returns the job to its normal position).
      const max = db
        .prepare("SELECT MAX(priority) AS m FROM render_jobs WHERE user_id = ? AND kind = 'EXPORT' AND status = 'QUEUED'")
        .get(userId) as { m: number | null };
      db.prepare("UPDATE render_jobs SET status = 'QUEUED', priority = ?, updated_at = ? WHERE id = ?")
        .run((max.m ?? 0) + 1, nowIso(), job.id);
    } else if (job.status === "QUEUED") {
      const max = db
        .prepare("SELECT MAX(priority) AS m FROM render_jobs WHERE user_id = ? AND kind = 'EXPORT' AND status = 'QUEUED'")
        .get(userId) as { m: number | null };
      db.prepare("UPDATE render_jobs SET priority = ?, updated_at = ? WHERE id = ?")
        .run((max.m ?? 0) + 1, nowIso(), job.id);
    } else {
      return fail(res, 409, "NOT_STARTABLE", `A ${job.status.toLowerCase()} export cannot be started.`);
    }
    res.json({ job: publicExportJob(ownedExportJob(userId, job.id) ?? job, queuePositions(userId)) });
  });

  app.post("/api/export-jobs/:jobId/retry", requireAuth, async (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const job = ownedExportJob(userId, String(req.params.jobId));
    if (!job) return fail(res, 404, "NOT_FOUND", "Export job not found.");
    if (job.status !== "FAILED" && job.status !== "CANCELLED") {
      return fail(res, 409, "NOT_RETRYABLE", `A ${job.status.toLowerCase()} export cannot be retried.`);
    }
    const db = getDb();
    // Retry re-runs the SAME preflight gate as creation (resolve →
    // prepareExport → runPreflight) against the CURRENT project
    // state, so a job that failed at VALIDATING — a caption-timing
    // violation, an unreadable B-roll file — can only re-enter the
    // queue once the problem is actually fixed. (The render worker's
    // own re-check only tests file existence; without this gate a
    // retry sailed straight into encoding with the error unchanged.)
    const stored = parseJson<{
      export?: ExportSettings;
      target?: { kind?: string; id?: string | null };
    } | null>(job.settings_json, null);
    const storedExport = stored?.export;
    const failRetry = (checks: PreflightCheck[], reason: string) => {
      const now = nowIso();
      db.prepare(
        `UPDATE render_jobs SET status = 'FAILED', stage = 'VALIDATING', error = ?, cancel_requested = 0,
         retry_count = retry_count + 1, started_at = NULL, finished_at = ?, progress_json = NULL, updated_at = ?
         WHERE id = ?`,
      ).run(reason, now, now, job.id);
      db.prepare(
        "INSERT INTO render_validation_results (id, job_id, user_id, phase, ok, checks_json, created_at) VALUES (?, ?, ?, 'PREFLIGHT', 0, ?, ?)",
      ).run(newId(), job.id, userId, JSON.stringify(checks), now);
      const outName = job.output_name ?? storedExport?.outputName;
      if (storedExport && outName) {
        recordFailedExport({
          job, userId, projectId: job.project_id,
          targetLabel: storedExport.targetLabel ?? outName,
          targetKind:
            stored.target?.kind === "version" || stored.target?.kind === "candidate"
              ? stored.target.kind
              : "document",
          targetId: stored.target?.id ?? null,
          outputName: outName,
          format: exportExtension(storedExport),
          reason,
        });
      }
      return res.json({
        job: publicExportJob(ownedExportJob(userId, job.id) ?? job, queuePositions(userId)),
        preflight: checks,
      });
    };
    const prepareCheck = (detail: string): PreflightCheck[] => [
      { id: "prepare", ok: false, level: "error", detail },
    ];
    const project = ownedProject(userId, job.project_id);
    if (!project) {
      const detail = "The project this export belongs to no longer exists, so it cannot be re-validated.";
      return failRetry(prepareCheck(detail), detail);
    }
    if (!storedExport) {
      const detail = "The export's stored settings could not be read, so it cannot be re-validated.";
      return failRetry(prepareCheck(detail), detail);
    }
    const settingsInput: Record<string, unknown> = {
      ...(storedExport as unknown as Record<string, unknown>),
    };
    delete settingsInput.outputName;
    delete settingsInput.targetLabel;
    const normalized = normalizeExportSettings(settingsInput);
    if (!normalized.ok) {
      return failRetry(prepareCheck(normalized.error), normalized.error);
    }
    const settings = normalized.settings;
    const target: ExportTargetRef =
      stored.target?.kind === "version" || stored.target?.kind === "candidate"
        ? { kind: stored.target.kind, id: stored.target.id ?? undefined }
        : { kind: "document" };
    const { doc } = getOrCreateDoc(userId, project, null);
    const resolved = resolveTargetState(userId, project, doc, target);
    if (!resolved.ok) {
      return failRetry(prepareCheck(resolved.error), resolved.error);
    }
    const preparedResult = prepareExport(userId, doc, resolved.resolved.state, settings);
    if (!preparedResult.ok) {
      return failRetry(prepareCheck(preparedResult.error), preparedResult.error);
    }
    const prepared = preparedResult.prepared;
    const preflight = await runPreflight({ userId, project, state: prepared.state, settings, prepared });
    const failures = preflight.filter((c) => !c.ok && c.level === "error");
    if (failures.length > 0) {
      const reason = `Preflight failed: ${failures.map((f) => f.detail).join("; ")}`;
      return failRetry(preflight, reason);
    }
    // Preflight is clean. Refresh the stored snapshot to the state
    // that just passed — the render worker composes from
    // settings_json, so queueing the stale snapshot would render
    // the very state that failed — then persist the passing checks
    // (as creation does) and re-queue.
    const storedSettings: ExportSettings = {
      ...settings,
      outputName: job.output_name ?? storedExport.outputName,
      targetLabel: resolved.resolved.label,
    };
    const stateHash = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          state: prepared.state,
          export: settings,
          enhance: prepared.enhance,
          reframe: prepared.reframe,
        }),
      )
      .digest("hex");
    const settingsJson = JSON.stringify({
      state: prepared.state,
      timelineDuration: prepared.timelineDuration,
      stateHash,
      enhance: prepared.enhance,
      reframe: prepared.reframe,
      export: storedSettings,
      target: { kind: target.kind, id: target.id ?? null },
    });
    const now = nowIso();
    db.prepare(
      `UPDATE render_jobs SET status = 'QUEUED', stage = 'QUEUED', error = NULL, cancel_requested = 0,
       retry_count = retry_count + 1, started_at = NULL, finished_at = NULL, progress_json = NULL, settings_json = ?, updated_at = ?
       WHERE id = ?`,
    ).run(settingsJson, now, job.id);
    db.prepare(
      "INSERT INTO render_validation_results (id, job_id, user_id, phase, ok, checks_json, created_at) VALUES (?, ?, ?, 'PREFLIGHT', 1, ?, ?)",
    ).run(newId(), job.id, userId, JSON.stringify(preflight), now);
    res.json({
      job: publicExportJob(ownedExportJob(userId, job.id) ?? job, queuePositions(userId)),
      preflight,
    });
  });

  app.patch("/api/export-jobs/:jobId/priority", requireAuth, (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const job = ownedExportJob(userId, String(req.params.jobId));
    if (!job) return fail(res, 404, "NOT_FOUND", "Export job not found.");
    if (job.status !== "QUEUED" && job.status !== "PAUSED") {
      return fail(res, 409, "NOT_REORDERABLE", "Priority can only change while an export is queued or paused.");
    }
    const priority = (req.body as { priority?: unknown })?.priority;
    if (typeof priority !== "number" || !Number.isInteger(priority)) {
      return fail(res, 400, "INVALID_PRIORITY", "Priority must be an integer.");
    }
    getDb()
      .prepare("UPDATE render_jobs SET priority = ?, updated_at = ? WHERE id = ?")
      .run(Math.max(-100, Math.min(100, priority)), nowIso(), job.id);
    res.json({ job: publicExportJob(ownedExportJob(userId, job.id) ?? job, queuePositions(userId)) });
  });

  // Remove a job (and, for finished jobs, its deliverables).
  // Destructive: requires ?confirm=true (or { confirm: true } in
  // the body) — without it nothing is touched (409
  // CONFIRMATION_REQUIRED). Order: ownership 404 → JOB_RUNNING →
  // confirmation → delete.
  app.delete("/api/export-jobs/:jobId", requireAuth, (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const job = ownedExportJob(userId, String(req.params.jobId));
    if (!job) return fail(res, 404, "NOT_FOUND", "Export job not found.");
    if (job.status === "RUNNING") {
      return fail(res, 409, "JOB_RUNNING", "Cancel the running export before removing it.");
    }
    if (!deleteConfirmed(req)) {
      return fail(
        res,
        409,
        "CONFIRMATION_REQUIRED",
        `Deleting export job ${job.id}${job.output_name ? ` ("${job.output_name}")` : ""} permanently removes the job and its stored output files. Repeat the request with ?confirm=true to proceed.`,
      );
    }
    deleteJobFiles(userId, job);
    getDb().prepare("DELETE FROM render_jobs WHERE id = ?").run(job.id);
    res.status(204).end();
  });

  // Owner-checked download of a QC-passed deliverable. file=video
  // (default; the ZIP when the export bundled subtitles), srt, vtt
  // or zip. A missing stored file is a 410, never a broken stream.
  app.get("/api/export-jobs/:jobId/download", requireAuth, (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const job = ownedExportJob(userId, String(req.params.jobId));
    if (!job) return fail(res, 404, "NOT_FOUND", "Export job not found.");
    if (job.status !== "COMPLETED") {
      return fail(res, 409, "NOT_READY", "Only a completed, quality-checked export can be downloaded.");
    }
    const output = outputForJob(job.id);
    const baseName = (job.output_name ?? output?.filename ?? `export-${job.id}`).replace(/\.[A-Za-z0-9]+$/, "");
    const which = typeof req.query.file === "string" ? req.query.file : "video";
    let rel: string | null = null;
    let downloadName = job.output_name ?? `export-${job.id}`;
    if (which === "srt") {
      rel = `${userId}/renders/${job.id}.srt`;
      downloadName = `${baseName}.srt`;
    } else if (which === "vtt") {
      rel = `${userId}/renders/${job.id}.vtt`;
      downloadName = `${baseName}.vtt`;
    } else if (which === "zip") {
      rel = `${userId}/renders/${job.id}.zip`;
      downloadName = `${baseName}.zip`;
    } else {
      rel = output?.storage_key ?? job.output_path;
      if (rel && rel.endsWith(".zip")) downloadName = `${baseName}.zip`;
    }
    if (!rel) return fail(res, 410, "OUTPUT_MISSING", "This export's file is no longer stored.");
    const abs = mediaPath(rel);
    if (!fs.existsSync(abs)) {
      return fail(res, 410, "OUTPUT_MISSING", "This export's file is no longer stored. Re-export to recreate it.");
    }
    // ?inline=1 serves the same owner-checked file with an inline
    // disposition so the Export Studio's in-app viewer can play it;
    // the default stays an attachment download. Same auth, same file.
    if (req.query.inline === "1") {
      res.setHeader("Content-Disposition", `inline; filename="${downloadName}"`);
      res.sendFile(abs);
      return;
    }
    res.download(abs, downloadName);
  });

  // Owner-checked poster frame for a completed export (extracted at
  // completion time; absent — 404 — when extraction was not possible,
  // e.g. audio-only exports).
  app.get("/api/export-jobs/:jobId/thumbnail", requireAuth, (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const job = ownedExportJob(userId, String(req.params.jobId));
    if (!job) return fail(res, 404, "NOT_FOUND", "Export job not found.");
    const abs = mediaPath(`${userId}/renders/${job.id}.jpg`);
    if (!fs.existsSync(abs)) {
      return fail(res, 404, "NOT_FOUND", "This export has no thumbnail.");
    }
    res.sendFile(abs);
  });

  // Export history (spec §15).
  app.get("/api/exports/history", requireAuth, (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const rows = getDb()
      .prepare(
        `SELECT o.*, p.name AS project_name FROM export_outputs o
         LEFT JOIN projects p ON p.id = o.project_id
         WHERE o.user_id = ? ORDER BY o.created_at DESC LIMIT 200`,
      )
      .all(userId) as unknown as Array<ExportOutputRow & { project_name: string | null }>;
    res.json({
      outputs: rows.map((r) => ({ ...publicExportOutput(r), projectName: r.project_name })),
    });
  });

  // Destructive: same confirmation contract as the job delete —
  // ?confirm=true (or { confirm: true } in the body) is required,
  // checked BEFORE any file or row is touched and AFTER the
  // JOB_RUNNING guard. Deleting a history entry removes only the
  // export and its deliverables; the source media and the editing
  // project are never touched.
  app.delete("/api/exports/history/:outputId", requireAuth, (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const row = getDb()
      .prepare("SELECT * FROM export_outputs WHERE id = ? AND user_id = ?")
      .get(String(req.params.outputId), userId) as ExportOutputRow | undefined;
    if (!row) return fail(res, 404, "NOT_FOUND", "Export history entry not found.");
    const job = ownedExportJob(userId, row.job_id);
    if (job && job.status === "RUNNING") {
      return fail(res, 409, "JOB_RUNNING", "Cancel the running export before deleting it.");
    }
    if (!deleteConfirmed(req)) {
      return fail(
        res,
        409,
        "CONFIRMATION_REQUIRED",
        `Deleting the export "${row.filename}" (history entry ${row.id}) permanently removes the exported file and its history record; the source media and project are not affected. Repeat the request with ?confirm=true to proceed.`,
      );
    }
    if (job) {
      deleteJobFiles(userId, job);
      getDb().prepare("DELETE FROM render_jobs WHERE id = ?").run(job.id);
    } else {
      getDb().prepare("DELETE FROM export_outputs WHERE id = ?").run(row.id);
    }
    res.status(204).end();
  });

  // Batch ZIP bundle as its own background job (spec §19). Accepts
  // job ids, or history output ids (the History tab's selection) —
  // outputs map 1:1 to jobs and are resolved to job ids up front.
  app.post("/api/exports/bundles", requireAuth, (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const body = (req.body ?? {}) as { jobIds?: unknown; outputIds?: unknown };
    let jobIds: unknown[] = Array.isArray(body.jobIds) ? body.jobIds : [];
    const problems: string[] = [];
    if (jobIds.length === 0 && Array.isArray(body.outputIds)) {
      for (const oid of body.outputIds) {
        const row =
          typeof oid === "string"
            ? (getDb()
                .prepare("SELECT * FROM export_outputs WHERE id = ? AND user_id = ?")
                .get(oid, userId) as ExportOutputRow | undefined)
            : undefined;
        if (!row) problems.push(`output ${String(oid)} not found`);
        else if (row.status !== "COMPLETED") problems.push(`"${row.filename}" is not completed`);
        else jobIds.push(row.job_id);
      }
    }
    if (jobIds.length === 0 || jobIds.length > 50) {
      if (problems.length > 0) {
        return fail(res, 400, "INVALID_BUNDLE", `Cannot bundle: ${problems.join("; ")}.`);
      }
      return fail(res, 400, "INVALID_BUNDLE", "Choose between 1 and 50 completed exports to bundle.");
    }
    for (const id of jobIds) {
      const job = typeof id === "string" ? ownedExportJob(userId, id) : null;
      if (!job) problems.push(`job ${String(id)} not found`);
      else if (job.status !== "COMPLETED") problems.push(`"${job.output_name ?? job.id}" is not completed`);
      else {
        const output = outputForJob(job.id);
        const rel = output?.storage_key ?? job.output_path;
        if (!rel || !fs.existsSync(mediaPath(rel))) problems.push(`"${job.output_name ?? job.id}" has no stored file`);
      }
    }
    if (problems.length > 0) {
      return fail(res, 400, "INVALID_BUNDLE", `Cannot bundle: ${problems.join("; ")}.`);
    }
    const now = nowIso();
    const bundle: ExportBundleRow = {
      id: newId(),
      user_id: userId,
      status: "QUEUED",
      stage: "QUEUED",
      job_ids_json: JSON.stringify(jobIds),
      output_path: null,
      error: null,
      created_at: now,
      updated_at: now,
      finished_at: null,
    };
    getDb()
      .prepare(
        `INSERT INTO export_bundles (id, user_id, status, stage, job_ids_json, output_path, error, created_at, updated_at, finished_at)
         VALUES (?, ?, 'QUEUED', 'QUEUED', ?, NULL, NULL, ?, ?, NULL)`,
      )
      .run(bundle.id, userId, bundle.job_ids_json, now, now);
    res.status(201).json({ bundle: publicBundle(bundle) });
  });

  app.get("/api/export-bundles/:bundleId", requireAuth, (req: AuthedRequest, res) => {
    const bundle = getDb()
      .prepare("SELECT * FROM export_bundles WHERE id = ? AND user_id = ?")
      .get(String(req.params.bundleId), req.user!.id) as ExportBundleRow | undefined;
    if (!bundle) return fail(res, 404, "NOT_FOUND", "Bundle not found.");
    res.json({ bundle: publicBundle(bundle) });
  });

  app.get("/api/export-bundles/:bundleId/download", requireAuth, (req: AuthedRequest, res) => {
    const bundle = getDb()
      .prepare("SELECT * FROM export_bundles WHERE id = ? AND user_id = ?")
      .get(String(req.params.bundleId), req.user!.id) as ExportBundleRow | undefined;
    if (!bundle) return fail(res, 404, "NOT_FOUND", "Bundle not found.");
    if (bundle.status !== "COMPLETED" || !bundle.output_path) {
      return fail(res, 409, "NOT_READY", "This bundle is not ready to download.");
    }
    const abs = mediaPath(bundle.output_path);
    if (!fs.existsSync(abs)) {
      return fail(res, 410, "OUTPUT_MISSING", "This bundle's file is no longer stored.");
    }
    res.download(abs, `clipforge-exports-${bundle.id.slice(0, 8)}.zip`);
  });

  // ---- export presets CRUD -------------------------------------------------
  app.get("/api/export-presets", requireAuth, (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const customs = getDb()
      .prepare("SELECT * FROM export_presets WHERE user_id = ? ORDER BY created_at ASC")
      .all(userId) as unknown as ExportPresetRow[];
    res.json({
      presets: [
        ...BUILTIN_EXPORT_PRESETS.map((p) =>
          publicPreset({
            id: p.id,
            name: p.name,
            description: p.description,
            builtin: true,
            settings: { ...DEFAULT_EXPORT_SETTINGS, ...p.settings },
            createdAt: null,
            updatedAt: null,
          }),
        ),
        ...customs.map((r) =>
          publicPreset({
            id: r.id,
            name: r.name,
            description: null,
            builtin: false,
            settings: (() => {
              const parsed = normalizeExportSettings(parseJson(r.settings_json, null));
              return parsed.ok ? parsed.settings : { ...DEFAULT_EXPORT_SETTINGS };
            })(),
            createdAt: r.created_at,
            updatedAt: r.updated_at,
          }),
        ),
      ],
    });
  });

  app.post("/api/export-presets", requireAuth, (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const body = (req.body ?? {}) as { name?: unknown; settings?: unknown };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 120) return fail(res, 400, "INVALID_NAME", "A preset needs a name (max 120 characters).");
    const normalized = normalizeExportSettings(body.settings);
    if (!normalized.ok) return fail(res, 400, "INVALID_SETTINGS", normalized.error);
    const now = nowIso();
    const row: ExportPresetRow = {
      id: newId(),
      user_id: userId,
      name,
      settings_json: JSON.stringify(normalized.settings),
      created_at: now,
      updated_at: now,
    };
    getDb()
      .prepare("INSERT INTO export_presets (id, user_id, name, settings_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(row.id, userId, name, row.settings_json, now, now);
    res.status(201).json({
      preset: publicPreset({ id: row.id, name, description: null, builtin: false, settings: normalized.settings, createdAt: now, updatedAt: now }),
    });
  });

  app.put("/api/export-presets/:id", requireAuth, (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const id = String(req.params.id);
    if (id.startsWith("builtin:")) return fail(res, 400, "BUILTIN_PRESET", "Built-in presets cannot be edited — duplicate one instead.");
    const row = getDb()
      .prepare("SELECT * FROM export_presets WHERE id = ? AND user_id = ?")
      .get(id, userId) as ExportPresetRow | undefined;
    if (!row) return fail(res, 404, "NOT_FOUND", "Export preset not found.");
    const body = (req.body ?? {}) as { name?: unknown; settings?: unknown };
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 120) : row.name;
    const normalized = normalizeExportSettings(body.settings ?? parseJson(row.settings_json, null));
    if (!normalized.ok) return fail(res, 400, "INVALID_SETTINGS", normalized.error);
    const now = nowIso();
    getDb()
      .prepare("UPDATE export_presets SET name = ?, settings_json = ?, updated_at = ? WHERE id = ?")
      .run(name, JSON.stringify(normalized.settings), now, id);
    res.json({
      preset: publicPreset({ id, name, description: null, builtin: false, settings: normalized.settings, createdAt: row.created_at, updatedAt: now }),
    });
  });

  app.delete("/api/export-presets/:id", requireAuth, (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const id = String(req.params.id);
    if (id.startsWith("builtin:")) return fail(res, 400, "BUILTIN_PRESET", "Built-in presets cannot be deleted.");
    const info = getDb().prepare("DELETE FROM export_presets WHERE id = ? AND user_id = ?").run(id, userId);
    if (Number(info.changes) === 0) return fail(res, 404, "NOT_FOUND", "Export preset not found.");
    res.status(204).end();
  });

  app.post("/api/export-presets/:id/duplicate", requireAuth, (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const id = String(req.params.id);
    const settings = presetSettingsFor(id, userId);
    if (!settings) return fail(res, 404, "NOT_FOUND", "Export preset not found.");
    const builtin = BUILTIN_EXPORT_PRESETS.find((p) => p.id === id);
    const source = builtin
      ? builtin.name
      : (getDb().prepare("SELECT name FROM export_presets WHERE id = ? AND user_id = ?").get(id, userId) as { name: string }).name;
    const now = nowIso();
    const row: ExportPresetRow = {
      id: newId(),
      user_id: userId,
      name: `${source} copy`.slice(0, 120),
      settings_json: JSON.stringify(settings),
      created_at: now,
      updated_at: now,
    };
    getDb()
      .prepare("INSERT INTO export_presets (id, user_id, name, settings_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(row.id, userId, row.name, row.settings_json, now, now);
    res.status(201).json({
      preset: publicPreset({ id: row.id, name: row.name, description: null, builtin: false, settings, createdAt: now, updatedAt: now }),
    });
  });
}

function publicBundle(bundle: ExportBundleRow) {
  return {
    id: bundle.id,
    status: bundle.status,
    stage: bundle.stage,
    jobIds: parseJson<string[]>(bundle.job_ids_json, []),
    error: bundle.error,
    createdAt: bundle.created_at,
    updatedAt: bundle.updated_at,
    finishedAt: bundle.finished_at,
  };
}

// ---- bundle worker ---------------------------------------------------------------------

let bundleRunning = false;
let bundleTimer: NodeJS.Timeout | null = null;

/** Boot recovery + drain loop for ZIP bundle jobs. Render recovery
 *  itself is handled by the editor worker (shared render_jobs). */
export function startExportWorker(): void {
  try {
    getDb()
      .prepare(
        "UPDATE export_bundles SET status = 'FAILED', stage = 'FAILED', error = 'The server restarted while this bundle was being prepared.', finished_at = ?, updated_at = ? WHERE status = 'RUNNING'",
      )
      .run(nowIso(), nowIso());
  } catch {
    /* database not ready — recovery is best-effort at boot */
  }
  if (bundleTimer) return;
  bundleTimer = setInterval(() => {
    void bundleTick();
  }, 500);
}

async function bundleTick(): Promise<void> {
  if (bundleRunning) return;
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM export_bundles WHERE status = 'QUEUED' ORDER BY created_at ASC LIMIT 1")
    .get() as ExportBundleRow | undefined;
  if (!row) return;
  bundleRunning = true;
  const now = nowIso();
  db.prepare("UPDATE export_bundles SET status = 'RUNNING', stage = 'ZIPPING', updated_at = ? WHERE id = ?").run(now, row.id);
  const staging = path.join(config.processingDir, `bundle-${row.id}`);
  try {
    const jobIds = parseJson<string[]>(row.job_ids_json, []);
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    const usedNames = new Set<string>();
    for (const jobId of jobIds) {
      const job = db.prepare("SELECT * FROM render_jobs WHERE id = ?").get(jobId) as RenderJobRow | undefined;
      if (!job || job.status !== "COMPLETED") {
        throw new Error(`Export ${jobId} is no longer completed.`);
      }
      const output = outputForJob(jobId);
      const rel = output?.storage_key ?? job.output_path;
      if (!rel || !fs.existsSync(mediaPath(rel))) {
        throw new Error(`The stored file for "${job.output_name ?? jobId}" is missing.`);
      }
      let name = job.output_name ?? path.basename(rel);
      let n = 2;
      while (usedNames.has(name)) {
        name = name.replace(/(\.[A-Za-z0-9]+)$/, `-${n}$1`);
        n += 1;
      }
      usedNames.add(name);
      fs.copyFileSync(mediaPath(rel), path.join(staging, name));
    }
    const bundleRel = `${row.user_id}/bundles/${row.id}.zip`;
    const bundleAbs = mediaPath(bundleRel);
    fs.mkdirSync(path.dirname(bundleAbs), { recursive: true });
    await new Promise<void>((resolve, reject) => {
      execFile("zip", ["-j", "-q", bundleAbs, ...[...usedNames]], { cwd: staging }, (err) =>
        err ? reject(new Error("zip failed while building the bundle")) : resolve(),
      );
    });
    db.prepare(
      "UPDATE export_bundles SET status = 'COMPLETED', stage = 'COMPLETED', output_path = ?, finished_at = ?, updated_at = ? WHERE id = ?",
    ).run(bundleRel, nowIso(), nowIso(), row.id);
  } catch (err) {
    db.prepare(
      "UPDATE export_bundles SET status = 'FAILED', stage = 'FAILED', error = ?, finished_at = ?, updated_at = ? WHERE id = ?",
    ).run(err instanceof Error ? err.message.slice(0, 500) : "Bundle failed.", nowIso(), nowIso(), row.id);
  } finally {
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    bundleRunning = false;
  }
}
