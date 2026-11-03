// CLIPFORGE Phase 11 — analytics core: provenance-preserving reads
// over analytics_metric_values. Shared by the API routes
// (analytics.ts) and the report builder (analyticsReports.ts) so the
// dashboard and exported reports can never disagree.
//
// Semantics enforced here (§7, §9, §10):
//  - UNAVAILABLE ≠ ZERO: a metric with no 'ok' record is null with an
//    availability status — never 0, never a fabricated point.
//  - Views and reach are different metrics and are never added.
//  - Date-range totals prefer date-scoped activity; cumulative
//    counters contribute their snapshot DELTA inside the range (with
//    a pre-range baseline), and a counter that decreased contributes
//    0 growth flagged as a platform correction — never negative
//    "growth" (§9).
//  - Engagement uses only the components the platform actually
//    exposes, and the exact formula is always returned with the value.

import crypto from "node:crypto";
import {
  getDb,
  type AnalyticsMetricValueRow,
  type PlatformAccountRow,
  type PlatformPostRow,
  type PublishJobRow,
} from "./db.js";
import { definitionFor, METRIC_DEFINITIONS, type MetricKind } from "./analyticsProviders.js";
import type { Platform } from "./providers.js";

export const nowIso = (): string => new Date().toISOString();
export const newId = (): string => crypto.randomUUID();

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function seedMetricDefinitions(): void {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO analytics_metric_definitions
       (metric_key, platform, display_name, unit, kind, definition, source_note)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const d of METRIC_DEFINITIONS) {
    stmt.run(d.key, d.platform, d.displayName, d.unit, d.kind, d.definition, d.sourceNote);
  }
}

// ---- ranges -------------------------------------------------------------------

export interface DateRange { from: string; to: string } // yyyy-mm-dd, inclusive

export const DAY_MS = 86_400_000;

export function dateOf(iso: string): string {
  return iso.slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function rangeDays(range: DateRange): number {
  return Math.round((new Date(`${range.to}T00:00:00Z`).getTime() - new Date(`${range.from}T00:00:00Z`).getTime()) / DAY_MS) + 1;
}

export function previousRange(range: DateRange): DateRange {
  const days = rangeDays(range);
  return { from: addDays(range.from, -days), to: addDays(range.from, -1) };
}

export function validDate(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime());
}

// ---- raw value access -----------------------------------------------------------

interface ValueFilter {
  platform?: Platform;
  accountId?: string;
  metricKey?: string;
  scope?: "account" | "post";
}

function valueRows(userId: string, filter: ValueFilter): AnalyticsMetricValueRow[] {
  const clauses = ["user_id = ?"];
  const args: unknown[] = [userId];
  if (filter.platform) { clauses.push("platform = ?"); args.push(filter.platform); }
  if (filter.accountId) { clauses.push("account_id = ?"); args.push(filter.accountId); }
  if (filter.metricKey) { clauses.push("metric_key = ?"); args.push(filter.metricKey); }
  if (filter.scope) { clauses.push("scope = ?"); args.push(filter.scope); }
  return getDb()
    .prepare(`SELECT * FROM analytics_metric_values WHERE ${clauses.join(" AND ")} ORDER BY collected_at ASC`)
    .all(...(args as never[])) as unknown as AnalyticsMetricValueRow[];
}

/** Latest 'ok' value in a set of rows not after `beforeIso`
 *  (optionally strictly before `strictBeforeIso`). */
function latestOk(rows: AnalyticsMetricValueRow[], beforeIso: string | null, strictBeforeIso: string | null): AnalyticsMetricValueRow | null {
  let best: AnalyticsMetricValueRow | null = null;
  for (const row of rows) {
    if (row.availability_status !== "ok" || row.metric_value === null) continue;
    if (beforeIso && row.collected_at > beforeIso) continue;
    if (strictBeforeIso && row.collected_at >= strictBeforeIso) continue;
    if (!best || row.collected_at >= best.collected_at) best = row;
  }
  return best;
}

// ---- totals (§2, §7) --------------------------------------------------------------

export type TotalBasis = "range_activity" | "counter_delta" | "lifetime_counter" | "gauge" | "daily_activity";

export interface MetricTotal {
  metricKey: string;
  displayName: string;
  unit: string;
  value: number | null;
  previousValue: number | null;
  delta: number | null;
  pctChange: number | null;
  basis: TotalBasis | null;
  availability: "ok" | "partial" | "unavailable";
  note: string | null;
  lastUpdated: string | null;
}

const CORE_TOTAL_METRICS = ["views", "reach", "likes", "comments", "shares", "saves", "watch_time_seconds", "avg_watch_time_seconds", "followers", "total_interactions"];

function pctChangeOf(value: number | null, previous: number | null): number | null {
  if (value === null || previous === null || previous === 0) return null;
  return ((value - previous) / Math.abs(previous)) * 100;
}

/**
 * Totals for one platform (or all platforms when `platform` is null —
 * computed per platform then summed ONLY within the same metric;
 * views/reach stay separate metrics throughout).
 */
export function metricTotals(userId: string, range: DateRange, opts: { platform?: Platform | null; accountId?: string } = {}): MetricTotal[] {
  const platforms: Platform[] = opts.platform ? [opts.platform] : ["youtube", "instagram", "tiktok"];
  const endIso = `${range.to}T23:59:59.999Z`;
  const startIso = `${range.from}T00:00:00.000Z`;
  const prev = previousRange(range);
  const prevEndIso = `${prev.to}T23:59:59.999Z`;
  const prevStartIso = `${prev.from}T00:00:00.000Z`;
  const totals: MetricTotal[] = [];

  for (const metricKey of CORE_TOTAL_METRICS) {
    let value: number | null = null;
    let previousValue: number | null = null;
    let basis: TotalBasis | null = null;
    let anyData = false;
    let platformsWithData = 0;
    let corrections = 0;
    let lastUpdated: string | null = null;

    for (const platform of platforms) {
      const rows = valueRows(userId, { platform, accountId: opts.accountId, metricKey });
      if (rows.length === 0) continue;
      const okRows = rows.filter((r) => r.availability_status === "ok" && r.metric_value !== null);
      for (const r of okRows) {
        if (!lastUpdated || r.collected_at > lastUpdated) lastUpdated = r.collected_at;
      }
      const def = definitionFor(platform, metricKey);
      const isGauge = def?.kind === "gauge" || metricKey === "followers";

      if (isGauge) {
        const cur = latestOk(rows, endIso, null);
        const prevRow = latestOk(rows, null, startIso);
        if (cur) {
          anyData = true;
          platformsWithData += 1;
          basis = "gauge";
          value = (value ?? 0) + (cur.metric_value as number);
          if (prevRow) previousValue = (previousValue ?? 0) + (prevRow.metric_value as number);
        }
        continue;
      }

      // (a) date-scoped range activity recorded for exactly this range.
      const rangeRows = okRows.filter((r) => r.kind === "range_activity" && r.range_start === range.from && r.range_end === range.to);
      const prevRangeRows = okRows.filter((r) => r.kind === "range_activity" && r.range_start === prev.from && r.range_end === prev.to);
      if (rangeRows.length > 0) {
        anyData = true;
        platformsWithData += 1;
        basis = "range_activity";
        value = (value ?? 0) + rangeRows.reduce((s, r) => s + (r.metric_value as number), 0);
        if (prevRangeRows.length > 0) {
          previousValue = (previousValue ?? 0) + prevRangeRows.reduce((s, r) => s + (r.metric_value as number), 0);
        }
        continue;
      }

      // (b) daily activity inside the range (account-level series).
      const dailyRows = okRows.filter((r) => r.kind === "daily_activity" && r.range_start !== null && r.range_start >= range.from && (r.range_end ?? r.range_start) <= range.to);
      const prevDailyRows = okRows.filter((r) => r.kind === "daily_activity" && r.range_start !== null && r.range_start >= prev.from && (r.range_end ?? r.range_start) <= prev.to);
      if (dailyRows.length > 0 && metricKey !== "avg_watch_time_seconds") {
        anyData = true;
        platformsWithData += 1;
        if (basis === null) basis = "daily_activity";
        value = (value ?? 0) + dailyRows.reduce((s, r) => s + (r.metric_value as number), 0);
        if (prevDailyRows.length > 0) {
          previousValue = (previousValue ?? 0) + prevDailyRows.reduce((s, r) => s + (r.metric_value as number), 0);
        }
        continue;
      }

      // (c) cumulative counters: delta between the latest snapshot at
      // or before the range end and the latest before the range start.
      // (avg watch time is excluded — it is not cumulative; see (d).)
      const counterRows = metricKey === "avg_watch_time_seconds"
        ? []
        : okRows.filter((r) => r.kind === "lifetime_counter" && r.scope === "post");
      if (counterRows.length > 0) {
        const byPost = new Map<string, AnalyticsMetricValueRow[]>();
        for (const r of counterRows) {
          const key = r.platform_post_id ?? "";
          if (!byPost.has(key)) byPost.set(key, []);
          byPost.get(key)!.push(r);
        }
        let platformValue = 0;
        let platformPrevDelta = 0;
        let postsWithBaseline = 0;
        let postsWithoutBaseline = 0;
        let platformCorrections = 0;
        for (const postRows of byPost.values()) {
          const cur = latestOk(postRows, endIso, null);
          if (!cur) continue;
          const baseline = latestOk(postRows, null, startIso);
          const prevBaseline = latestOk(postRows, null, prevStartIso);
          const prevCur = latestOk(postRows, prevEndIso, null);
          if (baseline) {
            postsWithBaseline += 1;
            const rawDelta = (cur.metric_value as number) - (baseline.metric_value as number);
            if (rawDelta < 0) { platformCorrections += 1; corrections += 1; }
            platformValue += Math.max(0, rawDelta);
            if (prevCur && prevBaseline) {
              const rawPrev = (prevCur.metric_value as number) - (prevBaseline.metric_value as number);
              platformPrevDelta += Math.max(0, rawPrev);
            }
          } else {
            postsWithoutBaseline += 1;
            platformValue += cur.metric_value as number;
          }
        }
        if (postsWithBaseline + postsWithoutBaseline > 0) {
          anyData = true;
          platformsWithData += 1;
          basis = postsWithoutBaseline > 0 && postsWithBaseline === 0 ? "lifetime_counter" : "counter_delta";
          value = (value ?? 0) + platformValue;
          if (postsWithBaseline > 0) previousValue = (previousValue ?? 0) + platformPrevDelta;
          void platformCorrections; // per-post corrections already folded into `corrections` above
        }
        continue;
      }

      // (d) avg watch time: report the latest recorded average, which
      // is a per-view figure — summing or delta-ing it is meaningless.
      if (metricKey === "avg_watch_time_seconds") {
        const cur = latestOk(okRows, endIso, null);
        if (cur) {
          anyData = true;
          platformsWithData += 1;
          basis = "lifetime_counter";
          // Weighted reporting across platforms is not attempted; the
          // single-platform value is used, multi-platform stays null
          // with a note rather than an invented blend.
          value = platforms.length === 1 ? (cur.metric_value as number) : value;
        }
      }
    }

    const def = definitionFor(platforms[0], metricKey) ?? METRIC_DEFINITIONS.find((d) => d.key === metricKey);
    let note: string | null = null;
    if (basis === "lifetime_counter" && metricKey !== "avg_watch_time_seconds") {
      note = "No snapshot exists before this period, so this is the lifetime counter to date, not period activity.";
    }
    if (corrections > 0) {
      note = `${note ? `${note} ` : ""}${corrections} platform counter correction(s) were observed (a cumulative counter decreased); corrections contribute 0 growth, never negative growth.`;
    }
    if (metricKey === "avg_watch_time_seconds" && platforms.length > 1 && anyData) {
      note = "Average watch time is a per-view figure reported per platform in the comparison section; it is not blended across platforms.";
    }
    totals.push({
      metricKey,
      displayName: def?.displayName ?? metricKey,
      unit: def?.unit ?? "count",
      value: anyData ? value : null,
      previousValue: anyData ? previousValue : null,
      delta: value !== null && previousValue !== null ? value - previousValue : null,
      pctChange: pctChangeOf(value, previousValue),
      basis: anyData ? basis : null,
      availability: !anyData ? "unavailable" : platformsWithData >= platforms.length ? "ok" : "partial",
      note,
      lastUpdated,
    });
  }
  return totals;
}

// ---- engagement (§10) -------------------------------------------------------------

export interface EngagementResult {
  formula: "by_reach" | "by_views";
  formulaText: string;
  value: number | null; // percent
  availability: "ok" | "unavailable";
  reason: string | null;
  componentsUsed: string[];
  componentsMissing: string[];
  denominator: number | null;
  numerator: number | null;
}

/** Components a platform can actually expose (capability truth, not
 *  hope): YouTube has no saves; TikTok has no saves; reach exists
 *  only where the platform reports it. */
export const PLATFORM_ENGAGEMENT_COMPONENTS: Record<Platform, string[]> = {
  youtube: ["likes", "comments", "shares"],
  instagram: ["likes", "comments", "shares", "saves"],
  tiktok: ["likes", "comments", "shares"],
};

export function engagementFromComponents(
  formula: "by_reach" | "by_views",
  components: Record<string, number | null>,
  allowedComponents: string[],
): EngagementResult {
  const denominatorKey = formula === "by_reach" ? "reach" : "views";
  const used: string[] = [];
  const missing: string[] = [];
  let numerator = 0;
  for (const key of allowedComponents) {
    const v = components[key];
    if (v === null || v === undefined) missing.push(key);
    else { used.push(key); numerator += v; }
  }
  const denominator = components[denominatorKey] ?? null;
  const names = used.map((k) => k[0].toUpperCase() + k.slice(1)).join(" + ") || "—";
  const formulaText = `(${names}) / ${denominatorKey === "reach" ? "Reach" : "Views"} × 100`;
  if (missing.length > 0) {
    return {
      formula, formulaText, value: null, availability: "unavailable",
      reason: `Missing component(s): ${missing.join(", ")}. Engagement is not estimated from partial data.`,
      componentsUsed: used, componentsMissing: missing, denominator, numerator: null,
    };
  }
  if (denominator === null) {
    return {
      formula, formulaText, value: null, availability: "unavailable",
      reason: `${denominatorKey === "reach" ? "Reach" : "Views"} is unavailable for this selection, so the rate cannot be calculated. ${denominatorKey === "reach" ? "Views are never silently substituted for reach." : ""}`.trim(),
      componentsUsed: used, componentsMissing: [denominatorKey], denominator: null, numerator,
    };
  }
  if (denominator === 0) {
    return {
      formula, formulaText, value: null, availability: "unavailable",
      reason: `${denominatorKey === "reach" ? "Reach" : "Views"} is zero — division by zero is reported as N/A, never as 0% or infinity.`,
      componentsUsed: used, componentsMissing: [], denominator: 0, numerator,
    };
  }
  return {
    formula, formulaText, value: (numerator / denominator) * 100, availability: "ok",
    reason: null, componentsUsed: used, componentsMissing: [], denominator, numerator,
  };
}

/** Engagement for a totals set (overview / comparison). */
export function engagementForTotals(
  totals: MetricTotal[],
  formula: "by_reach" | "by_views",
  platform: Platform,
): EngagementResult {
  const byKey = new Map(totals.map((t) => [t.metricKey, t.value]));
  const components: Record<string, number | null> = {
    likes: byKey.get("likes") ?? null,
    comments: byKey.get("comments") ?? null,
    shares: byKey.get("shares") ?? null,
    saves: byKey.get("saves") ?? null,
    reach: byKey.get("reach") ?? null,
    views: byKey.get("views") ?? null,
  };
  return engagementFromComponents(formula, components, PLATFORM_ENGAGEMENT_COMPONENTS[platform]);
}

// ---- posts -------------------------------------------------------------------------

export interface PostContext {
  post: PlatformPostRow;
  job: PublishJobRow | null;
  title: string;
  publishedAt: string | null;
  projectId: string | null;
  clipId: string | null;
  account: PlatformAccountRow | null;
}

export function postContext(userId: string, platformPostId: string): PostContext | null {
  const db = getDb();
  const post = db.prepare("SELECT * FROM platform_posts WHERE id = ? AND user_id = ?").get(platformPostId, userId) as unknown as PlatformPostRow | undefined;
  if (!post) return null;
  return postContextForRow(post);
}

export function postContextForRow(post: PlatformPostRow): PostContext {
  const db = getDb();
  const job = db.prepare("SELECT * FROM publish_jobs WHERE id = ?").get(post.job_id) as unknown as PublishJobRow | undefined;
  let title = "";
  if (job) {
    const meta = db.prepare("SELECT metadata_json FROM post_metadata WHERE job_id = ?").get(job.id) as { metadata_json: string } | undefined;
    const parsed = parseJson<Record<string, unknown>>(meta?.metadata_json, {});
    title = String(parsed.title ?? parsed.caption ?? "");
  }
  const account = db.prepare("SELECT * FROM platform_accounts WHERE id = ?").get(post.account_id) as unknown as PlatformAccountRow | undefined;
  return {
    post,
    job: job ?? null,
    title,
    publishedAt: job?.published_at ?? post.created_at,
    projectId: job?.project_id ?? null,
    clipId: job?.clip_id ?? null,
    account: account ?? null,
  };
}

export function userPosts(userId: string, filter: { platform?: Platform; accountId?: string; projectId?: string } = {}): PostContext[] {
  const clauses = ["pp.user_id = ?"];
  const args: unknown[] = [userId];
  if (filter.platform) { clauses.push("pp.platform = ?"); args.push(filter.platform); }
  if (filter.accountId) { clauses.push("pp.account_id = ?"); args.push(filter.accountId); }
  if (filter.projectId) { clauses.push("j.project_id = ?"); args.push(filter.projectId); }
  const rows = getDb()
    .prepare(
      `SELECT pp.* FROM platform_posts pp
       LEFT JOIN publish_jobs j ON j.id = pp.job_id
       WHERE ${clauses.join(" AND ")} ORDER BY pp.created_at DESC`,
    )
    .all(...(args as never[])) as unknown as PlatformPostRow[];
  return rows.map(postContextForRow);
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

/** Latest value per metric for one post. Preference order:
 *  lifetime_counter (current cumulative truth) → range_activity →
 *  daily_activity. Unavailable rows surface when no ok row exists. */
export function latestPostMetrics(userId: string, platformPostId: string): Record<string, LatestMetric> {
  const rows = getDb()
    .prepare("SELECT * FROM analytics_metric_values WHERE user_id = ? AND platform_post_id = ? AND scope = 'post' ORDER BY collected_at ASC")
    .all(userId, platformPostId) as unknown as AnalyticsMetricValueRow[];
  const byMetric = new Map<string, AnalyticsMetricValueRow[]>();
  for (const row of rows) {
    if (!byMetric.has(row.metric_key)) byMetric.set(row.metric_key, []);
    byMetric.get(row.metric_key)!.push(row);
  }
  const kindRank = (kind: string): number => (kind === "lifetime_counter" ? 0 : kind === "range_activity" ? 1 : 2);
  const out: Record<string, LatestMetric> = {};
  for (const [key, list] of byMetric) {
    const ok = list.filter((r) => r.availability_status === "ok" && r.metric_value !== null)
      .sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || (a.collected_at < b.collected_at ? 1 : -1));
    if (ok.length > 0) {
      const r = ok[0];
      out[key] = {
        value: r.metric_value, availability: "ok", reason: null, kind: r.kind, source: r.source,
        collectedAt: r.collected_at, rangeStart: r.range_start, rangeEnd: r.range_end,
        correctionFlag: r.correction_flag === 1,
      };
    } else {
      const r = list[list.length - 1];
      out[key] = {
        value: null, availability: r.availability_status, reason: r.availability_reason, kind: r.kind,
        source: r.source, collectedAt: r.collected_at, rangeStart: r.range_start, rangeEnd: r.range_end,
        correctionFlag: false,
      };
    }
  }
  return out;
}

export function postEngagement(ctx: PostContext, metrics: Record<string, LatestMetric>, formula: "by_reach" | "by_views"): EngagementResult {
  const platform = ctx.post.platform as Platform;
  const get = (k: string): number | null => (metrics[k]?.availability === "ok" ? metrics[k].value : null);
  return engagementFromComponents(formula, {
    likes: get("likes"), comments: get("comments"), shares: get("shares"), saves: get("saves"),
    reach: get("reach"), views: get("views"),
  }, PLATFORM_ENGAGEMENT_COMPONENTS[platform]);
}

export interface PostSummary {
  id: string;
  platform: Platform;
  platformPostId: string;
  url: string | null;
  /** Owner-checked URL of the publish job's stored custom thumbnail
   *  (§8 "actual video thumbnail"), or null when the job stored none.
   *  The image itself is the file the user uploaded in Phase 10 —
   *  never a fabricated stand-in. */
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

export function summarizePost(ctx: PostContext): PostSummary {
  const metrics = latestPostMetrics(ctx.post.user_id, ctx.post.id);
  let lastSyncedAt: string | null = null;
  for (const m of Object.values(metrics)) {
    if (m.collectedAt && (!lastSyncedAt || m.collectedAt > lastSyncedAt)) lastSyncedAt = m.collectedAt;
  }
  // F10: the thumbnail reference comes from the publish job's stored
  // post_metadata.thumbnail_storage_key (read-only join — no schema
  // change). The file is served by the owner-checked analytics route.
  let thumbnailUrl: string | null = null;
  if (ctx.job) {
    const meta = getDb()
      .prepare("SELECT thumbnail_storage_key FROM post_metadata WHERE job_id = ?")
      .get(ctx.job.id) as { thumbnail_storage_key: string | null } | undefined;
    if (meta?.thumbnail_storage_key) {
      thumbnailUrl = `/api/analytics/posts/${ctx.post.id}/thumbnail`;
    }
  }
  return {
    id: ctx.post.id,
    platform: ctx.post.platform as Platform,
    platformPostId: ctx.post.platform_post_id,
    url: ctx.post.url,
    thumbnailUrl,
    title: ctx.title,
    publishedAt: ctx.publishedAt,
    accountId: ctx.post.account_id,
    accountUsername: ctx.account?.username ?? null,
    projectId: ctx.projectId,
    clipId: ctx.clipId,
    metrics,
    engagementByReach: postEngagement(ctx, metrics, "by_reach"),
    engagementByViews: postEngagement(ctx, metrics, "by_views"),
    lastSyncedAt,
  };
}

// ---- trends (§11) -------------------------------------------------------------------

export interface TrendPoint { date: string; value: number }
export interface TrendSeries {
  metricKey: string;
  displayName: string;
  unit: string;
  granularity: "day" | "week" | "month";
  points: TrendPoint[];
  sources: string[];
  basis: string;
  lastUpdated: string | null;
}

function bucketKey(date: string, granularity: "day" | "week" | "month"): string {
  if (granularity === "day") return date;
  if (granularity === "month") return date.slice(0, 7);
  // ISO week bucket: the Monday of the week containing `date`.
  const d = new Date(`${date}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

/**
 * Trend points come ONLY from saved records:
 *  1. daily_activity rows (account series) inside the range, and
 *  2. for cumulative post counters, the per-day delta between
 *     consecutive snapshots (assigned to the later snapshot's day) —
 *     this is how TikTok / lifetime-counter trends accrue honestly
 *     from CLIPFORGE's own snapshots (§9).
 * Days with no record are omitted — never zero-filled, never invented.
 */
export function trendSeries(
  userId: string,
  metricKey: string,
  range: DateRange,
  granularity: "day" | "week" | "month",
  filter: { platform?: Platform; accountId?: string; postId?: string } = {},
): TrendSeries {
  const rows = valueRows(userId, { platform: filter.platform, accountId: filter.accountId, metricKey });
  const scoped = filter.postId ? rows.filter((r) => r.platform_post_id === filter.postId) : rows;
  const perDay = new Map<string, number>();
  const sources = new Set<string>();
  let lastUpdated: string | null = null;
  const note = (r: AnalyticsMetricValueRow) => {
    sources.add(r.source);
    if (!lastUpdated || r.collected_at > lastUpdated) lastUpdated = r.collected_at;
  };

  const daily = scoped.filter((r) => r.kind === "daily_activity" && r.availability_status === "ok" && r.metric_value !== null && !filter.postId);
  for (const r of daily) {
    const day = r.range_start;
    if (!day || day < range.from || day > range.to) continue;
    perDay.set(day, (perDay.get(day) ?? 0) + (r.metric_value as number));
    note(r);
  }

  // Counter deltas per post between consecutive lifetime snapshots.
  const counters = scoped.filter((r) => r.kind === "lifetime_counter" && r.scope === "post" && r.availability_status === "ok" && r.metric_value !== null);
  const byPost = new Map<string, AnalyticsMetricValueRow[]>();
  for (const r of counters) {
    const key = r.platform_post_id ?? "";
    if (!byPost.has(key)) byPost.set(key, []);
    byPost.get(key)!.push(r);
  }
  for (const list of byPost.values()) {
    const sorted = [...list].sort((a, b) => (a.collected_at < b.collected_at ? -1 : 1));
    for (let i = 1; i < sorted.length; i += 1) {
      const day = dateOf(sorted[i].collected_at);
      if (day < range.from || day > range.to) continue;
      const delta = (sorted[i].metric_value as number) - (sorted[i - 1].metric_value as number);
      perDay.set(day, (perDay.get(day) ?? 0) + Math.max(0, delta)); // corrections never negative growth (§9)
      note(sorted[i]);
    }
  }

  const bucketed = new Map<string, number>();
  for (const [day, value] of perDay) {
    const key = bucketKey(day, granularity);
    bucketed.set(key, (bucketed.get(key) ?? 0) + value);
  }
  const points = [...bucketed.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, value]) => ({ date, value }));
  const def = METRIC_DEFINITIONS.find((d) => d.key === metricKey);
  return {
    metricKey,
    displayName: def?.displayName ?? metricKey,
    unit: def?.unit ?? "count",
    granularity,
    points,
    sources: [...sources],
    basis: daily.length > 0 && byPost.size > 0
      ? "Daily provider activity plus snapshot deltas of cumulative counters."
      : daily.length > 0
        ? "Daily provider activity records."
        : "Snapshot deltas of cumulative counters collected by CLIPFORGE syncs.",
    lastUpdated,
  };
}

/** Publishing frequency + follower gauge series for §11. */
export function publishingFrequency(userId: string, range: DateRange, granularity: "day" | "week" | "month", filter: { platform?: Platform } = {}): TrendPoint[] {
  const clauses = ["user_id = ?", "published_at IS NOT NULL", "published_at >= ?", "published_at <= ?"];
  const args: unknown[] = [userId, `${range.from}T00:00:00Z`, `${range.to}T23:59:59Z`];
  if (filter.platform) { clauses.push("platform = ?"); args.push(filter.platform); }
  const rows = getDb()
    .prepare(`SELECT published_at FROM publish_jobs WHERE ${clauses.join(" AND ")} AND status = 'PUBLISHED'`)
    .all(...(args as never[])) as unknown as { published_at: string }[];
  const buckets = new Map<string, number>();
  for (const row of rows) {
    const key = bucketKey(dateOf(row.published_at), granularity);
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  return [...buckets.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, value]) => ({ date, value }));
}

export function followerSeries(userId: string, range: DateRange, filter: { platform?: Platform; accountId?: string } = {}): TrendPoint[] {
  const rows = valueRows(userId, { platform: filter.platform, accountId: filter.accountId, metricKey: "followers", scope: "account" })
    .filter((r) => r.availability_status === "ok" && r.metric_value !== null);
  const perDay = new Map<string, number>();
  for (const r of rows) {
    const day = dateOf(r.collected_at);
    if (day < range.from || day > range.to) continue;
    perDay.set(day, r.metric_value as number); // gauge: last snapshot of the day wins
  }
  return [...perDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, value]) => ({ date, value }));
}
