// Typed client for the Phase 4 analysis API (server: /api/projects/:id/
// analysis, /api/analysis, /api/projects/:id/transcript,
// /api/projects/:id/candidates, /api/candidates).
//
// All state lives on the server: job status is polled from the API
// (never simulated with local timers), transcripts and candidates are
// whatever the pipeline actually produced, and nothing is stored in
// web storage.

import { API_BASE_URL } from "./api";
import { apiRequest } from "./auth";

export type AnalysisJobStatus =
  | "QUEUED"
  | "VALIDATING"
  | "EXTRACTING_AUDIO"
  | "TRANSCRIBING"
  | "ANALYZING"
  | "DETECTING_CLIPS"
  | "RANKING"
  | "GENERATING_PREVIEWS"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export interface AnalysisJob {
  id: string;
  projectId: string;
  sourceAssetId: string;
  prompt: string | null;
  settings: Record<string, unknown>;
  status: AnalysisJobStatus;
  stage: string;
  error: string | null;
  errorCode: string | null;
  outcome: string | null;
  candidateCount: number;
  transcriptId: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface AnalysisConfig {
  provider: string;
  configured: boolean;
  model: string;
  detail: string;
  speakerDiarization: boolean;
  wordTimestamps: boolean;
}

export interface TranscriptWord {
  start: number;
  end: number;
  word: string;
  probability: number | null;
}

export interface TranscriptSegment {
  id: string;
  index: number;
  startSec: number;
  endSec: number;
  text: string;
  speaker: string | null;
  words: TranscriptWord[] | null;
}

export interface TopicSegment {
  id: string;
  startSec: number;
  endSec: number;
  label: string;
  summaryText: string;
}

export interface Transcript {
  id: string;
  taskId: string;
  projectId: string;
  sourceAssetId: string;
  language: string | null;
  languageProbability: number | null;
  duration: number | null;
  fullText: string;
  provider: string;
  model: string;
  createdAt: string;
  hasWordTimestamps: boolean;
  speakerIdentificationAvailable: boolean;
  segments: TranscriptSegment[];
  topics: TopicSegment[];
}

export interface CandidateClip {
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
  status: "SELECTED" | "REMOVED";
  previewStatus: string;
  previewError: string | null;
  previewUrl: string | null;
  createdAt: string;
}

export const ACTIVE_JOB_STATUSES: AnalysisJobStatus[] = [
  "QUEUED",
  "VALIDATING",
  "EXTRACTING_AUDIO",
  "TRANSCRIBING",
  "ANALYZING",
  "DETECTING_CLIPS",
  "RANKING",
  "GENERATING_PREVIEWS",
];

export function isJobActive(job: AnalysisJob | null): boolean {
  return Boolean(job && ACTIVE_JOB_STATUSES.includes(job.status));
}

export const STAGE_LABELS: Record<string, string> = {
  QUEUED: "Queued",
  VALIDATING: "Validating source video",
  EXTRACTING_AUDIO: "Extracting audio",
  TRANSCRIBING: "Transcribing speech",
  ANALYZING: "Analysing transcript & signals",
  DETECTING_CLIPS: "Detecting clip moments",
  RANKING: "Ranking moments",
  GENERATING_PREVIEWS: "Generating preview clips",
  COMPLETED: "Completed",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
  CONFIGURATION: "Configuration problem",
};

export const analysisApi = {
  getConfig(): Promise<AnalysisConfig> {
    return apiRequest<AnalysisConfig>("/analysis/config");
  },

  createJob(
    projectId: string,
    input: { sourceAssetId: string; prompt?: string; language?: string },
  ): Promise<{ job: AnalysisJob; deduplicated: boolean }> {
    return apiRequest(`/projects/${encodeURIComponent(projectId)}/analysis`, {
      method: "POST",
      body: input,
    });
  },

  listJobs(projectId: string): Promise<{ jobs: AnalysisJob[] }> {
    return apiRequest<{ jobs: AnalysisJob[] }>(`/projects/${encodeURIComponent(projectId)}/analysis`);
  },

  getJob(jobId: string): Promise<{ job: AnalysisJob }> {
    return apiRequest<{ job: AnalysisJob }>(`/analysis/${encodeURIComponent(jobId)}`);
  },

  cancelJob(jobId: string): Promise<{ job: AnalysisJob }> {
    return apiRequest<{ job: AnalysisJob }>(`/analysis/${encodeURIComponent(jobId)}/cancel`, {
      method: "POST",
      body: {},
    });
  },

  retryJob(jobId: string): Promise<{ job: AnalysisJob }> {
    return apiRequest<{ job: AnalysisJob }>(`/analysis/${encodeURIComponent(jobId)}/retry`, {
      method: "POST",
      body: {},
    });
  },

  getTranscript(projectId: string): Promise<{ transcript: Transcript | null }> {
    return apiRequest<{ transcript: Transcript | null }>(
      `/projects/${encodeURIComponent(projectId)}/transcript`,
    );
  },

  listCandidates(
    projectId: string,
    sort: "score" | "start" | "shortest" | "longest" = "score",
  ): Promise<{ candidates: CandidateClip[] }> {
    return apiRequest<{ candidates: CandidateClip[] }>(
      `/projects/${encodeURIComponent(projectId)}/candidates?sort=${sort}`,
    );
  },

  updateCandidate(
    id: string,
    patch: { title?: string; status?: "SELECTED" | "REMOVED" },
  ): Promise<{ candidate: CandidateClip }> {
    return apiRequest<{ candidate: CandidateClip }>(`/candidates/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: patch,
    });
  },

  previewUrl(candidateId: string): string {
    return `${API_BASE_URL}/candidates/${encodeURIComponent(candidateId)}/preview`;
  },
};

export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatElapsed(fromIso: string, toIso?: string | null): string {
  const start = new Date(fromIso).getTime();
  const end = toIso ? new Date(toIso).getTime() : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return "—";
  const sec = Math.round((end - start) / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}
