// CLIPFORGE — caption style model (Phase 6).
//
// A leaf module (imports only zod) shared by the editor (document
// settings + per-caption overrides) and the Captions Studio (ASS
// generation, templates, brand kits), so neither has to import the
// other at module-init time.

import { z } from "zod";

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

export type CaptionPosition = "top" | "upper-middle" | "center" | "lower-middle" | "bottom" | "custom";

export interface CaptionStyleConfig {
  fontFamily: string;
  fontSize: number; // px on the render canvas (ASS PlayRes = canvas px)
  fontWeight: number; // 100–900; >=600 renders bold in ASS
  italic: boolean;
  textColor: string; // #RRGGBB
  highlightColor: string; // active/sung word + keyword emphasis colour
  backgroundColor: string;
  backgroundOpacity: number; // 0 = no box, >0 = ASS opaque-box background
  outlineColor: string;
  outlineWidth: number; // px
  shadowDepth: number; // px
  letterSpacing: number; // px (ASS \fsp / style Spacing)
  lineSpacing: number; // PREVIEW ONLY — libass cannot change line height
  alignment: "left" | "center" | "right";
  casing: "none" | "upper" | "lower" | "title";
  maxWordsPerLine: number;
  maxLines: number;
  position: CaptionPosition;
  positionX: number; // 0–1 of canvas width (custom position anchor)
  positionY: number; // 0–1 of canvas height (custom position anchor)
  marginH: number; // px
  marginV: number; // px
  animation: CaptionAnimation;
}

export const hexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Colour must be a #RRGGBB hex value.");

export const captionStyleSchema = z.object({
  fontFamily: z.string().trim().min(1).max(80),
  fontSize: z.number().min(8).max(200),
  fontWeight: z.number().int().min(100).max(900),
  italic: z.boolean(),
  textColor: hexColorSchema,
  highlightColor: hexColorSchema,
  backgroundColor: hexColorSchema,
  backgroundOpacity: z.number().min(0).max(1),
  outlineColor: hexColorSchema,
  outlineWidth: z.number().min(0).max(20),
  shadowDepth: z.number().min(0).max(20),
  letterSpacing: z.number().min(-2).max(40),
  lineSpacing: z.number().min(0.8).max(2.5),
  alignment: z.enum(["left", "center", "right"]),
  casing: z.enum(["none", "upper", "lower", "title"]),
  maxWordsPerLine: z.number().int().min(1).max(20),
  maxLines: z.number().int().min(1).max(6),
  position: z.enum(["top", "upper-middle", "center", "lower-middle", "bottom", "custom"]),
  positionX: z.number().min(0).max(1),
  positionY: z.number().min(0).max(1),
  marginH: z.number().min(0).max(400),
  marginV: z.number().min(0).max(400),
  animation: z.enum([
    "none",
    "fade",
    "pop",
    "slide-up",
    "word-reveal",
    "highlight",
    "karaoke",
    "keyword-emphasis",
    "minimal",
  ]),
});

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
