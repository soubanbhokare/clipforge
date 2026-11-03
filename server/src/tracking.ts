/**
 * CLIPFORGE — Phase 7: AI Face Lock, Active Speaker Detection & Smart
 * Auto-Reframing.
 *
 * Pipeline (same DB-backed in-process worker pattern as Phase 4):
 *
 *   QUEUED → VALIDATING → DETECTING_SCENES → DETECTING_SUBJECTS →
 *   TRACKING_SUBJECTS → ANALYZING_AUDIO → ASSOCIATING_SPEAKERS →
 *   GENERATING_REFRAME_DATA → GENERATING_PREVIEW → COMPLETED
 *   (FAILED / CANCELLED reachable from any stage.)
 *
 * Computer vision runs in a Python child process (scripts/track.py):
 * sampled frames (0.5 s interval, 480 px wide — never every frame at
 * full resolution) are analysed with the YuNet face detector
 * (cv2.FaceDetectorYN, real detector confidences) and, when its model
 * file is present, a YOLOv8-nano person detector via onnxruntime.
 * Speech activity comes from the Silero VAD model bundled with
 * faster-whisper plus the Phase 4 transcript segments.
 *
 * Honesty rules (spec sections 2/3, binding):
 *  - Subjects are anonymous per-video ids ("face-1"). No identity,
 *    name or external matching is ever performed or stored.
 *  - There is NO speaker diarization in this system (speaker labels
 *    are permanently null) and face tracking alone never establishes
 *    speaking. Active-speaker picks combine speech activity + a
 *    mouth-motion PROXY (YuNet exposes only the mouth corners, so
 *    mouth-width / nose-to-mouth distance variance over time) +
 *    presence. The evidence and score are stored per association; when
 *    the evidence is weak the pick is null and framing stays stable.
 *  - If the face model or OpenCV is unavailable the job fails with a
 *    CONFIGURATION error — detection is never simulated.
 *
 * All boxes/crops are normalized 0..1 of the source frame so they map
 * to any output resolution. Crop keyframes computed here are consumed
 * by BOTH the editor preview overlay and the Phase 5/6 render worker
 * (settings.reframe on the render job), so preview == render.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";

import { config, serverDir } from "./config.js";
import { notify, recordUsage } from "./accountCore.js";
import {
  getDb,
  type ProjectRow,
  type ReframeConfigurationRow,
  type SceneTrackingOverrideRow,
  type SourceAssetRow,
  type SplitScreenLayoutRow,
  type SubjectAssociationRow,
  type RenderJobRow,
  type TrackedSubjectRow,
  type TrackingJobRow,
  type TrackingKeyframeRow,
  type TranscriptRow,
  type TranscriptSegmentRow,
  type UserRow,
} from "./db.js";
import { mediaPath, probeFile } from "./media.js";
import {
  ASPECT_PRESETS,
  docById,
  getOrCreateDoc,
  ownedProject,
  publicRenderJob,
  readState,
  timelineDurationOf,
  type EditorState,
} from "./editor.js";

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

export interface NormBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ReframeMode =
  | "face-lock"
  | "active-speaker"
  | "person-follow"
  | "center-subject"
  | "smart-auto"
  | "manual"
  | "split-screen";

export const REFRAME_MODES: ReframeMode[] = [
  "face-lock",
  "active-speaker",
  "person-follow",
  "center-subject",
  "smart-auto",
  "manual",
  "split-screen",
];

export const FIT_MODES = ["smart-crop", "fill", "fit", "center-crop", "manual-crop"] as const;

export interface FollowControls {
  /** 0..1 — detector confidence floor for accepting detections. */
  sensitivity: number;
  /** 0..1 — max crop-centre velocity per sample step. */
  followSpeed: number;
  /** 0..1 — EMA smoothing of the crop trajectory. */
  smoothing: number;
  /** 0..1 — extra space kept around the subject box. */
  margin: number;
  /** 0..1 — how tight the crop is around the subject. */
  zoom: number;
  /** 0..1 — how quickly the crop SIZE adapts when the subject moves. */
  aggressiveness: number;
}

export const DEFAULT_CONTROLS: FollowControls = {
  sensitivity: 0.5,
  followSpeed: 0.6,
  smoothing: 0.6,
  margin: 0.5,
  zoom: 0.5,
  aggressiveness: 0.5,
};

export interface SpeechWindow {
  start: number;
  end: number;
  source: "vad" | "transcript";
}

export interface SceneRange {
  start: number;
  end: number;
}

export interface CropKeyframeData {
  t: number;
  crop: NormBox | null;
  fit: "fill" | "fit";
  subjectKey: string | null;
  confidence: number | null;
  lost: boolean;
}

/** One render interval derived from crop keyframes. */
export interface ReframeInterval {
  start: number;
  end: number;
  crop: NormBox | null;
  fit: "fill" | "fit";
}

export interface SplitRegion {
  subjectKey: string;
  rect: NormBox;
  /** Per-subject crop adjustments for this region (panel-editable). */
  crop?: { zoom?: number; offsetX?: number; offsetY?: number };
}

export interface ReframeRenderPayload {
  configId: string;
  mode: ReframeMode;
  jobId: string | null;
  sourceAssetId: string;
  intervals: ReframeInterval[];
  split: { layout: string; regions: { subjectKey: string; rect: NormBox; intervals: ReframeInterval[] }[] } | null;
}

const TRACKING_STAGES = [
  "QUEUED",
  "VALIDATING",
  "DETECTING_SCENES",
  "DETECTING_SUBJECTS",
  "TRACKING_SUBJECTS",
  "ANALYZING_AUDIO",
  "ASSOCIATING_SPEAKERS",
  "GENERATING_REFRAME_DATA",
  "GENERATING_PREVIEW",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;
type TrackingStage = (typeof TRACKING_STAGES)[number];
const ACTIVE_STATUSES = ["QUEUED", "RUNNING"] as const;

/** Local transaction helper (same pattern as editor.ts). */
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

const nowIso = () => new Date().toISOString();
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const round4 = (n: number) => Math.round(n * 10000) / 10000;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Provider / model status — honest configuration errors, never faked
// ---------------------------------------------------------------------------

export interface TrackingProviderStatus {
  configured: boolean;
  faceModel: string | null;
  personModel: string | null;
  personConfigured: boolean;
  vadModel: string | null;
  detail: string;
}

let cachedStatus: TrackingProviderStatus | null = null;

function findVadModel(): string | null {
  const candidates = [
    process.env.SILERO_VAD_MODEL ?? "",
    "/usr/local/lib/python3.12/dist-packages/faster_whisper/assets/silero_vad_v6.onnx",
    `${process.env.HOME ?? ""}/.local/lib/python3.12/site-packages/faster_whisper/assets/silero_vad_v6.onnx`,
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  // Last resort: ask the interpreter where faster-whisper lives.
  try {
    const out = spawnSync(
      config.pythonBin,
      [
        "-c",
        "import faster_whisper, os; print(os.path.join(os.path.dirname(faster_whisper.__file__), 'assets', 'silero_vad_v6.onnx'))",
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    const resolved = (out.stdout ?? "").trim();
    if (resolved && fs.existsSync(resolved)) return resolved;
  } catch {
    /* fall through */
  }
  return null;
}

export function trackingProviderStatus(): TrackingProviderStatus {
  if (cachedStatus) return cachedStatus;
  const facePath = path.join(config.tracking.modelsDir, config.tracking.faceModel);
  const personPath = path.join(config.tracking.modelsDir, config.tracking.personModel);
  const faceOk = fs.existsSync(facePath);
  const personOk = fs.existsSync(personPath);
  const vadPath = findVadModel();
  cachedStatus = {
    configured: faceOk,
    faceModel: faceOk ? facePath : null,
    personModel: personOk ? personPath : null,
    personConfigured: personOk,
    vadModel: vadPath,
    detail: faceOk
      ? `YuNet face model present (${config.tracking.faceModel}); person model ${personOk ? "present" : "not installed — face tracking still works"}; Silero VAD ${vadPath ? "present" : "not found"}.`
      : `Face model ${config.tracking.faceModel} is missing from ${config.tracking.modelsDir}. Tracking cannot run without it; no detection is simulated.`,
  };
  return cachedStatus;
}

/** Test hook: force a status re-check after model files change. */
export function resetTrackingStatusCache(): void {
  cachedStatus = null;
}

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

function jobById(userId: string, id: string): TrackingJobRow | undefined {
  return getDb()
    .prepare("SELECT * FROM tracking_jobs WHERE id = ? AND user_id = ?")
    .get(id, userId) as TrackingJobRow | undefined;
}

function anyJobById(id: string): TrackingJobRow | undefined {
  return getDb().prepare("SELECT * FROM tracking_jobs WHERE id = ?").get(id) as
    | TrackingJobRow
    | undefined;
}

function sourceAssetOf(userId: string, projectId: string): SourceAssetRow | undefined {
  // Same "the project's source asset" rule the editor library uses:
  // the most recent source asset row of the project.
  return getDb()
    .prepare(
      "SELECT * FROM source_assets WHERE project_id = ? AND user_id = ? ORDER BY rowid DESC LIMIT 1",
    )
    .get(projectId, userId) as SourceAssetRow | undefined;
}

function subjectsOfJob(jobId: string): TrackedSubjectRow[] {
  return getDb()
    .prepare("SELECT * FROM tracked_subjects WHERE job_id = ? ORDER BY kind, subject_key")
    .all(jobId) as unknown as TrackedSubjectRow[];
}

function configByVersion(userId: string, versionId: string): ReframeConfigurationRow | undefined {
  return getDb()
    .prepare("SELECT * FROM reframe_configurations WHERE version_id = ? AND user_id = ?")
    .get(versionId, userId) as ReframeConfigurationRow | undefined;
}

function configById(userId: string, id: string): ReframeConfigurationRow | undefined {
  return getDb()
    .prepare("SELECT * FROM reframe_configurations WHERE id = ? AND user_id = ?")
    .get(id, userId) as ReframeConfigurationRow | undefined;
}

export function publicTrackingJob(j: TrackingJobRow) {
  return {
    id: j.id,
    projectId: j.project_id,
    sourceAssetId: j.source_asset_id,
    status: j.status,
    stage: j.stage,
    progress: parseJson<Record<string, unknown>>(j.progress_json, {}),
    scenes: parseJson<SceneRange[]>(j.scenes_json, []),
    result: parseJson<Record<string, unknown>>(j.result_json, {}),
    outcome: j.outcome,
    error: j.error,
    errorCode: j.error_code,
    createdAt: j.created_at,
    updatedAt: j.updated_at,
    startedAt: j.started_at,
    finishedAt: j.finished_at,
  };
}

export function publicSubject(s: TrackedSubjectRow, baseUrl: string) {
  return {
    id: s.id,
    key: s.subject_key,
    kind: s.kind,
    firstSeenSec: s.first_seen_sec,
    lastSeenSec: s.last_seen_sec,
    presentSamples: s.present_samples,
    totalSamples: s.total_samples,
    presenceRatio: s.total_samples > 0 ? round3(s.present_samples / s.total_samples) : 0,
    meanConfidence: s.mean_confidence,
    bestConfidence: s.best_confidence,
    bestTimeSec: s.best_time_sec,
    bestBox: parseJson<NormBox | null>(s.best_bbox_json, null),
    hasThumbnail: Boolean(s.thumb_path),
    thumbnailUrl: s.thumb_path ? `${baseUrl}/${s.id}/thumbnail` : null,
  };
}

export function publicConfig(c: ReframeConfigurationRow) {
  const rawControls = parseJson<Record<string, unknown>>(c.controls_json, {});
  const { paused: _p, manualCrop: _m, ...controlFields } = rawControls;
  const extras = configExtras(c);
  return {
    id: c.id,
    documentId: c.version_id,
    projectId: c.project_id,
    jobId: c.job_id,
    mode: c.mode,
    enabled: c.enabled === 1,
    paused: extras.paused,
    manualCrop: extras.manualCrop,
    aspect: c.aspect,
    outWidth: c.out_width,
    outHeight: c.out_height,
    fitMode: c.fit_mode,
    subjectKey: c.subject_key,
    targetPosX: c.target_pos_x,
    targetPosY: c.target_pos_y,
    controls: { ...DEFAULT_CONTROLS, ...(controlFields as Partial<FollowControls>) },
    configVersion: c.config_version,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  };
}


// ---------------------------------------------------------------------------
// Job state machine (mirrors analysis.ts)
// ---------------------------------------------------------------------------

class JobCancelled extends Error {}

const runningChildren = new Map<string, Set<ChildProcess>>();

function registerChild(jobId: string, child: ChildProcess): void {
  let set = runningChildren.get(jobId);
  if (!set) {
    set = new Set();
    runningChildren.set(jobId, set);
  }
  set.add(child);
  child.once("close", () => {
    set!.delete(child);
    if (set!.size === 0) runningChildren.delete(jobId);
  });
}

function killChildren(jobId: string): void {
  const set = runningChildren.get(jobId);
  if (!set) return;
  for (const child of set) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

function jobRow(jobId: string): TrackingJobRow | undefined {
  return getDb().prepare("SELECT * FROM tracking_jobs WHERE id = ?").get(jobId) as
    | TrackingJobRow
    | undefined;
}

function throwIfCancelled(jobId: string): void {
  const row = jobRow(jobId);
  if (!row || row.cancel_requested === 1 || row.status === "CANCELLED") {
    throw new JobCancelled("tracking job cancelled");
  }
}

function setStage(jobId: string, stage: TrackingStage): void {
  throwIfCancelled(jobId);
  getDb()
    .prepare(
      "UPDATE tracking_jobs SET stage = ?, status = 'RUNNING', updated_at = ? WHERE id = ? AND status != 'CANCELLED'",
    )
    .run(stage, nowIso(), jobId);
}

function setProgress(jobId: string, progress: Record<string, unknown>): void {
  getDb()
    .prepare("UPDATE tracking_jobs SET progress_json = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(progress), nowIso(), jobId);
}

function markFailed(jobId: string, error: unknown, errorCode = "PROCESSING_ERROR"): void {
  const row = jobRow(jobId);
  if (!row || row.status === "CANCELLED") return;
  const message = error instanceof Error ? error.message : String(error);
  getDb()
    .prepare(
      "UPDATE tracking_jobs SET status = 'FAILED', error = ?, error_code = ?, finished_at = ?, updated_at = ? WHERE id = ?",
    )
    .run(message.slice(0, 500), errorCode, nowIso(), nowIso(), jobId);
  // Phase 12 (§9): failed tracking recorded with quantity 0.
  recordUsage(getDb(), {
    userId: row.user_id,
    operation: "tracking",
    resource: "tracking_job",
    quantity: 0,
    unit: "jobs",
    idempotencyKey: `tracking:${jobId}:failed`,
    jobId,
    projectId: row.project_id,
    status: "FAILED",
  });
  notify(getDb(), {
    userId: row.user_id,
    category: "ai_processing",
    type: "tracking.failed",
    title: "Tracking failed",
    body: message.slice(0, 200),
  });
}

function markCancelled(jobId: string): void {
  getDb()
    .prepare(
      "UPDATE tracking_jobs SET status = 'CANCELLED', stage = 'CANCELLED', finished_at = ?, updated_at = ? WHERE id = ?",
    )
    .run(nowIso(), nowIso(), jobId);
}

function markCompleted(jobId: string, outcome: string, result: Record<string, unknown>): void {
  getDb()
    .prepare(
      "UPDATE tracking_jobs SET status = 'COMPLETED', stage = 'COMPLETED', outcome = ?, result_json = ?, finished_at = ?, updated_at = ? WHERE id = ?",
    )
    .run(outcome, JSON.stringify(result), nowIso(), nowIso(), jobId);
  // Phase 12: usage ledger + notification (idempotent per job).
  const row = jobRow(jobId);
  if (row) {
    recordUsage(getDb(), {
      userId: row.user_id,
      operation: "tracking",
      resource: "tracking_job",
      quantity: 1,
      unit: "jobs",
      idempotencyKey: `tracking:${jobId}:completed`,
      jobId,
      projectId: row.project_id,
      status: "COMPLETED",
    });
    notify(getDb(), {
      userId: row.user_id,
      category: "ai_processing",
      type: "tracking.completed",
      title: "Tracking completed",
    });
  }
}

/** Run a short external command bound to the job (cancellable, timed). */
function runCommand(
  jobId: string,
  command: string,
  args: string[],
  timeoutMs = 180_000,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    registerChild(jobId, child);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      reject(new Error(`${command} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      stdout = (stdout + d.toString("utf8")).slice(-200_000);
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString("utf8")).slice(-20_000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim().slice(-600) || `${command} exited with code ${code}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Detection payload (from scripts/track.py)
// ---------------------------------------------------------------------------

interface SampleFace {
  bbox: number[];
  confidence: number;
  mouthWidth: number;
  noseMouth: number;
  eyeDist: number;
}
interface SamplePerson {
  bbox: number[];
  confidence: number;
}
interface SampleFrame {
  t: number;
  faces: SampleFace[];
  persons: SamplePerson[];
}
interface TrackResult {
  sampleInterval: number;
  sampleWidth: number;
  sampleHeight: number;
  frames: SampleFrame[];
  vadSpeech: SpeechWindow[] | null;
  vadError: string | null;
  personModel: string | null;
  faceModel: string;
}

const toBox = (raw: number[]): NormBox => ({
  x: round4(raw[0] ?? 0),
  y: round4(raw[1] ?? 0),
  w: round4(raw[2] ?? 0),
  h: round4(raw[3] ?? 0),
});

const boxCenter = (b: NormBox) => ({ cx: b.x + b.w / 2, cy: b.y + b.h / 2 });

function iou(a: NormBox, b: NormBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

// ---------------------------------------------------------------------------
// Subject association (IoU/centroid across samples — tracking by detection)
// ---------------------------------------------------------------------------

export interface SubjectSample {
  t: number;
  box: NormBox;
  confidence: number;
  mouthWidth: number | null;
  noseMouth: number | null;
}

export interface SubjectBuild {
  key: string;
  kind: "face" | "person";
  samples: SubjectSample[];
}

/**
 * Greedy per-kind association: a detection joins the open track with
 * the best IoU (>= 0.2) or nearest centroid (<= 0.18 normalized) when
 * the gap is <= 1.5 s; otherwise it opens a new track. Tracks are
 * scene-scoped by the caller (frames passed in are within one scene),
 * so no subject ever carries across a scene boundary.
 */
export function associateDetections(
  frames: SampleFrame[],
  kind: "face" | "person",
  sceneStart: number,
): SubjectBuild[] {
  interface OpenTrack {
    build: SubjectBuild;
    lastT: number;
    lastBox: NormBox;
  }
  const open: OpenTrack[] = [];
  const all: SubjectBuild[] = [];
  let counter = 0;
  for (const frame of frames) {
    const dets = kind === "face" ? frame.faces : frame.persons;
    const used = new Set<OpenTrack>();
    for (const det of dets) {
      const box = toBox(det.bbox);
      let best: OpenTrack | null = null;
      let bestScore = -1;
      for (const track of open) {
        if (used.has(track)) continue;
        if (frame.t - track.lastT > 1.5) continue;
        const overlap = iou(box, track.lastBox);
        const ca = boxCenter(box);
        const cb = boxCenter(track.lastBox);
        const dist = Math.hypot(ca.cx - cb.cx, ca.cy - cb.cy);
        const score = overlap >= 0.2 ? 1 + overlap : dist <= 0.18 ? 0.5 - dist : -1;
        if (score > bestScore) {
          bestScore = score;
          best = track;
        }
      }
      const sample: SubjectSample = {
        t: frame.t,
        box,
        confidence: det.confidence,
        mouthWidth: kind === "face" ? (det as SampleFace).mouthWidth : null,
        noseMouth: kind === "face" ? (det as SampleFace).noseMouth : null,
      };
      if (best) {
        best.build.samples.push(sample);
        best.lastT = frame.t;
        best.lastBox = box;
        used.add(best);
      } else {
        counter += 1;
        const build: SubjectBuild = {
          key: `${kind}-${sceneStart > 0 ? `${Math.round(sceneStart)}s-` : ""}${counter}`,
          kind,
          samples: [sample],
        };
        all.push(build);
        const track: OpenTrack = { build, lastT: frame.t, lastBox: box };
        open.push(track);
        used.add(track);
      }
    }
  }
  return all;
}

/** Interpolated (or nearest) box of a subject at time t; null if absent. */
function subjectBoxAtRaw(
  samples: SubjectSample[],
  t: number,
  maxGap = 0.75,
): { box: NormBox; confidence: number } | null {
  if (samples.length === 0) return null;
  let prev: SubjectSample | null = null;
  let next: SubjectSample | null = null;
  for (const s of samples) {
    if (s.t <= t) prev = s;
    if (s.t >= t && !next) next = s;
  }
  if (prev && next && prev !== next) {
    if (next.t - prev.t > maxGap * 2) {
      // A real absence gap — only trust the nearer sample within maxGap.
      if (t - prev.t <= maxGap) return { box: prev.box, confidence: prev.confidence };
      if (next.t - t <= maxGap) return { box: next.box, confidence: next.confidence };
      return null;
    }
    const f = (t - prev.t) / (next.t - prev.t);
    const lerp = (a: number, b: number) => a + (b - a) * f;
    return {
      box: {
        x: lerp(prev.box.x, next.box.x),
        y: lerp(prev.box.y, next.box.y),
        w: lerp(prev.box.w, next.box.w),
        h: lerp(prev.box.h, next.box.h),
      },
      confidence: Math.min(prev.confidence, next.confidence),
    };
  }
  const only = prev ?? next;
  if (only && Math.abs(only.t - t) <= maxGap) return { box: only.box, confidence: only.confidence };
  return null;
}

/**
 * Map the sensitivity slider (0..1) to the detector-confidence floor
 * used when ACCEPTING a tracked sample into the crop path:
 * floor = 0.98 * s^2. The quadratic keeps the floor at the default
 * slider value (s = 0.5 -> 0.245) below the lowest detector threshold
 * ever stored (person detections are stored from 0.35 up, faces from
 * 0.6 up), so default behaviour is unchanged; at s = 1 the floor is
 * 0.98, above every realistic detection, so weak samples are treated
 * as absent and the subject-loss hold / static framing takes over.
 * This is a path-computation filter only, like the other follow
 * controls — stored tracking data is never rewritten.
 */
export function sensitivityFloor(sensitivity: number): number {
  const s = clamp(sensitivity, 0, 1);
  return 0.98 * s * s;
}

/**
 * Box of a subject at time t, or null when the subject is absent OR
 * the sample's detector confidence is below `minConfidence` (the
 * sensitivity floor). Every crop-path mode resolves its subject boxes
 * through here, so the floor applies uniformly.
 */
export function subjectBoxAt(
  samples: SubjectSample[],
  t: number,
  maxGap = 0.75,
  minConfidence = 0,
): { box: NormBox; confidence: number } | null {
  const at = subjectBoxAtRaw(samples, t, maxGap);
  if (!at) return null;
  return at.confidence >= minConfidence ? at : null;
}

// ---------------------------------------------------------------------------
// Active-speaker evidence scoring (spec section 3 honesty rules)
// ---------------------------------------------------------------------------

export interface AssociationBuild {
  subjectKey: string;
  windowStart: number;
  windowEnd: number;
  speechSource: string;
  score: number;
  confidence: "low" | "medium" | "high";
  isPick: boolean;
  evidence: {
    mouthMotion: number | null;
    presenceRatio: number;
    samplesInWindow: number;
    note: string;
  };
}

function seriesVariance(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length;
}

/**
 * Score each face subject per speech window. The score combines the
 * mouth-motion PROXY (variance of YuNet mouth-corner measurements —
 * labelled as a proxy in the evidence) with presence during the
 * window. A pick is only made at medium/high confidence; otherwise the
 * window has no pick and framing stays stable (spec section 3).
 */
export function scoreActiveSpeakers(
  faceSubjects: SubjectBuild[],
  windows: SpeechWindow[],
): AssociationBuild[] {
  const out: AssociationBuild[] = [];
  for (const win of windows) {
    interface Cand {
      subject: SubjectBuild;
      mouthMotion: number | null;
      presence: number;
      samples: number;
    }
    const cands: Cand[] = [];
    for (const subject of faceSubjects) {
      const inWin = subject.samples.filter((s) => s.t >= win.start - 0.25 && s.t <= win.end + 0.25);
      if (inWin.length === 0) continue;
      const span = Math.max(win.end - win.start, 0.5);
      const presence = clamp(inWin.length / (span / 0.5 + 1), 0, 1);
      let mouthMotion: number | null = null;
      if (inWin.length >= 3) {
        const widths = inWin.map((s) => s.mouthWidth ?? 0);
        const noseMouth = inWin.map((s) => s.noseMouth ?? 0);
        mouthMotion = seriesVariance(widths) * 400 + seriesVariance(noseMouth) * 400;
      }
      cands.push({ subject, mouthMotion, presence, samples: inWin.length });
    }
    if (cands.length === 0) continue;
    const maxMotion = Math.max(...cands.map((c) => c.mouthMotion ?? 0), 0.0001);
    const scored = cands.map((c) => {
      const motionNorm = c.mouthMotion === null ? 0 : clamp(c.mouthMotion / maxMotion, 0, 1);
      const score = round3(0.65 * motionNorm + 0.35 * c.presence);
      return { ...c, motionNorm, score };
    });
    scored.sort((a, b) => b.score - a.score);
    const top = scored[0]!;
    const marginOverSecond = scored.length > 1 ? top.score - scored[1]!.score : top.score;
    for (const c of scored) {
      let confidence: "low" | "medium" | "high" = "low";
      if (c === top) {
        if (top.score >= 0.55 && marginOverSecond >= 0.15 && top.mouthMotion !== null) confidence = "high";
        else if (top.score >= 0.4 && top.mouthMotion !== null) confidence = "medium";
      }
      out.push({
        subjectKey: c.subject.key,
        windowStart: win.start,
        windowEnd: win.end,
        speechSource: win.source,
        score: c.score,
        confidence,
        isPick: c === top && confidence !== "low",
        evidence: {
          mouthMotion: c.mouthMotion === null ? null : round4(c.mouthMotion),
          presenceRatio: round3(c.presence),
          samplesInWindow: c.samples,
          note:
            "Mouth motion is a landmark-variance proxy (YuNet exposes mouth corners only); no diarization or identity is used.",
        },
      });
    }
  }
  return out;
}

/**
 * Conservative active-subject timeline from scored windows: a switch
 * to a different subject is only honoured when the new window lasts
 * at least the minimum dwell (1.2 s) or it is the first pick —
 * hysteresis against jitter (spec section 3).
 */
export function activeTimeline(
  associations: AssociationBuild[],
  duration: number,
): { start: number; end: number; subjectKey: string | null }[] {
  const picks = associations
    .filter((a) => a.isPick)
    .sort((a, b) => a.windowStart - b.windowStart);
  const segments: { start: number; end: number; subjectKey: string | null }[] = [];
  let current: string | null = null;
  let cursor = 0;
  for (const pick of picks) {
    const dwell = pick.windowEnd - pick.windowStart;
    if (current !== null && pick.subjectKey !== current && dwell < 1.2) continue;
    if (pick.windowStart > cursor) {
      segments.push({ start: cursor, end: pick.windowStart, subjectKey: current });
    }
    segments.push({ start: pick.windowStart, end: pick.windowEnd, subjectKey: pick.subjectKey });
    current = pick.subjectKey;
    cursor = pick.windowEnd;
  }
  if (cursor < duration) segments.push({ start: cursor, end: duration, subjectKey: current });
  return segments.filter((s) => s.end - s.start > 0.01);
}


// ---------------------------------------------------------------------------
// Reframing engine — crop computation shared by preview and render.
// ALL times here are SOURCE times of the tracked asset; the render
// worker maps timeline time -> source time per item.
// ---------------------------------------------------------------------------

export interface PathSubject {
  key: string;
  kind: "face" | "person";
  samples: SubjectSample[];
  presence: number;
}

export interface SceneOverrideLike {
  rangeStart: number;
  rangeEnd: number;
  mode: string | null;
  subjectKey: string | null;
  controls: Partial<FollowControls> | null;
  fitMode: string | null;
}

export interface PathConfig {
  mode: ReframeMode;
  subjectKey: string | null;
  fitMode: string;
  targetPosX: string;
  targetPosY: string;
  controls: FollowControls;
  /** Face Lock master switch: false = static framing, no following. */
  enabled: boolean;
  /** Persisted Auto-Follow pause: true = static framing, no following. */
  paused: boolean;
  /** The user's manual crop rectangle for fitMode "manual-crop". */
  manualCrop: NormBox | null;
}

/**
 * paused + manualCrop live inside controls_json alongside the
 * FollowControls fields (no schema change needed); this reader pulls
 * them out so the controls object itself stays a pure FollowControls.
 */
export function configExtras(c: { controls_json: string }): { paused: boolean; manualCrop: NormBox | null } {
  const raw = parseJson<Record<string, unknown>>(c.controls_json, {});
  const mc = raw.manualCrop as NormBox | null | undefined;
  const manualCrop =
    mc && typeof mc.x === "number" && typeof mc.y === "number" && typeof mc.w === "number" && typeof mc.h === "number"
      ? { x: mc.x, y: mc.y, w: mc.w, h: mc.h }
      : null;
  return { paused: raw.paused === true, manualCrop };
}

export interface ManualKeyframeLike {
  t: number;
  crop: NormBox | null;
  fit: "fill" | "fit";
}

const MANUAL_TAIL_SEC = 5;

export function staticCenterCrop(srcAspect: number, outAspect: number): NormBox {
  let hFrac = Math.min(1, srcAspect / outAspect);
  let wFrac = (hFrac * outAspect) / srcAspect;
  if (wFrac > 1) {
    wFrac = 1;
    hFrac = srcAspect / outAspect;
  }
  return {
    x: round4((1 - wFrac) / 2),
    y: round4((1 - hFrac) / 2),
    w: round4(wFrac),
    h: round4(hFrac),
  };
}

/** Crop rectangle that frames a subject box under the follow controls. */
export function cropForBox(
  box: NormBox,
  kind: "face" | "person",
  srcAspect: number,
  outAspect: number,
  controls: FollowControls,
  fitMode: string,
  targetPosX: string,
  targetPosY: string,
): NormBox {
  const zoomScale = 0.72 + controls.zoom * 0.62;
  let targetH: number;
  let targetW: number;
  if (fitMode === "fill") {
    targetH = 1;
    targetW = outAspect / srcAspect;
  } else {
    if (kind === "face") {
      targetH = (box.h * (1.55 + controls.margin * 1.9)) / zoomScale;
    } else {
      targetH = (box.h * (1.06 + controls.margin * 0.45)) / zoomScale;
    }
    targetW = (targetH * outAspect) / srcAspect;
    const minW =
      (box.w * (kind === "face" ? 1.5 + controls.margin : 1.12 + controls.margin * 0.4)) / zoomScale;
    if (targetW < minW) {
      targetW = minW;
      targetH = (targetW * srcAspect) / outAspect;
    }
  }
  if (targetW > 1) {
    targetW = 1;
    targetH = srcAspect / outAspect;
  }
  if (targetH > 1) {
    targetH = 1;
    targetW = outAspect / srcAspect;
    if (targetW > 1) targetW = 1;
  }
  targetH = Math.max(targetH, 0.04);
  targetW = Math.max(targetW, 0.04);
  const anchorCx = box.x + box.w / 2;
  const anchorCy = kind === "face" ? box.y + box.h / 2 : box.y + box.h * 0.38;
  const posX = targetPosX === "left" ? 0.34 : targetPosX === "right" ? 0.66 : 0.5;
  const posY = targetPosY === "upper" ? 0.36 : 0.5;
  return {
    x: round4(clamp(anchorCx - posX * targetW, 0, 1 - targetW)),
    y: round4(clamp(anchorCy - posY * targetH, 0, 1 - targetH)),
    w: round4(targetW),
    h: round4(targetH),
  };
}

function lerpBox(a: NormBox, b: NormBox, f: number): NormBox {
  return {
    x: a.x + (b.x - a.x) * f,
    y: a.y + (b.y - a.y) * f,
    w: a.w + (b.w - a.w) * f,
    h: a.h + (b.h - a.h) * f,
  };
}

/** Manual keyframe track value at t (null when outside the manual range). */
function manualCropAt(manual: ManualKeyframeLike[], t: number): { crop: NormBox | null; fit: "fill" | "fit" } | null {
  if (manual.length === 0) return null;
  const sorted = [...manual].sort((a, b) => a.t - b.t);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  if (t < first.t || t > last.t + MANUAL_TAIL_SEC) return null;
  if (t >= last.t) return { crop: last.crop, fit: last.fit };
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    if (t >= a.t && t <= b.t) {
      if (a.crop && b.crop && b.t > a.t) {
        return { crop: lerpBox(a.crop, b.crop, (t - a.t) / (b.t - a.t)), fit: "fill" };
      }
      return { crop: a.crop, fit: a.fit };
    }
  }
  return { crop: first.crop, fit: first.fit };
}

interface ResolvedTarget {
  box: NormBox;
  kind: "face" | "person";
  subjectKey: string;
  confidence: number;
}

/**
 * Compute the crop path for one configuration. Each of the seven
 * modes resolves its target differently (see resolvers below); the
 * shared tail (crop sizing from the follow controls, per-segment EMA
 * smoothing with a follow-speed cap, manual-keyframe override) then
 * turns targets into a stable camera path. Smoothing state resets at
 * scene/override boundaries so crops never glide across a cut.
 */
export function computeCropPath(args: {
  config: PathConfig;
  subjects: PathSubject[];
  associations: AssociationBuild[];
  scenes: SceneRange[];
  overrides: SceneOverrideLike[];
  manual: ManualKeyframeLike[];
  duration: number;
  interval: number;
  srcAspect: number;
  outAspect: number;
  regionSubjectKey?: string | null;
  regionAspect?: number | null;
  /** Per-subject crop adjustments for a split region path. */
  regionCrop?: { zoom?: number; offsetX?: number; offsetY?: number } | null;
}): CropKeyframeData[] {
  const { duration, interval, srcAspect } = args;
  const outAspect = args.regionAspect ?? args.outAspect;
  const byKey = new Map(args.subjects.map((s) => [s.key, s]));
  const faces = args.subjects.filter((s) => s.kind === "face");
  const persons = args.subjects.filter((s) => s.kind === "person");
  const timeline = activeTimeline(args.associations, duration);

  // Smart Auto decides once per scene: active speaker when the scene
  // has confident picks, else the dominant face, else dominant person.
  const smartDecision = new Map<number, { kind: "active" | "face" | "person" | "none"; subjectKey: string | null }>();
  args.scenes.forEach((scene, idx) => {
    const picks = args.associations.filter(
      (a) => a.isPick && a.windowStart >= scene.start - 0.01 && a.windowStart < scene.end,
    );
    if (picks.length > 0) {
      smartDecision.set(idx, { kind: "active", subjectKey: null });
      return;
    }
    const sceneFaces = faces.filter((f) => f.samples.some((s) => s.t >= scene.start && s.t < scene.end));
    const dominant = [...sceneFaces].sort((a, b) => b.presence - a.presence)[0];
    if (dominant) {
      smartDecision.set(idx, { kind: "face", subjectKey: dominant.key });
      return;
    }
    const scenePersons = persons.filter((p) => p.samples.some((s) => s.t >= scene.start && s.t < scene.end));
    const dominantPerson = [...scenePersons].sort((a, b) => b.presence - a.presence)[0];
    smartDecision.set(
      idx,
      dominantPerson
        ? { kind: "person", subjectKey: dominantPerson.key }
        : { kind: "none", subjectKey: null },
    );
  });

  const sceneIndexAt = (t: number): number => {
    const idx = args.scenes.findIndex((s) => t >= s.start && t < s.end);
    return idx === -1 ? args.scenes.length - 1 : idx;
  };
  const overrideAt = (t: number): SceneOverrideLike | null =>
    args.overrides.find((o) => t >= o.rangeStart && t < o.rangeEnd) ?? null;

  let stickyCenterKey: string | null = null;

  const resolveTarget = (
    mode: ReframeMode,
    cfg: PathConfig,
    t: number,
    sceneIdx: number,
  ): ResolvedTarget | null => {
    // Sensitivity is a confidence floor on the samples accepted here:
    // below-floor samples are treated as absent in EVERY mode, because
    // all modes resolve their subject boxes through this layer.
    const floor = sensitivityFloor(cfg.controls.sensitivity);
    const boxOf = (subject: PathSubject | null): ResolvedTarget | null => {
      if (!subject) return null;
      const at = subjectBoxAt(subject.samples, t, 0.75, floor);
      if (!at) return null;
      return { box: at.box, kind: subject.kind, subjectKey: subject.key, confidence: at.confidence };
    };
    switch (mode) {
      case "face-lock": {
        // No silent auto-pick: with several faces and no user
        // selection there is NO target (stable/static framing) until
        // the user picks one. A single face is the documented
        // auto-select case.
        const subject =
          (cfg.subjectKey ? byKey.get(cfg.subjectKey) : undefined) ??
          (faces.length === 1 ? faces[0] : undefined);
        return boxOf(subject && subject.kind === "face" ? subject : null);
      }
      case "person-follow": {
        const subject =
          (cfg.subjectKey ? byKey.get(cfg.subjectKey) : undefined) ??
          (persons.length === 1 ? persons[0] : undefined);
        return boxOf(subject && subject.kind === "person" ? subject : null);
      }
      case "active-speaker": {
        const seg = timeline.find((s) => t >= s.start && t < s.end);
        const subject = seg?.subjectKey ? byKey.get(seg.subjectKey) : null;
        return boxOf(subject ?? null);
      }
      case "center-subject": {
        let best: { subject: PathSubject; at: { box: NormBox; confidence: number }; score: number } | null = null;
        for (const subject of [...faces, ...persons]) {
          const at = subjectBoxAt(subject.samples, t, 0.75, floor);
          if (!at) continue;
          const c = boxCenter(at.box);
          const centerDist = Math.hypot(c.cx - 0.5, c.cy - 0.5);
          const score = at.box.w * at.box.h * (1.4 - centerDist);
          if (!best || score > best.score) best = { subject, at, score };
        }
        if (!best) {
          stickyCenterKey = null;
          return null;
        }
        if (stickyCenterKey && stickyCenterKey !== best.subject.key) {
          const sticky = byKey.get(stickyCenterKey);
          const stickyAt = sticky ? subjectBoxAt(sticky.samples, t, 0.75, floor) : null;
          if (sticky && stickyAt) {
            const c = boxCenter(stickyAt.box);
            const stickyScore = stickyAt.box.w * stickyAt.box.h * (1.4 - Math.hypot(c.cx - 0.5, c.cy - 0.5));
            if (best.score < stickyScore * 1.3) {
              return { box: stickyAt.box, kind: sticky.kind, subjectKey: sticky.key, confidence: stickyAt.confidence };
            }
          }
        }
        stickyCenterKey = best.subject.key;
        return { box: best.at.box, kind: best.subject.kind, subjectKey: best.subject.key, confidence: best.at.confidence };
      }
      case "smart-auto": {
        const decision = smartDecision.get(sceneIdx) ?? { kind: "none" as const, subjectKey: null };
        if (decision.kind === "active") return resolveTarget("active-speaker", cfg, t, sceneIdx);
        if (decision.kind === "face" || decision.kind === "person") {
          return boxOf(decision.subjectKey ? byKey.get(decision.subjectKey) ?? null : null);
        }
        return null;
      }
      default:
        return null;
    }
  };

  const frames: CropKeyframeData[] = [];
  let prevCrop: NormBox | null = null;
  let prevSegmentId = "";
  let heldCrop: NormBox | null = null;

  const steps = Math.max(1, Math.ceil(duration / interval));
  for (let i = 0; i <= steps; i += 1) {
    const t = round3(Math.min(i * interval, duration));
    const sceneIdx = sceneIndexAt(t);
    const override = overrideAt(t);
    const effMode = (override?.mode as ReframeMode | null) ?? args.config.mode;
    const effSubject = override?.subjectKey ?? args.config.subjectKey;
    const effControls: FollowControls = {
      ...args.config.controls,
      ...(override?.controls ?? {}),
    };
    const effFit = override?.fitMode ?? args.config.fitMode;
    const effCfg: PathConfig = {
      ...args.config,
      mode: effMode,
      subjectKey: args.regionSubjectKey ?? effSubject,
      controls: effControls,
      fitMode: effFit,
    };
    const segmentId = `${sceneIdx}|${override ? `${override.rangeStart}-${override.rangeEnd}` : "base"}|${effMode}|${effCfg.subjectKey ?? ""}`;

    // Region paths (split screen) pin their own subject. A region's
    // own zoom (when set) replaces the shared controls zoom for it.
    const regionCfg: PathConfig = args.regionSubjectKey
      ? {
          ...effCfg,
          mode: byKey.get(args.regionSubjectKey)?.kind === "person" ? "person-follow" : "face-lock",
          controls:
            args.regionCrop?.zoom != null
              ? { ...effCfg.controls, zoom: args.regionCrop.zoom }
              : effCfg.controls,
        }
      : effCfg;

    let crop: NormBox | null;
    let fit: "fill" | "fit" = "fill";
    let subjectKey: string | null = null;
    let confidence: number | null = null;
    let lost = false;

    // Face Lock OFF or a persisted Auto-Follow pause freezes the
    // camera: static framing, no subject following — in the preview
    // keyframes AND in the persisted path the render consumes.
    const followOff = args.config.enabled === false || args.config.paused === true;

    const manualHit = followOff || args.config.mode === "manual" ? null : manualCropAt(args.manual, t);
    if (followOff) {
      if (effFit === "fit") {
        crop = null;
        fit = "fit";
      } else {
        crop = staticCenterCrop(srcAspect, outAspect);
      }
    } else if (effMode === "manual" || manualHit) {
      const m = manualHit ?? manualCropAt(args.manual, t);
      if (m) {
        crop = m.crop;
        fit = m.fit;
      } else {
        crop = staticCenterCrop(srcAspect, outAspect);
      }
      subjectKey = "manual";
    } else if (effFit === "manual-crop") {
      // Manual Crop fit is genuinely manual: exactly the user's
      // stored rectangle for the whole scene — no subject following,
      // no smoothing. With no rectangle stored it NEVER falls back
      // to smart cropping; it holds a static centre crop and the
      // panel asks the user to set a rectangle.
      if (args.config.manualCrop) {
        crop = { ...args.config.manualCrop };
        subjectKey = "manual";
      } else {
        crop = staticCenterCrop(srcAspect, outAspect);
      }
    } else if (effFit === "fit") {
      crop = null;
      fit = "fit";
    } else if (effFit === "center-crop") {
      crop = staticCenterCrop(srcAspect, outAspect);
    } else {
      const target = resolveTarget(regionCfg.mode, regionCfg, t, sceneIdx);
      if (target) {
        subjectKey = target.subjectKey;
        confidence = target.confidence;
        const desired = cropForBox(
          target.box,
          target.kind,
          srcAspect,
          outAspect,
          effControls,
          effFit,
          args.config.targetPosX,
          args.config.targetPosY,
        );
        if (!prevCrop || prevSegmentId !== segmentId) {
          crop = desired;
        } else {
          const alpha: number = clamp(1 - effControls.smoothing * 0.88, 0.08, 1);
          const sizeAlpha: number = clamp(alpha * (0.4 + 1.2 * effControls.aggressiveness), 0.05, 1);
          const maxDelta: number = 0.02 + effControls.followSpeed * 0.3;
          const prevC: { cx: number; cy: number } = { cx: prevCrop.x + prevCrop.w / 2, cy: prevCrop.y + prevCrop.h / 2 };
          const desC: { cx: number; cy: number } = { cx: desired.x + desired.w / 2, cy: desired.y + desired.h / 2 };
          let ncx: number = prevC.cx + clamp((desC.cx - prevC.cx) * alpha, -maxDelta, maxDelta);
          let ncy: number = prevC.cy + clamp((desC.cy - prevC.cy) * alpha, -maxDelta, maxDelta);
          const nw: number = prevCrop.w + (desired.w - prevCrop.w) * sizeAlpha;
          const nh: number = prevCrop.h + (desired.h - prevCrop.h) * sizeAlpha;
          ncx = clamp(ncx, nw / 2, 1 - nw / 2);
          ncy = clamp(ncy, nh / 2, 1 - nh / 2);
          crop = { x: round4(ncx - nw / 2), y: round4(ncy - nh / 2), w: round4(nw), h: round4(nh) };
        }
      } else if (heldCrop && prevSegmentId === segmentId) {
        // Subject temporarily lost inside the same segment: hold the
        // last framing (subject-loss hold) instead of jumping.
        crop = heldCrop;
        lost = true;
      } else {
        crop = staticCenterCrop(srcAspect, outAspect);
        lost = faces.length + persons.length > 0;
      }
    }

    // Split-region offset adjustments shift the region's own crop
    // (applied after smoothing, clamped inside the frame).
    if (
      crop &&
      args.regionSubjectKey &&
      args.regionCrop &&
      (args.regionCrop.offsetX || args.regionCrop.offsetY)
    ) {
      crop = {
        ...crop,
        x: round4(clamp(crop.x + (args.regionCrop.offsetX ?? 0), 0, 1 - crop.w)),
        y: round4(clamp(crop.y + (args.regionCrop.offsetY ?? 0), 0, 1 - crop.h)),
      };
    }

    if (crop) heldCrop = crop;
    prevCrop = crop;
    prevSegmentId = segmentId;
    frames.push({ t, crop, fit, subjectKey, confidence, lost });
  }
  return frames;
}

/** Collapse per-sample keyframes into constant render intervals. */
export function keyframesToIntervals(frames: CropKeyframeData[], duration: number): ReframeInterval[] {
  const intervals: ReframeInterval[] = [];
  for (let i = 0; i < frames.length; i += 1) {
    const frame = frames[i]!;
    const start = frame.t;
    const end = i + 1 < frames.length ? frames[i + 1]!.t : duration;
    if (end - start <= 0.01) continue;
    const last = intervals[intervals.length - 1];
    const sameCrop =
      last &&
      last.fit === frame.fit &&
      JSON.stringify(last.crop) === JSON.stringify(frame.crop);
    if (sameCrop) {
      last.end = round3(end);
    } else {
      intervals.push({ start, end: round3(end), crop: frame.crop, fit: frame.fit });
    }
  }
  return intervals;
}


// ---------------------------------------------------------------------------
// Persisted crop paths (computed keyframes) — preview & render share these
// ---------------------------------------------------------------------------

function loadAssociations(jobId: string): AssociationBuild[] {
  const rows = getDb()
    .prepare(
      `SELECT a.*, s.subject_key FROM subject_associations a
       JOIN tracked_subjects s ON s.id = a.subject_id WHERE a.job_id = ? ORDER BY a.window_start_sec`,
    )
    .all(jobId) as unknown as (SubjectAssociationRow & { subject_key: string })[];
  return rows.map((r) => ({
    subjectKey: r.subject_key,
    windowStart: r.window_start_sec,
    windowEnd: r.window_end_sec,
    speechSource: r.speech_source,
    score: r.score,
    confidence: r.confidence,
    isPick: r.is_active_pick === 1,
    evidence: parseJson(r.evidence_json, { mouthMotion: null, presenceRatio: 0, samplesInWindow: 0, note: "" }),
  }));
}

function loadPathSubjects(jobId: string, totalSamples: number): PathSubject[] {
  const subjects = subjectsOfJob(jobId);
  const out: PathSubject[] = [];
  for (const subject of subjects) {
    const rows = getDb()
      .prepare("SELECT * FROM tracking_frames WHERE subject_id = ? ORDER BY t_sec")
      .all(subject.id) as unknown as { t_sec: number; bbox_json: string; confidence: number | null; features_json: string }[];
    out.push({
      key: subject.subject_key,
      kind: subject.kind,
      presence: totalSamples > 0 ? subject.present_samples / totalSamples : 0,
      samples: rows.map((r) => {
        const features = parseJson<{ mouthWidth?: number; noseMouth?: number }>(r.features_json, {});
        return {
          t: r.t_sec,
          box: parseJson<NormBox>(r.bbox_json, { x: 0, y: 0, w: 0, h: 0 }),
          confidence: r.confidence ?? 0,
          mouthWidth: features.mouthWidth ?? null,
          noseMouth: features.noseMouth ?? null,
        };
      }),
    });
  }
  return out;
}

/**
 * Subjects eligible for Split Screen: every face subject, plus person
 * subjects that are NOT the same human as a tracked face. A person
 * detection whose box contains a face's centre in at least half of
 * its samples is that face's owner — counting it again would offer a
 * "two-person" split of one person, which the spec forbids ("do not
 * offer split screen when fewer than 2 suitable subjects exist").
 */
export function splitSubjectKeys(jobId: string): string[] {
  const subjects = subjectsOfJob(jobId);
  const faces = subjects.filter((s) => s.kind === "face");
  const persons = subjects.filter((s) => s.kind === "person");
  const framesOf = (subjectId: string) =>
    getDb()
      .prepare("SELECT t_sec, bbox_json FROM tracking_frames WHERE subject_id = ? ORDER BY t_sec")
      .all(subjectId) as unknown as { t_sec: number; bbox_json: string }[];
  const faceFrames = faces.map((f) => ({ key: f.subject_key, frames: framesOf(f.id) }));
  const eligiblePersons: TrackedSubjectRow[] = [];
  for (const person of persons) {
    const pFrames = framesOf(person.id);
    if (pFrames.length === 0) continue;
    let contained = 0;
    for (const pf of pFrames) {
      const pBox = parseJson<NormBox>(pf.bbox_json, { x: 0, y: 0, w: 0, h: 0 });
      const hit = faceFrames.some((ff) => {
        const near = ff.frames.reduce((best, cur) =>
          Math.abs(cur.t_sec - pf.t_sec) < Math.abs(best.t_sec - pf.t_sec) ? cur : best,
        );
        if (Math.abs(near.t_sec - pf.t_sec) > 0.26) return false;
        const fBox = parseJson<NormBox>(near.bbox_json, { x: 0, y: 0, w: 0, h: 0 });
        const cx = fBox.x + fBox.w / 2;
        const cy = fBox.y + fBox.h / 2;
        return cx >= pBox.x && cx <= pBox.x + pBox.w && cy >= pBox.y && cy <= pBox.y + pBox.h;
      });
      if (hit) contained += 1;
    }
    if (contained / pFrames.length < 0.5) eligiblePersons.push(person);
  }
  const byPresence = (a: TrackedSubjectRow, b: TrackedSubjectRow) =>
    b.present_samples - a.present_samples;
  return [
    ...[...faces].sort(byPresence).map((s) => s.subject_key),
    ...eligiblePersons.sort(byPresence).map((s) => s.subject_key),
  ];
}

export function splitDefaultRegions(layout: string, subjectKeys: string[]): SplitRegion[] {
  const [a, b, c, d] = subjectKeys;
  switch (layout) {
    case "speaker-focused": {
      const regions: SplitRegion[] = [];
      if (a) regions.push({ subjectKey: a, rect: { x: 0, y: 0, w: 0.7, h: 1 } });
      const rest = [b, c].filter(Boolean) as string[];
      rest.forEach((key, i) => {
        regions.push({
          subjectKey: key,
          rect: { x: 0.7, y: rest.length === 1 ? 0 : i * 0.5, w: 0.3, h: rest.length === 1 ? 1 : 0.5 },
        });
      });
      return regions;
    }
    case "main-secondary": {
      const regions: SplitRegion[] = [];
      if (a) regions.push({ subjectKey: a, rect: { x: 0, y: 0, w: 0.62, h: 1 } });
      if (b) regions.push({ subjectKey: b, rect: { x: 0.62, y: 0, w: 0.38, h: 1 } });
      return regions;
    }
    case "equal-split": {
      const keys = [a, b, c, d].filter(Boolean) as string[];
      if (keys.length === 4) {
        return keys.map((key, i) => ({
          subjectKey: key,
          rect: { x: (i % 2) * 0.5, y: Math.floor(i / 2) * 0.5, w: 0.5, h: 0.5 },
        }));
      }
      return keys.map((key, i) => ({
        subjectKey: key,
        rect: { x: i / keys.length, y: 0, w: 1 / keys.length, h: 1 },
      }));
    }
    case "side-by-side":
    default: {
      const regions: SplitRegion[] = [];
      if (a) regions.push({ subjectKey: a, rect: { x: 0, y: 0, w: 0.5, h: 1 } });
      if (b) regions.push({ subjectKey: b, rect: { x: 0.5, y: 0, w: 0.5, h: 1 } });
      return regions;
    }
  }
}

/** Recompute + persist the crop keyframes for a configuration. */
export function recomputeConfigPaths(configRow: ReframeConfigurationRow): void {
  const db = getDb();
  const now = nowIso();
  const done = (bump: boolean) => {
    db.prepare(
      "UPDATE reframe_configurations SET config_version = config_version + ?, updated_at = ? WHERE id = ?",
    ).run(bump ? 1 : 0, now, configRow.id);
  };
  if (!configRow.job_id) {
    db.prepare("DELETE FROM tracking_keyframes WHERE config_id = ? AND kind = 'crop'").run(configRow.id);
    done(false);
    return;
  }
  const job = anyJobById(configRow.job_id);
  const asset = getDb()
    .prepare("SELECT * FROM source_assets WHERE id = ?")
    .get(job?.source_asset_id ?? "") as SourceAssetRow | undefined;
  // RUNNING is accepted because the worker itself recomputes during
  // GENERATING_REFRAME_DATA, before markCompleted: by then subjects
  // and frames are already committed in one transaction, so the data
  // read here is a consistent snapshot either way.
  if (
    !job ||
    (job.status !== "COMPLETED" && job.status !== "RUNNING") ||
    !asset ||
    !asset.width ||
    !asset.height ||
    !asset.duration
  ) {
    done(false);
    return;
  }
  const result = parseJson<{ sampleInterval?: number; totalSamples?: number }>(job.result_json, {});
  const interval = result.sampleInterval ?? config.tracking.sampleIntervalSec;
  const subjects = loadPathSubjects(job.id, result.totalSamples ?? 0);
  const associations = loadAssociations(job.id);
  const scenes = parseJson<SceneRange[]>(job.scenes_json, [{ start: 0, end: asset.duration }]);
  const overrideRows = db
    .prepare("SELECT * FROM scene_tracking_overrides WHERE config_id = ? ORDER BY range_start_sec")
    .all(configRow.id) as unknown as SceneTrackingOverrideRow[];
  const overrides: SceneOverrideLike[] = overrideRows.map((r) => {
    const settings = parseJson<{ controls?: Partial<FollowControls>; fitMode?: string }>(r.settings_json, {});
    return {
      rangeStart: r.range_start_sec,
      rangeEnd: r.range_end_sec,
      mode: r.mode,
      subjectKey: r.subject_key,
      controls: settings.controls ?? null,
      fitMode: settings.fitMode ?? null,
    };
  });
  const manualRows = db
    .prepare("SELECT * FROM tracking_keyframes WHERE config_id = ? AND kind = 'manual' ORDER BY t_sec")
    .all(configRow.id) as unknown as TrackingKeyframeRow[];
  const manual: ManualKeyframeLike[] = manualRows.map((r) => ({
    t: r.t_sec,
    crop: parseJson<NormBox | null>(r.crop_json, null),
    fit: r.fit === "fit" ? "fit" : "fill",
  }));
  const pathExtras = configExtras(configRow);
  const pathConfig: PathConfig = {
    mode: configRow.mode as ReframeMode,
    subjectKey: configRow.subject_key,
    fitMode: configRow.fit_mode,
    targetPosX: configRow.target_pos_x,
    targetPosY: configRow.target_pos_y,
    controls: { ...DEFAULT_CONTROLS, ...parseJson<Partial<FollowControls>>(configRow.controls_json, {}) },
    enabled: configRow.enabled === 1,
    paused: pathExtras.paused,
    manualCrop: pathExtras.manualCrop,
  };
  const srcAspect = asset.width / asset.height;
  const outAspect = configRow.out_width / configRow.out_height;

  const insert = db.prepare(
    `INSERT INTO tracking_keyframes (id, config_id, job_id, region_subject_key, kind, t_sec, crop_json, fit, subject_key, confidence, lost, created_at)
     VALUES (?, ?, ?, ?, 'crop', ?, ?, ?, ?, ?, ?, ?)`,
  );
  const persist = (frames: CropKeyframeData[], regionKey: string | null) => {
    for (const frame of frames) {
      insert.run(
        randomUUID(),
        configRow.id,
        job.id,
        regionKey,
        frame.t,
        frame.crop ? JSON.stringify(frame.crop) : null,
        frame.fit,
        frame.subjectKey,
        frame.confidence,
        frame.lost ? 1 : 0,
        now,
      );
    }
  };

  transaction(() => {
    db.prepare("DELETE FROM tracking_keyframes WHERE config_id = ? AND kind = 'crop'").run(configRow.id);
    if (configRow.mode === "split-screen") {
      const layoutRow = db
        .prepare("SELECT * FROM split_screen_layouts WHERE config_id = ?")
        .get(configRow.id) as SplitScreenLayoutRow | undefined;
      const layout = layoutRow?.layout ?? "side-by-side";
      let regions = layoutRow
        ? parseJson<SplitRegion[]>(layoutRow.regions_json, [])
        : [];
      if (regions.length === 0) {
        regions = splitDefaultRegions(layout, splitSubjectKeys(job.id));
      }
      for (const region of regions) {
        const regionAspect = (region.rect.w * configRow.out_width) / (region.rect.h * configRow.out_height);
        const frames = computeCropPath({
          config: pathConfig,
          subjects,
          associations,
          scenes,
          overrides,
          manual: [],
          duration: asset.duration!,
          interval,
          srcAspect,
          outAspect,
          regionSubjectKey: region.subjectKey,
          regionAspect,
          regionCrop: region.crop ?? null,
        });
        persist(frames, region.subjectKey);
      }
    } else {
      const frames = computeCropPath({
        config: pathConfig,
        subjects,
        associations,
        scenes,
        overrides,
        manual,
        duration: asset.duration!,
        interval,
        srcAspect,
        outAspect,
      });
      persist(frames, null);
    }
  });
  done(true);
}

/** Build the render payload from the persisted keyframes. */
export function buildReframePayload(
  configRow: ReframeConfigurationRow,
): { payload: ReframeRenderPayload; duration: number } | { error: string; code: string } {
  const db = getDb();
  if (!configRow.job_id) return { error: "Run subject tracking before rendering a reframed export.", code: "NO_TRACKING" };
  const job = anyJobById(configRow.job_id);
  if (!job || job.status !== "COMPLETED") {
    return { error: "Tracking data for this configuration is not complete.", code: "NO_TRACKING" };
  }
  const asset = db
    .prepare("SELECT * FROM source_assets WHERE id = ?")
    .get(job.source_asset_id) as SourceAssetRow | undefined;
  if (!asset?.duration) return { error: "Tracked source asset is missing.", code: "NOT_FOUND" };
  const duration = asset.duration;
  const toData = (rows: TrackingKeyframeRow[]): CropKeyframeData[] =>
    rows.map((r) => ({
      t: r.t_sec,
      crop: parseJson<NormBox | null>(r.crop_json, null),
      fit: r.fit === "fit" ? "fit" : "fill",
      subjectKey: r.subject_key,
      confidence: r.confidence,
      lost: r.lost === 1,
    }));
  if (configRow.mode === "split-screen") {
    const layoutRow = db
      .prepare("SELECT * FROM split_screen_layouts WHERE config_id = ?")
      .get(configRow.id) as SplitScreenLayoutRow | undefined;
    const layout = layoutRow?.layout ?? "side-by-side";
    let regions = layoutRow ? parseJson<SplitRegion[]>(layoutRow.regions_json, []) : [];
    if (regions.length === 0) {
      regions = splitDefaultRegions(layout, splitSubjectKeys(job.id));
    }
    if (regions.length < 2) {
      return {
        error: "Split Screen needs at least two tracked subjects in this video.",
        code: "SPLIT_NEEDS_SUBJECTS",
      };
    }
    return {
      duration,
      payload: {
        configId: configRow.id,
        mode: "split-screen",
        jobId: job.id,
        sourceAssetId: job.source_asset_id,
        intervals: [],
        split: {
          layout,
          regions: regions.map((region) => {
            const rows = db
              .prepare(
                "SELECT * FROM tracking_keyframes WHERE config_id = ? AND kind = 'crop' AND region_subject_key = ? ORDER BY t_sec",
              )
              .all(configRow.id, region.subjectKey) as unknown as TrackingKeyframeRow[];
            return {
              subjectKey: region.subjectKey,
              rect: region.rect,
              intervals: keyframesToIntervals(toData(rows), duration),
            };
          }),
        },
      },
    };
  }
  const rows = db
    .prepare(
      "SELECT * FROM tracking_keyframes WHERE config_id = ? AND kind = 'crop' AND region_subject_key IS NULL ORDER BY t_sec",
    )
    .all(configRow.id) as unknown as TrackingKeyframeRow[];
  if (rows.length === 0) {
    return { error: "No crop keyframes exist for this configuration yet.", code: "NO_TRACKING" };
  }
  return {
    duration,
    payload: {
      configId: configRow.id,
      mode: configRow.mode as ReframeMode,
      jobId: job.id,
      sourceAssetId: job.source_asset_id,
      intervals: keyframesToIntervals(toData(rows), duration),
      split: null,
    },
  };
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

async function detectScenes(jobId: string, srcPath: string, duration: number): Promise<SceneRange[]> {
  let cuts: number[] = [];
  try {
    const { stderr } = await runCommand(
      jobId,
      "ffmpeg",
      ["-hide_banner", "-i", srcPath, "-vf", "select='gt(scene\\,0.4)',showinfo", "-f", "null", "-"],
      300_000,
    );
    cuts = [...stderr.matchAll(/pts_time:([0-9.]+)/g)]
      .map((m) => Number(m[1]))
      .filter((t) => t > 0.3 && t < duration - 0.3)
      .sort((a, b) => a - b);
  } catch {
    cuts = []; // scene detection is best-effort; tracking still works as one scene
  }
  const bounds = [0, ...cuts.filter((t, i) => i === 0 || t - cuts[i - 1]! > 0.2), duration];
  const scenes: SceneRange[] = [];
  for (let i = 0; i + 1 < bounds.length; i += 1) {
    scenes.push({ start: round3(bounds[i]!), end: round3(bounds[i + 1]!) });
  }
  return scenes.length > 0 ? scenes : [{ start: 0, end: round3(duration) }];
}

interface TrackerLine {
  type: string;
  stage?: string;
  done?: number;
  total?: number;
  message?: string;
}

function runTracker(
  jobId: string,
  srcPath: string,
  workdir: string,
  optionsPath: string,
): Promise<TrackResult> {
  return new Promise((resolve, reject) => {
    const script = path.join(serverDir, "scripts", "track.py");
    const child = spawn(config.pythonBin, [script, srcPath, workdir, optionsPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    registerChild(jobId, child);
    let buffer = "";
    let stderr = "";
    let result: TrackResult | null = null;
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      reject(new Error("Vision tracking timed out (30 min)"));
    }, 1_800_000);
    child.stdout.on("data", (d: Buffer) => {
      buffer += d.toString("utf8");
      let idx = buffer.indexOf("\n");
      while (idx >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf("\n");
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as TrackerLine & TrackResult;
          if (parsed.type === "progress") {
            const stage = parsed.stage === "DETECTING_SUBJECTS" ? "DETECTING_SUBJECTS" : "TRACKING_SUBJECTS";
            try {
              setStage(jobId, stage);
            } catch {
              /* cancelled mid-stream */
            }
            setProgress(jobId, { done: parsed.done ?? 0, total: parsed.total ?? 0 });
          } else if (parsed.type === "result") {
            result = parsed as TrackResult;
          }
        } catch {
          /* non-JSON noise line */
        }
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString("utf8")).slice(-20_000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (result) resolve(result);
      else reject(new Error(stderr.trim().slice(-600) || `track.py exited with code ${code}`));
    });
  });
}

async function makeThumbnail(
  jobId: string,
  userId: string,
  srcPath: string,
  srcW: number,
  srcH: number,
  subject: { key: string; bestT: number; bestBox: NormBox },
): Promise<string | null> {
  const box = subject.bestBox;
  const expand = 0.45;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const w = Math.min(1, box.w * (1 + expand));
  const h = Math.min(1, box.h * (1 + expand));
  const x = clamp(cx - w / 2, 0, 1 - w);
  const y = clamp(cy - h / 2, 0, 1 - h);
  const px = Math.max(16, Math.floor(x * srcW));
  const py = Math.max(16, Math.floor(y * srcH));
  const pw = Math.max(16, Math.floor(w * srcW));
  const ph = Math.max(16, Math.floor(h * srcH));
  const relDir = path.join(userId, "tracking", jobId);
  const absDir = path.join(config.mediaDir, relDir);
  fs.mkdirSync(absDir, { recursive: true });
  const relPath = path.join(relDir, `${subject.key}.jpg`);
  try {
    await runCommand(jobId, "ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-ss", String(Math.max(0, subject.bestT)),
      "-i", srcPath,
      "-frames:v", "1",
      "-vf", `crop=${pw}:${ph}:${px}:${py},scale=192:-2`,
      "-q:v", "3",
      path.join(config.mediaDir, relPath),
    ], 60_000);
    return relPath;
  } catch {
    return null;
  }
}


async function processTrackingJob(jobId: string): Promise<void> {
  const db = getDb();
  const job = jobRow(jobId);
  if (!job || job.status === "CANCELLED") return;
  const workdir = path.join(config.processingDir, "tracking", jobId);
  try {
    const status = trackingProviderStatus();
    if (!status.configured || !status.faceModel) {
      markFailed(jobId, new Error(status.detail), "CONFIGURATION_ERROR");
      return;
    }
    const asset = db
      .prepare("SELECT * FROM source_assets WHERE id = ? AND user_id = ?")
      .get(job.source_asset_id, job.user_id) as SourceAssetRow | undefined;
    if (!asset?.storage_key) throw new Error("Source asset not found for this tracking job.");
    const srcPath = mediaPath(asset.storage_key);
    if (!fs.existsSync(srcPath)) throw new Error("Source media file is missing from storage.");

    // VALIDATING — re-probe the real file; never trust stale metadata.
    setStage(jobId, "VALIDATING");
    const probe = await probeFile(srcPath);
    const duration = probe.duration ?? asset.duration ?? 0;
    if (!probe.width || !probe.height || !(duration > 0)) {
      throw new Error("Source has no readable video stream to track.");
    }
    const settings = parseJson<{ sampleInterval?: number; sampleWidth?: number }>(job.settings_json, {});
    const sampleInterval = settings.sampleInterval ?? config.tracking.sampleIntervalSec;
    const sampleWidth = settings.sampleWidth ?? config.tracking.sampleWidth;

    // DETECTING_SCENES — real FFmpeg scene-cut detection.
    setStage(jobId, "DETECTING_SCENES");
    const scenes = await detectScenes(jobId, srcPath, duration);
    db.prepare("UPDATE tracking_jobs SET scenes_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(scenes), nowIso(), jobId);

    // Vision pass (Python child): faces + persons + VAD speech activity.
    fs.mkdirSync(workdir, { recursive: true });
    let wavPath: string | null = null;
    if (probe.hasAudio) {
      wavPath = path.join(workdir, "audio.wav");
      await runCommand(jobId, "ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y", "-i", srcPath,
        "-vn", "-ac", "1", "-ar", "16000", wavPath,
      ]);
    }
    const options = {
      faceModel: status.faceModel,
      personModel: status.personModel,
      vadWav: wavPath,
      vadModel: status.vadModel,
      sampleInterval,
      sampleWidth,
      faceScoreThreshold: config.tracking.faceScoreThreshold,
      personScoreThreshold: config.tracking.personScoreThreshold,
    };
    const optionsPath = path.join(workdir, "options.json");
    fs.writeFileSync(optionsPath, JSON.stringify(options));
    setStage(jobId, "DETECTING_SUBJECTS");
    const detected = await runTracker(jobId, srcPath, workdir, optionsPath);
    throwIfCancelled(jobId);

    // TRACKING_SUBJECTS — association per scene (no carry-over across cuts).
    setStage(jobId, "TRACKING_SUBJECTS");
    const builds: SubjectBuild[] = [];
    for (const scene of scenes) {
      const sceneFrames = detected.frames.filter((f) => f.t >= scene.start && f.t < scene.end);
      builds.push(...associateDetections(sceneFrames, "face", scene.start));
      builds.push(...associateDetections(sceneFrames, "person", scene.start));
    }
    const kept = builds.filter(
      (b) => b.samples.length >= 2 || (b.samples.length === 1 && (b.samples[0]?.confidence ?? 0) >= 0.92),
    );
    const totalSamples = detected.frames.length;
    const subjectIds = new Map<string, string>();
    const now = nowIso();
    transaction(() => {
      for (const build of kept) {
        const id = randomUUID();
        subjectIds.set(build.key, id);
        const confidences = build.samples.map((s) => s.confidence);
        const best = build.samples.reduce((a, b) => (b.confidence > a.confidence ? b : a), build.samples[0]!);
        db.prepare(
          `INSERT INTO tracked_subjects (id, job_id, subject_key, kind, first_seen_sec, last_seen_sec,
             present_samples, total_samples, mean_confidence, best_confidence, best_time_sec, best_bbox_json, thumb_path, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        ).run(
          id,
          jobId,
          build.key,
          build.kind,
          build.samples[0]!.t,
          build.samples[build.samples.length - 1]!.t,
          build.samples.length,
          totalSamples,
          round4(confidences.reduce((a, b) => a + b, 0) / confidences.length),
          best.confidence,
          best.t,
          JSON.stringify(best.box),
          now,
        );
        for (const sample of build.samples) {
          db.prepare(
            `INSERT INTO tracking_frames (id, job_id, subject_id, t_sec, bbox_json, confidence, features_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            randomUUID(),
            jobId,
            id,
            sample.t,
            JSON.stringify(sample.box),
            sample.confidence,
            JSON.stringify({ mouthWidth: sample.mouthWidth, noseMouth: sample.noseMouth }),
            now,
          );
        }
      }
    });

    // ANALYZING_AUDIO — speech windows: Phase 4 transcript if present,
    // else Silero VAD; neither is ever invented.
    setStage(jobId, "ANALYZING_AUDIO");
    let windows: SpeechWindow[] = [];
    const transcript = db
      .prepare(
        "SELECT * FROM transcripts WHERE project_id = ? AND source_asset_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(job.project_id, job.source_asset_id) as TranscriptRow | undefined;
    if (transcript) {
      const segments = db
        .prepare(
          "SELECT * FROM transcript_segments WHERE transcript_id = ? AND is_gap = 0 ORDER BY start_sec",
        )
        .all(transcript.id) as unknown as TranscriptSegmentRow[];
      windows = segments
        .filter((s) => s.end_sec > s.start_sec)
        .map((s) => ({ start: s.start_sec, end: s.end_sec, source: "transcript" as const }));
    }
    if (windows.length === 0 && detected.vadSpeech && detected.vadSpeech.length > 0) {
      windows = detected.vadSpeech.map((w) => ({ ...w, source: "vad" as const }));
    }

    // ASSOCIATING_SPEAKERS — evidence + scores persisted per window.
    setStage(jobId, "ASSOCIATING_SPEAKERS");
    const faceBuilds = kept.filter((b) => b.kind === "face");
    const associations = scoreActiveSpeakers(faceBuilds, windows);
    transaction(() => {
      for (const assoc of associations) {
        const subjectId = subjectIds.get(assoc.subjectKey);
        if (!subjectId) continue;
        db.prepare(
          `INSERT INTO subject_associations (id, job_id, subject_id, window_start_sec, window_end_sec,
             speech_source, score, confidence, is_active_pick, evidence_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          randomUUID(),
          jobId,
          subjectId,
          assoc.windowStart,
          assoc.windowEnd,
          assoc.speechSource,
          assoc.score,
          assoc.confidence,
          assoc.isPick ? 1 : 0,
          JSON.stringify(assoc.evidence),
          nowIso(),
        );
      }
    });

    // GENERATING_REFRAME_DATA — default configuration + crop keyframes
    // for the project's editor document.
    setStage(jobId, "GENERATING_REFRAME_DATA");
    const resultSummary: Record<string, unknown> = {
      faceSubjects: kept.filter((b) => b.kind === "face").length,
      personSubjects: kept.filter((b) => b.kind === "person").length,
      totalSamples,
      sampleInterval: detected.sampleInterval,
      sampleWidth: detected.sampleWidth,
      sampleHeight: detected.sampleHeight,
      faceModel: detected.faceModel,
      personModel: detected.personModel,
      vadError: detected.vadError,
      speechWindows: windows.length,
      speechSource: windows[0]?.source ?? null,
      associations: associations.length,
      activePicks: associations.filter((a) => a.isPick).length,
    };
    db.prepare("UPDATE tracking_jobs SET result_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(resultSummary), nowIso(), jobId);

    const project = db
      .prepare("SELECT * FROM projects WHERE id = ? AND user_id = ?")
      .get(job.project_id, job.user_id) as ProjectRow | undefined;
    if (project) {
      const { doc } = getOrCreateDoc(job.user_id, project, null);
      let configRow = configByVersion(job.user_id, doc.id);
      if (!configRow) {
        const onlyFace = kept.filter((b) => b.kind === "face");
        const state = readState(doc);
        const preset = Object.entries(ASPECT_PRESETS).find(
          ([, dims]) => dims.width === state.canvas.width && dims.height === state.canvas.height,
        );
        const id = randomUUID();
        db.prepare(
          `INSERT INTO reframe_configurations (id, version_id, user_id, project_id, job_id, mode, enabled,
             aspect, out_width, out_height, fit_mode, subject_key, target_pos_x, target_pos_y, controls_json,
             config_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'smart-auto', 1, ?, ?, ?, 'smart-crop', ?, 'center', 'middle', ?, 1, ?, ?)`,
        ).run(
          id,
          doc.id,
          job.user_id,
          job.project_id,
          jobId,
          preset ? preset[0] : "custom",
          state.canvas.width,
          state.canvas.height,
          onlyFace.length === 1 ? onlyFace[0]!.key : null,
          JSON.stringify(DEFAULT_CONTROLS),
          nowIso(),
          nowIso(),
        );
        configRow = configById(job.user_id, id);
      } else if (configRow.job_id !== jobId) {
        db.prepare("UPDATE reframe_configurations SET job_id = ?, updated_at = ? WHERE id = ?")
          .run(jobId, nowIso(), configRow.id);
        configRow = configById(job.user_id, configRow.id);
      }
      if (configRow) recomputeConfigPaths(configRow);
    }

    // GENERATING_PREVIEW — real face thumbnails cropped from the source.
    setStage(jobId, "GENERATING_PREVIEW");
    const subjectRows = subjectsOfJob(jobId);
    for (const subject of subjectRows) {
      const bestBox = parseJson<NormBox | null>(subject.best_bbox_json, null);
      if (!bestBox || subject.best_time_sec === null) continue;
      const thumb = await makeThumbnail(jobId, job.user_id, srcPath, probe.width, probe.height, {
        key: subject.subject_key,
        bestT: subject.best_time_sec,
        bestBox,
      });
      if (thumb) {
        db.prepare("UPDATE tracked_subjects SET thumb_path = ? WHERE id = ?").run(thumb, subject.id);
      }
    }

    markCompleted(jobId, kept.length > 0 ? "SUBJECTS_FOUND" : "NO_SUBJECTS", resultSummary);
  } catch (err) {
    if (err instanceof JobCancelled || jobRow(jobId)?.cancel_requested === 1) {
      killChildren(jobId);
      markCancelled(jobId);
    } else {
      markFailed(jobId, err);
    }
  } finally {
    fs.rm(workdir, { recursive: true, force: true }, () => undefined);
  }
}

let workerBusy = false;
let workerTimer: NodeJS.Timeout | null = null;

async function tickWorker(): Promise<void> {
  if (workerBusy) return;
  const next = getDb()
    .prepare(
      "SELECT * FROM tracking_jobs WHERE status = 'QUEUED' ORDER BY created_at ASC LIMIT 1",
    )
    .get() as TrackingJobRow | undefined;
  if (!next) return;
  workerBusy = true;
  getDb()
    .prepare(
      "UPDATE tracking_jobs SET status = 'RUNNING', stage = 'VALIDATING', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ? AND status = 'QUEUED'",
    )
    .run(nowIso(), nowIso(), next.id);
  try {
    await processTrackingJob(next.id);
  } finally {
    workerBusy = false;
  }
}

export function startTrackingWorker(): void {
  // Boot recovery: a job left mid-flight by a restart is marked failed
  // honestly (same as Phase 4) instead of hanging forever.
  const stuck = getDb()
    .prepare("SELECT id FROM tracking_jobs WHERE status = 'RUNNING'")
    .all() as unknown as { id: string }[];
  for (const row of stuck) {
    getDb()
      .prepare(
        "UPDATE tracking_jobs SET status = 'FAILED', error = 'Tracking was interrupted by a server restart. Use Retry to run it again.', error_code = 'INTERRUPTED', finished_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(nowIso(), nowIso(), row.id);
  }
  if (workerTimer) return;
  workerTimer = setInterval(() => {
    tickWorker().catch(() => undefined);
  }, 400);
}


// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

interface AuthedRequest extends Request {
  user?: UserRow;
  sessionId?: string;
}
type RequireAuth = (req: AuthedRequest, res: Response, next: NextFunction) => void;

function userIdOf(req: Request): string {
  return (req as AuthedRequest).user!.id;
}

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

const boxSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().gt(0).max(1),
  h: z.number().gt(0).max(1),
});

const controlsSchema = z
  .object({
    sensitivity: z.number().min(0).max(1).optional(),
    followSpeed: z.number().min(0).max(1).optional(),
    smoothing: z.number().min(0).max(1).optional(),
    margin: z.number().min(0).max(1).optional(),
    zoom: z.number().min(0).max(1).optional(),
    aggressiveness: z.number().min(0).max(1).optional(),
  })
  .strict();

function publicKeyframe(r: TrackingKeyframeRow) {
  return {
    id: r.id,
    kind: r.kind,
    t: r.t_sec,
    crop: parseJson<NormBox | null>(r.crop_json, null),
    fit: r.fit,
    subjectKey: r.subject_key,
    regionSubjectKey: r.region_subject_key,
    confidence: r.confidence,
    lost: r.lost === 1,
  };
}

function publicAssociation(a: AssociationBuild & { id?: string }) {
  return {
    subjectKey: a.subjectKey,
    windowStart: a.windowStart,
    windowEnd: a.windowEnd,
    speechSource: a.speechSource,
    score: a.score,
    confidence: a.confidence,
    isActivePick: a.isPick,
    evidence: a.evidence,
  };
}

function ensureConfig(userId: string, doc: ReturnType<typeof docById> & object): ReframeConfigurationRow {
  const existing = configByVersion(userId, doc.id);
  if (existing) return existing;
  const db = getDb();
  // Latest completed tracking job for this project's source asset.
  const asset = sourceAssetOf(userId, doc.project_id);
  const job = asset
    ? (db
        .prepare(
          "SELECT * FROM tracking_jobs WHERE user_id = ? AND source_asset_id = ? AND status = 'COMPLETED' ORDER BY created_at DESC LIMIT 1",
        )
        .get(userId, asset.id) as TrackingJobRow | undefined)
    : undefined;
  const state = readState(doc);
  const preset = Object.entries(ASPECT_PRESETS).find(
    ([, dims]) => dims.width === state.canvas.width && dims.height === state.canvas.height,
  );
  let subjectKey: string | null = null;
  if (job) {
    const faces = subjectsOfJob(job.id).filter((s) => s.kind === "face");
    if (faces.length === 1) subjectKey = faces[0]!.subject_key;
  }
  const id = randomUUID();
  db.prepare(
    `INSERT INTO reframe_configurations (id, version_id, user_id, project_id, job_id, mode, enabled,
       aspect, out_width, out_height, fit_mode, subject_key, target_pos_x, target_pos_y, controls_json,
       config_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'smart-auto', 1, ?, ?, ?, 'smart-crop', ?, 'center', 'middle', ?, 1, ?, ?)`,
  ).run(
    id,
    doc.id,
    userId,
    doc.project_id,
    job?.id ?? null,
    preset ? preset[0] : "custom",
    state.canvas.width,
    state.canvas.height,
    subjectKey,
    JSON.stringify(DEFAULT_CONTROLS),
    nowIso(),
    nowIso(),
  );
  return configById(userId, id)!;
}

function reframeState(userId: string, docId: string) {
  const doc = docById(userId, docId);
  if (!doc) return null;
  const db = getDb();
  const configRow = ensureConfig(userId, doc);
  const job = configRow.job_id ? anyJobById(configRow.job_id) : undefined;
  const asset = sourceAssetOf(userId, doc.project_id);
  const latestJob = asset
    ? (db
        .prepare(
          "SELECT * FROM tracking_jobs WHERE user_id = ? AND source_asset_id = ? ORDER BY created_at DESC LIMIT 1",
        )
        .get(userId, asset.id) as TrackingJobRow | undefined)
    : undefined;
  const subjects = job ? subjectsOfJob(job.id) : [];
  const subjectFrames: Record<string, { t: number; box: NormBox; confidence: number | null }[]> = {};
  if (job) {
    for (const subject of subjects) {
      const rows = db
        .prepare(
          "SELECT t_sec, bbox_json, confidence FROM tracking_frames WHERE subject_id = ? ORDER BY t_sec LIMIT 2000",
        )
        .all(subject.id) as unknown as { t_sec: number; bbox_json: string; confidence: number | null }[];
      subjectFrames[subject.subject_key] = rows.map((r) => ({
        t: r.t_sec,
        box: parseJson<NormBox>(r.bbox_json, { x: 0, y: 0, w: 0, h: 0 }),
        confidence: r.confidence,
      }));
    }
  }
  const keyframeRows = db
    .prepare("SELECT * FROM tracking_keyframes WHERE config_id = ? ORDER BY t_sec")
    .all(configRow.id) as unknown as TrackingKeyframeRow[];
  const overrideRows = db
    .prepare("SELECT * FROM scene_tracking_overrides WHERE config_id = ? ORDER BY range_start_sec")
    .all(configRow.id) as unknown as SceneTrackingOverrideRow[];
  const splitRow = db
    .prepare("SELECT * FROM split_screen_layouts WHERE config_id = ?")
    .get(configRow.id) as SplitScreenLayoutRow | undefined;
  const status = trackingProviderStatus();
  return {
    config: publicConfig(configRow),
    provider: {
      configured: status.configured,
      personConfigured: status.personConfigured,
      detail: status.detail,
    },
    job: job ? publicTrackingJob(job) : null,
    latestJob: latestJob ? publicTrackingJob(latestJob) : null,
    sourceAsset: asset
      ? {
          id: asset.id,
          width: asset.width,
          height: asset.height,
          duration: asset.duration,
          hasAudio: asset.has_audio === 1,
        }
      : null,
    subjects: subjects.map((s) => publicSubject(s, `/api/tracking-jobs/${job!.id}/subjects`)),
    subjectFrames,
    splitEligibleKeys: job ? splitSubjectKeys(job.id) : [],
    associations: job ? loadAssociations(job.id).map(publicAssociation) : [],
    scenes: job ? parseJson<SceneRange[]>(job.scenes_json, []) : [],
    keyframes: keyframeRows.filter((r) => r.kind === "crop" && !r.region_subject_key).map(publicKeyframe),
    regionKeyframes: Object.fromEntries(
      subjects.map((s) => [
        s.subject_key,
        keyframeRows
          .filter((r) => r.kind === "crop" && r.region_subject_key === s.subject_key)
          .map(publicKeyframe),
      ]),
    ),
    manualKeyframes: keyframeRows.filter((r) => r.kind === "manual").map(publicKeyframe),
    sceneOverrides: overrideRows.map((r) => ({
      id: r.id,
      topicSegmentId: r.topic_segment_id,
      rangeStart: r.range_start_sec,
      rangeEnd: r.range_end_sec,
      mode: r.mode,
      subjectKey: r.subject_key,
      settings: parseJson<Record<string, unknown>>(r.settings_json, {}),
    })),
    split: splitRow
      ? { layout: splitRow.layout, regions: parseJson<SplitRegion[]>(splitRow.regions_json, []) }
      : null,
  };
}

export function registerTrackingRoutes(app: Express, requireAuth: RequireAuth): void {
  // ---- provider status ----------------------------------------------------
  app.get("/api/tracking/status", requireAuth, (_req, res) => {
    const status = trackingProviderStatus();
    res.json({
      configured: status.configured,
      personConfigured: status.personConfigured,
      faceModel: status.faceModel ? path.basename(status.faceModel) : null,
      personModel: status.personModel ? path.basename(status.personModel) : null,
      vadModel: status.vadModel ? path.basename(status.vadModel) : null,
      detail: status.detail,
    });
  });

  // ---- tracking jobs --------------------------------------------------------
  const createJobSchema = z
    .object({
      sampleInterval: z.number().min(0.25).max(2).optional(),
      sampleWidth: z.number().int().min(320).max(640).optional(),
    })
    .strict();

  app.post("/api/projects/:projectId/tracking-jobs", requireAuth, (req, res) => {
    const userId = userIdOf(req);
    const project = ownedProject(userId, String(req.params.projectId));
    if (!project) return fail(res, 404, "NOT_FOUND", "Project not found.");
    const parsed = createJobSchema.safeParse(req.body ?? {});
    if (!parsed.success) return fail(res, 400, "VALIDATION_ERROR", "Invalid tracking settings.");
    const status = trackingProviderStatus();
    if (!status.configured) {
      return fail(res, 422, "CONFIGURATION_ERROR", status.detail);
    }
    const asset = sourceAssetOf(userId, project.id);
    if (!asset) return fail(res, 409, "NO_SOURCE", "This project has no source video to track.");
    const db = getDb();
    const duplicate = db
      .prepare(
        `SELECT * FROM tracking_jobs WHERE user_id = ? AND project_id = ? AND source_asset_id = ?
         AND status IN ('QUEUED', 'RUNNING') ORDER BY created_at DESC LIMIT 1`,
      )
      .get(userId, project.id, asset.id) as TrackingJobRow | undefined;
    if (duplicate) {
      return res.status(200).json({ job: publicTrackingJob(duplicate), deduplicated: true });
    }
    const id = randomUUID();
    const settings = {
      sampleInterval: parsed.data.sampleInterval ?? config.tracking.sampleIntervalSec,
      sampleWidth: parsed.data.sampleWidth ?? config.tracking.sampleWidth,
    };
    db.prepare(
      `INSERT INTO tracking_jobs (id, user_id, project_id, source_asset_id, settings_json, status, stage, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'QUEUED', 'QUEUED', ?, ?)`,
    ).run(id, userId, project.id, asset.id, JSON.stringify(settings), nowIso(), nowIso());
    return res.status(201).json({ job: publicTrackingJob(jobById(userId, id)!), deduplicated: false });
  });

  app.get("/api/projects/:projectId/tracking-jobs", requireAuth, (req, res) => {
    const userId = userIdOf(req);
    const project = ownedProject(userId, String(req.params.projectId));
    if (!project) return fail(res, 404, "NOT_FOUND", "Project not found.");
    const rows = getDb()
      .prepare("SELECT * FROM tracking_jobs WHERE user_id = ? AND project_id = ? ORDER BY created_at DESC")
      .all(userId, project.id) as unknown as TrackingJobRow[];
    return res.json({ jobs: rows.map(publicTrackingJob) });
  });

  app.get("/api/tracking-jobs/:jobId", requireAuth, (req, res) => {
    const job = jobById(userIdOf(req), String(req.params.jobId));
    if (!job) return fail(res, 404, "NOT_FOUND", "Tracking job not found.");
    return res.json({ job: publicTrackingJob(job) });
  });

  app.post("/api/tracking-jobs/:jobId/cancel", requireAuth, (req, res) => {
    const userId = userIdOf(req);
    const job = jobById(userId, String(req.params.jobId));
    if (!job) return fail(res, 404, "NOT_FOUND", "Tracking job not found.");
    if (!ACTIVE_STATUSES.includes(job.status as (typeof ACTIVE_STATUSES)[number])) {
      return fail(res, 409, "NOT_ACTIVE", "Only an active tracking job can be cancelled.");
    }
    if (job.status === "QUEUED") {
      getDb()
        .prepare(
          "UPDATE tracking_jobs SET status = 'CANCELLED', stage = 'CANCELLED', finished_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(nowIso(), nowIso(), job.id);
    } else {
      getDb()
        .prepare("UPDATE tracking_jobs SET cancel_requested = 1, updated_at = ? WHERE id = ?")
        .run(nowIso(), job.id);
      killChildren(job.id);
    }
    return res.json({ job: publicTrackingJob(jobById(userId, job.id)!) });
  });

  app.post("/api/tracking-jobs/:jobId/retry", requireAuth, (req, res) => {
    const userId = userIdOf(req);
    const job = jobById(userId, String(req.params.jobId));
    if (!job) return fail(res, 404, "NOT_FOUND", "Tracking job not found.");
    if (job.status !== "FAILED" && job.status !== "CANCELLED") {
      return fail(res, 409, "NOT_RETRYABLE", "Only a failed or cancelled tracking job can be retried.");
    }
    const status = trackingProviderStatus();
    if (!status.configured) return fail(res, 422, "CONFIGURATION_ERROR", status.detail);
    const db = getDb();
    const duplicate = db
      .prepare(
        `SELECT * FROM tracking_jobs WHERE user_id = ? AND project_id = ? AND source_asset_id = ?
         AND status IN ('QUEUED', 'RUNNING') ORDER BY created_at DESC LIMIT 1`,
      )
      .get(userId, job.project_id, job.source_asset_id) as TrackingJobRow | undefined;
    if (duplicate) {
      return res.status(200).json({ job: publicTrackingJob(duplicate), deduplicated: true });
    }
    const id = randomUUID();
    db.prepare(
      `INSERT INTO tracking_jobs (id, user_id, project_id, source_asset_id, settings_json, status, stage, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'QUEUED', 'QUEUED', ?, ?)`,
    ).run(id, userId, job.project_id, job.source_asset_id, job.settings_json, nowIso(), nowIso());
    return res.status(201).json({ job: publicTrackingJob(jobById(userId, id)!), deduplicated: false });
  });

  // Subject thumbnails — real crops from the source, owner-checked.
  app.get("/api/tracking-jobs/:jobId/subjects/:subjectId/thumbnail", requireAuth, (req, res) => {
    const userId = userIdOf(req);
    const job = jobById(userId, String(req.params.jobId));
    if (!job) return fail(res, 404, "NOT_FOUND", "Tracking job not found.");
    const subject = getDb()
      .prepare("SELECT * FROM tracked_subjects WHERE id = ? AND job_id = ?")
      .get(String(req.params.subjectId), job.id) as TrackedSubjectRow | undefined;
    if (!subject?.thumb_path) return fail(res, 404, "NOT_FOUND", "No thumbnail for this subject.");
    const abs = mediaPath(subject.thumb_path);
    if (!fs.existsSync(abs)) return fail(res, 404, "NOT_FOUND", "Thumbnail file is missing.");
    res.type("image/jpeg");
    return res.sendFile(abs);
  });


  // ---- editor reframe state & configuration --------------------------------

  app.get("/api/editor/:docId/reframe", requireAuth, (req, res) => {
    const state = reframeState(userIdOf(req), String(req.params.docId));
    if (!state) return fail(res, 404, "NOT_FOUND", "Editor document not found.");
    return res.json(state);
  });

  const configSchema = z
    .object({
      mode: z.enum(REFRAME_MODES as [ReframeMode, ...ReframeMode[]]).optional(),
      enabled: z.boolean().optional(),
      aspect: z.string().min(1).max(16).optional(),
      outWidth: z.number().int().min(16).max(4096).optional(),
      outHeight: z.number().int().min(16).max(4096).optional(),
      fitMode: z.enum(FIT_MODES).optional(),
      subjectKey: z.string().max(80).nullable().optional(),
      targetPosX: z.enum(["left", "center", "right"]).optional(),
      targetPosY: z.enum(["upper", "middle"]).optional(),
      controls: controlsSchema.optional(),
      /** Persisted Auto-Follow pause (stored in controls_json). */
      paused: z.boolean().optional(),
      /** Manual crop rectangle for fitMode "manual-crop" (controls_json). */
      manualCrop: boxSchema.nullable().optional(),
    })
    .strict();

  app.put("/api/editor/:docId/reframe/config", requireAuth, (req, res) => {
    const userId = userIdOf(req);
    const doc = docById(userId, String(req.params.docId));
    if (!doc) return fail(res, 404, "NOT_FOUND", "Editor document not found.");
    const parsed = configSchema.safeParse(req.body ?? {});
    if (!parsed.success) return fail(res, 400, "VALIDATION_ERROR", "Invalid reframe configuration.");
    const data = parsed.data;
    const db = getDb();
    const configRow = ensureConfig(userId, doc);
    const subjects = configRow.job_id ? subjectsOfJob(configRow.job_id) : [];
    if (data.subjectKey != null && !subjects.some((s) => s.subject_key === data.subjectKey)) {
      return fail(res, 400, "VALIDATION_ERROR", "That subject does not exist in the tracked video.");
    }
    const nextMode = data.mode ?? (configRow.mode as ReframeMode);
    if (
      nextMode === "split-screen" &&
      (!configRow.job_id || splitSubjectKeys(configRow.job_id).length < 2)
    ) {
      return fail(
        res,
        422,
        "SPLIT_NEEDS_SUBJECTS",
        "Split Screen needs at least two distinct tracked people in this video, so it is not offered here.",
      );
    }
    let outWidth = configRow.out_width;
    let outHeight = configRow.out_height;
    let aspect = configRow.aspect;
    if (data.aspect) {
      aspect = data.aspect;
      const preset = (ASPECT_PRESETS as Record<string, { width: number; height: number }>)[data.aspect];
      if (preset) {
        outWidth = preset.width;
        outHeight = preset.height;
      } else if (data.aspect === "custom") {
        outWidth = data.outWidth ?? outWidth;
        outHeight = data.outHeight ?? outHeight;
      } else {
        return fail(res, 400, "VALIDATION_ERROR", `Unknown aspect preset "${data.aspect}".`);
      }
    }
    if (data.aspect === undefined && (data.outWidth !== undefined || data.outHeight !== undefined)) {
      aspect = "custom";
      outWidth = data.outWidth ?? outWidth;
      outHeight = data.outHeight ?? outHeight;
    }
    const controls = {
      ...DEFAULT_CONTROLS,
      ...parseJson<Partial<FollowControls>>(configRow.controls_json, {}),
      ...(data.controls ?? {}),
    };
    // paused + manualCrop persist inside controls_json (see
    // configExtras); a manual crop must stay inside the frame.
    const extras = configExtras(configRow);
    const nextPaused = data.paused !== undefined ? data.paused : extras.paused;
    const nextManualCrop = data.manualCrop !== undefined ? data.manualCrop : extras.manualCrop;
    if (
      nextManualCrop &&
      (nextManualCrop.x + nextManualCrop.w > 1.001 || nextManualCrop.y + nextManualCrop.h > 1.001)
    ) {
      return fail(res, 400, "VALIDATION_ERROR", "Manual crop rectangle must stay inside the frame.");
    }
    const storedControls = { ...controls, paused: nextPaused, manualCrop: nextManualCrop };
    db.prepare(
      `UPDATE reframe_configurations SET mode = ?, enabled = ?, aspect = ?, out_width = ?, out_height = ?,
         fit_mode = ?, subject_key = ?, target_pos_x = ?, target_pos_y = ?, controls_json = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      nextMode,
      data.enabled !== undefined ? (data.enabled ? 1 : 0) : configRow.enabled,
      aspect,
      outWidth,
      outHeight,
      data.fitMode ?? configRow.fit_mode,
      data.subjectKey !== undefined ? data.subjectKey : configRow.subject_key,
      data.targetPosX ?? configRow.target_pos_x,
      data.targetPosY ?? configRow.target_pos_y,
      JSON.stringify(storedControls),
      nowIso(),
      configRow.id,
    );
    const fresh = configById(userId, configRow.id)!;
    recomputeConfigPaths(fresh);
    return res.json(reframeState(userId, doc.id));
  });

  // ---- reset tracking (configuration + keyframes back to defaults) ---------

  app.post("/api/editor/:docId/reframe/reset-tracking", requireAuth, (req, res) => {
    const userId = userIdOf(req);
    const doc = docById(userId, String(req.params.docId));
    if (!doc) return fail(res, 404, "NOT_FOUND", "Editor document not found.");
    const db = getDb();
    const configRow = ensureConfig(userId, doc);
    // Mirror ensureConfig's defaults: canvas-derived aspect/dims and
    // the exactly-one-face auto-selection. The tracking JOB and its
    // subjects/frames are analysis data and are kept; only the
    // configuration, its keyframes, overrides and split layout reset.
    let subjectKey: string | null = null;
    if (configRow.job_id) {
      const faces = subjectsOfJob(configRow.job_id).filter((s) => s.kind === "face");
      if (faces.length === 1) subjectKey = faces[0]!.subject_key;
    }
    const state = readState(doc);
    const preset = Object.entries(ASPECT_PRESETS).find(
      ([, dims]) => dims.width === state.canvas.width && dims.height === state.canvas.height,
    );
    transaction(() => {
      db.prepare("DELETE FROM tracking_keyframes WHERE config_id = ?").run(configRow.id);
      db.prepare("DELETE FROM scene_tracking_overrides WHERE config_id = ?").run(configRow.id);
      db.prepare("DELETE FROM split_screen_layouts WHERE config_id = ?").run(configRow.id);
      db.prepare(
        `UPDATE reframe_configurations SET mode = 'smart-auto', enabled = 1, aspect = ?, out_width = ?, out_height = ?,
           fit_mode = 'smart-crop', subject_key = ?, target_pos_x = 'center', target_pos_y = 'middle',
           controls_json = ?, updated_at = ? WHERE id = ?`,
      ).run(
        preset ? preset[0] : "custom",
        state.canvas.width,
        state.canvas.height,
        subjectKey,
        JSON.stringify(DEFAULT_CONTROLS),
        nowIso(),
        configRow.id,
      );
    });
    recomputeConfigPaths(configById(userId, configRow.id)!);
    return res.json(reframeState(userId, doc.id));
  });

  // ---- manual keyframes ------------------------------------------------------

  const keyframeSchema = z
    .object({
      t: z.number().min(0),
      crop: boxSchema.nullable().optional(),
      fit: z.enum(["fill", "fit"]).optional(),
    })
    .strict();

  const validateCrop = (res: Response, crop: NormBox): boolean => {
    if (crop.x + crop.w > 1.001 || crop.y + crop.h > 1.001) {
      fail(res, 400, "VALIDATION_ERROR", "Crop rectangle must stay inside the frame.");
      return false;
    }
    return true;
  };

  app.post("/api/editor/:docId/reframe/keyframes", requireAuth, (req, res) => {
    const userId = userIdOf(req);
    const doc = docById(userId, String(req.params.docId));
    if (!doc) return fail(res, 404, "NOT_FOUND", "Editor document not found.");
    const parsed = keyframeSchema.safeParse(req.body ?? {});
    if (!parsed.success) return fail(res, 400, "VALIDATION_ERROR", "Invalid keyframe.");
    if (parsed.data.crop && !validateCrop(res, parsed.data.crop)) return;
    const configRow = ensureConfig(userId, doc);
    const id = randomUUID();
    getDb()
      .prepare(
        `INSERT INTO tracking_keyframes (id, config_id, job_id, region_subject_key, kind, t_sec, crop_json, fit, subject_key, confidence, lost, created_at)
         VALUES (?, ?, ?, NULL, 'manual', ?, ?, ?, 'manual', NULL, 0, ?)`,
      )
      .run(
        id,
        configRow.id,
        configRow.job_id,
        parsed.data.t,
        parsed.data.crop ? JSON.stringify(parsed.data.crop) : null,
        parsed.data.fit ?? "fill",
        nowIso(),
      );
    recomputeConfigPaths(configById(userId, configRow.id)!);
    return res.status(201).json(reframeState(userId, doc.id));
  });

  app.put("/api/editor/:docId/reframe/keyframes/:keyframeId", requireAuth, (req, res) => {
    const userId = userIdOf(req);
    const doc = docById(userId, String(req.params.docId));
    if (!doc) return fail(res, 404, "NOT_FOUND", "Editor document not found.");
    const parsed = keyframeSchema.safeParse(req.body ?? {});
    if (!parsed.success) return fail(res, 400, "VALIDATION_ERROR", "Invalid keyframe.");
    if (parsed.data.crop && !validateCrop(res, parsed.data.crop)) return;
    const configRow = ensureConfig(userId, doc);
    const db = getDb();
    const row = db
      .prepare("SELECT * FROM tracking_keyframes WHERE id = ? AND config_id = ? AND kind = 'manual'")
      .get(String(req.params.keyframeId), configRow.id) as TrackingKeyframeRow | undefined;
    if (!row) return fail(res, 404, "NOT_FOUND", "Manual keyframe not found.");
    db.prepare("UPDATE tracking_keyframes SET t_sec = ?, crop_json = ?, fit = ? WHERE id = ?").run(
      parsed.data.t,
      parsed.data.crop !== undefined
        ? parsed.data.crop
          ? JSON.stringify(parsed.data.crop)
          : null
        : row.crop_json,
      parsed.data.fit ?? row.fit,
      row.id,
    );
    recomputeConfigPaths(configById(userId, configRow.id)!);
    return res.json(reframeState(userId, doc.id));
  });

  app.delete("/api/editor/:docId/reframe/keyframes/:keyframeId", requireAuth, (req, res) => {
    const userId = userIdOf(req);
    const doc = docById(userId, String(req.params.docId));
    if (!doc) return fail(res, 404, "NOT_FOUND", "Editor document not found.");
    const configRow = ensureConfig(userId, doc);
    const db = getDb();
    const row = db
      .prepare("SELECT * FROM tracking_keyframes WHERE id = ? AND config_id = ? AND kind = 'manual'")
      .get(String(req.params.keyframeId), configRow.id) as TrackingKeyframeRow | undefined;
    if (!row) return fail(res, 404, "NOT_FOUND", "Manual keyframe not found.");
    db.prepare("DELETE FROM tracking_keyframes WHERE id = ?").run(row.id);
    recomputeConfigPaths(configById(userId, configRow.id)!);
    return res.json(reframeState(userId, doc.id));
  });

  // ---- scene-level overrides (replace-all for the configuration) ------------

  const sceneOverridesSchema = z
    .object({
      overrides: z
        .array(
          z
            .object({
              topicSegmentId: z.string().max(80).nullable().optional(),
              rangeStart: z.number().min(0),
              rangeEnd: z.number().gt(0),
              mode: z.enum(REFRAME_MODES as [ReframeMode, ...ReframeMode[]]).nullable().optional(),
              subjectKey: z.string().max(80).nullable().optional(),
              controls: controlsSchema.optional(),
              fitMode: z.enum(FIT_MODES).nullable().optional(),
            })
            .strict(),
        )
        .max(64),
    })
    .strict();

  app.put("/api/editor/:docId/reframe/scene-overrides", requireAuth, (req, res) => {
    const userId = userIdOf(req);
    const doc = docById(userId, String(req.params.docId));
    if (!doc) return fail(res, 404, "NOT_FOUND", "Editor document not found.");
    const parsed = sceneOverridesSchema.safeParse(req.body ?? {});
    if (!parsed.success) return fail(res, 400, "VALIDATION_ERROR", "Invalid scene overrides.");
    const configRow = ensureConfig(userId, doc);
    const subjects = configRow.job_id ? subjectsOfJob(configRow.job_id) : [];
    for (const override of parsed.data.overrides) {
      if (override.rangeEnd <= override.rangeStart) {
        return fail(res, 400, "VALIDATION_ERROR", "Scene override range is empty.");
      }
      if (override.subjectKey != null && !subjects.some((s) => s.subject_key === override.subjectKey)) {
        return fail(res, 400, "VALIDATION_ERROR", "That subject does not exist in the tracked video.");
      }
    }
    const db = getDb();
    transaction(() => {
      db.prepare("DELETE FROM scene_tracking_overrides WHERE config_id = ?").run(configRow.id);
      for (const override of parsed.data.overrides) {
        db.prepare(
          `INSERT INTO scene_tracking_overrides (id, config_id, topic_segment_id, range_start_sec, range_end_sec, mode, subject_key, settings_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          randomUUID(),
          configRow.id,
          override.topicSegmentId ?? null,
          override.rangeStart,
          override.rangeEnd,
          override.mode ?? null,
          override.subjectKey ?? null,
          JSON.stringify({ controls: override.controls ?? null, fitMode: override.fitMode ?? null }),
          nowIso(),
          nowIso(),
        );
      }
    });
    recomputeConfigPaths(configById(userId, configRow.id)!);
    return res.json(reframeState(userId, doc.id));
  });

  app.delete("/api/editor/:docId/reframe/scene-overrides/:overrideId", requireAuth, (req, res) => {
    const userId = userIdOf(req);
    const doc = docById(userId, String(req.params.docId));
    if (!doc) return fail(res, 404, "NOT_FOUND", "Editor document not found.");
    const configRow = ensureConfig(userId, doc);
    const db = getDb();
    const row = db
      .prepare("SELECT * FROM scene_tracking_overrides WHERE id = ? AND config_id = ?")
      .get(String(req.params.overrideId), configRow.id) as SceneTrackingOverrideRow | undefined;
    if (!row) return fail(res, 404, "NOT_FOUND", "Scene override not found.");
    db.prepare("DELETE FROM scene_tracking_overrides WHERE id = ?").run(row.id);
    recomputeConfigPaths(configById(userId, configRow.id)!);
    return res.json(reframeState(userId, doc.id));
  });

  // ---- split screen layout -----------------------------------------------------

  const splitSchema = z
    .object({
      layout: z.enum(["side-by-side", "speaker-focused", "equal-split", "main-secondary", "custom"]),
      regions: z
        .array(
          z
            .object({
              subjectKey: z.string().max(80),
              rect: boxSchema,
              crop: z
                .object({
                  zoom: z.number().min(0).max(1).optional(),
                  offsetX: z.number().min(-0.5).max(0.5).optional(),
                  offsetY: z.number().min(-0.5).max(0.5).optional(),
                })
                .strict()
                .optional(),
            })
            .strict(),
        )
        .max(4)
        .optional(),
    })
    .strict();

  app.put("/api/editor/:docId/reframe/split", requireAuth, (req, res) => {
    const userId = userIdOf(req);
    const doc = docById(userId, String(req.params.docId));
    if (!doc) return fail(res, 404, "NOT_FOUND", "Editor document not found.");
    const parsed = splitSchema.safeParse(req.body ?? {});
    if (!parsed.success) return fail(res, 400, "VALIDATION_ERROR", "Invalid split layout.");
    const configRow = ensureConfig(userId, doc);
    const eligibleKeys = configRow.job_id ? splitSubjectKeys(configRow.job_id) : [];
    if (eligibleKeys.length < 2) {
      return fail(
        res,
        422,
        "SPLIT_NEEDS_SUBJECTS",
        "Split Screen needs at least two distinct tracked people in this video, so it is not offered here.",
      );
    }
    const regions =
      parsed.data.regions ?? splitDefaultRegions(parsed.data.layout, eligibleKeys);
    if (regions.length < 2) {
      return fail(res, 422, "SPLIT_NEEDS_SUBJECTS", "A split layout needs at least two regions.");
    }
    const seenSubjects = new Set<string>();
    for (const region of regions) {
      if (!eligibleKeys.includes(region.subjectKey) || seenSubjects.has(region.subjectKey)) {
        return fail(res, 400, "VALIDATION_ERROR", "A split region references an unknown or duplicate subject.");
      }
      seenSubjects.add(region.subjectKey);
      if (!validateCrop(res, region.rect)) return;
    }
    const db = getDb();
    const existing = db
      .prepare("SELECT * FROM split_screen_layouts WHERE config_id = ?")
      .get(configRow.id) as SplitScreenLayoutRow | undefined;
    if (existing) {
      db.prepare("UPDATE split_screen_layouts SET layout = ?, regions_json = ?, updated_at = ? WHERE id = ?")
        .run(parsed.data.layout, JSON.stringify(regions), nowIso(), existing.id);
    } else {
      db.prepare(
        "INSERT INTO split_screen_layouts (id, config_id, layout, regions_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(randomUUID(), configRow.id, parsed.data.layout, JSON.stringify(regions), nowIso(), nowIso());
    }
    db.prepare("UPDATE reframe_configurations SET mode = 'split-screen', updated_at = ? WHERE id = ?")
      .run(nowIso(), configRow.id);
    recomputeConfigPaths(configById(userId, configRow.id)!);
    return res.json(reframeState(userId, doc.id));
  });

  // ---- reframe render (Phase 5/6 pipeline with tracking crops) -----------------

  app.post("/api/editor/:docId/reframe-render", requireAuth, async (req, res) => {
    const userId = userIdOf(req);
    const doc = docById(userId, String(req.params.docId));
    if (!doc) return fail(res, 404, "NOT_FOUND", "Editor document not found.");
    const configRow = ensureConfig(userId, doc);
    if (configRow.mode === "face-lock" && configRow.enabled !== 1) {
      return fail(res, 400, "FACE_LOCK_OFF", "Face Lock is switched off for this configuration.");
    }
    const built = buildReframePayload(configRow);
    if ("error" in built) return fail(res, 422, built.code, built.error);
    const project = ownedProject(userId, doc.project_id);
    if (!project) return fail(res, 404, "NOT_FOUND", "Project not found.");
    const state = readState(doc) as EditorState;
    const cloned: EditorState = {
      ...state,
      canvas: {
        aspect: configRow.aspect,
        width: configRow.out_width,
        height: configRow.out_height,
        custom: configRow.aspect === "custom",
      },
    };
    const timelineDuration = timelineDurationOf(cloned);
    const settings = {
      state: cloned,
      timelineDuration,
      stateHash: "",
      reframe: built.payload,
    };
    const { createHash } = await import("node:crypto");
    settings.stateHash = createHash("sha256")
      .update(JSON.stringify({ state: cloned, reframe: built.payload }))
      .digest("hex");
    const db = getDb();
    const existing = db
      .prepare(
        "SELECT * FROM render_jobs WHERE user_id = ? AND version_id = ? AND status IN ('QUEUED','RUNNING') ORDER BY created_at DESC",
      )
      .all(userId, doc.id) as unknown as RenderJobRow[];
    const duplicate = existing.find((row) => {
      try {
        return (JSON.parse(row.settings_json) as { stateHash?: string }).stateHash === settings.stateHash;
      } catch {
        return false;
      }
    });
    if (duplicate) {
      return res.status(200).json({ job: publicRenderJob(duplicate), deduplicated: true });
    }
    const id = randomUUID();
    db.prepare(
      `INSERT INTO render_jobs (id, user_id, project_id, version_id, status, stage, settings_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'QUEUED', 'QUEUED', ?, ?, ?)`,
    ).run(id, userId, doc.project_id, doc.id, JSON.stringify(settings), nowIso(), nowIso());
    const row = db.prepare("SELECT * FROM render_jobs WHERE id = ?").get(id) as unknown as RenderJobRow;
    return res.status(201).json({ job: publicRenderJob(row), deduplicated: false });
  });
}
