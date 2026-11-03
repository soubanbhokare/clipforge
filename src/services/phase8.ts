// Typed client for the Phase 8 B-roll / Enhancement / Background
// API (server: src/broll.ts + src/enhance.ts).
//
// Honesty contract mirrored from the server: recommendation scores
// are real transcript term-overlap scores and every recommendation
// carries its matched terms as evidence; provider-backed operations
// (stock import, AI generation, background removal) have NO provider
// configured in this environment, so the API answers 422
// CONFIGURATION_ERROR and persists a FAILED job — the UI surfaces
// that state verbatim instead of pretending.

import { apiRequest } from "./auth";
import type { RenderJob } from "./editor";

export type Phase8JobKind =
  | "BROLL_RECOMMENDATIONS"
  | "ENHANCEMENT"
  | "ENHANCEMENT_PREVIEW"
  | "BACKGROUND_REMOVAL"
  | "PROVIDER_IMPORT"
  | "AI_GENERATION"
  | "URL_IMPORT";

export type Phase8JobStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";

export interface Phase8Job {
  id: string;
  projectId: string | null;
  versionId: string | null;
  kind: Phase8JobKind;
  status: Phase8JobStatus;
  stage: string;
  priority: number;
  payload: Record<string, unknown>;
  result: Record<string, unknown>;
  error: string | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ProviderInfo {
  configured: boolean;
  detail: string;
  id?: string;
}

export interface Phase8Status {
  providers: {
    stock: ProviderInfo;
    generation: ProviderInfo;
    backgroundRemoval: ProviderInfo;
    enhancement: {
      configured: boolean;
      engine: string;
      capabilities: {
        classification: { standardFilters: string; aiPowered: string; providerDependent: string };
        upscaleNote: string;
        interpolationNote: string;
      };
    };
  };
  categories: string[];
}

export interface BrollRecommendation {
  id: string;
  jobId: string | null;
  projectId: string;
  windowStartSec: number;
  windowEndSec: number;
  passage: string;
  assetRef: string;
  assetKind: string;
  assetId: string;
  assetFilename: string;
  assetCategory: string | null;
  assetDuration: number | null;
  thumbnailUrl: string | null;
  streamUrl: string | null;
  score: number;
  matchedTerms: string[];
  reason: string;
  suggestedStartSec: number;
  suggestedDurationSec: number;
  source: string;
  license: Record<string, unknown> | null;
  status: "PENDING" | "ACCEPTED" | "DISMISSED" | "REPLACED";
  placementId: string | null;
  createdAt: string;
}

export type BrollDisplayMode = "FULLSCREEN" | "PIP" | "OVERLAY";

export interface BrollPlacement {
  id: string;
  projectId: string;
  versionId: string;
  recommendationId: string | null;
  itemId: string;
  assetKind: string;
  assetId: string;
  startSec: number;
  durationSec: number;
  sourceInSec: number;
  sourceOutSec: number;
  displayMode: BrollDisplayMode;
  keepOriginalAudio: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LibraryAsset {
  ref: string;
  kind: string;
  id: string;
  projectId: string | null;
  filename: string;
  mediaKind: "VIDEO" | "AUDIO" | "IMAGE";
  duration: number | null;
  width: number | null;
  height: number | null;
  aspect: string | null;
  fileSize: number | null;
  hasAudio: boolean | null;
  hasVideo: boolean | null;
  audioCodec: string | null;
  videoCodec: string | null;
  container: string | null;
  createdAt: string;
  category: string;
  sourceType: string;
  provider: string | null;
  licenseName: string | null;
  attributionText: string | null;
  processingStatus: string;
  tags: string[];
  folderId: string | null;
  streamUrl: string | null;
  thumbnailUrl: string | null;
  usage: { usedByProjects: number; timelineItems: number; events: number };
}

export interface MediaFolder {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: string;
}

// These two interfaces mirror server/src/enhance.ts EXACTLY (the
// server zod schemas are the source of truth): same field names,
// same nesting, same types. The panel sends these objects verbatim,
// so any drift here makes the server's strict validation answer 400.
export interface VideoEnhanceSettings {
  denoise: number;
  sharpen: number;
  artifactReduction: number;
  brightness: number;
  contrast: number;
  saturation: number;
  exposure: number;
  gamma: number;
  temperature: number;
  tint: number;
  highlights: number;
  shadows: number;
  whiteBalanceK: number;
  blur: number;
  vignette: number;
  grayscale: boolean;
  upscale: { enabled: boolean; width: number; height: number };
  fps: { target: number | null; interpolate: boolean };
  stabilization: { enabled: boolean; strength: number; smoothing: number; cropCompensation: number };
}

export interface AudioEnhanceSettings {
  denoise: number;
  normalize: "off" | "loudnorm" | "dynaudnorm";
  targetLufs: number;
  clarity: number;
  hum: { enabled: boolean; freq: 50 | 60 };
  gainDb: number;
  fadeInSec: number;
  fadeOutSec: number;
  ducking: { enabled: boolean; amount: number };
}

export interface EnhancementConfig {
  id: string | null;
  documentId: string;
  projectId: string;
  videoEnabled: boolean;
  audioEnabled: boolean;
  video: VideoEnhanceSettings;
  audio: AudioEnhanceSettings;
  scope: "project" | "items";
  itemIds: string[];
  updatedAt: string | null;
}

export interface EffectPreset {
  id: string;
  name: string;
  kind: "video" | "audio" | "background" | "effect";
  builtin: boolean;
  settings: Record<string, unknown>;
  requiresBackgroundProvider?: boolean;
  note?: string | null;
  basedOn?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

// Defaults mirror the server's DEFAULT_VIDEO_ENHANCE /
// DEFAULT_AUDIO_ENHANCE. One deliberate presentation difference: the
// server stores whiteBalanceK as null when no Kelvin correction has
// been saved; the form's Kelvin slider needs a number, so the client
// default is the neutral 6500 K (a schema-valid value), and
// toClientVideoSettings below coerces a server null back to it.
export const DEFAULT_VIDEO_ENHANCE: VideoEnhanceSettings = {
  denoise: 0, sharpen: 0, artifactReduction: 0,
  brightness: 0, contrast: 1, saturation: 1, exposure: 0, gamma: 1,
  temperature: 0, tint: 0, highlights: 0, shadows: 0, whiteBalanceK: 6500,
  blur: 0, vignette: 0, grayscale: false,
  upscale: { enabled: false, width: 1920, height: 1080 },
  fps: { target: null, interpolate: false },
  stabilization: { enabled: false, strength: 0.5, smoothing: 15, cropCompensation: 0.5 },
};

export const DEFAULT_AUDIO_ENHANCE: AudioEnhanceSettings = {
  denoise: 0, normalize: "off", targetLufs: -16, clarity: 0,
  hum: { enabled: false, freq: 50 },
  gainDb: 0, fadeInSec: 0, fadeOutSec: 0,
  ducking: { enabled: false, amount: 0.5 },
};

/** Coerce anything server-shaped (a stored config, a preset's
 *  settings — possibly partial, possibly carrying whiteBalanceK:
 *  null) into a complete client settings object, so the form never
 *  renders `undefined.<field>` off a missing nested key. */
export function toClientVideoSettings(
  raw: Partial<VideoEnhanceSettings> & { whiteBalanceK?: number | null },
): VideoEnhanceSettings {
  return {
    ...DEFAULT_VIDEO_ENHANCE,
    ...raw,
    whiteBalanceK:
      typeof raw.whiteBalanceK === "number" ? raw.whiteBalanceK : DEFAULT_VIDEO_ENHANCE.whiteBalanceK,
    upscale: { ...DEFAULT_VIDEO_ENHANCE.upscale, ...(raw.upscale ?? {}) },
    fps: { ...DEFAULT_VIDEO_ENHANCE.fps, ...(raw.fps ?? {}) },
    stabilization: { ...DEFAULT_VIDEO_ENHANCE.stabilization, ...(raw.stabilization ?? {}) },
  };
}

export function toClientAudioSettings(raw: Partial<AudioEnhanceSettings>): AudioEnhanceSettings {
  return {
    ...DEFAULT_AUDIO_ENHANCE,
    ...raw,
    hum: { ...DEFAULT_AUDIO_ENHANCE.hum, ...(raw.hum ?? {}) },
    ducking: { ...DEFAULT_AUDIO_ENHANCE.ducking, ...(raw.ducking ?? {}) },
  };
}

export const phase8Api = {
  status(): Promise<Phase8Status> {
    return apiRequest<Phase8Status>("/phase8/status");
  },

  // -- B-roll recommendations --
  createRecommendations(
    projectId: string,
    instructions?: string,
  ): Promise<{ job: Phase8Job; deduplicated: boolean }> {
    return apiRequest(`/projects/${encodeURIComponent(projectId)}/broll/recommendations`, {
      method: "POST",
      body: JSON.stringify(instructions ? { instructions } : {}),
    });
  },
  listRecommendations(
    projectId: string,
    status?: string,
  ): Promise<{ recommendations: BrollRecommendation[] }> {
    const q = status ? `?status=${encodeURIComponent(status)}` : "";
    return apiRequest(`/projects/${encodeURIComponent(projectId)}/broll/recommendations${q}`);
  },
  dismissRecommendation(id: string): Promise<{ recommendation: BrollRecommendation }> {
    return apiRequest(`/broll-recommendations/${encodeURIComponent(id)}/dismiss`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  },
  replaceRecommendation(id: string): Promise<{ recommendation: BrollRecommendation }> {
    return apiRequest(`/broll-recommendations/${encodeURIComponent(id)}/replace`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  },
  acceptRecommendation(
    id: string,
    body: {
      startSec?: number;
      durationSec?: number;
      displayMode?: BrollDisplayMode;
      keepOriginalAudio?: boolean;
    },
  ): Promise<{ placement: BrollPlacement; mappedFromSourceTime: boolean }> {
    return apiRequest(`/broll-recommendations/${encodeURIComponent(id)}/accept`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
  listPlacements(projectId: string): Promise<{ placements: BrollPlacement[] }> {
    return apiRequest(`/projects/${encodeURIComponent(projectId)}/broll/placements`);
  },
  updatePlacement(
    id: string,
    body: Partial<{
      startSec: number;
      durationSec: number;
      displayMode: BrollDisplayMode;
      keepOriginalAudio: boolean;
    }>,
  ): Promise<{ placement: BrollPlacement }> {
    return apiRequest(`/broll-placements/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  },
  deletePlacement(id: string): Promise<{ ok: boolean }> {
    return apiRequest(`/broll-placements/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
  searchLibrary(
    projectId: string,
    query: string,
    source?: "library" | "provider",
  ): Promise<{ results: (LibraryAsset & { score: number; matchedTerms: string[] })[] }> {
    return apiRequest(`/projects/${encodeURIComponent(projectId)}/broll/search`, {
      method: "POST",
      body: JSON.stringify(source ? { query, source } : { query }),
    });
  },

  // -- provider-backed operations (honest 422s while unconfigured) --
  importStock(
    projectId: string,
    providerAssetId: string,
    licenseName?: string,
  ): Promise<{ job: Phase8Job }> {
    return apiRequest(`/projects/${encodeURIComponent(projectId)}/broll/import`, {
      method: "POST",
      body: JSON.stringify(licenseName ? { providerAssetId, licenseName } : { providerAssetId }),
    });
  },
  generateMedia(
    projectId: string,
    prompt: string,
    mediaKind: "video" | "image",
  ): Promise<{ job: Phase8Job }> {
    return apiRequest(`/projects/${encodeURIComponent(projectId)}/broll/generate`, {
      method: "POST",
      body: JSON.stringify({ prompt, mediaKind }),
    });
  },
  startBackgroundJob(
    projectId: string,
    assetRef: string,
    mode: "remove" | "blur" | "solid-dark" | "solid-light" | "custom-image" | "custom-video",
  ): Promise<{ job: Phase8Job }> {
    return apiRequest(`/projects/${encodeURIComponent(projectId)}/background-jobs`, {
      method: "POST",
      body: JSON.stringify({ assetRef, mode }),
    });
  },

  // -- enhancement jobs --
  createEnhancementJob(
    projectId: string,
    body: {
      assetRef: string;
      video?: Partial<VideoEnhanceSettings>;
      audio?: Partial<AudioEnhanceSettings>;
      preview?: boolean;
    },
  ): Promise<{ job: Phase8Job; deduplicated: boolean }> {
    return apiRequest(`/projects/${encodeURIComponent(projectId)}/enhancement-jobs`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
  getJob(jobId: string): Promise<{ job: Phase8Job }> {
    return apiRequest(`/phase8-jobs/${encodeURIComponent(jobId)}`);
  },
  cancelJob(jobId: string): Promise<{ job: Phase8Job }> {
    return apiRequest(`/phase8-jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  },
  retryJob(jobId: string): Promise<{ job: Phase8Job; deduplicated: boolean }> {
    return apiRequest(`/phase8-jobs/${encodeURIComponent(jobId)}/retry`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  },
  listJobs(projectId: string): Promise<{ jobs: Phase8Job[] }> {
    return apiRequest(`/projects/${encodeURIComponent(projectId)}/phase8-jobs`);
  },
  previewUrl(jobId: string, which: "before" | "after"): string {
    return `/api/phase8-jobs/${encodeURIComponent(jobId)}/preview/${which}`;
  },

  // -- document enhancement config + render --
  getEnhancement(docId: string): Promise<{ config: EnhancementConfig; providers: Phase8Status["providers"] }> {
    return apiRequest(`/editor/${encodeURIComponent(docId)}/enhancement`);
  },
  putEnhancement(
    docId: string,
    body: {
      videoEnabled: boolean;
      audioEnabled: boolean;
      video: VideoEnhanceSettings;
      audio: AudioEnhanceSettings;
      scope: "project" | "items";
      itemIds: string[];
    },
  ): Promise<{ config: EnhancementConfig }> {
    return apiRequest(`/editor/${encodeURIComponent(docId)}/enhancement`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  },
  renderEnhanced(docId: string): Promise<{ job: RenderJob; deduplicated: boolean }> {
    return apiRequest(`/editor/${encodeURIComponent(docId)}/render-enhanced`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  },

  // -- media library (spec §11) --
  listLibrary(params: {
    projectId?: string;
    category?: string;
    q?: string;
    folderId?: string;
    sort?: string;
  }): Promise<{ assets: LibraryAsset[]; categories: string[]; folders: MediaFolder[] }> {
    const qs = new URLSearchParams();
    if (params.projectId) qs.set("projectId", params.projectId);
    if (params.category) qs.set("category", params.category);
    if (params.q) qs.set("q", params.q);
    if (params.folderId) qs.set("folderId", params.folderId);
    if (params.sort) qs.set("sort", params.sort);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return apiRequest(`/media-library${suffix}`);
  },
  patchMeta(body: {
    assetRef: string;
    category?: string;
    tags?: string[];
    folderId?: string | null;
    licenseName?: string;
    attributionText?: string;
  }): Promise<{ asset: LibraryAsset }> {
    return apiRequest("/media-library/meta", { method: "PATCH", body: JSON.stringify(body) });
  },
  deleteItem(assetRef: string, force = false): Promise<{ ok: boolean; removedTimelineItems: boolean }> {
    const qs = `assetRef=${encodeURIComponent(assetRef)}${force ? "&force=true" : ""}`;
    return apiRequest(`/media-library/item?${qs}`, { method: "DELETE" });
  },
  listFolders(): Promise<{ folders: MediaFolder[] }> {
    return apiRequest("/media-library/folders");
  },
  createFolder(name: string): Promise<{ folder: MediaFolder }> {
    return apiRequest("/media-library/folders", { method: "POST", body: JSON.stringify({ name }) });
  },
  deleteFolder(id: string): Promise<{ ok: boolean }> {
    return apiRequest(`/media-library/folders/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  // -- presets (spec §12) --
  listPresets(): Promise<{ presets: EffectPreset[]; backgroundProviderConfigured: boolean }> {
    return apiRequest("/phase8/presets");
  },
  createPreset(body: {
    name: string;
    kind: EffectPreset["kind"];
    settings: Record<string, unknown>;
    basedOn?: string | null;
  }): Promise<{ preset: EffectPreset }> {
    return apiRequest("/phase8/presets", { method: "POST", body: JSON.stringify(body) });
  },
  updatePreset(
    id: string,
    body: { name?: string; kind?: EffectPreset["kind"]; settings?: Record<string, unknown> },
  ): Promise<{ preset: EffectPreset }> {
    return apiRequest(`/phase8/presets/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  },
  deletePreset(id: string): Promise<{ ok: boolean }> {
    return apiRequest(`/phase8/presets/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
  duplicatePreset(id: string, name?: string): Promise<{ preset: EffectPreset }> {
    return apiRequest(`/phase8/presets/${encodeURIComponent(id)}/duplicate`, {
      method: "POST",
      body: JSON.stringify(name ? { name } : {}),
    });
  },
};
