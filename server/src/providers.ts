// CLIPFORGE Phase 10 — official platform provider adapters.
//
// One interface, three real implementations against the OFFICIAL
// APIs (YouTube Data API v3, Instagram Graph API via Instagram
// Login, TikTok Content Posting API). No scraping, no browser
// automation, no unofficial endpoints. When a provider's OAuth
// credentials are absent from the environment the adapter is never
// invoked for live calls: publishing.ts gates every path on
// publishingProviderStatus() and fails honestly with 422
// CONFIGURATION_ERROR (the Phase 2/6/8 pattern).
//
// Platform limits that the APIs do not expose are marked FALLBACK
// constants with comments — the provider's own error is always
// surfaced verbatim when it disagrees. Limits the APIs DO expose
// (TikTok creator_info, YouTube video categories) are always
// fetched live and persisted as capability snapshots.
//
// Tokens are handled as opaque strings here; encryption at rest and
// storage live in tokenCrypto.ts / publishing.ts. Nothing in this
// file logs credentials or returns them to any caller.

import fs from "node:fs";
import { config } from "./config.js";
import type { StoredTokens } from "./tokenCrypto.js";

export type Platform = "youtube" | "instagram" | "tiktok";
export const PLATFORMS: Platform[] = ["youtube", "instagram", "tiktok"];

export type ErrorClass = "transient" | "user_intervention" | "permanent" | "ambiguous";

export class ProviderError extends Error {
  status: number;
  code: string;
  errorClass: ErrorClass;
  providerBody: unknown;

  constructor(message: string, opts: { status?: number; code?: string; errorClass?: ErrorClass; providerBody?: unknown } = {}) {
    super(message);
    this.status = opts.status ?? 0;
    this.code = opts.code ?? "PROVIDER_ERROR";
    this.errorClass = opts.errorClass ?? "permanent";
    this.providerBody = opts.providerBody;
  }
}

/** Recursively strip credential-shaped fields before a provider
 *  payload is persisted (attempts/error logs) or returned. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/token|secret|authorization|client_key|password/i.test(k)) {
        out[k] = "[redacted]";
      } else {
        out[k] = redact(v);
      }
    }
    return out;
  }
  if (typeof value === "string" && value.length > 4000) return value.slice(0, 4000) + "…";
  return value;
}

function classifyHttp(status: number): ErrorClass {
  if (status === 401 || status === 403) return "user_intervention";
  if (status === 429 || status >= 500) return "transient";
  return "permanent";
}

interface FetchOpts {
  method?: string;
  accessToken?: string;
  headers?: Record<string, string>;
  body?: unknown; // JSON
  form?: Record<string, string>; // x-www-form-urlencoded
  rawBody?: Buffer | Uint8Array;
  /** When true, a network failure is AMBIGUOUS (a submission may have landed). */
  ambiguousOnNetworkError?: boolean;
}

interface FetchResult {
  status: number;
  headers: Headers;
  json: unknown;
  text: string;
}

async function http(url: string, opts: FetchOpts = {}): Promise<FetchResult> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.accessToken) headers.Authorization = `Bearer ${opts.accessToken}`;
  let body: string | Uint8Array | undefined;
  if (opts.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(opts.form).toString();
  } else if (opts.rawBody) {
    body = opts.rawBody as Buffer;
  } else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(url, { method: opts.method ?? "GET", headers, body });
  } catch (err) {
    throw new ProviderError(
      `Network error talking to the platform: ${err instanceof Error ? err.message : String(err)}`,
      { status: 0, code: "NETWORK_ERROR", errorClass: opts.ambiguousOnNetworkError ? "ambiguous" : "transient" },
    );
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const providerMessage = extractProviderMessage(json) ?? text.slice(0, 300) ?? `HTTP ${res.status}`;
    // OAuth grant failures (invalid_grant / invalid_token) mean the
    // authorization itself is dead — a human must reconnect, whatever
    // HTTP status the provider wrapped them in.
    const errObj = (json as Record<string, unknown> | null)?.error as Record<string, unknown> | string | undefined;
    const errCode = typeof errObj === "string" ? errObj : typeof errObj?.code === "string" ? errObj.code : "";
    const grantDead = errCode === "invalid_grant" || errCode === "invalid_token" || /invalid_grant/.test(providerMessage);
    throw new ProviderError(providerMessage, {
      status: res.status,
      code: grantDead ? "AUTH_REQUIRED" : res.status === 429 ? "RATE_LIMITED" : `HTTP_${res.status}`,
      errorClass: grantDead ? "user_intervention" : classifyHttp(res.status),
      providerBody: redact(json ?? text.slice(0, 1000)),
    });
  }
  return { status: res.status, headers: res.headers, json, text };
}

/** Phase 11: the analytics layer (analyticsProviders.ts) talks to the
 *  same official hosts through this exact helper, so error
 *  classification, redaction and grant-death detection stay identical
 *  between publishing and analytics. */
export { http as providerHttp };

function extractProviderMessage(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const j = json as Record<string, unknown>;
  const err = j.error as Record<string, unknown> | string | undefined;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    if (typeof err.message === "string") return err.message;
    if (typeof err.error_message === "string") return err.error_message as string;
    if (typeof err.code === "string" && err.code !== "ok") return err.code;
  }
  if (typeof j.error_message === "string") return j.error_message;
  return null;
}

const isoPlusSeconds = (sec: number): string => new Date(Date.now() + sec * 1000).toISOString();

// ---------------------------------------------------------------------------

export interface ProviderAccountInfo {
  platformAccountId: string;
  username: string | null;
  displayName: string | null;
  profileImageUrl: string | null;
  accountType: string | null;
}

export interface PublishInput {
  accessToken: string;
  filePath: string;
  fileSize: number;
  contentType: string;
  /** Per-platform metadata object (shape validated by publishing.ts). */
  metadata: Record<string, unknown>;
  /** YouTube native scheduling (publishAt) — set ONLY when the spec
   *  conditions hold (privacy=private, never published). */
  nativeScheduleAt?: string | null;
  thumbnailPath?: string | null;
  /** Called the moment the provider hands us a durable identifier
   *  (upload session URI / container id / publish id) so the engine
   *  can persist it BEFORE the risky part of the call finishes. */
  onRequestId?: (providerRequestId: string) => void;
}

export interface PublishSubmitResult {
  providerRequestId: string;
  postId: string | null;
  postUrl: string | null;
  raw?: unknown;
}

export interface PublishStatusResult {
  state: "processing" | "published" | "failed";
  postId: string | null;
  postUrl: string | null;
  error?: string;
  raw?: unknown;
}

export interface MetricsResult {
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  source: string;
}

export interface ProviderAdapter {
  platform: Platform;
  scopes: string[];
  /** PKCE is used where the provider supports it (YouTube/Google). */
  usesPkce: boolean;
  buildAuthUrl(state: string, codeChallenge: string | null): string;
  exchangeCode(code: string, codeVerifier: string | null): Promise<StoredTokens>;
  refreshTokens(tokens: StoredTokens): Promise<StoredTokens>;
  revokeToken?(accessToken: string): Promise<void>;
  getAccountInfo(accessToken: string): Promise<ProviderAccountInfo>;
  getCapabilities(accessToken: string, account: ProviderAccountInfo): Promise<Record<string, unknown>>;
  publish(input: PublishInput): Promise<PublishSubmitResult>;
  getPublishStatus(
    accessToken: string,
    providerRequestId: string,
    postId: string | null,
    accountUsername?: string | null,
  ): Promise<PublishStatusResult>;
  /** Ambiguity recovery: determine (and where the protocol allows,
   *  complete) a submission whose response was lost. Returns null
   *  when the provider cannot prove the submission landed. */
  recoverSubmission(
    accessToken: string,
    providerRequestId: string,
    input: PublishInput,
  ): Promise<PublishStatusResult | null>;
  syncMetrics(accessToken: string, postId: string): Promise<MetricsResult | null>;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const numOrNull = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

// ===========================================================================
// YouTube — Data API v3 (Google OAuth 2.0, PKCE supported)
// ===========================================================================

const youtubeAdapter: ProviderAdapter = {
  platform: "youtube",
  scopes: [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.readonly",
  ],
  usesPkce: true,

  buildAuthUrl(state, codeChallenge) {
    const c = config.publishing.youtube;
    const params = new URLSearchParams({
      client_id: c.clientId,
      redirect_uri: c.redirectUri,
      response_type: "code",
      scope: this.scopes.join(" "),
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
    });
    if (codeChallenge) {
      params.set("code_challenge", codeChallenge);
      params.set("code_challenge_method", "S256");
    }
    return `${c.authBase}?${params.toString()}`;
  },

  async exchangeCode(code, codeVerifier) {
    const c = config.publishing.youtube;
    const form: Record<string, string> = {
      code,
      client_id: c.clientId,
      client_secret: c.clientSecret,
      redirect_uri: c.redirectUri,
      grant_type: "authorization_code",
    };
    if (codeVerifier) form.code_verifier = codeVerifier;
    const { json } = await http(c.tokenUrl, { method: "POST", form });
    const j = json as Record<string, unknown>;
    if (!str(j.access_token)) throw new ProviderError("Google did not return an access token.", { code: "TOKEN_EXCHANGE_FAILED" });
    return {
      accessToken: str(j.access_token),
      refreshToken: strOrNull(j.refresh_token),
      expiresAt: typeof j.expires_in === "number" ? isoPlusSeconds(j.expires_in) : null,
      scope: strOrNull(j.scope),
      tokenType: strOrNull(j.token_type),
    };
  },

  async refreshTokens(tokens) {
    if (!tokens.refreshToken) {
      throw new ProviderError("No refresh token is stored for this account — reconnect it.", {
        code: "NO_REFRESH_TOKEN",
        errorClass: "user_intervention",
      });
    }
    const c = config.publishing.youtube;
    const { json } = await http(c.tokenUrl, {
      method: "POST",
      form: {
        client_id: c.clientId,
        client_secret: c.clientSecret,
        refresh_token: tokens.refreshToken,
        grant_type: "refresh_token",
      },
    });
    const j = json as Record<string, unknown>;
    if (!str(j.access_token)) throw new ProviderError("Google did not return a refreshed access token.", { code: "TOKEN_REFRESH_FAILED" });
    return {
      ...tokens,
      accessToken: str(j.access_token),
      refreshToken: strOrNull(j.refresh_token) ?? tokens.refreshToken,
      expiresAt: typeof j.expires_in === "number" ? isoPlusSeconds(j.expires_in) : tokens.expiresAt,
      scope: strOrNull(j.scope) ?? tokens.scope,
    };
  },

  async revokeToken(accessToken) {
    const c = config.publishing.youtube;
    await http(c.revokeUrl, {
      method: "POST",
      form: { token: accessToken },
    }).catch(() => undefined); // revocation is best-effort; local deletion is authoritative
  },

  async getAccountInfo(accessToken) {
    const c = config.publishing.youtube;
    const { json } = await http(`${c.apiBase}/youtube/v3/channels?part=snippet&mine=true`, { accessToken });
    const items = (json as { items?: Record<string, unknown>[] }).items ?? [];
    if (items.length === 0) {
      throw new ProviderError("This Google account has no YouTube channel.", { code: "NO_CHANNEL", errorClass: "user_intervention" });
    }
    const ch = items[0];
    const snippet = (ch.snippet ?? {}) as Record<string, unknown>;
    const thumbs = (snippet.thumbnails ?? {}) as Record<string, Record<string, unknown>>;
    return {
      platformAccountId: str(ch.id),
      username: strOrNull(snippet.customUrl) ?? strOrNull(snippet.title),
      displayName: strOrNull(snippet.title),
      profileImageUrl: strOrNull(thumbs.default?.url),
      accountType: "CHANNEL",
    };
  },

  async getCapabilities(accessToken) {
    const c = config.publishing.youtube;
    let categories: { id: string; title: string }[] = [];
    try {
      const { json } = await http(
        `${c.apiBase}/youtube/v3/videoCategories?part=snippet&regionCode=US`,
        { accessToken },
      );
      const items = (json as { items?: Record<string, unknown>[] }).items ?? [];
      categories = items
        .filter((it) => ((it.snippet as Record<string, unknown>)?.assignable as boolean) !== false)
        .map((it) => ({ id: str(it.id), title: str((it.snippet as Record<string, unknown>)?.title) }));
    } catch {
      /* categories are an enhancement; limits below still apply */
    }
    return {
      // FALLBACK limits: the Data API does not expose these numbers;
      // they are YouTube's documented limits at build time and the
      // platform's own error wins if they change.
      maxTitleChars: 100,
      maxDescriptionChars: 5000,
      maxTagsTotalChars: 500,
      maxFileSizeBytes: 274_877_906_944, // 256 GiB documented upload ceiling (fallback)
      supportsNativeScheduling: true,
      nativeSchedulingRequires: "Video must be private and never previously published (status.publishAt).",
      supportsCustomThumbnail: true,
      supportsShorts: true, // vertical video up to 180s is classified as a Short by YouTube (fallback note)
      categories,
    };
  },

  async publish(input) {
    const c = config.publishing.youtube;
    const meta = input.metadata as {
      title?: string; description?: string; tags?: string[]; categoryId?: string;
      privacy?: string; madeForKids?: boolean; containsSyntheticMedia?: boolean;
    };
    const status: Record<string, unknown> = {
      privacyStatus: meta.privacy ?? "private",
      selfDeclaredMadeForKids: Boolean(meta.madeForKids),
    };
    if (meta.containsSyntheticMedia !== undefined) status.containsSyntheticMedia = Boolean(meta.containsSyntheticMedia);
    if (input.nativeScheduleAt) {
      status.privacyStatus = "private";
      status.publishAt = input.nativeScheduleAt;
    }
    const metadataBody = {
      snippet: {
        title: meta.title ?? "",
        description: meta.description ?? "",
        tags: meta.tags ?? [],
        categoryId: meta.categoryId || "22",
      },
      status,
    };
    // Step 1: open the resumable upload session.
    const init = await http(`${c.apiBase}/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`, {
      method: "POST",
      accessToken: input.accessToken,
      headers: {
        "X-Upload-Content-Length": String(input.fileSize),
        "X-Upload-Content-Type": input.contentType,
      },
      body: metadataBody,
    });
    const sessionUri = init.headers.get("location");
    if (!sessionUri) {
      throw new ProviderError("YouTube did not return a resumable upload session URL.", { code: "NO_UPLOAD_SESSION" });
    }
    input.onRequestId?.(sessionUri);
    // Step 2: upload the bytes. A NETWORK failure here is ambiguous —
    // the bytes may have landed; the engine recovers via the session.
    const bytes = fs.readFileSync(input.filePath);
    const up = await http(sessionUri, {
      method: "PUT",
      accessToken: input.accessToken,
      headers: {
        "Content-Type": input.contentType,
        "Content-Length": String(bytes.length),
        "Content-Range": `bytes 0-${bytes.length - 1}/${bytes.length}`,
      },
      rawBody: bytes,
      ambiguousOnNetworkError: true,
    });
    const video = up.json as Record<string, unknown>;
    const videoId = str(video.id);
    if (!videoId) throw new ProviderError("YouTube's upload response did not include a video id.", { code: "NO_VIDEO_ID" });
    // Step 3: custom thumbnail (separate call; failure is recorded by
    // the caller as its own attempt and does not unpublish the video).
    return {
      providerRequestId: sessionUri,
      postId: videoId,
      postUrl: `https://www.youtube.com/watch?v=${videoId}`,
      raw: redact(video),
    };
  },

  async getPublishStatus(accessToken, _providerRequestId, postId) {
    if (!postId) return { state: "processing", postId: null, postUrl: null };
    const c = config.publishing.youtube;
    const { json } = await http(`${c.apiBase}/youtube/v3/videos?part=status&id=${encodeURIComponent(postId)}`, { accessToken });
    const items = (json as { items?: Record<string, unknown>[] }).items ?? [];
    if (items.length === 0) {
      return { state: "failed", postId, postUrl: null, error: "YouTube no longer returns this video (deleted or rejected).", raw: redact(json) };
    }
    const status = (items[0].status ?? {}) as Record<string, unknown>;
    const uploadStatus = str(status.uploadStatus);
    const url = `https://www.youtube.com/watch?v=${postId}`;
    if (uploadStatus === "rejected" || uploadStatus === "failed") {
      return {
        state: "failed",
        postId,
        postUrl: null,
        error: `YouTube ${uploadStatus}: ${str(status.failureReason) || str(status.rejectionReason) || "no reason given"}`,
        raw: redact(items[0]),
      };
    }
    if (uploadStatus === "processed") {
      const publishAt = strOrNull(status.publishAt as string | undefined);
      if (publishAt && new Date(publishAt).getTime() > Date.now()) {
        return { state: "processing", postId, postUrl: url, raw: redact(items[0]) };
      }
      return { state: "published", postId, postUrl: url, raw: redact(items[0]) };
    }
    return { state: "processing", postId, postUrl: url, raw: redact(items[0]) };
  },

  async recoverSubmission(accessToken, providerRequestId, input) {
    // The resumable protocol IS the recovery: query the session.
    // 308 + Range = partially received → resume from the offset.
    // 200/201 = the upload completed and the resource exists.
    let res: Response;
    try {
      res = await fetch(providerRequestId, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Range": `bytes */${input.fileSize}`,
          "Content-Length": "0",
        },
      });
    } catch {
      return null;
    }
    if (res.status === 200 || res.status === 201) {
      const video = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      const videoId = video ? str(video.id) : "";
      if (!videoId) return null;
      return {
        state: "processing",
        postId: videoId,
        postUrl: `https://www.youtube.com/watch?v=${videoId}`,
        raw: redact(video),
      };
    }
    if (res.status === 308) {
      const range = res.headers.get("range");
      const m = range ? /bytes=0-(\d+)/.exec(range) : null;
      const offset = m ? Number(m[1]) + 1 : 0;
      if (offset >= input.fileSize) return null;
      const bytes = fs.readFileSync(input.filePath).subarray(offset);
      const up = await http(providerRequestId, {
        method: "PUT",
        headers: {
          "Content-Type": input.contentType,
          "Content-Length": String(bytes.length),
          "Content-Range": `bytes ${offset}-${input.fileSize - 1}/${input.fileSize}`,
        },
        rawBody: bytes,
        accessToken,
        ambiguousOnNetworkError: true,
      });
      const video = up.json as Record<string, unknown>;
      const videoId = str(video.id);
      if (!videoId) return null;
      return {
        state: "processing",
        postId: videoId,
        postUrl: `https://www.youtube.com/watch?v=${videoId}`,
        raw: redact(video),
      };
    }
    return null;
  },

  async syncMetrics(accessToken, postId) {
    const c = config.publishing.youtube;
    const { json } = await http(`${c.apiBase}/youtube/v3/videos?part=statistics&id=${encodeURIComponent(postId)}`, { accessToken });
    const items = (json as { items?: Record<string, unknown>[] }).items ?? [];
    if (items.length === 0) return null;
    const stats = (items[0].statistics ?? {}) as Record<string, unknown>;
    return {
      views: numOrNull(stats.viewCount),
      likes: numOrNull(stats.likeCount),
      comments: numOrNull(stats.commentCount),
      shares: null, // the Data API does not expose share counts here
      source: "youtube-data-api-v3 statistics",
    };
  },
};

// ===========================================================================
// Instagram — Graph API via Instagram Login (Business / Creator only)
// ===========================================================================
// Flow: api.instagram.com OAuth → short-lived token → long-lived
// token (ig_exchange_token, ~60 days) → graph.instagram.com calls.
// Content publishing: resumable container upload → container status
// → media_publish → permalink. Personal accounts are REAL accounts
// but the API does not let them publish; capabilities say so and
// validation blocks them with the platform's reason — they are
// never presented as publish-capable.

const instagramAdapter: ProviderAdapter = {
  platform: "instagram",
  scopes: ["instagram_business_basic", "instagram_business_content_publish"],
  usesPkce: false,

  buildAuthUrl(state) {
    const c = config.publishing.instagram;
    const params = new URLSearchParams({
      client_id: c.appId,
      redirect_uri: c.redirectUri,
      response_type: "code",
      scope: this.scopes.join(","),
      state,
    });
    return `${c.authBase}?${params.toString()}`;
  },

  async exchangeCode(code) {
    const c = config.publishing.instagram;
    const short = await http(c.tokenUrl, {
      method: "POST",
      form: {
        client_id: c.appId,
        client_secret: c.appSecret,
        grant_type: "authorization_code",
        redirect_uri: c.redirectUri,
        code,
      },
    });
    const sj = short.json as Record<string, unknown>;
    const shortToken = str(sj.access_token);
    const igUserId = str(sj.user_id);
    if (!shortToken) throw new ProviderError("Instagram did not return an access token.", { code: "TOKEN_EXCHANGE_FAILED" });
    // Exchange the short-lived token for a long-lived one (~60 days).
    const longUrl =
      `${c.apiBase}/access_token?grant_type=ig_exchange_token` +
      `&client_secret=${encodeURIComponent(c.appSecret)}&access_token=${encodeURIComponent(shortToken)}`;
    const { json } = await http(longUrl);
    const lj = json as Record<string, unknown>;
    const longToken = str(lj.access_token) || shortToken;
    return {
      accessToken: longToken,
      refreshToken: null, // Instagram long-lived tokens are refreshed, not refresh-token based
      expiresAt: typeof lj.expires_in === "number" ? isoPlusSeconds(lj.expires_in) : null,
      scope: this.scopes.join(","),
      tokenType: strOrNull(lj.token_type),
      extra: (igUserId ? { igUserId } : {}) as Record<string, string>,
    };
  },

  async refreshTokens(tokens) {
    const c = config.publishing.instagram;
    const url =
      `${c.apiBase}/refresh_access_token?grant_type=ig_refresh_token` +
      `&access_token=${encodeURIComponent(tokens.accessToken)}`;
    const { json } = await http(url);
    const j = json as Record<string, unknown>;
    if (!str(j.access_token)) {
      throw new ProviderError("Instagram did not return a refreshed token — reconnect the account.", {
        code: "TOKEN_REFRESH_FAILED",
        errorClass: "user_intervention",
      });
    }
    return {
      ...tokens,
      accessToken: str(j.access_token),
      expiresAt: typeof j.expires_in === "number" ? isoPlusSeconds(j.expires_in) : tokens.expiresAt,
    };
  },

  async getAccountInfo(accessToken) {
    const c = config.publishing.instagram;
    const { json } = await http(
      `${c.apiBase}/me?fields=id,username,account_type,name,profile_picture_url`,
      { accessToken },
    );
    const j = json as Record<string, unknown>;
    if (!str(j.id)) throw new ProviderError("Instagram did not return an account profile.", { code: "NO_PROFILE" });
    return {
      platformAccountId: str(j.id),
      username: strOrNull(j.username),
      displayName: strOrNull(j.name) ?? strOrNull(j.username),
      profileImageUrl: strOrNull(j.profile_picture_url),
      accountType: strOrNull(j.account_type),
    };
  },

  async getCapabilities(_accessToken, account) {
    const type = (account.accountType ?? "").toUpperCase();
    const publishSupported = type === "BUSINESS" || type === "CREATOR" || type === "MEDIA_CREATOR";
    return {
      publishSupported,
      accountType: account.accountType,
      unsupportedReason: publishSupported
        ? null
        : "The Instagram API only allows Business and Creator accounts to publish. This account reports type " +
          `${account.accountType ?? "unknown"} — switch it to a Business or Creator account in Instagram settings, then reconnect.`,
      formats: ["REELS"],
      // FALLBACK limits (not exposed by the API; platform errors win):
      maxCaptionChars: 2200,
      maxFileSizeBytes: 250 * 1024 * 1024, // documented Reels ceiling at build time (fallback)
      maxDurationSec: 180, // Reels ceiling at build time (fallback)
      supportsNativeScheduling: false, // CLIPFORGE scheduler submits at the chosen time
      supportsThumbOffset: true,
    };
  },

  async publish(input) {
    const c = config.publishing.instagram;
    const meta = input.metadata as { caption?: string; thumbOffsetMs?: number | null };
    // The IG user id is the account id for Instagram-Login integrations.
    const accountInfo = await this.getAccountInfo(input.accessToken);
    const igId = accountInfo.platformAccountId;
    // Step 1: create the media container with a resumable upload session.
    const createParams = new URLSearchParams({
      media_type: "REELS",
      upload_type: "resumable",
      caption: meta.caption ?? "",
    });
    if (typeof meta.thumbOffsetMs === "number") createParams.set("thumb_offset", String(meta.thumbOffsetMs));
    const created = await http(`${c.apiBase}/${igId}/media?${createParams.toString()}`, {
      method: "POST",
      accessToken: input.accessToken,
      ambiguousOnNetworkError: true,
    });
    const cj = created.json as Record<string, unknown>;
    const containerId = str(cj.id);
    const uploadUri = str(cj.uri) || str(cj.upload_uri);
    if (!containerId) throw new ProviderError("Instagram did not return a media container id.", { code: "NO_CONTAINER" });
    input.onRequestId?.(containerId);
    // Step 2: upload the bytes to the container's upload URI.
    if (uploadUri) {
      const bytes = fs.readFileSync(input.filePath);
      await http(uploadUri, {
        method: "POST",
        accessToken: input.accessToken,
        headers: {
          "Content-Type": "application/octet-stream",
          offset: "0",
          file_size: String(bytes.length),
        },
        rawBody: bytes,
        ambiguousOnNetworkError: true,
      });
    }
    // Step 3: wait for the container to finish processing.
    let statusCode = "";
    for (let i = 0; i < 30; i += 1) {
      const st = await http(`${c.apiBase}/${containerId}?fields=status_code,status`, { accessToken: input.accessToken });
      statusCode = str((st.json as Record<string, unknown>).status_code);
      if (statusCode === "FINISHED" || statusCode === "PUBLISHED") break;
      if (statusCode === "ERROR" || statusCode === "EXPIRED") {
        throw new ProviderError(`Instagram container ${statusCode.toLowerCase()} during processing.`, {
          code: "CONTAINER_FAILED",
          providerBody: redact(st.json),
        });
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (statusCode === "PUBLISHED") {
      return { providerRequestId: containerId, postId: null, postUrl: null, raw: redact(cj) };
    }
    if (statusCode !== "FINISHED") {
      // Still processing — the engine will poll; media_publish happens
      // in getPublishStatus-driven flow is NOT possible (publish is a
      // separate call), so report processing with the container id and
      // let recoverSubmission complete the publish step.
      const done = await this.recoverSubmission(input.accessToken, containerId, input);
      if (done) return { providerRequestId: containerId, postId: done.postId, postUrl: done.postUrl, raw: done.raw };
      return { providerRequestId: containerId, postId: null, postUrl: null, raw: redact(cj) };
    }
    // Step 4: publish the container.
    const published = await http(`${c.apiBase}/${igId}/media_publish`, {
      method: "POST",
      accessToken: input.accessToken,
      body: { creation_id: containerId },
      ambiguousOnNetworkError: true,
    });
    const mediaId = str((published.json as Record<string, unknown>).id);
    if (!mediaId) throw new ProviderError("Instagram's publish response did not include a media id.", { code: "NO_MEDIA_ID" });
    let permalink: string | null = null;
    try {
      const info = await http(`${c.apiBase}/${mediaId}?fields=permalink`, { accessToken: input.accessToken });
      permalink = strOrNull((info.json as Record<string, unknown>).permalink);
    } catch {
      /* permalink is best-effort; the media id is the durable identifier */
    }
    return { providerRequestId: containerId, postId: mediaId, postUrl: permalink, raw: redact(published.json) };
  },

  async getPublishStatus(accessToken, providerRequestId, postId) {
    const c = config.publishing.instagram;
    if (postId) {
      const info = await http(`${c.apiBase}/${postId}?fields=permalink,username`, { accessToken });
      const permalink = strOrNull((info.json as Record<string, unknown>).permalink);
      return { state: "published", postId, postUrl: permalink, raw: redact(info.json) };
    }
    const st = await http(`${c.apiBase}/${providerRequestId}?fields=status_code,status`, { accessToken });
    const code = str((st.json as Record<string, unknown>).status_code);
    if (code === "ERROR" || code === "EXPIRED") {
      return { state: "failed", postId: null, postUrl: null, error: `Instagram container ${code.toLowerCase()}.`, raw: redact(st.json) };
    }
    return { state: "processing", postId: null, postUrl: null, raw: redact(st.json) };
  },

  async recoverSubmission(accessToken, providerRequestId, input) {
    const c = config.publishing.instagram;
    const st = await http(`${c.apiBase}/${providerRequestId}?fields=status_code,status`, { accessToken });
    const sj = st.json as Record<string, unknown>;
    const code = str(sj.status_code);
    if (code === "ERROR" || code === "EXPIRED") {
      return { state: "failed", postId: null, postUrl: null, error: `Instagram container ${code.toLowerCase()}.`, raw: redact(sj) };
    }
    if (code === "PUBLISHED") {
      // The publish landed but we never learned the media id. The
      // container response MAY carry it; if it does not, we cannot
      // honestly claim the post — return null so the engine keeps
      // the job in an ambiguous, human-checkable state and NEVER
      // re-publishes on its own.
      const mediaId = str(sj.media_id);
      if (mediaId) return { state: "published", postId: mediaId, postUrl: null, raw: redact(sj) };
      return null;
    }
    if (code === "FINISHED") {
      // Upload landed, publish step never ran (or its response was
      // lost BEFORE the platform processed it — status would be
      // PUBLISHED in that case). Safe to run media_publish now.
      const accountInfo = await this.getAccountInfo(accessToken);
      const published = await http(`${c.apiBase}/${accountInfo.platformAccountId}/media_publish`, {
        method: "POST",
        accessToken,
        body: { creation_id: providerRequestId },
        ambiguousOnNetworkError: true,
      });
      const mediaId = str((published.json as Record<string, unknown>).id);
      if (!mediaId) return null;
      return { state: "published", postId: mediaId, postUrl: null, raw: redact(published.json) };
    }
    return { state: "processing", postId: null, postUrl: null, raw: redact(sj) };
  },

  async syncMetrics() {
    // Instagram insights require the instagram_business_manage_insights
    // permission, which this integration deliberately does NOT request
    // (minimal scopes). Metrics stay "unavailable", never invented.
    return null;
  },
};

// ===========================================================================
// TikTok — Content Posting API (Login Kit OAuth, Direct Post)
// ===========================================================================
// creator_info/query is called FIRST in every flow: the privacy
// options, interaction defaults and duration ceiling in ITS response
// govern what may be submitted — nothing about privacy is hardcoded.
// An unaudited client is restricted by TikTok itself (typically to
// SELF_ONLY privacy); we surface exactly what the API returns.

const tiktokAdapter: ProviderAdapter = {
  platform: "tiktok",
  scopes: ["user.info.basic", "video.publish"],
  usesPkce: false,

  buildAuthUrl(state) {
    const c = config.publishing.tiktok;
    const params = new URLSearchParams({
      client_key: c.clientKey,
      scope: this.scopes.join(","),
      response_type: "code",
      redirect_uri: c.redirectUri,
      state,
    });
    return `${c.authBase}?${params.toString()}`;
  },

  async exchangeCode(code) {
    const c = config.publishing.tiktok;
    const { json } = await http(`${c.apiBase}/v2/oauth/token/`, {
      method: "POST",
      form: {
        client_key: c.clientKey,
        client_secret: c.clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: c.redirectUri,
      },
    });
    const data = ((json as Record<string, unknown>).data ?? json) as Record<string, unknown>;
    if (!str(data.access_token)) throw new ProviderError("TikTok did not return an access token.", { code: "TOKEN_EXCHANGE_FAILED" });
    return {
      accessToken: str(data.access_token),
      refreshToken: strOrNull(data.refresh_token),
      expiresAt: typeof data.expires_in === "number" ? isoPlusSeconds(data.expires_in) : null,
      scope: strOrNull(data.scope),
      tokenType: null,
      extra: (str(data.open_id) ? { openId: str(data.open_id) } : {}) as Record<string, string>,
    };
  },

  async refreshTokens(tokens) {
    if (!tokens.refreshToken) {
      throw new ProviderError("No refresh token is stored for this account — reconnect it.", {
        code: "NO_REFRESH_TOKEN",
        errorClass: "user_intervention",
      });
    }
    const c = config.publishing.tiktok;
    const { json } = await http(`${c.apiBase}/v2/oauth/token/`, {
      method: "POST",
      form: {
        client_key: c.clientKey,
        client_secret: c.clientSecret,
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
      },
    });
    const data = ((json as Record<string, unknown>).data ?? json) as Record<string, unknown>;
    if (!str(data.access_token)) throw new ProviderError("TikTok did not return a refreshed access token.", { code: "TOKEN_REFRESH_FAILED" });
    return {
      ...tokens,
      accessToken: str(data.access_token),
      refreshToken: strOrNull(data.refresh_token) ?? tokens.refreshToken,
      expiresAt: typeof data.expires_in === "number" ? isoPlusSeconds(data.expires_in) : tokens.expiresAt,
      scope: strOrNull(data.scope) ?? tokens.scope,
    };
  },

  async revokeToken(accessToken) {
    const c = config.publishing.tiktok;
    await http(`${c.apiBase}/v2/oauth/revoke/`, {
      method: "POST",
      form: { client_key: c.clientKey, client_secret: c.clientSecret, token: accessToken },
    }).catch(() => undefined);
  },

  async getAccountInfo(accessToken) {
    const c = config.publishing.tiktok;
    const { json } = await http(
      `${c.apiBase}/v2/user/info/?fields=open_id,union_id,avatar_url,display_name,username`,
      { accessToken },
    );
    const user = ((json as Record<string, unknown>).data as Record<string, unknown>)?.user as Record<string, unknown> | undefined;
    if (!user || !str(user.open_id)) throw new ProviderError("TikTok did not return a user profile.", { code: "NO_PROFILE" });
    return {
      platformAccountId: str(user.open_id),
      username: strOrNull(user.username),
      displayName: strOrNull(user.display_name),
      profileImageUrl: strOrNull(user.avatar_url),
      accountType: "CREATOR",
    };
  },

  async getCapabilities(accessToken) {
    // Capabilities ARE the creator_info response for TikTok.
    const info = await queryCreatorInfo(accessToken);
    return {
      creatorUsername: info.creator_username ?? null,
      privacyLevelOptions: info.privacy_level_options ?? [],
      commentDisabled: Boolean(info.comment_disabled),
      duetDisabled: Boolean(info.duet_disabled),
      stitchDisabled: Boolean(info.stitch_disabled),
      maxVideoPostDurationSec: info.max_video_post_duration_sec ?? null,
      supportsNativeScheduling: false, // Direct Post has no native scheduling — CLIPFORGE scheduler submits at the chosen time
      maxCaptionChars: 2200, // FALLBACK: documented title ceiling at build time; TikTok's own error wins
    };
  },

  async publish(input) {
    const c = config.publishing.tiktok;
    const meta = input.metadata as {
      caption?: string; privacyLevel?: string; disableComment?: boolean; disableDuet?: boolean;
      disableStitch?: boolean; brandedContent?: boolean; brandOrganic?: boolean;
      containsSyntheticMedia?: boolean; videoCoverTimestampMs?: number | null;
    };
    // Creator info FIRST — the submitted privacy level must be one
    // the platform currently offers this creator.
    const creator = await queryCreatorInfo(input.accessToken);
    const options = creator.privacy_level_options ?? [];
    const privacy = meta.privacyLevel ?? options[0];
    if (!privacy || (options.length > 0 && !options.includes(privacy))) {
      throw new ProviderError(
        `Privacy level ${privacy ?? "(none)"} is not available for this creator. Available: ${options.join(", ") || "none reported"}.`,
        { code: "PRIVACY_NOT_AVAILABLE", errorClass: "user_intervention" },
      );
    }
    const size = input.fileSize;
    const CHUNK = 10 * 1024 * 1024; // documented chunk size ceiling for FILE_UPLOAD
    const chunkSize = size <= CHUNK ? size : CHUNK;
    const totalChunks = Math.max(1, Math.ceil(size / chunkSize));
    const init = await http(`${c.apiBase}/v2/post/publish/video/init/`, {
      method: "POST",
      accessToken: input.accessToken,
      body: {
        post_info: {
          title: meta.caption ?? "",
          privacy_level: privacy,
          disable_comment: Boolean(meta.disableComment),
          disable_duet: Boolean(meta.disableDuet),
          disable_stitch: Boolean(meta.disableStitch),
          video_cover_timestamp_ms: typeof meta.videoCoverTimestampMs === "number" ? meta.videoCoverTimestampMs : 0,
          brand_content_toggle: Boolean(meta.brandedContent),
          brand_organic_toggle: Boolean(meta.brandOrganic),
          is_aigc: Boolean(meta.containsSyntheticMedia),
        },
        source_info: {
          source: "FILE_UPLOAD",
          video_size: size,
          chunk_size: chunkSize,
          total_chunk_count: totalChunks,
        },
      },
      ambiguousOnNetworkError: true,
    });
    const data = ((init.json as Record<string, unknown>).data ?? {}) as Record<string, unknown>;
    const publishId = str(data.publish_id);
    const uploadUrl = str(data.upload_url);
    if (!publishId || !uploadUrl) throw new ProviderError("TikTok did not return a publish id / upload URL.", { code: "NO_PUBLISH_ID" });
    input.onRequestId?.(publishId);
    const bytes = fs.readFileSync(input.filePath);
    for (let i = 0; i < totalChunks; i += 1) {
      const start = i * chunkSize;
      const end = Math.min(size, start + chunkSize) - 1;
      const chunk = bytes.subarray(start, end + 1);
      await http(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": String(chunk.length),
          "Content-Range": `bytes ${start}-${end}/${size}`,
        },
        rawBody: chunk,
        ambiguousOnNetworkError: true,
      });
    }
    return { providerRequestId: publishId, postId: null, postUrl: null, raw: redact(init.json) };
  },

  async getPublishStatus(accessToken, providerRequestId, _postId, accountUsername) {
    const c = config.publishing.tiktok;
    const { json } = await http(`${c.apiBase}/v2/post/publish/status/fetch/`, {
      method: "POST",
      accessToken,
      body: { publish_id: providerRequestId },
    });
    const data = ((json as Record<string, unknown>).data ?? {}) as Record<string, unknown>;
    const status = str(data.status);
    if (status === "PUBLISH_COMPLETE") {
      const ids = (data.publicaly_available_post_id as unknown[] | undefined) ?? [];
      const postId = ids.length > 0 ? String(ids[0]) : null;
      const url = postId && accountUsername ? `https://www.tiktok.com/@${accountUsername}/video/${postId}` : null;
      return { state: "published", postId, postUrl: url, raw: redact(json) };
    }
    if (status === "FAILED") {
      return {
        state: "failed",
        postId: null,
        postUrl: null,
        error: `TikTok publish failed: ${str(data.fail_reason) || "no reason given"}`,
        raw: redact(json),
      };
    }
    return { state: "processing", postId: null, postUrl: null, raw: redact(json) };
  },

  async recoverSubmission(accessToken, providerRequestId, _input) {
    // Status-by-publish-id is the recovery: if TikTok accepted the
    // init/upload, the publish id tracks it to a terminal state.
    try {
      return await this.getPublishStatus(accessToken, providerRequestId, null, null);
    } catch {
      return null;
    }
  },

  async syncMetrics() {
    // TikTok's Research API is a separate, separately-approved
    // product; the Content Posting API exposes no post metrics.
    // Metrics stay "unavailable", never invented.
    return null;
  },
};

interface CreatorInfo {
  creator_username?: string;
  creator_nickname?: string;
  privacy_level_options?: string[];
  comment_disabled?: boolean;
  duet_disabled?: boolean;
  stitch_disabled?: boolean;
  max_video_post_duration_sec?: number;
}

async function queryCreatorInfo(accessToken: string): Promise<CreatorInfo> {
  const c = config.publishing.tiktok;
  const { json } = await http(`${c.apiBase}/v2/post/publish/creator_info/query/`, {
    method: "POST",
    accessToken,
    body: {},
  });
  const data = ((json as Record<string, unknown>).data ?? {}) as CreatorInfo;
  return data;
}

// ---------------------------------------------------------------------------

const ADAPTERS: Record<Platform, ProviderAdapter> = {
  youtube: youtubeAdapter,
  instagram: instagramAdapter,
  tiktok: tiktokAdapter,
};

export function getAdapter(platform: Platform): ProviderAdapter {
  return ADAPTERS[platform];
}

export function isPlatform(value: string): value is Platform {
  return (PLATFORMS as string[]).includes(value);
}
