// Server-side media inspection — FFprobe / FFmpeg (Phase 3).
//
// Metadata is ONLY ever taken from ffprobe output on the real file the
// server received. Nothing is inferred from the filename except the
// declared extension, and a file with no readable video stream is
// rejected as corrupted/unsupported.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/** Container extensions the configured pipeline accepts. */
export const ALLOWED_EXTENSIONS = ["mp4", "mov", "webm"] as const;
export type AllowedExtension = (typeof ALLOWED_EXTENSIONS)[number];

export function extensionOf(filename: string): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(filename.trim());
  return match ? match[1].toLowerCase() : "";
}

export function isAllowedExtension(filename: string): filename is string {
  return (ALLOWED_EXTENSIONS as readonly string[]).includes(extensionOf(filename));
}

export interface ProbedMetadata {
  duration: number | null;
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  bitrate: number | null;
  hasAudio: boolean;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  bit_rate?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: {
    format_name?: string;
    duration?: string;
    bit_rate?: string;
  };
}

function parseFrameRate(raw: string | undefined): number | null {
  if (!raw) return null;
  const [numRaw, denRaw] = raw.split("/");
  const num = Number(numRaw);
  const den = denRaw === undefined ? 1 : Number(denRaw);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  const fps = num / den;
  if (!Number.isFinite(fps) || fps <= 0) return null;
  return Math.round(fps * 100) / 100;
}

function runFfprobe(filePath: string): Promise<FfprobeOutput> {
  return new Promise((resolve, reject) => {
    execFile(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_format",
        "-show_streams",
        "-of",
        "json",
        filePath,
      ],
      { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          reject(new Error("FFprobe could not read this file."));
          return;
        }
        try {
          resolve(JSON.parse(stdout) as FfprobeOutput);
        } catch {
          reject(new Error("FFprobe returned unreadable output for this file."));
        }
      },
    );
  });
}

/**
 * Probe a stored file. Throws an Error with an actionable message when
 * the file is unreadable or contains no video stream.
 */
export async function probeFile(filePath: string): Promise<ProbedMetadata> {
  const data = await runFfprobe(filePath);
  const streams = data.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  if (!video) {
    throw new Error("No video stream was found in this file. Upload a video file you own or are authorized to process.");
  }
  const audio = streams.find((s) => s.codec_type === "audio");
  const durationRaw = Number(data.format?.duration);
  const bitrateRaw = Number(data.format?.bit_rate ?? video.bit_rate);
  return {
    duration: Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : null,
    container: data.format?.format_name ?? null,
    videoCodec: video.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    width: typeof video.width === "number" ? video.width : null,
    height: typeof video.height === "number" ? video.height : null,
    frameRate: parseFrameRate(video.avg_frame_rate) ?? parseFrameRate(video.r_frame_rate),
    bitrate: Number.isFinite(bitrateRaw) && bitrateRaw > 0 ? Math.round(bitrateRaw) : null,
    hasAudio: Boolean(audio),
  };
}

export interface ProbedAnyMetadata extends ProbedMetadata {
  hasVideo: boolean;
}

/**
 * Probe any media file (Phase 5 project-media uploads + render
 * verification). Unlike probeFile this does NOT require a video
 * stream — audio-only files are legitimate assets — but it still
 * throws when the file is unreadable or has no streams at all.
 */
export async function probeAnyFile(filePath: string): Promise<ProbedAnyMetadata> {
  const data = await runFfprobe(filePath);
  const streams = data.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  if (!video && !audio) {
    throw new Error("No audio or video stream was found in this file.");
  }
  const durationRaw = Number(data.format?.duration);
  const bitrateRaw = Number(data.format?.bit_rate ?? video?.bit_rate);
  return {
    duration: Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : null,
    container: data.format?.format_name ?? null,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    width: typeof video?.width === "number" ? video.width : null,
    height: typeof video?.height === "number" ? video.height : null,
    frameRate: video ? parseFrameRate(video.avg_frame_rate) ?? parseFrameRate(video.r_frame_rate) : null,
    bitrate: Number.isFinite(bitrateRaw) && bitrateRaw > 0 ? Math.round(bitrateRaw) : null,
    hasAudio: Boolean(audio),
    hasVideo: Boolean(video),
  };
}

// ---- container family verification -----------------------------------------
//
// FFprobe reports format_name as a comma-separated demuxer list, never a
// single clean label: .mp4 and .mov files both report the ISO-BMFF list
// ("mov,mp4,m4a,3gp,3g2,mj2"), and WebM files report "matroska,webm".
// Container checks are therefore family-based: the declared extension's
// family must appear in the probed token list.

const ISO_CONTAINER_TOKENS = new Set(["mov", "mp4", "m4a", "3gp", "3g2", "mj2"]);
const WEBM_CONTAINER_TOKENS = new Set(["webm", "matroska"]);

function containerTokens(container: string | null): string[] {
  if (!container) return [];
  return container
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * True when the probed container is consistent with the declared file
 * extension's family (mp4/mov → ISO-BMFF, webm → WebM/Matroska). A null
 * or unrecognised container never verifies — unverifiable is not valid.
 */
export function containerMatchesExtension(container: string | null, extension: string): boolean {
  const tokens = containerTokens(container);
  if (tokens.length === 0) return false;
  switch (extension.toLowerCase()) {
    case "mp4":
    case "mov":
      return tokens.some((t) => ISO_CONTAINER_TOKENS.has(t));
    case "webm":
      return tokens.some((t) => WEBM_CONTAINER_TOKENS.has(t));
    default:
      return false;
  }
}

/**
 * Content-Type implied by the PROBED container, or null when the
 * container is missing/unrecognised (callers then fall back to the
 * extension map). Used when serving stored media so the served type
 * follows the actual bytes, not the filename.
 */
export function contentTypeForContainer(container: string | null): string | null {
  const tokens = containerTokens(container);
  if (tokens.some((t) => WEBM_CONTAINER_TOKENS.has(t))) return "video/webm";
  if (tokens.some((t) => ISO_CONTAINER_TOKENS.has(t))) return "video/mp4";
  return null;
}

/** Absolute path for a storage key under the local media directory. */
export function mediaPath(storageKey: string): string {
  return path.join(config.mediaDir, storageKey);
}

export function thumbnailPath(storageKey: string): string {
  return `${mediaPath(storageKey)}.thumb.jpg`;
}

/**
 * Extract one real frame as the asset thumbnail. Returns false when
 * ffmpeg fails — a missing thumbnail is not fatal to the upload.
 */
export function makeThumbnail(storageKey: string, duration: number | null): Promise<boolean> {
  const input = mediaPath(storageKey);
  const output = thumbnailPath(storageKey);
  const seek = duration && duration > 2 ? Math.min(1, duration * 0.1) : 0.1;
  return new Promise((resolve) => {
    execFile(
      "ffmpeg",
      [
        "-v",
        "error",
        "-ss",
        String(seek),
        "-i",
        input,
        "-frames:v",
        "1",
        "-q:v",
        "3",
        "-y",
        output,
      ],
      { timeout: 30_000 },
      (err) => {
        if (err) {
          fs.rmSync(output, { force: true });
          resolve(false);
          return;
        }
        resolve(fs.existsSync(output));
      },
    );
  });
}

/** Remove the stored binary + thumbnail for an asset, if present. */
export function deleteStoredFiles(storageKey: string | null): void {
  if (!storageKey) return;
  fs.rmSync(mediaPath(storageKey), { force: true });
  fs.rmSync(thumbnailPath(storageKey), { force: true });
}

export function storedFileExists(storageKey: string | null): boolean {
  return Boolean(storageKey) && fs.existsSync(mediaPath(storageKey as string));
}
