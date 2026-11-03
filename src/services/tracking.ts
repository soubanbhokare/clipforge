// Typed client for the Phase 7 Face Lock / Active Speaker /
// Smart Auto-Reframing API (server: src/tracking.ts).
//
// Subjects are anonymous per-video ids ("face-1") — the API never
// returns identities. Confidences are the detectors' real scores.
// Active-speaker associations carry their evidence (speech source,
// mouth-motion proxy value, presence) so the UI can show WHY a pick
// was made — and show "not enough evidence" when none was.

import { apiRequest } from "./auth";
import type { RenderJob } from "./editor";

export type ReframeMode =
  | "face-lock"
  | "active-speaker"
  | "person-follow"
  | "center-subject"
  | "smart-auto"
  | "manual"
  | "split-screen";

export const REFRAME_MODE_LABELS: Record<ReframeMode, string> = {
  "face-lock": "Face Lock",
  "active-speaker": "Active Speaker",
  "person-follow": "Person Follow",
  "center-subject": "Center Subject",
  "smart-auto": "Smart Auto",
  manual: "Manual",
  "split-screen": "Split Screen",
};

export interface NormBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FollowControls {
  sensitivity: number;
  followSpeed: number;
  smoothing: number;
  margin: number;
  zoom: number;
  aggressiveness: number;
}

export interface TrackingJob {
  id: string;
  projectId: string;
  sourceAssetId: string;
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  stage: string;
  progress: { done?: number; total?: number };
  scenes: { start: number; end: number }[];
  result: {
    faceSubjects?: number;
    personSubjects?: number;
    speechWindows?: number;
    speechSource?: string | null;
    activePicks?: number;
    personModel?: string | null;
    vadError?: string | null;
  };
  outcome: string | null;
  error: string | null;
  errorCode: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface TrackedSubject {
  id: string;
  key: string;
  kind: "face" | "person";
  firstSeenSec: number;
  lastSeenSec: number;
  presenceRatio: number;
  meanConfidence: number | null;
  bestConfidence: number | null;
  bestTimeSec: number | null;
  bestBox: NormBox | null;
  hasThumbnail: boolean;
  thumbnailUrl: string | null;
}

export interface Association {
  subjectKey: string;
  windowStart: number;
  windowEnd: number;
  speechSource: string;
  score: number;
  confidence: "low" | "medium" | "high";
  isActivePick: boolean;
  evidence: {
    mouthMotion: number | null;
    presenceRatio: number;
    samplesInWindow: number;
    note: string;
  };
}

export interface ReframeConfig {
  id: string;
  documentId: string;
  projectId: string;
  jobId: string | null;
  mode: ReframeMode;
  enabled: boolean;
  /** Auto-Follow pause, persisted server-side (inside controls_json):
   *  when true the computed crop path is static in preview + render. */
  paused: boolean;
  /** Manual Crop rectangle (fitMode "manual-crop"); null when unset. */
  manualCrop: NormBox | null;
  aspect: string;
  outWidth: number;
  outHeight: number;
  fitMode: "smart-crop" | "fill" | "fit" | "center-crop" | "manual-crop";
  subjectKey: string | null;
  targetPosX: "left" | "center" | "right";
  targetPosY: "upper" | "middle";
  controls: FollowControls;
  configVersion: number;
}

export interface TrackingKeyframe {
  id: string;
  kind: "crop" | "manual";
  t: number;
  crop: NormBox | null;
  fit: "fill" | "fit";
  subjectKey: string | null;
  regionSubjectKey: string | null;
  confidence: number | null;
  lost: boolean;
}

export interface SceneOverride {
  id: string;
  topicSegmentId: string | null;
  rangeStart: number;
  rangeEnd: number;
  mode: ReframeMode | null;
  subjectKey: string | null;
  settings: { controls?: Partial<FollowControls> | null; fitMode?: string | null };
}

export interface ReframeState {
  config: ReframeConfig;
  provider: { configured: boolean; personConfigured: boolean; detail: string };
  job: TrackingJob | null;
  latestJob: TrackingJob | null;
  sourceAsset: { id: string; width: number | null; height: number | null; duration: number | null; hasAudio: boolean } | null;
  subjects: TrackedSubject[];
  subjectFrames: Record<string, { t: number; box: NormBox; confidence: number | null }[]>;
  /** Distinct people eligible for Split Screen (a person box that
   *  contains a tracked face is the same human, not a 2nd subject). */
  splitEligibleKeys: string[];
  associations: Association[];
  scenes: { start: number; end: number }[];
  keyframes: TrackingKeyframe[];
  regionKeyframes: Record<string, TrackingKeyframe[]>;
  manualKeyframes: TrackingKeyframe[];
  sceneOverrides: SceneOverride[];
  split: {
    layout: string;
    regions: {
      subjectKey: string;
      rect: NormBox;
      /** Per-subject split crop (the server applies zoom + offsets
       *  on top of the subject's own tracking crop). */
      crop?: { zoom?: number; offsetX?: number; offsetY?: number };
    }[];
  } | null;
}

export interface TrackingProviderStatus {
  configured: boolean;
  personConfigured: boolean;
  faceModel: string | null;
  personModel: string | null;
  vadModel: string | null;
  detail: string;
}

export const trackingApi = {
  status(): Promise<TrackingProviderStatus> {
    return apiRequest<TrackingProviderStatus>("/tracking/status");
  },
  createJob(projectId: string): Promise<{ job: TrackingJob; deduplicated: boolean }> {
    return apiRequest(`/projects/${encodeURIComponent(projectId)}/tracking-jobs`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  },
  getJob(jobId: string): Promise<{ job: TrackingJob }> {
    return apiRequest(`/tracking-jobs/${encodeURIComponent(jobId)}`);
  },
  cancelJob(jobId: string): Promise<{ job: TrackingJob }> {
    return apiRequest(`/tracking-jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });
  },
  retryJob(jobId: string): Promise<{ job: TrackingJob; deduplicated: boolean }> {
    return apiRequest(`/tracking-jobs/${encodeURIComponent(jobId)}/retry`, { method: "POST" });
  },
  getReframe(docId: string): Promise<ReframeState> {
    return apiRequest(`/editor/${encodeURIComponent(docId)}/reframe`);
  },
  updateConfig(
    docId: string,
    patch: Omit<Partial<ReframeConfig>, "controls"> & { controls?: Partial<FollowControls> },
  ): Promise<ReframeState> {
    return apiRequest(`/editor/${encodeURIComponent(docId)}/reframe/config`, {
      method: "PUT",
      body: JSON.stringify(patch),
    });
  },
  addKeyframe(docId: string, body: { t: number; crop: NormBox | null; fit?: "fill" | "fit" }): Promise<ReframeState> {
    return apiRequest(`/editor/${encodeURIComponent(docId)}/reframe/keyframes`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
  updateKeyframe(docId: string, keyframeId: string, body: { t: number; crop: NormBox | null; fit?: "fill" | "fit" }): Promise<ReframeState> {
    return apiRequest(`/editor/${encodeURIComponent(docId)}/reframe/keyframes/${encodeURIComponent(keyframeId)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  },
  deleteKeyframe(docId: string, keyframeId: string): Promise<ReframeState> {
    return apiRequest(`/editor/${encodeURIComponent(docId)}/reframe/keyframes/${encodeURIComponent(keyframeId)}`, {
      method: "DELETE",
    });
  },
  setSceneOverrides(
    docId: string,
    overrides: {
      topicSegmentId?: string | null;
      rangeStart: number;
      rangeEnd: number;
      mode?: ReframeMode | null;
      subjectKey?: string | null;
      controls?: Partial<FollowControls>;
      fitMode?: ReframeConfig["fitMode"] | null;
    }[],
  ): Promise<ReframeState> {
    return apiRequest(`/editor/${encodeURIComponent(docId)}/reframe/scene-overrides`, {
      method: "PUT",
      body: JSON.stringify({ overrides }),
    });
  },
  deleteSceneOverride(docId: string, overrideId: string): Promise<ReframeState> {
    return apiRequest(`/editor/${encodeURIComponent(docId)}/reframe/scene-overrides/${encodeURIComponent(overrideId)}`, {
      method: "DELETE",
    });
  },
  setSplit(
    docId: string,
    layout: string,
    regions?: { subjectKey: string; rect: NormBox; crop?: { zoom?: number; offsetX?: number; offsetY?: number } }[],
  ): Promise<ReframeState> {
    return apiRequest(`/editor/${encodeURIComponent(docId)}/reframe/split`, {
      method: "PUT",
      body: JSON.stringify({ layout, regions }),
    });
  },
  reframeRender(docId: string): Promise<{ job: RenderJob; deduplicated: boolean }> {
    return apiRequest(`/editor/${encodeURIComponent(docId)}/reframe-render`, { method: "POST" });
  },
  /** Persist the Auto-Follow pause on the config (same config PUT;
   *  the server stores it in controls_json and the render honours
   *  it exactly like the preview). */
  setFollowPaused(docId: string, paused: boolean): Promise<ReframeState> {
    return trackingApi.updateConfig(docId, { paused });
  },
  /** Set (or clear, with null) the Manual Crop rectangle. */
  setManualCrop(docId: string, manualCrop: NormBox | null): Promise<ReframeState> {
    return trackingApi.updateConfig(docId, { manualCrop });
  },
  /** Reset the reframe configuration (mode, controls, pause, manual
   *  crop), manual keyframes, scene overrides and split layout back
   *  to defaults; the tracking analysis itself is kept. */
  resetTracking(docId: string): Promise<ReframeState> {
    return apiRequest(`/editor/${encodeURIComponent(docId)}/reframe/reset-tracking`, { method: "POST" });
  },
};
