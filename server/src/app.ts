// CLIPFORGE API — Phase 2 authentication.
//
// Security controls implemented here:
//  - Argon2id password hashing (@node-rs/argon2 defaults to Argon2id).
//  - Server-side sessions: the cookie holds a 32-byte random token;
//    only its SHA-256 hash is stored, with a server-side expiry.
//    Logout and password reset revoke session rows.
//  - HttpOnly session cookie, SameSite=Lax, Secure in production.
//  - CSRF double-submit: every mutating request must send the
//    X-CSRF-Token header matching the cf_csrf cookie.
//  - Rate limiting on login / register / forgot-password / resend.
//  - Zod input validation, 100kb JSON body limit, security headers,
//    credential-aware CORS restricted to the dev frontend origin.
//  - Generic responses for login failures and account recovery so the
//    API never reveals whether an account exists.
//  - Verification/reset tokens are random, single-use, expiring, and
//    stored only as SHA-256 hashes. Tokens never appear in responses.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cookieParser from "cookie-parser";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";
import { z } from "zod";
import {
  config,
  emailConfigured,
  googleConfigured,
  isAdminEmail,
  serverDir,
} from "./config.js";
import {
  getDb,
  type SessionRow,
  type TokenRow,
  type UserRow,
} from "./db.js";
import { passwordResetEmail, sendEmail, verificationEmail } from "./email.js";
import {
  ROLE_RANK,
  activeWorkspaceId,
  audit,
  ensureUserFoundations,
  recordLoginEvent,
  workspaceRole,
} from "./accountCore.js";
import { registerStudioRoutes } from "./studio.js";
import { registerUrlImportRoutes } from "./urlImport.js";
import { registerAnalysisRoutes } from "./analysis.js";
import { registerEditorRoutes } from "./editor.js";
import { registerCaptionsRoutes } from "./captions.js";
import { registerTrackingRoutes } from "./tracking.js";
import { registerPhase8Routes } from "./broll.js";
import { registerExportRoutes } from "./export.js";
import { registerPublishingRoutes } from "./publishing.js";
import { registerAnalyticsRoutes } from "./analytics.js";
import { registerAccountRoutes } from "./account.js";
import { registerAdminRoutes } from "./admin.js";

// ---- helpers -----------------------------------------------------------

// Local intEnv-style parse (mirrors config.ts) for knobs that are not
// yet exposed through config — see the global rate limiter (F-02).
function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const sha256 = (value: string): string =>
  crypto.createHash("sha256").update(value).digest("hex");

const newToken = (): string => crypto.randomBytes(32).toString("base64url");
const nowIso = (): string => new Date().toISOString();
const addMs = (ms: number): string => new Date(Date.now() + ms).toISOString();

function publicUser(user: UserRow) {
  return {
    id: user.id,
    displayName: user.display_name,
    email: user.email,
    emailVerified: user.email_verified_at !== null,
    // Phase 12: the frontend uses isAdmin only to decide whether to
    // SHOW the Admin Console entry — the /api/admin namespace checks
    // the flag server-side on every request regardless.
    isAdmin: user.is_admin === 1,
    status: user.status ?? "ACTIVE",
    hasAvatar: Boolean(user.avatar_path),
    createdAt: user.created_at,
  };
}

const passwordSchema = z
  .string()
  .min(10, "Password must be at least 10 characters long.")
  // Login and reauth cap passwords at 200 characters, so the schema
  // that SETS a password must cap it identically — otherwise a
  // >200-char password could be stored but never presented again.
  .max(200, "Password must be at most 200 characters long.")
  .regex(/[a-z]/, "Password must contain a lowercase letter.")
  .regex(/[A-Z]/, "Password must contain an uppercase letter.")
  .regex(/[0-9]/, "Password must contain a number.");

const emailSchema = z.string().trim().toLowerCase().email("Enter a valid email address.").max(254);

const registerSchema = z
  .object({
    displayName: z.string().trim().min(1, "Display name is required.").max(80),
    email: emailSchema,
    password: passwordSchema,
    confirmPassword: z.string(),
    termsAccepted: z.literal(true, {
      errorMap: () => ({ message: "You must accept the terms to create an account." }),
    }),
  })
  .refine((d) => d.password === d.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
  });

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Password is required.").max(200),
  rememberMe: z.boolean().optional().default(false),
});

const forgotSchema = z.object({ email: emailSchema });
const resetSchema = z
  .object({
    token: z.string().min(10).max(200),
    newPassword: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
  });
const verifySchema = z.object({ token: z.string().min(10).max(200) });

function firstZodMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Invalid request.";
}

// ---- auth plumbing -----------------------------------------------------

interface AuthedRequest extends Request {
  user?: UserRow;
  sessionId?: string;
}

function readSession(req: Request): { user: UserRow; session: SessionRow } | null {
  const raw = (req.cookies?.cf_session as string | undefined) ?? "";
  if (!raw) return null;
  const db = getDb();
  const session = db
    .prepare("SELECT * FROM sessions WHERE id = ?")
    .get(sha256(raw)) as SessionRow | undefined;
  if (!session) return null;
  if (new Date(session.expires_at).getTime() <= Date.now()) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(session.id);
    return null;
  }
  const user = db
    .prepare("SELECT * FROM users WHERE id = ?")
    .get(session.user_id) as UserRow | undefined;
  if (!user) return null;
  // Phase 12: suspended accounts lose API access immediately, even
  // with a live session cookie.
  if ((user.status ?? "ACTIVE") === "SUSPENDED") return null;
  // Same for accounts whose deletion is queued or running: queuing
  // deletion closes the account, so existing sessions die at once.
  if (hasPendingAccountDeletion(db, user.id)) return null;
  // Session activity timestamp, throttled to one write per 5 minutes.
  const lastActive = session.last_active_at ? new Date(session.last_active_at).getTime() : 0;
  if (Date.now() - lastActive > 5 * 60 * 1000) {
    db.prepare("UPDATE sessions SET last_active_at = ? WHERE id = ?").run(nowIso(), session.id);
  }
  return { user, session };
}

function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const found = readSession(req);
  if (!found) {
    res.status(401).json({ error: "Not signed in." });
    return;
  }
  req.user = found.user;
  req.sessionId = found.session.id;
  next();
}

export function createSession(
  res: Response,
  userId: string,
  rememberMe: boolean,
  req?: Request,
): void {
  const token = newToken();
  const ttlMs = rememberMe
    ? config.rememberMeTtlDays * 24 * 60 * 60 * 1000
    : config.sessionTtlHours * 60 * 60 * 1000;
  const now = nowIso();
  getDb()
    .prepare(
      "INSERT INTO sessions (id, user_id, expires_at, created_at, ip, user_agent, last_active_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      sha256(token),
      userId,
      addMs(ttlMs),
      now,
      req?.ip ?? null,
      (req?.header("user-agent") ?? "").slice(0, 300) || null,
      now,
    );
  res.cookie("cf_session", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.isProduction,
    path: "/",
    maxAge: ttlMs,
  });
}

function issueToken(
  table: "email_verification_tokens" | "password_reset_tokens",
  userId: string,
  ttlMs: number,
): string {
  const token = newToken();
  const db = getDb();
  // A fresh token supersedes every earlier unused one for the same
  // user and purpose (mirrors the email-change flow in account.ts):
  // only the most recently issued link can ever be redeemed.
  db.prepare(`UPDATE ${table} SET used_at = ? WHERE user_id = ? AND used_at IS NULL`).run(
    nowIso(),
    userId,
  );
  db.prepare(
    `INSERT INTO ${table} (user_id, hashed_token, expires_at, used_at, created_at) VALUES (?, ?, ?, NULL, ?)`,
  ).run(userId, sha256(token), addMs(ttlMs), nowIso());
  return token;
}

function findValidToken(
  table: "email_verification_tokens" | "password_reset_tokens",
  token: string,
): TokenRow | null {
  const row = getDb()
    .prepare(`SELECT * FROM ${table} WHERE hashed_token = ?`)
    .get(sha256(token)) as TokenRow | undefined;
  if (!row || row.used_at !== null) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  return row;
}

// Argon2id hash of a random throwaway password, computed once. Login
// verifies against it when the email is unknown, so that path pays
// the same Argon2 cost as a wrong password and response timing
// cannot be used to enumerate which emails have accounts.
let dummyHashPromise: Promise<string> | null = null;
function dummyPasswordHash(): Promise<string> {
  dummyHashPromise ??= argonHash(newToken()).catch(() => "");
  return dummyHashPromise;
}

// Phase 12: an account with a queued or running deletion job is
// closed for use — its owner asked for it to be erased. COMPLETED
// jobs have no user row left anyway, and a FAILED job must leave
// the account usable (the deletion can be requested again).
function hasPendingAccountDeletion(db: ReturnType<typeof getDb>, userId: string): boolean {
  const row = db
    .prepare(
      "SELECT id FROM account_deletion_jobs WHERE user_id = ? AND status IN ('QUEUED', 'RUNNING') LIMIT 1",
    )
    .get(userId);
  return row !== undefined;
}

// ---- app ---------------------------------------------------------------

export function createApp(): express.Express {
  const app = express();
  app.disable("x-powered-by");

  // Security headers (helmet-lite, no extra dependency).
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    // F-03: every /api route returns JSON or a file download (media,
    // reports, avatars via sendFile) — never HTML — so API responses
    // keep the strictest CSP. Non-API responses only exist in the
    // single-service deployment below, where this same process serves
    // the built frontend same-origin; those responses get a
    // same-origin policy that lets the app's own hashed JS/CSS (and
    // data:/blob: media) load while still framing nothing.
    if (req.path.startsWith("/api")) {
      res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    } else {
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
          "img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; " +
          "connect-src 'self'; frame-ancestors 'none'",
      );
    }
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    // HSTS only in production: over plain-HTTP local development it
    // would pin the browser to HTTPS for a host that cannot serve it.
    if (config.isProduction) {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  });

  // CORS: credential-aware only for the local dev frontend. In
  // production the frontend is served same-origin, so CORS stays off.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin === "http://localhost:5173" || origin === "http://127.0.0.1:5173") {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-CSRF-Token, Idempotency-Key");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
      }
    }
    next();
  });

  // Phase 10 webhooks: provider servers POST without our session or
  // CSRF cookies — their authentication is the HMAC signature over
  // the RAW body. Capture the raw bytes before the JSON parser runs
  // and mark the body as already-read so express.json skips it; the
  // publishing routes verify the signature themselves.
  const captureRawBody = (req: Request, _res: Response, next: NextFunction) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
    req.on("end", () => {
      (req as Request & { rawBody?: Buffer }).rawBody = Buffer.concat(chunks);
      (req as unknown as { _body?: boolean })._body = true;
      next();
    });
    req.on("error", next);
  };
  app.use("/api/publishing/webhooks", captureRawBody);
  // Phase 12: payment webhooks are HMAC-verified over the raw body too.
  app.use("/api/payments/webhook", captureRawBody);

  app.use(express.json({ limit: "100kb" }));
  app.use(cookieParser());

  // CSRF double-submit for every mutating /api request.
  app.use("/api", (req, res, next) => {
    if (req.method === "GET" || req.method === "OPTIONS") return next();
    // Webhook endpoints are signature-authenticated instead (above).
    if (req.path.startsWith("/publishing/webhooks/")) return next();
    if (req.path.startsWith("/payments/webhook/")) return next();
    const cookieToken = (req.cookies?.cf_csrf as string | undefined) ?? "";
    const headerToken = req.header("x-csrf-token") ?? "";
    // F-06a: compare BYTE lengths, not string lengths — equal string
    // lengths can have different UTF-8 byte lengths (multibyte header
    // values), and timingSafeEqual throws on a byte-length mismatch,
    // which would turn a bad CSRF token into a 500 instead of a 403.
    const headerBuf = Buffer.from(headerToken);
    const cookieBuf = Buffer.from(cookieToken);
    const ok =
      cookieBuf.length > 0 &&
      headerBuf.length === cookieBuf.length &&
      crypto.timingSafeEqual(headerBuf, cookieBuf);
    if (!ok) {
      res.status(403).json({ error: "CSRF token missing or invalid." });
      return;
    }
    next();
  });

  const keyByIpAndEmail = (req: Request): string =>
    `${req.ip ?? "unknown"}:${typeof req.body?.email === "string" ? req.body.email.toLowerCase() : ""}`;

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: config.loginRateMax,
    keyGenerator: keyByIpAndEmail,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many attempts. Please wait and try again." },
  });
  const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: config.registerRateMax,
    keyGenerator: keyByIpAndEmail,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many attempts. Please wait and try again." },
  });
  const resetLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: config.resetRateMax,
    keyGenerator: keyByIpAndEmail,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many attempts. Please wait and try again." },
  });
  const resendLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: config.resendRateMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many attempts. Please wait and try again." },
  });

  // F-02 (partial mitigation): one global per-IP ceiling for /api on
  // top of the per-route auth limiters above. The default (6000 per
  // 15 minutes) is deliberately far above legitimate single-user
  // traffic — including the e2e suites, which boot their own
  // instances from localhost — so it only stops runaway/abusive
  // clients. RATE_LIMIT_GLOBAL_MAX is parsed locally with the
  // intEnv helper above because the other limiters read config.ts
  // values and config.ts is not part of this change.
  // Residual item (documented, not addressed here): per-route
  // expensive-operation quotas (e.g. analysis/render/export job
  // creation) remain a documented residual item.
  const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: intEnv("RATE_LIMIT_GLOBAL_MAX", 6000),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many attempts. Please wait and try again." },
    // Health checks must never be throttled. Mounted on /api, so
    // req.path is the remainder ("/health" for /api/health).
    skip: (req) => req.path === "/health",
  });
  app.use("/api", globalLimiter);

  const auth = express.Router();

  auth.get("/config", (_req, res) => {
    res.json({
      emailConfigured,
      googleConfigured,
      requireEmailVerification: config.requireEmailVerification,
    });
  });

  auth.get("/csrf", (_req, res) => {
    const csrfToken = newToken();
    res.cookie("cf_csrf", csrfToken, {
      httpOnly: false, // double-submit pattern: the client reads and echoes it
      sameSite: "lax",
      secure: config.isProduction,
      path: "/",
    });
    res.json({ csrfToken });
  });

  auth.post("/register", registerLimiter, async (req, res) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstZodMessage(parsed.error) });
      return;
    }
    const { displayName, email, password } = parsed.data;
    const db = getDb();
    const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
    if (existing) {
      // Generic duplicate message — does not expose account internals.
      res.status(409).json({ error: "An account with this email already exists." });
      return;
    }
    const passwordHash = await argonHash(password);
    const user: UserRow = {
      id: crypto.randomUUID(),
      display_name: displayName,
      email,
      password_hash: passwordHash,
      email_verified_at: null,
      created_at: nowIso(),
      updated_at: nowIso(),
      // Phase 12: admin is bootstrapped ONLY from the ADMIN_EMAILS
      // environment list — never from anything the client sends.
      is_admin: isAdminEmail(email) ? 1 : 0,
      status: "ACTIVE",
    };
    try {
      db.prepare(
        "INSERT INTO users (id, display_name, email, password_hash, email_verified_at, created_at, updated_at, is_admin, status) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 'ACTIVE')",
      ).run(user.id, user.display_name, user.email, user.password_hash, user.created_at, user.updated_at, user.is_admin ?? 0);
    } catch (err) {
      // The existence pre-check above and this INSERT are separated
      // by the Argon2 await, so two concurrent registrations for the
      // same email can both pass the check — the loser must get the
      // same 409 as the pre-check, not a 500 from the UNIQUE index.
      if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) {
        res.status(409).json({ error: "An account with this email already exists." });
        return;
      }
      throw err;
    }
    // Phase 12 foundations: preferences, personal workspace, plan.
    ensureUserFoundations(db, user);
    audit(db, {
      actorUserId: user.id,
      eventType: "ACCOUNT_REGISTERED",
      targetType: "user",
      targetId: user.id,
      ip: req.ip ?? null,
    });

    const token = issueToken("email_verification_tokens", user.id, 24 * 60 * 60 * 1000);
    try {
      await sendEmail(verificationEmail(email, token));
    } catch (err) {
      console.error("[auth] verification email failed:", err);
    }
    // Registration also opens a session so the new (still unverified)
    // user lands in their workspace and can use resend-verification,
    // which requires auth. Verification state is reported honestly
    // in the payload and in GET /me.
    createSession(res, user.id, false, req);
    res.status(201).json({
      user: publicUser(user),
      emailVerificationRequired: true,
      emailConfigured,
    });
  });

  auth.post("/verify-email", async (req, res) => {
    const parsed = verifySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid verification link." });
      return;
    }
    const row = findValidToken("email_verification_tokens", parsed.data.token);
    if (!row) {
      res.status(400).json({ error: "This verification link is invalid or has expired." });
      return;
    }
    const db = getDb();
    // Consume the token atomically BEFORE marking the email verified:
    // the UPDATE lands only while the token is still unused, so two
    // concurrent verifications with the same link cannot both succeed —
    // the loser gets the same response as an expired link.
    const consumed = db
      .prepare("UPDATE email_verification_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL")
      .run(nowIso(), row.id);
    if (consumed.changes !== 1) {
      res.status(400).json({ error: "This verification link is invalid or has expired." });
      return;
    }
    db.prepare(
      "UPDATE email_verification_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL",
    ).run(nowIso(), row.user_id);
    db.prepare("UPDATE users SET email_verified_at = ?, updated_at = ? WHERE id = ?").run(
      nowIso(),
      nowIso(),
      row.user_id,
    );
    res.json({ ok: true });
  });

  auth.post("/resend-verification", resendLimiter, requireAuth, async (req: AuthedRequest, res) => {
    const user = req.user!;
    if (user.email_verified_at) {
      res.status(400).json({ error: "Email is already verified." });
      return;
    }
    const token = issueToken("email_verification_tokens", user.id, 24 * 60 * 60 * 1000);
    try {
      await sendEmail(verificationEmail(user.email, token));
    } catch (err) {
      console.error("[auth] resend verification email failed:", err);
    }
    // Generic response — never includes the token.
    res.json({ ok: true, emailConfigured });
  });

  auth.post("/login", loginLimiter, async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      // A malformed attempt still belongs in the login history when
      // it carries an identifiable email; without one there is no
      // account to attach the event to.
      const rawEmail =
        typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
      if (rawEmail) {
        recordLoginEvent(getDb(), {
          userId: null,
          email: rawEmail,
          eventType: "LOGIN_FAILURE",
          ip: req.ip ?? null,
          userAgent: (req.header("user-agent") ?? "").slice(0, 300) || null,
        });
      }
      res.status(400).json({ error: firstZodMessage(parsed.error) });
      return;
    }
    const { email, password, rememberMe } = parsed.data;
    const db = getDb();
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email) as
      | UserRow
      | undefined;
    // Generic failure for unknown email AND wrong password alike.
    if (!user) {
      // Pay the same Argon2 verification cost against a dummy hash,
      // so response timing does not reveal whether the email exists.
      try {
        await argonVerify(await dummyPasswordHash(), password);
      } catch {
        // A dummy-hash failure is still just a failed login.
      }
      recordLoginEvent(db, {
        userId: null,
        email,
        eventType: "LOGIN_FAILURE",
        ip: req.ip ?? null,
        userAgent: (req.header("user-agent") ?? "").slice(0, 300) || null,
      });
      res.status(401).json({ error: "Invalid email or password." });
      return;
    }
    if (!(await argonVerify(user.password_hash, password))) {
      recordLoginEvent(db, {
        userId: user.id,
        email,
        eventType: "LOGIN_FAILURE",
        ip: req.ip ?? null,
        userAgent: (req.header("user-agent") ?? "").slice(0, 300) || null,
      });
      res.status(401).json({ error: "Invalid email or password." });
      return;
    }
    // Suspension is revealed only AFTER the password checks out, so
    // the login endpoint still leaks nothing to credential guessing.
    if ((user.status ?? "ACTIVE") === "SUSPENDED") {
      recordLoginEvent(db, {
        userId: user.id,
        email,
        eventType: "LOGIN_BLOCKED_SUSPENDED",
        ip: req.ip ?? null,
        userAgent: (req.header("user-agent") ?? "").slice(0, 300) || null,
      });
      res.status(403).json({
        error: "This account has been suspended. Contact support if you believe this is a mistake.",
        code: "ACCOUNT_SUSPENDED",
      });
      return;
    }
    // Same post-password placement as suspension: an account whose
    // deletion is queued or running is closed, full stop.
    if (hasPendingAccountDeletion(db, user.id)) {
      recordLoginEvent(db, {
        userId: user.id,
        email,
        eventType: "LOGIN_BLOCKED_DELETION_PENDING",
        ip: req.ip ?? null,
        userAgent: (req.header("user-agent") ?? "").slice(0, 300) || null,
      });
      res.status(403).json({
        error:
          "This account is scheduled for deletion and can no longer be used. Contact support if this was a mistake.",
        code: "ACCOUNT_DELETION_PENDING",
      });
      return;
    }
    if (config.requireEmailVerification && !user.email_verified_at) {
      recordLoginEvent(db, {
        userId: user.id,
        email,
        eventType: "LOGIN_BLOCKED_UNVERIFIED",
        ip: req.ip ?? null,
        userAgent: (req.header("user-agent") ?? "").slice(0, 300) || null,
      });
      res.status(403).json({
        error: "Please verify your email before signing in.",
        code: "EMAIL_NOT_VERIFIED",
      });
      return;
    }
    // Phase 12: env-based admin bootstrap is re-checked at login, and
    // pre-v12 users gain their workspace/plan foundations lazily.
    if (isAdminEmail(user.email) && user.is_admin !== 1) {
      db.prepare("UPDATE users SET is_admin = 1 WHERE id = ?").run(user.id);
      user.is_admin = 1;
    }
    ensureUserFoundations(db, user);
    // Phase 12 MFA: a confirmed TOTP enrolment turns login into a
    // two-step flow. No session exists until the second factor (or a
    // recovery code) verifies against the short-lived challenge.
    const totp = db
      .prepare("SELECT enabled FROM user_totp WHERE user_id = ?")
      .get(user.id) as { enabled: number } | undefined;
    if (totp?.enabled === 1) {
      const challengeToken = newToken();
      db.prepare("DELETE FROM mfa_challenges WHERE user_id = ?").run(user.id);
      db.prepare(
        "INSERT INTO mfa_challenges (id, user_id, remember_me, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(sha256(challengeToken), user.id, rememberMe ? 1 : 0, addMs(5 * 60 * 1000), nowIso());
      recordLoginEvent(db, {
        userId: user.id,
        email,
        eventType: "LOGIN_MFA_REQUIRED",
        ip: req.ip ?? null,
        userAgent: (req.header("user-agent") ?? "").slice(0, 300) || null,
      });
      res.json({ mfaRequired: true, challengeToken, expiresInSec: 300 });
      return;
    }
    db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(nowIso(), user.id);
    recordLoginEvent(db, {
      userId: user.id,
      email,
      eventType: "LOGIN_SUCCESS",
      ip: req.ip ?? null,
      userAgent: (req.header("user-agent") ?? "").slice(0, 300) || null,
    });
    createSession(res, user.id, rememberMe, req);
    res.json({ user: publicUser(user) });
  });

  auth.post("/logout", (req, res) => {
    const raw = (req.cookies?.cf_session as string | undefined) ?? "";
    if (raw) {
      getDb().prepare("DELETE FROM sessions WHERE id = ?").run(sha256(raw));
    }
    res.clearCookie("cf_session", { path: "/" });
    res.json({ ok: true });
  });

  auth.get("/me", (req, res) => {
    const found = readSession(req);
    if (!found) {
      res.status(401).json({ error: "Not signed in." });
      return;
    }
    res.json({ user: publicUser(found.user) });
  });

  auth.post("/forgot-password", resetLimiter, async (req, res) => {
    const parsed = forgotSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstZodMessage(parsed.error) });
      return;
    }
    const user = getDb()
      .prepare("SELECT * FROM users WHERE email = ?")
      .get(parsed.data.email) as UserRow | undefined;
    if (user) {
      const token = issueToken("password_reset_tokens", user.id, 30 * 60 * 1000);
      try {
        await sendEmail(passwordResetEmail(user.email, token));
      } catch (err) {
        console.error("[auth] reset email failed:", err);
      }
    }
    // ALWAYS the same generic response, whether or not the account
    // exists — and it never claims an email was sent.
    res.json({
      ok: true,
      message:
        "If an account exists for that email, password-reset instructions will be sent to it.",
      emailConfigured,
    });
  });

  auth.post("/reset-password", resetLimiter, async (req, res) => {
    const parsed = resetSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstZodMessage(parsed.error) });
      return;
    }
    const row = findValidToken("password_reset_tokens", parsed.data.token);
    if (!row) {
      res.status(400).json({ error: "This reset link is invalid or has expired." });
      return;
    }
    const db = getDb();
    const passwordHash = await argonHash(parsed.data.newPassword);
    // Consume the token atomically BEFORE changing the password:
    // the UPDATE lands only while the token is still unused, so two
    // concurrent resets with the same link cannot both succeed —
    // the loser gets the same response as an expired link.
    const consumed = db
      .prepare("UPDATE password_reset_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL")
      .run(nowIso(), row.id);
    if (consumed.changes !== 1) {
      res.status(400).json({ error: "This reset link is invalid or has expired." });
      return;
    }
    db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(
      passwordHash,
      nowIso(),
      row.user_id,
    );
    db.prepare(
      "UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL",
    ).run(nowIso(), row.user_id);
    // Revoke every existing session for this user.
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(row.user_id);
    audit(db, {
      actorUserId: row.user_id,
      eventType: "PASSWORD_RESET",
      targetType: "user",
      targetId: row.user_id,
      ip: req.ip ?? null,
    });
    const resetUser = db.prepare("SELECT email FROM users WHERE id = ?").get(row.user_id) as
      | { email: string }
      | undefined;
    recordLoginEvent(db, {
      userId: row.user_id,
      email: resetUser?.email ?? "",
      eventType: "PASSWORD_RESET",
      ip: req.ip ?? null,
    });
    res.json({ ok: true });
  });

  app.use("/api/auth", auth);

  // Phase 12: workspace ROLE enforcement for mutations on the two
  // ownership roots (projects, brand kits). Reads stay membership-
  // scoped via ownedProject; a mutation additionally requires the
  // caller's role in the resource's workspace to be EDITOR or above
  // (Viewer is read-only). Non-members fall through to the routes'
  // own 404s, exactly as before — this guard only ever ADDS a 403
  // for a member whose role is too low.
  const workspaceRoleGuard = (req: AuthedRequest, res: Response, next: NextFunction): void => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
    const projMatch = /^\/projects\/([A-Za-z0-9-]+)/.exec(req.path);
    const kitMatch = /^\/brand-kits\/([A-Za-z0-9-]+)/.exec(req.path);
    const isCreate = req.path === "/projects" || req.path === "/brand-kits";
    if (!projMatch && !kitMatch && !isCreate) return next();
    const found = readSession(req);
    if (!found) return next(); // the route's requireAuth answers 401
    const db = getDb();
    let workspaceId: string | null | undefined;
    if (projMatch) {
      const row = db.prepare("SELECT workspace_id FROM projects WHERE id = ?").get(projMatch[1]) as
        | { workspace_id: string | null }
        | undefined;
      if (!row) return next();
      workspaceId = row.workspace_id;
    } else if (kitMatch) {
      const row = db.prepare("SELECT workspace_id FROM brand_kits WHERE id = ?").get(kitMatch[1]) as
        | { workspace_id: string | null }
        | undefined;
      if (!row) return next();
      workspaceId = row.workspace_id;
    }
    const wsId = workspaceId ?? activeWorkspaceId(db, found.user.id);
    if (!wsId) return next();
    const role = workspaceRole(db, wsId, found.user.id);
    if (!role) return next();
    if ((ROLE_RANK[role] ?? 0) < (ROLE_RANK.EDITOR ?? 2)) {
      res.status(403).json({
        error: "Your role in this workspace does not allow changes. Ask an Owner or Admin to change your role.",
        code: "WORKSPACE_ROLE_FORBIDDEN",
      });
      return;
    }
    next();
  };
  app.use("/api", workspaceRoleGuard);

  // Phase 3: Studio projects, upload sessions, source media, YouTube
  // validation — same session + CSRF protections as auth.
  registerStudioRoutes(app, requireAuth);

  // URL import (yt-dlp): paste-a-URL source imports. The jobs are
  // phase8_jobs rows drained by the Phase 8 worker; these routes only
  // create them — same session + CSRF protections as everything else.
  registerUrlImportRoutes(app, requireAuth);

  // Phase 4: AI clip detection jobs, transcripts, candidates and
  // preview streaming — same session + CSRF protections as auth.
  registerAnalysisRoutes(app, requireAuth);

  // Phase 5: video editor documents, operations, versions, project
  // media and render jobs — same protections again.
  registerEditorRoutes(app, requireAuth);

  // Phase 6: Captions Studio (styles, templates, tracks, subtitle
  // import/export, translation jobs) and Brand Kits — same protections.
  registerCaptionsRoutes(app, requireAuth);
  registerTrackingRoutes(app, requireAuth);

  // Phase 8: B-roll recommendations/placements, media library,
  // enhancement jobs + document enhancement config, effect presets —
  // same session + CSRF protections as everything else.
  registerPhase8Routes(app, requireAuth);
  registerExportRoutes(app, requireAuth);

  // Phase 10: Publishing Center — connected accounts, OAuth,
  // publishing jobs, scheduling, calendar, queue, history, webhooks.
  registerPublishingRoutes(app, requireAuth);

  // Phase 11: Analytics — capability detection, snapshots, sync jobs,
  // engagement, trends, insights, posting times, reports.
  registerAnalyticsRoutes(app, requireAuth);

  // Phase 12: account settings, security/MFA, workspaces, members,
  // notifications, usage, plans, payments foundation, privacy, support.
  registerAccountRoutes(app, requireAuth);

  // Phase 12: Admin Console — every route behind a server-side
  // is_admin check (see admin.ts); the frontend flag only controls
  // whether the entry point is displayed.
  registerAdminRoutes(app, requireAuth);

  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  // Unknown /api/* — registered AFTER every API route above, so real
  // routes keep precedence and an unmatched API path is a JSON 404,
  // never an HTML page (and never the SPA/static fallback below).
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found." });
  });

  // Single-service deployment (e.g. Render Free — see
  // Dockerfile.render / render.yaml): optionally serve the BUILT
  // frontend from this same process, so one service is the whole
  // product. Gated on NODE_ENV=production OR SERVE_STATIC=1 so
  // development and the e2e suites (NODE_ENV=test) behave exactly as
  // before — API-only, no static middleware at all.
  //
  // The frontend dist is the repo-root dist/. The candidates cover
  // both ways this module runs: compiled (this file is
  // server/dist/app.js → ../../dist) and via tsx (server/src/app.ts →
  // ../../dist too, and serverDir/../dist is the serverDir-based
  // equivalent); the first candidate containing an index.html wins.
  // The frontend uses hash routing, so no SPA fallback is needed
  // beyond answering GET / with index.html (express.static's index).
  const serveStatic =
    config.isProduction || (process.env.SERVE_STATIC ?? "").trim() === "1";
  if (serveStatic) {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(moduleDir, "..", "..", "dist"),
      path.resolve(serverDir, "..", "dist"),
      path.resolve(process.cwd(), "dist"),
    ];
    const frontendDist = candidates.find((dir) =>
      fs.existsSync(path.join(dir, "index.html")),
    );
    if (frontendDist) {
      app.use(express.static(frontendDist));
      app.get("/", (_req, res) => {
        res.sendFile(path.join(frontendDist, "index.html"));
      });
      console.log(`[static] serving built frontend from ${frontendDist}`);
    } else {
      console.warn(
        "[static] static serving is enabled (production or SERVE_STATIC=1) " +
          `but no built frontend was found — looked for index.html in: ${candidates.join(", ")}`,
      );
    }
  }

  // Safe error handler — never leaks stack traces or SQL details.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[api] unhandled error:", err);
    if (res.headersSent) return;
    // F-06b: body-parser reports an over-limit JSON body as
    // type "entity.too.large" with status 413 — surface that as a
    // clean 413 instead of falling through to the generic 500.
    const errRecord = (err ?? {}) as Record<string, unknown>;
    const isTooLarge =
      errRecord.type === "entity.too.large" ||
      errRecord.status === 413 ||
      errRecord.statusCode === 413;
    const status = isTooLarge
      ? 413
      : err instanceof SyntaxError && "body" in errRecord
        ? 400
        : 500;
    res.status(status).json({
      error:
        status === 413
          ? "Request body too large."
          : status === 400
            ? "Invalid request body."
            : "Something went wrong on the server.",
    });
  });

  return app;
}
