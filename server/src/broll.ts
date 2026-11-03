// CLIPFORGE API — Phase 8: AI B-roll, Smart Visual Enhancement &
// Background Processing.
//
// Architecture notes (read before believing anything):
//  - Jobs are persisted phase8_jobs rows drained by an in-process
//    worker (the Phase 4/5/7 pattern). The Phase 8 spec names Redis +
//    BullMQ queues; that infrastructure does NOT exist on this
//    machine, so the same job rows are the queue. Production path:
//    PostgreSQL + BullMQ workers draining identical row shapes —
//    documented here, never claimed to be running.
//  - B-roll recommendations are computed from the project's REAL
//    Phase 4 transcript: windows of transcript segments are matched
//    against the user's own media library by term overlap, and the
//    matched terms are stored on every recommendation as its evidence.
//    A window with no genuine overlap produces NO recommendation —
//    filler is never invented. Nothing is inserted into a timeline
//    without an explicit accept call.
//  - External providers: stock media has ONE real adapter — Pexels
//    (free API key, PEXELS_API_KEY) — which searches the official
//    Pexels Videos API and downloads the chosen file into the media
//    pipeline with its licence/credit metadata. AI generation and
//    background removal remain unimplemented adapters (no genuinely
//    free production API exists for either). With NO configuration,
//    provider operations fail honestly with 422 CONFIGURATION_ERROR
//    and a persisted FAILED job row, and /api/phase8/status says
//    exactly what is missing. No scraping, no simulation, no fake
//    masks.
//  - Enhancement is REAL FFmpeg work via src/enhance.ts — one chain
//    builder shared by previews, asset jobs and timeline renders.
//  - Original media is never modified: enhancement outputs are new
//    project_media assets; B-roll overlays never replace the main
//    track's audio (the render pipeline mixes overlays over the base,
//    whose audio is input 0 — see editor.ts).

import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import {
  backgroundProviderConfigured,
  config,
  generationProviderConfigured,
  pexelsConfigured,
  stockProviderConfigured,
} from "./config.js";
import { notify, recordUsage as recordLedgerUsage } from "./accountCore.js";
import {
  getDb,
  type BrollPlacementRow,
  type BrollRecommendationRow,
  type BrandAssetRow,
  type CandidateClipRow,
  type EffectPresetRow,
  type EnhancementConfigRow,
  type MediaAssetMetaRow,
  type Phase8JobRow,
  type ProjectMediaRow,
  type ProjectRow,
  type RenderJobRow,
  type SourceAssetRow,
  type TopicSegmentRow,
  type TranscriptRow,
  type TranscriptSegmentRow,
  type UserRow,
} from "./db.js";
import { mediaPath, probeAnyFile, thumbnailPath } from "./media.js";
import {
  commitOperation,
  docById,
  getOrCreateDoc,
  ownedProject,
  publicRenderJob,
  readState,
  timelineDurationOf,
  validateState,
  type EditorState,
  type ItemState,
  type TransformState,
  DEFAULT_TRANSFORM,
} from "./editor.js";
import {
  BUILTIN_PRESETS,
  DEFAULT_AUDIO_ENHANCE,
  DEFAULT_VIDEO_ENHANCE,
  ENHANCEMENT_CAPABILITIES,
  audioEnhanceSchema,
  buildAudioChain,
  buildVideoChain,
  normalizeAudio,
  normalizeVideo,
  videoEnhanceSchema,
  type AudioEnhanceSettings,
  type VideoEnhanceSettings,
} from "./enhance.js";
// URL import (yt-dlp) jobs are phase8_jobs rows too (kind URL_IMPORT);
// their processor lives in src/urlImport.ts and is dispatched from
// processPhase8Job below. The circular import is call-time only —
// both modules reference each other's bindings inside functions,
// never at module initialisation.
import { processUrlImportJob, urlImportAvailability } from "./urlImport.js";

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

// ---- provider adapters -------------------------------------------------------
// Stock media has ONE real adapter in this build: Pexels (below),
// gated on the free PEXELS_API_KEY. The generation and background
// adapters further down are still INTERFACE STUBS: each carries
// implemented: false and its operations throw unconditionally. An
// adapter reports configured = (environment names a provider +
// credential) AND implemented — setting env vars alone can never
// flip the status to "configured" while the adapter body is a stub,
// and the detail string always names whichever piece is missing
// (environment, implementation, or neither). The routes surface that
// same detail as the 422 CONFIGURATION_ERROR message, so the status
// endpoint and the failing operations can never disagree. No adapter
// ever fabricates a result.

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

/** A configured provider failed at runtime (network, upstream HTTP
 *  error, rejected key). Distinct from ConfigurationError: the
 *  operation was attempted for real and failed honestly. */
export class StockProviderError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = "StockProviderError";
    this.status = status;
  }
}

export interface StockSearchHit {
  providerAssetId: string;
  title: string;
  licenseName: string | null;
  attributionText: string | null;
  /** Pexels page URL for the video (the credit/source link). */
  sourceUrl: string | null;
  creatorName: string | null;
  creatorUrl: string | null;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  previewImageUrl: string | null;
}

/** Everything the import worker needs about one provider asset:
 *  display/credit metadata (persisted on the imported asset) plus
 *  the server-side download URL of the chosen rendition. The
 *  download URL is never returned to API clients. */
export interface StockAssetDetail {
  providerAssetId: string;
  title: string;
  licenseName: string;
  attributionText: string;
  sourceUrl: string;
  creatorName: string | null;
  creatorUrl: string | null;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  downloadUrl: string;
}

export interface StockProviderAdapter {
  id: string;
  /** True only when a real adapter body exists for this provider. */
  implemented: boolean;
  configured: boolean;
  detail: string;
  search(query: string): Promise<StockSearchHit[]>;
  fetchAsset(providerAssetId: string): Promise<StockAssetDetail>;
  /** Stream a previously resolved download URL to disk, refusing
   *  more than maxBytes. Resolves with the byte count written. */
  downloadToFile(downloadUrl: string, destPath: string, maxBytes: number): Promise<number>;
}

// ---- Pexels stock adapter (real) ------------------------------------------
// Official Pexels API (https://api.pexels.com/videos): the key is
// sent as the raw Authorization header value (NOT a Bearer token),
// per Pexels' own documentation. Search is /videos/search; a single
// video is /videos/videos/:id. Imported assets persist the Pexels
// licence name, the "Video by <creator> on Pexels" attribution and
// the video's Pexels page URL (credit metadata — Pexels licence
// terms), on media_asset_meta + a media_license_records row.

const PEXELS_LICENSE_NAME = "Pexels License";

interface PexelsVideoFileRaw {
  id?: number;
  quality?: string;
  file_type?: string;
  width?: number;
  height?: number;
  fps?: number;
  link?: string;
}

interface PexelsVideoRaw {
  id?: number;
  width?: number;
  height?: number;
  duration?: number;
  url?: string;
  image?: string;
  user?: { id?: number; name?: string; url?: string };
  video_files?: PexelsVideoFileRaw[];
}

function pexelsTitle(raw: PexelsVideoRaw): string {
  // Pexels videos carry no title field; the page URL slug is the
  // closest human-readable name (".../video/waves-crashing-1234567/").
  const slug = (typeof raw.url === "string" ? raw.url : "").split("/").filter(Boolean).pop() ?? "";
  const words = slug.replace(/-\d+$/, "").replace(/^\d+-/, "").replace(/-/g, " ").trim();
  if (words) return words.charAt(0).toUpperCase() + words.slice(1);
  return `Pexels video ${raw.id ?? ""}`.trim();
}

function pexelsAttribution(raw: PexelsVideoRaw): string {
  const name = typeof raw.user?.name === "string" && raw.user.name.trim() ? raw.user.name.trim() : "a Pexels creator";
  return `Video by ${name} on Pexels`;
}

function pexelsHit(raw: PexelsVideoRaw): StockSearchHit {
  return {
    providerAssetId: String(raw.id ?? ""),
    title: pexelsTitle(raw),
    licenseName: PEXELS_LICENSE_NAME,
    attributionText: pexelsAttribution(raw),
    sourceUrl: typeof raw.url === "string" ? raw.url : null,
    creatorName: typeof raw.user?.name === "string" ? raw.user.name : null,
    creatorUrl: typeof raw.user?.url === "string" ? raw.user.url : null,
    durationSec: typeof raw.duration === "number" ? raw.duration : null,
    width: typeof raw.width === "number" ? raw.width : null,
    height: typeof raw.height === "number" ? raw.height : null,
    previewImageUrl: typeof raw.image === "string" ? raw.image : null,
  };
}

/** Choose the downloadable MP4 rendition: the widest file at or
 *  below 1920 px (full HD is plenty for B-roll and keeps imports
 *  fast); if every rendition is wider, the narrowest one. HLS
 *  playlist entries are not downloadable files and are skipped. */
function pexelsDownloadFile(raw: PexelsVideoRaw): PexelsVideoFileRaw | null {
  const files = (raw.video_files ?? []).filter(
    (f) => typeof f.link === "string" && f.link.split("?")[0].toLowerCase().endsWith(".mp4"),
  );
  if (files.length === 0) return null;
  const widthOf = (f: PexelsVideoFileRaw): number => (typeof f.width === "number" ? f.width : 0);
  const atOrBelow = files.filter((f) => widthOf(f) <= 1920);
  const pool = atOrBelow.length > 0 ? atOrBelow : files;
  return pool.sort((a, b) =>
    atOrBelow.length > 0 ? widthOf(b) - widthOf(a) : widthOf(a) - widthOf(b),
  )[0];
}

async function pexelsApi(pathname: string): Promise<unknown> {
  // NB: `Response` in this module is Express's (imported above);
  // the fetch Response is spelled globalThis.Response.
  let res: globalThis.Response;
  try {
    res = await fetch(`${config.phase8.pexelsApiBase}${pathname}`, {
      headers: { Authorization: config.phase8.pexelsApiKey },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new StockProviderError(
      `Could not reach the Pexels API (${err instanceof Error ? err.message : "network error"}).`,
      0,
    );
  }
  if (!res.ok) {
    // Status + a short body excerpt only — the key is never echoed.
    const body = (await res.text().catch(() => "")).slice(0, 200);
    throw new StockProviderError(
      res.status === 401 || res.status === 403
        ? `Pexels rejected the configured API key (HTTP ${res.status}). Check PEXELS_API_KEY.`
        : `Pexels API request failed (HTTP ${res.status})${body ? `: ${body}` : ""}`,
      res.status,
    );
  }
  return res.json();
}

function createPexelsStockAdapter(): StockProviderAdapter {
  const configured = pexelsConfigured;
  const detail = configured
    ? `Stock provider "pexels" is configured.`
    : "No licensed stock-media provider is configured. Set PEXELS_API_KEY (server-side) to enable licensed stock imports from Pexels — a free API key is available at pexels.com/api. CLIPFORGE never scrapes stock sites.";
  const requireConfigured = (): void => {
    if (!configured) throw new ConfigurationError(detail);
  };
  return {
    id: "pexels",
    implemented: true,
    configured,
    detail,
    async search(query: string): Promise<StockSearchHit[]> {
      requireConfigured();
      const json = (await pexelsApi(
        `/videos/search?query=${encodeURIComponent(query)}&per_page=15`,
      )) as { videos?: PexelsVideoRaw[] };
      return (json.videos ?? []).filter((v) => typeof v.id === "number").map(pexelsHit);
    },
    async fetchAsset(providerAssetId: string): Promise<StockAssetDetail> {
      requireConfigured();
      const json = (await pexelsApi(
        `/videos/videos/${encodeURIComponent(providerAssetId)}`,
      )) as PexelsVideoRaw;
      if (!json || typeof json.id !== "number") {
        throw new StockProviderError(`Pexels returned no video for id "${providerAssetId}".`, 404);
      }
      const file = pexelsDownloadFile(json);
      if (!file || typeof file.link !== "string") {
        throw new StockProviderError(
          `Pexels video ${json.id} has no downloadable MP4 rendition to import.`,
          422,
        );
      }
      const hit = pexelsHit(json);
      return {
        providerAssetId: hit.providerAssetId,
        title: hit.title,
        licenseName: PEXELS_LICENSE_NAME,
        attributionText: hit.attributionText ?? pexelsAttribution(json),
        sourceUrl: hit.sourceUrl ?? "",
        creatorName: hit.creatorName,
        creatorUrl: hit.creatorUrl,
        durationSec: hit.durationSec,
        width: hit.width,
        height: hit.height,
        downloadUrl: file.link,
      };
    },
    async downloadToFile(downloadUrl: string, destPath: string, maxBytes: number): Promise<number> {
      requireConfigured();
      let res: globalThis.Response;
      try {
        res = await fetch(downloadUrl, { signal: AbortSignal.timeout(180_000) });
      } catch (err) {
        throw new StockProviderError(
          `Downloading the stock file failed (${err instanceof Error ? err.message : "network error"}).`,
          0,
        );
      }
      if (!res.ok || !res.body) {
        throw new StockProviderError(
          `Downloading the stock file failed (HTTP ${res.status}).`,
          res.status,
        );
      }
      const declared = Number(res.headers.get("content-length") ?? "0");
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new StockProviderError(
          `The stock file is larger than the ${Math.round(maxBytes / (1024 * 1024))} MB import limit.`,
          413,
        );
      }
      let bytes = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            cb(
              new StockProviderError(
                `The stock file is larger than the ${Math.round(maxBytes / (1024 * 1024))} MB import limit.`,
                413,
              ),
            );
          } else {
            this.push(chunk);
            cb();
          }
        },
      });
      await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(destPath));
      return bytes;
    },
  };
}

/** A named stock provider with NO adapter in this build keeps the
 *  honest stub behaviour (the implemented stock adapter is Pexels). */
function createUnimplementedStockAdapter(id: string): StockProviderAdapter {
  const detail = !stockProviderConfigured
    ? "No licensed stock-media provider is configured. Set STOCK_PROVIDER and STOCK_API_KEY (server-side) to enable licensed imports. CLIPFORGE never scrapes stock sites."
    : `Stock provider "${id}" is named in the server environment, but no stock adapter is implemented for it in this build (the implemented stock adapter is Pexels — set PEXELS_API_KEY to use it), so licensed imports are still unavailable — setting credentials alone does not enable them.`;
  const fail = (): never => {
    throw new ConfigurationError(detail);
  };
  return {
    id,
    implemented: false,
    configured: false,
    detail,
    search: async () => fail(),
    fetchAsset: async () => fail(),
    downloadToFile: async () => fail(),
  };
}

// STOCK_PROVIDER unset (or "pexels") selects the implemented Pexels
// adapter; any other named provider keeps the honest stub.
export const stockProvider: StockProviderAdapter =
  config.phase8.stockProvider === "" || config.phase8.stockProvider === "pexels"
    ? createPexelsStockAdapter()
    : createUnimplementedStockAdapter(config.phase8.stockProvider);

export interface GenerationProviderAdapter {
  id: string;
  /** False in this build: no working generation adapter is implemented. */
  implemented: boolean;
  configured: boolean;
  detail: string;
  generate(prompt: string, mediaKind: "video" | "image"): Promise<never>;
}

const GENERATION_ADAPTER_IMPLEMENTED = false;

export const generationProvider: GenerationProviderAdapter = {
  id: config.phase8.generationProvider || "none",
  implemented: GENERATION_ADAPTER_IMPLEMENTED,
  configured: generationProviderConfigured && GENERATION_ADAPTER_IMPLEMENTED,
  detail: !generationProviderConfigured
    ? "No AI media-generation provider is configured. Set AI_GENERATION_PROVIDER and AI_GENERATION_API_KEY (server-side) to enable generated B-roll."
    : !GENERATION_ADAPTER_IMPLEMENTED
      ? `AI generation provider "${config.phase8.generationProvider}" is named in the server environment, but the generation adapter is not implemented in this build, so generated B-roll is still unavailable — setting credentials alone does not enable it.`
      : `AI generation provider "${config.phase8.generationProvider}" is configured.`,
  async generate(): Promise<never> {
    throw new ConfigurationError(this.detail);
  },
};

export interface BackgroundProviderAdapter {
  /** False in this build: no segmentation model/provider integration
   *  is implemented, only the configuration surface. */
  implemented: boolean;
  configured: boolean;
  detail: string;
}

const BACKGROUND_ADAPTER_IMPLEMENTED = false;

export const backgroundProvider: BackgroundProviderAdapter = {
  implemented: BACKGROUND_ADAPTER_IMPLEMENTED,
  configured: backgroundProviderConfigured && BACKGROUND_ADAPTER_IMPLEMENTED,
  detail: !backgroundProviderConfigured
    ? "Background removal needs a subject-segmentation model or provider, and none is configured on this server (no rembg/u2net/mediapipe model is installed). Set BACKGROUND_REMOVAL_PROVIDER + BACKGROUND_REMOVAL_API_KEY, or BACKGROUND_MODEL_PATH to a local segmentation model, to enable it. Until then the control is shown disabled — no fake mask is ever produced."
    : !BACKGROUND_ADAPTER_IMPLEMENTED
      ? "A background-removal provider/model is named in the server environment, but background removal is not implemented in this build, so it remains unavailable — setting the environment alone does not enable it, and no fake mask is ever produced."
      : "A background-removal provider/model is configured.",
};

export function phase8ProviderStatus() {
  return {
    stock: {
      id: stockProvider.id,
      implemented: stockProvider.implemented,
      configured: stockProvider.configured,
      detail: stockProvider.detail,
    },
    generation: {
      id: generationProvider.id,
      implemented: generationProvider.implemented,
      configured: generationProvider.configured,
      detail: generationProvider.detail,
    },
    backgroundRemoval: {
      implemented: backgroundProvider.implemented,
      configured: backgroundProvider.configured,
      detail: backgroundProvider.detail,
    },
    enhancement: {
      configured: true,
      engine: "FFmpeg (local)",
      capabilities: ENHANCEMENT_CAPABILITIES,
    },
  };
}

// ---- media library (spec §11): one union over the existing stores -----------

export const LIBRARY_CATEGORIES = [
  "Original Videos",
  "Generated Clips",
  "B-roll",
  "Images",
  "Audio",
  "Music",
  "Sound Effects",
  "Backgrounds",
  "Brand Assets",
  "Generated Assets",
] as const;

export type AssetKindName = "source" | "media" | "candidate" | "brand";

export interface LibraryAsset {
  ref: string;
  kind: AssetKindName;
  id: string;
  projectId: string | null;
  filename: string;
  mediaKind: "VIDEO" | "AUDIO" | "IMAGE";
  duration: number | null;
  width: number | null;
  height: number | null;
  aspect: string | null;
  fileSize: number | null;
  hasAudio: boolean | null;
  hasVideo: boolean | null;
  audioCodec: string | null;
  videoCodec: string | null;
  container: string | null;
  createdAt: string;
  storageKey: string | null;
  category: string;
  sourceType: string;
  provider: string | null;
  licenseName: string | null;
  attributionText: string | null;
  processingStatus: string;
  tags: string[];
  folderId: string | null;
  streamUrl: string | null;
  thumbnailUrl: string | null;
  /** Internal: text the recommendation/search matcher may use. */
  searchable: string;
}

const refOf = (kind: AssetKindName, id: string): string => `${kind}:${id}`;

export function parseRef(ref: string): { kind: AssetKindName; id: string } | null {
  const idx = ref.indexOf(":");
  if (idx <= 0) return null;
  const kind = ref.slice(0, idx);
  const id = ref.slice(idx + 1);
  if (!["source", "media", "candidate", "brand"].includes(kind) || !id) return null;
  return { kind: kind as AssetKindName, id };
}

function aspectOf(width: number | null, height: number | null): string | null {
  if (!width || !height) return null;
  const g = (a: number, b: number): number => (b === 0 ? a : g(b, a % b));
  const d = g(width, height);
  return `${width / d}:${height / d}`;
}

function metaOf(userId: string, ref: string): MediaAssetMetaRow | undefined {
  return getDb()
    .prepare("SELECT * FROM media_asset_meta WHERE asset_ref = ? AND user_id = ?")
    .get(ref, userId) as MediaAssetMetaRow | undefined;
}

/** Transcript-derived terms for a source asset (its own Phase 4
 *  analysis), so a library video can match another project's speech by
 *  what it actually contains — not by filename alone. */
function sourceSearchableExtra(assetId: string): string {
  const db = getDb();
  const transcript = db
    .prepare("SELECT * FROM transcripts WHERE source_asset_id = ? ORDER BY rowid DESC LIMIT 1")
    .get(assetId) as TranscriptRow | undefined;
  if (!transcript) return "";
  const topics = db
    .prepare("SELECT label, summary_text FROM topic_segments WHERE transcript_id = ?")
    .all(transcript.id) as unknown as TopicSegmentRow[];
  return topics.map((t) => `${t.label} ${t.summary_text}`).join(" ");
}

export function listLibraryAssets(userId: string): LibraryAsset[] {
  const db = getDb();
  const assets: LibraryAsset[] = [];
  const applyMeta = (asset: LibraryAsset): LibraryAsset | null => {
    const meta = metaOf(userId, asset.ref);
    if (meta?.hidden === 1) return null;
    if (meta) {
      asset.category = meta.category;
      asset.sourceType = meta.source_type;
      asset.provider = meta.provider;
      asset.licenseName = meta.license_name;
      asset.attributionText = meta.attribution_text;
      asset.processingStatus = meta.processing_status;
      asset.tags = parseJson<string[]>(meta.tags_json, []);
      asset.folderId = meta.folder_id;
    }
    asset.searchable = [asset.filename, asset.category, ...asset.tags, asset.searchable]
      .filter(Boolean)
      .join(" ");
    return asset;
  };

  const sources = db
    .prepare(
      "SELECT * FROM source_assets WHERE user_id = ? AND validation_status = 'VALID' AND storage_key IS NOT NULL ORDER BY created_at DESC",
    )
    .all(userId) as unknown as SourceAssetRow[];
  for (const s of sources) {
    const asset = applyMeta({
      ref: refOf("source", s.id),
      kind: "source",
      id: s.id,
      projectId: s.project_id,
      filename: s.original_filename,
      mediaKind: "VIDEO",
      duration: s.duration,
      width: s.width,
      height: s.height,
      aspect: aspectOf(s.width, s.height),
      fileSize: s.file_size,
      hasAudio: s.has_audio === null ? null : s.has_audio === 1,
      hasVideo: Boolean(s.video_codec),
      audioCodec: s.audio_codec,
      videoCodec: s.video_codec,
      container: s.container,
      createdAt: s.created_at,
      storageKey: s.storage_key,
      category: "Original Videos",
      sourceType: "PROJECT_SOURCE",
      provider: null,
      licenseName: null,
      attributionText: null,
      processingStatus: "READY",
      tags: [],
      folderId: null,
      streamUrl: `/api/source-assets/${s.id}/stream`,
      thumbnailUrl: `/api/media-library/thumbnail?assetRef=${encodeURIComponent(refOf("source", s.id))}`,
      searchable: sourceSearchableExtra(s.id),
    });
    if (asset) assets.push(asset);
  }

  const candidates = db
    .prepare(
      "SELECT * FROM candidate_clips WHERE user_id = ? AND preview_status = 'READY' AND preview_path IS NOT NULL ORDER BY created_at DESC",
    )
    .all(userId) as unknown as CandidateClipRow[];
  for (const c of candidates) {
    const asset = applyMeta({
      ref: refOf("candidate", c.id),
      kind: "candidate",
      id: c.id,
      projectId: c.project_id,
      filename: c.title,
      mediaKind: "VIDEO",
      duration: c.duration,
      width: null,
      height: null,
      aspect: null,
      fileSize: null,
      hasAudio: true,
      hasVideo: true,
      audioCodec: null,
      videoCodec: null,
      container: "mp4",
      createdAt: c.created_at,
      storageKey: c.preview_path,
      category: "Generated Clips",
      sourceType: "GENERATED_CLIP",
      provider: null,
      licenseName: null,
      attributionText: null,
      processingStatus: "READY",
      tags: [],
      folderId: null,
      streamUrl: `/api/candidates/${c.id}/preview`,
      thumbnailUrl: `/api/media-library/thumbnail?assetRef=${encodeURIComponent(refOf("candidate", c.id))}`,
      searchable: `${c.title} ${c.transcript_excerpt ?? ""}`,
    });
    if (asset) assets.push(asset);
  }

  const media = db
    .prepare("SELECT * FROM project_media WHERE user_id = ? ORDER BY created_at DESC")
    .all(userId) as unknown as ProjectMediaRow[];
  for (const m of media) {
    const asset = applyMeta({
      ref: refOf("media", m.id),
      kind: "media",
      id: m.id,
      projectId: m.project_id,
      filename: m.original_filename,
      mediaKind: m.kind,
      duration: m.duration,
      width: m.width,
      height: m.height,
      aspect: aspectOf(m.width, m.height),
      fileSize: m.file_size,
      hasAudio: m.has_audio === null ? null : m.has_audio === 1,
      hasVideo: m.has_video === null ? null : m.has_video === 1,
      audioCodec: m.audio_codec,
      videoCodec: m.video_codec,
      container: m.container,
      createdAt: m.created_at,
      storageKey: m.storage_key,
      category: m.kind === "VIDEO" ? "B-roll" : "Audio",
      sourceType: "USER_UPLOAD",
      provider: null,
      licenseName: null,
      attributionText: null,
      processingStatus: "READY",
      tags: [],
      folderId: null,
      streamUrl: `/api/project-media/${m.id}/stream`,
      thumbnailUrl:
        m.kind === "VIDEO"
          ? `/api/media-library/thumbnail?assetRef=${encodeURIComponent(refOf("media", m.id))}`
          : null,
      searchable: "",
    });
    if (asset) assets.push(asset);
  }

  const brand = db
    .prepare("SELECT * FROM brand_assets WHERE user_id = ? ORDER BY created_at DESC")
    .all(userId) as unknown as BrandAssetRow[];
  for (const b of brand) {
    const isImage = /\.(png|jpe?g|svg|webp|gif)$/i.test(b.original_filename);
    const asset = applyMeta({
      ref: refOf("brand", b.id),
      kind: "brand",
      id: b.id,
      projectId: null,
      filename: b.original_filename,
      mediaKind: isImage ? "IMAGE" : b.has_video === 1 ? "VIDEO" : "AUDIO",
      duration: b.duration,
      width: b.width,
      height: b.height,
      aspect: aspectOf(b.width, b.height),
      fileSize: b.file_size,
      hasAudio: b.has_audio === null ? null : b.has_audio === 1,
      hasVideo: b.has_video === null ? null : b.has_video === 1,
      audioCodec: null,
      videoCodec: null,
      container: b.container,
      createdAt: b.created_at,
      storageKey: b.storage_key,
      category: "Brand Assets",
      sourceType: "BRAND",
      provider: null,
      licenseName: null,
      attributionText: null,
      processingStatus: "READY",
      tags: [b.kind.toLowerCase()],
      folderId: null,
      streamUrl: `/api/brand-assets/${b.id}/stream`,
      thumbnailUrl: isImage ? `/api/brand-assets/${b.id}/stream` : null,
      searchable: b.kind,
    });
    if (asset) assets.push(asset);
  }

  return assets;
}

export function libraryAssetByRef(userId: string, ref: string): LibraryAsset | null {
  return listLibraryAssets(userId).find((a) => a.ref === ref) ?? null;
}

function publicLibraryAsset(a: LibraryAsset) {
  const { searchable: _searchable, storageKey: _storageKey, ...pub } = a;
  return pub;
}

/** Live usage: which editor documents currently reference this asset
 *  on a timeline (the honest "is it in use" answer), plus recorded
 *  usage events. */
export function assetUsage(userId: string, ref: string): { liveIn: { versionId: string; projectId: string }[]; events: number } {
  const parsed = parseRef(ref);
  if (!parsed) return { liveIn: [], events: 0 };
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT DISTINCT ti.version_id AS versionId, cv.project_id AS projectId
       FROM timeline_items ti JOIN clip_versions cv ON cv.id = ti.version_id
       WHERE ti.asset_kind = ? AND ti.asset_id = ? AND cv.user_id = ?`,
    )
    .all(parsed.kind, parsed.id, userId) as unknown as { versionId: string; projectId: string }[];
  const events = db
    .prepare("SELECT COUNT(*) AS n FROM asset_usage_records WHERE asset_ref = ? AND user_id = ?")
    .get(ref, userId) as { n: number };
  return { liveIn: rows, events: events.n };
}

export function recordUsage(
  userId: string,
  projectId: string | null,
  ref: string,
  usageType: string,
  detail: Record<string, unknown> = {},
): void {
  getDb()
    .prepare(
      "INSERT INTO asset_usage_records (id, user_id, project_id, asset_ref, usage_type, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(newId(), userId, projectId, ref, usageType, JSON.stringify(detail), nowIso());
}

/** True when any library row OTHER than the one being deleted still
 *  references this storage key. Library imports deliberately share
 *  binaries across rows — importAssetIntoProject creates a
 *  project_media row pointing at the SAME binary as the source
 *  brand/candidate/media row — so deleting a library row must never
 *  remove a binary another row still needs. (Candidate previews live
 *  in candidate_clips.preview_path, which is the storage_key other
 *  rows reference when a candidate is imported; pass selfTable null
 *  for those, since the candidate row itself is not in the three
 *  storage_key tables.) */
export function storageKeyReferencedElsewhere(
  storageKey: string,
  selfTable: "project_media" | "source_assets" | "brand_assets" | null,
  selfId: string | null,
): boolean {
  const db = getDb();
  for (const table of ["project_media", "source_assets", "brand_assets"] as const) {
    const row =
      table === selfTable
        ? (db
            .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE storage_key = ? AND id != ?`)
            .get(storageKey, selfId) as { n: number })
        : (db
            .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE storage_key = ?`)
            .get(storageKey) as { n: number });
    if (row.n > 0) return true;
  }
  return false;
}

// ---- transcript term matching (spec §1/§3) ----------------------------------
// Relevance is computed ONLY from real overlap between the spoken
// window's terms and the asset's own searchable terms (filename,
// category, tags, candidate title/excerpt, a source's own transcript
// topics). The matched terms are persisted as the recommendation's
// evidence. A window whose best overlap is negligible yields nothing.

const STOPWORDS = new Set([
  // English function words
  "the", "and", "for", "that", "this", "with", "from", "have", "has", "had", "are", "was", "were",
  "will", "would", "can", "could", "should", "you", "your", "yours", "our", "ours", "they", "them",
  "their", "then", "than", "but", "not", "all", "any", "its", "it", "in", "on", "of", "to", "a", "an",
  "is", "am", "be", "been", "being", "do", "does", "did", "so", "if", "or", "as", "at", "by", "we",
  "i", "me", "my", "he", "she", "his", "her", "here", "there", "what", "when", "where", "which",
  "who", "whom", "how", "why", "about", "into", "over", "under", "again", "once", "just", "like",
  "get", "got", "one", "two", "also", "more", "some", "such", "only", "very", "now", "out", "up",
  "down", "off", "own", "same", "too", "s", "t", "don", "let", "lets", "going", "go", "come",
  // Hindi function words (Devanagari + common romanisations)
  "का", "की", "के", "में", "है", "हैं", "और", "को", "से", "पर", "यह", "वह", "एक", "भी", "तो",
  "नहीं", "था", "थी", "हो", "कर", "जब", "तब", "जो", "कि", "ने", "लिए", "हम", "आप", "मैं",
  "मेरा", "मेरी", "उसके", "इसका", "हुआ", "गया", "रहा", "रही", "चाहिए", "बहुत", "अच्छा",
]);

export function tokenize(text: string): string[] {
  // \p{M} matters: Devanagari vowel signs and the nukta are combining
  // marks, so excluding them would shred words like "गाड़ी" into
  // fragments. Both sides of a match use this same tokenizer anyway.
  const raw = text.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
  return raw.filter((t) => {
    // Latin terms need >= 3 chars to carry meaning; Devanagari and
    // other scripts keep >= 2 (short content words are common).
    const minLen = /^[\u0000-\u007f]+$/.test(t) ? 3 : 2;
    return t.length >= minLen && !STOPWORDS.has(t);
  });
}

export interface TranscriptWindow {
  startSec: number;
  endSec: number;
  passage: string;
  terms: Map<string, number>;
  topicLabel: string | null;
}

/** Group transcript segments into recommendation windows: accumulate
 *  until the window spans >= 3s or two segments, so suggestions land
 *  on meaningful spoken beats rather than sentence fragments. */
export function buildWindows(
  segments: TranscriptSegmentRow[],
  topics: TopicSegmentRow[],
): TranscriptWindow[] {
  const windows: TranscriptWindow[] = [];
  let cur: TranscriptSegmentRow[] = [];
  const flush = () => {
    if (cur.length === 0) return;
    const startSec = cur[0].start_sec;
    const endSec = cur[cur.length - 1].end_sec;
    const passage = cur.map((s) => s.text).join(" ").trim();
    const terms = new Map<string, number>();
    for (const t of tokenize(passage)) terms.set(t, (terms.get(t) ?? 0) + 1);
    const topic = topics.find((tp) => tp.start_sec <= startSec + 0.01 && tp.end_sec >= endSec - 0.01);
    windows.push({ startSec, endSec, passage, terms, topicLabel: topic?.label ?? null });
    cur = [];
  };
  for (const seg of segments) {
    cur.push(seg);
    const span = seg.end_sec - (cur[0]?.start_sec ?? seg.start_sec);
    if (cur.length >= 2 || span >= 3) flush();
  }
  flush();
  return windows;
}

export interface ScoredAsset {
  asset: LibraryAsset;
  score: number;
  matchedTerms: string[];
}

/** Score one asset against one spoken window. Weight = sum of matched
 *  term frequencies in the window, normalised by the window's total
 *  term weight; a long filename keyword list cannot inflate the score
 *  because only window terms count. */
export function scoreAsset(window: TranscriptWindow, asset: LibraryAsset): ScoredAsset | null {
  const assetTerms = new Set(tokenize(asset.searchable));
  if (assetTerms.size === 0) return null;
  let denom = 0;
  let matchedWeight = 0;
  const matchedTerms: string[] = [];
  for (const [term, count] of window.terms) {
    denom += count;
    if (assetTerms.has(term)) {
      matchedWeight += count;
      matchedTerms.push(term);
    }
  }
  if (denom === 0 || matchedTerms.length === 0) return null;
  const score = Math.min(1, matchedWeight / denom);
  return { asset, score, matchedTerms };
}

const MIN_RELEVANCE = 0.12;

interface RecommendationDraft {
  window: TranscriptWindow;
  scored: ScoredAsset;
  reason: string;
}

function draftRecommendations(
  windows: TranscriptWindow[],
  assets: LibraryAsset[],
  instructionTerms: Set<string>,
  excludePairs: Set<string>,
): RecommendationDraft[] {
  const drafts: RecommendationDraft[] = [];
  for (const window of windows) {
    let best: ScoredAsset | null = null;
    for (const asset of assets) {
      if (asset.mediaKind !== "VIDEO" || !asset.hasVideo) continue;
      if (excludePairs.has(`${round3(window.startSec)}:${asset.ref}`)) continue;
      const scored = scoreAsset(window, asset);
      if (!scored) continue;
      // User instruction terms give a real, disclosed boost when the
      // asset matches what the user asked to emphasise.
      const boost = scored.matchedTerms.some((t) => instructionTerms.has(t)) ? 0.08 : 0;
      const total = Math.min(1, scored.score + boost);
      if (total < MIN_RELEVANCE) continue;
      if (!best || total > best.score) best = { ...scored, score: total };
    }
    if (best) {
      const terms = best.matchedTerms.slice(0, 5).join(", ");
      const topicPart = window.topicLabel ? ` during the “${window.topicLabel}” part` : "";
      drafts.push({
        window,
        scored: best,
        reason:
          `The speaker mentions ${terms}${topicPart}, and ${best.asset.filename} matches those terms ` +
          `(${best.asset.category}, from your media library).`,
      });
    }
  }
  return drafts;
}

// ---- phase8 jobs -------------------------------------------------------------
// Same persisted-job discipline as Phases 4/5/7: dedupe on create,
// cancel via a flag + killing the running FFmpeg child, retry, and
// boot recovery that fails interrupted jobs honestly. Progress is a
// STAGE, never an invented percentage (spec §13).

const jobChildren = new Map<string, Set<ChildProcess>>();

export function registerJobChild(jobId: string, child: ChildProcess): () => void {
  let set = jobChildren.get(jobId);
  if (!set) {
    set = new Set();
    jobChildren.set(jobId, set);
  }
  set.add(child);
  return () => {
    set.delete(child);
    if (set.size === 0) jobChildren.delete(jobId);
  };
}

function killJobChildren(jobId: string): void {
  const set = jobChildren.get(jobId);
  if (!set) return;
  for (const child of set) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

class JobCancelled extends Error {
  constructor() {
    super("Job cancelled.");
    this.name = "JobCancelled";
  }
}

export class JobStageError extends Error {
  code: string;
  constructor(message: string, code = "PROCESSING_ERROR") {
    super(message);
    this.name = "JobStageError";
    this.code = code;
  }
}

function runFfmpeg(jobId: string, args: string[], timeoutMs = 30 * 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    const unregister = registerJobChild(jobId, child);
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString("utf8")).slice(-100_000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      unregister();
      reject(new JobStageError(`Could not run ffmpeg: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      unregister();
      if (code === 0) resolve();
      else {
        const tail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400);
        reject(new JobStageError(`ffmpeg failed (exit ${code})${tail ? `: ${tail}` : ""}`));
      }
    });
  });
}

function jobById(id: string): Phase8JobRow | undefined {
  return getDb().prepare("SELECT * FROM phase8_jobs WHERE id = ?").get(id) as Phase8JobRow | undefined;
}

function isCancelRequested(jobId: string): boolean {
  const row = getDb()
    .prepare("SELECT cancel_requested, status FROM phase8_jobs WHERE id = ?")
    .get(jobId) as { cancel_requested: number; status: string } | undefined;
  return !row || row.cancel_requested === 1 || row.status === "CANCELLED";
}

export function throwIfCancelled(jobId: string): void {
  if (isCancelRequested(jobId)) throw new JobCancelled();
}

export function setJobStage(jobId: string, stage: string): void {
  throwIfCancelled(jobId);
  getDb()
    .prepare("UPDATE phase8_jobs SET stage = ?, status = 'RUNNING', updated_at = ? WHERE id = ?")
    .run(stage, nowIso(), jobId);
}

export function completeJob(jobId: string, result: Record<string, unknown>): void {
  getDb()
    .prepare(
      "UPDATE phase8_jobs SET status = 'COMPLETED', stage = 'COMPLETED', result_json = ?, error = NULL, error_code = NULL, finished_at = ?, updated_at = ? WHERE id = ?",
    )
    .run(JSON.stringify(result), nowIso(), nowIso(), jobId);
  // Phase 12: usage ledger + notification (idempotent per job).
  const job = jobById(jobId);
  if (job) {
    const isBroll = job.kind === "BROLL_RECOMMENDATIONS";
    const isImport = job.kind === "PROVIDER_IMPORT";
    const isUrlImport = job.kind === "URL_IMPORT";
    // PROVIDER_IMPORT completes under the same ledger operation the
    // failed-import path uses (stock_search — see createFailedJob).
    const op = isBroll ? "broll" : isImport ? "stock_search" : isUrlImport ? "url_import" : "enhancement";
    recordLedgerUsage(getDb(), {
      userId: job.user_id,
      operation: op,
      resource: "phase8_job",
      quantity: 1,
      unit: "jobs",
      idempotencyKey: `${op}:${jobId}:completed`,
      jobId,
      projectId: job.project_id,
      status: "COMPLETED",
    });
    notify(getDb(), {
      userId: job.user_id,
      category: "ai_processing",
      type: isBroll
        ? "broll.completed"
        : isImport
          ? "stock_import.completed"
          : isUrlImport
            ? "url_import.completed"
            : "enhancement.completed",
      title: isBroll
        ? "B-roll recommendations ready"
        : isImport
          ? "Stock B-roll imported"
          : isUrlImport
            ? "Video imported from URL"
            : "Enhancement completed",
    });
  }
}

export function publicPhase8Job(j: Phase8JobRow) {
  return {
    id: j.id,
    projectId: j.project_id,
    versionId: j.version_id,
    kind: j.kind,
    status: j.status,
    stage: j.stage,
    priority: j.priority,
    payload: parseJson<Record<string, unknown>>(j.payload_json, {}),
    result: parseJson<Record<string, unknown>>(j.result_json, {}),
    error: j.error,
    errorCode: j.error_code,
    createdAt: j.created_at,
    updatedAt: j.updated_at,
    startedAt: j.started_at,
    finishedAt: j.finished_at,
  };
}

interface CreateJobInput {
  userId: string;
  projectId: string;
  versionId?: string | null;
  kind: Phase8JobRow["kind"];
  payload: Record<string, unknown>;
  dedupeKey?: string | null;
  priority?: number;
}

/** Create a job, or return the identical still-active one (duplicate
 *  protection — spec §16: no accidental duplicate processing/spend). */
export function createJob(input: CreateJobInput): { job: Phase8JobRow; deduplicated: boolean } {
  const db = getDb();
  if (input.dedupeKey) {
    const existing = db
      .prepare(
        "SELECT * FROM phase8_jobs WHERE user_id = ? AND dedupe_key = ? AND status IN ('QUEUED', 'RUNNING') ORDER BY created_at DESC LIMIT 1",
      )
      .get(input.userId, input.dedupeKey) as Phase8JobRow | undefined;
    if (existing) return { job: existing, deduplicated: true };
  }
  const now = nowIso();
  const job: Phase8JobRow = {
    id: newId(),
    user_id: input.userId,
    project_id: input.projectId,
    version_id: input.versionId ?? null,
    kind: input.kind,
    status: "QUEUED",
    stage: "QUEUED",
    priority: input.priority ?? 0,
    payload_json: JSON.stringify(input.payload),
    result_json: "{}",
    error: null,
    error_code: null,
    cancel_requested: 0,
    dedupe_key: input.dedupeKey ?? null,
    created_at: now,
    updated_at: now,
    started_at: null,
    finished_at: null,
  };
  db.prepare(
    `INSERT INTO phase8_jobs (id, user_id, project_id, version_id, kind, status, stage, priority, payload_json, result_json, error, error_code, cancel_requested, dedupe_key, created_at, updated_at, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, 'QUEUED', 'QUEUED', ?, ?, '{}', NULL, NULL, 0, ?, ?, ?, NULL, NULL)`,
  ).run(
    job.id, job.user_id, job.project_id, job.version_id, job.kind, job.priority,
    job.payload_json, job.dedupe_key, now, now,
  );
  return { job, deduplicated: false };
}

/** Persist a job that fails before it can even queue (unconfigured
 *  provider operations): the failure is a real, inspectable row. */
export function createFailedJob(
  input: CreateJobInput,
  code: string,
  message: string,
): Phase8JobRow {
  const { job } = createJob(input);
  const now = nowIso();
  getDb()
    .prepare(
      "UPDATE phase8_jobs SET status = 'FAILED', stage = 'VALIDATING', error = ?, error_code = ?, started_at = ?, finished_at = ?, updated_at = ? WHERE id = ?",
    )
    .run(message, code, now, now, now, job.id);
  // Phase 12 (§9): an honestly-refused provider job is still a real
  // usage event — recorded FAILED with quantity 0, never as success.
  const failedOp =
    job.kind === "BACKGROUND_REMOVAL"
      ? "background_removal"
      : job.kind === "PROVIDER_IMPORT"
        ? "stock_search"
        : job.kind === "URL_IMPORT"
          ? "url_import"
          : job.kind === "AI_GENERATION"
            ? "ai_generation"
            : "enhancement";
  recordLedgerUsage(getDb(), {
    userId: job.user_id,
    operation: failedOp,
    resource: "phase8_job",
    quantity: 0,
    unit: "jobs",
    idempotencyKey: `${failedOp}:${job.id}:failed`,
    jobId: job.id,
    projectId: job.project_id,
    status: "FAILED",
  });
  return jobById(job.id)!;
}

// ---- job processors -----------------------------------------------------------

async function processRecommendationsJob(job: Phase8JobRow): Promise<void> {
  const db = getDb();
  const payload = parseJson<{ instructions?: string }>(job.payload_json, {});
  setJobStage(job.id, "VALIDATING");
  const transcript = db
    .prepare("SELECT * FROM transcripts WHERE project_id = ? ORDER BY rowid DESC LIMIT 1")
    .get(job.project_id) as TranscriptRow | undefined;
  if (!transcript) {
    throw new JobStageError(
      "This project has no transcript yet. Run “Find Clips” (Phase 4) first — B-roll recommendations are computed from the real transcript.",
      "NO_TRANSCRIPT",
    );
  }
  const segments = db
    .prepare("SELECT * FROM transcript_segments WHERE transcript_id = ? ORDER BY idx ASC")
    .all(transcript.id) as unknown as TranscriptSegmentRow[];
  if (segments.length === 0) {
    throw new JobStageError("The transcript has no segments to analyse.", "NO_TRANSCRIPT");
  }
  setJobStage(job.id, "ANALYZING");
  const topics = db
    .prepare("SELECT * FROM topic_segments WHERE transcript_id = ? ORDER BY start_sec ASC")
    .all(transcript.id) as unknown as TopicSegmentRow[];
  const windows = buildWindows(segments, topics);
  const instructionTerms = new Set(tokenize(payload.instructions ?? ""));
  throwIfCancelled(job.id);

  setJobStage(job.id, "GENERATING_RECOMMENDATIONS");
  const assets = listLibraryAssets(job.user_id).filter(
    (a) => !(a.kind === "source" && a.projectId === job.project_id),
  );
  // A fresh run replaces still-pending suggestions from earlier runs;
  // accepted/dismissed history is kept. Pairs the user already
  // resolved — DISMISSED, ACCEPTED or REPLACED — are NEVER suggested
  // again on regenerate: a dismissed suggestion stays dismissed, an
  // accepted one is not duplicated as a fresh PENDING row, and an
  // asset the user replaced does not resurface for the same window.
  db.prepare(
    "DELETE FROM broll_recommendations WHERE project_id = ? AND user_id = ? AND status = 'PENDING'",
  ).run(job.project_id, job.user_id);
  const resolvedRows = db
    .prepare(
      "SELECT window_start_sec, asset_ref FROM broll_recommendations WHERE project_id = ? AND user_id = ? AND status IN ('DISMISSED', 'ACCEPTED', 'REPLACED')",
    )
    .all(job.project_id, job.user_id) as unknown as { window_start_sec: number; asset_ref: string }[];
  const excludePairs = new Set(
    resolvedRows.map((r) => `${round3(r.window_start_sec)}:${r.asset_ref}`),
  );
  const drafts = draftRecommendations(windows, assets, instructionTerms, excludePairs);
  const now = nowIso();
  const ins = db.prepare(
    `INSERT INTO broll_recommendations (id, job_id, user_id, project_id, transcript_id, window_start_sec, window_end_sec, passage, asset_ref, asset_kind, asset_id, score, matched_terms_json, reason, suggested_start_sec, suggested_duration_sec, source, license_json, status, placement_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'LIBRARY', ?, 'PENDING', NULL, ?, ?)`,
  );
  for (const draft of drafts) {
    const asset = draft.scored.asset;
    const duration = round3(
      Math.max(
        1,
        Math.min(draft.window.endSec - draft.window.startSec, asset.duration ?? 6, 8),
      ),
    );
    ins.run(
      newId(), job.id, job.user_id, job.project_id, transcript.id,
      round3(draft.window.startSec), round3(draft.window.endSec),
      draft.window.passage.slice(0, 600),
      asset.ref, asset.kind, asset.id,
      Math.round(draft.scored.score * 1000) / 1000,
      JSON.stringify(draft.scored.matchedTerms),
      draft.reason,
      round3(draft.window.startSec), duration,
      asset.licenseName ? JSON.stringify({ licenseName: asset.licenseName, attribution: asset.attributionText }) : null,
      now, now,
    );
  }
  setJobStage(job.id, "FINALIZING");
  completeJob(job.id, {
    recommendations: drafts.length,
    windowsAnalysed: windows.length,
    transcriptId: transcript.id,
    language: transcript.language,
  });
}

/** Resolve a library asset (or a project source/media row) to a real
 *  file + probe metadata. The file is only ever READ. */
async function resolveAssetFile(
  userId: string,
  ref: string,
): Promise<{ asset: LibraryAsset; absPath: string; probe: Awaited<ReturnType<typeof probeAnyFile>> }> {
  const asset = libraryAssetByRef(userId, ref);
  if (!asset || !asset.storageKey) {
    throw new JobStageError("That asset is not available in your media library.", "ASSET_NOT_FOUND");
  }
  const absPath = mediaPath(asset.storageKey);
  if (!fs.existsSync(absPath)) {
    throw new JobStageError("The asset's file is missing from storage.", "ASSET_NOT_FOUND");
  }
  const probe = await probeAnyFile(absPath);
  return { asset, absPath, probe };
}

function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

interface EnhancePayload {
  assetRef: string;
  video: VideoEnhanceSettings;
  audio: AudioEnhanceSettings;
}

async function processEnhancementPreviewJob(job: Phase8JobRow): Promise<void> {
  const payload = parseJson<EnhancePayload>(job.payload_json, {
    assetRef: "",
    video: DEFAULT_VIDEO_ENHANCE,
    audio: DEFAULT_AUDIO_ENHANCE,
  });
  setJobStage(job.id, "VALIDATING");
  const { asset, absPath, probe } = await resolveAssetFile(job.user_id, payload.assetRef);
  if (!probe.hasVideo) {
    throw new JobStageError(
      "Before/after preview needs a video asset. Audio enhancement is applied by enhancement jobs and renders instead.",
      "NO_VIDEO",
    );
  }
  setJobStage(job.id, "PREPARING_MEDIA");
  const dir = path.join(config.mediaDir, job.user_id, "phase8-previews");
  fs.mkdirSync(dir, { recursive: true });
  const seconds = Math.min(4, probe.duration ?? 4);
  const common = ["-v", "error", "-y", "-ss", "0", "-i", absPath, "-t", String(seconds)];
  // "Before" = the untouched frames, re-encoded with the same codec
  // settings so the comparison is honest.
  setJobStage(job.id, "PROCESSING_VIDEO");
  await runFfmpeg(job.id, [
    ...common, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    ...(probe.hasAudio ? ["-c:a", "aac", "-b:a", "128k"] : ["-an"]),
    "-movflags", "+faststart", path.join(dir, `${job.id}-before.mp4`),
  ]);
  throwIfCancelled(job.id);
  const vChain = buildVideoChain(payload.video, { includeUpscale: true });
  const aChain = probe.hasAudio ? buildAudioChain(payload.audio, seconds) : [];
  const args = [...common];
  if (vChain.length > 0 || aChain.length > 0) {
    const parts: string[] = [];
    if (vChain.length > 0) parts.push(`[0:v]${vChain.join(",")}[v]`);
    if (aChain.length > 0) parts.push(`[0:a]${aChain.join(",")}[a]`);
    args.push("-filter_complex", parts.join(";"));
    args.push("-map", vChain.length > 0 ? "[v]" : "0:v");
    if (probe.hasAudio) args.push("-map", aChain.length > 0 ? "[a]" : "0:a");
    else args.push("-an");
  } else if (!probe.hasAudio) {
    args.push("-an");
  }
  args.push(
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    ...(probe.hasAudio ? ["-c:a", "aac", "-b:a", "128k"] : []),
    "-movflags", "+faststart", path.join(dir, `${job.id}-after.mp4`),
  );
  await runFfmpeg(job.id, args);
  setJobStage(job.id, "FINALIZING");
  completeJob(job.id, {
    assetRef: payload.assetRef,
    filename: asset.filename,
    previewSeconds: seconds,
    beforeUrl: `/api/phase8-jobs/${job.id}/preview/before`,
    afterUrl: `/api/phase8-jobs/${job.id}/preview/after`,
    appliedVideoFilters: vChain,
    appliedAudioFilters: aChain,
  });
}

async function processEnhancementJob(job: Phase8JobRow): Promise<void> {
  const db = getDb();
  const payload = parseJson<EnhancePayload>(job.payload_json, {
    assetRef: "",
    video: DEFAULT_VIDEO_ENHANCE,
    audio: DEFAULT_AUDIO_ENHANCE,
  });
  setJobStage(job.id, "VALIDATING");
  const { asset, absPath, probe } = await resolveAssetFile(job.user_id, payload.assetRef);
  const projectId = asset.projectId ?? job.project_id;
  const tmpDir = path.join(config.processingDir, "phase8", job.id);
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    // Stabilization pass 1 (vidstabdetect) — genuinely two-pass: the
    // transforms file is measured from THIS source, then consumed by
    // vidstabtransform in the main pass below.
    let stabFilter: string | null = null;
    if (probe.hasVideo && payload.video.stabilization.enabled) {
      setJobStage(job.id, "PREPARING_MEDIA");
      const transforms = path.join(tmpDir, "transforms.trf");
      await runFfmpeg(job.id, [
        "-v", "error", "-y", "-i", absPath,
        "-vf", `vidstabdetect=shakiness=${Math.max(1, Math.round(payload.video.stabilization.strength * 10))}:accuracy=15:result=${escapeFilterPath(transforms)}`,
        "-f", "null", "-",
      ]);
      throwIfCancelled(job.id);
      // Crop compensation (settings 0..1) maps onto vidstabtransform's
      // optzoom: <0.34 → 0 (no zoom compensation — frame borders may
      // show), <0.84 → 1 (optimal static zoom; the default 0.5 lands
      // here, reproducing the historical fixed optzoom=1), otherwise
      // 2 (adaptive per-frame zoom). Smoothing comes from the same
      // settings object, as before.
      const cc = payload.video.stabilization.cropCompensation;
      const optzoom = cc < 0.34 ? 0 : cc < 0.84 ? 1 : 2;
      stabFilter =
        `vidstabtransform=input=${escapeFilterPath(transforms)}:smoothing=${payload.video.stabilization.smoothing}` +
        `:optzoom=${optzoom}:interpol=bicubic`;
    }

    setJobStage(job.id, "PROCESSING_VIDEO");
    const vChain = probe.hasVideo ? buildVideoChain(payload.video, { includeUpscale: true }) : [];
    const fullVideoChain = [...(stabFilter ? [stabFilter] : []), ...vChain];
    const aChain = probe.hasAudio ? buildAudioChain(payload.audio, probe.duration) : [];

    const mediaId = newId();
    const isVideo = probe.hasVideo;
    const ext = isVideo ? "mp4" : "m4a";
    const storageKey = `${job.user_id}/media/${mediaId}.${ext}`;
    const outAbs = mediaPath(storageKey);
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    const outTmp = path.join(tmpDir, `out.${ext}`);
    const args = ["-v", "error", "-y", "-i", absPath];
    if (isVideo) {
      if (fullVideoChain.length > 0 || aChain.length > 0) {
        const parts: string[] = [];
        if (fullVideoChain.length > 0) parts.push(`[0:v]${fullVideoChain.join(",")}[v]`);
        if (aChain.length > 0) parts.push(`[0:a]${aChain.join(",")}[a]`);
        args.push("-filter_complex", parts.join(";"));
        args.push("-map", fullVideoChain.length > 0 ? "[v]" : "0:v");
        if (probe.hasAudio) args.push("-map", aChain.length > 0 ? "[a]" : "0:a");
        else args.push("-an");
      } else if (!probe.hasAudio) {
        args.push("-an");
      }
      args.push(
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
        ...(probe.hasAudio ? ["-c:a", "aac", "-b:a", "160k", "-ar", "48000"] : []),
        "-movflags", "+faststart", outTmp,
      );
    } else {
      if (aChain.length > 0) args.push("-af", aChain.join(","));
      args.push("-vn", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", outTmp);
    }
    if (probe.hasAudio) setJobStage(job.id, "PROCESSING_AUDIO");
    await runFfmpeg(job.id, args);
    throwIfCancelled(job.id);

    setJobStage(job.id, "FINALIZING");
    const outProbe = await probeAnyFile(outTmp);
    fs.renameSync(outTmp, outAbs);
    const baseName = asset.filename.replace(/\.[A-Za-z0-9]+$/, "");
    const row: ProjectMediaRow = {
      id: mediaId,
      project_id: projectId,
      user_id: job.user_id,
      kind: isVideo ? "VIDEO" : "AUDIO",
      original_filename: `${baseName}-enhanced.${ext}`,
      storage_key: storageKey,
      storage_provider: "local",
      file_size: fs.statSync(outAbs).size,
      duration: outProbe.duration,
      width: outProbe.width,
      height: outProbe.height,
      video_codec: outProbe.videoCodec,
      audio_codec: outProbe.audioCodec,
      has_audio: outProbe.hasAudio ? 1 : 0,
      has_video: outProbe.hasVideo ? 1 : 0,
      container: outProbe.container,
      created_at: nowIso(),
    };
    db.prepare(
      `INSERT INTO project_media (id, project_id, user_id, kind, original_filename, storage_key, storage_provider, file_size, duration, width, height, video_codec, audio_codec, has_audio, has_video, container, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id, row.project_id, row.user_id, row.kind, row.original_filename, row.storage_key,
      row.file_size, row.duration, row.width, row.height, row.video_codec, row.audio_codec,
      row.has_audio, row.has_video, row.container, row.created_at,
    );
    const derivedRef = refOf("media", mediaId);
    const now = nowIso();
    db.prepare(
      `INSERT INTO media_asset_meta (asset_ref, user_id, project_id, category, folder_id, source_type, provider, provider_asset_id, license_name, attribution_text, processing_status, tags_json, hidden, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, 'ENHANCED_DERIVED', NULL, NULL, NULL, NULL, 'READY', ?, 0, ?, ?)`,
    ).run(derivedRef, job.user_id, projectId, isVideo ? "Generated Assets" : "Audio", JSON.stringify(["enhanced", "derived"]), now, now);
    recordUsage(job.user_id, projectId, payload.assetRef, "ENHANCED", { jobId: job.id, derivedRef });
    completeJob(job.id, {
      sourceRef: payload.assetRef,
      derivedRef,
      derivedMediaId: mediaId,
      derivedFilename: row.original_filename,
      width: outProbe.width,
      height: outProbe.height,
      duration: outProbe.duration,
      hasAudio: outProbe.hasAudio,
      hasVideo: outProbe.hasVideo,
      stabilized: Boolean(stabFilter),
      appliedVideoFilters: fullVideoChain,
      appliedAudioFilters: aChain,
      note: payload.video.upscale.enabled
        ? "Upscaling used a lanczos scale filter only — it does not reconstruct detail that was not in the source."
        : undefined,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

interface ProviderImportPayload {
  provider?: string;
  providerAssetId?: string;
}

/** Real stock import (Pexels): resolve the asset, download the
 *  chosen rendition into this project's media, probe it, and land
 *  it as a normal B-roll library asset carrying the provider's
 *  licence + credit metadata (provider / provider_asset_id /
 *  license_name / attribution_text on media_asset_meta) plus a
 *  media_license_records row holding the source URL. From there the
 *  asset flows through the library exactly like an upload —
 *  recommendations, accept → placement (B-roll starts muted, the
 *  Phase 8 default) and renders need no special case. Importing
 *  the same provider asset into the same project twice completes
 *  against the existing asset instead of duplicating the file. */
async function processProviderImportJob(job: Phase8JobRow): Promise<void> {
  const db = getDb();
  const payload = parseJson<ProviderImportPayload>(job.payload_json, {});
  setJobStage(job.id, "VALIDATING");
  if (!stockProvider.configured) {
    // Queued while configured, key since removed (or a restored
    // row): fail honestly, never simulate an import.
    throw new JobStageError(stockProvider.detail, "CONFIGURATION_ERROR");
  }
  const providerAssetId = (payload.providerAssetId ?? "").trim();
  if (!providerAssetId) {
    throw new JobStageError("This import job does not name a provider asset.", "VALIDATION_ERROR");
  }
  if (payload.provider && payload.provider !== stockProvider.id) {
    throw new JobStageError(
      `Stock provider "${payload.provider}" is not the configured provider ("${stockProvider.id}").`,
      "CONFIGURATION_ERROR",
    );
  }
  const existing = db
    .prepare(
      "SELECT asset_ref FROM media_asset_meta WHERE user_id = ? AND project_id = ? AND provider = ? AND provider_asset_id = ? LIMIT 1",
    )
    .get(job.user_id, job.project_id, stockProvider.id, providerAssetId) as
    | { asset_ref: string }
    | undefined;
  if (existing) {
    completeJob(job.id, {
      assetRef: existing.asset_ref,
      provider: stockProvider.id,
      providerAssetId,
      deduplicated: true,
    });
    return;
  }

  let detail: StockAssetDetail;
  try {
    detail = await stockProvider.fetchAsset(providerAssetId);
  } catch (err) {
    if (err instanceof ConfigurationError) throw new JobStageError(err.message, "CONFIGURATION_ERROR");
    if (err instanceof StockProviderError) {
      throw new JobStageError(err.message, err.status === 404 ? "ASSET_NOT_FOUND" : "PROVIDER_ERROR");
    }
    throw err;
  }

  setJobStage(job.id, "PREPARING_MEDIA");
  const tmpDir = path.join(config.processingDir, "phase8", job.id);
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    const tmpFile = path.join(tmpDir, "download.mp4");
    try {
      await stockProvider.downloadToFile(detail.downloadUrl, tmpFile, config.maxUploadMb * 1024 * 1024);
    } catch (err) {
      if (err instanceof ConfigurationError) throw new JobStageError(err.message, "CONFIGURATION_ERROR");
      if (err instanceof StockProviderError) throw new JobStageError(err.message, "PROVIDER_ERROR");
      throw err;
    }
    throwIfCancelled(job.id);
    const probe = await probeAnyFile(tmpFile);
    if (!probe.hasVideo) {
      throw new JobStageError("The downloaded stock file is not a video file.", "INVALID_MEDIA");
    }
    setJobStage(job.id, "FINALIZING");
    const mediaId = newId();
    const storageKey = `${job.user_id}/media/${mediaId}.mp4`;
    const outAbs = mediaPath(storageKey);
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    fs.renameSync(tmpFile, outAbs);
    const safeTitle = detail.title
      .replace(/[^\p{L}\p{N} _-]+/gu, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    const filename = `${safeTitle || `pexels-${providerAssetId}`}.mp4`;
    const now = nowIso();
    db.prepare(
      `INSERT INTO project_media (id, project_id, user_id, kind, original_filename, storage_key, storage_provider, file_size, duration, width, height, video_codec, audio_codec, has_audio, has_video, container, created_at)
       VALUES (?, ?, ?, 'VIDEO', ?, ?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      mediaId, job.project_id, job.user_id, filename, storageKey,
      fs.statSync(outAbs).size, probe.duration, probe.width, probe.height,
      probe.videoCodec, probe.audioCodec, probe.hasAudio ? 1 : 0, probe.hasVideo ? 1 : 0,
      probe.container, now,
    );
    const assetRef = refOf("media", mediaId);
    db.prepare(
      `INSERT INTO media_asset_meta (asset_ref, user_id, project_id, category, folder_id, source_type, provider, provider_asset_id, license_name, attribution_text, processing_status, tags_json, hidden, created_at, updated_at)
       VALUES (?, ?, ?, 'B-roll', NULL, 'STOCK_IMPORT', ?, ?, ?, ?, 'READY', ?, 0, ?, ?)`,
    ).run(
      assetRef, job.user_id, job.project_id, stockProvider.id, providerAssetId,
      detail.licenseName, detail.attributionText,
      JSON.stringify(["broll", "stock", stockProvider.id]), now, now,
    );
    db.prepare(
      "INSERT INTO media_license_records (id, user_id, asset_ref, provider, license_name, attribution_text, source_url, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      newId(), job.user_id, assetRef, stockProvider.id, detail.licenseName,
      detail.attributionText, detail.sourceUrl || null, now,
    );
    recordUsage(job.user_id, job.project_id, assetRef, "STOCK_IMPORTED", {
      provider: stockProvider.id,
      providerAssetId,
      sourceUrl: detail.sourceUrl,
      creatorName: detail.creatorName,
    });
    completeJob(job.id, {
      assetRef,
      mediaId,
      provider: stockProvider.id,
      providerAssetId,
      title: detail.title,
      licenseName: detail.licenseName,
      attributionText: detail.attributionText,
      sourceUrl: detail.sourceUrl,
      creatorName: detail.creatorName,
      duration: probe.duration,
      width: probe.width,
      height: probe.height,
      hasAudio: probe.hasAudio,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function processPhase8Job(jobId: string): Promise<void> {
  const job = jobById(jobId);
  if (!job) return;
  try {
    if (job.kind === "BROLL_RECOMMENDATIONS") await processRecommendationsJob(job);
    else if (job.kind === "ENHANCEMENT") await processEnhancementJob(job);
    else if (job.kind === "ENHANCEMENT_PREVIEW") await processEnhancementPreviewJob(job);
    else if (job.kind === "PROVIDER_IMPORT") await processProviderImportJob(job);
    else if (job.kind === "URL_IMPORT") await processUrlImportJob(job);
    else {
      // BACKGROUND_REMOVAL / AI_GENERATION are only ever created as
      // already-FAILED rows; reaching the worker means a retry was
      // requested — fail honestly again, never simulate.
      throw new JobStageError(
        "This operation needs a provider that is not configured on this server.",
        "CONFIGURATION_ERROR",
      );
    }
  } catch (err) {
    if (err instanceof JobCancelled || isCancelRequested(jobId)) {
      killJobChildren(jobId);
      getDb()
        .prepare(
          "UPDATE phase8_jobs SET status = 'CANCELLED', stage = 'CANCELLED', finished_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(nowIso(), nowIso(), jobId);
    } else {
      const message = err instanceof Error ? err.message : "Processing failed.";
      const code = err instanceof JobStageError ? err.code : "PROCESSING_ERROR";
      const current = jobById(jobId);
      getDb()
        .prepare(
          "UPDATE phase8_jobs SET status = 'FAILED', stage = ?, error = ?, error_code = ?, finished_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(current?.stage ?? "FAILED", message.slice(0, 1000), code, nowIso(), nowIso(), jobId);
      // Phase 12 (§9): failed enhancement/B-roll recorded with
      // quantity 0 — never billed as successful usage.
      const failedOp =
        job.kind === "BROLL_RECOMMENDATIONS"
          ? "broll"
          : job.kind === "PROVIDER_IMPORT"
            ? "stock_search"
            : job.kind === "URL_IMPORT"
              ? "url_import"
              : "enhancement";
      recordLedgerUsage(getDb(), {
        userId: job.user_id,
        operation: failedOp,
        resource: "phase8_job",
        quantity: 0,
        unit: "jobs",
        idempotencyKey: `${failedOp}:${jobId}:failed`,
        jobId,
        projectId: job.project_id,
        status: "FAILED",
      });
      notify(getDb(), {
        userId: job.user_id,
        category: "ai_processing",
        type:
          job.kind === "PROVIDER_IMPORT"
            ? "stock_import.failed"
            : job.kind === "URL_IMPORT"
              ? "url_import.failed"
              : `${failedOp}.failed`,
        title:
          job.kind === "BROLL_RECOMMENDATIONS"
            ? "B-roll recommendations failed"
            : job.kind === "PROVIDER_IMPORT"
              ? "Stock B-roll import failed"
              : job.kind === "URL_IMPORT"
                ? "URL import failed"
                : "Enhancement failed",
        body: message.slice(0, 200),
      });
    }
  }
}

let phase8Timer: NodeJS.Timeout | null = null;
let phase8Busy = false;

async function phase8Tick(): Promise<void> {
  if (phase8Busy) return;
  const next = getDb()
    .prepare("SELECT id FROM phase8_jobs WHERE status = 'QUEUED' ORDER BY priority DESC, created_at ASC, rowid ASC LIMIT 1")
    .get() as { id: string } | undefined;
  if (!next) return;
  const claim = getDb()
    .prepare(
      "UPDATE phase8_jobs SET status = 'RUNNING', stage = 'VALIDATING', started_at = ?, updated_at = ? WHERE id = ? AND status = 'QUEUED'",
    )
    .run(nowIso(), nowIso(), next.id);
  if (claim.changes === 0) return;
  phase8Busy = true;
  try {
    await processPhase8Job(next.id);
  } finally {
    phase8Busy = false;
  }
}

/** Boot recovery + worker start (called from src/index.ts). */
export function startPhase8Worker(): void {
  getDb()
    .prepare(
      `UPDATE phase8_jobs SET status = 'FAILED', stage = 'FAILED',
       error = 'This job was interrupted by a server restart. Use Retry to run it again.', error_code = 'INTERRUPTED',
       finished_at = ?, updated_at = ? WHERE status = 'RUNNING'`,
    )
    .run(nowIso(), nowIso());
  if (phase8Timer) return;
  phase8Timer = setInterval(() => {
    void phase8Tick().catch((err) => console.error("[phase8] tick failed:", err));
  }, 500);
  phase8Timer.unref();
  void phase8Tick().catch((err) => console.error("[phase8] tick failed:", err));
}

// ---- serializers ---------------------------------------------------------------

function publicRecommendation(
  userId: string,
  r: BrollRecommendationRow,
) {
  const asset = libraryAssetByRef(userId, r.asset_ref);
  return {
    id: r.id,
    jobId: r.job_id,
    projectId: r.project_id,
    windowStartSec: r.window_start_sec,
    windowEndSec: r.window_end_sec,
    passage: r.passage,
    assetRef: r.asset_ref,
    assetKind: r.asset_kind,
    assetId: r.asset_id,
    assetFilename: asset?.filename ?? "(asset removed)",
    assetCategory: asset?.category ?? null,
    assetDuration: asset?.duration ?? null,
    thumbnailUrl: asset?.thumbnailUrl ?? null,
    streamUrl: asset?.streamUrl ?? null,
    score: r.score,
    matchedTerms: parseJson<string[]>(r.matched_terms_json, []),
    reason: r.reason,
    suggestedStartSec: r.suggested_start_sec,
    suggestedDurationSec: r.suggested_duration_sec,
    source: r.source,
    license: parseJson<Record<string, unknown> | null>(r.license_json, null),
    status: r.status,
    placementId: r.placement_id,
    createdAt: r.created_at,
  };
}

function publicPlacement(p: BrollPlacementRow) {
  return {
    id: p.id,
    projectId: p.project_id,
    versionId: p.version_id,
    recommendationId: p.recommendation_id,
    itemId: p.item_id,
    assetKind: p.asset_kind,
    assetId: p.asset_id,
    startSec: p.start_sec,
    durationSec: p.duration_sec,
    sourceInSec: p.source_in_sec,
    sourceOutSec: p.source_out_sec,
    displayMode: p.display_mode,
    keepOriginalAudio: p.keep_original_audio === 1,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

function publicEnhancementConfig(row: EnhancementConfigRow | null, docId: string, projectId: string) {
  if (!row) {
    return {
      id: null,
      documentId: docId,
      projectId,
      videoEnabled: false,
      audioEnabled: false,
      video: { ...DEFAULT_VIDEO_ENHANCE },
      audio: { ...DEFAULT_AUDIO_ENHANCE },
      scope: "project" as const,
      itemIds: [] as string[],
      updatedAt: null,
    };
  }
  return {
    id: row.id,
    documentId: row.version_id,
    projectId: row.project_id,
    videoEnabled: row.video_enabled === 1,
    audioEnabled: row.audio_enabled === 1,
    video: normalizeVideo(parseJson(row.video_json, {})),
    audio: normalizeAudio(parseJson(row.audio_json, {})),
    scope: (row.scope === "items" ? "items" : "project") as "project" | "items",
    itemIds: parseJson<string[]>(row.item_ids_json, []),
    updatedAt: row.updated_at,
  };
}

// ---- placement <-> timeline synchronisation -------------------------------------

/** Map a source-time instant (transcript time) onto the document's
 *  timeline through its main-track source/candidate items. Returns
 *  null when the moment is not part of the timeline. */
function sourceToTimeline(state: EditorState, t: number): number | null {
  const mainTracks = new Set(state.tracks.filter((tr) => tr.kind === "main").map((tr) => tr.id));
  const items = state.items
    .filter((i) => mainTracks.has(i.trackId) && (i.assetKind === "source" || i.assetKind === "candidate"))
    .sort((a, b) => a.start - b.start);
  for (const item of items) {
    if (t >= item.sourceIn - 0.01 && t <= item.sourceOut + 0.01) {
      return round3(item.start + (t - item.sourceIn) / item.speed);
    }
  }
  return null;
}

export const DISPLAY_MODES = ["FULLSCREEN", "PIP", "OVERLAY"] as const;
export type DisplayMode = (typeof DISPLAY_MODES)[number];

function transformForMode(mode: DisplayMode): TransformState {
  switch (mode) {
    case "PIP":
      return { ...DEFAULT_TRANSFORM, fit: "fill", scale: 0.35, x: 0.82, y: -0.82 };
    case "OVERLAY":
      return { ...DEFAULT_TRANSFORM, fit: "fit" };
    case "FULLSCREEN":
    default:
      return { ...DEFAULT_TRANSFORM, fit: "fill" };
  }
}

/** Import a library asset from another project into this project as a
 *  project_media row sharing the same stored binary (no copy, no
 *  modification of the original). Returns the media id to reference. */
function importAssetIntoProject(
  userId: string,
  projectId: string,
  asset: LibraryAsset,
): { mediaId: string; created: boolean } {
  const db = getDb();
  if (asset.kind === "media" && asset.projectId === projectId) {
    return { mediaId: asset.id, created: false };
  }
  if (!asset.storageKey) {
    throw new JobStageError("That asset has no stored file to import.", "ASSET_NOT_FOUND");
  }
  const existing = db
    .prepare("SELECT * FROM project_media WHERE project_id = ? AND user_id = ? AND storage_key = ?")
    .get(projectId, userId, asset.storageKey) as ProjectMediaRow | undefined;
  if (existing) return { mediaId: existing.id, created: false };
  const mediaId = newId();
  db.prepare(
    `INSERT INTO project_media (id, project_id, user_id, kind, original_filename, storage_key, storage_provider, file_size, duration, width, height, video_codec, audio_codec, has_audio, has_video, container, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    mediaId, projectId, userId, asset.mediaKind === "AUDIO" ? "AUDIO" : "VIDEO",
    asset.filename, asset.storageKey, asset.fileSize, asset.duration, asset.width, asset.height,
    asset.videoCodec, asset.audioCodec,
    asset.hasAudio === null ? null : asset.hasAudio ? 1 : 0,
    asset.hasVideo === null ? null : asset.hasVideo ? 1 : 0,
    asset.container, nowIso(),
  );
  const now = nowIso();
  db.prepare(
    `INSERT INTO media_asset_meta (asset_ref, user_id, project_id, category, folder_id, source_type, provider, provider_asset_id, license_name, attribution_text, processing_status, tags_json, hidden, created_at, updated_at)
     VALUES (?, ?, ?, 'B-roll', NULL, 'IMPORTED_FROM_LIBRARY', ?, ?, ?, ?, 'READY', ?, 0, ?, ?)`,
  ).run(
    refOf("media", mediaId), userId, projectId, asset.provider, asset.id,
    asset.licenseName, asset.attributionText, JSON.stringify(["broll"]), now, now,
  );
  recordUsage(userId, projectId, asset.ref, "IMPORTED_INTO_PROJECT", { asRef: refOf("media", mediaId) });
  return { mediaId, created: true };
}

// ---- routes -----------------------------------------------------------------------

export function registerPhase8Routes(app: express.Express, requireAuth: RequireAuth): void {
  const router = express.Router();

  // -- provider / capability status --
  router.get("/phase8/status", requireAuth, (_req: AuthedRequest, res) => {
    res.json({ providers: phase8ProviderStatus(), categories: LIBRARY_CATEGORIES });
  });

  // -- media library --
  router.get("/media-library", requireAuth, (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const q = typeof req.query.q === "string" ? req.query.q.toLowerCase() : "";
    const category = typeof req.query.category === "string" ? req.query.category : "";
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : "";
    const folderId = typeof req.query.folderId === "string" ? req.query.folderId : "";
    const sort = typeof req.query.sort === "string" ? req.query.sort : "newest";
    let assets = listLibraryAssets(userId);
    if (projectId) assets = assets.filter((a) => a.projectId === projectId);
    if (category) assets = assets.filter((a) => a.category === category);
    if (folderId) assets = assets.filter((a) => a.folderId === folderId);
    if (q) {
      const terms = tokenize(q);
      assets = assets.filter((a) => {
        const hay = new Set(tokenize(a.searchable));
        return terms.length === 0 || terms.some((t) => hay.has(t)) || a.filename.toLowerCase().includes(q);
      });
    }
    const by: Record<string, (x: LibraryAsset, y: LibraryAsset) => number> = {
      newest: (x, y) => y.createdAt.localeCompare(x.createdAt),
      oldest: (x, y) => x.createdAt.localeCompare(y.createdAt),
      name: (x, y) => x.filename.localeCompare(y.filename),
      duration: (x, y) => (y.duration ?? 0) - (x.duration ?? 0),
      size: (x, y) => (y.fileSize ?? 0) - (x.fileSize ?? 0),
    };
    assets.sort(by[sort] ?? by.newest);
    const folders = getDb()
      .prepare("SELECT * FROM media_library_folders WHERE user_id = ? ORDER BY name ASC")
      .all(userId) as unknown as { id: string; name: string; parent_id: string | null; created_at: string }[];
    res.json({
      assets: assets.map((a) => ({ ...publicLibraryAsset(a), usage: assetUsage(userId, a.ref) })),
      categories: LIBRARY_CATEGORIES,
      folders: folders.map((f) => ({ id: f.id, name: f.name, parentId: f.parent_id, createdAt: f.created_at })),
    });
  });

  const metaPatchSchema = z.object({
    assetRef: z.string().min(3).max(200),
    category: z.enum(LIBRARY_CATEGORIES).optional(),
    folderId: z.string().max(128).nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    licenseName: z.string().trim().max(200).nullable().optional(),
    attributionText: z.string().trim().max(500).nullable().optional(),
    sourceType: z.string().trim().max(60).optional(),
    processingStatus: z.string().trim().max(60).optional(),
  });

  router.patch("/media-library/meta", requireAuth, (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const parsed = metaPatchSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, "VALIDATION_ERROR", "Invalid library update.");
    const asset = libraryAssetByRef(userId, parsed.data.assetRef);
    if (!asset) return fail(res, 404, "NOT_FOUND", "Asset not found in your library.");
    const db = getDb();
    const existing = metaOf(userId, asset.ref);
    const now = nowIso();
    if (existing) {
      db.prepare(
        `UPDATE media_asset_meta SET category = ?, folder_id = ?, source_type = ?, license_name = ?, attribution_text = ?, processing_status = ?, tags_json = ?, updated_at = ? WHERE asset_ref = ?`,
      ).run(
        parsed.data.category ?? existing.category,
        parsed.data.folderId !== undefined ? parsed.data.folderId : existing.folder_id,
        parsed.data.sourceType ?? existing.source_type,
        parsed.data.licenseName !== undefined ? parsed.data.licenseName : existing.license_name,
        parsed.data.attributionText !== undefined ? parsed.data.attributionText : existing.attribution_text,
        parsed.data.processingStatus ?? existing.processing_status,
        parsed.data.tags ? JSON.stringify(parsed.data.tags) : existing.tags_json,
        now, asset.ref,
      );
    } else {
      db.prepare(
        `INSERT INTO media_asset_meta (asset_ref, user_id, project_id, category, folder_id, source_type, provider, provider_asset_id, license_name, attribution_text, processing_status, tags_json, hidden, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      ).run(
        asset.ref, userId, asset.projectId,
        parsed.data.category ?? asset.category,
        parsed.data.folderId ?? null,
        parsed.data.sourceType ?? asset.sourceType,
        asset.provider, null,
        parsed.data.licenseName ?? asset.licenseName,
        parsed.data.attributionText ?? asset.attributionText,
        parsed.data.processingStatus ?? asset.processingStatus,
        JSON.stringify(parsed.data.tags ?? asset.tags),
        now, now,
      );
    }
    if (parsed.data.licenseName || parsed.data.attributionText) {
      db.prepare(
        "INSERT INTO media_license_records (id, user_id, asset_ref, provider, license_name, attribution_text, source_url, recorded_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)",
      ).run(newId(), userId, asset.ref, asset.provider, parsed.data.licenseName ?? null, parsed.data.attributionText ?? null, now);
    }
    const updated = libraryAssetByRef(userId, asset.ref);
    return res.json({ asset: updated ? { ...publicLibraryAsset(updated), usage: assetUsage(userId, asset.ref) } : null });
  });

  router.delete("/media-library/item", requireAuth, (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const ref = typeof req.query.assetRef === "string" ? req.query.assetRef : "";
    const force = req.query.force === "true";
    const asset = libraryAssetByRef(userId, ref);
    if (!asset) return fail(res, 404, "NOT_FOUND", "Asset not found in your library.");
    if (asset.kind === "source") {
      return fail(
        res, 400, "ORIGINAL_PROTECTED",
        "This is a project's original uploaded video. CLIPFORGE never deletes original source media from the library — it is the input every edit depends on.",
      );
    }
    const usage = assetUsage(userId, ref);
    if (usage.liveIn.length > 0 && !force) {
      return res.status(409).json({
        error: {
          code: "ASSET_IN_USE",
          message: `This asset is used on ${usage.liveIn.length} timeline(s). Delete with force=true to remove those timeline items safely first, or remove the items manually.`,
        },
        usage,
      });
    }
    const db = getDb();
    // Safe path: when forced, remove referencing timeline items as
    // proper editor operations so documents stay valid.
    if (usage.liveIn.length > 0 && force) {
      for (const live of usage.liveIn) {
        const doc = docById(userId, live.versionId);
        if (!doc) continue;
        const state = readState(doc);
        const next: EditorState = {
          ...state,
          items: state.items.filter((i) => !(i.assetKind === asset.kind && i.assetId === asset.id)),
        };
        const checked = validateState(userId, doc.project_id, next);
        if (checked.ok) commitOperation(doc, "library_delete_cleanup", checked.state);
        const stalePlacements = db
          .prepare("SELECT id FROM broll_placements WHERE version_id = ? AND asset_id = ?")
          .all(live.versionId, asset.id) as unknown as { id: string }[];
        for (const stale of stalePlacements) {
          db.prepare("DELETE FROM broll_placements WHERE id = ?").run(stale.id);
        }
      }
    }
    if (asset.kind === "media") {
      const row = db
        .prepare("SELECT * FROM project_media WHERE id = ? AND user_id = ?")
        .get(asset.id, userId) as ProjectMediaRow | undefined;
      if (row?.storage_key) {
        // Only remove the binary when no other library row shares it
        // (library imports share binaries across rows by design).
        if (!storageKeyReferencedElsewhere(row.storage_key, "project_media", row.id)) {
          fs.rmSync(mediaPath(row.storage_key), { force: true });
          fs.rmSync(thumbnailPath(row.storage_key), { force: true });
        }
      }
      db.prepare("DELETE FROM project_media WHERE id = ?").run(asset.id);
    } else if (asset.kind === "candidate") {
      const row = db
        .prepare("SELECT * FROM candidate_clips WHERE id = ? AND user_id = ?")
        .get(asset.id, userId) as CandidateClipRow | undefined;
      // The preview binary is this candidate's storage key: an import
      // may have created a project_media row sharing it, in which case
      // the binary must survive this row's deletion.
      if (
        row?.preview_path &&
        !storageKeyReferencedElsewhere(row.preview_path, null, null)
      ) {
        fs.rmSync(mediaPath(row.preview_path), { force: true });
      }
      db.prepare("DELETE FROM candidate_clips WHERE id = ?").run(asset.id);
    } else if (asset.kind === "brand") {
      const row = db
        .prepare("SELECT * FROM brand_assets WHERE id = ? AND user_id = ?")
        .get(asset.id, userId) as BrandAssetRow | undefined;
      // A B-roll accept imports the brand binary into a project as a
      // project_media row SHARING this storage key (usage for the
      // brand ref reports no direct timeline use, so the 409 gate
      // above does not fire). Removing the binary here would silently
      // break that derived copy — only remove it when no other row
      // in project_media / source_assets / brand_assets references it.
      if (
        row?.storage_key &&
        !storageKeyReferencedElsewhere(row.storage_key, "brand_assets", row.id)
      ) {
        fs.rmSync(mediaPath(row.storage_key), { force: true });
      }
      db.prepare("DELETE FROM brand_assets WHERE id = ?").run(asset.id);
    }
    db.prepare("DELETE FROM media_asset_meta WHERE asset_ref = ? AND user_id = ?").run(ref, userId);
    return res.json({ ok: true, removedTimelineItems: usage.liveIn.length > 0 && force });
  });

  router.get("/media-library/thumbnail", requireAuth, async (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const ref = typeof req.query.assetRef === "string" ? req.query.assetRef : "";
    const asset = libraryAssetByRef(userId, ref);
    if (!asset || !asset.storageKey) return fail(res, 404, "NOT_FOUND", "Asset not found.");
    if (asset.mediaKind === "IMAGE") {
      const p = mediaPath(asset.storageKey);
      if (!fs.existsSync(p)) return fail(res, 404, "NOT_FOUND", "Image file is missing.");
      return res.sendFile(p);
    }
    if (asset.mediaKind !== "VIDEO") return fail(res, 400, "NO_THUMBNAIL", "Audio assets have no thumbnail.");
    const thumb = thumbnailPath(asset.storageKey);
    if (!fs.existsSync(thumb)) {
      // Generate a REAL frame thumbnail on demand (same helper the
      // Phase 3 upload pipeline uses).
      const { makeThumbnail } = await import("./media.js");
      const ok = await makeThumbnail(asset.storageKey, asset.duration);
      if (!ok || !fs.existsSync(thumb)) return fail(res, 404, "NO_THUMBNAIL", "Could not extract a thumbnail frame.");
    }
    res.type("image/jpeg");
    return res.sendFile(thumb);
  });

  // -- folders --
  router.get("/media-library/folders", requireAuth, (req: AuthedRequest, res) => {
    const rows = getDb()
      .prepare("SELECT * FROM media_library_folders WHERE user_id = ? ORDER BY name ASC")
      .all(req.user!.id) as unknown as { id: string; name: string; parent_id: string | null; created_at: string }[];
    res.json({ folders: rows.map((f) => ({ id: f.id, name: f.name, parentId: f.parent_id, createdAt: f.created_at })) });
  });

  router.post("/media-library/folders", requireAuth, (req: AuthedRequest, res) => {
    const parsed = z
      .object({ name: z.string().trim().min(1).max(80), parentId: z.string().max(128).nullable().optional() })
      .safeParse(req.body);
    if (!parsed.success) return fail(res, 400, "VALIDATION_ERROR", "Give the folder a name (1–80 characters).");
    const id = newId();
    getDb()
      .prepare("INSERT INTO media_library_folders (id, user_id, name, parent_id, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, req.user!.id, parsed.data.name, parsed.data.parentId ?? null, nowIso());
    return res.status(201).json({ folder: { id, name: parsed.data.name, parentId: parsed.data.parentId ?? null } });
  });

  router.delete("/media-library/folders/:id", requireAuth, (req: AuthedRequest, res) => {
    const db = getDb();
    const folder = db
      .prepare("SELECT * FROM media_library_folders WHERE id = ? AND user_id = ?")
      .get(req.params.id, req.user!.id);
    if (!folder) return fail(res, 404, "NOT_FOUND", "Folder not found.");
    db.prepare("UPDATE media_asset_meta SET folder_id = NULL WHERE folder_id = ? AND user_id = ?").run(req.params.id, req.user!.id);
    db.prepare("DELETE FROM media_library_folders WHERE id = ?").run(req.params.id);
    return res.json({ ok: true });
  });

  // -- B-roll recommendations --
  const ownedProjectOr404 = (req: AuthedRequest, res: Response): ProjectRow | null => {
    const project = ownedProject(req.user!.id, req.params.id);
    if (!project) fail(res, 404, "NOT_FOUND", "Project not found.");
    return project ?? null;
  };

  router.post("/projects/:id/broll/recommendations", requireAuth, (req: AuthedRequest, res) => {
    const project = ownedProjectOr404(req, res);
    if (!project) return;
    const parsed = z
      .object({ instructions: z.string().trim().max(1000).optional() })
      .safeParse(req.body ?? {});
    if (!parsed.success) return fail(res, 400, "VALIDATION_ERROR", "Invalid recommendation request.");
    const { job, deduplicated } = createJob({
      userId: req.user!.id,
      projectId: project.id,
      kind: "BROLL_RECOMMENDATIONS",
      payload: { instructions: parsed.data.instructions ?? "" },
      dedupeKey: `broll-rec:${project.id}`,
    });
    return res.status(deduplicated ? 200 : 201).json({ job: publicPhase8Job(job), deduplicated });
  });

  router.get("/projects/:id/broll/recommendations", requireAuth, (req: AuthedRequest, res) => {
    const project = ownedProjectOr404(req, res);
    if (!project) return;
    const status = typeof req.query.status === "string" ? req.query.status : "";
    const rows = getDb()
      .prepare(
        `SELECT * FROM broll_recommendations WHERE project_id = ? AND user_id = ? ${status ? "AND status = ?" : ""}
         ORDER BY created_at DESC, score DESC`,
      )
      .all(...(status ? [project.id, req.user!.id, status] : [project.id, req.user!.id])) as unknown as BrollRecommendationRow[];
    return res.json({ recommendations: rows.map((r) => publicRecommendation(req.user!.id, r)) });
  });

  const recById = (req: AuthedRequest): BrollRecommendationRow | undefined =>
    getDb()
      .prepare("SELECT * FROM broll_recommendations WHERE id = ? AND user_id = ?")
      .get(req.params.recId, req.user!.id) as BrollRecommendationRow | undefined;

  router.post("/broll-recommendations/:recId/dismiss", requireAuth, (req: AuthedRequest, res) => {
    const rec = recById(req);
    if (!rec) return fail(res, 404, "NOT_FOUND", "Recommendation not found.");
    if (rec.status !== "PENDING") {
      return fail(res, 409, "ALREADY_RESOLVED", `This recommendation is already ${rec.status.toLowerCase()}.`);
    }
    getDb()
      .prepare("UPDATE broll_recommendations SET status = 'DISMISSED', updated_at = ? WHERE id = ?")
      .run(nowIso(), rec.id);
    return res.json({ recommendation: publicRecommendation(req.user!.id, recById(req)!) });
  });

  router.post("/broll-recommendations/:recId/replace", requireAuth, (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const rec = recById(req);
    if (!rec) return fail(res, 404, "NOT_FOUND", "Recommendation not found.");
    if (rec.status !== "PENDING") {
      return fail(res, 409, "ALREADY_RESOLVED", `This recommendation is already ${rec.status.toLowerCase()}.`);
    }
    // Rebuild the spoken window from the stored passage and find the
    // next-best library asset that has not already been suggested for
    // this window — the replacement is a real alternative, never the
    // same asset re-labelled.
    const window: TranscriptWindow = {
      startSec: rec.window_start_sec,
      endSec: rec.window_end_sec,
      passage: rec.passage,
      terms: new Map(),
      topicLabel: null,
    };
    for (const t of tokenize(rec.passage)) window.terms.set(t, (window.terms.get(t) ?? 0) + 1);
    const usedRows = getDb()
      .prepare(
        "SELECT asset_ref FROM broll_recommendations WHERE project_id = ? AND user_id = ? AND window_start_sec = ?",
      )
      .all(rec.project_id, userId, rec.window_start_sec) as unknown as { asset_ref: string }[];
    const used = new Set(usedRows.map((r) => r.asset_ref));
    const project = ownedProject(userId, rec.project_id);
    const assets = listLibraryAssets(userId).filter(
      (a) => !(a.kind === "source" && project && a.projectId === project.id),
    );
    let best: ScoredAsset | null = null;
    for (const asset of assets) {
      if (asset.mediaKind !== "VIDEO" || !asset.hasVideo || used.has(asset.ref)) continue;
      const scored = scoreAsset(window, asset);
      if (!scored || scored.score < MIN_RELEVANCE) continue;
      if (!best || scored.score > best.score) best = scored;
    }
    if (!best) {
      return fail(
        res, 409, "NO_ALTERNATIVE",
        "No other library asset genuinely matches this moment. Upload more B-roll footage or dismiss the suggestion.",
      );
    }
    const db = getDb();
    const now = nowIso();
    db.prepare("UPDATE broll_recommendations SET status = 'REPLACED', updated_at = ? WHERE id = ?").run(now, rec.id);
    const replacement: BrollRecommendationRow = {
      ...rec,
      id: newId(),
      asset_ref: best.asset.ref,
      asset_kind: best.asset.kind,
      asset_id: best.asset.id,
      score: Math.round(best.score * 1000) / 1000,
      matched_terms_json: JSON.stringify(best.matchedTerms),
      reason:
        `Alternative for the same moment: the speaker mentions ${best.matchedTerms.slice(0, 5).join(", ")}, ` +
        `and ${best.asset.filename} matches those terms (${best.asset.category}, from your media library).`,
      suggested_duration_sec: round3(
        Math.max(1, Math.min(rec.window_end_sec - rec.window_start_sec, best.asset.duration ?? 6, 8)),
      ),
      license_json: best.asset.licenseName
        ? JSON.stringify({ licenseName: best.asset.licenseName, attribution: best.asset.attributionText })
        : null,
      status: "PENDING",
      placement_id: null,
      created_at: now,
      updated_at: now,
    };
    db.prepare(
      `INSERT INTO broll_recommendations (id, job_id, user_id, project_id, transcript_id, window_start_sec, window_end_sec, passage, asset_ref, asset_kind, asset_id, score, matched_terms_json, reason, suggested_start_sec, suggested_duration_sec, source, license_json, status, placement_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'LIBRARY', ?, 'PENDING', NULL, ?, ?)`,
    ).run(
      replacement.id, replacement.job_id, replacement.user_id, replacement.project_id, replacement.transcript_id,
      replacement.window_start_sec, replacement.window_end_sec, replacement.passage, replacement.asset_ref,
      replacement.asset_kind, replacement.asset_id, replacement.score, replacement.matched_terms_json,
      replacement.reason, replacement.suggested_start_sec, replacement.suggested_duration_sec,
      replacement.license_json, now, now,
    );
    return res.status(201).json({ recommendation: publicRecommendation(userId, replacement) });
  });

  const acceptSchema = z.object({
    startSec: z.number().min(0).max(86400).optional(),
    durationSec: z.number().min(0.5).max(3600).optional(),
    displayMode: z.enum(DISPLAY_MODES).optional(),
    keepOriginalAudio: z.boolean().optional(),
  });

  router.post("/broll-recommendations/:recId/accept", requireAuth, (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const rec = recById(req);
    if (!rec) return fail(res, 404, "NOT_FOUND", "Recommendation not found.");
    if (rec.status !== "PENDING") {
      return fail(res, 409, "ALREADY_RESOLVED", `This recommendation is already ${rec.status.toLowerCase()}.`);
    }
    const parsed = acceptSchema.safeParse(req.body ?? {});
    if (!parsed.success) return fail(res, 400, "VALIDATION_ERROR", "Invalid placement values.");
    const project = ownedProject(userId, rec.project_id);
    if (!project) return fail(res, 404, "NOT_FOUND", "Project not found.");
    const asset = libraryAssetByRef(userId, rec.asset_ref);
    if (!asset || asset.mediaKind !== "VIDEO") {
      return fail(res, 409, "ASSET_UNAVAILABLE", "The suggested asset is no longer available in your library.");
    }
    const { doc } = getOrCreateDoc(userId, project, null);
    const state = readState(doc);
    const brollTrack = state.tracks.find((t) => t.kind === "broll");
    if (!brollTrack) return fail(res, 409, "NO_BROLL_TRACK", "This document has no B-roll track.");
    // Placement start: explicit value wins; otherwise map the spoken
    // (source-time) moment onto the timeline through the main track.
    let start = parsed.data.startSec;
    let mappedFromSourceTime = false;
    if (start === undefined) {
      const mapped = sourceToTimeline(state, rec.suggested_start_sec);
      if (mapped !== null) {
        start = mapped;
        mappedFromSourceTime = true;
      } else {
        start = Math.min(rec.suggested_start_sec, timelineDurationOf(state));
      }
    }
    const duration = round3(parsed.data.durationSec ?? rec.suggested_duration_sec);
    const displayMode = (parsed.data.displayMode ?? "FULLSCREEN") as DisplayMode;
    const keepOriginalAudio = parsed.data.keepOriginalAudio ?? true;

    let mediaId: string;
    try {
      mediaId = importAssetIntoProject(userId, project.id, asset).mediaId;
    } catch (err) {
      return fail(res, 409, "ASSET_UNAVAILABLE", err instanceof Error ? err.message : "Asset unavailable.");
    }
    const fade = Math.min(0.3, duration / 3);
    const item: ItemState = {
      id: newId(),
      trackId: brollTrack.id,
      assetKind: "media",
      assetId: mediaId,
      start: round3(start),
      duration,
      sourceIn: 0,
      sourceOut: duration,
      transform: transformForMode(displayMode),
      speed: 1,
      // Keeping the original speech means the B-roll's own audio
      // starts muted; the speaker track is never touched either way.
      volume: keepOriginalAudio ? 0 : 1,
      fadeIn: round3(fade),
      fadeOut: round3(fade),
      layerOrder:
        Math.max(0, ...state.items.filter((i) => i.trackId === brollTrack.id).map((i) => i.layerOrder)) + 1,
    };
    const next: EditorState = { ...state, items: [...state.items, item] };
    const checked = validateState(userId, project.id, next);
    if (!checked.ok) return fail(res, 400, "VALIDATION_ERROR", checked.error);
    const updatedDoc = commitOperation(doc, "broll_placement_add", checked.state);
    const placementId = newId();
    const now = nowIso();
    getDb()
      .prepare(
        `INSERT INTO broll_placements (id, user_id, project_id, version_id, recommendation_id, item_id, asset_kind, asset_id, start_sec, duration_sec, source_in_sec, source_out_sec, display_mode, keep_original_audio, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'media', ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
      )
      .run(
        placementId, userId, project.id, updatedDoc.id, rec.id, item.id, mediaId,
        item.start, item.duration, item.sourceOut, displayMode, keepOriginalAudio ? 1 : 0, now, now,
      );
    getDb()
      .prepare("UPDATE broll_recommendations SET status = 'ACCEPTED', placement_id = ?, updated_at = ? WHERE id = ?")
      .run(placementId, now, rec.id);
    recordUsage(userId, project.id, rec.asset_ref, "PLACED_ON_TIMELINE", { placementId, itemId: item.id });
    const placement = getDb()
      .prepare("SELECT * FROM broll_placements WHERE id = ?")
      .get(placementId) as unknown as BrollPlacementRow;
    return res.status(201).json({
      placement: publicPlacement(placement),
      documentId: updatedDoc.id,
      mappedFromSourceTime,
    });
  });

  // -- placements --
  router.get("/projects/:id/broll/placements", requireAuth, (req: AuthedRequest, res) => {
    const project = ownedProjectOr404(req, res);
    if (!project) return;
    const rows = getDb()
      .prepare("SELECT * FROM broll_placements WHERE project_id = ? AND user_id = ? ORDER BY start_sec ASC")
      .all(project.id, req.user!.id) as unknown as BrollPlacementRow[];
    return res.json({ placements: rows.map(publicPlacement) });
  });

  const placementById = (req: AuthedRequest): BrollPlacementRow | undefined =>
    getDb()
      .prepare("SELECT * FROM broll_placements WHERE id = ? AND user_id = ?")
      .get(req.params.placementId, req.user!.id) as BrollPlacementRow | undefined;

  const placementPatchSchema = z.object({
    startSec: z.number().min(0).max(86400).optional(),
    durationSec: z.number().min(0.5).max(3600).optional(),
    sourceInSec: z.number().min(0).max(86400).optional(),
    displayMode: z.enum(DISPLAY_MODES).optional(),
    keepOriginalAudio: z.boolean().optional(),
  });

  router.patch("/broll-placements/:placementId", requireAuth, (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const placement = placementById(req);
    if (!placement) return fail(res, 404, "NOT_FOUND", "Placement not found.");
    const parsed = placementPatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) return fail(res, 400, "VALIDATION_ERROR", "Invalid placement values.");
    const doc = docById(userId, placement.version_id);
    if (!doc) return fail(res, 404, "NOT_FOUND", "Editor document not found.");
    const state = readState(doc);
    const item = state.items.find((i) => i.id === placement.item_id);
    if (!item) return fail(res, 409, "ITEM_MISSING", "The timeline item for this placement no longer exists.");
    const duration = round3(parsed.data.durationSec ?? placement.duration_sec);
    const sourceIn = round3(parsed.data.sourceInSec ?? placement.source_in_sec);
    const nextItem: ItemState = {
      ...item,
      start: round3(parsed.data.startSec ?? placement.start_sec),
      duration,
      sourceIn,
      sourceOut: round3(sourceIn + duration * item.speed),
      transform:
        parsed.data.displayMode !== undefined
          ? { ...transformForMode(parsed.data.displayMode), opacity: item.transform.opacity }
          : item.transform,
      volume:
        parsed.data.keepOriginalAudio !== undefined
          ? parsed.data.keepOriginalAudio
            ? 0
            : 1
          : item.volume,
      fadeIn: Math.min(item.fadeIn, duration / 3),
      fadeOut: Math.min(item.fadeOut, duration / 3),
    };
    const next: EditorState = {
      ...state,
      items: state.items.map((i) => (i.id === item.id ? nextItem : i)),
    };
    const checked = validateState(userId, doc.project_id, next);
    if (!checked.ok) return fail(res, 400, "VALIDATION_ERROR", checked.error);
    commitOperation(doc, "broll_placement_edit", checked.state);
    getDb()
      .prepare(
        `UPDATE broll_placements SET start_sec = ?, duration_sec = ?, source_in_sec = ?, source_out_sec = ?, display_mode = ?, keep_original_audio = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        nextItem.start, nextItem.duration, nextItem.sourceIn, nextItem.sourceOut,
        parsed.data.displayMode ?? placement.display_mode,
        parsed.data.keepOriginalAudio !== undefined
          ? parsed.data.keepOriginalAudio
            ? 1
            : 0
          : placement.keep_original_audio,
        nowIso(), placement.id,
      );
    return res.json({ placement: publicPlacement(placementById(req)!) });
  });

  router.delete("/broll-placements/:placementId", requireAuth, (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const placement = placementById(req);
    if (!placement) return fail(res, 404, "NOT_FOUND", "Placement not found.");
    const doc = docById(userId, placement.version_id);
    if (doc) {
      const state = readState(doc);
      const next: EditorState = {
        ...state,
        items: state.items.filter((i) => i.id !== placement.item_id),
      };
      const checked = validateState(userId, doc.project_id, next);
      if (checked.ok) commitOperation(doc, "broll_placement_remove", checked.state);
    }
    getDb().prepare("DELETE FROM broll_placements WHERE id = ?").run(placement.id);
    if (placement.recommendation_id) {
      getDb()
        .prepare(
          "UPDATE broll_recommendations SET status = 'PENDING', placement_id = NULL, updated_at = ? WHERE id = ? AND status = 'ACCEPTED'",
        )
        .run(nowIso(), placement.recommendation_id);
    }
    return res.json({ ok: true });
  });

  // -- library search / provider search --
  router.post("/projects/:id/broll/search", requireAuth, async (req: AuthedRequest, res) => {
    const project = ownedProjectOr404(req, res);
    if (!project) return;
    const parsed = z
      .object({
        query: z.string().trim().min(1).max(200),
        source: z.enum(["library", "provider"]).optional().default("library"),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return fail(res, 400, "VALIDATION_ERROR", "Enter a search query.");
    if (parsed.data.source === "provider") {
      if (!stockProvider.configured) {
        // Honest configuration failure — providers are never scraped.
        return fail(res, 422, "CONFIGURATION_ERROR", stockProvider.detail);
      }
      try {
        const hits = await stockProvider.search(parsed.data.query);
        return res.json({ results: hits, provider: stockProvider.id });
      } catch (err) {
        if (err instanceof ConfigurationError) {
          return fail(res, 422, "CONFIGURATION_ERROR", err.message);
        }
        const message = err instanceof Error ? err.message : "The stock provider request failed.";
        return fail(res, 502, "PROVIDER_ERROR", message);
      }
    }
    const terms = new Set(tokenize(parsed.data.query));
    const results = listLibraryAssets(req.user!.id)
      .filter((a) => a.mediaKind === "VIDEO")
      .map((asset) => {
        const hay = new Set(tokenize(asset.searchable));
        const matched = [...terms].filter((t) => hay.has(t));
        return { asset, matched, score: terms.size ? matched.length / terms.size : 0 };
      })
      .filter((r) => r.matched.length > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map((r) => ({ ...publicLibraryAsset(r.asset), matchedTerms: r.matched, score: Math.round(r.score * 1000) / 1000 }));
    return res.json({ results });
  });

  // -- provider operations: import / generate / background removal --
  router.post("/projects/:id/broll/import", requireAuth, (req: AuthedRequest, res) => {
    const project = ownedProjectOr404(req, res);
    if (!project) return;
    const parsed = z
      .object({ provider: z.string().trim().max(60).optional(), providerAssetId: z.string().trim().min(1).max(200) })
      .safeParse(req.body ?? {});
    if (!parsed.success) return fail(res, 400, "VALIDATION_ERROR", "A provider asset id is required.");
    const requestedProvider = parsed.data.provider ?? stockProvider.id;
    if (!stockProvider.configured || requestedProvider !== stockProvider.id) {
      // Unconfigured (or a provider other than the configured one):
      // the exact honest failure this route has always produced — a
      // persisted FAILED job row plus the 422 CONFIGURATION_ERROR.
      const detail = !stockProvider.configured
        ? stockProvider.detail
        : `Stock provider "${requestedProvider}" is not configured on this server — the configured stock provider is "${stockProvider.id}".`;
      const job = createFailedJob(
        {
          userId: req.user!.id,
          projectId: project.id,
          kind: "PROVIDER_IMPORT",
          payload: { provider: requestedProvider, providerAssetId: parsed.data.providerAssetId },
        },
        "CONFIGURATION_ERROR",
        detail,
      );
      return res.status(422).json({
        error: { code: "CONFIGURATION_ERROR", message: detail },
        job: publicPhase8Job(job),
      });
    }
    // Configured: queue a real import job; the Phase 8 worker
    // downloads the file into the project's media library.
    const { job, deduplicated } = createJob({
      userId: req.user!.id,
      projectId: project.id,
      kind: "PROVIDER_IMPORT",
      payload: { provider: stockProvider.id, providerAssetId: parsed.data.providerAssetId },
      dedupeKey: `stock-import:${project.id}:${parsed.data.providerAssetId}`,
    });
    return res.status(deduplicated ? 200 : 201).json({ job: publicPhase8Job(job), deduplicated });
  });

  router.post("/projects/:id/broll/generate", requireAuth, (req: AuthedRequest, res) => {
    const project = ownedProjectOr404(req, res);
    if (!project) return;
    const parsed = z
      .object({
        prompt: z.string().trim().min(3).max(1000),
        mediaKind: z.enum(["video", "image"]).optional().default("video"),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return fail(res, 400, "VALIDATION_ERROR", "Describe the B-roll to generate (3–1000 characters).");
    const job = createFailedJob(
      {
        userId: req.user!.id,
        projectId: project.id,
        kind: "AI_GENERATION",
        payload: { prompt: parsed.data.prompt, mediaKind: parsed.data.mediaKind, provider: generationProvider.id },
      },
      "CONFIGURATION_ERROR",
      generationProvider.detail,
    );
    return res.status(422).json({
      error: { code: "CONFIGURATION_ERROR", message: generationProvider.detail },
      job: publicPhase8Job(job),
    });
  });

  router.post("/projects/:id/background-jobs", requireAuth, (req: AuthedRequest, res) => {
    const project = ownedProjectOr404(req, res);
    if (!project) return;
    const parsed = z
      .object({
        assetRef: z.string().min(3).max(200),
        mode: z.enum(["remove", "blur", "solid-dark", "solid-light", "custom-image", "custom-video"]).optional().default("remove"),
        backgroundRef: z.string().max(200).nullable().optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return fail(res, 400, "VALIDATION_ERROR", "Invalid background job request.");
    const asset = libraryAssetByRef(req.user!.id, parsed.data.assetRef);
    if (!asset) return fail(res, 404, "NOT_FOUND", "Asset not found in your library.");
    const job = createFailedJob(
      {
        userId: req.user!.id,
        projectId: project.id,
        kind: "BACKGROUND_REMOVAL",
        payload: { assetRef: parsed.data.assetRef, mode: parsed.data.mode, backgroundRef: parsed.data.backgroundRef ?? null },
      },
      "CONFIGURATION_ERROR",
      backgroundProvider.detail,
    );
    return res.status(422).json({
      error: { code: "CONFIGURATION_ERROR", message: backgroundProvider.detail },
      job: publicPhase8Job(job),
    });
  });

  // -- enhancement jobs --
  const enhanceJobSchema = z.object({
    assetRef: z.string().min(3).max(200),
    video: z.unknown().optional(),
    audio: z.unknown().optional(),
    preview: z.boolean().optional().default(false),
  });

  function strictSettings<T>(
    schema: z.ZodType<T>,
    defaults: T,
    raw: unknown,
  ): T | null {
    if (raw === undefined) return { ...defaults };
    if (typeof raw !== "object" || raw === null) return null;
    const merged: Record<string, unknown> = { ...(defaults as Record<string, unknown>) };
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v && typeof v === "object" && !Array.isArray(v) && typeof merged[k] === "object" && merged[k] !== null) {
        merged[k] = { ...(merged[k] as Record<string, unknown>), ...(v as Record<string, unknown>) };
      } else {
        merged[k] = v;
      }
    }
    const parsed = schema.safeParse(merged);
    return parsed.success ? parsed.data : null;
  }

  router.post("/projects/:id/enhancement-jobs", requireAuth, (req: AuthedRequest, res) => {
    const project = ownedProjectOr404(req, res);
    if (!project) return;
    const parsed = enhanceJobSchema.safeParse(req.body ?? {});
    if (!parsed.success) return fail(res, 400, "VALIDATION_ERROR", "Invalid enhancement job request.");
    const asset = libraryAssetByRef(req.user!.id, parsed.data.assetRef);
    if (!asset) return fail(res, 404, "NOT_FOUND", "Asset not found in your library.");
    const video = strictSettings(videoEnhanceSchema, DEFAULT_VIDEO_ENHANCE, parsed.data.video);
    const audio = strictSettings(audioEnhanceSchema, DEFAULT_AUDIO_ENHANCE, parsed.data.audio);
    if (!video || !audio) {
      return fail(res, 400, "VALIDATION_ERROR", "Enhancement settings are out of range.");
    }
    const kind = parsed.data.preview ? "ENHANCEMENT_PREVIEW" : "ENHANCEMENT";
    const dedupeKey = crypto
      .createHash("sha256")
      .update(JSON.stringify({ kind, assetRef: parsed.data.assetRef, video, audio }))
      .digest("hex");
    const { job, deduplicated } = createJob({
      userId: req.user!.id,
      projectId: project.id,
      kind,
      payload: { assetRef: parsed.data.assetRef, video, audio },
      dedupeKey: `enh:${dedupeKey}`,
    });
    return res.status(deduplicated ? 200 : 201).json({ job: publicPhase8Job(job), deduplicated });
  });

  // -- phase8 job management --
  router.get("/projects/:id/phase8-jobs", requireAuth, (req: AuthedRequest, res) => {
    const project = ownedProjectOr404(req, res);
    if (!project) return;
    const rows = getDb()
      .prepare("SELECT * FROM phase8_jobs WHERE project_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 50")
      .all(project.id, req.user!.id) as unknown as Phase8JobRow[];
    return res.json({ jobs: rows.map(publicPhase8Job) });
  });

  const ownedJob = (req: AuthedRequest): Phase8JobRow | undefined =>
    getDb()
      .prepare("SELECT * FROM phase8_jobs WHERE id = ? AND user_id = ?")
      .get(req.params.jobId, req.user!.id) as Phase8JobRow | undefined;

  router.get("/phase8-jobs/:jobId", requireAuth, (req: AuthedRequest, res) => {
    const job = ownedJob(req);
    if (!job) return fail(res, 404, "NOT_FOUND", "Job not found.");
    return res.json({ job: publicPhase8Job(job) });
  });

  router.post("/phase8-jobs/:jobId/cancel", requireAuth, (req: AuthedRequest, res) => {
    const job = ownedJob(req);
    if (!job) return fail(res, 404, "NOT_FOUND", "Job not found.");
    if (!["QUEUED", "RUNNING"].includes(job.status)) {
      return fail(res, 409, "NOT_ACTIVE", `This job is already ${job.status.toLowerCase()} and cannot be cancelled.`);
    }
    if (job.status === "QUEUED") {
      getDb()
        .prepare(
          "UPDATE phase8_jobs SET status = 'CANCELLED', stage = 'CANCELLED', cancel_requested = 1, finished_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(nowIso(), nowIso(), job.id);
    } else {
      getDb()
        .prepare("UPDATE phase8_jobs SET cancel_requested = 1, updated_at = ? WHERE id = ?")
        .run(nowIso(), job.id);
      killJobChildren(job.id);
    }
    return res.json({ job: publicPhase8Job(ownedJob(req)!) });
  });

  router.post("/phase8-jobs/:jobId/retry", requireAuth, (req: AuthedRequest, res) => {
    const job = ownedJob(req);
    if (!job) return fail(res, 404, "NOT_FOUND", "Job not found.");
    if (!["FAILED", "CANCELLED"].includes(job.status)) {
      return fail(res, 409, "NOT_TERMINAL", "Only failed or cancelled jobs can be retried.");
    }
    // A PROVIDER_IMPORT job is retryable for real when the stock
    // provider is configured NOW (it falls through to the requeue
    // below); every other provider-kind job — and an import whose
    // provider is still unconfigured — fails honestly again. A
    // URL_IMPORT job follows the same rule against yt-dlp
    // availability (the URL-import module owns that check).
    const importRetryable =
      (job.kind === "PROVIDER_IMPORT" && stockProvider.configured) ||
      (job.kind === "URL_IMPORT" && urlImportAvailability().enabled);
    if (
      ["BACKGROUND_REMOVAL", "PROVIDER_IMPORT", "AI_GENERATION", "URL_IMPORT"].includes(job.kind) &&
      !importRetryable
    ) {
      // Retrying an unconfigured-provider job fails honestly again —
      // with a fresh row state so the attempt is visible. The error
      // persisted on the row and the error returned to the caller are
      // the SAME provider detail the status endpoint reports, so the
      // surfaces can never disagree about why it cannot run.
      const detail =
        job.kind === "BACKGROUND_REMOVAL"
          ? backgroundProvider.detail
          : job.kind === "PROVIDER_IMPORT"
            ? stockProvider.detail
            : job.kind === "URL_IMPORT"
              ? urlImportAvailability().detail
              : generationProvider.detail;
      getDb()
        .prepare(
          "UPDATE phase8_jobs SET status = 'FAILED', stage = 'VALIDATING', error = ?, error_code = 'CONFIGURATION_ERROR', finished_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(detail, nowIso(), nowIso(), job.id);
      return res.status(422).json({
        error: { code: "CONFIGURATION_ERROR", message: detail },
        job: publicPhase8Job(ownedJob(req)!),
      });
    }
    if (job.dedupe_key) {
      const active = getDb()
        .prepare(
          "SELECT * FROM phase8_jobs WHERE user_id = ? AND dedupe_key = ? AND status IN ('QUEUED', 'RUNNING') AND id != ? LIMIT 1",
        )
        .get(job.user_id, job.dedupe_key, job.id) as Phase8JobRow | undefined;
      if (active) return res.status(200).json({ job: publicPhase8Job(active), deduplicated: true });
    }
    getDb()
      .prepare(
        `UPDATE phase8_jobs SET status = 'QUEUED', stage = 'QUEUED', error = NULL, error_code = NULL,
         cancel_requested = 0, started_at = NULL, finished_at = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(nowIso(), job.id);
    return res.json({ job: publicPhase8Job(ownedJob(req)!), deduplicated: false });
  });

  router.get("/phase8-jobs/:jobId/preview/:which", requireAuth, (req: AuthedRequest, res) => {
    const job = ownedJob(req);
    if (!job || job.status !== "COMPLETED") return fail(res, 404, "NOT_FOUND", "Preview not available.");
    const which = req.params.which;
    if (which !== "before" && which !== "after") return fail(res, 404, "NOT_FOUND", "Preview not available.");
    const file = path.join(config.mediaDir, job.user_id, "phase8-previews", `${job.id}-${which}.mp4`);
    if (!fs.existsSync(file)) return fail(res, 404, "NOT_FOUND", "Preview file is missing.");
    res.type("video/mp4");
    return res.sendFile(file);
  });

  // -- document enhancement configuration + enhanced render --
  const configByDoc = (userId: string, docId: string): EnhancementConfigRow | undefined =>
    getDb()
      .prepare("SELECT * FROM enhancement_configs WHERE version_id = ? AND user_id = ?")
      .get(docId, userId) as EnhancementConfigRow | undefined;

  router.get("/editor/:docId/enhancement", requireAuth, (req: AuthedRequest, res) => {
    const doc = docById(req.user!.id, req.params.docId);
    if (!doc) return fail(res, 404, "NOT_FOUND", "Editor document not found.");
    return res.json({
      config: publicEnhancementConfig(configByDoc(req.user!.id, doc.id) ?? null, doc.id, doc.project_id),
      providers: phase8ProviderStatus(),
    });
  });

  const configPutSchema = z.object({
    videoEnabled: z.boolean(),
    audioEnabled: z.boolean(),
    video: z.unknown(),
    audio: z.unknown(),
    scope: z.enum(["project", "items"]).optional().default("project"),
    itemIds: z.array(z.string().max(128)).max(300).optional().default([]),
  });

  router.put("/editor/:docId/enhancement", requireAuth, (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const doc = docById(userId, req.params.docId);
    if (!doc) return fail(res, 404, "NOT_FOUND", "Editor document not found.");
    const parsed = configPutSchema.safeParse(req.body ?? {});
    if (!parsed.success) return fail(res, 400, "VALIDATION_ERROR", "Invalid enhancement configuration.");
    const video = strictSettings(videoEnhanceSchema, DEFAULT_VIDEO_ENHANCE, parsed.data.video);
    const audio = strictSettings(audioEnhanceSchema, DEFAULT_AUDIO_ENHANCE, parsed.data.audio);
    if (!video || !audio) return fail(res, 400, "VALIDATION_ERROR", "Enhancement settings are out of range.");
    // Item scope must reference this document's own items.
    const state = readState(doc);
    const itemIdSet = new Set(state.items.map((i) => i.id));
    const itemIds = parsed.data.itemIds.filter((id) => itemIdSet.has(id));
    const existing = configByDoc(userId, doc.id);
    const now = nowIso();
    if (existing) {
      getDb()
        .prepare(
          `UPDATE enhancement_configs SET video_enabled = ?, audio_enabled = ?, video_json = ?, audio_json = ?, scope = ?, item_ids_json = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          parsed.data.videoEnabled ? 1 : 0, parsed.data.audioEnabled ? 1 : 0,
          JSON.stringify(video), JSON.stringify(audio), parsed.data.scope,
          JSON.stringify(itemIds), now, existing.id,
        );
    } else {
      getDb()
        .prepare(
          `INSERT INTO enhancement_configs (id, version_id, user_id, project_id, video_enabled, audio_enabled, video_json, audio_json, scope, item_ids_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          newId(), doc.id, userId, doc.project_id,
          parsed.data.videoEnabled ? 1 : 0, parsed.data.audioEnabled ? 1 : 0,
          JSON.stringify(video), JSON.stringify(audio), parsed.data.scope,
          JSON.stringify(itemIds), now, now,
        );
    }
    return res.json({ config: publicEnhancementConfig(configByDoc(userId, doc.id) ?? null, doc.id, doc.project_id) });
  });

  router.post("/editor/:docId/render-enhanced", requireAuth, (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const doc = docById(userId, req.params.docId);
    if (!doc) return fail(res, 404, "NOT_FOUND", "Editor document not found.");
    const configRow = configByDoc(userId, doc.id);
    if (!configRow || (configRow.video_enabled !== 1 && configRow.audio_enabled !== 1)) {
      return fail(
        res, 400, "ENHANCEMENT_DISABLED",
        "Enhancement is switched off for this document. Enable video or audio enhancement and save the configuration first.",
      );
    }
    const cfg = publicEnhancementConfig(configRow, doc.id, doc.project_id);
    const state = readState(doc);
    const timelineDuration = timelineDurationOf(state);
    if (timelineDuration <= 0) {
      return fail(res, 400, "EMPTY_TIMELINE", "Add a clip to the main track before rendering.");
    }
    const enhance = {
      video: cfg.videoEnabled ? cfg.video : { ...DEFAULT_VIDEO_ENHANCE },
      audio: cfg.audioEnabled ? cfg.audio : { ...DEFAULT_AUDIO_ENHANCE },
      scope: cfg.scope,
      itemIds: cfg.scope === "items" ? cfg.itemIds : [],
    };
    const stateJson = JSON.stringify(state);
    const stateHash = crypto
      .createHash("sha256")
      .update(stateJson + JSON.stringify(enhance))
      .digest("hex");
    const db = getDb();
    const active = db
      .prepare("SELECT * FROM render_jobs WHERE version_id = ? AND status IN ('QUEUED', 'RUNNING') ORDER BY created_at DESC LIMIT 10")
      .all(doc.id) as unknown as RenderJobRow[];
    for (const j of active) {
      const s = parseJson<{ stateHash?: string }>(j.settings_json, {});
      if (s.stateHash === stateHash) {
        return res.status(200).json({ job: publicRenderJob(j), deduplicated: true });
      }
    }
    const now = nowIso();
    const jobId = newId();
    const settingsJson = JSON.stringify({ state, timelineDuration, stateHash, enhance });
    db.prepare(
      `INSERT INTO render_jobs (id, version_id, project_id, user_id, status, stage, settings_json, output_path, error, cancel_requested, created_at, updated_at, started_at, finished_at)
       VALUES (?, ?, ?, ?, 'QUEUED', 'QUEUED', ?, NULL, NULL, 0, ?, ?, NULL, NULL)`,
    ).run(jobId, doc.id, doc.project_id, userId, settingsJson, now, now);
    const row = db.prepare("SELECT * FROM render_jobs WHERE id = ?").get(jobId) as unknown as RenderJobRow;
    return res.status(201).json({ job: publicRenderJob(row), deduplicated: false });
  });

  // -- effect presets (spec §12) --
  const publicCustomPreset = (row: EffectPresetRow) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    builtin: false as const,
    settings: parseJson<Record<string, unknown>>(row.settings_json, {}),
    basedOn: row.based_on,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

  router.get("/phase8/presets", requireAuth, (req: AuthedRequest, res) => {
    const customs = getDb()
      .prepare("SELECT * FROM effect_presets WHERE user_id = ? ORDER BY created_at DESC")
      .all(req.user!.id) as unknown as EffectPresetRow[];
    return res.json({
      presets: [
        ...BUILTIN_PRESETS.map((p) => ({
          id: p.id,
          name: p.name,
          kind: p.kind,
          builtin: true as const,
          settings: p.settings,
          requiresBackgroundProvider: p.requiresBackgroundProvider ?? false,
          note: p.note ?? null,
        })),
        ...customs.map(publicCustomPreset),
      ],
      backgroundProviderConfigured: backgroundProvider.configured,
    });
  });

  const presetCreateSchema = z.object({
    name: z.string().trim().min(1).max(80),
    kind: z.enum(["video", "audio", "background", "effect"]),
    settings: z.unknown(),
    basedOn: z.string().max(128).nullable().optional(),
  });

  function validatePresetSettings(
    kind: string,
    settings: unknown,
  ): Record<string, unknown> | null {
    if (kind === "video" || kind === "effect") {
      const v = strictSettings(videoEnhanceSchema, DEFAULT_VIDEO_ENHANCE, settings);
      return v ? (v as unknown as Record<string, unknown>) : null;
    }
    if (kind === "audio") {
      const a = strictSettings(audioEnhanceSchema, DEFAULT_AUDIO_ENHANCE, settings);
      return a ? (a as unknown as Record<string, unknown>) : null;
    }
    const parsed = z.object({ mode: z.string().trim().min(1).max(40) }).safeParse(settings);
    return parsed.success ? { mode: parsed.data.mode } : null;
  }

  router.post("/phase8/presets", requireAuth, (req: AuthedRequest, res) => {
    const parsed = presetCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return fail(res, 400, "VALIDATION_ERROR", "Give the preset a name and a kind.");
    const settings = validatePresetSettings(parsed.data.kind, parsed.data.settings);
    if (!settings) return fail(res, 400, "VALIDATION_ERROR", "Preset settings are invalid for that kind.");
    const now = nowIso();
    const row: EffectPresetRow = {
      id: newId(),
      user_id: req.user!.id,
      name: parsed.data.name,
      kind: parsed.data.kind,
      settings_json: JSON.stringify(settings),
      based_on: parsed.data.basedOn ?? null,
      created_at: now,
      updated_at: now,
    };
    getDb()
      .prepare(
        "INSERT INTO effect_presets (id, user_id, name, kind, settings_json, based_on, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(row.id, row.user_id, row.name, row.kind, row.settings_json, row.based_on, now, now);
    return res.status(201).json({ preset: publicCustomPreset(row) });
  });

  const customPresetById = (req: AuthedRequest): EffectPresetRow | undefined =>
    getDb()
      .prepare("SELECT * FROM effect_presets WHERE id = ? AND user_id = ?")
      .get(req.params.presetId, req.user!.id) as EffectPresetRow | undefined;

  router.put("/phase8/presets/:presetId", requireAuth, (req: AuthedRequest, res) => {
    if (req.params.presetId.startsWith("builtin:")) {
      return fail(res, 400, "BUILTIN_PRESET", "Built-in presets can't be edited. Duplicate one to make it yours.");
    }
    const row = customPresetById(req);
    if (!row) return fail(res, 404, "NOT_FOUND", "Preset not found.");
    const parsed = presetCreateSchema.partial().safeParse(req.body ?? {});
    if (!parsed.success) return fail(res, 400, "VALIDATION_ERROR", "Invalid preset update.");
    const kind = parsed.data.kind ?? row.kind;
    let settingsJson = row.settings_json;
    if (parsed.data.settings !== undefined) {
      const settings = validatePresetSettings(kind, parsed.data.settings);
      if (!settings) return fail(res, 400, "VALIDATION_ERROR", "Preset settings are invalid for that kind.");
      settingsJson = JSON.stringify(settings);
    }
    getDb()
      .prepare("UPDATE effect_presets SET name = ?, kind = ?, settings_json = ?, based_on = ?, updated_at = ? WHERE id = ?")
      .run(parsed.data.name ?? row.name, kind, settingsJson, parsed.data.basedOn ?? row.based_on, nowIso(), row.id);
    return res.json({ preset: publicCustomPreset(customPresetById(req)!) });
  });

  router.delete("/phase8/presets/:presetId", requireAuth, (req: AuthedRequest, res) => {
    if (req.params.presetId.startsWith("builtin:")) {
      return fail(res, 400, "BUILTIN_PRESET", "Built-in presets can't be deleted.");
    }
    const row = customPresetById(req);
    if (!row) return fail(res, 404, "NOT_FOUND", "Preset not found.");
    getDb().prepare("DELETE FROM effect_presets WHERE id = ?").run(row.id);
    return res.json({ ok: true });
  });

  router.post("/phase8/presets/:presetId/duplicate", requireAuth, (req: AuthedRequest, res) => {
    const parsed = z.object({ name: z.string().trim().min(1).max(80).optional() }).safeParse(req.body ?? {});
    if (!parsed.success) return fail(res, 400, "VALIDATION_ERROR", "Invalid name.");
    let source: { name: string; kind: string; settings: unknown } | null = null;
    if (req.params.presetId.startsWith("builtin:")) {
      const builtin = BUILTIN_PRESETS.find((p) => p.id === req.params.presetId);
      if (builtin) source = { name: builtin.name, kind: builtin.kind, settings: builtin.settings };
    } else {
      const row = customPresetById(req);
      if (row) source = { name: row.name, kind: row.kind, settings: parseJson(row.settings_json, {}) };
    }
    if (!source) return fail(res, 404, "NOT_FOUND", "Preset not found.");
    const now = nowIso();
    const row: EffectPresetRow = {
      id: newId(),
      user_id: req.user!.id,
      name: parsed.data.name ?? `${source.name} (copy)`,
      kind: source.kind as EffectPresetRow["kind"],
      settings_json: JSON.stringify(source.settings),
      based_on: req.params.presetId,
      created_at: now,
      updated_at: now,
    };
    getDb()
      .prepare(
        "INSERT INTO effect_presets (id, user_id, name, kind, settings_json, based_on, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(row.id, row.user_id, row.name, row.kind, row.settings_json, row.based_on, now, now);
    return res.status(201).json({ preset: publicCustomPreset(row) });
  });

  app.use("/api", router);
}
