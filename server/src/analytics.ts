// CLIPFORGE API — Phase 11: Analytics Dashboard & Performance
// Intelligence.
//
// What is REAL here:
//  - Capability detection per connected account (§6): granted
//    scopes + account type are checked BEFORE any provider request;
//    every metric a platform cannot supply is stored and displayed
//    as unavailable — never zero, never invented.
//  - Persistent snapshots (§9) with full provenance (§19), collected
//    from the official analytics surfaces via analyticsProviders.ts.
//  - A DB-backed sync worker on the project's established pattern
//    (atomic conditional-UPDATE claims, boot recovery, persisted
//    §18 states, bounded retries with exponential backoff for safe
//    failures only).
//  - Transparent engagement formulas (§10), trends built only from
//    saved records (§11), rule-based insights whose every claim
//    carries its evidence (§14 — deterministic analysis over stored
//    data; no external AI API exists in this environment, and no
//    insight invents an explanation or predicts virality).
//  - Report generation in the background worker (§16).
//
// What is NOT possible in this environment, said plainly:
//  - No provider credentials exist here, so no live account can be
//    connected and the §22 real-account acceptance items stay
//    "credentials pending". Tests run the real code against a
//    clearly-labelled LOCAL MOCK analytics provider.

import fs from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import type { SQLInputValue } from "node:sqlite";
import { z } from "zod";
import { config, publishingProviderStatus } from "./config.js";
import {
  getDb,
  type AnalyticsCapabilityRow,
  type AnalyticsInsightRow,
  type AnalyticsReportRow,
  type AnalyticsSyncJobRow,
  type PlatformAccountRow,
  type PlatformPostRow,
  type UserRow,
} from "./db.js";
import {
  classifyKind,
  detectCapabilities,
  fetchAccountAnalytics,
  fetchPostAnalytics,
  API_VERSIONS,
  METRIC_DEFINITIONS,
  type FetchedMetric,
  type PostRef,
} from "./analyticsProviders.js";
import { mediaPath } from "./media.js";
import type { StoredTokens } from "./tokenCrypto.js";
import { recordUsage } from "./accountCore.js";

const METRIC_DEF_BY_KEY = new Map<string, { unit: string; definition: string; kind: string }>();
for (const d of METRIC_DEFINITIONS) {
  METRIC_DEF_BY_KEY.set(`${d.platform}:${d.key}`, { unit: d.unit, definition: d.definition, kind: d.kind });
}
import {
  addDays,
  dateOf,
  engagementForTotals,
  followerSeries,
  latestPostMetrics,
  metricTotals,
  nowIso,
  newId,
  parseJson,
  postContext,
  postContextForRow,
  previousRange,
  publishingFrequency,
  rangeDays,
  seedMetricDefinitions,
  summarizePost,
  trendSeries,
  userPosts,
  validDate,
  type DateRange,
  type PostContext,
} from "./analyticsCore.js";
import { normalizeReportConfig, processOneQueuedReport, recoverInterruptedReports } from "./analyticsReports.js";
import {
  ensureFreshTokens,
  loadTokens,
  markAccountAuthRequired,
  ownedAccount,
} from "./publishing.js";
import { isPlatform, ProviderError, type Platform } from "./providers.js";

// ---- shared helpers -----------------------------------------------------------

interface AuthedRequest extends Request {
  user?: UserRow;
}
type RequireAuth = (req: AuthedRequest, res: Response, next: NextFunction) => void;

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

function audit(userId: string, action: string, detail: Record<string, unknown>): void {
  try {
    getDb()
      .prepare("INSERT INTO analytics_audit_log (id, user_id, action, detail_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(newId(), userId, action, JSON.stringify(detail), nowIso());
  } catch {
    /* audit must never break the flow it describes */
  }
}

function parseRange(req: AuthedRequest): DateRange {
  const today = dateOf(nowIso());
  const from = validDate(req.query.from) ? (req.query.from as string) : addDays(today, -29);
  const to = validDate(req.query.to) ? (req.query.to as string) : today;
  return from <= to ? { from, to } : { from: to, to: from };
}

function platformFilter(req: AuthedRequest): Platform | undefined {
  const p = typeof req.query.platform === "string" ? req.query.platform : "";
  return isPlatform(p) ? p : undefined;
}

// ---- capabilities (§6) ----------------------------------------------------------

function storeCapabilities(account: PlatformAccountRow): AnalyticsCapabilityRow {
  const db = getDb();
  const scopes = parseJson<string[]>(account.granted_scopes_json, []);
  const caps = detectCapabilities(account.platform as Platform, scopes, account.account_type);
  const existing = db.prepare("SELECT * FROM analytics_capabilities WHERE account_id = ?").get(account.id) as unknown as AnalyticsCapabilityRow | undefined;
  const now = nowIso();
  if (existing) {
    db.prepare(
      `UPDATE analytics_capabilities SET endpoints_json = ?, metrics_json = ?, dimensions_json = ?,
       required_permissions_json = ?, limitations_json = ?, supported_range_json = ?, api_version = ?,
       last_capability_check_at = ?, updated_at = ? WHERE id = ?`,
    ).run(
      JSON.stringify(caps.endpoints), JSON.stringify(caps.metrics), JSON.stringify(caps.dimensions),
      JSON.stringify(caps.requiredPermissions), JSON.stringify(caps.limitations),
      JSON.stringify(caps.supportedRange), caps.apiVersion, now, now, existing.id,
    );
    // Return the row AS STORED — the caller must see the capabilities
    // this check just computed, not the previous check's.
    return db.prepare("SELECT * FROM analytics_capabilities WHERE id = ?").get(existing.id) as unknown as AnalyticsCapabilityRow;
  }
  const row: AnalyticsCapabilityRow = {
    id: newId(), user_id: account.user_id, account_id: account.id, platform: account.platform,
    endpoints_json: JSON.stringify(caps.endpoints), metrics_json: JSON.stringify(caps.metrics),
    dimensions_json: JSON.stringify(caps.dimensions), required_permissions_json: JSON.stringify(caps.requiredPermissions),
    limitations_json: JSON.stringify(caps.limitations), supported_range_json: JSON.stringify(caps.supportedRange),
    api_version: caps.apiVersion, last_capability_check_at: now, last_successful_retrieval_at: null,
    created_at: now, updated_at: now,
  };
  db.prepare(
    `INSERT INTO analytics_capabilities (id, user_id, account_id, platform, endpoints_json, metrics_json, dimensions_json,
     required_permissions_json, limitations_json, supported_range_json, api_version, last_capability_check_at,
     last_successful_retrieval_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.user_id, row.account_id, row.platform, row.endpoints_json, row.metrics_json, row.dimensions_json,
    row.required_permissions_json, row.limitations_json, row.supported_range_json, row.api_version,
    row.last_capability_check_at, row.last_successful_retrieval_at, row.created_at, row.updated_at);
  return row;
}

function publicCapability(row: AnalyticsCapabilityRow) {
  return {
    accountId: row.account_id,
    platform: row.platform,
    apiVersion: row.api_version,
    endpoints: parseJson(row.endpoints_json, []),
    metrics: parseJson(row.metrics_json, []),
    dimensions: parseJson(row.dimensions_json, []),
    requiredPermissions: parseJson(row.required_permissions_json, []),
    limitations: parseJson(row.limitations_json, []),
    supportedRange: parseJson(row.supported_range_json, {}),
    lastCapabilityCheckAt: row.last_capability_check_at,
    lastSuccessfulRetrievalAt: row.last_successful_retrieval_at,
  };
}

// ---- sync engine (§17, §18) -------------------------------------------------------

const ACTIVE_SYNC_STATUSES = [
  "QUEUED", "VALIDATING_ACCOUNT", "FETCHING_ACCOUNT_DATA", "FETCHING_POST_DATA",
  "FETCHING_METRICS", "NORMALIZING_DATA", "SAVING_SNAPSHOTS",
];
const WORKER_ID = `analytics-worker-${process.pid}-${Date.now()}`;

interface CreateSyncInput {
  accountId?: string;
  platform?: Platform;
  all?: boolean;
  postId?: string; // platform_posts.id
  from?: string;
  to?: string;
  source?: string;
}

function defaultSyncRange(): DateRange {
  const today = dateOf(nowIso());
  return { from: addDays(today, -89), to: today };
}

function findActiveDuplicate(userId: string, input: CreateSyncInput): AnalyticsSyncJobRow | undefined {
  const rows = getDb()
    .prepare(
      `SELECT * FROM analytics_sync_jobs WHERE user_id = ? AND status IN (${ACTIVE_SYNC_STATUSES.map(() => "?").join(",")}) ORDER BY created_at ASC`,
    )
    .all(userId, ...ACTIVE_SYNC_STATUSES) as unknown as AnalyticsSyncJobRow[];
  return rows.find((job) => {
    if (input.postId) return job.scope === "post" && job.platform_post_id === input.postId;
    if (input.accountId) return job.scope === "account" && job.account_id === input.accountId;
    if (input.platform) return (job.scope === "platform" && job.platform === input.platform) || job.scope === "all";
    return job.scope === "all" || job.scope === "platform" || job.scope === "account";
  });
}

export function createSyncJob(userId: string, input: CreateSyncInput): { job: AnalyticsSyncJobRow; deduplicated: boolean } {
  const duplicate = findActiveDuplicate(userId, input);
  if (duplicate) return { job: duplicate, deduplicated: true };
  const range = input.from && input.to && validDate(input.from) && validDate(input.to)
    ? { from: input.from, to: input.to }
    : defaultSyncRange();
  const now = nowIso();
  const row: AnalyticsSyncJobRow = {
    id: newId(),
    user_id: userId,
    account_id: input.accountId ?? null,
    platform: input.platform ?? null,
    scope: input.postId ? "post" : input.accountId ? "account" : input.platform ? "platform" : "all",
    platform_post_id: input.postId ?? null,
    range_start: range.from,
    range_end: range.to,
    status: "QUEUED",
    attempt_count: 0,
    max_attempts: config.analytics.maxSyncAttempts,
    next_attempt_at: null,
    progress_json: null,
    error: null,
    error_code: null,
    error_class: null,
    source: input.source ?? "manual",
    worker_id: null,
    created_at: now,
    updated_at: now,
    started_at: null,
    finished_at: null,
  };
  getDb()
    .prepare(
      `INSERT INTO analytics_sync_jobs (id, user_id, account_id, platform, scope, platform_post_id, range_start, range_end,
       status, attempt_count, max_attempts, next_attempt_at, progress_json, error, error_code, error_class, source,
       worker_id, created_at, updated_at, started_at, finished_at)
       VALUES (@id, @user_id, @account_id, @platform, @scope, @platform_post_id, @range_start, @range_end,
       @status, @attempt_count, @max_attempts, @next_attempt_at, @progress_json, @error, @error_code, @error_class, @source,
       @worker_id, @created_at, @updated_at, @started_at, @finished_at)`,
    )
    .run(row as unknown as Record<string, SQLInputValue>);
  audit(userId, "sync_created", { jobId: row.id, scope: row.scope, accountId: row.account_id, platform: row.platform, postId: row.platform_post_id });
  return { job: row, deduplicated: false };
}

function setSyncStatus(jobId: string, status: string, patch: Partial<AnalyticsSyncJobRow> = {}): void {
  const sets = ["status = @status", "updated_at = @updated_at"];
  const params: Record<string, SQLInputValue> = { status, updated_at: nowIso(), id: jobId };
  for (const [k, v] of Object.entries(patch)) {
    sets.push(`${k} = @${k}`);
    params[k] = v as SQLInputValue;
  }
  getDb().prepare(`UPDATE analytics_sync_jobs SET ${sets.join(", ")} WHERE id = @id`).run(params);
}

function setSyncProgress(jobId: string, progress: Record<string, unknown>): void {
  getDb().prepare("UPDATE analytics_sync_jobs SET progress_json = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(progress), nowIso(), jobId);
}

/** Phase 12 (§9): terminal sync outcomes feed the usage ledger —
 *  recorded ONLY when a job reaches a terminal state, never at
 *  queue/request time and never for a retry requeue. Quantity is the
 *  real work done (metrics actually saved across the job's accounts);
 *  failed outcomes record quantity 0, mirroring the analysis engine's
 *  failed-job pattern. The deterministic idempotency key
 *  (operation:jobId:outcome) makes any double-completion path record
 *  exactly one row per outcome. */
function recordSyncUsage(job: AnalyticsSyncJobRow, outcome: "completed" | "partial" | "failed", metricsSaved: number): void {
  recordUsage(getDb(), {
    userId: job.user_id,
    operation: "analytics_sync",
    resource: "analytics_sync_job",
    quantity: outcome === "failed" ? 0 : metricsSaved,
    unit: "metrics",
    idempotencyKey: `analytics_sync:${job.id}:${outcome}`,
    jobId: job.id,
    provider: job.platform ?? undefined,
    status: outcome === "failed" ? "FAILED" : outcome === "partial" ? "PARTIAL_SUCCESS" : "COMPLETED",
  });
}

interface AccountSyncOutcome {
  accountId: string;
  outcome: "ok" | "partial" | "auth_required" | "failed";
  error?: string;
  errorCode?: string;
  metricsSaved: number;
  postsSynced: number;
  /** Non-error limitations recorded for this account (e.g. the F5
   *  supported-range clamp), surfaced in the job's progress. */
  notes: string[];
}

/** F6 — the genuine NORMALIZING_DATA stage. Every fetched row is
 *  re-classified by kind, numerically validated (a non-finite value
 *  becomes an explicit error row — never stored as a number), and
 *  de-duplicated on (scope, post, metric, range, source) keeping the
 *  LAST row, before anything reaches the snapshot tables. Rows for
 *  metrics with no stored definition are dropped and counted. */
function normalizeFetched(
  rows: FetchedMetric[],
  platform: Platform,
): { rows: FetchedMetric[]; fetched: number; duplicatesDropped: number; invalidFlagged: number; unknownDropped: number } {
  const byKey = new Map<string, FetchedMetric>();
  let duplicatesDropped = 0;
  let invalidFlagged = 0;
  let unknownDropped = 0;
  for (const raw of rows) {
    const m: FetchedMetric = { ...raw, kind: classifyKind(raw) };
    if (!METRIC_DEF_BY_KEY.has(`${platform}:${m.metricKey}`) && !METRIC_DEF_BY_KEY.has(`all:${m.metricKey}`)) {
      unknownDropped += 1;
      continue;
    }
    if (m.value !== null && (typeof m.value !== "number" || !Number.isFinite(m.value))) {
      m.value = null;
      m.availability = "error";
      m.reason = "The provider returned a non-numeric value for this metric; it was discarded during normalization rather than stored.";
      invalidFlagged += 1;
    }
    const key = [m.scope, m.postExternalId ?? "", m.metricKey, m.rangeStart ?? "", m.rangeEnd ?? "", m.source].join("|");
    if (byKey.has(key)) duplicatesDropped += 1;
    byKey.set(key, m); // identical scope/post/metric/range rows: the last one wins
  }
  return { rows: [...byKey.values()], fetched: rows.length, duplicatesDropped, invalidFlagged, unknownDropped };
}

async function syncOneAccount(job: AnalyticsSyncJobRow, account: PlatformAccountRow, onlyPostId: string | null): Promise<AccountSyncOutcome> {
  const db = getDb();
  const platform = account.platform as Platform;
  const base: AccountSyncOutcome = { accountId: account.id, outcome: "ok", metricsSaved: 0, postsSynced: 0, notes: [] };
  if (account.status === "AUTH_REQUIRED") {
    return { ...base, outcome: "auth_required", error: "This account needs reauthorization before analytics can be synced.", errorCode: "AUTH_REQUIRED" };
  }
  if (account.status === "DISCONNECTED") {
    return { ...base, outcome: "failed", error: "Account is disconnected.", errorCode: "ACCOUNT_DISCONNECTED" };
  }
  const providerStatus = publishingProviderStatus(platform);
  if (!providerStatus.configured) {
    return {
      ...base, outcome: "failed", errorCode: "CONFIGURATION_ERROR",
      error: `${platform} is not configured on this server. Missing environment variables: ${providerStatus.missing.join(", ")}. No request was sent to the platform.`,
    };
  }

  let tokens: StoredTokens;
  try {
    tokens = await ensureFreshTokens(account);
  } catch (err) {
    // A refresh failure while the stored access token is already
    // expired means the grant is gone (e.g. invalid_grant) — the
    // account needs reauthorization regardless of how the adapter
    // classified the HTTP error.
    const stored = loadTokens(account.id);
    const storedExpired = !stored || !stored.expiresAt || new Date(stored.expiresAt).getTime() <= Date.now();
    if (err instanceof ProviderError && (err.errorClass === "user_intervention" || err.code === "AUTH_REQUIRED" || storedExpired)) {
      markAccountAuthRequired(account.id);
      return { ...base, outcome: "auth_required", error: err.message, errorCode: err.code };
    }
    throw err;
  }

  // §6 steps 1–4 happen in detection BEFORE any metric request.
  const capsRow = storeCapabilities(account);
  const acctCtx = {
    platformAccountId: account.platform_account_id,
    username: account.username,
    accountType: account.account_type,
    grantedScopes: parseJson<string[]>(account.granted_scopes_json, []),
  };
  const range: DateRange = { from: job.range_start ?? defaultSyncRange().from, to: job.range_end ?? defaultSyncRange().to };

  // F5 — enforce the capability record's supported range BEFORE any
  // request: when the platform only returns a bounded window, the
  // effective fetch range is clamped to it and the truncation is
  // recorded (on this outcome and on the affected account rows)
  // instead of silently requesting history the platform cannot give.
  const capsStored = parseJson<{ maxDaysBack?: number }>(capsRow.supported_range_json, {});
  let effectiveRange = range;
  const rangeNotes: string[] = [];
  if (typeof capsStored.maxDaysBack === "number" && capsStored.maxDaysBack > 0) {
    const earliest = addDays(dateOf(nowIso()), -(capsStored.maxDaysBack - 1));
    if (range.from < earliest) {
      effectiveRange = { from: earliest, to: range.to };
      rangeNotes.push(
        `Fetch range clamped to ${platform}'s supported range: requested ${range.from} → ${range.to}, account data fetched for ${effectiveRange.from} → ${effectiveRange.to} — older history is outside the window the platform returns.`,
      );
    }
  }

  setSyncStatus(job.id, "FETCHING_ACCOUNT_DATA");
  let accountMetrics = onlyPostId ? [] : await fetchAccountAnalytics(platform, tokens.accessToken, acctCtx, effectiveRange.from, effectiveRange.to);
  if (rangeNotes.length > 0) {
    // The clamp is part of these rows' provenance: it is appended to
    // the availability reason of every affected account-level row.
    accountMetrics = accountMetrics.map((m) =>
      m.availability === "ok" ? m : { ...m, reason: [m.reason, rangeNotes[0]].filter(Boolean).join(" ") },
    );
  }

  setSyncStatus(job.id, "FETCHING_POST_DATA");
  const postRows = db
    .prepare("SELECT * FROM platform_posts WHERE user_id = ? AND account_id = ? ORDER BY created_at ASC")
    .all(job.user_id, account.id) as unknown as PlatformPostRow[];
  const targetPosts = onlyPostId ? postRows.filter((p) => p.id === onlyPostId) : postRows;
  const postRefs: PostRef[] = targetPosts.map((p) => {
    const ctx = postContextForRow(p);
    return { internalId: p.id, externalId: p.platform_post_id, publishedAt: ctx.publishedAt };
  });

  setSyncStatus(job.id, "FETCHING_METRICS");
  const postResult = await fetchPostAnalytics(platform, tokens.accessToken, acctCtx, postRefs, range.from, range.to);

  // F6 — NORMALIZING_DATA is a real stage, not a label: fetched rows
  // are kind-classified, numerically validated and de-duplicated
  // here, and only the normalized rows reach the snapshot tables.
  setSyncStatus(job.id, "NORMALIZING_DATA");
  const normAccount = normalizeFetched(accountMetrics, platform);
  const normPosts = normalizeFetched(postResult.metrics, platform);
  accountMetrics = normAccount.rows;
  postResult.metrics = normPosts.rows;
  setSyncProgress(job.id, {
    stage: "NORMALIZING_DATA",
    fetched: normAccount.fetched + normPosts.fetched,
    normalized: normAccount.rows.length + normPosts.rows.length,
    duplicatesDropped: normAccount.duplicatesDropped + normPosts.duplicatesDropped,
    invalidFlagged: normAccount.invalidFlagged + normPosts.invalidFlagged,
    unknownDropped: normAccount.unknownDropped + normPosts.unknownDropped,
  });

  setSyncStatus(job.id, "SAVING_SNAPSHOTS");
  const collectedAt = nowIso();
  const apiVersion = API_VERSIONS[platform];
  let metricsSaved = 0;
  let partial = false;

  // Previous lifetime values (for §9 correction flags), read BEFORE
  // this sync's rows land.
  const prevLifetime = new Map<string, number>();
  {
    const rows = db
      .prepare(
        `SELECT platform_post_id, metric_key, metric_value FROM analytics_metric_values
         WHERE user_id = ? AND account_id = ? AND scope = 'post' AND kind = 'lifetime_counter'
           AND availability_status = 'ok' AND metric_value IS NOT NULL ORDER BY collected_at ASC`,
      )
      .all(job.user_id, account.id) as unknown as { platform_post_id: string; metric_key: string; metric_value: number }[];
    for (const r of rows) prevLifetime.set(`${r.platform_post_id}:${r.metric_key}`, r.metric_value);
  }

  const insertValue = db.prepare(
    `INSERT INTO analytics_metric_values (id, user_id, platform, account_id, scope, snapshot_id, platform_post_id,
     internal_post_id, metric_key, metric_value, unit, definition, kind, range_start, range_end, collected_at,
     source, api_version, availability_status, availability_reason, correction_flag, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const saveMetric = (m: FetchedMetric, snapshotId: string, platformPostId: string | null, internalPostId: string | null): void => {
    const def = METRIC_DEF_BY_KEY.get(`${platform}:${m.metricKey}`) ?? METRIC_DEF_BY_KEY.get(`all:${m.metricKey}`);
    let correction = 0;
    if (m.availability === "ok" && m.value !== null && m.kind === "lifetime_counter" && platformPostId) {
      const prev = prevLifetime.get(`${platformPostId}:${m.metricKey}`);
      if (prev !== undefined && m.value < prev) correction = 1; // cumulative counter decreased = platform correction (§9)
    }
    insertValue.run(
      newId(), job.user_id, platform, account.id, m.scope, snapshotId, platformPostId, internalPostId,
      m.metricKey, m.value, def?.unit ?? "count", def?.definition ?? "", m.kind ?? def?.kind ?? "lifetime_counter",
      m.rangeStart, m.rangeEnd, collectedAt, m.source, apiVersion, m.availability, m.reason, correction, collectedAt,
    );
    metricsSaved += 1;
    if (m.availability === "error") partial = true;
  };

  db.exec("BEGIN IMMEDIATE");
  try {
    // Idempotency (§9/§17): a retried save stage replaces — never
    // duplicates — this job's earlier snapshot rows.
    const oldSnaps = db.prepare("SELECT id FROM analytics_account_snapshots WHERE sync_job_id = ?").all(job.id) as unknown as { id: string }[];
    const oldPostSnaps = db.prepare("SELECT id FROM analytics_post_snapshots WHERE sync_job_id = ?").all(job.id) as unknown as { id: string }[];
    for (const s of [...oldSnaps, ...oldPostSnaps]) {
      db.prepare("DELETE FROM analytics_metric_values WHERE snapshot_id = ?").run(s.id);
    }
    db.prepare("DELETE FROM analytics_account_snapshots WHERE sync_job_id = ?").run(job.id);
    db.prepare("DELETE FROM analytics_post_snapshots WHERE sync_job_id = ?").run(job.id);

    // Date-scoped activity is re-fetched in full by every sync, so
    // the newest collection REPLACES the same day/range rows —
    // otherwise a second sync would double-count the same days in
    // totals and trends. Lifetime counters are NOT touched here:
    // their history is the snapshot record itself (§9).
    const deleteDaily = db.prepare(
      `DELETE FROM analytics_metric_values WHERE user_id = ? AND account_id = ? AND scope = 'account'
       AND metric_key = ? AND kind = 'daily_activity' AND range_start = ?`,
    );
    for (const m of accountMetrics) {
      if (m.kind === "daily_activity" && m.rangeStart) deleteDaily.run(job.user_id, account.id, m.metricKey, m.rangeStart);
    }
    const postIdByExternal = new Map(targetPosts.map((p) => [p.platform_post_id, p.id]));
    const deleteRange = db.prepare(
      `DELETE FROM analytics_metric_values WHERE user_id = ? AND platform_post_id = ?
       AND metric_key = ? AND kind = 'range_activity' AND range_start = ? AND range_end = ?`,
    );
    for (const m of postResult.metrics) {
      if (m.kind === "range_activity" && m.postExternalId && m.rangeStart && m.rangeEnd) {
        const internal = postIdByExternal.get(m.postExternalId);
        if (internal) deleteRange.run(job.user_id, internal, m.metricKey, m.rangeStart, m.rangeEnd);
      }
    }

    if (!onlyPostId) {
      const snapId = newId();
      db.prepare(
        `INSERT INTO analytics_account_snapshots (id, user_id, account_id, platform, sync_job_id, range_start, range_end, source, api_version, collected_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(snapId, job.user_id, account.id, platform, job.id, effectiveRange.from, effectiveRange.to, "analytics sync", apiVersion, collectedAt, collectedAt);
      for (const m of accountMetrics) saveMetric(m, snapId, null, null);
    }

    const metricsByPost = new Map<string, FetchedMetric[]>();
    for (const m of postResult.metrics) {
      if (!m.postExternalId) continue;
      if (!metricsByPost.has(m.postExternalId)) metricsByPost.set(m.postExternalId, []);
      metricsByPost.get(m.postExternalId)!.push(m);
    }
    const deletedSet = new Set(postResult.deletedExternalIds);
    for (const post of targetPosts) {
      const snapId = newId();
      const jobRow = db.prepare("SELECT id FROM publish_jobs WHERE id = ?").get(post.job_id) as { id: string } | undefined;
      db.prepare(
        `INSERT INTO analytics_post_snapshots (id, user_id, account_id, platform, platform_post_id, internal_post_id,
         platform_post_external_id, sync_job_id, range_start, range_end, source, api_version, post_status, collected_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        snapId, job.user_id, account.id, platform, post.id, jobRow?.id ?? null, post.platform_post_id, job.id,
        range.from, range.to, "analytics sync", apiVersion,
        deletedSet.has(post.platform_post_id) ? "deleted" : "ok", collectedAt, collectedAt,
      );
      for (const m of metricsByPost.get(post.platform_post_id) ?? []) {
        saveMetric(m, snapId, post.id, jobRow?.id ?? null);
      }
      // Keep the Phase 10 snapshot row (Publishing Center) coherent
      // with the latest lifetime counters.
      const latest = latestPostMetrics(job.user_id, post.id);
      const lv = (k: string) => (latest[k]?.availability === "ok" ? latest[k].value : null);
      const anyOk = Object.values(latest).some((m) => m.availability === "ok");
      db.prepare(
        `UPDATE post_analytics_snapshots SET views = ?, likes = ?, comments = ?, shares = ?,
         metrics_status = ?, metric_source = ?, last_synced_at = ?, updated_at = ? WHERE platform_post_id = ?`,
      ).run(
        lv("views"), lv("likes"), lv("comments"), lv("shares"),
        anyOk ? "ok" : "unavailable", "phase-11 analytics sync", collectedAt, collectedAt, post.id,
      );
    }
    db.prepare("UPDATE platform_accounts SET last_synced_at = ?, updated_at = ? WHERE id = ?").run(collectedAt, collectedAt, account.id);
    if (metricsSaved > 0) {
      db.prepare("UPDATE analytics_capabilities SET last_successful_retrieval_at = ?, updated_at = ? WHERE id = ?")
        .run(collectedAt, collectedAt, capsRow.id);
    }
    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw err;
  }

  setSyncProgress(job.id, {
    stage: "SAVING_SNAPSHOTS",
    postsTotal: targetPosts.length,
    postsDone: targetPosts.length,
    metricsSaved,
  });
  return { ...base, outcome: partial ? "partial" : "ok", metricsSaved, postsSynced: targetPosts.length, notes: rangeNotes };
}

async function runSyncJob(job: AnalyticsSyncJobRow): Promise<void> {
  const db = getDb();
  const attemptNo = Math.max(1, job.attempt_count); // the claim UPDATE already incremented it
  const attemptId = newId();
  db.prepare(
    "INSERT INTO analytics_sync_attempts (id, job_id, user_id, attempt_no, status, stage_reached, created_at) VALUES (?, ?, ?, ?, 'STARTED', 'VALIDATING_ACCOUNT', ?)",
  ).run(attemptId, job.id, job.user_id, attemptNo, nowIso());
  const finishAttempt = (status: string, stage: string, error: string | null, code: string | null) => {
    db.prepare("UPDATE analytics_sync_attempts SET status = ?, stage_reached = ?, error = ?, error_code = ?, finished_at = ? WHERE id = ?")
      .run(status, stage, error, code, nowIso(), attemptId);
  };

  let accounts: PlatformAccountRow[] = [];
  try {
    setSyncStatus(job.id, "VALIDATING_ACCOUNT");
    let onlyPostId: string | null = null;
    if (job.scope === "post" && job.platform_post_id) {
      const post = db.prepare("SELECT * FROM platform_posts WHERE id = ? AND user_id = ?").get(job.platform_post_id, job.user_id) as unknown as PlatformPostRow | undefined;
      if (!post) throw new ProviderError("The post to refresh no longer exists.", { code: "POST_NOT_FOUND" });
      const account = ownedAccount(job.user_id, post.account_id);
      if (!account) throw new ProviderError("The post's account no longer exists.", { code: "ACCOUNT_NOT_FOUND" });
      accounts = [account];
      onlyPostId = post.id;
    } else if (job.scope === "account" && job.account_id) {
      const account = ownedAccount(job.user_id, job.account_id);
      if (!account) throw new ProviderError("The account to sync no longer exists.", { code: "ACCOUNT_NOT_FOUND" });
      accounts = [account];
    } else if (job.scope === "platform" && job.platform) {
      accounts = db.prepare("SELECT * FROM platform_accounts WHERE user_id = ? AND platform = ? AND status != 'DISCONNECTED'")
        .all(job.user_id, job.platform) as unknown as PlatformAccountRow[];
    } else {
      accounts = db.prepare("SELECT * FROM platform_accounts WHERE user_id = ? AND status != 'DISCONNECTED'")
        .all(job.user_id) as unknown as PlatformAccountRow[];
    }
    if (accounts.length === 0) {
      setSyncStatus(job.id, "FAILED", {
        error: "No connected accounts match this sync. Connect an account in the Publishing Center first.",
        error_code: "NO_ACCOUNTS", error_class: "permanent", finished_at: nowIso(),
      });
      finishAttempt("FAILED", "VALIDATING_ACCOUNT", "No connected accounts match this sync.", "NO_ACCOUNTS");
      recordSyncUsage(job, "failed", 0);
      return;
    }

    const outcomes: AccountSyncOutcome[] = [];
    for (const account of accounts) {
      outcomes.push(await syncOneAccount(job, account, onlyPostId));
    }
    const okCount = outcomes.filter((o) => o.outcome === "ok" || o.outcome === "partial").length;
    const authCount = outcomes.filter((o) => o.outcome === "auth_required").length;
    const totalMetrics = outcomes.reduce((s, o) => s + o.metricsSaved, 0);
    setSyncProgress(job.id, {
      stage: "COMPLETED",
      accounts: outcomes.map((o) => ({ accountId: o.accountId, outcome: o.outcome, metricsSaved: o.metricsSaved, postsSynced: o.postsSynced, notes: o.notes })),
      metricsSaved: totalMetrics,
    });
    if (okCount === outcomes.length) {
      const anyPartial = outcomes.some((o) => o.outcome === "partial");
      setSyncStatus(job.id, anyPartial ? "PARTIAL_SUCCESS" : "COMPLETED", { finished_at: nowIso(), error: null, error_code: null, error_class: null });
      finishAttempt("SUCCEEDED", "SAVING_SNAPSHOTS", null, null);
      recordSyncUsage(job, anyPartial ? "partial" : "completed", totalMetrics);
    } else if (okCount > 0) {
      setSyncStatus(job.id, "PARTIAL_SUCCESS", {
        finished_at: nowIso(),
        error: outcomes.filter((o) => o.outcome !== "ok").map((o) => o.error).filter(Boolean).join(" ") || null,
        error_code: authCount > 0 ? "AUTH_REQUIRED" : "PARTIAL_FAILURE",
        error_class: authCount > 0 ? "user_intervention" : "permanent",
      });
      finishAttempt("SUCCEEDED", "SAVING_SNAPSHOTS", "Some accounts did not sync completely.", null);
      recordSyncUsage(job, "partial", totalMetrics);
    } else if (authCount === outcomes.length) {
      setSyncStatus(job.id, "AUTH_REQUIRED", {
        finished_at: nowIso(),
        error: outcomes[0]?.error ?? "Reauthorization is required.",
        error_code: "AUTH_REQUIRED", error_class: "user_intervention",
      });
      finishAttempt("FAILED", "VALIDATING_ACCOUNT", outcomes[0]?.error ?? "AUTH_REQUIRED", "AUTH_REQUIRED");
      recordSyncUsage(job, "failed", 0);
    } else {
      setSyncStatus(job.id, "FAILED", {
        finished_at: nowIso(),
        error: outcomes.map((o) => o.error).filter(Boolean).join(" ") || "Sync failed.",
        error_code: outcomes[0]?.errorCode ?? "SYNC_FAILED", error_class: "permanent",
      });
      finishAttempt("FAILED", "FETCHING_METRICS", outcomes[0]?.error ?? "Sync failed.", outcomes[0]?.errorCode ?? null);
      recordSyncUsage(job, "failed", 0);
    }
  } catch (err) {
    const perr = err instanceof ProviderError ? err : null;
    const message = err instanceof Error ? err.message : String(err);
    const code = perr?.code ?? "SYNC_ERROR";
    const errorClass = perr?.errorClass ?? "permanent";
    finishAttempt("FAILED", "FETCHING_METRICS", message, code);
    // Retry only safe failures (§17/§18): transient errors (rate
    // limits, network, 5xx) with attempts remaining go back to
    // QUEUED with exponential backoff. Everything else is terminal.
    if (errorClass === "transient" && attemptNo < job.max_attempts) {
      const backoffSec = Math.min(900, config.analytics.backoffBaseSec * 2 ** (attemptNo - 1));
      setSyncStatus(job.id, "QUEUED", {
        next_attempt_at: new Date(Date.now() + backoffSec * 1000).toISOString(),
        error: message, error_code: code, error_class: errorClass,
      });
      return;
    }
    if (errorClass === "user_intervention" || code === "AUTH_REQUIRED") {
      // The account(s) behind this job need reauthorization too —
      // flag them so the UI and later syncs see the real state (§18).
      for (const account of accounts) markAccountAuthRequired(account.id);
      if (accounts.length === 0 && job.account_id) markAccountAuthRequired(job.account_id);
      setSyncStatus(job.id, "AUTH_REQUIRED", { finished_at: nowIso(), error: message, error_code: "AUTH_REQUIRED", error_class: "user_intervention" });
      recordSyncUsage(job, "failed", 0);
      return;
    }
    setSyncStatus(job.id, "FAILED", { finished_at: nowIso(), error: message, error_code: code, error_class: errorClass });
    recordSyncUsage(job, "failed", 0);
  }
}

// ---- worker ------------------------------------------------------------------------

let analyticsTimer: NodeJS.Timeout | null = null;
let analyticsBusy = false;
let scheduleCheckCounter = 0;

function enqueueScheduledSyncs(): void {
  const db = getDb();
  const settings = db.prepare("SELECT * FROM analytics_settings WHERE auto_sync_minutes > 0").all() as unknown as { user_id: string; auto_sync_minutes: number }[];
  for (const s of settings) {
    const accounts = db.prepare("SELECT * FROM platform_accounts WHERE user_id = ? AND status = 'CONNECTED'").all(s.user_id) as unknown as PlatformAccountRow[];
    for (const account of accounts) {
      const last = db
        .prepare("SELECT finished_at FROM analytics_sync_jobs WHERE user_id = ? AND account_id = ? AND status IN ('COMPLETED', 'PARTIAL_SUCCESS') ORDER BY finished_at DESC LIMIT 1")
        .get(s.user_id, account.id) as { finished_at: string | null } | undefined;
      const due = !last?.finished_at || Date.now() - new Date(last.finished_at).getTime() >= s.auto_sync_minutes * 60_000;
      if (due) createSyncJob(s.user_id, { accountId: account.id, source: "schedule" });
    }
  }
}

async function analyticsTick(): Promise<void> {
  if (analyticsBusy) return;
  analyticsBusy = true;
  try {
    const db = getDb();
    scheduleCheckCounter += 1;
    if (scheduleCheckCounter % 30 === 0) {
      try { enqueueScheduledSyncs(); } catch { /* scheduling is best-effort per tick */ }
    }
    const candidate = db
      .prepare(
        `SELECT * FROM analytics_sync_jobs WHERE status = 'QUEUED'
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY created_at ASC LIMIT 1`,
      )
      .get(nowIso()) as unknown as AnalyticsSyncJobRow | undefined;
    if (candidate) {
      const claim = db
        .prepare(
          `UPDATE analytics_sync_jobs SET status = 'VALIDATING_ACCOUNT', attempt_count = attempt_count + 1,
           worker_id = ?, started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ? AND status = 'QUEUED'`,
        )
        .run(WORKER_ID, nowIso(), nowIso(), candidate.id) as unknown as { changes: number };
      if (Number(claim.changes) === 1) {
        const fresh = db.prepare("SELECT * FROM analytics_sync_jobs WHERE id = ?").get(candidate.id) as unknown as AnalyticsSyncJobRow;
        await runSyncJob(fresh);
        return;
      }
    }
    await processOneQueuedReport();
  } catch (err) {
    console.error("[analytics] worker tick failed:", err);
  } finally {
    analyticsBusy = false;
  }
}

export function startAnalyticsWorker(): void {
  seedMetricDefinitions();
  // Boot recovery (§18): analytics syncs are read-only against the
  // providers, so any job a restart interrupted mid-flight is safe
  // to re-queue — no submission can be duplicated by retrying a read.
  try {
    const db = getDb();
    const stuck = db
      .prepare(`UPDATE analytics_sync_jobs SET status = 'QUEUED', next_attempt_at = NULL, updated_at = ? WHERE status IN (${ACTIVE_SYNC_STATUSES.slice(1).map(() => "?").join(",")})`)
      .run(nowIso(), ...ACTIVE_SYNC_STATUSES.slice(1)) as unknown as { changes: number };
    if (Number(stuck.changes) > 0) {
      console.log(`[analytics] boot recovery: re-queued ${Number(stuck.changes)} interrupted sync job(s)`);
    }
    recoverInterruptedReports();
  } catch {
    /* database not ready — recovery is best-effort at boot */
  }
  if (analyticsTimer) return;
  analyticsTimer = setInterval(() => { void analyticsTick(); }, config.analytics.tickMs);
}

// ---- insights (§14) ------------------------------------------------------------------

const STOPWORDS = new Set(["with", "from", "this", "that", "your", "video", "shorts", "part", "full", "best", "new", "how", "what", "when", "will", "just", "over", "under", "more", "than", "then", "them", "they", "were", "been", "have", "has", "had", "clip", "reel", "short"]);

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

interface InsightDraft {
  kind: "OBSERVATION" | "CORRELATION" | "SUGGESTION";
  ruleKey: string;
  subjectKey: string;
  title: string;
  body: string;
  platform: Platform | null;
  accountId: string | null;
  sampleSize: number;
  formula: string | null;
  limitations: string;
  evidence: { label: string; metricKey: string | null; value: unknown; platformPostId: string | null }[];
}

export function generateInsights(userId: string, range: DateRange): { created: number; skipped: number } {
  const db = getDb();
  const drafts: InsightDraft[] = [];
  const posts = userPosts(userId, {});
  const summaries = posts.map((ctx) => ({ ctx, summary: summarizePost(ctx) }));

  // Rule 1 — posts performing far above their account's median (§14).
  const byAccount = new Map<string, typeof summaries>();
  for (const s of summaries) {
    if (!byAccount.has(s.ctx.post.account_id)) byAccount.set(s.ctx.post.account_id, []);
    byAccount.get(s.ctx.post.account_id)!.push(s);
  }
  for (const [accountId, list] of byAccount) {
    const withViews = list.filter((s) => s.summary.metrics.views?.availability === "ok" && s.summary.metrics.views.value !== null);
    if (withViews.length < 5) continue;
    const med = median(withViews.map((s) => s.summary.metrics.views!.value as number));
    if (med <= 0) continue;
    const standouts = withViews
      .filter((s) => (s.summary.metrics.views!.value as number) >= med * 1.5)
      .sort((a, b) => (b.summary.metrics.views!.value as number) - (a.summary.metrics.views!.value as number))
      .slice(0, 3);
    for (const s of standouts) {
      const views = s.summary.metrics.views!.value as number;
      drafts.push({
        kind: "OBSERVATION",
        ruleKey: "post_above_account_median",
        subjectKey: `post:${s.summary.id}`,
        title: `“${s.summary.title || s.summary.platformPostId}” is well above its account's median views`,
        body: `This ${s.summary.platform} post has ${Math.round(views)} views against an account median of ${Math.round(med)} views across ${withViews.length} posts with recorded views (${(views / med).toFixed(1)}× the median). This is an observation about recorded numbers only — it does not explain why the post performed this way, and no editing feature is credited.`,
        platform: s.summary.platform,
        accountId,
        sampleSize: withViews.length,
        formula: "Account median = median of latest recorded views across the account's published posts.",
        limitations: "Views are the latest recorded cumulative counters from the connected platform account; posts published outside CLIPFORGE are not part of the baseline.",
        evidence: [
          { label: "Post views (latest recorded)", metricKey: "views", value: views, platformPostId: s.summary.id },
          { label: "Account median views", metricKey: "views", value: med, platformPostId: null },
          { label: "Posts in baseline", metricKey: null, value: withViews.length, platformPostId: null },
        ],
      });
    }
  }

  // Rule 2 — metric movement between two complete, equal periods (§14).
  // The copy claims both periods are complete; that is only true when
  // the selected range has fully ended. A range that includes today
  // is still accumulating, so the rule is skipped for it (F2) rather
  // than describing an incomplete period as complete.
  const prev = previousRange(range);
  for (const platform of range.to < dateOf(nowIso()) ? ["youtube", "instagram", "tiktok"] as Platform[] : []) {
    const curTotals = metricTotals(userId, range, { platform });
    const prevTotals = metricTotals(userId, prev, { platform });
    for (const metricKey of ["shares", "views", "likes"] as const) {
      const cur = curTotals.find((t) => t.metricKey === metricKey);
      const old = prevTotals.find((t) => t.metricKey === metricKey);
      if (!cur || !old || cur.value === null || old.value === null || old.value <= 0) continue;
      const change = ((cur.value - old.value) / old.value) * 100;
      if (Math.abs(change) < 20) continue;
      drafts.push({
        kind: "OBSERVATION",
        ruleKey: "period_metric_change",
        subjectKey: `${platform}:${metricKey}:${range.from}:${range.to}`,
        title: `${platform} ${metricKey} ${change > 0 ? "increased" : "decreased"} ${Math.abs(change).toFixed(1)}% between the two periods`,
        body: `${metricKey} on ${platform} moved from ${Math.round(old.value)} (${prev.from} to ${prev.to}) to ${Math.round(cur.value)} (${range.from} to ${range.to}), a change of ${change.toFixed(1)}%. Both periods are complete and equal in length (${rangeDays(range)} days). This compares recorded totals only; it does not attribute the change to any cause.`,
        platform,
        accountId: null,
        sampleSize: rangeDays(range),
        formula: "Percentage change = (current period total − previous period total) / previous period total × 100, using the same totals basis for both periods.",
        limitations: "Totals follow the basis shown in the dashboard (date-scoped activity where recorded, otherwise cumulative-counter deltas). If the basis differs between periods the insight is not generated.",
        evidence: [
          { label: `Previous period ${metricKey} (${prev.from} → ${prev.to})`, metricKey, value: old.value, platformPostId: null },
          { label: `Current period ${metricKey} (${range.from} → ${range.to})`, metricKey, value: cur.value, platformPostId: null },
          { label: "Percentage change", metricKey: null, value: Number(change.toFixed(2)), platformPostId: null },
        ],
      });
    }
  }

  // Rule 3 — publishing volume by platform (§14).
  const publishedInRange = summaries.filter((s) => s.summary.publishedAt && s.summary.publishedAt.slice(0, 10) >= range.from && s.summary.publishedAt.slice(0, 10) <= range.to);
  if (publishedInRange.length >= 3) {
    const counts = new Map<string, number>();
    for (const s of publishedInRange) counts.set(s.summary.platform, (counts.get(s.summary.platform) ?? 0) + 1);
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    if (ranked.length >= 2 && ranked[0][1] > ranked[1][1]) {
      drafts.push({
        kind: "OBSERVATION",
        ruleKey: "platform_publishing_volume",
        subjectKey: `volume:${range.from}:${range.to}`,
        title: `${ranked[0][0]} had the most CLIPFORGE-published posts in this period`,
        body: `Between ${range.from} and ${range.to}, CLIPFORGE published ${ranked[0][1]} post(s) to ${ranked[0][0]} out of ${publishedInRange.length} total (${ranked.map(([p, n]) => `${p}: ${n}`).join(", ")}). This describes publishing volume only, not performance.`,
        platform: ranked[0][0] as Platform,
        accountId: null,
        sampleSize: publishedInRange.length,
        formula: null,
        limitations: "Counts include only posts published through CLIPFORGE in the selected range.",
        evidence: ranked.map(([p, n]) => ({ label: `Posts published to ${p}`, metricKey: null, value: n, platformPostId: null })),
      });
    }
  }

  // Rule 4 — title terms over-represented among top posts (correlation).
  const withViews = summaries.filter((s) => s.summary.metrics.views?.availability === "ok" && s.summary.metrics.views.value !== null && s.summary.title);
  if (withViews.length >= 8) {
    const sorted = [...withViews].sort((a, b) => (b.summary.metrics.views!.value as number) - (a.summary.metrics.views!.value as number));
    const topCount = Math.max(2, Math.floor(sorted.length / 4));
    const top = sorted.slice(0, topCount);
    const rest = sorted.slice(topCount);
    const termCounts = (list: typeof withViews): Map<string, number> => {
      const map = new Map<string, number>();
      for (const s of list) {
        const terms = new Set((s.summary.title.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).filter((t) => !STOPWORDS.has(t)));
        for (const t of terms) map.set(t, (map.get(t) ?? 0) + 1);
      }
      return map;
    };
    const topTerms = termCounts(top);
    const restTerms = termCounts(rest);
    for (const [term, count] of topTerms) {
      if (count < 2) continue;
      const topRate = count / top.length;
      const restRate = (restTerms.get(term) ?? 0) / Math.max(1, rest.length);
      if (topRate >= 0.5 && topRate >= restRate * 2) {
        drafts.push({
          kind: "CORRELATION",
          ruleKey: "title_term_top_posts",
          subjectKey: `term:${term}:${range.from}:${range.to}`,
          title: `The term “${term}” appears often among the top posts`,
          body: `“${term}” appears in ${count} of the ${top.length} highest-viewed posts (${Math.round(topRate * 100)}%) versus ${Math.round(restRate * 100)}% of the remaining ${rest.length} posts. This is a correlation in titles only — it is not evidence that the term caused the performance.`,
          platform: null,
          accountId: null,
          sampleSize: withViews.length,
          formula: "Top group = highest-viewed quartile of posts with recorded views and titles.",
          limitations: "Title wording is one of many differences between posts (topic, timing, platform, audience). Treat this as a prompt for your own review, not a rule.",
          evidence: [
            { label: `Top posts containing “${term}”`, metricKey: null, value: count, platformPostId: null },
            { label: "Top group size", metricKey: null, value: top.length, platformPostId: null },
            { label: "Remaining posts", metricKey: null, value: rest.length, platformPostId: null },
          ],
        });
      }
    }
  }

  // Rule 5 — posting-time suggestion from sufficient history (§15).
  const posting = buildPostingTimes(userId, null);
  if (posting.sufficient && posting.bestBucket) {
    drafts.push({
      kind: "SUGGESTION",
      ruleKey: "posting_time_observation",
      subjectKey: `posting:${posting.bestBucket.weekday}:${posting.bestBucket.hour}`,
      title: `Historically, posts at ${posting.bestBucket.label} have the highest median views`,
      body: `Across ${posting.totalPosts} posts with recorded views, the ${posting.bestBucket.label} group (n=${posting.bestBucket.count}) has a median of ${Math.round(posting.bestBucket.medianViews ?? 0)} views. This is a historical observation from your own publishing history, not a recommendation guarantee and not evidence that the time slot caused the results.`,
      platform: null,
      accountId: null,
      sampleSize: posting.totalPosts,
      formula: "Median of latest recorded views per weekday/hour bucket in the account timezone.",
      limitations: "Posting-time groups differ in content and platform mix; small groups are excluded (minimum 3 posts per bucket).",
      evidence: [
        { label: "Bucket median views", metricKey: "views", value: posting.bestBucket.medianViews, platformPostId: null },
        { label: "Posts in bucket", metricKey: null, value: posting.bestBucket.count, platformPostId: null },
        { label: "Total posts analysed", metricKey: null, value: posting.totalPosts, platformPostId: null },
      ],
    });
  }

  let created = 0;
  let skipped = 0;
  for (const draft of drafts) {
    const existing = db
      .prepare(
        `SELECT id FROM analytics_insights WHERE user_id = ? AND rule_key = ? AND subject_key = ?
         AND COALESCE(range_start, '') = COALESCE(?, '') AND COALESCE(range_end, '') = COALESCE(?, '')
         AND status IN ('ACTIVE', 'SAVED') LIMIT 1`,
      )
      .get(userId, draft.ruleKey, draft.subjectKey, range.from, range.to) as { id: string } | undefined;
    if (existing) { skipped += 1; continue; }
    const id = newId();
    const now = nowIso();
    db.prepare(
      `INSERT INTO analytics_insights (id, user_id, kind, rule_key, subject_key, title, body, platform, account_id,
       range_start, range_end, sample_size, formula, limitations, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
    ).run(id, userId, draft.kind, draft.ruleKey, draft.subjectKey, draft.title, draft.body, draft.platform,
      draft.accountId, range.from, range.to, draft.sampleSize, draft.formula, draft.limitations, now, now);
    for (const ev of draft.evidence) {
      db.prepare(
        "INSERT INTO analytics_insight_evidence (id, insight_id, user_id, label, metric_key, value_json, platform_post_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(newId(), id, userId, ev.label, ev.metricKey, JSON.stringify(ev.value), ev.platformPostId, now);
    }
    created += 1;
  }
  audit(userId, "insights_generated", { created, skipped, from: range.from, to: range.to });
  return { created, skipped };
}

// ---- content analysis (§13) + posting times (§15) --------------------------------------

interface PostAttributes {
  project: string;
  sourceVideo: string;
  clip: string;
  captionTemplate: string;
  aspectRatio: string;
  reframeMode: string;
  brollUsage: string;
  enhancementPreset: string;
  platform: string;
  account: string;
}

function documentIdForPost(db: ReturnType<typeof getDb>, ctx: PostContext): string | null {
  if (!ctx.job?.export_output_id) return null;
  const output = db.prepare("SELECT job_id FROM export_outputs WHERE id = ?").get(ctx.job.export_output_id) as { job_id: string } | undefined;
  if (!output) return null;
  const renderJob = db.prepare("SELECT version_id FROM render_jobs WHERE id = ?").get(output.job_id) as { version_id: string } | undefined;
  return renderJob?.version_id ?? null;
}

function gcd(a: number, b: number): number { return b === 0 ? a : gcd(b, a % b); }

export function postAttributes(ctx: PostContext): PostAttributes {
  const db = getDb();
  const project = ctx.projectId
    ? ((db.prepare("SELECT name FROM projects WHERE id = ?").get(ctx.projectId) as { name: string } | undefined)?.name ?? ctx.projectId)
    : "Unknown project";
  let sourceVideo = "Not recorded";
  if (ctx.projectId) {
    const asset = db.prepare("SELECT original_filename FROM source_assets WHERE project_id = ? ORDER BY created_at ASC LIMIT 1").get(ctx.projectId) as { original_filename: string } | undefined;
    if (asset) sourceVideo = asset.original_filename;
  }
  let clip = "Full video (no clip)";
  if (ctx.clipId) {
    const candidate = db.prepare("SELECT title FROM candidate_clips WHERE id = ?").get(ctx.clipId) as { title: string } | undefined;
    clip = candidate?.title ?? "Generated clip";
  }
  let aspectRatio = "Not recorded";
  if (ctx.job?.export_output_id) {
    const output = db.prepare("SELECT width, height FROM export_outputs WHERE id = ?").get(ctx.job.export_output_id) as { width: number | null; height: number | null } | undefined;
    if (output?.width && output?.height) {
      const g = gcd(output.width, output.height) || 1;
      aspectRatio = `${output.width / g}:${output.height / g}`;
    }
  }
  let captionTemplate = "Not recorded";
  let reframeMode = "Not recorded";
  let brollUsage = "No B-roll";
  let enhancementPreset = "No enhancement recorded";
  const docId = documentIdForPost(db, ctx);
  if (docId) {
    const doc = db.prepare("SELECT settings_json FROM clip_versions WHERE id = ?").get(docId) as { settings_json: string } | undefined;
    const settings = parseJson<Record<string, unknown>>(doc?.settings_json, {});
    const templateId = typeof settings.captionTemplateId === "string" ? settings.captionTemplateId : null;
    if (templateId) {
      if (templateId.startsWith("builtin:")) {
        captionTemplate = templateId.slice("builtin:".length).replace(/-/g, " ");
      } else {
        const tpl = db.prepare("SELECT name FROM caption_templates WHERE id = ?").get(templateId) as { name: string } | undefined;
        captionTemplate = tpl?.name ?? "Custom template";
      }
    } else {
      captionTemplate = "No caption template";
    }
    const reframe = db.prepare("SELECT mode FROM reframe_configurations WHERE version_id = ? ORDER BY updated_at DESC LIMIT 1").get(docId) as { mode: string } | undefined;
    if (reframe) reframeMode = reframe.mode;
    const placements = db.prepare("SELECT COUNT(*) AS n FROM broll_placements WHERE version_id = ?").get(docId) as unknown as { n: number };
    if (Number(placements.n) > 0) brollUsage = "With B-roll";
    const enhancement = db.prepare("SELECT video_enabled, audio_enabled, video_json, audio_json FROM enhancement_configs WHERE version_id = ? ORDER BY updated_at DESC LIMIT 1").get(docId) as { video_enabled: number; audio_enabled: number; video_json: string; audio_json: string } | undefined;
    if (enhancement && (enhancement.video_enabled === 1 || enhancement.audio_enabled === 1)) {
      const vj = parseJson<Record<string, unknown>>(enhancement.video_json, {});
      const presetName = typeof vj.presetName === "string" ? vj.presetName : typeof vj.preset === "string" ? vj.preset : null;
      enhancementPreset = presetName ?? "Enhancement applied";
    }
  }
  return {
    project,
    sourceVideo,
    clip,
    captionTemplate,
    aspectRatio,
    reframeMode,
    brollUsage,
    enhancementPreset,
    platform: ctx.post.platform,
    account: ctx.account?.username ?? ctx.account?.platform_account_id ?? "Unknown account",
  };
}

export const CONTENT_GROUP_KEYS = ["project", "sourceVideo", "clip", "captionTemplate", "aspectRatio", "reframeMode", "brollUsage", "enhancementPreset", "platform", "account"] as const;
export type ContentGroupKey = (typeof CONTENT_GROUP_KEYS)[number];

export function buildContentAnalysis(userId: string, groupBy: ContentGroupKey) {
  const posts = userPosts(userId, {});
  const groups = new Map<string, { label: string; postIds: string[]; views: number[]; likes: number; likesCount: number; comments: number; commentsCount: number; shares: number; sharesCount: number; reachValues: number[]; engagementsByReach: number[]; engagementsByViews: number[] }>();
  for (const ctx of posts) {
    const attrs = postAttributes(ctx);
    const label = attrs[groupBy];
    const summary = summarizePost(ctx);
    if (!groups.has(label)) {
      groups.set(label, { label, postIds: [], views: [], likes: 0, likesCount: 0, comments: 0, commentsCount: 0, shares: 0, sharesCount: 0, reachValues: [], engagementsByReach: [], engagementsByViews: [] });
    }
    const g = groups.get(label)!;
    g.postIds.push(ctx.post.id);
    const v = summary.metrics.views;
    if (v?.availability === "ok" && v.value !== null) g.views.push(v.value);
    // F1: a post contributes to a metric's sum ONLY when that metric
    // was actually recorded for it — unavailable is never silently
    // counted as 0. The contributing count travels with each total so
    // partial coverage is visible, and a total with zero contributors
    // is null (unavailable), exactly like totalViews below.
    const contrib = (k: string): number | null =>
      summary.metrics[k]?.availability === "ok" && summary.metrics[k].value !== null ? summary.metrics[k].value : null;
    const lv = contrib("likes");
    if (lv !== null) { g.likes += lv; g.likesCount += 1; }
    const cv = contrib("comments");
    if (cv !== null) { g.comments += cv; g.commentsCount += 1; }
    const sv = contrib("shares");
    if (sv !== null) { g.shares += sv; g.sharesCount += 1; }
    if (summary.engagementByReach.availability === "ok" && summary.engagementByReach.value !== null) g.engagementsByReach.push(summary.engagementByReach.value);
    if (summary.engagementByViews.availability === "ok" && summary.engagementByViews.value !== null) g.engagementsByViews.push(summary.engagementByViews.value);
  }
  const rows = [...groups.values()].map((g) => ({
    label: g.label,
    postCount: g.postIds.length,
    postIds: g.postIds,
    smallSample: g.postIds.length < 3,
    totalViews: g.views.length > 0 ? g.views.reduce((s, x) => s + x, 0) : null,
    averageViews: g.views.length > 0 ? g.views.reduce((s, x) => s + x, 0) / g.views.length : null,
    medianViews: g.views.length > 0 ? median(g.views) : null,
    totalLikes: g.likesCount > 0 ? g.likes : null,
    likesCount: g.likesCount,
    totalComments: g.commentsCount > 0 ? g.comments : null,
    commentsCount: g.commentsCount,
    totalShares: g.sharesCount > 0 ? g.shares : null,
    sharesCount: g.sharesCount,
    medianEngagementByReach: g.engagementsByReach.length > 0 ? median(g.engagementsByReach) : null,
    medianEngagementByViews: g.engagementsByViews.length > 0 ? median(g.engagementsByViews) : null,
  })).sort((a, b) => (b.totalViews ?? -1) - (a.totalViews ?? -1));
  return {
    groupBy,
    groups: rows,
    disclaimer:
      "Groups compare recorded performance of posts that share a CLIPFORGE production attribute. Correlation is not proof of causation: a group performing better does not prove the attribute caused it. Groups with fewer than 3 posts are flagged as too small for meaningful comparison. Unpublished clips are never included.",
  };
}

export const MIN_POSTING_SAMPLE = 10;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function buildPostingTimes(userId: string, accountId: string | null, timezone = "Asia/Kolkata") {
  const posts = userPosts(userId, accountId ? { accountId } : {});
  const withTime = posts.filter((p) => p.publishedAt);
  const fmtCache = new Map<string, Intl.DateTimeFormat>();
  const fmtFor = (hourCycle: "h23") => {
    const key = `${timezone}:${hourCycle}`;
    if (!fmtCache.has(key)) {
      fmtCache.set(key, new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", hour: "2-digit", hourCycle }));
    }
    return fmtCache.get(key)!;
  };
  interface Bucket { weekday: number; hour: number; count: number; views: number[] }
  const buckets = new Map<string, Bucket>();
  let postsWithViews = 0;
  for (const ctx of withTime) {
    const summary = summarizePost(ctx);
    const parts = fmtFor("h23").formatToParts(new Date(ctx.publishedAt as string));
    const weekdayName = parts.find((p) => p.type === "weekday")?.value ?? "";
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? NaN);
    const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekdayName);
    if (weekday < 0 || Number.isNaN(hour)) continue;
    const key = `${weekday}:${hour}`;
    if (!buckets.has(key)) buckets.set(key, { weekday, hour, count: 0, views: [] });
    const bucket = buckets.get(key)!;
    bucket.count += 1;
    const v = summary.metrics.views;
    if (v?.availability === "ok" && v.value !== null) { bucket.views.push(v.value); postsWithViews += 1; }
  }
  const rows = [...buckets.values()].map((b) => ({
    weekday: b.weekday,
    weekdayLabel: WEEKDAYS[b.weekday],
    hour: b.hour,
    label: `${WEEKDAYS[b.weekday]} ${String(b.hour).padStart(2, "0")}:00`,
    count: b.count,
    medianViews: b.views.length > 0 ? median(b.views) : null,
  })).sort((a, b) => a.weekday - b.weekday || a.hour - b.hour);
  const sufficient = withTime.length >= MIN_POSTING_SAMPLE;
  const best = sufficient
    ? rows.filter((r) => r.count >= 3 && r.medianViews !== null).sort((a, b) => (b.medianViews ?? 0) - (a.medianViews ?? 0))[0] ?? null
    : null;
  return {
    timezone,
    totalPosts: withTime.length,
    postsWithViews,
    minimumSample: MIN_POSTING_SAMPLE,
    sufficient,
    message: sufficient
      ? "Buckets show historical observations from your own CLIPFORGE publishing history. They are not recommendations and do not prove a time slot caused performance."
      : `Posting-time analysis needs at least ${MIN_POSTING_SAMPLE} published posts with recorded history; ${withTime.length} are available. More publishing history is needed before any pattern can be described honestly.`,
    buckets: rows,
    bestBucket: best ? { weekday: best.weekday, hour: best.hour, label: best.label, count: best.count, medianViews: best.medianViews } : null,
  };
}

// ---- routes ---------------------------------------------------------------------------

function publicSyncJob(job: AnalyticsSyncJobRow) {
  return {
    id: job.id,
    accountId: job.account_id,
    platform: job.platform,
    scope: job.scope,
    platformPostId: job.platform_post_id,
    rangeStart: job.range_start,
    rangeEnd: job.range_end,
    status: job.status,
    attemptCount: job.attempt_count,
    maxAttempts: job.max_attempts,
    nextAttemptAt: job.next_attempt_at,
    progress: parseJson(job.progress_json, null),
    error: job.error,
    errorCode: job.error_code,
    errorClass: job.error_class,
    source: job.source,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
  };
}

export function registerAnalyticsRoutes(app: express.Express, requireAuth: RequireAuth): void {
  seedMetricDefinitions();
  const an = express.Router();
  const db = getDb();

  // -- definitions + capabilities (§6, §19) --------------------------------------
  an.get("/definitions", requireAuth, (_req: AuthedRequest, res) => {
    const rows = db.prepare("SELECT * FROM analytics_metric_definitions ORDER BY metric_key, platform").all();
    res.json({ definitions: rows });
  });

  an.get("/capabilities", requireAuth, (req: AuthedRequest, res) => {
    const accounts = db.prepare("SELECT * FROM platform_accounts WHERE user_id = ? AND status != 'DISCONNECTED'").all(req.user!.id) as unknown as PlatformAccountRow[];
    const out = accounts.map((account) => {
      const row = db.prepare("SELECT * FROM analytics_capabilities WHERE account_id = ?").get(account.id) as unknown as AnalyticsCapabilityRow | undefined;
      const stored = row ?? storeCapabilities(account);
      return { account: { id: account.id, platform: account.platform, username: account.username, status: account.status }, capability: publicCapability(stored) };
    });
    // A supported platform with NO connected account must still be
    // visible here: without an entry the UI cannot distinguish "not
    // configured on this server" from "not a supported platform".
    // The entry carries the same publishingProviderStatus result the
    // sync engine's CONFIGURATION_ERROR is built from — the missing
    // credential variable NAMES, never values. Connected accounts'
    // entries above are unchanged.
    const represented = new Set(accounts.map((a) => a.platform));
    const unrepresented: {
      account: null;
      platform: Platform;
      configured: boolean;
      missing: string[];
      capability: null;
    }[] = [];
    for (const platform of ["youtube", "instagram", "tiktok"] as Platform[]) {
      if (represented.has(platform)) continue;
      const status = publishingProviderStatus(platform);
      unrepresented.push({ account: null, platform, configured: status.configured, missing: status.missing, capability: null });
    }
    res.json({ accounts: [...out, ...unrepresented] });
  });

  an.post("/capabilities/refresh", requireAuth, (req: AuthedRequest, res) => {
    const accountId = typeof req.body?.accountId === "string" ? req.body.accountId : "";
    const account = ownedAccount(req.user!.id, accountId);
    if (!account) return fail(res, 404, "NOT_FOUND", "Account not found.");
    const row = storeCapabilities(account);
    audit(req.user!.id, "capability_refresh", { accountId: account.id, platform: account.platform });
    res.json({ capability: publicCapability(row) });
  });

  // -- overview (§2) ----------------------------------------------------------------
  an.get("/overview", requireAuth, (req: AuthedRequest, res) => {
    const range = parseRange(req);
    const platform = platformFilter(req);
    const accountId = typeof req.query.accountId === "string" ? req.query.accountId : undefined;
    const formula = req.query.formula === "by_reach" ? "by_reach" : "by_views";
    const totals = metricTotals(req.user!.id, range, { platform: platform ?? null, accountId });
    const published = db
      .prepare(
        `SELECT COUNT(*) AS n FROM publish_jobs WHERE user_id = ? AND status = 'PUBLISHED'
         AND published_at >= ? AND published_at <= ? ${platform ? "AND platform = ?" : ""}`,
      )
      .get(req.user!.id, `${range.from}T00:00:00Z`, `${range.to}T23:59:59Z`, ...(platform ? [platform] : [])) as unknown as { n: number };
    const prevR = previousRange(range);
    const publishedPrev = db
      .prepare(
        `SELECT COUNT(*) AS n FROM publish_jobs WHERE user_id = ? AND status = 'PUBLISHED'
         AND published_at >= ? AND published_at <= ? ${platform ? "AND platform = ?" : ""}`,
      )
      .get(req.user!.id, `${prevR.from}T00:00:00Z`, `${prevR.to}T23:59:59Z`, ...(platform ? [platform] : [])) as unknown as { n: number };
    const engagement = platform
      ? engagementForTotals(totals, formula, platform)
      : null; // cross-platform engagement is only shown when component sets match — see comparison
    const lastSync = db
      .prepare("SELECT MAX(finished_at) AS at FROM analytics_sync_jobs WHERE user_id = ? AND status IN ('COMPLETED', 'PARTIAL_SUCCESS')")
      .get(req.user!.id) as { at: string | null };
    res.json({
      range,
      previousRange: prevR,
      periodNote: "Previous period is the immediately preceding period of equal length. Incomplete periods are never compared as if complete: figures reflect only snapshots collected so far.",
      metrics: totals,
      publishedPosts: {
        value: Number(published.n),
        previousValue: Number(publishedPrev.n),
        delta: Number(published.n) - Number(publishedPrev.n),
      },
      engagement,
      engagementNote: platform
        ? null
        : "Select a single platform to see an engagement rate: platforms expose different components (for example saves), so a blended rate would compare different formulas.",
      lastSuccessfulSyncAt: lastSync.at,
    });
  });

  // -- platform comparison (§7) -------------------------------------------------------
  an.get("/platform-comparison", requireAuth, (req: AuthedRequest, res) => {
    const range = parseRange(req);
    const formula = req.query.formula === "by_reach" ? "by_reach" : "by_views";
    const userId = req.user!.id;
    const platforms = (["youtube", "instagram", "tiktok"] as Platform[]).map((platform) => {
      const totals = metricTotals(userId, range, { platform });
      const posts = userPosts(userId, { platform });
      const summaries = posts.map(summarizePost);
      const top = [...summaries].sort((a, b) => (b.metrics.views?.value ?? -1) - (a.metrics.views?.value ?? -1))[0] ?? null;
      return {
        platform,
        metrics: totals,
        engagement: engagementForTotals(totals, formula, platform),
        publishedPostCount: posts.filter((p) => p.publishedAt && p.publishedAt.slice(0, 10) >= range.from && p.publishedAt.slice(0, 10) <= range.to).length,
        topPost: top ? { id: top.id, title: top.title, views: top.metrics.views?.value ?? null, url: top.url } : null,
      };
    });
    const componentSets = new Map(platforms.map((p) => [p.platform, p.engagement.componentsUsed.join("+")]));
    const setsDiffer = new Set(componentSets.values()).size > 1;
    res.json({
      range,
      formula,
      platforms,
      warnings: [
        "Views and reach are different metrics and are never added together.",
        "Figures are date-scoped activity where the provider reports it, otherwise deltas of cumulative counters between snapshots; each metric's basis is shown.",
        ...(setsDiffer ? ["Engagement component sets differ by platform (for example, YouTube and TikTok do not expose saves), so engagement rates are not directly comparable across platforms."] : []),
      ],
    });
  });

  // -- trends (§11) ---------------------------------------------------------------------
  an.get("/trends", requireAuth, (req: AuthedRequest, res) => {
    const range = parseRange(req);
    const metricKey = typeof req.query.metric === "string" ? req.query.metric : "views";
    const granularity = req.query.granularity === "week" || req.query.granularity === "month" ? req.query.granularity : "day";
    const platform = platformFilter(req);
    const accountId = typeof req.query.accountId === "string" ? req.query.accountId : undefined;
    const postId = typeof req.query.postId === "string" ? req.query.postId : undefined;
    if (metricKey === "followers") {
      const points = followerSeries(req.user!.id, range, { platform, accountId });
      return res.json({
        metricKey, displayName: "Followers", unit: "count", granularity,
        points, sources: ["profile counters collected at each sync"],
        basis: "Follower counts are gauges recorded at collection time; the series shows the last recorded value per day.",
        lastUpdated: points.length > 0 ? range.to : null,
      });
    }
    if (metricKey === "publishing_frequency") {
      const points = publishingFrequency(req.user!.id, range, granularity, { platform });
      return res.json({
        metricKey, displayName: "Publishing frequency", unit: "count", granularity,
        points, sources: ["CLIPFORGE publish records"], basis: "Posts published through CLIPFORGE per period.",
        lastUpdated: null,
      });
    }
    const series = trendSeries(req.user!.id, metricKey, range, granularity, { platform, accountId, postId });
    res.json(series);
  });

  // -- posts (§8) -------------------------------------------------------------------------
  an.get("/posts", requireAuth, (req: AuthedRequest, res) => {
    const platform = platformFilter(req);
    const accountId = typeof req.query.accountId === "string" ? req.query.accountId : undefined;
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    const posts = userPosts(req.user!.id, { platform, accountId, projectId }).map(summarizePost);
    res.json({ posts });
  });

  an.get("/posts/:id", requireAuth, (req: AuthedRequest, res) => {
    const ctx = postContext(req.user!.id, String(req.params.id));
    if (!ctx) return fail(res, 404, "NOT_FOUND", "Post not found.");
    const summary = summarizePost(ctx);
    const attrs = postAttributes(ctx);
    const siblings = userPosts(req.user!.id, { accountId: ctx.post.account_id })
      .filter((p) => p.post.id !== ctx.post.id)
      .map(summarizePost)
      .sort((a, b) => (b.metrics.views?.value ?? -1) - (a.metrics.views?.value ?? -1))
      .slice(0, 5);
    res.json({ post: summary, attributes: attrs, compareCandidates: siblings });
  });

  an.get("/posts/:id/history", requireAuth, (req: AuthedRequest, res) => {
    const ctx = postContext(req.user!.id, String(req.params.id));
    if (!ctx) return fail(res, 404, "NOT_FOUND", "Post not found.");
    const snapshots = db
      .prepare("SELECT * FROM analytics_post_snapshots WHERE platform_post_id = ? AND user_id = ? ORDER BY collected_at ASC")
      .all(ctx.post.id, req.user!.id);
    const values = db
      .prepare("SELECT * FROM analytics_metric_values WHERE platform_post_id = ? AND user_id = ? ORDER BY collected_at ASC")
      .all(ctx.post.id, req.user!.id);
    res.json({ snapshots, values });
  });

  // F10 (§8): serve the publish job's stored custom thumbnail,
  // owner-checked through the post's ownership (the same pattern as
  // the report-download route). 404 — never a placeholder image —
  // when the job stored no thumbnail or the file is gone.
  an.get("/posts/:id/thumbnail", requireAuth, (req: AuthedRequest, res) => {
    const ctx = postContext(req.user!.id, String(req.params.id));
    if (!ctx || !ctx.job) return fail(res, 404, "NOT_FOUND", "Post not found.");
    const meta = db
      .prepare("SELECT thumbnail_storage_key FROM post_metadata WHERE job_id = ?")
      .get(ctx.job.id) as { thumbnail_storage_key: string | null } | undefined;
    if (!meta?.thumbnail_storage_key) return fail(res, 404, "NOT_FOUND", "This post's publish job stored no thumbnail.");
    const abs = mediaPath(meta.thumbnail_storage_key);
    if (!fs.existsSync(abs)) return fail(res, 404, "NOT_FOUND", "The stored thumbnail file is missing from storage.");
    res.sendFile(abs);
  });

  const compareSchema = z.object({
    postIds: z.array(z.string().min(1)).min(2).max(6),
    from: z.string().optional(),
    to: z.string().optional(),
  }).strict();

  an.post("/posts/compare", requireAuth, (req: AuthedRequest, res) => {
    const parsed = compareSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, "VALIDATION_ERROR", "Provide 2–6 post ids to compare.");
    const range: DateRange | null = parsed.data.from && parsed.data.to && validDate(parsed.data.from) && validDate(parsed.data.to)
      ? { from: parsed.data.from, to: parsed.data.to }
      : null;
    const posts = [];
    for (const id of parsed.data.postIds) {
      const ctx = postContext(req.user!.id, id);
      if (!ctx) return fail(res, 404, "NOT_FOUND", `Post ${id} not found.`);
      const summary = summarizePost(ctx);
      // Same-range figures: range_activity rows recorded for exactly
      // this comparison range, when a sync collected them.
      let rangeMetrics: Record<string, number | null> = {};
      if (range) {
        const rows = db
          .prepare(
            `SELECT metric_key, metric_value FROM analytics_metric_values WHERE user_id = ? AND platform_post_id = ?
             AND kind = 'range_activity' AND availability_status = 'ok' AND range_start = ? AND range_end = ?
             ORDER BY collected_at DESC`,
          )
          .all(req.user!.id, id, range.from, range.to) as unknown as { metric_key: string; metric_value: number }[];
        const seen = new Set<string>();
        for (const r of rows) {
          if (seen.has(r.metric_key)) continue;
          seen.add(r.metric_key);
          rangeMetrics[r.metric_key] = r.metric_value;
        }
        if (Object.keys(rangeMetrics).length === 0) rangeMetrics = {};
      }
      posts.push({ ...summary, rangeMetrics: range ? rangeMetrics : null });
    }
    res.json({
      range,
      posts,
      note: range
        ? "Range figures are shown only where a sync collected date-scoped activity for exactly this range; otherwise the latest recorded counters are shown and labelled as lifetime."
        : "Latest recorded counters (lifetime) are shown. Pass a date range to compare date-scoped activity where a sync collected it.",
    });
  });

  an.post("/comparison-groups", requireAuth, (req: AuthedRequest, res) => {
    const name = typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim().slice(0, 120) : "Comparison";
    const postIds = Array.isArray(req.body?.postIds) ? req.body.postIds.map(String).slice(0, 6) : [];
    for (const id of postIds) {
      if (!postContext(req.user!.id, id)) return fail(res, 404, "NOT_FOUND", `Post ${id} not found.`);
    }
    const now = nowIso();
    const id = newId();
    db.prepare(
      "INSERT INTO analytics_comparison_groups (id, user_id, name, post_ids_json, range_start, range_end, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(id, req.user!.id, name, JSON.stringify(postIds),
      validDate(req.body?.from) ? req.body.from : null, validDate(req.body?.to) ? req.body.to : null, now, now);
    res.status(201).json({ group: { id, name, postIds, createdAt: now } });
  });

  an.get("/comparison-groups", requireAuth, (req: AuthedRequest, res) => {
    const rows = db.prepare("SELECT * FROM analytics_comparison_groups WHERE user_id = ? ORDER BY created_at DESC").all(req.user!.id) as unknown as Record<string, unknown>[];
    res.json({
      groups: rows.map((r) => ({
        id: r.id, name: r.name, postIds: parseJson(r.post_ids_json as string, []),
        rangeStart: r.range_start, rangeEnd: r.range_end, createdAt: r.created_at,
      })),
    });
  });

  // -- top content (§12) ---------------------------------------------------------------------
  an.get("/top-content", requireAuth, (req: AuthedRequest, res) => {
    const sort = typeof req.query.sort === "string" ? req.query.sort : "views";
    const platform = platformFilter(req);
    const accountId = typeof req.query.accountId === "string" ? req.query.accountId : undefined;
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    const clipId = typeof req.query.clipId === "string" ? req.query.clipId : undefined;
    const aspect = typeof req.query.aspect === "string" ? req.query.aspect : undefined;
    const range = parseRange(req);
    let summaries = userPosts(req.user!.id, { platform, accountId, projectId }).map(summarizePost);
    if (clipId) summaries = summaries.filter((s) => s.clipId === clipId);
    summaries = summaries.filter((s) => !s.publishedAt || (s.publishedAt.slice(0, 10) >= addDays(range.from, -3650) && s.publishedAt.slice(0, 10) <= range.to));
    if (aspect) {
      summaries = summaries.filter((s) => {
        const ctx = postContext(req.user!.id, s.id);
        return ctx ? postAttributes(ctx).aspectRatio === aspect : false;
      });
    }
    const valueOf = (s: (typeof summaries)[number]): number => {
      if (sort === "engagement") return s.engagementByViews.value ?? -1;
      if (sort === "watch_time") return s.metrics.watch_time_seconds?.value ?? -1;
      return s.metrics[sort]?.value ?? -1;
    };
    summaries.sort((a, b) => valueOf(b) - valueOf(a));
    res.json({
      sort,
      posts: summaries.slice(0, 50),
      note: "Rankings use the latest recorded metrics. A high-performing post does not prove which editing choice caused its performance.",
    });
  });

  // -- content analysis (§13) ------------------------------------------------------------------
  an.get("/content-analysis", requireAuth, (req: AuthedRequest, res) => {
    const groupBy = (typeof req.query.groupBy === "string" ? req.query.groupBy : "project") as string;
    if (!(CONTENT_GROUP_KEYS as readonly string[]).includes(groupBy)) {
      return fail(res, 400, "VALIDATION_ERROR", `groupBy must be one of: ${CONTENT_GROUP_KEYS.join(", ")}`);
    }
    res.json(buildContentAnalysis(req.user!.id, groupBy as ContentGroupKey));
  });

  // -- posting times (§15) ----------------------------------------------------------------------
  an.get("/posting-times", requireAuth, (req: AuthedRequest, res) => {
    const accountId = typeof req.query.accountId === "string" ? req.query.accountId : null;
    const settings = db.prepare("SELECT timezone FROM analytics_settings WHERE user_id = ?").get(req.user!.id) as { timezone: string } | undefined;
    const timezone = typeof req.query.timezone === "string" ? req.query.timezone : settings?.timezone ?? "Asia/Kolkata";
    res.json(buildPostingTimes(req.user!.id, accountId, timezone));
  });

  // -- sync (§17) ---------------------------------------------------------------------------------
  const syncSchema = z.object({
    accountId: z.string().min(1).optional(),
    platform: z.enum(["youtube", "instagram", "tiktok"]).optional(),
    all: z.boolean().optional(),
    postId: z.string().min(1).optional(),
    from: z.string().optional(),
    to: z.string().optional(),
  }).strict();

  an.post("/sync", requireAuth, (req: AuthedRequest, res) => {
    const parsed = syncSchema.safeParse(req.body ?? {});
    if (!parsed.success) return fail(res, 400, "VALIDATION_ERROR", "Invalid sync request.");
    const body = parsed.data;
    if (body.accountId && !ownedAccount(req.user!.id, body.accountId)) {
      return fail(res, 404, "NOT_FOUND", "Account not found.");
    }
    if (body.postId && !postContext(req.user!.id, body.postId)) {
      return fail(res, 404, "NOT_FOUND", "Post not found.");
    }
    const { job, deduplicated } = createSyncJob(req.user!.id, {
      accountId: body.accountId,
      platform: body.platform,
      all: body.all,
      postId: body.postId,
      from: body.from,
      to: body.to,
      source: body.postId ? "post_refresh" : "manual",
    });
    res.status(deduplicated ? 200 : 201).json({ job: publicSyncJob(job), deduplicated });
  });

  an.get("/sync/jobs", requireAuth, (req: AuthedRequest, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : null;
    const rows = db
      .prepare(`SELECT * FROM analytics_sync_jobs WHERE user_id = ? ${status ? "AND status = ?" : ""} ORDER BY created_at DESC LIMIT 100`)
      .all(...(status ? [req.user!.id, status] : [req.user!.id])) as unknown as AnalyticsSyncJobRow[];
    res.json({ jobs: rows.map(publicSyncJob) });
  });

  an.get("/sync/jobs/:id", requireAuth, (req: AuthedRequest, res) => {
    const job = db.prepare("SELECT * FROM analytics_sync_jobs WHERE id = ? AND user_id = ?").get(String(req.params.id), req.user!.id) as unknown as AnalyticsSyncJobRow | undefined;
    if (!job) return fail(res, 404, "NOT_FOUND", "Sync job not found.");
    const attempts = db.prepare("SELECT * FROM analytics_sync_attempts WHERE job_id = ? ORDER BY attempt_no ASC").all(job.id);
    res.json({ job: publicSyncJob(job), attempts });
  });

  an.post("/sync/jobs/:id/retry", requireAuth, (req: AuthedRequest, res) => {
    const job = db.prepare("SELECT * FROM analytics_sync_jobs WHERE id = ? AND user_id = ?").get(String(req.params.id), req.user!.id) as unknown as AnalyticsSyncJobRow | undefined;
    if (!job) return fail(res, 404, "NOT_FOUND", "Sync job not found.");
    if (!["FAILED", "PARTIAL_SUCCESS", "AUTH_REQUIRED", "CANCELLED"].includes(job.status)) {
      return fail(res, 409, "NOT_RETRYABLE", `A job in status ${job.status} cannot be retried.`);
    }
    if (job.status === "AUTH_REQUIRED") {
      const account = job.account_id ? ownedAccount(req.user!.id, job.account_id) : undefined;
      if (account && account.status === "AUTH_REQUIRED") {
        return fail(res, 409, "AUTH_REQUIRED", "Reconnect the account in the Publishing Center before retrying this sync.");
      }
    }
    db.prepare(
      "UPDATE analytics_sync_jobs SET status = 'QUEUED', attempt_count = 0, next_attempt_at = NULL, error = NULL, error_code = NULL, error_class = NULL, finished_at = NULL, updated_at = ? WHERE id = ?",
    ).run(nowIso(), job.id);
    audit(req.user!.id, "sync_retried", { jobId: job.id });
    const fresh = db.prepare("SELECT * FROM analytics_sync_jobs WHERE id = ?").get(job.id) as unknown as AnalyticsSyncJobRow;
    res.json({ job: publicSyncJob(fresh) });
  });

  an.post("/sync/jobs/:id/cancel", requireAuth, (req: AuthedRequest, res) => {
    const job = db.prepare("SELECT * FROM analytics_sync_jobs WHERE id = ? AND user_id = ?").get(String(req.params.id), req.user!.id) as unknown as AnalyticsSyncJobRow | undefined;
    if (!job) return fail(res, 404, "NOT_FOUND", "Sync job not found.");
    if (job.status !== "QUEUED") {
      return fail(res, 409, "NOT_CANCELLABLE", "Only a queued sync can be cancelled; a running sync finishes its current read and stops.");
    }
    db.prepare("UPDATE analytics_sync_jobs SET status = 'CANCELLED', finished_at = ?, updated_at = ? WHERE id = ?").run(nowIso(), nowIso(), job.id);
    res.json({ ok: true });
  });

  an.get("/sync/history", requireAuth, (req: AuthedRequest, res) => {
    const rows = db
      .prepare("SELECT * FROM analytics_sync_jobs WHERE user_id = ? AND status IN ('COMPLETED', 'PARTIAL_SUCCESS', 'FAILED', 'AUTH_REQUIRED', 'CANCELLED') ORDER BY created_at DESC LIMIT 100")
      .all(req.user!.id) as unknown as AnalyticsSyncJobRow[];
    const accounts = db.prepare("SELECT id, platform, username, last_synced_at FROM platform_accounts WHERE user_id = ? AND status != 'DISCONNECTED'").all(req.user!.id);
    res.json({ history: rows.map(publicSyncJob), accounts });
  });

  // -- settings (§17 refresh frequency) --------------------------------------------------------------
  an.get("/settings", requireAuth, (req: AuthedRequest, res) => {
    const row = db.prepare("SELECT * FROM analytics_settings WHERE user_id = ?").get(req.user!.id) as { auto_sync_minutes: number; timezone: string } | undefined;
    res.json({ settings: { autoSyncMinutes: row?.auto_sync_minutes ?? 0, timezone: row?.timezone ?? "Asia/Kolkata" } });
  });

  const settingsSchema = z.object({
    autoSyncMinutes: z.number().int().min(0).max(10080),
    timezone: z.string().min(1).max(80),
  }).strict();

  an.put("/settings", requireAuth, (req: AuthedRequest, res) => {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, "VALIDATION_ERROR", "Invalid analytics settings.");
    try {
      Intl.DateTimeFormat("en-US", { timeZone: parsed.data.timezone });
    } catch {
      return fail(res, 400, "VALIDATION_ERROR", "Unknown timezone.");
    }
    db.prepare(
      `INSERT INTO analytics_settings (user_id, auto_sync_minutes, timezone, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET auto_sync_minutes = excluded.auto_sync_minutes, timezone = excluded.timezone, updated_at = excluded.updated_at`,
    ).run(req.user!.id, parsed.data.autoSyncMinutes, parsed.data.timezone, nowIso());
    res.json({ settings: { autoSyncMinutes: parsed.data.autoSyncMinutes, timezone: parsed.data.timezone } });
  });

  // -- insights (§14) -------------------------------------------------------------------------------------
  an.post("/insights/generate", requireAuth, (req: AuthedRequest, res) => {
    const range = parseRange(req);
    const result = generateInsights(req.user!.id, range);
    res.status(201).json({ ...result, range });
  });

  an.get("/insights", requireAuth, (req: AuthedRequest, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : "ACTIVE";
    const rows = db
      .prepare("SELECT * FROM analytics_insights WHERE user_id = ? AND status = ? ORDER BY created_at DESC LIMIT 100")
      .all(req.user!.id, status) as unknown as AnalyticsInsightRow[];
    res.json({ insights: rows.map(publicInsight) });
  });

  an.get("/insights/:id", requireAuth, (req: AuthedRequest, res) => {
    const row = db.prepare("SELECT * FROM analytics_insights WHERE id = ? AND user_id = ?").get(String(req.params.id), req.user!.id) as unknown as AnalyticsInsightRow | undefined;
    if (!row) return fail(res, 404, "NOT_FOUND", "Insight not found.");
    const evidence = db.prepare("SELECT * FROM analytics_insight_evidence WHERE insight_id = ? ORDER BY created_at ASC").all(row.id) as unknown as Record<string, unknown>[];
    res.json({
      insight: publicInsight(row),
      evidence: evidence.map((e) => ({
        label: e.label, metricKey: e.metric_key, value: parseJson(e.value_json as string, null), platformPostId: e.platform_post_id,
      })),
    });
  });

  const insightAction = (status: string, action: string) => (req: AuthedRequest, res: Response) => {
    const row = db.prepare("SELECT * FROM analytics_insights WHERE id = ? AND user_id = ?").get(String(req.params.id), req.user!.id) as unknown as AnalyticsInsightRow | undefined;
    if (!row) return fail(res, 404, "NOT_FOUND", "Insight not found.");
    db.prepare("UPDATE analytics_insights SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), row.id);
    audit(req.user!.id, action, { insightId: row.id });
    res.json({ ok: true, status });
  };
  an.post("/insights/:id/dismiss", requireAuth, insightAction("DISMISSED", "insight_dismissed"));
  an.post("/insights/:id/save", requireAuth, insightAction("SAVED", "insight_saved"));

  // -- reports (§16) ------------------------------------------------------------------------------------------------
  const reportSchema = z.object({
    name: z.string().min(1).max(160),
    from: z.string().optional(),
    to: z.string().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  }).strict();

  an.post("/reports", requireAuth, (req: AuthedRequest, res) => {
    const parsed = reportSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, "VALIDATION_ERROR", "A report needs a name.");
    const cfg = normalizeReportConfig(parsed.data.config ?? {});
    const range = parseRange(req);
    const from = parsed.data.from && validDate(parsed.data.from) ? parsed.data.from : range.from;
    const to = parsed.data.to && validDate(parsed.data.to) ? parsed.data.to : range.to;
    const now = nowIso();
    const id = newId();
    db.prepare(
      "INSERT INTO analytics_reports (id, user_id, name, config_json, status, range_start, range_end, created_at, updated_at) VALUES (?, ?, ?, ?, 'QUEUED', ?, ?, ?, ?)",
    ).run(id, req.user!.id, parsed.data.name, JSON.stringify(cfg), from, to, now, now);
    for (const format of cfg.formats) {
      db.prepare(
        "INSERT INTO analytics_report_exports (id, report_id, user_id, format, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'QUEUED', ?, ?)",
      ).run(newId(), id, req.user!.id, format, now, now);
    }
    audit(req.user!.id, "report_created", { reportId: id, formats: cfg.formats });
    const report = db.prepare("SELECT * FROM analytics_reports WHERE id = ?").get(id) as unknown as AnalyticsReportRow;
    res.status(201).json({ report: publicReport(report) });
  });

  an.get("/reports", requireAuth, (req: AuthedRequest, res) => {
    const rows = db.prepare("SELECT * FROM analytics_reports WHERE user_id = ? ORDER BY created_at DESC LIMIT 100").all(req.user!.id) as unknown as AnalyticsReportRow[];
    res.json({ reports: rows.map(publicReport) });
  });

  an.get("/reports/:id", requireAuth, (req: AuthedRequest, res) => {
    const report = ownedReport(req, res);
    if (!report) return;
    res.json({ report: publicReport(report) });
  });

  an.delete("/reports/:id", requireAuth, (req: AuthedRequest, res) => {
    const report = ownedReport(req, res);
    if (!report) return;
    const confirmed = req.query.confirm === "true" || (req.body as { confirm?: unknown } | undefined)?.confirm === true;
    if (!confirmed) {
      return fail(res, 409, "CONFIRMATION_REQUIRED", "Deleting a report removes its generated files. Repeat with ?confirm=true to proceed.");
    }
    const exports = db.prepare("SELECT * FROM analytics_report_exports WHERE report_id = ?").all(report.id) as unknown as { storage_key: string | null; format: string }[];
    for (const exp of exports) {
      if (exp.storage_key) {
        try { fs.unlinkSync(path.join(config.analytics.reportsDir, exp.storage_key)); } catch { /* file already gone */ }
      }
    }
    db.prepare("DELETE FROM analytics_reports WHERE id = ?").run(report.id);
    audit(req.user!.id, "report_deleted", { reportId: report.id });
    res.json({ ok: true });
  });

  an.get("/report-exports/:exportId/download", requireAuth, (req: AuthedRequest, res) => {
    const exp = db
      .prepare("SELECT * FROM analytics_report_exports WHERE id = ? AND user_id = ?")
      .get(String(req.params.exportId), req.user!.id) as unknown as { id: string; report_id: string; format: string; status: string; storage_key: string | null } | undefined;
    if (!exp) return fail(res, 404, "NOT_FOUND", "Report export not found.");
    if (exp.status !== "COMPLETED" || !exp.storage_key) {
      return fail(res, 409, "NOT_READY", "This report file is not ready to download.");
    }
    const abs = path.join(config.analytics.reportsDir, exp.storage_key);
    if (!fs.existsSync(abs)) return fail(res, 404, "NOT_FOUND", "The generated file is missing from storage.");
    audit(req.user!.id, "report_downloaded", { exportId: exp.id, format: exp.format });
    res.download(abs, `clipforge-analytics-${exp.report_id.slice(0, 8)}.${exp.format}`);
  });

  function ownedReport(req: AuthedRequest, res: Response): AnalyticsReportRow | null {
    const report = db.prepare("SELECT * FROM analytics_reports WHERE id = ? AND user_id = ?").get(String(req.params.id), req.user!.id) as unknown as AnalyticsReportRow | undefined;
    if (!report) {
      fail(res, 404, "NOT_FOUND", "Report not found.");
      return null;
    }
    return report;
  }

  function publicReport(report: AnalyticsReportRow) {
    const exports = db.prepare("SELECT * FROM analytics_report_exports WHERE report_id = ? ORDER BY format ASC").all(report.id) as unknown as Record<string, unknown>[];
    return {
      id: report.id,
      name: report.name,
      config: parseJson(report.config_json, {}),
      status: report.status,
      error: report.error,
      rangeStart: report.range_start,
      rangeEnd: report.range_end,
      createdAt: report.created_at,
      generatedAt: report.generated_at,
      exports: exports.map((e) => ({
        id: e.id, format: e.format, status: e.status, fileSize: e.file_size, error: e.error,
        downloadUrl: e.status === "COMPLETED" ? `/api/analytics/report-exports/${e.id}/download` : null,
      })),
    };
  }

  function publicInsight(row: AnalyticsInsightRow) {
    return {
      id: row.id,
      kind: row.kind,
      ruleKey: row.rule_key,
      title: row.title,
      body: row.body,
      platform: row.platform,
      accountId: row.account_id,
      rangeStart: row.range_start,
      rangeEnd: row.range_end,
      sampleSize: row.sample_size,
      formula: row.formula,
      limitations: row.limitations,
      status: row.status,
      createdAt: row.created_at,
    };
  }

  app.use("/api/analytics", an);
}
