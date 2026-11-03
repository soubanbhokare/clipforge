// CLIPFORGE API — Phase 5: professional video editor, multi-track
// timeline and FFmpeg rendering.
//
// Model:
//  - One editing document per project (clip_versions) with normalized
//    tracks / items / caption segments / scene overrides.
//  - UNDO STRATEGY (state snapshots): every mutation is recorded as an
//    editing_operations row whose payload stores the FULL document
//    state before and after the operation. undo_cursor on the document
//    points at the last applied operation; undo restores that
//    operation's "before" snapshot, redo restores its "after". A new
//    operation after undo truncates the redo branch, exactly like a
//    text editor. Snapshots make every operation — including version
//    restores — uniformly undoable, at the cost of storing the (small,
//    JSON) timeline state per operation.
//  - Autosave is literal: the client sends each operation as it
//    happens and the server persists it in a transaction before
//    responding, so the save status the UI shows is the real result.
//  - Rendering is a persisted render_jobs row drained by a DB-backed
//    in-process worker (the Phase 4 pattern). Production path: the
//    same rows map to PostgreSQL drained by BullMQ/Redis workers —
//    that queue does NOT run in this environment and is never
//    claimed to. The renderer composes the actual timeline with
//    FFmpeg (trims, speed, transforms, scene overrides, B-roll
//    overlays, music mixing, libass caption burn-in) and only marks a
//    job COMPLETED after FFprobe verifies the output. The original
//    uploads are inputs only — never modified.

import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { config } from "./config.js";
import {
  getDb,
  type CandidateClipRow,
  type CaptionSegmentRow,
  type ClipVersionRow,
  type EditingOperationRow,
  type ProjectMediaRow,
  type ProjectRow,
  type ProjectVersionRow,
  type RenderJobRow,
  type SceneOverrideRow,
  type SourceAssetRow,
  type TimelineItemRow,
  type TimelineTrackRow,
  type TopicSegmentRow,
  type TranscriptRow,
  type TranscriptSegmentRow,
  type UserRow,
} from "./db.js";
import {
  ALLOWED_EXTENSIONS,
  extensionOf,
  mediaPath,
  probeAnyFile,
  type ProbedAnyMetadata,
} from "./media.js";
import {
  captionStyleSchema,
  DEFAULT_CAPTION_STYLE,
  type CaptionStyleConfig,
} from "./captionStyle.js";
import { buildAss, buildSrtText, buildVttText } from "./captions.js";
import { currentWorkspaceId, notify, recordUsage } from "./accountCore.js";
import {
  buildAudioChain,
  buildVideoChain,
  duckingFilter,
  type AudioEnhanceSettings,
  type VideoEnhanceSettings,
} from "./enhance.js";
// Type-only import (erased at runtime): tracking.ts imports values
// from this module, so a value import here would create a cycle.
import type { ReframeRenderPayload } from "./tracking.js";
// Same pattern for Phase 9: export.ts imports values from this
// module; only the settings TYPE crosses back.
import type { ExportSettings } from "./export.js";

// ---- shared types -----------------------------------------------------------

const nowIso = (): string => new Date().toISOString();
const newId = (): string => crypto.randomUUID();
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

interface AuthedRequest extends Request {
  user?: UserRow;
}
type RequireAuth = (req: AuthedRequest, res: Response, next: NextFunction) => void;

export interface TransformState {
  crop: { x: number; y: number; w: number; h: number } | null;
  x: number;
  y: number;
  scale: number;
  zoom: number;
  rotation: number;
  fit: "fit" | "fill";
  /** Phase 8: overlay opacity 0..1 (applied at compose time, where an
   *  alpha channel can be synthesised; main-track items ignore it). */
  opacity: number;
}

export const DEFAULT_TRANSFORM: TransformState = {
  crop: null,
  x: 0,
  y: 0,
  scale: 1,
  zoom: 1,
  rotation: 0,
  fit: "fill",
  opacity: 1,
};

export interface TrackState {
  id: string;
  kind: "main" | "broll" | "caption" | "audio" | "overlay";
  label: string;
  order: number;
  locked: boolean;
  visible: boolean;
  muted: boolean;
  solo: boolean;
}

export interface ItemState {
  id: string;
  trackId: string;
  assetKind: "source" | "candidate" | "media";
  assetId: string;
  start: number;
  duration: number;
  sourceIn: number;
  sourceOut: number;
  transform: TransformState;
  speed: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  layerOrder: number;
}

export interface CaptionWordState {
  start: number;
  end: number;
  word: string;
  /** Whisper per-word probability from the transcript (null when the
   *  provider did not report one — never fabricated). */
  probability?: number | null;
  /** Phase 6: user-marked keyword emphasis for this word. */
  emphasized?: boolean;
}

export interface CaptionState {
  id: string;
  start: number;
  end: number;
  text: string;
  words: CaptionWordState[] | null;
  /** Phase 6: per-segment style override; null = document style. */
  style: CaptionStyleConfig | null;
  /** Phase 6: language of this caption set (its caption track). */
  language: string;
}

export type SceneOverrideFields = Partial<{
  crop: TransformState["crop"];
  x: number;
  y: number;
  scale: number;
  zoom: number;
  rotation: number;
  fit: "fit" | "fill";
}>;

export interface SceneOverrideState {
  id: string;
  topicSegmentId: string | null;
  rangeStart: number;
  rangeEnd: number;
  overrides: SceneOverrideFields;
}

export interface CanvasState {
  aspect: string;
  width: number;
  height: number;
  custom: boolean;
}

export interface DocSettings {
  backgroundFill: "blur" | "solid";
  showCaptions: boolean;
  showGuides: boolean;
  safeZones: boolean;
  /**
   * Centre guide lines in the preview. Optional in storage: when a
   * document has never set it, it defaults to the showGuides value
   * (the historical behaviour — centre lines rode along with the
   * guides toggle). readState/validateState normalise it to a
   * concrete boolean.
   */
  centerGuides?: boolean;
  /** Phase 6: the document's caption style (Caption Studio). */
  captionStyle: CaptionStyleConfig;
  /** Phase 6: template the current caption style came from, if any. */
  captionTemplateId: string | null;
  /** Phase 6: brand kit last applied to this document, if any. */
  brandKitId: string | null;
}

export interface EditorState {
  canvas: CanvasState;
  settings: DocSettings;
  tracks: TrackState[];
  items: ItemState[];
  captions: CaptionState[];
  sceneOverrides: SceneOverrideState[];
}

export const ASPECT_PRESETS: Record<string, { width: number; height: number }> = {
  "9:16": { width: 1080, height: 1920 },
  "16:9": { width: 1920, height: 1080 },
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 1080, height: 1350 },
};

const DEFAULT_SETTINGS: DocSettings = {
  backgroundFill: "solid",
  showCaptions: true,
  showGuides: true,
  safeZones: true,
  captionStyle: { ...DEFAULT_CAPTION_STYLE },
  captionTemplateId: "builtin:clean-minimal",
  brandKitId: null,
};

// ---- state validation ---------------------------------------------------------

const cropSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    w: z.number().min(0.05).max(1),
    h: z.number().min(0.05).max(1),
  })
  .nullable();

const transformSchema = z.object({
  crop: cropSchema,
  x: z.number().min(-1).max(1),
  y: z.number().min(-1).max(1),
  scale: z.number().min(0.1).max(4),
  zoom: z.number().min(0.25).max(4),
  rotation: z.number().min(-180).max(180),
  fit: z.enum(["fit", "fill"]),
  // Phase 8 (optional so Phase 5-era states keep validating; readState
  // fills the default of 1 when absent).
  opacity: z.number().min(0.05).max(1).optional(),
});

const trackSchema = z.object({
  id: z.string().min(1).max(128),
  kind: z.enum(["main", "broll", "caption", "audio", "overlay"]),
  label: z.string().max(80),
  order: z.number().int().min(0).max(50),
  locked: z.boolean(),
  visible: z.boolean(),
  muted: z.boolean(),
  solo: z.boolean(),
});

const itemSchema = z.object({
  id: z.string().min(1).max(128),
  trackId: z.string().min(1).max(128),
  assetKind: z.enum(["source", "candidate", "media"]),
  assetId: z.string().min(1).max(128),
  start: z.number().min(0).max(86400),
  duration: z.number().min(0.05).max(86400),
  sourceIn: z.number().min(0).max(86400),
  sourceOut: z.number().min(0).max(86400),
  transform: transformSchema,
  speed: z.number().min(0.25).max(4),
  volume: z.number().min(0).max(2),
  fadeIn: z.number().min(0).max(3600),
  fadeOut: z.number().min(0).max(3600),
  layerOrder: z.number().int().min(0).max(1000),
});

const wordSchema = z.object({
  start: z.number().min(0).max(86400),
  end: z.number().min(0).max(86400),
  word: z.string().max(200),
  probability: z.number().min(0).max(1).nullable().optional(),
  emphasized: z.boolean().optional(),
});

const captionSchema = z.object({
  id: z.string().min(1).max(128),
  start: z.number().min(0).max(86400),
  end: z.number().min(0).max(86400),
  text: z.string().max(500),
  words: z.array(wordSchema).max(400).nullable(),
  // Phase 6 fields are optional so Phase 5 states/snapshots keep
  // validating; readState normalises them to style=null + a language.
  style: captionStyleSchema.nullable().optional(),
  language: z.string().min(1).max(8).optional(),
});

// Unknown override keys are stripped (not rejected) so states written by
// older/newer clients — e.g. ones still carrying the removed `layout` key —
// keep validating; only the known fields below are ever stored.
const overrideFieldsSchema = z.object({
  crop: cropSchema.optional(),
  x: z.number().min(-1).max(1).optional(),
  y: z.number().min(-1).max(1).optional(),
  scale: z.number().min(0.1).max(4).optional(),
  zoom: z.number().min(0.25).max(4).optional(),
  rotation: z.number().min(-180).max(180).optional(),
  fit: z.enum(["fit", "fill"]).optional(),
});

const sceneOverrideSchema = z.object({
  id: z.string().min(1).max(128),
  topicSegmentId: z.string().max(128).nullable(),
  rangeStart: z.number().min(0).max(86400),
  rangeEnd: z.number().min(0).max(86400),
  overrides: overrideFieldsSchema,
});

export const editorStateSchema = z.object({
  canvas: z.object({
    aspect: z.string().min(1).max(12),
    width: z.number().int().min(16).max(7680),
    height: z.number().int().min(16).max(7680),
    custom: z.boolean(),
  }),
  settings: z.object({
    backgroundFill: z.enum(["blur", "solid"]),
    showCaptions: z.boolean(),
    showGuides: z.boolean(),
    safeZones: z.boolean(),
    // Optional for backward compatibility with pre-centre-guides
    // states; validateState fills it from showGuides when absent.
    centerGuides: z.boolean().optional(),
    // Phase 6 (optional for Phase 5 payload compatibility; readState
    // fills defaults when absent).
    captionStyle: captionStyleSchema.optional(),
    captionTemplateId: z.string().max(128).nullable().optional(),
    brandKitId: z.string().max(128).nullable().optional(),
  }),
  tracks: z.array(trackSchema).min(1).max(12),
  items: z.array(itemSchema).max(300),
  captions: z.array(captionSchema).max(2000),
  sceneOverrides: z.array(sceneOverrideSchema).max(200),
});

/**
 * Validate a candidate editor state: shape (zod) + cross-checks
 * (unique ids, items on real tracks, ranges sane, asset references
 * owned by this user within this project and kind-compatible with
 * their track). Returns the normalized state or an error message.
 */
export function validateState(
  userId: string,
  projectId: string,
  raw: unknown,
): { ok: true; state: EditorState } | { ok: false; error: string } {
  const parsed = editorStateSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: `Invalid editor state: ${parsed.error.issues[0]?.message ?? "bad shape"}` };
  }
  const state = parsed.data as EditorState;
  const db = getDb();

  const trackIds = new Set<string>();
  let mainTracks = 0;
  for (const track of state.tracks) {
    if (trackIds.has(track.id)) return { ok: false, error: `Duplicate track id ${track.id}.` };
    trackIds.add(track.id);
    if (track.kind === "main") mainTracks += 1;
  }
  if (mainTracks === 0) return { ok: false, error: "The timeline needs a main video track." };

  const trackKind = new Map(state.tracks.map((t) => [t.id, t.kind]));
  const itemIds = new Set<string>();
  for (const item of state.items) {
    if (itemIds.has(item.id)) return { ok: false, error: `Duplicate item id ${item.id}.` };
    itemIds.add(item.id);
    const kind = trackKind.get(item.trackId);
    if (!kind) return { ok: false, error: `Item ${item.id} references a missing track.` };
    if (kind === "caption") return { ok: false, error: "Media items cannot be placed on the caption track." };
    if (item.sourceOut <= item.sourceIn) return { ok: false, error: "Item source out must be after source in." };
    if (item.fadeIn + item.fadeOut > item.duration + 0.001) {
      return { ok: false, error: "Fade in + fade out cannot exceed the item duration." };
    }
    // Asset reference + track compatibility.
    const media = resolveAsset(userId, projectId, item.assetKind, item.assetId);
    if (!media) return { ok: false, error: `Item references an asset that is not part of this project.` };
    if (kind === "audio" && !media.hasAudio) {
      return { ok: false, error: "That asset has no audio stream, so it cannot go on the audio track." };
    }
    if (kind !== "audio" && !media.hasVideo) {
      return { ok: false, error: "That asset has no video stream, so it cannot go on a video track." };
    }
  }
  const captionIds = new Set<string>();
  for (const caption of state.captions) {
    if (captionIds.has(caption.id)) return { ok: false, error: `Duplicate caption id ${caption.id}.` };
    captionIds.add(caption.id);
    if (caption.end <= caption.start) return { ok: false, error: "Caption end must be after its start." };
    if (caption.text.trim().length === 0) return { ok: false, error: "Caption text cannot be empty." };
    // Word timings are part of the saved state, so they are validated
    // here (not in the zod schema) — a word that ends at or before it
    // starts can never be highlighted or burned in correctly.
    if (caption.words) {
      for (const word of caption.words) {
        if (word.end <= word.start) {
          return { ok: false, error: "Caption word timings must end after they start." };
        }
      }
    }
    // Normalise Phase 6 fields so older states round-trip fully.
    caption.style = caption.style ?? null;
    caption.language = caption.language ?? "en";
  }
  state.settings.captionStyle = state.settings.captionStyle
    ? { ...DEFAULT_CAPTION_STYLE, ...state.settings.captionStyle }
    : { ...DEFAULT_CAPTION_STYLE };
  state.settings.captionTemplateId = state.settings.captionTemplateId ?? null;
  state.settings.brandKitId = state.settings.brandKitId ?? null;
  // Centre guides default to the guides behaviour until set explicitly.
  state.settings.centerGuides = state.settings.centerGuides ?? state.settings.showGuides;
  for (const override of state.sceneOverrides) {
    if (override.rangeEnd <= override.rangeStart) {
      return { ok: false, error: "Scene override end must be after its start." };
    }
  }
  void db;
  return { ok: true, state };
}

// ---- asset resolution -----------------------------------------------------------

export interface ResolvedAsset {
  path: string | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  hasAudio: boolean;
  hasVideo: boolean;
  /** For candidates: the source asset the candidate was cut from. */
  underlyingSourceId: string | null;
}

function sourceAssetRow(userId: string, projectId: string, id: string): SourceAssetRow | undefined {
  return getDb()
    .prepare("SELECT * FROM source_assets WHERE id = ? AND user_id = ? AND project_id = ?")
    .get(id, userId, projectId) as SourceAssetRow | undefined;
}

export function resolveAsset(
  userId: string,
  projectId: string,
  kind: "source" | "candidate" | "media",
  id: string,
): ResolvedAsset | null {
  const db = getDb();
  if (kind === "source") {
    const asset = sourceAssetRow(userId, projectId, id);
    if (!asset) return null;
    return {
      path: asset.storage_key,
      width: asset.width,
      height: asset.height,
      duration: asset.duration,
      hasAudio: asset.has_audio === 1,
      hasVideo: Boolean(asset.video_codec),
      underlyingSourceId: asset.id,
    };
  }
  if (kind === "candidate") {
    const candidate = db
      .prepare("SELECT * FROM candidate_clips WHERE id = ? AND user_id = ? AND project_id = ?")
      .get(id, userId, projectId) as CandidateClipRow | undefined;
    if (!candidate) return null;
    const source = sourceAssetRow(userId, projectId, candidate.source_asset_id);
    if (!source) return null;
    return {
      path: source.storage_key,
      width: source.width,
      height: source.height,
      duration: source.duration,
      hasAudio: source.has_audio === 1,
      hasVideo: Boolean(source.video_codec),
      underlyingSourceId: source.id,
    };
  }
  const media = db
    .prepare("SELECT * FROM project_media WHERE id = ? AND user_id = ? AND project_id = ?")
    .get(id, userId, projectId) as ProjectMediaRow | undefined;
  if (!media) return null;
  return {
    path: media.storage_key,
    width: media.width,
    height: media.height,
    duration: media.duration,
    hasAudio: media.has_audio === 1,
    hasVideo: media.has_video === 1,
    underlyingSourceId: null,
  };
}

// ---- document persistence ---------------------------------------------------------

export function ownedProject(userId: string, id: string): ProjectRow | undefined {
  const row = getDb()
    .prepare("SELECT * FROM projects WHERE id = ?")
    .get(id) as ProjectRow | undefined;
  if (!row) return undefined;
  // Phase 12 workspace access (see studio.ts ownedProject): members
  // reach the active workspace's projects; everyone else gets a 404.
  const wsId = currentWorkspaceId(userId);
  if (row.workspace_id) {
    return wsId && row.workspace_id === wsId ? row : undefined;
  }
  return row.user_id === userId ? row : undefined;
}

export function docById(userId: string, id: string): ClipVersionRow | undefined {
  return getDb()
    .prepare("SELECT * FROM clip_versions WHERE id = ? AND user_id = ?")
    .get(id, userId) as ClipVersionRow | undefined;
}

function docByProject(userId: string, projectId: string): ClipVersionRow | undefined {
  return getDb()
    .prepare("SELECT * FROM clip_versions WHERE project_id = ? AND user_id = ?")
    .get(projectId, userId) as ClipVersionRow | undefined;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Rebuild the full editor state from the normalized tables. */
export function readState(doc: ClipVersionRow): EditorState {
  const db = getDb();
  const canvas = parseJson<CanvasState>(doc.canvas_json, {
    aspect: "9:16",
    ...ASPECT_PRESETS["9:16"],
    custom: false,
  });
  const settings = { ...DEFAULT_SETTINGS, ...parseJson<Partial<DocSettings>>(doc.settings_json, {}) };
  // Centre guides: documents stored before the setting existed fall
  // back to their showGuides value (the historical behaviour).
  if (settings.centerGuides === undefined) settings.centerGuides = settings.showGuides;
  // Fill any caption-style keys a pre-Phase 6 settings blob lacks and
  // never hand out the shared default object itself.
  settings.captionStyle = { ...DEFAULT_CAPTION_STYLE, ...(settings.captionStyle ?? {}) };
  settings.captionTemplateId = settings.captionTemplateId ?? null;
  settings.brandKitId = settings.brandKitId ?? null;
  const trackRows = db
    .prepare("SELECT * FROM timeline_tracks WHERE version_id = ? ORDER BY order_idx ASC, rowid ASC")
    .all(doc.id) as unknown as TimelineTrackRow[];
  const itemRows = db
    .prepare("SELECT * FROM timeline_items WHERE version_id = ? ORDER BY start_sec ASC, layer_order ASC, rowid ASC")
    .all(doc.id) as unknown as TimelineItemRow[];
  const captionRows = db
    .prepare("SELECT * FROM caption_segments WHERE version_id = ? ORDER BY start_sec ASC, rowid ASC")
    .all(doc.id) as unknown as CaptionSegmentRow[];
  const overrideRows = db
    .prepare("SELECT * FROM scene_overrides WHERE version_id = ? ORDER BY range_start_sec ASC, rowid ASC")
    .all(doc.id) as unknown as SceneOverrideRow[];
  return {
    canvas,
    settings,
    tracks: trackRows.map((t) => ({
      id: t.id,
      kind: t.kind as TrackState["kind"],
      label: t.label,
      order: t.order_idx,
      locked: t.locked === 1,
      visible: t.visible === 1,
      muted: t.muted === 1,
      solo: t.solo === 1,
    })),
    items: itemRows.map((i) => ({
      id: i.id,
      trackId: i.track_id,
      assetKind: i.asset_kind as ItemState["assetKind"],
      assetId: i.asset_id,
      start: i.start_sec,
      duration: i.duration_sec,
      sourceIn: i.source_in_sec,
      sourceOut: i.source_out_sec,
      transform: { ...DEFAULT_TRANSFORM, ...parseJson<Partial<TransformState>>(i.transform_json, {}) },
      speed: i.speed,
      volume: i.volume,
      fadeIn: i.fade_in_sec,
      fadeOut: i.fade_out_sec,
      layerOrder: i.layer_order,
    })),
    captions: captionRows.map((c) => ({
      id: c.id,
      start: c.start_sec,
      end: c.end_sec,
      text: c.text,
      words: c.words_json ? parseJson<CaptionState["words"]>(c.words_json, null) : null,
      style: c.style_json
        ? { ...DEFAULT_CAPTION_STYLE, ...parseJson<Partial<CaptionStyleConfig>>(c.style_json, {}) }
        : null,
      language: c.language ?? "en",
    })),
    sceneOverrides: overrideRows.map((o) => {
      // Strip the retired `layout` key from rows written before it was
      // removed, so legacy data round-trips in the current shape only.
      const { layout: _legacyLayout, ...overrides } = parseJson<SceneOverrideFields & { layout?: string }>(
        o.overrides_json,
        {},
      );
      return {
        id: o.id,
        topicSegmentId: o.topic_segment_id,
        rangeStart: o.range_start_sec,
        rangeEnd: o.range_end_sec,
        overrides,
      };
    }),
  };
}

/** Replace the document's rows with the given state (call inside a transaction). */
function applyState(docId: string, state: EditorState): void {
  const db = getDb();
  db.prepare("DELETE FROM timeline_items WHERE version_id = ?").run(docId);
  db.prepare("DELETE FROM timeline_tracks WHERE version_id = ?").run(docId);
  db.prepare("DELETE FROM caption_segments WHERE version_id = ?").run(docId);
  db.prepare("DELETE FROM scene_overrides WHERE version_id = ?").run(docId);
  const insTrack = db.prepare(
    "INSERT INTO timeline_tracks (id, version_id, kind, label, order_idx, locked, visible, muted, solo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const t of state.tracks) {
    insTrack.run(t.id, docId, t.kind, t.label, t.order, t.locked ? 1 : 0, t.visible ? 1 : 0, t.muted ? 1 : 0, t.solo ? 1 : 0);
  }
  const insItem = db.prepare(
    `INSERT INTO timeline_items (id, version_id, track_id, asset_kind, asset_id, start_sec, duration_sec, source_in_sec, source_out_sec, transform_json, speed, volume, fade_in_sec, fade_out_sec, layer_order, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = nowIso();
  for (const i of state.items) {
    insItem.run(
      i.id, docId, i.trackId, i.assetKind, i.assetId,
      round3(i.start), round3(i.duration), round3(i.sourceIn), round3(i.sourceOut),
      JSON.stringify(i.transform), i.speed, i.volume, round3(i.fadeIn), round3(i.fadeOut),
      i.layerOrder, now,
    );
  }
  const insCaption = db.prepare(
    "INSERT INTO caption_segments (id, version_id, start_sec, end_sec, text, words_json, style_json, language, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const c of state.captions) {
    insCaption.run(
      c.id, docId, round3(c.start), round3(c.end), c.text,
      c.words ? JSON.stringify(c.words) : null,
      c.style ? JSON.stringify(c.style) : null,
      c.language ?? null,
      now,
    );
  }
  const insOverride = db.prepare(
    "INSERT INTO scene_overrides (id, version_id, topic_segment_id, range_start_sec, range_end_sec, overrides_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const o of state.sceneOverrides) {
    insOverride.run(o.id, docId, o.topicSegmentId, round3(o.rangeStart), round3(o.rangeEnd), JSON.stringify(o.overrides), now);
  }
  db.prepare("UPDATE clip_versions SET canvas_json = ?, settings_json = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(state.canvas),
    JSON.stringify(state.settings),
    nowIso(),
    docId,
  );
}

function transaction<T>(fn: () => T): T {
  const db = getDb();
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Record an editing operation (state-snapshot strategy) and make the
 * new state current. Truncates any redo branch first. When the client
 * supplies an operationId it is stored inside payload_json so a retried
 * request can be recognised and de-duplicated (see the operations route).
 */
export function commitOperation(
  doc: ClipVersionRow,
  type: string,
  newState: EditorState,
  operationId?: string,
): ClipVersionRow {
  const db = getDb();
  const before = readState(doc);
  transaction(() => {
    db.prepare("DELETE FROM editing_operations WHERE version_id = ? AND seq > ?").run(doc.id, doc.undo_cursor);
    const seq = doc.undo_cursor + 1;
    db.prepare(
      "INSERT INTO editing_operations (id, version_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      newId(), doc.id, seq, type,
      JSON.stringify({ type, before, after: newState, operationId: operationId ?? null }),
      nowIso(),
    );
    applyState(doc.id, newState);
    db.prepare("UPDATE clip_versions SET undo_cursor = ?, updated_at = ? WHERE id = ?").run(seq, nowIso(), doc.id);
  });
  return docById(doc.user_id, doc.id)!;
}

function opCount(docId: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM editing_operations WHERE version_id = ?")
    .get(docId) as { n: number };
  return row.n;
}

function opAt(docId: string, seq: number): EditingOperationRow | undefined {
  return getDb()
    .prepare("SELECT * FROM editing_operations WHERE version_id = ? AND seq = ?")
    .get(docId, seq) as EditingOperationRow | undefined;
}

/**
 * Find a previously committed operation by its client-supplied
 * operationId. The id lives inside payload_json (no separate column, so
 * no schema migration); operation counts per document are small, so a
 * scan of the doc's payloads is cheap enough.
 */
function findOperationByOperationId(docId: string, operationId: string): EditingOperationRow | undefined {
  const rows = getDb()
    .prepare("SELECT * FROM editing_operations WHERE version_id = ?")
    .all(docId) as unknown as EditingOperationRow[];
  return rows.find(
    (row) => parseJson<{ operationId?: string | null }>(row.payload_json, {})?.operationId === operationId,
  );
}

// ---- document creation / seeding ---------------------------------------------------

function defaultTracks(): TrackState[] {
  return [
    { id: newId(), kind: "main", label: "Main video", order: 0, locked: false, visible: true, muted: false, solo: false },
    { id: newId(), kind: "broll", label: "B-roll", order: 1, locked: false, visible: true, muted: false, solo: false },
    { id: newId(), kind: "caption", label: "Captions", order: 2, locked: false, visible: true, muted: false, solo: false },
    { id: newId(), kind: "audio", label: "Music & audio", order: 3, locked: false, visible: true, muted: false, solo: false },
    { id: newId(), kind: "overlay", label: "Overlays", order: 4, locked: false, visible: true, muted: false, solo: false },
  ];
}

function canvasForProject(project: ProjectRow): CanvasState {
  const settings = parseJson<Record<string, unknown>>(project.settings_json, {});
  const wanted =
    typeof settings.aspectRatio === "string"
      ? settings.aspectRatio
      : typeof settings.reframeAspect === "string"
        ? settings.reframeAspect
        : null;
  const fallback = project.workflow_type === "LONG_VIDEO_TO_SHORTS" ? "9:16" : "16:9";
  const aspect = wanted && ASPECT_PRESETS[wanted] ? wanted : fallback;
  return { aspect, ...ASPECT_PRESETS[aspect], custom: false };
}

interface SeedItem {
  item: ItemState;
  /** Source-time window the item occupies, for caption mapping. */
  sourceAssetId: string;
}

/**
 * Build the initial document state: seeded from a candidate clip when
 * one is requested (or from the project's valid source), with the
 * caption track seeded from the project's real transcript segments,
 * mapped through the seed item's source window. Timings are only ever
 * copied/shifted from the transcript — never invented.
 */
function buildSeedState(
  userId: string,
  project: ProjectRow,
  seedCandidateId: string | null,
): { state: EditorState; baseCandidateId: string | null; seed: SeedItem | null } {
  const db = getDb();
  const tracks = defaultTracks();
  const mainTrack = tracks[0];
  const state: EditorState = {
    canvas: canvasForProject(project),
    settings: { ...DEFAULT_SETTINGS },
    tracks,
    items: [],
    captions: [],
    sceneOverrides: [],
  };

  let seed: SeedItem | null = null;
  let baseCandidateId: string | null = null;

  const candidate = seedCandidateId
    ? (db
        .prepare("SELECT * FROM candidate_clips WHERE id = ? AND user_id = ? AND project_id = ?")
        .get(seedCandidateId, userId, project.id) as CandidateClipRow | undefined)
    : undefined;

  if (candidate) {
    baseCandidateId = candidate.id;
    const item: ItemState = {
      id: newId(),
      trackId: mainTrack.id,
      assetKind: "candidate",
      assetId: candidate.id,
      start: 0,
      duration: round3(candidate.duration),
      sourceIn: round3(candidate.start_sec),
      sourceOut: round3(candidate.end_sec),
      transform: { ...DEFAULT_TRANSFORM },
      speed: 1,
      volume: 1,
      fadeIn: 0,
      fadeOut: 0,
      layerOrder: 0,
    };
    state.items.push(item);
    seed = { item, sourceAssetId: candidate.source_asset_id };
  } else {
    const asset = db
      .prepare(
        "SELECT * FROM source_assets WHERE project_id = ? AND user_id = ? AND validation_status = 'VALID' AND storage_key IS NOT NULL ORDER BY rowid DESC LIMIT 1",
      )
      .get(project.id, userId) as SourceAssetRow | undefined;
    if (asset && asset.duration && asset.duration > 0) {
      const item: ItemState = {
        id: newId(),
        trackId: mainTrack.id,
        assetKind: "source",
        assetId: asset.id,
        start: 0,
        duration: round3(asset.duration),
        sourceIn: 0,
        sourceOut: round3(asset.duration),
        transform: { ...DEFAULT_TRANSFORM },
        speed: 1,
        volume: 1,
        fadeIn: 0,
        fadeOut: 0,
        layerOrder: 0,
      };
      state.items.push(item);
      seed = { item, sourceAssetId: asset.id };
    }
  }

  // Seed captions from the latest transcript of the seed's source.
  if (seed) {
    const transcript = db
      .prepare("SELECT * FROM transcripts WHERE project_id = ? AND source_asset_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(project.id, seed.sourceAssetId) as TranscriptRow | undefined;
    if (transcript) {
      const segments = db
        .prepare("SELECT * FROM transcript_segments WHERE transcript_id = ? ORDER BY idx ASC")
        .all(transcript.id) as unknown as TranscriptSegmentRow[];
      const { sourceIn, sourceOut, start } = seed.item;
      for (const segment of segments) {
        if (segment.end_sec <= sourceIn || segment.start_sec >= sourceOut) continue;
        const words = segment.words_json
          ? parseJson<{ start: number; end: number; word: string; probability?: number | null }[]>(segment.words_json, [])
              .filter((w) => w.end > sourceIn && w.start < sourceOut)
              .map((w) => ({
                start: round3(start + Math.max(w.start, sourceIn) - sourceIn),
                end: round3(start + Math.min(w.end, sourceOut) - sourceIn),
                word: w.word.trim(),
                probability: w.probability ?? null,
              }))
              .filter((w) => w.word.length > 0 && w.end > w.start)
          : null;
        state.captions.push({
          id: newId(),
          start: round3(start + Math.max(segment.start_sec, sourceIn) - sourceIn),
          end: round3(start + Math.min(segment.end_sec, sourceOut) - sourceIn),
          text: segment.text,
          words: words && words.length > 0 ? words : null,
          style: null,
          language: transcript.language ?? "en",
        });
      }
    }
  }

  return { state, baseCandidateId, seed };
}

export function getOrCreateDoc(
  userId: string,
  project: ProjectRow,
  seedCandidateId: string | null,
): { doc: ClipVersionRow; created: boolean } {
  const existing = docByProject(userId, project.id);
  if (existing) return { doc: existing, created: false };
  const { state, baseCandidateId } = buildSeedState(userId, project, seedCandidateId);
  const now = nowIso();
  const doc: ClipVersionRow = {
    id: newId(),
    user_id: userId,
    project_id: project.id,
    base_candidate_id: baseCandidateId,
    canvas_json: JSON.stringify(state.canvas),
    settings_json: JSON.stringify(state.settings),
    undo_cursor: 0,
    created_at: now,
    updated_at: now,
  };
  transaction(() => {
    getDb()
      .prepare(
        "INSERT INTO clip_versions (id, user_id, project_id, base_candidate_id, canvas_json, settings_json, undo_cursor, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)",
      )
      .run(doc.id, doc.user_id, doc.project_id, doc.base_candidate_id, doc.canvas_json, doc.settings_json, now, now);
    applyState(doc.id, state);
  });
  return { doc: docById(userId, doc.id)!, created: true };
}

/**
 * Phase 9: the standalone editing state for ONE generated candidate
 * clip (its source window on the main track + its transcript-mapped
 * captions + the project canvas) — exactly the state the editor
 * would seed for that candidate. Batch export uses this so every
 * candidate exports from its own state, never from the raw source.
 * Returns null when the candidate does not exist for this project.
 */
export function candidateState(
  userId: string,
  project: ProjectRow,
  candidateId: string,
): EditorState | null {
  const { state, baseCandidateId } = buildSeedState(userId, project, candidateId);
  if (!baseCandidateId) return null;
  return state;
}

// ---- serializers ----------------------------------------------------------------------

function publicMedia(m: ProjectMediaRow) {
  return {
    id: m.id,
    projectId: m.project_id,
    kind: m.kind,
    originalFilename: m.original_filename,
    fileSize: m.file_size,
    duration: m.duration,
    width: m.width,
    height: m.height,
    videoCodec: m.video_codec,
    audioCodec: m.audio_codec,
    hasAudio: m.has_audio === null ? null : m.has_audio === 1,
    hasVideo: m.has_video === null ? null : m.has_video === 1,
    container: m.container,
    createdAt: m.created_at,
  };
}

export function publicRenderJob(j: RenderJobRow) {
  let settings: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(j.settings_json) as {
      timelineDuration?: unknown;
      enhance?: { scope?: unknown } | null;
      export?: Record<string, unknown> | null;
      state?: { canvas?: unknown; settings?: { backgroundFill?: unknown; showCaptions?: unknown } };
    };
    settings = {
      canvas: parsed.state?.canvas ?? null,
      backgroundFill: parsed.state?.settings?.backgroundFill ?? null,
      showCaptions: parsed.state?.settings?.showCaptions ?? null,
      timelineDuration: parsed.timelineDuration ?? null,
      // Phase 8: whether this render carried an enhancement snapshot.
      enhanced: parsed.enhance != null,
      enhanceScope: parsed.enhance?.scope ?? null,
      // Phase 9: the full export settings block (null on plain renders).
      export: parsed.export ?? null,
    };
  } catch {
    settings = {};
  }
  return {
    id: j.id,
    documentId: j.version_id,
    projectId: j.project_id,
    status: j.status,
    stage: j.stage,
    settings,
    error: j.error,
    hasOutput: Boolean(j.output_path),
    // Phase 9 queue discipline + real encoder progress (null when the
    // current command reports none — the UI shows the stage instead).
    kind: j.kind ?? "RENDER",
    priority: j.priority ?? 0,
    retryCount: j.retry_count ?? 0,
    progress: j.progress_json ? parseJson<Record<string, unknown> | null>(j.progress_json, null) : null,
    outputName: j.output_name ?? null,
    workerId: j.worker_id ?? null,
    createdAt: j.created_at,
    updatedAt: j.updated_at,
    startedAt: j.started_at,
    finishedAt: j.finished_at,
  };
}

export function publicDocument(doc: ClipVersionRow) {
  const state = readState(doc);
  return {
    id: doc.id,
    projectId: doc.project_id,
    baseCandidateId: doc.base_candidate_id,
    canvas: state.canvas,
    settings: state.settings,
    tracks: state.tracks,
    items: state.items,
    captions: state.captions,
    sceneOverrides: state.sceneOverrides,
    undoCursor: doc.undo_cursor,
    opCount: opCount(doc.id),
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

/** Media library + scene data the editor UI needs alongside the document. */
function editorLibrary(userId: string, project: ProjectRow) {
  const db = getDb();
  const source = db
    .prepare("SELECT * FROM source_assets WHERE project_id = ? AND user_id = ? ORDER BY rowid DESC LIMIT 1")
    .get(project.id, userId) as SourceAssetRow | undefined;
  const candidates = db
    .prepare("SELECT * FROM candidate_clips WHERE project_id = ? AND user_id = ? ORDER BY score DESC, start_sec ASC")
    .all(project.id, userId) as unknown as CandidateClipRow[];
  const media = db
    .prepare("SELECT * FROM project_media WHERE project_id = ? AND user_id = ? ORDER BY created_at ASC")
    .all(project.id, userId) as unknown as ProjectMediaRow[];
  const transcript = db
    .prepare("SELECT * FROM transcripts WHERE project_id = ? ORDER BY rowid DESC LIMIT 1")
    .get(project.id) as TranscriptRow | undefined;
  const topics = transcript
    ? (db
        .prepare("SELECT * FROM topic_segments WHERE transcript_id = ? ORDER BY start_sec ASC")
        .all(transcript.id) as unknown as TopicSegmentRow[])
    : [];
  return {
    sourceAsset: source
      ? {
          id: source.id,
          originalFilename: source.original_filename,
          duration: source.duration,
          width: source.width,
          height: source.height,
          hasAudio: source.has_audio === null ? null : source.has_audio === 1,
          hasVideo: Boolean(source.video_codec),
          validationStatus: source.validation_status,
          sourceType: source.source_type,
        }
      : null,
    candidates: candidates.map((c) => ({
      id: c.id,
      title: c.title,
      startSec: c.start_sec,
      endSec: c.end_sec,
      duration: c.duration,
      score: c.score,
      status: c.status,
      previewStatus: c.preview_status,
      sourceAssetId: c.source_asset_id,
    })),
    media: media.map(publicMedia),
    topics: topics.map((t) => ({ id: t.id, startSec: t.start_sec, endSec: t.end_sec, label: t.label })),
    transcriptSourceAssetId: transcript?.source_asset_id ?? null,
  };
}

// ---- routes -----------------------------------------------------------------------------

const operationSchema = z.object({
  type: z.string().trim().min(1).max(60),
  state: z.unknown(),
  // Optional idempotency key: a retry carrying an already-committed
  // operationId returns the current document instead of appending a
  // duplicate operation.
  operationId: z.string().trim().min(1).max(128).optional(),
  // Optional optimistic-concurrency guard: the undo cursor the client
  // based this state on. A mismatch means the client is stale -> 409.
  baseCursor: z.number().int().min(0).optional(),
});

const settingsPatchSchema = z.object({
  canvas: editorStateSchema.shape.canvas.optional(),
  settings: editorStateSchema.shape.settings.partial().optional(),
  // Same optimistic-concurrency guard as the operations route.
  baseCursor: z.number().int().min(0).optional(),
});

/** Body shape for routes that take no payload of their own (undo /
 *  redo / version restore) but accept the same optional baseCursor
 *  guard as the operations route. */
const cursorGuardSchema = z.object({
  baseCursor: z.number().int().min(0).optional(),
});

/**
 * Phase 5 (§12 add/remove tracks): structural guards for the
 * track_add / track_remove operation types, checked by diffing the
 * persisted state against the proposed one — the same conservatism
 * as the merge/lock guards. Adding must add exactly one EMPTY track
 * of an existing kind (the state schema enforces the kind set);
 * removing must remove exactly one track that is EMPTY in the
 * persisted state, never the document's last track, and never the
 * only caption track. (validateState separately guarantees at least
 * one main track survives.)
 */
function trackChangeError(current: EditorState, next: EditorState, type: string): string | null {
  const currentIds = new Set(current.tracks.map((t) => t.id));
  const nextIds = new Set(next.tracks.map((t) => t.id));
  const added = next.tracks.filter((t) => !currentIds.has(t.id));
  const removed = current.tracks.filter((t) => !nextIds.has(t.id));
  if (type === "track_add") {
    if (added.length !== 1 || removed.length > 0) {
      return "Adding a track must add exactly one new track and remove none.";
    }
    if (next.items.some((i) => i.trackId === added[0].id)) {
      return "A newly added track must be empty.";
    }
    return null;
  }
  // track_remove
  if (removed.length !== 1 || added.length > 0) {
    return "Removing a track must remove exactly one track and add none.";
  }
  const track = removed[0];
  if (current.items.some((i) => i.trackId === track.id)) {
    return "Only an empty track can be removed — move or delete its clips first.";
  }
  if (track.kind === "caption" && current.tracks.filter((t) => t.kind === "caption").length <= 1) {
    return "The last caption track cannot be removed.";
  }
  if (next.tracks.length === 0) {
    return "The last track of the document cannot be removed.";
  }
  return null;
}

const versionSchema = z.object({ name: z.string().trim().min(1).max(120) });

export function registerEditorRoutes(app: express.Express, requireAuth: RequireAuth): void {
  const router = express.Router();
  const maxBytes = config.maxUploadMb * 1024 * 1024;

  fs.mkdirSync(path.join(config.mediaDir, ".tmp"), { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination: path.join(config.mediaDir, ".tmp"),
      filename: (_req, _file, cb) => cb(null, `${newId()}.part`),
    }),
    limits: { fileSize: maxBytes, files: 1 },
  });

  const sendDoc = (res: Response, doc: ClipVersionRow, status = 200) => {
    res.status(status).json({ document: publicDocument(doc) });
  };

  /**
   * Optimistic-concurrency guard for the mutation routes other than
   * operations (which inlines the same check after its idempotency
   * check): when the client sends the undo cursor it based its view
   * on and it no longer matches the document's, the request is stale
   * -> 409. An absent field means no guard, so clients that do not
   * send it proceed unchanged. Returns true when rejected.
   */
  const rejectIfStale = (res: Response, doc: ClipVersionRow, baseCursor: number | undefined): boolean => {
    if (baseCursor !== undefined && baseCursor !== doc.undo_cursor) {
      res.status(409).json({
        error: "This edit is based on an older version of the document. Reload the editor and try again.",
      });
      return true;
    }
    return false;
  };

  /** Extract the optional baseCursor from a body that carries no
   *  other payload; a malformed value is treated as absent. */
  const guardCursorOf = (body: unknown): number | undefined => {
    const parsed = cursorGuardSchema.safeParse(body ?? {});
    return parsed.success ? parsed.data.baseCursor : undefined;
  };

  // -- Get or create the editing document for a project --
  const getOrCreate = (req: AuthedRequest, res: Response) => {
    const project = ownedProject(req.user!.id, req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found." });
      return;
    }
    const seedParam =
      typeof req.query.seedCandidateId === "string"
        ? req.query.seedCandidateId
        : typeof (req.body as { seedCandidateId?: unknown })?.seedCandidateId === "string"
          ? ((req.body as { seedCandidateId: string }).seedCandidateId as string)
          : null;
    if (seedParam) {
      const candidate = getDb()
        .prepare("SELECT id FROM candidate_clips WHERE id = ? AND user_id = ? AND project_id = ?")
        .get(seedParam, req.user!.id, project.id);
      if (!candidate) {
        res.status(404).json({ error: "Seed candidate clip not found for this project." });
        return;
      }
    }
    const { doc, created } = getOrCreateDoc(req.user!.id, project, seedParam);
    res.status(created ? 201 : 200).json({
      document: publicDocument(doc),
      library: editorLibrary(req.user!.id, project),
    });
  };
  router.get("/projects/:id/editor", requireAuth, getOrCreate);
  router.post("/projects/:id/editor", requireAuth, getOrCreate);

  // -- Apply one editing operation (autosave) --
  router.post("/editor/:docId/operations", requireAuth, (req: AuthedRequest, res) => {
    const doc = docById(req.user!.id, req.params.docId);
    if (!doc) {
      res.status(404).json({ error: "Editor document not found." });
      return;
    }
    const parsed = operationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid operation." });
      return;
    }
    // Idempotent retry: this operationId was already committed, so hand
    // back the current document rather than appending a duplicate op.
    // Checked before baseCursor on purpose: a genuine retry carries the
    // original (now stale) baseCursor from its first attempt.
    if (parsed.data.operationId && findOperationByOperationId(doc.id, parsed.data.operationId)) {
      sendDoc(res, doc);
      return;
    }
    // Optimistic concurrency: the state was built on an older cursor, so
    // applying it would silently overwrite newer edits. Reject and let
    // the client reload.
    if (parsed.data.baseCursor !== undefined && parsed.data.baseCursor !== doc.undo_cursor) {
      res.status(409).json({
        error: "This edit is based on an older version of the document. Reload the editor and try again.",
      });
      return;
    }
    const checked = validateState(req.user!.id, doc.project_id, parsed.data.state);
    if (!checked.ok) {
      res.status(400).json({ error: checked.error });
      return;
    }
    // Track add/remove carry extra structural guards (empty-only
    // removal, never the last track / only caption track).
    if (parsed.data.type === "track_add" || parsed.data.type === "track_remove") {
      const trackError = trackChangeError(readState(doc), checked.state, parsed.data.type);
      if (trackError) {
        res.status(400).json({ error: trackError });
        return;
      }
    }
    const updated = commitOperation(doc, parsed.data.type, checked.state, parsed.data.operationId);
    sendDoc(res, updated);
  });

  // -- Undo / redo --
  const undoRedo = (direction: "undo" | "redo") => (req: AuthedRequest, res: Response) => {
    const doc = docById(req.user!.id, req.params.docId);
    if (!doc) {
      res.status(404).json({ error: "Editor document not found." });
      return;
    }
    if (rejectIfStale(res, doc, guardCursorOf(req.body))) return;
    const targetSeq = direction === "undo" ? doc.undo_cursor : doc.undo_cursor + 1;
    if (direction === "undo" && doc.undo_cursor === 0) {
      res.status(409).json({ error: "Nothing to undo." });
      return;
    }
    const op = opAt(doc.id, targetSeq);
    if (!op) {
      res.status(409).json({ error: direction === "undo" ? "Nothing to undo." : "Nothing to redo." });
      return;
    }
    const payload = parseJson<{ before: EditorState; after: EditorState } | null>(op.payload_json, null);
    if (!payload) {
      res.status(500).json({ error: "Operation history is unreadable." });
      return;
    }
    const state = direction === "undo" ? payload.before : payload.after;
    const newCursor = direction === "undo" ? doc.undo_cursor - 1 : doc.undo_cursor + 1;
    transaction(() => {
      applyState(doc.id, state);
      getDb()
        .prepare("UPDATE clip_versions SET undo_cursor = ?, updated_at = ? WHERE id = ?")
        .run(newCursor, nowIso(), doc.id);
    });
    sendDoc(res, docById(req.user!.id, doc.id)!);
  };
  router.post("/editor/:docId/undo", requireAuth, undoRedo("undo"));
  router.post("/editor/:docId/redo", requireAuth, undoRedo("redo"));

  // -- Document settings (canvas / background) — recorded as an operation --
  router.patch("/editor/:docId/settings", requireAuth, (req: AuthedRequest, res) => {
    const doc = docById(req.user!.id, req.params.docId);
    if (!doc) {
      res.status(404).json({ error: "Editor document not found." });
      return;
    }
    const parsed = settingsPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid settings." });
      return;
    }
    if (rejectIfStale(res, doc, parsed.data.baseCursor)) return;
    const current = readState(doc);
    const next: EditorState = {
      ...current,
      canvas: parsed.data.canvas ?? current.canvas,
      settings: { ...current.settings, ...(parsed.data.settings ?? {}) },
    };
    const checked = validateState(req.user!.id, doc.project_id, next);
    if (!checked.ok) {
      res.status(400).json({ error: checked.error });
      return;
    }
    const updated = commitOperation(doc, "settings", checked.state);
    sendDoc(res, updated);
  });

  // -- Named versions --
  router.get("/editor/:docId/versions", requireAuth, (req: AuthedRequest, res) => {
    const doc = docById(req.user!.id, req.params.docId);
    if (!doc) {
      res.status(404).json({ error: "Editor document not found." });
      return;
    }
    const rows = getDb()
      .prepare("SELECT * FROM project_versions WHERE version_id = ? ORDER BY created_at DESC, rowid DESC")
      .all(doc.id) as unknown as ProjectVersionRow[];
    res.json({
      versions: rows.map((v) => ({ id: v.id, name: v.name, createdAt: v.created_at })),
    });
  });

  router.post("/editor/:docId/versions", requireAuth, (req: AuthedRequest, res) => {
    const doc = docById(req.user!.id, req.params.docId);
    if (!doc) {
      res.status(404).json({ error: "Editor document not found." });
      return;
    }
    const parsed = versionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Give the version a name (1–120 characters)." });
      return;
    }
    const version: ProjectVersionRow = {
      id: newId(),
      version_id: doc.id,
      name: parsed.data.name,
      snapshot_json: JSON.stringify(readState(doc)),
      created_at: nowIso(),
    };
    getDb()
      .prepare("INSERT INTO project_versions (id, version_id, name, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(version.id, version.version_id, version.name, version.snapshot_json, version.created_at);
    res.status(201).json({ version: { id: version.id, name: version.name, createdAt: version.created_at } });
  });

  router.post("/editor/:docId/versions/:versionId/restore", requireAuth, (req: AuthedRequest, res) => {
    const doc = docById(req.user!.id, req.params.docId);
    if (!doc) {
      res.status(404).json({ error: "Editor document not found." });
      return;
    }
    const version = getDb()
      .prepare("SELECT * FROM project_versions WHERE id = ? AND version_id = ?")
      .get(req.params.versionId, doc.id) as ProjectVersionRow | undefined;
    if (!version) {
      res.status(404).json({ error: "Version not found." });
      return;
    }
    if (rejectIfStale(res, doc, guardCursorOf(req.body))) return;
    // Restore is itself an operation — history is never rewritten.
    const checked = validateState(req.user!.id, doc.project_id, parseJson<unknown>(version.snapshot_json, null));
    if (!checked.ok) {
      res.status(400).json({ error: `That version can no longer be restored: ${checked.error}` });
      return;
    }
    const updated = commitOperation(doc, "restore_version", checked.state);
    sendDoc(res, updated);
  });

  // -- Project media (audio / extra clips for the library) --
  router.get("/projects/:id/media", requireAuth, (req: AuthedRequest, res) => {
    const project = ownedProject(req.user!.id, req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found." });
      return;
    }
    const rows = getDb()
      .prepare("SELECT * FROM project_media WHERE project_id = ? AND user_id = ? ORDER BY created_at ASC")
      .all(project.id, req.user!.id) as unknown as ProjectMediaRow[];
    res.json({ media: rows.map(publicMedia) });
  });

  router.post("/projects/:id/media", requireAuth, (req: AuthedRequest, res) => {
    const project = ownedProject(req.user!.id, req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found." });
      return;
    }
    upload.single("file")(req, res, async (err: unknown) => {
      const fail = (status: number, message: string) => {
        if (!res.headersSent) res.status(status).json({ error: message });
      };
      try {
        if (err) {
          const multerErr = err as { code?: string };
          if (multerErr.code === "LIMIT_FILE_SIZE") {
            fail(413, `This file is larger than the current upload limit of ${config.maxUploadMb} MB.`);
          } else {
            fail(400, "The upload could not be read. Please choose the file again and retry.");
          }
          return;
        }
        const file = (req as Request & { file?: Express.Multer.File }).file;
        if (!file) {
          fail(400, "No file was received. Choose an audio or video file and try again.");
          return;
        }
        const ext = extensionOf(file.originalname);
        const allowed = [...ALLOWED_EXTENSIONS, ...AUDIO_EXTENSIONS];
        if (!allowed.includes(ext)) {
          fs.rmSync(file.path, { force: true });
          fail(400, `This file type is not supported. Supported: ${allowed.map((e) => `.${e}`).join(", ")}.`);
          return;
        }
        const mediaId = newId();
        const storageKey = `${req.user!.id}/media/${mediaId}.${ext}`;
        fs.mkdirSync(path.dirname(mediaPath(storageKey)), { recursive: true });
        fs.renameSync(file.path, mediaPath(storageKey));
        let meta: ProbedAnyMetadata;
        try {
          meta = await probeAnyFile(mediaPath(storageKey));
        } catch (probeErr) {
          fs.rmSync(mediaPath(storageKey), { force: true });
          fail(422, probeErr instanceof Error ? probeErr.message : "This file could not be read as audio or video.");
          return;
        }
        const row: ProjectMediaRow = {
          id: mediaId,
          project_id: project.id,
          user_id: req.user!.id,
          kind: meta.hasVideo ? "VIDEO" : "AUDIO",
          original_filename: file.originalname,
          storage_key: storageKey,
          storage_provider: "local",
          file_size: file.size,
          duration: meta.duration,
          width: meta.width,
          height: meta.height,
          video_codec: meta.videoCodec,
          audio_codec: meta.audioCodec,
          has_audio: meta.hasAudio ? 1 : 0,
          has_video: meta.hasVideo ? 1 : 0,
          container: meta.container,
          created_at: nowIso(),
        };
        getDb()
          .prepare(
            `INSERT INTO project_media (id, project_id, user_id, kind, original_filename, storage_key, storage_provider, file_size, duration, width, height, video_codec, audio_codec, has_audio, has_video, container, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(row.id, row.project_id, row.user_id, row.kind, row.original_filename, row.storage_key, row.file_size, row.duration, row.width, row.height, row.video_codec, row.audio_codec, row.has_audio, row.has_video, row.container, row.created_at);
        res.status(201).json({ media: publicMedia(row) });
      } catch (handlerErr) {
        console.error("[editor] media upload failed:", handlerErr);
        fail(500, "The upload failed on the server. Please retry.");
      }
    });
  });

  const MEDIA_CONTENT_TYPES: Record<string, string> = {
    mp4: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    ogg: "audio/ogg",
    flac: "audio/flac",
  };

  router.get("/project-media/:id/stream", requireAuth, (req: AuthedRequest, res) => {
    const media = getDb()
      .prepare("SELECT * FROM project_media WHERE id = ? AND user_id = ?")
      .get(req.params.id, req.user!.id) as ProjectMediaRow | undefined;
    if (!media || !media.storage_key || !fs.existsSync(mediaPath(media.storage_key))) {
      res.status(404).json({ error: "Media not found." });
      return;
    }
    res.type(MEDIA_CONTENT_TYPES[extensionOf(media.original_filename)] ?? "application/octet-stream");
    res.sendFile(mediaPath(media.storage_key));
  });

  router.delete("/project-media/:id", requireAuth, (req: AuthedRequest, res) => {
    const media = getDb()
      .prepare("SELECT * FROM project_media WHERE id = ? AND user_id = ?")
      .get(req.params.id, req.user!.id) as ProjectMediaRow | undefined;
    if (!media) {
      res.status(404).json({ error: "Media not found." });
      return;
    }
    if (media.storage_key) fs.rmSync(mediaPath(media.storage_key), { force: true });
    getDb().prepare("DELETE FROM project_media WHERE id = ?").run(media.id);
    res.json({ ok: true });
  });

  registerRenderRoutes(router, requireAuth);

  app.use("/api", router);
}

export const AUDIO_EXTENSIONS = ["mp3", "wav", "m4a", "ogg", "flac"];

// ---- rendering ---------------------------------------------------------------------------

const RENDER_ACTIVE = ["QUEUED", "RUNNING"] as const;

class RenderCancelled extends Error {
  constructor() {
    super("Render cancelled.");
    this.name = "RenderCancelled";
  }
}

class RenderStageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderStageError";
  }
}

const renderChildren = new Map<string, Set<ChildProcess>>();

function registerRenderChild(jobId: string, child: ChildProcess): () => void {
  let set = renderChildren.get(jobId);
  if (!set) {
    set = new Set();
    renderChildren.set(jobId, set);
  }
  set.add(child);
  return () => {
    set.delete(child);
    if (set.size === 0) renderChildren.delete(jobId);
  };
}

export function killRenderChildren(jobId: string): void {
  const set = renderChildren.get(jobId);
  if (!set) return;
  for (const child of set) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

/** Phase 9: persist REAL encoder progress (parsed from ffmpeg's own
 *  -progress output: frame / out_time / speed). The percentage is
 *  processed-duration ÷ the known duration of the media this command
 *  encodes — measured from encoder output, never from a timer. When
 *  a command's expected duration is unknown the caller passes no
 *  expectedSec and no progress is written (the UI then shows the
 *  stage, per spec §10). Writes are throttled to ~1/second. */
function writeRenderProgress(
  jobId: string,
  progress: {
    frame: number | null;
    outTimeSec: number;
    expectedSec: number;
    speed: number | null;
    /** Output frame rate of the encode when known — expectedFrames
     *  is derived from it, never invented when it is unknown. */
    fps?: number | null;
  },
): void {
  try {
    const percent =
      progress.expectedSec > 0
        ? Math.min(100, Math.round((progress.outTimeSec / progress.expectedSec) * 1000) / 10)
        : null;
    const expectedFrames =
      progress.fps && progress.fps > 0 && progress.expectedSec > 0
        ? Math.round(progress.fps * progress.expectedSec)
        : null;
    // Wall-clock time since THIS job was claimed (started_at) —
    // measured at write time from the persisted claim timestamp.
    let elapsedSec: number | null = null;
    const row = getDb()
      .prepare("SELECT started_at FROM render_jobs WHERE id = ?")
      .get(jobId) as { started_at: string | null } | undefined;
    if (row?.started_at) {
      const startedMs = Date.parse(row.started_at);
      if (Number.isFinite(startedMs)) {
        elapsedSec = Math.max(0, Math.round((Date.now() - startedMs) / 100) / 10);
      }
    }
    getDb()
      .prepare("UPDATE render_jobs SET progress_json = ?, updated_at = ? WHERE id = ?")
      .run(
        JSON.stringify({
          frame: progress.frame,
          outTimeSec: Math.round(progress.outTimeSec * 1000) / 1000,
          expectedSec: progress.expectedSec,
          expectedFrames,
          elapsedSec,
          speed: progress.speed,
          percent,
        }),
        nowIso(),
        jobId,
      );
  } catch {
    /* progress is best-effort; never fail a render over it */
  }
}

function runRenderCommand(
  jobId: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; expectedSec?: number; fps?: number | null } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    let finalArgs = args;
    if (opts.expectedSec && opts.expectedSec > 0) {
      // -progress writes machine-readable blocks to stdout. Insert
      // after the leading "-v error" every call site uses.
      const at = args[0] === "-v" && args[1] === "error" ? 2 : 0;
      finalArgs = [...args.slice(0, at), "-progress", "pipe:1", "-nostats", ...args.slice(at)];
    }
    const child = spawn("ffmpeg", finalArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: opts.cwd,
    });
    const unregister = registerRenderChild(jobId, child);
    if (opts.expectedSec && opts.expectedSec > 0) {
      const expectedSec = opts.expectedSec;
      let buf = "";
      let frame: number | null = null;
      let outTimeSec = 0;
      let speed: number | null = null;
      let lastWrite = 0;
      child.stdout.on("data", (d: Buffer) => {
        buf += d.toString("utf8");
        let nl = buf.indexOf("\n");
        while (nl >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          nl = buf.indexOf("\n");
          const eq = line.indexOf("=");
          if (eq <= 0) continue;
          const key = line.slice(0, eq);
          const value = line.slice(eq + 1);
          if (key === "frame") frame = Number(value) || null;
          else if (key === "out_time_ms") outTimeSec = (Number(value) || 0) / 1_000_000;
          else if (key === "speed") {
            const n = Number.parseFloat(value);
            speed = Number.isFinite(n) ? n : null;
          } else if (key === "progress") {
            const now = Date.now();
            if (value === "end" || now - lastWrite >= 1000) {
              lastWrite = now;
              writeRenderProgress(jobId, { frame, outTimeSec, expectedSec, speed, fps: opts.fps ?? null });
            }
          }
        }
      });
    } else {
      child.stdout.on("data", () => {
        /* drain so a chatty ffmpeg can never block on a full pipe */
      });
    }
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, opts.timeoutMs ?? 30 * 60_000);
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString("utf8")).slice(-200_000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      unregister();
      reject(new RenderStageError(`Could not run ffmpeg: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      unregister();
      if (code === 0) {
        resolve();
      } else {
        const tail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400);
        reject(new RenderStageError(`ffmpeg failed (exit ${code})${tail ? `: ${tail}` : ""}`));
      }
    });
  });
}

function renderJobById(id: string): RenderJobRow | undefined {
  return getDb().prepare("SELECT * FROM render_jobs WHERE id = ?").get(id) as RenderJobRow | undefined;
}

/** Extract one poster frame (~10% into the video) for the export
 *  queue/history cards. Deliberately NOT runRenderCommand: this is a
 *  cosmetic extra, so it resolves either way and can never fail — or
 *  cancel — the export it belongs to. */
function extractPosterFrame(videoPath: string, durationSec: number, outPath: string): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    try {
      const at = Math.max(0, Math.round(durationSec * 0.1 * 1000) / 1000);
      const child = spawn(
        "ffmpeg",
        ["-v", "error", "-y", "-ss", String(at), "-i", videoPath, "-frames:v", "1", "-q:v", "3", outPath],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        done();
      }, 30_000);
      child.on("error", () => {
        clearTimeout(timer);
        done();
      });
      child.on("close", () => {
        clearTimeout(timer);
        done();
      });
    } catch {
      done();
    }
  });
}

function isRenderCancelRequested(jobId: string): boolean {
  const row = getDb()
    .prepare("SELECT cancel_requested, status FROM render_jobs WHERE id = ?")
    .get(jobId) as { cancel_requested: number; status: string } | undefined;
  return !row || row.cancel_requested === 1 || row.status === "CANCELLED";
}

function throwIfRenderCancelled(jobId: string): void {
  if (isRenderCancelRequested(jobId)) throw new RenderCancelled();
}

function setRenderStage(jobId: string, stage: string): void {
  throwIfRenderCancelled(jobId);
  // Entering a progress-reporting pass is a pass boundary: clear
  // the previous pass's progress so a poller never reads a stale
  // ~100% from the last pass under the new stage's label (progress
  // is per-pass; the new pass writes its own as its encoder runs).
  // VERIFYING_OUTPUT reports no progress of its own, so the final
  // encode's numbers stay visible through completion.
  const resetsProgress = stage !== "VERIFYING_OUTPUT";
  getDb()
    .prepare(
      resetsProgress
        ? "UPDATE render_jobs SET stage = ?, progress_json = NULL, updated_at = ? WHERE id = ?"
        : "UPDATE render_jobs SET stage = ?, updated_at = ? WHERE id = ?",
    )
    .run(stage, nowIso(), jobId);
}

// ---- ffmpeg graph helpers -------------------------------------------------------------

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const fmt = (n: number): string => String(round3(n));

/**
 * Content rectangle for a source inside the canvas — THE shared math
 * for preview (CSS) and render (FFmpeg): crop defines the effective
 * source size, fit/fill + scale + zoom size it, x/y position it
 * (fractions of the slack, -1..1). Returns even pixel sizes.
 */
export function contentRect(
  srcW: number,
  srcH: number,
  t: TransformState,
  canvas: CanvasState,
): { rw: number; rh: number; rx: number; ry: number } {
  let ew = t.crop ? srcW * t.crop.w : srcW;
  let eh = t.crop ? srcH * t.crop.h : srcH;
  const rot = Math.abs(t.rotation % 180);
  if (rot > 45 && rot < 135) {
    const tmp = ew;
    ew = eh;
    eh = tmp;
  }
  const base = t.fit === "fill" ? Math.max(canvas.width / ew, canvas.height / eh) : Math.min(canvas.width / ew, canvas.height / eh);
  const s = base * t.scale * t.zoom;
  const rw = even(ew * s);
  const rh = even(eh * s);
  const rx = Math.round((canvas.width - rw) / 2 + (t.x * (canvas.width - rw)) / 2);
  const ry = Math.round((canvas.height - rh) / 2 + (t.y * (canvas.height - rh)) / 2);
  return { rw, rh, rx, ry };
}

/**
 * Build the video filter graph that turns input [0:v] into a
 * canvas-sized [vout] stream applying crop → rotate → scale →
 * fit/fill composition over the chosen background.
 */
function videoGraph(
  inputLabel: string,
  srcW: number,
  srcH: number,
  t: TransformState,
  canvas: CanvasState,
  backgroundFill: "blur" | "solid",
  speed: number,
): string {
  const W = canvas.width;
  const H = canvas.height;
  const { rw, rh, rx, ry } = contentRect(srcW, srcH, t, canvas);
  const parts: string[] = [];
  let cur = inputLabel;
  let n = 0;
  const step = (filter: string): string => {
    const out = `vg${n}`;
    n += 1;
    parts.push(`${cur}${filter}[${out}]`);
    cur = `[${out}]`;
    return cur;
  };
  step(`setpts=PTS/${fmt(speed)}`);
  if (t.crop) {
    const cw = even(srcW * t.crop.w);
    const ch = even(srcH * t.crop.h);
    const cx = clamp(Math.round(srcW * t.crop.x), 0, Math.max(0, srcW - cw));
    const cy = clamp(Math.round(srcH * t.crop.y), 0, Math.max(0, srcH - ch));
    step(`crop=${cw}:${ch}:${cx}:${cy}`);
  }
  if (t.rotation !== 0) {
    step(`rotate=${fmt((t.rotation * Math.PI) / 180)}:ow=rotw(iw,ih):oh=roth(iw,ih):c=black`);
  }
  const covers = rw >= W - 2 && rh >= H - 2;
  if (covers) {
    step(`scale=${rw}:${rh}`);
    const cx = clamp(-rx, 0, Math.max(0, rw - W));
    const cy = clamp(-ry, 0, Math.max(0, rh - H));
    step(`crop=${W}:${H}:${cx}:${cy}`);
  } else if (backgroundFill === "blur") {
    // Split: blurred cover background + fitted foreground.
    const bgLabel = `vg${n}`;
    const fgLabel = `vg${n + 1}`;
    n += 2;
    parts.push(`${cur}split=2[bgin][fgin]`);
    parts.push(`[bgin]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=40,setsar=1[${bgLabel}]`);
    parts.push(`[fgin]scale=${rw}:${rh},setsar=1[${fgLabel}]`);
    const out = `vg${n}`;
    n += 1;
    parts.push(`[${bgLabel}][${fgLabel}]overlay=${rx}:${ry}[${out}]`);
    cur = `[${out}]`;
  } else {
    step(`scale=${rw}:${rh}`);
    step(`pad=${W}:${H}:${rx}:${ry}:color=0x030407`);
  }
  step("fps=30");
  step("setsar=1");
  step("format=yuv420p");
  parts.push(`${cur}null[vout]`);
  return parts.join(";");
}

function atempoChain(speed: number): string {
  const parts: number[] = [];
  let f = speed;
  while (f > 2) {
    parts.push(2);
    f /= 2;
  }
  while (f < 0.5) {
    parts.push(0.5);
    f /= 0.5;
  }
  parts.push(round3(f));
  return parts.map((p) => `atempo=${p}`).join(",");
}

function audioChain(speed: number, volume: number, fadeIn: number, fadeOut: number, outDur: number): string {
  const filters = ["asetpts=PTS-STARTPTS", atempoChain(speed), `volume=${fmt(volume)}`];
  if (fadeIn > 0) filters.push(`afade=t=in:st=0:d=${fmt(Math.min(fadeIn, outDur))}`);
  if (fadeOut > 0) filters.push(`afade=t=out:st=${fmt(Math.max(0, outDur - fadeOut))}:d=${fmt(Math.min(fadeOut, outDur))}`);
  filters.push("aresample=48000", "aformat=sample_fmts=fltp:channel_layouts=stereo");
  return filters.join(",");
}

interface SegmentSpec {
  inputPath: string | null; // null = gap (solid canvas + silence)
  srcW: number;
  srcH: number;
  srcIn: number;
  srcDur: number;
  speed: number;
  transform: TransformState;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  hasAudio: boolean;
  /** Phase 8: per-item enhancement chain (scope = selected items),
   *  built by src/enhance.ts — the same builder the previews use. */
  videoChain?: string[];
}

async function renderSegment(
  jobId: string,
  spec: SegmentSpec,
  canvas: CanvasState,
  backgroundFill: "blur" | "solid",
  outPath: string,
): Promise<void> {
  const outDur = spec.srcDur / spec.speed;
  const args: string[] = ["-v", "error", "-y"];
  let graph: string;
  let videoLabel = "[vout]";
  if (spec.inputPath === null) {
    args.push("-f", "lavfi", "-i", `color=c=0x030407:s=${canvas.width}x${canvas.height}:r=30`);
    args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
    graph = "[0:v]format=yuv420p,setsar=1[vout];[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[aout]";
  } else {
    args.push("-ss", fmt(spec.srcIn), "-i", spec.inputPath);
    let video = videoGraph("[0:v]", spec.srcW, spec.srcH, spec.transform, canvas, backgroundFill, spec.speed);
    if (spec.videoChain && spec.videoChain.length > 0) {
      // videoGraph terminates at [vout]; the enhancement chain hangs
      // off it under a fresh label and the map below follows it.
      video = `${video};[vout]${spec.videoChain.join(",")}[venh]`;
      videoLabel = "[venh]";
    }
    if (spec.hasAudio) {
      graph = `${video};[0:a]${audioChain(spec.speed, spec.volume, spec.fadeIn, spec.fadeOut, outDur)}[aout]`;
    } else {
      args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
      graph = `${video};[1:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[aout]`;
    }
  }
  args.push(
    "-filter_complex", graph,
    "-map", videoLabel, "-map", "[aout]",
    "-t", fmt(outDur),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
    "-movflags", "+faststart",
    outPath,
  );
  await runRenderCommand(jobId, args, { expectedSec: outDur, fps: 30 });
}

/** Video-only overlay clip at its content-rect size, for compose-time overlay. */
async function renderOverlayClip(
  jobId: string,
  item: ItemState,
  media: ResolvedAsset,
  canvas: CanvasState,
  outPath: string,
  videoChain?: string[],
): Promise<{ rx: number; ry: number }> {
  const srcW = media.width ?? 320;
  const srcH = media.height ?? 240;
  const { rw, rh, rx, ry } = contentRect(srcW, srcH, item.transform, canvas);
  const outDur = (item.sourceOut - item.sourceIn) / item.speed;
  const parts: string[] = [];
  let cur = "[0:v]";
  let n = 0;
  const step = (filter: string) => {
    const out = `ov${n}`;
    n += 1;
    parts.push(`${cur}${filter}[${out}]`);
    cur = `[${out}]`;
  };
  step(`setpts=PTS/${fmt(item.speed)}`);
  if (item.transform.crop) {
    const c = item.transform.crop;
    const cw = even(srcW * c.w);
    const ch = even(srcH * c.h);
    const cx = clamp(Math.round(srcW * c.x), 0, Math.max(0, srcW - cw));
    const cy = clamp(Math.round(srcH * c.y), 0, Math.max(0, srcH - ch));
    step(`crop=${cw}:${ch}:${cx}:${cy}`);
  }
  if (item.transform.rotation !== 0) {
    step(`rotate=${fmt((item.transform.rotation * Math.PI) / 180)}:ow=rotw(iw,ih):oh=roth(iw,ih):c=black`);
  }
  step(`scale=${rw}:${rh}`);
  step("fps=30");
  step("setsar=1");
  step("format=yuv420p");
  // Phase 8: per-item enhancement (scope = selected items only; the
  // project scope is applied once to the composed output instead).
  if (videoChain) {
    for (const filter of videoChain) step(filter);
  }
  parts.push(`${cur}null[vout]`);
  const args = [
    "-v", "error", "-y",
    "-ss", fmt(item.sourceIn), "-i", media.path as string,
    "-filter_complex", parts.join(";"),
    "-map", "[vout]", "-an",
    "-t", fmt(outDur),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-movflags", "+faststart",
    outPath,
  ];
  await runRenderCommand(jobId, args, { expectedSec: outDur, fps: 30 });
  return { rx, ry };
}

/** Audio-only stem (music / audible overlay audio) with tempo, volume and fades applied. */
async function renderStem(
  jobId: string,
  item: ItemState,
  media: ResolvedAsset,
  outPath: string,
): Promise<void> {
  const outDur = (item.sourceOut - item.sourceIn) / item.speed;
  const args = [
    "-v", "error", "-y",
    "-ss", fmt(item.sourceIn), "-i", media.path as string,
    "-vn",
    "-af", audioChain(item.speed, item.volume, item.fadeIn, item.fadeOut, outDur),
    "-t", fmt(outDur),
    "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
    outPath,
  ];
  await runRenderCommand(jobId, args, { expectedSec: outDur });
}

// ---- job processing -------------------------------------------------------------------------
// (Caption burn-in moved to the Phase 6 ASS builder in src/captions.ts;
//  SRT/VTT text generation for export lives there too.)

/** Phase 8: enhancement snapshot carried by enhanced render jobs
 *  (created by src/broll.ts from the document's stored config). */
export interface EnhanceRenderSettings {
  video: VideoEnhanceSettings;
  audio: AudioEnhanceSettings;
  /** 'project' = chain applied once to the composed output;
   *  'items' = video chain applied per selected item while its
   *  segment/clip renders (audio chain still applies to the mix). */
  scope: "project" | "items";
  itemIds: string[];
}

interface RenderSettings {
  state: EditorState;
  timelineDuration: number;
  stateHash: string;
  /** Phase 7: present on reframe renders created by tracking.ts. */
  reframe?: ReframeRenderPayload | null;
  /** Phase 8: present on enhanced renders created by broll.ts. */
  enhance?: EnhanceRenderSettings | null;
  /** Phase 9: present on export jobs created by export.ts. The
   *  composition above is unchanged; the export block drives the
   *  final ENCODING pass (container/codecs/quality/audio), the QC
   *  extension and the export_outputs/history records. */
  export?: ExportSettings | null;
  /** Migration v10: the export target this job was created from
   *  (kind + id), copied onto the export_outputs history row so a
   *  finished export remembers what it was made from. */
  target?: { kind: string; id: string | null } | null;
}

export function timelineDurationOf(state: EditorState): number {
  const mainTrackIds = new Set(state.tracks.filter((t) => t.kind === "main").map((t) => t.id));
  let end = 0;
  for (const item of state.items) {
    if (mainTrackIds.has(item.trackId)) end = Math.max(end, item.start + item.duration);
  }
  return round3(end);
}

function trackAudible(state: EditorState, track: TrackState): boolean {
  const audioKinds: TrackState["kind"][] = ["main", "broll", "audio", "overlay"];
  const anySolo = state.tracks.some((t) => audioKinds.includes(t.kind) && t.solo);
  if (anySolo) return track.solo;
  return !track.muted;
}

interface MainPiece {
  spec: SegmentSpec;
}

function buildMainPieces(
  userId: string,
  projectId: string,
  state: EditorState,
  transcriptSourceId: string | null,
  reframe?: {
    sourceAssetId: string;
    intervals: {
      start: number;
      end: number;
      crop: { x: number; y: number; w: number; h: number } | null;
      fit: "fill" | "fit";
    }[];
  } | null,
  /** Phase 8: per-item enhancement chain resolver (items scope). */
  videoChainFor?: ((item: ItemState) => string[] | undefined) | null,
): MainPiece[] {
  const mainTracks = state.tracks.filter((t) => t.kind === "main");
  const mainTrack = mainTracks[0];
  if (!mainTrack) return [];
  const pieces: MainPiece[] = [];
  if (!mainTrack.visible) {
    const total = timelineDurationOf(state);
    if (total > 0) {
      pieces.push({
        spec: {
          inputPath: null, srcW: state.canvas.width, srcH: state.canvas.height,
          srcIn: 0, srcDur: total, speed: 1, transform: { ...DEFAULT_TRANSFORM },
          volume: 0, fadeIn: 0, fadeOut: 0, hasAudio: false,
        },
      });
    }
    return pieces;
  }
  const audible = trackAudible(state, mainTrack);
  const items = state.items
    .filter((i) => i.trackId === mainTrack.id)
    .sort((a, b) => a.start - b.start || a.layerOrder - b.layerOrder);
  let cursor = 0;
  for (const item of items) {
    const media = resolveAsset(userId, projectId, item.assetKind, item.assetId);
    if (!media || !media.path) {
      throw new RenderStageError(`A main-track clip (asset ${item.assetId}) is missing its media file.`);
    }
    if (item.start > cursor + 0.02) {
      pieces.push({
        spec: {
          inputPath: null, srcW: state.canvas.width, srcH: state.canvas.height,
          srcIn: 0, srcDur: item.start - cursor, speed: 1, transform: { ...DEFAULT_TRANSFORM },
          volume: 0, fadeIn: 0, fadeOut: 0, hasAudio: false,
        },
      });
    }
    // Sub-divide at scene-override boundaries (source-time ranges).
    const bounds = [item.sourceIn, item.sourceOut];
    if (transcriptSourceId && media.underlyingSourceId === transcriptSourceId) {
      for (const ov of state.sceneOverrides) {
        if (ov.rangeStart > item.sourceIn && ov.rangeStart < item.sourceOut) bounds.push(ov.rangeStart);
        if (ov.rangeEnd > item.sourceIn && ov.rangeEnd < item.sourceOut) bounds.push(ov.rangeEnd);
      }
    }
    // Phase 7: sub-divide at reframe interval boundaries too (source
    // time) when this item's media is the tracked source asset.
    const reframeHere = Boolean(
      reframe && media.underlyingSourceId === reframe.sourceAssetId,
    );
    if (reframeHere && reframe) {
      for (const iv of reframe.intervals) {
        if (iv.start > item.sourceIn && iv.start < item.sourceOut) bounds.push(iv.start);
      }
    }
    const unique = [...new Set(bounds.map((b) => round3(b)))].sort((a, b) => a - b);
    for (let k = 0; k + 1 < unique.length; k += 1) {
      const a = unique[k];
      const b = unique[k + 1];
      if (b - a < 0.01) continue;
      const mid = (a + b) / 2;
      let transform = item.transform;
      if (reframeHere && reframe) {
        // The tracking crop REPLACES the item/scene-override transform
        // for this sub-piece: it is computed from the same persisted
        // keyframes the preview shows, and scene-level tracking
        // overrides are already baked into those keyframes.
        const iv =
          reframe.intervals.find((x) => x.start <= mid && mid < x.end) ??
          reframe.intervals[reframe.intervals.length - 1];
        if (iv) {
          transform =
            iv.fit === "fit"
              ? { ...DEFAULT_TRANSFORM, fit: "fit" }
              : { ...DEFAULT_TRANSFORM, fit: "fill", crop: iv.crop };
        }
      } else if (transcriptSourceId && media.underlyingSourceId === transcriptSourceId) {
        const active = [...state.sceneOverrides]
          .reverse()
          .find((ov) => ov.rangeStart <= mid && mid < ov.rangeEnd);
        if (active) {
          transform = { ...item.transform, ...active.overrides };
        }
      }
      const isFirst = k === 0;
      const isLast = k + 2 === unique.length;
      pieces.push({
        spec: {
          inputPath: mediaPath(media.path),
          srcW: media.width ?? 320,
          srcH: media.height ?? 240,
          srcIn: a,
          srcDur: b - a,
          speed: item.speed,
          transform,
          volume: audible ? item.volume : 0,
          fadeIn: isFirst ? item.fadeIn : 0,
          fadeOut: isLast ? item.fadeOut : 0,
          hasAudio: media.hasAudio,
          videoChain: videoChainFor ? videoChainFor(item) : undefined,
        },
      });
    }
    cursor = Math.max(cursor, item.start + item.duration);
  }
  return pieces;
}

/**
 * Phase 7 split screen: render the full timeline once per region —
 * each region with its own subject's crop path at the region's canvas
 * size — then stack the region videos with xstack. Every region video
 * carries an audio track (renderSegment synthesises silence for gaps),
 * and the composed output takes region 0's audio, which is the main
 * track's own mix. Overlays, stems and captions then apply as usual.
 */
async function buildSplitBasePath(
  jobId: string,
  job: RenderJobRow,
  settings: RenderSettings,
  jobDir: string,
): Promise<string> {
  const split = settings.reframe!.split!;
  const state = settings.state;
  const canvas = state.canvas;
  const regionPaths: string[] = [];
  for (let r = 0; r < split.regions.length; r += 1) {
    const region = split.regions[r]!;
    const rw = Math.max(16, Math.round((region.rect.w * canvas.width) / 2) * 2);
    const rh = Math.max(16, Math.round((region.rect.h * canvas.height) / 2) * 2);
    const regionCanvas: CanvasState = { aspect: "custom", width: rw, height: rh, custom: true };
    const pieces = buildMainPieces(job.user_id, job.project_id, state, null, {
      sourceAssetId: settings.reframe!.sourceAssetId,
      intervals: region.intervals,
    });
    if (pieces.length === 0) {
      throw new RenderStageError("A split-screen region has no timeline content to render.");
    }
    const segPaths: string[] = [];
    for (let i = 0; i < pieces.length; i += 1) {
      throwIfRenderCancelled(jobId);
      const segPath = path.join(jobDir, `split-${r}-seg-${String(i).padStart(3, "0")}.mp4`);
      await renderSegment(jobId, pieces[i]!.spec, regionCanvas, state.settings.backgroundFill, segPath);
      segPaths.push(segPath);
    }
    let regionPath = segPaths[0]!;
    if (segPaths.length > 1) {
      regionPath = path.join(jobDir, `split-${r}.mp4`);
      const listPath = path.join(jobDir, `split-${r}-concat.txt`);
      fs.writeFileSync(listPath, segPaths.map((p) => `file '${p}'`).join("\n"));
      await runRenderCommand(jobId, [
        "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", listPath,
        "-c", "copy", "-movflags", "+faststart", regionPath,
      ]);
    }
    regionPaths.push(regionPath);
  }
  if (regionPaths.length === 1) return regionPaths[0]!;
  const outPath = path.join(jobDir, "split-base.mp4");
  const args: string[] = ["-v", "error", "-y"];
  for (const p of regionPaths) args.push("-i", p);
  const layout = split.regions
    .map((reg) => `${Math.round(reg.rect.x * canvas.width)}_${Math.round(reg.rect.y * canvas.height)}`)
    .join("|");
  const inputs = regionPaths.map((_, i) => `[${i}:v]`).join("");
  args.push(
    "-filter_complex", `${inputs}xstack=inputs=${regionPaths.length}:layout=${layout}:fill=black[vout]`,
    "-map", "[vout]", "-map", "0:a",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
    "-movflags", "+faststart", outPath,
  );
  await runRenderCommand(jobId, args);
  return outPath;
}

// ---- Phase 9 export helpers -------------------------------------------------
// The composition pipeline above is format-agnostic (always the same
// intermediate MP4). Everything Phase 9 adds happens AFTER it: a final
// ENCODING pass to the requested container/codecs/quality, an extended
// QC gate, and the export history records. Plain Phase 5–8 renders
// (settings.export absent) skip every branch below, byte for byte.

const EXPORT_VIDEO_CODEC_NAMES: Record<string, string> = {
  libx264: "h264",
  libx265: "hevc",
  libvpx: "vp9",
  "libvpx-vp9": "vp9",
};
const EXPORT_AUDIO_CODEC_NAMES: Record<string, string> = {
  aac: "aac",
  libopus: "opus",
  libmp3lame: "mp3",
};
/** CRF per quality preset (x264/x265 scale; VP9 uses its own). */
const EXPORT_QUALITY_CRF: Record<string, { avc: number; vp9: number }> = {
  low: { avc: 28, vp9: 42 },
  standard: { avc: 23, vp9: 34 },
  high: { avc: 18, vp9: 27 },
  maximum: { avc: 14, vp9: 20 },
};

function exportFileExtension(exp: ExportSettings): string {
  if (exp.audioOnly) {
    if (exp.audioCodec === "libmp3lame") return "mp3";
    if (exp.audioCodec === "libopus") return "opus";
    return "m4a";
  }
  return exp.container;
}

function recordValidation(
  jobId: string,
  userId: string,
  phase: "PREFLIGHT" | "QC",
  ok: boolean,
  checks: { id: string; ok: boolean; detail: string }[],
): void {
  try {
    getDb()
      .prepare(
        "INSERT INTO render_validation_results (id, job_id, user_id, phase, ok, checks_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(newId(), jobId, userId, phase, ok ? 1 : 0, JSON.stringify(checks), nowIso());
  } catch {
    /* diagnostics are best-effort; the job outcome never depends on them */
  }
}

function recordRenderError(jobId: string, userId: string, stage: string, message: string): void {
  try {
    getDb()
      .prepare("INSERT INTO render_error_log (id, job_id, user_id, stage, message, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(newId(), jobId, userId, stage, message.slice(0, 1000), nowIso());
  } catch {
    /* best-effort, as above */
  }
}

/** Capture an ffmpeg run's stdout as a Buffer (frame grabs for QC). */
function runCapture(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString("utf8")).slice(-20_000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg capture failed (exit ${code}): ${stderr.trim().split("\n").slice(-2).join(" ")}`));
    });
  });
}

/** Gray frame (scaled down) at time t as raw bytes + dimensions. */
async function grayFrame(file: string, tSec: number, width: number): Promise<{ data: Buffer; w: number; h: number }> {
  const meta = await probeAnyFile(file);
  const srcW = meta.width ?? width;
  const srcH = meta.height ?? Math.round(width * 0.5625);
  const h = Math.max(2, Math.round((width * srcH) / srcW / 2) * 2);
  const data = await runCapture([
    "-v", "error", "-ss", String(Math.max(0, tSec)), "-i", file,
    "-frames:v", "1", "-vf", `scale=${width}:${h},format=gray`, "-f", "rawvideo", "-",
  ]);
  return { data, w: width, h };
}

/**
 * Phase 9 QC caption check: when captions were burned in, the burned
 * frame must actually differ from the same frame of the pre-burn
 * composition in at least one horizontal third (captions sit at the
 * top, middle or bottom depending on the style; caption glyphs are
 * strong local changes, encoder generation noise is not). Both
 * files are crf-20 encodes of the same frames, so this comparison is
 * between near-identical pictures. Returns null when the comparison
 * cannot run, true/false when it can.
 */
async function captionsVisuallyPresent(
  preBurnPath: string,
  burnedPath: string,
  atSec: number,
): Promise<boolean | null> {
  if (!fs.existsSync(preBurnPath) || !fs.existsSync(burnedPath)) return null;
  const a = await grayFrame(preBurnPath, atSec, 320);
  const b = await grayFrame(burnedPath, atSec, 320);
  if (a.data.length === 0 || a.data.length !== b.data.length || a.w !== b.w || a.h !== b.h) return null;
  for (let third = 0; third < 3; third += 1) {
    const from = Math.floor((a.data.length / 3) * third);
    const to = Math.floor((a.data.length / 3) * (third + 1));
    let strong = 0;
    for (let i = from; i < to; i += 1) {
      if (Math.abs(a.data[i]! - b.data[i]!) > 30) strong += 1;
    }
    if (to > from && strong / (to - from) > 0.0005) return true;
  }
  return false;
}

async function processRenderJob(jobId: string): Promise<void> {
  const db = getDb();
  const jobDir = path.join(config.processingDir, "renders", jobId);
  // Phase 9: hoisted so the failure path can record export diagnostics.
  let exportSettings: ExportSettings | null = null;
  // Migration v10: the export target, copied onto the history row.
  let exportTarget: { kind: string; id: string | null } | null = null;
  try {
    const job = renderJobById(jobId);
    if (!job) return;
    const settings = parseJson<RenderSettings | null>(job.settings_json, null);
    if (!settings || !settings.state) throw new RenderStageError("Render job has no timeline snapshot.");
    exportSettings = settings.export ?? null;
    exportTarget = settings.target ?? null;
    let state = settings.state;
    // Non-export renders have no creation-time preflight (the export
    // gate lives in export.ts and is re-checked below), so validate
    // the stored snapshot before anything is rendered from it: an
    // invalid state fails the job with the reason instead of being
    // rendered silently. The validated (normalised) state is what
    // gets rendered.
    if (!exportSettings) {
      const checked = validateState(job.user_id, job.project_id, state);
      if (!checked.ok) {
        throw new RenderStageError(`The saved timeline is not valid: ${checked.error}`);
      }
      state = checked.state;
    }
    const canvas = state.canvas;
    const timelineDuration = timelineDurationOf(state);
    if (timelineDuration <= 0) {
      throw new RenderStageError("The timeline has no main-track clips to render.");
    }
    const project = ownedProject(job.user_id, job.project_id);
    if (!project) throw new RenderStageError("Project no longer exists.");

    // Phase 9 run-time preflight (the creation-time preflight in
    // export.ts is the primary gate; this re-check runs while the job
    // is still in VALIDATING so a source deleted after queueing fails
    // here with diagnostics, never mid-render).
    if (exportSettings) {
      const missing: string[] = [];
      for (const item of state.items) {
        const media = resolveAsset(job.user_id, job.project_id, item.assetKind, item.assetId);
        if (!media || !media.path || !fs.existsSync(mediaPath(media.path))) {
          missing.push(`timeline item ${item.id} (asset ${item.assetId}) has no readable media file`);
        }
      }
      if (missing.length > 0) {
        recordValidation(jobId, job.user_id, "PREFLIGHT", false, [
          { id: "assets-exist", ok: false, detail: missing.join("; ") },
        ]);
        throw new RenderStageError(`Preflight failed: ${missing.join("; ")}.`);
      }
    }

    fs.mkdirSync(jobDir, { recursive: true });

    // PREPARING: normalized main-track segments.
    setRenderStage(jobId, "PREPARING");
    const transcript = db
      .prepare("SELECT * FROM transcripts WHERE project_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(job.project_id) as TranscriptRow | undefined;
    const reframe = settings.reframe ?? null;
    // Phase 8: enhancement snapshot (null on plain/reframe renders).
    // Chains come from src/enhance.ts — the same builder the preview
    // jobs use, so preview and export cannot drift apart.
    const enhance = settings.enhance ?? null;
    const itemVideoChain = (item: ItemState): string[] | undefined => {
      if (!enhance || enhance.scope !== "items" || !enhance.itemIds.includes(item.id)) {
        return undefined;
      }
      const chain = buildVideoChain(enhance.video, { includeUpscale: false });
      return chain.length > 0 ? chain : undefined;
    };
    let basePath: string;
    if (reframe?.split) {
      basePath = await buildSplitBasePath(jobId, job, settings, jobDir);
    } else {
      const pieces = buildMainPieces(
        job.user_id,
        job.project_id,
        state,
        transcript?.source_asset_id ?? null,
        reframe
          ? { sourceAssetId: reframe.sourceAssetId, intervals: reframe.intervals }
          : null,
        enhance ? itemVideoChain : null,
      );
      if (pieces.length === 0) throw new RenderStageError("The timeline has no main-track clips to render.");
      const segmentPaths: string[] = [];
      for (let i = 0; i < pieces.length; i += 1) {
        throwIfRenderCancelled(jobId);
        const segPath = path.join(jobDir, `seg-${String(i).padStart(3, "0")}.mp4`);
        await renderSegment(jobId, pieces[i]!.spec, canvas, state.settings.backgroundFill, segPath);
        segmentPaths.push(segPath);
      }
      basePath = segmentPaths[0]!;
      if (segmentPaths.length > 1) {
        basePath = path.join(jobDir, "base.mp4");
        const listPath = path.join(jobDir, "concat.txt");
        fs.writeFileSync(listPath, segmentPaths.map((p) => `file '${p}'`).join("\n"));
        await runRenderCommand(jobId, [
          "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", listPath,
          "-c", "copy", "-movflags", "+faststart", basePath,
        ]);
      }
    }

    // Overlay clips (b-roll + overlay tracks) and audio stems.
    const overlayInputs: { path: string; item: ItemState; rx: number; ry: number }[] = [];
    /** `duck` marks stems from the music/audio track — the only stems
     *  Phase 8 ducking may compress (never the speaker's own audio). */
    const stemInputs: { path: string; start: number; duck: boolean }[] = [];
    const overlayTracks = state.tracks
      .filter((t) => t.kind === "broll" || t.kind === "overlay")
      .sort((a, b) => a.order - b.order);
    for (const track of overlayTracks) {
      const items = state.items
        .filter((i) => i.trackId === track.id)
        .sort((a, b) => a.layerOrder - b.layerOrder || a.start - b.start);
      for (const item of items) {
        throwIfRenderCancelled(jobId);
        const media = resolveAsset(job.user_id, job.project_id, item.assetKind, item.assetId);
        if (!media || !media.path) {
          throw new RenderStageError(`An overlay clip (asset ${item.assetId}) is missing its media file.`);
        }
        if (track.visible && media.hasVideo) {
          const clipPath = path.join(jobDir, `ov-${item.id}.mp4`);
          const { rx, ry } = await renderOverlayClip(
            jobId, item, { ...media, path: mediaPath(media.path) }, canvas, clipPath,
            enhance ? itemVideoChain(item) : undefined,
          );
          overlayInputs.push({ path: clipPath, item, rx, ry });
        }
        if (trackAudible(state, track) && media.hasAudio && item.volume > 0) {
          const stemPath = path.join(jobDir, `stem-${item.id}.m4a`);
          await renderStem(jobId, item, { ...media, path: mediaPath(media.path) }, stemPath);
          stemInputs.push({ path: stemPath, start: item.start, duck: false });
        }
      }
    }
    const audioTracks = state.tracks.filter((t) => t.kind === "audio");
    for (const track of audioTracks) {
      if (!trackAudible(state, track)) continue;
      const items = state.items.filter((i) => i.trackId === track.id).sort((a, b) => a.start - b.start);
      for (const item of items) {
        throwIfRenderCancelled(jobId);
        const media = resolveAsset(job.user_id, job.project_id, item.assetKind, item.assetId);
        if (!media || !media.path || !media.hasAudio) {
          throw new RenderStageError(`A music/audio clip (asset ${item.assetId}) is missing its audio file.`);
        }
        const stemPath = path.join(jobDir, `stem-${item.id}.m4a`);
        await renderStem(jobId, item, { ...media, path: mediaPath(media.path) }, stemPath);
        stemInputs.push({ path: stemPath, start: item.start, duck: true });
      }
    }

    // COMPOSING: overlays + audio mixdown.
    setRenderStage(jobId, "COMPOSING");
    const composedPath = path.join(jobDir, "composed.mp4");
    {
      const args: string[] = ["-v", "error", "-y", "-i", basePath];
      for (const ov of overlayInputs) args.push("-i", ov.path);
      for (const stem of stemInputs) args.push("-i", stem.path);
      const graphParts: string[] = [];
      let videoMap = "0:v";
      if (overlayInputs.length > 0) {
        let cur = "[0:v]";
        overlayInputs.forEach((ov, idx) => {
          const out = idx === overlayInputs.length - 1 ? "[vout]" : `[ovc${idx}]`;
          // Phase 8: B-roll/overlay opacity + alpha fades. The
          // intermediate clips are yuv420p (no alpha), so the alpha
          // channel is synthesised HERE in the compose graph — the
          // overlay filter then blends with real transparency.
          const opacity = ov.item.transform.opacity ?? 1;
          let srcLabel = `[${idx + 1}:v]`;
          if (opacity < 1 || ov.item.fadeIn > 0 || ov.item.fadeOut > 0) {
            const pre: string[] = ["format=yuva420p"];
            if (ov.item.fadeIn > 0) {
              pre.push(`fade=t=in:st=0:d=${fmt(Math.min(ov.item.fadeIn, ov.item.duration))}:alpha=1`);
            }
            if (ov.item.fadeOut > 0) {
              const d = Math.min(ov.item.fadeOut, ov.item.duration);
              pre.push(`fade=t=out:st=${fmt(Math.max(0, ov.item.duration - d))}:d=${fmt(d)}:alpha=1`);
            }
            if (opacity < 1) pre.push(`colorchannelmixer=aa=${fmt(opacity)}`);
            graphParts.push(`${srcLabel}${pre.join(",")}[ovp${idx}]`);
            srcLabel = `[ovp${idx}]`;
          }
          graphParts.push(
            `${cur}${srcLabel}overlay=${ov.rx}:${ov.ry}:enable='between(t,${fmt(ov.item.start)},${fmt(ov.item.start + ov.item.duration)})'${out}`,
          );
          cur = out;
        });
        videoMap = "[vout]";
      }
      let audioMap = "0:a";
      if (stemInputs.length > 0) {
        const ducking = enhance?.audio.ducking.enabled
          ? { filter: duckingFilter(enhance.audio.ducking.amount) }
          : null;
        const duckStems = stemInputs.map((s, i) => ({ ...s, idx: i })).filter((s) => s.duck);
        const useDucking = Boolean(ducking && duckStems.length > 0);
        const labels: string[] = [];
        const mixIns: string[] = [];
        if (useDucking && ducking) {
          // Speech (base) is split: one copy stays in the mix, the
          // other drives the sidechain that ducks the music stems.
          labels.push("[0:a]aresample=48000,asplit=2[abase][aside]");
          mixIns.push("[abase]");
          const musicLabels: string[] = [];
          duckStems.forEach((stem) => {
            const inputIdx = overlayInputs.length + 1 + stem.idx;
            labels.push(
              `[${inputIdx}:a]aresample=48000,adelay=${Math.round(stem.start * 1000)}:all=1[stm${stem.idx}]`,
            );
            musicLabels.push(`[stm${stem.idx}]`);
          });
          if (musicLabels.length > 1) {
            labels.push(`${musicLabels.join("")}amix=inputs=${musicLabels.length}:duration=first:normalize=0[musicmix]`);
          } else {
            labels.push(`${musicLabels[0]}anull[musicmix]`);
          }
          labels.push(`[musicmix][aside]${ducking.filter}[ducked]`);
          mixIns.push("[ducked]");
          stemInputs.forEach((stem, idx) => {
            if (stem.duck) return;
            const inputIdx = overlayInputs.length + 1 + idx;
            labels.push(
              `[${inputIdx}:a]aresample=48000,adelay=${Math.round(stem.start * 1000)}:all=1[stm${idx}]`,
            );
            mixIns.push(`[stm${idx}]`);
          });
        } else {
          labels.push("[0:a]aresample=48000[abase]");
          mixIns.push("[abase]");
          stemInputs.forEach((stem, idx) => {
            const inputIdx = overlayInputs.length + 1 + idx;
            labels.push(
              `[${inputIdx}:a]aresample=48000,adelay=${Math.round(stem.start * 1000)}:all=1[stm${idx}]`,
            );
            mixIns.push(`[stm${idx}]`);
          });
        }
        graphParts.push(labels.join(";"));
        graphParts.push(`${mixIns.join("")}amix=inputs=${mixIns.length}:duration=first:normalize=0[aout]`);
        audioMap = "[aout]";
      }
      if (graphParts.length > 0) args.push("-filter_complex", graphParts.join(";"));
      args.push(
        "-map", videoMap, "-map", audioMap,
        "-t", fmt(timelineDuration),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
        "-movflags", "+faststart",
        composedPath,
      );
      await runRenderCommand(jobId, args, { expectedSec: timelineDuration, fps: 30 });
    }

    // Phase 8: document-level enhancement pass. Project scope applies
    // the video chain ONCE here to the flattened composition (the
    // items scope already applied it per item while segments/clips
    // rendered); the audio chain always applies here because it is a
    // mix-level operation. The same src/enhance.ts builders produced
    // the before/after previews, so preview and export cannot drift.
    // Output replaces composed.mp4 so caption burn-in + verification
    // downstream are untouched. Upscaling is excluded on purpose:
    // timeline renders are governed by the canvas (verified below).
    if (enhance) {
      const vChain =
        enhance.scope === "project"
          ? buildVideoChain(enhance.video, { includeUpscale: false })
          : [];
      const aChain = buildAudioChain(enhance.audio, timelineDuration);
      if (vChain.length > 0 || aChain.length > 0) {
        setRenderStage(jobId, "ENHANCING");
        const enhancedPath = path.join(jobDir, "enhanced.mp4");
        const parts: string[] = [];
        if (vChain.length > 0) parts.push(`[0:v]${vChain.join(",")}[v]`);
        if (aChain.length > 0) parts.push(`[0:a]${aChain.join(",")}[a]`);
        const args = ["-v", "error", "-y", "-i", composedPath];
        if (parts.length > 0) args.push("-filter_complex", parts.join(";"));
        args.push(
          "-map", vChain.length > 0 ? "[v]" : "0:v",
          "-map", aChain.length > 0 ? "[a]" : "0:a",
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
          "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
          "-movflags", "+faststart",
          enhancedPath,
        );
        await runRenderCommand(jobId, args, { expectedSec: timelineDuration, fps: 30 });
        fs.renameSync(enhancedPath, composedPath);
      }
    }

    // Caption burn-in (Phase 6: libass over a generated .ass file so
    // the document's caption style — font, colours, highlight,
    // background, position, karaoke/highlight animation, per-segment
    // overrides — is exactly what renders; see src/captions.ts).
    let finalPath = composedPath;
    if (state.settings.showCaptions && state.captions.some((c) => c.text.trim().length > 0)) {
      setRenderStage(jobId, "RENDERING_CAPTIONS");
      const assPath = path.join(jobDir, "captions.ass");
      const captionLanguage =
        state.captions.find((c) => c.text.trim().length > 0)?.language ?? null;
      fs.writeFileSync(
        assPath,
        buildAss(state.captions, state.settings.captionStyle, canvas, captionLanguage),
        "utf8",
      );
      const burnedPath = path.join(jobDir, "final.mp4");
      await runRenderCommand(
        jobId,
        [
          "-v", "error", "-y",
          "-i", "composed.mp4",
          "-vf", "subtitles=captions.ass",
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
          "-c:a", "copy",
          "-movflags", "+faststart",
          "final.mp4",
        ],
        { cwd: jobDir, expectedSec: timelineDuration, fps: 30 },
      );
      finalPath = burnedPath;
    }

    // Phase 9 ENCODING: export jobs get one final encode from the
    // composed/burned master to the requested container, codecs,
    // quality and audio settings. Plain renders skip this entirely —
    // their master IS the deliverable, exactly as Phases 5–8 shipped.
    let deliverPath = finalPath;
    let deliverExt = "mp4";
    if (exportSettings) {
      const exp = exportSettings;
      deliverExt = exportFileExtension(exp);
      setRenderStage(jobId, "ENCODING");
      const encodedPath = path.join(jobDir, `export.${deliverExt}`);
      const args: string[] = ["-v", "error", "-y", "-i", finalPath];
      const audioExpected =
        exp.includeOriginalAudio || exp.includeMusic || exp.includeBrollAudio;
      if (exp.audioOnly) {
        args.push("-vn");
      } else {
        if (exp.fps) args.push("-vf", `fps=${exp.fps}`);
        if (exp.videoCodec === "libvpx-vp9") {
          args.push("-c:v", "libvpx-vp9", "-deadline", "good");
          const cpuUsedMap: Record<string, number> = {
            ultrafast: 5, superfast: 5, veryfast: 4, faster: 3, fast: 2, medium: 1, slow: 0,
          };
          args.push("-cpu-used", String(cpuUsedMap[exp.encoderPreset] ?? 4));
          if (exp.qualityMode === "bitrate" && exp.videoBitrateKbps) {
            args.push("-b:v", `${exp.videoBitrateKbps}k`);
          } else {
            const crf =
              exp.qualityMode === "crf" && exp.crf !== null
                ? exp.crf
                : EXPORT_QUALITY_CRF[exp.qualityPreset]!.vp9;
            args.push("-crf", String(crf), "-b:v", "0");
          }
        } else {
          args.push("-c:v", exp.videoCodec, "-preset", exp.encoderPreset);
          if (exp.qualityMode === "bitrate" && exp.videoBitrateKbps) {
            args.push("-b:v", `${exp.videoBitrateKbps}k`);
          } else {
            const crf =
              exp.qualityMode === "crf" && exp.crf !== null
                ? exp.crf
                : EXPORT_QUALITY_CRF[exp.qualityPreset]!.avc;
            args.push("-crf", String(crf));
          }
          if (exp.videoCodec === "libx265" && exp.container === "mp4") args.push("-tag:v", "hvc1");
        }
        if (exp.keyframeInterval) {
          args.push("-g", String(Math.max(1, Math.round((exp.fps ?? 30) * exp.keyframeInterval))));
        }
      }
      if (!audioExpected) {
        args.push("-an");
      } else {
        if (exp.normalizeAudio) args.push("-af", "loudnorm=I=-16:TP=-1.5:LRA=11");
        args.push(
          "-c:a", exp.audioCodec,
          "-b:a", `${exp.audioBitrateKbps}k`,
          "-ar", String(exp.audioSampleRate),
          "-ac", String(exp.audioChannels),
        );
      }
      if (!exp.audioOnly && exp.container === "mp4") args.push("-movflags", "+faststart");
      args.push(encodedPath);
      await runRenderCommand(jobId, args, { expectedSec: timelineDuration, fps: exp.fps ?? 30 });
      deliverPath = encodedPath;
    }

    // VERIFYING: FFprobe the real output before claiming success.
    setRenderStage(jobId, "VERIFYING_OUTPUT");
    const probe = await probeAnyFile(deliverPath);
    const deliverSize = fs.existsSync(deliverPath) ? fs.statSync(deliverPath).size : 0;
    const problems: string[] = [];
    const qcChecks: { id: string; ok: boolean; detail: string }[] = [];
    const qc = (id: string, ok: boolean, detail: string) => {
      qcChecks.push({ id, ok, detail });
      if (!ok) problems.push(detail);
    };
    if (exportSettings?.audioOnly) {
      qc("audio-stream", probe.hasAudio, probe.hasAudio ? "audio stream present" : "output has no audio stream");
      qc("no-video", !probe.hasVideo, probe.hasVideo ? "audio-only export unexpectedly contains video" : "no video stream, as requested");
    } else {
      qc("video-stream", probe.hasVideo, probe.hasVideo ? "video stream present" : "output has no video stream");
      if (probe.width !== canvas.width || probe.height !== canvas.height) {
        qc("resolution", false, `output resolution ${probe.width}×${probe.height} does not match the canvas ${canvas.width}×${canvas.height}`);
      } else {
        qc("resolution", true, `resolution ${probe.width}×${probe.height} matches the export canvas`);
      }
      const audioExpected = exportSettings
        ? exportSettings.includeOriginalAudio || exportSettings.includeMusic || exportSettings.includeBrollAudio
        : true;
      if (audioExpected) {
        qc("audio-stream", probe.hasAudio, probe.hasAudio ? "audio stream present" : "output has no audio stream");
      } else {
        qc("audio-stream", !probe.hasAudio, probe.hasAudio ? "audio was included despite every include toggle being off" : "no audio stream, as configured");
      }
    }
    if (probe.duration === null || Math.abs(probe.duration - timelineDuration) > 1.0) {
      qc("duration", false, `output duration ${probe.duration ?? "?"}s differs from the timeline duration ${timelineDuration}s`);
    } else {
      qc("duration", true, `duration ${probe.duration}s within tolerance of ${timelineDuration}s`);
    }
    if (exportSettings) {
      const exp = exportSettings;
      qc("file-size", deliverSize >= 1024, `output size ${deliverSize} bytes${deliverSize >= 1024 ? "" : " — unexpectedly empty"}`);
      if (!exp.audioOnly) {
        const wantVideo = EXPORT_VIDEO_CODEC_NAMES[exp.videoCodec];
        qc(
          "video-codec",
          probe.videoCodec === wantVideo,
          `video codec ${probe.videoCodec ?? "none"}${probe.videoCodec === wantVideo ? "" : `, expected ${wantVideo}`}`,
        );
        const wantContainer = exp.container === "webm" ? "webm" : "mp4";
        qc(
          "container",
          (probe.container ?? "").includes(wantContainer),
          `container ${probe.container ?? "unknown"}`,
        );
      }
      const audioExpected = exp.includeOriginalAudio || exp.includeMusic || exp.includeBrollAudio;
      if (audioExpected) {
        const wantAudio = EXPORT_AUDIO_CODEC_NAMES[exp.audioCodec];
        qc(
          "audio-codec",
          probe.audioCodec === wantAudio,
          `audio codec ${probe.audioCodec ?? "none"}${probe.audioCodec === wantAudio ? "" : `, expected ${wantAudio}`}`,
        );
      }
      if (exp.captionMode === "burn" && state.captions.some((c) => c.text.trim().length > 0)) {
        const first = state.captions.find((c) => c.text.trim().length > 0)!;
        // Compare the burned MASTER against the pre-burn composition:
        // both are crf-20 encodes of the same frames, so the only
        // strong pixel differences are the caption glyphs themselves.
        const visible = await captionsVisuallyPresent(
          composedPath,
          finalPath,
          (first.start + first.end) / 2,
        ).catch(() => null);
        qc(
          "captions-burned",
          visible === true,
          visible === true
            ? "caption pixels verified in the output frame"
            : "caption burn-in could not be visually verified in the output frame",
        );
      }
    }
    if (problems.length > 0) {
      if (exportSettings) {
        recordValidation(jobId, job.user_id, "QC", false, qcChecks);
        // Keep the failed output isolated for diagnosis — never in
        // the downloadable renders directory.
        try {
          const failedRel = `${job.user_id}/renders/failed/${jobId}.${deliverExt}`;
          fs.mkdirSync(path.dirname(mediaPath(failedRel)), { recursive: true });
          if (fs.existsSync(deliverPath)) fs.copyFileSync(deliverPath, mediaPath(failedRel));
        } catch {
          /* isolation is best-effort */
        }
      }
      throw new RenderStageError(`Output verification failed: ${problems.join("; ")}.`);
    }
    if (exportSettings) recordValidation(jobId, job.user_id, "QC", true, qcChecks);

    const outputRel = `${job.user_id}/renders/${jobId}.${deliverExt}`;
    fs.mkdirSync(path.dirname(mediaPath(outputRel)), { recursive: true });
    fs.copyFileSync(deliverPath, mediaPath(outputRel));

    // Phase 9 sidecars + bundle (spec §6/§19): separate subtitle
    // files are generated from the SAME caption state the burn-in
    // used, and a bundle zips video + subtitles under the export's
    // display filename so the download is one self-contained file.
    // deliverRel/storedSize track what is actually stored as THE
    // deliverable: the video file normally, the ZIP for bundles.
    let deliverRel = outputRel;
    let storedSize = deliverSize;
    let outputName: string | null = null;
    if (exportSettings) {
      const exp = exportSettings;
      outputName = exp.outputName ?? `export.${deliverExt}`;
      const segments = state.captions
        .filter((c) => c.text.trim().length > 0)
        .map((c) => ({ start: c.start, end: c.end, text: c.text }));
      if ((exp.captionMode === "separate" || exp.captionMode === "bundle") && segments.length > 0) {
        if (exp.captionFormat === "srt" || exp.captionFormat === "both") {
          fs.writeFileSync(mediaPath(`${job.user_id}/renders/${jobId}.srt`), buildSrtText(segments), "utf8");
        }
        if (exp.captionFormat === "vtt" || exp.captionFormat === "both") {
          fs.writeFileSync(mediaPath(`${job.user_id}/renders/${jobId}.vtt`), buildVttText(segments), "utf8");
        }
      }
      if (exp.captionMode === "bundle") {
        const bundleName = outputName ?? `export.${deliverExt}`;
        const stageDir = path.join(jobDir, "bundle");
        fs.mkdirSync(stageDir, { recursive: true });
        fs.copyFileSync(deliverPath, path.join(stageDir, bundleName));
        for (const fmt of ["srt", "vtt"] as const) {
          if (exp.captionFormat === fmt || exp.captionFormat === "both") {
            const side = mediaPath(`${job.user_id}/renders/${jobId}.${fmt}`);
            if (fs.existsSync(side)) {
              fs.copyFileSync(side, path.join(stageDir, bundleName.replace(/\.[A-Za-z0-9]+$/, `.${fmt}`)));
            }
          }
        }
        const zipRel = `${job.user_id}/renders/${jobId}.zip`;
        await new Promise<void>((resolve, reject) => {
          const child = spawn("zip", ["-j", "-q", mediaPath(zipRel), ...fs.readdirSync(stageDir).map((f) => path.join(stageDir, f))], {
            stdio: ["ignore", "ignore", "pipe"],
          });
          let err = "";
          child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
          child.on("error", reject);
          child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`zip failed (exit ${code}): ${err.slice(-200)}`))));
        });
        deliverRel = zipRel;
        storedSize = fs.statSync(mediaPath(zipRel)).size;
      }
      // Export History record (spec §15): one row per finished
      // export, written only now that QC has passed.
      db.prepare(
        `INSERT OR REPLACE INTO export_outputs (id, job_id, user_id, project_id, target_label, filename, storage_key, format, video_codec, audio_codec, width, height, duration, file_size, status, failure_reason, created_at, target_kind, target_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETED', NULL, ?, ?, ?)`,
      ).run(
        newId(), jobId, job.user_id, job.project_id,
        exp.targetLabel ?? "",
        outputName, deliverRel, deliverExt,
        probe.videoCodec, probe.audioCodec,
        probe.width, probe.height, probe.duration,
        storedSize, nowIso(),
        exportTarget?.kind ?? null, exportTarget?.id ?? null,
      );
      // Poster frame for the queue/history cards, taken from the
      // stored video (for bundle exports outputRel is still the plain
      // video copy next to the ZIP). Strictly best-effort: a failed
      // extraction leaves the thumbnail absent, never the export.
      if (!exp.audioOnly && probe.hasVideo && probe.duration) {
        await extractPosterFrame(
          mediaPath(outputRel),
          probe.duration,
          mediaPath(`${job.user_id}/renders/${jobId}.jpg`),
        );
      }
    }
    db.prepare(
      "UPDATE render_jobs SET status = 'COMPLETED', stage = 'COMPLETED', output_path = ?, output_name = ?, error = NULL, finished_at = ?, updated_at = ? WHERE id = ?",
    ).run(deliverRel, outputName, nowIso(), nowIso(), jobId);
    // Phase 12: usage ledger + in-app notification. Idempotency keys
    // are per job, so a worker retry can never double-record.
    if (job) {
      const isExport = job.kind === "EXPORT";
      const wsRow = db
        .prepare("SELECT workspace_id FROM projects WHERE id = ?")
        .get(job.project_id) as { workspace_id: string | null } | undefined;
      recordUsage(db, {
        userId: job.user_id,
        workspaceId: wsRow?.workspace_id ?? undefined,
        operation: isExport ? "export" : "render",
        resource: "render_job",
        quantity: 1,
        unit: "jobs",
        idempotencyKey: `${isExport ? "export" : "render"}:${jobId}:completed`,
        jobId,
        projectId: job.project_id,
        status: "COMPLETED",
      });
      notify(db, {
        userId: job.user_id,
        category: "ai_processing",
        type: isExport ? "export.completed" : "render.completed",
        title: isExport ? "Export completed" : "Render completed",
        body: outputName ?? undefined,
        link: "#/exports",
      });
    }
  } catch (err) {
    if (err instanceof RenderCancelled || isRenderCancelRequested(jobId)) {
      killRenderChildren(jobId);
      getDb()
        .prepare(
          "UPDATE render_jobs SET status = 'CANCELLED', stage = 'CANCELLED', finished_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(nowIso(), nowIso(), jobId);
    } else {
      const job = renderJobById(jobId);
      const message = err instanceof Error ? err.message : "Render failed.";
      getDb()
        .prepare(
          "UPDATE render_jobs SET status = 'FAILED', stage = ?, error = ?, finished_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(job?.stage ?? "FAILED", message.slice(0, 1000), nowIso(), nowIso(), jobId);
      // Phase 12 (§9): a failed job may appear in usage with FAILED
      // status and quantity 0 — it must never be billed as successful
      // usage. The idempotency key keeps retries from double-writing.
      if (job) {
        const isExport = job.kind === "EXPORT";
        const wsRow = getDb()
          .prepare("SELECT workspace_id FROM projects WHERE id = ?")
          .get(job.project_id) as { workspace_id: string | null } | undefined;
        recordUsage(getDb(), {
          userId: job.user_id,
          workspaceId: wsRow?.workspace_id ?? undefined,
          operation: isExport ? "export" : "render",
          resource: "render_job",
          quantity: 0,
          unit: "jobs",
          idempotencyKey: `${isExport ? "export" : "render"}:${jobId}:failed`,
          jobId,
          projectId: job.project_id,
          status: "FAILED",
        });
        notify(getDb(), {
          userId: job.user_id,
          category: "ai_processing",
          type: isExport ? "export.failed" : "render.failed",
          title: isExport ? "Export failed" : "Render failed",
          body: message.slice(0, 200),
          link: "#/exports",
        });
      }
      // Phase 9: export failures are diagnosable — an error-log row
      // (stage + message) and a FAILED history record (spec §13/§15).
      if (exportSettings && job) {
        recordRenderError(jobId, job.user_id, job.stage ?? "FAILED", message);
        try {
          db.prepare(
            `INSERT OR REPLACE INTO export_outputs (id, job_id, user_id, project_id, target_label, filename, storage_key, format, video_codec, audio_codec, width, height, duration, file_size, status, failure_reason, created_at, target_kind, target_id)
             VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, NULL, NULL, NULL, 'FAILED', ?, ?, ?, ?)`,
          ).run(
            newId(), jobId, job.user_id, job.project_id,
            exportSettings.targetLabel ?? "",
            exportSettings.outputName ?? `export.${exportFileExtension(exportSettings)}`,
            exportFileExtension(exportSettings),
            message.slice(0, 1000), nowIso(),
            exportTarget?.kind ?? null, exportTarget?.id ?? null,
          );
        } catch {
          /* history is best-effort */
        }
      }
    }
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
}

// ---- render worker ---------------------------------------------------------------------------

let renderTimer: NodeJS.Timeout | null = null;
let renderActive = 0;

/** Stable identity of this worker process (pid + boot time),
 *  recorded on every job it claims (render_jobs.worker_id) so the
 *  queue can show WHICH worker rendered a job. */
const RENDER_WORKER_ID = `worker-${process.pid}-${Date.now()}`;

/** How many renders may run at once: the RENDER_CONCURRENCY env
 *  var, default 1, clamped to 1–4, invalid values fall back to 1.
 *  Encoding is CPU-bound, so the default keeps the historical
 *  one-at-a-time behaviour exactly; raising it is an operator's
 *  explicit choice on bigger hardware. */
export function renderConcurrency(): number {
  const n = Number.parseInt(process.env.RENDER_CONCURRENCY ?? "", 10);
  if (!Number.isFinite(n)) return 1;
  return Math.min(4, Math.max(1, n));
}

async function renderTick(): Promise<void> {
  const limit = renderConcurrency();
  while (renderActive < limit) {
    // Phase 9: queue order is priority first (higher earlier), then
    // FIFO. PAUSED jobs are not QUEUED, so the pause-hold needs no
    // special case here — the worker simply never claims them.
    const next = getDb()
      .prepare("SELECT id FROM render_jobs WHERE status = 'QUEUED' ORDER BY priority DESC, created_at ASC, rowid ASC LIMIT 1")
      .get() as { id: string } | undefined;
    if (!next) return;
    const claim = getDb()
      .prepare(
        "UPDATE render_jobs SET status = 'RUNNING', stage = 'VALIDATING', started_at = ?, updated_at = ?, worker_id = ? WHERE id = ? AND status = 'QUEUED'",
      )
      .run(nowIso(), nowIso(), RENDER_WORKER_ID, next.id);
    if (claim.changes === 0) continue;
    renderActive += 1;
    void processRenderJob(next.id)
      .catch((err) => console.error("[editor] render job failed:", err))
      .finally(() => {
        renderActive -= 1;
        void renderTick().catch((err) => console.error("[editor] render tick failed:", err));
      });
  }
}

/**
 * Boot recovery + worker start (called from src/index.ts). A render
 * that was mid-flight when the server stopped is marked FAILED with
 * an explicit interruption message — never silently "still running".
 * Renders run one at a time by default (RENDER_CONCURRENCY, 1–4):
 * encoding is CPU-bound on this machine.
 */
export function startRenderWorker(): void {
  getDb()
    .prepare(
      `UPDATE render_jobs SET status = 'FAILED', stage = 'FAILED',
       error = 'This render was interrupted by a server restart. Start the render again.',
       finished_at = ?, updated_at = ? WHERE status = 'RUNNING'`,
    )
    .run(nowIso(), nowIso());
  if (renderTimer) return;
  renderTimer = setInterval(() => {
    void renderTick().catch((err) => console.error("[editor] render tick failed:", err));
  }, 500);
  renderTimer.unref();
  void renderTick().catch((err) => console.error("[editor] render tick failed:", err));
}

// ---- render routes ------------------------------------------------------------------------------

function registerRenderRoutes(router: express.Router, requireAuth: RequireAuth): void {
  const ownedDoc = (req: AuthedRequest) => docById(req.user!.id, req.params.docId);

  router.post("/editor/:docId/render", requireAuth, (req: AuthedRequest, res) => {
    const doc = ownedDoc(req);
    if (!doc) {
      res.status(404).json({ error: "Editor document not found." });
      return;
    }
    const state = readState(doc);
    const timelineDuration = timelineDurationOf(state);
    if (timelineDuration <= 0) {
      res.status(400).json({ error: "Add a clip to the main track before rendering." });
      return;
    }
    const stateJson = JSON.stringify(state);
    const stateHash = crypto.createHash("sha256").update(stateJson).digest("hex");
    const db = getDb();
    const active = db
      .prepare(
        `SELECT * FROM render_jobs WHERE version_id = ? AND status IN ('QUEUED', 'RUNNING') ORDER BY created_at DESC LIMIT 5`,
      )
      .all(doc.id) as unknown as RenderJobRow[];
    const duplicate = active.find((j) => {
      try {
        return (JSON.parse(j.settings_json) as RenderSettings).stateHash === stateHash;
      } catch {
        return false;
      }
    });
    if (duplicate) {
      res.status(200).json({ job: publicRenderJob(duplicate), deduplicated: true });
      return;
    }
    const now = nowIso();
    const job: RenderJobRow = {
      id: newId(),
      version_id: doc.id,
      project_id: doc.project_id,
      user_id: req.user!.id,
      status: "QUEUED",
      stage: "QUEUED",
      settings_json: JSON.stringify({ state, timelineDuration, stateHash } satisfies RenderSettings),
      output_path: null,
      error: null,
      cancel_requested: 0,
      created_at: now,
      updated_at: now,
      started_at: null,
      finished_at: null,
    };
    db.prepare(
      `INSERT INTO render_jobs (id, version_id, project_id, user_id, status, stage, settings_json, output_path, error, cancel_requested, created_at, updated_at, started_at, finished_at)
       VALUES (?, ?, ?, ?, 'QUEUED', 'QUEUED', ?, NULL, NULL, 0, ?, ?, NULL, NULL)`,
    ).run(job.id, job.version_id, job.project_id, job.user_id, job.settings_json, now, now);
    res.status(201).json({ job: publicRenderJob(job), deduplicated: false });
  });

  router.get("/editor/:docId/renders", requireAuth, (req: AuthedRequest, res) => {
    const doc = ownedDoc(req);
    if (!doc) {
      res.status(404).json({ error: "Editor document not found." });
      return;
    }
    const rows = getDb()
      .prepare("SELECT * FROM render_jobs WHERE version_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 20")
      .all(doc.id, req.user!.id) as unknown as RenderJobRow[];
    res.json({ jobs: rows.map(publicRenderJob) });
  });

  const ownedJob = (req: AuthedRequest): RenderJobRow | undefined =>
    getDb()
      .prepare("SELECT * FROM render_jobs WHERE id = ? AND user_id = ?")
      .get(req.params.jobId, req.user!.id) as RenderJobRow | undefined;

  router.get("/render-jobs/:jobId", requireAuth, (req: AuthedRequest, res) => {
    const job = ownedJob(req);
    if (!job) {
      res.status(404).json({ error: "Render job not found." });
      return;
    }
    res.json({ job: publicRenderJob(job) });
  });

  router.post("/render-jobs/:jobId/cancel", requireAuth, (req: AuthedRequest, res) => {
    const job = ownedJob(req);
    if (!job) {
      res.status(404).json({ error: "Render job not found." });
      return;
    }
    if (!RENDER_ACTIVE.includes(job.status as (typeof RENDER_ACTIVE)[number])) {
      res.status(409).json({ error: `This render is already ${job.status.toLowerCase()} and cannot be cancelled.` });
      return;
    }
    if (job.status === "QUEUED") {
      getDb()
        .prepare(
          "UPDATE render_jobs SET status = 'CANCELLED', stage = 'CANCELLED', cancel_requested = 1, finished_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(nowIso(), nowIso(), job.id);
    } else {
      getDb()
        .prepare("UPDATE render_jobs SET cancel_requested = 1, updated_at = ? WHERE id = ?")
        .run(nowIso(), job.id);
      killRenderChildren(job.id);
    }
    res.json({ job: publicRenderJob(ownedJob(req)!) });
  });

  router.get("/render-jobs/:jobId/download", requireAuth, (req: AuthedRequest, res) => {
    const job = ownedJob(req);
    if (!job || job.status !== "COMPLETED" || !job.output_path) {
      res.status(404).json({ error: "Render output not available." });
      return;
    }
    const filePath = mediaPath(job.output_path);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: "Render output file is missing." });
      return;
    }
    res.download(filePath, `clipforge-render-${job.id}.mp4`);
  });
}
