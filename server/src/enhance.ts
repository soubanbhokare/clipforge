// CLIPFORGE Phase 8 — Smart Enhancement settings + FFmpeg filter chains.
//
// ONE builder, three callers: the before/after preview jobs, the
// asset-level enhancement jobs and the Phase 5 render pipeline all
// turn settings into filter strings through THIS module, so a preview
// can never promise something the export does not do.
//
// Honesty contract (spec §6/§7):
//  - Everything here is a STANDARD FFmpeg filter chain. None of it is
//    "AI enhancement" and nothing in the UI calls it that.
//  - Upscaling is a lanczos scale ONLY. It resizes the frame; it does
//    not and cannot reconstruct detail that was not in the source.
//  - Frame interpolation is FFmpeg's minterpolate (standard motion
//    estimation), labelled as standard processing, never as AI.
//  - Speech denoise uses afftdn. The arnndn filter exists in this
//    FFmpeg build but ships with ZERO .rnnn model files, so it is
//    never referenced.
//  - Background removal/segmentation has NO model on this machine and
//    is not represented here at all — src/broll.ts exposes it as an
//    honestly unconfigured provider instead of a fake control.
//  - Stabilization (vidstab two-pass) needs a per-source transforms
//    file, so it is produced by the enhancement JOB (which owns the
//    two passes), not by this single-pass chain builder.

import { z } from "zod";

const f2 = (n: number): string => {
  const v = Math.round(n * 1000) / 1000;
  return String(v);
};

// ---------------------------------------------------------------------------
// Settings shapes
// ---------------------------------------------------------------------------

export interface VideoEnhanceSettings {
  /** Spatial/temporal denoise strength 0..1 (hqdn3d). */
  denoise: number;
  /** Sharpening 0..1 (unsharp). */
  sharpen: number;
  /** Detail enhancement 0..1 — a DEDICATED fine-texture stage
   *  (wide-radius luma unsharp), distinct from the general sharpen
   *  pass: sharpen works on overall edge contrast, detail lifts
   *  small-scale texture. Both are standard unsharp masking; neither
   *  reconstructs detail that was not in the source. */
  detail: number;
  /** Compression-artifact reduction 0..1 (deblock + chroma smoothing). */
  artifactReduction: number;
  brightness: number; // -1..1
  contrast: number; // 0..2, 1 = neutral
  saturation: number; // 0..3, 1 = neutral
  exposure: number; // -1..1, folded into brightness/gamma below
  gamma: number; // 0.1..3, 1 = neutral
  temperature: number; // -1..1 (cool..warm)
  tint: number; // -1..1 (magenta..green)
  highlights: number; // -1..1
  shadows: number; // -1..1
  /** White balance target in Kelvin; null = off. */
  whiteBalanceK: number | null;
  blur: number; // 0..1 (gblur) — §10 effect
  vignette: number; // 0..1 — §10 effect
  grayscale: boolean; // §10 effect
  upscale: { enabled: boolean; width: number; height: number };
  fps: { target: number | null; interpolate: boolean };
  stabilization: {
    enabled: boolean;
    strength: number;
    smoothing: number;
    /** Crop compensation 0..1 for the vidstab transform pass: how
     *  aggressively the stabilizer zooms in to hide the moving frame
     *  borders. Mapped onto vidstabtransform's optzoom in broll.ts
     *  (<0.34 → 0/off, <0.84 → 1/optimal, else 2/adaptive). The
     *  default 0.5 reproduces the historical optzoom=1 behaviour. */
    cropCompensation: number;
  };
}

/** One point of the volume-automation contour (spec: gain over time). */
export interface VolumeAutomationPoint {
  timeSec: number;
  gainDb: number;
}

export interface AudioEnhanceSettings {
  /** Speech/background noise reduction 0..1 (afftdn). */
  denoise: number;
  normalize: "off" | "loudnorm" | "dynaudnorm";
  targetLufs: number; // loudnorm integrated target
  clarity: number; // 0..1 presence EQ + gentle high-pass
  hum: { enabled: boolean; freq: 50 | 60 };
  gainDb: number; // -24..24
  fadeInSec: number;
  fadeOutSec: number;
  /** Echo control 0..1 — a conservative aecho preset shape (single
   *  very short, low-decay tap). Documented honestly: this is a
   *  standard-filter echo-shaping stage, NOT a dereverberation
   *  model; it tightens short echo tails, it cannot remove room
   *  reverb from a recording. 0 = off. */
  echoReduction: number;
  /** L/R balance -1..1 (pan). -1 = full left, 0 = neutral, 1 = full
   *  right. The favoured channel is never boosted — the other is
   *  attenuated — so balance can never clip. */
  balance: number;
  /** Volume automation: (timeSec, gainDb) points rendered as a
   *  piecewise-linear gain contour via volume eval=frame. Empty =
   *  no automation stage (chain identical to no-automation renders). */
  volumeAutomation: VolumeAutomationPoint[];
  ducking: { enabled: boolean; amount: number }; // applied at mix time, not in this chain
}

export const DEFAULT_VIDEO_ENHANCE: VideoEnhanceSettings = {
  denoise: 0,
  sharpen: 0,
  detail: 0,
  artifactReduction: 0,
  brightness: 0,
  contrast: 1,
  saturation: 1,
  exposure: 0,
  gamma: 1,
  temperature: 0,
  tint: 0,
  highlights: 0,
  shadows: 0,
  whiteBalanceK: null,
  blur: 0,
  vignette: 0,
  grayscale: false,
  upscale: { enabled: false, width: 1920, height: 1080 },
  fps: { target: null, interpolate: false },
  stabilization: { enabled: false, strength: 0.5, smoothing: 15, cropCompensation: 0.5 },
};

export const DEFAULT_AUDIO_ENHANCE: AudioEnhanceSettings = {
  denoise: 0,
  normalize: "off",
  targetLufs: -16,
  clarity: 0,
  hum: { enabled: false, freq: 50 },
  gainDb: 0,
  fadeInSec: 0,
  fadeOutSec: 0,
  echoReduction: 0,
  balance: 0,
  volumeAutomation: [],
  ducking: { enabled: false, amount: 0.5 },
};

// ---------------------------------------------------------------------------
// Validation (server-side, zod) — also used for preset payloads.
// ---------------------------------------------------------------------------

const unit = z.number().min(0).max(1);

export const videoEnhanceSchema = z.object({
  denoise: unit,
  sharpen: unit,
  detail: unit,
  artifactReduction: unit,
  brightness: z.number().min(-1).max(1),
  contrast: z.number().min(0).max(2),
  saturation: z.number().min(0).max(3),
  exposure: z.number().min(-1).max(1),
  gamma: z.number().min(0.1).max(3),
  temperature: z.number().min(-1).max(1),
  tint: z.number().min(-1).max(1),
  highlights: z.number().min(-1).max(1),
  shadows: z.number().min(-1).max(1),
  whiteBalanceK: z.number().int().min(2500).max(10000).nullable(),
  blur: unit,
  vignette: unit,
  grayscale: z.boolean(),
  upscale: z.object({
    enabled: z.boolean(),
    width: z.number().int().min(16).max(7680),
    height: z.number().int().min(16).max(7680),
  }),
  fps: z.object({
    target: z.number().int().min(1).max(240).nullable(),
    interpolate: z.boolean(),
  }),
  stabilization: z.object({
    enabled: z.boolean(),
    strength: unit,
    smoothing: z.number().int().min(0).max(100),
    cropCompensation: unit,
  }),
});

export const audioEnhanceSchema = z.object({
  denoise: unit,
  normalize: z.enum(["off", "loudnorm", "dynaudnorm"]),
  targetLufs: z.number().min(-30).max(-8),
  clarity: unit,
  hum: z.object({ enabled: z.boolean(), freq: z.union([z.literal(50), z.literal(60)]) }),
  gainDb: z.number().min(-24).max(24),
  fadeInSec: z.number().min(0).max(30),
  fadeOutSec: z.number().min(0).max(30),
  echoReduction: unit,
  balance: z.number().min(-1).max(1),
  volumeAutomation: z
    .array(
      z.object({
        timeSec: z.number().min(0).max(86400),
        gainDb: z.number().min(-24).max(24),
      }),
    )
    .max(64),
  ducking: z.object({ enabled: z.boolean(), amount: unit }),
});

/** Fill any missing keys with defaults so partial payloads (older
 *  clients, preset subsets) validate into complete settings. */
export function normalizeVideo(raw: unknown): VideoEnhanceSettings {
  const merged = {
    ...DEFAULT_VIDEO_ENHANCE,
    ...(typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {}),
  } as Record<string, unknown>;
  merged.upscale = { ...DEFAULT_VIDEO_ENHANCE.upscale, ...((merged.upscale as object) ?? {}) };
  merged.fps = { ...DEFAULT_VIDEO_ENHANCE.fps, ...((merged.fps as object) ?? {}) };
  merged.stabilization = {
    ...DEFAULT_VIDEO_ENHANCE.stabilization,
    ...((merged.stabilization as object) ?? {}),
  };
  const parsed = videoEnhanceSchema.safeParse(merged);
  return parsed.success ? (parsed.data as VideoEnhanceSettings) : { ...DEFAULT_VIDEO_ENHANCE };
}

export function normalizeAudio(raw: unknown): AudioEnhanceSettings {
  const merged = {
    ...DEFAULT_AUDIO_ENHANCE,
    ...(typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {}),
  } as Record<string, unknown>;
  merged.hum = { ...DEFAULT_AUDIO_ENHANCE.hum, ...((merged.hum as object) ?? {}) };
  merged.ducking = { ...DEFAULT_AUDIO_ENHANCE.ducking, ...((merged.ducking as object) ?? {}) };
  const parsed = audioEnhanceSchema.safeParse(merged);
  return parsed.success ? (parsed.data as AudioEnhanceSettings) : { ...DEFAULT_AUDIO_ENHANCE };
}

// ---------------------------------------------------------------------------
// Filter-chain builders
// ---------------------------------------------------------------------------

/**
 * Video filter chain for the given settings. `includeUpscale` is true
 * only for asset-level jobs: timeline renders are governed by the
 * canvas (the render verifier asserts canvas dimensions), so the
 * document pipeline excludes the scale step and the UI says why.
 * Stabilization is never part of this chain (two-pass, job-level).
 */
export function buildVideoChain(v: VideoEnhanceSettings, opts: { includeUpscale: boolean }): string[] {
  const chain: string[] = [];

  if (v.artifactReduction >= 0.4) {
    chain.push("deblock=filter=strong:block=8");
  } else if (v.artifactReduction > 0) {
    chain.push(
      `hqdn3d=0:${f2(v.artifactReduction * 4)}:0:${f2(v.artifactReduction * 3)}`,
    );
  }

  if (v.denoise > 0) {
    const d = v.denoise;
    chain.push(
      `hqdn3d=${f2(1.5 + d * 6)}:${f2(1.5 + d * 5)}:${f2(2 + d * 7)}:${f2(2 + d * 6)}`,
    );
  }

  if (v.sharpen > 0) {
    chain.push(`unsharp=5:5:${f2(v.sharpen * 1.6)}:5:5:0`);
  }

  // Detail stage: a separate, wider-radius (7x7) luma unsharp at a
  // gentler amount than the sharpen pass. The wider kernel responds
  // to fine texture (hair, fabric, foliage) rather than hard edges,
  // which is what makes it a distinct control rather than a second
  // sharpen slider; chroma amount stays 0 like the sharpen pass.
  if (v.detail > 0) {
    chain.push(`unsharp=7:7:${f2(v.detail * 1.2)}:7:7:0`);
  }

  // Colour: one eq for brightness/contrast/saturation/gamma/exposure.
  const effBrightness = Math.max(-1, Math.min(1, v.brightness + v.exposure * 0.3));
  const effGamma = Math.max(0.1, Math.min(3, v.gamma * (1 + v.exposure * 0.25)));
  if (
    effBrightness !== 0 ||
    v.contrast !== 1 ||
    v.saturation !== 1 ||
    Math.abs(effGamma - 1) > 0.001
  ) {
    chain.push(
      `eq=contrast=${f2(v.contrast)}:brightness=${f2(effBrightness * 0.5)}:saturation=${f2(
        v.grayscale ? 0 : v.saturation,
      )}:gamma=${f2(effGamma)}`,
    );
  } else if (v.grayscale) {
    chain.push("hue=s=0");
  }

  if (v.temperature !== 0 || v.tint !== 0) {
    const t = v.temperature;
    const g = v.tint;
    chain.push(
      [
        "colorbalance",
        `rs=${f2(t * 0.22 - g * 0.08)}`,
        `gs=${f2(g * 0.2)}`,
        `bs=${f2(-t * 0.22 - g * 0.08)}`,
        `rm=${f2(t * 0.14)}`,
        `gm=${f2(g * 0.12)}`,
        `bm=${f2(-t * 0.14)}`,
        `rh=${f2(t * 0.08)}`,
        `gh=${f2(g * 0.06)}`,
        `bh=${f2(-t * 0.08)}`,
      ].join(":"),
    );
  }

  if (v.highlights !== 0 || v.shadows !== 0) {
    const y25 = Math.max(0.02, Math.min(0.6, 0.25 + v.shadows * 0.12));
    const y75 = Math.max(0.4, Math.min(0.98, 0.75 + v.highlights * 0.12));
    chain.push(`curves=all='0/0 0.25/${f2(y25)} 0.75/${f2(y75)} 1/1'`);
  }

  if (v.whiteBalanceK !== null) {
    chain.push(`colortemperature=temperature=${v.whiteBalanceK}:mix=0.85:pl=1`);
  }

  if (v.blur > 0) {
    chain.push(`gblur=sigma=${f2(v.blur * 12)}`);
  }
  if (v.vignette > 0) {
    const angle = Math.PI / 5 - v.vignette * (Math.PI / 5 - Math.PI / 11);
    chain.push(`vignette=angle=${f2(angle)}`);
  }

  if (opts.includeUpscale && v.upscale.enabled) {
    chain.push(`scale=${v.upscale.width}:${v.upscale.height}:flags=lanczos`);
  }

  if (v.fps.target !== null) {
    chain.push(
      v.fps.interpolate
        ? `minterpolate=fps=${v.fps.target}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`
        : `fps=fps=${v.fps.target}`,
    );
  }

  return chain;
}

/**
 * Audio filter chain. Ducking is deliberately NOT here: it needs two
 * streams (speech + music) and is applied by the renderer's mix stage
 * via sidechaincompress (see editor.ts compose step).
 */
export function buildAudioChain(a: AudioEnhanceSettings, durationSec?: number | null): string[] {
  const chain: string[] = [];

  if (a.hum.enabled) {
    const f = a.hum.freq;
    chain.push(`bandreject=f=${f}:width_type=h:w=6`);
    chain.push(`bandreject=f=${f * 2}:width_type=h:w=6`);
    chain.push(`bandreject=f=${f * 3}:width_type=h:w=6`);
  }

  if (a.denoise > 0) {
    // afftdn noise reduction in dB: gentle at low strength so speech
    // is not hollowed out; the -25 dB noise floor keeps it natural.
    chain.push(`afftdn=nr=${f2(4 + a.denoise * 20)}:nf=-25`);
  }

  if (a.echoReduction > 0) {
    // Conservative aecho preset shape: ONE tap at 10–30 ms with a
    // low decay (0.15–0.35) scaled by the amount. This shapes very
    // short echo tails; it is a standard filter preset, not a
    // dereverberation model (see the settings comment).
    const delayMs = 10 + Math.round(a.echoReduction * 20);
    const decay = 0.15 + a.echoReduction * 0.2;
    chain.push(`aecho=0.8:0.85:${delayMs}:${f2(decay)}`);
  }

  if (a.clarity > 0) {
    chain.push("highpass=f=70");
    chain.push(`equalizer=f=3500:width_type=o:width=1.5:g=${f2(a.clarity * 5)}`);
    chain.push(`equalizer=f=8000:width_type=o:width=1.5:g=${f2(a.clarity * 3.5)}`);
  }

  if (a.normalize === "loudnorm") {
    chain.push(`loudnorm=I=${f2(a.targetLufs)}:TP=-1.5:LRA=11`);
  } else if (a.normalize === "dynaudnorm") {
    chain.push("dynaudnorm=f=150:g=15");
  }

  if (a.gainDb !== 0) {
    chain.push(`volume=${f2(a.gainDb)}dB`);
  }

  if (a.fadeInSec > 0) {
    chain.push(`afade=t=in:st=0:d=${f2(a.fadeInSec)}`);
  }
  if (a.fadeOutSec > 0 && durationSec && durationSec > a.fadeOutSec) {
    chain.push(`afade=t=out:st=${f2(durationSec - a.fadeOutSec)}:d=${f2(a.fadeOutSec)}`);
  }

  if (a.balance !== 0) {
    // pan-based L/R balance: the favoured side keeps gain 1, the
    // other side is attenuated towards 0 at |balance| = 1, so the
    // stage can never boost or clip. pan upmixes mono sources to
    // stereo (verified on this FFmpeg build).
    const b = a.balance;
    const gL = b > 0 ? 1 - b : 1;
    const gR = b < 0 ? 1 + b : 1;
    chain.push(`pan=stereo|c0=${f2(gL)}*c0|c1=${f2(gR)}*c1`);
  }

  if (a.volumeAutomation.length > 0) {
    // Last gain stage, so the points describe the final contour
    // (after static gain, normalize and fades have been applied).
    chain.push(`volume='${volumeAutomationExpr(a.volumeAutomation)}':eval=frame`);
  }

  return chain;
}

/**
 * Piecewise-linear gain expression (over the frame timestamp `t`)
 * for the volume filter: constant at the first point's gain before
 * it, linearly interpolated between points, constant at the last
 * point's gain after it. The returned expression is the LINEAR
 * multiplier pow(10, dB/20), because the volume filter's expression
 * result is interpreted as a linear gain. All numbers
 * come from schema-validated settings formatted by f2 (plain
 * decimals, no commas/exponents), and the whole expression is
 * single-quoted by the caller, so no filter-parser escaping hazard
 * exists.
 */
export function volumeAutomationExpr(points: VolumeAutomationPoint[]): string {
  const pts = [...points]
    .map((p) => ({
      t: Math.max(0, p.timeSec),
      g: Math.max(-24, Math.min(24, p.gainDb)),
    }))
    .sort((x, y) => x.t - y.t);
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  let dbExpr = f2(last.g);
  for (let i = pts.length - 2; i >= 0; i -= 1) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const dt = Math.max(0.001, b.t - a.t);
    const lerp = `(${f2(a.g)}+(${f2(b.g)}-${f2(a.g)})*(t-${f2(a.t)})/${f2(dt)})`;
    dbExpr = `if(lt(t,${f2(b.t)}),${lerp},${dbExpr})`;
  }
  if (pts.length > 1) {
    dbExpr = `if(lt(t,${f2(first.t)}),${f2(first.g)},${dbExpr})`;
  }
  return `pow(10,(${dbExpr})/20)`;
}

/** sidechaincompress parameters for a ducking amount 0..1. The music
 *  stream is compressed using the speech stream as the sidechain, so
 *  music genuinely dips while someone talks. */
export function duckingFilter(amount: number): string {
  const ratio = Math.round(2 + amount * 14); // 2..16
  const threshold = 0.3 - amount * 0.22; // 0.30..0.08 (earlier ducking when stronger)
  return `sidechaincompress=threshold=${f2(threshold)}:ratio=${ratio}:attack=40:release=350:makeup=1:knee=6`;
}

export function videoChainActive(v: VideoEnhanceSettings, opts: { includeUpscale: boolean }): boolean {
  return buildVideoChain(v, opts).length > 0;
}

export function audioChainActive(a: AudioEnhanceSettings, durationSec?: number | null): boolean {
  return buildAudioChain(a, durationSec).length > 0;
}

// ---------------------------------------------------------------------------
// Built-in presets (spec §12). Settings are real values consumed by the
// same builders above — a preset is never a label without an effect.
// Background presets that need segmentation carry
// requiresBackgroundProvider: they stay visible but gated until a
// background provider/model is configured (spec §7 honesty rule).
// ---------------------------------------------------------------------------

export interface BuiltinPreset {
  id: string;
  name: string;
  kind: "video" | "audio" | "background";
  builtin: true;
  settings: VideoEnhanceSettings | AudioEnhanceSettings | { mode: string };
  requiresBackgroundProvider?: boolean;
  note?: string;
}

const vp = (patch: Partial<VideoEnhanceSettings>): VideoEnhanceSettings => ({
  ...DEFAULT_VIDEO_ENHANCE,
  ...patch,
});
const ap = (patch: Partial<AudioEnhanceSettings>): AudioEnhanceSettings => ({
  ...DEFAULT_AUDIO_ENHANCE,
  ...patch,
});

export const BUILTIN_PRESETS: BuiltinPreset[] = [
  { id: "builtin:clean-natural", name: "Clean Natural", kind: "video", builtin: true, settings: vp({ denoise: 0.25, sharpen: 0.2, contrast: 1.03, saturation: 1.05 }) },
  { id: "builtin:sharp-details", name: "Sharp Details", kind: "video", builtin: true, settings: vp({ sharpen: 0.8, denoise: 0.15, artifactReduction: 0.4, contrast: 1.05 }) },
  { id: "builtin:soft-cinematic", name: "Soft Cinematic", kind: "video", builtin: true, settings: vp({ contrast: 1.08, saturation: 0.92, gamma: 1.05, temperature: 0.12, vignette: 0.35 }) },
  { id: "builtin:bright-studio", name: "Bright Studio", kind: "video", builtin: true, settings: vp({ brightness: 0.12, exposure: 0.3, contrast: 1.04, saturation: 1.06, whiteBalanceK: 5600 }) },
  { id: "builtin:low-light-cleanup", name: "Low-Light Cleanup", kind: "video", builtin: true, settings: vp({ denoise: 0.7, artifactReduction: 0.5, brightness: 0.18, gamma: 1.25, shadows: 0.4 }) },
  { id: "builtin:smooth-motion", name: "Smooth Motion", kind: "video", builtin: true, settings: vp({ denoise: 0.1, fps: { target: 60, interpolate: true } }), note: "Uses FFmpeg minterpolate — standard motion estimation, not AI frame generation." },
  { id: "builtin:portrait-enhancement", name: "Portrait Enhancement", kind: "video", builtin: true, settings: vp({ denoise: 0.3, sharpen: 0.35, saturation: 1.08, temperature: 0.15, highlights: -0.1 }) },

  { id: "builtin:clear-voice", name: "Clear Voice", kind: "audio", builtin: true, settings: ap({ denoise: 0.5, clarity: 0.7, normalize: "loudnorm", targetLufs: -16, hum: { enabled: true, freq: 50 } }) },
  { id: "builtin:podcast-voice", name: "Podcast Voice", kind: "audio", builtin: true, settings: ap({ denoise: 0.35, clarity: 0.55, normalize: "loudnorm", targetLufs: -14, gainDb: 2, hum: { enabled: true, freq: 50 } }) },
  { id: "builtin:low-noise", name: "Low Noise", kind: "audio", builtin: true, settings: ap({ denoise: 0.9, normalize: "dynaudnorm", hum: { enabled: true, freq: 50 } }) },
  { id: "builtin:balanced-speech", name: "Balanced Speech", kind: "audio", builtin: true, settings: ap({ denoise: 0.3, clarity: 0.4, normalize: "loudnorm", targetLufs: -16 }) },
  { id: "builtin:voice-plus-music", name: "Voice + Music", kind: "audio", builtin: true, settings: ap({ denoise: 0.4, clarity: 0.5, normalize: "loudnorm", targetLufs: -16, ducking: { enabled: true, amount: 0.6 } }) },

  { id: "builtin:bg-original", name: "Original Background", kind: "background", builtin: true, settings: { mode: "original" } },
  { id: "builtin:bg-soft-blur", name: "Soft Blur", kind: "background", builtin: true, settings: { mode: "blur" }, requiresBackgroundProvider: true },
  { id: "builtin:bg-solid-dark", name: "Solid Dark", kind: "background", builtin: true, settings: { mode: "solid-dark" }, requiresBackgroundProvider: true },
  { id: "builtin:bg-solid-light", name: "Solid Light", kind: "background", builtin: true, settings: { mode: "solid-light" }, requiresBackgroundProvider: true },
  { id: "builtin:bg-custom-image", name: "Custom Image", kind: "background", builtin: true, settings: { mode: "custom-image" }, requiresBackgroundProvider: true },
  { id: "builtin:bg-custom-video", name: "Custom Video", kind: "background", builtin: true, settings: { mode: "custom-video" }, requiresBackgroundProvider: true },
];

/** Plain-language capability summary for the status endpoint + UI. */
export const ENHANCEMENT_CAPABILITIES = {
  classification: {
    standardFilters:
      "Denoise (hqdn3d), sharpen + detail enhancement (unsharp), deblock, brightness/contrast/saturation/gamma (eq), temperature/tint (colorbalance), highlights/shadows (curves), white balance (colortemperature), blur (gblur), vignette, grayscale, fps conversion, lanczos scaling, vidstab stabilization (with crop compensation), afftdn noise reduction, echo control (aecho preset), L/R balance (pan), volume automation (volume eval=frame), loudnorm/dynaudnorm, presence EQ, hum notch, sidechain ducking.",
    aiPowered: "None on this machine. No filter here is labelled AI.",
    providerDependent:
      "Background removal/replacement (segmentation model), stock-media import and AI media generation — all require a configured provider; see provider status.",
  },
  upscaleNote:
    "Upscaling resizes frames with a lanczos scale filter. It does not reconstruct detail that was not present in the source.",
  interpolationNote:
    "Frame-rate conversion uses the fps filter; optional smoothing uses FFmpeg minterpolate (standard motion estimation), not an AI model.",
} as const;
