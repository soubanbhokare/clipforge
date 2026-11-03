// CLIPFORGE Phase 12 — Account, Workspaces, Settings, Usage, Privacy,
// Support. (Admin Console lives in admin.ts.)
//
// Honesty rules that shape this module:
//  - Email goes through the Phase 2 email adapter: SMTP when
//    configured, otherwise the server-side OUTBOX — invitation and
//    notification code never claims a delivery that did not happen.
//  - Payments stay behind the env feature flag (config.paymentsStatus)
//    with NO merchant credentials in this environment, so checkout is
//    an honest CONFIGURATION_ERROR and no invoice is ever fabricated.
//  - MFA is REAL TOTP (RFC 6238, node:crypto) with the secret
//    encrypted at rest (tokenCrypto AES-256-GCM) and single-use
//    recovery codes stored as SHA-256 hashes. Email-based MFA is not
//    offered because it is not configured.
//  - Usage rows are written by the engines themselves (accountCore
//    recordUsage) with idempotency keys; this module only reads them.

import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import multer from "multer";
import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";
import { z } from "zod";
import { config, emailConfigured, paymentsStatus } from "./config.js";
import {
  getDb,
  type NotificationRow,
  type PlanEntitlementRow,
  type PlanRow,
  type SupportTicketRow,
  type UsageLedgerRow,
  type UserPreferencesRow,
  type UserRow,
  type UserSubscriptionRow,
  type WorkspaceInvitationRow,
  type WorkspaceRow,
} from "./db.js";
import { sendEmail } from "./email.js";
import { decryptText, encryptText } from "./tokenCrypto.js";
import {
  activeWorkspaceId,
  audit,
  ensureUserFoundations,
  escapeHtml,
  generateRecoveryCodes,
  generateTotpSecret,
  hasRole,
  matchTotpStep,
  newId,
  normalizeRecoveryCode,
  notify,
  nowIso,
  recordLoginEvent,
  ROLE_RANK,
  sha256,
  totpCode,
  workspaceRole,
  WORKSPACE_ROLES,
  NOTIFICATION_CATEGORIES,
} from "./accountCore.js";
import { createSession } from "./app.js";
import { mediaPath } from "./media.js";

interface AuthedRequest extends Request {
  user?: UserRow;
  sessionId?: string;
}

type RequireAuth = (req: AuthedRequest, res: Response, next: NextFunction) => void;

const sha256Hex = sha256;

function firstZodMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Invalid request.";
}

function configError(res: Response, message: string, missing: string[]): void {
  res.status(422).json({
    error: { code: "CONFIGURATION_ERROR", message },
    missing,
  });
}

interface TotpRow {
  secret_encrypted: string;
  enabled: number;
  last_used_step: number | null;
}

/**
 * Verify a TOTP code WITH replay protection (migration v13:
 * user_totp.last_used_step). The matched 30-second step must be
 * strictly newer than the last step accepted for this user, so the
 * same code can never be replayed inside its validity window. A
 * successful verification records the step.
 */
function verifyTotpFresh(userId: string, row: TotpRow, code: string): boolean {
  let step: number | null = null;
  try {
    step = matchTotpStep(decryptText(row.secret_encrypted), code);
  } catch {
    step = null;
  }
  if (step === null) return false;
  if (row.last_used_step !== null && row.last_used_step !== undefined && step <= row.last_used_step) {
    return false;
  }
  getDb().prepare("UPDATE user_totp SET last_used_step = ? WHERE user_id = ?").run(step, userId);
  return true;
}

// ---- profile / preference serializers --------------------------------------

function publicProfile(user: UserRow) {
  const db = getDb();
  const prefs = db
    .prepare("SELECT * FROM user_preferences WHERE user_id = ?")
    .get(user.id) as UserPreferencesRow | undefined;
  return {
    id: user.id,
    displayName: user.display_name,
    email: user.email,
    emailVerified: user.email_verified_at !== null,
    hasAvatar: Boolean(user.avatar_path),
    avatarUrl: user.avatar_path ? "/api/account/avatar" : null,
    status: user.status ?? "ACTIVE",
    isAdmin: user.is_admin === 1,
    createdAt: user.created_at,
    lastLoginAt: user.last_login_at ?? null,
    language: prefs?.language ?? "en",
    timezone: prefs?.timezone ?? "UTC",
    profileCompletion: profileCompletion(user, prefs),
  };
}

function profileCompletion(user: UserRow, prefs: UserPreferencesRow | undefined): number {
  let done = 0;
  const total = 5;
  if (user.display_name.trim().length > 0) done += 1;
  if (user.email_verified_at) done += 1;
  if (user.avatar_path) done += 1;
  if (prefs && prefs.language) done += 1;
  if (prefs && prefs.timezone && prefs.timezone !== "UTC") done += 1;
  return Math.round((done / total) * 100);
}

function publicPreferences(p: UserPreferencesRow) {
  return {
    language: p.language,
    timezone: p.timezone,
    dateFormat: p.date_format,
    timeFormat: p.time_format,
    defaultAspectRatio: p.default_aspect_ratio,
    defaultExportResolution: p.default_export_resolution,
    captionLanguage: p.caption_language,
    defaultCaptionTemplateId: p.default_caption_template_id,
    defaultBrandKitId: p.default_brand_kit_id,
    defaultWorkspaceId: p.default_workspace_id,
    editorPrefs: safeJson(p.editor_prefs_json),
    updatedAt: p.updated_at,
  };
}

function safeJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function getPreferences(userId: string): UserPreferencesRow {
  const db = getDb();
  let row = db.prepare("SELECT * FROM user_preferences WHERE user_id = ?").get(userId) as
    | UserPreferencesRow
    | undefined;
  if (!row) {
    db.prepare("INSERT OR IGNORE INTO user_preferences (user_id, updated_at) VALUES (?, ?)").run(
      userId,
      nowIso(),
    );
    row = db.prepare("SELECT * FROM user_preferences WHERE user_id = ?").get(userId) as unknown as UserPreferencesRow;
  }
  return row;
}

// ---- reauthentication ---------------------------------------------------------

async function verifyCurrentPassword(user: UserRow, password: string): Promise<boolean> {
  if (!password) return false;
  return argonVerify(user.password_hash, password);
}

const reauthSchema = z.object({ currentPassword: z.string().min(1).max(200) });

// ---- image uploads (avatar / workspace logo) ------------------------------------

const IMAGE_TYPES: { ext: string; magic: (b: Buffer) => boolean }[] = [
  { ext: "png", magic: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: "jpg", magic: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    ext: "webp",
    magic: (b) =>
      b.length > 12 &&
      b.toString("ascii", 0, 4) === "RIFF" &&
      b.toString("ascii", 8, 12) === "WEBP",
  },
  { ext: "gif", magic: (b) => b.length > 6 && b.toString("ascii", 0, 3) === "GIF" },
];

function sniffImage(buf: Buffer): string | null {
  for (const t of IMAGE_TYPES) if (t.magic(buf)) return t.ext;
  return null;
}

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
});

function handleImageUpload(
  req: AuthedRequest,
  res: Response,
  dir: string,
  fileStem: string,
  previousPath: string | null,
  onSaved: (storedPath: string) => void,
): void {
  imageUpload.single("image")(req, res, (err: unknown) => {
    if (err) {
      const code = (err as { code?: string }).code;
      res.status(code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
        error:
          code === "LIMIT_FILE_SIZE"
            ? "Image is larger than the 2 MB limit."
            : "The image upload could not be read.",
      });
      return;
    }
    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file) {
      res.status(400).json({ error: "No image file was received." });
      return;
    }
    const ext = sniffImage(file.buffer);
    if (!ext) {
      res.status(400).json({ error: "Only PNG, JPEG, WebP or GIF images are accepted." });
      return;
    }
    fs.mkdirSync(dir, { recursive: true });
    const stored = path.join(dir, `${fileStem}.${ext}`);
    fs.writeFileSync(stored, file.buffer);
    if (previousPath && previousPath !== stored) {
      fs.rmSync(previousPath, { force: true });
    }
    onSaved(stored);
  });
}

// ---- workspace serializers ---------------------------------------------------

function publicWorkspace(db: ReturnType<typeof getDb>, ws: WorkspaceRow, userId: string) {
  const memberCount = (
    db.prepare("SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ?").get(ws.id) as {
      n: number;
    }
  ).n;
  return {
    id: ws.id,
    name: ws.name,
    ownerUserId: ws.owner_user_id,
    hasLogo: Boolean(ws.logo_path),
    logoUrl: ws.logo_path ? `/api/workspaces/${ws.id}/logo` : null,
    settings: safeJson(ws.settings_json),
    status: ws.status,
    isPersonal: ws.is_personal === 1,
    myRole: workspaceRole(db, ws.id, userId),
    memberCount,
    createdAt: ws.created_at,
    updatedAt: ws.updated_at,
  };
}

// ============================================================================
// Routes
// ============================================================================

export function registerAccountRoutes(app: express.Express, requireAuth: RequireAuth): void {
  const router = express.Router();

  // ---- MFA login challenge (public; the challenge token IS the credential) --
  const mfaLoginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many attempts. Please wait and try again." },
  });

  router.post("/auth/login/mfa", mfaLoginLimiter, async (req, res) => {
    const parsed = z
      .object({
        challengeToken: z.string().min(10).max(200),
        code: z.string().min(4).max(32),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstZodMessage(parsed.error) });
      return;
    }
    const db = getDb();
    const challenge = db
      .prepare("SELECT * FROM mfa_challenges WHERE id = ?")
      .get(sha256Hex(parsed.data.challengeToken)) as
      | { user_id: string; remember_me: number; expires_at: string }
      | undefined;
    if (!challenge || new Date(challenge.expires_at).getTime() <= Date.now()) {
      // Login history covers blocked attempts too, not just wrong
      // codes — recorded whenever the account is identifiable (an
      // expired challenge still names its user; a token that never
      // existed identifies nobody, so there is nothing truthful to
      // attach a history row to).
      if (challenge) {
        const expiredUser = db.prepare("SELECT id, email FROM users WHERE id = ?").get(challenge.user_id) as
          | { id: string; email: string }
          | undefined;
        if (expiredUser) {
          recordLoginEvent(db, {
            userId: expiredUser.id,
            email: expiredUser.email,
            eventType: "LOGIN_BLOCKED_INVALID_CHALLENGE",
            ip: req.ip ?? null,
            userAgent: (req.header("user-agent") ?? "").slice(0, 300) || null,
          });
        }
      }
      res.status(401).json({ error: "This sign-in challenge is invalid or has expired. Sign in again." });
      return;
    }
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(challenge.user_id) as
      | UserRow
      | undefined;
    if (!user || (user.status ?? "ACTIVE") === "SUSPENDED") {
      if (user && (user.status ?? "ACTIVE") === "SUSPENDED") {
        recordLoginEvent(db, {
          userId: user.id,
          email: user.email,
          eventType: "LOGIN_BLOCKED_SUSPENDED",
          ip: req.ip ?? null,
          userAgent: (req.header("user-agent") ?? "").slice(0, 300) || null,
        });
      }
      res.status(401).json({ error: "This sign-in challenge is invalid or has expired. Sign in again." });
      return;
    }
    // Try TOTP first (replay-protected), then a single-use recovery code.
    let ok = false;
    let usedRecovery = false;
    const totpRow = db.prepare("SELECT * FROM user_totp WHERE user_id = ?").get(user.id) as
      | TotpRow
      | undefined;
    if (totpRow?.enabled === 1) {
      ok = verifyTotpFresh(user.id, totpRow, parsed.data.code);
    }
    if (!ok) {
      const hash = sha256Hex(normalizeRecoveryCode(parsed.data.code));
      const codeRow = db
        .prepare("SELECT id FROM mfa_recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL")
        .get(user.id, hash) as { id: string } | undefined;
      if (codeRow) {
        db.prepare("UPDATE mfa_recovery_codes SET used_at = ? WHERE id = ?").run(nowIso(), codeRow.id);
        ok = true;
        usedRecovery = true;
      }
    }
    if (!ok) {
      recordLoginEvent(db, {
        userId: user.id,
        email: user.email,
        eventType: "LOGIN_MFA_FAILURE",
        ip: req.ip ?? null,
        userAgent: (req.header("user-agent") ?? "").slice(0, 300) || null,
      });
      res.status(401).json({ error: "That code did not verify. Check your authenticator app and try again." });
      return;
    }
    db.prepare("DELETE FROM mfa_challenges WHERE id = ?").run(sha256Hex(parsed.data.challengeToken));
    db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(nowIso(), user.id);
    recordLoginEvent(db, {
      userId: user.id,
      email: user.email,
      eventType: usedRecovery ? "LOGIN_MFA_RECOVERY_SUCCESS" : "LOGIN_MFA_SUCCESS",
      ip: req.ip ?? null,
      userAgent: (req.header("user-agent") ?? "").slice(0, 300) || null,
    });
    createSession(res, user.id, challenge.remember_me === 1, req);
    res.json({
      user: {
        id: user.id,
        displayName: user.display_name,
        email: user.email,
        emailVerified: user.email_verified_at !== null,
        isAdmin: user.is_admin === 1,
        status: user.status ?? "ACTIVE",
        hasAvatar: Boolean(user.avatar_path),
        createdAt: user.created_at,
      },
    });
  });

  // ---- Profile ---------------------------------------------------------------
  router.get("/account/profile", requireAuth, (req: AuthedRequest, res) => {
    ensureUserFoundations(getDb(), req.user!);
    const fresh = getDb().prepare("SELECT * FROM users WHERE id = ?").get(req.user!.id) as unknown as UserRow;
    res.json({ profile: publicProfile(fresh) });
  });

  router.patch("/account/profile", requireAuth, (req: AuthedRequest, res) => {
    const parsed = z
      .object({
        displayName: z.string().trim().min(1).max(80).optional(),
        language: z.string().trim().min(2).max(10).optional(),
        timezone: z.string().trim().min(1).max(64).optional(),
      })
      .strict()
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstZodMessage(parsed.error) });
      return;
    }
    const db = getDb();
    const user = req.user!;
    if (parsed.data.timezone && !isValidTimezone(parsed.data.timezone)) {
      res.status(400).json({ error: "That timezone is not a recognised IANA timezone." });
      return;
    }
    if (parsed.data.displayName !== undefined) {
      db.prepare("UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?").run(
        parsed.data.displayName,
        nowIso(),
        user.id,
      );
    }
    if (parsed.data.language !== undefined || parsed.data.timezone !== undefined) {
      const prefs = getPreferences(user.id);
      db.prepare("UPDATE user_preferences SET language = ?, timezone = ?, updated_at = ? WHERE user_id = ?").run(
        parsed.data.language ?? prefs.language,
        parsed.data.timezone ?? prefs.timezone,
        nowIso(),
        user.id,
      );
    }
    const fresh = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id) as unknown as UserRow;
    res.json({ profile: publicProfile(fresh) });
  });

  router.post("/account/avatar", requireAuth, (req: AuthedRequest, res) => {
    const user = req.user!;
    handleImageUpload(req, res, config.account.avatarsDir, user.id, user.avatar_path ?? null, (stored) => {
      getDb().prepare("UPDATE users SET avatar_path = ?, updated_at = ? WHERE id = ?").run(stored, nowIso(), user.id);
      res.json({ ok: true, avatarUrl: "/api/account/avatar" });
    });
  });

  router.delete("/account/avatar", requireAuth, (req: AuthedRequest, res) => {
    const user = req.user!;
    if (user.avatar_path) fs.rmSync(user.avatar_path, { force: true });
    getDb().prepare("UPDATE users SET avatar_path = NULL, updated_at = ? WHERE id = ?").run(nowIso(), user.id);
    res.json({ ok: true });
  });

  router.get("/account/avatar", requireAuth, (req: AuthedRequest, res) => {
    const user = req.user!;
    if (!user.avatar_path || !fs.existsSync(user.avatar_path)) {
      res.status(404).json({ error: "No profile image." });
      return;
    }
    res.sendFile(user.avatar_path);
  });

  // ---- Email change (verified workflow) ---------------------------------------
  router.post("/account/email-change", requireAuth, async (req: AuthedRequest, res) => {
    const parsed = z
      .object({
        newEmail: z.string().trim().toLowerCase().email().max(254),
        currentPassword: z.string().min(1).max(200),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstZodMessage(parsed.error) });
      return;
    }
    const user = req.user!;
    if (!(await verifyCurrentPassword(user, parsed.data.currentPassword))) {
      res.status(401).json({ error: "Current password is incorrect." });
      return;
    }
    const db = getDb();
    const newEmail = parsed.data.newEmail;
    // The response is IDENTICAL whether or not the new address belongs
    // to another account — only the token issuance differs, silently.
    if (newEmail !== user.email.toLowerCase()) {
      const taken = db.prepare("SELECT id FROM users WHERE email = ? AND id != ?").get(newEmail, user.id);
      if (!taken) {
        const token = crypto.randomBytes(32).toString("base64url");
        db.prepare("DELETE FROM email_change_tokens WHERE user_id = ? AND used_at IS NULL").run(user.id);
        db.prepare(
          "INSERT INTO email_change_tokens (user_id, new_email, hashed_token, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, NULL, ?)",
        ).run(user.id, newEmail, sha256Hex(token), new Date(Date.now() + 60 * 60 * 1000).toISOString(), nowIso());
        const link = `${config.appBaseUrl}/#/settings?emailChangeToken=${encodeURIComponent(token)}`;
        try {
          await sendEmail({
            to: newEmail,
            subject: "Confirm your new CLIPFORGE email address",
            text: `A change of email was requested for your CLIPFORGE account.\n\nConfirm the new address by opening this link:\n${link}\n\nThis link expires in 1 hour. If you did not request this, ignore this email — nothing will change.`,
            html: `<p>A change of email was requested for your CLIPFORGE account.</p><p>Confirm the new address:</p><p><a href="${link}">${link}</a></p><p>This link expires in 1 hour. If you did not request this, ignore this email.</p>`,
          });
        } catch (err) {
          console.error("[account] email-change email failed:", err);
        }
        // The OLD address is notified at request time — before any
        // change takes effect — so a hijacked session cannot quietly
        // move the account's email to an address the owner never sees.
        try {
          await sendEmail({
            to: user.email,
            subject: "Your CLIPFORGE email address is being changed",
            text: `A request was made to change the email address on your CLIPFORGE account from ${user.email} to ${newEmail}.\n\nA confirmation link was sent to the new address. The change takes effect only if that link is confirmed within 1 hour.\n\nIf you did NOT request this change, do not confirm the link — secure your account immediately: change your password, review your active sessions under Settings, and contact support.`,
            html: `<p>A request was made to change the email address on your CLIPFORGE account from <strong>${escapeHtml(user.email)}</strong> to <strong>${escapeHtml(newEmail)}</strong>.</p><p>A confirmation link was sent to the new address. The change takes effect only if that link is confirmed within 1 hour.</p><p>If you did <strong>not</strong> request this change, do not confirm the link — secure your account immediately: change your password, review your active sessions under Settings, and contact support.</p>`,
          });
        } catch (err) {
          console.error("[account] email-change old-address notice failed:", err);
        }
      }
    }
    // The wording is configuration-aware (an outbox record is not a
    // sent email) but never depends on whether the token was issued,
    // so the response stays enumeration-safe.
    const delivery = emailConfigured ? "smtp" : "outbox";
    res.json({
      ok: true,
      message: emailConfigured
        ? "If the new address can be used, a confirmation link has been sent to it. Your email changes only after that link is confirmed."
        : "If the new address can be used, a confirmation link has been written for it. Email delivery is not configured on this server, so the link was recorded in the server outbox rather than sent to a real inbox. Your email changes only after that link is confirmed.",
      emailConfigured,
      delivery,
      deliveryNote: emailConfigured
        ? "The confirmation email was handed to the configured SMTP server for the new address, and a notice was recorded for your current address."
        : "No SMTP server is configured: the confirmation email exists only as a server-side outbox record and was NOT delivered to the new address's inbox.",
    });
  });

  router.post("/account/email-change/confirm", requireAuth, (req: AuthedRequest, res) => {
    const parsed = z.object({ token: z.string().min(10).max(200) }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid confirmation link." });
      return;
    }
    const db = getDb();
    const row = db
      .prepare("SELECT * FROM email_change_tokens WHERE hashed_token = ?")
      .get(sha256Hex(parsed.data.token)) as
      | { id: number; user_id: string; new_email: string; expires_at: string; used_at: string | null }
      | undefined;
    if (!row || row.used_at !== null || new Date(row.expires_at).getTime() <= Date.now()) {
      res.status(400).json({ error: "This confirmation link is invalid or has expired." });
      return;
    }
    if (row.user_id !== req.user!.id) {
      res.status(403).json({ error: "This confirmation link belongs to a different account." });
      return;
    }
    const taken = db.prepare("SELECT id FROM users WHERE email = ? AND id != ?").get(row.new_email, row.user_id);
    if (taken) {
      res.status(409).json({ error: "That email address is no longer available." });
      return;
    }
    // Capture the OLD address before the overwrite — after the UPDATE
    // it exists nowhere else, and the audit record needs both sides.
    const oldEmail = req.user!.email;
    db.prepare("UPDATE email_change_tokens SET used_at = ? WHERE id = ?").run(nowIso(), row.id);
    db.prepare(
      "UPDATE users SET email = ?, email_verified_at = ?, updated_at = ? WHERE id = ?",
    ).run(row.new_email, nowIso(), nowIso(), row.user_id);
    // Every OTHER session is revoked; invitations follow the new address.
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").run(row.user_id, req.sessionId ?? "");
    audit(db, {
      actorUserId: row.user_id,
      eventType: "EMAIL_CHANGED",
      targetType: "user",
      targetId: row.user_id,
      metadata: { oldEmail, newEmail: row.new_email },
      ip: req.ip ?? null,
    });
    notify(db, {
      userId: row.user_id,
      category: "account",
      type: "EMAIL_CHANGED",
      title: "Email address changed",
      body: `Your account email is now ${row.new_email}.`,
    });
    const fresh = db.prepare("SELECT * FROM users WHERE id = ?").get(row.user_id) as unknown as UserRow;
    res.json({ profile: publicProfile(fresh) });
  });

  // ---- Preferences -------------------------------------------------------------
  const preferencesSchema = z
    .object({
      language: z.string().trim().min(2).max(10).optional(),
      timezone: z.string().trim().min(1).max(64).optional(),
      dateFormat: z.enum(["YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY", "DD MMM YYYY"]).optional(),
      timeFormat: z.enum(["24h", "12h"]).optional(),
      defaultAspectRatio: z.enum(["9:16", "16:9", "1:1", "4:5"]).optional(),
      defaultExportResolution: z.enum(["720p", "1080p", "1440p", "2160p"]).optional(),
      captionLanguage: z.string().trim().min(2).max(10).optional(),
      defaultCaptionTemplateId: z.string().max(64).nullable().optional(),
      defaultBrandKitId: z.string().max(64).nullable().optional(),
      defaultWorkspaceId: z.string().max(64).nullable().optional(),
      editorPrefs: z.record(z.string(), z.unknown()).optional(),
    })
    .strict();

  router.get("/account/preferences", requireAuth, (req: AuthedRequest, res) => {
    res.json({ preferences: publicPreferences(getPreferences(req.user!.id)) });
  });

  router.put("/account/preferences", requireAuth, (req: AuthedRequest, res) => {
    const parsed = preferencesSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstZodMessage(parsed.error) });
      return;
    }
    const d = parsed.data;
    if (d.timezone && !isValidTimezone(d.timezone)) {
      res.status(400).json({ error: "That timezone is not a recognised IANA timezone." });
      return;
    }
    const db = getDb();
    const userId = req.user!.id;
    const cur = getPreferences(userId);
    // A default brand kit must belong to the user AND live in their
    // ACTIVE workspace — a kit scoped to another workspace is rejected
    // exactly like a foreign-workspace id elsewhere. Legacy kits with
    // no workspace (workspace_id NULL) are the user's personal kits
    // and stay valid in any context, matching how the rest of the app
    // lists kits (workspace match OR unscoped-and-owned).
    if (d.defaultBrandKitId) {
      const kit = db
        .prepare(
          "SELECT id FROM brand_kits WHERE id = ? AND user_id = ? AND (workspace_id = ? OR workspace_id IS NULL)",
        )
        .get(d.defaultBrandKitId, userId, activeWorkspaceId(db, userId));
      if (!kit) {
        res.status(400).json({ error: "That brand kit does not belong to your active workspace." });
        return;
      }
    }
    if (d.defaultCaptionTemplateId) {
      const tpl = db
        .prepare("SELECT id FROM caption_templates WHERE id = ? AND (user_id = ? OR user_id IS NULL)")
        .get(d.defaultCaptionTemplateId, userId);
      if (!tpl) {
        res.status(400).json({ error: "That caption template does not exist." });
        return;
      }
    }
    if (d.defaultWorkspaceId && !workspaceRole(db, d.defaultWorkspaceId, userId)) {
      res.status(400).json({ error: "You are not a member of that workspace." });
      return;
    }
    db.prepare(
      `UPDATE user_preferences SET language = ?, timezone = ?, date_format = ?, time_format = ?,
       default_aspect_ratio = ?, default_export_resolution = ?, caption_language = ?,
       default_caption_template_id = ?, default_brand_kit_id = ?, default_workspace_id = ?,
       editor_prefs_json = ?, updated_at = ? WHERE user_id = ?`,
    ).run(
      d.language ?? cur.language,
      d.timezone ?? cur.timezone,
      d.dateFormat ?? cur.date_format,
      d.timeFormat ?? cur.time_format,
      d.defaultAspectRatio ?? cur.default_aspect_ratio,
      d.defaultExportResolution ?? cur.default_export_resolution,
      d.captionLanguage ?? cur.caption_language,
      d.defaultCaptionTemplateId !== undefined ? d.defaultCaptionTemplateId : cur.default_caption_template_id,
      d.defaultBrandKitId !== undefined ? d.defaultBrandKitId : cur.default_brand_kit_id,
      d.defaultWorkspaceId !== undefined ? d.defaultWorkspaceId : cur.default_workspace_id,
      d.editorPrefs !== undefined ? JSON.stringify(d.editorPrefs) : cur.editor_prefs_json,
      nowIso(),
      userId,
    );
    res.json({ preferences: publicPreferences(getPreferences(userId)) });
  });

  // ---- Security: password + sessions -------------------------------------------
  const passwordSchema = z
    .string()
    .min(10, "Password must be at least 10 characters long.")
    .max(200, "Password must be at most 200 characters long.")
    .regex(/[a-z]/, "Password must contain a lowercase letter.")
    .regex(/[A-Z]/, "Password must contain an uppercase letter.")
    .regex(/[0-9]/, "Password must contain a number.");

  router.post("/account/change-password", requireAuth, async (req: AuthedRequest, res) => {
    const parsed = z
      .object({
        currentPassword: z.string().min(1).max(200),
        newPassword: passwordSchema,
        confirmPassword: z.string(),
      })
      .refine((d) => d.newPassword === d.confirmPassword, {
        message: "Passwords do not match.",
        path: ["confirmPassword"],
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstZodMessage(parsed.error) });
      return;
    }
    const user = req.user!;
    if (!(await verifyCurrentPassword(user, parsed.data.currentPassword))) {
      res.status(401).json({ error: "Current password is incorrect." });
      return;
    }
    const db = getDb();
    const hash = await argonHash(parsed.data.newPassword);
    db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(hash, nowIso(), user.id);
    // Revoke every OTHER session (the spec's password-change rule).
    const revoked = db
      .prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?")
      .run(user.id, req.sessionId ?? "");
    audit(db, {
      actorUserId: user.id,
      eventType: "PASSWORD_CHANGED",
      targetType: "user",
      targetId: user.id,
      metadata: { otherSessionsRevoked: Number(revoked.changes) },
      ip: req.ip ?? null,
    });
    recordLoginEvent(db, {
      userId: user.id,
      email: user.email,
      eventType: "PASSWORD_CHANGED",
      ip: req.ip ?? null,
    });
    notify(db, {
      userId: user.id,
      category: "account",
      type: "PASSWORD_CHANGED",
      title: "Password changed",
      body: "Your password was changed and all other sessions were signed out.",
    });
    res.json({ ok: true, otherSessionsRevoked: Number(revoked.changes) });
  });

  router.get("/account/sessions", requireAuth, (req: AuthedRequest, res) => {
    const db = getDb();
    // Expired sessions are dead rows: purge this user's expired
    // sessions opportunistically on list and never present them as
    // active sign-ins.
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?").run(req.user!.id, nowIso());
    const rows = db
      .prepare("SELECT * FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC")
      .all(req.user!.id, nowIso()) as unknown as {
      id: string;
      expires_at: string;
      created_at: string;
      ip: string | null;
      user_agent: string | null;
      last_active_at: string | null;
    }[];
    res.json({
      sessions: rows.map((s) => ({
        id: s.id,
        current: s.id === req.sessionId,
        ip: s.ip,
        userAgent: s.user_agent,
        createdAt: s.created_at,
        lastActiveAt: s.last_active_at,
        expiresAt: s.expires_at,
      })),
    });
  });

  router.delete("/account/sessions/:id", requireAuth, (req: AuthedRequest, res) => {
    const db = getDb();
    const result = db
      .prepare("DELETE FROM sessions WHERE id = ? AND user_id = ?")
      .run(req.params.id, req.user!.id);
    if (Number(result.changes) === 0) {
      res.status(404).json({ error: "Session not found." });
      return;
    }
    audit(db, {
      actorUserId: req.user!.id,
      eventType: "SESSION_REVOKED",
      targetType: "session",
      targetId: req.params.id,
      ip: req.ip ?? null,
    });
    res.json({ ok: true, wasCurrent: req.params.id === req.sessionId });
  });

  router.post("/account/sessions/revoke-others", requireAuth, (req: AuthedRequest, res) => {
    const db = getDb();
    const result = db
      .prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?")
      .run(req.user!.id, req.sessionId ?? "");
    audit(db, {
      actorUserId: req.user!.id,
      eventType: "SESSIONS_REVOKED_OTHERS",
      targetType: "user",
      targetId: req.user!.id,
      metadata: { revoked: Number(result.changes) },
      ip: req.ip ?? null,
    });
    res.json({ ok: true, revoked: Number(result.changes) });
  });

  router.get("/account/login-activity", requireAuth, (req: AuthedRequest, res) => {
    const db = getDb();
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit ?? "30"), 10) || 30));
    const rows = db
      .prepare("SELECT * FROM login_events WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(req.user!.id, limit) as unknown as {
      id: string;
      event_type: string;
      ip: string | null;
      user_agent: string | null;
      created_at: string;
    }[];
    res.json({
      events: rows.map((e) => ({
        id: e.id,
        type: e.event_type,
        ip: e.ip,
        userAgent: e.user_agent,
        createdAt: e.created_at,
      })),
    });
  });

  // ---- MFA (TOTP) ---------------------------------------------------------------
  router.get("/account/mfa", requireAuth, (req: AuthedRequest, res) => {
    const db = getDb();
    const row = db.prepare("SELECT enabled, confirmed_at FROM user_totp WHERE user_id = ?").get(req.user!.id) as
      | { enabled: number; confirmed_at: string | null }
      | undefined;
    const codes = db
      .prepare("SELECT COUNT(*) AS n FROM mfa_recovery_codes WHERE user_id = ? AND used_at IS NULL")
      .get(req.user!.id) as { n: number };
    res.json({
      totp: {
        available: true,
        enabled: row?.enabled === 1,
        confirmedAt: row?.confirmed_at ?? null,
        recoveryCodesRemaining: codes.n,
      },
      // Honest: no email-MFA method is configured in this deployment.
      emailMfa: { available: false, reason: "Email-based MFA is not configured." },
    });
  });

  router.post("/account/mfa/setup", requireAuth, async (req: AuthedRequest, res) => {
    const parsed = reauthSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstZodMessage(parsed.error) });
      return;
    }
    const user = req.user!;
    if (!(await verifyCurrentPassword(user, parsed.data.currentPassword))) {
      res.status(401).json({ error: "Current password is incorrect." });
      return;
    }
    const db = getDb();
    const existing = db.prepare("SELECT enabled FROM user_totp WHERE user_id = ?").get(user.id) as
      | { enabled: number }
      | undefined;
    if (existing?.enabled === 1) {
      res.status(409).json({ error: "MFA is already enabled. Disable it first to re-enrol." });
      return;
    }
    const secret = generateTotpSecret();
    db.prepare(
      `INSERT INTO user_totp (user_id, secret_encrypted, enabled, created_at, confirmed_at)
       VALUES (?, ?, 0, ?, NULL)
       ON CONFLICT(user_id) DO UPDATE SET secret_encrypted = excluded.secret_encrypted, enabled = 0, confirmed_at = NULL, created_at = excluded.created_at, last_used_step = NULL`,
    ).run(user.id, encryptText(secret), nowIso());
    const issuer = "CLIPFORGE";
    const otpauthUrl = `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(user.email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
    // The secret is returned ONCE here so the user can enrol their
    // authenticator; afterwards only its ciphertext exists server-side.
    res.json({ secret, otpauthUrl });
  });

  router.post("/account/mfa/confirm", requireAuth, (req: AuthedRequest, res) => {
    const parsed = z.object({ code: z.string().min(6).max(10) }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstZodMessage(parsed.error) });
      return;
    }
    const db = getDb();
    const user = req.user!;
    const row = db.prepare("SELECT * FROM user_totp WHERE user_id = ?").get(user.id) as
      | TotpRow
      | undefined;
    if (!row) {
      res.status(400).json({ error: "Start MFA setup first." });
      return;
    }
    if (row.enabled === 1) {
      res.status(409).json({ error: "MFA is already enabled." });
      return;
    }
    // Confirming enrolment also consumes the code's TOTP step, so the
    // enrolment code cannot be replayed as the first sign-in code.
    const ok = verifyTotpFresh(user.id, row, parsed.data.code);
    if (!ok) {
      res.status(400).json({ error: "That code did not verify. Check your authenticator app and try again." });
      return;
    }
    db.prepare("UPDATE user_totp SET enabled = 1, confirmed_at = ? WHERE user_id = ?").run(nowIso(), user.id);
    // Fresh single-use recovery codes; shown exactly once, here.
    const codes = generateRecoveryCodes(10);
    db.prepare("DELETE FROM mfa_recovery_codes WHERE user_id = ?").run(user.id);
    const ins = db.prepare(
      "INSERT INTO mfa_recovery_codes (id, user_id, code_hash, used_at, created_at) VALUES (?, ?, ?, NULL, ?)",
    );
    for (const code of codes) {
      ins.run(newId(), user.id, sha256Hex(normalizeRecoveryCode(code)), nowIso());
    }
    audit(db, {
      actorUserId: user.id,
      eventType: "MFA_ENABLED",
      targetType: "user",
      targetId: user.id,
      ip: req.ip ?? null,
    });
    notify(db, {
      userId: user.id,
      category: "account",
      type: "MFA_ENABLED",
      title: "Two-factor authentication enabled",
      body: "TOTP MFA is now protecting your account. Store your recovery codes somewhere safe.",
    });
    res.json({ ok: true, recoveryCodes: codes });
  });

  router.post("/account/mfa/disable", requireAuth, async (req: AuthedRequest, res) => {
    const parsed = z
      .object({
        currentPassword: z.string().min(1).max(200),
        // Optional at the schema level ON PURPOSE: disabling MFA
        // removes the second factor, so a working second factor must
        // be presented — but that requirement is enforced in the
        // handler AFTER password reauth, so a wrong password surfaces
        // as 401 instead of being masked by a schema 400.
        code: z.string().min(4).max(32).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstZodMessage(parsed.error) });
      return;
    }
    const user = req.user!;
    if (!(await verifyCurrentPassword(user, parsed.data.currentPassword))) {
      res.status(401).json({ error: "Current password is incorrect." });
      return;
    }
    // The second factor is enforced only now that reauth has passed
    // (see the schema note above): no code supplied → 400 here, never
    // a schema failure ahead of the 401.
    const code = parsed.data.code;
    if (!code) {
      res.status(400).json({ error: "A verification code is required to disable MFA." });
      return;
    }
    const db = getDb();
    const row = db.prepare("SELECT * FROM user_totp WHERE user_id = ?").get(user.id) as
      | TotpRow
      | undefined;
    if (!row || row.enabled !== 1) {
      res.status(400).json({ error: "MFA is not enabled." });
      return;
    }
    // The required code is a current TOTP (replay-protected) or a
    // single-use recovery code — same acceptance as sign-in.
    let ok = verifyTotpFresh(user.id, row, code);
    if (!ok) {
      const hash = sha256Hex(normalizeRecoveryCode(code));
      const codeRow = db
        .prepare("SELECT id FROM mfa_recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL")
        .get(user.id, hash) as { id: string } | undefined;
      if (codeRow) {
        db.prepare("UPDATE mfa_recovery_codes SET used_at = ? WHERE id = ?").run(nowIso(), codeRow.id);
        ok = true;
      }
    }
    if (!ok) {
      res.status(400).json({ error: "That code did not verify." });
      return;
    }
    db.prepare("DELETE FROM user_totp WHERE user_id = ?").run(user.id);
    db.prepare("DELETE FROM mfa_recovery_codes WHERE user_id = ?").run(user.id);
    db.prepare("DELETE FROM mfa_challenges WHERE user_id = ?").run(user.id);
    audit(db, {
      actorUserId: user.id,
      eventType: "MFA_DISABLED",
      targetType: "user",
      targetId: user.id,
      ip: req.ip ?? null,
    });
    notify(db, {
      userId: user.id,
      category: "account",
      type: "MFA_DISABLED",
      title: "Two-factor authentication disabled",
      body: "TOTP MFA was disabled for your account.",
    });
    res.json({ ok: true });
  });

  router.post("/account/mfa/recovery-codes/regenerate", requireAuth, async (req: AuthedRequest, res) => {
    const parsed = reauthSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstZodMessage(parsed.error) });
      return;
    }
    const user = req.user!;
    if (!(await verifyCurrentPassword(user, parsed.data.currentPassword))) {
      res.status(401).json({ error: "Current password is incorrect." });
      return;
    }
    const db = getDb();
    const row = db.prepare("SELECT enabled FROM user_totp WHERE user_id = ?").get(user.id) as
      | { enabled: number }
      | undefined;
    if (!row || row.enabled !== 1) {
      res.status(400).json({ error: "MFA is not enabled." });
      return;
    }
    const codes = generateRecoveryCodes(10);
    db.prepare("DELETE FROM mfa_recovery_codes WHERE user_id = ?").run(user.id);
    const ins = db.prepare(
      "INSERT INTO mfa_recovery_codes (id, user_id, code_hash, used_at, created_at) VALUES (?, ?, ?, NULL, ?)",
    );
    for (const code of codes) ins.run(newId(), user.id, sha256Hex(normalizeRecoveryCode(code)), nowIso());
    audit(db, {
      actorUserId: user.id,
      eventType: "MFA_RECOVERY_CODES_REGENERATED",
      targetType: "user",
      targetId: user.id,
      ip: req.ip ?? null,
    });
    res.json({ ok: true, recoveryCodes: codes });
  });

  // ---- Connected accounts (read state from Phase 10) -------------------------
  router.get("/account/connected-accounts", requireAuth, (req: AuthedRequest, res) => {
    const db = getDb();
    const rows = db
      .prepare("SELECT id, platform, display_name, status, created_at, updated_at FROM platform_accounts WHERE user_id = ? ORDER BY platform ASC")
      .all(req.user!.id) as unknown as {
      id: string;
      platform: string;
      display_name: string | null;
      status: string;
      created_at: string;
      updated_at: string;
    }[];
    res.json({
      accounts: rows.map((a) => ({
        id: a.id,
        platform: a.platform,
        displayName: a.display_name,
        status: a.status,
        connectedAt: a.created_at,
        updatedAt: a.updated_at,
      })),
    });
  });

  // ---- Workspaces ---------------------------------------------------------------
  router.get("/workspaces", requireAuth, (req: AuthedRequest, res) => {
    const db = getDb();
    ensureUserFoundations(db, req.user!);
    const rows = db
      .prepare(
        `SELECT w.* FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id
         WHERE m.user_id = ? ORDER BY w.is_personal DESC, w.created_at ASC`,
      )
      .all(req.user!.id) as unknown as WorkspaceRow[];
    const activeId = activeWorkspaceId(db, req.user!.id);
    const prefs = getPreferences(req.user!.id);
    res.json({
      workspaces: rows.map((w) => publicWorkspace(db, w, req.user!.id)),
      activeWorkspaceId: activeId,
      defaultWorkspaceId: prefs.default_workspace_id,
    });
  });

  router.post("/workspaces", requireAuth, (req: AuthedRequest, res) => {
    const parsed = z
      .object({ name: z.string().trim().min(1).max(80) })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstZodMessage(parsed.error) });
      return;
    }
    const db = getDb();
    const ws: WorkspaceRow = {
      id: newId(),
      name: parsed.data.name,
      owner_user_id: req.user!.id,
      logo_path: null,
      settings_json: "{}",
      status: "ACTIVE",
      is_personal: 0,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    db.prepare(
      "INSERT INTO workspaces (id, name, owner_user_id, logo_path, settings_json, status, is_personal, created_at, updated_at) VALUES (?, ?, ?, NULL, '{}', 'ACTIVE', 0, ?, ?)",
    ).run(ws.id, ws.name, ws.owner_user_id, ws.created_at, ws.updated_at);
    db.prepare(
      "INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'OWNER', ?)",
    ).run(ws.id, req.user!.id, nowIso());
    audit(db, {
      actorUserId: req.user!.id,
      workspaceId: ws.id,
      eventType: "WORKSPACE_CREATED",
      targetType: "workspace",
      targetId: ws.id,
      ip: req.ip ?? null,
    });
    res.status(201).json({ workspace: publicWorkspace(db, ws, req.user!.id) });
  });

  router.get("/workspaces/:id", requireAuth, (req: AuthedRequest, res) => {
    const db = getDb();
    const ws = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(req.params.id) as
      | WorkspaceRow
      | undefined;
    if (!ws || !workspaceRole(db, ws.id, req.user!.id)) {
      res.status(404).json({ error: "Workspace not found." });
      return;
    }
    res.json({ workspace: publicWorkspace(db, ws, req.user!.id) });
  });

  router.patch("/workspaces/:id", requireAuth, (req: AuthedRequest, res) => {
    const db = getDb();
    const ws = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(req.params.id) as
      | WorkspaceRow
      | undefined;
    if (!ws || !workspaceRole(db, ws.id, req.user!.id)) {
      res.status(404).json({ error: "Workspace not found." });
      return;
    }
    if (!hasRole(db, ws.id, req.user!.id, "ADMIN")) {
      res.status(403).json({ error: "Only workspace Owners and Admins can change workspace settings." });
      return;
    }
    const parsed = z
      .object({
        name: z.string().trim().min(1).max(80).optional(),
        settings: z.record(z.string(), z.unknown()).optional(),
      })
      .strict()
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstZodMessage(parsed.error) });
      return;
    }
    db.prepare("UPDATE workspaces SET name = ?, settings_json = ?, updated_at = ? WHERE id = ?").run(
      parsed.data.name ?? ws.name,
      parsed.data.settings !== undefined ? JSON.stringify(parsed.data.settings) : ws.settings_json,
      nowIso(),
      ws.id,
    );
    const fresh = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(ws.id) as unknown as WorkspaceRow;
    res.json({ workspace: publicWorkspace(db, fresh, req.user!.id) });
  });

  router.post("/workspaces/:id/logo", requireAuth, (req: AuthedRequest, res) => {
    const db = getDb();
    const ws = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(req.params.id) as
      | WorkspaceRow
      | undefined;
    if (!ws || !workspaceRole(db, ws.id, req.user!.id)) {
      res.status(404).json({ error: "Workspace not found." });
      return;
    }
    if (!hasRole(db, ws.id, req.user!.id, "ADMIN")) {
      res.status(403).json({ error: "Only workspace Owners and Admins can change the logo." });
      return;
    }
    handleImageUpload(req, res, config.account.workspaceLogosDir, ws.id, ws.logo_path, (stored) => {
      getDb().prepare("UPDATE workspaces SET logo_path = ?, updated_at = ? WHERE id = ?").run(stored, nowIso(), ws.id);
      res.json({ ok: true, logoUrl: `/api/workspaces/${ws.id}/logo` });
    });
  });

  router.get("/workspaces/:id/logo", requireAuth, (req: AuthedRequest, res) => {
    const db = getDb();
    const ws = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(req.params.id) as
      | WorkspaceRow
      | undefined;
    if (!ws || !workspaceRole(db, ws.id, req.user!.id) || !ws.logo_path || !fs.existsSync(ws.logo_path)) {
      res.status(404).json({ error: "No workspace logo." });
      return;
    }
    res.sendFile(ws.logo_path);
  });

  router.post("/workspaces/:id/switch", requireAuth, (req: AuthedRequest, res) => {
    const db = getDb();
    const ws = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(req.params.id) as
      | WorkspaceRow
      | undefined;
    if (!ws || !workspaceRole(db, ws.id, req.user!.id)) {
      res.status(404).json({ error: "Workspace not found." });
      return;
    }
    if (ws.status === "ARCHIVED") {
      res.status(400).json({ error: "Archived workspaces cannot be made active. Unarchive it first." });
      return;
    }
    db.prepare("UPDATE users SET active_workspace_id = ? WHERE id = ?").run(ws.id, req.user!.id);
    res.json({ ok: true, activeWorkspaceId: ws.id });
  });

  router.post("/workspaces/:id/default", requireAuth, (req: AuthedRequest, res) => {
    const db = getDb();
    const ws = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(req.params.id) as
      | WorkspaceRow
      | undefined;
    if (!ws || !workspaceRole(db, ws.id, req.user!.id)) {
      res.status(404).json({ error: "Workspace not found." });
      return;
    }
    db.prepare("UPDATE user_preferences SET default_workspace_id = ?, updated_at = ? WHERE user_id = ?").run(
      ws.id,
      nowIso(),
      req.user!.id,
    );
    res.json({ ok: true, defaultWorkspaceId: ws.id });
  });

  router.post("/workspaces/:id/archive", requireAuth, (req: AuthedRequest, res) => {
    const db = getDb();
    const ws = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(req.params.id) as
      | WorkspaceRow
      | undefined;
    if (!ws || !workspaceRole(db, ws.id, req.user!.id)) {
      res.status(404).json({ error: "Workspace not found." });
      return;
    }
    if (ws.owner_user_id !== req.user!.id) {
      res.status(403).json({ error: "Only the workspace Owner can archive it." });
      return;
    }
    const parsed = z.object({ archived: z.boolean() }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstZodMessage(parsed.error) });
      return;
    }
    // The personal workspace is the account's permanent home — it
    // cannot be archived away (unarchiving it stays allowed).
    if (parsed.data.archived && ws.is_personal === 1) {
      res.status(400).json({ error: "Your personal workspace cannot be archived." });
      return;
    }
    db.prepare("UPDATE workspaces SET status = ?, updated_at = ? WHERE id = ?").run(
      parsed.data.archived ? "ARCHIVED" : "ACTIVE",
      nowIso(),
      ws.id,
    );
    // Archiving the active workspace falls back to the personal one.
    if (parsed.data.archived && activeWorkspaceId(db, req.user!.id) === ws.id) {
      const personal = db
        .prepare("SELECT id FROM workspaces WHERE owner_user_id = ? AND is_personal = 1")
        .get(req.user!.id) as { id: string } | undefined;
      if (personal && personal.id !== ws.id) {
        db.prepare("UPDATE users SET active_workspace_id = ? WHERE id = ?").run(personal.id, req.user!.id);
      }
    }
    audit(db, {
      actorUserId: req.user!.id,
      workspaceId: ws.id,
      eventType: parsed.data.archived ? "WORKSPACE_ARCHIVED" : "WORKSPACE_UNARCHIVED",
      targetType: "workspace",
      targetId: ws.id,
      ip: req.ip ?? null,
    });
    const fresh = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(ws.id) as unknown as WorkspaceRow;
    res.json({ workspace: publicWorkspace(db, fresh, req.user!.id) });
  });

  router.delete("/workspaces/:id", requireAuth, (req: AuthedRequest, res) => {
    const db = getDb();
    const ws = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(req.params.id) as
      | WorkspaceRow
      | undefined;
    if (!ws || !workspaceRole(db, ws.id, req.user!.id)) {
      res.status(404).json({ error: "Workspace not found." });
      return;
    }
    if (ws.owner_user_id !== req.user!.id) {
      res.status(403).json({ error: "Only the workspace Owner can delete it." });
      return;
    }
    // The personal workspace cannot be deleted: it is recreated empty
    // by the account foundations, which would silently lose its
    // settings — so the delete is refused outright instead.
    if (ws.is_personal === 1) {
      res.status(400).json({ error: "Your personal workspace cannot be deleted." });
      return;
    }
    const parsed = z.object({ confirmName: z.string() }).safeParse(req.body);
    if (!parsed.success || parsed.data.confirmName !== ws.name) {
      res.status(400).json({
        error: `Type the workspace name (${ws.name}) to confirm deletion.`,
        code: "CONFIRMATION_REQUIRED",
      });
      return;
    }
    const mine = db
      .prepare("SELECT COUNT(*) AS n FROM workspace_members WHERE user_id = ?")
      .get(req.user!.id) as { n: number };
    if (mine.n <= 1) {
      res.status(400).json({ error: "You cannot delete your last workspace." });
      return;
    }
    const projectCount = db
      .prepare("SELECT COUNT(*) AS n FROM projects WHERE workspace_id = ?")
      .get(ws.id) as { n: number };
    if (projectCount.n > 0) {
      res.status(409).json({
        error: `This workspace still contains ${projectCount.n} project(s). Move or delete those projects before deleting the workspace.`,
        code: "WORKSPACE_NOT_EMPTY",
      });
      return;
    }
    const kitCount = db
      .prepare("SELECT COUNT(*) AS n FROM brand_kits WHERE workspace_id = ?")
      .get(ws.id) as { n: number };
    if (kitCount.n > 0) {
      res.status(409).json({
        error: `This workspace still contains ${kitCount.n} brand kit(s). Move or delete them before deleting the workspace.`,
        code: "WORKSPACE_NOT_EMPTY",
      });
      return;
    }
    if (ws.logo_path) fs.rmSync(ws.logo_path, { force: true });
    db.prepare("DELETE FROM workspaces WHERE id = ?").run(ws.id);
    if (activeWorkspaceId(db, req.user!.id) === null) {
      ensureUserFoundations(db, req.user!);
    } else if (
      (db.prepare("SELECT active_workspace_id FROM users WHERE id = ?").get(req.user!.id) as { active_workspace_id: string | null }).active_workspace_id === ws.id
    ) {
      const personal = db
        .prepare("SELECT id FROM workspaces WHERE owner_user_id = ? AND is_personal = 1")
        .get(req.user!.id) as { id: string } | undefined;
      if (personal) db.prepare("UPDATE users SET active_workspace_id = ? WHERE id = ?").run(personal.id, req.user!.id);
    }
    audit(db, {
      actorUserId: req.user!.id,
      workspaceId: ws.id,
      eventType: "WORKSPACE_DELETED",
      targetType: "workspace",
      targetId: ws.id,
      metadata: { name: ws.name },
      ip: req.ip ?? null,
    });
    res.json({ ok: true });
  });

  // ---- Workspace members ---------------------------------------------------------
  router.get("/workspaces/:id/members", requireAuth, (req: AuthedRequest, res) => {
    const db = getDb();
    const ws = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(req.params.id) as
      | WorkspaceRow
      | undefined;
    if (!ws || !workspaceRole(db, ws.id, req.user!.id)) {
      res.status(404).json({ error: "Workspace not found." });
      return;
    }
    const members = db
      .prepare(
        `SELECT m.workspace_id, m.user_id, m.role, m.joined_at, u.display_name, u.email, u.status AS user_status
         FROM workspace_members m JOIN users u ON u.id = m.user_id
         WHERE m.workspace_id = ? ORDER BY m.joined_at ASC`,
      )
      .all(ws.id) as unknown as {
      user_id: string;
      role: string;
      joined_at: string;
      display_name: string;
      email: string;
      user_status: string;
    }[];
    const invites = db
      .prepare("SELECT * FROM workspace_invitations WHERE workspace_id = ? AND status = 'PENDING' ORDER BY created_at DESC")
      .all(ws.id) as unknown as WorkspaceInvitationRow[];
    res.json({
      members: members.map((m) => ({
        userId: m.user_id,
        displayName: m.display_name,
        email: m.email,
        role: m.role,
        status: m.user_status,
        joinedAt: m.joined_at,
      })),
      pendingInvitations: invites.map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        expiresAt: i.expires_at,
        createdAt: i.created_at,
      })),
    });
  });

  router.patch("/workspaces/:id/members/:userId", requireAuth, (req: AuthedRequest, res) => {
    const db = getDb();
    const ws = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(req.params.id) as
      | WorkspaceRow
      | undefined;
    if (!ws || !workspaceRole(db, ws.id, req.user!.id)) {
      res.status(404).json({ error: "Workspace not found." });
      return;
    }
    if (!hasRole(db, ws.id, req.user!.id, "ADMIN")) {
      res.status(403).json({ error: "Only workspace Owners and Admins can change member roles." });
      return;
    }
    const parsed = z.object({ role: z.enum(["ADMIN", "EDITOR", "VIEWER"]) }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Role must be ADMIN, EDITOR or VIEWER. Ownership is transferred only by the owner flow." });
      return;
    }
    const targetRole = workspaceRole(db, ws.id, req.params.userId);
    if (!targetRole) {
      res.status(404).json({ error: "That user is not a member of this workspace." });
      return;
    }
    if (targetRole === "OWNER") {
      res.status(400).json({ error: "The workspace Owner's role cannot be changed here." });
      return;
    }
    // An Admin cannot promote anyone above their own rank.
    const myRank = ROLE_RANK[workspaceRole(db, ws.id, req.user!.id) ?? ""] ?? 0;
    if ((ROLE_RANK[parsed.data.role] ?? 0) > myRank) {
      res.status(403).json({ error: "You cannot grant a role above your own." });
      return;
    }
    db.prepare("UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?").run(
      parsed.data.role,
      ws.id,
      req.params.userId,
    );
    audit(db, {
      actorUserId: req.user!.id,
      workspaceId: ws.id,
      eventType: "MEMBER_ROLE_CHANGED",
      targetType: "user",
      targetId: req.params.userId,
      metadata: { from: targetRole, to: parsed.data.role },
      ip: req.ip ?? null,
    });
    notify(db, {
      userId: req.params.userId,
      category: "workspace",
      type: "ROLE_CHANGED",
      title: "Your workspace role changed",
      body: `Your role in "${ws.name}" is now ${parsed.data.role}.`,
    });
    res.json({ ok: true, role: parsed.data.role });
  });

  router.delete("/workspaces/:id/members/:userId", requireAuth, (req: AuthedRequest, res) => {
    const db = getDb();
    const ws = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(req.params.id) as
      | WorkspaceRow
      | undefined;
    if (!ws || !workspaceRole(db, ws.id, req.user!.id)) {
      res.status(404).json({ error: "Workspace not found." });
      return;
    }
    const targetId = req.params.userId;
    const targetRole = workspaceRole(db, ws.id, targetId);
    if (!targetRole) {
      res.status(404).json({ error: "That user is not a member of this workspace." });
      return;
    }
    const isSelf = targetId === req.user!.id;
    if (!isSelf && !hasRole(db, ws.id, req.user!.id, "ADMIN")) {
      res.status(403).json({ error: "Only workspace Owners and Admins can remove members." });
      return;
    }
    if (targetRole === "OWNER") {
      const owners = db
        .prepare("SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ? AND role = 'OWNER'")
        .get(ws.id) as { n: number };
      if (owners.n <= 1) {
        res.status(400).json({ error: "The last workspace Owner cannot be removed." });
        return;
      }
    }
    db.prepare("DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?").run(ws.id, targetId);
    // A removed user whose active workspace this was falls back.
    const targetActive = db.prepare("SELECT active_workspace_id FROM users WHERE id = ?").get(targetId) as
      | { active_workspace_id: string | null }
      | undefined;
    if (targetActive?.active_workspace_id === ws.id) {
      const fallback = db
        .prepare("SELECT workspace_id FROM workspace_members WHERE user_id = ? ORDER BY joined_at ASC")
        .get(targetId) as { workspace_id: string } | undefined;
      db.prepare("UPDATE users SET active_workspace_id = ? WHERE id = ?").run(fallback?.workspace_id ?? null, targetId);
    }
    audit(db, {
      actorUserId: req.user!.id,
      workspaceId: ws.id,
      eventType: isSelf ? "MEMBER_LEFT" : "MEMBER_REMOVED",
      targetType: "user",
      targetId,
      ip: req.ip ?? null,
    });
    if (!isSelf) {
      notify(db, {
        userId: targetId,
        category: "workspace",
        type: "MEMBER_REMOVED",
        title: "Removed from a workspace",
        body: `You were removed from the workspace "${ws.name}".`,
      });
    }
    res.json({ ok: true });
  });

  // ---- Workspace invitations ------------------------------------------------------
  const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

  router.post("/workspaces/:id/invitations", requireAuth, async (req: AuthedRequest, res) => {
    const db = getDb();
    const ws = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(req.params.id) as
      | WorkspaceRow
      | undefined;
    if (!ws || !workspaceRole(db, ws.id, req.user!.id)) {
      res.status(404).json({ error: "Workspace not found." });
      return;
    }
    if (!hasRole(db, ws.id, req.user!.id, "ADMIN")) {
      res.status(403).json({ error: "Only workspace Owners and Admins can invite members." });
      return;
    }
    const parsed = z
      .object({
        email: z.string().trim().toLowerCase().email().max(254),
        role: z.enum(["ADMIN", "EDITOR", "VIEWER"]),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstZodMessage(parsed.error) });
      return;
    }
    const email = parsed.data.email;
    const existingUser = db.prepare("SELECT id FROM users WHERE email = ?").get(email) as
      | { id: string }
      | undefined;
    if (existingUser && workspaceRole(db, ws.id, existingUser.id)) {
      res.status(409).json({ error: "That person is already a member of this workspace." });
      return;
    }
    const pending = db
      .prepare("SELECT id FROM workspace_invitations WHERE workspace_id = ? AND email = ? AND status = 'PENDING'")
      .get(ws.id, email);
    if (pending) {
      res.status(409).json({ error: "A pending invitation already exists for that email." });
      return;
    }
    const token = crypto.randomBytes(32).toString("base64url");
    const invite: WorkspaceInvitationRow = {
      id: newId(),
      workspace_id: ws.id,
      email,
      role: parsed.data.role,
      invited_by: req.user!.id,
      hashed_token: sha256Hex(token),
      status: "PENDING",
      expires_at: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
      created_at: nowIso(),
      responded_at: null,
    };
    db.prepare(
      `INSERT INTO workspace_invitations (id, workspace_id, email, role, invited_by, hashed_token, status, expires_at, created_at, responded_at)
       VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, NULL)`,
    ).run(invite.id, invite.workspace_id, invite.email, invite.role, invite.invited_by, invite.hashed_token, invite.expires_at, invite.created_at);
    const link = `${config.appBaseUrl}/#/accept-invitation?token=${encodeURIComponent(token)}`;
    let delivery: "smtp" | "outbox" | "failed" = emailConfigured ? "smtp" : "outbox";
    try {
      await sendEmail({
        to: email,
        subject: `You are invited to the CLIPFORGE workspace "${ws.name}"`,
        text: `${req.user!.display_name} invited you to join the CLIPFORGE workspace "${ws.name}" as ${invite.role}.\n\nAccept the invitation:\n${link}\n\nThis invitation expires in 7 days. If you do not have a CLIPFORGE account yet, create one with this email address first, then open the link again.`,
        html: `<p>${escapeHtml(req.user!.display_name)} invited you to join the CLIPFORGE workspace "<strong>${escapeHtml(ws.name)}</strong>" as ${escapeHtml(invite.role)}.</p><p><a href="${link}">Accept the invitation</a></p><p>This invitation expires in 7 days. If you do not have a CLIPFORGE account yet, create one with this email address first, then open the link again.</p>`,
      });
    } catch (err) {
      console.error("[account] invitation email failed:", err);
      // Truthful failure state: the invitation record exists and stays
      // acceptable by token, but the 201 must not claim a mail
      // handoff (SMTP or outbox) that never happened.
      delivery = "failed";
    }
    audit(db, {
      actorUserId: req.user!.id,
      workspaceId: ws.id,
      eventType: "MEMBER_INVITED",
      targetType: "workspace_invitation",
      targetId: invite.id,
      metadata: { email, role: invite.role, delivery },
      ip: req.ip ?? null,
    });
    res.status(201).json({
      invitation: {
        id: invite.id,
        email: invite.email,
        role: invite.role,
        status: invite.status,
        expiresAt: invite.expires_at,
        createdAt: invite.created_at,
      },
      // HONEST delivery state: without SMTP the mail is a server-side
      // outbox file; it is NOT delivered to a real inbox — and a
      // failed send is reported as failed, never dressed as either.
      delivery,
      deliveryNote:
        delivery === "failed"
          ? "The invitation was created, but its email could not be written or sent — the delivery attempt failed. The invitation record is active and can be accepted with its token."
          : emailConfigured
            ? "The invitation email was handed to the configured SMTP server."
            : "Email delivery is not configured (no SMTP). The invitation was written to the server outbox only — it has NOT been delivered to the invitee's inbox. The invitation record is active and can be accepted with its token.",
    });
  });

  router.delete("/workspaces/:id/invitations/:inviteId", requireAuth, (req: AuthedRequest, res) => {
    const db = getDb();
    const ws = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(req.params.id) as
      | WorkspaceRow
      | undefined;
    if (!ws || !workspaceRole(db, ws.id, req.user!.id)) {
      res.status(404).json({ error: "Workspace not found." });
      return;
    }
    if (!hasRole(db, ws.id, req.user!.id, "ADMIN")) {
      res.status(403).json({ error: "Only workspace Owners and Admins can revoke invitations." });
      return;
    }
    const result = db
      .prepare("UPDATE workspace_invitations SET status = 'REVOKED', responded_at = ? WHERE id = ? AND workspace_id = ? AND status = 'PENDING'")
      .run(nowIso(), req.params.inviteId, ws.id);
    if (Number(result.changes) === 0) {
      res.status(404).json({ error: "Pending invitation not found." });
      return;
    }
    audit(db, {
      actorUserId: req.user!.id,
      workspaceId: ws.id,
      eventType: "MEMBER_INVITATION_REVOKED",
      targetType: "workspace_invitation",
      targetId: req.params.inviteId,
      ip: req.ip ?? null,
    });
    res.json({ ok: true });
  });

  const inviteTokenSchema = z.object({ token: z.string().min(10).max(200) });

  function loadInviteByToken(token: string): WorkspaceInvitationRow | undefined {
    return getDb()
      .prepare("SELECT * FROM workspace_invitations WHERE hashed_token = ?")
      .get(sha256Hex(token)) as WorkspaceInvitationRow | undefined;
  }

  router.get("/invitations/pending", requireAuth, (req: AuthedRequest, res) => {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT i.*, w.name AS workspace_name FROM workspace_invitations i JOIN workspaces w ON w.id = i.workspace_id
         WHERE i.email = ? AND i.status = 'PENDING' AND i.expires_at > ? ORDER BY i.created_at DESC`,
      )
      .all(req.user!.email.toLowerCase(), nowIso()) as unknown as (WorkspaceInvitationRow & { workspace_name: string })[];
    res.json({
      invitations: rows.map((i) => ({
        id: i.id,
        workspaceId: i.workspace_id,
        workspaceName: i.workspace_name,
        role: i.role,
        expiresAt: i.expires_at,
        createdAt: i.created_at,
      })),
    });
  });

  router.post("/invitations/accept", requireAuth, (req: AuthedRequest, res) => {
    const parsed = inviteTokenSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid invitation link." });
      return;
    }
    const db = getDb();
    const invite = loadInviteByToken(parsed.data.token);
    if (!invite || invite.status !== "PENDING") {
      res.status(400).json({ error: "This invitation is no longer valid." });
      return;
    }
    if (new Date(invite.expires_at).getTime() <= Date.now()) {
      db.prepare("UPDATE workspace_invitations SET status = 'EXPIRED' WHERE id = ?").run(invite.id);
      res.status(400).json({ error: "This invitation has expired." });
      return;
    }
    if (invite.email.toLowerCase() !== req.user!.email.toLowerCase()) {
      res.status(403).json({ error: "This invitation was sent to a different email address." });
      return;
    }
    if (workspaceRole(db, invite.workspace_id, req.user!.id)) {
      db.prepare("UPDATE workspace_invitations SET status = 'ACCEPTED', responded_at = ? WHERE id = ?").run(nowIso(), invite.id);
      res.status(409).json({ error: "You are already a member of this workspace." });
      return;
    }
    db.prepare(
      "INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)",
    ).run(invite.workspace_id, req.user!.id, invite.role, nowIso());
    db.prepare("UPDATE workspace_invitations SET status = 'ACCEPTED', responded_at = ? WHERE id = ?").run(nowIso(), invite.id);
    const ws = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(invite.workspace_id) as unknown as WorkspaceRow;
    audit(db, {
      actorUserId: req.user!.id,
      workspaceId: invite.workspace_id,
      eventType: "MEMBER_INVITATION_ACCEPTED",
      targetType: "workspace_invitation",
      targetId: invite.id,
      metadata: { role: invite.role },
      ip: req.ip ?? null,
    });
    notify(db, {
      userId: invite.invited_by,
      category: "workspace",
      type: "INVITATION_ACCEPTED",
      title: "Invitation accepted",
      body: `${req.user!.email} joined the workspace "${ws.name}" as ${invite.role}.`,
    });
    res.json({ ok: true, workspace: publicWorkspace(db, ws, req.user!.id) });
  });

  router.post("/invitations/reject", requireAuth, (req: AuthedRequest, res) => {
    const parsed = inviteTokenSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid invitation link." });
      return;
    }
    const db = getDb();
    const invite = loadInviteByToken(parsed.data.token);
    if (!invite || invite.status !== "PENDING") {
      res.status(400).json({ error: "This invitation is no longer valid." });
      return;
    }
    // Same expiry rule as accept: an expired PENDING invitation is
    // closed as EXPIRED, not silently rejected after its lifetime.
    if (new Date(invite.expires_at).getTime() <= Date.now()) {
      db.prepare("UPDATE workspace_invitations SET status = 'EXPIRED' WHERE id = ?").run(invite.id);
      res.status(400).json({ error: "This invitation has expired." });
      return;
    }
    if (invite.email.toLowerCase() !== req.user!.email.toLowerCase()) {
      res.status(403).json({ error: "This invitation was sent to a different email address." });
      return;
    }
    db.prepare("UPDATE workspace_invitations SET status = 'REJECTED', responded_at = ? WHERE id = ?").run(nowIso(), invite.id);
    audit(db, {
      actorUserId: req.user!.id,
      workspaceId: invite.workspace_id,
      eventType: "MEMBER_INVITATION_REJECTED",
      targetType: "workspace_invitation",
      targetId: invite.id,
      ip: req.ip ?? null,
    });
    res.json({ ok: true });
  });

  // ---- Notifications ---------------------------------------------------------------
  router.get("/notifications", requireAuth, (req: AuthedRequest, res) => {
    const db = getDb();
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit ?? "30"), 10) || 30));
    const rows = db
      .prepare("SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(req.user!.id, limit) as unknown as NotificationRow[];
    const unread = db
      .prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL")
      .get(req.user!.id) as { n: number };
    res.json({
      notifications: rows.map((n) => ({
        id: n.id,
        category: n.category,
        type: n.type,
        title: n.title,
        body: n.body,
        link: n.link,
        readAt: n.read_at,
        createdAt: n.created_at,
      })),
      unreadCount: unread.n,
    });
  });

  router.post("/notifications/:id/read", requireAuth, (req: AuthedRequest, res) => {
    const result = getDb()
      .prepare("UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND user_id = ?")
      .run(nowIso(), req.params.id, req.user!.id);
    if (Number(result.changes) === 0) {
      res.status(404).json({ error: "Notification not found." });
      return;
    }
    res.json({ ok: true });
  });

  router.post("/notifications/read-all", requireAuth, (req: AuthedRequest, res) => {
    const result = getDb()
      .prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL")
      .run(nowIso(), req.user!.id);
    res.json({ ok: true, marked: Number(result.changes) });
  });

  router.delete("/notifications", requireAuth, (req: AuthedRequest, res) => {
    const result = getDb().prepare("DELETE FROM notifications WHERE user_id = ?").run(req.user!.id);
    res.json({ ok: true, cleared: Number(result.changes) });
  });

  router.get("/notifications/preferences", requireAuth, (req: AuthedRequest, res) => {
    const db = getDb();
    const rows = db
      .prepare("SELECT category, in_app, email, browser FROM notification_preferences WHERE user_id = ?")
      .all(req.user!.id) as unknown as { category: string; in_app: number; email: number; browser: number }[];
    const byCategory = new Map(rows.map((r) => [r.category, r]));
    res.json({
      preferences: NOTIFICATION_CATEGORIES.map((category) => {
        const r = byCategory.get(category);
        return {
          category,
          inApp: r ? r.in_app === 1 : true,
          email: r ? r.email === 1 : false,
          browser: r ? r.browser === 1 : false,
        };
      }),
      emailDelivery: emailConfigured ? "smtp" : "outbox",
      emailDeliveryNote: emailConfigured
        ? "Email notifications are sent through the configured SMTP server."
        : "Email delivery is not configured (no SMTP): notification emails are written to the server outbox only and are not delivered to real inboxes.",
    });
  });

  router.put("/notifications/preferences", requireAuth, (req: AuthedRequest, res) => {
    const parsed = z
      .object({
        preferences: z
          .array(
            z.object({
              category: z.enum(NOTIFICATION_CATEGORIES),
              inApp: z.boolean(),
              email: z.boolean(),
              browser: z.boolean(),
            }),
          )
          .min(1)
          .max(8),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstZodMessage(parsed.error) });
      return;
    }
    const db = getDb();
    const upsert = db.prepare(
      `INSERT INTO notification_preferences (user_id, category, in_app, email, browser)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, category) DO UPDATE SET in_app = excluded.in_app, email = excluded.email, browser = excluded.browser`,
    );
    for (const p of parsed.data.preferences) {
      upsert.run(req.user!.id, p.category, p.inApp ? 1 : 0, p.email ? 1 : 0, p.browser ? 1 : 0);
    }
    res.json({ ok: true });
  });

  // ---- Usage -----------------------------------------------------------------------
  router.get("/usage/overview", requireAuth, (req: AuthedRequest, res) => {
    const db = getDb();
    const userId = req.user!.id;
    const days = Math.min(365, Math.max(1, Number.parseInt(String(req.query.days ?? "30"), 10) || 30));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const totals = db
      .prepare(
        `SELECT operation, resource, unit, SUM(quantity) AS qty, COUNT(*) AS n
         FROM usage_ledger WHERE user_id = ? AND status = 'COMPLETED' GROUP BY operation, resource, unit`,
      )
      .all(userId) as unknown as { operation: string; resource: string; unit: string; qty: number; n: number }[];
    const period = db
      .prepare(
        `SELECT operation, resource, unit, SUM(quantity) AS qty, COUNT(*) AS n
         FROM usage_ledger WHERE user_id = ? AND status = 'COMPLETED' AND created_at >= ? GROUP BY operation, resource, unit`,
      )
      .all(userId, since) as unknown as { operation: string; resource: string; unit: string; qty: number; n: number }[];
    const failed = db
      .prepare("SELECT COUNT(*) AS n FROM usage_ledger WHERE user_id = ? AND status = 'FAILED'")
      .get(userId) as { n: number };
    const byDay = db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS day, operation, SUM(quantity) AS qty, COUNT(*) AS n
         FROM usage_ledger WHERE user_id = ? AND created_at >= ? GROUP BY day, operation ORDER BY day ASC`,
      )
      .all(userId, since) as unknown as { day: string; operation: string; qty: number; n: number }[];
    // Live storage: measured from the real rows on disk-backed tables.
    const sourceBytes = db
      .prepare("SELECT COALESCE(SUM(file_size), 0) AS b FROM source_assets WHERE user_id = ?")
      .get(userId) as { b: number };
    const outputBytes = db
      .prepare("SELECT COALESCE(SUM(file_size), 0) AS b FROM export_outputs WHERE user_id = ? AND status = 'COMPLETED'")
      .get(userId) as { b: number };
    const projectMediaBytes = db
      .prepare("SELECT COALESCE(SUM(file_size), 0) AS b FROM project_media WHERE user_id = ?")
      .get(userId) as { b: number };
    const connected = db
      .prepare("SELECT COUNT(*) AS n FROM platform_accounts WHERE user_id = ? AND status = 'CONNECTED'")
      .get(userId) as { n: number };
    const published = db
      .prepare("SELECT COUNT(*) AS n FROM publish_jobs WHERE user_id = ? AND status = 'PUBLISHED'")
      .get(userId) as { n: number };
    const plan = currentPlan(db, userId);
    res.json({
      periodDays: days,
      totals,
      period,
      history: byDay,
      failedOperations: failed.n,
      storage: {
        sourceBytes: sourceBytes.b,
        outputBytes: outputBytes.b,
        projectMediaBytes: projectMediaBytes.b,
        totalBytes: sourceBytes.b + outputBytes.b + projectMediaBytes.b,
        measuredAt: nowIso(),
      },
      publishing: { publishedPosts: published.n, connectedAccounts: connected.n },
      plan: plan
        ? {
            key: plan.plan.key,
            name: plan.plan.name,
            status: plan.subscription.status,
            limits: limitsWithUsage(db, userId, plan.entitlements, since),
            limitsConfigured: plan.entitlements.some((e) => e.limit_value !== null),
          }
        : null,
      lastUpdated: nowIso(),
    });
  });

  router.get("/usage/history", requireAuth, (req: AuthedRequest, res) => {
    const db = getDb();
    const page = Math.max(1, Number.parseInt(String(req.query.page ?? "1"), 10) || 1);
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(String(req.query.pageSize ?? "25"), 10) || 25));
    const operation = typeof req.query.operation === "string" ? req.query.operation : "";
    const clauses = ["user_id = ?"];
    const params: (string | number)[] = [req.user!.id];
    if (operation) {
      clauses.push("operation = ?");
      params.push(operation);
    }
    const where = clauses.join(" AND ");
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM usage_ledger WHERE ${where}`).get(...params) as { n: number }).n;
    const rows = db
      .prepare(`SELECT * FROM usage_ledger WHERE ${where} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize) as unknown as UsageLedgerRow[];
    res.json({
      entries: rows.map((r) => ({
        id: r.id,
        workspaceId: r.workspace_id,
        projectId: r.project_id,
        jobId: r.job_id,
        operation: r.operation,
        provider: r.provider,
        resource: r.resource,
        unit: r.unit,
        quantity: r.quantity,
        status: r.status,
        createdAt: r.created_at,
      })),
      total,
      page,
      pageSize,
    });
  });

  // ---- Plans & subscription -----------------------------------------------------------
  router.get("/plans", requireAuth, (_req: AuthedRequest, res) => {
    const db = getDb();
    const plans = db.prepare("SELECT * FROM plans WHERE is_active = 1 ORDER BY created_at ASC").all() as unknown as PlanRow[];
    res.json({
      plans: plans.map((p) => publicPlan(db, p)),
      payments: paymentsStatus(),
      note: "Prices and limits are configured by an administrator. A price of null means no price has been set — CLIPFORGE never invents pricing.",
    });
  });

  router.get("/subscription", requireAuth, (req: AuthedRequest, res) => {
    const db = getDb();
    const plan = currentPlan(db, req.user!.id);
    const events = db
      .prepare("SELECT * FROM subscription_events WHERE user_id = ? ORDER BY created_at DESC LIMIT 50")
      .all(req.user!.id) as unknown as {
      id: string;
      event_type: string;
      detail_json: string;
      created_at: string;
    }[];
    const invoices = db
      .prepare("SELECT * FROM invoices WHERE user_id = ? ORDER BY created_at DESC LIMIT 50")
      .all(req.user!.id) as unknown as {
      id: string;
      amount_cents: number;
      currency: string;
      status: string;
      provider: string | null;
      issued_at: string;
    }[];
    res.json({
      subscription: plan
        ? {
            id: plan.subscription.id,
            status: plan.subscription.status,
            source: plan.subscription.source,
            currentPeriodStart: plan.subscription.current_period_start,
            currentPeriodEnd: plan.subscription.current_period_end,
            cancelRequestedAt: plan.subscription.cancel_requested_at,
            plan: publicPlan(db, plan.plan),
          }
        : null,
      history: events.map((e) => ({
        id: e.id,
        type: e.event_type,
        detail: safeJson(e.detail_json),
        createdAt: e.created_at,
      })),
      // Invoices exist only when a real provider/admin event created
      // them. With no payment provider configured this list is empty —
      // that emptiness is the honest state, not a gap to fill.
      invoices: invoices.map((i) => ({
        id: i.id,
        amountCents: i.amount_cents,
        currency: i.currency,
        status: i.status,
        provider: i.provider,
        issuedAt: i.issued_at,
      })),
      payments: paymentsStatus(),
    });
  });

  router.post("/subscription/cancel-request", requireAuth, (req: AuthedRequest, res) => {
    const db = getDb();
    const sub = db
      .prepare("SELECT * FROM user_subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(req.user!.id) as UserSubscriptionRow | undefined;
    if (!sub) {
      res.status(404).json({ error: "No subscription found." });
      return;
    }
    if (sub.status === "CANCELLATION_REQUESTED") {
      res.status(409).json({ error: "Cancellation has already been requested for this subscription." });
      return;
    }
    db.prepare(
      "UPDATE user_subscriptions SET status = 'CANCELLATION_REQUESTED', cancel_requested_at = ?, updated_at = ? WHERE id = ?",
    ).run(nowIso(), nowIso(), sub.id);
    db.prepare(
      "INSERT INTO subscription_events (id, user_id, subscription_id, event_type, detail_json, actor_user_id, created_at) VALUES (?, ?, ?, 'CANCELLATION_REQUESTED', '{}', ?, ?)",
    ).run(newId(), req.user!.id, sub.id, req.user!.id, nowIso());
    audit(db, {
      actorUserId: req.user!.id,
      eventType: "SUBSCRIPTION_CANCELLATION_REQUESTED",
      targetType: "subscription",
      targetId: sub.id,
      ip: req.ip ?? null,
    });
    res.json({
      ok: true,
      status: "CANCELLATION_REQUESTED",
      note: "This records your cancellation request. No payment provider is configured, so there is no provider-side subscription to cancel and no refund flow runs.",
    });
  });

  router.post("/subscription/checkout", requireAuth, (req: AuthedRequest, res) => {
    const status = paymentsStatus();
    if (!status.enabled) {
      configError(
        res,
        `Payments are not configured for this deployment. Missing configuration: ${status.missing.join(", ")}. No checkout was started and no charge was made.`,
        status.missing,
      );
      return;
    }
    // The env gate passed but no provider adapter is implemented in
    // this codebase — say so rather than simulating a checkout.
    configError(
      res,
      `The payment provider "${status.provider}" is flagged on but its adapter is not implemented. No checkout was started and no charge was made.`,
      [],
    );
  });

  // ---- Privacy: data export + account deletion -------------------------------------------
  router.post("/privacy/data-export", requireAuth, (req: AuthedRequest, res) => {
    const db = getDb();
    const job = {
      id: newId(),
      user_id: req.user!.id,
      status: "QUEUED",
      created_at: nowIso(),
    };
    db.prepare(
      "INSERT INTO data_export_jobs (id, user_id, status, file_path, error, created_at, completed_at) VALUES (?, ?, 'QUEUED', NULL, NULL, ?, NULL)",
    ).run(job.id, job.user_id, job.created_at);
    audit(db, {
      actorUserId: req.user!.id,
      eventType: "DATA_EXPORT_REQUESTED",
      targetType: "data_export_job",
      targetId: job.id,
      ip: req.ip ?? null,
    });
    res.status(202).json({ job: { id: job.id, status: job.status, createdAt: job.created_at } });
  });

  router.get("/privacy/data-exports", requireAuth, (req: AuthedRequest, res) => {
    const db = getDb();
    const rows = db
      .prepare("SELECT * FROM data_export_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 20")
      .all(req.user!.id) as unknown as {
      id: string;
      status: string;
      error: string | null;
      created_at: string;
      completed_at: string | null;
    }[];
    res.json({
      exports: rows.map((r) => ({
        id: r.id,
        status: r.status,
        error: r.error,
        createdAt: r.created_at,
        completedAt: r.completed_at,
        downloadUrl: r.status === "COMPLETED" ? `/api/privacy/data-exports/${r.id}/download` : null,
      })),
    });
  });

  router.get("/privacy/data-exports/:id/download", requireAuth, (req: AuthedRequest, res) => {
    const db = getDb();
    const row = db
      .prepare("SELECT * FROM data_export_jobs WHERE id = ? AND user_id = ?")
      .get(req.params.id, req.user!.id) as { status: string; file_path: string | null } | undefined;
    if (!row || row.status !== "COMPLETED" || !row.file_path || !fs.existsSync(row.file_path)) {
      res.status(404).json({ error: "Export not found or not ready." });
      return;
    }
    res.download(row.file_path, `clipforge-data-export-${req.params.id}.zip`);
  });

  router.post("/privacy/account-deletion", requireAuth, async (req: AuthedRequest, res) => {
    const parsed = z
      .object({
        currentPassword: z.string().min(1).max(200),
        confirmText: z.string(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstZodMessage(parsed.error) });
      return;
    }
    if (parsed.data.confirmText !== "DELETE") {
      res.status(400).json({ error: "Type DELETE to confirm account deletion.", code: "CONFIRMATION_REQUIRED" });
      return;
    }
    const user = req.user!;
    if (!(await verifyCurrentPassword(user, parsed.data.currentPassword))) {
      res.status(401).json({ error: "Current password is incorrect." });
      return;
    }
    const db = getDb();
    const existing = db
      .prepare("SELECT id FROM account_deletion_jobs WHERE user_id = ? AND status IN ('QUEUED', 'RUNNING')")
      .get(user.id);
    if (existing) {
      res.status(409).json({ error: "An account deletion is already in progress." });
      return;
    }
    const jobId = newId();
    db.prepare(
      "INSERT INTO account_deletion_jobs (id, user_id, status, detail_json, error, created_at, completed_at) VALUES (?, ?, 'QUEUED', '{}', NULL, ?, NULL)",
    ).run(jobId, user.id, nowIso());
    audit(db, {
      actorUserId: user.id,
      eventType: "ACCOUNT_DELETION_REQUESTED",
      targetType: "user",
      targetId: user.id,
      ip: req.ip ?? null,
    });
    res.status(202).json({
      job: { id: jobId, status: "QUEUED" },
      warning:
        "Your account, projects, media and exports stored in CLIPFORGE will be deleted. Posts already published to external platforms are NOT deleted — CLIPFORGE cannot remove content from YouTube, Instagram or TikTok.",
    });
  });

  router.get("/privacy/deletion-status", requireAuth, (req: AuthedRequest, res) => {
    const db = getDb();
    const row = db
      .prepare("SELECT * FROM account_deletion_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(req.user!.id) as
      | { id: string; status: string; detail_json: string; error: string | null; created_at: string; completed_at: string | null }
      | undefined;
    res.json({
      deletion: row
        ? {
            id: row.id,
            status: row.status,
            detail: safeJson(row.detail_json),
            error: row.error,
            createdAt: row.created_at,
            completedAt: row.completed_at,
          }
        : null,
    });
  });

  // ---- Support ----------------------------------------------------------------------------
  router.post("/support/tickets", requireAuth, (req: AuthedRequest, res) => {
    const parsed = z
      .object({
        category: z.enum(["account", "billing", "upload", "export", "publishing", "processing", "other"]),
        subject: z.string().trim().min(3).max(160),
        body: z.string().trim().min(3).max(5000),
        priority: z.enum(["LOW", "NORMAL", "HIGH"]).optional().default("NORMAL"),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstZodMessage(parsed.error) });
      return;
    }
    const db = getDb();
    const ticket: SupportTicketRow = {
      id: newId(),
      user_id: req.user!.id,
      category: parsed.data.category,
      subject: parsed.data.subject,
      status: "OPEN",
      priority: parsed.data.priority,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    db.prepare(
      "INSERT INTO support_tickets (id, user_id, category, subject, status, priority, created_at, updated_at) VALUES (?, ?, ?, ?, 'OPEN', ?, ?, ?)",
    ).run(ticket.id, ticket.user_id, ticket.category, ticket.subject, ticket.priority, ticket.created_at, ticket.updated_at);
    db.prepare(
      "INSERT INTO support_ticket_messages (id, ticket_id, author_user_id, author_kind, body, created_at) VALUES (?, ?, ?, 'USER', ?, ?)",
    ).run(newId(), ticket.id, req.user!.id, parsed.data.body, nowIso());
    res.status(201).json({
      ticket: publicTicket(ticket),
      deliveryNote:
        "No support-delivery mechanism (support inbox / helpdesk) is configured, so this ticket is stored in CLIPFORGE only — it has not been emailed anywhere. An administrator can read and reply to it in the Admin Console.",
    });
  });

  router.get("/support/tickets", requireAuth, (req: AuthedRequest, res) => {
    const db = getDb();
    const rows = db
      .prepare("SELECT * FROM support_tickets WHERE user_id = ? ORDER BY updated_at DESC")
      .all(req.user!.id) as unknown as SupportTicketRow[];
    res.json({ tickets: rows.map(publicTicket) });
  });

  router.get("/support/tickets/:id", requireAuth, (req: AuthedRequest, res) => {
    const db = getDb();
    const ticket = db
      .prepare("SELECT * FROM support_tickets WHERE id = ? AND user_id = ?")
      .get(req.params.id, req.user!.id) as SupportTicketRow | undefined;
    if (!ticket) {
      res.status(404).json({ error: "Ticket not found." });
      return;
    }
    const messages = ticketMessages(db, ticket.id);
    res.json({ ticket: { ...publicTicket(ticket), messages } });
  });

  router.post("/support/tickets/:id/messages", requireAuth, (req: AuthedRequest, res) => {
    const parsed = z.object({ body: z.string().trim().min(1).max(5000) }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstZodMessage(parsed.error) });
      return;
    }
    const db = getDb();
    const ticket = db
      .prepare("SELECT * FROM support_tickets WHERE id = ? AND user_id = ?")
      .get(req.params.id, req.user!.id) as SupportTicketRow | undefined;
    if (!ticket) {
      res.status(404).json({ error: "Ticket not found." });
      return;
    }
    if (ticket.status === "CLOSED") {
      res.status(400).json({ error: "This ticket is closed. Open a new ticket to continue." });
      return;
    }
    db.prepare(
      "INSERT INTO support_ticket_messages (id, ticket_id, author_user_id, author_kind, body, created_at) VALUES (?, ?, ?, 'USER', ?, ?)",
    ).run(newId(), ticket.id, req.user!.id, parsed.data.body, nowIso());
    db.prepare("UPDATE support_tickets SET updated_at = ? WHERE id = ?").run(nowIso(), ticket.id);
    res.status(201).json({ ok: true, messages: ticketMessages(db, ticket.id) });
  });

  app.use("/api", router);
  registerPaymentWebhook(app);
}

// ---- plan helpers ----------------------------------------------------------------

export function currentPlan(
  db: ReturnType<typeof getDb>,
  userId: string,
): { subscription: UserSubscriptionRow; plan: PlanRow; entitlements: PlanEntitlementRow[] } | null {
  const sub = db
    .prepare("SELECT * FROM user_subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(userId) as UserSubscriptionRow | undefined;
  if (!sub) return null;
  const plan = db.prepare("SELECT * FROM plans WHERE id = ?").get(sub.plan_id) as PlanRow | undefined;
  if (!plan) return null;
  const entitlements = db
    .prepare("SELECT * FROM plan_entitlements WHERE plan_id = ? ORDER BY key ASC")
    .all(plan.id) as unknown as PlanEntitlementRow[];
  return { subscription: sub, plan, entitlements };
}

export function publicPlan(db: ReturnType<typeof getDb>, plan: PlanRow) {
  const entitlements = db
    .prepare("SELECT * FROM plan_entitlements WHERE plan_id = ? ORDER BY key ASC")
    .all(plan.id) as unknown as PlanEntitlementRow[];
  return {
    id: plan.id,
    key: plan.key,
    name: plan.name,
    description: plan.description,
    // null = "not set" — rendered as such, never as a price.
    monthlyPriceCents: plan.monthly_price_cents,
    annualPriceCents: plan.annual_price_cents,
    currency: plan.currency,
    isActive: plan.is_active === 1,
    entitlements: entitlements.map((e) => ({
      key: e.key,
      limit: e.limit_value,
      featureEnabled: e.feature_enabled === null ? null : e.feature_enabled === 1,
    })),
  };
}

const PERIOD_LIMIT_KEYS: Record<string, { operations: string[]; resources: string[] }> = {
  exports_per_month: { operations: ["export", "render"], resources: ["exports"] },
  ai_processing_minutes: { operations: ["transcription", "analysis", "tracking", "enhancement"], resources: [] },
};

function limitsWithUsage(
  db: ReturnType<typeof getDb>,
  userId: string,
  entitlements: PlanEntitlementRow[],
  since: string,
): { key: string; limit: number | null; used: number | null; unit: string | null }[] {
  const storage = db
    .prepare(
      `SELECT (SELECT COALESCE(SUM(file_size),0) FROM source_assets WHERE user_id = ?)
             + (SELECT COALESCE(SUM(file_size),0) FROM export_outputs WHERE user_id = ? AND status = 'COMPLETED')
             + (SELECT COALESCE(SUM(file_size),0) FROM project_media WHERE user_id = ?) AS b`,
    )
    .get(userId, userId, userId) as { b: number };
  const connected = db
    .prepare("SELECT COUNT(*) AS n FROM platform_accounts WHERE user_id = ? AND status = 'CONNECTED'")
    .get(userId) as { n: number };
  const activeWs = activeWorkspaceId(db, userId);
  const teamMembers = activeWs
    ? (db.prepare("SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ?").get(activeWs) as { n: number }).n
    : null;
  return entitlements
    .filter((e) => e.limit_value !== null || ["storage_bytes", "connected_accounts", "team_members", "exports_per_month", "ai_processing_minutes"].includes(e.key))
    .map((e) => {
      let used: number | null = null;
      let unit: string | null = null;
      if (e.key === "storage_bytes") {
        used = storage.b;
        unit = "bytes";
      } else if (e.key === "connected_accounts") {
        used = connected.n;
        unit = "accounts";
      } else if (e.key === "team_members") {
        used = teamMembers;
        unit = "members";
      } else if (PERIOD_LIMIT_KEYS[e.key]) {
        const { operations, resources } = PERIOD_LIMIT_KEYS[e.key];
        const opPlaceholders = operations.map(() => "?").join(",");
        const resClause = resources.length
          ? `AND resource IN (${resources.map(() => "?").join(",")})`
          : "AND unit = 'seconds'";
        const row = db
          .prepare(
            `SELECT COALESCE(SUM(quantity),0) AS q FROM usage_ledger
             WHERE user_id = ? AND status = 'COMPLETED' AND created_at >= ? AND operation IN (${opPlaceholders}) ${resClause}`,
          )
          .get(userId, since, ...operations, ...resources) as { q: number };
        used = e.key === "ai_processing_minutes" ? row.q / 60 : row.q;
        unit = e.key === "ai_processing_minutes" ? "minutes" : "exports";
      }
      return { key: e.key, limit: e.limit_value, used, unit };
    });
}

function publicTicket(t: SupportTicketRow) {
  return {
    id: t.id,
    category: t.category,
    subject: t.subject,
    status: t.status,
    priority: t.priority,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}

export function ticketMessages(db: ReturnType<typeof getDb>, ticketId: string) {
  const rows = db
    .prepare("SELECT * FROM support_ticket_messages WHERE ticket_id = ? ORDER BY created_at ASC")
    .all(ticketId) as unknown as {
    id: string;
    author_user_id: string;
    author_kind: string;
    body: string;
    created_at: string;
  }[];
  return rows.map((m) => ({
    id: m.id,
    authorUserId: m.author_user_id,
    authorKind: m.author_kind,
    body: m.body,
    createdAt: m.created_at,
  }));
}

// ---- payment webhook (foundation) ---------------------------------------------------
// Mounted separately because it is signature-authenticated, not
// session-authenticated (app.ts raw-body capture covers this path).

export function registerPaymentWebhook(app: express.Express): void {
  app.post("/api/payments/webhook/:provider", (req: Request & { rawBody?: Buffer }, res) => {
    const status = paymentsStatus();
    const provider = req.params.provider.toLowerCase();
    if (!status.enabled) {
      res.status(422).json({
        error: {
          code: "CONFIGURATION_ERROR",
          message: `Payments are not configured (missing: ${status.missing.join(", ")}). The event was not processed.`,
        },
      });
      return;
    }
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const signature = req.header("x-payment-signature") ?? "";
    const expected = crypto
      .createHmac("sha256", config.account.payments.webhookSecret)
      .update(raw)
      .digest("hex");
    const valid =
      signature.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    // The raw-body middleware bypasses express.json for this path, so
    // the payload is parsed from the exact signed bytes.
    let payload = (req.body ?? {}) as { id?: string; type?: string };
    if (typeof payload.id !== "string" && raw.length > 0) {
      try {
        payload = JSON.parse(raw.toString("utf8")) as { id?: string; type?: string };
      } catch {
        /* unsigned/unparseable bodies fall through to the hash id */
      }
    }
    const eventId = typeof payload.id === "string" ? payload.id : `unknown-${sha256(raw.toString("utf8")).slice(0, 16)}`;
    const db = getDb();
    // Idempotent log: a redelivered VALIDLY-SIGNED event is
    // acknowledged, not reprocessed. An earlier INVALID attempt with
    // the same id is kept in the log (signature_valid = 0) but does
    // not poison the first genuine delivery.
    const existingValid = db
      .prepare("SELECT id FROM payment_webhook_events WHERE provider = ? AND event_id = ? AND signature_valid = 1")
      .get(provider, eventId);
    const existingAny = db
      .prepare("SELECT id FROM payment_webhook_events WHERE provider = ? AND event_id = ?")
      .get(provider, eventId);
    if (!existingAny) {
      db.prepare(
        `INSERT INTO payment_webhook_events (id, provider, event_id, event_type, signature_valid, processed, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
      ).run(newId(), provider, eventId, typeof payload.type === "string" ? payload.type : "", valid ? 1 : 0, raw.toString("utf8").slice(0, 20000), nowIso());
    } else if (valid && !existingValid) {
      // The one row per (provider, event) is upgraded by the first
      // genuine delivery: an earlier forged/invalid attempt recorded
      // signature_valid = 0 and was answered 401; the real delivery
      // must still be processed (once) and become the idempotency
      // anchor for replays.
      db.prepare(
        "UPDATE payment_webhook_events SET signature_valid = 1, event_type = ?, payload_json = ? WHERE provider = ? AND event_id = ?",
      ).run(typeof payload.type === "string" ? payload.type : "", raw.toString("utf8").slice(0, 20000), provider, eventId);
    }
    if (!valid) {
      res.status(401).json({ error: "Invalid webhook signature." });
      return;
    }
    res.json({ ok: true, duplicate: Boolean(existingValid) });
  });
}

// ---- background worker: data exports + account deletion ------------------------------

function runExecFile(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err) => (err ? reject(err) : resolve()));
  });
}

async function processDataExport(jobId: string): Promise<void> {
  const db = getDb();
  const job = db.prepare("SELECT * FROM data_export_jobs WHERE id = ?").get(jobId) as
    | { user_id: string }
    | undefined;
  if (!job) return;
  const userId = job.user_id;
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRow | undefined;
  if (!user) throw new Error("User no longer exists.");
  const dir = config.account.dataExportsDir;
  fs.mkdirSync(dir, { recursive: true });
  const staging = path.join(dir, `staging-${jobId}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const write = (name: string, data: unknown) =>
    fs.writeFileSync(path.join(staging, name), JSON.stringify(data, null, 2), "utf8");
  write("profile.json", publicProfile(user));
  write("preferences.json", publicPreferences(getPreferences(userId)));
  write(
    "workspaces.json",
    db
      .prepare(
        `SELECT w.id, w.name, w.status, w.is_personal, m.role FROM workspaces w
         JOIN workspace_members m ON m.workspace_id = w.id WHERE m.user_id = ?`,
      )
      .all(userId),
  );
  write(
    "projects.json",
    db
      .prepare("SELECT id, name, workflow_type, status, workspace_id, created_at, updated_at FROM projects WHERE user_id = ?")
      .all(userId),
  );
  write("usage.json", db.prepare("SELECT * FROM usage_ledger WHERE user_id = ? ORDER BY created_at ASC").all(userId));
  write("notifications.json", db.prepare("SELECT id, category, type, title, body, created_at FROM notifications WHERE user_id = ? ORDER BY created_at ASC").all(userId));
  write(
    "subscription.json",
    db.prepare("SELECT * FROM user_subscriptions WHERE user_id = ?").all(userId),
  );
  write(
    "support-tickets.json",
    db.prepare("SELECT * FROM support_tickets WHERE user_id = ?").all(userId),
  );
  fs.writeFileSync(
    path.join(staging, "README.txt"),
    "CLIPFORGE account data export.\nContains the account data listed in the Privacy & Data section: profile, preferences, workspace memberships, project metadata, usage ledger, notifications, subscription records and support tickets. Media files themselves are not included; download them from the app before deleting your account.\n",
    "utf8",
  );
  const zipPath = path.join(dir, `${jobId}.zip`);
  fs.rmSync(zipPath, { force: true });
  const files = fs.readdirSync(staging);
  await runExecFile("zip", ["-j", "-q", zipPath, ...files.map((f) => path.join(staging, f))]);
  fs.rmSync(staging, { recursive: true, force: true });
  db.prepare("UPDATE data_export_jobs SET status = 'COMPLETED', file_path = ?, completed_at = ? WHERE id = ?").run(
    zipPath,
    nowIso(),
    jobId,
  );
  audit(db, {
    actorUserId: userId,
    eventType: "DATA_EXPORT_COMPLETED",
    targetType: "data_export_job",
    targetId: jobId,
  });
}

async function processAccountDeletion(jobId: string): Promise<void> {
  const db = getDb();
  const job = db.prepare("SELECT * FROM account_deletion_jobs WHERE id = ?").get(jobId) as
    | { user_id: string }
    | undefined;
  if (!job) return;
  const userId = job.user_id;
  const user = db.prepare("SELECT id, email, avatar_path FROM users WHERE id = ?").get(userId) as
    | { id: string; email: string; avatar_path: string | null }
    | undefined;
  const detail: Record<string, unknown> = {};
  if (!user) {
    db.prepare("UPDATE account_deletion_jobs SET status = 'COMPLETED', detail_json = ?, completed_at = ? WHERE id = ?").run(
      JSON.stringify({ alreadyDeleted: true }),
      nowIso(),
      jobId,
    );
    return;
  }

  // 1. Cancel queued work + scheduled posts (nothing may run for a
  //    deleted account afterwards).
  const renders = db
    .prepare("UPDATE render_jobs SET status = 'CANCELLED', updated_at = ? WHERE user_id = ? AND status IN ('QUEUED', 'PAUSED')")
    .run(nowIso(), userId);
  detail.renderJobsCancelled = Number(renders.changes);
  const publishes = db
    .prepare("UPDATE publish_jobs SET status = 'CANCELLED', updated_at = ? WHERE user_id = ? AND status IN ('DRAFT', 'SCHEDULED', 'QUEUED', 'AWAITING_APPROVAL', 'VALIDATING')")
    .run(nowIso(), userId);
  detail.publishJobsCancelled = Number(publishes.changes);
  const scheduled = db
    .prepare("UPDATE scheduled_posts SET status = 'CANCELLED', updated_at = ? WHERE user_id = ? AND status = 'SCHEDULED'")
    .run(nowIso(), userId);
  detail.scheduledPostsCancelled = Number(scheduled.changes);
  const syncs = db
    .prepare("UPDATE analytics_sync_jobs SET status = 'CANCELLED', updated_at = ? WHERE user_id = ? AND status IN ('QUEUED', 'VALIDATING_ACCOUNT', 'FETCHING_ACCOUNT_DATA', 'FETCHING_POST_DATA', 'FETCHING_METRICS', 'NORMALIZING_DATA', 'SAVING_SNAPSHOTS', 'GENERATING_REPORT')")
    .run(nowIso(), userId);
  detail.analyticsSyncJobsCancelled = Number(syncs.changes);

  // 2. Disconnect platform accounts: tokens are destroyed first.
  const accounts = db.prepare("SELECT id FROM platform_accounts WHERE user_id = ?").all(userId) as unknown as { id: string }[];
  for (const account of accounts) {
    db.prepare("DELETE FROM oauth_token_records WHERE account_id = ?").run(account.id);
  }
  db.prepare("UPDATE platform_accounts SET status = 'DISCONNECTED', updated_at = ? WHERE user_id = ?").run(nowIso(), userId);
  detail.platformAccountsDisconnected = accounts.length;
  detail.externalPostsDeleted = false;
  detail.externalPostsNote = "Posts already published to external platforms are NOT deleted by this workflow.";

  // 3. Delete stored files (best effort): the user's media tree,
  //    avatar, workspace logos they own, data exports, render outputs
  //    stored outside the media tree.
  const userMediaDir = path.join(config.mediaDir, userId);
  fs.rmSync(userMediaDir, { recursive: true, force: true });
  const outputs = db
    .prepare("SELECT output_path FROM render_jobs WHERE user_id = ? AND output_path IS NOT NULL")
    .all(userId) as unknown as { output_path: string }[];
  for (const o of outputs) {
    try {
      fs.rmSync(path.isAbsolute(o.output_path) ? o.output_path : mediaPath(o.output_path), { force: true });
    } catch {
      /* best effort */
    }
  }
  if (user.avatar_path) fs.rmSync(user.avatar_path, { force: true });
  const ownedWs = db.prepare("SELECT logo_path FROM workspaces WHERE owner_user_id = ? AND logo_path IS NOT NULL").all(userId) as unknown as { logo_path: string }[];
  for (const w of ownedWs) fs.rmSync(w.logo_path, { force: true });
  const exportRows = db.prepare("SELECT file_path FROM data_export_jobs WHERE user_id = ? AND file_path IS NOT NULL").all(userId) as unknown as { file_path: string }[];
  for (const e of exportRows) fs.rmSync(e.file_path, { force: true });

  // 4. Audit retention: the deletion itself stays on record (the audit
  //    log keeps actor-less system rows + this completion row), and
  //    login events are anonymized rather than kept with the email.
  audit(db, {
    actorUserId: null,
    eventType: "ACCOUNT_DELETED",
    targetType: "user",
    targetId: userId,
    metadata: { emailDomain: user.email.split("@")[1] ?? null, ...detail },
  });
  db.prepare("UPDATE login_events SET email = 'deleted-account' WHERE user_id = ?").run(userId);

  // 5. Delete every user-owned row, then the user (FK cascades cover
  //    the rest). Dynamic table sweep keeps this correct as tables grow.
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as unknown as { name: string }[];
  // usage_ledger is in the retained set on purpose: ledger rows are
  // immutable accounting records (the same reason admin_audit_log is
  // retained), so the sweep does not delete them deliberately.
  // Retention also survives the final DELETE FROM users: migration
  // v14 (db.ts) made usage_ledger.user_id nullable with ON DELETE
  // SET NULL, so when the user row is deleted the ledger rows are
  // retained anonymised — their user_id is set to NULL rather than
  // the rows being removed.
  const skip = new Set(["account_deletion_jobs", "admin_audit_log", "login_events", "usage_ledger", "users"]);
  db.exec("BEGIN IMMEDIATE;");
  try {
    for (const t of tables) {
      if (skip.has(t.name)) continue;
      const cols = db.prepare(`PRAGMA table_info(${t.name})`).all() as unknown as { name: string }[];
      if (cols.some((c) => c.name === "user_id")) {
        db.prepare(`DELETE FROM ${t.name} WHERE user_id = ?`).run(userId);
      }
    }
    // Owned workspaces (their members/invitations cascade).
    db.prepare("DELETE FROM workspaces WHERE owner_user_id = ?").run(userId);
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    db.exec("COMMIT;");
  } catch (err) {
    db.exec("ROLLBACK;");
    throw err;
  }
  detail.recordsDeleted = true;
  db.prepare("UPDATE account_deletion_jobs SET status = 'COMPLETED', detail_json = ?, completed_at = ? WHERE id = ?").run(
    JSON.stringify(detail),
    nowIso(),
    jobId,
  );
}

let accountTick: NodeJS.Timeout | null = null;
let accountTickBusy = false;

export function startAccountWorker(): void {
  if (accountTick) return;
  const db = getDb();
  // Boot recovery: anything left RUNNING by a previous process is
  // re-queued — both job kinds are safe to re-run.
  db.prepare("UPDATE data_export_jobs SET status = 'QUEUED' WHERE status = 'RUNNING'").run();
  db.prepare("UPDATE account_deletion_jobs SET status = 'QUEUED' WHERE status = 'RUNNING'").run();
  const tick = async () => {
    if (accountTickBusy) return;
    accountTickBusy = true;
    try {
      const dbNow = getDb();
      const exportJob = dbNow.prepare("SELECT id FROM data_export_jobs WHERE status = 'QUEUED' ORDER BY created_at ASC LIMIT 1").get() as { id: string } | undefined;
      if (exportJob) {
        dbNow.prepare("UPDATE data_export_jobs SET status = 'RUNNING' WHERE id = ?").run(exportJob.id);
        try {
          await processDataExport(exportJob.id);
        } catch (err) {
          dbNow
            .prepare("UPDATE data_export_jobs SET status = 'FAILED', error = ? WHERE id = ?")
            .run(err instanceof Error ? err.message : "Export failed.", exportJob.id);
        }
      }
      const deletionJob = dbNow.prepare("SELECT id FROM account_deletion_jobs WHERE status = 'QUEUED' ORDER BY created_at ASC LIMIT 1").get() as { id: string } | undefined;
      if (deletionJob) {
        dbNow.prepare("UPDATE account_deletion_jobs SET status = 'RUNNING' WHERE id = ?").run(deletionJob.id);
        try {
          await processAccountDeletion(deletionJob.id);
        } catch (err) {
          dbNow
            .prepare("UPDATE account_deletion_jobs SET status = 'FAILED', error = ? WHERE id = ?")
            .run(err instanceof Error ? err.message : "Deletion failed.", deletionJob.id);
        }
      }
    } catch (err) {
      console.error("[account] worker tick failed:", err);
    } finally {
      accountTickBusy = false;
    }
  };
  accountTick = setInterval(() => void tick(), config.account.tickMs);
  accountTick.unref?.();
  void tick();
}

function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export { isValidTimezone };
export type { NotificationRow, PlanRow, PlanEntitlementRow, UsageLedgerRow, UserSubscriptionRow, WorkspaceRow, WorkspaceInvitationRow, SupportTicketRow };
export { publicWorkspace };
