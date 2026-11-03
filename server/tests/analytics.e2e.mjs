// Phase 11 Analytics & Performance Intelligence e2e.
//
// ============================================================================
// HONESTY NOTE — READ FIRST.
// This suite runs CLIPFORGE's REAL Phase 11 code (capability
// detection, snapshot storage, engagement formulas, sync worker,
// insights, report builder) against a LOCAL MOCK ANALYTICS PROVIDER
// implemented in this file (mock OAuth + mock YouTube Analytics /
// Data API, Instagram Insights and TikTok Display API on localhost).
// The mock exists because no real platform credentials exist in this
// environment. These are MOCK-PROVIDER tests of CLIPFORGE's own
// mechanics — they do NOT verify the spec §22 items that require
// real developer applications, audited clients or real accounts
// (§22 #1–11 against real platforms). Those remain "credentials
// pending", exactly as in Phase 10.
//
// Mock data design (deterministic, asserted exactly):
//  - Five YouTube videos with Data-API lifetime counters
//    views/likes/comments = [1000/100/50, 100/10/5, 120/12/6, 80/8/4,
//    90/9/5]; the Analytics API reports the same per-video activity
//    plus shares=7 each, daily channel activity views=10/day, and
//    the channel has 5000 subscribers.
//  - Two Instagram Reels: #1 reach 1000, views 5000, likes 50,
//    comments 10, shares 5, saves 20 (engagement by reach = 8.5%);
//    #2 reach 0 (zero-denominator case). Instagram Insights are
//    scope-gated: unavailable until the test grants
//    instagram_business_manage_insights in the account record.
//  - One TikTok video: views 777, likes 70, comments 7, shares 17 —
//    unavailable until the video.list scope is granted.
// ============================================================================
//
// Run: npm run test:analytics

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const PORT = 3261;
const MOCK_PORT = 3262;
const BASE = `http://localhost:${PORT}`;
const MOCK = `http://localhost:${MOCK_PORT}`;
const TOKEN_KEY_B64 = crypto.randomBytes(32).toString("base64");

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, extra = "") {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`FAIL  ${name} ${extra}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (res.status !== 0) throw new Error(`${cmd} failed: ${(res.stderr || "").slice(-400)}`);
  return res.stdout;
}

// ---------------------------------------------------------------------------
// HTTP client with cookie + CSRF handling (same pattern as other suites)
// ---------------------------------------------------------------------------
class Client {
  constructor() {
    this.cookies = new Map();
    this.csrf = null;
  }
  cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  storeCookies(res) {
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const line of set) {
      const [pair] = line.split(";");
      const idx = pair.indexOf("=");
      if (idx > 0) this.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }
  async raw(method, url, { body, headers = {}, formData } = {}) {
    const finalHeaders = { ...headers };
    if (this.cookies.size) finalHeaders.Cookie = this.cookieHeader();
    if (body !== undefined && !formData) finalHeaders["Content-Type"] = "application/json";
    if (method !== "GET" && this.csrf) finalHeaders["X-CSRF-Token"] = this.csrf;
    const res = await fetch(`${BASE}${url}`, {
      method,
      headers: finalHeaders,
      body: formData ?? (body !== undefined ? JSON.stringify(body) : undefined),
      redirect: "manual",
    });
    this.storeCookies(res);
    return res;
  }
  async call(method, url, opts = {}) {
    const res = await this.raw(method, url, opts);
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    return { status: res.status, data, headers: res.headers };
  }
  async getCsrf() {
    const { data } = await this.call("GET", "/api/auth/csrf");
    this.csrf = data.csrfToken;
    return this.csrf;
  }
  async register(email) {
    await this.getCsrf();
    const pw = "Str0ngPassw0rd!";
    const res = await this.call("POST", "/api/auth/register", {
      body: { displayName: "Analytics Tester", email, password: pw, confirmPassword: pw, termsAccepted: true },
    });
    if (res.status !== 201) throw new Error(`register failed: ${JSON.stringify(res.data)}`);
    return res.data.user;
  }
}

// ---------------------------------------------------------------------------
// LOCAL MOCK ANALYTICS PROVIDER — mock OAuth + mock platform APIs,
// INCLUDING the analytics surfaces (YouTube Analytics reports.query,
// Instagram Insights, TikTok Display API video.query). Clearly a
// test double: it serves deterministic fixture numbers so the suite
// can assert CLIPFORGE's math exactly. It is NOT a platform.
// ---------------------------------------------------------------------------
function freshMockState() {
  return {
    counters: { ytSessions: 0, ytUploads: 0, analyticsReports: 0, igInsights: 0, ttVideoQueries: 0, ytDataCalls: 0, ttUserInfo: 0 },
    flags: {
      denyNextAuth: false,
      rateLimitNextAnalytics: false,
      quotaNextYtDataApi: false,
      revokeYtRefresh: false,
      igAccountType: "BUSINESS",
      ytStatsQueue: [],
      igStatsQueue: [],
    },
    pkceByState: new Map(),
    ytAccess: new Map(),
    ytRefresh: new Map(),
    ytSessions: new Map(),
    ytVideos: new Map(),
    igAccess: new Set(),
    igContainers: new Map(),
    igMedia: new Map(),
    igMediaStats: new Map(),
    ttAccess: new Map(),
    ttPublishes: new Map(),
    ttVideos: new Map(),
    seq: 0,
  };
}
let M = freshMockState();

function mockJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}
function bearer(req) {
  const h = req.headers.authorization ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}
function ytAuth(req, res) {
  const tok = bearer(req);
  const rec = M.ytAccess.get(tok);
  if (!rec || rec.exp <= Date.now()) {
    mockJson(res, 401, { error: { code: 401, message: "Request had invalid authentication credentials." } });
    return null;
  }
  return rec;
}
function issueYtTokens() {
  const n = ++M.seq;
  const access = `yt-access-${n}`;
  const refresh = `yt-refresh-${n}`;
  M.ytAccess.set(access, { exp: Date.now() + 3600_000, refresh });
  M.ytRefresh.set(refresh, { revoked: false });
  return { access, refresh };
}

const YT_DAILY = { views: 10, engagedViews: 8, likes: 2, comments: 1, shares: 1, estimatedMinutesWatched: 30, averageViewDuration: 45, subscribersGained: 1, subscribersLost: 0 };

async function mockHandler(req, res) {
  const url = new URL(req.url, MOCK);
  const p = url.pathname;
  try {
    // ---- control plane -------------------------------------------------
    if (p === "/__state") return mockJson(res, 200, { counters: M.counters, flags: M.flags });
    if (p === "/__control" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      Object.assign(M.flags, body);
      return mockJson(res, 200, { ok: true });
    }
    if (p === "/__expire-yt-access" && req.method === "POST") {
      for (const rec of M.ytAccess.values()) rec.exp = Date.now() - 1000;
      return mockJson(res, 200, { ok: true });
    }
    if (p === "/__set-yt-stats" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const video = M.ytVideos.get(body.videoId);
      if (video) video.stats = body.stats;
      return mockJson(res, 200, { ok: Boolean(video) });
    }

    // ---- YouTube OAuth ---------------------------------------------------
    if (p === "/oauth/authorize" && req.method === "GET") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      if (url.searchParams.get("code_challenge")) M.pkceByState.set(state, url.searchParams.get("code_challenge"));
      res.writeHead(302, { Location: `${redirectUri}?code=mock-yt-code&state=${state}` });
      return res.end();
    }
    if (p === "/oauth/token" && req.method === "POST") {
      const form = new URLSearchParams((await readBody(req)).toString("utf8"));
      const grant = form.get("grant_type");
      if (grant === "authorization_code") {
        const verifier = form.get("code_verifier");
        const states = [...M.pkceByState.entries()];
        const expected = states.length ? states[states.length - 1][1] : null;
        if (!verifier || !expected || crypto.createHash("sha256").update(verifier).digest("base64url") !== expected) {
          return mockJson(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed." });
        }
        const t = issueYtTokens();
        return mockJson(res, 200, {
          access_token: t.access, refresh_token: t.refresh, expires_in: 3600,
          scope: "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly",
          token_type: "Bearer",
        });
      }
      if (grant === "refresh_token") {
        const rec = M.ytRefresh.get(form.get("refresh_token"));
        if (!rec || rec.revoked || M.flags.revokeYtRefresh) {
          return mockJson(res, 400, { error: "invalid_grant", error_description: "Token has been revoked." });
        }
        const n = ++M.seq;
        const access = `yt-access-${n}`;
        M.ytAccess.set(access, { exp: Date.now() + 3600_000, refresh: form.get("refresh_token") });
        return mockJson(res, 200, { access_token: access, expires_in: 3600, token_type: "Bearer" });
      }
      return mockJson(res, 400, { error: "unsupported_grant_type" });
    }
    if (p === "/oauth/revoke" && req.method === "POST") {
      await readBody(req);
      return mockJson(res, 200, {});
    }

    // ---- YouTube Analytics API (reports.query) ---------------------------
    if (p === "/v2/reports" && req.method === "GET") {
      if (!ytAuth(req, res)) return;
      if (M.flags.rateLimitNextAnalytics) {
        M.flags.rateLimitNextAnalytics = false;
        return mockJson(res, 429, { error: { code: 429, message: "Quota exceeded for quota metric 'analytics.reports'." } });
      }
      M.counters.analyticsReports += 1;
      const metrics = (url.searchParams.get("metrics") ?? "").split(",").filter(Boolean);
      const dimensions = url.searchParams.get("dimensions") ?? "";
      if (dimensions === "day") {
        const start = new Date(`${url.searchParams.get("startDate")}T00:00:00Z`);
        const end = new Date(`${url.searchParams.get("endDate")}T00:00:00Z`);
        const rows = [];
        for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
          const day = d.toISOString().slice(0, 10);
          rows.push([day, ...metrics.map((m) => YT_DAILY[m] ?? 0)]);
        }
        return mockJson(res, 200, {
          kind: "youtubeAnalytics#resultTable",
          columnHeaders: [{ name: "day" }, ...metrics.map((name) => ({ name }))],
          rows,
        });
      }
      if (dimensions === "video") {
        const filter = url.searchParams.get("filters") ?? "";
        const ids = filter.startsWith("video==") ? filter.slice("video==".length).split(",") : [];
        const rows = [];
        for (const id of ids) {
          const video = M.ytVideos.get(id);
          if (!video?.stats) continue;
          const s = video.stats;
          const byMetric = {
            views: Number(s.viewCount), engagedViews: Math.round(Number(s.viewCount) * 0.8),
            likes: Number(s.likeCount), comments: Number(s.commentCount), shares: 7,
            estimatedMinutesWatched: 12, averageViewDuration: 40,
          };
          rows.push([id, ...metrics.map((m) => byMetric[m] ?? 0)]);
        }
        return mockJson(res, 200, {
          kind: "youtubeAnalytics#resultTable",
          columnHeaders: [{ name: "video" }, ...metrics.map((name) => ({ name }))],
          rows,
        });
      }
      return mockJson(res, 400, { error: { code: 400, message: "mock: unsupported report shape" } });
    }

    // ---- YouTube Data API --------------------------------------------------
    if (p === "/youtube/v3/channels") {
      if (!ytAuth(req, res)) return;
      // F3 one-shot fault: a Google-style quota 403. classifyHttp alone
      // would call any 403 AUTH_REQUIRED; the integration must treat a
      // quota body as a transient rate limit and retry.
      if (M.flags.quotaNextYtDataApi) {
        M.flags.quotaNextYtDataApi = false;
        return mockJson(res, 403, { error: { code: 403, message: "The request cannot be completed because you have exceeded your quota.", errors: [{ domain: "youtube.quota", reason: "quotaExceeded", message: "The request cannot be completed because you have exceeded your quota." }] } });
      }
      M.counters.ytDataCalls += 1;
      return mockJson(res, 200, {
        items: [{
          id: "yt-channel-1",
          snippet: { title: "Mock Channel", customUrl: "@mockchannel", thumbnails: { default: { url: "http://mock/avatar.png" } } },
          statistics: { viewCount: "99999", subscriberCount: "5000", hiddenSubscriberCount: false, videoCount: "5" },
        }],
      });
    }
    if (p === "/youtube/v3/videoCategories") {
      if (!ytAuth(req, res)) return;
      return mockJson(res, 200, { items: [{ id: "22", snippet: { title: "People & Blogs", assignable: true } }] });
    }
    if (p === "/youtube/v3/videos" && req.method === "GET") {
      if (!ytAuth(req, res)) return;
      if (M.flags.quotaNextYtDataApi) {
        M.flags.quotaNextYtDataApi = false;
        return mockJson(res, 403, { error: { code: 403, message: "The request cannot be completed because you have exceeded your quota.", errors: [{ domain: "youtube.quota", reason: "quotaExceeded", message: "The request cannot be completed because you have exceeded your quota." }] } });
      }
      M.counters.ytDataCalls += 1;
      const ids = (url.searchParams.get("id") ?? "").split(",").filter(Boolean);
      const part = url.searchParams.get("part") ?? "";
      const items = [];
      for (const id of ids) {
        const video = M.ytVideos.get(id);
        if (!video) continue;
        const item = { id };
        if (part.includes("statistics")) {
          item.statistics = video.stats ?? { viewCount: "123", likeCount: "45", commentCount: "6" };
        }
        if (part.includes("status")) {
          item.status = { uploadStatus: "processed", privacyStatus: video.meta?.status?.privacyStatus ?? "private" };
        }
        items.push(item);
      }
      return mockJson(res, 200, { items });
    }
    if (p === "/upload/youtube/v3/videos" && req.method === "POST") {
      if (!ytAuth(req, res)) return;
      const meta = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const id = `sess-${++M.seq}`;
      M.ytSessions.set(id, { total: Number(req.headers["x-upload-content-length"] ?? 0), received: 0, complete: false, videoId: null, meta });
      M.counters.ytSessions += 1;
      res.writeHead(200, { Location: `${MOCK}/upload-session/${id}`, "Content-Type": "application/json" });
      return res.end("{}");
    }
    if (p.startsWith("/upload-session/") && req.method === "PUT") {
      if (!ytAuth(req, res)) return;
      const sess = M.ytSessions.get(p.split("/")[2]);
      if (!sess) return mockJson(res, 404, { error: { message: "session not found" } });
      const range = req.headers["content-range"] ?? "";
      if (range.startsWith("bytes */")) {
        if (sess.complete) return mockJson(res, 200, { id: sess.videoId, status: { uploadStatus: "uploaded" } });
        res.writeHead(308, { Range: `bytes=0-${Math.max(0, sess.received - 1)}` });
        return res.end();
      }
      const body = await readBody(req);
      sess.received += body.length;
      if (sess.received >= sess.total) {
        sess.complete = true;
        sess.videoId = `ytvid-${++M.seq}`;
        const stats = M.flags.ytStatsQueue.length > 0 ? M.flags.ytStatsQueue.shift() : { viewCount: "100", likeCount: "10", commentCount: "5" };
        M.ytVideos.set(sess.videoId, { meta: sess.meta, stats });
        M.counters.ytUploads += 1;
      }
      return mockJson(res, 200, { id: sess.videoId, status: { uploadStatus: "uploaded" } });
    }
    if (p === "/upload/youtube/v3/thumbnails/set" && req.method === "POST") {
      if (!ytAuth(req, res)) return;
      await readBody(req);
      return mockJson(res, 200, { items: [{ videoId: url.searchParams.get("videoId") }] });
    }

    // ---- Instagram OAuth + Graph -------------------------------------------
    if (p === "/ig/authorize" && req.method === "GET") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      res.writeHead(302, { Location: `${redirectUri}?code=mock-ig-code&state=${state}` });
      return res.end();
    }
    if (p === "/ig/oauth/access_token" && req.method === "POST") {
      await readBody(req);
      M.igAccess.add("ig-short-1");
      return mockJson(res, 200, { access_token: "ig-short-1", user_id: "ig-user-1", permissions: ["instagram_business_basic", "instagram_business_content_publish"] });
    }
    if (p === "/graph/access_token" && req.method === "GET") {
      M.igAccess.add("ig-long-1");
      return mockJson(res, 200, { access_token: "ig-long-1", token_type: "bearer", expires_in: 5184000 });
    }
    if (p === "/graph/refresh_access_token" && req.method === "GET") {
      const tok = `ig-long-${++M.seq}`;
      M.igAccess.add(tok);
      return mockJson(res, 200, { access_token: tok, token_type: "bearer", expires_in: 5184000 });
    }
    if (p === "/graph/me" && req.method === "GET") {
      if (!M.igAccess.has(bearer(req))) return mockJson(res, 401, { error: { message: "Invalid OAuth access token.", code: 190 } });
      return mockJson(res, 200, {
        id: "ig-user-1", username: "mock.creator", account_type: M.flags.igAccountType,
        name: "Mock Creator", profile_picture_url: "http://mock/ig-avatar.png", followers_count: 1234,
      });
    }
    if (p === "/graph/ig-user-1/insights" && req.method === "GET") {
      if (!M.igAccess.has(bearer(req))) return mockJson(res, 401, { error: { message: "Invalid OAuth access token.", code: 190 } });
      M.counters.igInsights += 1;
      const metric = url.searchParams.get("metric");
      const perDay = { reach: 100, views: 300, total_interactions: 40 }[metric] ?? 0;
      const days = [2, 1, 0].map((back) => {
        const d = new Date(Date.now() - back * 86400000);
        return { value: perDay, end_time: `${d.toISOString().slice(0, 10)}T07:00:00+0000` };
      });
      return mockJson(res, 200, { data: [{ name: metric, period: "day", values: days, total_value: { value: perDay * 3 } }] });
    }
    if (/^\/graph\/ig-media-\d+\/insights$/.test(p) && req.method === "GET") {
      if (!M.igAccess.has(bearer(req))) return mockJson(res, 401, { error: { message: "Invalid OAuth access token.", code: 190 } });
      M.counters.igInsights += 1;
      const mediaId = p.split("/")[2];
      const stats = M.igMediaStats.get(mediaId);
      if (!stats) return mockJson(res, 404, { error: { message: "(#100) media does not exist", code: 100 } });
      const requested = (url.searchParams.get("metric") ?? "").split(",").filter(Boolean);
      const data = requested
        .filter((name) => stats[name] !== undefined)
        .map((name) => ({ name, period: "lifetime", values: [{ value: stats[name] }], total_value: { value: stats[name] } }));
      return mockJson(res, 200, { data });
    }
    if (/^\/graph\/ig-user-1\/media$/.test(p) && req.method === "POST") {
      if (!M.igAccess.has(bearer(req))) return mockJson(res, 401, { error: { message: "Invalid OAuth access token.", code: 190 } });
      const id = `ig-container-${++M.seq}`;
      M.igContainers.set(id, { uploaded: false, published: false });
      return mockJson(res, 200, { id, uri: `${MOCK}/ig-upload/${id}` });
    }
    if (p.startsWith("/ig-upload/") && req.method === "POST") {
      const id = p.split("/")[2];
      await readBody(req);
      const c = M.igContainers.get(id);
      if (c) c.uploaded = true;
      return mockJson(res, 200, { success: true });
    }
    if (/^\/graph\/ig-container-\d+$/.test(p) && req.method === "GET") {
      const c = M.igContainers.get(p.split("/")[2]);
      if (!c) return mockJson(res, 404, { error: { message: "container not found" } });
      return mockJson(res, 200, { status_code: c.published ? "PUBLISHED" : c.uploaded ? "FINISHED" : "IN_PROGRESS", id: p.split("/")[2] });
    }
    if (/^\/graph\/ig-media-\d+$/.test(p) && req.method === "GET") {
      const id = p.split("/")[2];
      if (!M.igMedia.has(id)) return mockJson(res, 404, { error: { message: "media not found" } });
      return mockJson(res, 200, { id, permalink: `https://www.instagram.com/reel/${id}/`, username: "mock.creator" });
    }
    if (/^\/graph\/ig-user-1\/media_publish$/.test(p) && req.method === "POST") {
      if (!M.igAccess.has(bearer(req))) return mockJson(res, 401, { error: { message: "Invalid OAuth access token.", code: 190 } });
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const container = M.igContainers.get(body.creation_id);
      if (!container) return mockJson(res, 400, { error: { message: "container not found" } });
      container.published = true;
      const mediaId = `ig-media-${++M.seq}`;
      M.igMedia.set(mediaId, { containerId: body.creation_id });
      const stats = M.flags.igStatsQueue.length > 0
        ? M.flags.igStatsQueue.shift()
        : { views: 5000, reach: 1000, likes: 50, comments: 10, shares: 5, saved: 20, total_interactions: 85, ig_reels_avg_watch_time: 12300 };
      M.igMediaStats.set(mediaId, stats);
      return mockJson(res, 200, { id: mediaId });
    }

    // ---- TikTok --------------------------------------------------------------
    if (p === "/v2/auth/authorize" && req.method === "GET") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      res.writeHead(302, { Location: `${redirectUri}?code=mock-tt-code&state=${state}` });
      return res.end();
    }
    if (p === "/v2/oauth/token/" && req.method === "POST") {
      const form = new URLSearchParams((await readBody(req)).toString("utf8"));
      if (form.get("grant_type") === "refresh_token") {
        const n = ++M.seq;
        const access = `tt-access-${n}`;
        M.ttAccess.set(access, { exp: Date.now() + 86400_000 });
        return mockJson(res, 200, { data: { access_token: access, refresh_token: form.get("refresh_token"), open_id: "tt-open-1", scope: "user.info.basic,video.publish", expires_in: 86400 } });
      }
      M.ttAccess.set("tt-access-1", { exp: Date.now() + 86400_000 });
      return mockJson(res, 200, {
        data: { access_token: "tt-access-1", refresh_token: "tt-refresh-1", open_id: "tt-open-1", scope: "user.info.basic,video.publish", expires_in: 86400, refresh_expires_in: 31536000 },
        error: { code: "ok", message: "", log_id: "mock" },
      });
    }
    if (p === "/v2/user/info/" && req.method === "GET") {
      const rec = M.ttAccess.get(bearer(req));
      if (!rec || rec.exp <= Date.now()) return mockJson(res, 401, { error: { code: "access_token_invalid", message: "Access token is invalid." } });
      M.counters.ttUserInfo += 1;
      return mockJson(res, 200, {
        data: { user: { open_id: "tt-open-1", union_id: "tt-union-1", avatar_url: "http://mock/tt-avatar.png", display_name: "Mock Creator", username: "mockcreator", follower_count: 4321, following_count: 12, likes_count: 9876, video_count: 1 } },
        error: { code: "ok" },
      });
    }
    if (p === "/v2/post/publish/creator_info/query/" && req.method === "POST") {
      await readBody(req);
      return mockJson(res, 200, {
        data: {
          creator_username: "mockcreator", creator_nickname: "Mock Creator", creator_avatar_url: "http://mock/tt-avatar.png",
          privacy_level_options: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"],
          comment_disabled: false, duet_disabled: false, stitch_disabled: false, max_video_post_duration_sec: 600,
        },
        error: { code: "ok" },
      });
    }
    if (p === "/v2/post/publish/video/init/" && req.method === "POST") {
      const rec = M.ttAccess.get(bearer(req));
      if (!rec || rec.exp <= Date.now()) return mockJson(res, 401, { error: { code: "access_token_invalid", message: "Access token is invalid." } });
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const id = `tt-pub-${++M.seq}`;
      M.ttPublishes.set(id, { uploaded: false, postInfo: body.post_info });
      return mockJson(res, 200, { data: { publish_id: id, upload_url: `${MOCK}/tt-upload/${id}` }, error: { code: "ok" } });
    }
    if (p.startsWith("/tt-upload/") && req.method === "PUT") {
      const id = p.split("/")[2];
      await readBody(req);
      const rec = M.ttPublishes.get(id);
      if (rec) rec.uploaded = true;
      return res.writeHead(201), res.end();
    }
    if (p === "/v2/post/publish/status/fetch/" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const rec = M.ttPublishes.get(body.publish_id);
      if (!rec) return mockJson(res, 200, { data: { status: "FAILED", fail_reason: "file_not_found" }, error: { code: "ok" } });
      if (rec.uploaded) {
        const videoId = `tt-post-${body.publish_id.split("-")[2]}`;
        if (!M.ttVideos.has(videoId)) {
          M.ttVideos.set(videoId, {
            id: videoId, create_time: Math.floor(Date.now() / 1000) - 3600,
            video_description: rec.postInfo?.title ?? "", duration: 3,
            like_count: 70, comment_count: 7, share_count: 17, view_count: 777,
            share_url: `https://www.tiktok.com/@mockcreator/video/${videoId}`,
          });
        }
        return mockJson(res, 200, { data: { status: "PUBLISH_COMPLETE", publicaly_available_post_id: [videoId] }, error: { code: "ok" } });
      }
      return mockJson(res, 200, { data: { status: "PROCESSING_UPLOAD" }, error: { code: "ok" } });
    }
    if (p === "/v2/video/query/" && req.method === "POST") {
      const rec = M.ttAccess.get(bearer(req));
      if (!rec || rec.exp <= Date.now()) return mockJson(res, 401, { error: { code: "access_token_invalid", message: "Access token is invalid." } });
      M.counters.ttVideoQueries += 1;
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const ids = body.filters?.video_ids ?? [];
      const videos = ids.map((id) => M.ttVideos.get(id)).filter(Boolean);
      return mockJson(res, 200, { data: { videos }, error: { code: "ok", message: "" } });
    }
    if (p === "/v2/video/list/" && req.method === "POST") {
      const rec = M.ttAccess.get(bearer(req));
      if (!rec || rec.exp <= Date.now()) return mockJson(res, 401, { error: { code: "access_token_invalid", message: "Access token is invalid." } });
      await readBody(req);
      return mockJson(res, 200, { data: { videos: [...M.ttVideos.values()], cursor: 0, has_more: false }, error: { code: "ok", message: "" } });
    }

    return mockJson(res, 404, { error: { message: `mock: no route for ${req.method} ${p}` } });
  } catch (err) {
    return mockJson(res, 500, { error: { message: `mock error: ${err.message}` } });
  }
}

// ---------------------------------------------------------------------------
// CLIPFORGE server management + workflow helpers (Phase 10 pattern)
// ---------------------------------------------------------------------------
const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-an-a-"));
const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-an-b-"));

function baseEnv(tmp) {
  return {
    ...process.env,
    PORT: String(PORT),
    NODE_ENV: "test",
    DATABASE_FILE: path.join(tmp, "test.db"),
    MEDIA_DIR: path.join(tmp, "media"),
    PROCESSING_DIR: path.join(tmp, "processing"),
    ANALYTICS_REPORTS_DIR: path.join(tmp, "reports"),
    TOKEN_ENCRYPTION_KEY: TOKEN_KEY_B64,
    PUBLISH_TICK_MS: "200",
    PUBLISH_STATUS_POLL_MS: "300",
    ANALYTICS_TICK_MS: "200",
    ANALYTICS_BACKOFF_BASE_SEC: "1",
    GOOGLE_OAUTH_CLIENT_ID: "", GOOGLE_OAUTH_CLIENT_SECRET: "", GOOGLE_OAUTH_REDIRECT_URI: "",
    META_APP_ID: "", META_APP_SECRET: "", META_REDIRECT_URI: "",
    TIKTOK_CLIENT_KEY: "", TIKTOK_CLIENT_SECRET: "", TIKTOK_REDIRECT_URI: "",
  };
}
function mockEnv(tmp) {
  return {
    ...baseEnv(tmp),
    GOOGLE_OAUTH_CLIENT_ID: "mock-google-client",
    GOOGLE_OAUTH_CLIENT_SECRET: "mock-google-secret",
    GOOGLE_OAUTH_REDIRECT_URI: `${BASE}/api/publishing/oauth/youtube/callback`,
    YOUTUBE_AUTH_BASE: `${MOCK}/oauth/authorize`,
    YOUTUBE_TOKEN_URL: `${MOCK}/oauth/token`,
    YOUTUBE_REVOKE_URL: `${MOCK}/oauth/revoke`,
    YOUTUBE_API_BASE: MOCK,
    YOUTUBE_ANALYTICS_API_BASE: MOCK,
    META_APP_ID: "mock-meta-app",
    META_APP_SECRET: "mock-meta-secret",
    META_REDIRECT_URI: `${BASE}/api/publishing/oauth/instagram/callback`,
    META_AUTH_BASE: `${MOCK}/ig/authorize`,
    META_TOKEN_URL: `${MOCK}/ig/oauth/access_token`,
    META_GRAPH_BASE: `${MOCK}/graph`,
    META_WEBHOOK_VERIFY_TOKEN: "mock-verify-token",
    TIKTOK_CLIENT_KEY: "mock-tt-key",
    TIKTOK_CLIENT_SECRET: "mock-tt-secret",
    TIKTOK_REDIRECT_URI: `${BASE}/api/publishing/oauth/tiktok/callback`,
    TIKTOK_AUTH_BASE: `${MOCK}/v2/auth/authorize`,
    TIKTOK_API_BASE: MOCK,
  };
}

function spawnServer(env) {
  const srv = spawn(path.join(serverDir, "node_modules", ".bin", "tsx"), ["src/index.ts"], {
    cwd: serverDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  srv.log = "";
  srv.stdout.on("data", (d) => (srv.log += d));
  srv.stderr.on("data", (d) => (srv.log += d));
  return srv;
}
function killServer(srv) {
  try {
    process.kill(-srv.pid, "SIGKILL");
  } catch {
    try { srv.kill("SIGKILL"); } catch { /* already gone */ }
  }
}
async function waitForHealth(timeoutMs = 60000) {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() - start > timeoutMs) throw new Error("server did not start in time");
    await sleep(250);
  }
}
async function mockState() {
  const res = await fetch(`${MOCK}/__state`);
  return res.json();
}
async function mockControl(flags) {
  await fetch(`${MOCK}/__control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(flags),
  });
}

async function followOAuth(client, platform) {
  const conn = await client.call("POST", `/api/publishing/accounts/${platform}/connect`);
  if (conn.status !== 200) throw new Error(`connect ${platform} failed: ${conn.status} ${JSON.stringify(conn.data)}`);
  const authRes = await fetch(conn.data.authUrl, { redirect: "manual" });
  const callbackUrl = authRes.headers.get("location");
  if (!callbackUrl) throw new Error(`mock authorize for ${platform} did not redirect`);
  const cbRes = await fetch(callbackUrl, { redirect: "manual" });
  return { cbStatus: cbRes.status, cbLocation: cbRes.headers.get("location") ?? "" };
}

async function waitForPublishJob(client, jobId, wanted, timeoutMs = 45000) {
  const start = Date.now();
  let last = null;
  for (;;) {
    const res = await client.call("GET", `/api/publishing/jobs/${jobId}`);
    last = res.data?.job;
    if (last && wanted.includes(last.status)) return last;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`publish job ${jobId} never reached ${wanted.join("|")} (now ${last?.status}: ${last?.error ?? ""})`);
    }
    await sleep(300);
  }
}

async function waitForSyncJob(client, jobId, timeoutMs = 60000) {
  const start = Date.now();
  let last = null;
  const terminal = ["COMPLETED", "PARTIAL_SUCCESS", "FAILED", "AUTH_REQUIRED", "CANCELLED"];
  for (;;) {
    const res = await client.call("GET", `/api/analytics/sync/jobs/${jobId}`);
    last = res.data?.job;
    if (last && terminal.includes(last.status)) return { job: last, attempts: res.data.attempts ?? [] };
    if (Date.now() - start > timeoutMs) {
      throw new Error(`sync job ${jobId} never finished (now ${last?.status}: ${last?.error ?? ""})`);
    }
    await sleep(300);
  }
}

const CLIENT_YT_METADATA = {
  title: "", description: "", tags: [], categoryId: "22", privacy: "private",
  madeForKids: false, containsSyntheticMedia: false, paidPromotion: false,
};
const CLIENT_IG_METADATA = {
  caption: "", hashtags: [], shareToFeed: true, thumbOffsetMs: null, paidPromotion: false,
};
const CLIENT_TT_METADATA = {
  caption: "", privacyLevel: "", disableComment: false, disableDuet: false, disableStitch: false,
  brandedContent: false, brandOrganic: false, creatorConsent: false, containsSyntheticMedia: false,
  videoCoverTimestampMs: null,
};

async function createDraft(client, accountId, exportOutputId, metadata) {
  return client.call("POST", "/api/publishing/jobs", { body: { exportOutputId, accountId, metadata } });
}
async function validateApproveSubmit(client, jobId) {
  const v = await client.call("POST", `/api/publishing/jobs/${jobId}/validate`);
  if (!v.data?.ok) throw new Error(`validate failed for ${jobId}: ${JSON.stringify(v.data?.checks?.filter((c) => !c.ok))}`);
  const a = await client.call("POST", `/api/publishing/jobs/${jobId}/approve`, { body: { rightsConfirmed: true } });
  if (a.status !== 200) throw new Error(`approve failed for ${jobId}: ${JSON.stringify(a.data)}`);
  const s = await client.call("POST", `/api/publishing/jobs/${jobId}/submit`);
  if (s.status !== 200) throw new Error(`submit failed for ${jobId}: ${JSON.stringify(s.data)}`);
  return s.data.job;
}
async function publishOne(client, accountId, exportOutputId, metadata) {
  const draft = await createDraft(client, accountId, exportOutputId, metadata);
  if (draft.status !== 201) throw new Error(`draft failed: ${JSON.stringify(draft.data)}`);
  const jobId = draft.data.job.id;
  await validateApproveSubmit(client, jobId);
  const published = await waitForPublishJob(client, jobId, ["PUBLISHED", "FAILED", "AUTH_REQUIRED"]);
  if (published.status !== "PUBLISHED") throw new Error(`publish failed for ${jobId}: ${published.error}`);
  return published;
}

const CLIENT_EXPORT_SETTINGS = {
  container: "mp4", videoCodec: "libx264", audioCodec: "aac", audioOnly: false,
  resolution: "original", aspect: "original", customWidth: null, customHeight: null,
  qualityMode: "preset", qualityPreset: "standard", crf: null, videoBitrateKbps: null,
  encoderPreset: "veryfast", fps: null, keyframeInterval: null,
  includeOriginalAudio: true, includeMusic: true, includeBrollAudio: true,
  audioBitrateKbps: 160, audioSampleRate: 48000, audioChannels: 2, normalizeAudio: false,
  captionMode: "burn", captionFormat: "both", includeEnhancement: false, includeReframe: false,
  namingPattern: "project-clip-resolution", customName: null, rangeStart: null, rangeEnd: null,
};
async function uploadSource(client, projectId, filePath, filename) {
  const buf = fs.readFileSync(filePath);
  const session = await client.call("POST", `/api/projects/${projectId}/upload-session`, {
    body: { filename, size: buf.length },
  });
  if (session.status !== 201) throw new Error(`upload session failed: ${JSON.stringify(session.data)}`);
  const form = new FormData();
  form.append("file", new Blob([buf], { type: "video/mp4" }), filename);
  const res = await client.raw("POST", `/api/upload-sessions/${session.data.session.id}/file`, { formData: form });
  const data = await res.json();
  if (res.status !== 200) throw new Error(`source upload failed ${res.status}: ${JSON.stringify(data)}`);
  return data.asset;
}
async function makeExport(client, projectId, settings) {
  const res = await client.call("POST", `/api/projects/${projectId}/exports`, {
    body: { targets: [{ kind: "document" }], settings },
  });
  if (res.status !== 201) throw new Error(`export create failed: ${JSON.stringify(res.data)}`);
  const renderJobId = res.data.jobs[0].id;
  const start = Date.now();
  for (;;) {
    const jr = await client.call("GET", `/api/export-jobs/${renderJobId}`);
    const job = jr.data?.job;
    if (job?.status === "COMPLETED") break;
    if (job?.status === "FAILED" || job?.status === "CANCELLED") throw new Error(`export failed: ${job.error}`);
    if (Date.now() - start > 180000) throw new Error("export timed out");
    await sleep(800);
  }
  const hist = await client.call("GET", "/api/exports/history");
  const output = hist.data.outputs.find((o) => o.jobId === renderJobId);
  if (!output) throw new Error("export output missing from history");
  return output;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------
const mockServer = http.createServer((req, res) => void mockHandler(req, res));
await new Promise((r) => mockServer.listen(MOCK_PORT, r));
console.log(`Phase 11 analytics e2e — LOCAL MOCK analytics provider on ${MOCK_PORT}`);

const today = new Date();
const dayStr = (d) => d.toISOString().slice(0, 10);
const RANGE = { from: dayStr(new Date(today.getTime() - 29 * 86400000)), to: dayStr(today) };

let server = null;
try {
  // =========================================================================
  console.log("\n== Server A: NO provider credentials ==");
  // =========================================================================
  server = spawnServer(baseEnv(tmpA));
  await waitForHealth();
  const aliceA = new Client();
  await aliceA.register("alice-an-a@example.com");
  const anon = new Client();

  const defsA = await aliceA.call("GET", "/api/analytics/definitions");
  check("A: metric definitions are served (§19) incl. views + reach with distinct definitions",
    defsA.status === 200 && defsA.data.definitions.some((d) => d.metric_key === "views") &&
    defsA.data.definitions.some((d) => d.metric_key === "reach" && /never added/i.test(d.definition ?? "")),
    JSON.stringify(defsA.data).slice(0, 200));
  const ovA = await aliceA.call("GET", `/api/analytics/overview?from=${RANGE.from}&to=${RANGE.to}`);
  check("A (#33): with zero data every overview metric is null/unavailable — nothing invented, nothing zero-filled",
    ovA.status === 200 && ovA.data.metrics.every((m) => m.value === null && m.availability === "unavailable"),
    JSON.stringify(ovA.data.metrics).slice(0, 300));
  const capsA = await aliceA.call("GET", "/api/analytics/capabilities");
  check("A: capabilities lists every platform as NOT CONFIGURED (named missing vars, no accounts) when nothing is connected",
    capsA.status === 200 && capsA.data.accounts.length === 3 &&
    capsA.data.accounts.every((a) => a.account === null && a.configured === false && Array.isArray(a.missing) && a.missing.length > 0 && a.capability === null),
    JSON.stringify(capsA.data).slice(0, 200));
  const syncA = await aliceA.call("POST", "/api/analytics/sync", { body: { accountId: "no-such-account" } });
  check("A: sync for a nonexistent account → 404", syncA.status === 404, `got ${syncA.status}`);
  const anonOv = await anon.call("GET", "/api/analytics/overview");
  check("A: analytics APIs require auth (401)", anonOv.status === 401, `got ${anonOv.status}`);
  killServer(server);
  server = null;
  await sleep(500);

  // =========================================================================
  console.log("\n== Server B: LOCAL MOCK analytics provider configured ==");
  // =========================================================================
  server = spawnServer(mockEnv(tmpB));
  await waitForHealth();
  const alice = new Client();
  const bob = new Client();
  const aliceUser = await alice.register("alice-an@example.com");
  const bobUser = await bob.register("bob-an@example.com");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(tmpB, "test.db"));

  await followOAuth(alice, "youtube");
  await followOAuth(alice, "instagram");
  await followOAuth(alice, "tiktok");
  const accounts = (await alice.call("GET", "/api/publishing/accounts")).data.accounts;
  const ytAccount = accounts.find((a) => a.platform === "youtube");
  const igAccount = accounts.find((a) => a.platform === "instagram");
  const ttAccount = accounts.find((a) => a.platform === "tiktok");
  check("B: three mock accounts connected", Boolean(ytAccount && igAccount && ttAccount), JSON.stringify(accounts).slice(0, 200));

  // ---- capability detection before any request (§6) -------------------------
  const capsRes = await alice.call("GET", "/api/analytics/capabilities");
  const capsByPlatform = Object.fromEntries(capsRes.data.accounts.map((a) => [a.account.platform, a.capability]));
  const ytCaps = capsByPlatform.youtube;
  const igCaps = capsByPlatform.instagram;
  const ttCaps = capsByPlatform.tiktok;
  check("B (§6): YouTube analytics metrics AVAILABLE (yt-analytics.readonly granted by the mock OAuth)",
    ytCaps?.metrics.find((m) => m.key === "views")?.status === "available" &&
    ytCaps?.metrics.find((m) => m.key === "followers")?.status === "available",
    JSON.stringify(ytCaps?.metrics).slice(0, 300));
  check("B (§6/#12): YouTube saves are UNSUPPORTED (platform exposes none) — distinct from unavailable",
    ytCaps?.metrics.find((m) => m.key === "saves")?.status === "unsupported");
  check("B (§6/#8): Instagram insights UNAVAILABLE until the insights scope is granted, with the scope named",
    igCaps?.metrics.find((m) => m.key === "views")?.status === "unavailable" &&
    /instagram_business_manage_insights/.test(igCaps?.metrics.find((m) => m.key === "views")?.reason ?? ""),
    igCaps?.metrics.find((m) => m.key === "views")?.reason ?? "");
  check("B (§6/#11): TikTok post metrics UNAVAILABLE until video.list is granted, with the scope named",
    ttCaps?.metrics.find((m) => m.key === "views")?.status === "unavailable" &&
    /video\.list/.test(ttCaps?.metrics.find((m) => m.key === "views")?.reason ?? ""));
  check("B (§6): TikTok reach/watch-time are UNSUPPORTED via the Display API (no Research API substitute)",
    ttCaps?.metrics.find((m) => m.key === "reach")?.status === "unsupported" &&
    ttCaps?.metrics.find((m) => m.key === "watch_time_seconds")?.status === "unsupported");

  // ---- a real export + publishes ---------------------------------------------
  const fixtureDir = path.join(tmpB, "fixtures");
  fs.mkdirSync(fixtureDir, { recursive: true });
  const sourceFile = path.join(fixtureDir, "source.mp4");
  run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=3",
    "-f", "lavfi", "-i", "sine=frequency=440:d=3", "-map", "0:v", "-map", "1:a",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", sourceFile]);
  const proj = await alice.call("POST", "/api/projects", { body: { name: "Analytics Main", workflowType: "LONG_VIDEO_TO_SHORTS" } });
  const projectId = proj.data.project.id;
  await uploadSource(alice, projectId, sourceFile, "source.mp4");
  await alice.call("GET", `/api/projects/${projectId}/editor`);
  const videoOutput = await makeExport(alice, projectId, CLIENT_EXPORT_SETTINGS);
  check("B: export COMPLETED for publishing", videoOutput.status === "COMPLETED", JSON.stringify(videoOutput).slice(0, 160));

  await mockControl({
    ytStatsQueue: [
      { viewCount: "1000", likeCount: "100", commentCount: "50" },
      { viewCount: "100", likeCount: "10", commentCount: "5" },
      { viewCount: "120", likeCount: "12", commentCount: "6" },
      { viewCount: "80", likeCount: "8", commentCount: "4" },
      { viewCount: "90", likeCount: "9", commentCount: "5" },
    ],
    igStatsQueue: [
      { views: 5000, reach: 1000, likes: 50, comments: 10, shares: 5, saved: 20, total_interactions: 85, ig_reels_avg_watch_time: 12300 },
      { views: 300, reach: 0, likes: 10, comments: 2, shares: 1, saved: 3, total_interactions: 16, ig_reels_avg_watch_time: 9000 },
    ],
  });

  const ytTitles = ["Alpha launch day", "Beta launch day", "Gamma tips daily", "Delta tips daily", "Epsilon tips daily"];
  for (const title of ytTitles) {
    await publishOne(alice, ytAccount.id, videoOutput.id, { ...CLIENT_YT_METADATA, title, privacy: "public" });
  }
  await publishOne(alice, igAccount.id, videoOutput.id, { ...CLIENT_IG_METADATA, caption: "First reel" });
  await publishOne(alice, igAccount.id, videoOutput.id, { ...CLIENT_IG_METADATA, caption: "Second reel" });
  await publishOne(alice, ttAccount.id, videoOutput.id, { ...CLIENT_TT_METADATA, caption: "TikTok debut", creatorConsent: true, privacyLevel: "PUBLIC_TO_EVERYONE" });
  check("B: 8 posts published through CLIPFORGE to the mock platforms (5 YT + 2 IG + 1 TT)", true);

  const postsRes = await alice.call("GET", "/api/analytics/posts");
  const allPosts = postsRes.data.posts;
  const ytPost = (title) => allPosts.find((p) => p.platform === "youtube" && p.title === title);
  const igPost = (title) => allPosts.find((p) => p.platform === "instagram" && p.title === title);
  const ttPost = allPosts.find((p) => p.platform === "tiktok");
  const alpha = ytPost("Alpha launch day");
  const beta = ytPost("Beta launch day");
  check("B: analytics posts list joins publishing records (8 posts, titles from post metadata)",
    allPosts.length === 8 && Boolean(alpha && beta && ttPost), `got ${allPosts.length}`);
  check("B: before any sync, post metrics are absent (no invented numbers at publish time)",
    alpha.metrics.views === undefined || alpha.metrics.views.availability !== "ok",
    JSON.stringify(alpha.metrics).slice(0, 200));

  // ---- YouTube sync (§22 #1–4 mechanics, #19) ----------------------------------
  const syncRes = await alice.call("POST", "/api/analytics/sync", {
    body: { accountId: ytAccount.id, from: RANGE.from, to: RANGE.to },
  });
  check("B: sync job created (201, not deduplicated)", syncRes.status === 201 && syncRes.data.deduplicated === false,
    JSON.stringify(syncRes.data).slice(0, 200));
  const ytSync = await waitForSyncJob(alice, syncRes.data.job.id);
  check("B: YouTube sync COMPLETED through the §18 state machine (attempt recorded SUCCEEDED)",
    ytSync.job.status === "COMPLETED" && ytSync.attempts.some((a) => a.status === "SUCCEEDED"),
    `${ytSync.job.status}: ${ytSync.job.error ?? ""}`);
  check("B: the mock Analytics API was actually called (reports.query counter > 0)",
    (await mockState()).counters.analyticsReports > 0);
  const snapCount = db.prepare("SELECT COUNT(*) AS n FROM analytics_post_snapshots WHERE account_id = ?").get(ytAccount.id);
  check("B (#19): historical snapshots persist — one post snapshot per published video for this sync",
    Number(snapCount.n) === 5, `got ${snapCount.n}`);
  const acctSnap = db.prepare("SELECT COUNT(*) AS n FROM analytics_account_snapshots WHERE account_id = ?").get(ytAccount.id);
  check("B (#19): an account snapshot with provenance (source + api version) persists",
    Number(acctSnap.n) === 1 &&
    Boolean(db.prepare("SELECT source, api_version FROM analytics_account_snapshots WHERE account_id = ?").get(ytAccount.id)?.api_version),
    JSON.stringify(acctSnap));

  const postsAfter = (await alice.call("GET", "/api/analytics/posts")).data.posts;
  const alphaAfter = postsAfter.find((p) => p.id === alpha.id);
  check("B (#1/#2 mechanics): Alpha's views come from the Data API lifetime counter (1000) with source recorded",
    alphaAfter.metrics.views?.value === 1000 && /data-api/.test(alphaAfter.metrics.views?.source ?? ""),
    JSON.stringify(alphaAfter.metrics.views));
  check("B: Alpha's watch time is present from the Analytics API (12 min → 720s, range activity)",
    alphaAfter.metrics.watch_time_seconds?.value === 720 && alphaAfter.metrics.watch_time_seconds?.kind === "range_activity",
    JSON.stringify(alphaAfter.metrics.watch_time_seconds));
  check("B (#12): shares carry the Data-API UNAVAILABLE row (null value, reason) AND the Analytics value — sources never mixed",
    alphaAfter.metrics.shares?.value === 7 && /analytics/.test(alphaAfter.metrics.shares?.source ?? ""));
  const alphaHistory = await alice.call("GET", `/api/analytics/posts/${alpha.id}/history`);
  const dataApiShares = alphaHistory.data.values.find((v) => v.metric_key === "shares" && /data-api/.test(v.source ?? ""));
  check("B (#12): stored Data-API shares row is availability=unavailable with metric_value NULL (never 0)",
    Boolean(dataApiShares) && dataApiShares.availability_status === "unavailable" && dataApiShares.metric_value === null,
    JSON.stringify(dataApiShares));
  // F10 (§8): a post summary carries a thumbnail reference only when
  // its publish job actually stored a thumbnail.
  {
    const alphaJob = db.prepare("SELECT job_id FROM platform_posts WHERE id = ?").get(alpha.id);
    fs.mkdirSync(path.join(tmpB, "media", `${aliceUser.id}/publishing-thumbnails`), { recursive: true });
    run("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=blue:s=64x36", "-frames:v", "1", path.join(tmpB, "media", `${aliceUser.id}/publishing-thumbnails/${alphaJob.job_id}.png`)]);
    db.prepare("UPDATE post_metadata SET thumbnail_storage_key = ? WHERE job_id = ?")
      .run(`${aliceUser.id}/publishing-thumbnails/${alphaJob.job_id}.png`, alphaJob.job_id);
    const postsThumb = (await alice.call("GET", "/api/analytics/posts")).data.posts;
    const alphaThumb = postsThumb.find((p) => p.id === alpha.id);
    const betaThumb = postsThumb.find((p) => p.id === beta.id);
    check("B (F10/§8): post summary carries an owner-checked thumbnail URL when the publish job stored one, null otherwise (never fabricated)",
      typeof alphaThumb.thumbnailUrl === "string" && alphaThumb.thumbnailUrl.includes("/thumbnail") && betaThumb.thumbnailUrl === null,
      `alpha=${JSON.stringify(alphaThumb.thumbnailUrl)} beta=${JSON.stringify(betaThumb.thumbnailUrl)}`);
    const thumbRes = await alice.raw("GET", alphaThumb.thumbnailUrl);
    const thumbBuf = Buffer.from(await thumbRes.arrayBuffer());
    check("B (F10/§8): the thumbnail URL serves the actual stored PNG to the owner",
      thumbRes.status === 200 && thumbBuf.length > 8 && thumbBuf[0] === 0x89 && thumbBuf[1] === 0x50,
      `status=${thumbRes.status} bytes=${thumbBuf.length}`);
    const thumbBob = await bob.raw("GET", alphaThumb.thumbnailUrl);
    check("B (F10/§8): another user cannot fetch the thumbnail (404, owner-checked)",
      thumbBob.status === 404, `status=${thumbBob.status}`);
  }
  check("B (#18): saves have no 'ok' record for a YouTube post (missing metric is not fabricated)",
    alphaAfter.metrics.saves === undefined || alphaAfter.metrics.saves.availability !== "ok",
    JSON.stringify(alphaAfter.metrics.saves));
  check("B (#16): engagement by views = (100 likes + 50 comments + 7 shares) / 1000 views = 15.7%, formula displayed",
    alphaAfter.engagementByViews.availability === "ok" &&
    Math.abs(alphaAfter.engagementByViews.value - 15.7) < 0.01 &&
    /Views/.test(alphaAfter.engagementByViews.formulaText),
    JSON.stringify(alphaAfter.engagementByViews));

  // ---- overview + trends ---------------------------------------------------------
  const ovYt = await alice.call("GET", `/api/analytics/overview?from=${RANGE.from}&to=${RANGE.to}&platform=youtube&formula=by_views`);
  const ovMetric = (res, key) => res.data.metrics.find((m) => m.metricKey === key);
  check("B (#4): overview YouTube views total = 1390 (sum of per-video range activity) with basis labelled",
    ovMetric(ovYt, "views")?.value === 1390 && ovMetric(ovYt, "views")?.basis === "range_activity",
    JSON.stringify(ovMetric(ovYt, "views")));
  check("B (#4): previous-period value is null when no data exists for it (incomplete periods are not faked)",
    ovMetric(ovYt, "views")?.previousValue === null && ovMetric(ovYt, "views")?.pctChange === null);
  check("B: overview followers = 5000 subscribers (gauge, latest snapshot wins)",
    ovMetric(ovYt, "followers")?.value === 5000 && ovMetric(ovYt, "followers")?.basis === "gauge",
    JSON.stringify(ovMetric(ovYt, "followers")));
  check("B (#12): overview saves stay unavailable for YouTube (not 0)",
    ovMetric(ovYt, "saves")?.value === null && ovMetric(ovYt, "saves")?.availability === "unavailable");
  check("B: overview engagement by views = (139 + 70 + 35) / 1390 ≈ 17.55%",
    ovYt.data.engagement?.availability === "ok" && Math.abs(ovYt.data.engagement.value - 17.55) < 0.01,
    JSON.stringify(ovYt.data.engagement));
  const trends = await alice.call("GET", `/api/analytics/trends?metric=views&platform=youtube&from=${RANGE.from}&to=${RANGE.to}&granularity=day`);
  check("B (#3): daily trend comes from Analytics daily reports — 30 points of 10 views, no invented days",
    trends.data.points.length === 30 && trends.data.points.every((p) => p.value === 10) &&
    trends.data.sources.some((s) => /reports\.query/.test(s)),
    JSON.stringify(trends.data.points.slice(0, 3)));

  // ---- duplicate sync prevention (#31) ---------------------------------------------
  const dup1 = await alice.call("POST", "/api/analytics/sync", { body: { accountId: ytAccount.id } });
  const dup2 = await alice.call("POST", "/api/analytics/sync", { body: { accountId: ytAccount.id } });
  check("B (#31): a second sync for the same account while one is active is deduplicated to the same job",
    dup1.data.job.id === dup2.data.job.id && dup2.data.deduplicated === true,
    `${dup1.data.job?.id} vs ${dup2.data.job?.id} dedup=${dup2.data.deduplicated}`);
  const dupDone = await waitForSyncJob(alice, dup1.data.job.id);
  check("B (#31): the deduplicated job completes normally", dupDone.job.status === "COMPLETED", dupDone.job.status);
  const trendsAfterDup = await alice.call("GET", `/api/analytics/trends?metric=views&platform=youtube&from=${RANGE.from}&to=${RANGE.to}&granularity=day`);
  check("B (#19): re-syncing does NOT double-count daily activity (newest collection replaces the same days)",
    trendsAfterDup.data.points.length === 30 && trendsAfterDup.data.points.every((p) => p.value === 10),
    JSON.stringify(trendsAfterDup.data.points.slice(0, 3)));

  // ---- cumulative counters + corrections (#20) ---------------------------------------
  await fetch(`${MOCK}/__set-yt-stats`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoId: alpha.platformPostId, stats: { viewCount: "900", likeCount: "100", commentCount: "50" } }),
  });
  const postSync1 = await alice.call("POST", "/api/analytics/sync", { body: { postId: alpha.id } });
  const postSync1Done = await waitForSyncJob(alice, postSync1.data.job.id);
  check("B (#20): single-post refresh sync completes", postSync1Done.job.status === "COMPLETED", postSync1Done.job.status);
  const histAfterCorrection = await alice.call("GET", `/api/analytics/posts/${alpha.id}/history`);
  const correctionRow = histAfterCorrection.data.values.find(
    (v) => v.metric_key === "views" && v.kind === "lifetime_counter" && v.metric_value === 900,
  );
  check("B (#20): a DECREASED cumulative counter is stored with correction_flag=1 (platform correction, not negative growth)",
    Boolean(correctionRow) && correctionRow.correction_flag === 1, JSON.stringify(correctionRow));
  await fetch(`${MOCK}/__set-yt-stats`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoId: alpha.platformPostId, stats: { viewCount: "1200", likeCount: "100", commentCount: "50" } }),
  });
  const postSync2 = await alice.call("POST", "/api/analytics/sync", { body: { postId: alpha.id } });
  await waitForSyncJob(alice, postSync2.data.job.id);
  const alphaTrend = await alice.call("GET", `/api/analytics/trends?metric=views&postId=${alpha.id}&from=${RANGE.from}&to=${RANGE.to}&granularity=day`);
  check("B (#20): post trend deltas are never negative — the +300 recovery appears, corrections contribute 0",
    alphaTrend.data.points.every((p) => p.value >= 0) &&
    alphaTrend.data.points.some((p) => p.value === 300),
    JSON.stringify(alphaTrend.data.points));

  // ---- Instagram: scope-gated insights (#5–8 mechanics) --------------------------------
  const igSync1 = await alice.call("POST", "/api/analytics/sync", { body: { accountId: igAccount.id } });
  const igSync1Done = await waitForSyncJob(alice, igSync1.data.job.id);
  check("B: Instagram sync completes even without the insights scope (followers gauge still syncs)",
    igSync1Done.job.status === "COMPLETED", `${igSync1Done.job.status}: ${igSync1Done.job.error ?? ""}`);
  const postsIg1 = (await alice.call("GET", "/api/analytics/posts")).data.posts;
  const ig1Before = postsIg1.find((p) => p.id === igPost("First reel").id);
  check("B (#8/#18): without the insights scope, Reel metrics are stored unavailable (null + reason), never zero",
    ig1Before.metrics.views?.availability === "unavailable" && ig1Before.metrics.views?.value === null &&
    /instagram_business_manage_insights/.test(ig1Before.metrics.views?.reason ?? ""),
    JSON.stringify(ig1Before.metrics.views));
  const ovIg1 = await alice.call("GET", `/api/analytics/overview?from=${RANGE.from}&to=${RANGE.to}&platform=instagram`);
  check("B (#6 mechanics): Instagram followers gauge syncs from the profile (1234) without the insights scope",
    ovMetric(ovIg1, "followers")?.value === 1234, JSON.stringify(ovMetric(ovIg1, "followers")));
  // F1 (§13): with no Instagram likes recorded anywhere (insights
  // scope absent), the platform group's like total must be null —
  // unavailable — with a contributing count of 0, never a bare 0.
  {
    const ca = await alice.call("GET", "/api/analytics/content-analysis?groupBy=platform");
    const igGroup = ca.data.groups.find((g) => g.label === "instagram");
    const ytGroup = ca.data.groups.find((g) => g.label === "youtube");
    check("B (F1/§13): a content group with no recorded likes returns a null total + contributing count 0 (unavailable ≠ 0)",
      igGroup.totalLikes === null && igGroup.likesCount === 0 && igGroup.totalViews === null,
      JSON.stringify(igGroup));
    check("B (F1/§13): a group with recorded likes returns the real sum and its contributing count (YouTube 139 across 5 videos)",
      ytGroup.totalLikes === 139 && ytGroup.likesCount === 5,
      JSON.stringify(ytGroup));
  }

  // Grant the insights scope the way a reconnect with the scope would.
  {
    const row = db.prepare("SELECT granted_scopes_json FROM platform_accounts WHERE id = ?").get(igAccount.id);
    const scopes = JSON.parse(row.granted_scopes_json);
    if (!scopes.includes("instagram_business_manage_insights")) scopes.push("instagram_business_manage_insights");
    db.prepare("UPDATE platform_accounts SET granted_scopes_json = ? WHERE id = ?").run(JSON.stringify(scopes), igAccount.id);
  }
  const igCaps2 = await alice.call("POST", "/api/analytics/capabilities/refresh", { body: { accountId: igAccount.id } });
  check("B (§6): after the scope grant, capability re-check marks Instagram views available",
    igCaps2.data.capability.metrics.find((m) => m.key === "views")?.status === "available");
  const igSync2 = await alice.call("POST", "/api/analytics/sync", { body: { accountId: igAccount.id } });
  const igSync2Done = await waitForSyncJob(alice, igSync2.data.job.id);
  check("B (#6/#7 mechanics): Instagram sync with insights scope completes and called the Insights API",
    igSync2Done.job.status === "COMPLETED" && (await mockState()).counters.igInsights > 0, igSync2Done.job.status);
  // F5: the default sync range is 90 days but Instagram's stored
  // capability record limits history to a 30-day window — the sync
  // must clamp the fetch and record the truncation on the job.
  {
    const igOutcome = (igSync2Done.job.progress?.accounts ?? []).find((a) => a.accountId === igAccount.id);
    check("B (F5): the Instagram sync clamped its fetch to the capability's supported range and recorded the clamp on the job's per-account outcome",
      Boolean(igOutcome) && (igOutcome.notes ?? []).some((n) => /supported range/i.test(n)),
      JSON.stringify(igOutcome));
  }
  const postsIg2 = (await alice.call("GET", "/api/analytics/posts")).data.posts;
  const ig1After = postsIg2.find((p) => p.id === igPost("First reel").id);
  const ig2After = postsIg2.find((p) => p.id === igPost("Second reel").id);
  check("B (#7 mechanics): Reel 1 metrics land — reach 1000, views 5000, saves 20, avg watch 12.3s (ms converted)",
    ig1After.metrics.reach?.value === 1000 && ig1After.metrics.views?.value === 5000 &&
    ig1After.metrics.saves?.value === 20 && Math.abs((ig1After.metrics.avg_watch_time_seconds?.value ?? 0) - 12.3) < 0.001,
    JSON.stringify(ig1After.metrics));
  check("B (#15): engagement by reach for Reel 1 = (50+10+5+20)/1000 = 8.5% with the reach formula shown",
    ig1After.engagementByReach.availability === "ok" &&
    Math.abs(ig1After.engagementByReach.value - 8.5) < 0.01 &&
    /Reach/.test(ig1After.engagementByReach.formulaText) &&
    ig1After.engagementByReach.componentsUsed.includes("saves"),
    JSON.stringify(ig1After.engagementByReach));
  check("B (#17): zero reach → engagement by reach is N/A with a zero-denominator explanation (never 0%, never infinity)",
    ig2After.metrics.reach?.value === 0 &&
    ig2After.engagementByReach.availability === "unavailable" &&
    /zero/i.test(ig2After.engagementByReach.reason ?? ""),
    JSON.stringify(ig2After.engagementByReach));

  // ---- TikTok: scope-gated Display API (#9–11 mechanics) ---------------------------------
  const ttSync1 = await alice.call("POST", "/api/analytics/sync", { body: { accountId: ttAccount.id } });
  const ttSync1Done = await waitForSyncJob(alice, ttSync1.data.job.id);
  const ttBefore = (await alice.call("GET", "/api/analytics/posts")).data.posts.find((p) => p.id === ttPost.id);
  check("B (#11): without video.list, TikTok post metrics are unavailable with the missing scope named",
    ttSync1Done.job.status === "COMPLETED" &&
    ttBefore.metrics.views?.availability === "unavailable" && /video\.list/.test(ttBefore.metrics.views?.reason ?? ""),
    JSON.stringify(ttBefore.metrics.views));
  {
    const row = db.prepare("SELECT granted_scopes_json FROM platform_accounts WHERE id = ?").get(ttAccount.id);
    const scopes = JSON.parse(row.granted_scopes_json);
    if (!scopes.includes("video.list")) scopes.push("video.list");
    db.prepare("UPDATE platform_accounts SET granted_scopes_json = ? WHERE id = ?").run(JSON.stringify(scopes), ttAccount.id);
  }
  const ttSync2 = await alice.call("POST", "/api/analytics/sync", { body: { accountId: ttAccount.id } });
  const ttSync2Done = await waitForSyncJob(alice, ttSync2.data.job.id);
  const ttAfter = (await alice.call("GET", "/api/analytics/posts")).data.posts.find((p) => p.id === ttPost.id);
  check("B (#10 mechanics): with video.list granted, TikTok counters land via video.query (views 777, likes 70, shares 17)",
    ttSync2Done.job.status === "COMPLETED" && (await mockState()).counters.ttVideoQueries > 0 &&
    ttAfter.metrics.views?.value === 777 && ttAfter.metrics.likes?.value === 70 && ttAfter.metrics.shares?.value === 17,
    JSON.stringify(ttAfter.metrics.views));

  // ---- platform comparison (#13) ---------------------------------------------------------
  const comparison = await alice.call("GET", `/api/analytics/platform-comparison?from=${RANGE.from}&to=${RANGE.to}&formula=by_views`);
  const compBy = Object.fromEntries(comparison.data.platforms.map((p) => [p.platform, p]));
  const compMetric = (entry, key) => entry.metrics.find((m) => m.metricKey === key);
  check("B (#13): platform comparison separates the three platforms with their own bases (YT 1390 range activity, IG 900 daily, TT 777 lifetime)",
    compMetric(compBy.youtube, "views")?.value === 1390 &&
    compMetric(compBy.instagram, "views")?.value === 900 &&
    compMetric(compBy.tiktok, "views")?.value === 777,
    JSON.stringify(comparison.data.platforms.map((p) => [p.platform, compMetric(p, "views")?.value, compMetric(p, "views")?.basis])));
  check("B (#13): comparison warns views ≠ reach and shows each platform's top post",
    comparison.data.warnings.some((w) => /reach/i.test(w)) &&
    compBy.youtube.topPost?.views === 1200 || compBy.youtube.topPost?.views === 1000,
    JSON.stringify(compBy.youtube.topPost));

  // ---- same-range post comparison (#14) ------------------------------------------------------
  const compare = await alice.call("POST", "/api/analytics/posts/compare", {
    body: { postIds: [alpha.id, beta.id], from: RANGE.from, to: RANGE.to },
  });
  const alphaRange = compare.data.posts.find((p) => p.id === alpha.id);
  const betaRange = compare.data.posts.find((p) => p.id === beta.id);
  check("B (#14): posts compared over the SAME date range use the range-activity figures (Alpha 1000, Beta 100)",
    compare.status === 200 && alphaRange.rangeMetrics?.views === 1000 && betaRange.rangeMetrics?.views === 100,
    JSON.stringify(compare.data.posts.map((p) => p.rangeMetrics)));

  // ---- insights (#21, #22) ----------------------------------------------------------------------
  const gen = await alice.call("POST", `/api/analytics/insights/generate?from=${RANGE.from}&to=${RANGE.to}`, { body: {} });
  check("B (#21): insight generation runs over stored data and creates insights", gen.status === 201 && gen.data.created >= 1,
    JSON.stringify(gen.data));
  const insightList = await alice.call("GET", "/api/analytics/insights");
  const medianInsight = insightList.data.insights.find((i) => i.ruleKey === "post_above_account_median");
  check("B (#21): a post-above-median insight exists for Alpha (1000 views vs account median 100)",
    Boolean(medianInsight) && /Alpha/.test(medianInsight.title), JSON.stringify(insightList.data.insights.map((i) => i.ruleKey)));
  const insightDetail = await alice.call("GET", `/api/analytics/insights/${medianInsight.id}`);
  check("B (#22): the insight carries its evidence — post views = Alpha's LATEST recorded value (1200 after the correction-recovery syncs), account median 100, sample size 5",
    insightDetail.data.evidence.some((e) => e.value === 1200) &&
    insightDetail.data.evidence.some((e) => e.value === 100) &&
    insightDetail.data.insight.sampleSize === 5 &&
    insightDetail.data.insight.limitations.length > 0,
    JSON.stringify(insightDetail.data.evidence));
  check("B (#14 rules): no insight claims virality or causation",
    !/will go viral|caused the|guarantee/i.test(medianInsight.body), medianInsight.body.slice(0, 120));
  check("B (F2): the period-change rule did NOT fire for a range ending today — its copy claims complete periods, so incomplete ranges are skipped honestly",
    !insightList.data.insights.some((i) => i.ruleKey === "period_metric_change"),
    JSON.stringify(insightList.data.insights.map((i) => i.ruleKey)));
  const dismissed = await alice.call("POST", `/api/analytics/insights/${medianInsight.id}/dismiss`, { body: {} });
  const insightList2 = await alice.call("GET", "/api/analytics/insights");
  check("B: dismissing an insight removes it from the active list",
    dismissed.status === 200 && !insightList2.data.insights.some((i) => i.id === medianInsight.id));

  // ---- posting times (#23) -------------------------------------------------------------------------
  const posting = await alice.call("GET", "/api/analytics/posting-times");
  check("B (#23): with 8 published posts (< 10 minimum) posting-time analysis reports INSUFFICIENT sample honestly",
    posting.data.sufficient === false && posting.data.totalPosts === 8 && /10/.test(posting.data.message),
    JSON.stringify({ total: posting.data.totalPosts, sufficient: posting.data.sufficient }));

  // ---- content analysis (§13) ----------------------------------------------------------------------------
  const content = await alice.call("GET", "/api/analytics/content-analysis?groupBy=platform");
  check("B (§13): content analysis groups published posts by platform with a causation disclaimer",
    content.data.groups.length === 3 && /not proof of causation/i.test(content.data.disclaimer) &&
    content.data.groups.find((g) => g.label === "youtube")?.postCount === 5,
    JSON.stringify(content.data.groups.map((g) => [g.label, g.postCount])));

  // ---- reports (#24–27) --------------------------------------------------------------------------------------
  const reportRes = await alice.call("POST", "/api/analytics/reports", {
    body: {
      name: "Phase 11 test report", from: RANGE.from, to: RANGE.to,
      config: { formats: ["csv", "xlsx", "pdf"], metrics: ["views", "likes", "comments", "shares", "saves"], includeTrends: true, includeTopContent: true, includeComparison: true },
    },
  });
  check("B (#24–26): report created and queued for background generation",
    reportRes.status === 201 && reportRes.data.report.status === "QUEUED", JSON.stringify(reportRes.data).slice(0, 200));
  const reportId = reportRes.data.report.id;
  let report = null;
  {
    const start = Date.now();
    for (;;) {
      const r = await alice.call("GET", `/api/analytics/reports/${reportId}`);
      report = r.data.report;
      if (report.status === "COMPLETED" || report.status === "FAILED") break;
      if (Date.now() - start > 60000) throw new Error(`report never finished (status ${report.status})`);
      await sleep(500);
    }
  }
  check("B (#24–26): report generation COMPLETED with all three exports ready",
    report.status === "COMPLETED" && report.exports.length === 3 && report.exports.every((e) => e.status === "COMPLETED"),
    JSON.stringify(report.exports));
  const downloadAs = async (client, exp) => {
    const res = await client.raw("GET", exp.downloadUrl);
    return res;
  };
  const csvExp = report.exports.find((e) => e.format === "csv");
  const xlsxExp = report.exports.find((e) => e.format === "xlsx");
  const pdfExp = report.exports.find((e) => e.format === "pdf");
  const csvRes = await downloadAs(alice, csvExp);
  const csvText = await csvRes.text();
  check("B (#24/#27): CSV downloads and contains 'Unavailable' for missing metrics + a definitions section",
    csvRes.status === 200 && csvText.includes("Unavailable") && /Metric definitions/.test(csvText),
    csvText.slice(0, 300));
  check("B (#24): CSV KPI views = the all-platform saved total 3067 (YT 1390 range activity + IG 900 daily + TT 777 lifetime)",
    /^Views,3067/m.test(csvText), csvText.slice(0, 400));
  const xlsxRes = await downloadAs(alice, xlsxExp);
  const xlsxBuf = Buffer.from(await xlsxRes.arrayBuffer());
  check("B (#25/#27): XLSX downloads as a real workbook (ZIP magic + size)",
    xlsxRes.status === 200 && xlsxBuf.length > 2000 && xlsxBuf[0] === 0x50 && xlsxBuf[1] === 0x4b,
    `status ${xlsxRes.status} size ${xlsxBuf.length}`);
  const pdfRes = await downloadAs(alice, pdfExp);
  const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
  check("B (#26/#27): PDF downloads as a real PDF (%PDF header + size)",
    pdfRes.status === 200 && pdfBuf.length > 1000 && pdfBuf.subarray(0, 4).toString("latin1") === "%PDF",
    `status ${pdfRes.status} size ${pdfBuf.length}`);
  const bobDownload = await bob.raw("GET", csvExp.downloadUrl);
  check("B (#27/#32): another user cannot download the report (404)",
    bobDownload.status === 404, `got ${bobDownload.status}`);
  const delNoConfirm = await alice.call("DELETE", `/api/analytics/reports/${reportId}`);
  check("B: report delete without confirmation → 409 CONFIRMATION_REQUIRED",
    delNoConfirm.status === 409 && delNoConfirm.data.error?.code === "CONFIRMATION_REQUIRED", `got ${delNoConfirm.status}`);

  // ---- rate-limit handling (#28) -------------------------------------------------------------------------------
  await mockControl({ rateLimitNextAnalytics: true });
  const rlSync = await alice.call("POST", "/api/analytics/sync", { body: { accountId: ytAccount.id } });
  const rlDone = await waitForSyncJob(alice, rlSync.data.job.id, 90000);
  const rlAttempts = rlDone.attempts;
  check("B (#28): a 429 from the Analytics API is retried with backoff and the sync eventually COMPLETES",
    rlDone.job.status === "COMPLETED" && rlAttempts.length >= 2 &&
    rlAttempts.some((a) => a.error_code === "RATE_LIMITED"),
    `${rlDone.job.status} attempts=${JSON.stringify(rlAttempts.map((a) => [a.status, a.error_code]))}`);

  // ---- Data API quota 403 (F3) -----------------------------------------------------------------------------
  await mockControl({ quotaNextYtDataApi: true });
  const quotaSync = await alice.call("POST", "/api/analytics/sync", { body: { accountId: ytAccount.id } });
  const quotaDone = await waitForSyncJob(alice, quotaSync.data.job.id, 90000);
  check("B (F3): a quota 403 from the YouTube Data API is classified RATE_LIMITED (transient), retried, and the sync COMPLETES",
    quotaDone.job.status === "COMPLETED" && quotaDone.attempts.length >= 2 &&
    quotaDone.attempts.some((a) => a.error_code === "RATE_LIMITED"),
    `${quotaDone.job.status} attempts=${JSON.stringify(quotaDone.attempts.map((a) => [a.status, a.error_code]))}`);
  const accountsAfterQuota = (await alice.call("GET", "/api/publishing/accounts")).data.accounts;
  check("B (F3): the account is NOT flagged AUTH_REQUIRED by a quota error (it stays CONNECTED)",
    accountsAfterQuota.find((a) => a.id === ytAccount.id)?.status === "CONNECTED",
    JSON.stringify(accountsAfterQuota.find((a) => a.id === ytAccount.id)?.status));

  // ---- token expiry → AUTH_REQUIRED (#29) ---------------------------------------------------------------------------
  await mockControl({ revokeYtRefresh: true });
  await fetch(`${MOCK}/__expire-yt-access`, { method: "POST" });
  const expSync = await alice.call("POST", "/api/analytics/sync", { body: { accountId: ytAccount.id } });
  const expDone = await waitForSyncJob(alice, expSync.data.job.id);
  check("B (#29): expired access + revoked refresh → sync job AUTH_REQUIRED (never a fake success)",
    expDone.job.status === "AUTH_REQUIRED", `${expDone.job.status}: ${expDone.job.error ?? ""}`);
  const accountsAfterExpiry = (await alice.call("GET", "/api/publishing/accounts")).data.accounts;
  check("B (#29): the account itself is flagged AUTH_REQUIRED",
    accountsAfterExpiry.find((a) => a.id === ytAccount.id)?.status === "AUTH_REQUIRED");
  const retryWhileAuth = await alice.call("POST", `/api/analytics/sync/jobs/${expSync.data.job.id}/retry`);
  check("B (#29): retrying while the account still needs reauthorization is refused with the reason",
    retryWhileAuth.status === 409 && retryWhileAuth.data.error?.code === "AUTH_REQUIRED", `got ${retryWhileAuth.status}`);
  await mockControl({ revokeYtRefresh: false });
  const refreshed = await alice.call("POST", `/api/publishing/accounts/${ytAccount.id}/refresh`);
  check("B (#29): reconnecting/refreshing the account restores CONNECTED",
    refreshed.status === 200 && refreshed.data.account?.status === "CONNECTED", JSON.stringify(refreshed.data).slice(0, 200));
  const retryAfter = await alice.call("POST", `/api/analytics/sync/jobs/${expSync.data.job.id}/retry`);
  const retryDone = await waitForSyncJob(alice, expSync.data.job.id);
  check("B (#29): after reauthorization the same job retries to COMPLETED",
    retryAfter.status === 200 && retryDone.job.status === "COMPLETED", retryDone.job.status);

  // ---- user isolation (#32) + no invented metrics (#33) ---------------------------------------------------------------
  const bobPosts = await bob.call("GET", "/api/analytics/posts");
  check("B (#32): the second user sees none of the first user's posts",
    bobPosts.status === 200 && bobPosts.data.posts.length === 0);
  const bobDetail = await bob.call("GET", `/api/analytics/posts/${alpha.id}`);
  check("B (#32): the second user gets 404 on the first user's post detail", bobDetail.status === 404);
  const bobSync = await bob.call("POST", "/api/analytics/sync", { body: { accountId: ytAccount.id } });
  check("B (#32): the second user cannot sync the first user's account (404)", bobSync.status === 404);
  const bobOv = await bob.call("GET", `/api/analytics/overview?from=${RANGE.from}&to=${RANGE.to}`);
  check("B (#33): the second user's overview is entirely unavailable (no cross-user leakage, no invented data)",
    bobOv.data.metrics.every((m) => m.value === null), JSON.stringify(bobOv.data.metrics).slice(0, 200));
  const badRows = db.prepare(
    "SELECT COUNT(*) AS n FROM analytics_metric_values WHERE (availability_status != 'ok' AND metric_value IS NOT NULL) OR (availability_status = 'ok' AND metric_value IS NULL)",
  ).get();
  check("B (#33): DB sweep — unavailable rows NEVER carry a value and ok rows ALWAYS do (unavailable ≠ zero, structurally)",
    Number(badRows.n) === 0, `violations: ${badRows.n}`);
  const bobRows = db.prepare("SELECT COUNT(*) AS n FROM analytics_metric_values WHERE user_id = ?").get(bobUser.id);
  check("B (#33): zero metric rows exist for the user who never synced", Number(bobRows.n) === 0);

  // ---- job recovery after restart (#30) + snapshot persistence (#19) -----------------------------------------------------
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO analytics_sync_jobs (id, user_id, account_id, platform, scope, platform_post_id, range_start, range_end,
     status, attempt_count, max_attempts, next_attempt_at, progress_json, error, error_code, error_class, source,
     worker_id, created_at, updated_at, started_at, finished_at)
     VALUES ('stuck-job-1', ?, ?, 'youtube', 'account', NULL, ?, ?, 'FETCHING_METRICS', 1, 3, NULL, NULL, NULL, NULL, NULL,
     'manual', 'dead-worker', ?, ?, ?, NULL)`,
  ).run(aliceUser.id, ytAccount.id, RANGE.from, RANGE.to, now, now, now);
  // F4 fixture: report rows written by an older build with the bare
  // 'GENERATING' status — boot recovery must converge them to the §18
  // name GENERATING_REPORT and finish the report.
  db.prepare(
    `INSERT INTO analytics_reports (id, user_id, name, config_json, status, range_start, range_end, created_at, updated_at, generated_at)
     VALUES ('legacy-report-1', ?, 'Legacy status report', ?, 'GENERATING', ?, ?, ?, ?, NULL)`,
  ).run(aliceUser.id, JSON.stringify({ formats: ["csv"], metrics: ["views"] }), RANGE.from, RANGE.to, now, now);
  db.prepare(
    `INSERT INTO analytics_report_exports (id, report_id, user_id, format, status, storage_key, file_size, error, created_at, updated_at)
     VALUES ('legacy-exp-1', 'legacy-report-1', ?, 'csv', 'GENERATING', NULL, NULL, NULL, ?, ?)`,
  ).run(aliceUser.id, now, now);
  killServer(server);
  server = null;
  await sleep(600);
  server = spawnServer(mockEnv(tmpB));
  await waitForHealth();
  const alice2 = new Client();
  await alice2.getCsrf();
  const login = await alice2.call("POST", "/api/auth/login", { body: { email: "alice-an@example.com", password: "Str0ngPassw0rd!" } });
  check("B: re-login after restart works (sessions/DB persisted)", login.status === 200, `got ${login.status}`);
  const recovered = await waitForSyncJob(alice2, "stuck-job-1");
  check("B (#30): a sync job interrupted mid-flight by the restart is recovered and COMPLETES (reads are safe to redo)",
    recovered.job.status === "COMPLETED", `${recovered.job.status}: ${recovered.job.error ?? ""}`);
  const postsFinal = (await alice2.call("GET", "/api/analytics/posts")).data.posts;
  const alphaFinal = postsFinal.find((p) => p.id === alpha.id);
  check("B (#19): snapshots survive the restart — Alpha still shows its latest recorded views (1200)",
    alphaFinal?.metrics.views?.value === 1200, JSON.stringify(alphaFinal?.metrics.views));

  // F4: the legacy-'GENERATING' report converges at boot and finishes.
  let legacyReport = null;
  {
    const start = Date.now();
    for (;;) {
      const r = await alice2.call("GET", "/api/analytics/reports/legacy-report-1");
      legacyReport = r.data?.report;
      if (legacyReport && (legacyReport.status === "COMPLETED" || legacyReport.status === "FAILED")) break;
      if (Date.now() - start > 60000) break;
      await sleep(500);
    }
  }
  const legacyStuck = db.prepare("SELECT COUNT(*) AS n FROM analytics_reports WHERE status = 'GENERATING'").get();
  const legacyStuckExp = db.prepare("SELECT COUNT(*) AS n FROM analytics_report_exports WHERE status = 'GENERATING'").get();
  check("B (F4): report rows written with the legacy 'GENERATING' status converge to §18's GENERATING_REPORT at boot and finish — no row keeps the old name",
    legacyReport?.status === "COMPLETED" && Number(legacyStuck.n) === 0 && Number(legacyStuckExp.n) === 0,
    `report=${legacyReport?.status} stuckReports=${legacyStuck.n} stuckExports=${legacyStuckExp.n}`);

  killServer(server);
  server = null;

  // =========================================================================
  console.log("\n== Server C: TikTok provider credentials removed ==");
  // =========================================================================
  server = spawnServer({ ...mockEnv(tmpB), TIKTOK_CLIENT_KEY: "", TIKTOK_CLIENT_SECRET: "", TIKTOK_REDIRECT_URI: "" });
  await waitForHealth();
  const alice3 = new Client();
  await alice3.getCsrf();
  const login3 = await alice3.call("POST", "/api/auth/login", { body: { email: "alice-an@example.com", password: "Str0ngPassw0rd!" } });
  check("C: re-login on the reconfigured server works", login3.status === 200, `got ${login3.status}`);
  const countersBeforeC = (await mockState()).counters;
  const ttSyncC = await alice3.call("POST", "/api/analytics/sync", { body: { accountId: ttAccount.id } });
  const ttSyncCDone = await waitForSyncJob(alice3, ttSyncC.data.job.id);
  const countersAfterC = (await mockState()).counters;
  check("C (F7): syncing an account whose provider credentials are absent ends FAILED with CONFIGURATION_ERROR (never a fake success)",
    ttSyncCDone.job.status === "FAILED" && ttSyncCDone.job.errorCode === "CONFIGURATION_ERROR",
    `${ttSyncCDone.job.status}: ${ttSyncCDone.job.errorCode} ${ttSyncCDone.job.error ?? ""}`);
  check("C (F7): the unconfigured sync made ZERO analytics calls to the mock TikTok API (video/query + user/info counters unchanged)",
    countersAfterC.ttVideoQueries === countersBeforeC.ttVideoQueries &&
      countersAfterC.ttUserInfo === countersBeforeC.ttUserInfo,
    `before=${JSON.stringify({ q: countersBeforeC.ttVideoQueries, u: countersBeforeC.ttUserInfo })} after=${JSON.stringify({ q: countersAfterC.ttVideoQueries, u: countersAfterC.ttUserInfo })}`);
  killServer(server);
  server = null;
} catch (err) {
  failed += 1;
  failures.push(`UNCAUGHT: ${err.message}`);
  console.error("UNCAUGHT", err);
  if (server) {
    console.error("---- server log tail ----");
    console.error((server.log ?? "").slice(-3000));
  }
} finally {
  if (server) killServer(server);
  mockServer.close();
}

console.log(`\nPhase 11 analytics e2e: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log("Failures:");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed > 0 ? 1 : 0);
