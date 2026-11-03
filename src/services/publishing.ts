// Typed client for the Phase 10 Publishing API (server:
// src/publishing.ts + src/providers.ts).
//
// Wire-shape contract (the Phase 8 lesson): the metadata interfaces
// below mirror the server's Zod schemas in server/src/publishing.ts
// FIELD FOR FIELD, and the publishing e2e suite posts these exact
// default objects to prove the panel's shape is accepted.
//
// Honesty rules mirrored from the server:
//  - A provider is either configured (OAuth credentials present on
//    the server) or it is not — the UI shows the missing variable
//    NAMES, and clicking Connect surfaces the server's
//    CONFIGURATION_ERROR naming them. No sample accounts exist.
//  - A job is PUBLISHED only when the platform's own status said so;
//    post IDs/URLs come from platform responses, never invented.
//  - Metrics distinguish "unavailable" (null) from a measured zero.

import { API_BASE_URL } from "./api";
import { apiRequest, fetchCsrfToken } from "./auth";

export type Platform = "youtube" | "instagram" | "tiktok";

export type PublishJobStatus =
  | "DRAFT" | "AWAITING_APPROVAL" | "VALIDATING" | "SCHEDULED" | "QUEUED"
  | "UPLOADING" | "SUBMITTED" | "PLATFORM_PROCESSING" | "PUBLISHED"
  | "FAILED" | "CANCELLED" | "AUTH_REQUIRED";

export interface ProviderStatus {
  platform: Platform;
  implemented: boolean;
  configured: boolean;
  missing: string[];
  scopes: string[];
  usesPkce: boolean;
}

/** User-editable publishing defaults. Field names deliberately mirror
 *  the per-platform metadata fields they seed (YoutubeMetadata.privacy,
 *  InstagramMetadata.shareToFeed, TiktokMetadata.privacyLevel). Every
 *  field is optional: PUT /publishing/settings accepts partial
 *  defaults, and GET may omit `defaults` entirely until some are
 *  saved. These are STARTING values for new drafts only — per-post
 *  validation still enforces the live platform limits (e.g. TikTok
 *  creator info) before anything is submitted. */
export interface PublishingDefaults {
  timezone?: string;
  youtube?: { privacy?: YoutubeMetadata["privacy"] };
  instagram?: { shareToFeed?: boolean };
  tiktok?: { privacyLevel?: string };
}

export interface PublishingSettings {
  providers: { platform: Platform; configured: boolean; present: string[]; missing: string[] }[];
  tokenEncryption: { mode: "env" | "dev-file"; ready: boolean };
  publicAppUrl: string;
  databaseNote: string;
  defaults?: PublishingDefaults;
}

export interface PlatformAccount {
  id: string;
  platform: Platform;
  platformAccountId: string;
  username: string | null;
  displayName: string | null;
  profileImageUrl: string | null;
  accountType: string | null;
  status: "CONNECTED" | "AUTH_REQUIRED" | "DISCONNECTED";
  grantedScopes: string[];
  tokenExpiresAt: string | null;
  lastSyncedAt: string | null;
  providerConfigured: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---- per-platform metadata (mirrors server/src/publishing.ts) ---------------

export interface YoutubeMetadata {
  title: string;
  description: string;
  tags: string[];
  categoryId: string;
  privacy: "public" | "private" | "unlisted";
  madeForKids: boolean;
  containsSyntheticMedia: boolean;
  paidPromotion: boolean;
}

export interface InstagramMetadata {
  caption: string;
  hashtags: string[];
  shareToFeed: boolean;
  thumbOffsetMs: number | null;
  paidPromotion: boolean;
}

export interface TiktokMetadata {
  caption: string;
  privacyLevel: string;
  disableComment: boolean;
  disableDuet: boolean;
  disableStitch: boolean;
  brandedContent: boolean;
  brandOrganic: boolean;
  creatorConsent: boolean;
  containsSyntheticMedia: boolean;
  videoCoverTimestampMs: number | null;
}

export type PlatformMetadata = YoutubeMetadata | InstagramMetadata | TiktokMetadata;

export const DEFAULT_YOUTUBE_METADATA: YoutubeMetadata = {
  title: "",
  description: "",
  tags: [],
  categoryId: "22",
  privacy: "private",
  madeForKids: false,
  containsSyntheticMedia: false,
  paidPromotion: false,
};

export const DEFAULT_INSTAGRAM_METADATA: InstagramMetadata = {
  caption: "",
  hashtags: [],
  shareToFeed: true,
  thumbOffsetMs: null,
  paidPromotion: false,
};

export const DEFAULT_TIKTOK_METADATA: TiktokMetadata = {
  caption: "",
  privacyLevel: "",
  disableComment: false,
  disableDuet: false,
  disableStitch: false,
  brandedContent: false,
  brandOrganic: false,
  creatorConsent: false,
  containsSyntheticMedia: false,
  videoCoverTimestampMs: null,
};

export function defaultMetadataFor(platform: Platform): PlatformMetadata {
  if (platform === "youtube") return { ...DEFAULT_YOUTUBE_METADATA };
  if (platform === "instagram") return { ...DEFAULT_INSTAGRAM_METADATA };
  return { ...DEFAULT_TIKTOK_METADATA };
}

// ---- jobs -------------------------------------------------------------------

export interface PublishJobExport {
  id: string;
  filename: string;
  format: string;
  width: number | null;
  height: number | null;
  duration: number | null;
  fileSize: number | null;
  downloadPath: string;
}

export interface PublishJob {
  id: string;
  projectId: string;
  clipId: string | null;
  exportOutputId: string;
  export: PublishJobExport | null;
  accountId: string;
  accountUsername: string | null;
  accountDisplayName: string | null;
  platform: Platform;
  status: PublishJobStatus;
  schedulingMode: "platform" | "clipforge" | null;
  schedulingLabel: string | null;
  approvedAt: string | null;
  rightsConfirmedAt: string | null;
  submittedAt: string | null;
  publishedAt: string | null;
  platformPostId: string | null;
  publishedUrl: string | null;
  platformPost: { postId: string; url: string | null; status: string } | null;
  error: string | null;
  errorCode: string | null;
  errorClass: "transient" | "user_intervention" | "permanent" | "ambiguous" | null;
  retryCount: number;
  nextRetryAt: string | null;
  ambiguous: boolean;
  metadata: PlatformMetadata;
  hasCustomThumbnail: boolean;
  schedule: { id: string; scheduledForUtc: string; timezone: string; status: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface ValidationCheck {
  id: string;
  label: string;
  ok: boolean;
  severity: "error" | "warning";
  detail: string;
}

export interface ValidationResult {
  ok: boolean;
  checks: ValidationCheck[];
  createdAt: string;
}

export interface PublishAttempt {
  id: string;
  attemptNo: number;
  kind: string;
  status: string;
  providerRequestId: string | null;
  providerResponse: unknown;
  error: string | null;
  createdAt: string;
}

export interface CalendarEvent {
  id: string;
  kind: "scheduled" | "published" | "failed" | "draft" | "cancelled";
  jobId: string;
  platform: Platform;
  accountId: string;
  projectId: string;
  atUtc: string;
  timezone: string;
  status: PublishJobStatus;
  title: string;
}

export interface MetricsResponse {
  metricsStatus: "unavailable" | "ok" | "error";
  metrics: { views: number | null; likes: number | null; comments: number | null; shares: number | null } | null;
  metricSource?: string | null;
  lastSyncedAt?: string | null;
  note?: string;
}

export interface AccountCapabilities {
  capabilities: Record<string, unknown> | null;
  fetchedAt: string | null;
  live: boolean;
}

// ---- API ----------------------------------------------------------------------

async function uploadForm<T>(url: string, form: FormData): Promise<T> {
  const csrf = await fetchCsrfToken();
  const res = await fetch(url, {
    method: "POST",
    headers: { "X-CSRF-Token": csrf },
    credentials: "include",
    body: form,
  });
  const data = (await res.json().catch(() => null)) as (T & { error?: { message?: string } | string }) | null;
  if (!res.ok || !data) {
    const msg = typeof data?.error === "string" ? data.error : data?.error?.message;
    throw new Error(msg ?? `Request failed (${res.status}).`);
  }
  return data;
}

export const publishingApi = {
  providers(): Promise<{ providers: ProviderStatus[] }> {
    return apiRequest("/publishing/providers");
  },
  settings(): Promise<PublishingSettings> {
    return apiRequest("/publishing/settings");
  },
  updateSettings(body: { defaults: PublishingDefaults }): Promise<PublishingSettings> {
    return apiRequest("/publishing/settings", { method: "PUT", body });
  },
  accounts(): Promise<{ accounts: PlatformAccount[] }> {
    return apiRequest("/publishing/accounts");
  },
  connect(platform: Platform): Promise<{ authUrl: string; connectionId: string; expiresAt: string }> {
    return apiRequest(`/publishing/accounts/${platform}/connect`, { method: "POST", body: {} });
  },
  disconnect(accountId: string): Promise<void> {
    return apiRequest(`/publishing/accounts/${encodeURIComponent(accountId)}?confirm=true`, { method: "DELETE" });
  },
  refreshAccount(accountId: string): Promise<{ account: PlatformAccount }> {
    return apiRequest(`/publishing/accounts/${encodeURIComponent(accountId)}/refresh`, { method: "POST", body: {} });
  },
  capabilities(accountId: string, fresh = false): Promise<AccountCapabilities> {
    return apiRequest(`/publishing/accounts/${encodeURIComponent(accountId)}/capabilities${fresh ? "?fresh=1" : ""}`);
  },

  createJob(
    body: { exportOutputId: string; accountId: string; clipId?: string; metadata: PlatformMetadata },
    idempotencyKey?: string,
  ): Promise<{ job: PublishJob; deduplicated?: boolean }> {
    return apiRequest("/publishing/jobs", {
      method: "POST",
      body,
      headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
    });
  },
  job(jobId: string): Promise<{ job: PublishJob; validation: ValidationResult | null }> {
    return apiRequest(`/publishing/jobs/${encodeURIComponent(jobId)}`);
  },
  updateMetadata(jobId: string, metadata: PlatformMetadata): Promise<{ job: PublishJob }> {
    return apiRequest(`/publishing/jobs/${encodeURIComponent(jobId)}/metadata`, {
      method: "PUT",
      body: { metadata },
    });
  },
  deleteJob(jobId: string): Promise<void> {
    return apiRequest(`/publishing/jobs/${encodeURIComponent(jobId)}?confirm=true`, { method: "DELETE" });
  },
  uploadThumbnail(jobId: string, file: File): Promise<{ job: PublishJob }> {
    const form = new FormData();
    form.append("file", file);
    return uploadForm(`${API_BASE_URL}/publishing/jobs/${encodeURIComponent(jobId)}/thumbnail`, form);
  },
  removeThumbnail(jobId: string): Promise<{ job: PublishJob }> {
    return apiRequest(`/publishing/jobs/${encodeURIComponent(jobId)}/thumbnail`, { method: "DELETE" });
  },
  validate(jobId: string): Promise<{ ok: boolean; checks: ValidationCheck[]; job: PublishJob }> {
    return apiRequest(`/publishing/jobs/${encodeURIComponent(jobId)}/validate`, { method: "POST", body: {} });
  },
  preview(jobId: string): Promise<{
    job: PublishJob;
    account: PlatformAccount | null;
    validation: ValidationResult | null;
    capabilities: Record<string, unknown> | null;
  }> {
    return apiRequest(`/publishing/jobs/${encodeURIComponent(jobId)}/preview`);
  },
  approve(jobId: string, rightsConfirmed: boolean): Promise<{ job: PublishJob }> {
    return apiRequest(`/publishing/jobs/${encodeURIComponent(jobId)}/approve`, {
      method: "POST",
      body: { rightsConfirmed },
    });
  },
  submit(jobId: string): Promise<{ job: PublishJob }> {
    return apiRequest(`/publishing/jobs/${encodeURIComponent(jobId)}/submit`, { method: "POST", body: {} });
  },
  schedule(
    jobId: string,
    body: { scheduledForUtc?: string; scheduledForLocal?: string; timezone?: string },
  ): Promise<{ job: PublishJob }> {
    return apiRequest(`/publishing/jobs/${encodeURIComponent(jobId)}/schedule`, { method: "POST", body });
  },
  moveSchedule(
    scheduleId: string,
    body: { scheduledForUtc?: string; scheduledForLocal?: string; timezone?: string },
  ): Promise<{ job: PublishJob }> {
    return apiRequest(`/publishing/schedules/${encodeURIComponent(scheduleId)}`, { method: "PATCH", body });
  },
  cancelSchedule(jobId: string): Promise<{ job: PublishJob }> {
    return apiRequest(`/publishing/jobs/${encodeURIComponent(jobId)}/cancel-schedule`, { method: "POST", body: {} });
  },
  cancel(jobId: string): Promise<{ job: PublishJob }> {
    return apiRequest(`/publishing/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST", body: {} });
  },
  retry(jobId: string, confirmAmbiguousRetry = false): Promise<{ job: PublishJob; reconciled?: boolean }> {
    return apiRequest(`/publishing/jobs/${encodeURIComponent(jobId)}/retry`, {
      method: "POST",
      body: confirmAmbiguousRetry ? { confirmAmbiguousRetry: true } : {},
    });
  },
  statusCheck(jobId: string): Promise<{ job: PublishJob }> {
    return apiRequest(`/publishing/jobs/${encodeURIComponent(jobId)}/status-check`, { method: "POST", body: {} });
  },
  queue(params: { status?: string; platform?: string; accountId?: string; projectId?: string } = {}): Promise<{
    jobs: PublishJob[];
    counts: Record<string, number>;
  }> {
    const q = new URLSearchParams();
    if (params.status) q.set("status", params.status);
    if (params.platform) q.set("platform", params.platform);
    if (params.accountId) q.set("accountId", params.accountId);
    if (params.projectId) q.set("projectId", params.projectId);
    const suffix = q.toString() ? `?${q.toString()}` : "";
    return apiRequest(`/publishing/queue${suffix}`);
  },
  calendar(params: { from: string; to: string; platform?: string; accountId?: string; projectId?: string }): Promise<{
    events: CalendarEvent[];
  }> {
    const q = new URLSearchParams({ from: params.from, to: params.to });
    if (params.platform) q.set("platform", params.platform);
    if (params.accountId) q.set("accountId", params.accountId);
    if (params.projectId) q.set("projectId", params.projectId);
    return apiRequest(`/publishing/calendar?${q.toString()}`);
  },
  history(): Promise<{ jobs: PublishJob[] }> {
    return apiRequest("/publishing/history");
  },
  attempts(jobId: string): Promise<{ attempts: PublishAttempt[] }> {
    return apiRequest(`/publishing/jobs/${encodeURIComponent(jobId)}/attempts`);
  },
  metrics(jobId: string): Promise<MetricsResponse> {
    return apiRequest(`/publishing/jobs/${encodeURIComponent(jobId)}/metrics`);
  },
  syncMetrics(jobId: string): Promise<MetricsResponse> {
    return apiRequest(`/publishing/jobs/${encodeURIComponent(jobId)}/metrics/sync`, { method: "POST", body: {} });
  },
};

/** Absolute URL for the approval-screen video preview (the Phase 9
 *  owner-checked export download endpoint). */
export function exportDownloadUrl(downloadPath: string): string {
  return `${API_BASE_URL}${downloadPath.replace(/^\/api/, "")}`;
}
