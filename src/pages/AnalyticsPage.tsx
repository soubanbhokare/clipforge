// Phase 11 — Analytics Dashboard & Performance Intelligence.
//
// Everything on this page comes from saved analytics records via
// /api/analytics. A metric the platform did not provide is shown as
// "Unavailable" — never as 0 — and charts are drawn only from saved
// points (gaps stay gaps). When nothing has been synced yet, the
// page says so and points at the Sync tab instead of inventing
// sample charts.

import { useCallback, useEffect, useMemo, useState } from "react";
import { navigateTo } from "../features/auth/routing";
import {
  analyticsApi,
  type AccountCapability,
  type AnalyticsReport,
  type ContentGroup,
  type Formula,
  type Insight,
  type InsightEvidence,
  type MetricTotal,
  type OverviewResponse,
  type Platform,
  type PlatformComparisonEntry,
  type PostSummary,
  type PostingTimes,
  type SyncJob,
  type TrendResponse,
} from "../services/analytics";
import { exportDownloadUrl, publishingApi, type PlatformAccount, type ProviderStatus } from "../services/publishing";
import { projectsApi } from "../services/projects";
import { BarChart, LineChart } from "../components/analytics/Charts";
import styles from "./AnalyticsPage.module.css";

type Tab = "overview" | "comparison" | "posts" | "trends" | "content" | "insights" | "posting" | "reports" | "sync";

const PLATFORM_LABEL: Record<Platform, string> = { youtube: "YouTube", instagram: "Instagram", tiktok: "TikTok" };
const PLATFORMS: Platform[] = ["youtube", "instagram", "tiktok"];

type PresetKey = "today" | "7d" | "30d" | "90d" | "thisMonth" | "prevMonth" | "custom";

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function presetRange(preset: PresetKey): { from: string; to: string } {
  const now = new Date();
  const today = isoDay(now);
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "7d":
      return { from: isoDay(new Date(now.getTime() - 6 * 86400000)), to: today };
    case "90d":
      return { from: isoDay(new Date(now.getTime() - 89 * 86400000)), to: today };
    case "thisMonth":
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case "prevMonth": {
      const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
      return { from: isoDay(first), to: isoDay(last) };
    }
    default:
      return { from: isoDay(new Date(now.getTime() - 29 * 86400000)), to: today };
  }
}

function fmtNum(v: number | null | undefined): string {
  if (v === null || v === undefined) return "Unavailable";
  return Math.round(v).toLocaleString("en-IN");
}

function fmtMetric(m: MetricTotal): string {
  // Honour availability, not just the value: a metric the platform
  // marked unavailable renders "Unavailable" even when a (stale)
  // value is attached to it.
  if (m.availability === "unavailable" || m.value === null) return "Unavailable";
  return m.unit === "seconds" ? `${fmtNum(m.value)}s` : fmtNum(m.value);
}

function fmtDelta(m: MetricTotal): string {
  if (m.delta === null) return "—";
  const sign = m.delta > 0 ? "+" : "";
  const pct = m.pctChange !== null ? ` (${sign}${m.pctChange.toFixed(1)}%)` : "";
  return `${sign}${fmtNum(m.delta)}${pct}`;
}

function fmtWhen(iso: string | null): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong.";
}

const TREND_METRICS = ["views", "reach", "likes", "comments", "shares", "followers", "publishing_frequency"];
const REPORT_METRICS = ["views", "reach", "likes", "comments", "shares", "saves", "watch_time_seconds", "followers"];
const CONTENT_GROUPS = [
  { key: "project", label: "Project" },
  { key: "sourceVideo", label: "Source video" },
  { key: "clip", label: "Generated clip" },
  { key: "captionTemplate", label: "Caption template" },
  { key: "aspectRatio", label: "Aspect ratio" },
  { key: "reframeMode", label: "Reframing mode" },
  { key: "brollUsage", label: "B-roll usage" },
  { key: "enhancementPreset", label: "Enhancement preset" },
  { key: "platform", label: "Publishing platform" },
  { key: "account", label: "Publishing account" },
];

export default function AnalyticsPage() {
  const [tab, setTab] = useState<Tab>("overview");
  const [preset, setPreset] = useState<PresetKey>("30d");
  const [range, setRange] = useState(() => presetRange("30d"));
  const [platform, setPlatform] = useState<Platform | "">("");
  const [formula, setFormula] = useState<Formula>("by_views");
  const [accounts, setAccounts] = useState<PlatformAccount[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    publishingApi.accounts().then((r) => setAccounts(r.accounts)).catch((err) => { setAccounts([]); setError(errText(err)); });
  }, []);

  const applyPreset = (p: PresetKey) => {
    setPreset(p);
    if (p !== "custom") setRange(presetRange(p));
  };

  const syncAll = async () => {
    setError(null);
    try {
      const r = await analyticsApi.startSync({ all: true });
      setNotice(r.deduplicated ? "A sync is already running — duplicate syncs are prevented." : "Analytics sync queued. Watch its progress in the Sync tab.");
      setTab("sync");
    } catch (err) {
      setError(errText(err));
    }
  };

  const hasAccounts = accounts.length > 0;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <button className={styles.primaryButton} onClick={() => void syncAll()} disabled={!hasAccounts}>
          Sync all accounts
        </button>
      </header>

      {error && <p className={styles.errorBanner}>{error}</p>}
      {notice && <p className={styles.noticeBanner}>{notice}</p>}
      {!hasAccounts && (
        <p className={styles.noticeBanner}>
          No social account is connected yet. Connect YouTube, Instagram or TikTok in the Publishing Center,
          publish through CLIPFORGE, then run a sync here — until records exist, every figure stays empty.
        </p>
      )}

      <div className={styles.controls}>
        <div className={styles.presetGroup} role="group" aria-label="Date range">
          {([
            ["today", "Today"], ["7d", "Last 7 days"], ["30d", "Last 30 days"], ["90d", "Last 90 days"],
            ["thisMonth", "This month"], ["prevMonth", "Previous month"], ["custom", "Custom"],
          ] as [PresetKey, string][]).map(([key, label]) => (
            <button key={key} className={preset === key ? styles.chipActive : styles.chip} onClick={() => applyPreset(key)}>
              {label}
            </button>
          ))}
        </div>
        {preset === "custom" && (
          <span className={styles.customRange}>
            <input type="date" value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} aria-label="From date" />
            <input type="date" value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} aria-label="To date" />
          </span>
        )}
        <select value={platform} onChange={(e) => setPlatform(e.target.value as Platform | "")} aria-label="Platform filter">
          <option value="">All platforms</option>
          {PLATFORMS.map((p) => <option key={p} value={p}>{PLATFORM_LABEL[p]}</option>)}
        </select>
        <select value={formula} onChange={(e) => setFormula(e.target.value as Formula)} aria-label="Engagement formula">
          <option value="by_views">Engagement by views</option>
          <option value="by_reach">Engagement by reach</option>
        </select>
        <span className={styles.rangeLabel}>{range.from} → {range.to}</span>
      </div>

      <nav className={styles.tabs} aria-label="Analytics sections">
        {([
          ["overview", "Overview"], ["comparison", "Platform Comparison"], ["posts", "Posts"],
          ["trends", "Trends"], ["content", "Content Analysis"], ["insights", "Insights"],
          ["posting", "Posting Times"], ["reports", "Reports"], ["sync", "Sync & Capabilities"],
        ] as [Tab, string][]).map(([key, label]) => (
          <button key={key} className={tab === key ? styles.tabActive : styles.tab} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </nav>

      {tab === "overview" && <Overview range={range} platform={platform || undefined} formula={formula} onError={setError} />}
      {tab === "comparison" && <Comparison range={range} formula={formula} onError={setError} />}
      {tab === "posts" && <Posts platform={platform || undefined} onError={setError} setNotice={setNotice} />}
      {tab === "trends" && <Trends range={range} platform={platform || undefined} onError={setError} />}
      {tab === "content" && <ContentAnalysis onError={setError} />}
      {tab === "insights" && <Insights range={range} onError={setError} setNotice={setNotice} />}
      {tab === "posting" && <PostingTimesView onError={setError} />}
      {tab === "reports" && <Reports range={range} onError={setError} setNotice={setNotice} />}
      {tab === "sync" && <SyncCenter accounts={accounts} onError={setError} setNotice={setNotice} />}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Overview({ range, platform, formula, onError }: { range: { from: string; to: string }; platform?: Platform; formula: Formula; onError: (e: string | null) => void }) {
  const [data, setData] = useState<OverviewResponse | null>(null);
  useEffect(() => {
    let live = true;
    onError(null);
    analyticsApi.overview(range.from, range.to, platform, formula)
      .then((r) => { if (live) setData(r); })
      .catch((err) => onError(errText(err)));
    return () => { live = false; };
  }, [range, platform, formula, onError]);

  if (!data) return <p className={styles.loading}>Loading overview…</p>;
  const allUnavailable = data.metrics.every((m) => m.availability === "unavailable" || m.value === null) && data.publishedPosts.value === 0;
  return (
    <section className={styles.section}>
      {allUnavailable && (
        <div className={styles.card}>
          <h2>Nothing synced yet</h2>
          <p>No analytics records exist for this selection. Connect an account, publish through CLIPFORGE and run a sync — figures appear here only when a platform actually returns them.</p>
        </div>
      )}
      <div className={styles.kpiGrid}>
        {data.metrics.map((m) => (
          <article key={m.metricKey} className={styles.kpiCard}>
            <span className={styles.kpiLabel}>{m.displayName}</span>
            <span className={styles.kpiValue}>{fmtMetric(m)}</span>
            <span className={styles.kpiMeta}>
              {m.availability !== "unavailable" && m.value !== null ? <>Δ {fmtDelta(m)} vs previous period</> : "Not provided by the connected platforms for this selection"}
            </span>
            <span className={styles.kpiMeta}>
              Basis: {m.basis ?? "—"} · Updated: {fmtWhen(m.lastUpdated)}
            </span>
            {m.note && <span className={styles.kpiNote}>{m.note}</span>}
          </article>
        ))}
        <article className={styles.kpiCard}>
          <span className={styles.kpiLabel}>Published posts</span>
          <span className={styles.kpiValue}>{data.publishedPosts.value}</span>
          <span className={styles.kpiMeta}>Δ {data.publishedPosts.delta >= 0 ? "+" : ""}{data.publishedPosts.delta} vs previous period ({data.publishedPosts.previousValue})</span>
          <span className={styles.kpiMeta}>Source: CLIPFORGE publish records</span>
        </article>
        <article className={styles.kpiCard}>
          <span className={styles.kpiLabel}>Engagement rate</span>
          {data.engagement ? (
            <>
              <span className={styles.kpiValue}>
                {data.engagement.availability === "ok" && data.engagement.value !== null ? `${data.engagement.value.toFixed(2)}%` : "N/A"}
              </span>
              <span className={styles.kpiMeta}>{data.engagement.formulaText}</span>
              {data.engagement.reason && <span className={styles.kpiNote}>{data.engagement.reason}</span>}
            </>
          ) : (
            <>
              <span className={styles.kpiValue}>N/A</span>
              <span className={styles.kpiNote}>{data.engagementNote}</span>
            </>
          )}
        </article>
      </div>
      <p className={styles.footnote}>
        {data.periodNote} Last successful sync: {fmtWhen(data.lastSuccessfulSyncAt)}.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------

function Comparison({ range, formula, onError }: { range: { from: string; to: string }; formula: Formula; onError: (e: string | null) => void }) {
  const [entries, setEntries] = useState<PlatformComparisonEntry[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  useEffect(() => {
    onError(null);
    analyticsApi.platformComparison(range.from, range.to, formula)
      .then((r) => { setEntries(r.platforms); setWarnings(r.warnings); })
      .catch((err) => onError(errText(err)));
  }, [range, formula, onError]);

  const metricKeys = ["views", "reach", "likes", "comments", "shares", "saves", "watch_time_seconds", "followers"];
  return (
    <section className={styles.section}>
      <div className={styles.card}>
        <h2>Platform comparison</h2>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr><th>Metric</th>{entries.map((e) => <th key={e.platform}>{PLATFORM_LABEL[e.platform]}</th>)}</tr>
            </thead>
            <tbody>
              {metricKeys.map((key) => {
                // The metric's known basis, taken from any platform
                // cell that carries one, so an unavailable cell still
                // shows its basis line instead of silently dropping it.
                // When no cell carries a basis, the line shows "—" —
                // a basis is never invented.
                const knownBasis = entries
                  .map((e) => e.metrics.find((x) => x.metricKey === key)?.basis)
                  .find((b): b is string => !!b) ?? null;
                return (
                  <tr key={key}>
                    <td>{entries[0]?.metrics.find((m) => m.metricKey === key)?.displayName ?? key}</td>
                    {entries.map((e) => {
                      const m = e.metrics.find((x) => x.metricKey === key);
                      const unavailable = !m || m.availability === "unavailable" || m.value === null;
                      const basis = m?.basis ?? (unavailable ? knownBasis : null);
                      return (
                        <td key={e.platform}>
                          {m ? fmtMetric(m) : "Unavailable"}
                          {(basis !== null || unavailable) && (
                            <span className={styles.cellNote}>Basis: {basis ? basis.replace(/_/g, " ") : "—"}</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              <tr>
                <td>Engagement ({formula === "by_reach" ? "by reach" : "by views"})</td>
                {entries.map((e) => (
                  <td key={e.platform}>
                    {e.engagement.availability === "ok" && e.engagement.value !== null ? `${e.engagement.value.toFixed(2)}%` : "N/A"}
                    <span className={styles.cellNote}>{e.engagement.formulaText}</span>
                  </td>
                ))}
              </tr>
              <tr>
                <td>Published posts in range</td>
                {entries.map((e) => <td key={e.platform}>{e.publishedPostCount}</td>)}
              </tr>
              <tr>
                <td>Top post</td>
                {entries.map((e) => (
                  <td key={e.platform}>
                    {e.topPost ? (
                      e.topPost.url
                        ? <a href={e.topPost.url} target="_blank" rel="noreferrer">{e.topPost.title || e.topPost.id} ({fmtNum(e.topPost.views)} views)</a>
                        : `${e.topPost.title || e.topPost.id} (${fmtNum(e.topPost.views)} views)`
                    ) : "—"}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
        <p className={styles.footnote}>
          “Published posts in range” is a count of the posts CLIPFORGE published inside the selected range, and
          “Top post” is the single best-performing post of the range (by views) — these two rows are a count / a
          best-of over the selected range, so they carry no collection basis of their own.
        </p>
        {warnings.map((w) => <p key={w} className={styles.footnote}>{w}</p>)}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------

function Posts({ platform, onError, setNotice }: { platform?: Platform; onError: (e: string | null) => void; setNotice: (n: string | null) => void }) {
  const [posts, setPosts] = useState<PostSummary[]>([]);
  const [sort, setSort] = useState("views");
  const [selected, setSelected] = useState<PostSummary | null>(null);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [comparison, setComparison] = useState<{ posts: (PostSummary & { rangeMetrics: Record<string, number | null> | null })[]; note: string } | null>(null);

  const load = useCallback(() => {
    onError(null);
    analyticsApi.posts({ platform }).then((r) => setPosts(r.posts)).catch((err) => onError(errText(err)));
  }, [platform, onError]);
  useEffect(load, [load]);

  const sorted = useMemo(() => {
    const valueOf = (p: PostSummary): number => {
      if (sort === "engagement") return p.engagementByViews.value ?? -1;
      if (sort === "watch_time") return p.metrics.watch_time_seconds?.value ?? -1;
      return p.metrics[sort]?.value ?? -1;
    };
    return [...posts].sort((a, b) => valueOf(b) - valueOf(a));
  }, [posts, sort]);

  const toggleCompare = (id: string) => {
    setCompareIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : ids.length >= 6 ? ids : [...ids, id]));
  };

  const runCompare = async () => {
    try {
      const r = await analyticsApi.comparePosts(compareIds);
      setComparison(r);
    } catch (err) {
      onError(errText(err));
    }
  };

  const refreshPost = async (post: PostSummary) => {
    try {
      const r = await analyticsApi.startSync({ postId: post.id });
      setNotice(r.deduplicated ? "A refresh for this post is already queued." : `Refresh queued for “${post.title || post.platformPostId}”.`);
    } catch (err) {
      onError(errText(err));
    }
  };

  const metricCell = (p: PostSummary, key: string) => {
    const m = p.metrics[key];
    if (!m) return "Unavailable";
    if (m.availability !== "ok") return "Unavailable";
    return key.includes("watch_time") ? `${fmtNum(m.value)}s` : fmtNum(m.value);
  };

  return (
    <section className={styles.section}>
      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <h2>Published posts</h2>
          <label>
            Sort by{" "}
            <select value={sort} onChange={(e) => setSort(e.target.value)}>
              {["views", "reach", "likes", "comments", "shares", "saves", "watch_time", "engagement"].map((k) => (
                <option key={k} value={k}>{k.replace("_", " ")}</option>
              ))}
            </select>
          </label>
        </div>
        {posts.length === 0 && <p>No posts have been published through CLIPFORGE for this selection yet.</p>}
        {posts.length > 0 && (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Compare</th><th>Post</th><th>Platform</th><th>Published</th><th>Views</th><th>Reach</th>
                  <th>Likes</th><th>Comments</th><th>Shares</th><th>Saves</th><th>Watch time</th><th>Engagement (views)</th><th></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((p) => (
                  <tr key={p.id}>
                    <td><input type="checkbox" checked={compareIds.includes(p.id)} onChange={() => toggleCompare(p.id)} aria-label={`Compare ${p.title || p.platformPostId}`} /></td>
                    <td>
                      <PostThumb post={p} width={72} />
                      <button className={styles.linkButton} onClick={() => setSelected(p)}>{p.title || p.platformPostId}</button>
                      <span className={styles.cellNote}>@{p.accountUsername ?? "—"} · synced {fmtWhen(p.lastSyncedAt)}</span>
                    </td>
                    <td>{PLATFORM_LABEL[p.platform]}</td>
                    <td>{p.publishedAt ? new Date(p.publishedAt).toLocaleDateString("en-IN") : "—"}</td>
                    <td>{metricCell(p, "views")}</td>
                    <td>{metricCell(p, "reach")}</td>
                    <td>{metricCell(p, "likes")}</td>
                    <td>{metricCell(p, "comments")}</td>
                    <td>{metricCell(p, "shares")}</td>
                    <td>{metricCell(p, "saves")}</td>
                    <td>{metricCell(p, "watch_time_seconds")}</td>
                    <td>{p.engagementByViews.availability === "ok" && p.engagementByViews.value !== null ? `${p.engagementByViews.value.toFixed(2)}%` : "N/A"}</td>
                    <td><button className={styles.smallButton} onClick={() => void refreshPost(p)}>Refresh</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {compareIds.length >= 2 && (
          <button className={styles.primaryButton} onClick={() => void runCompare()}>Compare {compareIds.length} selected posts</button>
        )}
        {compareIds.length >= 6 && (
          <p className={styles.cellNote}>Compare is limited to 6 posts — untick one to swap in another.</p>
        )}
        {comparison && (
          <div className={styles.compareBox}>
            <h3>Comparison</h3>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead><tr><th>Post</th><th>Views</th><th>Likes</th><th>Comments</th><th>Shares</th><th>Engagement (views)</th></tr></thead>
                <tbody>
                  {comparison.posts.map((p) => (
                    <tr key={p.id}>
                      <td>{p.title || p.platformPostId} ({PLATFORM_LABEL[p.platform]})</td>
                      <td>{p.rangeMetrics?.views ?? metricCell(p, "views")}</td>
                      <td>{p.rangeMetrics?.likes ?? metricCell(p, "likes")}</td>
                      <td>{p.rangeMetrics?.comments ?? metricCell(p, "comments")}</td>
                      <td>{p.rangeMetrics?.shares ?? metricCell(p, "shares")}</td>
                      <td>{p.engagementByViews.availability === "ok" && p.engagementByViews.value !== null ? `${p.engagementByViews.value.toFixed(2)}%` : "N/A"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className={styles.footnote}>{comparison.note}</p>
          </div>
        )}
      </div>

      {selected && <PostDetail post={selected} onClose={() => setSelected(null)} onError={onError} />}
    </section>
  );
}

/** §8: the post's actual stored thumbnail (uploaded with the publish
 *  job in Phase 10). When the job stored none, a neutral placeholder
 *  block is shown — an image is never fabricated. */
function PostThumb({ post, width }: { post: PostSummary; width: number }) {
  const height = Math.round((width * 9) / 16);
  if (!post.thumbnailUrl) {
    return (
      <span
        aria-hidden="true"
        style={{
          display: "block", width, height, borderRadius: 6, marginBottom: 6,
          background: "repeating-linear-gradient(45deg, #141a26, #141a26 6px, #10141d 6px, #10141d 12px)",
          border: "1px solid #232a38",
        }}
      />
    );
  }
  return (
    <img
      src={post.thumbnailUrl}
      alt={`Thumbnail for ${post.title || post.platformPostId}`}
      loading="lazy"
      style={{ display: "block", width, height, objectFit: "cover", borderRadius: 6, marginBottom: 6, border: "1px solid #232a38" }}
    />
  );
}

interface HistoryValueRow {
  metric_key: string;
  metric_value: number | null;
  availability_status: string;
  availability_reason: string | null;
  kind: string | null;
  source: string | null;
  collected_at: string;
  range_start: string | null;
  range_end: string | null;
}

function PostDetail({ post, onClose, onError }: { post: PostSummary; onClose: () => void; onError: (e: string | null) => void }) {
  const [detail, setDetail] = useState<{ attributes: Record<string, string>; compareCandidates: PostSummary[] } | null>(null);
  const [historyCount, setHistoryCount] = useState<number | null>(null);
  const [historyValues, setHistoryValues] = useState<HistoryValueRow[]>([]);
  useEffect(() => {
    onError(null);
    analyticsApi.post(post.id)
      .then((r) => setDetail({ attributes: r.attributes, compareCandidates: r.compareCandidates }))
      .catch((err) => onError(errText(err)));
    analyticsApi.postHistory(post.id)
      .then((r) => {
        setHistoryCount(r.snapshots.length);
        setHistoryValues(r.values as unknown as HistoryValueRow[]);
      })
      .catch((err) => { setHistoryCount(null); setHistoryValues([]); onError(errText(err)); });
  }, [post.id, onError]);

  // F11 (§8): the post's metric history, grouped per metric from the
  // saved records. The chart series uses one point per day (the last
  // value recorded that day) and is drawn only with ≥2 points; the
  // table shows every recorded value.
  const historySeries = useMemo(() => {
    const byMetric = new Map<string, HistoryValueRow[]>();
    for (const v of historyValues) {
      if (!byMetric.has(v.metric_key)) byMetric.set(v.metric_key, []);
      byMetric.get(v.metric_key)!.push(v);
    }
    return [...byMetric.entries()]
      .map(([key, rows]) => {
        const sorted = [...rows].sort((a, b) => (a.collected_at < b.collected_at ? -1 : 1));
        const perDay = new Map<string, number>();
        for (const r of sorted) {
          if (r.availability_status === "ok" && r.metric_value !== null) {
            perDay.set(r.collected_at.slice(0, 10), r.metric_value);
          }
        }
        const points = [...perDay.entries()].map(([date, value]) => ({ date, value }));
        return { key, rows: sorted, points };
      })
      .filter((s) => s.rows.length > 0)
      .sort((a, b) => b.rows.length - a.rows.length || a.key.localeCompare(b.key));
  }, [historyValues]);

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <h2>{post.title || post.platformPostId}</h2>
        <button className={styles.smallButton} onClick={onClose}>Close</button>
      </div>
      <PostThumb post={post} width={180} />
      <p className={styles.footnote}>
        {PLATFORM_LABEL[post.platform]} · @{post.accountUsername ?? "—"} · Published {post.publishedAt ? fmtWhen(post.publishedAt) : "—"} ·
        Last metric sync {fmtWhen(post.lastSyncedAt)} · {historyCount !== null ? `${historyCount} snapshot(s) recorded` : ""}
      </p>
      <div className={styles.kpiGrid}>
        {Object.entries(post.metrics).map(([key, m]) => (
          <article key={key} className={styles.kpiCard}>
            <span className={styles.kpiLabel}>{key.replace(/_/g, " ")}</span>
            <span className={styles.kpiValue}>{m.availability === "ok" ? (key.includes("watch_time") ? `${fmtNum(m.value)}s` : fmtNum(m.value)) : "Unavailable"}</span>
            <span className={styles.kpiMeta}>
              {m.availability === "ok" ? `${m.source ?? ""} · ${m.kind ?? ""} · collected ${fmtWhen(m.collectedAt)}` : m.reason ?? "Not provided by the platform."}
            </span>
            {m.correctionFlag && <span className={styles.kpiNote}>A later sync recorded a lower cumulative value — the platform corrected this counter.</span>}
          </article>
        ))}
      </div>
      <p className={styles.footnote}>
        Engagement by reach: {post.engagementByReach.availability === "ok" && post.engagementByReach.value !== null ? `${post.engagementByReach.value.toFixed(2)}%` : "N/A"} ({post.engagementByReach.formulaText})
        {" · "}By views: {post.engagementByViews.availability === "ok" && post.engagementByViews.value !== null ? `${post.engagementByViews.value.toFixed(2)}%` : "N/A"} ({post.engagementByViews.formulaText})
      </p>
      {historySeries.length > 0 && (
        <div>
          <h3>Metric history</h3>
          <p className={styles.footnote}>
            Every value below is a saved record from a sync — unavailable collections are shown with their reason, never as zero.
          </p>
          {historySeries.map((s) => (
            <div key={s.key}>
              <h4>{s.key.replace(/_/g, " ")}</h4>
              {s.points.length >= 2 && <LineChart points={s.points} label={`${s.key.replace(/_/g, " ")} history for this post`} />}
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead><tr><th>Collected</th><th>Value</th><th>Kind</th><th>Source</th><th>Range</th></tr></thead>
                  <tbody>
                    {s.rows.map((r, i) => (
                      <tr key={i}>
                        <td>{fmtWhen(r.collected_at)}</td>
                        <td>{r.availability_status === "ok" && r.metric_value !== null ? fmtNum(r.metric_value) : `Unavailable${r.availability_reason ? ` — ${r.availability_reason}` : ""}`}</td>
                        <td>{r.kind ?? "—"}</td>
                        <td>{r.source ?? "—"}</td>
                        <td>{r.range_start ? `${r.range_start} → ${r.range_end ?? r.range_start}` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
      {detail && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <tbody>
              {Object.entries(detail.attributes).map(([k, v]) => (
                <tr key={k}><td>{k}</td><td>{v}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className={styles.buttonRow}>
        {post.url && <a className={styles.smallButton} href={post.url} target="_blank" rel="noreferrer">Open platform post</a>}
        {post.projectId && <button className={styles.smallButton} onClick={() => navigateTo(`projects/${post.projectId}`)}>Open CLIPFORGE project</button>}
        {post.projectId && post.clipId && <button className={styles.smallButton} onClick={() => navigateTo(`projects/${post.projectId}/editor`)}>Open in editor</button>}
      </div>
      {detail && detail.compareCandidates.length > 0 && (
        <p className={styles.footnote}>
          Other posts on this account: {detail.compareCandidates.map((c) => `${c.title || c.platformPostId} (${fmtNum(c.metrics.views?.value ?? null)} views)`).join(" · ")}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Trends({ range, platform, onError }: { range: { from: string; to: string }; platform?: Platform; onError: (e: string | null) => void }) {
  const [metric, setMetric] = useState("views");
  const [granularity, setGranularity] = useState("day");
  const [chartType, setChartType] = useState<"line" | "bar">("line");
  const [series, setSeries] = useState<TrendResponse | null>(null);
  useEffect(() => {
    onError(null);
    analyticsApi.trends({ metric, from: range.from, to: range.to, granularity, platform })
      .then(setSeries)
      .catch((err) => onError(errText(err)));
  }, [metric, granularity, range, platform, onError]);

  return (
    <section className={styles.section}>
      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <h2>Historical trends</h2>
          <span className={styles.buttonRow}>
            <select value={metric} onChange={(e) => setMetric(e.target.value)} aria-label="Trend metric">
              {TREND_METRICS.map((m) => <option key={m} value={m}>{m.replace(/_/g, " ")}</option>)}
            </select>
            <select value={granularity} onChange={(e) => setGranularity(e.target.value)} aria-label="Granularity">
              <option value="day">Daily</option>
              <option value="week">Weekly</option>
              <option value="month">Monthly</option>
            </select>
            <select value={chartType} onChange={(e) => setChartType(e.target.value as "line" | "bar")} aria-label="Chart type">
              <option value="line">Line chart</option>
              <option value="bar">Bar chart</option>
            </select>
          </span>
        </div>
        {series && series.points.length === 0 && (
          <p>No saved records exist for {series.displayName} in this range, so no chart is drawn — points are never invented.</p>
        )}
        {series && series.points.length > 0 && (
          chartType === "line"
            ? <LineChart points={series.points} label={`${series.displayName} trend`} />
            : <BarChart points={series.points} label={`${series.displayName} trend`} />
        )}
        {series && (
          <p className={styles.footnote}>
            {series.displayName} ({series.unit}) · {series.basis} Sources: {series.sources.join("; ") || "—"} · Last updated: {fmtWhen(series.lastUpdated)}
          </p>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------

function ContentAnalysis({ onError }: { onError: (e: string | null) => void }) {
  const [groupBy, setGroupBy] = useState("project");
  const [groups, setGroups] = useState<ContentGroup[]>([]);
  const [disclaimer, setDisclaimer] = useState("");
  useEffect(() => {
    onError(null);
    analyticsApi.contentAnalysis(groupBy)
      .then((r) => { setGroups(r.groups); setDisclaimer(r.disclaimer); })
      .catch((err) => onError(errText(err)));
  }, [groupBy, onError]);

  return (
    <section className={styles.section}>
      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <h2>CLIPFORGE content performance</h2>
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)} aria-label="Group by">
            {CONTENT_GROUPS.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
          </select>
        </div>
        {groups.length === 0 && <p>No published posts with recorded metrics yet.</p>}
        {groups.length > 0 && (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr><th>Group</th><th>Posts</th><th>Total views</th><th>Median views</th><th>Likes</th><th>Comments</th><th>Shares</th><th>Median engagement (reach)</th><th>Median engagement (views)</th></tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <tr key={g.label}>
                    <td>{g.label}{g.smallSample && <span className={styles.cellNote}>Too small a group for meaningful comparison (fewer than 3 posts)</span>}</td>
                    <td>{g.postCount}</td>
                    <td>{fmtNum(g.totalViews)}{g.totalViews !== null && <span className={styles.cellNote}>recorded posts only</span>}</td>
                    <td>{fmtNum(g.medianViews)}{g.medianViews !== null && <span className={styles.cellNote}>recorded posts only</span>}</td>
                    <td>{fmtNum(g.totalLikes)}{g.totalLikes !== null && <span className={styles.cellNote}>recorded for {g.likesCount} of {g.postCount} posts</span>}</td>
                    <td>{fmtNum(g.totalComments)}{g.totalComments !== null && <span className={styles.cellNote}>recorded for {g.commentsCount} of {g.postCount} posts</span>}</td>
                    <td>{fmtNum(g.totalShares)}{g.totalShares !== null && <span className={styles.cellNote}>recorded for {g.sharesCount} of {g.postCount} posts</span>}</td>
                    <td>{g.medianEngagementByReach !== null ? `${g.medianEngagementByReach.toFixed(2)}%` : "N/A"}</td>
                    <td>{g.medianEngagementByViews !== null ? `${g.medianEngagementByViews.toFixed(2)}%` : "N/A"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className={styles.footnote}>{disclaimer}</p>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------

function Insights({ range, onError, setNotice }: { range: { from: string; to: string }; onError: (e: string | null) => void; setNotice: (n: string | null) => void }) {
  const [items, setItems] = useState<Insight[]>([]);
  const [status, setStatus] = useState("ACTIVE");
  const [evidenceFor, setEvidenceFor] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<InsightEvidence[]>([]);
  const [linkedPost, setLinkedPost] = useState<PostSummary | null>(null);

  const load = useCallback(() => {
    onError(null);
    analyticsApi.insights(status).then((r) => setItems(r.insights)).catch((err) => onError(errText(err)));
  }, [status, onError]);
  useEffect(load, [load]);

  const generate = async () => {
    try {
      const r = await analyticsApi.generateInsights(range.from, range.to);
      setNotice(`Insight analysis complete: ${r.created} new insight(s), ${r.skipped} already present. Insights are generated by transparent rules over your saved records — every claim carries its evidence.`);
      load();
    } catch (err) {
      onError(errText(err));
    }
  };

  const showEvidence = async (id: string) => {
    if (evidenceFor === id) { setEvidenceFor(null); setLinkedPost(null); return; }
    try {
      const r = await analyticsApi.insight(id);
      setEvidence(r.evidence);
      setEvidenceFor(id);
      setLinkedPost(null);
    } catch (err) {
      onError(errText(err));
    }
  };

  // F13: evidence rows that reference a post link to that post's
  // detail (fetched live from the analytics API, shown inline here).
  const openEvidencePost = async (postId: string) => {
    try {
      const r = await analyticsApi.post(postId);
      setLinkedPost(r.post);
    } catch (err) {
      onError(errText(err));
    }
  };

  return (
    <section className={styles.section}>
      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <h2>Performance insights</h2>
          <span className={styles.buttonRow}>
            <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Insight status">
              <option value="ACTIVE">Active</option>
              <option value="SAVED">Saved</option>
            </select>
            <button className={styles.primaryButton} onClick={() => void generate()}>Generate new analysis</button>
          </span>
        </div>
        <p className={styles.footnote}>
          Insights are deterministic, data-grounded observations computed from your saved analytics records.
          They never invent explanations, never credit an editing feature with causing performance, and never predict virality.
        </p>
        {items.length === 0 && <p>No insights here yet. Generate an analysis once syncs have recorded real data.</p>}
        {items.map((insight) => (
          <article key={insight.id} className={styles.insightCard}>
            <div className={styles.cardHeader}>
              <span className={styles.kindBadge}>{insight.kind}</span>
              <span className={styles.buttonRow}>
                <button className={styles.smallButton} onClick={() => void showEvidence(insight.id)}>Evidence</button>
                {insight.status !== "SAVED" && (
                  <button className={styles.smallButton} onClick={() => void analyticsApi.saveInsight(insight.id).then(load).catch((err) => onError(errText(err)))}>Save</button>
                )}
                <button className={styles.smallButton} onClick={() => void analyticsApi.dismissInsight(insight.id).then(load).catch((err) => onError(errText(err)))}>Dismiss</button>
              </span>
            </div>
            <h3>{insight.title}</h3>
            <p>{insight.body}</p>
            <p className={styles.footnote}>
              Sample size: {insight.sampleSize} · Period: {insight.rangeStart ?? "—"} → {insight.rangeEnd ?? "—"}
              {insight.formula ? ` · ${insight.formula}` : ""} · Limitations: {insight.limitations}
            </p>
            {evidenceFor === insight.id && (
              <div>
                {evidence.length === 0 ? (
                  <p className={styles.footnote}>No evidence rows recorded for this insight.</p>
                ) : (
                  <ul className={styles.evidenceList}>
                    {evidence.map((e, i) => (
                      <li key={i}>
                        {e.label}: <strong>{typeof e.value === "number" ? fmtNum(e.value) : String(e.value)}</strong>
                        {e.platformPostId && (
                          <>{" "}<button className={styles.smallButton} onClick={() => void openEvidencePost(e.platformPostId!)}>Show related post</button></>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {linkedPost && (
                  <p className={styles.footnote}>
                    Related post: <strong>{linkedPost.title || linkedPost.platformPostId}</strong> ({PLATFORM_LABEL[linkedPost.platform]})
                    {" · "}Published {linkedPost.publishedAt ? fmtWhen(linkedPost.publishedAt) : "—"}
                    {" · "}Views {fmtNum(linkedPost.metrics.views?.value ?? null)}
                    {" · "}Likes {fmtNum(linkedPost.metrics.likes?.value ?? null)}
                    {linkedPost.url && <>{" · "}<a href={linkedPost.url} target="_blank" rel="noreferrer">Open on platform</a></>}
                    {" · "}Open the Posts tab and select it for the full metric history.
                  </p>
                )}
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------

function PostingTimesView({ onError }: { onError: (e: string | null) => void }) {
  const [data, setData] = useState<PostingTimes | null>(null);
  useEffect(() => {
    onError(null);
    analyticsApi.postingTimes().then(setData).catch((err) => onError(errText(err)));
  }, [onError]);
  if (!data) return <p className={styles.loading}>Loading posting-time analysis…</p>;
  return (
    <section className={styles.section}>
      <div className={styles.card}>
        <h2>Posting-time analysis ({data.timezone})</h2>
        <p>{data.message}</p>
        {data.sufficient && data.bestBucket && (
          <p className={styles.noticeBanner}>
            Historically strongest bucket: <strong>{data.bestBucket.label}</strong> — median {fmtNum(data.bestBucket.medianViews)} views
            across {data.bestBucket.count} posts. An observation, not a guarantee.
          </p>
        )}
        {data.buckets.length > 0 && (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead><tr><th>Weekday</th><th>Hour</th><th>Posts</th><th>Median views</th></tr></thead>
              <tbody>
                {data.buckets.map((b) => (
                  <tr key={`${b.weekday}-${b.hour}`}>
                    <td>{b.weekdayLabel}</td>
                    <td>{String(b.hour).padStart(2, "0")}:00</td>
                    <td>{b.count}</td>
                    <td>{fmtNum(b.medianViews)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className={styles.footnote}>{data.totalPosts} published post(s) analysed, {data.postsWithViews} with recorded views. Minimum sample for conclusions: {data.minimumSample}.</p>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------

function Reports({ range, onError, setNotice }: { range: { from: string; to: string }; onError: (e: string | null) => void; setNotice: (n: string | null) => void }) {
  const [reports, setReports] = useState<AnalyticsReport[]>([]);
  const [name, setName] = useState("");
  const [formats, setFormats] = useState<string[]>(["csv"]);
  const [metrics, setMetrics] = useState<string[]>(["views", "likes", "comments", "shares"]);
  // §16 scope selection (F12): empty selection = no restriction,
  // which is exactly how the server's normalizeReportConfig reads it.
  const [scopePlatforms, setScopePlatforms] = useState<string[]>([]);
  const [accountOptions, setAccountOptions] = useState<PlatformAccount[]>([]);
  const [accountIds, setAccountIds] = useState<string[]>([]);
  const [projectOptions, setProjectOptions] = useState<{ id: string; name: string }[]>([]);
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [postOptions, setPostOptions] = useState<PostSummary[]>([]);
  const [postIds, setPostIds] = useState<string[]>([]);
  // Option-list load failures are tracked separately so a failed
  // fetch is never rendered as "no accounts/projects/posts exist".
  const [optionLoadFailed, setOptionLoadFailed] = useState({ accounts: false, projects: false, posts: false });
  const [includeTrends, setIncludeTrends] = useState(true);
  const [includeTopContent, setIncludeTopContent] = useState(true);
  const [includeComparison, setIncludeComparison] = useState(true);

  const load = useCallback(() => {
    onError(null);
    analyticsApi.reports().then((r) => setReports(r.reports)).catch((err) => onError(errText(err)));
  }, [onError]);
  useEffect(load, [load]);
  useEffect(() => {
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => {
    publishingApi.accounts().then((r) => setAccountOptions(r.accounts)).catch((err) => { setAccountOptions([]); setOptionLoadFailed((f) => ({ ...f, accounts: true })); onError(errText(err)); });
    projectsApi.listProjects({ pageSize: 100 }).then((r) => setProjectOptions(r.projects.map((p) => ({ id: p.id, name: p.name })))).catch((err) => { setProjectOptions([]); setOptionLoadFailed((f) => ({ ...f, projects: true })); onError(errText(err)); });
    analyticsApi.posts({}).then((r) => setPostOptions(r.posts)).catch((err) => { setPostOptions([]); setOptionLoadFailed((f) => ({ ...f, posts: true })); onError(errText(err)); });
  }, []);

  const toggle = (list: string[], setList: (v: string[]) => void, value: string) => {
    setList(list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);
  };

  const create = async () => {
    if (!name.trim()) { onError("Give the report a name first."); return; }
    if (formats.length === 0) { onError("Choose at least one report format (CSV, XLSX or PDF)."); return; }
    if (metrics.length === 0) { onError("Choose at least one metric for the report."); return; }
    try {
      await analyticsApi.createReport({
        name: name.trim(),
        from: range.from,
        to: range.to,
        config: {
          formats, metrics,
          platforms: scopePlatforms, accountIds, projectIds, postIds,
          includeTrends, includeTopContent, includeComparison,
        },
      });
      setName("");
      setNotice("Report queued — it is generated in the background from saved records only.");
      load();
    } catch (err) {
      onError(errText(err));
    }
  };

  return (
    <section className={styles.section}>
      <div className={styles.card}>
        <h2>Report builder</h2>
        <div className={styles.formGrid}>
          <label>
            Report name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. October performance" />
          </label>
          <fieldset>
            <legend>Formats</legend>
            {["csv", "xlsx", "pdf"].map((f) => (
              <label key={f} className={styles.checkLabel}>
                <input type="checkbox" checked={formats.includes(f)} onChange={() => toggle(formats, setFormats, f)} /> {f.toUpperCase()}
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>Metrics</legend>
            {REPORT_METRICS.map((m) => (
              <label key={m} className={styles.checkLabel}>
                <input type="checkbox" checked={metrics.includes(m)} onChange={() => toggle(metrics, setMetrics, m)} /> {m.replace(/_/g, " ")}
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>Platforms (none ticked = all)</legend>
            {PLATFORMS.map((p) => (
              <label key={p} className={styles.checkLabel}>
                <input type="checkbox" checked={scopePlatforms.includes(p)} onChange={() => toggle(scopePlatforms, setScopePlatforms, p)} /> {PLATFORM_LABEL[p]}
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>Accounts (none ticked = all)</legend>
            {accountOptions.length === 0 && <span className={styles.cellNote}>{optionLoadFailed.accounts ? "Accounts could not be loaded — reopen this tab to retry." : "No connected accounts"}</span>}
            {accountOptions.map((a) => (
              <label key={a.id} className={styles.checkLabel}>
                <input type="checkbox" checked={accountIds.includes(a.id)} onChange={() => toggle(accountIds, setAccountIds, a.id)} /> {PLATFORM_LABEL[a.platform]} · @{a.username ?? a.id}
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>Projects (none ticked = all)</legend>
            {projectOptions.length === 0 && <span className={styles.cellNote}>{optionLoadFailed.projects ? "Projects could not be loaded — reopen this tab to retry." : "No projects"}</span>}
            {projectOptions.map((p) => (
              <label key={p.id} className={styles.checkLabel}>
                <input type="checkbox" checked={projectIds.includes(p.id)} onChange={() => toggle(projectIds, setProjectIds, p.id)} /> {p.name}
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>Posts (none ticked = all)</legend>
            {postOptions.length === 0 && <span className={styles.cellNote}>{optionLoadFailed.posts ? "Posts could not be loaded — reopen this tab to retry." : "No published posts"}</span>}
            {postOptions.map((p) => (
              <label key={p.id} className={styles.checkLabel}>
                <input type="checkbox" checked={postIds.includes(p.id)} onChange={() => toggle(postIds, setPostIds, p.id)} /> {p.title || p.platformPostId} ({PLATFORM_LABEL[p.platform]})
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>Sections</legend>
            <label className={styles.checkLabel}>
              <input type="checkbox" checked={includeTrends} onChange={() => setIncludeTrends(!includeTrends)} /> Trend chart data
            </label>
            <label className={styles.checkLabel}>
              <input type="checkbox" checked={includeTopContent} onChange={() => setIncludeTopContent(!includeTopContent)} /> Top-performing content
            </label>
            <label className={styles.checkLabel}>
              <input type="checkbox" checked={includeComparison} onChange={() => setIncludeComparison(!includeComparison)} /> Platform comparison
            </label>
          </fieldset>
        </div>
        <p className={styles.footnote}>
          Range: {range.from} → {range.to} (use the date controls above). Reports contain saved data only,
          with metric definitions, source notes and last-sync timestamps.
        </p>
        <button className={styles.primaryButton} onClick={() => void create()}>Create report</button>
      </div>

      <div className={styles.card}>
        <h2>Generated reports</h2>
        {reports.length === 0 && <p>No reports yet.</p>}
        {reports.map((report) => (
          <article key={report.id} className={styles.reportRow}>
            <div>
              <strong>{report.name}</strong>
              <span className={styles.cellNote}>
                {report.rangeStart} → {report.rangeEnd} · Status: {report.status}
                {report.generatedAt ? ` · Generated ${fmtWhen(report.generatedAt)}` : ""}
                {report.error ? ` · ${report.error}` : ""}
              </span>
            </div>
            <span className={styles.buttonRow}>
              {report.exports.map((exp) => (
                exp.downloadUrl
                  ? <a key={exp.id} className={styles.smallButton} href={exportDownloadUrl(exp.downloadUrl)}>{exp.format.toUpperCase()} ↓</a>
                  : <span key={exp.id} className={styles.cellNote}>{exp.format.toUpperCase()}: {exp.status}</span>
              ))}
              <button className={styles.smallButton} onClick={() => { if (window.confirm("Delete this report and its generated files?")) void analyticsApi.deleteReport(report.id).then(load).catch((err) => onError(errText(err))); }}>
                Delete
              </button>
            </span>
          </article>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------

/** A capabilities-endpoint entry for a platform the server cannot
 *  serve yet: no account can be connected, and the entry names the
 *  missing server credentials. Consumed defensively — older servers
 *  return only real per-account capability records. */
interface UnconfiguredEntry {
  platform: Platform;
  configured: false;
  missing: string[];
}

function SyncCenter({ accounts, onError, setNotice }: { accounts: PlatformAccount[]; onError: (e: string | null) => void; setNotice: (n: string | null) => void }) {
  const [capabilities, setCapabilities] = useState<AccountCapability[]>([]);
  const [unconfigured, setUnconfigured] = useState<UnconfiguredEntry[]>([]);
  const [providerStatus, setProviderStatus] = useState<ProviderStatus[] | null>(null);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<SyncJob[]>([]);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [autoSync, setAutoSync] = useState(0);
  const [timezone, setTimezone] = useState("Asia/Kolkata");

  const load = useCallback(() => {
    onError(null);
    analyticsApi.capabilities().then((r) => {
      // Partition the response: real per-account capability records
      // vs NOT CONFIGURED platform entries ({ configured: false,
      // missing: [...] }) the server may include for platforms with
      // no connected account.
      const list = (r.accounts ?? []) as unknown as Array<Record<string, unknown>>;
      const real: AccountCapability[] = [];
      const unc: UnconfiguredEntry[] = [];
      for (const e of list) {
        if (e && e.configured === false) {
          const platform = (e.platform ?? (e.account as { platform?: Platform } | undefined)?.platform) as Platform | undefined;
          if (platform) {
            unc.push({ platform, configured: false, missing: Array.isArray(e.missing) ? (e.missing as string[]) : [] });
          }
        } else if (e && e.capability) {
          real.push(e as unknown as AccountCapability);
        }
      }
      setCapabilities(real);
      setUnconfigured(unc);
    }).catch((err) => onError(errText(err)));
    analyticsApi.syncJobs().then((r) => { setJobs(r.jobs); setJobsError(null); }).catch((err) => setJobsError(errText(err)));
    analyticsApi.getSettings().then((r) => { setAutoSync(r.settings.autoSyncMinutes); setTimezone(r.settings.timezone); setSettingsError(null); }).catch((err) => setSettingsError(errText(err)));
    // Fallback source for the NOT CONFIGURED entries: the publishing
    // provider configuration the app already exposes.
    publishingApi.providers().then((r) => { setProviderStatus(r.providers); setProvidersError(null); }).catch((err) => { setProviderStatus(null); setProvidersError(errText(err)); });
  }, [onError]);
  useEffect(load, [load]);
  useEffect(() => {
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);

  const startSync = async (body: { accountId?: string; platform?: Platform; all?: boolean }) => {
    try {
      const r = await analyticsApi.startSync(body);
      setNotice(r.deduplicated ? "That sync is already queued or running — duplicates are prevented." : "Sync queued.");
      load();
    } catch (err) {
      onError(errText(err));
    }
  };

  const saveSettings = async () => {
    const tz = timezone.trim();
    const supported = (
      Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
    ).supportedValuesOf?.("timeZone");
    if (!tz || (supported && supported.length > 0 && !supported.includes(tz))) {
      onError(
        `"${timezone}" is not a recognised IANA timezone (examples: Asia/Kolkata, UTC, America/New_York). Settings were not saved.`,
      );
      return;
    }
    try {
      await analyticsApi.putSettings({ autoSyncMinutes: autoSync, timezone: tz });
      setNotice("Analytics settings saved.");
    } catch (err) {
      onError(errText(err));
    }
  };

  return (
    <section className={styles.section}>
      <div className={styles.card}>
        <h2>Connected accounts & capabilities</h2>
        {accounts.length === 0 && <p>No connected accounts. Connect one in the Publishing Center first.</p>}
        {capabilities.map(({ account, capability }) => (
          <article key={account.id} className={styles.accountBlock}>
            <div className={styles.cardHeader}>
              <strong>{PLATFORM_LABEL[account.platform]} · @{account.username ?? account.id}</strong>
              <span className={styles.buttonRow}>
                <button className={styles.smallButton} onClick={() => void analyticsApi.refreshCapabilities(account.id).then(load).catch((err) => onError(errText(err)))}>Re-check capabilities</button>
                <button className={styles.smallButton} onClick={() => void startSync({ accountId: account.id })}>Sync this account</button>
              </span>
            </div>
            <p className={styles.footnote}>
              {capability.apiVersion} · Capability check: {fmtWhen(capability.lastCapabilityCheckAt)} ·
              Last successful retrieval: {fmtWhen(capability.lastSuccessfulRetrievalAt)}
            </p>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead><tr><th>Metric</th><th>Status</th><th>Why / required permission</th></tr></thead>
                <tbody>
                  {capability.metrics.map((m) => (
                    <tr key={m.key}>
                      <td>{m.key.replace(/_/g, " ")}</td>
                      <td>{m.status}</td>
                      <td>{m.reason ?? (m.requiredPermissions.length > 0 ? m.requiredPermissions.join(", ") : "—")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead><tr><th>Endpoint</th><th>Status</th><th>Used by this integration</th></tr></thead>
                <tbody>
                  {capability.endpoints.map((ep) => (
                    <tr key={`${ep.name}-${ep.path}`}>
                      <td>{ep.name}<span className={styles.cellNote}>{ep.path}</span></td>
                      <td>{ep.status}</td>
                      <td>
                        {ep.exercised === false
                          ? <>Available but not used{ep.reason ? ` — ${ep.reason}` : ""}</>
                          : ep.exercised === true
                            ? <>Used{ep.reason ? ` — ${ep.reason}` : ""}</>
                            : (ep.reason ?? "—")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className={styles.footnote}>Dimensions: {capability.dimensions.length > 0 ? capability.dimensions.join(", ") : "—"}</p>
            <p className={styles.footnote}>Required permissions: {capability.requiredPermissions.length > 0 ? capability.requiredPermissions.join(", ") : "—"}</p>
            {capability.limitations.map((l) => <p key={l} className={styles.footnote}>{l}</p>)}
            <p className={styles.footnote}>
              Supported range: {capability.supportedRange.note}
              {typeof capability.supportedRange.maxDaysBack === "number" ? ` Max look-back: ${capability.supportedRange.maxDaysBack} days.` : ""}
            </p>
          </article>
        ))}
        {providersError && (
          <p className={styles.footnote}>Platform configuration status could not be loaded: {providersError}</p>
        )}
        {PLATFORMS.filter((p) => !accounts.some((a) => a.platform === p)).map((p) => {
          const fromServer = unconfigured.find((u) => u.platform === p);
          const prov = providerStatus?.find((s) => s.platform === p);
          const missing = fromServer ? fromServer.missing : prov && !prov.configured ? prov.missing : null;
          return (
            <article key={p} className={styles.accountBlock}>
              <div className={styles.cardHeader}>
                <strong>{PLATFORM_LABEL[p]} · No account connected</strong>
              </div>
              {missing ? (
                <>
                  <p className={styles.footnote}>
                    <strong>NOT CONFIGURED</strong> — this platform is not configured on the server, so no account
                    can be connected and no analytics can sync for it yet.
                  </p>
                  <p className={styles.footnote}>
                    Missing credentials: {missing.length > 0 ? missing.join(", ") : "provider configuration"}.
                    Once they are added to the server configuration, connect the account in the Publishing Center.
                  </p>
                </>
              ) : (
                <p className={styles.footnote}>
                  {prov?.configured
                    ? "The platform is configured on this server, but no account is connected — connect one in the Publishing Center to sync its analytics."
                    : "No account is connected for this platform — connect one in the Publishing Center to sync its analytics."}
                </p>
              )}
            </article>
          );
        })}
      </div>

      <div className={styles.card}>
        <h2>Refresh frequency</h2>
        {settingsError && <p className={styles.errorBanner}>Analytics settings could not be loaded: {settingsError}</p>}
        <div className={styles.formGrid}>
          <label>
            Automatic sync every (minutes, 0 = off)
            <input type="number" min={0} value={autoSync} onChange={(e) => setAutoSync(Number(e.target.value))} />
          </label>
          <label>
            Account timezone (posting-time analysis)
            <input value={timezone} onChange={(e) => setTimezone(e.target.value)} />
          </label>
        </div>
        <p className={styles.footnote}>Automatic syncs respect platform rate limits and never poll aggressively; failed syncs are never shown as successful.</p>
        <button className={styles.primaryButton} onClick={() => void saveSettings()}>Save settings</button>
      </div>

      <div className={styles.card}>
        <h2>Sync jobs</h2>
        {jobsError && <p className={styles.errorBanner}>Sync jobs could not be loaded: {jobsError}</p>}
        {jobs.length === 0 && !jobsError && <p>No sync jobs yet.</p>}
        {jobs.map((job) => (
          <article key={job.id} className={styles.reportRow}>
            <div>
              <strong>{job.scope}{job.platform ? ` · ${PLATFORM_LABEL[job.platform as Platform]}` : ""} · {job.status}</strong>
              <span className={styles.cellNote}>
                Created {fmtWhen(job.createdAt)} · Attempts {job.attemptCount}/{job.maxAttempts} · Source {job.source}
                {job.error ? ` · ${job.error}` : ""}
                {job.nextAttemptAt && job.status === "QUEUED" ? ` · Retry at ${fmtWhen(job.nextAttemptAt)}` : ""}
              </span>
            </div>
            <span className={styles.buttonRow}>
              {job.status === "QUEUED" && <button className={styles.smallButton} onClick={() => void analyticsApi.cancelSync(job.id).then(load).catch((err) => onError(errText(err)))}>Cancel</button>}
              {["FAILED", "PARTIAL_SUCCESS", "AUTH_REQUIRED", "CANCELLED"].includes(job.status) && (
                <button className={styles.smallButton} onClick={() => void analyticsApi.retrySync(job.id).then(load).catch((err) => onError(errText(err)))}>Retry</button>
              )}
            </span>
          </article>
        ))}
      </div>
    </section>
  );
}
