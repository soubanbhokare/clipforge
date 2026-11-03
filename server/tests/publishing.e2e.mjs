// Phase 10 Publishing / Scheduling / Platform Integrations e2e.
//
// ============================================================================
// HONESTY NOTE — READ FIRST.
// This suite runs CLIPFORGE's REAL Phase 10 code (OAuth flows, token
// encryption, provider adapters, validation, scheduling engine,
// ambiguity handling) against a LOCAL MOCK PROVIDER implemented in
// this file (mock OAuth authorize/token endpoints + mock YouTube /
// Instagram / TikTok APIs on localhost). The mock exists because no
// real platform credentials exist in this environment. These are
// therefore MOCK-PROVIDER tests of CLIPFORGE's own mechanics — they
// are NOT tests against real YouTube/Instagram/TikTok accounts, and
// nothing here verifies the spec §22 items that require real
// developer applications, audited clients or real accounts
// (§22 #1–18, #20–21 against real platforms). Those remain blocked
// on credentials only the user can supply.
// ============================================================================
//
// What IS genuinely asserted:
//  - Unconfigured providers → honest 422 CONFIGURATION_ERROR with the
//    missing env NAMES (separate unconfigured server instance).
//  - Mock OAuth happy path: authorize URL carries state + PKCE S256,
//    the mock token endpoint VERIFIES the PKCE verifier, tampered
//    state is rejected, OAuth denial creates no account, the account
//    appears with the mock-returned identity, the DB token payload
//    is AES-GCM ciphertext (no token string anywhere in it or in any
//    API response).
//  - Draft → per-platform metadata → validation failures with exact
//    reasons (YouTube title limit, TikTok creator-info duration and
//    privacy options incl. unaudited SELF_ONLY, TikTok consent,
//    audio-only format) block submission; approval gate (409 without
//    approval, 400 without rights confirmation).
//  - Publish-now for all three mock providers → PUBLISHED only after
//    the mock's status says so, with the mock's post id/URL stored.
//  - YouTube native scheduling (publishAt, private) is labelled
//    "Scheduled on YouTube" and does NOT read PUBLISHED before the
//    time; CLIPFORGE scheduling submits at the due time.
//  - Calendar: local time + timezone stored as exact UTC.
//  - Restart: scheduled jobs persist and fire after a server restart.
//  - Duplicate prevention: double submit 409, Idempotency-Key dedupe,
//    one platform upload per job.
//  - Ambiguity: mock accepts the upload but destroys the response →
//    the engine reconciles by status/session query and does NOT
//    re-upload (YouTube + TikTok).
//  - Rate limit (429) → transient retry with backoff succeeds.
//  - Expired/revoked authorization → AUTH_REQUIRED; forced refresh
//    restores the account; retry publishes.
//  - Cross-user isolation (404s). Webhooks: Meta challenge + HMAC
//    verification + idempotent storage; TikTok signature.
//  - Analytics: YouTube metrics sync from the mock statistics part;
//    Instagram metrics stay "unavailable" with NULL (never zero).
//  - Disconnect: confirmation contract, tokens deleted, history kept.
//  - Checker fixes: post-approval thumbnail edits void the approval;
//    a 403 user_intervention from the publish call itself flags job
//    AND account AUTH_REQUIRED; a code-less OAuth callback consumes
//    its connection as FAILED at once; disconnect revocation follows
//    the configured revoke URL (mock-intercepted).
//
// Run: npm run test:publish

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const PORT = 3251;
const MOCK_PORT = 3252;
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
      body: { displayName: "Publish Tester", email, password: pw, confirmPassword: pw, termsAccepted: true },
    });
    if (res.status !== 201) throw new Error(`register failed: ${JSON.stringify(res.data)}`);
    return res.data.user;
  }
}

// ---------------------------------------------------------------------------
// MOCK PROVIDER — mock OAuth + mock platform APIs (see honesty note)
// ---------------------------------------------------------------------------
function freshMockState() {
  return {
    counters: {
      ytSessions: 0, ytUploads: 0, ytThumbnails: 0, ytTokenExchanges: 0, ytRefreshes: 0, ytRevokes: 0,
      igContainers: 0, igPublishes: 0, igTokenExchanges: 0,
      ttInits: 0, ttUploads: 0, ttTokenExchanges: 0,
    },
    flags: {
      denyNextAuth: false,
      dropNextYtUploadResponse: false,
      dropNextTtUploadResponse: false,
      rateLimitNextYtInit: false,
      forbidNextYtUploadInit: false,
      revokeYtRefresh: false,
      igAccountType: "BUSINESS",
      ttPrivacyOptions: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"],
      ttMaxDuration: 600,
    },
    pkceByState: new Map(), // state -> code_challenge
    ytAccess: new Map(), // token -> { exp, refresh }
    ytRefresh: new Map(), // refresh -> { revoked }
    ytSessions: new Map(),
    ytVideos: new Map(),
    igAccess: new Set(),
    igContainers: new Map(),
    igMedia: new Map(),
    ttAccess: new Map(),
    ttPublishes: new Map(),
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

    // ---- YouTube OAuth ---------------------------------------------------
    if (p === "/oauth/authorize" && req.method === "GET") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      if (url.searchParams.get("code_challenge")) M.pkceByState.set(state, url.searchParams.get("code_challenge"));
      if (M.flags.denyNextAuth) {
        M.flags.denyNextAuth = false;
        res.writeHead(302, { Location: `${redirectUri}?error=access_denied&state=${state}` });
        return res.end();
      }
      res.writeHead(302, { Location: `${redirectUri}?code=mock-yt-code&state=${state}` });
      return res.end();
    }
    if (p === "/oauth/token" && req.method === "POST") {
      const form = new URLSearchParams((await readBody(req)).toString("utf8"));
      const grant = form.get("grant_type");
      if (grant === "authorization_code") {
        // Verify PKCE exactly like Google does.
        const verifier = form.get("code_verifier");
        const states = [...M.pkceByState.entries()];
        const expected = states.length ? states[states.length - 1][1] : null;
        if (!verifier || !expected || crypto.createHash("sha256").update(verifier).digest("base64url") !== expected) {
          return mockJson(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed." });
        }
        M.counters.ytTokenExchanges += 1;
        const t = issueYtTokens();
        return mockJson(res, 200, {
          access_token: t.access, refresh_token: t.refresh, expires_in: 3600,
          scope: "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly",
          token_type: "Bearer",
        });
      }
      if (grant === "refresh_token") {
        M.counters.ytRefreshes += 1;
        const rec = M.ytRefresh.get(form.get("refresh_token"));
        if (!rec || rec.revoked || M.flags.revokeYtRefresh) {
          return mockJson(res, 400, { error: "invalid_grant", error_description: "Token has been revoked." });
        }
        const n = ++M.seq;
        const access = `yt-access-${n}`;
        M.ytAccess.set(access, { exp: Date.now() + 3600_000, refresh: form.get("refresh_token") });
        return mockJson(res, 200, { access_token: access, expires_in: 3600, scope: "https://www.googleapis.com/auth/youtube.upload", token_type: "Bearer" });
      }
      return mockJson(res, 400, { error: "unsupported_grant_type" });
    }

    // ---- YouTube Data API --------------------------------------------------
    if (p === "/youtube/v3/channels") {
      if (!ytAuth(req, res)) return;
      return mockJson(res, 200, {
        items: [{
          id: "yt-channel-1",
          snippet: { title: "Mock Channel", customUrl: "@mockchannel", thumbnails: { default: { url: "http://mock/avatar.png" } } },
        }],
      });
    }
    if (p === "/youtube/v3/videoCategories") {
      if (!ytAuth(req, res)) return;
      return mockJson(res, 200, {
        items: [
          { id: "22", snippet: { title: "People & Blogs", assignable: true } },
          { id: "24", snippet: { title: "Entertainment", assignable: true } },
          { id: "28", snippet: { title: "Science & Technology", assignable: true } },
        ],
      });
    }
    if (p === "/youtube/v3/videos" && req.method === "GET") {
      if (!ytAuth(req, res)) return;
      const id = url.searchParams.get("id");
      const part = url.searchParams.get("part") ?? "";
      const video = M.ytVideos.get(id);
      if (!video) return mockJson(res, 200, { items: [] });
      if (part.includes("statistics")) {
        return mockJson(res, 200, { items: [{ id, statistics: { viewCount: "123", likeCount: "45", commentCount: "6" } }] });
      }
      const status = { uploadStatus: "processed", privacyStatus: video.meta?.status?.privacyStatus ?? "private" };
      if (video.meta?.status?.publishAt) status.publishAt = video.meta.status.publishAt;
      return mockJson(res, 200, { items: [{ id, status }] });
    }
    if (p === "/oauth/revoke" && req.method === "POST") {
      await readBody(req);
      M.counters.ytRevokes += 1;
      return mockJson(res, 200, {});
    }
    if (p === "/upload/youtube/v3/videos" && req.method === "POST") {
      if (!ytAuth(req, res)) return;
      if (M.flags.rateLimitNextYtInit) {
        M.flags.rateLimitNextYtInit = false;
        return mockJson(res, 429, { error: { code: 429, message: "Quota exceeded for quota metric." } });
      }
      if (M.flags.forbidNextYtUploadInit) {
        // A valid token whose upload scope was revoked: Google
        // answers 403, which CLIPFORGE classifies user_intervention.
        M.flags.forbidNextYtUploadInit = false;
        return mockJson(res, 403, { error: { code: 403, message: "The caller does not have permission to upload." } });
      }
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
        // Resumable status query.
        if (sess.complete) {
          return mockJson(res, 200, { id: sess.videoId, status: { uploadStatus: "uploaded" } });
        }
        res.writeHead(308, { Range: `bytes=0-${Math.max(0, sess.received - 1)}` });
        return res.end();
      }
      const body = await readBody(req);
      sess.received += body.length;
      if (sess.received >= sess.total) {
        sess.complete = true;
        sess.videoId = `ytvid-${++M.seq}`;
        M.ytVideos.set(sess.videoId, { meta: sess.meta });
        M.counters.ytUploads += 1;
        if (M.flags.dropNextYtUploadResponse) {
          M.flags.dropNextYtUploadResponse = false;
          req.socket.destroy(); // the upload LANDED; the response is lost
          return;
        }
      }
      return mockJson(res, 200, { id: sess.videoId, status: { uploadStatus: "uploaded" } });
    }
    if (p === "/upload/youtube/v3/thumbnails/set" && req.method === "POST") {
      if (!ytAuth(req, res)) return;
      await readBody(req);
      M.counters.ytThumbnails += 1;
      return mockJson(res, 200, { items: [{ videoId: url.searchParams.get("videoId"), default: { url: "http://mock/thumb.jpg" } }] });
    }

    // ---- Instagram OAuth + Graph -------------------------------------------
    if (p === "/ig/authorize" && req.method === "GET") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      if (M.flags.denyNextAuth) {
        M.flags.denyNextAuth = false;
        res.writeHead(302, { Location: `${redirectUri}?error=access_denied&error_reason=user_denied&state=${state}` });
        return res.end();
      }
      res.writeHead(302, { Location: `${redirectUri}?code=mock-ig-code&state=${state}` });
      return res.end();
    }
    if (p === "/ig/oauth/access_token" && req.method === "POST") {
      await readBody(req);
      M.counters.igTokenExchanges += 1;
      M.igAccess.add("ig-short-1");
      return mockJson(res, 200, { access_token: "ig-short-1", user_id: "ig-user-1", permissions: "instagram_business_basic,instagram_business_content_publish" });
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
        name: "Mock Creator", profile_picture_url: "http://mock/ig-avatar.png",
      });
    }
    if (/^\/graph\/ig-user-1\/media$/.test(p) && req.method === "POST") {
      if (!M.igAccess.has(bearer(req))) return mockJson(res, 401, { error: { message: "Invalid OAuth access token.", code: 190 } });
      const id = `ig-container-${++M.seq}`;
      M.igContainers.set(id, { uploaded: false, published: false });
      M.counters.igContainers += 1;
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
      M.counters.igPublishes += 1;
      return mockJson(res, 200, { id: mediaId });
    }

    // ---- TikTok --------------------------------------------------------------
    if (p === "/v2/auth/authorize" && req.method === "GET") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      if (M.flags.denyNextAuth) {
        M.flags.denyNextAuth = false;
        res.writeHead(302, { Location: `${redirectUri}?error=access_denied&state=${state}` });
        return res.end();
      }
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
      M.counters.ttTokenExchanges += 1;
      M.ttAccess.set("tt-access-1", { exp: Date.now() + 86400_000 });
      return mockJson(res, 200, {
        data: { access_token: "tt-access-1", refresh_token: "tt-refresh-1", open_id: "tt-open-1", scope: "user.info.basic,video.publish", expires_in: 86400, refresh_expires_in: 31536000 },
        error: { code: "ok", message: "", log_id: "mock" },
      });
    }
    if (p === "/v2/user/info/" && req.method === "GET") {
      const rec = M.ttAccess.get(bearer(req));
      if (!rec || rec.exp <= Date.now()) return mockJson(res, 401, { error: { code: "access_token_invalid", message: "Access token is invalid." } });
      return mockJson(res, 200, { data: { user: { open_id: "tt-open-1", union_id: "tt-union-1", avatar_url: "http://mock/tt-avatar.png", display_name: "Mock Creator", username: "mockcreator" } }, error: { code: "ok" } });
    }
    if (p === "/v2/post/publish/creator_info/query/" && req.method === "POST") {
      await readBody(req);
      return mockJson(res, 200, {
        data: {
          creator_username: "mockcreator", creator_nickname: "Mock Creator", creator_avatar_url: "http://mock/tt-avatar.png",
          privacy_level_options: M.flags.ttPrivacyOptions,
          comment_disabled: false, duet_disabled: false, stitch_disabled: false,
          max_video_post_duration_sec: M.flags.ttMaxDuration,
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
      M.counters.ttInits += 1;
      return mockJson(res, 200, { data: { publish_id: id, upload_url: `${MOCK}/tt-upload/${id}` }, error: { code: "ok" } });
    }
    if (p.startsWith("/tt-upload/") && req.method === "PUT") {
      const id = p.split("/")[2];
      await readBody(req);
      const rec = M.ttPublishes.get(id);
      if (rec) rec.uploaded = true;
      M.counters.ttUploads += 1;
      if (M.flags.dropNextTtUploadResponse) {
        M.flags.dropNextTtUploadResponse = false;
        req.socket.destroy(); // upload LANDED; response lost
        return;
      }
      res.writeHead(201);
      return res.end();
    }
    if (p === "/v2/post/publish/status/fetch/" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const rec = M.ttPublishes.get(body.publish_id);
      if (!rec) return mockJson(res, 200, { data: { status: "FAILED", fail_reason: "file_not_found" }, error: { code: "ok" } });
      if (rec.uploaded) {
        return mockJson(res, 200, {
          data: { status: "PUBLISH_COMPLETE", publicaly_available_post_id: [`tt-post-${body.publish_id.split("-")[2]}`] },
          error: { code: "ok" },
        });
      }
      return mockJson(res, 200, { data: { status: "PROCESSING_UPLOAD" }, error: { code: "ok" } });
    }

    return mockJson(res, 404, { error: { message: `mock: no route for ${req.method} ${p}` } });
  } catch (err) {
    return mockJson(res, 500, { error: { message: `mock error: ${err.message}` } });
  }
}

// ---------------------------------------------------------------------------
// CLIPFORGE server management + workflow helpers
// ---------------------------------------------------------------------------
const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-pub-a-"));
const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-pub-b-"));

function baseEnv(tmp) {
  return {
    ...process.env,
    PORT: String(PORT),
    NODE_ENV: "test",
    DATABASE_FILE: path.join(tmp, "test.db"),
    MEDIA_DIR: path.join(tmp, "media"),
    PROCESSING_DIR: path.join(tmp, "processing"),
    TOKEN_ENCRYPTION_KEY: TOKEN_KEY_B64,
    PUBLISH_TICK_MS: "200",
    PUBLISH_STATUS_POLL_MS: "300",
    // No provider credentials anywhere near server A:
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

/** Drive one full OAuth round trip the way a browser would:
 *  connect → mock authorize (302) → CLIPFORGE callback (302) → app. */
async function followOAuth(client, platform) {
  const conn = await client.call("POST", `/api/publishing/accounts/${platform}/connect`);
  if (conn.status !== 200) throw new Error(`connect ${platform} failed: ${conn.status} ${JSON.stringify(conn.data)}`);
  const authUrl = conn.data.authUrl;
  const authRes = await fetch(authUrl, { redirect: "manual" });
  const callbackUrl = authRes.headers.get("location");
  if (!callbackUrl) throw new Error(`mock authorize for ${platform} did not redirect`);
  const cbRes = await fetch(callbackUrl, { redirect: "manual" });
  return { authUrl, callbackUrl, cbStatus: cbRes.status, cbLocation: cbRes.headers.get("location") ?? "" };
}

async function waitForJob(client, jobId, wanted, timeoutMs = 45000) {
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

// The FRONTEND CLIENT'S payload shapes, copied from
// src/services/publishing.ts (Phase 8 wire-shape lesson: if the
// client's shape drifts from the server schema, these calls fail).
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
async function createDraft(client, accountId, exportOutputId, metadata, idemKey) {
  const headers = idemKey ? { "Idempotency-Key": idemKey } : {};
  return client.call("POST", "/api/publishing/jobs", {
    body: { exportOutputId, accountId, metadata },
    headers,
  });
}
async function validateApproveSubmit(client, jobId, { schedule } = {}) {
  const v = await client.call("POST", `/api/publishing/jobs/${jobId}/validate`);
  if (!v.data?.ok) throw new Error(`validate failed for ${jobId}: ${JSON.stringify(v.data?.checks?.filter((c) => !c.ok))}`);
  const a = await client.call("POST", `/api/publishing/jobs/${jobId}/approve`, { body: { rightsConfirmed: true } });
  if (a.status !== 200) throw new Error(`approve failed for ${jobId}: ${JSON.stringify(a.data)}`);
  if (schedule) {
    const s = await client.call("POST", `/api/publishing/jobs/${jobId}/schedule`, { body: schedule });
    if (s.status !== 200) throw new Error(`schedule failed for ${jobId}: ${JSON.stringify(s.data)}`);
    return s.data.job;
  }
  const s = await client.call("POST", `/api/publishing/jobs/${jobId}/submit`);
  if (s.status !== 200) throw new Error(`submit failed for ${jobId}: ${JSON.stringify(s.data)}`);
  return s.data.job;
}

// --- Phase 9 export helpers (to obtain REAL completed exports) --------------
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
console.log(`Phase 10 publishing e2e — mock provider on ${MOCK_PORT}`);

let server = null;
try {
  // =========================================================================
  console.log("\n== Server A: NO provider credentials (honest unconfigured) ==");
  // =========================================================================
  server = spawnServer(baseEnv(tmpA));
  await waitForHealth();
  const anon = new Client();
  const aliceA = new Client();
  await aliceA.register("alice-pub-a@example.com");

  const provA = await aliceA.call("GET", "/api/publishing/providers");
  check("A: providers list reports all three implemented but NOT configured",
    provA.status === 200 && provA.data.providers.length === 3 &&
    provA.data.providers.every((p) => p.implemented === true && p.configured === false),
    JSON.stringify(provA.data).slice(0, 300));
  check("A: missing env NAMES are reported per provider (never values)",
    provA.data.providers.find((p) => p.platform === "youtube")?.missing.includes("GOOGLE_OAUTH_CLIENT_ID") &&
    provA.data.providers.find((p) => p.platform === "instagram")?.missing.includes("META_APP_ID") &&
    provA.data.providers.find((p) => p.platform === "tiktok")?.missing.includes("TIKTOK_CLIENT_KEY"));
  for (const [platform, name] of [["youtube", "GOOGLE_OAUTH_CLIENT_ID"], ["instagram", "META_APP_ID"], ["tiktok", "TIKTOK_CLIENT_KEY"]]) {
    const res = await aliceA.call("POST", `/api/publishing/accounts/${platform}/connect`);
    check(`A: connect ${platform} without credentials → 422 CONFIGURATION_ERROR naming ${name}`,
      res.status === 422 && res.data.error?.code === "CONFIGURATION_ERROR" && res.data.error.message.includes(name),
      `${res.status} ${JSON.stringify(res.data).slice(0, 200)}`);
  }
  const accA = await aliceA.call("GET", "/api/publishing/accounts");
  check("A: no accounts exist (nothing faked)", accA.status === 200 && accA.data.accounts.length === 0);
  const setA = await aliceA.call("GET", "/api/publishing/settings");
  check("A: settings shows token encryption ready (env key) + per-provider missing names",
    setA.data.tokenEncryption?.ready === true && setA.data.providers.every((p) => p.configured === false && p.missing.length === 3));
  const draftA = await aliceA.call("POST", "/api/publishing/jobs", { body: { exportOutputId: "nope", accountId: "nope", metadata: {} } });
  check("A: draft create against a nonexistent account → 404", draftA.status === 404, `got ${draftA.status}`);
  const whA = await fetch(`${BASE}/api/publishing/webhooks/meta`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ object: "instagram", entry: [] }),
  });
  check("A: Meta webhook without app secret → 503 CONFIGURATION_ERROR (no CSRF demanded — signature is the auth)",
    whA.status === 503, `got ${whA.status}`);
  const anonProv = await anon.call("GET", "/api/publishing/providers");
  check("A: publishing APIs require auth (401)", anonProv.status === 401, `got ${anonProv.status}`);
  killServer(server);
  server = null;
  await sleep(500);

  // =========================================================================
  console.log("\n== Server B: mock provider configured ==");
  // =========================================================================
  server = spawnServer(mockEnv(tmpB));
  await waitForHealth();
  const alice = new Client();
  const bob = new Client();
  const aliceUser = await alice.register("alice-pub@example.com");
  await bob.register("bob-pub@example.com");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(tmpB, "test.db"));

  const provB = await alice.call("GET", "/api/publishing/providers");
  check("B: providers report configured with mock credentials",
    provB.data.providers.every((p) => p.configured === true && p.missing.length === 0));

  // ---- OAuth: tampered state, denial, then happy paths ----------------------
  {
    const conn = await alice.call("POST", "/api/publishing/accounts/youtube/connect");
    check("B: connect returns an authorize URL on the provider's official host shape",
      conn.status === 200 && conn.data.authUrl.startsWith(`${MOCK}/oauth/authorize?`), JSON.stringify(conn.data).slice(0, 200));
    const u = new URL(conn.data.authUrl);
    check("B: authorize URL carries state + PKCE S256 + minimal scopes",
      Boolean(u.searchParams.get("state")) &&
      u.searchParams.get("code_challenge_method") === "S256" &&
      Boolean(u.searchParams.get("code_challenge")) &&
      (u.searchParams.get("scope") ?? "").includes("youtube.upload"));
    const authRes = await fetch(conn.data.authUrl, { redirect: "manual" });
    const cb = new URL(authRes.headers.get("location"));
    cb.searchParams.set("state", "tampered-state-value");
    const cbRes = await fetch(cb.toString(), { redirect: "manual" });
    check("B: tampered OAuth state is rejected with an honest error redirect (no account)",
      cbRes.status === 302 && (cbRes.headers.get("location") ?? "").includes("pub_error"),
      cbRes.headers.get("location") ?? "");
    const acc = await alice.call("GET", "/api/publishing/accounts");
    check("B: tampered state created NO account", acc.data.accounts.length === 0);
  }
  {
    await mockControl({ denyNextAuth: true });
    const r = await followOAuth(alice, "instagram");
    check("B: OAuth denial (access_denied) → error redirect, no fake success",
      r.cbStatus === 302 && r.cbLocation.includes("pub_error") && r.cbLocation.includes("access_denied"),
      r.cbLocation);
    const acc = await alice.call("GET", "/api/publishing/accounts");
    check("B: denial created NO account", acc.data.accounts.length === 0);
  }

  const ytFlow = await followOAuth(alice, "youtube");
  check("B: YouTube OAuth happy path redirects to the app with pub_connected",
    ytFlow.cbStatus === 302 && ytFlow.cbLocation.includes("pub_connected=youtube"), ytFlow.cbLocation);
  const igFlow = await followOAuth(alice, "instagram");
  check("B: Instagram OAuth happy path (mock)", igFlow.cbLocation.includes("pub_connected=instagram"), igFlow.cbLocation);
  const ttFlow = await followOAuth(alice, "tiktok");
  check("B: TikTok OAuth happy path (mock)", ttFlow.cbLocation.includes("pub_connected=tiktok"), ttFlow.cbLocation);

  const accounts = (await alice.call("GET", "/api/publishing/accounts")).data.accounts;
  const ytAccount = accounts.find((a) => a.platform === "youtube");
  const igAccount = accounts.find((a) => a.platform === "instagram");
  const ttAccount = accounts.find((a) => a.platform === "tiktok");
  check("B: accounts appear with the mock-returned identities (real API data, not samples)",
    ytAccount?.username === "@mockchannel" && ytAccount?.status === "CONNECTED" &&
    igAccount?.username === "mock.creator" && ttAccount?.username === "mockcreator",
    JSON.stringify(accounts).slice(0, 400));
  check("B: granted scopes recorded from the token response",
    ytAccount.grantedScopes.some((s) => s.includes("youtube.upload")) &&
    ttAccount.grantedScopes.includes("video.publish"));
  const accountsJson = JSON.stringify(accounts);
  check("B: NO token material in the accounts API response",
    !/yt-access|yt-refresh|ig-long|ig-short|tt-access|tt-refresh/.test(accountsJson));
  const tokenRow = db.prepare("SELECT encrypted_payload FROM oauth_token_records WHERE account_id = ?").get(ytAccount.id);
  check("B: stored token payload is ciphertext (AES-GCM envelope, no plaintext token)",
    Boolean(tokenRow) &&
    !tokenRow.encrypted_payload.includes("yt-access") && !tokenRow.encrypted_payload.includes("yt-refresh") &&
    (() => { const e = JSON.parse(tokenRow.encrypted_payload); return Boolean(e.iv && e.tag && e.ct); })(),
    tokenRow?.encrypted_payload?.slice(0, 80));
  const caps = await alice.call("GET", `/api/publishing/accounts/${ytAccount.id}/capabilities?fresh=1`);
  check("B: YouTube capabilities fetched live (categories from the API)",
    caps.status === 200 && caps.data.capabilities?.categories?.some((c) => c.id === "22"),
    JSON.stringify(caps.data).slice(0, 200));
  const ttCaps = await alice.call("GET", `/api/publishing/accounts/${ttAccount.id}/capabilities?fresh=1`);
  check("B: TikTok capabilities ARE creator info (privacy options from the platform)",
    Array.isArray(ttCaps.data.capabilities?.privacyLevelOptions) &&
    ttCaps.data.capabilities.privacyLevelOptions.includes("SELF_ONLY") &&
    ttCaps.data.capabilities.maxVideoPostDurationSec === 600);

  // ---- a real completed export to publish -----------------------------------
  const fixtureDir = path.join(tmpB, "fixtures");
  fs.mkdirSync(fixtureDir, { recursive: true });
  const sourceFile = path.join(fixtureDir, "source.mp4");
  run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=3",
    "-f", "lavfi", "-i", "sine=frequency=440:d=3", "-map", "0:v", "-map", "1:a",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", sourceFile]);
  const proj = await alice.call("POST", "/api/projects", { body: { name: "Publishing Main", workflowType: "LONG_VIDEO_TO_SHORTS" } });
  const projectId = proj.data.project.id;
  await uploadSource(alice, projectId, sourceFile, "source.mp4");
  const docRes = await alice.call("GET", `/api/projects/${projectId}/editor`);
  check("B: editor doc seeded for export", docRes.status === 200 || docRes.status === 201, `got ${docRes.status}`);
  const videoOutput = await makeExport(alice, projectId, CLIENT_EXPORT_SETTINGS);
  check("B: video export COMPLETED with real file metadata",
    videoOutput.status === "COMPLETED" && videoOutput.format === "mp4" && videoOutput.width > 0 && videoOutput.duration > 2,
    JSON.stringify(videoOutput).slice(0, 200));
  const audioOutput = await makeExport(alice, projectId, {
    ...CLIENT_EXPORT_SETTINGS, audioOnly: true, audioCodec: "libmp3lame", captionMode: "none",
  });
  check("B: audio-only export COMPLETED (for the format validation test)",
    audioOutput.status === "COMPLETED" && !audioOutput.width, JSON.stringify(audioOutput).slice(0, 200));

  // ---- clip_id derivation (migration v10): a draft sourced from a
  // CANDIDATE-targeted export inherits clip_id server-side from the
  // export's persisted target; a document-targeted one leaves it NULL.
  const pubSourceAsset = db.prepare("SELECT id FROM source_assets WHERE project_id = ? ORDER BY created_at LIMIT 1").get(projectId);
  const pubNow = new Date().toISOString();
  db.prepare("INSERT INTO processing_tasks (id, user_id, project_id, source_asset_id, status, stage, created_at, updated_at) VALUES ('pub-task-clip', ?, ?, ?, 'COMPLETED', 'COMPLETED', ?, ?)").run(aliceUser.id, projectId, pubSourceAsset.id, pubNow, pubNow);
  db.prepare("INSERT INTO candidate_clips (id, task_id, project_id, source_asset_id, user_id, start_sec, end_sec, duration, score, reasons_json, suggested_title, title, transcript_excerpt, status, preview_status, created_at) VALUES ('pub-candidate-1', 'pub-task-clip', ?, ?, ?, 0, 2, 2, 85, '[]', 'Publish Clip', 'Publish Clip', '', 'SELECTED', 'READY', ?)").run(projectId, pubSourceAsset.id, aliceUser.id, pubNow);
  const candExportRes = await alice.call("POST", `/api/projects/${projectId}/exports`, {
    body: { targets: [{ kind: "candidate", id: "pub-candidate-1" }], settings: CLIENT_EXPORT_SETTINGS },
  });
  check("B: candidate-targeted export created (201)", candExportRes.status === 201, JSON.stringify(candExportRes.data).slice(0, 200));
  const candRenderJobId = candExportRes.data.jobs[0].id;
  {
    const start = Date.now();
    for (;;) {
      const jr = await alice.call("GET", `/api/export-jobs/${candRenderJobId}`);
      const job = jr.data?.job;
      if (job?.status === "COMPLETED") break;
      if (job?.status === "FAILED" || job?.status === "CANCELLED") throw new Error(`candidate export failed: ${job.error}`);
      if (Date.now() - start > 180000) throw new Error("candidate export timed out");
      await sleep(800);
    }
  }
  const candHistory = await alice.call("GET", "/api/exports/history");
  const candOutput = candHistory.data.outputs.find((o) => o.jobId === candRenderJobId);
  check("B: candidate export's history row persists its target",
    candOutput?.targetKind === "candidate" && candOutput?.targetId === "pub-candidate-1",
    JSON.stringify(candOutput).slice(0, 220));
  const candDraft = await createDraft(alice, ytAccount.id, candOutput.id, { ...CLIENT_YT_METADATA, title: "From a candidate" });
  check("B: draft from a candidate-targeted export carries clip_id (server-derived)",
    candDraft.status === 201 && candDraft.data.job.clipId === "pub-candidate-1",
    JSON.stringify(candDraft.data).slice(0, 260));
  const docDraft = await createDraft(alice, ytAccount.id, videoOutput.id, { ...CLIENT_YT_METADATA, title: "From the document" });
  check("B: draft from a document-targeted export leaves clip_id NULL",
    docDraft.status === 201 && (docDraft.data.job.clipId === null || docDraft.data.job.clipId === undefined),
    JSON.stringify(docDraft.data.job).slice(0, 260));

  // ---- draft → validation failures → approval gate → publish ----------------
  const draftRes = await createDraft(alice, ytAccount.id, videoOutput.id,
    { ...CLIENT_YT_METADATA, title: "My first mock publish", description: "Posted from CLIPFORGE", tags: ["test"], privacy: "public" },
    "idem-key-1");
  check("B: draft created from the client's exact wire shape (201)",
    draftRes.status === 201 && draftRes.data.job.status === "DRAFT", JSON.stringify(draftRes.data).slice(0, 200));
  const ytJobId = draftRes.data.job.id;
  const dupRes = await createDraft(alice, ytAccount.id, videoOutput.id, { ...CLIENT_YT_METADATA }, "idem-key-1");
  check("B: Idempotency-Key dedupe returns the same draft",
    dupRes.status === 200 && dupRes.data.job.id === ytJobId && dupRes.data.deduplicated === true);

  const earlySubmit = await alice.call("POST", `/api/publishing/jobs/${ytJobId}/submit`);
  check("B: submit before approval → 409 APPROVAL_REQUIRED (no auto-publish, ever)",
    earlySubmit.status === 409 && earlySubmit.data.error?.code === "APPROVAL_REQUIRED", `got ${earlySubmit.status}`);
  const valRes = await alice.call("POST", `/api/publishing/jobs/${ytJobId}/validate`);
  check("B: validation passes for a well-formed YouTube post and moves the job to AWAITING_APPROVAL",
    valRes.status === 200 && valRes.data.ok === true && valRes.data.job.status === "AWAITING_APPROVAL",
    JSON.stringify(valRes.data.checks?.filter((c) => !c.ok)));
  const noRights = await alice.call("POST", `/api/publishing/jobs/${ytJobId}/approve`, { body: { rightsConfirmed: false } });
  check("B: approval without the rights confirmation → 400 RIGHTS_NOT_CONFIRMED",
    noRights.status === 400 && noRights.data.error?.code === "RIGHTS_NOT_CONFIRMED", `got ${noRights.status}`);
  const countersBefore = (await mockState()).counters;
  const approved = await alice.call("POST", `/api/publishing/jobs/${ytJobId}/approve`, { body: { rightsConfirmed: true } });
  check("B: approval recorded with rights confirmation", approved.status === 200 && Boolean(approved.data.job.approvedAt) && Boolean(approved.data.job.rightsConfirmedAt));
  const submitRes = await alice.call("POST", `/api/publishing/jobs/${ytJobId}/submit`);
  check("B: submit queues the approved job", submitRes.status === 200 && submitRes.data.job.status === "QUEUED");
  const doubleSubmit = await alice.call("POST", `/api/publishing/jobs/${ytJobId}/submit`);
  check("B: double submit → 409 (cannot submit twice)", doubleSubmit.status === 409, `got ${doubleSubmit.status}`);
  const published = await waitForJob(alice, ytJobId, ["PUBLISHED", "FAILED", "AUTH_REQUIRED"]);
  check("B: YouTube job PUBLISHED only after the platform confirmed",
    published.status === "PUBLISHED", `${published.status}: ${published.error ?? ""}`);
  check("B: platform post id + genuine-shaped URL stored from the mock response",
    /^ytvid-/.test(published.platformPostId ?? "") && published.publishedUrl === `https://www.youtube.com/watch?v=${published.platformPostId}`,
    `${published.platformPostId} ${published.publishedUrl}`);
  const countersAfter = (await mockState()).counters;
  check("B: exactly ONE upload session + ONE upload reached the mock platform",
    countersAfter.ytSessions - countersBefore.ytSessions === 1 && countersAfter.ytUploads - countersBefore.ytUploads === 1,
    JSON.stringify({ before: countersBefore, after: countersAfter }));
  const attempts = await alice.call("GET", `/api/publishing/jobs/${ytJobId}/attempts`);
  check("B: attempt history records SUBMIT + STATUS_CHECK with provider ids",
    attempts.data.attempts.some((a) => a.kind === "SUBMIT" && a.status === "SUCCEEDED" && a.providerRequestId) &&
    attempts.data.attempts.some((a) => a.kind === "STATUS_CHECK"),
    JSON.stringify(attempts.data).slice(0, 300));
  // Metrics sync runs at publish (YouTube statistics part).
  let metrics = null;
  for (let i = 0; i < 20; i += 1) {
    metrics = (await alice.call("GET", `/api/publishing/jobs/${ytJobId}/metrics`)).data;
    if (metrics.metricsStatus === "ok") break;
    await sleep(400);
  }
  check("B: YouTube metrics synced from the platform statistics (real values, mock source)",
    metrics?.metricsStatus === "ok" && metrics.metrics?.views === 123 && metrics.metrics?.likes === 45,
    JSON.stringify(metrics));
  const hist = await alice.call("GET", "/api/publishing/history");
  check("B: publishing history contains the published job with its platform post",
    hist.data.jobs.some((j) => j.id === ytJobId && j.status === "PUBLISHED" && j.platformPost?.postId === published.platformPostId));

  // ---- validation failures with exact reasons --------------------------------
  {
    const d = await createDraft(alice, ytAccount.id, videoOutput.id, { ...CLIENT_YT_METADATA, title: "x".repeat(101) });
    const v = await alice.call("POST", `/api/publishing/jobs/${d.data.job.id}/validate`);
    const c = v.data.checks.find((x) => x.id === "metadata_limits");
    check("V: YouTube title of 101 chars fails validation with the exact limit in the reason",
      v.data.ok === false && c && c.ok === false && /100/.test(c.detail), JSON.stringify(c));
    check("V: a failed validation leaves the job in DRAFT (never queued)",
      v.data.job.status === "DRAFT", v.data.job.status);
  }
  {
    const d = await createDraft(alice, ytAccount.id, audioOutput.id, { ...CLIENT_YT_METADATA, title: "Audio only" });
    const v = await alice.call("POST", `/api/publishing/jobs/${d.data.job.id}/validate`);
    const c = v.data.checks.find((x) => x.id === "format_supported");
    check("V: audio-only export fails the format check with the reason stated",
      v.data.ok === false && c?.ok === false && /audio-only/i.test(c.detail), JSON.stringify(c));
  }
  {
    // TikTok: creator-info duration ceiling (mock set to 1s; our clip is ~3s)
    await mockControl({ ttMaxDuration: 1 });
    const d = await createDraft(alice, ttAccount.id, videoOutput.id,
      { ...CLIENT_TT_METADATA, caption: "hello", privacyLevel: "SELF_ONLY", creatorConsent: true });
    const v = await alice.call("POST", `/api/publishing/jobs/${d.data.job.id}/validate`);
    const c = v.data.checks.find((x) => x.id === "duration_limit");
    check("V: TikTok duration beyond the creator-info ceiling fails with that ceiling named",
      v.data.ok === false && c?.ok === false && /1s limit/.test(c.detail), JSON.stringify(c));
    await mockControl({ ttMaxDuration: 600 });
    // Unaudited client: only SELF_ONLY is offered
    await mockControl({ ttPrivacyOptions: ["SELF_ONLY"] });
    const d2 = await createDraft(alice, ttAccount.id, videoOutput.id,
      { ...CLIENT_TT_METADATA, caption: "hello", privacyLevel: "PUBLIC_TO_EVERYONE", creatorConsent: true });
    const v2 = await alice.call("POST", `/api/publishing/jobs/${d2.data.job.id}/validate`);
    const c2 = v2.data.checks.find((x) => x.id === "privacy_available");
    check("V: unaudited TikTok client — PUBLIC_TO_EVERYONE rejected, SELF_ONLY restriction surfaced (never bypassed)",
      v2.data.ok === false && c2?.ok === false && /SELF_ONLY/.test(c2.detail) && /unaudited/i.test(c2.detail), JSON.stringify(c2));
    const d3 = await createDraft(alice, ttAccount.id, videoOutput.id,
      { ...CLIENT_TT_METADATA, caption: "hello", privacyLevel: "SELF_ONLY", creatorConsent: false });
    const v3 = await alice.call("POST", `/api/publishing/jobs/${d3.data.job.id}/validate`);
    const c3 = v3.data.checks.find((x) => x.id === "creator_consent");
    check("V: TikTok creator consent is a hard validation gate",
      v3.data.ok === false && c3?.ok === false, JSON.stringify(c3));
    await mockControl({ ttPrivacyOptions: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"] });
  }

  // ---- Instagram publish-now + personal-account rejection ---------------------
  const igJob = await createDraft(alice, igAccount.id, videoOutput.id,
    { ...CLIENT_IG_METADATA, caption: "Reel from CLIPFORGE", hashtags: ["#clipforge", "#test"] });
  const igPublished = await validateApproveSubmit(alice, igJob.data.job.id).then(() =>
    waitForJob(alice, igJob.data.job.id, ["PUBLISHED", "FAILED", "AUTH_REQUIRED"]));
  check("IG: publish-now completes via container → publish → permalink (mock)",
    igPublished.status === "PUBLISHED" && /^ig-media-/.test(igPublished.platformPostId ?? "") &&
    (igPublished.publishedUrl ?? "").includes("instagram.com/reel/"),
    `${igPublished.status} ${igPublished.error ?? ""} ${igPublished.publishedUrl}`);
  const igMetrics = await alice.call("GET", `/api/publishing/jobs/${igJob.data.job.id}/metrics`);
  check("IG: metrics are UNAVAILABLE with null values (never a fabricated zero)",
    igMetrics.data.metricsStatus === "unavailable" && igMetrics.data.metrics === null, JSON.stringify(igMetrics.data));
  {
    await mockControl({ igAccountType: "PERSONAL" });
    await followOAuth(alice, "instagram"); // reconnect — account now reports PERSONAL
    const d = await createDraft(alice, igAccount.id, videoOutput.id, { ...CLIENT_IG_METADATA, caption: "should not publish" });
    const v = await alice.call("POST", `/api/publishing/jobs/${d.data.job.id}/validate`);
    const c = v.data.checks.find((x) => x.id === "account_eligible");
    check("IG: a PERSONAL account is honestly rejected as not publish-eligible (Business/Creator only)",
      v.data.ok === false && c?.ok === false && /Business and Creator/.test(c.detail), JSON.stringify(c));
    await mockControl({ igAccountType: "BUSINESS" });
    await followOAuth(alice, "instagram");
  }

  // ---- TikTok publish-now ------------------------------------------------------
  const ttJob = await createDraft(alice, ttAccount.id, videoOutput.id,
    { ...CLIENT_TT_METADATA, caption: "TikTok from CLIPFORGE", privacyLevel: "PUBLIC_TO_EVERYONE", creatorConsent: true });
  const ttPublished = await validateApproveSubmit(alice, ttJob.data.job.id).then(() =>
    waitForJob(alice, ttJob.data.job.id, ["PUBLISHED", "FAILED", "AUTH_REQUIRED"]));
  check("TT: publish-now completes via creator-info → init → upload → status (mock)",
    ttPublished.status === "PUBLISHED" && /^tt-post-/.test(ttPublished.platformPostId ?? "") &&
    (ttPublished.publishedUrl ?? "").includes("tiktok.com/@mockcreator/video/"),
    `${ttPublished.status} ${ttPublished.error ?? ""}`);

  // ---- YouTube custom thumbnail ---------------------------------------------
  {
    const d = await createDraft(alice, ytAccount.id, videoOutput.id,
      { ...CLIENT_YT_METADATA, title: "With thumbnail", privacy: "public" });
    const jobId = d.data.job.id;
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
    const form = new FormData();
    form.append("file", new Blob([png], { type: "image/png" }), "thumb.png");
    const up = await alice.raw("POST", `/api/publishing/jobs/${jobId}/thumbnail`, { formData: form });
    const upData = await up.json();
    check("YT: custom thumbnail upload attaches to the draft",
      up.status === 200 && upData.job.hasCustomThumbnail === true, `${up.status} ${JSON.stringify(upData).slice(0, 200)}`);
    const before = (await mockState()).counters.ytThumbnails;
    await validateApproveSubmit(alice, jobId);
    const done = await waitForJob(alice, jobId, ["PUBLISHED", "FAILED"]);
    const after = (await mockState()).counters.ytThumbnails;
    check("YT: thumbnail is uploaded to the platform after the video (thumbnails.set called once)",
      done.status === "PUBLISHED" && after - before === 1, `${done.status}, delta=${after - before}`);
  }

  // ---- Scheduling: YouTube native vs CLIPFORGE --------------------------------
  {
    const d = await createDraft(alice, ytAccount.id, videoOutput.id,
      { ...CLIENT_YT_METADATA, title: "Native scheduled", privacy: "private" });
    const jobId = d.data.job.id;
    const v = await alice.call("POST", `/api/publishing/jobs/${jobId}/validate`);
    if (!v.data.ok) throw new Error(`native-schedule validate failed: ${JSON.stringify(v.data.checks.filter((c) => !c.ok))}`);
    await alice.call("POST", `/api/publishing/jobs/${jobId}/approve`, { body: { rightsConfirmed: true } });
    const dueUtc = new Date(Date.now() + 9000).toISOString();
    const s = await alice.call("POST", `/api/publishing/jobs/${jobId}/schedule`, { body: { scheduledForUtc: dueUtc, timezone: "Asia/Kolkata" } });
    check("S: YouTube + private → scheduling mode is the PLATFORM's (publishAt), honestly labelled",
      s.status === 200 && s.data.job.schedulingMode === "platform" && s.data.job.schedulingLabel === "Scheduled on YouTube",
      JSON.stringify(s.data.job).slice(0, 300));
    await sleep(3000);
    const mid = (await alice.call("GET", `/api/publishing/jobs/${jobId}`)).data.job;
    check("S: a natively scheduled video is NOT 'published' before its time (upload done, platform holds it)",
      mid.status !== "PUBLISHED" && (mid.status === "SUBMITTED" || mid.status === "PLATFORM_PROCESSING"),
      mid.status);
    const done = await waitForJob(alice, jobId, ["PUBLISHED", "FAILED"], 30000);
    check("S: after publishAt passes, the platform status flips the job to PUBLISHED",
      done.status === "PUBLISHED", `${done.status} ${done.error ?? ""}`);
  }
  {
    // CLIPFORGE scheduling with an exact timezone conversion assertion.
    const d = await createDraft(alice, ytAccount.id, videoOutput.id,
      { ...CLIENT_YT_METADATA, title: "TZ test", privacy: "public" });
    const jobId = d.data.job.id;
    await alice.call("POST", `/api/publishing/jobs/${jobId}/validate`);
    await alice.call("POST", `/api/publishing/jobs/${jobId}/approve`, { body: { rightsConfirmed: true } });
    const s = await alice.call("POST", `/api/publishing/jobs/${jobId}/schedule`, {
      body: { scheduledForLocal: "2026-12-01T10:00", timezone: "Asia/Kolkata" },
    });
    check("S: local time + Asia/Kolkata is stored as exact UTC (10:00 IST = 04:30 UTC)",
      s.data.job.schedule?.scheduledForUtc === "2026-12-01T04:30:00.000Z" && s.data.job.schedulingMode === "clipforge",
      JSON.stringify(s.data.job.schedule));
    const cs = await alice.call("POST", `/api/publishing/jobs/${jobId}/cancel-schedule`);
    check("S: cancel-schedule returns the approved job to AWAITING_APPROVAL",
      cs.status === 200 && cs.data.job.status === "AWAITING_APPROVAL" && cs.data.job.schedule === null);
    const cx = await alice.call("POST", `/api/publishing/jobs/${jobId}/cancel`);
    check("S: cancel terminates the job", cx.status === 200 && cx.data.job.status === "CANCELLED");
  }
  {
    // CLIPFORGE-scheduled Instagram post fires at its time; calendar shows it.
    const d = await createDraft(alice, igAccount.id, videoOutput.id,
      { ...CLIENT_IG_METADATA, caption: "Scheduled reel" });
    const jobId = d.data.job.id;
    const before = (await mockState()).counters.igPublishes;
    // Asia/Kolkata is a fixed UTC+05:30 (no DST) — compute the local
    // wall-clock string for "4 seconds from now" directly.
    const dueLocal = new Date(Date.now() + 4000 + 5.5 * 3600_000);
    const p2 = (n) => String(n).padStart(2, "0");
    const localClean = `${dueLocal.getUTCFullYear()}-${p2(dueLocal.getUTCMonth() + 1)}-${p2(dueLocal.getUTCDate())}T${p2(dueLocal.getUTCHours())}:${p2(dueLocal.getUTCMinutes())}:${p2(dueLocal.getUTCSeconds())}`;
    const job = await validateApproveSubmit(alice, jobId, {
      schedule: { scheduledForLocal: localClean, timezone: "Asia/Kolkata" },
    });
    check("S: Instagram scheduling is CLIPFORGE-side and labelled as such",
      job.schedulingMode === "clipforge" && job.schedulingLabel === "Scheduled in CLIPFORGE", JSON.stringify(job).slice(0, 200));
    const midCount = (await mockState()).counters.igPublishes;
    check("S: nothing is submitted before the scheduled time", midCount === before, `${midCount} vs ${before}`);
    const done = await waitForJob(alice, jobId, ["PUBLISHED", "FAILED"], 30000);
    check("S: the CLIPFORGE scheduler submits at the due time with no browser involved",
      done.status === "PUBLISHED", `${done.status} ${done.error ?? ""}`);
    const storedUtc = done.schedule?.scheduledForUtc;
    const cal = await alice.call("GET", `/api/publishing/calendar?from=${encodeURIComponent(new Date(Date.now() - 3600_000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 3600_000).toISOString())}`);
    const ev = cal.data.events.find((e) => e.jobId === jobId);
    check("S: calendar returns the record at its stored UTC time",
      Boolean(ev) && ev.atUtc === storedUtc && ev.kind === "published", JSON.stringify(ev));
  }
  {
    // Cancel a scheduled TikTok post before its time — it must never submit.
    const d = await createDraft(alice, ttAccount.id, videoOutput.id,
      { ...CLIENT_TT_METADATA, caption: "never goes out", privacyLevel: "SELF_ONLY", creatorConsent: true });
    const jobId = d.data.job.id;
    await validateApproveSubmit(alice, jobId, {
      schedule: { scheduledForUtc: new Date(Date.now() + 60000).toISOString(), timezone: "Asia/Kolkata" },
    });
    const before = (await mockState()).counters.ttInits;
    const cx = await alice.call("POST", `/api/publishing/jobs/${jobId}/cancel`);
    check("S: a scheduled job can be cancelled before submission", cx.status === 200 && cx.data.job.status === "CANCELLED");
    await sleep(1500);
    const after = (await mockState()).counters.ttInits;
    check("S: the cancelled job never reaches the platform", after === before, `${after} vs ${before}`);
  }

  // ---- Ambiguity: response lost AFTER the platform accepted -------------------
  {
    await mockControl({ dropNextYtUploadResponse: true });
    const d = await createDraft(alice, ytAccount.id, videoOutput.id,
      { ...CLIENT_YT_METADATA, title: "Ambiguous upload", privacy: "public" });
    const jobId = d.data.job.id;
    const before = (await mockState()).counters;
    await validateApproveSubmit(alice, jobId);
    const done = await waitForJob(alice, jobId, ["PUBLISHED", "FAILED"], 60000);
    const after = (await mockState()).counters;
    check("AM: YouTube upload whose response was lost still ends PUBLISHED via session recovery",
      done.status === "PUBLISHED", `${done.status} ${done.error ?? ""}`);
    check("AM: recovery did NOT re-upload (one session, one completed upload)",
      after.ytSessions - before.ytSessions === 1 && after.ytUploads - before.ytUploads === 1,
      JSON.stringify({ before, after }));
  }
  {
    await mockControl({ dropNextTtUploadResponse: true });
    const d = await createDraft(alice, ttAccount.id, videoOutput.id,
      { ...CLIENT_TT_METADATA, caption: "Ambiguous TikTok", privacyLevel: "SELF_ONLY", creatorConsent: true });
    const jobId = d.data.job.id;
    const before = (await mockState()).counters;
    await validateApproveSubmit(alice, jobId);
    const done = await waitForJob(alice, jobId, ["PUBLISHED", "FAILED"], 60000);
    const after = (await mockState()).counters;
    check("AM: TikTok upload whose response was lost ends PUBLISHED via status-by-publish-id",
      done.status === "PUBLISHED", `${done.status} ${done.error ?? ""}`);
    check("AM: TikTok recovery did NOT re-init a second publish",
      after.ttInits - before.ttInits === 1, `delta=${after.ttInits - before.ttInits}`);
  }

  // ---- Rate limit → transient backoff retry -----------------------------------
  {
    await mockControl({ rateLimitNextYtInit: true });
    const d = await createDraft(alice, ytAccount.id, videoOutput.id,
      { ...CLIENT_YT_METADATA, title: "Rate limited once", privacy: "public" });
    const jobId = d.data.job.id;
    await validateApproveSubmit(alice, jobId);
    const done = await waitForJob(alice, jobId, ["PUBLISHED", "FAILED"], 90000);
    check("RL: a 429 from the platform is retried with backoff and eventually publishes",
      done.status === "PUBLISHED" && done.retryCount >= 1, `${done.status} retries=${done.retryCount} ${done.error ?? ""}`);
  }

  // ---- Expired/revoked auth → AUTH_REQUIRED → refresh → retry -------------------
  {
    const d = await createDraft(alice, ytAccount.id, videoOutput.id,
      { ...CLIENT_YT_METADATA, title: "Auth expiry", privacy: "public" });
    const jobId = d.data.job.id;
    await validateApproveSubmit(alice, jobId);
    // The provider now considers every access token expired AND the
    // refresh grant revoked.
    await fetch(`${MOCK}/__expire-yt-access`, { method: "POST" });
    await mockControl({ revokeYtRefresh: true });
    const failedJob = await waitForJob(alice, jobId, ["AUTH_REQUIRED", "FAILED", "PUBLISHED"], 60000);
    check("AUTH: a dead authorization lands the job in AUTH_REQUIRED (not a fake success)",
      failedJob.status === "AUTH_REQUIRED", `${failedJob.status} ${failedJob.error ?? ""}`);
    const accNow = (await alice.call("GET", "/api/publishing/accounts")).data.accounts.find((a) => a.id === ytAccount.id);
    check("AUTH: the account itself is flagged AUTH_REQUIRED", accNow?.status === "AUTH_REQUIRED", accNow?.status);
    const earlyRetry = await alice.call("POST", `/api/publishing/jobs/${jobId}/retry`);
    check("AUTH: retry is refused while the account is still unauthorized",
      earlyRetry.status === 409, `got ${earlyRetry.status}`);
    await mockControl({ revokeYtRefresh: false });
    const refresh = await alice.call("POST", `/api/publishing/accounts/${ytAccount.id}/refresh`);
    check("AUTH: account Refresh performs a real token refresh and restores CONNECTED",
      refresh.status === 200 && refresh.data.account.status === "CONNECTED", `${refresh.status} ${JSON.stringify(refresh.data).slice(0, 200)}`);
    const retry = await alice.call("POST", `/api/publishing/jobs/${jobId}/retry`);
    check("AUTH: retry after reconnection re-queues the job", retry.status === 200 && retry.data.job.status === "QUEUED");
    const done = await waitForJob(alice, jobId, ["PUBLISHED", "FAILED"], 60000);
    check("AUTH: the retried job publishes", done.status === "PUBLISHED", `${done.status} ${done.error ?? ""}`);
  }

  // ---- Cross-user isolation ------------------------------------------------------
  {
    const g = await bob.call("GET", `/api/publishing/jobs/${ytJobId}`);
    check("X: another user cannot read the job (404)", g.status === 404, `got ${g.status}`);
    const c1 = await bob.call("POST", "/api/publishing/jobs", {
      body: { exportOutputId: videoOutput.id, accountId: bob.id ? ytAccount.id : ytAccount.id, metadata: { ...CLIENT_YT_METADATA } },
    });
    check("X: another user cannot draft against Alice's account (404)", c1.status === 404, `got ${c1.status}`);
    const bobAcc = await bob.call("GET", "/api/publishing/accounts");
    check("X: Bob sees only his own (zero) accounts", bobAcc.data.accounts.length === 0);
    const bobDraft = await bob.call("POST", "/api/publishing/jobs", {
      body: { exportOutputId: videoOutput.id, accountId: "nonexistent", metadata: {} },
    });
    check("X: Bob cannot reference Alice's export through a foreign account (404)", bobDraft.status === 404, `got ${bobDraft.status}`);
    const del = await bob.call("DELETE", `/api/publishing/accounts/${ytAccount.id}?confirm=true`);
    check("X: Bob cannot disconnect Alice's account (404)", del.status === 404, `got ${del.status}`);
    const att = await bob.call("GET", `/api/publishing/jobs/${ytJobId}/attempts`);
    check("X: Bob cannot read Alice's attempt history (404)", att.status === 404, `got ${att.status}`);
  }

  // ---- Metadata reuse (§13) ------------------------------------------------------
  {
    const src = (await alice.call("GET", `/api/publishing/jobs/${ytJobId}`)).data.job;
    const d = await createDraft(alice, ytAccount.id, videoOutput.id, src.metadata);
    check("H: metadata from a published job can seed a new draft unchanged",
      d.status === 201 && d.data.job.metadata.title === src.metadata.title &&
      d.data.job.metadata.privacy === src.metadata.privacy,
      JSON.stringify(d.data.job?.metadata).slice(0, 200));
  }

  // ---- Webhooks ---------------------------------------------------------------------
  {
    const verify = await fetch(`${BASE}/api/publishing/webhooks/meta?hub.mode=subscribe&hub.verify_token=mock-verify-token&hub.challenge=challenge-123`);
    check("W: Meta webhook verification challenge is answered",
      verify.status === 200 && (await verify.text()) === "challenge-123", `got ${verify.status}`);
    const payload = JSON.stringify({ object: "instagram", entry: [{ id: "ig-user-1", time: 123, changes: [{ field: "comments", value: { id: "c1" } }] }] });
    const sig = `sha256=${crypto.createHmac("sha256", "mock-meta-secret").update(payload).digest("hex")}`;
    const post = () => fetch(`${BASE}/api/publishing/webhooks/meta`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-hub-signature-256": sig }, body: payload,
    });
    const r1 = await post();
    const r2 = await post();
    const rows = db.prepare("SELECT COUNT(*) AS n FROM platform_webhook_events WHERE provider = 'instagram'").get();
    check("W: signed Meta webhook is accepted and stored idempotently (duplicate delivery = one row)",
      r1.status === 200 && r2.status === 200 && rows.n === 1, `${r1.status}/${r2.status} rows=${rows.n}`);
    const bad = await fetch(`${BASE}/api/publishing/webhooks/meta`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-hub-signature-256": "sha256=deadbeef" }, body: payload,
    });
    check("W: a bad Meta signature is rejected (401)", bad.status === 401, `got ${bad.status}`);
    const ttPayload = JSON.stringify({ event: "authorization.removed", create_time: 123, data: {} });
    const ts = "1700000000";
    const ttSig = `t=${ts},s=${crypto.createHmac("sha256", "mock-tt-secret").update(`${ts}.${ttPayload}`).digest("hex")}`;
    const ttRes = await fetch(`${BASE}/api/publishing/webhooks/tiktok`, {
      method: "POST", headers: { "Content-Type": "application/json", "tiktok-signature": ttSig }, body: ttPayload,
    });
    check("W: signed TikTok webhook is accepted", ttRes.status === 200, `got ${ttRes.status}`);
  }

  // ---- Restart: persistence + overdue pickup ---------------------------------------
  {
    const far = await createDraft(alice, ytAccount.id, videoOutput.id,
      { ...CLIENT_YT_METADATA, title: "Far future", privacy: "public" });
    await validateApproveSubmit(alice, far.data.job.id, {
      schedule: { scheduledForUtc: new Date(Date.now() + 3600_000).toISOString(), timezone: "Asia/Kolkata" },
    });
    const near = await createDraft(alice, igAccount.id, videoOutput.id,
      { ...CLIENT_IG_METADATA, caption: "Fires after restart" });
    const nearId = near.data.job.id;
    await validateApproveSubmit(alice, nearId, {
      schedule: { scheduledForUtc: new Date(Date.now() + 3000).toISOString(), timezone: "Asia/Kolkata" },
    });
    killServer(server);
    server = null;
    await sleep(600);
    server = spawnServer(mockEnv(tmpB));
    await waitForHealth();
    const farAfter = (await alice.call("GET", `/api/publishing/jobs/${far.data.job.id}`)).data.job;
    check("R: a future schedule survives a server restart untouched",
      farAfter.status === "SCHEDULED", farAfter.status);
    const nearDone = await waitForJob(alice, nearId, ["PUBLISHED", "FAILED"], 60000);
    check("R: an overdue scheduled job is picked up and published after the restart (no browser involved)",
      nearDone.status === "PUBLISHED", `${nearDone.status} ${nearDone.error ?? ""}`);
    // Clean up the far-future job so nothing lingers.
    await alice.call("POST", `/api/publishing/jobs/${far.data.job.id}/cancel`);
  }

  // ---- Disconnect ---------------------------------------------------------------------
  {
    const noConfirm = await alice.call("DELETE", `/api/publishing/accounts/${igAccount.id}`);
    check("D: disconnect without API confirmation → 409 CONFIRMATION_REQUIRED",
      noConfirm.status === 409 && noConfirm.data.error?.code === "CONFIRMATION_REQUIRED", `got ${noConfirm.status}`);
    const del = await alice.call("DELETE", `/api/publishing/accounts/${igAccount.id}?confirm=true`);
    check("D: confirmed disconnect succeeds", del.status === 204, `got ${del.status}`);
    const list = (await alice.call("GET", "/api/publishing/accounts")).data.accounts;
    check("D: the disconnected account leaves the connected list",
      !list.some((a) => a.id === igAccount.id));
    const tokenRows = db.prepare("SELECT COUNT(*) AS n FROM oauth_token_records WHERE account_id = ?").get(igAccount.id);
    check("D: stored tokens are deleted on disconnect", tokenRows.n === 0, `rows=${tokenRows.n}`);
    const histAfter = await alice.call("GET", "/api/publishing/history");
    check("D: publishing history survives disconnection (records are kept)",
      histAfter.data.jobs.some((j) => j.accountId === igAccount.id && j.status === "PUBLISHED"));
    const re = await followOAuth(alice, "instagram");
    check("D: the account can be reconnected cleanly afterwards",
      re.cbLocation.includes("pub_connected=instagram"), re.cbLocation);
  }

  // ---- Regression spot checks ---------------------------------------------------------
  {
    const me = await alice.call("GET", "/api/auth/me");
    const histExports = await alice.call("GET", "/api/exports/history");
    const queue = await alice.call("GET", "/api/publishing/queue?status=PUBLISHED");
    check("REG: Phase 2 auth + Phase 9 exports still respond; queue filter works",
      me.status === 200 && histExports.status === 200 && queue.data.jobs.every((j) => j.status === "PUBLISHED") && queue.data.jobs.length >= 3,
      `me=${me.status} exports=${histExports.status} queue=${queue.data.jobs?.length}`);
    const dbVersion = db.prepare("PRAGMA user_version").get();
    check("REG: database is at migration version 15", dbVersion.user_version === 15, JSON.stringify(dbVersion));
  }

  // ---- Checker-fix verification (S1, S2, S3, S4) ------------------------------
  // Runs last: S2 flags the YouTube account AUTH_REQUIRED and S3
  // disconnects it, so nothing after this block may publish via it.
  {
    // S1: thumbnail edits after approval void the approval.
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
    const thumbForm = () => {
      const f = new FormData();
      f.append("file", new Blob([png], { type: "image/png" }), "thumb.png");
      return f;
    };
    const d = await createDraft(alice, ytAccount.id, videoOutput.id,
      { ...CLIENT_YT_METADATA, title: "Approval voiding", privacy: "public" });
    const jobId = d.data.job.id;
    await alice.raw("POST", `/api/publishing/jobs/${jobId}/thumbnail`, { formData: thumbForm() });
    await alice.call("POST", `/api/publishing/jobs/${jobId}/validate`);
    const ap1 = await alice.call("POST", `/api/publishing/jobs/${jobId}/approve`, { body: { rightsConfirmed: true } });
    check("FIX S1: setup — job approved with a thumbnail attached",
      ap1.status === 200 && ap1.data.job.status === "AWAITING_APPROVAL" && Boolean(ap1.data.job.approvedAt),
      `${ap1.status} ${JSON.stringify(ap1.data).slice(0, 200)}`);
    const changed = await alice.raw("POST", `/api/publishing/jobs/${jobId}/thumbnail`, { formData: thumbForm() });
    const changedData = await changed.json();
    check("FIX S1: changing the thumbnail after approval voids it (back to DRAFT, approval + rights cleared)",
      changed.status === 200 && changedData.job.status === "DRAFT" &&
      !changedData.job.approvedAt && !changedData.job.rightsConfirmedAt,
      `${changed.status} ${JSON.stringify(changedData.job ?? {}).slice(0, 200)}`);
    const sub = await alice.call("POST", `/api/publishing/jobs/${jobId}/submit`);
    check("FIX S1: submit after the post-approval thumbnail change → 409 APPROVAL_REQUIRED",
      sub.status === 409 && sub.data.error?.code === "APPROVAL_REQUIRED", `got ${sub.status}`);
    await alice.call("POST", `/api/publishing/jobs/${jobId}/validate`);
    await alice.call("POST", `/api/publishing/jobs/${jobId}/approve`, { body: { rightsConfirmed: true } });
    const removed = await alice.call("DELETE", `/api/publishing/jobs/${jobId}/thumbnail`);
    check("FIX S1: removing the thumbnail after approval voids it too",
      removed.status === 200 && removed.data.job.status === "DRAFT" && !removed.data.job.approvedAt,
      `${removed.status} ${JSON.stringify(removed.data.job ?? {}).slice(0, 200)}`);
  }
  {
    // S4: a callback with state but NO code consumes the connection.
    const before = (await alice.call("GET", "/api/publishing/accounts")).data.accounts.length;
    const conn = await alice.call("POST", "/api/publishing/accounts/youtube/connect");
    const authRes = await fetch(conn.data.authUrl, { redirect: "manual" });
    const cb = new URL(authRes.headers.get("location"));
    cb.searchParams.delete("code");
    const cbRes = await fetch(cb.toString(), { redirect: "manual" });
    check("FIX S4: a callback without a code redirects with an honest error",
      cbRes.status === 302 && (cbRes.headers.get("location") ?? "").includes("pub_error"),
      cbRes.headers.get("location") ?? "");
    const state = new URL(conn.data.authUrl).searchParams.get("state");
    const stateHash = crypto.createHash("sha256").update(state).digest("hex");
    const row = db.prepare("SELECT status FROM oauth_connections WHERE state_hash = ?").get(stateHash);
    check("FIX S4: the no-code callback marks the connection FAILED immediately (not left PENDING)",
      row?.status === "FAILED", JSON.stringify(row));
    const after = (await alice.call("GET", "/api/publishing/accounts")).data.accounts.length;
    check("FIX S4: no account was created by the no-code callback", after === before, `${before} -> ${after}`);
  }
  {
    // S2: a 403 (user_intervention) from the publish call itself →
    // job AND account land in AUTH_REQUIRED.
    const d = await createDraft(alice, ytAccount.id, videoOutput.id,
      { ...CLIENT_YT_METADATA, title: "Scope revoked at upload", privacy: "public" });
    const jobId = d.data.job.id;
    await mockControl({ forbidNextYtUploadInit: true });
    await validateApproveSubmit(alice, jobId);
    const done = await waitForJob(alice, jobId, ["AUTH_REQUIRED", "FAILED", "PUBLISHED"], 60000);
    check("FIX S2: a 403 user_intervention from the publish call lands the job in AUTH_REQUIRED",
      done.status === "AUTH_REQUIRED" && done.errorClass === "user_intervention",
      `${done.status} class=${done.errorClass} ${done.error ?? ""}`);
    const acc = (await alice.call("GET", "/api/publishing/accounts")).data.accounts.find((a) => a.id === ytAccount.id);
    check("FIX S2: the account is flagged AUTH_REQUIRED as well", acc?.status === "AUTH_REQUIRED", acc?.status);
  }
  {
    // S3: disconnect revokes through the CONFIGURED revoke URL (the
    // mock's), proving the endpoint is config-routed like the token
    // URL — production still defaults to Google's official URL.
    const before = (await mockState()).counters.ytRevokes;
    const del = await alice.call("DELETE", `/api/publishing/accounts/${ytAccount.id}?confirm=true`);
    check("FIX S3: YouTube disconnect succeeds", del.status === 204, `got ${del.status}`);
    const after = (await mockState()).counters.ytRevokes;
    check("FIX S3: revocation went to the configured revoke URL (mock received exactly one call)",
      after - before === 1, `${before} -> ${after}`);
    const tokenRows = db.prepare("SELECT COUNT(*) AS n FROM oauth_token_records WHERE account_id = ?").get(ytAccount.id);
    check("FIX S3: stored tokens are deleted on disconnect", tokenRows.n === 0, `rows=${tokenRows.n}`);
  }
} finally {
  if (server) killServer(server);
  mockServer.close();
}

console.log(`\nPhase 10 publishing e2e (MOCK provider): ${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log("Failures:\n - " + failures.join("\n - "));
  process.exit(1);
}
