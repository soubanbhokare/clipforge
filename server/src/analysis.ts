// CLIPFORGE API — Phase 4: AI clip detection & smart clip generation.
//
// Pipeline (real work, no simulated results):
//   QUEUED → VALIDATING → EXTRACTING_AUDIO → TRANSCRIBING → ANALYZING
//   → DETECTING_CLIPS → RANKING → GENERATING_PREVIEWS → COMPLETED
//   (FAILED / CANCELLED can be reached from any stage.)
//
// - Transcription goes through the provider adapter in src/stt.ts
//   (local faster-whisper by default). If the selected provider is not
//   configured the job fails with a CONFIGURATION error — transcript
//   text, timestamps and speakers are never invented. faster-whisper
//   has no diarization, so speaker is stored NULL everywhere.
// - Clip windows are built from real transcript sentence boundaries.
//   Boundary scoring prefers pauses measured directly in the audio
//   (ffmpeg silencedetect): a boundary covered by a detected silence
//   earns full pause credit, and transcript sentence gaps are the
//   fallback when no silence evidence exists for that boundary.
//   Scene changes come from ffmpeg select/showinfo. Scores come only
//   from measurable signals, and every candidate stores the
//   human-readable reasons derived from those measurements.
// - The user's optional instruction genuinely changes ranking: content
//   keywords and known intent patterns (questions & answers,
//   educational markers, motivational language, …) are matched against
//   the actual transcript and matching windows get a bounded boost
//   plus a reason citing the matched passage.
// - Previews are genuine FFmpeg cuts (re-encoded H.264 + AAC, source
//   audio preserved) and are only marked READY after FFprobe verifies
//   video/audio streams and duration. The original file is never
//   modified — previews are new files under media/<userId>/clips/.
//
// Jobs live in SQLite (processing_tasks) and are executed by an
// in-process worker loop started in src/index.ts. Production path: the
// same rows map to PostgreSQL jobs drained by BullMQ/Redis workers —
// Redis/BullMQ do NOT run in this environment and are not claimed to.

import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { config } from "./config.js";
import {
  getDb,
  type CandidateClipRow,
  type ProcessingTaskRow,
  type ProjectRow,
  type SourceAssetRow,
  type TopicSegmentRow,
  type TranscriptRow,
  type TranscriptSegmentRow,
  type UserRow,
} from "./db.js";
import { mediaPath, probeFile } from "./media.js";
import { currentWorkspaceId, notify, recordUsage } from "./accountCore.js";
import { getSttConfig, transcribeAudio, SttConfigurationError, type SttResult } from "./stt.js";

// ---- constants -------------------------------------------------------------

export const TASK_ACTIVE_STATUSES = [
  "QUEUED",
  "VALIDATING",
  "EXTRACTING_AUDIO",
  "TRANSCRIBING",
  "ANALYZING",
  "DETECTING_CLIPS",
  "RANKING",
  "GENERATING_PREVIEWS",
] as const;

const nowIso = (): string => new Date().toISOString();
const newId = (): string => crypto.randomUUID();
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

class CancelledError extends Error {
  constructor() {
    super("Job cancelled.");
    this.name = "CancelledError";
  }
}

class StageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StageError";
  }
}

// ---- row helpers -------------------------------------------------------------

interface AuthedRequest extends Request {
  user?: UserRow;
}
type RequireAuth = (req: AuthedRequest, res: Response, next: NextFunction) => void;

function taskById(id: string): ProcessingTaskRow | undefined {
  return getDb().prepare("SELECT * FROM processing_tasks WHERE id = ?").get(id) as
    | ProcessingTaskRow
    | undefined;
}

function ownedTask(userId: string, id: string): ProcessingTaskRow | undefined {
  return getDb()
    .prepare("SELECT * FROM processing_tasks WHERE id = ? AND user_id = ?")
    .get(id, userId) as ProcessingTaskRow | undefined;
}

function ownedProject(userId: string, id: string): ProjectRow | undefined {
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

function candidateCount(taskId: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM candidate_clips WHERE task_id = ?")
    .get(taskId) as { n: number };
  return row.n;
}

function latestTranscriptId(taskId: string): string | null {
  const row = getDb()
    .prepare("SELECT id FROM transcripts WHERE task_id = ? ORDER BY rowid DESC LIMIT 1")
    .get(taskId) as { id: string } | undefined;
  return row?.id ?? null;
}

function publicTask(t: ProcessingTaskRow) {
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(t.settings_json) as Record<string, unknown>;
  } catch {
    settings = {};
  }
  return {
    id: t.id,
    projectId: t.project_id,
    sourceAssetId: t.source_asset_id,
    prompt: t.prompt,
    settings,
    status: t.status,
    stage: t.stage,
    error: t.error,
    errorCode: t.error_code,
    outcome: t.outcome,
    candidateCount: candidateCount(t.id),
    transcriptId: latestTranscriptId(t.id),
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    startedAt: t.started_at,
    finishedAt: t.finished_at,
  };
}

interface PublicCandidate {
  id: string;
  taskId: string;
  projectId: string;
  sourceAssetId: string;
  startSec: number;
  endSec: number;
  duration: number;
  score: number;
  reasons: string[];
  suggestedTitle: string;
  title: string;
  transcriptExcerpt: string;
  status: string;
  previewStatus: string;
  previewError: string | null;
  previewUrl: string | null;
  createdAt: string;
}

function publicCandidate(c: CandidateClipRow): PublicCandidate {
  let reasons: string[] = [];
  try {
    const parsed = JSON.parse(c.reasons_json) as unknown;
    if (Array.isArray(parsed)) reasons = parsed.filter((r): r is string => typeof r === "string");
  } catch {
    reasons = [];
  }
  return {
    id: c.id,
    taskId: c.task_id,
    projectId: c.project_id,
    sourceAssetId: c.source_asset_id,
    startSec: c.start_sec,
    endSec: c.end_sec,
    duration: c.duration,
    score: c.score,
    reasons,
    suggestedTitle: c.suggested_title,
    title: c.title,
    transcriptExcerpt: c.transcript_excerpt,
    status: c.status,
    previewStatus: c.preview_status,
    previewError: c.preview_error,
    previewUrl: c.preview_status === "READY" ? `/api/candidates/${c.id}/preview` : null,
    createdAt: c.created_at,
  };
}

// ---- child-process management (for cancellation) ----------------------------

const runningChildren = new Map<string, Set<ChildProcess>>();

function registerChild(jobId: string, child: ChildProcess): () => void {
  let set = runningChildren.get(jobId);
  if (!set) {
    set = new Set();
    runningChildren.set(jobId, set);
  }
  set.add(child);
  return () => {
    set.delete(child);
    if (set.size === 0) runningChildren.delete(jobId);
  };
}

function killChildren(jobId: string): void {
  const set = runningChildren.get(jobId);
  if (!set) return;
  for (const child of set) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

function runCommand(
  jobId: string,
  command: string,
  args: string[],
  timeoutMs = 15 * 60_000,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const unregister = registerChild(jobId, child);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      stdout = (stdout + d.toString("utf8")).slice(-4_000_000);
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString("utf8")).slice(-4_000_000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      unregister();
      reject(new StageError(`Could not run ${command}: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      unregister();
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const tail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400);
        reject(new StageError(`${command} failed (exit ${code})${tail ? `: ${tail}` : ""}`));
      }
    });
  });
}

// ---- task state transitions ---------------------------------------------------

function isCancelRequested(jobId: string): boolean {
  const row = getDb()
    .prepare("SELECT cancel_requested, status FROM processing_tasks WHERE id = ?")
    .get(jobId) as { cancel_requested: number; status: string } | undefined;
  return !row || row.cancel_requested === 1 || row.status === "CANCELLED";
}

function throwIfCancelled(jobId: string): void {
  if (isCancelRequested(jobId)) throw new CancelledError();
}

function setStage(jobId: string, stage: string): void {
  throwIfCancelled(jobId);
  getDb()
    .prepare("UPDATE processing_tasks SET status = ?, stage = ?, updated_at = ? WHERE id = ?")
    .run(stage, stage, nowIso(), jobId);
}

function markCancelled(jobId: string): void {
  getDb()
    .prepare(
      "UPDATE processing_tasks SET status = 'CANCELLED', stage = 'CANCELLED', finished_at = ?, updated_at = ? WHERE id = ?",
    )
    .run(nowIso(), nowIso(), jobId);
}

function markFailed(jobId: string, err: Error): void {
  const task = taskById(jobId);
  const isConfig = err instanceof SttConfigurationError;
  getDb()
    .prepare(
      "UPDATE processing_tasks SET status = 'FAILED', stage = ?, error = ?, error_code = ?, finished_at = ?, updated_at = ? WHERE id = ?",
    )
    .run(
      // The stage field always names the stage the job actually
      // failed in — including configuration errors, which are told
      // apart by error_code instead of an off-spec stage value.
      task?.stage ?? "FAILED",
      err.message.slice(0, 1000),
      isConfig ? "CONFIGURATION_ERROR" : "PROCESSING_ERROR",
      nowIso(),
      nowIso(),
      jobId,
    );
  // Phase 12 (§9): failed analysis is recorded with FAILED status and
  // quantity 0 — visible in usage, never billed as success.
  if (task) {
    const db = getDb();
    const wsRow = db.prepare("SELECT workspace_id FROM projects WHERE id = ?").get(task.project_id) as { workspace_id: string | null } | undefined;
    recordUsage(db, {
      userId: task.user_id,
      workspaceId: wsRow?.workspace_id ?? undefined,
      operation: "analysis",
      resource: "analysis_job",
      quantity: 0,
      unit: "jobs",
      idempotencyKey: `analysis:${jobId}:failed`,
      jobId,
      projectId: task.project_id,
      status: "FAILED",
    });
    notify(db, {
      userId: task.user_id,
      category: "ai_processing",
      type: "analysis.failed",
      title: "Analysis failed",
      body: err.message.slice(0, 200),
    });
  }
}

function markCompleted(jobId: string, outcome: string): void {
  getDb()
    .prepare(
      "UPDATE processing_tasks SET status = 'COMPLETED', stage = 'COMPLETED', outcome = ?, error = NULL, error_code = NULL, finished_at = ?, updated_at = ? WHERE id = ?",
    )
    .run(outcome, nowIso(), nowIso(), jobId);
  // Phase 12: usage ledger (analysis job, transcription minutes from
  // the real source duration, clips actually generated) + notification.
  const task = taskById(jobId);
  if (task) {
    const db = getDb();
    const wsRow = db.prepare("SELECT workspace_id FROM projects WHERE id = ?").get(task.project_id) as { workspace_id: string | null } | undefined;
    const wsId = wsRow?.workspace_id ?? undefined;
    recordUsage(db, {
      userId: task.user_id,
      workspaceId: wsId,
      operation: "analysis",
      resource: "analysis_job",
      quantity: 1,
      unit: "jobs",
      idempotencyKey: `analysis:${jobId}:completed`,
      jobId,
      projectId: task.project_id,
      status: "COMPLETED",
    });
    const asset = db
      .prepare("SELECT duration FROM source_assets WHERE id = ?")
      .get(task.source_asset_id) as { duration: number | null } | undefined;
    if (asset?.duration) {
      recordUsage(db, {
        userId: task.user_id,
        workspaceId: wsId,
        operation: "transcription",
        resource: "source_asset",
        quantity: Math.round((asset.duration / 60) * 1000) / 1000,
        unit: "minutes",
        idempotencyKey: `transcription:${jobId}:minutes`,
        jobId,
        projectId: task.project_id,
        status: "COMPLETED",
      });
    }
    const clips = db
      .prepare("SELECT COUNT(*) AS n FROM candidate_clips WHERE project_id = ?")
      .get(task.project_id) as { n: number };
    if (clips.n > 0) {
      recordUsage(db, {
        userId: task.user_id,
        workspaceId: wsId,
        operation: "clips",
        resource: "candidate_clip",
        quantity: clips.n,
        unit: "clips",
        idempotencyKey: `clips:${jobId}:generated`,
        jobId,
        projectId: task.project_id,
        status: "COMPLETED",
      });
    }
    notify(db, {
      userId: task.user_id,
      category: "ai_processing",
      type: "analysis.completed",
      title: "Analysis completed",
      body: clips.n > 0 ? `${clips.n} candidate clip(s) are ready.` : undefined,
    });
  }
}

// ---- transcript → sentence units ------------------------------------------------

interface SentenceUnit {
  start: number;
  end: number;
  text: string;
  avgConfidence: number | null;
  wordCount: number;
}

const SENTENCE_END = /[.!?…।॥]["'”’)\]]?$/;

function buildSentences(stt: SttResult): SentenceUnit[] {
  const sentences: SentenceUnit[] = [];
  for (const segment of stt.segments) {
    const words = segment.words.filter((w) => w.word.trim().length > 0);
    if (words.length > 0) {
      let current: typeof words = [];
      const flush = () => {
        if (current.length === 0) return;
        const text = current.map((w) => w.word).join("").replace(/\s+/g, " ").trim();
        if (text) {
          const probs = current
            .map((w) => w.probability)
            .filter((p): p is number => typeof p === "number");
          sentences.push({
            start: round3(current[0].start),
            end: round3(current[current.length - 1].end),
            text,
            avgConfidence: probs.length ? probs.reduce((a, b) => a + b, 0) / probs.length : null,
            wordCount: current.length,
          });
        }
        current = [];
      };
      for (const word of words) {
        current.push(word);
        if (SENTENCE_END.test(word.word.trim())) flush();
      }
      flush(); // a provider segment boundary also ends a sentence unit
    } else if (segment.text.trim()) {
      // No word timestamps from this provider: split the real segment
      // text into sentences and interpolate times by character share.
      const parts = segment.text.match(/[^.!?…।॥]+[.!?…।॥]*/g) ?? [segment.text];
      const totalChars = parts.reduce((n, p) => n + p.length, 0) || 1;
      const span = Math.max(0, segment.end - segment.start);
      let cursor = segment.start;
      for (const part of parts) {
        const text = part.replace(/\s+/g, " ").trim();
        if (!text) continue;
        const dur = span * (part.length / totalChars);
        sentences.push({
          start: round3(cursor),
          end: round3(cursor + dur),
          text,
          avgConfidence: null,
          wordCount: text.split(/\s+/).length,
        });
        cursor += dur;
      }
    }
  }
  return sentences.filter((s) => s.end > s.start || s.text.length > 0);
}

// ---- signal extraction (silence + scene changes) --------------------------------

interface MediaSignals {
  silences: { start: number; end: number }[];
  sceneChanges: number[];
}

async function extractSignals(jobId: string, sourcePath: string, wavPath: string | null): Promise<MediaSignals> {
  const signals: MediaSignals = { silences: [], sceneChanges: [] };
  if (wavPath) {
    try {
      const { stderr } = await runCommand(jobId, "ffmpeg", [
        "-v", "info", "-i", wavPath,
        "-af", "silencedetect=noise=-45dB:d=0.35",
        "-f", "null", "-",
      ]);
      let openStart: number | null = null;
      for (const line of stderr.split("\n")) {
        const startMatch = /silence_start:\s*([0-9.]+)/.exec(line);
        const endMatch = /silence_end:\s*([0-9.]+)/.exec(line);
        if (startMatch) openStart = Number(startMatch[1]);
        if (endMatch && openStart !== null) {
          signals.silences.push({ start: round3(openStart), end: round3(Number(endMatch[1])) });
          openStart = null;
        }
      }
    } catch {
      // Silence detection is a scoring signal; its failure must not
      // kill an otherwise valid analysis. Boundaries then fall back to
      // sentence timing alone, which the reasons text reflects.
      signals.silences = [];
    }
  }
  throwIfCancelled(jobId);
  try {
    const { stderr } = await runCommand(jobId, "ffmpeg", [
      "-v", "info", "-i", sourcePath,
      "-vf", "select='gt(scene,0.4)',showinfo",
      "-an", "-f", "null", "-",
    ]);
    for (const line of stderr.split("\n")) {
      const match = /pts_time:\s*([0-9.]+)/.exec(line);
      if (match) signals.sceneChanges.push(round3(Number(match[1])));
    }
  } catch {
    signals.sceneChanges = [];
  }
  return signals;
}

// ---- instruction (prompt) matching ------------------------------------------------

const STOPWORDS = new Set([
  "find", "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with",
  "most", "moments", "moment", "clips", "clip", "video", "videos", "please",
  "that", "this", "from", "where", "when", "what", "should", "ai", "me", "my",
  "important", "best", "good", "great", "interesting", "strong", "useful",
]);

interface IntentPattern {
  name: string;
  promptWords: string[];
  test: (text: string) => boolean;
  reason: (excerpt: string) => string;
}

const INTENT_PATTERNS: IntentPattern[] = [
  {
    name: "questions-and-answers",
    promptWords: ["question", "questions", "answer", "answers", "qa", "q&a"],
    test: (t) => /\?/.test(t),
    reason: () => "Matches your instruction: this window contains a question and the sentences that follow it.",
  },
  {
    name: "educational",
    promptWords: ["educational", "tips", "tip", "learn", "teaching", "explain", "explains", "tutorial", "guide"],
    test: (t) => /\b(because|means|called|works by|step|first|second|for example|in other words|reason is)\b/i.test(t) || /[0-9]/.test(t),
    reason: () => "Matches your instruction: this passage explains something (explanation markers or concrete numbers in the transcript).",
  },
  {
    name: "motivational",
    promptWords: ["motivational", "motivation", "inspiring", "inspiration"],
    test: (t) => /\b(you can|never give up|believe|dream|goal|success|succeed|keep going|hard work|discipline|focus|achieve)\b/i.test(t),
    reason: () => "Matches your instruction: motivational language appears in this passage.",
  },
  {
    name: "funny",
    promptWords: ["funny", "funniest", "humour", "humor", "comedy", "hilarious"],
    test: (t) => /!/.test(t) || /\b(haha|funny|joke|laugh|hilarious|crazy)\b/i.test(t),
    reason: () => "Matches your instruction: this passage has the exclamatory / humour markers your prompt asked for.",
  },
  {
    name: "powerful statements",
    promptWords: ["powerful", "statements", "statement", "podcast"],
    test: (t) => /\b(always|never|truth|fact is|everyone|nobody|remember|important|must)\b/i.test(t),
    reason: () => "Matches your instruction: this passage makes a strong declarative statement.",
  },
  {
    name: "technical",
    promptWords: ["technical", "technology", "software", "code", "data"],
    test: (t) => /\b(api|server|database|code|software|algorithm|system|model|data|function|error)\b/i.test(t),
    reason: () => "Matches your instruction: technical terms from the transcript appear in this passage.",
  },
];

interface PromptMatch {
  boost: number;
  reasons: string[];
}

function promptKeywords(prompt: string): string[] {
  return [...new Set(
    prompt
      .toLowerCase()
      .replace(/[^a-z0-9\u0900-\u097F\s-]/gi, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !STOPWORDS.has(w)),
  )].slice(0, 12);
}

function matchPrompt(prompt: string, windowText: string): PromptMatch {
  if (!prompt.trim()) return { boost: 0, reasons: [] };
  const lower = windowText.toLowerCase();
  const reasons: string[] = [];
  let boost = 0;
  const keywords = promptKeywords(prompt);
  const hitKeywords = keywords.filter((k) => lower.includes(k));
  if (hitKeywords.length > 0) {
    boost += Math.min(8, hitKeywords.length * 3);
    reasons.push(
      `Matches your instruction: the words "${hitKeywords.slice(0, 3).join('", "')}" from your prompt appear in this passage.`,
    );
  }
  const promptLower = prompt.toLowerCase();
  for (const intent of INTENT_PATTERNS) {
    if (intent.promptWords.some((w) => promptLower.includes(w)) && intent.test(windowText)) {
      boost += 6;
      reasons.push(intent.reason(windowText));
      break;
    }
  }
  return { boost: Math.min(12, boost), reasons };
}

// ---- candidate windows + ranking ----------------------------------------------------

interface TargetSettings {
  minDuration: number;
  maxDuration: number;
  targetDuration: number;
  desiredCount: number;
}

interface ScoredWindow {
  start: number;
  end: number;
  duration: number;
  score: number;
  reasons: string[];
  text: string;
  firstSentence: string;
}

function scoreWindow(
  sentences: SentenceUnit[],
  from: number,
  to: number,
  signals: MediaSignals,
  target: TargetSettings,
  prompt: string,
): ScoredWindow {
  const slice = sentences.slice(from, to + 1);
  const start = slice[0].start;
  const end = slice[slice.length - 1].end;
  const duration = Math.max(0.1, end - start);
  const text = slice.map((s) => s.text).join(" ");

  const speechSeconds = slice.reduce((n, s) => n + Math.max(0, s.end - s.start), 0);
  const density = Math.min(1, speechSeconds / duration);

  const completeCount = slice.filter((s) => SENTENCE_END.test(s.text.trim())).length;
  const completeness = slice.length ? completeCount / slice.length : 0;

  const gapBefore = from > 0 ? start - sentences[from - 1].end : 1;
  const gapAfter = to < sentences.length - 1 ? sentences[to + 1].start - end : 1;
  // Boundary credit per side, 0..1. Pauses measured directly in the
  // audio (ffmpeg silencedetect, see extractSignals) are the preferred
  // evidence: a detected silence that covers the boundary point — or
  // begins within 0.35s before it and runs up to it — earns full
  // credit for that boundary. With no silence evidence for a boundary
  // (including when silence extraction failed entirely and the list is
  // empty), fall back to the transcript sentence gap capped at 2s,
  // exactly as before. The component's total weight is unchanged.
  const SILENCE_TOLERANCE_SEC = 0.35;
  const silenceCoversBoundary = (t: number): boolean =>
    signals.silences.some(
      (s) =>
        (s.start <= t && t <= s.end) ||
        (s.start <= t && t - s.start <= SILENCE_TOLERANCE_SEC && s.end >= t - SILENCE_TOLERANCE_SEC),
    );
  const startSilenceCredit = silenceCoversBoundary(start);
  const endSilenceCredit = silenceCoversBoundary(end);
  const gapCredit = (gap: number): number => Math.min(Math.max(gap, 0), 2) / 2;
  const boundaryScore =
    ((startSilenceCredit ? 1 : gapCredit(gapBefore)) +
      (endSilenceCredit ? 1 : gapCredit(gapAfter))) /
    2;

  const durationFit = Math.max(0, 1 - Math.abs(duration - target.targetDuration) / target.targetDuration);

  const confidences = slice.map((s) => s.avgConfidence).filter((c): c is number => c !== null);
  const avgConfidence = confidences.length
    ? confidences.reduce((a, b) => a + b, 0) / confidences.length
    : null;

  const first = slice[0].text;
  let hookScore = 0.35;
  let hookReason: string | null = null;
  if (/\?/.test(first)) {
    hookScore = 1;
    hookReason = "Opens with a question, which tends to hold attention.";
  } else if (/[0-9]/.test(first)) {
    hookScore = 0.85;
    hookReason = "Opens with a concrete number or fact.";
  } else if (/!/.test(first)) {
    hookScore = 0.9;
    hookReason = "Opens with an emphatic statement.";
  } else if (/\b(important|must|never|always|secret|mistake|remember|listen|imagine|stop|why|how)\b/i.test(first)) {
    hookScore = 0.8;
    hookReason = "Opens with a strong statement.";
  }

  // Weighted, explainable score. When the provider gives no word
  // confidence, that component is excluded and the rest renormalised —
  // a confidence number is never invented.
  const parts: { weight: number; value: number }[] = [
    { weight: 25, value: density },
    { weight: 15, value: completeness },
    { weight: 15, value: boundaryScore },
    { weight: 20, value: durationFit },
    { weight: 15, value: hookScore },
  ];
  if (avgConfidence !== null) parts.push({ weight: 10, value: avgConfidence });
  const totalWeight = parts.reduce((n, p) => n + p.weight, 0);
  let score = parts.reduce((n, p) => n + p.weight * p.value, 0) / totalWeight * 100;

  const reasons: string[] = [
    `Speech fills ${Math.round(density * 100)}% of this ${duration.toFixed(1)}s window.`,
    slice.length === completeCount
      ? `Contains ${slice.length} complete sentence${slice.length === 1 ? "" : "s"} — no mid-sentence cuts.`
      : `Contains ${slice.length} sentences (${completeCount} end with closing punctuation).`,
    startSilenceCredit && endSilenceCredit
      ? "Boundaries sit at pauses measured in the audio by silence detection."
      : startSilenceCredit || endSilenceCredit
        ? "One boundary sits at a pause measured in the audio by silence detection; the other follows sentence timing."
        : gapBefore >= 0.05 || gapAfter >= 0.05
          ? `Boundaries sit at natural pauses (${Math.max(0, gapBefore).toFixed(1)}s before, ${Math.max(0, gapAfter).toFixed(1)}s after).`
          : "Boundaries align with sentence starts and ends.",
    `Duration ${duration.toFixed(1)}s against a ${target.targetDuration}s target.`,
  ];
  if (avgConfidence !== null) {
    reasons.push(`Average word confidence from the transcription model is ${Math.round(avgConfidence * 100)}%.`);
  }
  if (hookReason) reasons.push(hookReason);
  const sceneInside = signals.sceneChanges.some((t) => t > start + 0.25 && t < end - 0.25);
  if (sceneInside) reasons.push("Contains a scene change detected by FFmpeg inside the window.");

  const promptMatch = matchPrompt(prompt, text);
  if (promptMatch.boost > 0) {
    score = Math.min(100, score + promptMatch.boost);
    reasons.push(...promptMatch.reasons);
  }

  return {
    start: round3(start),
    end: round3(end),
    duration: round3(duration),
    score: Math.round(Math.max(0, Math.min(100, score))),
    reasons,
    text,
    firstSentence: first,
  };
}

function buildWindows(
  sentences: SentenceUnit[],
  signals: MediaSignals,
  target: TargetSettings,
  prompt: string,
): ScoredWindow[] {
  const windows: ScoredWindow[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < sentences.length; i += 1) {
    let endIdx = -1;
    for (let j = i; j < sentences.length; j += 1) {
      const dur = sentences[j].end - sentences[i].start;
      if (dur >= target.minDuration) {
        endIdx = j;
        break;
      }
      if (dur > target.maxDuration && j > i) break;
    }
    if (endIdx === -1) {
      // Remaining speech from i is shorter than the minimum: only the
      // whole remainder can still qualify, and only if it is close.
      const totalRemaining = sentences[sentences.length - 1].end - sentences[i].start;
      if (i === 0 && totalRemaining >= Math.max(8, target.minDuration * 0.6)) {
        endIdx = sentences.length - 1;
      } else {
        continue;
      }
    }
    for (let extra = 0; extra <= 2; extra += 1) {
      const j = endIdx + extra;
      if (j >= sentences.length) break;
      const dur = sentences[j].end - sentences[i].start;
      if (dur > target.maxDuration * 1.15 && j > endIdx) break;
      const key = `${i}:${j}`;
      if (seen.has(key)) continue;
      seen.add(key);
      windows.push(scoreWindow(sentences, i, j, signals, target, prompt));
    }
  }
  return windows;
}

function pickTopWindows(windows: ScoredWindow[], desiredCount: number): ScoredWindow[] {
  const sorted = [...windows].sort((a, b) => b.score - a.score || a.start - b.start);
  const picked: ScoredWindow[] = [];
  for (const w of sorted) {
    if (picked.length >= desiredCount) break;
    const overlap = picked.some((p) => {
      const shared = Math.min(p.end, w.end) - Math.max(p.start, w.start);
      return shared > 0.25 * Math.min(p.duration, w.duration);
    });
    if (!overlap) picked.push(w);
  }
  if (picked.length < Math.min(desiredCount, sorted.length)) {
    for (const w of sorted) {
      if (picked.length >= desiredCount) break;
      if (!picked.includes(w)) picked.push(w);
    }
  }
  return picked;
}

function suggestedTitle(firstSentence: string): string {
  const cleaned = firstSentence
    .replace(/\s+/g, " ")
    .replace(/^(um+|uh+|so|well|okay|ok)[,.\s]+/i, "")
    .trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  const title = words.slice(0, 7).join(" ").replace(/[.!?…]+$/, "");
  return title.length >= 3 ? title : "Clip moment";
}

// ---- settings snapshot --------------------------------------------------------------

interface JobSettings extends TargetSettings {
  language: string | null;
  transcriptionContext: string | null;
  sourceDuration: number | null;
}

function computeJobSettings(
  project: ProjectRow,
  bodyLanguage: string | undefined,
  prompt: string,
): JobSettings {
  let stored: Record<string, unknown> = {};
  try {
    stored = JSON.parse(project.settings_json) as Record<string, unknown>;
  } catch {
    stored = {};
  }
  let targetDuration = 45;
  let minDuration = 15;
  let maxDuration = 90;
  const clipDuration = typeof stored.clipDuration === "string" ? stored.clipDuration : "auto";
  const custom = typeof stored.customClipDurationSec === "number" ? stored.customClipDurationSec : null;
  if (clipDuration !== "auto") {
    const n = clipDuration === "custom" ? (custom ?? 45) : Number.parseInt(clipDuration, 10);
    if (Number.isFinite(n) && n >= 5) {
      targetDuration = n;
      minDuration = Math.max(5, Math.round(n * 0.6));
      maxDuration = Math.round(n * 1.45);
    }
  }
  let desiredCount = 5;
  const clipCount = typeof stored.clipCount === "string" ? stored.clipCount : "5";
  if (clipCount === "custom" && typeof stored.customClipCount === "number") {
    desiredCount = Math.min(50, Math.max(1, Math.round(stored.customClipCount)));
  } else if (/^[0-9]+$/.test(clipCount)) {
    desiredCount = Number.parseInt(clipCount, 10);
  }
  const rawLanguage = bodyLanguage ?? (typeof stored.language === "string" ? stored.language : "auto");
  const language = rawLanguage && rawLanguage !== "auto" && rawLanguage !== "other" ? rawLanguage : null;
  return {
    minDuration,
    maxDuration,
    targetDuration,
    desiredCount,
    language,
    transcriptionContext:
      typeof stored.transcriptionContext === "string" && stored.transcriptionContext.trim()
        ? stored.transcriptionContext.trim().slice(0, 1000)
        : null,
    sourceDuration: null,
  };
}

// ---- the pipeline ---------------------------------------------------------------------

async function processJob(jobId: string): Promise<void> {
  const db = getDb();
  const task = taskById(jobId);
  if (!task) return;
  const settings = JSON.parse(task.settings_json) as JobSettings;
  const jobDir = path.join(config.processingDir, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  try {
    // VALIDATING ------------------------------------------------------
    setStage(jobId, "VALIDATING");
    const project = db
      .prepare("SELECT * FROM projects WHERE id = ? AND user_id = ?")
      .get(task.project_id, task.user_id) as ProjectRow | undefined;
    const asset = db
      .prepare("SELECT * FROM source_assets WHERE id = ? AND project_id = ? AND user_id = ?")
      .get(task.source_asset_id, task.project_id, task.user_id) as SourceAssetRow | undefined;
    if (!project || !asset) throw new StageError("The project or source video for this job no longer exists.");
    // A processable source is any asset with a real, verified local
    // media file: uploads AND URL imports (yt-dlp) both land one.
    // Link-only sources (a validated YouTube URL with no file) have
    // no storage key and stay honestly rejected here.
    if (!asset.storage_key) {
      throw new StageError(
        "This project does not have a source video file yet. Upload the original video file — or import it from its URL — to run clip detection.",
      );
    }
    const sourcePath = mediaPath(asset.storage_key);
    if (!fs.existsSync(sourcePath)) {
      throw new StageError("The uploaded source file is missing from server storage, so analysis cannot run.");
    }
    const probe = await probeFile(sourcePath).catch(() => {
      throw new StageError("FFprobe could not read the source video. The file appears corrupted or unsupported.");
    });
    throwIfCancelled(jobId);

    // EXTRACTING_AUDIO --------------------------------------------------
    setStage(jobId, "EXTRACTING_AUDIO");
    const wavPath = path.join(jobDir, "audio.wav");
    let hasAudio = probe.hasAudio;
    if (hasAudio) {
      try {
        await runCommand(jobId, "ffmpeg", [
          "-v", "error", "-i", sourcePath,
          "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
          "-y", wavPath,
        ]);
      } catch {
        // A stream FFprobe listed but FFmpeg cannot decode means there
        // is effectively no usable audio.
        hasAudio = false;
      }
    }
    throwIfCancelled(jobId);

    if (!hasAudio || !fs.existsSync(wavPath)) {
      markCompleted(jobId, "NO_SPEECH");
      return;
    }

    // TRANSCRIBING --------------------------------------------------------
    setStage(jobId, "TRANSCRIBING");
    const sttConfig = await getSttConfig();
    if (!sttConfig.configured) throw new SttConfigurationError(sttConfig.detail);
    const stt = await transcribeAudio(wavPath, {
      language: settings.language,
      initialPrompt: settings.transcriptionContext,
      registerChild: (child) => registerChild(jobId, child),
    });
    throwIfCancelled(jobId);

    const fullText = stt.segments.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim();
    const transcriptId = newId();
    const now = nowIso();
    db.prepare(
      `INSERT INTO transcripts (id, task_id, project_id, source_asset_id, language, language_probability, duration, full_text, provider, model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      transcriptId,
      jobId,
      task.project_id,
      task.source_asset_id,
      stt.language,
      stt.languageProbability,
      stt.duration ?? probe.duration,
      fullText,
      stt.provider,
      stt.model,
      now,
    );
    const insertSegment = db.prepare(
      "INSERT INTO transcript_segments (id, transcript_id, idx, start_sec, end_sec, text, words_json, speaker) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
    );
    stt.segments.forEach((segment, idx) => {
      insertSegment.run(
        newId(),
        transcriptId,
        idx,
        round3(segment.start),
        round3(segment.end),
        segment.text,
        segment.words.length ? JSON.stringify(segment.words) : null,
      );
    });

    if (!fullText) {
      markCompleted(jobId, "NO_SPEECH");
      return;
    }

    // ANALYZING -------------------------------------------------------------
    setStage(jobId, "ANALYZING");
    const sentences = buildSentences(stt);
    const signals = await extractSignals(jobId, sourcePath, wavPath);
    db.prepare("UPDATE processing_tasks SET signals_json = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify({
        silences: signals.silences,
        sceneChanges: signals.sceneChanges,
        sentenceCount: sentences.length,
      }),
      nowIso(),
      jobId,
    );
    // Topic segments: group consecutive sentences, breaking on long
    // pauses or scene changes. Labels/summaries come from the actual
    // transcript text of the group — nothing is paraphrased by a model.
    const insertTopic = db.prepare(
      "INSERT INTO topic_segments (id, transcript_id, start_sec, end_sec, label, summary_text) VALUES (?, ?, ?, ?, ?, ?)",
    );
    let group: SentenceUnit[] = [];
    const flushGroup = () => {
      if (group.length === 0) return;
      const text = group.map((s) => s.text).join(" ");
      const labelWords = group[0].text.replace(/\s+/g, " ").split(" ").filter(Boolean).slice(0, 6).join(" ");
      insertTopic.run(
        newId(),
        transcriptId,
        round3(group[0].start),
        round3(group[group.length - 1].end),
        labelWords || "Segment",
        text.slice(0, 280),
      );
      group = [];
    };
    for (const sentence of sentences) {
      if (group.length > 0) {
        const gap = sentence.start - group[group.length - 1].end;
        const sceneBreak = signals.sceneChanges.some(
          (t) => t > group[group.length - 1].end - 0.1 && t <= sentence.start + 0.1,
        );
        const groupDuration = sentence.end - group[0].start;
        if (gap > 2.5 || sceneBreak || groupDuration > 60) flushGroup();
      }
      group.push(sentence);
    }
    flushGroup();
    throwIfCancelled(jobId);

    // DETECTING_CLIPS ----------------------------------------------------------
    setStage(jobId, "DETECTING_CLIPS");
    const target: TargetSettings = settings;
    const windows = buildWindows(sentences, signals, target, task.prompt ?? "");

    // RANKING --------------------------------------------------------------------
    setStage(jobId, "RANKING");
    const picked = pickTopWindows(windows, target.desiredCount);
    const insertCandidate = db.prepare(
      `INSERT INTO candidate_clips (id, task_id, project_id, source_asset_id, user_id, start_sec, end_sec, duration, score, reasons_json, suggested_title, title, transcript_excerpt, status, preview_path, preview_status, preview_error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SELECTED', NULL, 'PENDING', NULL, ?)`,
    );
    const created: { id: string; window: ScoredWindow }[] = [];
    for (const w of picked) {
      const id = newId();
      const title = suggestedTitle(w.firstSentence);
      insertCandidate.run(
        id,
        jobId,
        task.project_id,
        task.source_asset_id,
        task.user_id,
        w.start,
        w.end,
        w.duration,
        w.score,
        JSON.stringify(w.reasons),
        title,
        title,
        w.text.slice(0, 400),
        nowIso(),
      );
      created.push({ id, window: w });
    }
    throwIfCancelled(jobId);

    // GENERATING_PREVIEWS ------------------------------------------------------------
    setStage(jobId, "GENERATING_PREVIEWS");
    for (const { id, window: w } of created) {
      throwIfCancelled(jobId);
      const relativePath = `${task.user_id}/clips/${id}.mp4`;
      const outputPath = mediaPath(relativePath);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      db.prepare("UPDATE candidate_clips SET preview_status = 'GENERATING' WHERE id = ?").run(id);
      try {
        await runCommand(jobId, "ffmpeg", [
          "-v", "error",
          "-ss", String(w.start),
          "-i", sourcePath,
          "-t", String(w.duration),
          "-map", "0:v:0",
          "-map", "0:a?",
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
          "-c:a", "aac", "-b:a", "128k",
          "-avoid_negative_ts", "make_zero",
          "-movflags", "+faststart",
          "-y", outputPath,
        ]);
        const meta = await probeFile(outputPath);
        if (!meta.duration || Math.abs(meta.duration - w.duration) > 1) {
          throw new StageError(
            `Preview duration ${meta.duration ?? "unknown"}s does not match the requested ${w.duration}s.`,
          );
        }
        if (probe.hasAudio && !meta.hasAudio) {
          throw new StageError("Preview is missing the source audio stream.");
        }
        db.prepare(
          "UPDATE candidate_clips SET preview_path = ?, preview_status = 'READY', preview_error = NULL WHERE id = ?",
        ).run(relativePath, id);
      } catch (previewErr) {
        if (previewErr instanceof CancelledError || isCancelRequested(jobId)) throw new CancelledError();
        fs.rmSync(outputPath, { force: true });
        db.prepare("UPDATE candidate_clips SET preview_path = NULL, preview_status = 'FAILED', preview_error = ? WHERE id = ?").run(
          previewErr instanceof Error ? previewErr.message.slice(0, 500) : "Preview generation failed.",
          id,
        );
      }
    }

    markCompleted(jobId, picked.length > 0 ? "CLIPS_FOUND" : "NO_CLIPS_FOUND");
  } catch (err) {
    if (err instanceof CancelledError || isCancelRequested(jobId)) {
      killChildren(jobId);
      markCancelled(jobId);
    } else {
      markFailed(jobId, err instanceof Error ? err : new Error("Analysis failed."));
    }
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
}

// ---- worker loop ------------------------------------------------------------------------

let workerTimer: NodeJS.Timeout | null = null;
let workerBusy = false;

async function workerTick(): Promise<void> {
  if (workerBusy) return;
  const next = getDb()
    .prepare("SELECT id FROM processing_tasks WHERE status = 'QUEUED' ORDER BY created_at ASC, rowid ASC LIMIT 1")
    .get() as { id: string } | undefined;
  if (!next) return;
  // Atomic claim (single-process worker; the WHERE keeps it honest).
  const claim = getDb()
    .prepare(
      "UPDATE processing_tasks SET status = 'VALIDATING', stage = 'VALIDATING', started_at = ?, updated_at = ? WHERE id = ? AND status = 'QUEUED'",
    )
    .run(nowIso(), nowIso(), next.id);
  if (claim.changes === 0) return;
  workerBusy = true;
  try {
    await processJob(next.id);
  } finally {
    workerBusy = false;
  }
}

/**
 * Boot-time recovery + worker start (called from src/index.ts).
 * Jobs that were mid-flight when the server stopped are marked FAILED
 * with an explicit interruption message so the user can retry — they
 * are never silently presented as still running.
 */
export function startAnalysisWorker(): void {
  getDb()
    .prepare(
      `UPDATE processing_tasks
       SET status = 'FAILED', error = 'This job was interrupted by a server restart. Use Retry to run it again.', error_code = 'INTERRUPTED', finished_at = ?, updated_at = ?
       WHERE status IN (${TASK_ACTIVE_STATUSES.slice(1).map(() => "?").join(", ")})`,
    )
    .run(nowIso(), nowIso(), ...TASK_ACTIVE_STATUSES.slice(1));
  if (workerTimer) return;
  workerTimer = setInterval(() => {
    void workerTick().catch((err) => console.error("[analysis] worker tick failed:", err));
  }, 500);
  workerTimer.unref();
  void workerTick().catch((err) => console.error("[analysis] worker tick failed:", err));
}

// ---- cleanup helpers -----------------------------------------------------------------------

function deleteTaskArtifacts(task: ProcessingTaskRow): void {
  const db = getDb();
  const candidates = db
    .prepare("SELECT * FROM candidate_clips WHERE task_id = ?")
    .all(task.id) as unknown as CandidateClipRow[];
  for (const c of candidates) {
    if (c.preview_path) fs.rmSync(mediaPath(c.preview_path), { force: true });
  }
  db.prepare("DELETE FROM candidate_clips WHERE task_id = ?").run(task.id);
  db.prepare("DELETE FROM transcripts WHERE task_id = ?").run(task.id); // cascades segments + topics
}

// ---- routes -----------------------------------------------------------------------------------

const createJobSchema = z.object({
  sourceAssetId: z.string().min(1).max(128),
  prompt: z.string().max(500).optional(),
  language: z.enum(["auto", "en", "hi", "mr", "other"]).optional(),
});

const patchCandidateSchema = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    status: z.enum(["SELECTED", "DESELECTED", "REMOVED"]).optional(),
  })
  .refine((d) => d.title !== undefined || d.status !== undefined, {
    message: "Provide a title or a status to update.",
  });

export function registerAnalysisRoutes(app: express.Express, requireAuth: RequireAuth): void {
  const router = express.Router();

  // Provider configuration — honest labelling for the UI.
  router.get("/analysis/config", requireAuth, async (_req, res) => {
    const cfg = await getSttConfig();
    res.json({
      provider: cfg.provider,
      configured: cfg.configured,
      model: cfg.model,
      detail: cfg.detail,
      speakerDiarization: false,
      wordTimestamps: cfg.provider === "local-faster-whisper",
    });
  });

  // Create (or dedupe) an analysis job for a project.
  router.post("/projects/:id/analysis", requireAuth, (req: AuthedRequest, res) => {
    const project = ownedProject(req.user!.id, req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found." });
      return;
    }
    const parsed = createJobSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid analysis request." });
      return;
    }
    const asset = getDb()
      .prepare("SELECT * FROM source_assets WHERE id = ? AND project_id = ? AND user_id = ?")
      .get(parsed.data.sourceAssetId, project.id, req.user!.id) as SourceAssetRow | undefined;
    if (!asset) {
      res.status(404).json({ error: "Source asset not found for this project." });
      return;
    }
    const prompt =
      parsed.data.prompt !== undefined ? parsed.data.prompt.trim() || null : project.ai_instruction;
    const settings = computeJobSettings(project, parsed.data.language, prompt ?? "");
    settings.sourceDuration = asset.duration;
    const settingsJson = JSON.stringify(settings);

    const db = getDb();
    const activePlaceholders = TASK_ACTIVE_STATUSES.map(() => "?").join(", ");
    const existing = db
      .prepare(
        `SELECT * FROM processing_tasks
         WHERE user_id = ? AND project_id = ? AND source_asset_id = ? AND settings_json = ? AND prompt IS ?
           AND status IN (${activePlaceholders})
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(req.user!.id, project.id, asset.id, settingsJson, prompt, ...TASK_ACTIVE_STATUSES) as
      | ProcessingTaskRow
      | undefined;
    if (existing) {
      res.status(200).json({ job: publicTask(existing), deduplicated: true });
      return;
    }

    const now = nowIso();
    const task: ProcessingTaskRow = {
      id: newId(),
      user_id: req.user!.id,
      project_id: project.id,
      source_asset_id: asset.id,
      prompt,
      settings_json: settingsJson,
      status: "QUEUED",
      stage: "QUEUED",
      error: null,
      error_code: null,
      outcome: null,
      signals_json: "{}",
      cancel_requested: 0,
      created_at: now,
      updated_at: now,
      started_at: null,
      finished_at: null,
    };
    db.prepare(
      `INSERT INTO processing_tasks (id, user_id, project_id, source_asset_id, prompt, settings_json, status, stage, error, error_code, outcome, signals_json, cancel_requested, created_at, updated_at, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, 'QUEUED', 'QUEUED', NULL, NULL, NULL, '{}', 0, ?, ?, NULL, NULL)`,
    ).run(task.id, task.user_id, task.project_id, task.source_asset_id, task.prompt, task.settings_json, now, now);
    res.status(201).json({ job: publicTask(task), deduplicated: false });
  });

  // List a project's jobs (newest first).
  router.get("/projects/:id/analysis", requireAuth, (req: AuthedRequest, res) => {
    const project = ownedProject(req.user!.id, req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found." });
      return;
    }
    const rows = getDb()
      .prepare("SELECT * FROM processing_tasks WHERE project_id = ? AND user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 20")
      .all(project.id, req.user!.id) as unknown as ProcessingTaskRow[];
    res.json({ jobs: rows.map(publicTask) });
  });

  // Job detail (refresh recovery: state comes only from the database).
  router.get("/analysis/:jobId", requireAuth, (req: AuthedRequest, res) => {
    const task = ownedTask(req.user!.id, req.params.jobId);
    if (!task) {
      res.status(404).json({ error: "Analysis job not found." });
      return;
    }
    res.json({ job: publicTask(task) });
  });

  // Cancel a queued or running job.
  router.post("/analysis/:jobId/cancel", requireAuth, (req: AuthedRequest, res) => {
    const task = ownedTask(req.user!.id, req.params.jobId);
    if (!task) {
      res.status(404).json({ error: "Analysis job not found." });
      return;
    }
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(task.status)) {
      res.status(409).json({ error: `This job is already ${task.status.toLowerCase()} and cannot be cancelled.` });
      return;
    }
    if (task.status === "QUEUED") {
      getDb()
        .prepare(
          "UPDATE processing_tasks SET status = 'CANCELLED', stage = 'CANCELLED', cancel_requested = 1, finished_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(nowIso(), nowIso(), task.id);
    } else {
      getDb()
        .prepare("UPDATE processing_tasks SET cancel_requested = 1, updated_at = ? WHERE id = ?")
        .run(nowIso(), task.id);
      killChildren(task.id);
    }
    const updated = ownedTask(req.user!.id, task.id)!;
    res.json({ job: publicTask(updated) });
  });

  // Retry a failed or cancelled job (prior attempt artifacts removed).
  router.post("/analysis/:jobId/retry", requireAuth, (req: AuthedRequest, res) => {
    const task = ownedTask(req.user!.id, req.params.jobId);
    if (!task) {
      res.status(404).json({ error: "Analysis job not found." });
      return;
    }
    if (!["FAILED", "CANCELLED"].includes(task.status)) {
      res.status(409).json({ error: "Only a failed or cancelled job can be retried." });
      return;
    }
    deleteTaskArtifacts(task);
    getDb()
      .prepare(
        `UPDATE processing_tasks
         SET status = 'QUEUED', stage = 'QUEUED', error = NULL, error_code = NULL, outcome = NULL,
             signals_json = '{}', cancel_requested = 0, started_at = NULL, finished_at = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(nowIso(), task.id);
    const updated = ownedTask(req.user!.id, task.id)!;
    res.status(200).json({ job: publicTask(updated) });
  });

  // Latest transcript for a project (+ segments + topic segments).
  router.get("/projects/:id/transcript", requireAuth, (req: AuthedRequest, res) => {
    const project = ownedProject(req.user!.id, req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found." });
      return;
    }
    const db = getDb();
    const transcript = db
      .prepare("SELECT * FROM transcripts WHERE project_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(project.id) as TranscriptRow | undefined;
    if (!transcript) {
      res.json({ transcript: null });
      return;
    }
    const segments = db
      .prepare("SELECT * FROM transcript_segments WHERE transcript_id = ? ORDER BY idx ASC")
      .all(transcript.id) as unknown as TranscriptSegmentRow[];
    const topics = db
      .prepare("SELECT * FROM topic_segments WHERE transcript_id = ? ORDER BY start_sec ASC")
      .all(transcript.id) as unknown as TopicSegmentRow[];
    res.json({
      transcript: {
        id: transcript.id,
        taskId: transcript.task_id,
        projectId: transcript.project_id,
        sourceAssetId: transcript.source_asset_id,
        language: transcript.language,
        languageProbability: transcript.language_probability,
        duration: transcript.duration,
        fullText: transcript.full_text,
        provider: transcript.provider,
        model: transcript.model,
        createdAt: transcript.created_at,
        hasWordTimestamps: segments.some((s) => Boolean(s.words_json)),
        speakerIdentificationAvailable: false,
        segments: segments.map((s) => ({
          id: s.id,
          index: s.idx,
          startSec: s.start_sec,
          endSec: s.end_sec,
          text: s.text,
          speaker: s.speaker,
          words: s.words_json ? (JSON.parse(s.words_json) as unknown) : null,
        })),
        topics: topics.map((t) => ({
          id: t.id,
          startSec: t.start_sec,
          endSec: t.end_sec,
          label: t.label,
          summaryText: t.summary_text,
        })),
      },
    });
  });

  // Candidate clips for a project.
  router.get("/projects/:id/candidates", requireAuth, (req: AuthedRequest, res) => {
    const project = ownedProject(req.user!.id, req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found." });
      return;
    }
    // Spec §6 sorts: highest score (default), shortest duration,
    // longest duration, timeline order (by start). Unknown values fall
    // back to the score order.
    const sort =
      req.query.sort === "start"
        ? "start_sec ASC, score DESC"
        : req.query.sort === "shortest"
          ? "duration ASC, score DESC"
          : req.query.sort === "longest"
            ? "duration DESC, score DESC"
            : "score DESC, start_sec ASC";
    const rows = getDb()
      .prepare(`SELECT * FROM candidate_clips WHERE project_id = ? AND user_id = ? ORDER BY ${sort}`)
      .all(project.id, req.user!.id) as unknown as CandidateClipRow[];
    res.json({ candidates: rows.map(publicCandidate) });
  });

  // Edit a candidate (title, select/remove).
  router.patch("/candidates/:id", requireAuth, (req: AuthedRequest, res) => {
    const candidate = getDb()
      .prepare("SELECT * FROM candidate_clips WHERE id = ? AND user_id = ?")
      .get(req.params.id, req.user!.id) as CandidateClipRow | undefined;
    if (!candidate) {
      res.status(404).json({ error: "Candidate clip not found." });
      return;
    }
    const parsed = patchCandidateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid candidate update." });
      return;
    }
    const title = parsed.data.title ?? candidate.title;
    const status = parsed.data.status ?? candidate.status;
    getDb()
      .prepare("UPDATE candidate_clips SET title = ?, status = ? WHERE id = ?")
      .run(title, status, candidate.id);
    const updated = getDb()
      .prepare("SELECT * FROM candidate_clips WHERE id = ?")
      .get(candidate.id) as unknown as CandidateClipRow;
    res.json({ candidate: publicCandidate(updated) });
  });

  // Candidate preview stream (owner only).
  router.get("/candidates/:id/preview", requireAuth, (req: AuthedRequest, res) => {
    const candidate = getDb()
      .prepare("SELECT * FROM candidate_clips WHERE id = ? AND user_id = ?")
      .get(req.params.id, req.user!.id) as CandidateClipRow | undefined;
    if (!candidate || candidate.preview_status !== "READY" || !candidate.preview_path) {
      res.status(404).json({ error: "Preview not available." });
      return;
    }
    const filePath = mediaPath(candidate.preview_path);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: "Preview file is missing." });
      return;
    }
    res.type("video/mp4");
    res.sendFile(filePath);
  });

  app.use("/api", router);
}
