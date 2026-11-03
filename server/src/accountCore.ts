// Phase 12 shared helpers — workspaces, roles, audit log, usage
// ledger, in-app notifications, login events and TOTP MFA.
//
// These helpers are deliberately defensive: audit/usage/notification
// writes must NEVER break the user-facing flow that triggered them,
// so each swallows its own errors after logging them. Authorization
// helpers (workspaceRole etc.) are the opposite — they return facts
// and let the route decide; route code treats "no role" as no access.

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDb, type UserRow, type WorkspaceRow } from "./db.js";
import { sendEmail } from "./email.js";

export const nowIso = (): string => new Date().toISOString();
export const newId = (): string => crypto.randomUUID();
export const sha256 = (value: string): string =>
  crypto.createHash("sha256").update(value).digest("hex");

/**
 * Escape a user-controlled string for interpolation into an HTML
 * email body, so display names, workspace names, addresses and
 * notification text cannot inject markup into outgoing mail.
 * Plain-text email parts must NOT use this — they need no escaping.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---- user foundations ----------------------------------------------------

/**
 * Idempotently create everything a user needs from Phase 12 onward:
 * preferences row, personal workspace + OWNER membership, the
 * active-workspace pointer, and a Free-plan subscription. Used by the
 * v12 migration backfill AND by registration/login (new users), so
 * both paths converge on identical state.
 */
export function ensureUserFoundations(
  db: DatabaseSync,
  user: Pick<UserRow, "id" | "display_name">,
): void {
  const now = nowIso();
  db.prepare("INSERT OR IGNORE INTO user_preferences (user_id, updated_at) VALUES (?, ?)").run(
    user.id,
    now,
  );
  let personal = db
    .prepare("SELECT * FROM workspaces WHERE owner_user_id = ? AND is_personal = 1")
    .get(user.id) as WorkspaceRow | undefined;
  if (!personal) {
    const wsId = newId();
    db.prepare(
      "INSERT INTO workspaces (id, name, owner_user_id, logo_path, settings_json, status, is_personal, created_at, updated_at) VALUES (?, 'Personal', ?, NULL, '{}', 'ACTIVE', 1, ?, ?)",
    ).run(wsId, user.id, now, now);
    personal = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(wsId) as unknown as WorkspaceRow;
  }
  db.prepare(
    "INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'OWNER', ?)",
  ).run(personal.id, user.id, now);
  db.prepare(
    "UPDATE users SET active_workspace_id = ? WHERE id = ? AND (active_workspace_id IS NULL OR active_workspace_id = '')",
  ).run(personal.id, user.id);
  const freePlan = db.prepare("SELECT id FROM plans WHERE key = 'free'").get() as
    | { id: string }
    | undefined;
  if (freePlan) {
    const hasSub = db.prepare("SELECT id FROM user_subscriptions WHERE user_id = ?").get(user.id);
    if (!hasSub) {
      const subId = newId();
      db.prepare(
        "INSERT INTO user_subscriptions (id, user_id, plan_id, status, source, created_at, updated_at) VALUES (?, ?, ?, 'ACTIVE', 'registration', ?, ?)",
      ).run(subId, user.id, freePlan.id, now, now);
      db.prepare(
        "INSERT INTO subscription_events (id, user_id, subscription_id, event_type, detail_json, actor_user_id, created_at) VALUES (?, ?, ?, 'ASSIGNED', ?, NULL, ?)",
      ).run(newId(), user.id, subId, JSON.stringify({ planKey: "free", source: "registration" }), now);
    }
  }
}

// ---- workspaces & roles ----------------------------------------------------

export const ROLE_RANK: Record<string, number> = {
  VIEWER: 1,
  EDITOR: 2,
  ADMIN: 3,
  OWNER: 4,
};
export const WORKSPACE_ROLES = ["OWNER", "ADMIN", "EDITOR", "VIEWER"] as const;

export function workspaceRole(
  db: DatabaseSync,
  workspaceId: string,
  userId: string,
): string | null {
  const row = db
    .prepare("SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?")
    .get(workspaceId, userId) as { role: string } | undefined;
  return row?.role ?? null;
}

export function hasRole(
  db: DatabaseSync,
  workspaceId: string,
  userId: string,
  minRole: string,
): boolean {
  const role = workspaceRole(db, workspaceId, userId);
  if (!role) return false;
  return (ROLE_RANK[role] ?? 0) >= (ROLE_RANK[minRole] ?? 99);
}

export function getWorkspace(db: DatabaseSync, workspaceId: string): WorkspaceRow | undefined {
  return db.prepare("SELECT * FROM workspaces WHERE id = ?").get(workspaceId) as
    | WorkspaceRow
    | undefined;
}

/**
 * The caller's active workspace: the stored pointer when it still
 * names a workspace they belong to, otherwise their personal
 * workspace. Returns null only for a user with no memberships at all
 * (not expected once foundations exist).
 */
export function activeWorkspaceId(db: DatabaseSync, userId: string): string | null {
  const user = db.prepare("SELECT active_workspace_id FROM users WHERE id = ?").get(userId) as
    | { active_workspace_id: string | null }
    | undefined;
  if (user?.active_workspace_id && workspaceRole(db, user.active_workspace_id, userId)) {
    return user.active_workspace_id;
  }
  const personal = db
    .prepare(
      `SELECT w.id FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id
       WHERE w.owner_user_id = ? AND w.is_personal = 1 AND m.user_id = ?`,
    )
    .get(userId, userId) as { id: string } | undefined;
  if (personal) return personal.id;
  const anyMember = db
    .prepare("SELECT workspace_id FROM workspace_members WHERE user_id = ? ORDER BY joined_at ASC")
    .get(userId) as { workspace_id: string } | undefined;
  return anyMember?.workspace_id ?? null;
}

/** Convenience for routes in other modules (studio/editor/captions). */
export function currentWorkspaceId(userId: string): string | null {
  return activeWorkspaceId(getDb(), userId);
}

// ---- audit log ---------------------------------------------------------------

export interface AuditEntry {
  actorUserId: string | null;
  workspaceId?: string | null;
  eventType: string;
  targetType?: string | null;
  targetId?: string | null;
  result?: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

/** Append-only audit write. Never throws into the caller's flow. */
export function audit(db: DatabaseSync, entry: AuditEntry): void {
  try {
    db.prepare(
      `INSERT INTO admin_audit_log (id, actor_user_id, workspace_id, event_type, target_type, target_id, result, metadata_json, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId(),
      entry.actorUserId,
      entry.workspaceId ?? null,
      entry.eventType,
      entry.targetType ?? null,
      entry.targetId ?? null,
      entry.result ?? "SUCCESS",
      JSON.stringify(entry.metadata ?? {}),
      entry.ip ?? null,
      nowIso(),
    );
  } catch (err) {
    console.error("[account] audit write failed:", err);
  }
}

export function recordLoginEvent(
  db: DatabaseSync,
  entry: {
    userId: string | null;
    email: string;
    eventType: string;
    ip?: string | null;
    userAgent?: string | null;
  },
): void {
  try {
    db.prepare(
      "INSERT INTO login_events (id, user_id, email, event_type, ip, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      newId(),
      entry.userId,
      entry.email,
      entry.eventType,
      entry.ip ?? null,
      entry.userAgent ?? null,
      nowIso(),
    );
  } catch (err) {
    console.error("[account] login event write failed:", err);
  }
}

// ---- usage ledger --------------------------------------------------------------

export interface UsageEntry {
  userId: string;
  workspaceId?: string | null;
  projectId?: string | null;
  jobId?: string | null;
  operation: string;
  provider?: string | null;
  resource: string;
  unit: string;
  quantity: number;
  status?: string;
  entitlementKey?: string | null;
  idempotencyKey: string;
}

/**
 * Immutable, idempotent usage write: the UNIQUE idempotency_key makes
 * retries and double-completion paths record exactly one row. Never
 * throws into the caller's flow.
 */
export function recordUsage(db: DatabaseSync, entry: UsageEntry): void {
  try {
    db.prepare(
      `INSERT OR IGNORE INTO usage_ledger
       (id, user_id, workspace_id, project_id, job_id, operation, provider, resource, unit, quantity, status, entitlement_key, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId(),
      entry.userId,
      entry.workspaceId ?? null,
      entry.projectId ?? null,
      entry.jobId ?? null,
      entry.operation,
      entry.provider ?? null,
      entry.resource,
      entry.unit,
      entry.quantity,
      entry.status ?? "COMPLETED",
      entry.entitlementKey ?? null,
      entry.idempotencyKey,
      nowIso(),
    );
  } catch (err) {
    console.error("[account] usage write failed:", err);
  }
}

// ---- notifications ---------------------------------------------------------------

export const NOTIFICATION_CATEGORIES = [
  "account",
  "ai_processing",
  "publishing",
  "workspace",
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const NOTIFICATION_CATEGORY_LABELS: Record<NotificationCategory, string> = {
  account: "Account",
  ai_processing: "AI Processing",
  publishing: "Publishing",
  workspace: "Workspace",
};

interface Prefs {
  in_app: number;
  email: number;
  browser: number;
}

function notificationPrefs(db: DatabaseSync, userId: string, category: string): Prefs {
  const row = db
    .prepare("SELECT in_app, email, browser FROM notification_preferences WHERE user_id = ? AND category = ?")
    .get(userId, category) as Prefs | undefined;
  // Defaults mirror the schema defaults: in-app on, email/browser off.
  return row ?? { in_app: 1, email: 0, browser: 0 };
}

/**
 * Generate a notification from a REAL event. In-app delivery honours
 * the user's per-category preference; the email channel sends through
 * the configured email adapter (SMTP when configured, otherwise the
 * server-side outbox — the same honest delivery story as the rest of
 * the app). Never throws into the caller's flow.
 */
export function notify(
  db: DatabaseSync,
  entry: {
    userId: string;
    category: NotificationCategory;
    type: string;
    title: string;
    body?: string;
    link?: string | null;
  },
): void {
  try {
    const prefs = notificationPrefs(db, entry.userId, entry.category);
    if (prefs.in_app === 1) {
      db.prepare(
        `INSERT INTO notifications (id, user_id, category, type, title, body, link, read_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      ).run(
        newId(),
        entry.userId,
        entry.category,
        entry.type,
        entry.title,
        entry.body ?? "",
        entry.link ?? null,
        nowIso(),
      );
    }
    if (prefs.email === 1) {
      const user = db.prepare("SELECT email FROM users WHERE id = ?").get(entry.userId) as
        | { email: string }
        | undefined;
      if (user) {
        void sendEmail({
          to: user.email,
          subject: `CLIPFORGE: ${entry.title}`,
          text: `${entry.title}\n\n${entry.body ?? ""}`,
          html: `<p><strong>${escapeHtml(entry.title)}</strong></p><p>${escapeHtml(entry.body ?? "")}</p>`,
        }).catch((err) => console.error("[account] notification email failed:", err));
      }
    }
  } catch (err) {
    console.error("[account] notify failed:", err);
  }
}

// ---- TOTP (RFC 6238) -------------------------------------------------------------

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error("Invalid base32 character.");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secretBase32: string, counter: number): string {
  const key = base32Decode(secretBase32);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac("sha1", key).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const code =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, "0");
}

export function totpCode(secretBase32: string, atMs: number = Date.now()): string {
  return hotp(secretBase32, Math.floor(atMs / 1000 / 30));
}

/**
 * Match a TOTP code against the ±1 step window (clock skew),
 * timing-safe compare. Returns the 30-second step the code belongs
 * to, or null when nothing matches. Callers that persist the
 * accepted step (user_totp.last_used_step) get replay protection:
 * a code whose step is not newer than the last accepted step must
 * be rejected even while it is still inside its validity window.
 */
export function matchTotpStep(secretBase32: string, code: string): number | null {
  const clean = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(clean)) return null;
  const counter = Math.floor(Date.now() / 1000 / 30);
  for (const delta of [-1, 0, 1]) {
    const step = counter + delta;
    const expected = hotp(secretBase32, step);
    if (
      expected.length === clean.length &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(clean))
    ) {
      return step;
    }
  }
  return null;
}

/** Verify with a ±1 step window (clock skew), timing-safe compare. */
export function verifyTotp(secretBase32: string, code: string): boolean {
  return matchTotpStep(secretBase32, code) !== null;
}

/** Human-grouped recovery codes, e.g. "K7QX-9F2MA". Plaintext is shown
 *  to the user exactly once; only SHA-256 hashes are stored. */
export function generateRecoveryCodes(count = 10): string[] {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const raw = crypto.randomBytes(9);
    let s = "";
    for (const b of raw) s += chars[b % chars.length];
    codes.push(`${s.slice(0, 4)}-${s.slice(4, 8)}`);
  }
  return codes;
}

export function normalizeRecoveryCode(code: string): string {
  return code.replace(/[\s-]/g, "").toUpperCase();
}
