// CLIPFORGE server configuration — everything comes from environment
// variables. No secrets are hard-coded anywhere in this codebase.

import path from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const config = {
  port: intEnv("PORT", 3001),
  nodeEnv: process.env.NODE_ENV ?? "development",
  isProduction: process.env.NODE_ENV === "production",
  isTest: process.env.NODE_ENV === "test",
  appBaseUrl: process.env.APP_BASE_URL ?? "http://localhost:5173",
  databaseFile:
    process.env.DATABASE_FILE ?? path.join(serverDir, "data", "clipforge.db"),
  sessionTtlHours: intEnv("SESSION_TTL_HOURS", 12),
  rememberMeTtlDays: intEnv("REMEMBER_ME_TTL_DAYS", 30),
  requireEmailVerification:
    (process.env.REQUIRE_EMAIL_VERIFICATION ?? "false").toLowerCase() === "true",

  // Rate-limit knobs (overridable so the e2e suite can exercise 429s).
  loginRateMax: intEnv("LOGIN_RATE_MAX", 10),
  registerRateMax: intEnv("REGISTER_RATE_MAX", 10),
  resetRateMax: intEnv("RESET_RATE_MAX", 5),
  resendRateMax: intEnv("RESEND_RATE_MAX", 3),

  smtp: {
    host: process.env.SMTP_HOST ?? "",
    port: intEnv("SMTP_PORT", 587),
    user: process.env.SMTP_USER ?? "",
    pass: process.env.SMTP_PASS ?? "",
    from: process.env.SMTP_FROM ?? "CLIPFORGE <no-reply@localhost>",
  },

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    redirectUri: process.env.GOOGLE_REDIRECT_URI ?? "",
  },

  // ---- Phase 3: Studio / uploads --------------------------------------
  // Local development storage adapter: uploaded binaries live under
  // data/media (gitignored), never in the database. When production
  // object storage is configured later, only the storage layer changes.
  mediaDir: process.env.MEDIA_DIR ?? path.join(serverDir, "data", "media"),
  maxUploadMb: intEnv("MAX_UPLOAD_MB", 500),
  uploadSessionTtlMinutes: intEnv("UPLOAD_SESSION_TTL_MINUTES", 30),
  youtubeApiKey: process.env.YOUTUBE_API_KEY ?? "",

  // ---- Phase 4: AI clip detection --------------------------------------
  // Speech-to-text is provider-based. The development provider runs a
  // local faster-whisper model on this server; an OpenAI-compatible
  // Whisper HTTP API can be selected instead. No provider is ever
  // assumed: src/stt.ts verifies configuration before a job may claim
  // transcription results, and jobs fail with a CONFIGURATION error
  // when the selected provider is unusable.
  processingDir: process.env.PROCESSING_DIR ?? path.join(serverDir, "data", "processing"),

  // ---- URL import (yt-dlp) ------------------------------------------------
  // Paste-a-URL source import: a background job downloads the video
  // with the open-source yt-dlp binary and lands it as a normal
  // project source asset. FREE only: no paid APIs, no cookies files,
  // no account logins. The import is AVAILABLE only when the feature
  // flag allows it (URL_IMPORT_ENABLED unset or "true") AND the
  // yt-dlp binary resolves (YTDLP_BIN, default "yt-dlp" on PATH) —
  // otherwise the endpoint answers the honest CONFIGURATION_ERROR
  // naming the missing dependency (see src/urlImport.ts).
  // URL_IMPORT_ALLOW_PRIVATE=1 additionally permits private/loopback
  // targets, which are otherwise SSRF-blocked; it exists ONLY so the
  // e2e suite can import from its local fixture server — never set
  // it in production.
  urlImport: {
    bin: (process.env.YTDLP_BIN ?? "yt-dlp").trim() || "yt-dlp",
    enabledFlag: (process.env.URL_IMPORT_ENABLED ?? "").trim().toLowerCase(),
    allowPrivate:
      (process.env.URL_IMPORT_ALLOW_PRIVATE ?? "").trim() === "1" ||
      (process.env.URL_IMPORT_ALLOW_PRIVATE ?? "").trim().toLowerCase() === "true",
  },
  sttProvider: (process.env.STT_PROVIDER ?? "local-faster-whisper").trim().toLowerCase(),
  whisperModel:
    process.env.WHISPER_MODEL ??
    ((process.env.STT_PROVIDER ?? "local-faster-whisper").trim().toLowerCase() === "openai-compatible"
      ? "whisper-1"
      : "small"),
  sttApiBase: (process.env.STT_API_BASE ?? process.env.OPENAI_API_BASE ?? "https://api.openai.com/v1").replace(/\/$/, ""),
  sttApiKey: process.env.OPENAI_API_KEY ?? process.env.STT_API_KEY ?? "",
  pythonBin: process.env.PYTHON_BIN ?? "python3",

  // ---- Phase 6: caption translation ------------------------------------
  // Translation is provider-based, exactly like STT. NO provider is
  // configured in this development environment (no API key exists), so
  // translation jobs honestly fail with a CONFIGURATION error and the
  // UI says so — translations are never invented. Manual translations
  // typed/uploaded by the user are stored separately and always work.
  translation: {
    provider: (process.env.TRANSLATION_PROVIDER ?? "").trim().toLowerCase(),
    apiKey: process.env.TRANSLATION_API_KEY ?? "",
    apiBase: (process.env.TRANSLATION_API_BASE ?? "").replace(/\/$/, ""),
  },

  // ---- Phase 7: face/person tracking & reframing ------------------------
  // CV runs in a Python child process (scripts/track.py): YuNet face
  // detection (OpenCV FaceDetectorYN) + a YOLOv8-nano person model via
  // onnxruntime + the Silero VAD model bundled with faster-whisper.
  // Models live in server/models (downloaded at setup); if the face
  // model or OpenCV is missing, tracking jobs fail honestly with a
  // CONFIGURATION error — detection is never simulated.
  tracking: {
    modelsDir: process.env.TRACKING_MODELS_DIR ?? path.join(serverDir, "models"),
    faceModel: process.env.TRACKING_FACE_MODEL ?? "face_detection_yunet_2023mar.onnx",
    personModel: process.env.TRACKING_PERSON_MODEL ?? "yolov8n.onnx",
    sampleIntervalSec: 0.5,
    sampleWidth: 480,
    faceScoreThreshold: 0.6,
    personScoreThreshold: 0.35,
  },

  // ---- Phase 8: B-roll providers, AI generation, background removal ----
  // All three external capabilities are PROVIDER-based and optional.
  // None is configured in this development environment (no API keys
  // exist), so the adapters in src/broll.ts honestly report
  // "not configured" and the API fails those operations with a
  // CONFIGURATION error — nothing is scraped, simulated or faked.
  //
  // Stock media: the Pexels adapter in src/broll.ts IS implemented
  // (free-integrations pass) — it activates when PEXELS_API_KEY is
  // set (a free key from pexels.com/api). STOCK_PROVIDER may name
  // "pexels" explicitly; naming any OTHER stock provider keeps the
  // honest not-implemented state, because no adapter exists for it.
  // AI generation and background removal remain interface stubs
  // (implemented: false — no genuinely free production API exists
  // for either), so dropping a key into the environment is NOT
  // sufficient to enable them. Provider status reports
  // implemented:false and configured:false until BOTH are true, so
  // the status surface can never claim readiness the code lacks.
  // Credentials stay server-side, always.
  phase8: {
    stockProvider: (process.env.STOCK_PROVIDER ?? "").trim().toLowerCase(),
    stockApiKey: process.env.STOCK_API_KEY ?? "",
    pexelsApiKey: process.env.PEXELS_API_KEY ?? "",
    // Testing/sandbox override (the Phase 10 *_API_BASE pattern):
    // lets the e2e suite point the REAL Pexels adapter at a local
    // mock. Default is the official production endpoint.
    pexelsApiBase: (process.env.PEXELS_API_BASE ?? "https://api.pexels.com").replace(/\/$/, ""),
    generationProvider: (process.env.AI_GENERATION_PROVIDER ?? "").trim().toLowerCase(),
    generationApiKey: process.env.AI_GENERATION_API_KEY ?? "",
    backgroundProvider: (process.env.BACKGROUND_REMOVAL_PROVIDER ?? "").trim().toLowerCase(),
    backgroundApiKey: process.env.BACKGROUND_REMOVAL_API_KEY ?? "",
    backgroundModelPath: process.env.BACKGROUND_MODEL_PATH ?? "",
  },

  // ---- Phase 10: social publishing (YouTube / Instagram / TikTok) ------
  // Official-API integrations only — no scraping, no browser
  // automation. NO provider credentials exist in this development
  // environment, so every provider reports configured:false and its
  // connect/publish paths fail honestly with 422 CONFIGURATION_ERROR
  // naming the missing variables (the Phase 2/6/8 pattern). Client
  // secrets live ONLY here (server-side); tokens are encrypted at
  // rest (src/tokenCrypto.ts) and never reach the frontend.
  //
  // The *_API_BASE / *_AUTH_BASE / *_TOKEN_URL overrides exist so the
  // e2e suite can point the REAL adapter code at a local mock provider
  // (and so staging can target a sandbox). Defaults are the official
  // production endpoints.
  publishing: {
    publicAppUrl: (process.env.PUBLIC_APP_URL ?? process.env.APP_BASE_URL ?? "http://localhost:5173").replace(/\/$/, ""),
    tokenEncryptionKey: process.env.TOKEN_ENCRYPTION_KEY ?? "",
    tickMs: intEnv("PUBLISH_TICK_MS", 1000),
    youtube: {
      clientId: process.env.GOOGLE_OAUTH_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "",
      redirectUri: process.env.GOOGLE_OAUTH_REDIRECT_URI ?? "",
      authBase: (process.env.YOUTUBE_AUTH_BASE ?? "https://accounts.google.com/o/oauth2/v2/auth").replace(/\/$/, ""),
      tokenUrl: process.env.YOUTUBE_TOKEN_URL ?? "https://oauth2.googleapis.com/token",
      revokeUrl: process.env.YOUTUBE_REVOKE_URL ?? "https://oauth2.googleapis.com/revoke",
      apiBase: (process.env.YOUTUBE_API_BASE ?? "https://www.googleapis.com").replace(/\/$/, ""),
    },
    instagram: {
      appId: process.env.META_APP_ID ?? "",
      appSecret: process.env.META_APP_SECRET ?? "",
      redirectUri: process.env.META_REDIRECT_URI ?? "",
      authBase: (process.env.META_AUTH_BASE ?? "https://www.instagram.com/oauth/authorize").replace(/\/$/, ""),
      tokenUrl: process.env.META_TOKEN_URL ?? "https://api.instagram.com/oauth/access_token",
      apiBase: (process.env.META_GRAPH_BASE ?? "https://graph.instagram.com").replace(/\/$/, ""),
      webhookVerifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN ?? "",
    },
    tiktok: {
      clientKey: process.env.TIKTOK_CLIENT_KEY ?? "",
      clientSecret: process.env.TIKTOK_CLIENT_SECRET ?? "",
      redirectUri: process.env.TIKTOK_REDIRECT_URI ?? "",
      authBase: (process.env.TIKTOK_AUTH_BASE ?? "https://www.tiktok.com/v2/auth/authorize").replace(/\/$/, ""),
      apiBase: (process.env.TIKTOK_API_BASE ?? "https://open.tiktokapis.com").replace(/\/$/, ""),
    },
  },

  // ---- Phase 11: analytics & performance intelligence -------------------
  // Analytics reads go through the SAME connected accounts and tokens
  // as Phase 10 publishing — no new credentials are introduced. What
  // differs per platform is which SCOPES gate which metrics:
  //  - YouTube Analytics API (reports.query) needs the
  //    yt-analytics.readonly scope; the Data API counters used as a
  //    separate source need only youtube.readonly (already granted).
  //  - Instagram Insights need instagram_business_manage_insights,
  //    which Phase 10 deliberately did NOT request (minimal scopes),
  //    so Instagram metrics stay "unavailable" until the account is
  //    reconnected with that scope granted.
  //  - TikTok post metrics need the Display API video.list scope;
  //    Phase 10 requested user.info.basic + video.publish only.
  // Capability detection (analyticsProviders.ts) checks the account's
  // granted scopes before every request and records unavailable
  // metrics as unavailable — never as zero, never invented.
  analytics: {
    tickMs: intEnv("ANALYTICS_TICK_MS", 1000),
    reportsDir: process.env.ANALYTICS_REPORTS_DIR ?? path.join(serverDir, "data", "reports"),
    maxSyncAttempts: intEnv("ANALYTICS_MAX_SYNC_ATTEMPTS", 3),
    backoffBaseSec: intEnv("ANALYTICS_BACKOFF_BASE_SEC", 30),
    youtubeAnalyticsBase: (process.env.YOUTUBE_ANALYTICS_API_BASE ?? "https://youtubeanalytics.googleapis.com").replace(/\/$/, ""),
  },

  // ---- Phase 12: accounts, workspaces, admin, payments ------------------
  // Admin bootstrap: an email listed in ADMIN_EMAILS (comma-separated)
  // is flagged is_admin at registration and at every login. This is the
  // ONLY bootstrap path — admin is never granted from the frontend,
  // and the /api/admin namespace re-checks the flag server-side on
  // every request.
  //
  // Payments: the adapter foundation exists (provider records, signed
  // webhook verification, idempotent event log) but stays DISABLED
  // unless PAYMENTS_ENABLED=true AND a provider name + merchant
  // credentials are present. No merchant credentials exist in this
  // environment, so checkout honestly fails with CONFIGURATION_ERROR.
  account: {
    adminEmails: (process.env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0),
    avatarsDir: process.env.AVATARS_DIR ?? path.join(serverDir, "data", "avatars"),
    dataExportsDir: process.env.DATA_EXPORTS_DIR ?? path.join(serverDir, "data", "data-exports"),
    workspaceLogosDir:
      process.env.WORKSPACE_LOGOS_DIR ?? path.join(serverDir, "data", "workspace-logos"),
    tickMs: intEnv("ACCOUNT_TICK_MS", 1000),
    payments: {
      enabled: (process.env.PAYMENTS_ENABLED ?? "false").toLowerCase() === "true",
      provider: (process.env.PAYMENT_PROVIDER ?? "").trim().toLowerCase(),
      merchantKeyId: process.env.PAYMENT_MERCHANT_KEY_ID ?? "",
      merchantSecret: process.env.PAYMENT_MERCHANT_SECRET ?? "",
      webhookSecret: process.env.PAYMENT_WEBHOOK_SECRET ?? "",
    },
  },
};

export const stockProviderConfigured = Boolean(
  config.phase8.stockProvider && config.phase8.stockApiKey,
);
/** Free-integrations pass: the implemented Pexels stock adapter is
 *  configured exactly when its (free) API key is present. */
export const pexelsConfigured = Boolean(config.phase8.pexelsApiKey);
export const generationProviderConfigured = Boolean(
  config.phase8.generationProvider && config.phase8.generationApiKey,
);
export const backgroundProviderConfigured = Boolean(
  (config.phase8.backgroundProvider && config.phase8.backgroundApiKey) ||
    config.phase8.backgroundModelPath,
);

export const translationConfigured = Boolean(
  config.translation.provider && config.translation.apiKey,
);

export const youtubeConfigured = Boolean(config.youtubeApiKey);

/** Phase 10 provider configuration gates. A provider is "configured"
 *  only when ALL of its OAuth credentials are present; the missing
 *  variable NAMES (never values) are surfaced to the UI so the user
 *  can see exactly what to supply. */
export function publishingProviderStatus(platform: "youtube" | "instagram" | "tiktok"): {
  configured: boolean;
  missing: string[];
} {
  const p = config.publishing;
  const need: Record<string, string>[] = [];
  if (platform === "youtube") {
    need.push(
      { name: "GOOGLE_OAUTH_CLIENT_ID", value: p.youtube.clientId },
      { name: "GOOGLE_OAUTH_CLIENT_SECRET", value: p.youtube.clientSecret },
      { name: "GOOGLE_OAUTH_REDIRECT_URI", value: p.youtube.redirectUri },
    );
  } else if (platform === "instagram") {
    need.push(
      { name: "META_APP_ID", value: p.instagram.appId },
      { name: "META_APP_SECRET", value: p.instagram.appSecret },
      { name: "META_REDIRECT_URI", value: p.instagram.redirectUri },
    );
  } else {
    need.push(
      { name: "TIKTOK_CLIENT_KEY", value: p.tiktok.clientKey },
      { name: "TIKTOK_CLIENT_SECRET", value: p.tiktok.clientSecret },
      { name: "TIKTOK_REDIRECT_URI", value: p.tiktok.redirectUri },
    );
  }
  const missing = need.filter((e) => !e.value).map((e) => e.name);
  return { configured: missing.length === 0, missing };
}

/** Phase 12: is this email an env-bootstrapped administrator? */
export function isAdminEmail(email: string): boolean {
  return config.account.adminEmails.includes(email.trim().toLowerCase());
}

/** Phase 12 payments gate: enabled flag AND provider AND credentials. */
export function paymentsStatus(): { enabled: boolean; provider: string | null; missing: string[] } {
  const p = config.account.payments;
  const missing: string[] = [];
  if (!p.enabled) missing.push("PAYMENTS_ENABLED");
  if (!p.provider) missing.push("PAYMENT_PROVIDER");
  if (!p.merchantKeyId) missing.push("PAYMENT_MERCHANT_KEY_ID");
  if (!p.merchantSecret) missing.push("PAYMENT_MERCHANT_SECRET");
  if (!p.webhookSecret) missing.push("PAYMENT_WEBHOOK_SECRET");
  return {
    enabled: missing.length === 0,
    provider: p.provider || null,
    missing,
  };
}

export const emailConfigured = Boolean(config.smtp.host);
export const googleConfigured = Boolean(
  config.google.clientId && config.google.clientSecret && config.google.redirectUri,
);

// ---- Phase 13 (§11): production startup validation ---------------------
// Called from src/index.ts BEFORE migrations, workers or listen().
// Hard failures throw; src/index.ts catches, prints and exits(1) so a
// misconfigured production process never accepts traffic. In every
// non-production environment (development / test — the e2e suites boot
// with NODE_ENV=test) this is a no-op apart from one info line, so
// local dev keeps the tokenCrypto dev key-file fallback.
//
// Single source of truth for the token key: the raw env value exposed
// as config.publishing.tokenEncryptionKey (process.env.TOKEN_ENCRYPTION_KEY).
// tokenCrypto.ts keeps its lazy length check as a backstop only.
function isParseableHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// Strict standard-base64 shape (openssl rand -base64 32 output).
// Buffer.from(..., "base64") alone is too lenient — it silently
// ignores invalid characters, so validate the alphabet/padding first.
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function validateProductionConfig(): void {
  if (!config.isProduction) {
    console.log(
      `[config] production validation skipped (NODE_ENV=${config.nodeEnv})`,
    );
    return;
  }

  const failures: string[] = [];

  // FAIL: TOKEN_ENCRYPTION_KEY — missing, not valid base64, or not
  // exactly 32 bytes decoded. The value itself is never printed.
  const rawKey = config.publishing.tokenEncryptionKey.trim();
  if (!rawKey) {
    failures.push(
      "TOKEN_ENCRYPTION_KEY is missing. Set it to a base64-encoded 32-byte key " +
        "(generate one with: openssl rand -base64 32). The development key-file " +
        "fallback (server/data/.token-key) is not allowed in production.",
    );
  } else if (!BASE64_RE.test(rawKey)) {
    failures.push(
      "TOKEN_ENCRYPTION_KEY is not valid base64. Set it to a base64-encoded " +
        "32-byte key (generate one with: openssl rand -base64 32).",
    );
  } else if (Buffer.from(rawKey, "base64").length !== 32) {
    failures.push(
      `TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (decoded: ${Buffer.from(rawKey, "base64").length}). ` +
        "Generate one with: openssl rand -base64 32.",
    );
  }

  // FAIL: APP_BASE_URL / PUBLIC_APP_URL, when set, must be a
  // parseable http(s) URL. Only the variable name/reason is reported
  // in aggregate form; the check reads the raw env values so an unset
  // variable (which falls back to a valid default) never fails.
  for (const name of ["APP_BASE_URL", "PUBLIC_APP_URL"] as const) {
    const raw = process.env[name]?.trim();
    if (raw && !isParseableHttpUrl(raw)) {
      failures.push(
        `${name} is set but is not a parseable http(s) URL. Set it to a full URL such as https://example.com.`,
      );
    }
  }

  if (failures.length > 0) {
    throw new Error(
      "[config] Production startup validation failed — refusing to start:\n" +
        failures.map((f) => `  - ${f}`).join("\n"),
    );
  }

  // WARN (loud, non-fatal): risky-but-workable production settings.
  if (!config.requireEmailVerification) {
    console.warn(
      "[config] WARNING: REQUIRE_EMAIL_VERIFICATION is not true — new accounts will not be required to verify their email in production.",
    );
  }
  if (config.account.adminEmails.length === 0) {
    console.warn(
      "[config] WARNING: ADMIN_EMAILS is empty — no administrator will be bootstrapped in production.",
    );
  }
  if (!emailConfigured) {
    console.warn(
      "[config] WARNING: SMTP is not configured (SMTP_HOST unset) — email will use the dev outbox and will not be delivered in production.",
    );
  }
  if (!process.env.DATABASE_FILE) {
    console.warn(
      `[config] WARNING: DATABASE_FILE is not set — using the default database path: ${config.databaseFile}`,
    );
  }
}

export { serverDir };
