// CLIPFORGE API — Phase 10: Social Media Publishing, Scheduling &
// Platform Integrations.
//
// What is REAL here:
//  - OAuth 2.0 against the official provider endpoints (Google /
//    Instagram Login / TikTok Login Kit): server-side state
//    validation, PKCE where supported (Google), server-side code
//    exchange, refresh where the provider issues it, revocation on
//    disconnect. Tokens are AES-256-GCM encrypted at rest
//    (tokenCrypto.ts) and NEVER leave the server.
//  - Publishing through the provider adapters in providers.ts
//    (YouTube Data API v3 resumable uploads, Instagram Graph API
//    containers, TikTok Content Posting API with creator_info
//    governing privacy). A post is reported PUBLISHED only when the
//    platform's own status says so.
//  - A DB-backed scheduling worker on the project's established
//    pattern (atomic conditional-UPDATE claims, boot recovery,
//    persisted state) — PostgreSQL/Redis/BullMQ remain the
//    documented production path, exactly as in Phases 4–9.
//
// What is NOT possible in this environment, said plainly:
//  - No provider credentials exist here (no Google OAuth client,
//    no Meta app, no TikTok client key). Until the user supplies
//    them (see server/.env.example + README), every provider
//    reports configured:false and connect/publish fail honestly
//    with 422 CONFIGURATION_ERROR naming the missing variables.
//    Nothing is faked: no sample accounts, no invented post IDs.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { config, publishingProviderStatus } from "./config.js";
import {
  getDb,
  type ExportOutputRow,
  type OAuthConnectionRow,
  type PlatformAccountRow,
  type PostAnalyticsSnapshotRow,
  type PublishAttemptRow,
  type PublishJobRow,
  type ScheduledPostRow,
  type UserRow,
} from "./db.js";
import { audit, notify, recordUsage } from "./accountCore.js";
import { mediaPath } from "./media.js";
import { decryptTokens, encryptTokens, tokenEncryptionStatus, type StoredTokens } from "./tokenCrypto.js";
import {
  getAdapter,
  isPlatform,
  ProviderError,
  redact,
  type Platform,
  type PublishInput,
  type PublishStatusResult,
} from "./providers.js";

// ---- shared helpers ---------------------------------------------------------

const nowIso = (): string => new Date().toISOString();
const newId = (): string => crypto.randomUUID();
const sha256 = (v: string): string => crypto.createHash("sha256").update(v).digest("hex");

interface AuthedRequest extends Request {
  user?: UserRow;
  rawBody?: Buffer;
}
type RequireAuth = (req: AuthedRequest, res: Response, next: NextFunction) => void;

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

function configError(res: Response, platform: Platform): void {
  const st = publishingProviderStatus(platform);
  fail(
    res,
    422,
    "CONFIGURATION_ERROR",
    `${platform} publishing is not configured on this server. Missing environment variables: ${st.missing.join(", ")}. ` +
      "Register a developer application with the platform and set them on the server (see README, Phase 10). Nothing was sent to the platform.",
  );
}

/** Same destructive-action contract as Phase 9 deletes. */
function deleteConfirmed(req: AuthedRequest): boolean {
  if (req.query.confirm === "true") return true;
  const body = (req.body ?? {}) as { confirm?: unknown };
  return body.confirm === true;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function logError(userId: string, platform: string | null, stage: string, code: string | null, message: string, jobId: string | null = null): void {
  try {
    getDb()
      .prepare(
        "INSERT INTO publishing_error_log (id, job_id, user_id, platform, stage, code, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(newId(), jobId, userId, platform, stage, code, message.slice(0, 2000), nowIso());
  } catch {
    /* logging must never break the flow it describes */
  }
}

// ---- token storage ----------------------------------------------------------

function saveTokens(account: PlatformAccountRow, tokens: StoredTokens): void {
  const db = getDb();
  const payload = encryptTokens(tokens);
  const existing = db
    .prepare("SELECT id FROM oauth_token_records WHERE account_id = ?")
    .get(account.id) as { id: string } | undefined;
  if (existing) {
    db.prepare("UPDATE oauth_token_records SET encrypted_payload = ?, updated_at = ? WHERE id = ?").run(payload, nowIso(), existing.id);
  } else {
    db.prepare(
      "INSERT INTO oauth_token_records (id, account_id, user_id, encrypted_payload, key_version, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
    ).run(newId(), account.id, account.user_id, payload, nowIso(), nowIso());
  }
  db.prepare("UPDATE platform_accounts SET token_expires_at = ?, updated_at = ? WHERE id = ?").run(
    tokens.expiresAt,
    nowIso(),
    account.id,
  );
}

export function loadTokens(accountId: string): StoredTokens | null {
  const row = getDb()
    .prepare("SELECT encrypted_payload FROM oauth_token_records WHERE account_id = ?")
    .get(accountId) as { encrypted_payload: string } | undefined;
  if (!row) return null;
  try {
    return decryptTokens(row.encrypted_payload);
  } catch {
    return null;
  }
}

function deleteTokens(accountId: string): void {
  getDb().prepare("DELETE FROM oauth_token_records WHERE account_id = ?").run(accountId);
}

/** Return a usable access token for the account, refreshing first
 *  when the stored one is expired (or within 60s of expiry), or
 *  unconditionally when forceRefresh is set (the account Refresh
 *  action — the provider may have revoked a token whose stored
 *  expiry still looks fine). Throws ProviderError(user_intervention)
 *  when re-authorization is needed. */
export async function ensureFreshTokens(account: PlatformAccountRow, forceRefresh = false): Promise<StoredTokens> {
  const tokens = loadTokens(account.id);
  if (!tokens) {
    throw new ProviderError("No stored authorization for this account — reconnect it.", {
      code: "AUTH_REQUIRED",
      errorClass: "user_intervention",
    });
  }
  const expMs = tokens.expiresAt ? new Date(tokens.expiresAt).getTime() : NaN;
  if (!forceRefresh && Number.isFinite(expMs) && expMs - Date.now() > 60_000) return tokens;
  if (!forceRefresh && !Number.isFinite(expMs) && account.platform !== "instagram") return tokens;
  // Expired (or expiry unknown): refresh. Instagram long-lived tokens
  // are refreshed via ig_refresh_token; YouTube/TikTok via refresh_token.
  const adapter = getAdapter(account.platform as Platform);
  try {
    const refreshed = await adapter.refreshTokens(tokens);
    saveTokens(account, refreshed);
    return refreshed;
  } catch (err) {
    if (err instanceof ProviderError && err.errorClass === "user_intervention") throw err;
    // A transient refresh failure with a still-valid token is survivable.
    if (Number.isFinite(expMs) && expMs > Date.now()) return tokens;
    throw err;
  }
}

export function markAccountAuthRequired(accountId: string): void {
  getDb()
    .prepare("UPDATE platform_accounts SET status = 'AUTH_REQUIRED', updated_at = ? WHERE id = ?")
    .run(nowIso(), accountId);
}

// ---- account helpers --------------------------------------------------------

export function ownedAccount(userId: string, id: string): PlatformAccountRow | undefined {
  return getDb()
    .prepare("SELECT * FROM platform_accounts WHERE id = ? AND user_id = ?")
    .get(id, userId) as PlatformAccountRow | undefined;
}

/** The ONLY account shape the API returns — no token material, ever. */
export function publicAccount(row: PlatformAccountRow) {
  const st = publishingProviderStatus(row.platform as Platform);
  return {
    id: row.id,
    platform: row.platform,
    platformAccountId: row.platform_account_id,
    username: row.username,
    displayName: row.display_name,
    profileImageUrl: row.profile_image_url,
    accountType: row.account_type,
    status: row.status,
    grantedScopes: parseJson<string[]>(row.granted_scopes_json, []),
    tokenExpiresAt: row.token_expires_at,
    lastSyncedAt: row.last_synced_at,
    providerConfigured: st.configured,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function fetchAndStoreCapabilities(account: PlatformAccountRow, tokens: StoredTokens): Promise<Record<string, unknown>> {
  const adapter = getAdapter(account.platform as Platform);
  const info = await adapter.getAccountInfo(tokens.accessToken);
  const caps = await adapter.getCapabilities(tokens.accessToken, info);
  getDb()
    .prepare(
      "INSERT INTO platform_capability_snapshots (id, account_id, user_id, platform, capabilities_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(newId(), account.id, account.user_id, account.platform, JSON.stringify(caps), nowIso());
  return caps;
}

function latestCapabilities(accountId: string): Record<string, unknown> | null {
  const row = getDb()
    .prepare("SELECT capabilities_json FROM platform_capability_snapshots WHERE account_id = ? ORDER BY fetched_at DESC LIMIT 1")
    .get(accountId) as { capabilities_json: string } | undefined;
  return row ? parseJson<Record<string, unknown>>(row.capabilities_json, {}) : null;
}

// ---- per-platform metadata (THE wire shape) ---------------------------------
// src/services/publishing.ts mirrors these schemas field for field
// (the Phase 8 lesson). Bounds here are generous on purpose: §6
// validation produces the exact, platform-specific failure reasons —
// a hard Zod max would hide them behind a generic 400.

export const youtubeMetadataSchema = z
  .object({
    title: z.string().max(1000).default(""),
    description: z.string().max(20000).default(""),
    tags: z.array(z.string().max(200)).max(100).default([]),
    categoryId: z.string().max(20).default("22"),
    privacy: z.enum(["public", "private", "unlisted"]).default("private"),
    madeForKids: z.boolean().default(false),
    containsSyntheticMedia: z.boolean().default(false),
    paidPromotion: z.boolean().default(false),
  })
  .strict();

export const instagramMetadataSchema = z
  .object({
    caption: z.string().max(10000).default(""),
    hashtags: z.array(z.string().max(200)).max(100).default([]),
    shareToFeed: z.boolean().default(true),
    thumbOffsetMs: z.number().int().min(0).max(86_400_000).nullable().default(null),
    paidPromotion: z.boolean().default(false),
  })
  .strict();

export const tiktokMetadataSchema = z
  .object({
    caption: z.string().max(10000).default(""),
    privacyLevel: z.string().max(60).default(""),
    disableComment: z.boolean().default(false),
    disableDuet: z.boolean().default(false),
    disableStitch: z.boolean().default(false),
    brandedContent: z.boolean().default(false),
    brandOrganic: z.boolean().default(false),
    creatorConsent: z.boolean().default(false),
    containsSyntheticMedia: z.boolean().default(false),
    videoCoverTimestampMs: z.number().int().min(0).max(86_400_000).nullable().default(null),
  })
  .strict();

export type YoutubeMetadata = z.infer<typeof youtubeMetadataSchema>;
export type InstagramMetadata = z.infer<typeof instagramMetadataSchema>;
export type TiktokMetadata = z.infer<typeof tiktokMetadataSchema>;
export type PlatformMetadata = YoutubeMetadata | InstagramMetadata | TiktokMetadata;

export function defaultMetadata(platform: Platform): PlatformMetadata {
  if (platform === "youtube") return youtubeMetadataSchema.parse({});
  if (platform === "instagram") return instagramMetadataSchema.parse({});
  return tiktokMetadataSchema.parse({});
}

function metadataSchema(platform: Platform) {
  return platform === "youtube"
    ? youtubeMetadataSchema
    : platform === "instagram"
      ? instagramMetadataSchema
      : tiktokMetadataSchema;
}

// ---- job helpers ------------------------------------------------------------

function ownedJob(userId: string, id: string): PublishJobRow | undefined {
  return getDb()
    .prepare("SELECT * FROM publish_jobs WHERE id = ? AND user_id = ?")
    .get(id, userId) as PublishJobRow | undefined;
}

function metadataFor(jobId: string): { metadata: Record<string, unknown>; thumbnailStorageKey: string | null } {
  const row = getDb()
    .prepare("SELECT metadata_json, thumbnail_storage_key FROM post_metadata WHERE job_id = ?")
    .get(jobId) as { metadata_json: string; thumbnail_storage_key: string | null } | undefined;
  return {
    metadata: row ? parseJson<Record<string, unknown>>(row.metadata_json, {}) : {},
    thumbnailStorageKey: row?.thumbnail_storage_key ?? null,
  };
}

function scheduleFor(jobId: string): ScheduledPostRow | undefined {
  return getDb()
    .prepare("SELECT * FROM scheduled_posts WHERE job_id = ?")
    .get(jobId) as ScheduledPostRow | undefined;
}

function publicJob(job: PublishJobRow) {
  const { metadata, thumbnailStorageKey } = metadataFor(job.id);
  const scheduleRow = scheduleFor(job.id);
  // A cancelled schedule is history, not an active schedule.
  const schedule = scheduleRow && scheduleRow.status !== "CANCELLED" ? scheduleRow : undefined;
  const post = getDb()
    .prepare("SELECT * FROM platform_posts WHERE job_id = ?")
    .get(job.id) as { platform_post_id: string; url: string | null; status: string } | undefined;
  const output = getDb()
    .prepare("SELECT id, filename, format, width, height, duration, file_size, project_id FROM export_outputs WHERE id = ?")
    .get(job.export_output_id) as
    | { id: string; filename: string; format: string; width: number | null; height: number | null; duration: number | null; file_size: number | null; project_id: string }
    | undefined;
  const account = getDb()
    .prepare("SELECT username, display_name, platform FROM platform_accounts WHERE id = ?")
    .get(job.account_id) as { username: string | null; display_name: string | null; platform: string } | undefined;
  return {
    id: job.id,
    projectId: job.project_id,
    clipId: job.clip_id,
    exportOutputId: job.export_output_id,
    export: output
      ? {
          id: output.id,
          filename: output.filename,
          format: output.format,
          width: output.width,
          height: output.height,
          duration: output.duration,
          fileSize: output.file_size,
          // The Phase 9 owner-checked download for the approval preview.
          downloadPath: `/api/export-jobs/${jobExportRenderJobId(job.export_output_id)}/download`,
        }
      : null,
    accountId: job.account_id,
    accountUsername: account?.username ?? null,
    accountDisplayName: account?.display_name ?? null,
    platform: job.platform,
    status: job.status,
    schedulingMode: job.scheduling_mode,
    schedulingLabel:
      job.scheduling_mode === "platform"
        ? `Scheduled on ${job.platform === "youtube" ? "YouTube" : "the platform"}`
        : job.scheduling_mode === "clipforge"
          ? "Scheduled in CLIPFORGE"
          : null,
    approvedAt: job.approved_at,
    rightsConfirmedAt: job.rights_confirmed_at,
    submittedAt: job.submitted_at,
    publishedAt: job.published_at,
    platformPostId: job.platform_post_id,
    publishedUrl: job.published_url,
    platformPost: post ? { postId: post.platform_post_id, url: post.url, status: post.status } : null,
    error: job.error,
    errorCode: job.error_code,
    errorClass: job.error_class,
    retryCount: job.retry_count,
    nextRetryAt: job.next_retry_at,
    ambiguous: job.ambiguous === 1,
    metadata,
    hasCustomThumbnail: Boolean(thumbnailStorageKey),
    schedule: schedule
      ? {
          id: schedule.id,
          scheduledForUtc: schedule.scheduled_for_utc,
          timezone: schedule.timezone,
          status: schedule.status,
        }
      : null,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
  };
}

function jobExportRenderJobId(exportOutputId: string): string {
  const row = getDb()
    .prepare("SELECT job_id FROM export_outputs WHERE id = ?")
    .get(exportOutputId) as { job_id: string } | undefined;
  return row?.job_id ?? "";
}

const TERMINAL_STATUSES = ["PUBLISHED", "CANCELLED"];
const EDITABLE_STATUSES = ["DRAFT", "AWAITING_APPROVAL", "FAILED", "AUTH_REQUIRED"];

// ---- validation (spec §6) ---------------------------------------------------

export interface ValidationCheck {
  id: string;
  label: string;
  ok: boolean;
  severity: "error" | "warning";
  detail: string;
}

/** Run the full per-platform validation for a job and persist the
 *  result. Blocking failures are severity "error". When the provider
 *  is configured, capabilities are refreshed live where the platform
 *  exposes them (TikTok creator_info governs privacy + duration). */
async function runValidation(
  job: PublishJobRow,
): Promise<{ ok: boolean; checks: ValidationCheck[]; authFailed: boolean }> {
  const checks: ValidationCheck[] = [];
  let authFailed = false;
  const platform = job.platform as Platform;
  const account = ownedAccount(job.user_id, job.account_id);
  const output = getDb()
    .prepare("SELECT * FROM export_outputs WHERE id = ? AND user_id = ?")
    .get(job.export_output_id, job.user_id) as ExportOutputRow | undefined;
  const { metadata, thumbnailStorageKey } = metadataFor(job.id);
  const cfg = publishingProviderStatus(platform);

  checks.push({
    id: "provider_configured",
    label: "Provider configured",
    ok: cfg.configured,
    severity: "error",
    detail: cfg.configured
      ? `${platform} OAuth credentials are configured on the server.`
      : `${platform} is not configured — missing environment variables: ${cfg.missing.join(", ")}. Publishing is unavailable until they are set.`,
  });

  checks.push({
    id: "account_connected",
    label: "Account connected",
    ok: Boolean(account) && account!.status === "CONNECTED",
    severity: "error",
    detail: !account
      ? "The target account no longer exists."
      : account.status === "CONNECTED"
        ? `Connected as ${account.username ?? account.display_name ?? account.platform_account_id}.`
        : account.status === "AUTH_REQUIRED"
          ? "The account's authorization has expired or been revoked — reconnect it before publishing."
          : "The account is disconnected.",
  });

  // Capabilities: live-refresh when possible so limits are current.
  let caps: Record<string, unknown> | null = account ? latestCapabilities(account.id) : null;
  if (account && cfg.configured && account.status === "CONNECTED") {
    try {
      const tokens = await ensureFreshTokens(account);
      caps = await fetchAndStoreCapabilities(account, tokens);
    } catch (err) {
      if (
        err instanceof ProviderError &&
        (err.errorClass === "user_intervention" || err.status === 401 || err.code === "AUTH_REQUIRED")
      ) {
        authFailed = true;
      }
      checks.push({
        id: "capabilities_fetch",
        label: "Platform capabilities",
        ok: false,
        severity: "error",
        detail: `Could not retrieve current capabilities from ${platform}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const publishScope =
    platform === "youtube"
      ? "youtube.upload"
      : platform === "instagram"
        ? "instagram_business_content_publish"
        : "video.publish";
  const scopes = account ? parseJson<string[]>(account.granted_scopes_json, []) : [];
  checks.push({
    id: "permissions",
    label: "Publishing permission granted",
    ok: scopes.some((s) => s.includes(publishScope)),
    severity: "error",
    detail: scopes.some((s) => s.includes(publishScope))
      ? `Granted scopes include ${publishScope}.`
      : `The connected account did not grant the publishing scope (${publishScope}). Reconnect and approve all requested permissions.`,
  });

  if (platform === "instagram" && caps) {
    checks.push({
      id: "account_eligible",
      label: "Account eligible to publish",
      ok: caps.publishSupported === true,
      severity: "error",
      detail:
        caps.publishSupported === true
          ? `Instagram account type ${String(caps.accountType ?? "")} can publish via the API.`
          : String(caps.unsupportedReason ?? "This account type cannot publish via the Instagram API."),
    });
  }

  // Export asset checks.
  const fileExists = Boolean(output?.storage_key) && fs.existsSync(mediaPath(output!.storage_key as string));
  checks.push({
    id: "export_ready",
    label: "Exported video available",
    ok: Boolean(output) && output!.status === "COMPLETED" && fileExists,
    severity: "error",
    detail: !output
      ? "The export no longer exists."
      : output.status !== "COMPLETED"
        ? `The export is ${output.status}, not COMPLETED — only completed, quality-checked exports can be published.`
        : !fileExists
          ? "The exported file is missing from storage."
          : `${output.filename} is present (${output.file_size ?? 0} bytes).`,
  });

  const isVideo = Boolean(output?.width && output?.height);
  checks.push({
    id: "format_supported",
    label: "Video format supported",
    ok: isVideo && (output!.format === "mp4" || output!.format === "webm"),
    severity: "error",
    detail: !isVideo
      ? "The selected export has no video stream (audio-only exports cannot be published to video platforms)."
      : output!.format === "mp4" || output!.format === "webm"
        ? `Container ${output!.format.toUpperCase()} with ${output!.video_codec ?? "unknown codec"} is accepted by ${platform}.`
        : `Container ${output!.format} is not accepted by ${platform}.`,
  });

  if (output?.width && output?.height) {
    const vertical = output.height > output.width;
    checks.push({
      id: "dimensions",
      label: "Dimensions",
      ok: true,
      severity: "warning",
      detail: `${output.width}×${output.height}${vertical ? " (vertical — Shorts/Reels friendly)" : " (not vertical — Shorts and Reels favour 9:16)"}.`,
    });
  }

  const duration = output?.duration ?? null;
  const maxDuration =
    platform === "tiktok"
      ? (typeof caps?.maxVideoPostDurationSec === "number" ? (caps.maxVideoPostDurationSec as number) : null)
      : platform === "instagram"
        ? (typeof caps?.maxDurationSec === "number" ? (caps.maxDurationSec as number) : 180)
        : null; // YouTube's ceiling (hours) never binds CLIPFORGE clips
  if (maxDuration !== null) {
    checks.push({
      id: "duration_limit",
      label: "Duration within platform limit",
      ok: duration !== null && duration <= maxDuration,
      severity: "error",
      detail:
        duration === null
          ? "The export's duration is unknown."
          : duration <= maxDuration
            ? `${duration.toFixed(1)}s is within the ${maxDuration}s limit${platform === "tiktok" ? " reported by TikTok creator info" : ""}.`
            : `${duration.toFixed(1)}s exceeds the ${maxDuration}s limit${platform === "tiktok" ? " reported by TikTok creator info for this creator" : ""}. Trim the clip and re-export.`,
    });
  }

  const maxSize = typeof caps?.maxFileSizeBytes === "number" ? (caps.maxFileSizeBytes as number) : null;
  if (maxSize !== null && output?.file_size != null) {
    checks.push({
      id: "file_size_limit",
      label: "File size within platform limit",
      ok: output.file_size <= maxSize,
      severity: "error",
      detail:
        output.file_size <= maxSize
          ? `${output.file_size} bytes is within the ${maxSize}-byte limit.`
          : `${output.file_size} bytes exceeds the ${maxSize}-byte platform limit.`,
    });
  }

  // Metadata limits — exact field-level reasons.
  if (platform === "youtube") {
    const m = metadata as YoutubeMetadata;
    const maxTitle = typeof caps?.maxTitleChars === "number" ? (caps.maxTitleChars as number) : 100;
    const maxDesc = typeof caps?.maxDescriptionChars === "number" ? (caps.maxDescriptionChars as number) : 5000;
    const tagsTotal = (m.tags ?? []).join(",").length;
    checks.push({
      id: "metadata_limits",
      label: "Metadata within YouTube limits",
      ok: m.title.trim().length > 0 && m.title.length <= maxTitle && (m.description ?? "").length <= maxDesc && tagsTotal <= 500,
      severity: "error",
      detail:
        m.title.trim().length === 0
          ? "Title is empty — YouTube requires a title."
          : m.title.length > maxTitle
            ? `Title is ${m.title.length} characters; YouTube allows at most ${maxTitle}.`
            : (m.description ?? "").length > maxDesc
              ? `Description is ${(m.description ?? "").length} characters; YouTube allows at most ${maxDesc}.`
              : tagsTotal > 500
                ? `Tags total ${tagsTotal} characters; YouTube allows at most 500 across all tags.`
                : "Title, description and tags are within limits.",
    });
  } else if (platform === "instagram") {
    const m = metadata as InstagramMetadata;
    const maxCaption = typeof caps?.maxCaptionChars === "number" ? (caps.maxCaptionChars as number) : 2200;
    const fullCaption = (m.caption ?? "") + ((m.hashtags ?? []).length ? `\n\n${(m.hashtags ?? []).join(" ")}` : "");
    checks.push({
      id: "metadata_limits",
      label: "Caption within Instagram limits",
      ok: fullCaption.trim().length > 0 && fullCaption.length <= maxCaption,
      severity: "error",
      detail:
        fullCaption.trim().length === 0
          ? "Caption is empty."
          : fullCaption.length > maxCaption
            ? `Caption + hashtags total ${fullCaption.length} characters; Instagram allows at most ${maxCaption}.`
            : "Caption is within limits.",
    });
  } else {
    const m = metadata as TiktokMetadata;
    const maxCaption = typeof caps?.maxCaptionChars === "number" ? (caps.maxCaptionChars as number) : 2200;
    const options = Array.isArray(caps?.privacyLevelOptions) ? (caps.privacyLevelOptions as string[]) : [];
    checks.push({
      id: "metadata_limits",
      label: "Caption within TikTok limits",
      ok: (m.caption ?? "").length <= maxCaption,
      severity: "error",
      detail:
        (m.caption ?? "").length > maxCaption
          ? `Caption is ${(m.caption ?? "").length} characters; TikTok allows at most ${maxCaption}.`
          : "Caption is within limits.",
    });
    checks.push({
      id: "privacy_available",
      label: "Privacy option available for this creator",
      ok: !m.privacyLevel || options.length === 0 || options.includes(m.privacyLevel),
      severity: "error",
      detail: !m.privacyLevel
        ? "No privacy level selected — pick one of the options TikTok returns for this creator."
        : options.length === 0
          ? "TikTok creator info has not been retrieved yet — it will be fetched and enforced at submission."
          : options.includes(m.privacyLevel)
            ? `${m.privacyLevel} is among the privacy options TikTok returned for this creator (${options.join(", ")}).`
            : `${m.privacyLevel} is NOT available for this creator. TikTok returned: ${options.join(", ")}.${options.length === 1 && options[0] === "SELF_ONLY" ? " This client appears to be unaudited, which TikTok restricts to private (SELF_ONLY) posts." : ""}`,
    });
    checks.push({
      id: "creator_consent",
      label: "Creator consent confirmed",
      ok: m.creatorConsent === true,
      severity: "error",
      detail:
        m.creatorConsent === true
          ? "The creator-consent confirmation required by TikTok's posting guidelines is recorded."
          : "TikTok's content-sharing guidelines require the creator's consent confirmation before posting. Tick the consent box in the TikTok metadata editor.",
    });
  }

  if (thumbnailStorageKey) {
    checks.push({
      id: "thumbnail",
      label: "Custom thumbnail",
      ok: platform === "youtube" && fs.existsSync(mediaPath(thumbnailStorageKey)),
      severity: "error",
      detail:
        platform !== "youtube"
          ? "Custom thumbnails are only supported for YouTube in this integration."
          : fs.existsSync(mediaPath(thumbnailStorageKey))
            ? "Thumbnail image is stored and will be uploaded after the video."
            : "The thumbnail file is missing from storage.",
    });
  }

  checks.push({
    id: "rights",
    label: "Media rights",
    ok: Boolean(job.rights_confirmed_at),
    severity: "warning",
    detail: job.rights_confirmed_at
      ? "You confirmed you own or are authorised to distribute this media."
      : "Not yet confirmed — publishing requires confirming you own or are authorised to distribute this media (checked at approval). CLIPFORGE never adds a watermark to uploads.",
  });

  const ok = checks.every((c) => c.ok || c.severity !== "error");
  getDb()
    .prepare(
      "INSERT INTO post_validation_results (id, job_id, user_id, ok, checks_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(newId(), job.id, job.user_id, ok ? 1 : 0, JSON.stringify(checks), nowIso());
  return { ok, checks, authFailed };
}

function latestValidation(jobId: string): { ok: boolean; checks: ValidationCheck[]; createdAt: string } | null {
  const row = getDb()
    .prepare("SELECT ok, checks_json, created_at FROM post_validation_results WHERE job_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(jobId) as { ok: number; checks_json: string; created_at: string } | undefined;
  if (!row) return null;
  return { ok: row.ok === 1, checks: parseJson<ValidationCheck[]>(row.checks_json, []), createdAt: row.created_at };
}

// ---- timezone helpers -------------------------------------------------------

/** Offset (ms) of `timeZone` at the given UTC instant, via Intl. */
function tzOffsetMs(timeZone: string, utcDate: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(utcDate)) parts[p.type] = p.value;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - utcDate.getTime();
}

/** Convert a wall-clock time in `timeZone` ("2026-11-03T10:00" or with
 *  seconds) to a UTC ISO string. Handles DST by double-passing the
 *  offset computation. */
export function localToUtc(localIso: string, timeZone: string): string {
  const naive = new Date(`${localIso.length === 16 ? `${localIso}:00` : localIso}Z`);
  if (Number.isNaN(naive.getTime())) throw new Error(`Invalid local time: ${localIso}`);
  const off1 = tzOffsetMs(timeZone, naive);
  let utc = new Date(naive.getTime() - off1);
  const off2 = tzOffsetMs(timeZone, utc);
  if (off2 !== off1) utc = new Date(naive.getTime() - off2);
  return utc.toISOString();
}

// ---- attempts ---------------------------------------------------------------

function insertAttempt(job: PublishJobRow, kind: string): PublishAttemptRow {
  const count = getDb()
    .prepare("SELECT COUNT(*) AS n FROM publish_attempts WHERE job_id = ?")
    .get(job.id) as { n: number };
  const row: PublishAttemptRow = {
    id: newId(),
    job_id: job.id,
    user_id: job.user_id,
    attempt_no: count.n + 1,
    kind,
    status: "STARTED",
    provider_request_id: null,
    provider_response_json: null,
    error: null,
    created_at: nowIso(),
  };
  getDb()
    .prepare(
      "INSERT INTO publish_attempts (id, job_id, user_id, attempt_no, kind, status, provider_request_id, provider_response_json, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(row.id, row.job_id, row.user_id, row.attempt_no, row.kind, row.status, null, null, null, row.created_at);
  return row;
}

function updateAttempt(
  attemptId: string,
  patch: Partial<Pick<PublishAttemptRow, "status" | "provider_request_id" | "provider_response_json" | "error">>,
): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    sets.push(`${k} = ?`);
    values.push(v ?? null);
  }
  if (sets.length === 0) return;
  values.push(attemptId);
  getDb().prepare(`UPDATE publish_attempts SET ${sets.join(", ")} WHERE id = ?`).run(...(values as never[]));
  // Phase 12: every finished provider attempt lands in the usage
  // ledger (idempotent per attempt id — retries create new attempts,
  // and a re-written attempt row can never double-record). Failed
  // attempts record quantity 0 like every other engine — the row
  // keeps the attempt visible in the ledger without inflating the
  // totals that quota/usage summaries read.
  if (patch.status === "SUCCEEDED" || patch.status === "FAILED") {
    const attempt = getDb()
      .prepare("SELECT * FROM publish_attempts WHERE id = ?")
      .get(attemptId) as PublishAttemptRow | undefined;
    if (attempt) {
      const job = getDb()
        .prepare("SELECT user_id, project_id FROM publish_jobs WHERE id = ?")
        .get(attempt.job_id) as { user_id: string; project_id: string | null } | undefined;
      if (job) {
        recordUsage(getDb(), {
          userId: job.user_id,
          operation: "publish_attempt",
          resource: "publish_job",
          quantity: patch.status === "SUCCEEDED" ? 1 : 0,
          unit: "attempts",
          idempotencyKey: `publish-attempt:${attemptId}:finished`,
          jobId: attempt.job_id,
          projectId: job.project_id ?? undefined,
          status: patch.status === "SUCCEEDED" ? "COMPLETED" : "FAILED",
        });
      }
    }
  }
}

function lastAttempt(jobId: string): PublishAttemptRow | undefined {
  return getDb()
    .prepare("SELECT * FROM publish_attempts WHERE job_id = ? ORDER BY attempt_no DESC LIMIT 1")
    .get(jobId) as PublishAttemptRow | undefined;
}

function setJobStatus(jobId: string, status: string, patch: Record<string, unknown> = {}): void {
  const sets = ["status = ?", "updated_at = ?"];
  const values: unknown[] = [status, nowIso()];
  for (const [k, v] of Object.entries(patch)) {
    sets.push(`${k} = ?`);
    values.push(v ?? null);
  }
  values.push(jobId);
  getDb().prepare(`UPDATE publish_jobs SET ${sets.join(", ")} WHERE id = ?`).run(...(values as never[]));
  // Phase 12: terminal publish outcomes feed the usage ledger and
  // the in-app notification centre (idempotent per job + outcome).
  if (status === "PUBLISHED" || status === "FAILED") {
    const job = getDb()
      .prepare("SELECT * FROM publish_jobs WHERE id = ?")
      .get(jobId) as PublishJobRow | undefined;
    if (job) {
      if (status === "PUBLISHED") {
        recordUsage(getDb(), {
          userId: job.user_id,
          operation: "publish",
          resource: "publish_job",
          quantity: 1,
          unit: "posts",
          idempotencyKey: `publish:${jobId}:published`,
          jobId,
          projectId: job.project_id ?? undefined,
          status: "COMPLETED",
        });
      }
      notify(getDb(), {
        userId: job.user_id,
        category: "publishing",
        type: status === "PUBLISHED" ? "publish.succeeded" : "publish.failed",
        title:
          status === "PUBLISHED"
            ? `Published to ${job.platform}`
            : `Publishing to ${job.platform} failed`,
        body: (job as { caption?: string | null }).caption?.slice(0, 200) ?? undefined,
        link: "#/publishing",
      });
      audit(getDb(), {
        actorUserId: job.user_id,
        eventType: status === "PUBLISHED" ? "PUBLISH_SUCCEEDED" : "PUBLISH_FAILED",
        targetType: "publish_job",
        targetId: jobId,
        metadata: { platform: job.platform },
      });
    }
  }
}

// ---- status application -----------------------------------------------------

function applyPublished(job: PublishJobRow, result: PublishStatusResult): void {
  const db = getDb();
  const postId = result.postId ?? job.platform_post_id;
  if (!postId) return; // cannot honestly mark published without a platform id
  const existing = db.prepare("SELECT id FROM platform_posts WHERE job_id = ?").get(job.id) as { id: string } | undefined;
  if (!existing) {
    db.prepare(
      "INSERT INTO platform_posts (id, job_id, user_id, account_id, platform, platform_post_id, url, status, raw_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'PUBLISHED', ?, ?, ?)",
    ).run(newId(), job.id, job.user_id, job.account_id, job.platform, postId, result.postUrl, JSON.stringify(redact(result.raw ?? {})), nowIso(), nowIso());
  } else {
    db.prepare("UPDATE platform_posts SET platform_post_id = ?, url = ?, updated_at = ? WHERE id = ?").run(
      postId,
      result.postUrl,
      nowIso(),
      existing.id,
    );
  }
  setJobStatus(job.id, "PUBLISHED", {
    platform_post_id: postId,
    published_url: result.postUrl,
    published_at: job.published_at ?? nowIso(),
    error: null,
    error_code: null,
    error_class: null,
    ambiguous: 0,
  });
  // Analytics foundation (§14): a snapshot row exists from publish
  // time with NULL metrics — "unavailable", never a fabricated zero.
  const post = db.prepare("SELECT id FROM platform_posts WHERE job_id = ?").get(job.id) as { id: string };
  const snap = db
    .prepare("SELECT id FROM post_analytics_snapshots WHERE platform_post_id = ?")
    .get(post.id) as { id: string } | undefined;
  if (!snap) {
    db.prepare(
      "INSERT INTO post_analytics_snapshots (id, platform_post_id, user_id, platform, views, likes, comments, shares, metrics_status, metric_source, last_synced_at, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, 'unavailable', NULL, NULL, ?, ?)",
    ).run(newId(), post.id, job.user_id, job.platform, nowIso(), nowIso());
  }
  void syncMetricsForJob(job.id).catch(() => undefined);
}

async function syncMetricsForJob(jobId: string): Promise<void> {
  const job = getDb().prepare("SELECT * FROM publish_jobs WHERE id = ?").get(jobId) as unknown as PublishJobRow | undefined;
  if (!job || job.status !== "PUBLISHED" || !job.platform_post_id) return;
  const account = ownedAccount(job.user_id, job.account_id);
  if (!account || account.status !== "CONNECTED") return;
  const post = getDb().prepare("SELECT id FROM platform_posts WHERE job_id = ?").get(jobId) as { id: string } | undefined;
  if (!post) return;
  try {
    const tokens = await ensureFreshTokens(account);
    const metrics = await getAdapter(job.platform as Platform).syncMetrics(tokens.accessToken, job.platform_post_id);
    if (!metrics) return; // provider exposes no metrics under our scopes — stays "unavailable"
    getDb()
      .prepare(
        "UPDATE post_analytics_snapshots SET views = ?, likes = ?, comments = ?, shares = ?, metrics_status = 'ok', metric_source = ?, last_synced_at = ?, updated_at = ? WHERE platform_post_id = ?",
      )
      .run(metrics.views, metrics.likes, metrics.comments, metrics.shares, metrics.source, nowIso(), nowIso(), post.id);
  } catch {
    getDb()
      .prepare("UPDATE post_analytics_snapshots SET metrics_status = 'error', updated_at = ? WHERE platform_post_id = ?")
      .run(nowIso(), post.id);
  }
}

/** Poll the platform for a submitted job and apply the truth. */
async function pollJobStatus(job: PublishJobRow): Promise<void> {
  const account = ownedAccount(job.user_id, job.account_id);
  if (!account) return;
  const attempt = lastAttempt(job.id);
  const providerRequestId = attempt?.provider_request_id ?? null;
  let tokens: StoredTokens;
  try {
    tokens = await ensureFreshTokens(account);
  } catch (err) {
    if (err instanceof ProviderError && err.errorClass === "user_intervention") {
      markAccountAuthRequired(account.id);
      setJobStatus(job.id, "AUTH_REQUIRED", {
        error: err.message,
        error_code: err.code,
        error_class: "user_intervention",
      });
    }
    return;
  }
  const adapter = getAdapter(job.platform as Platform);
  const checkAttempt = insertAttempt(job, "STATUS_CHECK");
  try {
    let result: PublishStatusResult | null = null;
    if (job.ambiguous === 1 && providerRequestId) {
      const input = await buildPublishInput(job, account, tokens);
      result = await adapter.recoverSubmission(tokens.accessToken, providerRequestId, input).catch(() => null);
      if (result?.postId) {
        // The provider confirms the submission EXISTS — the
        // ambiguity is resolved. Persist the id, clear the flag,
        // and (when recovery only proves existence) ask for the
        // authoritative status in the same poll.
        setJobStatus(job.id, job.status, {
          ambiguous: 0,
          platform_post_id: result.postId,
          published_url: result.postUrl ?? job.published_url,
        });
        job.platform_post_id = result.postId;
        job.ambiguous = 0;
        if (result.state === "processing") {
          result = await adapter
            .getPublishStatus(tokens.accessToken, providerRequestId, result.postId, account.username)
            .catch(() => result);
        }
      }
    }
    if (!result) {
      if (!providerRequestId && !job.platform_post_id) {
        updateAttempt(checkAttempt.id, { status: "FAILED", error: "No provider request id recorded yet." });
        return;
      }
      result = await adapter.getPublishStatus(
        tokens.accessToken,
        providerRequestId ?? "",
        job.platform_post_id,
        account.username,
      );
    }
    updateAttempt(checkAttempt.id, {
      status: "SUCCEEDED",
      provider_request_id: providerRequestId,
      provider_response_json: JSON.stringify(redact(result.raw ?? {})),
    });
    // Persist a platform id learned during recovery so later polls
    // (and the user) can see it even before the post is final.
    if (result.postId && result.postId !== job.platform_post_id) {
      setJobStatus(job.id, job.status, {
        platform_post_id: result.postId,
        published_url: result.postUrl ?? job.published_url,
        last_status_check_at: nowIso(),
      });
      job.platform_post_id = result.postId;
    } else {
      setJobStatus(job.id, job.status, { last_status_check_at: nowIso() });
    }
    if (result.state === "published") {
      applyPublished(job, result);
    } else if (result.state === "failed") {
      setJobStatus(job.id, "FAILED", {
        error: result.error ?? "The platform reported this publish as failed.",
        error_code: "PLATFORM_FAILED",
        error_class: "permanent",
        ambiguous: 0,
      });
      logError(job.user_id, job.platform, "STATUS_POLL", "PLATFORM_FAILED", result.error ?? "Platform reported failure.", job.id);
    } else {
      setJobStatus(job.id, "PLATFORM_PROCESSING", { last_status_check_at: nowIso() });
    }
  } catch (err) {
    updateAttempt(checkAttempt.id, {
      status: "FAILED",
      error: err instanceof Error ? err.message : String(err),
    });
    setJobStatus(job.id, job.status, { last_status_check_at: nowIso() });
    if (err instanceof ProviderError && err.status === 401) {
      markAccountAuthRequired(account.id);
      setJobStatus(job.id, "AUTH_REQUIRED", {
        error: err.message,
        error_code: err.code,
        error_class: "user_intervention",
      });
    }
  }
}

async function buildPublishInput(
  job: PublishJobRow,
  _account: PlatformAccountRow,
  tokens: StoredTokens,
): Promise<PublishInput> {
  const output = getDb()
    .prepare("SELECT * FROM export_outputs WHERE id = ?")
    .get(job.export_output_id) as unknown as ExportOutputRow;
  const { metadata, thumbnailStorageKey } = metadataFor(job.id);
  const publishMeta: Record<string, unknown> = { ...metadata };
  if (job.platform === "instagram") {
    // Hashtags live in the caption on Instagram — merge exactly as
    // validation measured them.
    const tags = (metadata.hashtags as string[] | undefined) ?? [];
    if (tags.length) {
      publishMeta.caption = `${String(metadata.caption ?? "")}\n\n${tags.join(" ")}`.trim();
    }
  }
  const schedule = scheduleFor(job.id);
  const nativeScheduleAt =
    job.platform === "youtube" && job.scheduling_mode === "platform" && schedule
      ? schedule.scheduled_for_utc
      : null;
  return {
    accessToken: tokens.accessToken,
    filePath: mediaPath(output.storage_key as string),
    fileSize: output.file_size ?? fs.statSync(mediaPath(output.storage_key as string)).size,
    contentType: output.format === "webm" ? "video/webm" : "video/mp4",
    metadata: publishMeta,
    nativeScheduleAt,
    thumbnailPath: thumbnailStorageKey ? mediaPath(thumbnailStorageKey) : null,
  };
}

// ---- submission -------------------------------------------------------------

const MAX_TRANSIENT_RETRIES = 3;
const backoffMs = (retryCount: number): number => Math.min(60_000, 1000 * 2 ** retryCount * 5);

async function submitJob(job: PublishJobRow): Promise<void> {
  const account = ownedAccount(job.user_id, job.account_id);
  if (!account) {
    setJobStatus(job.id, "FAILED", { error: "The target account no longer exists.", error_code: "ACCOUNT_MISSING", error_class: "permanent" });
    return;
  }
  if (account.status !== "CONNECTED") {
    setJobStatus(job.id, "AUTH_REQUIRED", {
      error: "The account is not connected (authorization expired, revoked or disconnected). Reconnect it, then retry.",
      error_code: "AUTH_REQUIRED",
      error_class: "user_intervention",
    });
    return;
  }
  let tokens: StoredTokens;
  try {
    tokens = await ensureFreshTokens(account);
  } catch (err) {
    if (err instanceof ProviderError && err.errorClass === "user_intervention") {
      markAccountAuthRequired(account.id);
      setJobStatus(job.id, "AUTH_REQUIRED", { error: err.message, error_code: err.code, error_class: "user_intervention" });
    } else {
      setJobStatus(job.id, "FAILED", {
        error: err instanceof Error ? err.message : String(err),
        error_code: "TOKEN_REFRESH_FAILED",
        error_class: "transient",
      });
    }
    return;
  }

  // Revalidate at submission time (spec §10): auth, media and
  // restrictions may all have changed since approval.
  const validation = await runValidation(job);
  if (!validation.ok && validation.authFailed) {
    markAccountAuthRequired(account.id);
    setJobStatus(job.id, "AUTH_REQUIRED", {
      error: "The account's authorization is no longer valid (expired or revoked). Reconnect it, then retry.",
      error_code: "AUTH_REQUIRED",
      error_class: "user_intervention",
    });
    return;
  }
  if (!validation.ok) {
    const first = validation.checks.find((c) => !c.ok && c.severity === "error");
    setJobStatus(job.id, "FAILED", {
      error: `Revalidation failed at submission: ${first ? `${first.label} — ${first.detail}` : "unknown check"}`,
      error_code: "VALIDATION_FAILED",
      error_class: "user_intervention",
    });
    logError(job.user_id, job.platform, "SUBMIT_VALIDATE", "VALIDATION_FAILED", first?.detail ?? "", job.id);
    return;
  }

  setJobStatus(job.id, "UPLOADING", { submitted_at: job.submitted_at ?? nowIso() });
  const attempt = insertAttempt(job, "SUBMIT");
  let recordedRequestId: string | null = null;
  try {
    const input = await buildPublishInput(job, account, tokens);
    input.onRequestId = (id) => {
      recordedRequestId = id;
      updateAttempt(attempt.id, { provider_request_id: id });
    };
    const result = await getAdapter(job.platform as Platform).publish(input);
    updateAttempt(attempt.id, {
      status: "SUCCEEDED",
      provider_request_id: result.providerRequestId,
      provider_response_json: JSON.stringify(redact(result.raw ?? {})),
    });
    // YouTube custom thumbnail is a second call; its failure is
    // recorded but does not unpublish the video.
    if (job.platform === "youtube" && input.thumbnailPath && result.postId) {
      const thumbAttempt = insertAttempt(job, "THUMBNAIL");
      try {
        await uploadYouTubeThumbnail(tokens.accessToken, result.postId, input.thumbnailPath);
        updateAttempt(thumbAttempt.id, { status: "SUCCEEDED", provider_request_id: result.postId });
      } catch (err) {
        updateAttempt(thumbAttempt.id, {
          status: "FAILED",
          provider_request_id: result.postId,
          error: err instanceof Error ? err.message : String(err),
        });
        logError(job.user_id, job.platform, "THUMBNAIL", "THUMBNAIL_FAILED", err instanceof Error ? err.message : String(err), job.id);
      }
    }
    setJobStatus(job.id, "SUBMITTED", {
      platform_post_id: result.postId,
      published_url: result.postUrl,
      last_status_check_at: null,
      error: null,
      error_code: null,
      error_class: null,
    });
  } catch (err) {
    const perr = err instanceof ProviderError ? err : null;
    const message = err instanceof Error ? err.message : String(err);
    // AMBIGUITY RULE: if the provider gave us a durable identifier
    // (or the failure class is ambiguous), the submission may have
    // landed. NEVER re-upload blindly — reconcile by status first.
    if (recordedRequestId || perr?.errorClass === "ambiguous") {
      updateAttempt(attempt.id, {
        status: "AMBIGUOUS",
        provider_request_id: recordedRequestId,
        error: message,
      });
      setJobStatus(job.id, "SUBMITTED", {
        ambiguous: 1,
        error: `Submission outcome uncertain (${message}). CLIPFORGE is verifying with the platform before any retry.`,
        error_code: "AMBIGUOUS_SUBMISSION",
        error_class: "ambiguous",
        last_status_check_at: null,
      });
      logError(job.user_id, job.platform, "SUBMIT", "AMBIGUOUS_SUBMISSION", message, job.id);
      return;
    }
    updateAttempt(attempt.id, {
      status: "FAILED",
      error: message,
      provider_response_json: perr ? JSON.stringify(redact(perr.providerBody ?? {})) : null,
    });
    if (
      perr &&
      (perr.status === 401 ||
        perr.code === "AUTH_REQUIRED" ||
        // A scope revoked between token refresh and the publish call
        // itself surfaces as a 403 classed user_intervention — the
        // authorization is just as dead as on a 401, so the account
        // must be flagged for reconnection the same way.
        (perr.status === 403 && perr.errorClass === "user_intervention"))
    ) {
      markAccountAuthRequired(account.id);
      setJobStatus(job.id, "AUTH_REQUIRED", { error: message, error_code: perr.code, error_class: "user_intervention" });
      return;
    }
    if (perr?.errorClass === "transient" && job.retry_count < MAX_TRANSIENT_RETRIES) {
      const nextRetry = new Date(Date.now() + backoffMs(job.retry_count)).toISOString();
      setJobStatus(job.id, "QUEUED", {
        error: `Transient platform error (will retry): ${message}`,
        error_code: perr.code,
        error_class: "transient",
        retry_count: job.retry_count + 1,
        next_retry_at: nextRetry,
      });
      return;
    }
    setJobStatus(job.id, "FAILED", {
      error: message,
      error_code: perr?.code ?? "PUBLISH_FAILED",
      error_class: perr?.errorClass ?? "permanent",
    });
    logError(job.user_id, job.platform, "SUBMIT", perr?.code ?? "PUBLISH_FAILED", message, job.id);
  }
}

async function uploadYouTubeThumbnail(accessToken: string, videoId: string, thumbnailPath: string): Promise<void> {
  const c = config.publishing.youtube;
  const bytes = fs.readFileSync(thumbnailPath);
  const ext = path.extname(thumbnailPath).toLowerCase();
  const res = await fetch(`${c.apiBase}/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": ext === ".png" ? "image/png" : "image/jpeg",
      "Content-Length": String(bytes.length),
    },
    body: bytes,
  });
  if (!res.ok) {
    throw new ProviderError(`YouTube thumbnail upload failed (HTTP ${res.status}).`, { status: res.status, code: "THUMBNAIL_FAILED" });
  }
}

// ---- worker -----------------------------------------------------------------

let publishTimer: NodeJS.Timeout | null = null;
let publishBusy = false;
const STATUS_POLL_MS = Number(process.env.PUBLISH_STATUS_POLL_MS ?? 5000);

export function startPublishingWorker(): void {
  // Boot recovery (spec §10/§19): reconcile whatever a restart
  // interrupted. VALIDATING jobs never reached a provider → safe to
  // re-queue. UPLOADING jobs may have reached one: if a provider
  // request id was recorded, reconcile by status; if not, the job is
  // honestly ambiguous and needs a status check / user decision —
  // it is NEVER blindly re-uploaded.
  try {
    const db = getDb();
    ensurePublishingSettingsStore();
    db.prepare("UPDATE publish_jobs SET status = 'QUEUED', updated_at = ? WHERE status = 'VALIDATING'").run(nowIso());
    const uploading = db.prepare("SELECT * FROM publish_jobs WHERE status = 'UPLOADING'").all() as unknown as PublishJobRow[];
    for (const job of uploading) {
      const attempt = lastAttempt(job.id);
      if (attempt?.provider_request_id) {
        setJobStatus(job.id, "SUBMITTED", {
          ambiguous: 1,
          error: "The server restarted during submission. CLIPFORGE is verifying the outcome with the platform before any retry.",
          error_code: "AMBIGUOUS_SUBMISSION",
          error_class: "ambiguous",
          last_status_check_at: null,
        });
      } else {
        setJobStatus(job.id, "FAILED", {
          ambiguous: 1,
          error: "The server restarted during submission and no provider request was recorded. The post may or may not exist on the platform — verify there before retrying.",
          error_code: "AMBIGUOUS_SUBMISSION",
          error_class: "ambiguous",
        });
      }
    }
  } catch {
    /* database not ready — recovery is best-effort at boot */
  }
  if (publishTimer) return;
  publishTimer = setInterval(() => {
    void publishTick();
  }, config.publishing.tickMs);
}

async function publishTick(): Promise<void> {
  if (publishBusy) return;
  publishBusy = true;
  try {
    const db = getDb();
    // 1) Claim ONE due job (atomic conditional update — a second
    //    ticker/process can never claim the same job).
    const dueScheduled = db
      .prepare(
        `SELECT j.* FROM publish_jobs j
         LEFT JOIN scheduled_posts sp ON sp.job_id = j.id
         WHERE j.status = 'SCHEDULED'
           AND (j.scheduling_mode = 'platform' OR sp.scheduled_for_utc IS NULL OR sp.scheduled_for_utc <= ?)
         ORDER BY COALESCE(sp.scheduled_for_utc, j.created_at) ASC LIMIT 1`,
      )
      .get(nowIso()) as PublishJobRow | undefined;
    const dueQueued = db
      .prepare(
        "SELECT * FROM publish_jobs WHERE status = 'QUEUED' AND (next_retry_at IS NULL OR next_retry_at <= ?) ORDER BY created_at ASC LIMIT 1",
      )
      .get(nowIso()) as PublishJobRow | undefined;
    const candidate = dueScheduled ?? dueQueued;
    if (candidate) {
      const claim = db
        .prepare("UPDATE publish_jobs SET status = 'VALIDATING', updated_at = ? WHERE id = ? AND status IN ('QUEUED', 'SCHEDULED')")
        .run(nowIso(), candidate.id);
      if (Number((claim as { changes: number }).changes) === 1) {
        db.prepare("UPDATE scheduled_posts SET status = 'FIRED', updated_at = ? WHERE job_id = ? AND status = 'SCHEDULED'").run(nowIso(), candidate.id);
        const fresh = db.prepare("SELECT * FROM publish_jobs WHERE id = ?").get(candidate.id) as unknown as PublishJobRow;
        await submitJob(fresh);
      }
    }
    // 2) Poll submitted jobs whose status check is due.
    const pollDue = db
      .prepare(
        `SELECT * FROM publish_jobs WHERE status IN ('SUBMITTED', 'PLATFORM_PROCESSING')
         AND (last_status_check_at IS NULL OR last_status_check_at <= ?) ORDER BY updated_at ASC LIMIT 3`,
      )
      .all(new Date(Date.now() - STATUS_POLL_MS).toISOString()) as unknown as PublishJobRow[];
    for (const job of pollDue) {
      await pollJobStatus(job);
    }
  } catch (err) {
    console.error("[publishing] worker tick failed:", err);
  } finally {
    publishBusy = false;
  }
}

// ---- routes -----------------------------------------------------------------

function sniffImage(filePath: string, ext: string): boolean {
  const fd = fs.openSync(filePath, "r");
  const buf = Buffer.alloc(16);
  const read = fs.readSync(fd, buf, 0, 16, 0);
  fs.closeSync(fd);
  const head = buf.subarray(0, read);
  if (ext === "png") return head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff; // jpg
}

const createJobSchema = z
  .object({
    exportOutputId: z.string().min(1),
    accountId: z.string().min(1),
    clipId: z.string().max(120).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const scheduleSchema = z
  .object({
    scheduledForUtc: z.string().max(40).optional(),
    scheduledForLocal: z.string().max(40).optional(),
    timezone: z.string().max(80).optional(),
  })
  .strict();

function resolveScheduleTime(body: z.infer<typeof scheduleSchema>): { utc: string; timezone: string } {
  const timezone = body.timezone ?? "Asia/Kolkata";
  if (body.scheduledForUtc) {
    const d = new Date(body.scheduledForUtc);
    if (Number.isNaN(d.getTime())) throw new Error("scheduledForUtc is not a valid timestamp.");
    return { utc: d.toISOString(), timezone };
  }
  if (body.scheduledForLocal) {
    return { utc: localToUtc(body.scheduledForLocal, timezone), timezone };
  }
  throw new Error("Provide scheduledForUtc or scheduledForLocal + timezone.");
}

// ---- per-user publishing defaults (§21 settings write path) -----------------
// The settings response pairs deployment facts (provider configuration,
// token encryption, public URL) with the caller's own persisted
// defaults. The defaults live in a table this module creates at boot
// (CREATE TABLE IF NOT EXISTS — the boot-fixup precedent used for
// report statuses), one row per user, so no schema migration in db.ts
// is needed. Built-in fallbacks mirror the metadata schemas' defaults
// above: YouTube privacy "private", Instagram shareToFeed true,
// TikTok privacyLevel "" (the creator's own default applies).

const youtubeDefaultsSchema = z
  .object({
    privacy: z.enum(["public", "private", "unlisted"]).default("private"),
  })
  .strict();

const instagramDefaultsSchema = z
  .object({
    shareToFeed: z.boolean().default(true),
  })
  .strict();

const tiktokDefaultsSchema = z
  .object({
    privacyLevel: z.string().max(60).default(""),
  })
  .strict();

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const timezoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidTimeZone, "timezone must be a valid IANA time zone name");

const publishingDefaultsSchema = z
  .object({
    timezone: timezoneSchema.default("UTC"),
    youtube: youtubeDefaultsSchema.default({}),
    instagram: instagramDefaultsSchema.default({}),
    tiktok: tiktokDefaultsSchema.default({}),
  })
  .strict();

const publishingDefaultsPatchSchema = z
  .object({
    timezone: timezoneSchema.optional(),
    youtube: z.object({ privacy: z.enum(["public", "private", "unlisted"]).optional() }).strict().optional(),
    instagram: z.object({ shareToFeed: z.boolean().optional() }).strict().optional(),
    tiktok: z.object({ privacyLevel: z.string().max(60).optional() }).strict().optional(),
  })
  .strict();

type PublishingUserDefaults = z.infer<typeof publishingDefaultsSchema>;

function ensurePublishingSettingsStore(): void {
  getDb().exec(
    `CREATE TABLE IF NOT EXISTS publishing_user_settings (
       user_id TEXT PRIMARY KEY,
       settings_json TEXT NOT NULL DEFAULT '{}',
       updated_at TEXT NOT NULL DEFAULT ''
     )`,
  );
}

function readPublishingDefaults(userId: string): PublishingUserDefaults {
  ensurePublishingSettingsStore();
  const row = getDb()
    .prepare("SELECT settings_json FROM publishing_user_settings WHERE user_id = ?")
    .get(userId) as { settings_json: string } | undefined;
  if (!row) return publishingDefaultsSchema.parse({});
  // Parsing through the full schema re-fills any field a stored row
  // predates, so older rows keep working as defaults are added.
  const parsed = publishingDefaultsSchema.safeParse(parseJson(row.settings_json, {}));
  return parsed.success ? parsed.data : publishingDefaultsSchema.parse({});
}

function writePublishingDefaults(userId: string, defaults: PublishingUserDefaults): void {
  ensurePublishingSettingsStore();
  getDb()
    .prepare(
      `INSERT INTO publishing_user_settings (user_id, settings_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at`,
    )
    .run(userId, JSON.stringify(defaults), nowIso());
}

function publishingSettingsResponse(userId: string) {
  const allVars: Record<Platform, string[]> = {
    youtube: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_REDIRECT_URI"],
    instagram: ["META_APP_ID", "META_APP_SECRET", "META_REDIRECT_URI"],
    tiktok: ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET", "TIKTOK_REDIRECT_URI"],
  };
  return {
    providers: (Object.keys(allVars) as Platform[]).map((platform) => {
      const st = publishingProviderStatus(platform);
      return {
        platform,
        configured: st.configured,
        present: allVars[platform].filter((n) => !st.missing.includes(n)),
        missing: st.missing,
      };
    }),
    tokenEncryption: tokenEncryptionStatus(),
    publicAppUrl: config.publishing.publicAppUrl,
    databaseNote:
      "This build stores publishing data in SQLite via the project's portable schema; PostgreSQL + Redis/BullMQ are the documented production path (README).",
    defaults: readPublishingDefaults(userId),
  };
}

export function registerPublishingRoutes(app: express.Express, requireAuth: RequireAuth): void {
  const pub = express.Router();

  // -- provider status + settings (§21) -------------------------------------
  pub.get("/providers", requireAuth, (_req: AuthedRequest, res) => {
    res.json({
      providers: (["youtube", "instagram", "tiktok"] as Platform[]).map((platform) => {
        const st = publishingProviderStatus(platform);
        const adapter = getAdapter(platform);
        return {
          platform,
          implemented: true,
          configured: st.configured,
          missing: st.missing,
          scopes: adapter.scopes,
          usesPkce: adapter.usesPkce,
        };
      }),
    });
  });

  pub.get("/settings", requireAuth, (req: AuthedRequest, res) => {
    res.json(publishingSettingsResponse(req.user!.id));
  });

  // Partial updates: any subset of the defaults fields (sent either as
  // the whole body or wrapped in a `defaults` key) is merged onto the
  // stored values, validated as a whole, persisted, and the full
  // settings object — the exact shape GET returns — is sent back.
  pub.put("/settings", requireAuth, (req: AuthedRequest, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patchRaw = body.defaults !== undefined ? body.defaults : body;
    const parsed = publishingDefaultsPatchSchema.safeParse(patchRaw ?? {});
    if (!parsed.success) {
      return fail(res, 400, "INVALID_REQUEST", parsed.error.issues[0]?.message ?? "Invalid settings.");
    }
    const userId = req.user!.id;
    const current = readPublishingDefaults(userId);
    const merged = publishingDefaultsSchema.parse({
      timezone: parsed.data.timezone ?? current.timezone,
      youtube: { ...current.youtube, ...(parsed.data.youtube ?? {}) },
      instagram: { ...current.instagram, ...(parsed.data.instagram ?? {}) },
      tiktok: { ...current.tiktok, ...(parsed.data.tiktok ?? {}) },
    });
    writePublishingDefaults(userId, merged);
    res.json(publishingSettingsResponse(userId));
  });

  // -- connected accounts (§3) ----------------------------------------------
  pub.get("/accounts", requireAuth, (req: AuthedRequest, res) => {
    const rows = getDb()
      .prepare("SELECT * FROM platform_accounts WHERE user_id = ? AND status != 'DISCONNECTED' ORDER BY created_at ASC")
      .all(req.user!.id) as unknown as PlatformAccountRow[];
    res.json({ accounts: rows.map(publicAccount) });
  });

  pub.post("/accounts/:platform/connect", requireAuth, (req: AuthedRequest, res) => {
    const platform = String(req.params.platform);
    if (!isPlatform(platform)) return fail(res, 404, "NOT_FOUND", "Unknown platform.");
    const st = publishingProviderStatus(platform);
    if (!st.configured) return configError(res, platform);
    const adapter = getAdapter(platform);
    const state = crypto.randomBytes(32).toString("base64url");
    let codeVerifier: string | null = null;
    let codeChallenge: string | null = null;
    if (adapter.usesPkce) {
      codeVerifier = crypto.randomBytes(48).toString("base64url");
      codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
    }
    const connectionId = newId();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    getDb()
      .prepare(
        "INSERT INTO oauth_connections (id, user_id, platform, state_hash, code_verifier, status, account_id, error, created_at, expires_at) VALUES (?, ?, ?, ?, ?, 'PENDING', NULL, NULL, ?, ?)",
      )
      .run(connectionId, req.user!.id, platform, sha256(state), codeVerifier, nowIso(), expiresAt);
    res.json({ authUrl: adapter.buildAuthUrl(state, codeChallenge), connectionId, expiresAt });
  });

  pub.delete("/accounts/:accountId", requireAuth, async (req: AuthedRequest, res) => {
    const account = ownedAccount(req.user!.id, String(req.params.accountId));
    if (!account) return fail(res, 404, "NOT_FOUND", "Account not found.");
    if (!deleteConfirmed(req)) {
      return fail(
        res,
        409,
        "CONFIRMATION_REQUIRED",
        `Disconnecting ${account.platform} account ${account.username ?? account.platform_account_id} revokes its authorization and deletes the stored tokens. Repeat the request with ?confirm=true to proceed.`,
      );
    }
    // Revoke at the provider when possible (best-effort), then delete
    // the stored credentials and mark the account DISCONNECTED. The
    // account row is retained so publishing history stays readable;
    // it disappears from the connected list and cannot publish.
    const tokens = loadTokens(account.id);
    const adapter = getAdapter(account.platform as Platform);
    if (tokens && adapter.revokeToken && publishingProviderStatus(account.platform as Platform).configured) {
      await adapter.revokeToken(tokens.accessToken).catch(() => undefined);
    }
    deleteTokens(account.id);
    getDb()
      .prepare(
        "UPDATE platform_accounts SET status = 'DISCONNECTED', granted_scopes_json = '[]', token_expires_at = NULL, updated_at = ? WHERE id = ?",
      )
      .run(nowIso(), account.id);
    res.status(204).end();
  });

  pub.post("/accounts/:accountId/refresh", requireAuth, async (req: AuthedRequest, res) => {
    const account = ownedAccount(req.user!.id, String(req.params.accountId));
    if (!account) return fail(res, 404, "NOT_FOUND", "Account not found.");
    if (account.status === "DISCONNECTED") return fail(res, 409, "ACCOUNT_DISCONNECTED", "This account is disconnected. Connect it again.");
    if (!publishingProviderStatus(account.platform as Platform).configured) {
      return configError(res, account.platform as Platform);
    }
    try {
      const tokens = await ensureFreshTokens(account, true);
      const info = await getAdapter(account.platform as Platform).getAccountInfo(tokens.accessToken);
      getDb()
        .prepare(
          "UPDATE platform_accounts SET username = ?, display_name = ?, profile_image_url = ?, account_type = ?, status = 'CONNECTED', last_synced_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(info.username, info.displayName, info.profileImageUrl, info.accountType, nowIso(), nowIso(), account.id);
      await fetchAndStoreCapabilities(account, tokens).catch(() => undefined);
      const fresh = ownedAccount(req.user!.id, account.id)!;
      res.json({ account: publicAccount(fresh) });
    } catch (err) {
      if (err instanceof ProviderError && err.errorClass === "user_intervention") {
        markAccountAuthRequired(account.id);
        return fail(res, 409, "AUTH_REQUIRED", `${err.message} Reconnect the account to continue.`);
      }
      return fail(res, 502, "PROVIDER_ERROR", err instanceof Error ? err.message : String(err));
    }
  });

  pub.get("/accounts/:accountId/capabilities", requireAuth, async (req: AuthedRequest, res) => {
    const account = ownedAccount(req.user!.id, String(req.params.accountId));
    if (!account) return fail(res, 404, "NOT_FOUND", "Account not found.");
    const wantFresh = req.query.fresh === "1" || req.query.fresh === "true";
    if (wantFresh) {
      if (!publishingProviderStatus(account.platform as Platform).configured) {
        return configError(res, account.platform as Platform);
      }
      if (account.status !== "CONNECTED") {
        return fail(res, 409, "AUTH_REQUIRED", "The account is not connected. Reconnect it to retrieve capabilities.");
      }
      try {
        const tokens = await ensureFreshTokens(account);
        const caps = await fetchAndStoreCapabilities(account, tokens);
        return res.json({ capabilities: caps, fetchedAt: nowIso(), live: true });
      } catch (err) {
        if (err instanceof ProviderError && err.errorClass === "user_intervention") {
          markAccountAuthRequired(account.id);
          return fail(res, 409, "AUTH_REQUIRED", err.message);
        }
        return fail(res, 502, "PROVIDER_ERROR", err instanceof Error ? err.message : String(err));
      }
    }
    const caps = latestCapabilities(account.id);
    res.json({ capabilities: caps, fetchedAt: null, live: false });
  });

  // -- jobs: create / read / edit (§5, §17) -----------------------------------
  pub.post("/jobs", requireAuth, (req: AuthedRequest, res) => {
    const parsed = createJobSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, "INVALID_REQUEST", parsed.error.issues[0]?.message ?? "Invalid request.");
    const userId = req.user!.id;
    const account = ownedAccount(userId, parsed.data.accountId);
    if (!account) return fail(res, 404, "NOT_FOUND", "Account not found.");
    const output = getDb()
      .prepare("SELECT * FROM export_outputs WHERE id = ? AND user_id = ?")
      .get(parsed.data.exportOutputId, userId) as ExportOutputRow | undefined;
    if (!output) return fail(res, 404, "NOT_FOUND", "Export not found.");
    // Idempotency-Key: a retried create returns the original draft.
    const clientRequestId = (req.header("idempotency-key") ?? "").slice(0, 200) || null;
    if (clientRequestId) {
      const existing = getDb()
        .prepare("SELECT * FROM publish_jobs WHERE user_id = ? AND client_request_id = ?")
        .get(userId, clientRequestId) as PublishJobRow | undefined;
      if (existing) return res.json({ job: publicJob(existing), deduplicated: true });
    }
    const platform = account.platform as Platform;
    const schema = metadataSchema(platform);
    const metaParsed = schema.safeParse(parsed.data.metadata ?? {});
    if (!metaParsed.success) {
      return fail(res, 400, "INVALID_METADATA", metaParsed.error.issues[0]?.message ?? "Invalid metadata.");
    }
    const jobId = newId();
    const db = getDb();
    // clip_id derivation (migration v10): export_outputs now persist
    // the export's target (target_kind/target_id), so a draft made
    // from a CANDIDATE-targeted export is traced back to its
    // candidate clip from stored data, server-side. (Before v10 only
    // a human target_label was stored, which is not an identifier;
    // the S5 limitation that described is lifted for exports created
    // since.) Document/version-targeted exports have no single clip,
    // so clip_id stays NULL for them; the client's optional clipId
    // remains only as a fallback when no target was persisted.
    const derivedClipId =
      output.target_kind === "candidate" && output.target_id ? output.target_id : null;
    db.prepare(
      `INSERT INTO publish_jobs (id, user_id, project_id, clip_id, export_output_id, account_id, platform, status, scheduling_mode,
        client_request_id, approved_at, rights_confirmed_at, submitted_at, published_at, platform_post_id, published_url,
        error, error_code, error_class, retry_count, next_retry_at, ambiguous, last_status_check_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'DRAFT', NULL, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, 0, NULL, ?, ?)`,
    ).run(jobId, userId, output.project_id, derivedClipId ?? parsed.data.clipId ?? null, output.id, account.id, platform, clientRequestId, nowIso(), nowIso());
    db.prepare(
      "INSERT INTO post_metadata (id, job_id, user_id, platform, metadata_json, thumbnail_storage_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)",
    ).run(newId(), jobId, userId, platform, JSON.stringify(metaParsed.data), nowIso(), nowIso());
    const job = ownedJob(userId, jobId)!;
    res.status(201).json({ job: publicJob(job) });
  });

  pub.get("/jobs/:jobId", requireAuth, (req: AuthedRequest, res) => {
    const job = ownedJob(req.user!.id, String(req.params.jobId));
    if (!job) return fail(res, 404, "NOT_FOUND", "Publishing job not found.");
    res.json({ job: publicJob(job), validation: latestValidation(job.id) });
  });

  pub.put("/jobs/:jobId/metadata", requireAuth, (req: AuthedRequest, res) => {
    const job = ownedJob(req.user!.id, String(req.params.jobId));
    if (!job) return fail(res, 404, "NOT_FOUND", "Publishing job not found.");
    if (!EDITABLE_STATUSES.includes(job.status)) {
      return fail(res, 409, "NOT_EDITABLE", `A job in state ${job.status} cannot be edited. Cancel it or create a new draft.`);
    }
    const schema = metadataSchema(job.platform as Platform);
    const parsed = schema.safeParse((req.body as { metadata?: unknown })?.metadata ?? {});
    if (!parsed.success) return fail(res, 400, "INVALID_METADATA", parsed.error.issues[0]?.message ?? "Invalid metadata.");
    const db = getDb();
    db.prepare("UPDATE post_metadata SET metadata_json = ?, updated_at = ? WHERE job_id = ?").run(
      JSON.stringify(parsed.data),
      nowIso(),
      job.id,
    );
    if (job.status === "FAILED" || job.status === "AUTH_REQUIRED") {
      // Editing a failed job restarts its lifecycle as a draft.
      setJobStatus(job.id, "DRAFT", { error: null, error_code: null, error_class: null, approved_at: null });
    } else if (job.status === "AWAITING_APPROVAL") {
      // Metadata changed after validation/approval — both are void;
      // the job must be validated and approved again.
      setJobStatus(job.id, "DRAFT", { approved_at: null, rights_confirmed_at: null });
    }
    res.json({ job: publicJob(ownedJob(req.user!.id, job.id)!) });
  });

  pub.delete("/jobs/:jobId", requireAuth, (req: AuthedRequest, res) => {
    const job = ownedJob(req.user!.id, String(req.params.jobId));
    if (!job) return fail(res, 404, "NOT_FOUND", "Publishing job not found.");
    if (!["DRAFT", "AWAITING_APPROVAL", "FAILED", "CANCELLED", "AUTH_REQUIRED"].includes(job.status)) {
      return fail(res, 409, "NOT_DELETABLE", `A job in state ${job.status} cannot be deleted.`);
    }
    if (!deleteConfirmed(req)) {
      return fail(res, 409, "CONFIRMATION_REQUIRED", "Deleting this publishing job removes the draft and its history. Repeat the request with ?confirm=true to proceed.");
    }
    getDb().prepare("DELETE FROM publish_jobs WHERE id = ?").run(job.id);
    res.status(204).end();
  });

  // Custom thumbnail (YouTube only — the only adapter whose API
  // supports a thumbnail upload for a video post).
  const thumbUpload = multer({
    storage: multer.diskStorage({
      destination: path.join(config.mediaDir, ".tmp"),
      filename: (_req, _file, cb) => cb(null, `${newId()}.part`),
    }),
    limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  });
  pub.post("/jobs/:jobId/thumbnail", requireAuth, (req: AuthedRequest, res) => {
    const job = ownedJob(req.user!.id, String(req.params.jobId));
    if (!job) return fail(res, 404, "NOT_FOUND", "Publishing job not found.");
    if (job.platform !== "youtube") {
      return fail(res, 400, "UNSUPPORTED", "Custom thumbnails are only supported for YouTube posts in this integration.");
    }
    if (!EDITABLE_STATUSES.includes(job.status)) {
      return fail(res, 409, "NOT_EDITABLE", `A job in state ${job.status} cannot be edited.`);
    }
    fs.mkdirSync(path.join(config.mediaDir, ".tmp"), { recursive: true });
    thumbUpload.single("file")(req, res, (err: unknown) => {
      if (err) {
        const code = (err as { code?: string }).code;
        if (code === "LIMIT_FILE_SIZE") return fail(res, 413, "FILE_TOO_LARGE", "Thumbnails are limited to 2 MB by YouTube.");
        return fail(res, 400, "UPLOAD_FAILED", "The upload could not be read.");
      }
      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file) return fail(res, 400, "NO_FILE", "No file was received.");
      const ext = path.extname(file.originalname).toLowerCase().replace(".", "");
      if (ext !== "png" && ext !== "jpg" && ext !== "jpeg") {
        fs.rmSync(file.path, { force: true });
        return fail(res, 400, "UNSUPPORTED", "Thumbnails must be PNG or JPEG images.");
      }
      if (!sniffImage(file.path, ext === "jpeg" ? "jpg" : ext)) {
        fs.rmSync(file.path, { force: true });
        return fail(res, 422, "INVALID_IMAGE", "This file's contents do not match an image of that type.");
      }
      const storageKey = `${req.user!.id}/publishing-thumbnails/${job.id}.${ext === "jpeg" ? "jpg" : ext}`;
      fs.mkdirSync(path.dirname(mediaPath(storageKey)), { recursive: true });
      fs.renameSync(file.path, mediaPath(storageKey));
      getDb().prepare("UPDATE post_metadata SET thumbnail_storage_key = ?, updated_at = ? WHERE job_id = ?").run(storageKey, nowIso(), job.id);
      if (job.status === "AWAITING_APPROVAL") {
        // The thumbnail is part of what gets published, so changing
        // it after validation/approval voids both — the job must be
        // validated and approved again (same rule as metadata edits).
        setJobStatus(job.id, "DRAFT", { approved_at: null, rights_confirmed_at: null });
      }
      return res.json({ job: publicJob(ownedJob(req.user!.id, job.id)!) });
    });
  });
  pub.delete("/jobs/:jobId/thumbnail", requireAuth, (req: AuthedRequest, res) => {
    const job = ownedJob(req.user!.id, String(req.params.jobId));
    if (!job) return fail(res, 404, "NOT_FOUND", "Publishing job not found.");
    const { thumbnailStorageKey } = metadataFor(job.id);
    if (thumbnailStorageKey) {
      fs.rmSync(mediaPath(thumbnailStorageKey), { force: true });
      getDb().prepare("UPDATE post_metadata SET thumbnail_storage_key = NULL, updated_at = ? WHERE job_id = ?").run(nowIso(), job.id);
      if (job.status === "AWAITING_APPROVAL") {
        // Removing the thumbnail after validation/approval voids
        // both — the job must be validated and approved again
        // (same rule as metadata edits).
        setJobStatus(job.id, "DRAFT", { approved_at: null, rights_confirmed_at: null });
      }
    }
    res.json({ job: publicJob(ownedJob(req.user!.id, job.id)!) });
  });

  // -- validation / preview / approval (§6, §8) -------------------------------
  pub.post("/jobs/:jobId/validate", requireAuth, async (req: AuthedRequest, res) => {
    const job = ownedJob(req.user!.id, String(req.params.jobId));
    if (!job) return fail(res, 404, "NOT_FOUND", "Publishing job not found.");
    if (!EDITABLE_STATUSES.includes(job.status) && job.status !== "SCHEDULED" && job.status !== "QUEUED") {
      return fail(res, 409, "NOT_VALIDATABLE", `A job in state ${job.status} cannot be validated.`);
    }
    const result = await runValidation(job);
    if (result.ok && job.status === "DRAFT") {
      setJobStatus(job.id, "AWAITING_APPROVAL", {});
    }
    res.json({ ok: result.ok, checks: result.checks, job: publicJob(ownedJob(req.user!.id, job.id)!) });
  });

  pub.get("/jobs/:jobId/preview", requireAuth, (req: AuthedRequest, res) => {
    const job = ownedJob(req.user!.id, String(req.params.jobId));
    if (!job) return fail(res, 404, "NOT_FOUND", "Publishing job not found.");
    const account = ownedAccount(req.user!.id, job.account_id);
    res.json({
      job: publicJob(job),
      account: account ? publicAccount(account) : null,
      validation: latestValidation(job.id),
      capabilities: account ? latestCapabilities(account.id) : null,
    });
  });

  pub.post("/jobs/:jobId/approve", requireAuth, (req: AuthedRequest, res) => {
    const job = ownedJob(req.user!.id, String(req.params.jobId));
    if (!job) return fail(res, 404, "NOT_FOUND", "Publishing job not found.");
    const rightsConfirmed = (req.body as { rightsConfirmed?: unknown })?.rightsConfirmed === true;
    if (!rightsConfirmed) {
      return fail(res, 400, "RIGHTS_NOT_CONFIRMED", "Confirm that you own or are authorised to distribute this media before approving it for publication.");
    }
    if (job.status !== "AWAITING_APPROVAL") {
      return fail(res, 409, "NOT_AWAITING_APPROVAL", `Only a validated job awaiting approval can be approved (current state: ${job.status}). Run validation first.`);
    }
    const validation = latestValidation(job.id);
    if (!validation?.ok) {
      return fail(res, 409, "VALIDATION_FAILED", "The latest validation did not pass. Fix the reported problems and validate again.");
    }
    setJobStatus(job.id, "AWAITING_APPROVAL", { approved_at: nowIso(), rights_confirmed_at: nowIso() });
    res.json({ job: publicJob(ownedJob(req.user!.id, job.id)!) });
  });

  // -- submit / schedule (§9, §10) ---------------------------------------------
  pub.post("/jobs/:jobId/submit", requireAuth, (req: AuthedRequest, res) => {
    const job = ownedJob(req.user!.id, String(req.params.jobId));
    if (!job) return fail(res, 404, "NOT_FOUND", "Publishing job not found.");
    if (!job.approved_at) {
      return fail(res, 409, "APPROVAL_REQUIRED", "This post has not been approved. Review it on the approval screen and approve it before submitting — CLIPFORGE never publishes without explicit approval.");
    }
    if (!["AWAITING_APPROVAL"].includes(job.status)) {
      return fail(res, 409, "ALREADY_SUBMITTED", `This job is already ${job.status.toLowerCase()} — it cannot be submitted twice.`);
    }
    setJobStatus(job.id, "QUEUED", { next_retry_at: null });
    res.json({ job: publicJob(ownedJob(req.user!.id, job.id)!) });
  });

  pub.post("/jobs/:jobId/schedule", requireAuth, (req: AuthedRequest, res) => {
    const job = ownedJob(req.user!.id, String(req.params.jobId));
    if (!job) return fail(res, 404, "NOT_FOUND", "Publishing job not found.");
    if (!job.approved_at) {
      return fail(res, 409, "APPROVAL_REQUIRED", "Approve the post before scheduling it — CLIPFORGE never publishes without explicit approval.");
    }
    if (job.status !== "AWAITING_APPROVAL") {
      return fail(res, 409, "NOT_SCHEDULABLE", `A job in state ${job.status} cannot be scheduled.`);
    }
    const parsed = scheduleSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, "INVALID_REQUEST", parsed.error.issues[0]?.message ?? "Invalid schedule.");
    let when: { utc: string; timezone: string };
    try {
      when = resolveScheduleTime(parsed.data);
    } catch (err) {
      return fail(res, 400, "INVALID_REQUEST", err instanceof Error ? err.message : String(err));
    }
    if (new Date(when.utc).getTime() <= Date.now()) {
      return fail(res, 400, "INVALID_REQUEST", "The scheduled time is in the past. Pick a future time.");
    }
    // YouTube native scheduling (status.publishAt) applies ONLY
    // when the video will be private and has never been published —
    // a fresh job satisfies the second condition; the metadata the
    // first. Anything else is honestly CLIPFORGE-scheduled.
    const { metadata } = metadataFor(job.id);
    const mode =
      job.platform === "youtube" && (metadata as YoutubeMetadata).privacy === "private" ? "platform" : "clipforge";
    const db = getDb();
    db.prepare(
      "INSERT INTO scheduled_posts (id, job_id, user_id, scheduled_for_utc, timezone, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'SCHEDULED', ?, ?)",
    ).run(newId(), job.id, req.user!.id, when.utc, when.timezone, nowIso(), nowIso());
    setJobStatus(job.id, "SCHEDULED", { scheduling_mode: mode });
    res.json({ job: publicJob(ownedJob(req.user!.id, job.id)!) });
  });

  pub.patch("/schedules/:scheduleId", requireAuth, (req: AuthedRequest, res) => {
    const schedule = getDb()
      .prepare("SELECT * FROM scheduled_posts WHERE id = ? AND user_id = ?")
      .get(String(req.params.scheduleId), req.user!.id) as ScheduledPostRow | undefined;
    if (!schedule) return fail(res, 404, "NOT_FOUND", "Schedule not found.");
    const job = ownedJob(req.user!.id, schedule.job_id);
    if (!job || job.status !== "SCHEDULED" || schedule.status !== "SCHEDULED") {
      return fail(res, 409, "NOT_EDITABLE", "Only a pending scheduled post can be moved.");
    }
    const parsed = scheduleSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, "INVALID_REQUEST", parsed.error.issues[0]?.message ?? "Invalid schedule.");
    let when: { utc: string; timezone: string };
    try {
      when = resolveScheduleTime(parsed.data);
    } catch (err) {
      return fail(res, 400, "INVALID_REQUEST", err instanceof Error ? err.message : String(err));
    }
    if (new Date(when.utc).getTime() <= Date.now()) {
      return fail(res, 400, "INVALID_REQUEST", "The scheduled time is in the past. Pick a future time.");
    }
    getDb()
      .prepare("UPDATE scheduled_posts SET scheduled_for_utc = ?, timezone = ?, updated_at = ? WHERE id = ?")
      .run(when.utc, when.timezone, nowIso(), schedule.id);
    res.json({ job: publicJob(ownedJob(req.user!.id, job.id)!) });
  });

  pub.post("/jobs/:jobId/cancel-schedule", requireAuth, (req: AuthedRequest, res) => {
    const job = ownedJob(req.user!.id, String(req.params.jobId));
    if (!job) return fail(res, 404, "NOT_FOUND", "Publishing job not found.");
    if (job.status !== "SCHEDULED") {
      return fail(res, 409, "NOT_SCHEDULED", `A job in state ${job.status} has no schedule to cancel.`);
    }
    getDb().prepare("UPDATE scheduled_posts SET status = 'CANCELLED', updated_at = ? WHERE job_id = ?").run(nowIso(), job.id);
    setJobStatus(job.id, "AWAITING_APPROVAL", { scheduling_mode: null });
    res.json({ job: publicJob(ownedJob(req.user!.id, job.id)!) });
  });

  pub.post("/jobs/:jobId/cancel", requireAuth, (req: AuthedRequest, res) => {
    const job = ownedJob(req.user!.id, String(req.params.jobId));
    if (!job) return fail(res, 404, "NOT_FOUND", "Publishing job not found.");
    if (["UPLOADING", "SUBMITTED", "PLATFORM_PROCESSING"].includes(job.status)) {
      return fail(res, 409, "CANNOT_CANCEL", "This post has already been submitted to the platform and cannot be cancelled from CLIPFORGE.");
    }
    if (TERMINAL_STATUSES.includes(job.status)) {
      return fail(res, 409, "CANNOT_CANCEL", `This job is already ${job.status.toLowerCase()}.`);
    }
    getDb().prepare("UPDATE scheduled_posts SET status = 'CANCELLED', updated_at = ? WHERE job_id = ? AND status = 'SCHEDULED'").run(nowIso(), job.id);
    setJobStatus(job.id, "CANCELLED", {});
    res.json({ job: publicJob(ownedJob(req.user!.id, job.id)!) });
  });

  pub.post("/jobs/:jobId/retry", requireAuth, async (req: AuthedRequest, res) => {
    const job = ownedJob(req.user!.id, String(req.params.jobId));
    if (!job) return fail(res, 404, "NOT_FOUND", "Publishing job not found.");
    if (job.status === "AUTH_REQUIRED") {
      const account = ownedAccount(req.user!.id, job.account_id);
      if (!account || account.status !== "CONNECTED") {
        return fail(res, 409, "AUTH_REQUIRED", "Reconnect the account first — retrying cannot succeed without authorization.");
      }
      setJobStatus(job.id, "QUEUED", { error: null, error_code: null, error_class: null, next_retry_at: null });
      return res.json({ job: publicJob(ownedJob(req.user!.id, job.id)!) });
    }
    if (job.status !== "FAILED") {
      return fail(res, 409, "NOT_RETRYABLE", `Only failed jobs can be retried (current state: ${job.status}).`);
    }
    if (job.ambiguous === 1) {
      // Ambiguity rule: reconcile with the platform BEFORE any
      // re-upload is even considered.
      const attempt = lastAttempt(job.id);
      if (!attempt?.provider_request_id) {
        const confirmed = (req.body as { confirmAmbiguousRetry?: unknown })?.confirmAmbiguousRetry === true;
        if (!confirmed) {
          return fail(
            res,
            409,
            "AMBIGUOUS_UNRESOLVED",
            "The previous submission's outcome is unknown and no platform reference was recorded, so CLIPFORGE cannot verify whether the post already exists. Check the platform manually; if it is not there, retry with confirmAmbiguousRetry: true.",
          );
        }
        setJobStatus(job.id, "QUEUED", { ambiguous: 0, error: null, error_code: null, error_class: null, next_retry_at: null, retry_count: job.retry_count + 1 });
        return res.json({ job: publicJob(ownedJob(req.user!.id, job.id)!) });
      }
      await pollJobStatus(job);
      const after = ownedJob(req.user!.id, job.id)!;
      if (after.status !== "FAILED") {
        return res.json({ job: publicJob(after), reconciled: true });
      }
      // The platform confirmed it never landed — safe to re-queue.
      setJobStatus(job.id, "QUEUED", { ambiguous: 0, error: null, error_code: null, error_class: null, next_retry_at: null, retry_count: job.retry_count + 1 });
      return res.json({ job: publicJob(ownedJob(req.user!.id, job.id)!) });
    }
    if (job.error_class === "user_intervention") {
      const meta = getDb()
        .prepare("SELECT updated_at FROM post_metadata WHERE job_id = ?")
        .get(job.id) as { updated_at: string } | undefined;
      const attempt = lastAttempt(job.id);
      const editedSinceFailure = meta && attempt ? meta.updated_at > attempt.created_at : false;
      if (!editedSinceFailure) {
        return fail(res, 409, "USER_INTERVENTION_REQUIRED", `This failure needs a fix first: ${job.error ?? "see job details"}. Edit the post, then retry.`);
      }
    }
    setJobStatus(job.id, "QUEUED", { error: null, error_code: null, error_class: null, next_retry_at: null, retry_count: job.retry_count + 1 });
    res.json({ job: publicJob(ownedJob(req.user!.id, job.id)!) });
  });

  pub.post("/jobs/:jobId/status-check", requireAuth, async (req: AuthedRequest, res) => {
    const job = ownedJob(req.user!.id, String(req.params.jobId));
    if (!job) return fail(res, 404, "NOT_FOUND", "Publishing job not found.");
    if (!["SUBMITTED", "PLATFORM_PROCESSING"].includes(job.status)) {
      return fail(res, 409, "NOT_SUBMITTED", `A job in state ${job.status} has no platform status to check.`);
    }
    await pollJobStatus(job);
    res.json({ job: publicJob(ownedJob(req.user!.id, job.id)!) });
  });

  // -- queue / calendar / history (§9, §11, §13) -------------------------------
  pub.get("/queue", requireAuth, (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const status = typeof req.query.status === "string" ? req.query.status : "all";
    const clauses = ["user_id = ?"];
    const params: unknown[] = [userId];
    if (status !== "all") {
      clauses.push("status = ?");
      params.push(status.toUpperCase());
    }
    if (typeof req.query.platform === "string") {
      clauses.push("platform = ?");
      params.push(req.query.platform);
    }
    if (typeof req.query.accountId === "string") {
      clauses.push("account_id = ?");
      params.push(req.query.accountId);
    }
    if (typeof req.query.projectId === "string") {
      clauses.push("project_id = ?");
      params.push(req.query.projectId);
    }
    const rows = getDb()
      .prepare(`SELECT * FROM publish_jobs WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT 300`)
      .all(...(params as never[])) as unknown as PublishJobRow[];
    const counts = getDb()
      .prepare("SELECT status, COUNT(*) AS n FROM publish_jobs WHERE user_id = ? GROUP BY status")
      .all(userId) as unknown as { status: string; n: number }[];
    res.json({
      jobs: rows.map(publicJob),
      counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
    });
  });

  pub.get("/calendar", requireAuth, (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const from = typeof req.query.from === "string" ? req.query.from : new Date(Date.now() - 31 * 86400_000).toISOString();
    const to = typeof req.query.to === "string" ? req.query.to : new Date(Date.now() + 62 * 86400_000).toISOString();
    const filters: string[] = [];
    const fp: unknown[] = [];
    if (typeof req.query.platform === "string") { filters.push("j.platform = ?"); fp.push(req.query.platform); }
    if (typeof req.query.accountId === "string") { filters.push("j.account_id = ?"); fp.push(req.query.accountId); }
    if (typeof req.query.projectId === "string") { filters.push("j.project_id = ?"); fp.push(req.query.projectId); }
    const extra = filters.length ? ` AND ${filters.join(" AND ")}` : "";
    const events: Record<string, unknown>[] = [];
    const titleOf = (jobId: string, fallback: string): string => {
      const m = metadataFor(jobId).metadata;
      const t = String((m.title as string) ?? (m.caption as string) ?? "").trim();
      return t ? t.slice(0, 80) : fallback;
    };
    const scheduled = getDb()
      .prepare(
        `SELECT sp.*, j.platform, j.account_id, j.project_id, j.status AS job_status FROM scheduled_posts sp
         JOIN publish_jobs j ON j.id = sp.job_id
         WHERE sp.user_id = ? AND sp.scheduled_for_utc >= ? AND sp.scheduled_for_utc <= ?${extra.replaceAll("j.", "j.")}`,
      )
      .all(userId, from, to, ...(fp as never[])) as unknown as (ScheduledPostRow & { platform: string; account_id: string; project_id: string; job_status: string })[];
    for (const s of scheduled) {
      events.push({
        id: `sched-${s.id}`,
        kind: s.job_status === "PUBLISHED" ? "published" : s.status === "CANCELLED" || s.job_status === "CANCELLED" ? "cancelled" : s.job_status === "FAILED" ? "failed" : "scheduled",
        jobId: s.job_id,
        platform: s.platform,
        accountId: s.account_id,
        projectId: s.project_id,
        atUtc: s.scheduled_for_utc,
        timezone: s.timezone,
        status: s.job_status,
        title: titleOf(s.job_id, "Scheduled post"),
      });
    }
    const others = getDb()
      .prepare(
        `SELECT * FROM publish_jobs WHERE user_id = ? AND id NOT IN (SELECT job_id FROM scheduled_posts)
         AND COALESCE(published_at, updated_at) >= ? AND COALESCE(published_at, updated_at) <= ?${extra.replaceAll("j.platform", "platform").replaceAll("j.account_id", "account_id").replaceAll("j.project_id", "project_id")}`,
      )
      .all(userId, from, to, ...(fp as never[])) as unknown as PublishJobRow[];
    for (const j of others) {
      events.push({
        id: `job-${j.id}`,
        kind: j.status === "PUBLISHED" ? "published" : j.status === "FAILED" || j.status === "AUTH_REQUIRED" ? "failed" : j.status === "CANCELLED" ? "cancelled" : "draft",
        jobId: j.id,
        platform: j.platform,
        accountId: j.account_id,
        projectId: j.project_id,
        atUtc: j.published_at ?? j.updated_at,
        timezone: "UTC",
        status: j.status,
        title: titleOf(j.id, "Publishing job"),
      });
    }
    events.sort((a, b) => String(a.atUtc).localeCompare(String(b.atUtc)));
    res.json({ events });
  });

  pub.get("/history", requireAuth, (req: AuthedRequest, res) => {
    const rows = getDb()
      .prepare(
        "SELECT * FROM publish_jobs WHERE user_id = ? AND status IN ('PUBLISHED', 'FAILED', 'CANCELLED') ORDER BY updated_at DESC LIMIT 200",
      )
      .all(req.user!.id) as unknown as PublishJobRow[];
    res.json({ jobs: rows.map(publicJob) });
  });

  pub.get("/jobs/:jobId/attempts", requireAuth, (req: AuthedRequest, res) => {
    const job = ownedJob(req.user!.id, String(req.params.jobId));
    if (!job) return fail(res, 404, "NOT_FOUND", "Publishing job not found.");
    const rows = getDb()
      .prepare("SELECT * FROM publish_attempts WHERE job_id = ? ORDER BY attempt_no ASC")
      .all(job.id) as unknown as PublishAttemptRow[];
    res.json({
      attempts: rows.map((a) => ({
        id: a.id,
        attemptNo: a.attempt_no,
        kind: a.kind,
        status: a.status,
        providerRequestId: a.provider_request_id,
        providerResponse: a.provider_response_json ? parseJson(a.provider_response_json, null) : null,
        error: a.error,
        createdAt: a.created_at,
      })),
    });
  });

  pub.get("/jobs/:jobId/metrics", requireAuth, (req: AuthedRequest, res) => {
    const job = ownedJob(req.user!.id, String(req.params.jobId));
    if (!job) return fail(res, 404, "NOT_FOUND", "Publishing job not found.");
    const post = getDb().prepare("SELECT id FROM platform_posts WHERE job_id = ?").get(job.id) as { id: string } | undefined;
    if (!post) {
      return res.json({ metricsStatus: "unavailable", metrics: null, note: "This job has not been published, so no metrics exist." });
    }
    const snap = getDb()
      .prepare("SELECT * FROM post_analytics_snapshots WHERE platform_post_id = ?")
      .get(post.id) as PostAnalyticsSnapshotRow | undefined;
    if (!snap) {
      return res.json({ metricsStatus: "unavailable", metrics: null, note: "No analytics snapshot exists for this post yet." });
    }
    res.json({
      metricsStatus: snap.metrics_status,
      metrics:
        snap.metrics_status === "ok"
          ? { views: snap.views, likes: snap.likes, comments: snap.comments, shares: snap.shares }
          : null,
      metricSource: snap.metric_source,
      lastSyncedAt: snap.last_synced_at,
      note:
        snap.metrics_status === "unavailable"
          ? "Metrics are unavailable for this platform under the permissions CLIPFORGE requested — unavailable is not the same as zero."
          : undefined,
    });
  });

  pub.post("/jobs/:jobId/metrics/sync", requireAuth, async (req: AuthedRequest, res) => {
    const job = ownedJob(req.user!.id, String(req.params.jobId));
    if (!job) return fail(res, 404, "NOT_FOUND", "Publishing job not found.");
    if (job.status !== "PUBLISHED") return fail(res, 409, "NOT_PUBLISHED", "Only published posts have metrics to sync.");
    await syncMetricsForJob(job.id);
    const fresh = ownedJob(req.user!.id, job.id)!;
    void fresh;
    // Reuse the GET handler's shape by redirecting through a fresh read:
    const post = getDb().prepare("SELECT id FROM platform_posts WHERE job_id = ?").get(job.id) as { id: string } | undefined;
    const snap = post
      ? (getDb().prepare("SELECT * FROM post_analytics_snapshots WHERE platform_post_id = ?").get(post.id) as PostAnalyticsSnapshotRow | undefined)
      : undefined;
    res.json({
      metricsStatus: snap?.metrics_status ?? "unavailable",
      metrics:
        snap?.metrics_status === "ok"
          ? { views: snap.views, likes: snap.likes, comments: snap.comments, shares: snap.shares }
          : null,
      metricSource: snap?.metric_source ?? null,
      lastSyncedAt: snap?.last_synced_at ?? null,
    });
  });

  app.use("/api/publishing", pub);

  // -- OAuth callback (top-level GET; state is its protection) -----------------
  app.get("/api/publishing/oauth/:platform/callback", async (req, res) => {
    const platform = String(req.params.platform);
    const back = (params: Record<string, string>) => {
      const qs = new URLSearchParams(params).toString();
      res.redirect(`${config.appBaseUrl}/#/publishing-calendar?${qs}`);
    };
    if (!isPlatform(platform)) return back({ pub_error: "Unknown platform in the OAuth callback." });
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const providerError = typeof req.query.error === "string" ? req.query.error : "";
    const db = getDb();
    const connection = state
      ? (db.prepare("SELECT * FROM oauth_connections WHERE state_hash = ? AND platform = ?").get(sha256(state), platform) as OAuthConnectionRow | undefined)
      : undefined;
    if (!connection || connection.status !== "PENDING" || new Date(connection.expires_at).getTime() <= Date.now()) {
      return back({ pub_error: "This authorization link is invalid or has expired. Start the connection again from CLIPFORGE." });
    }
    if (providerError) {
      db.prepare("UPDATE oauth_connections SET status = 'FAILED', error = ? WHERE id = ?").run(
        `The platform returned: ${providerError}${typeof req.query.error_description === "string" ? ` — ${req.query.error_description}` : ""}`,
        connection.id,
      );
      return back({ pub_error: `Authorization was not completed (${providerError}). No account was connected.` });
    }
    if (!code) {
      // No code came back: consume the connection NOW (FAILED, as on
      // the provider-error path above) instead of leaving it PENDING
      // until it expires.
      db.prepare("UPDATE oauth_connections SET status = 'FAILED', error = ? WHERE id = ?").run(
        "The platform did not return an authorization code.",
        connection.id,
      );
      return back({ pub_error: "The platform did not return an authorization code. No account was connected." });
    }
    try {
      const adapter = getAdapter(platform);
      const tokens = await adapter.exchangeCode(code, connection.code_verifier);
      const info = await adapter.getAccountInfo(tokens.accessToken);
      const grantedScopes = (tokens.scope ?? "")
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const scopesToStore = grantedScopes.length ? grantedScopes : adapter.scopes;
      let account = db
        .prepare("SELECT * FROM platform_accounts WHERE user_id = ? AND platform = ? AND platform_account_id = ?")
        .get(connection.user_id, platform, info.platformAccountId) as PlatformAccountRow | undefined;
      if (account) {
        db.prepare(
          "UPDATE platform_accounts SET username = ?, display_name = ?, profile_image_url = ?, account_type = ?, status = 'CONNECTED', granted_scopes_json = ?, token_expires_at = ?, last_synced_at = ?, updated_at = ? WHERE id = ?",
        ).run(info.username, info.displayName, info.profileImageUrl, info.accountType, JSON.stringify(scopesToStore), tokens.expiresAt, nowIso(), nowIso(), account.id);
        account = ownedAccount(connection.user_id, account.id)!;
      } else {
        const accountId = newId();
        db.prepare(
          `INSERT INTO platform_accounts (id, user_id, platform, platform_account_id, username, display_name, profile_image_url, account_type, status, granted_scopes_json, token_expires_at, last_synced_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'CONNECTED', ?, ?, ?, ?, ?)`,
        ).run(accountId, connection.user_id, platform, info.platformAccountId, info.username, info.displayName, info.profileImageUrl, info.accountType, JSON.stringify(scopesToStore), tokens.expiresAt, nowIso(), nowIso(), nowIso());
        account = ownedAccount(connection.user_id, accountId)!;
      }
      saveTokens(account, tokens);
      db.prepare("UPDATE oauth_connections SET status = 'COMPLETED', account_id = ? WHERE id = ?").run(account.id, connection.id);
      await fetchAndStoreCapabilities(account, tokens).catch(() => undefined);
      return back({ pub_connected: platform });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      db.prepare("UPDATE oauth_connections SET status = 'FAILED', error = ? WHERE id = ?").run(message.slice(0, 500), connection.id);
      logError(connection.user_id, platform, "OAUTH_CALLBACK", "OAUTH_FAILED", message);
      return back({ pub_error: `Connection failed: ${message}` });
    }
  });

  // -- Webhooks (§18): signature-authenticated, CSRF-exempt (see app.ts) -------
  app.get("/api/publishing/webhooks/meta", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && config.publishing.instagram.webhookVerifyToken && token === config.publishing.instagram.webhookVerifyToken) {
      res.status(200).send(String(challenge ?? ""));
      return;
    }
    res.status(403).json({ error: "Webhook verification failed." });
  });

  app.post("/api/publishing/webhooks/meta", (req: AuthedRequest, res) => {
    const secret = config.publishing.instagram.appSecret;
    if (!secret) {
      return fail(res, 503, "CONFIGURATION_ERROR", "Meta webhooks are not configured (META_APP_SECRET is not set).");
    }
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const signature = req.header("x-hub-signature-256") ?? "";
    const expected = `sha256=${crypto.createHmac("sha256", secret).update(raw).digest("hex")}`;
    const ok =
      signature.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    if (!ok) return fail(res, 401, "INVALID_SIGNATURE", "Webhook signature verification failed.");
    storeWebhookEvent("instagram", raw, true);
    res.json({ ok: true });
  });

  app.post("/api/publishing/webhooks/tiktok", (req: AuthedRequest, res) => {
    const secret = config.publishing.tiktok.clientSecret;
    if (!secret) {
      return fail(res, 503, "CONFIGURATION_ERROR", "TikTok webhooks are not configured (TIKTOK_CLIENT_SECRET is not set).");
    }
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const header = req.header("tiktok-signature") ?? "";
    const m = /t=(\d+),s=([0-9a-f]+)/i.exec(header);
    let ok = false;
    if (m) {
      const expected = crypto.createHmac("sha256", secret).update(`${m[1]}.${raw.toString("utf8")}`).digest("hex");
      ok = m[2].length === expected.length && crypto.timingSafeEqual(Buffer.from(m[2]), Buffer.from(expected));
    }
    if (!ok) return fail(res, 401, "INVALID_SIGNATURE", "Webhook signature verification failed.");
    storeWebhookEvent("tiktok", raw, true);
    res.json({ ok: true });
  });
}

/** Idempotent webhook event storage: the same delivery twice is one
 *  row (event id = hash of the raw payload when the provider gives
 *  no stable id of its own). Events are stored for audit; job status
 *  truth continues to come from the status-query APIs, because the
 *  providers' publishing webhooks do not reliably report post state. */
function storeWebhookEvent(provider: string, raw: Buffer, signatureValid: boolean): void {
  const text = raw.toString("utf8");
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* keep raw only */
  }
  const eventId =
    (typeof parsed.event_id === "string" && parsed.event_id) ||
    (typeof (parsed as { event?: unknown }).event === "string" ? sha256(text) : sha256(text));
  const eventType =
    (typeof parsed.event === "string" ? parsed.event : null) ??
    (typeof parsed.object === "string" ? parsed.object : null);
  try {
    getDb()
      .prepare(
        "INSERT OR IGNORE INTO platform_webhook_events (id, provider, event_id, event_type, payload_json, signature_valid, processed, received_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)",
      )
      .run(newId(), provider, eventId, eventType, text.slice(0, 20000), signatureValid ? 1 : 0, nowIso());
  } catch {
    /* storage is best-effort; the 200 response contract stands */
  }
}
