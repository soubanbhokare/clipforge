// CLIPFORGE Phase 11 — Analytics Report Builder (§16).
//
// Reports are generated ONLY from saved analytics records by the
// analytics worker (background), in CSV (native serialization),
// XLSX (exceljs) and PDF (pdfkit). Every report carries the metric
// definitions, source notes and last-synchronization timestamps so a
// reader can see exactly where each number came from. A metric with
// no saved value is written as "Unavailable" — never as 0.

import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { config } from "./config.js";
import {
  getDb,
  type AnalyticsReportExportRow,
  type AnalyticsReportRow,
} from "./db.js";
import { recordUsage } from "./accountCore.js";
import {
  engagementForTotals,
  metricTotals,
  nowIso,
  parseJson,
  summarizePost,
  trendSeries,
  userPosts,
  type DateRange,
} from "./analyticsCore.js";
import { METRIC_DEFINITIONS } from "./analyticsProviders.js";
import type { Platform } from "./providers.js";

export interface ReportConfig {
  platforms: Platform[];
  accountIds: string[];
  projectIds: string[];
  postIds: string[];
  metrics: string[];
  formats: ("csv" | "xlsx" | "pdf")[];
  includeTrends: boolean;
  includeTopContent: boolean;
  includeComparison: boolean;
}

export const DEFAULT_REPORT_METRICS = ["views", "reach", "likes", "comments", "shares", "saves", "watch_time_seconds", "followers"];

export function normalizeReportConfig(raw: unknown): ReportConfig {
  const r = (raw ?? {}) as Partial<ReportConfig>;
  const platforms = (Array.isArray(r.platforms) ? r.platforms : []).filter(
    (p): p is Platform => p === "youtube" || p === "instagram" || p === "tiktok",
  );
  const formats = (Array.isArray(r.formats) ? r.formats : []).filter(
    (f): f is "csv" | "xlsx" | "pdf" => f === "csv" || f === "xlsx" || f === "pdf",
  );
  return {
    platforms: platforms.length > 0 ? platforms : ["youtube", "instagram", "tiktok"],
    accountIds: Array.isArray(r.accountIds) ? r.accountIds.map(String) : [],
    projectIds: Array.isArray(r.projectIds) ? r.projectIds.map(String) : [],
    postIds: Array.isArray(r.postIds) ? r.postIds.map(String) : [],
    metrics: Array.isArray(r.metrics) && r.metrics.length > 0 ? r.metrics.map(String) : [...DEFAULT_REPORT_METRICS],
    formats: formats.length > 0 ? formats : ["csv"],
    includeTrends: r.includeTrends !== false,
    includeTopContent: r.includeTopContent !== false,
    includeComparison: r.includeComparison !== false,
  };
}

export interface ReportData {
  name: string;
  generatedAt: string;
  range: DateRange;
  config: ReportConfig;
  kpis: { metricKey: string; displayName: string; unit: string; value: string; basis: string; availability: string }[];
  platformRows: { platform: string; views: string; likes: string; comments: string; shares: string; engagementByViews: string; posts: number }[];
  topContent: { title: string; platform: string; publishedAt: string; views: string; likes: string; comments: string; shares: string; engagementByViews: string; url: string }[];
  trend: { metricKey: string; points: { date: string; value: number }[]; basis: string } | null;
  definitions: { metricKey: string; displayName: string; unit: string; definition: string }[];
  sourceNotes: string[];
  lastSyncByAccount: { account: string; platform: string; lastSyncAt: string | null }[];
}

const fmtVal = (v: number | null): string => (v === null ? "Unavailable" : String(Math.round(v * 100) / 100));

export function buildReportData(userId: string, report: AnalyticsReportRow): ReportData {
  const cfg = normalizeReportConfig(parseJson(report.config_json, {}));
  const range: DateRange = { from: report.range_start ?? "1970-01-01", to: report.range_end ?? nowIso().slice(0, 10) };
  const totals = metricTotals(userId, range, {});
  const kpis = totals
    .filter((t) => cfg.metrics.includes(t.metricKey))
    .map((t) => ({
      metricKey: t.metricKey,
      displayName: t.displayName,
      unit: t.unit,
      value: fmtVal(t.value),
      basis: t.basis ?? "—",
      availability: t.availability,
    }));

  const platformRows = cfg.platforms.map((platform) => {
    const pt = metricTotals(userId, range, { platform });
    const get = (k: string) => pt.find((t) => t.metricKey === k)?.value ?? null;
    const eng = engagementForTotals(pt, "by_views", platform);
    const posts = userPosts(userId, { platform }).filter(
      (p) => p.publishedAt && p.publishedAt.slice(0, 10) >= range.from && p.publishedAt.slice(0, 10) <= range.to,
    ).length;
    return {
      platform,
      views: fmtVal(get("views")),
      likes: fmtVal(get("likes")),
      comments: fmtVal(get("comments")),
      shares: fmtVal(get("shares")),
      engagementByViews: eng.availability === "ok" && eng.value !== null ? `${eng.value.toFixed(2)}% (${eng.formulaText})` : "Unavailable",
      posts,
    };
  });

  let posts = userPosts(userId, {});
  if (cfg.postIds.length > 0) posts = posts.filter((p) => cfg.postIds.includes(p.post.id));
  if (cfg.projectIds.length > 0) posts = posts.filter((p) => cfg.projectIds.includes(p.projectId ?? ""));
  if (cfg.accountIds.length > 0) posts = posts.filter((p) => cfg.accountIds.includes(p.post.account_id));
  if (cfg.platforms.length > 0) posts = posts.filter((p) => cfg.platforms.includes(p.post.platform as Platform));
  const summaries = posts.map((ctx) => summarizePost(ctx));
  const topContent = [...summaries]
    .sort((a, b) => (b.metrics.views?.value ?? -1) - (a.metrics.views?.value ?? -1))
    .slice(0, 20)
    .map((s) => ({
      title: s.title || s.platformPostId,
      platform: s.platform,
      publishedAt: s.publishedAt ?? "",
      views: fmtVal(s.metrics.views?.value ?? null),
      likes: fmtVal(s.metrics.likes?.value ?? null),
      comments: fmtVal(s.metrics.comments?.value ?? null),
      shares: fmtVal(s.metrics.shares?.value ?? null),
      engagementByViews: s.engagementByViews.availability === "ok" && s.engagementByViews.value !== null ? `${s.engagementByViews.value.toFixed(2)}%` : "Unavailable",
      url: s.url ?? "",
    }));

  const trendMetric = cfg.metrics.includes("views") ? "views" : cfg.metrics[0] ?? "views";
  const series = cfg.includeTrends ? trendSeries(userId, trendMetric, range, "day", {}) : null;

  const accounts = getDb()
    .prepare("SELECT username, platform_account_id, platform, last_synced_at FROM platform_accounts WHERE user_id = ? AND status != 'DISCONNECTED'")
    .all(userId) as unknown as { username: string | null; platform_account_id: string; platform: string; last_synced_at: string | null }[];

  return {
    name: report.name,
    generatedAt: nowIso(),
    range,
    config: cfg,
    kpis,
    platformRows: cfg.includeComparison ? platformRows : [],
    topContent: cfg.includeTopContent ? topContent : [],
    trend: series ? { metricKey: trendMetric, points: series.points, basis: series.basis } : null,
    definitions: METRIC_DEFINITIONS.filter((d) => cfg.metrics.includes(d.key)).map((d) => ({
      metricKey: d.key, displayName: d.displayName, unit: d.unit, definition: d.definition,
    })),
    sourceNotes: [
      "All figures come from CLIPFORGE's saved analytics snapshots, collected from the official platform APIs (YouTube Analytics + Data API, Instagram Insights, TikTok Display API).",
      "Unavailable means the platform did not provide the metric (missing scope, unsupported metric or no data) — it is never shown as zero.",
      "YouTube Analytics figures are date-scoped activity; Data API / Display API figures are lifetime counters. Each KPI's basis column states which.",
      "Engagement rate uses only the components the platform exposes; the exact formula is shown wherever a rate appears.",
    ],
    lastSyncByAccount: accounts.map((a) => ({
      account: a.username ?? a.platform_account_id,
      platform: a.platform,
      lastSyncAt: a.last_synced_at,
    })),
  };
}

// ---- renderers -----------------------------------------------------------------

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function renderCsv(data: ReportData): string {
  const lines: string[] = [];
  const row = (cells: (string | number)[]) => lines.push(cells.map((c) => csvEscape(String(c))).join(","));
  row(["CLIPFORGE Analytics Report"]);
  row(["Name", data.name]);
  row(["Generated at", data.generatedAt]);
  row(["Date range", `${data.range.from} to ${data.range.to}`]);
  lines.push("");
  row(["KPI", "Value", "Unit", "Basis", "Availability"]);
  for (const k of data.kpis) row([k.displayName, k.value, k.unit, k.basis, k.availability]);
  lines.push("");
  row(["Platform comparison"]);
  row(["Platform", "Views", "Likes", "Comments", "Shares", "Engagement by views", "Published posts in range"]);
  for (const p of data.platformRows) row([p.platform, p.views, p.likes, p.comments, p.shares, p.engagementByViews, p.posts]);
  lines.push("");
  row(["Top content"]);
  row(["Title", "Platform", "Published", "Views", "Likes", "Comments", "Shares", "Engagement by views", "URL"]);
  for (const t of data.topContent) row([t.title, t.platform, t.publishedAt, t.views, t.likes, t.comments, t.shares, t.engagementByViews, t.url]);
  lines.push("");
  if (data.trend) {
    row([`Trend — ${data.trend.metricKey} (${data.trend.basis})`]);
    row(["Date", "Value"]);
    for (const p of data.trend.points) row([p.date, p.value]);
    lines.push("");
  }
  row(["Metric definitions"]);
  row(["Metric", "Unit", "Definition"]);
  for (const d of data.definitions) row([d.displayName, d.unit, d.definition]);
  lines.push("");
  row(["Source notes"]);
  for (const n of data.sourceNotes) row([n]);
  lines.push("");
  row(["Last synchronization by account"]);
  row(["Account", "Platform", "Last sync"]);
  for (const a of data.lastSyncByAccount) row([a.account, a.platform, a.lastSyncAt ?? "Never"]);
  return lines.join("\n") + "\n";
}

async function renderXlsx(data: ReportData, outPath: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "CLIPFORGE";
  wb.created = new Date(data.generatedAt);
  const summary = wb.addWorksheet("Summary");
  summary.addRow(["CLIPFORGE Analytics Report"]);
  summary.addRow(["Name", data.name]);
  summary.addRow(["Generated at", data.generatedAt]);
  summary.addRow(["Date range", `${data.range.from} to ${data.range.to}`]);
  summary.addRow([]);
  summary.addRow(["KPI", "Value", "Unit", "Basis", "Availability"]);
  for (const k of data.kpis) summary.addRow([k.displayName, k.value === "Unavailable" ? "Unavailable" : Number(k.value), k.unit, k.basis, k.availability]);
  summary.addRow([]);
  summary.addRow(["Source notes"]);
  for (const n of data.sourceNotes) summary.addRow([n]);
  summary.addRow([]);
  summary.addRow(["Last synchronization by account", "Platform", "Last sync"]);
  for (const a of data.lastSyncByAccount) summary.addRow([a.account, a.platform, a.lastSyncAt ?? "Never"]);

  const comp = wb.addWorksheet("Platform comparison");
  comp.addRow(["Platform", "Views", "Likes", "Comments", "Shares", "Engagement by views", "Published posts in range"]);
  for (const p of data.platformRows) comp.addRow([p.platform, p.views, p.likes, p.comments, p.shares, p.engagementByViews, p.posts]);

  const top = wb.addWorksheet("Top content");
  top.addRow(["Title", "Platform", "Published", "Views", "Likes", "Comments", "Shares", "Engagement by views", "URL"]);
  for (const t of data.topContent) top.addRow([t.title, t.platform, t.publishedAt, t.views, t.likes, t.comments, t.shares, t.engagementByViews, t.url]);

  if (data.trend) {
    const tr = wb.addWorksheet("Trends");
    tr.addRow([`Trend — ${data.trend.metricKey}`, data.trend.basis]);
    tr.addRow(["Date", "Value"]);
    for (const p of data.trend.points) tr.addRow([p.date, p.value]);
  }
  const defs = wb.addWorksheet("Definitions");
  defs.addRow(["Metric", "Unit", "Definition"]);
  for (const d of data.definitions) defs.addRow([d.displayName, d.unit, d.definition]);
  await wb.xlsx.writeFile(outPath);
}

function renderPdf(data: ReportData, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 48, size: "A4" });
    const stream = fs.createWriteStream(outPath);
    doc.pipe(stream);
    stream.on("finish", () => resolve());
    stream.on("error", reject);
    doc.on("error", reject);

    doc.fontSize(20).fillColor("#1558C9").text("CLIPFORGE Analytics Report");
    doc.fontSize(11).fillColor("#111111");
    doc.text(`Name: ${data.name}`);
    doc.text(`Generated: ${data.generatedAt}`);
    doc.text(`Date range: ${data.range.from} to ${data.range.to}`);
    doc.moveDown();

    doc.fontSize(14).text("Key performance indicators");
    doc.fontSize(10);
    for (const k of data.kpis) {
      doc.text(`${k.displayName}: ${k.value} ${k.unit}  (basis: ${k.basis}, availability: ${k.availability})`);
    }
    doc.moveDown();

    if (data.platformRows.length > 0) {
      doc.fontSize(14).text("Platform comparison");
      doc.fontSize(10);
      for (const p of data.platformRows) {
        doc.text(`${p.platform} — views ${p.views}, likes ${p.likes}, comments ${p.comments}, shares ${p.shares}, engagement by views ${p.engagementByViews}, posts in range ${p.posts}`);
      }
      doc.moveDown();
    }

    if (data.trend && data.trend.points.length > 0) {
      doc.fontSize(14).text(`Trend — ${data.trend.metricKey}`);
      doc.fontSize(9).text(data.trend.basis);
      // Real line chart drawn from the saved series only.
      const points = data.trend.points;
      const max = Math.max(...points.map((p) => p.value), 1);
      const x0 = 48, y0 = doc.y + 8, w = 500, h = 140;
      doc.strokeColor("#999999").moveTo(x0, y0).lineTo(x0, y0 + h).lineTo(x0 + w, y0 + h).stroke();
      doc.strokeColor("#D4FF24").lineWidth(2);
      points.forEach((p, i) => {
        const x = x0 + (points.length === 1 ? w / 2 : (i / (points.length - 1)) * w);
        const y = y0 + h - (p.value / max) * h;
        if (i === 0) doc.moveTo(x, y); else doc.lineTo(x, y);
      });
      doc.stroke();
      doc.lineWidth(1).fillColor("#111111").fontSize(8);
      doc.text(`Peak ${max} · ${points.length} recorded day(s) · gaps are days with no saved record (never zero-filled)`, x0, y0 + h + 6);
      doc.moveDown(9);
    } else if (data.trend) {
      doc.fontSize(14).text(`Trend — ${data.trend.metricKey}`);
      doc.fontSize(10).text("No trend points are saved in this range, so no chart is drawn.");
      doc.moveDown();
    }

    if (data.topContent.length > 0) {
      doc.fontSize(14).text("Top-performing content");
      doc.fontSize(10);
      for (const t of data.topContent.slice(0, 15)) {
        doc.text(`${t.title} (${t.platform}, ${t.publishedAt}) — views ${t.views}, likes ${t.likes}, comments ${t.comments}, shares ${t.shares}, engagement by views ${t.engagementByViews}`);
      }
      doc.moveDown();
    }

    doc.fontSize(14).text("Metric definitions");
    doc.fontSize(9);
    for (const d of data.definitions) doc.text(`${d.displayName} (${d.unit}): ${d.definition}`);
    doc.moveDown();
    doc.fontSize(14).text("Source notes");
    doc.fontSize(9);
    for (const n of data.sourceNotes) doc.text(`• ${n}`);
    doc.moveDown();
    doc.fontSize(14).text("Last synchronization");
    doc.fontSize(9);
    for (const a of data.lastSyncByAccount) doc.text(`${a.account} (${a.platform}): ${a.lastSyncAt ?? "Never"}`);
    doc.end();
  });
}

// ---- worker processing -----------------------------------------------------------

export function reportFilePath(reportId: string, format: string): string {
  return path.join(config.analytics.reportsDir, `${reportId}.${format}`);
}

/** Generate every queued export of one report. Returns false when no
 *  report is queued. Runs on the analytics worker tick (§16/§18:
 *  background generation with persisted states). */
export async function processOneQueuedReport(): Promise<boolean> {
  const db = getDb();
  const report = db
    .prepare("SELECT * FROM analytics_reports WHERE status = 'QUEUED' ORDER BY created_at ASC LIMIT 1")
    .get() as unknown as AnalyticsReportRow | undefined;
  if (!report) return false;
  const claim = db
    .prepare("UPDATE analytics_reports SET status = 'GENERATING_REPORT', updated_at = ? WHERE id = ? AND status = 'QUEUED'")
    .run(nowIso(), report.id) as unknown as { changes: number };
  if (Number(claim.changes) !== 1) return true;
  try {
    fs.mkdirSync(config.analytics.reportsDir, { recursive: true });
    const data = buildReportData(report.user_id, report);
    const exports = db
      .prepare("SELECT * FROM analytics_report_exports WHERE report_id = ? AND status = 'QUEUED'")
      .all(report.id) as unknown as AnalyticsReportExportRow[];
    for (const exp of exports) {
      db.prepare("UPDATE analytics_report_exports SET status = 'GENERATING_REPORT', updated_at = ? WHERE id = ?").run(nowIso(), exp.id);
      const outPath = reportFilePath(report.id, exp.format);
      try {
        if (exp.format === "csv") fs.writeFileSync(outPath, renderCsv(data), "utf8");
        else if (exp.format === "xlsx") await renderXlsx(data, outPath);
        else await renderPdf(data, outPath);
        const size = fs.statSync(outPath).size;
        db.prepare("UPDATE analytics_report_exports SET status = 'COMPLETED', storage_key = ?, file_size = ?, error = NULL, updated_at = ? WHERE id = ?")
          .run(path.basename(outPath), size, nowIso(), exp.id);
      } catch (err) {
        db.prepare("UPDATE analytics_report_exports SET status = 'FAILED', error = ?, updated_at = ? WHERE id = ?")
          .run(err instanceof Error ? err.message : String(err), nowIso(), exp.id);
      }
    }
    db.prepare("UPDATE analytics_reports SET status = 'COMPLETED', generated_at = ?, updated_at = ? WHERE id = ?")
      .run(nowIso(), nowIso(), report.id);
    // Phase 12 (§9): one generated report = one usage record,
    // written only at this genuine completion point (never when the
    // report is queued). Idempotent per report + outcome.
    recordUsage(getDb(), {
      userId: report.user_id,
      operation: "analytics_report",
      resource: "analytics_report",
      quantity: 1,
      unit: "reports",
      idempotencyKey: `analytics_report:${report.id}:completed`,
      jobId: report.id,
      status: "COMPLETED",
    });
  } catch (err) {
    db.prepare("UPDATE analytics_reports SET status = 'FAILED', error = ?, updated_at = ? WHERE id = ?")
      .run(err instanceof Error ? err.message : String(err), nowIso(), report.id);
    // Failed generation is recorded with quantity 0 — visible in
    // usage, never counted as a generated report.
    recordUsage(getDb(), {
      userId: report.user_id,
      operation: "analytics_report",
      resource: "analytics_report",
      quantity: 0,
      unit: "reports",
      idempotencyKey: `analytics_report:${report.id}:failed`,
      jobId: report.id,
      status: "FAILED",
    });
  }
  return true;
}

/** Boot recovery: a report left GENERATING_REPORT by a restart is
 *  re-queued (generation is a pure function of saved data — safe to
 *  redo). Also carries the F4 boot-time data migration: report
 *  generation uses the §18 state name GENERATING_REPORT, so rows
 *  written by an older build with the bare 'GENERATING' status are
 *  converged to the new name here — no db.ts migration needed. */
export function recoverInterruptedReports(): void {
  const db = getDb();
  db.prepare("UPDATE analytics_report_exports SET status = 'GENERATING_REPORT', updated_at = ? WHERE status = 'GENERATING'").run(nowIso());
  db.prepare("UPDATE analytics_reports SET status = 'GENERATING_REPORT', updated_at = ? WHERE status = 'GENERATING'").run(nowIso());
  db.prepare("UPDATE analytics_report_exports SET status = 'QUEUED', updated_at = ? WHERE status = 'GENERATING_REPORT'").run(nowIso());
  db.prepare("UPDATE analytics_reports SET status = 'QUEUED', updated_at = ? WHERE status = 'GENERATING_REPORT'").run(nowIso());
}
