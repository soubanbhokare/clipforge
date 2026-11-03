// CLIPFORGE Phase 12 — Admin Console API.
//
// Authorization: EVERY route here sits behind requireAdmin, which
// re-reads the caller's user row and requires is_admin = 1 (the flag
// is bootstrapped only from the ADMIN_EMAILS environment list at
// registration/login). A frontend that merely shows the console, or a
// forged client state, gains nothing — non-admins get 403 on every
// route, which the e2e suite proves.
//
// Honesty: every number on this surface is a real query against the
// live tables. Health checks really spawn ffmpeg/ffprobe and really
// stat the disk. PostgreSQL / Redis / BullMQ are reported as
// NOT_USED — this deployment runs SQLite + in-process workers —
// never as fake green or fake red. Secrets are never returned:
// provider configuration stores only secret REFERENCES (env var
// names), and user payloads never include password hashes or tokens.

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import {
  config,
  emailConfigured,
  paymentsStatus,
  publishingProviderStatus,
} from "./config.js";
import { getDb, type PlanRow, type UserRow } from "./db.js";
import { sendEmail, passwordResetEmail } from "./email.js";
import { tokenEncryptionStatus } from "./tokenCrypto.js";
import { audit, newId, nowIso } from "./accountCore.js";
import { currentPlan, publicPlan, ticketMessages } from "./account.js";

interface AuthedRequest extends Request {
  user?: UserRow;
  sessionId?: string;
}

type RequireAuth = (req: AuthedRequest, res: Response, next: NextFunction) => void;

function firstZodMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Invalid request.";
}

function requireAdmin(requireAuth: RequireAuth) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    requireAuth(req, res, () => {
      const fresh = getDb().prepare("SELECT * FROM users WHERE id = ?").get(req.user!.id) as
        | UserRow
        | undefined;
      if (!fresh || fresh.is_admin !== 1 || (fresh.status ?? "ACTIVE") === "SUSPENDED") {
        res.status(403).json({ error: "Administrator access is required." });
        return;
      }
      req.user = fresh;
      next();
    });
  };
}

function adminPublicUser(u: UserRow) {
  return {
    id: u.id,
    displayName: u.display_name,
    email: u.email,
    emailVerified: u.email_verified_at !== null,
    status: u.status ?? "ACTIVE",
    isAdmin: u.is_admin === 1,
    hasAvatar: Boolean(u.avatar_path),
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at ?? null,
  };
}

function count(db: ReturnType<typeof getDb>, sql: string, ...params: (string | number)[]): number {
  return (db.prepare(sql).get(...params) as { n: number }).n;
}

// ---- provider catalogue ---------------------------------------------------------
// "Configured" is computed from REAL signals: env credentials, local
// model files on disk, and the FFmpeg binary. The admin enable/disable
// toggle and secret REFERENCE live in provider_configurations and are
// layered on top; a toggle never makes an unconfigured provider look
// configured.

interface ProviderDef {
  key: string;
  displayName: string;
  category: string;
  operations: string[];
  configured: () => { configured: boolean; detail: string };
  probe: () => Promise<{ status: string; detail: string }>;
}

function spawnOk(cmd: string, args: string[], timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err) => resolve(!err));
  });
}

async function httpProbe(url: string, headers: Record<string, string>): Promise<{ status: string; detail: string }> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(url, { method: "GET", headers, signal: ctrl.signal });
    clearTimeout(timer);
    if (res.status === 401 || res.status === 403) {
      return { status: "DEGRADED", detail: `Endpoint reachable (HTTP ${res.status}) but rejected the configured credentials.` };
    }
    if (res.ok) return { status: "OPERATIONAL", detail: `Endpoint reachable (HTTP ${res.status}).` };
    return { status: "DEGRADED", detail: `Endpoint returned HTTP ${res.status}.` };
  } catch (err) {
    return { status: "UNAVAILABLE", detail: `Endpoint unreachable: ${err instanceof Error ? err.message : "network error"}.` };
  }
}

function providerDefs(): ProviderDef[] {
  const modelsDir = config.tracking.modelsDir;
  const faceModel = path.join(modelsDir, config.tracking.faceModel);
  const personModel = path.join(modelsDir, config.tracking.personModel);
  return [
    {
      key: "stt",
      displayName: "Speech-to-text",
      category: "ai",
      operations: ["transcription"],
      configured: () => {
        if (config.sttProvider === "openai-compatible") {
          return config.sttApiKey
            ? { configured: true, detail: `OpenAI-compatible Whisper API at ${config.sttApiBase}.` }
            : { configured: false, detail: "STT_PROVIDER=openai-compatible but no API key is set (OPENAI_API_KEY / STT_API_KEY)." };
        }
        return { configured: true, detail: `Local faster-whisper (model "${config.whisperModel}") running on this server.` };
      },
      probe: async () => {
        if (config.sttProvider === "openai-compatible") {
          if (!config.sttApiKey) return { status: "NOT_CONFIGURED", detail: "No STT API key is configured." };
          return httpProbe(`${config.sttApiBase}/models`, { Authorization: `Bearer ${config.sttApiKey}` });
        }
        const pythonOk = await spawnOk(config.pythonBin, ["-c", "import faster_whisper"]);
        return pythonOk
          ? { status: "OPERATIONAL", detail: "Local faster-whisper imports successfully." }
          : { status: "UNAVAILABLE", detail: "Local faster-whisper could not be imported by the configured Python." };
      },
    },
    {
      key: "translation",
      displayName: "Language translation",
      category: "ai",
      operations: ["caption translation"],
      configured: () =>
        config.translation.provider && config.translation.apiKey
          ? { configured: true, detail: `Provider "${config.translation.provider}" configured.` }
          : { configured: false, detail: "No translation provider is configured (TRANSLATION_PROVIDER / TRANSLATION_API_KEY)." },
      probe: async () =>
        config.translation.provider && config.translation.apiKey
          ? httpProbe(config.translation.apiBase || "https://api.openai.com/v1", { Authorization: `Bearer ${config.translation.apiKey}` })
          : { status: "NOT_CONFIGURED", detail: "No translation provider is configured." },
    },
    {
      key: "llm_clip_analysis",
      displayName: "LLM clip analysis",
      category: "ai",
      operations: ["clip ranking assistance"],
      configured: () => ({
        configured: false,
        detail: "No LLM provider is integrated. Clip detection uses the local transcript/scene/silence pipeline.",
      }),
      probe: async () => ({ status: "NOT_CONFIGURED", detail: "No LLM provider is integrated." }),
    },
    {
      key: "tracking",
      displayName: "Face / person tracking",
      category: "ai",
      operations: ["face detection", "person tracking", "auto-reframing"],
      configured: () => {
        const missing: string[] = [];
        if (!fs.existsSync(faceModel)) missing.push(config.tracking.faceModel);
        if (!fs.existsSync(personModel)) missing.push(config.tracking.personModel);
        return missing.length
          ? { configured: false, detail: `Missing model file(s) in ${modelsDir}: ${missing.join(", ")}.` }
          : { configured: true, detail: `Local CV models present in ${modelsDir}.` };
      },
      probe: async () => {
        const ok = fs.existsSync(faceModel) && fs.existsSync(personModel);
        if (!ok) return { status: "UNAVAILABLE", detail: "Tracking model file(s) are missing from disk." };
        const py = await spawnOk(config.pythonBin, ["-c", "import cv2, onnxruntime"]);
        return py
          ? { status: "OPERATIONAL", detail: "Models present and the CV runtime imports successfully." }
          : { status: "UNAVAILABLE", detail: "Models present but the CV runtime (opencv/onnxruntime) failed to import." };
      },
    },
    {
      key: "active_speaker",
      displayName: "Active speaker analysis",
      category: "ai",
      operations: ["active speaker detection"],
      configured: () => ({
        configured: fs.existsSync(faceModel),
        detail: fs.existsSync(faceModel)
          ? "Local analysis over YuNet face tracks + Silero VAD (bundled with faster-whisper)."
          : "Face model missing — active speaker analysis is unavailable.",
      }),
      probe: async () =>
        fs.existsSync(faceModel)
          ? { status: "OPERATIONAL", detail: "Face model present; analysis runs locally with tracking." }
          : { status: "UNAVAILABLE", detail: "Face model missing from disk." },
    },
    {
      key: "enhancement",
      displayName: "Video enhancement",
      category: "media",
      operations: ["enhancement", "stabilization", "audio cleanup"],
      configured: () => ({ configured: true, detail: "Local FFmpeg filter chains on this server." }),
      probe: async () =>
        (await spawnOk("ffmpeg", ["-version"]))
          ? { status: "OPERATIONAL", detail: "FFmpeg is available." }
          : { status: "UNAVAILABLE", detail: "FFmpeg could not be executed." },
    },
    {
      key: "background_removal",
      displayName: "Background removal",
      category: "ai",
      operations: ["background removal"],
      configured: () =>
        (config.phase8.backgroundProvider && config.phase8.backgroundApiKey) || config.phase8.backgroundModelPath
          ? { configured: true, detail: "A background-removal provider/model is configured." }
          : { configured: false, detail: "No background-removal provider or model is configured; the adapter is an honest stub." },
      probe: async () => ({
        status:
          (config.phase8.backgroundProvider && config.phase8.backgroundApiKey) || config.phase8.backgroundModelPath
            ? "DEGRADED"
            : "NOT_CONFIGURED",
        detail:
          (config.phase8.backgroundProvider && config.phase8.backgroundApiKey) || config.phase8.backgroundModelPath
            ? "Configuration present, but the adapter body is not implemented in this build."
            : "No background-removal provider is configured.",
      }),
    },
    {
      key: "image_generation",
      displayName: "Image generation (B-roll)",
      category: "ai",
      operations: ["AI image generation"],
      configured: () =>
        config.phase8.generationProvider && config.phase8.generationApiKey
          ? { configured: true, detail: `Provider "${config.phase8.generationProvider}" configured.` }
          : { configured: false, detail: "No AI generation provider is configured (AI_GENERATION_PROVIDER / AI_GENERATION_API_KEY)." },
      probe: async () => ({
        status: config.phase8.generationProvider && config.phase8.generationApiKey ? "DEGRADED" : "NOT_CONFIGURED",
        detail:
          config.phase8.generationProvider && config.phase8.generationApiKey
            ? "Configuration present, but the adapter body is not implemented in this build."
            : "No AI generation provider is configured.",
      }),
    },
    {
      key: "video_generation",
      displayName: "Video generation",
      category: "ai",
      operations: ["AI video generation"],
      configured: () => ({
        configured: false,
        detail: "No video-generation provider is integrated in this build.",
      }),
      probe: async () => ({ status: "NOT_CONFIGURED", detail: "No video-generation provider is integrated." }),
    },
    {
      key: "stock_media",
      displayName: "Stock media (B-roll)",
      category: "media",
      operations: ["stock search"],
      configured: () =>
        config.phase8.stockProvider && config.phase8.stockApiKey
          ? { configured: true, detail: `Provider "${config.phase8.stockProvider}" configured.` }
          : { configured: false, detail: "No stock-media provider is configured (STOCK_PROVIDER / STOCK_API_KEY)." },
      probe: async () => ({
        status: config.phase8.stockProvider && config.phase8.stockApiKey ? "DEGRADED" : "NOT_CONFIGURED",
        detail:
          config.phase8.stockProvider && config.phase8.stockApiKey
            ? "Configuration present, but the adapter body is not implemented in this build."
            : "No stock-media provider is configured.",
      }),
    },
  ];
}

function providerView(db: ReturnType<typeof getDb>, def: ProviderDef) {
  const cfg = db
    .prepare("SELECT * FROM provider_configurations WHERE provider_key = ?")
    .get(def.key) as
    | {
        enabled: number;
        secret_ref: string | null;
        last_health_status: string | null;
        last_health_at: string | null;
        last_error: string | null;
      }
    | undefined;
  const real = def.configured();
  return {
    key: def.key,
    displayName: def.displayName,
    category: def.category,
    operations: def.operations,
    configured: real.configured,
    configDetail: real.detail,
    enabled: cfg ? cfg.enabled === 1 : true,
    secretRef: cfg?.secret_ref ?? null,
    lastHealthStatus: cfg?.last_health_status ?? null,
    lastHealthAt: cfg?.last_health_at ?? null,
    lastError: cfg?.last_error ?? null,
  };
}

function ensureProviderRow(db: ReturnType<typeof getDb>, def: ProviderDef): void {
  db.prepare(
    `INSERT OR IGNORE INTO provider_configurations
     (id, provider_key, display_name, category, enabled, secret_ref, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, NULL, ?, ?)`,
  ).run(newId(), def.key, def.displayName, def.category, nowIso(), nowIso());
}

// ---- system health -----------------------------------------------------------------

export interface HealthCheck {
  key: string;
  label: string;
  status: string;
  detail: string;
}

export async function runSystemHealth(db: ReturnType<typeof getDb>): Promise<HealthCheck[]> {
  const checks: HealthCheck[] = [];
  const push = (key: string, label: string, status: string, detail: string) => {
    checks.push({ key, label, status, detail });
    db.prepare(
      "INSERT INTO system_health_checks (id, check_key, status, detail, checked_at) VALUES (?, ?, ?, ?, ?)",
    ).run(newId(), key, status, detail.slice(0, 500), nowIso());
  };

  push("api", "Backend API", "OPERATIONAL", "This response is being served by the API process.");

  try {
    const version = db.prepare("PRAGMA user_version").get() as { user_version: number };
    db.prepare("SELECT 1").get();
    push("database", "Database (SQLite)", "OPERATIONAL", `SQLite reachable; schema user_version = ${version.user_version}.`);
  } catch (err) {
    push("database", "Database (SQLite)", "UNAVAILABLE", `SQLite check failed: ${err instanceof Error ? err.message : "unknown error"}.`);
  }

  push("postgresql", "PostgreSQL", "NOT_USED", "Not used by this deployment — the application runs on SQLite (PostgreSQL is the documented production path).");
  push("redis", "Redis", "NOT_USED", "Not used by this deployment — queues are DB-backed tables.");
  push("bullmq", "BullMQ workers", "NOT_USED", "Not used by this deployment — workers are in-process loops in this server.");

  const ffmpegOk = await spawnOk("ffmpeg", ["-version"]);
  push("ffmpeg", "FFmpeg", ffmpegOk ? "OPERATIONAL" : "UNAVAILABLE", ffmpegOk ? "ffmpeg -version executed successfully." : "ffmpeg could not be executed.");
  const ffprobeOk = await spawnOk("ffprobe", ["-version"]);
  push("ffprobe", "FFprobe", ffprobeOk ? "OPERATIONAL" : "UNAVAILABLE", ffprobeOk ? "ffprobe -version executed successfully." : "ffprobe could not be executed.");

  try {
    const stats = await fs.promises.statfs(path.dirname(config.databaseFile));
    const freeMb = Math.round((stats.bfree * stats.bsize) / (1024 * 1024));
    push("disk", "Disk (data directory)", freeMb > 200 ? "OPERATIONAL" : "DEGRADED", `${freeMb} MB free on the data volume.`);
  } catch (err) {
    push("disk", "Disk (data directory)", "UNAVAILABLE", `statfs failed: ${err instanceof Error ? err.message : "unknown error"}.`);
  }

  try {
    fs.mkdirSync(config.mediaDir, { recursive: true });
    fs.accessSync(config.mediaDir, fs.constants.W_OK);
    push("storage", "Media storage (local disk)", "OPERATIONAL", `Media directory ${config.mediaDir} is writable.`);
  } catch {
    push("storage", "Media storage (local disk)", "UNAVAILABLE", `Media directory ${config.mediaDir} is not writable.`);
  }
  push("object_storage", "Object storage (S3 etc.)", "NOT_USED", "Not used by this deployment — media lives on local disk.");

  push(
    "email",
    "Email service",
    emailConfigured ? "OPERATIONAL" : "DEGRADED",
    emailConfigured
      ? "SMTP is configured (status reflects configuration, not a test send)."
      : "SMTP is not configured. The development outbox adapter writes mail to server files — it does not deliver to real inboxes.",
  );

  for (const platform of ["youtube", "instagram", "tiktok"] as const) {
    const s = publishingProviderStatus(platform);
    push(
      `oauth_${platform}`,
      `OAuth — ${platform}`,
      s.configured ? "OPERATIONAL" : "NOT_CONFIGURED",
      s.configured ? "OAuth credentials are present." : `Missing configuration: ${s.missing.join(", ")}.`,
    );
  }

  const enc = tokenEncryptionStatus();
  push("token_encryption", "Token encryption", enc.ready ? "OPERATIONAL" : "UNAVAILABLE", `AES-256-GCM token store, key mode: ${enc.mode}.`);

  const pay = paymentsStatus();
  push("payments", "Payment provider", pay.enabled ? "OPERATIONAL" : "NOT_CONFIGURED", pay.enabled ? `Provider "${pay.provider}" enabled.` : `Payments disabled. Missing: ${pay.missing.join(", ")}.`);

  const queuedRenders = count(db, "SELECT COUNT(*) AS n FROM render_jobs WHERE status = 'QUEUED'");
  const queuedAnalysis = count(db, "SELECT COUNT(*) AS n FROM processing_tasks WHERE status IN ('QUEUED', 'PENDING')");
  push("workers", "Background workers (in-process)", "OPERATIONAL", `Workers run inside this API process. Queue depth: ${queuedRenders} render job(s), ${queuedAnalysis} analysis task(s).`);

  return checks;
}

// ============================================================================
// Routes
// ============================================================================

export function registerAdminRoutes(app: express.Express, requireAuth: RequireAuth): void {
  const router = express.Router();
  const admin = requireAdmin(requireAuth);

  router.get("/admin/overview", admin, (_req: AuthedRequest, res) => {
    const db = getDb();
    const storageBytes =
      (db.prepare("SELECT COALESCE(SUM(file_size),0) AS b FROM source_assets").get() as { b: number }).b +
      (db.prepare("SELECT COALESCE(SUM(file_size),0) AS b FROM export_outputs WHERE status = 'COMPLETED'").get() as { b: number }).b +
      (db.prepare("SELECT COALESCE(SUM(file_size),0) AS b FROM project_media").get() as { b: number }).b;
    res.json({
      users: count(db, "SELECT COUNT(*) AS n FROM users"),
      activeUsers: count(
        db,
        "SELECT COUNT(DISTINCT user_id) AS n FROM sessions WHERE expires_at > ?",
        nowIso(),
      ),
      suspendedUsers: count(db, "SELECT COUNT(*) AS n FROM users WHERE status = 'SUSPENDED'"),
      workspaces: count(db, "SELECT COUNT(*) AS n FROM workspaces"),
      projects: count(db, "SELECT COUNT(*) AS n FROM projects"),
      mediaAssets: count(db, "SELECT COUNT(*) AS n FROM source_assets"),
      analysisJobs: count(db, "SELECT COUNT(*) AS n FROM processing_tasks"),
      generatedClips: count(db, "SELECT COUNT(*) AS n FROM candidate_clips"),
      trackingJobs: count(db, "SELECT COUNT(*) AS n FROM tracking_jobs"),
      exportJobs: count(db, "SELECT COUNT(*) AS n FROM render_jobs WHERE kind = 'EXPORT'"),
      completedExports: count(db, "SELECT COUNT(*) AS n FROM render_jobs WHERE kind = 'EXPORT' AND status = 'COMPLETED'"),
      failedJobs:
        count(db, "SELECT COUNT(*) AS n FROM render_jobs WHERE status = 'FAILED'") +
        count(db, "SELECT COUNT(*) AS n FROM processing_tasks WHERE status = 'FAILED'") +
        count(db, "SELECT COUNT(*) AS n FROM publish_jobs WHERE status = 'FAILED'"),
      publishedPosts: count(db, "SELECT COUNT(*) AS n FROM publish_jobs WHERE status = 'PUBLISHED'"),
      connectedAccounts: count(db, "SELECT COUNT(*) AS n FROM platform_accounts WHERE status = 'CONNECTED'"),
      platformAccounts: count(db, "SELECT COUNT(*) AS n FROM platform_accounts"),
      storageBytes,
      openSupportTickets: count(db, "SELECT COUNT(*) AS n FROM support_tickets WHERE status IN ('OPEN', 'IN_PROGRESS')"),
      workers: "in-process",
      generatedAt: nowIso(),
    });
  });

  // ---- users ------------------------------------------------------------------
  router.get("/admin/users", admin, (req: AuthedRequest, res) => {
    const db = getDb();
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const status = typeof req.query.status === "string" ? req.query.status : "";
    const page = Math.max(1, Number.parseInt(String(req.query.page ?? "1"), 10) || 1);
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(String(req.query.pageSize ?? "25"), 10) || 25));
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (search) {
      clauses.push("(instr(lower(email), lower(?)) > 0 OR instr(lower(display_name), lower(?)) > 0)");
      params.push(search, search);
    }
    if (status === "ACTIVE" || status === "SUSPENDED") {
      clauses.push("status = ?");
      params.push(status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const total = count(db, `SELECT COUNT(*) AS n FROM users ${where}`, ...params);
    const rows = db
      .prepare(`SELECT * FROM users ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize) as unknown as UserRow[];
    res.json({ users: rows.map(adminPublicUser), total, page, pageSize });
  });

  router.get("/admin/users/:id", admin, (req: AuthedRequest, res) => {
    const db = getDb();
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id) as UserRow | undefined;
    if (!user) {
      res.status(404).json({ error: "User not found." });
      return;
    }
    const workspaces = db
      .prepare(
        `SELECT w.id, w.name, w.status, w.is_personal, m.role FROM workspaces w
         JOIN workspace_members m ON m.workspace_id = w.id WHERE m.user_id = ? ORDER BY w.created_at ASC`,
      )
      .all(user.id);
    const usage = db
      .prepare(
        "SELECT operation, resource, unit, SUM(quantity) AS qty, COUNT(*) AS n FROM usage_ledger WHERE user_id = ? GROUP BY operation, resource, unit ORDER BY operation ASC",
      )
      .all(user.id);
    const plan = currentPlan(db, user.id);
    res.json({
      user: adminPublicUser(user),
      workspaces,
      usage,
      subscription: plan
        ? { status: plan.subscription.status, source: plan.subscription.source, plan: publicPlan(db, plan.plan) }
        : null,
      projectCount: count(db, "SELECT COUNT(*) AS n FROM projects WHERE user_id = ?", user.id),
    });
  });

  router.post("/admin/users/:id/suspend", admin, (req: AuthedRequest, res) => {
    const parsed = z.object({ confirm: z.literal(true) }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Confirmation is required to suspend an account.", code: "CONFIRMATION_REQUIRED" });
      return;
    }
    const db = getDb();
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id) as UserRow | undefined;
    if (!user) {
      res.status(404).json({ error: "User not found." });
      return;
    }
    if (user.id === req.user!.id) {
      res.status(400).json({ error: "You cannot suspend your own account." });
      return;
    }
    db.prepare("UPDATE users SET status = 'SUSPENDED', updated_at = ? WHERE id = ?").run(nowIso(), user.id);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
    audit(db, {
      actorUserId: req.user!.id,
      eventType: "USER_SUSPENDED",
      targetType: "user",
      targetId: user.id,
      ip: req.ip ?? null,
    });
    res.json({ ok: true, user: adminPublicUser({ ...user, status: "SUSPENDED" }) });
  });

  router.post("/admin/users/:id/reactivate", admin, (req: AuthedRequest, res) => {
    const db = getDb();
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id) as UserRow | undefined;
    if (!user) {
      res.status(404).json({ error: "User not found." });
      return;
    }
    db.prepare("UPDATE users SET status = 'ACTIVE', updated_at = ? WHERE id = ?").run(nowIso(), user.id);
    audit(db, {
      actorUserId: req.user!.id,
      eventType: "USER_REACTIVATED",
      targetType: "user",
      targetId: user.id,
      ip: req.ip ?? null,
    });
    res.json({ ok: true, user: adminPublicUser({ ...user, status: "ACTIVE" }) });
  });

  router.post("/admin/users/:id/recovery", admin, async (req: AuthedRequest, res) => {
    const db = getDb();
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id) as UserRow | undefined;
    if (!user) {
      res.status(404).json({ error: "User not found." });
      return;
    }
    // Same machinery as the self-service flow: a single-use, hashed,
    // expiring reset token delivered through the email adapter.
    const token = randomBytes(32).toString("base64url");
    const hashed = createHash("sha256").update(token).digest("hex");
    db.prepare(
      "INSERT INTO password_reset_tokens (user_id, hashed_token, expires_at, used_at, created_at) VALUES (?, ?, ?, NULL, ?)",
    ).run(user.id, hashed, new Date(Date.now() + 30 * 60 * 1000).toISOString(), nowIso());
    try {
      await sendEmail(passwordResetEmail(user.email, token));
    } catch (err) {
      console.error("[admin] recovery email failed:", err);
    }
    audit(db, {
      actorUserId: req.user!.id,
      eventType: "USER_RECOVERY_INITIATED",
      targetType: "user",
      targetId: user.id,
      metadata: { delivery: emailConfigured ? "smtp" : "outbox" },
      ip: req.ip ?? null,
    });
    res.json({
      ok: true,
      delivery: emailConfigured ? "smtp" : "outbox",
      deliveryNote: emailConfigured
        ? "A password-reset email was handed to the configured SMTP server."
        : "No SMTP is configured: the reset email was written to the server outbox only.",
    });
  });

  router.post("/admin/users/:id/plan", admin, (req: AuthedRequest, res) => {
    const parsed = z.object({ planId: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstZodMessage(parsed.error) });
      return;
    }
    const db = getDb();
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id) as UserRow | undefined;
    if (!user) {
      res.status(404).json({ error: "User not found." });
      return;
    }
    const plan = db.prepare("SELECT * FROM plans WHERE id = ?").get(parsed.data.planId) as PlanRow | undefined;
    if (!plan) {
      res.status(404).json({ error: "Plan not found." });
      return;
    }
    const subId = newId();
    db.prepare(
      "INSERT INTO user_subscriptions (id, user_id, plan_id, status, source, created_at, updated_at) VALUES (?, ?, ?, 'ACTIVE', 'admin', ?, ?)",
    ).run(subId, user.id, plan.id, nowIso(), nowIso());
    db.prepare(
      "INSERT INTO subscription_events (id, user_id, subscription_id, event_type, detail_json, actor_user_id, created_at) VALUES (?, ?, ?, 'PLAN_CHANGED', ?, ?, ?)",
    ).run(newId(), user.id, subId, JSON.stringify({ planKey: plan.key, by: "admin" }), req.user!.id, nowIso());
    audit(db, {
      actorUserId: req.user!.id,
      eventType: "USER_PLAN_CHANGED",
      targetType: "user",
      targetId: user.id,
      metadata: { planKey: plan.key },
      ip: req.ip ?? null,
    });
    res.json({ ok: true, subscriptionId: subId, plan: publicPlan(db, plan) });
  });

  // ---- workspaces / projects / jobs --------------------------------------------
  router.get("/admin/workspaces", admin, (_req: AuthedRequest, res) => {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT w.*, (SELECT COUNT(*) FROM workspace_members m WHERE m.workspace_id = w.id) AS member_count,
                (SELECT COUNT(*) FROM projects p WHERE p.workspace_id = w.id) AS project_count
         FROM workspaces w ORDER BY w.created_at DESC LIMIT 200`,
      )
      .all() as unknown as (Record<string, unknown> & { member_count: number; project_count: number })[];
    res.json({
      workspaces: rows.map((w) => ({
        id: w.id,
        name: w.name,
        ownerUserId: w.owner_user_id,
        status: w.status,
        isPersonal: w.is_personal === 1,
        memberCount: w.member_count,
        projectCount: w.project_count,
        createdAt: w.created_at,
      })),
    });
  });

  router.get("/admin/projects", admin, (_req: AuthedRequest, res) => {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT p.id, p.name, p.workflow_type, p.status, p.user_id, p.workspace_id, p.created_at, p.updated_at, u.email AS owner_email
         FROM projects p JOIN users u ON u.id = p.user_id ORDER BY p.updated_at DESC LIMIT 200`,
      )
      .all();
    res.json({ projects: rows });
  });

  router.get("/admin/jobs", admin, (_req: AuthedRequest, res) => {
    const db = getDb();
    const jobs: Record<string, unknown>[] = [];
    const pushRows = (kind: string, rows: Record<string, unknown>[]) => {
      for (const r of rows) jobs.push({ kind, ...r });
    };
    pushRows("analysis", db.prepare("SELECT id, user_id, project_id, status, created_at, updated_at FROM processing_tasks ORDER BY created_at DESC LIMIT 60").all() as unknown as Record<string, unknown>[]);
    pushRows("tracking", db.prepare("SELECT id, user_id, project_id, status, created_at, updated_at FROM tracking_jobs ORDER BY created_at DESC LIMIT 60").all() as unknown as Record<string, unknown>[]);
    pushRows("phase8", db.prepare("SELECT id, user_id, project_id, status, created_at, updated_at FROM phase8_jobs ORDER BY created_at DESC LIMIT 60").all() as unknown as Record<string, unknown>[]);
    res.json({ jobs });
  });

  router.get("/admin/render-queue", admin, (_req: AuthedRequest, res) => {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT id, kind, user_id, project_id, status, stage, worker_id, created_at, updated_at, started_at, finished_at
         FROM render_jobs ORDER BY created_at DESC LIMIT 200`,
      )
      .all();
    res.json({ jobs: rows });
  });

  router.get("/admin/publishing-jobs", admin, (_req: AuthedRequest, res) => {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT id, user_id, platform, status, scheduled_for_utc, created_at, updated_at FROM publish_jobs ORDER BY created_at DESC LIMIT 200`,
      )
      .all();
    res.json({ jobs: rows });
  });

  // ---- providers ------------------------------------------------------------------
  router.get("/admin/providers", admin, (_req: AuthedRequest, res) => {
    const db = getDb();
    const defs = providerDefs();
    for (const def of defs) ensureProviderRow(db, def);
    res.json({ providers: defs.map((d) => providerView(db, d)) });
  });

  router.post("/admin/providers/:key/test", admin, async (req: AuthedRequest, res) => {
    const db = getDb();
    const def = providerDefs().find((d) => d.key === req.params.key);
    if (!def) {
      res.status(404).json({ error: "Unknown provider." });
      return;
    }
    ensureProviderRow(db, def);
    const result = await def.probe();
    db.prepare(
      "UPDATE provider_configurations SET last_health_status = ?, last_health_at = ?, last_error = ?, updated_by = ? WHERE provider_key = ?",
    ).run(result.status, nowIso(), result.status === "OPERATIONAL" ? null : result.detail, req.user!.id, def.key);
    audit(db, {
      actorUserId: req.user!.id,
      eventType: "PROVIDER_HEALTH_TESTED",
      targetType: "provider",
      targetId: def.key,
      metadata: { status: result.status },
      ip: req.ip ?? null,
    });
    res.json({ key: def.key, status: result.status, detail: result.detail, checkedAt: nowIso() });
  });

  router.patch("/admin/providers/:key", admin, (req: AuthedRequest, res) => {
    const parsed = z
      .object({
        enabled: z.boolean().optional(),
        secretRef: z
          .string()
          .regex(/^[A-Z][A-Z0-9_]*$/, "Secret reference must be an environment variable NAME (e.g. OPENAI_API_KEY). Secret values are never accepted or stored.")
          .max(80)
          .nullable()
          .optional(),
      })
      .strict()
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstZodMessage(parsed.error) });
      return;
    }
    const db = getDb();
    const def = providerDefs().find((d) => d.key === req.params.key);
    if (!def) {
      res.status(404).json({ error: "Unknown provider." });
      return;
    }
    ensureProviderRow(db, def);
    const cur = db.prepare("SELECT enabled, secret_ref FROM provider_configurations WHERE provider_key = ?").get(def.key) as { enabled: number; secret_ref: string | null };
    db.prepare("UPDATE provider_configurations SET enabled = ?, secret_ref = ?, updated_by = ?, updated_at = ? WHERE provider_key = ?").run(
      parsed.data.enabled !== undefined ? (parsed.data.enabled ? 1 : 0) : cur.enabled,
      parsed.data.secretRef !== undefined ? parsed.data.secretRef : cur.secret_ref,
      req.user!.id,
      nowIso(),
      def.key,
    );
    audit(db, {
      actorUserId: req.user!.id,
      eventType: "PROVIDER_CONFIG_CHANGED",
      targetType: "provider",
      targetId: def.key,
      metadata: { enabled: parsed.data.enabled, secretRefSet: parsed.data.secretRef !== undefined },
      ip: req.ip ?? null,
    });
    res.json({ provider: providerView(db, def) });
  });

  router.get("/admin/integrations", admin, (_req: AuthedRequest, res) => {
    const db = getDb();
    const platforms = (["youtube", "instagram", "tiktok"] as const).map((platform) => {
      const s = publishingProviderStatus(platform);
      const accounts = count(db, "SELECT COUNT(*) AS n FROM platform_accounts WHERE platform = ?", platform);
      const connected = count(db, "SELECT COUNT(*) AS n FROM platform_accounts WHERE platform = ? AND status = 'CONNECTED'", platform);
      return { platform, configured: s.configured, missing: s.missing, accounts, connected };
    });
    res.json({
      platforms,
      tokenEncryption: tokenEncryptionStatus(),
      email: { configured: emailConfigured, mode: emailConfigured ? "smtp" : "outbox" },
      payments: paymentsStatus(),
    });
  });

  // ---- usage monitoring ------------------------------------------------------------
  router.get("/admin/usage", admin, (_req: AuthedRequest, res) => {
    const db = getDb();
    const byOperation = db
      .prepare(
        "SELECT operation, resource, unit, SUM(quantity) AS qty, COUNT(*) AS n FROM usage_ledger GROUP BY operation, resource, unit ORDER BY operation ASC",
      )
      .all();
    const byUser = db
      .prepare(
        `SELECT l.user_id, u.email, COUNT(*) AS entries, SUM(l.quantity) AS total_quantity
         FROM usage_ledger l JOIN users u ON u.id = l.user_id GROUP BY l.user_id ORDER BY entries DESC LIMIT 50`,
      )
      .all();
    res.json({ byOperation, byUser, totalEntries: count(db, "SELECT COUNT(*) AS n FROM usage_ledger") });
  });

  // ---- plans CRUD ---------------------------------------------------------------------
  router.get("/admin/plans", admin, (_req: AuthedRequest, res) => {
    const db = getDb();
    const plans = db.prepare("SELECT * FROM plans ORDER BY created_at ASC").all() as unknown as PlanRow[];
    res.json({ plans: plans.map((p) => publicPlan(db, p)) });
  });

  router.post("/admin/plans", admin, (req: AuthedRequest, res) => {
    const parsed = z
      .object({
        key: z.string().trim().toLowerCase().regex(/^[a-z0-9-]+$/).max(32),
        name: z.string().trim().min(1).max(80),
        description: z.string().max(500).optional().default(""),
        monthlyPriceCents: z.number().int().min(0).nullable().optional(),
        annualPriceCents: z.number().int().min(0).nullable().optional(),
        currency: z.string().trim().length(3).optional().default("USD"),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstZodMessage(parsed.error) });
      return;
    }
    const db = getDb();
    const existing = db.prepare("SELECT id FROM plans WHERE key = ?").get(parsed.data.key);
    if (existing) {
      res.status(409).json({ error: "A plan with that key already exists." });
      return;
    }
    const plan: PlanRow = {
      id: newId(),
      key: parsed.data.key,
      name: parsed.data.name,
      description: parsed.data.description,
      monthly_price_cents: parsed.data.monthlyPriceCents ?? null,
      annual_price_cents: parsed.data.annualPriceCents ?? null,
      currency: parsed.data.currency.toUpperCase(),
      is_active: 1,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    db.prepare(
      "INSERT INTO plans (id, key, name, description, monthly_price_cents, annual_price_cents, currency, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
    ).run(plan.id, plan.key, plan.name, plan.description, plan.monthly_price_cents, plan.annual_price_cents, plan.currency, plan.created_at, plan.updated_at);
    audit(db, {
      actorUserId: req.user!.id,
      eventType: "PLAN_CREATED",
      targetType: "plan",
      targetId: plan.id,
      metadata: { key: plan.key },
      ip: req.ip ?? null,
    });
    res.status(201).json({ plan: publicPlan(db, plan) });
  });

  router.patch("/admin/plans/:id", admin, (req: AuthedRequest, res) => {
    const parsed = z
      .object({
        name: z.string().trim().min(1).max(80).optional(),
        description: z.string().max(500).optional(),
        monthlyPriceCents: z.number().int().min(0).nullable().optional(),
        annualPriceCents: z.number().int().min(0).nullable().optional(),
        currency: z.string().trim().length(3).optional(),
        isActive: z.boolean().optional(),
      })
      .strict()
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstZodMessage(parsed.error) });
      return;
    }
    const db = getDb();
    const plan = db.prepare("SELECT * FROM plans WHERE id = ?").get(req.params.id) as PlanRow | undefined;
    if (!plan) {
      res.status(404).json({ error: "Plan not found." });
      return;
    }
    const d = parsed.data;
    db.prepare(
      "UPDATE plans SET name = ?, description = ?, monthly_price_cents = ?, annual_price_cents = ?, currency = ?, is_active = ?, updated_at = ? WHERE id = ?",
    ).run(
      d.name ?? plan.name,
      d.description ?? plan.description,
      d.monthlyPriceCents !== undefined ? d.monthlyPriceCents : plan.monthly_price_cents,
      d.annualPriceCents !== undefined ? d.annualPriceCents : plan.annual_price_cents,
      d.currency ? d.currency.toUpperCase() : plan.currency,
      d.isActive !== undefined ? (d.isActive ? 1 : 0) : plan.is_active,
      nowIso(),
      plan.id,
    );
    audit(db, {
      actorUserId: req.user!.id,
      eventType: "PLAN_UPDATED",
      targetType: "plan",
      targetId: plan.id,
      metadata: { fields: Object.keys(d) },
      ip: req.ip ?? null,
    });
    const fresh = db.prepare("SELECT * FROM plans WHERE id = ?").get(plan.id) as unknown as PlanRow;
    res.json({ plan: publicPlan(db, fresh) });
  });

  router.put("/admin/plans/:id/entitlements", admin, (req: AuthedRequest, res) => {
    const parsed = z
      .object({
        entitlements: z
          .array(
            z.object({
              key: z.string().trim().min(1).max(64),
              limit: z.number().min(0).nullable().optional(),
              featureEnabled: z.boolean().nullable().optional(),
            }),
          )
          .min(1)
          .max(50),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstZodMessage(parsed.error) });
      return;
    }
    const db = getDb();
    const plan = db.prepare("SELECT * FROM plans WHERE id = ?").get(req.params.id) as PlanRow | undefined;
    if (!plan) {
      res.status(404).json({ error: "Plan not found." });
      return;
    }
    const upsert = db.prepare(
      `INSERT INTO plan_entitlements (id, plan_id, key, limit_value, feature_enabled)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(plan_id, key) DO UPDATE SET limit_value = excluded.limit_value, feature_enabled = excluded.feature_enabled`,
    );
    for (const e of parsed.data.entitlements) {
      upsert.run(
        newId(),
        plan.id,
        e.key,
        e.limit !== undefined ? e.limit : null,
        e.featureEnabled === undefined || e.featureEnabled === null ? null : e.featureEnabled ? 1 : 0,
      );
    }
    audit(db, {
      actorUserId: req.user!.id,
      eventType: "PLAN_ENTITLEMENTS_UPDATED",
      targetType: "plan",
      targetId: plan.id,
      metadata: { keys: parsed.data.entitlements.map((e) => e.key) },
      ip: req.ip ?? null,
    });
    res.json({ plan: publicPlan(db, plan) });
  });

  // ---- reports (Phase 11) ----------------------------------------------------------------
  router.get("/admin/reports", admin, (_req: AuthedRequest, res) => {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT r.id, r.user_id, r.name, r.status, r.created_at, u.email AS owner_email
         FROM analytics_reports r JOIN users u ON u.id = r.user_id ORDER BY r.created_at DESC LIMIT 200`,
      )
      .all();
    res.json({ reports: rows });
  });

  // ---- audit logs ---------------------------------------------------------------------------
  router.get("/admin/audit-logs", admin, (req: AuthedRequest, res) => {
    const db = getDb();
    const page = Math.max(1, Number.parseInt(String(req.query.page ?? "1"), 10) || 1);
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(String(req.query.pageSize ?? "50"), 10) || 50));
    const eventType = typeof req.query.eventType === "string" ? req.query.eventType : "";
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (eventType) {
      clauses.push("event_type = ?");
      params.push(eventType);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const total = count(db, `SELECT COUNT(*) AS n FROM admin_audit_log ${where}`, ...params);
    const rows = db
      .prepare(`SELECT * FROM admin_audit_log ${where} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize) as unknown as {
      id: string;
      actor_user_id: string | null;
      workspace_id: string | null;
      event_type: string;
      target_type: string | null;
      target_id: string | null;
      result: string;
      metadata_json: string;
      ip: string | null;
      created_at: string;
    }[];
    res.json({
      logs: rows.map((r) => ({
        id: r.id,
        actorUserId: r.actor_user_id,
        workspaceId: r.workspace_id,
        eventType: r.event_type,
        targetType: r.target_type,
        targetId: r.target_id,
        result: r.result,
        metadata: (() => {
          try {
            return JSON.parse(r.metadata_json) as Record<string, unknown>;
          } catch {
            return {};
          }
        })(),
        ip: r.ip,
        createdAt: r.created_at,
      })),
      total,
      page,
      pageSize,
    });
  });

  // ---- system health ---------------------------------------------------------------------------
  router.get("/admin/system-health", admin, async (_req: AuthedRequest, res) => {
    const db = getDb();
    const checks = await runSystemHealth(db);
    res.json({ checks, checkedAt: nowIso() });
  });

  // ---- support -----------------------------------------------------------------------------------
  router.get("/admin/support/tickets", admin, (_req: AuthedRequest, res) => {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT t.*, u.email AS user_email, u.display_name AS user_name
         FROM support_tickets t JOIN users u ON u.id = t.user_id ORDER BY t.updated_at DESC LIMIT 200`,
      )
      .all();
    res.json({ tickets: rows });
  });

  router.get("/admin/support/tickets/:id", admin, (req: AuthedRequest, res) => {
    const db = getDb();
    const ticket = db.prepare("SELECT * FROM support_tickets WHERE id = ?").get(req.params.id) as
      | Record<string, unknown>
      | undefined;
    if (!ticket) {
      res.status(404).json({ error: "Ticket not found." });
      return;
    }
    res.json({ ticket: { ...ticket, messages: ticketMessages(db, req.params.id) } });
  });

  router.post("/admin/support/tickets/:id/messages", admin, (req: AuthedRequest, res) => {
    const parsed = z.object({ body: z.string().trim().min(1).max(5000) }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstZodMessage(parsed.error) });
      return;
    }
    const db = getDb();
    const ticket = db.prepare("SELECT id, user_id FROM support_tickets WHERE id = ?").get(req.params.id) as
      | { id: string; user_id: string }
      | undefined;
    if (!ticket) {
      res.status(404).json({ error: "Ticket not found." });
      return;
    }
    db.prepare(
      "INSERT INTO support_ticket_messages (id, ticket_id, author_user_id, author_kind, body, created_at) VALUES (?, ?, ?, 'ADMIN', ?, ?)",
    ).run(newId(), ticket.id, req.user!.id, parsed.data.body, nowIso());
    db.prepare("UPDATE support_tickets SET status = 'IN_PROGRESS', updated_at = ? WHERE id = ? AND status = 'OPEN'").run(nowIso(), ticket.id);
    db.prepare("UPDATE support_tickets SET updated_at = ? WHERE id = ?").run(nowIso(), ticket.id);
    audit(db, {
      actorUserId: req.user!.id,
      eventType: "SUPPORT_TICKET_MESSAGE_POSTED",
      targetType: "support_ticket",
      targetId: ticket.id,
      metadata: { authorKind: "ADMIN" },
      ip: req.ip ?? null,
    });
    res.status(201).json({ ok: true, messages: ticketMessages(db, ticket.id) });
  });

  router.patch("/admin/support/tickets/:id", admin, (req: AuthedRequest, res) => {
    const parsed = z.object({ status: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"]) }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstZodMessage(parsed.error) });
      return;
    }
    const db = getDb();
    const result = db
      .prepare("UPDATE support_tickets SET status = ?, updated_at = ? WHERE id = ?")
      .run(parsed.data.status, nowIso(), req.params.id);
    if (Number(result.changes) === 0) {
      res.status(404).json({ error: "Ticket not found." });
      return;
    }
    audit(db, {
      actorUserId: req.user!.id,
      eventType: "SUPPORT_TICKET_STATUS_CHANGED",
      targetType: "support_ticket",
      targetId: req.params.id,
      metadata: { status: parsed.data.status },
      ip: req.ip ?? null,
    });
    res.json({ ok: true });
  });

  app.use("/api", router);
}
