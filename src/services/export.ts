// Typed client for the Phase 9 Export Studio / Rendering Queue API
// (server: src/export.ts).
//
// Wire-shape contract (the Phase 8 lesson): ExportSettings below
// mirrors the server's Zod schema in server/src/export.ts FIELD FOR
// FIELD, and DEFAULT_EXPORT_SETTINGS mirrors the server default
// exactly. The export e2e suite posts this exact default object to
// prove the panel's shape is accepted by the server.
//
// Honesty notes mirrored from the server: progress comes from the
// encoder's own output (percent is null until real progress exists);
// file-size estimates appear ONLY for bitrate-mode exports and are
// labelled as estimates; pause exists only for queued jobs (a
// running FFmpeg render cannot be paused safely — cancel instead).

import { apiRequest } from "./auth";
import { API_BASE_URL } from "./api";

export type ExportContainer = "mp4" | "webm";
export type ExportVideoCodec = "libx264" | "libx265" | "libvpx-vp9";
export type ExportAudioCodec = "aac" | "libopus" | "libmp3lame";
export type ExportResolution = "original" | "480p" | "720p" | "1080p" | "1440p" | "2160p";
export type ExportAspect = "original" | "9:16" | "16:9" | "1:1" | "4:5" | "custom";
export type ExportQualityMode = "preset" | "crf" | "bitrate";
export type ExportQualityPreset = "low" | "standard" | "high" | "maximum";
export type ExportEncoderPreset =
  | "ultrafast" | "superfast" | "veryfast" | "faster" | "fast" | "medium" | "slow";
export type ExportCaptionMode = "burn" | "separate" | "bundle" | "none";
export type ExportCaptionFormat = "srt" | "vtt" | "both";
export type ExportNamingPattern =
  | "project-clip-date" | "project-clip-resolution" | "clip-aspect-format" | "custom";

export interface ExportSettings {
  container: ExportContainer;
  videoCodec: ExportVideoCodec;
  audioCodec: ExportAudioCodec;
  audioOnly: boolean;
  resolution: ExportResolution;
  aspect: ExportAspect;
  customWidth: number | null;
  customHeight: number | null;
  qualityMode: ExportQualityMode;
  qualityPreset: ExportQualityPreset;
  crf: number | null;
  videoBitrateKbps: number | null;
  encoderPreset: ExportEncoderPreset;
  fps: number | null;
  keyframeInterval: number | null;
  includeOriginalAudio: boolean;
  includeMusic: boolean;
  includeBrollAudio: boolean;
  audioBitrateKbps: number;
  audioSampleRate: 44100 | 48000;
  audioChannels: 1 | 2;
  normalizeAudio: boolean;
  captionMode: ExportCaptionMode;
  captionFormat: ExportCaptionFormat;
  includeEnhancement: boolean;
  includeReframe: boolean;
  namingPattern: ExportNamingPattern;
  customName: string | null;
  rangeStart: number | null;
  rangeEnd: number | null;
}

/** MUST match DEFAULT_EXPORT_SETTINGS in server/src/export.ts. */
export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
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

export interface ExportTargetRef {
  kind: "document" | "version" | "candidate";
  id?: string;
}

export interface ExportTargets {
  document: {
    kind: "document";
    docId: string;
    label: string;
    duration: number;
    canvas: { aspect: string; width: number; height: number; custom: boolean };
  };
  versions: { kind: "version"; id: string; label: string; createdAt: string }[];
  candidates: {
    kind: "candidate";
    id: string;
    label: string;
    duration: number;
    score: number;
    startSec: number;
    endSec: number;
  }[];
}

export interface PreflightCheck {
  id: string;
  ok: boolean;
  level: "error" | "warning";
  detail: string;
}

export interface ExportSummary {
  outputName: string;
  targetLabel: string;
  durationSec: number;
  width: number;
  height: number;
  aspect: string;
  fps: number | null;
  container: string;
  videoCodec: string | null;
  audioCodec: string;
  audioOnly: boolean;
  captionMode: ExportCaptionMode;
  captionFormat: ExportCaptionFormat;
  captionCount: number;
  includeEnhancement: boolean;
  includeReframe: boolean;
  qualityMode: ExportQualityMode;
  qualityPreset: ExportQualityPreset;
  estimatedSizeBytes: number | null;
  estimateNote: string | null;
}

export interface PreflightResult {
  ok: boolean;
  checks: PreflightCheck[];
  summary: ExportSummary | null;
}

export interface ExportProgress {
  /** Current encoder frame; null until the encoder reports one. */
  frame: number | null;
  outTimeSec: number;
  expectedSec: number;
  /** Estimated total frames (fps × expected duration); null when
   *  the encode's frame rate is unknown. */
  expectedFrames: number | null;
  /** Wall-clock seconds since the job was claimed; null if the
   *  claim time is unknown. */
  elapsedSec: number | null;
  /** Encoder-reported speed multiplier; null until reported. */
  speed: number | null;
  percent: number | null;
}

export interface ExportJobOutput {
  id: string;
  filename: string;
  format: string;
  width: number | null;
  height: number | null;
  duration: number | null;
  fileSize: number | null;
  status: string;
  failureReason: string | null;
  /** Poster-frame URL (owner-checked) when one was extracted at
   *  completion; null for audio-only/failed exports. */
  thumbnailUrl: string | null;
}

export interface ExportJob {
  id: string;
  documentId: string;
  projectId: string;
  status: "QUEUED" | "RUNNING" | "PAUSED" | "COMPLETED" | "FAILED" | "CANCELLED";
  stage: string;
  error: string | null;
  hasOutput: boolean;
  kind: "EXPORT";
  priority: number;
  retryCount: number;
  /** Id of the worker process that claimed this job (null until claimed). */
  workerId: string | null;
  progress: ExportProgress | null;
  outputName: string | null;
  held: boolean;
  queuePosition: number | null;
  exportSettings: (ExportSettings & { outputName?: string; targetLabel?: string }) | null;
  settings: {
    canvas: { aspect: string; width: number; height: number } | null;
    timelineDuration: number | null;
  };
  output: ExportJobOutput | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ExportJobDetail {
  job: ExportJob;
  validation: { id: string; phase: string; ok: boolean; checks: PreflightCheck[]; createdAt: string }[];
  errors: { id: string; stage: string; message: string; created_at: string }[];
}

export interface ExportHistoryEntry extends ExportJobOutput {
  jobId: string;
  projectId: string;
  targetLabel: string;
  /** What the export was made from (migration v10): document |
   *  version | candidate, plus the version/candidate id. */
  targetKind: string | null;
  targetId: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  projectName: string | null;
  createdAt: string;
}

export interface ExportPreset {
  id: string;
  name: string;
  description: string | null;
  builtin: boolean;
  settings: ExportSettings;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ExportBundle {
  id: string;
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";
  stage: string;
  jobIds: string[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface ExportCapabilities {
  ffmpegVersion: string | null;
  /** Server-side render concurrency (RENDER_CONCURRENCY, 1–4). */
  renderConcurrency: number;
  encoders: Record<string, boolean | string | null>;
  containers: { id: string; videoCodecs: string[]; audioCodecs: string[]; supported: boolean }[];
  audioOnlyCodecs: string[];
  qualityPresets: { id: string; description: string }[];
}

export const exportsApi = {
  capabilities(): Promise<ExportCapabilities> {
    return apiRequest("/exports/capabilities");
  },
  targets(projectId: string): Promise<ExportTargets> {
    return apiRequest(`/projects/${encodeURIComponent(projectId)}/export-targets`);
  },
  preflight(
    projectId: string,
    body: { target: ExportTargetRef; settings: ExportSettings; presetId?: string },
  ): Promise<PreflightResult> {
    return apiRequest(`/projects/${encodeURIComponent(projectId)}/exports/preflight`, {
      method: "POST",
      body,
    });
  },
  create(
    projectId: string,
    body: {
      targets: ExportTargetRef[];
      settings: ExportSettings;
      presetId?: string;
      overrides?: Record<string, Partial<ExportSettings>>;
      priority?: number;
    },
  ): Promise<{ jobs: (ExportJob & { deduplicated: boolean; preflight: PreflightCheck[] | null })[]; errors: { target: ExportTargetRef; error: string }[] }> {
    return apiRequest(`/projects/${encodeURIComponent(projectId)}/exports`, { method: "POST", body });
  },
  queue(params: { status?: string; sort?: string; projectId?: string } = {}): Promise<{ jobs: ExportJob[] }> {
    const q = new URLSearchParams();
    if (params.status) q.set("status", params.status);
    if (params.sort) q.set("sort", params.sort);
    if (params.projectId) q.set("projectId", params.projectId);
    const suffix = q.toString() ? `?${q.toString()}` : "";
    return apiRequest(`/exports/queue${suffix}`);
  },
  job(jobId: string): Promise<ExportJobDetail> {
    return apiRequest(`/export-jobs/${encodeURIComponent(jobId)}`);
  },
  cancel(jobId: string): Promise<{ job: ExportJob }> {
    return apiRequest(`/export-jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST", body: {} });
  },
  pause(jobId: string): Promise<{ job: ExportJob }> {
    return apiRequest(`/export-jobs/${encodeURIComponent(jobId)}/pause`, { method: "POST", body: {} });
  },
  resume(jobId: string): Promise<{ job: ExportJob }> {
    return apiRequest(`/export-jobs/${encodeURIComponent(jobId)}/resume`, { method: "POST", body: {} });
  },
  start(jobId: string): Promise<{ job: ExportJob }> {
    return apiRequest(`/export-jobs/${encodeURIComponent(jobId)}/start`, { method: "POST", body: {} });
  },
  retry(jobId: string): Promise<{ job: ExportJob }> {
    return apiRequest(`/export-jobs/${encodeURIComponent(jobId)}/retry`, { method: "POST", body: {} });
  },
  setPriority(jobId: string, priority: number): Promise<{ job: ExportJob }> {
    return apiRequest(`/export-jobs/${encodeURIComponent(jobId)}/priority`, {
      method: "PATCH",
      body: { priority },
    });
  },
  remove(jobId: string): Promise<void> {
    // The server requires ?confirm=true as a second gate behind the
    // page's inline two-step confirmation, and 409s without it.
    return apiRequest(`/export-jobs/${encodeURIComponent(jobId)}?confirm=true`, { method: "DELETE" });
  },
  downloadUrl(jobId: string, file: "video" | "srt" | "vtt" | "zip" = "video"): string {
    return `${API_BASE_URL}/export-jobs/${encodeURIComponent(jobId)}/download?file=${file}`;
  },
  /** Same owner-checked download, served inline for the in-app viewer. */
  inlineUrl(jobId: string): string {
    return `${API_BASE_URL}/export-jobs/${encodeURIComponent(jobId)}/download?file=video&inline=1`;
  },
  /** Owner-checked poster frame (present only when the payload's
   *  thumbnailUrl is non-null). */
  thumbnailUrl(jobId: string): string {
    return `${API_BASE_URL}/export-jobs/${encodeURIComponent(jobId)}/thumbnail`;
  },
  history(): Promise<{ outputs: ExportHistoryEntry[] }> {
    return apiRequest("/exports/history");
  },
  deleteHistory(outputId: string): Promise<void> {
    // Same server-side confirmation gate as remove() above.
    return apiRequest(`/exports/history/${encodeURIComponent(outputId)}?confirm=true`, { method: "DELETE" });
  },
  createBundle(jobIds: string[]): Promise<{ bundle: ExportBundle }> {
    return apiRequest("/exports/bundles", { method: "POST", body: { jobIds } });
  },
  /** Bundle from History-tab output ids (the server maps each
   *  output to its job). */
  createBundleFromOutputs(outputIds: string[]): Promise<{ bundle: ExportBundle }> {
    return apiRequest("/exports/bundles", { method: "POST", body: { outputIds } });
  },
  bundle(bundleId: string): Promise<{ bundle: ExportBundle }> {
    return apiRequest(`/export-bundles/${encodeURIComponent(bundleId)}`);
  },
  bundleDownloadUrl(bundleId: string): string {
    return `${API_BASE_URL}/export-bundles/${encodeURIComponent(bundleId)}/download`;
  },
  presets(): Promise<{ presets: ExportPreset[] }> {
    return apiRequest("/export-presets");
  },
  createPreset(name: string, settings: ExportSettings): Promise<{ preset: ExportPreset }> {
    return apiRequest("/export-presets", { method: "POST", body: { name, settings } });
  },
  updatePreset(id: string, name: string, settings: ExportSettings): Promise<{ preset: ExportPreset }> {
    return apiRequest(`/export-presets/${encodeURIComponent(id)}`, { method: "PUT", body: { name, settings } });
  },
  deletePreset(id: string): Promise<void> {
    return apiRequest(`/export-presets/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
  duplicatePreset(id: string): Promise<{ preset: ExportPreset }> {
    return apiRequest(`/export-presets/${encodeURIComponent(id)}/duplicate`, { method: "POST", body: {} });
  },
};
