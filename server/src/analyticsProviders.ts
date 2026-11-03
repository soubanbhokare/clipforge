// CLIPFORGE Phase 11 — analytics provider layer.
//
// Capability detection (§6) + metric fetching (§3–§5) against the
// OFFICIAL analytics surfaces only:
//  - YouTube Analytics API reports.query (needs the
//    yt-analytics.readonly scope) and YouTube Data API v3 counters
//    (youtube.readonly) — always stored as SEPARATE sources (§3).
//  - Instagram Insights (needs instagram_business_manage_insights,
//    which Phase 10 deliberately did not request — minimal scopes).
//  - TikTok Display API video.query (needs the video.list scope).
//
// Detection runs BEFORE any request: it checks the account's granted
// scopes and account type from Phase 10 records, and every metric the
// provider cannot supply is returned as an explicit unavailable /
// unsupported row — never as zero, never invented. Fetchers use the
// same providerHttp helper as publishing, so error classification
// (429 → RATE_LIMITED/transient, invalid_grant → AUTH_REQUIRED) is
// identical across phases.

import { config } from "./config.js";
import { providerHttp, ProviderError, type Platform } from "./providers.js";

// ---- metric catalogue (§19 definitions, seeded into the DB) ----------------

export type MetricKind = "daily_activity" | "range_activity" | "lifetime_counter" | "gauge";

export interface MetricDef {
  key: string;
  platform: Platform | "all";
  displayName: string;
  unit: "count" | "seconds";
  kind: MetricKind;
  definition: string;
  sourceNote: string;
}

const D = (
  key: string,
  platform: Platform | "all",
  displayName: string,
  unit: "count" | "seconds",
  kind: MetricKind,
  definition: string,
  sourceNote = "",
): MetricDef => ({ key, platform, displayName, unit, kind, definition, sourceNote });

export const METRIC_DEFINITIONS: MetricDef[] = [
  D("views", "all", "Views", "count", "lifetime_counter",
    "Times the post was viewed, as counted by the platform. YouTube Analytics reports date-scoped views; Data API / Display API counters are lifetime cumulative counts. The two sources are stored and labelled separately, never mixed."),
  D("reach", "all", "Reach", "count", "lifetime_counter",
    "Unique accounts that saw the post at least once. Not the same metric as views and never added to views."),
  D("likes", "all", "Likes", "count", "lifetime_counter", "Like / heart count reported by the platform."),
  D("comments", "all", "Comments", "count", "lifetime_counter", "Comment count reported by the platform."),
  D("shares", "all", "Shares", "count", "lifetime_counter",
    "Share count reported by the platform. The YouTube Data API does not expose shares; the YouTube Analytics API does (scope permitting)."),
  D("saves", "all", "Saves", "count", "lifetime_counter",
    "Save / bookmark count. Exposed by Instagram Insights; not exposed by YouTube or TikTok Display API."),
  D("watch_time_seconds", "all", "Watch time", "seconds", "lifetime_counter",
    "Total seconds watched. YouTube reports estimatedMinutesWatched (converted to seconds); Instagram reports average watch time for Reels, not a total, so a total is not derived."),
  D("avg_watch_time_seconds", "all", "Average watch time", "seconds", "lifetime_counter",
    "Average seconds watched per view, as reported by the platform (YouTube averageViewDuration; Instagram ig_reels_avg_watch_time converted from ms)."),
  D("followers", "all", "Followers", "count", "gauge",
    "Follower / subscriber count at collection time (a gauge, not a period total). Growth is the difference between two snapshots."),
  D("engaged_views", "youtube", "Engaged views", "count", "range_activity",
    "YouTube Analytics engagedViews: views that met YouTube's engagement criteria for the report range."),
  D("subscribers_gained", "youtube", "Subscribers gained", "count", "daily_activity",
    "YouTube Analytics subscribersGained for the day / range."),
  D("subscribers_lost", "youtube", "Subscribers lost", "count", "daily_activity",
    "YouTube Analytics subscribersLost for the day / range."),
  D("total_interactions", "instagram", "Total interactions", "count", "lifetime_counter",
    "Instagram Insights total_interactions for the media or account period."),
  D("follows", "instagram", "Follows", "count", "lifetime_counter",
    "Follows attributed to the content/account by Instagram Insights, where the API returns it."),
  D("profile_visits", "instagram", "Profile activity", "count", "lifetime_counter",
    "Instagram profile activity actions where the API returns them for the account type."),
  D("total_likes_received", "tiktok", "Total likes received", "count", "gauge",
    "TikTok Display API likes_count on the profile: lifetime likes across the account's videos at collection time."),
];

export function definitionFor(platform: Platform, key: string): MetricDef | undefined {
  return METRIC_DEFINITIONS.find((d) => d.key === key && (d.platform === platform || d.platform === "all"));
}

// ---- scopes that gate analytics (§6 step 2: verify permission exists) -------

export const ANALYTICS_SCOPES = {
  youtubeAnalytics: "https://www.googleapis.com/auth/yt-analytics.readonly",
  youtubeReadonly: "https://www.googleapis.com/auth/youtube.readonly",
  instagramInsights: "instagram_business_manage_insights",
  instagramBasic: "instagram_business_basic",
  tiktokVideoList: "video.list",
  tiktokBasic: "user.info.basic",
} as const;

export const API_VERSIONS: Record<Platform, string> = {
  youtube: "YouTube Analytics API v2 (reports.query) + YouTube Data API v3",
  instagram: "Instagram Graph API (Instagram Login, current version)",
  tiktok: "TikTok Display API v2 (video.query / user info)",
};

// ---- capability detection (§6) ----------------------------------------------

export interface CapabilityMetric {
  key: string;
  status: "available" | "unavailable" | "unsupported";
  reason: string | null;
  requiredPermissions: string[];
}

export interface CapabilitySet {
  platform: Platform;
  apiVersion: string;
  /** `exercised` is false for endpoints the provider offers but this
   *  integration never calls — capabilities must not overstate what
   *  the code actually uses (F8). */
  endpoints: { name: string; path: string; status: "available" | "unavailable"; reason: string | null; exercised: boolean }[];
  metrics: CapabilityMetric[];
  dimensions: string[];
  requiredPermissions: string[];
  limitations: string[];
  /** `maxDaysBack`, when present, is the machine-enforced supported
   *  window: syncs clamp older fetch ranges to it (F5). */
  supportedRange: { note: string; maxDaysBack?: number };
}

const has = (scopes: string[], s: string): boolean => scopes.includes(s);

export function detectCapabilities(platform: Platform, grantedScopes: string[], accountType: string | null): CapabilitySet {
  const metrics: CapabilityMetric[] = [];
  const limitations: string[] = [];
  const m = (key: string, status: CapabilityMetric["status"], reason: string | null, perms: string[]) =>
    metrics.push({ key, status, reason, requiredPermissions: perms });

  if (platform === "youtube") {
    const analyticsOk = has(grantedScopes, ANALYTICS_SCOPES.youtubeAnalytics);
    const dataOk = has(grantedScopes, ANALYTICS_SCOPES.youtubeReadonly);
    const aReason = analyticsOk ? null : `Scope not granted: ${ANALYTICS_SCOPES.youtubeAnalytics}. Reconnect the account granting YouTube Analytics access.`;
    for (const key of ["views", "likes", "comments", "shares", "watch_time_seconds", "avg_watch_time_seconds", "engaged_views", "subscribers_gained", "subscribers_lost"]) {
      m(key, analyticsOk ? "available" : "unavailable", aReason, [ANALYTICS_SCOPES.youtubeAnalytics]);
    }
    m("followers", dataOk ? "available" : "unavailable", dataOk ? null : `Scope not granted: ${ANALYTICS_SCOPES.youtubeReadonly}.`, [ANALYTICS_SCOPES.youtubeReadonly]);
    m("saves", "unsupported", "YouTube does not expose a saves/bookmarks metric.", []);
    m("reach", "unsupported", "YouTube Analytics does not expose a reach metric comparable to Instagram reach.", []);
    limitations.push(
      "YouTube Analytics figures are date-scoped activity; Data API statistics are lifetime counters. Both are stored with their own source label and never mixed.",
      "Analytics data can lag up to ~72 hours and is subject to YouTube's supported metric/dimension combinations and quota.",
    );
    return {
      platform, apiVersion: API_VERSIONS.youtube,
      endpoints: [
        { name: "Analytics reports.query", path: "youtubeanalytics.googleapis.com/v2/reports", status: analyticsOk ? "available" : "unavailable", reason: aReason, exercised: true },
        { name: "Data API videos.list / channels.list", path: "youtube/v3/videos, youtube/v3/channels", status: dataOk ? "available" : "unavailable", reason: dataOk ? null : "youtube.readonly scope not granted.", exercised: true },
      ],
      metrics,
      dimensions: analyticsOk ? ["day", "video"] : [],
      requiredPermissions: [ANALYTICS_SCOPES.youtubeAnalytics, ANALYTICS_SCOPES.youtubeReadonly],
      limitations,
      supportedRange: { note: "YouTube Analytics supports historical daily reports back to the channel's first activity, subject to quota." },
    };
  }

  if (platform === "instagram") {
    const insightsOk = has(grantedScopes, ANALYTICS_SCOPES.instagramInsights);
    const basicOk = has(grantedScopes, ANALYTICS_SCOPES.instagramBasic);
    const type = (accountType ?? "").toUpperCase();
    const eligible = type === "BUSINESS" || type === "CREATOR" || type === "MEDIA_CREATOR";
    const iReason = !eligible
      ? `Account type ${accountType ?? "unknown"} is not eligible for Instagram Insights (Business or Creator required).`
      : !insightsOk
        ? `Scope not granted: ${ANALYTICS_SCOPES.instagramInsights}. Phase 10 requested minimal scopes; reconnect granting insights access to enable Instagram analytics.`
        : null;
    const iStatus: CapabilityMetric["status"] = iReason ? "unavailable" : "available";
    for (const key of ["views", "reach", "likes", "comments", "shares", "saves", "total_interactions", "avg_watch_time_seconds"]) {
      m(key, iStatus, iReason, [ANALYTICS_SCOPES.instagramInsights]);
    }
    m("follows", iStatus, iReason, [ANALYTICS_SCOPES.instagramInsights]);
    m("profile_visits", iStatus, iReason, [ANALYTICS_SCOPES.instagramInsights]);
    m("watch_time_seconds", "unsupported", "Instagram exposes average watch time for Reels, not a total watch time; a total is not derived.", [ANALYTICS_SCOPES.instagramInsights]);
    m("followers", basicOk ? "available" : "unavailable", basicOk ? null : `Scope not granted: ${ANALYTICS_SCOPES.instagramBasic}.`, [ANALYTICS_SCOPES.instagramBasic]);
    limitations.push(
      "Available metrics differ by media type, API version, account eligibility and permissions; each metric is checked per media before display.",
      "CLIPFORGE publishes Instagram Reels only, so media insights are requested with the Reels metric set.",
    );
    return {
      platform, apiVersion: API_VERSIONS.instagram,
      endpoints: [
        { name: "Account insights", path: "{ig-user-id}/insights", status: iStatus === "available" ? "available" : "unavailable", reason: iReason, exercised: true },
        { name: "Media insights", path: "{media-id}/insights", status: iStatus === "available" ? "available" : "unavailable", reason: iReason, exercised: true },
        { name: "Profile", path: "me?fields=followers_count", status: basicOk ? "available" : "unavailable", reason: basicOk ? null : "instagram_business_basic scope not granted.", exercised: true },
      ],
      metrics,
      dimensions: ["media", "day"],
      requiredPermissions: [ANALYTICS_SCOPES.instagramInsights, ANALYTICS_SCOPES.instagramBasic],
      limitations,
      supportedRange: { note: "Instagram Insights history is limited by Meta (account insights are returned for a bounded recent window — 30 days per request in this integration); syncs clamp older requested ranges to that window and record the clamp.", maxDaysBack: 30 },
    };
  }

  // tiktok
  const listOk = has(grantedScopes, ANALYTICS_SCOPES.tiktokVideoList);
  const basicOk = has(grantedScopes, ANALYTICS_SCOPES.tiktokBasic);
  const lReason = listOk ? null : `Scope not granted: ${ANALYTICS_SCOPES.tiktokVideoList}. Phase 10 requested user.info.basic + video.publish; reconnect granting video.list to enable TikTok post metrics.`;
  for (const key of ["views", "likes", "comments", "shares"]) {
    m(key, listOk ? "available" : "unavailable", lReason, [ANALYTICS_SCOPES.tiktokVideoList]);
  }
  m("followers", basicOk ? "available" : "unavailable", basicOk ? null : `Scope not granted: ${ANALYTICS_SCOPES.tiktokBasic}.`, [ANALYTICS_SCOPES.tiktokBasic]);
  m("total_likes_received", basicOk ? "available" : "unavailable", basicOk ? null : `Scope not granted: ${ANALYTICS_SCOPES.tiktokBasic}.`, [ANALYTICS_SCOPES.tiktokBasic]);
  for (const key of ["reach", "saves", "watch_time_seconds", "avg_watch_time_seconds"]) {
    m(key, "unsupported", "The TikTok Display API does not expose this metric for creator accounts. The Research API is a separate product and is not used.", []);
  }
  limitations.push(
    "Display API counters are current lifetime values per video; historical daily activity is not exposed, so TikTok trends are built from CLIPFORGE's own snapshots over time.",
    "No audience, retention or follower-analytics endpoints are available to this integration.",
  );
  return {
    platform, apiVersion: API_VERSIONS.tiktok,
    endpoints: [
      { name: "Video query", path: "v2/video/query/", status: listOk ? "available" : "unavailable", reason: lReason, exercised: true },
      // F8: video/list exists on the Display API but this integration
      // never calls it — post metrics come from video/query. It is
      // recorded as available-but-unused so the capability record
      // never overstates what the code exercises.
      { name: "Video list", path: "v2/video/list/", status: listOk ? "available" : "unavailable", reason: lReason ?? "Offered by the Display API but not called by this integration — post metrics are fetched with video/query.", exercised: false },
      { name: "User info", path: "v2/user/info/", status: basicOk ? "available" : "unavailable", reason: basicOk ? null : "user.info.basic scope not granted.", exercised: true },
    ],
    metrics,
    dimensions: ["video"],
    requiredPermissions: [ANALYTICS_SCOPES.tiktokVideoList, ANALYTICS_SCOPES.tiktokBasic],
    limitations,
    supportedRange: { note: "TikTok Display API returns current counters only; history accrues from CLIPFORGE snapshots." },
  };
}

// ---- fetch results ------------------------------------------------------------

export interface FetchedMetric {
  scope: "account" | "post";
  postExternalId: string | null;
  metricKey: string;
  value: number | null;
  availability: "ok" | "unavailable" | "unsupported" | "error";
  reason: string | null;
  rangeStart: string | null; // yyyy-mm-dd
  rangeEnd: string | null;
  source: string;
  /** Assigned by the dispatch wrappers from the source label:
   *  daily reports → daily_activity; per-video range reports →
   *  range_activity; profile counters → gauge; everything else is a
   *  lifetime cumulative counter. The distinction is load-bearing:
   *  totals and trends never mix kinds silently. */
  kind?: MetricKind;
}

/** Exported for the sync engine's normalization stage (F6), which
 *  re-derives each fetched row's kind before anything is stored. */
export function classifyKind(m: FetchedMetric): MetricKind {
  if (m.kind) return m.kind;
  if (m.source.includes("dimensions=day") || m.source.includes("period=day")) return "daily_activity";
  if (m.source.includes("dimensions=video")) return "range_activity";
  if (m.metricKey === "followers" || m.metricKey === "total_likes_received") return "gauge";
  return "lifetime_counter";
}

export interface AnalyticsAccountContext {
  platformAccountId: string;
  username: string | null;
  accountType: string | null;
  grantedScopes: string[];
}

export interface PostRef {
  internalId: string; // platform_posts.id
  externalId: string; // provider's post id
  publishedAt: string | null;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

function unavailable(scope: "account" | "post", postExternalId: string | null, keys: string[], reason: string, rangeStart: string | null, rangeEnd: string | null, source: string): FetchedMetric[] {
  return keys.map((metricKey) => ({
    scope, postExternalId, metricKey, value: null, availability: "unavailable" as const, reason,
    rangeStart, rangeEnd, source,
  }));
}

/** Google wraps quota exhaustion in a 403; that is a transient
 *  rate-limit, not a permission problem. Re-classify it so the sync
 *  engine backs off instead of demanding reauthorization. */
function rethrowClassified(err: unknown): never {
  if (err instanceof ProviderError) {
    const body = JSON.stringify(err.providerBody ?? "");
    if (err.code !== "RATE_LIMITED" && /quota/i.test(body + err.message)) {
      throw new ProviderError(err.message, { status: 429, code: "RATE_LIMITED", errorClass: "transient", providerBody: err.providerBody });
    }
  }
  throw err;
}

// ===========================================================================
// YouTube
// ===========================================================================

const YT_ANALYTICS_METRICS = "views,engagedViews,likes,comments,shares,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost";
const YT_VIDEO_METRICS = "views,engagedViews,likes,comments,shares,estimatedMinutesWatched,averageViewDuration";

interface YtReport {
  columnHeaders?: { name: string }[];
  rows?: unknown[][];
}

function ytRows(report: YtReport): Record<string, unknown>[] {
  const headers = (report.columnHeaders ?? []).map((h) => h.name);
  return (report.rows ?? []).map((row) => {
    const out: Record<string, unknown> = {};
    headers.forEach((h, i) => { out[h] = row[i]; });
    return out;
  });
}

async function ytReport(accessToken: string, params: Record<string, string>): Promise<YtReport> {
  const qs = new URLSearchParams(params).toString();
  try {
    const { json } = await providerHttp(`${config.analytics.youtubeAnalyticsBase}/v2/reports?${qs}`, { accessToken });
    return (json ?? {}) as YtReport;
  } catch (err) {
    rethrowClassified(err);
  }
}

function ytDailyMetrics(rows: Record<string, unknown>[], source: string): FetchedMetric[] {
  const out: FetchedMetric[] = [];
  const map: [string, string, number][] = [
    ["views", "views", 1], ["engagedViews", "engaged_views", 1], ["likes", "likes", 1],
    ["comments", "comments", 1], ["shares", "shares", 1],
    ["estimatedMinutesWatched", "watch_time_seconds", 60], ["averageViewDuration", "avg_watch_time_seconds", 1],
    ["subscribersGained", "subscribers_gained", 1], ["subscribersLost", "subscribers_lost", 1],
  ];
  for (const row of rows) {
    const day = typeof row.day === "string" ? row.day : null;
    if (!day) continue;
    for (const [src, key, mult] of map) {
      const v = num(row[src]);
      if (v === null) continue;
      out.push({ scope: "account", postExternalId: null, metricKey: key, value: v * mult, availability: "ok", reason: null, rangeStart: day, rangeEnd: day, source });
    }
  }
  return out;
}

async function fetchYouTubeAccount(accessToken: string, acct: AnalyticsAccountContext, rangeStart: string, rangeEnd: string): Promise<FetchedMetric[]> {
  const out: FetchedMetric[] = [];
  const c = config.publishing.youtube;
  const scopes = acct.grantedScopes;
  // Data API channel statistics — a separate source from Analytics (§3).
  if (has(scopes, ANALYTICS_SCOPES.youtubeReadonly)) {
    // F3: same quota treatment as ytReport — a Google quota 403 from
    // the Data API is a transient rate limit, not a dead grant.
    let channelJson: unknown = null;
    try {
      const res = await providerHttp(`${c.apiBase}/youtube/v3/channels?part=statistics&id=${encodeURIComponent(acct.platformAccountId)}`, { accessToken });
      channelJson = res.json;
    } catch (err) {
      rethrowClassified(err);
    }
    const items = (channelJson as { items?: Record<string, unknown>[] }).items ?? [];
    const stats = (items[0]?.statistics ?? {}) as Record<string, unknown>;
    const subs = num(stats.subscriberCount);
    if (subs !== null && stats.hiddenSubscriberCount !== true) {
      out.push({ scope: "account", postExternalId: null, metricKey: "followers", value: subs, availability: "ok", reason: null, rangeStart: null, rangeEnd: null, source: "youtube-data-api-v3 channels.statistics" });
    } else {
      out.push({ scope: "account", postExternalId: null, metricKey: "followers", value: null, availability: "unavailable", reason: "The channel hides its subscriber count.", rangeStart: null, rangeEnd: null, source: "youtube-data-api-v3 channels.statistics" });
    }
  }
  if (!has(scopes, ANALYTICS_SCOPES.youtubeAnalytics)) {
    out.push(...unavailable("account", null,
      ["views", "likes", "comments", "shares", "watch_time_seconds", "avg_watch_time_seconds", "engaged_views", "subscribers_gained", "subscribers_lost"],
      `Scope not granted: ${ANALYTICS_SCOPES.youtubeAnalytics}. Reconnect the account granting YouTube Analytics access.`,
      rangeStart, rangeEnd, "youtube-analytics-api reports.query"));
    return out;
  }
  const report = await ytReport(accessToken, {
    ids: "channel==MINE", startDate: rangeStart, endDate: rangeEnd,
    metrics: YT_ANALYTICS_METRICS, dimensions: "day", sort: "day",
  });
  out.push(...ytDailyMetrics(ytRows(report), "youtube-analytics-api reports.query (dimensions=day)"));
  return out;
}

async function fetchYouTubePosts(accessToken: string, acct: AnalyticsAccountContext, posts: PostRef[], rangeStart: string, rangeEnd: string): Promise<{ metrics: FetchedMetric[]; deletedExternalIds: string[] }> {
  const out: FetchedMetric[] = [];
  const deleted: string[] = [];
  const c = config.publishing.youtube;
  const scopes = acct.grantedScopes;
  const map: [string, string, number][] = [
    ["views", "views", 1], ["engagedViews", "engaged_views", 1], ["likes", "likes", 1],
    ["comments", "comments", 1], ["shares", "shares", 1],
    ["estimatedMinutesWatched", "watch_time_seconds", 60], ["averageViewDuration", "avg_watch_time_seconds", 1],
  ];
  // Analytics per-video range activity (date-scoped — NOT lifetime).
  if (has(scopes, ANALYTICS_SCOPES.youtubeAnalytics) && posts.length > 0) {
    for (let i = 0; i < posts.length; i += 50) {
      const batch = posts.slice(i, i + 50);
      const report = await ytReport(accessToken, {
        ids: "channel==MINE", startDate: rangeStart, endDate: rangeEnd,
        metrics: YT_VIDEO_METRICS, dimensions: "video",
        filters: `video==${batch.map((p) => p.externalId).join(",")}`,
      });
      const byVideo = new Map<string, Record<string, unknown>>();
      for (const row of ytRows(report)) {
        if (typeof row.video === "string") byVideo.set(row.video, row);
      }
      for (const post of batch) {
        const row = byVideo.get(post.externalId);
        if (!row) continue; // no activity in range is a legitimate absence of rows, not zero-filled data
        for (const [src, key, mult] of map) {
          const v = num(row[src]);
          if (v === null) continue;
          out.push({ scope: "post", postExternalId: post.externalId, metricKey: key, value: v * mult, availability: "ok", reason: null, rangeStart, rangeEnd, source: "youtube-analytics-api reports.query (dimensions=video)" });
        }
      }
    }
  } else if (posts.length > 0) {
    for (const post of posts) {
      out.push(...unavailable("post", post.externalId, map.map(([, k]) => k),
        `Scope not granted: ${ANALYTICS_SCOPES.youtubeAnalytics}.`, rangeStart, rangeEnd, "youtube-analytics-api reports.query (dimensions=video)"));
    }
  }
  // Data API lifetime counters — separate source, stored separately (§3).
  if (has(scopes, ANALYTICS_SCOPES.youtubeReadonly) && posts.length > 0) {
    for (let i = 0; i < posts.length; i += 50) {
      const batch = posts.slice(i, i + 50);
      // F3: same quota treatment as ytReport (see channels.list above).
      let videosJson: unknown = null;
      try {
        const res = await providerHttp(`${c.apiBase}/youtube/v3/videos?part=statistics&id=${batch.map((p) => encodeURIComponent(p.externalId)).join(",")}`, { accessToken });
        videosJson = res.json;
      } catch (err) {
        rethrowClassified(err);
      }
      const items = (videosJson as { items?: Record<string, unknown>[] }).items ?? [];
      const seen = new Set<string>();
      for (const item of items) {
        const id = typeof item.id === "string" ? item.id : null;
        if (!id) continue;
        seen.add(id);
        const stats = (item.statistics ?? {}) as Record<string, unknown>;
        const pairs: [string, unknown][] = [["views", stats.viewCount], ["likes", stats.likeCount], ["comments", stats.commentCount]];
        for (const [key, raw] of pairs) {
          const v = num(raw);
          if (v === null) continue;
          out.push({ scope: "post", postExternalId: id, metricKey: key, value: v, availability: "ok", reason: null, rangeStart: null, rangeEnd: null, source: "youtube-data-api-v3 videos.statistics" });
        }
        out.push({ scope: "post", postExternalId: id, metricKey: "shares", value: null, availability: "unavailable", reason: "The YouTube Data API does not expose share counts; shares come from the Analytics API when its scope is granted.", rangeStart: null, rangeEnd: null, source: "youtube-data-api-v3 videos.statistics" });
      }
      for (const post of batch) {
        if (!seen.has(post.externalId)) deleted.push(post.externalId);
      }
    }
  }
  return { metrics: out, deletedExternalIds: deleted };
}

// ===========================================================================
// Instagram
// ===========================================================================

const IG_MEDIA_METRICS = ["views", "reach", "likes", "comments", "shares", "saved", "total_interactions", "ig_reels_avg_watch_time"];
const IG_ACCOUNT_METRICS = ["reach", "views", "total_interactions"];

async function igGet(accessToken: string, pathAndQuery: string): Promise<Record<string, unknown>> {
  const c = config.publishing.instagram;
  const { json } = await providerHttp(`${c.apiBase}/${pathAndQuery}`, { accessToken });
  return (json ?? {}) as Record<string, unknown>;
}

function igInsightsValues(json: Record<string, unknown>): { name: string; values: { value: unknown; end_time?: string }[]; total?: unknown }[] {
  const data = (json.data ?? []) as Record<string, unknown>[];
  return data.map((d) => ({
    name: String(d.name ?? ""),
    values: (d.values ?? []) as { value: unknown; end_time?: string }[],
    total: (d.total_value as Record<string, unknown> | undefined)?.value,
  }));
}

async function fetchInstagramAccount(accessToken: string, acct: AnalyticsAccountContext, rangeStart: string, rangeEnd: string): Promise<FetchedMetric[]> {
  const out: FetchedMetric[] = [];
  const scopes = acct.grantedScopes;
  // Followers gauge from the profile (basic scope — not an insight).
  if (has(scopes, ANALYTICS_SCOPES.instagramBasic)) {
    try {
      const me = await igGet(accessToken, "me?fields=followers_count");
      const followers = num(me.followers_count);
      out.push({
        scope: "account", postExternalId: null, metricKey: "followers",
        value: followers, availability: followers !== null ? "ok" : "unavailable",
        reason: followers !== null ? null : "Instagram did not return followers_count for this account.",
        rangeStart: null, rangeEnd: null, source: "instagram-graph-api me.followers_count",
      });
    } catch (err) {
      if (err instanceof ProviderError && (err.errorClass === "user_intervention" || err.code === "RATE_LIMITED")) throw err;
      out.push({ scope: "account", postExternalId: null, metricKey: "followers", value: null, availability: "error", reason: err instanceof Error ? err.message : "Profile request failed.", rangeStart: null, rangeEnd: null, source: "instagram-graph-api me.followers_count" });
    }
  }
  const caps = detectCapabilities("instagram", scopes, acct.accountType);
  const insightsMetric = caps.metrics.find((x) => x.key === "views");
  if (!insightsMetric || insightsMetric.status !== "available") {
    out.push(...unavailable("account", null, [...IG_ACCOUNT_METRICS, "follows", "profile_visits"],
      insightsMetric?.reason ?? "Instagram Insights are not available for this account.",
      rangeStart, rangeEnd, "instagram-graph-api insights"));
    return out;
  }
  const since = Math.floor(new Date(`${rangeStart}T00:00:00Z`).getTime() / 1000);
  const until = Math.floor(new Date(`${rangeEnd}T00:00:00Z`).getTime() / 1000) + 86399;
  // Per-metric requests: one unsupported metric must not sink the rest (§4).
  for (const metric of IG_ACCOUNT_METRICS) {
    try {
      const json = await igGet(accessToken, `${acct.platformAccountId}/insights?metric=${metric}&period=day&metric_type=total_value&since=${since}&until=${until}`);
      const series = igInsightsValues(json).find((s) => s.name === metric);
      if (!series) {
        out.push({ scope: "account", postExternalId: null, metricKey: metric, value: null, availability: "unavailable", reason: "Instagram returned no series for this metric.", rangeStart, rangeEnd, source: "instagram-graph-api account insights" });
        continue;
      }
      for (const point of series.values) {
        const v = num(point.value);
        if (v === null) continue;
        const day = point.end_time ? point.end_time.slice(0, 10) : rangeStart;
        out.push({ scope: "account", postExternalId: null, metricKey: metric, value: v, availability: "ok", reason: null, rangeStart: day, rangeEnd: day, source: "instagram-graph-api account insights (period=day)" });
      }
    } catch (err) {
      if (err instanceof ProviderError && err.code === "RATE_LIMITED") throw err;
      out.push({ scope: "account", postExternalId: null, metricKey: metric, value: null, availability: "error", reason: err instanceof Error ? err.message : "Insights request failed.", rangeStart, rangeEnd, source: "instagram-graph-api account insights" });
    }
  }
  return out;
}

async function fetchInstagramPosts(accessToken: string, acct: AnalyticsAccountContext, posts: PostRef[], rangeStart: string, rangeEnd: string): Promise<{ metrics: FetchedMetric[]; deletedExternalIds: string[] }> {
  const out: FetchedMetric[] = [];
  const deleted: string[] = [];
  const caps = detectCapabilities("instagram", acct.grantedScopes, acct.accountType);
  const insightsMetric = caps.metrics.find((x) => x.key === "views");
  const keyMap: Record<string, string> = { saved: "saves", ig_reels_avg_watch_time: "avg_watch_time_seconds" };
  if (!insightsMetric || insightsMetric.status !== "available") {
    for (const post of posts) {
      out.push(...unavailable("post", post.externalId, ["views", "reach", "likes", "comments", "shares", "saves", "total_interactions", "avg_watch_time_seconds"],
        insightsMetric?.reason ?? "Instagram Insights are not available for this account.",
        rangeStart, rangeEnd, "instagram-graph-api media insights"));
    }
    return { metrics: out, deletedExternalIds: deleted };
  }
  for (const post of posts) {
    try {
      const json = await igGet(accessToken, `${post.externalId}/insights?metric=${IG_MEDIA_METRICS.join(",")}`);
      const series = igInsightsValues(json);
      for (const entry of series) {
        const key = keyMap[entry.name] ?? entry.name;
        let v = num(entry.total ?? entry.values?.[0]?.value);
        if (v === null) continue;
        if (entry.name === "ig_reels_avg_watch_time") v = v / 1000; // ms → seconds
        out.push({ scope: "post", postExternalId: post.externalId, metricKey: key, value: v, availability: "ok", reason: null, rangeStart: null, rangeEnd: null, source: "instagram-graph-api media insights" });
      }
      const returned = new Set(series.map((s) => keyMap[s.name] ?? s.name));
      for (const key of ["views", "reach", "likes", "comments", "shares", "saves", "total_interactions", "avg_watch_time_seconds"]) {
        if (!returned.has(key)) {
          out.push({ scope: "post", postExternalId: post.externalId, metricKey: key, value: null, availability: "unavailable", reason: "Instagram did not return this metric for this media (metric availability varies by media type and API version).", rangeStart: null, rangeEnd: null, source: "instagram-graph-api media insights" });
        }
      }
    } catch (err) {
      if (err instanceof ProviderError && err.code === "RATE_LIMITED") throw err;
      if (err instanceof ProviderError && (err.status === 404 || /does not exist|not found/i.test(err.message))) {
        deleted.push(post.externalId);
        continue;
      }
      for (const key of ["views", "reach", "likes", "comments", "shares", "saves", "total_interactions", "avg_watch_time_seconds"]) {
        out.push({ scope: "post", postExternalId: post.externalId, metricKey: key, value: null, availability: "error", reason: err instanceof Error ? err.message : "Media insights request failed.", rangeStart: null, rangeEnd: null, source: "instagram-graph-api media insights" });
      }
    }
  }
  return { metrics: out, deletedExternalIds: deleted };
}

// ===========================================================================
// TikTok (Display API — no Research API, no scraping)
// ===========================================================================

async function fetchTikTokAccount(accessToken: string, acct: AnalyticsAccountContext): Promise<FetchedMetric[]> {
  const out: FetchedMetric[] = [];
  const c = config.publishing.tiktok;
  if (!has(acct.grantedScopes, ANALYTICS_SCOPES.tiktokBasic)) {
    out.push(...unavailable("account", null, ["followers", "total_likes_received"],
      `Scope not granted: ${ANALYTICS_SCOPES.tiktokBasic}.`, null, null, "tiktok-display-api user/info"));
    return out;
  }
  const { json } = await providerHttp(`${c.apiBase}/v2/user/info/?fields=open_id,follower_count,following_count,likes_count,video_count`, { accessToken });
  const user = (((json as Record<string, unknown>).data as Record<string, unknown> | undefined)?.user ?? {}) as Record<string, unknown>;
  const followers = num(user.follower_count);
  out.push({
    scope: "account", postExternalId: null, metricKey: "followers", value: followers,
    availability: followers !== null ? "ok" : "unavailable",
    reason: followers !== null ? null : "TikTok did not return follower_count for this account.",
    rangeStart: null, rangeEnd: null, source: "tiktok-display-api user/info",
  });
  const likesTotal = num(user.likes_count);
  if (likesTotal !== null) {
    out.push({ scope: "account", postExternalId: null, metricKey: "total_likes_received", value: likesTotal, availability: "ok", reason: null, rangeStart: null, rangeEnd: null, source: "tiktok-display-api user/info" });
  }
  return out;
}

async function fetchTikTokPosts(accessToken: string, acct: AnalyticsAccountContext, posts: PostRef[]): Promise<{ metrics: FetchedMetric[]; deletedExternalIds: string[] }> {
  const out: FetchedMetric[] = [];
  const deleted: string[] = [];
  const c = config.publishing.tiktok;
  if (!has(acct.grantedScopes, ANALYTICS_SCOPES.tiktokVideoList)) {
    for (const post of posts) {
      out.push(...unavailable("post", post.externalId, ["views", "likes", "comments", "shares"],
        `Scope not granted: ${ANALYTICS_SCOPES.tiktokVideoList}. Phase 10 requested user.info.basic + video.publish; reconnect granting video.list to enable TikTok post metrics.`,
        null, null, "tiktok-display-api video/query"));
    }
    return { metrics: out, deletedExternalIds: deleted };
  }
  const fields = "id,create_time,video_description,duration,like_count,comment_count,share_count,view_count,share_url";
  for (let i = 0; i < posts.length; i += 20) {
    const batch = posts.slice(i, i + 20);
    const { json } = await providerHttp(`${c.apiBase}/v2/video/query/?fields=${fields}`, {
      method: "POST", accessToken,
      body: { filters: { video_ids: batch.map((p) => p.externalId) } },
    });
    const data = ((json as Record<string, unknown>).data ?? {}) as Record<string, unknown>;
    const videos = (data.videos ?? []) as Record<string, unknown>[];
    const seen = new Set<string>();
    for (const video of videos) {
      const id = typeof video.id === "string" ? video.id : null;
      if (!id) continue;
      seen.add(id);
      const pairs: [string, unknown][] = [
        ["views", video.view_count], ["likes", video.like_count],
        ["comments", video.comment_count], ["shares", video.share_count],
      ];
      for (const [key, raw] of pairs) {
        const v = num(raw);
        if (v === null) {
          out.push({ scope: "post", postExternalId: id, metricKey: key, value: null, availability: "unavailable", reason: "TikTok did not return this counter for this video.", rangeStart: null, rangeEnd: null, source: "tiktok-display-api video/query" });
        } else {
          out.push({ scope: "post", postExternalId: id, metricKey: key, value: v, availability: "ok", reason: null, rangeStart: null, rangeEnd: null, source: "tiktok-display-api video/query" });
        }
      }
    }
    for (const post of batch) {
      if (!seen.has(post.externalId)) deleted.push(post.externalId);
    }
  }
  return { metrics: out, deletedExternalIds: deleted };
}

// ---- dispatch ------------------------------------------------------------------

export async function fetchAccountAnalytics(
  platform: Platform,
  accessToken: string,
  acct: AnalyticsAccountContext,
  rangeStart: string,
  rangeEnd: string,
): Promise<FetchedMetric[]> {
  const rows = platform === "youtube"
    ? await fetchYouTubeAccount(accessToken, acct, rangeStart, rangeEnd)
    : platform === "instagram"
      ? await fetchInstagramAccount(accessToken, acct, rangeStart, rangeEnd)
      : await fetchTikTokAccount(accessToken, acct);
  for (const row of rows) row.kind = classifyKind(row);
  return rows;
}

export async function fetchPostAnalytics(
  platform: Platform,
  accessToken: string,
  acct: AnalyticsAccountContext,
  posts: PostRef[],
  rangeStart: string,
  rangeEnd: string,
): Promise<{ metrics: FetchedMetric[]; deletedExternalIds: string[] }> {
  const result = platform === "youtube"
    ? await fetchYouTubePosts(accessToken, acct, posts, rangeStart, rangeEnd)
    : platform === "instagram"
      ? await fetchInstagramPosts(accessToken, acct, posts, rangeStart, rangeEnd)
      : await fetchTikTokPosts(accessToken, acct, posts);
  for (const row of result.metrics) row.kind = classifyKind(row);
  return result;
}
