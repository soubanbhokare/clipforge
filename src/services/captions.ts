// Typed client for the Phase 6 Captions Studio & Brand Kit API
// (server: src/captions.ts — /api/captions/fonts, /api/caption-
// templates, /api/editor/:docId/caption-studio + captions/*,
// /api/brand-kits, /api/brand-assets).
//
// The style model mirrors the server's captionStyle.ts exactly: the
// same object drives the editor preview (CSS), the ASS burn-in
// render (libass) and template/brand-kit storage, so what the user
// sees is what renders. The one preview-only control is lineSpacing —
// libass has no line-height setting; the UI labels it as such.

import { API_BASE_URL } from "./api";
import { apiRequest, AuthApiError, fetchCsrfToken } from "./auth";
import type { EditorDocument } from "./editor";

export type CaptionAnimation =
  | "none"
  | "fade"
  | "pop"
  | "slide-up"
  | "word-reveal"
  | "highlight"
  | "karaoke"
  | "keyword-emphasis"
  | "minimal";

export type CaptionPosition =
  | "top"
  | "upper-middle"
  | "center"
  | "lower-middle"
  | "bottom"
  | "custom";

export interface CaptionStyleConfig {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  italic: boolean;
  textColor: string;
  highlightColor: string;
  backgroundColor: string;
  backgroundOpacity: number;
  outlineColor: string;
  outlineWidth: number;
  shadowDepth: number;
  letterSpacing: number;
  lineSpacing: number;
  alignment: "left" | "center" | "right";
  casing: "none" | "upper" | "lower" | "title";
  maxWordsPerLine: number;
  maxLines: number;
  position: CaptionPosition;
  positionX: number;
  positionY: number;
  marginH: number;
  marginV: number;
  animation: CaptionAnimation;
}

export const DEFAULT_CAPTION_STYLE: CaptionStyleConfig = {
  fontFamily: "Noto Sans",
  fontSize: 52,
  fontWeight: 500,
  italic: false,
  textColor: "#FFFFFF",
  highlightColor: "#D4FF24",
  backgroundColor: "#030407",
  backgroundOpacity: 0.55,
  outlineColor: "#030407",
  outlineWidth: 0,
  shadowDepth: 1,
  letterSpacing: 0,
  lineSpacing: 1.25,
  alignment: "center",
  casing: "none",
  maxWordsPerLine: 7,
  maxLines: 2,
  position: "bottom",
  positionX: 0.5,
  positionY: 0.9,
  marginH: 64,
  marginV: 72,
  animation: "minimal",
};

export interface CaptionTemplate {
  id: string;
  name: string;
  builtin: boolean;
  basedOn: string | null;
  style: CaptionStyleConfig;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface CaptionTrack {
  id: string;
  documentId: string;
  projectId: string;
  language: string;
  kind: "original" | "translation" | "manual";
  label: string;
  isActive: boolean;
  segmentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CaptionStudioState {
  documentId: string;
  projectId: string;
  captionsEnabled: boolean;
  style: CaptionStyleConfig;
  templateId: string | null;
  brandKitId: string | null;
  activeTrack: CaptionTrack;
  tracks: CaptionTrack[];
  hasWordTimestamps: boolean;
  hasTranscript: boolean;
  captionCount: number;
  translationConfigured: boolean;
  translationProvider: string | null;
}

export interface TranslationJob {
  id: string;
  documentId: string;
  projectId: string;
  sourceLanguage: string;
  targetLanguage: string;
  provider: string;
  status: string;
  error: string | null;
  errorCode: string | null;
  resultTrackId: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export type BrandAssetKind = "LOGO" | "INTRO" | "OUTRO" | "MUSIC" | "OVERLAY" | "OTHER";

export interface BrandAsset {
  id: string;
  kind: BrandAssetKind;
  filename: string;
  fileSize: number | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean | null;
  hasVideo: boolean | null;
  container: string | null;
  streamUrl: string;
  createdAt: string;
}

export interface BrandKit {
  id: string;
  name: string;
  brandName: string;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  fontFamily: string | null;
  captionTemplateId: string | null;
  captionStyle: CaptionStyleConfig | null;
  logoAssetId: string | null;
  introAssetId: string | null;
  outroAssetId: string | null;
  musicAssetId: string | null;
  overlayAssetId: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BrandKitInput {
  name: string;
  brandName: string;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  fontFamily?: string | null;
  captionTemplateId?: string | null;
  captionStyle?: CaptionStyleConfig | null;
  logoAssetId?: string | null;
  introAssetId?: string | null;
  outroAssetId?: string | null;
  musicAssetId?: string | null;
  overlayAssetId?: string | null;
}

// ---- preview text helpers (mirror the server's ASS text shaping) -------

export function applyCasing(text: string, casing: CaptionStyleConfig["casing"]): string {
  switch (casing) {
    case "upper":
      return text.toUpperCase();
    case "lower":
      return text.toLowerCase();
    case "title":
      return text.replace(/(^|\s)(\S)/g, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
    default:
      return text;
  }
}

/** Wrap into lines of <= maxWordsPerLine, widening instead of ever
 *  truncating when maxLines would be exceeded (server-identical). */
export function wrapLines(text: string, style: CaptionStyleConfig): string[] {
  const wordsOf = (s: string) => s.split(/\s+/).filter(Boolean);
  const hardLines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const totalWords = hardLines.reduce((n, l) => n + wordsOf(l).length, 0);
  if (totalWords === 0) return [];
  let perLine = Math.max(1, style.maxWordsPerLine);
  for (;;) {
    const lines: string[] = [];
    for (const hard of hardLines) {
      const words = wordsOf(hard);
      for (let i = 0; i < words.length; i += perLine) {
        lines.push(words.slice(i, i + perLine).join(" "));
      }
    }
    if (lines.length <= style.maxLines || perLine >= totalWords) return lines;
    perLine += 1;
  }
}

export function wrapWords<T extends { word: string }>(words: T[], style: CaptionStyleConfig): T[][] {
  if (words.length === 0) return [];
  let perLine = Math.max(1, style.maxWordsPerLine);
  for (;;) {
    const lines: T[][] = [];
    for (let i = 0; i < words.length; i += perLine) lines.push(words.slice(i, i + perLine));
    if (lines.length <= style.maxLines || perLine >= words.length) return lines;
    perLine += 1;
  }
}

// ---- API -------------------------------------------------------------------

/** Build the AuthApiError for a failed upload response, parsing BOTH
 *  server error shapes exactly like request() in services/auth.ts:
 *  the { error: "…" } string form and the { error: { code, message } }
 *  object form (plus a top-level `code`), classified the same way. */
function uploadApiError(status: number, data: Record<string, unknown>): AuthApiError {
  const errObj = data.error as { code?: unknown; message?: unknown } | string | undefined;
  const message =
    typeof errObj === "string"
      ? errObj
      : errObj && typeof errObj === "object" && typeof errObj.message === "string"
        ? errObj.message
        : "Something went wrong.";
  const code =
    typeof data.code === "string"
      ? data.code
      : errObj && typeof errObj === "object" && typeof errObj.code === "string"
        ? errObj.code
        : undefined;
  if (status === 400 || status === 409 || status === 403 || status === 429) {
    return new AuthApiError("validation", status, message, code);
  }
  if (status === 401) {
    return new AuthApiError("credentials", status, message, code);
  }
  return new AuthApiError("server", status, message, code);
}

async function uploadForm<T>(url: string, form: FormData): Promise<T> {
  const csrf = await fetchCsrfToken();
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "X-CSRF-Token": csrf },
      credentials: "include",
      body: form,
    });
  } catch {
    throw new AuthApiError(
      "network",
      0,
      "Cannot reach the server. Check that the CLIPFORGE server is running, then try again.",
    );
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw uploadApiError(res.status, data);
  }
  return data as T;
}

export const captionsApi = {
  fonts(): Promise<{ fonts: string[]; defaultFont: string; devanagariFont: string | null }> {
    return apiRequest("/captions/fonts");
  },

  listTemplates(): Promise<{ templates: CaptionTemplate[] }> {
    return apiRequest("/caption-templates");
  },

  createTemplate(input: {
    name: string;
    style: CaptionStyleConfig;
    basedOn?: string | null;
  }): Promise<{ template: CaptionTemplate }> {
    return apiRequest("/caption-templates", { method: "POST", body: input });
  },

  updateTemplate(
    id: string,
    patch: { name?: string; style?: CaptionStyleConfig },
  ): Promise<{ template: CaptionTemplate }> {
    return apiRequest(`/caption-templates/${encodeURIComponent(id)}`, { method: "PATCH", body: patch });
  },

  deleteTemplate(id: string): Promise<{ ok: true }> {
    return apiRequest(`/caption-templates/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  duplicateTemplate(id: string, name?: string): Promise<{ template: CaptionTemplate }> {
    return apiRequest(`/caption-templates/${encodeURIComponent(id)}/duplicate`, {
      method: "POST",
      body: name ? { name } : {},
    });
  },

  getStudio(docId: string): Promise<{ studio: CaptionStudioState }> {
    return apiRequest(`/editor/${encodeURIComponent(docId)}/caption-studio`);
  },

  regenerate(
    docId: string,
    confirm = false,
  ): Promise<{ document: EditorDocument; studio: CaptionStudioState; generated: number }> {
    return apiRequest(`/editor/${encodeURIComponent(docId)}/captions/regenerate`, {
      method: "POST",
      body: { confirm },
    });
  },

  importSubtitles(
    docId: string,
    file: File,
    opts: { mode: "replace-active" | "new-track"; language?: string; kind?: string; label?: string },
  ): Promise<{ document?: EditorDocument; studio?: CaptionStudioState; track?: CaptionTrack; imported: number }> {
    const form = new FormData();
    form.append("file", file);
    form.append("mode", opts.mode);
    if (opts.language) form.append("language", opts.language);
    if (opts.kind) form.append("kind", opts.kind);
    if (opts.label) form.append("label", opts.label);
    return uploadForm(`${API_BASE_URL}/editor/${encodeURIComponent(docId)}/captions/import`, form);
  },

  exportUrl(docId: string, format: "srt" | "vtt", trackId?: string): string {
    const q = new URLSearchParams({ format });
    if (trackId) q.set("trackId", trackId);
    return `${API_BASE_URL}/editor/${encodeURIComponent(docId)}/captions/export?${q.toString()}`;
  },

  createManualTrack(
    docId: string,
    input: {
      language: string;
      kind: "manual" | "translation";
      label?: string;
      segments: { start: number; end: number; text: string }[];
    },
  ): Promise<{ track: CaptionTrack }> {
    return apiRequest(`/editor/${encodeURIComponent(docId)}/caption-tracks`, {
      method: "POST",
      body: input,
    });
  },

  activateTrack(
    docId: string,
    trackId: string,
  ): Promise<{ document: EditorDocument; studio: CaptionStudioState }> {
    return apiRequest(
      `/editor/${encodeURIComponent(docId)}/caption-tracks/${encodeURIComponent(trackId)}/activate`,
      { method: "POST", body: {} },
    );
  },

  listTranslationJobs(docId: string): Promise<{ jobs: TranslationJob[]; translationConfigured: boolean }> {
    return apiRequest(`/editor/${encodeURIComponent(docId)}/translation-jobs`);
  },

  createTranslationJob(
    docId: string,
    targetLanguage: string,
  ): Promise<{ job: TranslationJob; deduplicated?: boolean }> {
    return apiRequest(`/editor/${encodeURIComponent(docId)}/translation-jobs`, {
      method: "POST",
      body: { targetLanguage },
    });
  },
};

export const brandApi = {
  listKits(): Promise<{ kits: BrandKit[] }> {
    return apiRequest("/brand-kits");
  },

  createKit(input: BrandKitInput): Promise<{ kit: BrandKit }> {
    return apiRequest("/brand-kits", { method: "POST", body: input });
  },

  updateKit(id: string, patch: Partial<BrandKitInput>): Promise<{ kit: BrandKit }> {
    return apiRequest(`/brand-kits/${encodeURIComponent(id)}`, { method: "PATCH", body: patch });
  },

  deleteKit(id: string): Promise<{ ok: true }> {
    return apiRequest(`/brand-kits/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  duplicateKit(id: string): Promise<{ kit: BrandKit }> {
    return apiRequest(`/brand-kits/${encodeURIComponent(id)}/duplicate`, { method: "POST", body: {} });
  },

  setDefaultKit(id: string): Promise<{ kit: BrandKit }> {
    return apiRequest(`/brand-kits/${encodeURIComponent(id)}/default`, { method: "POST", body: {} });
  },

  applyKit(
    id: string,
    projectIds: string[],
  ): Promise<{ results: { projectId: string; ok: boolean; documentId?: string; error?: string }[] }> {
    return apiRequest(`/brand-kits/${encodeURIComponent(id)}/apply`, {
      method: "POST",
      body: { projectIds },
    });
  },

  listAssets(): Promise<{ assets: BrandAsset[] }> {
    return apiRequest("/brand-assets");
  },

  uploadAsset(file: File, kind: BrandAssetKind): Promise<{ asset: BrandAsset }> {
    const form = new FormData();
    form.append("file", file);
    form.append("kind", kind);
    return uploadForm(`${API_BASE_URL}/brand-assets`, form);
  },

  deleteAsset(id: string): Promise<{ ok: true }> {
    return apiRequest(`/brand-assets/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  assetStreamUrl(id: string): string {
    return `${API_BASE_URL}/brand-assets/${encodeURIComponent(id)}/stream`;
  },
};
