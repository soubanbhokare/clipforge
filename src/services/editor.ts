// Typed client for the Phase 5 editor API (server: /api/projects/:id/
// editor, /api/editor/:docId/*, /api/projects/:id/media,
// /api/project-media/:id, /api/render-jobs/:id).
//
// The editing document is SERVER state: every mutation is posted as an
// operation and the returned document replaces the local copy, so the
// save indicator reflects real request results and a refresh always
// recovers the current document from the server. Nothing is stored in
// web storage.

import { API_BASE_URL } from "./api";
import { apiRequest, AuthApiError, fetchCsrfToken } from "./auth";
import { analysisApi } from "./analysis";
import { projectsApi } from "./projects";
import type { CaptionStyleConfig } from "./captions";

export { AuthApiError };

export type TrackKind = "main" | "broll" | "caption" | "captions" | "audio" | "overlay";
export type AssetKind = "source" | "candidate" | "media";
export type FitMode = "fit" | "fill";

export interface ItemTransform {
  crop: { x: number; y: number; w: number; h: number } | null;
  x: number;
  y: number;
  scale: number;
  zoom: number;
  rotation: number;
  fit: FitMode;
  /** Phase 8: overlay/B-roll opacity (0.05–1). Applied by the
   *  compose graph for broll/overlay items; absent = fully opaque. */
  opacity?: number;
}

export interface TimelineTrack {
  id: string;
  kind: TrackKind;
  label: string;
  order: number;
  locked: boolean;
  visible: boolean;
  muted: boolean;
  solo: boolean;
}

export interface TimelineItem {
  id: string;
  trackId: string;
  assetKind: AssetKind;
  assetId: string;
  start: number;
  duration: number;
  sourceIn: number;
  sourceOut: number;
  transform: ItemTransform;
  speed: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  layerOrder: number;
}

export interface CaptionWord {
  start: number;
  end: number;
  word: string;
  probability: number | null;
  /** Phase 6: user-marked keyword emphasis. */
  emphasized?: boolean;
}

export interface CaptionSegment {
  id: string;
  start: number;
  end: number;
  text: string;
  words: CaptionWord[] | null;
  /** Phase 6: per-segment style override (null = document style). */
  style: CaptionStyleConfig | null;
  /** Phase 6: caption-track language this segment belongs to. */
  language: string;
}

export interface SceneOverride {
  id: string;
  topicSegmentId: string | null;
  rangeStart: number;
  rangeEnd: number;
  overrides: {
    crop?: ItemTransform["crop"];
    x?: number;
    y?: number;
    scale?: number;
    zoom?: number;
    rotation?: number;
    fit?: "fit" | "fill";
  };
}

export interface EditorCanvas {
  aspect: string;
  width: number;
  height: number;
  custom: boolean;
}

export interface EditorSettings {
  backgroundFill: "blur" | "solid";
  showCaptions: boolean;
  snapEnabled?: boolean;
  showGuides: boolean;
  safeZones: boolean;
  /** Centre guide lines; absent on legacy docs = follows showGuides. */
  centerGuides?: boolean;
  /** Phase 6: Caption Studio document style + provenance. */
  captionStyle: CaptionStyleConfig;
  captionTemplateId: string | null;
  brandKitId: string | null;
}

export interface EditorState {
  canvas: EditorCanvas;
  settings: EditorSettings;
  tracks: TimelineTrack[];
  items: TimelineItem[];
  captions: CaptionSegment[];
  sceneOverrides: SceneOverride[];
}

export interface EditorDocument extends EditorState {
  id: string;
  projectId: string;
  baseCandidateId: string | null;
  undoCursor: number;
  opCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface LibraryAsset {
  id: string;
  filename: string;
  duration: number | null;
  hasAudio: boolean;
  hasVideo: boolean;
  width: number | null;
  height: number | null;
}

export interface LibraryCandidate {
  id: string;
  title: string;
  startSec: number;
  endSec: number;
  duration: number;
  previewStatus: string;
  sourceAssetId: string;
}

export interface LibraryTopic {
  id: string;
  label: string;
  startSec: number;
  endSec: number;
}

export interface ProjectMediaAsset {
  id: string;
  filename: string;
  kind: "VIDEO" | "AUDIO";
  duration: number | null;
  hasAudio: boolean;
  hasVideo: boolean;
  width: number | null;
  height: number | null;
}

export interface EditorLibrary {
  sourceAsset: (LibraryAsset & { id: string }) | null;
  candidates: LibraryCandidate[];
  media: ProjectMediaAsset[];
  topics: LibraryTopic[];
  transcriptSourceAssetId: string | null;
}

export interface EditorResponse {
  document: EditorDocument;
  library: EditorLibrary;
}

export interface ProjectVersion {
  id: string;
  name: string;
  createdAt: string;
}

export type RenderJobStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";

export interface RenderJob {
  id: string;
  documentId: string;
  projectId: string;
  status: RenderJobStatus;
  stage: string;
  error: string | null;
  settings: {
    canvas: EditorCanvas | null;
    backgroundFill: string | null;
    showCaptions: boolean | null;
    timelineDuration: number | null;
  };
  hasOutput: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export const RENDER_ACTIVE: RenderJobStatus[] = ["QUEUED", "RUNNING"];

export const DEFAULT_TRANSFORM: ItemTransform = {
  crop: null,
  x: 0,
  y: 0,
  scale: 1,
  zoom: 1,
  rotation: 0,
  fit: "fill",
};

/** The editable state slice of a document (what operations post back). */
export function stateOf(doc: EditorDocument): EditorState {
  return structuredClone({
    canvas: doc.canvas,
    settings: doc.settings,
    tracks: doc.tracks,
    items: doc.items,
    captions: doc.captions,
    sceneOverrides: doc.sceneOverrides,
  });
}

export function timelineDuration(doc: EditorState): number {
  let end = 0;
  for (const item of doc.items) end = Math.max(end, item.start + item.duration);
  for (const caption of doc.captions) end = Math.max(end, caption.end);
  return end;
}

/** Build the AuthApiError for a failed upload response, parsing BOTH
 *  server error shapes exactly like request() in services/auth.ts:
 *  the { error: "…" } string form and the { error: { code, message } }
 *  object form (plus a top-level `code`), classified the same way. */
function uploadApiError(status: number, data: Record<string, unknown>): AuthApiError {
  const errObj = data.error as { code?: unknown; message?: unknown } | string | undefined;
  const message =
    typeof errObj === "string"
      ? errObj
      : errObj && typeof errObj === "object" && typeof errObj.message === "string"
        ? errObj.message
        : "Something went wrong.";
  const code =
    typeof data.code === "string"
      ? data.code
      : errObj && typeof errObj === "object" && typeof errObj.code === "string"
        ? errObj.code
        : undefined;
  if (status === 400 || status === 409 || status === 403 || status === 429) {
    return new AuthApiError("validation", status, message, code);
  }
  if (status === 401) {
    return new AuthApiError("credentials", status, message, code);
  }
  return new AuthApiError("server", status, message, code);
}

export const editorApi = {
  getDocument(projectId: string, seedCandidateId?: string | null): Promise<EditorResponse> {
    const query = seedCandidateId ? `?seedCandidateId=${encodeURIComponent(seedCandidateId)}` : "";
    return apiRequest<EditorResponse>(`/projects/${encodeURIComponent(projectId)}/editor${query}`);
  },

  applyOperation(
    docId: string,
    type: string,
    state: EditorState,
    baseCursor?: number,
  ): Promise<{ document: EditorDocument }> {
    return apiRequest<{ document: EditorDocument }>(`/editor/${encodeURIComponent(docId)}/operations`, {
      method: "POST",
      // operationId lets the server dedupe a retried request;
      // baseCursor is the undoCursor this state was based on, so the
      // server can reject (409) an edit built on a stale document.
      body: { type, state, operationId: crypto.randomUUID(), baseCursor },
    });
  },

  undo(docId: string): Promise<{ document: EditorDocument }> {
    return apiRequest<{ document: EditorDocument }>(`/editor/${encodeURIComponent(docId)}/undo`, {
      method: "POST",
      body: {},
    });
  },

  redo(docId: string): Promise<{ document: EditorDocument }> {
    return apiRequest<{ document: EditorDocument }>(`/editor/${encodeURIComponent(docId)}/redo`, {
      method: "POST",
      body: {},
    });
  },

  patchSettings(
    docId: string,
    patch: { canvas?: EditorCanvas; settings?: Partial<EditorSettings> },
  ): Promise<{ document: EditorDocument }> {
    return apiRequest<{ document: EditorDocument }>(`/editor/${encodeURIComponent(docId)}/settings`, {
      method: "PATCH",
      body: patch,
    });
  },

  listVersions(docId: string): Promise<{ versions: ProjectVersion[] }> {
    return apiRequest<{ versions: ProjectVersion[] }>(`/editor/${encodeURIComponent(docId)}/versions`);
  },

  createVersion(docId: string, name: string): Promise<{ version: ProjectVersion }> {
    return apiRequest<{ version: ProjectVersion }>(`/editor/${encodeURIComponent(docId)}/versions`, {
      method: "POST",
      body: { name },
    });
  },

  restoreVersion(docId: string, versionId: string): Promise<{ document: EditorDocument }> {
    return apiRequest<{ document: EditorDocument }>(
      `/editor/${encodeURIComponent(docId)}/versions/${encodeURIComponent(versionId)}/restore`,
      { method: "POST", body: {} },
    );
  },

  startRender(docId: string): Promise<{ job: RenderJob }> {
    return apiRequest<{ job: RenderJob }>(`/editor/${encodeURIComponent(docId)}/render`, {
      method: "POST",
      body: {},
    });
  },

  listRenders(docId: string): Promise<{ jobs: RenderJob[] }> {
    return apiRequest<{ jobs: RenderJob[] }>(`/editor/${encodeURIComponent(docId)}/renders`);
  },

  getRender(jobId: string): Promise<{ job: RenderJob }> {
    return apiRequest<{ job: RenderJob }>(`/render-jobs/${encodeURIComponent(jobId)}`);
  },

  cancelRender(jobId: string): Promise<{ job: RenderJob }> {
    return apiRequest<{ job: RenderJob }>(`/render-jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: "POST",
      body: {},
    });
  },

  renderDownloadUrl(jobId: string): string {
    return `${API_BASE_URL}/render-jobs/${encodeURIComponent(jobId)}/download`;
  },

  mediaStreamUrl(mediaId: string): string {
    return `${API_BASE_URL}/project-media/${encodeURIComponent(mediaId)}/stream`;
  },

  /** Upload an audio/video file as a project asset (real XHR progress). */
  uploadMedia(
    projectId: string,
    file: File,
    onProgress?: (fraction: number) => void,
  ): Promise<{ media: ProjectMediaAsset }> {
    return new Promise((resolve, reject) => {
      void (async () => {
        let csrf: string;
        try {
          csrf = await fetchCsrfToken();
        } catch (err) {
          reject(err instanceof Error ? err : new Error("Could not prepare the upload."));
          return;
        }
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `${API_BASE_URL}/projects/${encodeURIComponent(projectId)}/media`);
        xhr.withCredentials = true;
        xhr.setRequestHeader("X-CSRF-Token", csrf);
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
        };
        xhr.onload = () => {
          let data: Record<string, unknown> = {};
          try {
            data = JSON.parse(xhr.responseText) as Record<string, unknown>;
          } catch {
            data = {};
          }
          const media = (data as { media?: ProjectMediaAsset }).media;
          if (xhr.status >= 200 && xhr.status < 300 && media) {
            resolve({ media });
          } else {
            reject(uploadApiError(xhr.status, data));
          }
        };
        xhr.onerror = () =>
          reject(
            new AuthApiError(
              "network",
              0,
              "Cannot reach the server. Check that the CLIPFORGE server is running, then try again.",
            ),
          );
        const form = new FormData();
        form.append("file", file);
        xhr.send(form);
      })();
    });
  },
};

// ---- Playback resolution ------------------------------------------------------
// The preview plays the composition from EXISTING lightweight files:
// a candidate item whose range fits inside the candidate window plays
// the candidate's preview file with a file-time offset; everything
// else plays the underlying source stream. `fileTime` converts a
// position inside the item to a time inside the resolved file.

export interface ResolvedPlayback {
  url: string;
  /** File time corresponding to the item's sourceIn. */
  fileStart: number;
  hasAudio: boolean;
  hasVideo: boolean;
}

export function resolvePlayback(
  item: TimelineItem,
  library: EditorLibrary,
): ResolvedPlayback | null {
  if (item.assetKind === "candidate") {
    const candidate = library.candidates.find((c) => c.id === item.assetId);
    if (!candidate) return null;
    if (
      candidate.previewStatus === "READY" &&
      item.sourceIn >= candidate.startSec - 0.01 &&
      item.sourceOut <= candidate.endSec + 0.01
    ) {
      return {
        url: analysisApi.previewUrl(candidate.id),
        fileStart: item.sourceIn - candidate.startSec,
        hasAudio: true,
        hasVideo: true,
      };
    }
    return {
      url: projectsApi.streamUrl(candidate.sourceAssetId),
      fileStart: item.sourceIn,
      hasAudio: library.sourceAsset?.hasAudio ?? true,
      hasVideo: true,
    };
  }
  if (item.assetKind === "source") {
    if (!library.sourceAsset) return null;
    return {
      url: projectsApi.streamUrl(item.assetId),
      fileStart: item.sourceIn,
      hasAudio: library.sourceAsset.hasAudio,
      hasVideo: library.sourceAsset.hasVideo,
    };
  }
  const media = library.media.find((m) => m.id === item.assetId);
  if (!media) return null;
  return {
    url: editorApi.mediaStreamUrl(media.id),
    fileStart: item.sourceIn,
    hasAudio: media.hasAudio,
    hasVideo: media.hasVideo,
  };
}

/** Asset display metadata for library rows, badges and the inspector. */
export function assetInfo(
  item: TimelineItem,
  library: EditorLibrary,
): { label: string; hasAudio: boolean; hasVideo: boolean; sourceDuration: number | null } {
  if (item.assetKind === "candidate") {
    const candidate = library.candidates.find((c) => c.id === item.assetId);
    return {
      label: candidate?.title ?? "Generated clip",
      hasAudio: true,
      hasVideo: true,
      sourceDuration: library.sourceAsset?.duration ?? null,
    };
  }
  if (item.assetKind === "source") {
    return {
      label: library.sourceAsset?.filename ?? "Source video",
      hasAudio: library.sourceAsset?.hasAudio ?? false,
      hasVideo: library.sourceAsset?.hasVideo ?? true,
      sourceDuration: library.sourceAsset?.duration ?? null,
    };
  }
  const media = library.media.find((m) => m.id === item.assetId);
  return {
    label: media?.filename ?? "Imported media",
    hasAudio: media?.hasAudio ?? false,
    hasVideo: media?.hasVideo ?? false,
    sourceDuration: media?.duration ?? null,
  };
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(1).padStart(4, "0")}`;
}
