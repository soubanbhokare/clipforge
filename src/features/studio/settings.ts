// Studio generation/enhancement settings — shared shapes for the two
// workflow pages and the project-detail summary. Enum values must stay
// in sync with the server-side Zod schemas in server/src/studio.ts.

export interface ShortsSettings {
  clipCount: "1" | "3" | "5" | "10" | "custom";
  customClipCount: number | null;
  clipDuration: "auto" | "15" | "30" | "45" | "60" | "custom";
  customClipDurationSec: number | null;
  aspectRatio: "9:16" | "1:1" | "16:9" | "4:5";
  resolution: "720p" | "1080p" | "4k";
  targetPlatform: "youtube-shorts" | "instagram-reels" | "tiktok" | "custom";
  language: "auto" | "en" | "hi" | "mr" | "other";
  captions: { enabled: boolean; style: "clean" | "bold" | "minimal" | "highlight"; animatedHighlight: boolean };
  tracking: "face-lock" | "auto-follow" | "active-speaker" | "center" | "manual" | "none";
  zoom: "subtle" | "balanced" | "dynamic" | "manual";
  audio: string[];
  discoveryPrompt: string;
  transcriptionContext: string;
}

export const DEFAULT_SHORTS_SETTINGS: ShortsSettings = {
  clipCount: "5",
  customClipCount: null,
  clipDuration: "auto",
  customClipDurationSec: null,
  aspectRatio: "9:16",
  resolution: "1080p",
  targetPlatform: "youtube-shorts",
  language: "auto",
  captions: { enabled: true, style: "bold", animatedHighlight: false },
  tracking: "face-lock",
  zoom: "balanced",
  audio: ["preserve"],
  discoveryPrompt: "",
  transcriptionContext: "",
};

export interface EnhanceSettings {
  reframeAspect: "9:16" | "1:1" | "16:9" | "4:5";
  faceTracking: "face-lock" | "follow-speaker" | "center" | "manual";
  captionsMode: "generate" | "preserve" | "remove" | "edit-later";
  audio: string[];
  visual: string[];
}

export const DEFAULT_ENHANCE_SETTINGS: EnhanceSettings = {
  reframeAspect: "9:16",
  faceTracking: "face-lock",
  captionsMode: "generate",
  audio: ["preserve"],
  visual: [],
};

/** Merge stored (partial, server-validated) settings over defaults. */
export function shortsSettingsFrom(stored: Record<string, unknown> | undefined): ShortsSettings {
  if (!stored) return DEFAULT_SHORTS_SETTINGS;
  const captions = (stored.captions ?? {}) as Partial<ShortsSettings["captions"]>;
  return {
    ...DEFAULT_SHORTS_SETTINGS,
    ...(stored as Partial<ShortsSettings>),
    captions: { ...DEFAULT_SHORTS_SETTINGS.captions, ...captions },
    audio: Array.isArray(stored.audio) ? (stored.audio as string[]) : DEFAULT_SHORTS_SETTINGS.audio,
  };
}

export function enhanceSettingsFrom(stored: Record<string, unknown> | undefined): EnhanceSettings {
  if (!stored) return DEFAULT_ENHANCE_SETTINGS;
  return {
    ...DEFAULT_ENHANCE_SETTINGS,
    ...(stored as Partial<EnhanceSettings>),
    audio: Array.isArray(stored.audio) ? (stored.audio as string[]) : DEFAULT_ENHANCE_SETTINGS.audio,
    visual: Array.isArray(stored.visual) ? (stored.visual as string[]) : DEFAULT_ENHANCE_SETTINGS.visual,
  };
}
