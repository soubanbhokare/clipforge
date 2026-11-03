// CLIPFORGE — URL import (yt-dlp): paste a video page URL (YouTube
// or any other yt-dlp-supported site) or a direct media URL, and a
// background job downloads the video into the project as its source
// asset. From there the asset is indistinguishable from an upload:
// FFprobe-verified metadata, thumbnail, AI clip detection, captions,
// editor and export all work on it unchanged.
//
// Architecture notes (read before believing anything):
//  - The job is a phase8_jobs row (kind URL_IMPORT), created and
//    drained by the exact Phase 8 machinery the Pexels PROVIDER_IMPORT
//    uses (src/broll.ts): persisted queue, dedupe, cancel via flag +
//    killing the running child process, retry, boot recovery, usage
//    ledger and notifications. Only the processor lives here.
//  - The downloader is the open-source yt-dlp binary (free; no paid
//    APIs, no cookies files, no account logins — those are never
//    used). The binary path is YTDLP_BIN (default "yt-dlp" on PATH).
//    When the feature is disabled (URL_IMPORT_ENABLED=false) or the
//    binary cannot be resolved, the endpoint answers the honest
//    422 CONFIGURATION_ERROR naming the missing dependency and the
//    job is persisted FAILED — nothing is simulated.
//  - SSRF safety: only http/https; the target host must not resolve
//    to a private/loopback/link-local/documentation address. The
//    check runs on the submitted URL (IP literals exactly; DNS names
//    best-effort, since yt-dlp resolves independently — a rebinding
//    name could still land elsewhere, which is why the downloaded
//    FILE is then validated exactly like an upload: FFprobe must
//    find a real video stream in an accepted container family).
//    URL_IMPORT_ALLOW_PRIVATE=1 lifts the address block for the
//    e2e suite's local fixture server ONLY — never in production.
//  - Platform reality: some sites (notably YouTube) block
//    datacenter/server IPs or demand sign-in for some videos. Those
//    imports fail honestly per video with a classified reason
//    (SIGN_IN_REQUIRED / ACCESS_BLOCKED / …) — a platform
//    restriction, never a fake success.
//  - Rights: the licence record stored on the asset states that the
//    URL was supplied by the user, who is responsible for having the
//    rights to process the video (the same basis as uploads).

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { config } from "./config.js";
import {
  getDb,
  type Phase8JobRow,
  type ProjectRow,
  type SourceAssetRow,
  type UserRow,
} from "./db.js";
import {
  containerMatchesExtension,
  deleteStoredFiles,
  makeThumbnail,
  mediaPath,
  probeFile,
  type ProbedMetadata,
} from "./media.js";
import { ownedProject } from "./editor.js";
import { publicAsset } from "./studio.js";
import {
  JobStageError,
  completeJob,
  createFailedJob,
  createJob,
  publicPhase8Job,
  registerJobChild,
  setJobStage,
  throwIfCancelled,
} from "./broll.js";

// ---- helpers ---------------------------------------------------------------

const nowIso = (): string => new Date().toISOString();
const newId = (): string => crypto.randomUUID();
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

interface AuthedRequest extends Request {
  user?: UserRow;
}
type RequireAuth = (req: AuthedRequest, res: Response, next: NextFunction) => void;

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// ---- availability ------------------------------------------------------------

export interface UrlImportAvailability {
  enabled: boolean;
  detail: string;
}

let binCheckCache: { bin: string; ok: boolean } | null = null;

function ytdlpResolvable(): boolean {
  const bin = config.urlImport.bin;
  if (binCheckCache && binCheckCache.bin === bin) return binCheckCache.ok;
  let ok = false;
  try {
    if (bin.includes("/") || bin.includes("\\")) {
      ok = fs.existsSync(bin);
    } else {
      const probe = spawnSync(bin, ["--version"], { timeout: 10_000, stdio: "ignore" });
      ok = !probe.error && probe.status === 0;
    }
  } catch {
    ok = false;
  }
  binCheckCache = { bin, ok };
  return ok;
}

export function urlImportAvailability(): UrlImportAvailability {
  if (config.urlImport.enabledFlag === "false" || config.urlImport.enabledFlag === "0") {
    return {
      enabled: false,
      detail:
        "URL import is disabled on this server (URL_IMPORT_ENABLED=false). Set URL_IMPORT_ENABLED=true (and keep yt-dlp installed) to enable importing videos from URLs.",
    };
  }
  if (!ytdlpResolvable()) {
    return {
      enabled: false,
      detail: `URL import is unavailable: the yt-dlp downloader was not found (YTDLP_BIN="${config.urlImport.bin}"). Install yt-dlp on the server or point YTDLP_BIN at the binary to enable importing videos from URLs.`,
    };
  }
  return { enabled: true, detail: "URL import is available (yt-dlp)." };
}

// ---- SSRF guard ---------------------------------------------------------------

function ipv4Blocked(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT shared space
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 + TEST-NET-1 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51) return true; // TEST-NET-2
  if (a === 203 && b === 0) return true; // TEST-NET-3 (203.0.113.0/24)
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function ipBlocked(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) return ipv4Blocked(ip);
  if (version === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true; // fe80::/10 link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7 unique-local
    if (lower.startsWith("ff")) return true; // multicast
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return ipv4Blocked(mapped[1]);
    return false;
  }
  return true; // not an IP at all — treat as blocked in this context
}

export type UrlGuardResult =
  | { ok: true; url: string }
  | { ok: false; code: string; message: string };

/** Validate a user-supplied import URL. http/https only; the host
 *  must not be (or resolve to) a private/loopback/link-local target
 *  unless URL_IMPORT_ALLOW_PRIVATE is set (e2e fixtures only). */
export async function assertUrlImportAllowed(raw: string): Promise<UrlGuardResult> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, code: "VALIDATION_ERROR", message: "Enter a valid URL, for example https://www.youtube.com/watch?v=… or a direct link to a video file." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, code: "VALIDATION_ERROR", message: "Only http(s) URLs can be imported." };
  }
  if (url.username || url.password) {
    return { ok: false, code: "VALIDATION_ERROR", message: "URLs with embedded credentials are not accepted." };
  }
  const host = url.hostname.toLowerCase();
  if (!host) {
    return { ok: false, code: "VALIDATION_ERROR", message: "That URL has no host to import from." };
  }
  if (config.urlImport.allowPrivate) return { ok: true, url: url.toString() };
  const blockedMessage =
    "That URL points at a private, loopback or link-local address, which URL import refuses for safety (SSRF protection). Import from a public video page or a direct public media link instead.";
  if (net.isIP(host)) {
    if (ipBlocked(host)) return { ok: false, code: "URL_BLOCKED", message: blockedMessage };
    return { ok: true, url: url.toString() };
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return { ok: false, code: "URL_BLOCKED", message: blockedMessage };
  }
  // DNS names: best-effort resolution check (yt-dlp resolves again
  // on its own; a name that fails to resolve here is left for the
  // download step to fail honestly).
  try {
    const records = await dns.lookup(host, { all: true, verbatim: true });
    if (records.length > 0 && records.every((r) => ipBlocked(r.address))) {
      return { ok: false, code: "URL_BLOCKED", message: blockedMessage };
    }
    if (records.some((r) => ipBlocked(r.address))) {
      return { ok: false, code: "URL_BLOCKED", message: blockedMessage };
    }
  } catch {
    /* unresolvable here — yt-dlp's attempt will classify it */
  }
  return { ok: true, url: url.toString() };
}

// ---- yt-dlp runner --------------------------------------------------------------

interface YtdlpInfo {
  id?: string;
  title?: string;
  uploader?: string;
  channel?: string;
  extractor?: string;
  extractor_key?: string;
  webpage_url?: string;
  duration?: number;
  filesize?: number;
  filesize_approx?: number;
}

function runYtdlp(
  jobId: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(config.urlImport.bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const unregister = registerJobChild(jobId, child);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => {
      stdout = (stdout + d.toString("utf8")).slice(-200_000);
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString("utf8")).slice(-50_000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      unregister();
      reject(new JobStageError(`Could not run yt-dlp: ${err.message}`, "CONFIGURATION_ERROR"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      unregister();
      resolve({ stdout, stderr, code });
    });
  });
}

/** Map a yt-dlp failure to a stable reason class + a human message.
 *  Messages never echo the full URL back (it may carry tokens). */
export function classifyYtdlpFailure(stderr: string): { code: string; message: string } {
  const text = stderr.toLowerCase();
  if (/sign in|login required|age.?restrict|confirm your age|cookies/.test(text)) {
    return {
      code: "SIGN_IN_REQUIRED",
      message:
        "This video requires sign-in (or age confirmation) at the source site. CLIPFORGE never uses accounts or cookies, so it cannot import sign-in-walled videos. Try a publicly accessible video.",
    };
  }
  if (/unsupported url/.test(text)) {
    return {
      code: "UNSUPPORTED_URL",
      message:
        "That URL is not a video page or media link yt-dlp can read. Paste a link to a specific video (not a channel, playlist or home page).",
    };
  }
  if (/video unavailable|private video|this video is no longer|removed by the uploader|account .* terminated/.test(text)) {
    return {
      code: "VIDEO_UNAVAILABLE",
      message: "The video at that URL is unavailable (private, removed or deleted at the source).",
    };
  }
  if (/not available in your country|geo.?restrict|blocked in your country/.test(text)) {
    return {
      code: "GEO_BLOCKED",
      message: "The source site does not offer this video in the server's region, so it cannot be imported from here.",
    };
  }
  if (/http error 403|forbidden|unable to download webpage: http error 403|blocked by/.test(text)) {
    return {
      code: "ACCESS_BLOCKED",
      message:
        "The source site refused this server's request (HTTP 403). Some platforms block datacenter/server IPs for some videos — a platform restriction, not something the app can bypass. The same link may work for a different video.",
    };
  }
  if (/file is larger than max-filesize|exceeds the max|aborting due to --max-filesize/.test(text)) {
    return {
      code: "TOO_LARGE",
      message: `The video is larger than the ${config.maxUploadMb} MB import limit. Import a shorter or lower-resolution video, or raise MAX_UPLOAD_MB on the server.`,
    };
  }
  if (/timed out|timeout/.test(text)) {
    return {
      code: "TIMEOUT",
      message: "Downloading the video took too long and was stopped. Try again, or import a shorter video.",
    };
  }
  if (/name or service not known|failed to resolve|network is unreachable|connection refused|unable to download webpage/.test(text)) {
    return {
      code: "DOWNLOAD_ERROR",
      message: "The source site could not be reached from this server. Check the URL and try again.",
    };
  }
  const tail = stderr.trim().split("\n").filter(Boolean).slice(-1)[0]?.replace(/^ERROR:\s*/i, "").slice(0, 240);
  return {
    code: "DOWNLOAD_ERROR",
    message: `The download failed${tail ? `: ${tail}` : ""}`,
  };
}

const FORMAT_SELECTOR =
  "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/bv*[height<=1080]+ba/b[height<=1080]/b";

async function fetchUrlInfo(jobId: string, url: string): Promise<YtdlpInfo> {
  const { stdout, stderr, code } = await runYtdlp(
    jobId,
    ["--no-playlist", "--no-warnings", "--socket-timeout", "20", "--dump-single-json", url],
    120_000,
  );
  throwIfCancelled(jobId);
  if (code !== 0) {
    const failure = classifyYtdlpFailure(stderr);
    throw new JobStageError(failure.message, failure.code);
  }
  try {
    return JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as YtdlpInfo;
  } catch {
    throw new JobStageError("yt-dlp returned unreadable metadata for that URL.", "DOWNLOAD_ERROR");
  }
}

// ---- job processor ---------------------------------------------------------------

interface UrlImportPayload {
  url?: string;
  assetId?: string;
}

const RIGHTS_NOTE =
  "User-supplied URL: imported at the account holder's request from the URL they provided. The user is responsible for having the rights to process this video.";

function providerNameOf(info: YtdlpInfo): string {
  const raw = (info.extractor_key ?? info.extractor ?? "generic").toLowerCase();
  return raw.replace(/[^a-z0-9_-]+/g, "-").slice(0, 60) || "generic";
}

function setProjectStatus(projectId: string, status: string): void {
  getDb()
    .prepare("UPDATE projects SET status = ?, updated_at = ? WHERE id = ?")
    .run(status, nowIso(), projectId);
}

function markAssetFailed(assetId: string, message: string): void {
  getDb()
    .prepare("UPDATE source_assets SET validation_status = 'FAILED', validation_error = ? WHERE id = ?")
    .run(message.slice(0, 1000), assetId);
}

function projectHasValidSource(projectId: string, exceptAssetId: string): boolean {
  const row = getDb()
    .prepare(
      "SELECT COUNT(*) AS n FROM source_assets WHERE project_id = ? AND id != ? AND validation_status = 'VALID'",
    )
    .get(projectId, exceptAssetId) as { n: number };
  return row.n > 0;
}

/** The URL_IMPORT processor: download with yt-dlp, then the SAME
 *  post-processing an upload gets (strict FFprobe validation,
 *  container-family check, thumbnail, probe metadata on the source
 *  asset row). Exported for the Phase 8 dispatcher in broll.ts. */
export async function processUrlImportJob(job: Phase8JobRow): Promise<void> {
  const db = getDb();
  const payload = parseJson<UrlImportPayload>(job.payload_json, {});
  const url = (payload.url ?? "").trim();
  const assetId = (payload.assetId ?? "").trim();
  const maxBytes = config.maxUploadMb * 1024 * 1024;
  const tmpDir = path.join(config.processingDir, "url-import", job.id);
  try {
    setJobStage(job.id, "VALIDATING");
    const availability = urlImportAvailability();
    if (!availability.enabled) {
      throw new JobStageError(availability.detail, "CONFIGURATION_ERROR");
    }
    if (!url || !assetId) {
      throw new JobStageError("This import job does not carry a URL and asset to fill.", "VALIDATION_ERROR");
    }
    const guard = await assertUrlImportAllowed(url);
    if (!guard.ok) throw new JobStageError(guard.message, guard.code);

    setJobStage(job.id, "DOWNLOADING");
    const info = await fetchUrlInfo(job.id, url);
    const declaredSize = info.filesize ?? info.filesize_approx ?? null;
    if (declaredSize !== null && declaredSize > maxBytes) {
      throw new JobStageError(
        `The video is larger than the ${config.maxUploadMb} MB import limit. Import a shorter or lower-resolution video, or raise MAX_UPLOAD_MB on the server.`,
        "TOO_LARGE",
      );
    }
    fs.mkdirSync(tmpDir, { recursive: true });
    const { stdout, stderr, code } = await runYtdlp(
      job.id,
      [
        "--no-playlist",
        "--no-warnings",
        "--socket-timeout", "20",
        "--retries", "2",
        "--max-filesize", String(maxBytes),
        "--merge-output-format", "mp4",
        "-f", FORMAT_SELECTOR,
        "-o", path.join(tmpDir, "source.%(ext)s"),
        url,
      ],
      15 * 60_000,
    );
    throwIfCancelled(job.id);
    // yt-dlp reports the --max-filesize abort on STDOUT and still
    // exits 0, and direct-file metadata often carries no filesize —
    // so the size cap is enforced here on the combined output, with
    // the post-download byte check below as the backstop.
    const combinedOutput = `${stdout}\n${stderr}`;
    if (/larger than max-filesize/i.test(combinedOutput)) {
      throw new JobStageError(
        `The video is larger than the ${config.maxUploadMb} MB import limit. Import a shorter or lower-resolution video, or raise MAX_UPLOAD_MB on the server.`,
        "TOO_LARGE",
      );
    }
    if (code !== 0) {
      const failure = classifyYtdlpFailure(combinedOutput);
      throw new JobStageError(failure.message, failure.code);
    }
    const produced = fs
      .readdirSync(tmpDir)
      .filter((f) => !f.endsWith(".part") && !f.endsWith(".ytdl"))
      .map((f) => path.join(tmpDir, f))
      .filter((f) => fs.statSync(f).isFile());
    if (produced.length !== 1) {
      throw new JobStageError("The download did not produce a single media file.", "DOWNLOAD_ERROR");
    }
    const downloaded = produced[0];
    const fileSize = fs.statSync(downloaded).size;
    if (fileSize > maxBytes) {
      throw new JobStageError(
        `The video is larger than the ${config.maxUploadMb} MB import limit. Import a shorter or lower-resolution video, or raise MAX_UPLOAD_MB on the server.`,
        "TOO_LARGE",
      );
    }

    setJobStage(job.id, "VALIDATING_MEDIA");
    let meta: ProbedMetadata;
    try {
      meta = await probeFile(downloaded);
    } catch (probeErr) {
      throw new JobStageError(
        probeErr instanceof Error
          ? probeErr.message
          : "The downloaded file could not be read as a video.",
        "INVALID_MEDIA",
      );
    }
    // The stored filename's extension follows the PROBED container
    // family (mp4/mov → .mp4, webm → .webm) — the same honesty rule
    // uploads enforce between declared name and actual bytes.
    const ext = containerMatchesExtension(meta.container, "mp4")
      ? "mp4"
      : containerMatchesExtension(meta.container, "webm")
        ? "webm"
        : null;
    if (!ext) {
      throw new JobStageError(
        `The downloaded file's format (${meta.container ?? "unknown"}) is not a container CLIPFORGE processes. Only MP4/MOV and WebM video can be imported.`,
        "INVALID_MEDIA",
      );
    }

    setJobStage(job.id, "FINALIZING");
    const provider = providerNameOf(info);
    const providerAssetId = typeof info.id === "string" && info.id ? info.id : null;
    const title = (info.title ?? "").trim();
    const uploader = (info.uploader ?? info.channel ?? "").trim();
    const storageKey = `${job.user_id}/${assetId}.${ext}`;
    const outAbs = mediaPath(storageKey);
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    try {
      fs.renameSync(downloaded, outAbs);
    } catch (moveErr) {
      // PROCESSING_DIR and MEDIA_DIR may live on different
      // filesystems (e.g. tmpfs vs disk) — rename cannot cross
      // devices, so fall back to copy + remove.
      if ((moveErr as NodeJS.ErrnoException).code === "EXDEV") {
        fs.copyFileSync(downloaded, outAbs);
        fs.rmSync(downloaded, { force: true });
      } else {
        throw moveErr;
      }
    }
    const safeTitle = title
      .replace(/[^\p{L}\p{N} _-]+/gu, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100);
    const filename = `${safeTitle || `url-import-${assetId.slice(0, 8)}`}.${ext}`;
    const now = nowIso();
    db.prepare(
      `UPDATE source_assets SET original_filename = ?, external_id = ?, storage_key = ?, file_size = ?,
       duration = ?, width = ?, height = ?, frame_rate = ?, video_codec = ?, audio_codec = ?,
       has_audio = ?, container = ?, bitrate = ?, validation_status = 'VALID', validation_error = NULL
       WHERE id = ?`,
    ).run(
      filename, providerAssetId, storageKey, fileSize,
      meta.duration, meta.width, meta.height, meta.frameRate, meta.videoCodec, meta.audioCodec,
      meta.hasAudio ? 1 : 0, meta.container, meta.bitrate, assetId,
    );
    await makeThumbnail(storageKey, meta.duration);

    // Provenance: provider + source page + rights note on the same
    // metadata/licence tables the Pexels import uses (asset ref
    // "source:<id>" — the library union reads them for sources too).
    const assetRef = `source:${assetId}`;
    const attribution = title
      ? `“${title}”${uploader ? ` by ${uploader}` : ""} — imported from a user-supplied URL`
      : "Imported from a user-supplied URL";
    db.prepare("DELETE FROM media_asset_meta WHERE asset_ref = ?").run(assetRef);
    db.prepare(
      `INSERT INTO media_asset_meta (asset_ref, user_id, project_id, category, folder_id, source_type, provider, provider_asset_id, license_name, attribution_text, processing_status, tags_json, hidden, created_at, updated_at)
       VALUES (?, ?, ?, 'Original Videos', NULL, 'URL_IMPORT', ?, ?, ?, ?, 'READY', ?, 0, ?, ?)`,
    ).run(
      assetRef, job.user_id, job.project_id, provider, providerAssetId,
      RIGHTS_NOTE, attribution, JSON.stringify(["url-import", provider]), now, now,
    );
    db.prepare("DELETE FROM media_license_records WHERE asset_ref = ?").run(assetRef);
    db.prepare(
      "INSERT INTO media_license_records (id, user_id, asset_ref, provider, license_name, attribution_text, source_url, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      newId(), job.user_id, assetRef, provider, RIGHTS_NOTE, attribution,
      info.webpage_url ?? url, now,
    );

    // Replace semantics (same as uploads): a project keeps ONE
    // current source; older assets and their files are removed only
    // now that the imported source is valid.
    const others = db
      .prepare("SELECT * FROM source_assets WHERE project_id = ? AND id != ?")
      .all(job.project_id, assetId) as unknown as SourceAssetRow[];
    for (const other of others) {
      deleteStoredFiles(other.storage_key);
      db.prepare("DELETE FROM source_assets WHERE id = ?").run(other.id);
    }
    setProjectStatus(job.project_id, "READY_FOR_ANALYSIS");
    completeJob(job.id, {
      assetId,
      assetRef,
      sourceUrl: url,
      sourcePageUrl: info.webpage_url ?? url,
      provider,
      providerAssetId,
      title: title || null,
      uploader: uploader || null,
      duration: meta.duration !== null ? round3(meta.duration) : null,
      width: meta.width,
      height: meta.height,
      hasAudio: meta.hasAudio,
      fileSize,
    });
  } catch (err) {
    // Keep the source asset row honest about the failure (the job
    // row itself is failed by the shared Phase 8 error path, which
    // also records the ledger entry + notification). A cancelled
    // import removes its never-valid placeholder instead.
    const row = db
      .prepare("SELECT cancel_requested, status FROM phase8_jobs WHERE id = ?")
      .get(job.id) as { cancel_requested: number; status: string } | undefined;
    const cancelled = !row || row.cancel_requested === 1 || row.status === "CANCELLED";
    if (assetId) {
      if (cancelled) {
        db.prepare("DELETE FROM source_assets WHERE id = ? AND validation_status != 'VALID'").run(assetId);
      } else {
        markAssetFailed(assetId, err instanceof Error ? err.message : "The import failed.");
      }
    }
    if (!cancelled) {
      setProjectStatus(
        job.project_id,
        assetId && projectHasValidSource(job.project_id, assetId) ? "READY_FOR_ANALYSIS" : "FAILED",
      );
    }
    throw err;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---- routes -----------------------------------------------------------------------

const importSchema = z.object({ url: z.string().trim().min(1).max(2048) });

export function registerUrlImportRoutes(app: express.Express, requireAuth: RequireAuth): void {
  const router = express.Router();

  router.post("/projects/:id/url-import", requireAuth, async (req: AuthedRequest, res) => {
    const project: ProjectRow | undefined = ownedProject(req.user!.id, req.params.id);
    if (!project) return fail(res, 404, "NOT_FOUND", "Project not found.");
    const parsed = importSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return fail(res, 400, "VALIDATION_ERROR", "Paste the URL of a video to import.");
    }
    const url = parsed.data.url;

    // Cheap, decisive checks run BEFORE anything is queued: a
    // malformed or SSRF-blocked URL is a 400, never a queued job.
    const guard = await assertUrlImportAllowed(url);
    if (!guard.ok) return fail(res, 400, guard.code, guard.message);

    const availability = urlImportAvailability();
    if (!availability.enabled) {
      // Mirror the Phase 8 unconfigured-import contract: a persisted
      // FAILED job + the 422 CONFIGURATION_ERROR naming the missing
      // dependency. No placeholder asset is created.
      const job = createFailedJob(
        {
          userId: req.user!.id,
          projectId: project.id,
          kind: "URL_IMPORT",
          payload: { url },
        },
        "CONFIGURATION_ERROR",
        availability.detail,
      );
      return res.status(422).json({
        error: { code: "CONFIGURATION_ERROR", message: availability.detail },
        job: publicPhase8Job(job),
      });
    }

    // Dedupe on the exact URL within the project while an import of
    // it is still active (the Phase 8 duplicate-protection rule).
    const dedupeKey = `url-import:${project.id}:${crypto.createHash("sha256").update(url).digest("hex")}`;
    const db = getDb();
    const active = db
      .prepare(
        "SELECT * FROM phase8_jobs WHERE user_id = ? AND dedupe_key = ? AND status IN ('QUEUED', 'RUNNING') ORDER BY created_at DESC LIMIT 1",
      )
      .get(req.user!.id, dedupeKey) as Phase8JobRow | undefined;
    if (active) {
      const payload = parseJson<UrlImportPayload>(active.payload_json, {});
      const asset = payload.assetId
        ? (db.prepare("SELECT * FROM source_assets WHERE id = ?").get(payload.assetId) as SourceAssetRow | undefined)
        : undefined;
      return res.status(200).json({
        job: publicPhase8Job(active),
        asset: asset ? publicAsset(asset) : null,
        deduplicated: true,
      });
    }

    const now = nowIso();
    const assetId = newId();
    const urlHost = (() => {
      try {
        return new URL(url).hostname;
      } catch {
        return "URL";
      }
    })();
    db.prepare(
      `INSERT INTO source_assets (id, project_id, user_id, source_type, original_filename, source_url, external_id, storage_key, storage_provider, file_size, duration, width, height, frame_rate, video_codec, audio_codec, has_audio, container, bitrate, validation_status, validation_error, created_at)
       VALUES (?, ?, ?, 'URL_IMPORT', ?, ?, NULL, NULL, 'local', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'UPLOAD_PENDING', NULL, ?)`,
    ).run(assetId, project.id, req.user!.id, `Importing from ${urlHost}…`, url, now);
    setProjectStatus(project.id, "UPLOADING");
    const { job } = createJob({
      userId: req.user!.id,
      projectId: project.id,
      kind: "URL_IMPORT",
      payload: { url, assetId },
      dedupeKey,
    });
    const asset = db.prepare("SELECT * FROM source_assets WHERE id = ?").get(assetId) as unknown as SourceAssetRow;
    return res.status(201).json({ job: publicPhase8Job(job), asset: publicAsset(asset), deduplicated: false });
  });

  app.use("/api", router);
}
