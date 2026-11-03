// Typed client for the Phase 11 Analytics API (server:
// src/analytics.ts + analyticsCore.ts + analyticsProviders.ts).
//
// Honesty rules mirrored from the server:
//  - A metric value of null means UNAVAILABLE (missing scope,
//    unsupported metric, no snapshot yet) — it is rendered as
//    "Unavailable", never as 0.
//  - Engagement always arrives with its exact formula text; rates
//    from different formulas or component sets are never blended.
//  - Charts are built only from saved records returned by the API.

import { apiRequest } from "./auth";

export type Platform = "youtube" | "instagram" | "tiktok";
export type Formula = "by_reach" | "by_views";

export interface MetricTotal {
  metricKey: string;
  displayName: string;
  unit: string;
  value: number | null;
  previousValue: number | null;
  delta: number | null;
  pctChange: number | null;
  basis: string | null;
  availability: "ok" | "partial" | "unavailable";
  note: string | null;
  lastUpdated: string | null;
}

export interface EngagementResult {
  formula: Formula;
  formulaText: string;
  value: number | null;
  availability: "ok" | "unavailable";
  reason: string | null;
  componentsUsed: string[];
  componentsMissing: string[];
  denominator: number | null;
  numerator: number | null;
}

export interface OverviewResponse {
  range: { from: string; to: string };
  previousRange: { from: string; to: string };
  periodNote: string;
  metrics: MetricTotal[];
  publishedPosts: { value: number; previousValue: number; delta: number };
  engagement: EngagementResult | null;
  engagementNote: string | null;
  lastSuccessfulSyncAt: string | null;
}

export interface PlatformComparisonEntry {
  platform: Platform;
  metrics: MetricTotal[];
  engagement: EngagementResult;
  publishedPostCount: number;
  topPost: { id: string; title: string; views: number | null; url: string | null } | null;
}

export interface LatestMetric {
  value: number | null;
  availability: string;
  reason: string | null;
  kind: string | null;
  source: string | null;
  collectedAt: string | null;
  rangeStart: string | null;
  rangeEnd: string | null;
  correctionFlag: boolean;
}

export interface PostSummary {
  id: string;
  platform: Platform;
  platformPostId: string;
  url: string | null;
  /** Owner-checked URL of the publish job's stored thumbnail, or
   *  null when none was stored (the UI shows a neutral placeholder). */
  thumbnailUrl: string | null;
  title: string;
  publishedAt: string | null;
  accountId: string;
  accountUsername: string | null;
  projectId: string | null;
  clipId: string | null;
  metrics: Record<string, LatestMetric>;
  engagementByReach: EngagementResult;
  engagementByViews: EngagementResult;
  lastSyncedAt: string | null;
}

export interface TrendResponse {
  metricKey: string;
  displayName: string;
  unit: string;
  granularity: string;
  points: { date: string; value: number }[];
  sources: string[];
  basis: string;
  lastUpdated: string | null;
}

export interface CapabilityMetric {
  key: string;
  status: "available" | "unavailable" | "unsupported";
  reason: string | null;
  requiredPermissions: string[];
}

export interface AccountCapability {
  account: { id: string; platform: Platform; username: string | null; status: string };
  capability: {
    accountId: string;
    platform: Platform;
    apiVersion: string;
    endpoints: { name: string; path: string; status: string; reason: string | null; exercised?: boolean }[];
    metrics: CapabilityMetric[];
    dimensions: string[];
    requiredPermissions: string[];
    limitations: string[];
    supportedRange: { note: string; maxDaysBack?: number };
    lastCapabilityCheckAt: string | null;
    lastSuccessfulRetrievalAt: string | null;
  };
}

export type SyncStatus =
  | "QUEUED" | "VALIDATING_ACCOUNT" | "FETCHING_ACCOUNT_DATA" | "FETCHING_POST_DATA"
  | "FETCHING_METRICS" | "NORMALIZING_DATA" | "SAVING_SNAPSHOTS" | "GENERATING_REPORT"
  | "COMPLETED" | "PARTIAL_SUCCESS" | "FAILED" | "CANCELLED" | "AUTH_REQUIRED";

export interface SyncJob {
  id: string;
  accountId: string | null;
  platform: Platform | null;
  scope: string;
  platformPostId: string | null;
  rangeStart: string | null;
  rangeEnd: string | null;
  status: SyncStatus;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  progress: Record<string, unknown> | null;
  error: string | null;
  errorCode: string | null;
  errorClass: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface Insight {
  id: string;
  kind: "OBSERVATION" | "CORRELATION" | "SUGGESTION";
  ruleKey: string;
  title: string;
  body: string;
  platform: Platform | null;
  accountId: string | null;
  rangeStart: string | null;
  rangeEnd: string | null;
  sampleSize: number;
  formula: string | null;
  limitations: string;
  status: string;
  createdAt: string;
}

export interface InsightEvidence {
  label: string;
  metricKey: string | null;
  value: unknown;
  platformPostId: string | null;
}

export interface ReportExport {
  id: string;
  format: string;
  status: string;
  fileSize: number | null;
  error: string | null;
  downloadUrl: string | null;
}

export interface AnalyticsReport {
  id: string;
  name: string;
  config: Record<string, unknown>;
  status: string;
  error: string | null;
  rangeStart: string | null;
  rangeEnd: string | null;
  createdAt: string;
  generatedAt: string | null;
  exports: ReportExport[];
}

export interface ContentGroup {
  label: string;
  postCount: number;
  postIds: string[];
  smallSample: boolean;
  totalViews: number | null;
  averageViews: number | null;
  medianViews: number | null;
  /** Totals are null when NO post in the group has the metric
   *  recorded; the *Count fields say how many posts contributed. */
  totalLikes: number | null;
  likesCount: number;
  totalComments: number | null;
  commentsCount: number;
  totalShares: number | null;
  sharesCount: number;
  medianEngagementByReach: number | null;
  medianEngagementByViews: number | null;
}

export interface PostingTimes {
  timezone: string;
  totalPosts: number;
  postsWithViews: number;
  minimumSample: number;
  sufficient: boolean;
  message: string;
  buckets: { weekday: number; weekdayLabel: string; hour: number; label: string; count: number; medianViews: number | null }[];
  bestBucket: { weekday: number; hour: number; label: string; count: number; medianViews: number | null } | null;
}

const qs = (params: Record<string, string | undefined>): string => {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== "");
  return entries.length > 0 ? `?${new URLSearchParams(entries as [string, string][]).toString()}` : "";
};

export const analyticsApi = {
  overview: (from: string, to: string, platform?: Platform, formula?: Formula) =>
    apiRequest<OverviewResponse>(`/analytics/overview${qs({ from, to, platform, formula })}`),
  platformComparison: (from: string, to: string, formula?: Formula) =>
    apiRequest<{ range: { from: string; to: string }; formula: Formula; platforms: PlatformComparisonEntry[]; warnings: string[] }>(
      `/analytics/platform-comparison${qs({ from, to, formula })}`,
    ),
  trends: (params: { metric: string; from: string; to: string; granularity?: string; platform?: Platform; accountId?: string; postId?: string }) =>
    apiRequest<TrendResponse>(`/analytics/trends${qs({ ...params })}`),
  posts: (params: { platform?: Platform; accountId?: string; projectId?: string } = {}) =>
    apiRequest<{ posts: PostSummary[] }>(`/analytics/posts${qs({ ...params })}`),
  post: (id: string) =>
    apiRequest<{ post: PostSummary; attributes: Record<string, string>; compareCandidates: PostSummary[] }>(`/analytics/posts/${id}`),
  postHistory: (id: string) =>
    apiRequest<{ snapshots: Record<string, unknown>[]; values: Record<string, unknown>[] }>(`/analytics/posts/${id}/history`),
  comparePosts: (postIds: string[], from?: string, to?: string) =>
    apiRequest<{ range: { from: string; to: string } | null; posts: (PostSummary & { rangeMetrics: Record<string, number | null> | null })[]; note: string }>(
      "/analytics/posts/compare",
      { method: "POST", body: { postIds, from, to } },
    ),
  topContent: (params: { sort?: string; platform?: Platform; accountId?: string; projectId?: string; clipId?: string; aspect?: string; from: string; to: string }) =>
    apiRequest<{ sort: string; posts: PostSummary[]; note: string }>(`/analytics/top-content${qs({ ...params })}`),
  contentAnalysis: (groupBy: string) =>
    apiRequest<{ groupBy: string; groups: ContentGroup[]; disclaimer: string }>(`/analytics/content-analysis${qs({ groupBy })}`),
  postingTimes: (accountId?: string, timezone?: string) =>
    apiRequest<PostingTimes>(`/analytics/posting-times${qs({ accountId, timezone })}`),
  capabilities: () => apiRequest<{ accounts: AccountCapability[] }>("/analytics/capabilities"),
  refreshCapabilities: (accountId: string) =>
    apiRequest<{ capability: AccountCapability["capability"] }>("/analytics/capabilities/refresh", {
      method: "POST",
      body: { accountId },
    }),
  startSync: (body: { accountId?: string; platform?: Platform; all?: boolean; postId?: string; from?: string; to?: string }) =>
    apiRequest<{ job: SyncJob; deduplicated: boolean }>("/analytics/sync", { method: "POST", body }),
  syncJobs: () => apiRequest<{ jobs: SyncJob[] }>("/analytics/sync/jobs"),
  syncJob: (id: string) => apiRequest<{ job: SyncJob; attempts: Record<string, unknown>[] }>(`/analytics/sync/jobs/${id}`),
  retrySync: (id: string) => apiRequest<{ job: SyncJob }>(`/analytics/sync/jobs/${id}/retry`, { method: "POST", body: {} }),
  cancelSync: (id: string) => apiRequest<{ ok: boolean }>(`/analytics/sync/jobs/${id}/cancel`, { method: "POST", body: {} }),
  syncHistory: () =>
    apiRequest<{ history: SyncJob[]; accounts: { id: string; platform: Platform; username: string | null; last_synced_at: string | null }[] }>(
      "/analytics/sync/history",
    ),
  getSettings: () => apiRequest<{ settings: { autoSyncMinutes: number; timezone: string } }>("/analytics/settings"),
  putSettings: (settings: { autoSyncMinutes: number; timezone: string }) =>
    apiRequest<{ settings: { autoSyncMinutes: number; timezone: string } }>("/analytics/settings", {
      method: "PUT",
      body: settings,
    }),
  generateInsights: (from: string, to: string) =>
    apiRequest<{ created: number; skipped: number }>(`/analytics/insights/generate${qs({ from, to })}`, { method: "POST", body: {} }),
  insights: (status = "ACTIVE") => apiRequest<{ insights: Insight[] }>(`/analytics/insights${qs({ status })}`),
  insight: (id: string) => apiRequest<{ insight: Insight; evidence: InsightEvidence[] }>(`/analytics/insights/${id}`),
  dismissInsight: (id: string) => apiRequest<{ ok: boolean }>(`/analytics/insights/${id}/dismiss`, { method: "POST", body: {} }),
  saveInsight: (id: string) => apiRequest<{ ok: boolean }>(`/analytics/insights/${id}/save`, { method: "POST", body: {} }),
  createReport: (body: { name: string; from: string; to: string; config: Record<string, unknown> }) =>
    apiRequest<{ report: AnalyticsReport }>("/analytics/reports", { method: "POST", body }),
  reports: () => apiRequest<{ reports: AnalyticsReport[] }>("/analytics/reports"),
  deleteReport: (id: string) => apiRequest<{ ok: boolean }>(`/analytics/reports/${id}?confirm=true`, { method: "DELETE" }),
  definitions: () => apiRequest<{ definitions: Record<string, unknown>[] }>("/analytics/definitions"),
};
