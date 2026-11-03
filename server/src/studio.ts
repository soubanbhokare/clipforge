// CLIPFORGE API — Phase 3: Studio projects, source uploads, YouTube
// URL validation.
//
// Honesty rules enforced here:
//  - Upload success is only reported AFTER the file is stored and
//    FFprobe has verified a real video stream + extracted metadata.
//  - YouTube validation NEVER imports media: it reports URL validity,
//    metadata availability, authorization and import as five separate
//    statuses. No scraping or downloading of YouTube media exists.
//  - Every project/asset/session lookup is ownership-scoped: another
//    user's resource is indistinguishable from a missing one (404).
//  - Uploaded binaries live in the local storage adapter directory
//    (server/data/media, gitignored) — never in the database.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { config, youtubeConfigured } from "./config.js";
import {
  getDb,
  type ProjectRow,
  type SourceAssetRow,
  type UploadSessionRow,
  type UserRow,
} from "./db.js";
import {
  ALLOWED_EXTENSIONS,
  containerMatchesExtension,
  contentTypeForContainer,
  deleteStoredFiles,
  extensionOf,
  isAllowedExtension,
  makeThumbnail,
  mediaPath,
  probeFile,
  storedFileExists,
  thumbnailPath,
} from "./media.js";
import { currentWorkspaceId, recordUsage } from "./accountCore.js";
import { urlImportAvailability } from "./urlImport.js";

// ---- shared constants ----------------------------------------------------

export const PROJECT_STATUSES = [
  "DRAFT",
  "VALIDATING",
  "UPLOAD_PENDING",
  "UPLOADING",
  "UPLOADED",
  "METADATA_EXTRACTION",
  "READY_FOR_ANALYSIS",
  "REQUIRES_AUTHORIZATION",
  "REQUIRES_SOURCE_FILE",
  "FAILED",
  "CANCELLED",
] as const;

export const WORKFLOW_TYPES = ["LONG_VIDEO_TO_SHORTS", "SHORT_VIDEO_ENHANCEMENT"] as const;

// ---- helpers ---------------------------------------------------------------

const nowIso = (): string => new Date().toISOString();
const newId = (): string => crypto.randomUUID();

interface AuthedRequest extends Request {
  user?: UserRow;
}

type RequireAuth = (req: AuthedRequest, res: Response, next: NextFunction) => void;

export function publicAsset(a: SourceAssetRow) {
  return {
    id: a.id,
    projectId: a.project_id,
    sourceType: a.source_type,
    originalFilename: a.original_filename,
    sourceUrl: a.source_url,
    externalId: a.external_id,
    storageProvider: a.storage_provider,
    fileSize: a.file_size,
    duration: a.duration,
    width: a.width,
    height: a.height,
    frameRate: a.frame_rate,
    videoCodec: a.video_codec,
    audioCodec: a.audio_codec,
    hasAudio: a.has_audio === null ? null : a.has_audio === 1,
    container: a.container,
    bitrate: a.bitrate,
    validationStatus: a.validation_status,
    validationError: a.validation_error,
    hasThumbnail: storedFileExists(a.storage_key) && fs.existsSync(thumbnailPath(a.storage_key as string)),
    createdAt: a.created_at,
  };
}

function publicProject(p: ProjectRow, asset?: SourceAssetRow | null) {
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(p.settings_json) as Record<string, unknown>;
  } catch {
    settings = {};
  }
  return {
    id: p.id,
    name: p.name,
    workflowType: p.workflow_type,
    status: p.status,
    settings,
    aiInstruction: p.ai_instruction,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    sourceAsset: asset ? publicAsset(asset) : null,
  };
}

function publicSession(s: UploadSessionRow) {
  return {
    id: s.id,
    projectId: s.project_id,
    sourceAssetId: s.source_asset_id,
    status: s.upload_status,
    bytesUploaded: s.bytes_uploaded,
    totalBytes: s.total_bytes,
    expiresAt: s.expires_at,
    createdAt: s.created_at,
  };
}

function ownedProject(userId: string, id: string): ProjectRow | undefined {
  const row = getDb()
    .prepare("SELECT * FROM projects WHERE id = ?")
    .get(id) as ProjectRow | undefined;
  if (!row) return undefined;
  // Phase 12 workspace access: a project is visible inside its own
  // workspace to that workspace's members (the caller's active
  // workspace IS a membership-checked pointer, so matching it proves
  // membership). It 404s from any other workspace and for non-members.
  // Rows without a workspace (pre-v12 legacy) stay owner-only.
  const wsId = currentWorkspaceId(userId);
  if (row.workspace_id) {
    return wsId && row.workspace_id === wsId ? row : undefined;
  }
  return row.user_id === userId ? row : undefined;
}

function ownedAsset(userId: string, id: string): SourceAssetRow | undefined {
  return getDb()
    .prepare("SELECT * FROM source_assets WHERE id = ? AND user_id = ?")
    .get(id, userId) as SourceAssetRow | undefined;
}

function ownedSession(userId: string, id: string): UploadSessionRow | undefined {
  return getDb()
    .prepare("SELECT * FROM upload_sessions WHERE id = ? AND user_id = ?")
    .get(id, userId) as UploadSessionRow | undefined;
}

function latestAsset(projectId: string): SourceAssetRow | undefined {
  return getDb()
    .prepare("SELECT * FROM source_assets WHERE project_id = ? ORDER BY rowid DESC LIMIT 1")
    .get(projectId) as SourceAssetRow | undefined;
}

function setProjectStatus(projectId: string, status: string): void {
  getDb()
    .prepare("UPDATE projects SET status = ?, updated_at = ? WHERE id = ?")
    .run(status, nowIso(), projectId);
}

/** Recompute a project's status from whatever source it currently has. */
function recomputeProjectStatus(projectId: string): void {
  const assets = getDb()
    .prepare("SELECT * FROM source_assets WHERE project_id = ? ORDER BY rowid DESC")
    .all(projectId) as unknown as SourceAssetRow[];
  if (assets.some((a) => a.validation_status === "VALID")) {
    setProjectStatus(projectId, "READY_FOR_ANALYSIS");
  } else if (assets.some((a) => a.source_type === "YOUTUBE_URL")) {
    setProjectStatus(projectId, "REQUIRES_SOURCE_FILE");
  } else {
    setProjectStatus(projectId, "DRAFT");
  }
}

// ---- settings validation ---------------------------------------------------

const captionsSchema = z.object({
  enabled: z.boolean().optional(),
  style: z.enum(["clean", "bold", "minimal", "highlight"]).optional(),
  animatedHighlight: z.boolean().optional(),
});

const settingsASchema = z
  .object({
    clipCount: z.enum(["1", "3", "5", "10", "custom"]).optional(),
    customClipCount: z.number().int().min(1).max(50).nullable().optional(),
    clipDuration: z.enum(["auto", "15", "30", "45", "60", "custom"]).optional(),
    customClipDurationSec: z.number().int().min(5).max(600).nullable().optional(),
    aspectRatio: z.enum(["9:16", "1:1", "16:9", "4:5"]).optional(),
    resolution: z.enum(["720p", "1080p", "4k"]).optional(),
    targetPlatform: z.enum(["youtube-shorts", "instagram-reels", "tiktok", "custom"]).optional(),
    language: z.enum(["auto", "en", "hi", "mr", "other"]).optional(),
    captions: captionsSchema.optional(),
    tracking: z.enum(["face-lock", "auto-follow", "active-speaker", "center", "manual", "none"]).optional(),
    zoom: z.enum(["subtle", "balanced", "dynamic", "manual"]).optional(),
    audio: z
      .array(z.enum(["preserve", "silence-removal", "enhancement", "background-music", "voice-emphasis"]))
      .max(5)
      .optional(),
    discoveryPrompt: z.string().max(500).optional(),
    transcriptionContext: z.string().max(1000).optional(),
  })
  .strict();

const settingsBSchema = z
  .object({
    reframeAspect: z.enum(["9:16", "1:1", "16:9", "4:5"]).optional(),
    faceTracking: z.enum(["face-lock", "follow-speaker", "center", "manual"]).optional(),
    captionsMode: z.enum(["generate", "preserve", "remove", "edit-later"]).optional(),
    audio: z.array(z.enum(["preserve", "noise-reduction", "normalization", "music-layer"])).max(4).optional(),
    visual: z
      .array(z.enum(["background-blur", "zoom", "text-overlay", "logo-watermark", "brand-template"]))
      .max(5)
      .optional(),
  })
  .strict();

// ---- YouTube URL parsing -----------------------------------------------------

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export type YouTubeParse =
  | { ok: true; videoId: string; canonicalUrl: string }
  | { ok: false; error: string };

export function parseYouTubeUrl(raw: string): YouTubeParse {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, error: "Enter a valid URL, for example https://www.youtube.com/watch?v=VIDEO_ID." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: "Only http(s) YouTube links are supported." };
  }
  const host = url.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) {
    return { ok: false, error: "This doesn't look like a YouTube link. Paste a youtube.com or youtu.be URL." };
  }
  let videoId: string | null = null;
  if (host === "youtu.be") {
    videoId = url.pathname.split("/").filter(Boolean)[0] ?? null;
  } else if (url.pathname === "/watch") {
    videoId = url.searchParams.get("v");
  } else {
    const match = /^\/(shorts|embed|live|v)\/([^/?#]+)/.exec(url.pathname);
    if (match) videoId = match[2];
  }
  if (!videoId || !VIDEO_ID_RE.test(videoId)) {
    return { ok: false, error: "No valid YouTube video ID was found in that link. Use a watch, Shorts or youtu.be link to a specific video." };
  }
  return { ok: true, videoId, canonicalUrl: `https://www.youtube.com/watch?v=${videoId}` };
}

// ---- routes ------------------------------------------------------------------

export function registerStudioRoutes(app: express.Express, requireAuth: RequireAuth): void {
  const router = express.Router();
  const maxBytes = config.maxUploadMb * 1024 * 1024;

  fs.mkdirSync(path.join(config.mediaDir, ".tmp"), { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination: path.join(config.mediaDir, ".tmp"),
      filename: (_req, _file, cb) => cb(null, `${newId()}.part`),
    }),
    limits: { fileSize: maxBytes, files: 1 },
  });

  // -- Studio configuration (limits the UI must honour) --
  router.get("/studio/config", requireAuth, (_req, res) => {
    res.json({
      maxUploadMb: config.maxUploadMb,
      maxUploadBytes: maxBytes,
      allowedExtensions: ALLOWED_EXTENSIONS,
      storageProvider: "local",
      youtubeConfigured,
      cloudImportConfigured: false,
      // URL import (yt-dlp): a separate capability from cloud
      // STORAGE import above — importing a video from a pasted URL
      // is available exactly when the downloader resolves.
      urlImport: urlImportAvailability(),
    });
  });

  // -- Create project (idempotent) --
  const createProjectSchema = z.object({
    name: z.string().trim().min(1).max(120).optional(),
    workflowType: z.enum(WORKFLOW_TYPES),
    sourceType: z.enum(["UPLOAD", "YOUTUBE_URL"]).optional(),
    youtube: z.object({ url: z.string().max(2048), videoId: z.string().regex(VIDEO_ID_RE) }).optional(),
  });

  router.post("/projects", requireAuth, (req: AuthedRequest, res) => {
    const parsed = createProjectSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid project." });
      return;
    }
    const user = req.user!;
    const db = getDb();
    const idemHeader = req.header("idempotency-key");
    const idempotencyKey = idemHeader && idemHeader.length <= 128 ? idemHeader : null;
    // Idempotency is scoped to the caller's ACTIVE workspace, the same
    // scoping the rest of this module applies to projects: a key that
    // created a project in workspace A must never silently return that
    // project when replayed from workspace B. ("workspace_id IS ?"
    // matches the value, or NULL when the caller has no active
    // workspace — the scope a key created with no workspace lives in.)
    const wsId = currentWorkspaceId(user.id);
    const findByIdempotencyKey = (): ProjectRow | undefined =>
      db
        .prepare("SELECT * FROM projects WHERE user_id = ? AND idempotency_key = ? AND workspace_id IS ?")
        .get(user.id, idempotencyKey, wsId) as ProjectRow | undefined;
    if (idempotencyKey) {
      const existing = findByIdempotencyKey();
      if (existing) {
        res.status(200).json({ project: publicProject(existing, latestAsset(existing.id)) });
        return;
      }
    }
    const now = nowIso();
    const project: ProjectRow = {
      id: newId(),
      user_id: user.id,
      name: parsed.data.name ?? "Untitled project",
      workflow_type: parsed.data.workflowType,
      status: "DRAFT",
      settings_json: "{}",
      ai_instruction: null,
      idempotency_key: idempotencyKey,
      created_at: now,
      updated_at: now,
      // Phase 12: new projects belong to the caller's active workspace.
      workspace_id: wsId,
    };
    try {
      db.prepare(
        "INSERT INTO projects (id, user_id, name, workflow_type, status, settings_json, ai_instruction, idempotency_key, created_at, updated_at, workspace_id) VALUES (?, ?, ?, ?, ?, '{}', NULL, ?, ?, ?, ?)",
      ).run(project.id, project.user_id, project.name, project.workflow_type, project.status, project.idempotency_key, now, now, project.workspace_id ?? null);
    } catch {
      // Unique idempotency index raced — return the winner, but ONLY
      // when it lives in the caller's active workspace. If the key was
      // already spent in a DIFFERENT workspace, say so (409) instead of
      // returning that workspace's project across the boundary.
      if (idempotencyKey) {
        const winner = findByIdempotencyKey();
        if (winner) {
          res.status(200).json({ project: publicProject(winner, latestAsset(winner.id)) });
          return;
        }
        const spentElsewhere = db
          .prepare("SELECT id FROM projects WHERE user_id = ? AND idempotency_key = ?")
          .get(user.id, idempotencyKey) as { id: string } | undefined;
        if (spentElsewhere) {
          res.status(409).json({
            error:
              "This idempotency key was already used to create a project in a different workspace. Switch to that workspace to reuse it, or send the request without an idempotency key to create a separate project here.",
          });
          return;
        }
      }
      throw new Error("project insert failed");
    }

    if (parsed.data.sourceType === "YOUTUBE_URL" && parsed.data.youtube) {
      const asset: SourceAssetRow = {
        id: newId(),
        project_id: project.id,
        user_id: user.id,
        source_type: "YOUTUBE_URL",
        original_filename: `YouTube video ${parsed.data.youtube.videoId}`,
        source_url: parsed.data.youtube.url,
        external_id: parsed.data.youtube.videoId,
        storage_key: null,
        storage_provider: "local",
        file_size: null,
        duration: null,
        width: null,
        height: null,
        frame_rate: null,
        video_codec: null,
        audio_codec: null,
        has_audio: null,
        container: null,
        bitrate: null,
        validation_status: "REQUIRES_SOURCE_FILE",
        validation_error: null,
        created_at: now,
      };
      db.prepare(
        `INSERT INTO source_assets (id, project_id, user_id, source_type, original_filename, source_url, external_id, storage_key, storage_provider, file_size, duration, width, height, frame_rate, video_codec, audio_codec, has_audio, container, bitrate, validation_status, validation_error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'local', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'REQUIRES_SOURCE_FILE', NULL, ?)`,
      ).run(asset.id, asset.project_id, asset.user_id, asset.source_type, asset.original_filename, asset.source_url, asset.external_id, now);
      setProjectStatus(project.id, "REQUIRES_SOURCE_FILE");
      project.status = "REQUIRES_SOURCE_FILE";
      res.status(201).json({ project: publicProject(project, asset) });
      return;
    }

    res.status(201).json({ project: publicProject(project, null) });
  });

  // -- List projects (search / filter / sort / paginate) --
  router.get("/projects", requireAuth, (req: AuthedRequest, res) => {
    const user = req.user!;
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const workflow = typeof req.query.workflow === "string" ? req.query.workflow : "";
    const status = typeof req.query.status === "string" ? req.query.status : "";
    const sortRaw = typeof req.query.sort === "string" ? req.query.sort : "newest";
    const sortSql: Record<string, string> = {
      newest: "created_at DESC, rowid DESC",
      oldest: "created_at ASC, rowid ASC",
      name: "name COLLATE NOCASE ASC",
      "name-desc": "name COLLATE NOCASE DESC",
      updated: "updated_at DESC, rowid DESC",
    };
    const order = sortSql[sortRaw] ?? sortSql.newest;
    const page = Math.max(1, Number.parseInt(String(req.query.page ?? "1"), 10) || 1);
    const pageSize = Math.min(50, Math.max(1, Number.parseInt(String(req.query.pageSize ?? "20"), 10) || 20));

    // Phase 12: the project list shows the ACTIVE workspace's
    // projects (workspace membership is what grants access — the
    // owner sees theirs, invited members see the shared ones), plus
    // any legacy owner rows that predate workspaces.
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    const activeWs = currentWorkspaceId(user.id);
    if (activeWs) {
      clauses.push("(workspace_id = ? OR (workspace_id IS NULL AND user_id = ?))");
      params.push(activeWs, user.id);
    } else {
      clauses.push("user_id = ?");
      params.push(user.id);
    }
    if (search) {
      clauses.push("instr(lower(name), lower(?)) > 0");
      params.push(search);
    }
    if ((WORKFLOW_TYPES as readonly string[]).includes(workflow)) {
      clauses.push("workflow_type = ?");
      params.push(workflow);
    }
    if ((PROJECT_STATUSES as readonly string[]).includes(status)) {
      clauses.push("status = ?");
      params.push(status);
    }
    const where = clauses.join(" AND ");
    const db = getDb();
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM projects WHERE ${where}`).get(...params) as { n: number }).n;
    const rows = db
      .prepare(`SELECT * FROM projects WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize) as unknown as ProjectRow[];
    const projects = rows.map((p) => publicProject(p, latestAsset(p.id)));
    res.json({ projects, total, page, pageSize });
  });

  // -- Get one project --
  router.get("/projects/:id", requireAuth, (req: AuthedRequest, res) => {
    const project = ownedProject(req.user!.id, req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found." });
      return;
    }
    res.json({ project: publicProject(project, latestAsset(project.id)) });
  });

  // -- Rename / settings / AI instruction --
  const patchSchema = z.object({
    name: z.string().trim().min(1).max(120).optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
    aiInstruction: z.string().max(500).nullable().optional(),
  });

  router.patch("/projects/:id", requireAuth, (req: AuthedRequest, res) => {
    const project = ownedProject(req.user!.id, req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found." });
      return;
    }
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid update." });
      return;
    }
    let settingsJson = project.settings_json;
    let aiInstruction = project.ai_instruction;
    if (parsed.data.settings !== undefined) {
      const schema = project.workflow_type === "LONG_VIDEO_TO_SHORTS" ? settingsASchema : settingsBSchema;
      const validated = schema.safeParse(parsed.data.settings);
      if (!validated.success) {
        res.status(400).json({ error: `Invalid settings: ${validated.error.issues[0]?.message ?? "unknown field or value"}` });
        return;
      }
      settingsJson = JSON.stringify(validated.data);
      const prompt = (validated.data as { discoveryPrompt?: unknown }).discoveryPrompt;
      if (typeof prompt === "string") aiInstruction = prompt === "" ? null : prompt;
    }
    if (parsed.data.aiInstruction !== undefined) aiInstruction = parsed.data.aiInstruction;
    const name = parsed.data.name ?? project.name;
    getDb()
      .prepare("UPDATE projects SET name = ?, settings_json = ?, ai_instruction = ?, updated_at = ? WHERE id = ?")
      .run(name, settingsJson, aiInstruction, nowIso(), project.id);
    const updated = ownedProject(req.user!.id, project.id)!;
    res.json({ project: publicProject(updated, latestAsset(project.id)) });
  });

  // -- Delete project (+ stored files) --
  router.delete("/projects/:id", requireAuth, (req: AuthedRequest, res) => {
    const project = ownedProject(req.user!.id, req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found." });
      return;
    }
    const db = getDb();
    const assets = db
      .prepare("SELECT * FROM source_assets WHERE project_id = ?")
      .all(project.id) as unknown as SourceAssetRow[];
    for (const asset of assets) deleteStoredFiles(asset.storage_key);
    db.prepare("DELETE FROM projects WHERE id = ?").run(project.id);
    res.json({ ok: true });
  });

  // -- Remove a project's source (files + asset rows + sessions) --
  router.delete("/projects/:id/source", requireAuth, (req: AuthedRequest, res) => {
    const project = ownedProject(req.user!.id, req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found." });
      return;
    }
    const db = getDb();
    const assets = db
      .prepare("SELECT * FROM source_assets WHERE project_id = ?")
      .all(project.id) as unknown as SourceAssetRow[];
    for (const asset of assets) deleteStoredFiles(asset.storage_key);
    db.prepare("DELETE FROM source_assets WHERE project_id = ?").run(project.id);
    db.prepare("DELETE FROM upload_sessions WHERE project_id = ?").run(project.id);
    setProjectStatus(project.id, "DRAFT");
    res.json({ ok: true });
  });

  // -- Create upload session --
  const sessionSchema = z.object({
    filename: z.string().trim().min(1).max(255),
    size: z.number().int().positive(),
  });

  router.post("/projects/:id/upload-session", requireAuth, (req: AuthedRequest, res) => {
    const project = ownedProject(req.user!.id, req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found." });
      return;
    }
    const parsed = sessionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid upload session." });
      return;
    }
    const { filename, size } = parsed.data;
    if (!isAllowedExtension(filename)) {
      res.status(400).json({
        error: `This video format is not supported by the current processing setup. Supported formats: ${ALLOWED_EXTENSIONS.map((e) => `.${e}`).join(", ")}.`,
      });
      return;
    }
    if (size > maxBytes) {
      res.status(413).json({
        error: `This file is larger than the current upload limit of ${config.maxUploadMb} MB. Choose a smaller file or raise MAX_UPLOAD_MB on the server.`,
      });
      return;
    }
    const db = getDb();
    const now = nowIso();
    const asset: SourceAssetRow = {
      id: newId(),
      project_id: project.id,
      user_id: req.user!.id,
      source_type: "UPLOAD",
      original_filename: filename,
      source_url: null,
      external_id: null,
      storage_key: null,
      storage_provider: "local",
      file_size: size,
      duration: null,
      width: null,
      height: null,
      frame_rate: null,
      video_codec: null,
      audio_codec: null,
      has_audio: null,
      container: null,
      bitrate: null,
      validation_status: "UPLOAD_PENDING",
      validation_error: null,
      created_at: now,
    };
    db.prepare(
      `INSERT INTO source_assets (id, project_id, user_id, source_type, original_filename, source_url, external_id, storage_key, storage_provider, file_size, duration, width, height, frame_rate, video_codec, audio_codec, has_audio, container, bitrate, validation_status, validation_error, created_at)
       VALUES (?, ?, ?, 'UPLOAD', ?, NULL, NULL, NULL, 'local', ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'UPLOAD_PENDING', NULL, ?)`,
    ).run(asset.id, asset.project_id, asset.user_id, asset.original_filename, asset.file_size, now);
    const session: UploadSessionRow = {
      id: newId(),
      user_id: req.user!.id,
      project_id: project.id,
      source_asset_id: asset.id,
      upload_status: "PENDING",
      bytes_uploaded: 0,
      total_bytes: size,
      expires_at: new Date(Date.now() + config.uploadSessionTtlMinutes * 60_000).toISOString(),
      created_at: now,
    };
    db.prepare(
      "INSERT INTO upload_sessions (id, user_id, project_id, source_asset_id, upload_status, bytes_uploaded, total_bytes, expires_at, created_at) VALUES (?, ?, ?, ?, 'PENDING', 0, ?, ?, ?)",
    ).run(session.id, session.user_id, session.project_id, session.source_asset_id, session.total_bytes, session.expires_at, now);
    setProjectStatus(project.id, "UPLOAD_PENDING");
    res.status(201).json({ session: publicSession(session), asset: publicAsset(asset) });
  });

  // -- Upload session status --
  router.get("/upload-sessions/:id", requireAuth, (req: AuthedRequest, res) => {
    const session = ownedSession(req.user!.id, req.params.id);
    if (!session) {
      res.status(404).json({ error: "Upload session not found." });
      return;
    }
    if (
      session.upload_status === "PENDING" &&
      new Date(session.expires_at).getTime() <= Date.now()
    ) {
      getDb().prepare("UPDATE upload_sessions SET upload_status = 'EXPIRED' WHERE id = ?").run(session.id);
      session.upload_status = "EXPIRED";
    }
    res.json({ session: publicSession(session) });
  });

  // -- Cancel upload session --
  router.post("/upload-sessions/:id/cancel", requireAuth, (req: AuthedRequest, res) => {
    const session = ownedSession(req.user!.id, req.params.id);
    if (!session) {
      res.status(404).json({ error: "Upload session not found." });
      return;
    }
    if (session.upload_status === "COMPLETED") {
      res.status(409).json({ error: "This upload has already completed and cannot be cancelled." });
      return;
    }
    const db = getDb();
    db.prepare("UPDATE upload_sessions SET upload_status = 'CANCELLED' WHERE id = ?").run(session.id);
    if (session.source_asset_id) {
      const asset = ownedAsset(req.user!.id, session.source_asset_id);
      if (asset && asset.validation_status !== "VALID") {
        deleteStoredFiles(asset.storage_key);
        db.prepare("DELETE FROM source_assets WHERE id = ?").run(asset.id);
      }
    }
    recomputeProjectStatus(session.project_id);
    res.json({ ok: true });
  });

  // -- Upload the file for a session --
  router.post("/upload-sessions/:id/file", requireAuth, (req: AuthedRequest, res) => {
    const session = ownedSession(req.user!.id, req.params.id);
    if (!session) {
      res.status(404).json({ error: "Upload session not found." });
      return;
    }
    if (new Date(session.expires_at).getTime() <= Date.now()) {
      getDb().prepare("UPDATE upload_sessions SET upload_status = 'EXPIRED' WHERE id = ?").run(session.id);
      res.status(410).json({ error: "This upload session has expired. Start a new upload to try again." });
      return;
    }
    if (session.upload_status !== "PENDING") {
      res.status(409).json({ error: `This upload session is ${session.upload_status.toLowerCase()} and cannot accept a file. Start a new upload session.` });
      return;
    }
    const asset = session.source_asset_id ? ownedAsset(req.user!.id, session.source_asset_id) : undefined;
    if (!asset) {
      res.status(404).json({ error: "Source asset for this upload was not found." });
      return;
    }
    const db = getDb();
    db.prepare("UPDATE upload_sessions SET upload_status = 'UPLOADING' WHERE id = ?").run(session.id);
    setProjectStatus(session.project_id, "UPLOADING");

    upload.single("file")(req, res, async (err: unknown) => {
      const fail = (status: number, message: string) => {
        db.prepare("UPDATE upload_sessions SET upload_status = 'FAILED' WHERE id = ?").run(session.id);
        db.prepare(
          "UPDATE source_assets SET validation_status = 'FAILED', validation_error = ? WHERE id = ?",
        ).run(message, asset.id);
        setProjectStatus(session.project_id, "FAILED");
        if (!res.headersSent) res.status(status).json({ error: message });
      };
      try {
        if (err) {
          const multerErr = err as { code?: string };
          if (multerErr.code === "LIMIT_FILE_SIZE") {
            fail(413, `This file is larger than the current upload limit of ${config.maxUploadMb} MB.`);
          } else {
            fail(400, "The upload could not be read. Please choose the file again and retry.");
          }
          return;
        }
        const file = (req as Request & { file?: Express.Multer.File }).file;
        if (!file) {
          fail(400, "No file was received. Choose a video file and try again.");
          return;
        }
        // Extension of the actual uploaded name must match the session.
        if (extensionOf(file.originalname) !== extensionOf(asset.original_filename)) {
          fs.rmSync(file.path, { force: true });
          fail(400, "The uploaded file does not match the file chosen for this upload session. Start a new upload.");
          return;
        }
        // Declared-size enforcement — STRICT rule: the received byte
        // count must EXACTLY equal the size declared when this upload
        // session was created (session.total_bytes). The client
        // declares the real file size and a file transfer does not
        // change byte counts, so ANY difference — smaller (truncated
        // or swapped file) or larger (padded) — means the bytes
        // received are not the declared file. Reject and keep nothing.
        if (file.size !== session.total_bytes) {
          fs.rmSync(file.path, { force: true });
          fail(
            400,
            `The uploaded file is ${file.size} bytes, but ${session.total_bytes} bytes were declared for this upload session. The file may have changed or been truncated — start a new upload.`,
          );
          return;
        }
        const storageKey = `${req.user!.id}/${asset.id}.${extensionOf(asset.original_filename)}`;
        fs.mkdirSync(path.dirname(mediaPath(storageKey)), { recursive: true });
        fs.renameSync(file.path, mediaPath(storageKey));
        db.prepare("UPDATE upload_sessions SET bytes_uploaded = ? WHERE id = ?").run(file.size, session.id);
        db.prepare("UPDATE source_assets SET storage_key = ?, file_size = ? WHERE id = ?").run(storageKey, file.size, asset.id);
        setProjectStatus(session.project_id, "METADATA_EXTRACTION");

        // Server-side inspection — the ONLY source of metadata truth.
        let meta;
        try {
          meta = await probeFile(mediaPath(storageKey));
        } catch (probeErr) {
          deleteStoredFiles(storageKey);
          db.prepare("UPDATE source_assets SET storage_key = NULL WHERE id = ?").run(asset.id);
          fail(422, probeErr instanceof Error ? probeErr.message : "This file could not be read as a video. It may be damaged or in an unsupported format.");
          return;
        }
        // The probed container must agree with the declared extension's
        // family. A renamed file (e.g. WebM bytes under an .mp4 name)
        // would otherwise be stored under an .mp4 key, marked VALID and
        // later served with a Content-Type derived from the wrong
        // extension. Same failure path as an unreadable file: the
        // stored bytes are removed and the asset fails with the reason.
        const declaredExt = extensionOf(asset.original_filename);
        if (!containerMatchesExtension(meta.container, declaredExt)) {
          deleteStoredFiles(storageKey);
          db.prepare("UPDATE source_assets SET storage_key = NULL WHERE id = ?").run(asset.id);
          fail(
            422,
            `The file's actual format (${meta.container ?? "unknown"}) does not match its .${declaredExt} extension. Rename the file with its real format's extension or convert it to .${declaredExt}, then upload again.`,
          );
          return;
        }
        db.prepare(
          `UPDATE source_assets SET duration = ?, width = ?, height = ?, frame_rate = ?, video_codec = ?, audio_codec = ?, has_audio = ?, container = ?, bitrate = ?, validation_status = 'VALID', validation_error = NULL WHERE id = ?`,
        ).run(
          meta.duration,
          meta.width,
          meta.height,
          meta.frameRate,
          meta.videoCodec,
          meta.audioCodec,
          meta.hasAudio ? 1 : 0,
          meta.container,
          meta.bitrate,
          asset.id,
        );
        await makeThumbnail(storageKey, meta.duration);
        db.prepare("UPDATE upload_sessions SET upload_status = 'COMPLETED' WHERE id = ?").run(session.id);
        setProjectStatus(session.project_id, "READY_FOR_ANALYSIS");

        // Phase 12 usage ledger: one record per stored source video
        // (idempotent on the asset id, so replace-uploads of the same
        // asset never double-count) + its measured duration/storage.
        const wsId = currentWorkspaceId(req.user!.id);
        recordUsage(db, {
          userId: req.user!.id,
          workspaceId: wsId,
          projectId: session.project_id,
          jobId: session.id,
          operation: "upload",
          provider: "local-storage",
          resource: "videos_uploaded",
          unit: "videos",
          quantity: 1,
          idempotencyKey: `upload:${asset.id}:count`,
        });
        if (meta.duration != null) {
          recordUsage(db, {
            userId: req.user!.id,
            workspaceId: wsId,
            projectId: session.project_id,
            jobId: session.id,
            operation: "upload",
            provider: "local-storage",
            resource: "source_duration",
            unit: "seconds",
            quantity: meta.duration,
            idempotencyKey: `upload:${asset.id}:duration`,
          });
        }
        recordUsage(db, {
          userId: req.user!.id,
          workspaceId: wsId,
          projectId: session.project_id,
          jobId: session.id,
          operation: "upload",
          provider: "local-storage",
          resource: "storage_bytes",
          unit: "bytes",
          quantity: file.size,
          entitlementKey: "storage_bytes",
          idempotencyKey: `upload:${asset.id}:bytes`,
        });

        // Replace semantics: a project keeps ONE current source. Older
        // assets (a previous upload or a YouTube placeholder) are
        // removed with their files only after the new source is valid.
        const others = db
          .prepare("SELECT * FROM source_assets WHERE project_id = ? AND id != ?")
          .all(session.project_id, asset.id) as unknown as SourceAssetRow[];
        for (const other of others) {
          deleteStoredFiles(other.storage_key);
          db.prepare("DELETE FROM source_assets WHERE id = ?").run(other.id);
        }

        const updatedAsset = ownedAsset(req.user!.id, asset.id)!;
        const project = ownedProject(req.user!.id, session.project_id)!;
        res.status(200).json({ asset: publicAsset(updatedAsset), project: publicProject(project, updatedAsset) });
      } catch (handlerErr) {
        console.error("[studio] upload handler failed:", handlerErr);
        if (!res.headersSent) fail(500, "The upload failed on the server. Please retry.");
      }
    });
  });

  // -- Source media (ownership-checked) --
  const CONTENT_TYPES: Record<string, string> = {
    mp4: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm",
  };

  router.get("/source-assets/:id/stream", requireAuth, (req: AuthedRequest, res) => {
    const asset = ownedAsset(req.user!.id, req.params.id);
    if (!asset || !asset.storage_key || !storedFileExists(asset.storage_key)) {
      res.status(404).json({ error: "Media not found." });
      return;
    }
    // Serve the type implied by the PROBED container stored at upload
    // time, so a row whose extension disagrees with its actual bytes
    // (e.g. a legacy row stored before container verification) is not
    // served under the extension's type. Fall back to the extension
    // map only when no container was ever recorded.
    res.type(
      contentTypeForContainer(asset.container) ??
        CONTENT_TYPES[extensionOf(asset.original_filename)] ??
        "application/octet-stream",
    );
    res.sendFile(mediaPath(asset.storage_key));
  });

  router.get("/source-assets/:id/thumbnail", requireAuth, (req: AuthedRequest, res) => {
    const asset = ownedAsset(req.user!.id, req.params.id);
    if (!asset || !asset.storage_key || !fs.existsSync(thumbnailPath(asset.storage_key))) {
      res.status(404).json({ error: "Thumbnail not found." });
      return;
    }
    res.type("image/jpeg");
    res.sendFile(thumbnailPath(asset.storage_key));
  });

  // -- YouTube URL validation (metadata only; NEVER imports media) --
  const youtubeSchema = z.object({ url: z.string().trim().min(1).max(2048) });

  router.post("/youtube/validate", requireAuth, async (req, res) => {
    const parsed = youtubeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Paste a YouTube URL to validate." });
      return;
    }
    const result = parseYouTubeUrl(parsed.data.url);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    // The five statuses are deliberately separate. A valid URL is not
    // metadata, metadata is not authorization, and none of them is an
    // import: CLIPFORGE cannot take the media file from YouTube.
    let metadataAvailable = false;
    let metadata: Record<string, unknown> | null = null;
    let metadataNote = "YouTube Data API is not configured on this server, so no metadata was retrieved.";
    if (youtubeConfigured) {
      try {
        const apiUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${encodeURIComponent(result.videoId)}&key=${encodeURIComponent(config.youtubeApiKey)}`;
        const apiRes = await fetch(apiUrl, { signal: AbortSignal.timeout(5000) });
        if (apiRes.ok) {
          const data = (await apiRes.json()) as {
            items?: {
              snippet?: { title?: string; channelTitle?: string; thumbnails?: { medium?: { url?: string } } };
              contentDetails?: { duration?: string };
            }[];
          };
          const item = data.items?.[0];
          if (item?.snippet) {
            metadataAvailable = true;
            metadata = {
              title: item.snippet.title ?? null,
              channelTitle: item.snippet.channelTitle ?? null,
              durationIso: item.contentDetails?.duration ?? null,
              thumbnailUrl: item.snippet.thumbnails?.medium?.url ?? null,
            };
            metadataNote = "Metadata retrieved from the YouTube Data API. Metadata access does not grant access to the original media file.";
          } else {
            metadataNote = "The YouTube Data API returned no metadata for this video.";
          }
        } else {
          metadataNote = "The YouTube Data API could not be reached, so no metadata was retrieved.";
        }
      } catch {
        metadataNote = "The YouTube Data API could not be reached, so no metadata was retrieved.";
      }
    }
    res.json({
      urlValid: true,
      videoId: result.videoId,
      canonicalUrl: result.canonicalUrl,
      metadataAvailable,
      metadata,
      metadataNote,
      authorizationVerified: false,
      mediaAvailable: false,
      imported: false,
      message:
        "This YouTube link is valid, but CLIPFORGE cannot download media from YouTube. To process this video, upload the original video file that you own or are authorized to process.",
    });
  });

  app.use("/api", router);
}
