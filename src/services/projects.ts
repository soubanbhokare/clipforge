// Typed client for the Phase 3 Studio API (server: /api/projects,
// /api/upload-sessions, /api/source-assets, /api/youtube).
//
// Same rules as the auth client: session rides on the HttpOnly cookie,
// mutations carry the CSRF double-submit header, and nothing is ever
// stored in web storage. File uploads use XMLHttpRequest because fetch
// cannot report upload progress; the server still confirms success —
// the client never claims an upload worked before the server says so.

import { API_BASE_URL } from "./api";
import { apiRequest, AuthApiError, fetchCsrfToken } from "./auth";
import type { Phase8Job } from "./phase8";

export type WorkflowType = "LONG_VIDEO_TO_SHORTS" | "SHORT_VIDEO_ENHANCEMENT";

export type ProjectStatus =
  | "DRAFT"
  | "VALIDATING"
  | "UPLOAD_PENDING"
  | "UPLOADING"
  | "UPLOADED"
  | "METADATA_EXTRACTION"
  | "READY_FOR_ANALYSIS"
  | "REQUIRES_AUTHORIZATION"
  | "REQUIRES_SOURCE_FILE"
  | "FAILED"
  | "CANCELLED";

export interface SourceAsset {
  id: string;
  projectId: string;
  sourceType: "UPLOAD" | "YOUTUBE_URL" | "URL_IMPORT";
  originalFilename: string;
  sourceUrl: string | null;
  externalId: string | null;
  storageProvider: string;
  fileSize: number | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  hasAudio: boolean | null;
  container: string | null;
  bitrate: number | null;
  validationStatus: string;
  validationError: string | null;
  hasThumbnail: boolean;
  createdAt: string;
}

export interface Project {
  id: string;
  name: string;
  workflowType: WorkflowType;
  status: ProjectStatus;
  settings: Record<string, unknown>;
  aiInstruction: string | null;
  createdAt: string;
  updatedAt: string;
  sourceAsset: SourceAsset | null;
}

export interface UploadSession {
  id: string;
  projectId: string;
  sourceAssetId: string | null;
  status: string;
  bytesUploaded: number;
  totalBytes: number;
  expiresAt: string;
  createdAt: string;
}

export interface StudioConfig {
  maxUploadMb: number;
  maxUploadBytes: number;
  allowedExtensions: string[];
  storageProvider: string;
  youtubeConfigured: boolean;
  cloudImportConfigured: boolean;
  /** URL import (yt-dlp): enabled exactly when the server can
   *  resolve the downloader; `detail` is the honest explanation the
   *  UI shows when it cannot. */
  urlImport: { enabled: boolean; detail: string };
}

export interface YouTubeValidation {
  urlValid: boolean;
  videoId: string;
  canonicalUrl: string;
  metadataAvailable: boolean;
  metadata: {
    title: string | null;
    channelTitle: string | null;
    durationIso: string | null;
    thumbnailUrl: string | null;
  } | null;
  metadataNote: string;
  authorizationVerified: boolean;
  mediaAvailable: boolean;
  imported: boolean;
  message: string;
}

export interface ProjectListResult {
  projects: Project[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ListProjectsParams {
  search?: string;
  workflow?: string;
  status?: string;
  sort?: "newest" | "oldest" | "name" | "name-desc" | "updated";
  page?: number;
  pageSize?: number;
}

let idempotencyCounter = 0;
function newIdempotencyKey(): string {
  idempotencyCounter += 1;
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${idempotencyCounter}`;
  return `project-${random}`;
}

export const projectsApi = {
  getStudioConfig(): Promise<StudioConfig> {
    return apiRequest<StudioConfig>("/studio/config");
  },

  listProjects(params: ListProjectsParams = {}): Promise<ProjectListResult> {
    const query = new URLSearchParams();
    if (params.search) query.set("search", params.search);
    if (params.workflow) query.set("workflow", params.workflow);
    if (params.status) query.set("status", params.status);
    if (params.sort) query.set("sort", params.sort);
    if (params.page) query.set("page", String(params.page));
    if (params.pageSize) query.set("pageSize", String(params.pageSize));
    const qs = query.toString();
    return apiRequest<ProjectListResult>(`/projects${qs ? `?${qs}` : ""}`);
  },

  getProject(id: string): Promise<{ project: Project }> {
    return apiRequest<{ project: Project }>(`/projects/${encodeURIComponent(id)}`);
  },

  createProject(input: {
    name?: string;
    workflowType: WorkflowType;
    sourceType?: "UPLOAD" | "YOUTUBE_URL";
    youtube?: { url: string; videoId: string };
    /** Reuse one key across a double-click/retry to avoid duplicates. */
    idempotencyKey?: string;
  }): Promise<{ project: Project }> {
    const { idempotencyKey, ...body } = input;
    return apiRequest<{ project: Project }>("/projects", {
      method: "POST",
      body,
      headers: { "Idempotency-Key": idempotencyKey ?? newIdempotencyKey() },
    });
  },

  updateProject(
    id: string,
    patch: { name?: string; settings?: Record<string, unknown>; aiInstruction?: string | null },
  ): Promise<{ project: Project }> {
    return apiRequest<{ project: Project }>(`/projects/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: patch,
    });
  },

  deleteProject(id: string): Promise<{ ok: true }> {
    return apiRequest<{ ok: true }>(`/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  removeSource(projectId: string): Promise<{ ok: true }> {
    return apiRequest<{ ok: true }>(`/projects/${encodeURIComponent(projectId)}/source`, {
      method: "DELETE",
    });
  },

  /** Import a video from a pasted URL (YouTube or any yt-dlp
   *  supported page, or a direct media link). The server queues a
   *  URL_IMPORT job — poll it via phase8Api.getJob; on completion the
   *  project source asset is the imported, server-verified video.
   *  When the downloader is unavailable the server answers 422
   *  CONFIGURATION_ERROR (and still returns the persisted FAILED
   *  job), which apiRequest surfaces as an AuthApiError. */
  createUrlImport(
    projectId: string,
    url: string,
  ): Promise<{ job: Phase8Job; asset: SourceAsset | null; deduplicated: boolean }> {
    return apiRequest(`/projects/${encodeURIComponent(projectId)}/url-import`, {
      method: "POST",
      body: { url },
    });
  },

  createUploadSession(
    projectId: string,
    filename: string,
    size: number,
  ): Promise<{ session: UploadSession; asset: SourceAsset }> {
    return apiRequest(`/projects/${encodeURIComponent(projectId)}/upload-session`, {
      method: "POST",
      body: { filename, size },
    });
  },

  getUploadSession(id: string): Promise<{ session: UploadSession }> {
    return apiRequest<{ session: UploadSession }>(`/upload-sessions/${encodeURIComponent(id)}`);
  },

  cancelUploadSession(id: string): Promise<{ ok: true }> {
    return apiRequest<{ ok: true }>(`/upload-sessions/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      body: {},
    });
  },

  validateYouTube(url: string): Promise<YouTubeValidation> {
    return apiRequest<YouTubeValidation>("/youtube/validate", {
      method: "POST",
      body: { url },
    });
  },

  thumbnailUrl(assetId: string): string {
    return `${API_BASE_URL}/source-assets/${encodeURIComponent(assetId)}/thumbnail`;
  },

  streamUrl(assetId: string): string {
    return `${API_BASE_URL}/source-assets/${encodeURIComponent(assetId)}/stream`;
  },
};

// ---- File upload with real progress (XMLHttpRequest) ----------------------

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

export interface UploadHandle {
  promise: Promise<{ asset: SourceAsset; project: Project }>;
  abort: () => void;
}

export class UploadCancelledError extends Error {
  constructor() {
    super("Upload cancelled.");
    this.name = "UploadCancelledError";
  }
}

export function uploadFile(
  sessionId: string,
  file: File,
  onProgress?: (percent: number) => void,
): UploadHandle {
  let xhr: XMLHttpRequest | null = null;
  const promise = (async () => {
    const csrf = await fetchCsrfToken();
    return new Promise<{ asset: SourceAsset; project: Project }>((resolve, reject) => {
      xhr = new XMLHttpRequest();
      const form = new FormData();
      form.append("file", file);
      xhr.open("POST", `${API_BASE_URL}/upload-sessions/${encodeURIComponent(sessionId)}/file`);
      xhr.withCredentials = true;
      xhr.setRequestHeader("X-CSRF-Token", csrf);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && onProgress) {
          onProgress(Math.round((event.loaded / event.total) * 100));
        }
      };
      xhr.onload = () => {
        let data: Record<string, unknown> = {};
        try {
          data = JSON.parse(xhr?.responseText ?? "{}") as Record<string, unknown>;
        } catch {
          data = {};
        }
        if (xhr && xhr.status >= 200 && xhr.status < 300) {
          resolve(data as unknown as { asset: SourceAsset; project: Project });
          return;
        }
        reject(uploadApiError(xhr?.status ?? 0, data));
      };
      xhr.onerror = () =>
        reject(new AuthApiError("network", 0, "Cannot reach the server. Check your connection, then retry the upload."));
      xhr.onabort = () => reject(new UploadCancelledError());
      xhr.send(form);
    });
  })();
  return {
    promise,
    abort: () => {
      xhr?.abort();
    },
  };
}

// ---- Display helpers ---------------------------------------------------------

export const WORKFLOW_LABELS: Record<WorkflowType, string> = {
  LONG_VIDEO_TO_SHORTS: "Multiple Shorts",
  SHORT_VIDEO_ENHANCEMENT: "Enhance Video",
};

export const STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft — source needed",
  VALIDATING: "Validating",
  UPLOAD_PENDING: "Upload pending",
  UPLOADING: "Uploading",
  UPLOADED: "Uploaded",
  METADATA_EXTRACTION: "Reading metadata",
  READY_FOR_ANALYSIS: "Ready for analysis",
  REQUIRES_AUTHORIZATION: "Authorization required",
  REQUIRES_SOURCE_FILE: "Source file required",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
};

export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
