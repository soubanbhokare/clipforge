// CLIPFORGE API — Phase 6: Captions Studio & Brand Kit.
//
// Design rules (from the Phase 6 spec, kept honest):
//  - The Phase 5 editor document stays the single editing surface.
//    Its caption_segments rows ARE the active caption track; other
//    variants (translations, manual sets) live in caption_tracks /
//    caption_track_segments and are swapped in through normal editor
//    operations, so undo/autosave keep working uniformly.
//  - Word-level features use ONLY the real word timings copied from
//    the Phase 4 transcript (transcript_segments.words_json). When a
//    caption has no word data, karaoke/highlight/reveal degrade to
//    segment-level effects and the API/UI say so — timings are never
//    invented.
//  - Every appearance control maps to a real ASS (libass) style or
//    override tag in the burn-in render, EXCEPT lineSpacing: libass
//    has no line-height control, so it is preview-only and labelled
//    as such in the UI (spec §10: report the limitation, never fake).
//  - Translation runs through a provider adapter. No provider is
//    configured in this environment, so jobs fail honestly with a
//    CONFIGURATION error. Manual translations (typed or imported by
//    the user) are stored as separate tracks and always work; the
//    original transcript is never modified.

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { config, serverDir, translationConfigured } from "./config.js";
import { currentWorkspaceId } from "./accountCore.js";
import {
  getDb,
  type BrandAssetRow,
  type BrandKitRow,
  type CaptionTrackRow,
  type CaptionTrackSegmentRow,
  type CaptionTemplateRow,
  type ClipVersionRow,
  type ProjectRow,
  type TranslationJobRow,
  type UserRow,
} from "./db.js";
import { extensionOf, mediaPath, probeAnyFile } from "./media.js";
import {
  commitOperation,
  docById,
  getOrCreateDoc,
  ownedProject,
  publicDocument,
  readState,
  validateState,
  type CaptionState,
  type EditorState,
} from "./editor.js";

// ---- shared helpers -----------------------------------------------------------

const nowIso = (): string => new Date().toISOString();
const newId = (): string => crypto.randomUUID();
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

interface AuthedRequest extends Request {
  user?: UserRow;
}
type RequireAuth = (req: AuthedRequest, res: Response, next: NextFunction) => void;

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// ---- caption style model --------------------------------------------------------
// The style model itself lives in ./captionStyle.ts (a leaf module)
// and is re-exported here for route/builder consumers.

import {
  captionStyleSchema,
  DEFAULT_CAPTION_STYLE,
  hexColorSchema as hexColor,
  type CaptionAnimation,
  type CaptionPosition,
  type CaptionStyleConfig,
} from "./captionStyle.js";

export {
  captionStyleSchema,
  DEFAULT_CAPTION_STYLE,
  type CaptionAnimation,
  type CaptionPosition,
  type CaptionStyleConfig,
};

// ---- built-in templates -----------------------------------------------------------
// Templates are real style CONFIGURATIONS. The 10 built-ins live here;
// user templates are rows in caption_templates with the same shape.

export interface CaptionTemplateDef {
  id: string;
  name: string;
  builtin: boolean;
  basedOn: string | null;
  style: CaptionStyleConfig;
}

const tpl = (patch: Partial<CaptionStyleConfig>): CaptionStyleConfig => ({
  ...DEFAULT_CAPTION_STYLE,
  ...patch,
});

export const BUILTIN_TEMPLATES: CaptionTemplateDef[] = [
  {
    id: "builtin:clean-minimal",
    name: "Clean Minimal",
    builtin: true,
    basedOn: null,
    style: tpl({}),
  },
  {
    id: "builtin:bold-creator",
    name: "Bold Creator",
    builtin: true,
    basedOn: null,
    style: tpl({
      fontSize: 64,
      fontWeight: 800,
      backgroundOpacity: 0,
      outlineWidth: 3,
      shadowDepth: 2,
      casing: "upper",
      maxWordsPerLine: 5,
      animation: "pop",
    }),
  },
  {
    id: "builtin:modern-highlight",
    name: "Modern Highlight",
    builtin: true,
    basedOn: null,
    style: tpl({
      fontSize: 56,
      fontWeight: 700,
      highlightColor: "#1558C9",
      backgroundOpacity: 0.35,
      animation: "highlight",
      maxWordsPerLine: 6,
    }),
  },
  {
    id: "builtin:karaoke",
    name: "Karaoke",
    builtin: true,
    basedOn: null,
    style: tpl({
      fontSize: 58,
      fontWeight: 700,
      highlightColor: "#D4FF24",
      backgroundOpacity: 0.4,
      animation: "karaoke",
      maxWordsPerLine: 6,
    }),
  },
  {
    id: "builtin:cinematic-subtitle",
    name: "Cinematic Subtitle",
    builtin: true,
    basedOn: null,
    style: tpl({
      fontFamily: "DejaVu Serif",
      fontSize: 44,
      fontWeight: 400,
      backgroundOpacity: 0,
      outlineWidth: 1,
      shadowDepth: 2,
      letterSpacing: 1,
      animation: "fade",
      maxWordsPerLine: 10,
    }),
  },
  {
    id: "builtin:news-style",
    name: "News Style",
    builtin: true,
    basedOn: null,
    style: tpl({
      fontSize: 46,
      fontWeight: 700,
      textColor: "#030407",
      highlightColor: "#1558C9",
      backgroundColor: "#FFFFFF",
      backgroundOpacity: 0.92,
      alignment: "left",
      animation: "none",
      maxWordsPerLine: 9,
      marginH: 48,
    }),
  },
  {
    id: "builtin:educational",
    name: "Educational",
    builtin: true,
    basedOn: null,
    style: tpl({
      fontSize: 46,
      fontWeight: 600,
      backgroundOpacity: 0.7,
      animation: "keyword-emphasis",
      maxWordsPerLine: 8,
      maxLines: 3,
    }),
  },
  {
    id: "builtin:interview",
    name: "Interview",
    builtin: true,
    basedOn: null,
    style: tpl({
      fontSize: 46,
      fontWeight: 400,
      italic: true,
      backgroundOpacity: 0.45,
      animation: "fade",
      maxWordsPerLine: 8,
    }),
  },
  {
    id: "builtin:podcast",
    name: "Podcast",
    builtin: true,
    basedOn: null,
    style: tpl({
      fontSize: 54,
      fontWeight: 600,
      highlightColor: "#1558C9",
      backgroundOpacity: 0.5,
      animation: "word-reveal",
      position: "lower-middle",
      maxWordsPerLine: 6,
    }),
  },
  {
    id: "builtin:clipforge-signature",
    name: "CLIPFORGE Signature",
    builtin: true,
    basedOn: null,
    // Approved brand palette only (Midnight/Cobalt/Lime + the logo's
    // CLIP off-white). The approved logo itself is never redrawn.
    style: tpl({
      fontSize: 58,
      fontWeight: 800,
      textColor: "#F8F9FC",
      highlightColor: "#D4FF24",
      backgroundColor: "#030407",
      backgroundOpacity: 0.72,
      outlineColor: "#1558C9",
      outlineWidth: 1,
      letterSpacing: 0.5,
      animation: "highlight",
      maxWordsPerLine: 6,
    }),
  },
];

export const CLIPFORGE_SIGNATURE_TEMPLATE_ID = "builtin:clipforge-signature";

export function builtinTemplate(id: string | null | undefined): CaptionTemplateDef | undefined {
  if (!id) return undefined;
  return BUILTIN_TEMPLATES.find((t) => t.id === id);
}

// ---- fonts (real, from fontconfig) -------------------------------------------------

let fontsCache: string[] | null = null;

/** Actual font families installed on this machine (fc-list), cached. */
export function availableFonts(): string[] {
  if (fontsCache) return fontsCache;
  try {
    const out = execFileSync("fc-list", ["-f", "%{family}\n"], {
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const set = new Set<string>();
    for (const line of out.split("\n")) {
      for (const part of line.split(",")) {
        const name = part.trim();
        if (name) set.add(name);
      }
    }
    fontsCache = [...set].sort((a, b) => a.localeCompare(b));
    if (fontsCache.length === 0) throw new Error("fc-list returned no fonts");
  } catch {
    fontsCache = ["DejaVu Sans", "Noto Sans"];
  }
  return fontsCache;
}

export function fontAvailable(name: string): boolean {
  return availableFonts().includes(name);
}

/**
 * The font the render will actually use. A family that is not
 * installed falls back (Noto Sans Devanagari for hi/mr text, else
 * Noto Sans) and the fallback is REPORTED, never hidden. Latin
 * "Noto Sans" with Hindi/Marathi captions swaps to its Devanagari
 * sibling so the script renders with a real Devanagari face.
 */
export function resolveRenderFont(
  style: CaptionStyleConfig,
  language: string | null,
): { font: string; fellBack: boolean } {
  const fonts = availableFonts();
  const devanagari = language === "hi" || language === "mr";
  if (fonts.includes(style.fontFamily)) {
    if (devanagari && style.fontFamily === "Noto Sans" && fonts.includes("Noto Sans Devanagari")) {
      return { font: "Noto Sans Devanagari", fellBack: false };
    }
    return { font: style.fontFamily, fellBack: false };
  }
  if (devanagari && fonts.includes("Noto Sans Devanagari")) {
    return { font: "Noto Sans Devanagari", fellBack: true };
  }
  return { font: fonts.includes("Noto Sans") ? "Noto Sans" : (fonts[0] ?? "DejaVu Sans"), fellBack: true };
}

// ---- text helpers ---------------------------------------------------------------------

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

/**
 * Wrap caption text into lines of at most maxWordsPerLine words. If
 * that yields more than maxLines lines, the words-per-line budget is
 * widened until it fits — text is NEVER truncated to fit the box.
 * Existing line breaks in the text act as hard line starts.
 */
export function wrapLines(text: string, style: CaptionStyleConfig): string[] {
  const wordsOf = (s: string) => s.split(/\s+/).filter(Boolean);
  const hardLines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
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

/** Same wrapping, but operating on word objects (for karaoke/keyword spans). */
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

// ---- ASS (libass) generation ----------------------------------------------------------
// The render burns captions with the FFmpeg `subtitles` filter over a
// generated .ass file whose PlayRes equals the canvas, so FontSize,
// margins and positions are literal canvas pixels. Karaoke uses \kf
// sweep tags, "highlight" builds one event per word with only the
// active word restyled, word-reveal builds cumulative events — all
// from the caption's REAL word timings. A caption without word data
// degrades to segment-level effects (fade / whole-line sweep).

type AssCaption = Pick<CaptionState, "start" | "end" | "text" | "words" | "style" | "language">;

function assColor(hex: string, opacity = 1): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex) ?? ["", "FFFFFF"];
  const rr = m[1].slice(0, 2);
  const gg = m[1].slice(2, 4);
  const bb = m[1].slice(4, 6);
  const aa = Math.round((1 - opacity) * 255)
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();
  return `&H${aa}${bb}${gg}${rr}`.toUpperCase();
}

/** Escape caption text for an ASS dialogue line. Braces would start an
 *  override block, so they are swapped for fullwidth lookalikes;
 *  newlines become \N. */
function assText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "｛")
    .replace(/\}/g, "｝")
    .replace(/\r?\n/g, "\\N");
}

function assTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360_000);
  const m = Math.floor((cs % 360_000) / 6_000);
  const s = Math.floor((cs % 6_000) / 100);
  const c = cs % 100;
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${h}:${pad(m)}:${pad(s)}.${pad(c)}`;
}

/** ASS numpad alignment for a style's position + horizontal alignment. */
function assAlignment(style: CaptionStyleConfig): number {
  const col = style.alignment === "left" ? 0 : style.alignment === "right" ? 2 : 1;
  switch (style.position) {
    case "top":
    case "upper-middle":
      return 7 + col;
    case "center":
    case "custom":
      return 4 + col;
    default:
      return 1 + col; // bottom / lower-middle
  }
}

function assMargins(style: CaptionStyleConfig, canvasH: number): { l: number; r: number; v: number } {
  if (style.position === "custom") return { l: 0, r: 0, v: 0 };
  let v = Math.round(style.marginV);
  if (style.position === "upper-middle" || style.position === "lower-middle") {
    v = Math.round(canvasH * 0.16);
  }
  if (style.position === "center") v = 0;
  return { l: Math.round(style.marginH), r: Math.round(style.marginH), v };
}

/** Anchor point (for \pos / \move) of a style on the canvas. */
function assAnchor(
  style: CaptionStyleConfig,
  canvas: { width: number; height: number },
): { x: number; y: number; an: number } {
  const an = assAlignment(style);
  if (style.position === "custom") {
    return { x: Math.round(style.positionX * canvas.width), y: Math.round(style.positionY * canvas.height), an };
  }
  const x =
    style.alignment === "left"
      ? Math.round(style.marginH)
      : style.alignment === "right"
        ? canvas.width - Math.round(style.marginH)
        : Math.round(canvas.width / 2);
  let y: number;
  switch (style.position) {
    case "top":
      y = Math.round(style.marginV);
      break;
    case "upper-middle":
      y = Math.round(canvas.height * 0.16);
      break;
    case "center":
      y = Math.round(canvas.height / 2);
      break;
    case "lower-middle":
      y = canvas.height - Math.round(canvas.height * 0.16);
      break;
    default:
      y = canvas.height - Math.round(style.marginV);
  }
  return { x, y, an };
}

interface AssEvent {
  start: number;
  end: number;
  styleName: string;
  text: string;
}

function captionEvents(
  caption: AssCaption,
  style: CaptionStyleConfig,
  styleName: string,
  canvas: { width: number; height: number },
): AssEvent[] {
  const words = caption.words && caption.words.length > 0 ? caption.words : null;
  const cased = applyCasing(caption.text, style.casing);
  const plainLines = wrapLines(cased, style);
  const plainText = plainLines.map(assText).join("\\N");
  const start = caption.start;
  const end = Math.max(caption.end, caption.start + 0.1);

  const prefix: string[] = [];
  if (style.position === "custom" || style.animation === "slide-up") {
    const a = assAnchor(style, canvas);
    if (style.animation === "slide-up") {
      const fromY = a.y + Math.round(canvas.height * 0.045);
      prefix.push(`\\an${a.an}\\move(${a.x},${fromY},${a.x},${a.y},0,240)`);
    } else {
      prefix.push(`\\an${a.an}\\pos(${a.x},${a.y})`);
    }
  }
  const head = prefix.length > 0 ? `{${prefix.join("")}}` : "";
  const one = (text: string, s = start, e = end, extraHead = ""): AssEvent[] => [
    { start: s, end: e, styleName, text: `${head}${extraHead}${text}` },
  ];

  switch (style.animation) {
    case "fade":
      return one(plainText, start, end, "{\\fad(200,150)}");
    case "minimal":
      return one(plainText, start, end, "{\\fad(110,110)}");
    case "pop":
      return one(plainText, start, end, "{\\fscx55\\fscy55\\t(0,160,\\fscx100\\fscy100)}");
    case "keyword-emphasis": {
      if (!words) return one(plainText);
      const hl = assColor(style.highlightColor);
      const primary = assColor(style.textColor);
      const lines = wrapWords(
        words.map((w) => ({ ...w, display: applyCasing(w.word, style.casing) })),
        style,
      );
      const rendered = lines
        .map((line) =>
          line
            .map((w) =>
              w.emphasized
                ? `{\\b1\\1c${hl}}${assText(w.display)}{\\b0\\1c${primary}}`
                : assText(w.display),
            )
            .join(" "),
        )
        .join("\\N");
      return one(rendered);
    }
    case "word-reveal": {
      if (!words) return one(plainText, start, end, "{\\fad(150,120)}");
      const events: AssEvent[] = [];
      for (let i = 0; i < words.length; i += 1) {
        const evStart = Math.max(start, words[i].start);
        const evEnd = i + 1 < words.length ? Math.max(words[i + 1].start, evStart + 0.05) : end;
        const shown = words.slice(0, i + 1).map((w) => applyCasing(w.word, style.casing));
        const text = wrapLines(shown.join(" "), style).map(assText).join("\\N");
        events.push({ start: evStart, end: evEnd, styleName, text: `${head}${text}` });
      }
      return events;
    }
    case "karaoke": {
      if (!words) {
        const totalCs = Math.max(1, Math.round((end - start) * 100));
        return one(`{\\kf${totalCs}}${plainText}`);
      }
      // Karaoke sweeps continuously across the whole cue; words are
      // joined with spaces (no \N) so the sweep never restarts mid-cue.
      const swept = words
        .map((w) => {
          const cs = Math.max(1, Math.round((w.end - w.start) * 100));
          return `{\\kf${cs}}${assText(applyCasing(w.word, style.casing))}`;
        })
        .join(" ");
      return one(swept);
    }
    case "highlight": {
      if (!words) return one(plainText, start, end, "{\\fad(150,120)}");
      const hl = assColor(style.highlightColor);
      const events: AssEvent[] = [];
      for (let i = 0; i < words.length; i += 1) {
        const evStart = Math.max(start, words[i].start);
        const evEnd = i + 1 < words.length ? Math.max(words[i + 1].start, evStart + 0.05) : end;
        const lines = wrapWords(
          words.map((w, j) => ({ ...w, display: applyCasing(w.word, style.casing), active: j === i })),
          style,
        );
        const text = lines
          .map((line) =>
            line
              .map((w) =>
                w.active ? `{\\b1\\1c${hl}}${assText(w.display)}{\\r}` : assText(w.display),
              )
              .join(" "),
          )
          .join("\\N");
        events.push({ start: evStart, end: evEnd, styleName, text: `${head}${text}` });
      }
      return events;
    }
    default:
      return one(plainText);
  }
}

/**
 * Build the .ass document for a set of captions on a canvas. Each
 * distinct effective style (per-caption override ?? document style)
 * becomes one ASS style; karaoke uses PrimaryColour as the sung
 * colour and SecondaryColour as the not-yet-sung colour.
 */
export function buildAss(
  captions: AssCaption[],
  docStyle: CaptionStyleConfig,
  canvas: { width: number; height: number },
  language: string | null,
): string {
  const styleNames = new Map<string, string>();
  const styleLines: string[] = [];
  const nameFor = (style: CaptionStyleConfig): string => {
    const key = JSON.stringify(style);
    const existing = styleNames.get(key);
    if (existing) return existing;
    const name = `Style${styleNames.size}`;
    styleNames.set(key, name);
    const { font } = resolveRenderFont(style, language);
    const useBox = style.backgroundOpacity > 0;
    const isKaraoke = style.animation === "karaoke";
    const primary = isKaraoke ? style.highlightColor : style.textColor;
    const secondary = isKaraoke ? style.textColor : style.highlightColor;
    const margins = assMargins(style, canvas.height);
    styleLines.push(
      [
        `Style: ${name}`,
        font,
        String(Math.round(style.fontSize)),
        assColor(primary),
        assColor(secondary),
        assColor(style.outlineColor),
        useBox ? assColor(style.backgroundColor, style.backgroundOpacity) : "&H96030407",
        style.fontWeight >= 600 ? "-1" : "0",
        style.italic ? "-1" : "0",
        "0",
        "0",
        "100",
        "100",
        String(style.letterSpacing),
        "0",
        useBox ? "3" : "1",
        useBox ? String(Math.max(2, Math.round(style.outlineWidth))) : String(Math.round(style.outlineWidth)),
        String(Math.round(style.shadowDepth)),
        String(assAlignment(style)),
        String(margins.l),
        String(margins.r),
        String(margins.v),
        "1",
      ].join(","),
    );
    return name;
  };

  const events: AssEvent[] = [];
  const sorted = [...captions]
    .filter((c) => c.text.trim().length > 0)
    .sort((a, b) => a.start - b.start);
  for (const caption of sorted) {
    const effective = caption.style ?? docStyle;
    events.push(...captionEvents(caption, effective, nameFor(effective), canvas));
  }
  events.sort((a, b) => a.start - b.start);

  const header = [
    "[Script Info]",
    "Title: CLIPFORGE captions",
    "ScriptType: v4.00+",
    `PlayResX: ${canvas.width}`,
    `PlayResY: ${canvas.height}`,
    "ScaledBorderAndShadow: yes",
    "WrapStyle: 2",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ...styleLines,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events.map(
      (e) => `Dialogue: 0,${assTime(e.start)},${assTime(e.end)},${e.styleName},,0,0,0,,${e.text}`,
    ),
    "",
  ];
  return header.join("\n");
}

// ---- SRT / VTT build + parse ------------------------------------------------------------

export interface SubtitleSegment {
  start: number;
  end: number;
  text: string;
}

function subTime(sec: number, separator: "," | "."): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const milli = ms % 1000;
  const pad = (v: number, l = 2) => String(v).padStart(l, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}${separator}${pad(milli, 3)}`;
}

/** Keep a cue's text from corrupting the file grammar (a literal
 *  "-->" would break the timing line of the NEXT parse). Multi-line
 *  cue text is legal in both formats and is preserved — but a BLANK
 *  line inside a cue would terminate the cue block early in both
 *  grammars, so runs of blank lines collapse to a single newline. */
function safeCueText(text: string): string {
  return text.replace(/-->/g, "-- >").replace(/\n\s*\n+/g, "\n").trim();
}

export function buildSrtText(segments: SubtitleSegment[]): string {
  const sorted = [...segments]
    .map((s) => ({ ...s, text: safeCueText(s.text) }))
    .filter((s) => s.text.length > 0)
    .sort((a, b) => a.start - b.start);
  return sorted
    .map(
      (s, i) =>
        `${i + 1}\n${subTime(s.start, ",")} --> ${subTime(Math.max(s.end, s.start + 0.1), ",")}\n${s.text}\n`,
    )
    .join("\n");
}

export function buildVttText(segments: SubtitleSegment[]): string {
  const sorted = [...segments]
    .map((s) => ({
      ...s,
      text: safeCueText(s.text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    }))
    .filter((s) => s.text.length > 0)
    .sort((a, b) => a.start - b.start);
  const cues = sorted.map(
    (s) => `${subTime(s.start, ".")} --> ${subTime(Math.max(s.end, s.start + 0.1), ".")}\n${s.text}\n`,
  );
  return `WEBVTT\n\n${cues.join("\n")}`;
}

function parseTimestamp(raw: string): number | null {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(raw.trim());
  if (!m) return null;
  const hours = m[1] ? Number(m[1]) : 0;
  const minutes = Number(m[2]);
  const seconds = Number(m[3]);
  const millis = Number(m[4].padEnd(3, "0"));
  if (minutes > 59 || seconds > 59) return null;
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

/**
 * Strict-enough subtitle parser: blocks without a timing line are
 * skipped (VTT NOTE/STYLE blocks), but a block WITH a "-->" timing
 * line that does not parse invalidates the whole file — imports must
 * never silently drop or mis-time cues.
 */
export function parseSubtitles(
  content: string,
  format: "srt" | "vtt",
): { ok: true; segments: SubtitleSegment[] } | { ok: false; error: string } {
  const text = content.replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (format === "vtt" && !/^\s*WEBVTT/.test(text)) {
    return { ok: false, error: "This is not a WebVTT file — it does not start with the WEBVTT header." };
  }
  const blocks = text.split(/\n\s*\n/);
  const segments: SubtitleSegment[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) continue;
    const timingIdx = lines.findIndex((l) => l.includes("-->"));
    if (timingIdx === -1) continue; // index numbers, NOTE/STYLE blocks
    const timing = lines[timingIdx];
    const [startRaw, restRaw] = timing.split("-->");
    const endRaw = (restRaw ?? "").trim().split(/\s+/)[0] ?? "";
    const start = parseTimestamp(startRaw ?? "");
    const end = parseTimestamp(endRaw);
    if (start === null || end === null) {
      return { ok: false, error: `A cue timing line could not be read: "${timing.trim().slice(0, 80)}".` };
    }
    if (end <= start) {
      return { ok: false, error: `A cue ends at or before it starts (${startRaw.trim()} --> ${endRaw}).` };
    }
    if (end > 86400) {
      return { ok: false, error: "A cue ends beyond 24 hours, which the editor does not support." };
    }
    const cueText = lines
      .slice(timingIdx + 1)
      .join("\n")
      .replace(/<[^>]+>/g, "")
      .trim();
    if (!cueText) {
      return { ok: false, error: "A cue has timing but no caption text." };
    }
    if (cueText.length > 500) {
      return {
        ok: false,
        error: `A cue starting at ${startRaw.trim()} is longer than 500 characters, the editor's per-caption limit.`,
      };
    }
    segments.push({ start: round3(start), end: round3(end), text: cueText });
  }
  if (segments.length === 0) {
    return { ok: false, error: "No caption cues were found in this file." };
  }
  segments.sort((a, b) => a.start - b.start);
  return { ok: true, segments };
}

// ---- caption track storage ---------------------------------------------------------------
// Invariant: caption_segments (the editor table) always mirrors the
// ACTIVE caption track. Inactive variants are stored in
// caption_track_segments. Before any read/switch of stored variants,
// the active track's stored copy is re-synced from the live document,
// so the document remains the single source of truth.

function trackRows(versionId: string): CaptionTrackRow[] {
  return getDb()
    .prepare("SELECT * FROM caption_tracks WHERE version_id = ? ORDER BY created_at ASC, rowid ASC")
    .all(versionId) as unknown as CaptionTrackRow[];
}

function activeTrackRow(versionId: string): CaptionTrackRow | undefined {
  return getDb()
    .prepare("SELECT * FROM caption_tracks WHERE version_id = ? AND is_active = 1")
    .get(versionId) as CaptionTrackRow | undefined;
}

function transcriptLanguage(projectId: string): string | null {
  const row = getDb()
    .prepare("SELECT language FROM transcripts WHERE project_id = ? ORDER BY rowid DESC LIMIT 1")
    .get(projectId) as { language: string | null } | undefined;
  return row?.language ?? null;
}

/**
 * True when a transcript with actual segments is stored for the
 * project. Lets the studio UI distinguish "no transcript yet" from
 * "a transcript exists but produced no caption cues" — both would
 * otherwise surface as captionCount 0. Mirrors how the regenerate
 * path reads transcripts: the project's transcript rows plus their
 * transcript_segments.
 */
function projectHasTranscript(projectId: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 AS found FROM transcripts t
       WHERE t.project_id = ?
         AND EXISTS (SELECT 1 FROM transcript_segments s WHERE s.transcript_id = t.id)
       LIMIT 1`,
    )
    .get(projectId) as { found: number } | undefined;
  return row !== undefined;
}

/** Persist the document's current captions as the active track's stored set. */
function syncActiveTrackSegments(doc: ClipVersionRow, state: EditorState): void {
  const track = activeTrackRow(doc.id);
  if (!track) return;
  const db = getDb();
  db.prepare("DELETE FROM caption_track_segments WHERE track_id = ?").run(track.id);
  const ins = db.prepare(
    "INSERT INTO caption_track_segments (id, track_id, start_sec, end_sec, text, words_json, style_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const now = nowIso();
  for (const c of state.captions) {
    ins.run(
      newId(), track.id, round3(c.start), round3(c.end), c.text,
      c.words ? JSON.stringify(c.words) : null,
      c.style ? JSON.stringify(c.style) : null,
      now,
    );
  }
  db.prepare("UPDATE caption_tracks SET updated_at = ? WHERE id = ?").run(now, track.id);
}

function ensureActiveTrack(userId: string, doc: ClipVersionRow, state: EditorState): CaptionTrackRow {
  const active = activeTrackRow(doc.id);
  if (active) return active;
  const rows = trackRows(doc.id);
  if (rows.length > 0) {
    getDb().prepare("UPDATE caption_tracks SET is_active = 1 WHERE id = ?").run(rows[0].id);
    return { ...rows[0], is_active: 1 };
  }
  const language =
    state.captions.find((c) => c.language)?.language ?? transcriptLanguage(doc.project_id) ?? "en";
  const row: CaptionTrackRow = {
    id: newId(),
    version_id: doc.id,
    user_id: userId,
    project_id: doc.project_id,
    language,
    kind: "original",
    label: `Original (${language})`,
    is_active: 1,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  getDb()
    .prepare(
      "INSERT INTO caption_tracks (id, version_id, user_id, project_id, language, kind, label, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
    )
    .run(row.id, row.version_id, row.user_id, row.project_id, row.language, row.kind, row.label, row.created_at, row.updated_at);
  syncActiveTrackSegments(doc, state);
  return row;
}

function storedSegments(track: CaptionTrackRow): CaptionState[] {
  const rows = getDb()
    .prepare("SELECT * FROM caption_track_segments WHERE track_id = ? ORDER BY start_sec ASC, rowid ASC")
    .all(track.id) as unknown as CaptionTrackSegmentRow[];
  return rows.map((r) => ({
    id: r.id,
    start: r.start_sec,
    end: r.end_sec,
    text: r.text,
    words: r.words_json
      ? parseJson<CaptionState["words"]>(r.words_json, null)
      : null,
    style: r.style_json ? parseJson<CaptionStyleConfig | null>(r.style_json, null) : null,
    language: track.language,
  }));
}

function segmentCount(trackId: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM caption_track_segments WHERE track_id = ?")
    .get(trackId) as { n: number };
  return row.n;
}

// ---- serializers ---------------------------------------------------------------------------

function publicTrack(t: CaptionTrackRow, activeSegmentCount?: number) {
  return {
    id: t.id,
    documentId: t.version_id,
    projectId: t.project_id,
    language: t.language,
    kind: t.kind,
    label: t.label,
    isActive: t.is_active === 1,
    segmentCount: t.is_active === 1 && activeSegmentCount !== undefined ? activeSegmentCount : segmentCount(t.id),
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}

function publicTemplateDef(t: CaptionTemplateDef) {
  return { id: t.id, name: t.name, builtin: true, basedOn: t.basedOn, style: t.style, createdAt: null, updatedAt: null };
}

function publicTemplateRow(r: CaptionTemplateRow) {
  return {
    id: r.id,
    name: r.name,
    builtin: false,
    basedOn: r.based_on,
    style: parseJson<CaptionStyleConfig>(r.style_json, DEFAULT_CAPTION_STYLE),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function studioPayload(userId: string, doc: ClipVersionRow) {
  const state = readState(doc);
  const track = ensureActiveTrack(userId, doc, state);
  return {
    documentId: doc.id,
    projectId: doc.project_id,
    captionsEnabled: state.settings.showCaptions,
    style: state.settings.captionStyle,
    templateId: state.settings.captionTemplateId,
    brandKitId: state.settings.brandKitId,
    activeTrack: publicTrack(track, state.captions.length),
    tracks: trackRows(doc.id).map((t) =>
      publicTrack(t, t.id === track.id ? state.captions.length : undefined),
    ),
    hasWordTimestamps: state.captions.some((c) => Boolean(c.words && c.words.length > 0)),
    hasTranscript: projectHasTranscript(doc.project_id),
    captionCount: state.captions.length,
    translationConfigured,
    translationProvider: config.translation.provider || null,
  };
}

// ---- template routes ---------------------------------------------------------------------------

const templateCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  style: captionStyleSchema,
  basedOn: z.string().max(128).nullable().optional(),
});

const templatePatchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  style: captionStyleSchema.optional(),
});

function userTemplate(userId: string, id: string): CaptionTemplateRow | undefined {
  return getDb()
    .prepare("SELECT * FROM caption_templates WHERE id = ? AND user_id = ?")
    .get(id, userId) as CaptionTemplateRow | undefined;
}

function registerTemplateRoutes(router: express.Router, requireAuth: RequireAuth): void {
  router.get("/caption-templates", requireAuth, (req: AuthedRequest, res) => {
    const rows = getDb()
      .prepare("SELECT * FROM caption_templates WHERE user_id = ? ORDER BY created_at ASC")
      .all(req.user!.id) as unknown as CaptionTemplateRow[];
    res.json({
      templates: [...BUILTIN_TEMPLATES.map(publicTemplateDef), ...rows.map(publicTemplateRow)],
    });
  });

  router.post("/caption-templates", requireAuth, (req: AuthedRequest, res) => {
    const parsed = templateCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "A template needs a name (1–80 characters) and a complete, valid caption style." });
      return;
    }
    const row: CaptionTemplateRow = {
      id: newId(),
      user_id: req.user!.id,
      name: parsed.data.name,
      style_json: JSON.stringify(parsed.data.style),
      based_on: parsed.data.basedOn ?? null,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    getDb()
      .prepare(
        "INSERT INTO caption_templates (id, user_id, name, style_json, based_on, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(row.id, row.user_id, row.name, row.style_json, row.based_on, row.created_at, row.updated_at);
    res.status(201).json({ template: publicTemplateRow(row) });
  });

  router.patch("/caption-templates/:id", requireAuth, (req: AuthedRequest, res) => {
    if (builtinTemplate(req.params.id)) {
      res.status(400).json({ error: "Built-in templates cannot be edited. Duplicate it to make your own copy." });
      return;
    }
    const row = userTemplate(req.user!.id, req.params.id);
    if (!row) {
      res.status(404).json({ error: "Template not found." });
      return;
    }
    const parsed = templatePatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid template update." });
      return;
    }
    const name = parsed.data.name ?? row.name;
    const styleJson = parsed.data.style ? JSON.stringify(parsed.data.style) : row.style_json;
    getDb()
      .prepare("UPDATE caption_templates SET name = ?, style_json = ?, updated_at = ? WHERE id = ?")
      .run(name, styleJson, nowIso(), row.id);
    res.json({ template: publicTemplateRow(userTemplate(req.user!.id, row.id)!) });
  });

  router.delete("/caption-templates/:id", requireAuth, (req: AuthedRequest, res) => {
    if (builtinTemplate(req.params.id)) {
      res.status(400).json({ error: "Built-in templates cannot be deleted." });
      return;
    }
    const row = userTemplate(req.user!.id, req.params.id);
    if (!row) {
      res.status(404).json({ error: "Template not found." });
      return;
    }
    getDb().prepare("DELETE FROM caption_templates WHERE id = ?").run(row.id);
    res.json({ ok: true });
  });

  router.post("/caption-templates/:id/duplicate", requireAuth, (req: AuthedRequest, res) => {
    const parsed = z
      .object({ name: z.string().trim().min(1).max(80).optional() })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid duplicate request." });
      return;
    }
    const builtin = builtinTemplate(req.params.id);
    const custom = builtin ? undefined : userTemplate(req.user!.id, req.params.id);
    if (!builtin && !custom) {
      res.status(404).json({ error: "Template not found." });
      return;
    }
    const sourceName = builtin ? builtin.name : custom!.name;
    const sourceStyle = builtin ? builtin.style : parseJson<CaptionStyleConfig>(custom!.style_json, DEFAULT_CAPTION_STYLE);
    const row: CaptionTemplateRow = {
      id: newId(),
      user_id: req.user!.id,
      name: parsed.data.name ?? `${sourceName} copy`,
      style_json: JSON.stringify(sourceStyle),
      based_on: req.params.id,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    getDb()
      .prepare(
        "INSERT INTO caption_templates (id, user_id, name, style_json, based_on, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(row.id, row.user_id, row.name, row.style_json, row.based_on, row.created_at, row.updated_at);
    res.status(201).json({ template: publicTemplateRow(row) });
  });
}

// ---- document caption-studio routes ------------------------------------------------------------

interface TranscriptSegmentLike {
  start_sec: number;
  end_sec: number;
  text: string;
  words_json: string | null;
}

/**
 * Map the project's latest transcript through the document's current
 * main-track items (the regenerate path — the same source-window math
 * the editor seed uses, generalised to every main item and honouring
 * item speed). Timings are only copied/shifted from the transcript.
 */
function captionsFromTranscript(
  doc: ClipVersionRow,
  state: EditorState,
): { captions: CaptionState[]; language: string } | null {
  const db = getDb();
  const transcript = db
    .prepare("SELECT * FROM transcripts WHERE project_id = ? ORDER BY rowid DESC LIMIT 1")
    .get(doc.project_id) as { id: string; source_asset_id: string; language: string | null } | undefined;
  if (!transcript) return null;
  const segments = db
    .prepare("SELECT * FROM transcript_segments WHERE transcript_id = ? ORDER BY idx ASC")
    .all(transcript.id) as unknown as TranscriptSegmentLike[];
  const mainTrack = state.tracks.find((t) => t.kind === "main");
  if (!mainTrack) return { captions: [], language: transcript.language ?? "en" };
  const items = state.items
    .filter((i) => i.trackId === mainTrack.id)
    .sort((a, b) => a.start - b.start);
  const language = transcript.language ?? "en";
  const out: CaptionState[] = [];
  for (const item of items) {
    let underlying: string | null = null;
    if (item.assetKind === "source") underlying = item.assetId;
    else if (item.assetKind === "candidate") {
      const cand = db
        .prepare("SELECT source_asset_id FROM candidate_clips WHERE id = ?")
        .get(item.assetId) as { source_asset_id: string } | undefined;
      underlying = cand?.source_asset_id ?? null;
    }
    if (underlying !== transcript.source_asset_id) continue;
    for (const seg of segments) {
      if (seg.end_sec <= item.sourceIn || seg.start_sec >= item.sourceOut) continue;
      const start = round3(item.start + (Math.max(seg.start_sec, item.sourceIn) - item.sourceIn) / item.speed);
      const end = round3(item.start + (Math.min(seg.end_sec, item.sourceOut) - item.sourceIn) / item.speed);
      if (end <= start) continue;
      const words = seg.words_json
        ? parseJson<{ start: number; end: number; word: string; probability?: number | null }[]>(seg.words_json, [])
            .filter((w) => w.end > item.sourceIn && w.start < item.sourceOut)
            .map((w) => ({
              start: round3(item.start + (Math.max(w.start, item.sourceIn) - item.sourceIn) / item.speed),
              end: round3(item.start + (Math.min(w.end, item.sourceOut) - item.sourceIn) / item.speed),
              word: w.word.trim(),
              probability: w.probability ?? null,
            }))
            .filter((w) => w.word.length > 0 && w.end > w.start)
        : null;
      out.push({
        id: newId(),
        start,
        end,
        text: seg.text,
        words: words && words.length > 0 ? words : null,
        style: null,
        language,
      });
    }
  }
  out.sort((a, b) => a.start - b.start);
  return { captions: out, language };
}

/**
 * Content equality for the regenerate contract: two caption sets are
 * "the same" when every segment matches on text/start/end/language in
 * order (ids and word timings are regenerated artefacts, not content).
 * Both sides are start-ordered (readState orders by start_sec; the
 * builder sorts by start).
 */
function captionsEquivalent(a: CaptionState[], b: CaptionState[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((c, i) => {
    const o = b[i];
    return (
      c.text === o.text &&
      c.start === o.start &&
      c.end === o.end &&
      (c.language ?? "en") === (o.language ?? "en")
    );
  });
}

const regenerateBodySchema = z.object({ confirm: z.boolean().optional() });

function registerStudioRoutes(router: express.Router, requireAuth: RequireAuth): void {
  const tmpDir = path.join(config.mediaDir, ".tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const subtitleUpload = multer({
    storage: multer.diskStorage({
      destination: tmpDir,
      filename: (_req, _file, cb) => cb(null, `${newId()}.part`),
    }),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  });

  router.get("/captions/fonts", requireAuth, (_req: AuthedRequest, res) => {
    const fonts = availableFonts();
    res.json({
      fonts,
      defaultFont: fonts.includes("Noto Sans") ? "Noto Sans" : (fonts[0] ?? "DejaVu Sans"),
      devanagariFont: fonts.includes("Noto Sans Devanagari") ? "Noto Sans Devanagari" : null,
    });
  });

  router.get("/editor/:docId/caption-studio", requireAuth, (req: AuthedRequest, res) => {
    const doc = docById(req.user!.id, req.params.docId);
    if (!doc) {
      res.status(404).json({ error: "Editor document not found." });
      return;
    }
    res.json({ studio: studioPayload(req.user!.id, doc) });
  });

  // -- Regenerate captions from the project's real transcript --
  router.post("/editor/:docId/captions/regenerate", requireAuth, (req: AuthedRequest, res) => {
    const doc = docById(req.user!.id, req.params.docId);
    if (!doc) {
      res.status(404).json({ error: "Editor document not found." });
      return;
    }
    const state = readState(doc);
    ensureActiveTrack(req.user!.id, doc, state);
    const built = captionsFromTranscript(doc, state);
    if (!built) {
      res.status(400).json({
        error: "This project has no transcript yet. Run “Find Clips” analysis on the project first — captions are generated from that transcript.",
      });
      return;
    }
    if (built.captions.length === 0) {
      res.status(400).json({
        error: "The transcript does not overlap the clips currently on the main track, so no captions could be generated.",
      });
      return;
    }
    // Confirmation contract: regenerating replaces the document's
    // current captions wholesale, so a caller whose captions differ
    // from the transcript-derived set (i.e. they hold edits) must
    // explicitly confirm. A set that already matches is a true no-op.
    const parsedBody = regenerateBodySchema.safeParse(req.body ?? {});
    const confirm = parsedBody.success && parsedBody.data.confirm === true;
    if (captionsEquivalent(state.captions, built.captions)) {
      res.json({
        document: publicDocument(doc),
        studio: studioPayload(req.user!.id, doc),
        generated: built.captions.length,
      });
      return;
    }
    if (!confirm) {
      res.status(409).json({
        error: "Regenerating will replace the current captions, including any edits. Send confirm: true to proceed.",
        code: "CONFIRMATION_REQUIRED",
      });
      return;
    }
    const next: EditorState = { ...state, captions: built.captions };
    const checked = validateState(req.user!.id, doc.project_id, next);
    if (!checked.ok) {
      res.status(400).json({ error: checked.error });
      return;
    }
    const updated = commitOperation(doc, "captions_regenerate", checked.state);
    // The active track is the original-language track again.
    const db = getDb();
    const track = activeTrackRow(updated.id)!;
    db.prepare("UPDATE caption_tracks SET language = ?, kind = 'original', label = ?, updated_at = ? WHERE id = ?")
      .run(built.language, `Original (${built.language})`, nowIso(), track.id);
    syncActiveTrackSegments(updated, readState(updated));
    res.json({
      document: publicDocument(updated),
      studio: studioPayload(req.user!.id, updated),
      generated: built.captions.length,
    });
  });

  // -- Subtitle import (SRT / VTT) --
  router.post("/editor/:docId/captions/import", requireAuth, (req: AuthedRequest, res) => {
    const doc = docById(req.user!.id, req.params.docId);
    if (!doc) {
      res.status(404).json({ error: "Editor document not found." });
      return;
    }
    subtitleUpload.single("file")(req, res, (err: unknown) => {
      const fail = (status: number, message: string) => {
        if (!res.headersSent) res.status(status).json({ error: message });
      };
      try {
        if (err) {
          const multerErr = err as { code?: string };
          if (multerErr.code === "LIMIT_FILE_SIZE") fail(413, "Subtitle files are limited to 5 MB.");
          else fail(400, "The subtitle upload could not be read.");
          return;
        }
        const file = (req as Request & { file?: Express.Multer.File }).file;
        if (!file) {
          fail(400, "No file was received. Choose an .srt or .vtt file and try again.");
          return;
        }
        const ext = extensionOf(file.originalname);
        const content = fs.readFileSync(file.path, "utf8");
        fs.rmSync(file.path, { force: true });
        if (ext !== "srt" && ext !== "vtt") {
          fail(400, "Only .srt and .vtt subtitle files can be imported.");
          return;
        }
        const parsed = parseSubtitles(content, ext);
        if (!parsed.ok) {
          fail(422, `This subtitle file is not valid: ${parsed.error}`);
          return;
        }
        const body = (req.body ?? {}) as Record<string, unknown>;
        const mode = body.mode === "new-track" ? "new-track" : "replace-active";
        const language =
          typeof body.language === "string" && body.language.trim() ? body.language.trim().slice(0, 8) : null;

        if (mode === "new-track") {
          if (!language) {
            fail(400, "A language is required when importing subtitles as a separate track.");
            return;
          }
          if (parsed.segments.length > 2000) {
            fail(422, "This subtitle file has more than 2000 cues, which is the per-track limit.");
            return;
          }
          const kind = body.kind === "translation" ? "translation" : "manual";
          const label =
            typeof body.label === "string" && body.label.trim()
              ? body.label.trim().slice(0, 80)
              : kind === "translation"
                ? `Translation (${language})`
                : `Manual (${language})`;
          const track: CaptionTrackRow = {
            id: newId(),
            version_id: doc.id,
            user_id: req.user!.id,
            project_id: doc.project_id,
            language,
            kind,
            label,
            is_active: 0,
            created_at: nowIso(),
            updated_at: nowIso(),
          };
          const db = getDb();
          db.prepare(
            "INSERT INTO caption_tracks (id, version_id, user_id, project_id, language, kind, label, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
          ).run(track.id, track.version_id, track.user_id, track.project_id, track.language, track.kind, track.label, track.created_at, track.updated_at);
          const ins = db.prepare(
            "INSERT INTO caption_track_segments (id, track_id, start_sec, end_sec, text, words_json, style_json, created_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)",
          );
          for (const s of parsed.segments) {
            ins.run(newId(), track.id, s.start, s.end, s.text, nowIso());
          }
          res.status(201).json({ track: publicTrack(track), imported: parsed.segments.length });
          return;
        }

        // replace-active: the imported set becomes the document's
        // captions through a normal (undoable) operation. Imported
        // cues carry NO word timings — that limitation is real and is
        // reported by the studio payload (hasWordTimestamps).
        const state = readState(doc);
        const active = ensureActiveTrack(req.user!.id, doc, state);
        const captionLanguage = language ?? active.language;
        const next: EditorState = {
          ...state,
          captions: parsed.segments.map((s) => ({
            id: newId(),
            start: s.start,
            end: s.end,
            text: s.text,
            words: null,
            style: null,
            language: captionLanguage,
          })),
        };
        const checked = validateState(req.user!.id, doc.project_id, next);
        if (!checked.ok) {
          fail(400, checked.error);
          return;
        }
        const updated = commitOperation(doc, "captions_import", checked.state);
        syncActiveTrackSegments(updated, readState(updated));
        if (language) {
          // Keep the active track row's language in step with the
          // language stamped on the imported captions, so the track
          // label and export filename do not lag behind.
          getDb()
            .prepare("UPDATE caption_tracks SET language = ?, updated_at = ? WHERE id = ?")
            .run(language, nowIso(), active.id);
        }
        res.json({
          document: publicDocument(updated),
          studio: studioPayload(req.user!.id, updated),
          imported: parsed.segments.length,
        });
      } catch (handlerErr) {
        console.error("[captions] import failed:", handlerErr);
        fail(500, "The subtitle import failed on the server. Please retry.");
      }
    });
  });

  // -- Subtitle export (SRT / VTT), synced to the edited timeline --
  router.get("/editor/:docId/captions/export", requireAuth, (req: AuthedRequest, res) => {
    const doc = docById(req.user!.id, req.params.docId);
    if (!doc) {
      res.status(404).json({ error: "Editor document not found." });
      return;
    }
    const formatParam = typeof req.query.format === "string" ? req.query.format : undefined;
    if (formatParam !== undefined && formatParam !== "srt" && formatParam !== "vtt") {
      res.status(400).json({
        error: `Unsupported subtitle format "${formatParam}". Use format=srt or format=vtt.`,
      });
      return;
    }
    const format = formatParam === "vtt" ? "vtt" : "srt";
    const state = readState(doc);
    ensureActiveTrack(req.user!.id, doc, state);
    let segments: SubtitleSegment[];
    let language = state.captions[0]?.language ?? "captions";
    const trackId = typeof req.query.trackId === "string" ? req.query.trackId : null;
    if (trackId) {
      const track = trackRows(doc.id).find((t) => t.id === trackId);
      if (!track) {
        res.status(404).json({ error: "Caption track not found." });
        return;
      }
      if (track.is_active === 1) {
        segments = state.captions.map((c) => ({ start: c.start, end: c.end, text: c.text }));
      } else {
        segments = storedSegments(track).map((c) => ({ start: c.start, end: c.end, text: c.text }));
      }
      language = track.language;
    } else {
      segments = state.captions.map((c) => ({ start: c.start, end: c.end, text: c.text }));
    }
    if (segments.length === 0) {
      res.status(400).json({ error: "There are no captions to export yet." });
      return;
    }
    const body = format === "vtt" ? buildVttText(segments) : buildSrtText(segments);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="clipforge-captions-${language}.${format}"`,
    );
    res.send(body);
  });

  // -- Manual caption track (typed by the user; original untouched) --
  const manualTrackSchema = z.object({
    language: z.string().trim().min(2).max(8),
    kind: z.enum(["manual", "translation"]).optional().default("manual"),
    label: z.string().trim().min(1).max(80).optional(),
    segments: z
      .array(
        z.object({
          start: z.number().min(0).max(86400),
          end: z.number().min(0).max(86400),
          text: z.string().trim().min(1).max(500),
        }),
      )
      .min(1)
      .max(2000),
  });

  router.post("/editor/:docId/caption-tracks", requireAuth, (req: AuthedRequest, res) => {
    const doc = docById(req.user!.id, req.params.docId);
    if (!doc) {
      res.status(404).json({ error: "Editor document not found." });
      return;
    }
    const parsed = manualTrackSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "A caption track needs a language and at least one valid segment (end after start, text up to 500 characters)." });
      return;
    }
    if (parsed.data.segments.some((s) => s.end <= s.start)) {
      res.status(400).json({ error: "Every segment must end after it starts." });
      return;
    }
    const track: CaptionTrackRow = {
      id: newId(),
      version_id: doc.id,
      user_id: req.user!.id,
      project_id: doc.project_id,
      language: parsed.data.language,
      kind: parsed.data.kind,
      label:
        parsed.data.label ??
        (parsed.data.kind === "translation"
          ? `Translation (${parsed.data.language})`
          : `Manual (${parsed.data.language})`),
      is_active: 0,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    const db = getDb();
    db.prepare(
      "INSERT INTO caption_tracks (id, version_id, user_id, project_id, language, kind, label, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
    ).run(track.id, track.version_id, track.user_id, track.project_id, track.language, track.kind, track.label, track.created_at, track.updated_at);
    const ins = db.prepare(
      "INSERT INTO caption_track_segments (id, track_id, start_sec, end_sec, text, words_json, style_json, created_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)",
    );
    for (const s of [...parsed.data.segments].sort((a, b) => a.start - b.start)) {
      ins.run(newId(), track.id, round3(s.start), round3(s.end), s.text, nowIso());
    }
    res.status(201).json({ track: publicTrack(track) });
  });

  // -- Switch the active caption track (original stays stored) --
  router.post("/editor/:docId/caption-tracks/:trackId/activate", requireAuth, (req: AuthedRequest, res) => {
    const doc = docById(req.user!.id, req.params.docId);
    if (!doc) {
      res.status(404).json({ error: "Editor document not found." });
      return;
    }
    const state = readState(doc);
    ensureActiveTrack(req.user!.id, doc, state);
    syncActiveTrackSegments(doc, state); // persist current edits first
    const target = trackRows(doc.id).find((t) => t.id === req.params.trackId);
    if (!target) {
      res.status(404).json({ error: "Caption track not found." });
      return;
    }
    if (target.is_active === 1) {
      res.json({ document: publicDocument(doc), studio: studioPayload(req.user!.id, doc) });
      return;
    }
    const next: EditorState = { ...state, captions: storedSegments(target) };
    const checked = validateState(req.user!.id, doc.project_id, next);
    if (!checked.ok) {
      res.status(400).json({ error: checked.error });
      return;
    }
    const updated = commitOperation(doc, "caption_track_switch", checked.state);
    const db = getDb();
    db.prepare("UPDATE caption_tracks SET is_active = 0 WHERE version_id = ?").run(doc.id);
    db.prepare("UPDATE caption_tracks SET is_active = 1, updated_at = ? WHERE id = ?").run(nowIso(), target.id);
    syncActiveTrackSegments(updated, readState(updated));
    res.json({
      document: publicDocument(updated),
      studio: studioPayload(req.user!.id, updated),
    });
  });

  // -- Translation jobs (provider adapter; honest CONFIGURATION failure) --
  const translationSchema = z.object({
    targetLanguage: z.string().trim().min(2).max(8),
  });

  const publicJob = (j: TranslationJobRow) => ({
    id: j.id,
    documentId: j.version_id,
    projectId: j.project_id,
    sourceLanguage: j.source_language,
    targetLanguage: j.target_language,
    provider: j.provider,
    status: j.status,
    error: j.error,
    errorCode: j.error_code,
    resultTrackId: j.result_track_id,
    createdAt: j.created_at,
    updatedAt: j.updated_at,
    finishedAt: j.finished_at,
  });

  router.get("/editor/:docId/translation-jobs", requireAuth, (req: AuthedRequest, res) => {
    const doc = docById(req.user!.id, req.params.docId);
    if (!doc) {
      res.status(404).json({ error: "Editor document not found." });
      return;
    }
    const rows = getDb()
      .prepare("SELECT * FROM translation_jobs WHERE version_id = ? ORDER BY created_at DESC, rowid DESC")
      .all(doc.id) as unknown as TranslationJobRow[];
    res.json({ jobs: rows.map(publicJob), translationConfigured });
  });

  router.post("/editor/:docId/translation-jobs", requireAuth, (req: AuthedRequest, res) => {
    const doc = docById(req.user!.id, req.params.docId);
    if (!doc) {
      res.status(404).json({ error: "Editor document not found." });
      return;
    }
    const parsed = translationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Choose a target language for the translation." });
      return;
    }
    const state = readState(doc);
    const active = ensureActiveTrack(req.user!.id, doc, state);
    const targetLanguage = parsed.data.targetLanguage;
    if (targetLanguage === active.language) {
      res.status(400).json({ error: `The active captions are already in ${targetLanguage}.` });
      return;
    }
    const db = getDb();
    // No duplicate in-flight jobs for the same document + language.
    const inflight = db
      .prepare(
        "SELECT * FROM translation_jobs WHERE version_id = ? AND target_language = ? AND status IN ('QUEUED', 'RUNNING') ORDER BY rowid DESC LIMIT 1",
      )
      .get(doc.id, targetLanguage) as TranslationJobRow | undefined;
    if (inflight) {
      res.json({ job: publicJob(inflight), deduplicated: true });
      return;
    }
    // A previous job for the same document + language that failed
    // because translation is not configured would fail identically —
    // return it instead of piling up duplicate failures. (Once a
    // provider IS configured, new jobs run normally again.)
    const configFailed = db
      .prepare(
        "SELECT * FROM translation_jobs WHERE version_id = ? AND target_language = ? AND status = 'FAILED' AND error_code = 'CONFIGURATION_ERROR' ORDER BY rowid DESC LIMIT 1",
      )
      .get(doc.id, targetLanguage) as TranslationJobRow | undefined;
    if (configFailed) {
      res.status(422).json({
        error: configFailed.error,
        code: "CONFIGURATION_ERROR",
        job: publicJob(configFailed),
        deduplicated: true,
      });
      return;
    }
    const job: TranslationJobRow = {
      id: newId(),
      user_id: req.user!.id,
      project_id: doc.project_id,
      version_id: doc.id,
      source_language: active.language,
      target_language: targetLanguage,
      provider: config.translation.provider || "none",
      status: "QUEUED",
      error: null,
      error_code: null,
      result_track_id: null,
      created_at: nowIso(),
      updated_at: nowIso(),
      finished_at: null,
    };
    db.prepare(
      `INSERT INTO translation_jobs (id, user_id, project_id, version_id, source_language, target_language, provider, status, error, error_code, result_track_id, created_at, updated_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'QUEUED', NULL, NULL, NULL, ?, ?, NULL)`,
    ).run(job.id, job.user_id, job.project_id, job.version_id, job.source_language, job.target_language, job.provider, job.created_at, job.updated_at);

    // Provider adapter: this build ships no translation provider
    // client and no API key is configured, so the job fails honestly
    // instead of inventing a translation. Manual tracks + subtitle
    // import remain the working paths, and the original is untouched.
    const message = !config.translation.provider || !config.translation.apiKey
      ? "Translation is not configured on this server — no translation provider or API key is set. You can add a manual translation track or import a translated subtitle file instead; your original captions are unchanged."
      : `The '${config.translation.provider}' translation provider is named in configuration, but no client for it is available in this build. Your original captions are unchanged.`;
    db.prepare(
      "UPDATE translation_jobs SET status = 'FAILED', error = ?, error_code = 'CONFIGURATION_ERROR', finished_at = ?, updated_at = ? WHERE id = ?",
    ).run(message, nowIso(), nowIso(), job.id);
    const failed = db
      .prepare("SELECT * FROM translation_jobs WHERE id = ?")
      .get(job.id) as unknown as TranslationJobRow;
    res.status(422).json({ error: message, code: "CONFIGURATION_ERROR", job: publicJob(failed) });
  });
}

// ---- Brand Kit ---------------------------------------------------------------------------------

function publicAsset(a: BrandAssetRow) {
  return {
    id: a.id,
    kind: a.kind,
    filename: a.original_filename,
    fileSize: a.file_size,
    duration: a.duration,
    width: a.width,
    height: a.height,
    hasAudio: a.has_audio === null ? null : a.has_audio === 1,
    hasVideo: a.has_video === null ? null : a.has_video === 1,
    container: a.container,
    streamUrl: `/api/brand-assets/${a.id}/stream`,
    createdAt: a.created_at,
  };
}

function publicKit(k: BrandKitRow) {
  return {
    id: k.id,
    name: k.name,
    brandName: k.brand_name,
    primaryColor: k.primary_color,
    secondaryColor: k.secondary_color,
    accentColor: k.accent_color,
    fontFamily: k.font_family,
    captionTemplateId: k.caption_template_id,
    captionStyle: k.caption_style_json
      ? parseJson<CaptionStyleConfig | null>(k.caption_style_json, null)
      : null,
    logoAssetId: k.logo_asset_id,
    introAssetId: k.intro_asset_id,
    outroAssetId: k.outro_asset_id,
    musicAssetId: k.music_asset_id,
    overlayAssetId: k.overlay_asset_id,
    isDefault: k.is_default === 1,
    createdAt: k.created_at,
    updatedAt: k.updated_at,
  };
}

function kitRow(userId: string, id: string): BrandKitRow | undefined {
  // Phase 12: brand kits are workspace-scoped — members of the active
  // workspace can use its kits; a kit from any other workspace reads
  // as not-found (404), never leaked. Legacy rows stay owner-only.
  const wsId = currentWorkspaceId(userId);
  const row = getDb()
    .prepare("SELECT * FROM brand_kits WHERE id = ?")
    .get(id) as BrandKitRow | undefined;
  if (!row) return undefined;
  if (row.workspace_id) {
    return wsId && row.workspace_id === wsId ? row : undefined;
  }
  return row.user_id === userId ? row : undefined;
}

function assetRow(userId: string, id: string): BrandAssetRow | undefined {
  return getDb()
    .prepare("SELECT * FROM brand_assets WHERE id = ? AND user_id = ?")
    .get(id, userId) as BrandAssetRow | undefined;
}

/**
 * Seed the user's default kit with the approved CLIPFORGE identity:
 * the exact brand colours and — as the logo asset — a byte-identical
 * copy of the approved logo file that ships with the app (never
 * redrawn or regenerated). Runs once per user, on first kit access.
 */
function ensureDefaultKit(userId: string): void {
  const db = getDb();
  // Phase 12: the seed belongs to the caller's ACTIVE workspace; a
  // freshly switched-to workspace with no kits of its own gets its own
  // seeded default (the documented Phase 6 quirk, now per workspace).
  const wsId = currentWorkspaceId(userId);
  const count = db
    .prepare(
      "SELECT COUNT(*) AS n FROM brand_kits WHERE workspace_id = ? OR (workspace_id IS NULL AND user_id = ?)",
    )
    .get(wsId, userId) as { n: number };
  if (count.n > 0) return;
  let logoAssetId: string | null = null;
  try {
    const src = path.join(serverDir, "..", "public", "assets", "clipforge-logo.svg");
    if (fs.existsSync(src)) {
      const assetId = newId();
      const storageKey = `${userId}/brand/${assetId}.svg`;
      fs.mkdirSync(path.dirname(mediaPath(storageKey)), { recursive: true });
      fs.copyFileSync(src, mediaPath(storageKey));
      const size = fs.statSync(mediaPath(storageKey)).size;
      db.prepare(
        `INSERT INTO brand_assets (id, user_id, kind, original_filename, storage_key, storage_provider, file_size, duration, width, height, has_audio, has_video, container, created_at)
         VALUES (?, ?, 'LOGO', 'clipforge-logo.svg', ?, 'local', ?, NULL, NULL, NULL, 0, 0, 'svg', ?)`,
      ).run(assetId, userId, storageKey, size, nowIso());
      logoAssetId = assetId;
    }
  } catch {
    logoAssetId = null; // kit still seeds; the logo slot stays empty
  }
  const now = nowIso();
  db.prepare(
    `INSERT INTO brand_kits (id, user_id, name, brand_name, primary_color, secondary_color, accent_color, font_family, caption_template_id, caption_style_json, logo_asset_id, intro_asset_id, outro_asset_id, music_asset_id, overlay_asset_id, is_default, created_at, updated_at, workspace_id)
     VALUES (?, ?, 'CLIPFORGE Brand', 'CLIPFORGE', '#1558C9', '#030407', '#D4FF24', 'Noto Sans', ?, NULL, ?, NULL, NULL, NULL, NULL, 1, ?, ?, ?)`,
  ).run(newId(), userId, CLIPFORGE_SIGNATURE_TEMPLATE_ID, logoAssetId, now, now, wsId);
}

const kitCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  brandName: z.string().trim().min(1).max(80),
  primaryColor: hexColor,
  secondaryColor: hexColor,
  accentColor: hexColor,
  fontFamily: z.string().trim().max(80).nullable().optional(),
  captionTemplateId: z.string().max(128).nullable().optional(),
  captionStyle: captionStyleSchema.nullable().optional(),
  logoAssetId: z.string().max(128).nullable().optional(),
  introAssetId: z.string().max(128).nullable().optional(),
  outroAssetId: z.string().max(128).nullable().optional(),
  musicAssetId: z.string().max(128).nullable().optional(),
  overlayAssetId: z.string().max(128).nullable().optional(),
});

const kitPatchSchema = kitCreateSchema.partial();

/** The caption style a kit applies: its own style if set, else the
 *  style of the template it points at; the kit font wins if set. */
function resolveKitStyle(userId: string, kit: BrandKitRow): CaptionStyleConfig | null {
  let style: CaptionStyleConfig | null = kit.caption_style_json
    ? parseJson<CaptionStyleConfig | null>(kit.caption_style_json, null)
    : null;
  if (!style && kit.caption_template_id) {
    const builtin = builtinTemplate(kit.caption_template_id);
    if (builtin) style = { ...builtin.style };
    else {
      const custom = userTemplate(userId, kit.caption_template_id);
      if (custom) style = parseJson<CaptionStyleConfig>(custom.style_json, DEFAULT_CAPTION_STYLE);
    }
  }
  if (style && kit.font_family) style = { ...style, fontFamily: kit.font_family };
  return style;
}

const BRAND_ASSET_EXTENSIONS: Record<BrandAssetRow["kind"], string[]> = {
  LOGO: ["png", "jpg", "jpeg", "svg", "webp", "gif"],
  OVERLAY: ["png", "jpg", "jpeg", "svg", "webp", "gif"],
  INTRO: ["mp4", "mov", "webm", "png", "jpg", "jpeg", "webp"],
  OUTRO: ["mp4", "mov", "webm", "png", "jpg", "jpeg", "webp"],
  MUSIC: ["mp3", "wav", "m4a", "ogg", "flac"],
  OTHER: ["png", "jpg", "jpeg", "svg", "webp", "gif", "mp4", "mov", "webm", "mp3", "wav", "m4a", "ogg", "flac"],
};
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "svg", "webp", "gif"];

/** Magic-byte sniff for image uploads (extension alone is not proof). */
function sniffImageKind(filePath: string, ext: string): boolean {
  const fd = fs.openSync(filePath, "r");
  const buf = Buffer.alloc(512);
  const read = fs.readSync(fd, buf, 0, 512, 0);
  fs.closeSync(fd);
  const head = buf.subarray(0, read);
  switch (ext) {
    case "png":
      return head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
    case "jpg":
    case "jpeg":
      return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    case "gif":
      return head.subarray(0, 4).toString("latin1") === "GIF8";
    case "webp":
      return (
        head.subarray(0, 4).toString("latin1") === "RIFF" &&
        head.subarray(8, 12).toString("latin1") === "WEBP"
      );
    case "svg": {
      const text = head.toString("utf8");
      return text.includes("<svg");
    }
    default:
      return false;
  }
}

const BRAND_CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  svg: "image/svg+xml",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  flac: "audio/flac",
};

function registerBrandRoutes(router: express.Router, requireAuth: RequireAuth): void {
  const tmpDir = path.join(config.mediaDir, ".tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const assetUpload = multer({
    storage: multer.diskStorage({
      destination: tmpDir,
      filename: (_req, _file, cb) => cb(null, `${newId()}.part`),
    }),
    limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 },
  });

  // -- Assets --
  router.post("/brand-assets", requireAuth, (req: AuthedRequest, res) => {
    assetUpload.single("file")(req, res, async (err: unknown) => {
      const fail = (status: number, message: string) => {
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
          fail(400, "No file was received. Choose a brand asset file and try again.");
          return;
        }
        const kindRaw = typeof req.body?.kind === "string" ? req.body.kind : "OTHER";
        const kind = (Object.keys(BRAND_ASSET_EXTENSIONS).includes(kindRaw) ? kindRaw : "OTHER") as BrandAssetRow["kind"];
        const ext = extensionOf(file.originalname);
        const allowed = BRAND_ASSET_EXTENSIONS[kind];
        if (!allowed.includes(ext)) {
          fs.rmSync(file.path, { force: true });
          fail(400, `A ${kind.toLowerCase()} asset must be one of: ${allowed.map((e) => `.${e}`).join(", ")}.`);
          return;
        }
        const assetId = newId();
        const storageKey = `${req.user!.id}/brand/${assetId}.${ext}`;
        fs.mkdirSync(path.dirname(mediaPath(storageKey)), { recursive: true });
        fs.renameSync(file.path, mediaPath(storageKey));
        const stored = mediaPath(storageKey);
        let duration: number | null = null;
        let width: number | null = null;
        let height: number | null = null;
        let hasAudio: number | null = null;
        let hasVideo: number | null = null;
        let container: string | null = ext;
        if (IMAGE_EXTENSIONS.includes(ext)) {
          if (!sniffImageKind(stored, ext)) {
            fs.rmSync(stored, { force: true });
            fail(422, "This file's contents do not match an image of that type.");
            return;
          }
          hasAudio = 0;
          hasVideo = 0;
        } else {
          try {
            const meta = await probeAnyFile(stored);
            if (kind === "MUSIC" && !meta.hasAudio) throw new Error("no audio stream");
            if ((kind === "INTRO" || kind === "OUTRO") && !meta.hasVideo) throw new Error("no video stream");
            duration = meta.duration;
            width = meta.width;
            height = meta.height;
            hasAudio = meta.hasAudio ? 1 : 0;
            hasVideo = meta.hasVideo ? 1 : 0;
            container = meta.container ?? ext;
          } catch {
            fs.rmSync(stored, { force: true });
            fail(422, "This file could not be read as the media type its extension claims.");
            return;
          }
        }
        const row: BrandAssetRow = {
          id: assetId,
          user_id: req.user!.id,
          kind,
          original_filename: file.originalname,
          storage_key: storageKey,
          storage_provider: "local",
          file_size: file.size,
          duration,
          width,
          height,
          has_audio: hasAudio,
          has_video: hasVideo,
          container,
          created_at: nowIso(),
        };
        getDb()
          .prepare(
            `INSERT INTO brand_assets (id, user_id, kind, original_filename, storage_key, storage_provider, file_size, duration, width, height, has_audio, has_video, container, created_at)
             VALUES (?, ?, ?, ?, ?, 'local', ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(row.id, row.user_id, row.kind, row.original_filename, row.storage_key, row.file_size, row.duration, row.width, row.height, row.has_audio, row.has_video, row.container, row.created_at);
        res.status(201).json({ asset: publicAsset(row) });
      } catch (handlerErr) {
        console.error("[captions] brand asset upload failed:", handlerErr);
        fail(500, "The upload failed on the server. Please retry.");
      }
    });
  });

  router.get("/brand-assets", requireAuth, (req: AuthedRequest, res) => {
    const rows = getDb()
      .prepare("SELECT * FROM brand_assets WHERE user_id = ? ORDER BY created_at ASC")
      .all(req.user!.id) as unknown as BrandAssetRow[];
    res.json({ assets: rows.map(publicAsset) });
  });

  router.get("/brand-assets/:id/stream", requireAuth, (req: AuthedRequest, res) => {
    const asset = assetRow(req.user!.id, req.params.id);
    if (!asset || !asset.storage_key || !fs.existsSync(mediaPath(asset.storage_key))) {
      res.status(404).json({ error: "Brand asset not found." });
      return;
    }
    res.type(BRAND_CONTENT_TYPES[extensionOf(asset.original_filename)] ?? "application/octet-stream");
    // F-01 (stored XSS): brand assets are user uploads and may be SVG
    // (BRAND_CONTENT_TYPES svg -> image/svg+xml). An SVG containing
    // <script> served inline would execute on direct navigation to
    // this URL. `CSP: sandbox` puts the response in an opaque origin
    // and blocks script execution on navigation, while <img>-tag
    // rendering of legitimate SVG logos in the app still works — so
    // this stays inline (no Content-Disposition: attachment).
    // nosniff is also set globally in app.ts, but is set here
    // explicitly so this route is safe wherever it is mounted.
    res.setHeader("Content-Security-Policy", "sandbox");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.sendFile(mediaPath(asset.storage_key));
  });

  router.delete("/brand-assets/:id", requireAuth, (req: AuthedRequest, res) => {
    const asset = assetRow(req.user!.id, req.params.id);
    if (!asset) {
      res.status(404).json({ error: "Brand asset not found." });
      return;
    }
    if (asset.storage_key) fs.rmSync(mediaPath(asset.storage_key), { force: true });
    getDb().prepare("DELETE FROM brand_assets WHERE id = ?").run(asset.id);
    res.json({ ok: true });
  });

  // -- Kits --
  router.get("/brand-kits", requireAuth, (req: AuthedRequest, res) => {
    ensureDefaultKit(req.user!.id);
    const wsId = currentWorkspaceId(req.user!.id);
    const rows = getDb()
      .prepare(
        "SELECT * FROM brand_kits WHERE workspace_id = ? OR (workspace_id IS NULL AND user_id = ?) ORDER BY is_default DESC, created_at ASC",
      )
      .all(wsId, req.user!.id) as unknown as BrandKitRow[];
    res.json({ kits: rows.map(publicKit) });
  });

  router.post("/brand-kits", requireAuth, (req: AuthedRequest, res) => {
    ensureDefaultKit(req.user!.id);
    const parsed = kitCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "A brand kit needs a name, a brand name and valid #RRGGBB colours." });
      return;
    }
    const d = parsed.data;
    // Asset references must belong to the caller.
    for (const assetId of [d.logoAssetId, d.introAssetId, d.outroAssetId, d.musicAssetId, d.overlayAssetId]) {
      if (assetId && !assetRow(req.user!.id, assetId)) {
        res.status(400).json({ error: "One of the referenced brand assets does not exist." });
        return;
      }
    }
    const now = nowIso();
    const row: BrandKitRow = {
      id: newId(),
      user_id: req.user!.id,
      name: d.name,
      brand_name: d.brandName,
      primary_color: d.primaryColor,
      secondary_color: d.secondaryColor,
      accent_color: d.accentColor,
      font_family: d.fontFamily ?? null,
      caption_template_id: d.captionTemplateId ?? null,
      caption_style_json: d.captionStyle ? JSON.stringify(d.captionStyle) : null,
      logo_asset_id: d.logoAssetId ?? null,
      intro_asset_id: d.introAssetId ?? null,
      outro_asset_id: d.outroAssetId ?? null,
      music_asset_id: d.musicAssetId ?? null,
      overlay_asset_id: d.overlayAssetId ?? null,
      is_default: 0,
      created_at: now,
      updated_at: now,
    };
    getDb()
      .prepare(
        `INSERT INTO brand_kits (id, user_id, name, brand_name, primary_color, secondary_color, accent_color, font_family, caption_template_id, caption_style_json, logo_asset_id, intro_asset_id, outro_asset_id, music_asset_id, overlay_asset_id, is_default, created_at, updated_at, workspace_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(row.id, row.user_id, row.name, row.brand_name, row.primary_color, row.secondary_color, row.accent_color, row.font_family, row.caption_template_id, row.caption_style_json, row.logo_asset_id, row.intro_asset_id, row.outro_asset_id, row.music_asset_id, row.overlay_asset_id, row.created_at, row.updated_at, currentWorkspaceId(req.user!.id));
    res.status(201).json({ kit: publicKit(row) });
  });

  router.get("/brand-kits/:id", requireAuth, (req: AuthedRequest, res) => {
    ensureDefaultKit(req.user!.id);
    const kit = kitRow(req.user!.id, req.params.id);
    if (!kit) {
      res.status(404).json({ error: "Brand kit not found." });
      return;
    }
    res.json({ kit: publicKit(kit) });
  });

  router.patch("/brand-kits/:id", requireAuth, (req: AuthedRequest, res) => {
    const kit = kitRow(req.user!.id, req.params.id);
    if (!kit) {
      res.status(404).json({ error: "Brand kit not found." });
      return;
    }
    const parsed = kitPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid brand kit update." });
      return;
    }
    const d = parsed.data;
    for (const assetId of [d.logoAssetId, d.introAssetId, d.outroAssetId, d.musicAssetId, d.overlayAssetId]) {
      if (assetId && !assetRow(req.user!.id, assetId)) {
        res.status(400).json({ error: "One of the referenced brand assets does not exist." });
        return;
      }
    }
    const next: BrandKitRow = {
      ...kit,
      name: d.name ?? kit.name,
      brand_name: d.brandName ?? kit.brand_name,
      primary_color: d.primaryColor ?? kit.primary_color,
      secondary_color: d.secondaryColor ?? kit.secondary_color,
      accent_color: d.accentColor ?? kit.accent_color,
      font_family: d.fontFamily !== undefined ? d.fontFamily : kit.font_family,
      caption_template_id: d.captionTemplateId !== undefined ? d.captionTemplateId : kit.caption_template_id,
      caption_style_json:
        d.captionStyle !== undefined
          ? d.captionStyle
            ? JSON.stringify(d.captionStyle)
            : null
          : kit.caption_style_json,
      logo_asset_id: d.logoAssetId !== undefined ? d.logoAssetId : kit.logo_asset_id,
      intro_asset_id: d.introAssetId !== undefined ? d.introAssetId : kit.intro_asset_id,
      outro_asset_id: d.outroAssetId !== undefined ? d.outroAssetId : kit.outro_asset_id,
      music_asset_id: d.musicAssetId !== undefined ? d.musicAssetId : kit.music_asset_id,
      overlay_asset_id: d.overlayAssetId !== undefined ? d.overlayAssetId : kit.overlay_asset_id,
      updated_at: nowIso(),
    };
    getDb()
      .prepare(
        `UPDATE brand_kits SET name = ?, brand_name = ?, primary_color = ?, secondary_color = ?, accent_color = ?, font_family = ?, caption_template_id = ?, caption_style_json = ?, logo_asset_id = ?, intro_asset_id = ?, outro_asset_id = ?, music_asset_id = ?, overlay_asset_id = ?, updated_at = ? WHERE id = ?`,
      )
      .run(next.name, next.brand_name, next.primary_color, next.secondary_color, next.accent_color, next.font_family, next.caption_template_id, next.caption_style_json, next.logo_asset_id, next.intro_asset_id, next.outro_asset_id, next.music_asset_id, next.overlay_asset_id, next.updated_at, next.id);
    res.json({ kit: publicKit(next) });
  });

  router.delete("/brand-kits/:id", requireAuth, (req: AuthedRequest, res) => {
    const kit = kitRow(req.user!.id, req.params.id);
    if (!kit) {
      res.status(404).json({ error: "Brand kit not found." });
      return;
    }
    getDb().prepare("DELETE FROM brand_kits WHERE id = ?").run(kit.id);
    res.json({ ok: true });
  });

  router.post("/brand-kits/:id/duplicate", requireAuth, (req: AuthedRequest, res) => {
    const kit = kitRow(req.user!.id, req.params.id);
    if (!kit) {
      res.status(404).json({ error: "Brand kit not found." });
      return;
    }
    const now = nowIso();
    const copy: BrandKitRow = {
      ...kit,
      id: newId(),
      name: `${kit.name} copy`.slice(0, 80),
      is_default: 0,
      created_at: now,
      updated_at: now,
    };
    getDb()
      .prepare(
        `INSERT INTO brand_kits (id, user_id, name, brand_name, primary_color, secondary_color, accent_color, font_family, caption_template_id, caption_style_json, logo_asset_id, intro_asset_id, outro_asset_id, music_asset_id, overlay_asset_id, is_default, created_at, updated_at, workspace_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(copy.id, copy.user_id, copy.name, copy.brand_name, copy.primary_color, copy.secondary_color, copy.accent_color, copy.font_family, copy.caption_template_id, copy.caption_style_json, copy.logo_asset_id, copy.intro_asset_id, copy.outro_asset_id, copy.music_asset_id, copy.overlay_asset_id, copy.created_at, copy.updated_at, kit.workspace_id ?? currentWorkspaceId(req.user!.id));
    res.status(201).json({ kit: publicKit(copy) });
  });

  router.post("/brand-kits/:id/default", requireAuth, (req: AuthedRequest, res) => {
    const kit = kitRow(req.user!.id, req.params.id);
    if (!kit) {
      res.status(404).json({ error: "Brand kit not found." });
      return;
    }
    const db = getDb();
    // Phase 12: "default" is per-workspace now — clearing defaults only
    // touches kits in the kit's own workspace.
    db.prepare("UPDATE brand_kits SET is_default = 0 WHERE user_id = ? AND (workspace_id = ? OR workspace_id IS NULL)").run(
      req.user!.id,
      kit.workspace_id ?? currentWorkspaceId(req.user!.id),
    );
    db.prepare("UPDATE brand_kits SET is_default = 1, updated_at = ? WHERE id = ?").run(nowIso(), kit.id);
    res.json({ kit: publicKit(kitRow(req.user!.id, kit.id)!) });
  });

  // -- Apply a kit to one or many projects --
  const applySchema = z.object({
    projectIds: z.array(z.string().min(1).max(128)).min(1).max(50),
  });

  router.post("/brand-kits/:id/apply", requireAuth, (req: AuthedRequest, res) => {
    const kit = kitRow(req.user!.id, req.params.id);
    if (!kit) {
      res.status(404).json({ error: "Brand kit not found." });
      return;
    }
    const parsed = applySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Choose at least one project to apply the brand kit to." });
      return;
    }
    const style = resolveKitStyle(req.user!.id, kit);
    const results: { projectId: string; ok: boolean; documentId?: string; error?: string }[] = [];
    for (const projectId of parsed.data.projectIds) {
      const project: ProjectRow | undefined = ownedProject(req.user!.id, projectId);
      if (!project) {
        results.push({ projectId, ok: false, error: "Project not found." });
        continue;
      }
      try {
        const { doc } = getOrCreateDoc(req.user!.id, project, null);
        const state = readState(doc);
        if (style) state.settings.captionStyle = { ...style };
        if (kit.caption_template_id) state.settings.captionTemplateId = kit.caption_template_id;
        state.settings.brandKitId = kit.id;
        const checked = validateState(req.user!.id, project.id, state);
        if (!checked.ok) {
          results.push({ projectId, ok: false, error: checked.error });
          continue;
        }
        // Applying COPIES the kit's caption style/template into the
        // document as a normal undoable operation; later kit edits do
        // not rewrite documents that already applied it.
        commitOperation(doc, "brand_kit_apply", checked.state);
        results.push({ projectId, ok: true, documentId: doc.id });
      } catch (err) {
        results.push({
          projectId,
          ok: false,
          error: err instanceof Error ? err.message : "Applying the brand kit failed.",
        });
      }
    }
    res.json({ results });
  });
}

// ---- registration ---------------------------------------------------------------------------------

export function registerCaptionsRoutes(app: express.Express, requireAuth: RequireAuth): void {
  const router = express.Router();
  registerTemplateRoutes(router, requireAuth);
  registerStudioRoutes(router, requireAuth);
  registerBrandRoutes(router, requireAuth);
  app.use("/api", router);
}
