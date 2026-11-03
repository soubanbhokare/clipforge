/**
 * CLIPFORGE landing page — centralized media asset map.
 *
 * PHASE RULE (2026-11-02, user instruction): NO media is inserted yet.
 * Every visual area on the landing page is an empty MediaPlaceholder
 * that reserves its exact dimensions. When real assets arrive, insert
 * them by updating ONLY the `futureFile` reference for the matching
 * slot here and swapping that slot's placeholder for the real player /
 * image in its section — no layout redesign is needed.
 *
 * Slot count: 26 required locations, 40 entries in total — some
 * locations hold several slots (b-roll gallery is location 18 with
 * four slots, social proof is location 21 with six, testimonials is
 * location 22 with three, how-it-works visuals is location 25 with
 * four).
 */

export type LandingMediaType = "video" | "image";

export interface LandingAsset {
  /** Stable slot key — use this to wire a real asset in later. */
  id: string;
  /** Short code shown inside the placeholder, e.g. HERO_VIDEO_01. */
  code: string;
  type: LandingMediaType;
  /** CSS aspect-ratio value, e.g. "16 / 9". Reserved at all sizes. */
  aspectRatio: string;
  /** Human label for the ratio, e.g. "16:9". */
  aspectLabel: string;
  /** Intended future filename. Reference only — the file does not exist yet. */
  futureFile: string;
  /** Where the slot lives on the page. */
  section: string;
}

export const LANDING_ASSETS = {
  // 1 — Hero main video
  "hero-video": {
    id: "hero-video",
    code: "HERO_VIDEO_01",
    type: "video",
    aspectRatio: "16 / 9",
    aspectLabel: "16:9",
    futureFile: "hero-video.mp4",
    section: "Hero",
  },
  // 2 — Hero vertical video preview
  "hero-vertical-preview": {
    id: "hero-vertical-preview",
    code: "HERO_VERTICAL_01",
    type: "video",
    aspectRatio: "9 / 16",
    aspectLabel: "9:16",
    futureFile: "hero-vertical-preview.mp4",
    section: "Hero",
  },
  // 3 — Before video
  "before-after-original": {
    id: "before-after-original",
    code: "BEFORE_VIDEO_01",
    type: "video",
    aspectRatio: "16 / 9",
    aspectLabel: "16:9",
    futureFile: "before-video.mp4",
    section: "Before / After demo",
  },
  // 4 — After video
  "before-after-vertical": {
    id: "before-after-vertical",
    code: "AFTER_VIDEO_01",
    type: "video",
    aspectRatio: "9 / 16",
    aspectLabel: "9:16",
    futureFile: "after-video.mp4",
    section: "Before / After demo",
  },
  // 5 — Auto Face Lock demonstration
  "face-lock-demo": {
    id: "face-lock-demo",
    code: "FACE_LOCK_DEMO_01",
    type: "video",
    aspectRatio: "16 / 9",
    aspectLabel: "16:9",
    futureFile: "face-lock-demo.mp4",
    section: "Features · Auto Face Lock",
  },
  // 6 — Active Speaker demonstration
  "active-speaker-demo": {
    id: "active-speaker-demo",
    code: "ACTIVE_SPEAKER_01",
    type: "video",
    aspectRatio: "16 / 9",
    aspectLabel: "16:9",
    futureFile: "active-speaker-demo.mp4",
    section: "Features · Active Speaker",
  },
  // 7 — AI Highlight Detection demonstration
  "highlight-detection-demo": {
    id: "highlight-detection-demo",
    code: "HIGHLIGHT_DEMO_01",
    type: "video",
    aspectRatio: "16 / 9",
    aspectLabel: "16:9",
    futureFile: "highlight-detection-demo.mp4",
    section: "Features · AI Highlight Detection",
  },
  // 8 — Animated Captions demonstration
  "caption-demo": {
    id: "caption-demo",
    code: "CAPTION_DEMO_01",
    type: "video",
    aspectRatio: "9 / 16",
    aspectLabel: "9:16",
    futureFile: "caption-demo.mp4",
    section: "Features · Animated Captions",
  },
  // 9 — Professional Video Editor preview
  "editor-preview": {
    id: "editor-preview",
    code: "EDITOR_PREVIEW_01",
    type: "image",
    aspectRatio: "16 / 9",
    aspectLabel: "16:9",
    futureFile: "editor-preview.png",
    section: "Editor preview",
  },
  // 10 — Podcast Template thumbnail
  "podcast-thumbnail": {
    id: "podcast-thumbnail",
    code: "PODCAST_THUMB_01",
    type: "image",
    aspectRatio: "9 / 16",
    aspectLabel: "9:16",
    futureFile: "podcast-thumbnail.png",
    section: "Templates · Podcast",
  },
  // 11 — Gaming Template thumbnail
  "gaming-thumbnail": {
    id: "gaming-thumbnail",
    code: "GAMING_THUMB_01",
    type: "image",
    aspectRatio: "9 / 16",
    aspectLabel: "9:16",
    futureFile: "gaming-thumbnail.png",
    section: "Templates · Gaming",
  },
  // 12 — Educational Template thumbnail
  "education-thumbnail": {
    id: "education-thumbnail",
    code: "EDUCATION_THUMB_01",
    type: "image",
    aspectRatio: "9 / 16",
    aspectLabel: "9:16",
    futureFile: "education-thumbnail.png",
    section: "Templates · Educational",
  },
  // 13 — Tutorial Template thumbnail
  "tutorial-thumbnail": {
    id: "tutorial-thumbnail",
    code: "TUTORIAL_THUMB_01",
    type: "image",
    aspectRatio: "9 / 16",
    aspectLabel: "9:16",
    futureFile: "tutorial-thumbnail.png",
    section: "Templates · Tutorial",
  },
  // 14 — Gaming use-case image
  "gaming-usecase": {
    id: "gaming-usecase",
    code: "GAMING_USECASE_01",
    type: "image",
    aspectRatio: "4 / 3",
    aspectLabel: "4:3",
    futureFile: "gaming-usecase.png",
    section: "Use cases · Gaming",
  },
  // 15 — Educational use-case image
  "education-usecase": {
    id: "education-usecase",
    code: "EDUCATION_USECASE_01",
    type: "image",
    aspectRatio: "4 / 3",
    aspectLabel: "4:3",
    futureFile: "education-usecase.png",
    section: "Use cases · Education",
  },
  // 16 — Podcast use-case image
  "podcast-usecase": {
    id: "podcast-usecase",
    code: "PODCAST_USECASE_01",
    type: "image",
    aspectRatio: "4 / 3",
    aspectLabel: "4:3",
    futureFile: "podcast-usecase.png",
    section: "Use cases · Podcast",
  },
  // 17 — Business use-case image
  "business-usecase": {
    id: "business-usecase",
    code: "BUSINESS_USECASE_01",
    type: "image",
    aspectRatio: "4 / 3",
    aspectLabel: "4:3",
    futureFile: "business-usecase.png",
    section: "Use cases · Business",
  },
  // 18 — B-roll gallery images (four slots, one location)
  "b-roll-gallery-01": {
    id: "b-roll-gallery-01",
    code: "BROLL_GALLERY_01",
    type: "image",
    aspectRatio: "16 / 9",
    aspectLabel: "16:9",
    futureFile: "b-roll-gallery-01.png",
    section: "B-roll gallery",
  },
  "b-roll-gallery-02": {
    id: "b-roll-gallery-02",
    code: "BROLL_GALLERY_02",
    type: "image",
    aspectRatio: "16 / 9",
    aspectLabel: "16:9",
    futureFile: "b-roll-gallery-02.png",
    section: "B-roll gallery",
  },
  "b-roll-gallery-03": {
    id: "b-roll-gallery-03",
    code: "BROLL_GALLERY_03",
    type: "image",
    aspectRatio: "16 / 9",
    aspectLabel: "16:9",
    futureFile: "b-roll-gallery-03.png",
    section: "B-roll gallery",
  },
  "b-roll-gallery-04": {
    id: "b-roll-gallery-04",
    code: "BROLL_GALLERY_04",
    type: "image",
    aspectRatio: "16 / 9",
    aspectLabel: "16:9",
    futureFile: "b-roll-gallery-04.png",
    section: "B-roll gallery",
  },
  // 19 — Publishing demonstration
  "publishing-demo": {
    id: "publishing-demo",
    code: "PUBLISHING_DEMO_01",
    type: "video",
    aspectRatio: "16 / 9",
    aspectLabel: "16:9",
    futureFile: "publishing-demo.mp4",
    section: "Publishing",
  },
  // 20 — Additional visual media: Smart Reframing demonstration
  "reframing-demo": {
    id: "reframing-demo",
    code: "REFRAMING_DEMO_01",
    type: "video",
    aspectRatio: "16 / 9",
    aspectLabel: "16:9",
    futureFile: "reframing-demo.mp4",
    section: "Features · Smart Reframing (additional)",
  },
  // 20 — Additional visual media: Batch Clip Creation demonstration
  "batch-demo": {
    id: "batch-demo",
    code: "BATCH_DEMO_01",
    type: "video",
    aspectRatio: "16 / 9",
    aspectLabel: "16:9",
    futureFile: "batch-demo.mp4",
    section: "Features · Batch Clip Creation (additional)",
  },
  // 21 — Social Proof creator logos (six slots, one location).
  // Reserved only: no creator/brand logos are shown until real,
  // authorised logo assets are supplied.
  "social-proof-logo-01": {
    id: "social-proof-logo-01",
    code: "SOCIAL_PROOF_LOGO_01",
    type: "image",
    aspectRatio: "3 / 1",
    aspectLabel: "3:1",
    futureFile: "social-proof-logo-01.png",
    section: "Social Proof",
  },
  "social-proof-logo-02": {
    id: "social-proof-logo-02",
    code: "SOCIAL_PROOF_LOGO_02",
    type: "image",
    aspectRatio: "3 / 1",
    aspectLabel: "3:1",
    futureFile: "social-proof-logo-02.png",
    section: "Social Proof",
  },
  "social-proof-logo-03": {
    id: "social-proof-logo-03",
    code: "SOCIAL_PROOF_LOGO_03",
    type: "image",
    aspectRatio: "3 / 1",
    aspectLabel: "3:1",
    futureFile: "social-proof-logo-03.png",
    section: "Social Proof",
  },
  "social-proof-logo-04": {
    id: "social-proof-logo-04",
    code: "SOCIAL_PROOF_LOGO_04",
    type: "image",
    aspectRatio: "3 / 1",
    aspectLabel: "3:1",
    futureFile: "social-proof-logo-04.png",
    section: "Social Proof",
  },
  "social-proof-logo-05": {
    id: "social-proof-logo-05",
    code: "SOCIAL_PROOF_LOGO_05",
    type: "image",
    aspectRatio: "3 / 1",
    aspectLabel: "3:1",
    futureFile: "social-proof-logo-05.png",
    section: "Social Proof",
  },
  "social-proof-logo-06": {
    id: "social-proof-logo-06",
    code: "SOCIAL_PROOF_LOGO_06",
    type: "image",
    aspectRatio: "3 / 1",
    aspectLabel: "3:1",
    futureFile: "social-proof-logo-06.png",
    section: "Social Proof",
  },
  // 22 — Testimonials (three slots, one location).
  // Reserved only: no quotes or names are shown until real creator
  // testimonials are supplied by the creators themselves.
  "testimonial-01": {
    id: "testimonial-01",
    code: "TESTIMONIAL_01",
    type: "image",
    aspectRatio: "4 / 3",
    aspectLabel: "4:3",
    futureFile: "testimonial-01.png",
    section: "Testimonials",
  },
  "testimonial-02": {
    id: "testimonial-02",
    code: "TESTIMONIAL_02",
    type: "image",
    aspectRatio: "4 / 3",
    aspectLabel: "4:3",
    futureFile: "testimonial-02.png",
    section: "Testimonials",
  },
  "testimonial-03": {
    id: "testimonial-03",
    code: "TESTIMONIAL_03",
    type: "image",
    aspectRatio: "4 / 3",
    aspectLabel: "4:3",
    futureFile: "testimonial-03.png",
    section: "Testimonials",
  },
  // 23 — Problem section visual
  "problem-visual": {
    id: "problem-visual",
    code: "PROBLEM_VISUAL_01",
    type: "image",
    aspectRatio: "16 / 9",
    aspectLabel: "16:9",
    futureFile: "problem-visual.png",
    section: "Problem",
  },
  // 24 — Solution section visual
  "solution-visual": {
    id: "solution-visual",
    code: "SOLUTION_VISUAL_01",
    type: "image",
    aspectRatio: "16 / 9",
    aspectLabel: "16:9",
    futureFile: "solution-visual.png",
    section: "Solution",
  },
  // 25 — How It Works step visuals (four slots, one location; one
  // reserved visual per step, in step order)
  "how-step-visual-01": {
    id: "how-step-visual-01",
    code: "HOW_STEP_VISUAL_01",
    type: "image",
    aspectRatio: "16 / 9",
    aspectLabel: "16:9",
    futureFile: "how-step-01.png",
    section: "How It Works · Step 1",
  },
  "how-step-visual-02": {
    id: "how-step-visual-02",
    code: "HOW_STEP_VISUAL_02",
    type: "image",
    aspectRatio: "16 / 9",
    aspectLabel: "16:9",
    futureFile: "how-step-02.png",
    section: "How It Works · Step 2",
  },
  "how-step-visual-03": {
    id: "how-step-visual-03",
    code: "HOW_STEP_VISUAL_03",
    type: "image",
    aspectRatio: "16 / 9",
    aspectLabel: "16:9",
    futureFile: "how-step-03.png",
    section: "How It Works · Step 3",
  },
  "how-step-visual-04": {
    id: "how-step-visual-04",
    code: "HOW_STEP_VISUAL_04",
    type: "image",
    aspectRatio: "16 / 9",
    aspectLabel: "16:9",
    futureFile: "how-step-04.png",
    section: "How It Works · Step 4",
  },
  // 26 — Final CTA visual
  "final-cta-visual": {
    id: "final-cta-visual",
    code: "FINAL_CTA_VISUAL_01",
    type: "image",
    aspectRatio: "16 / 9",
    aspectLabel: "16:9",
    futureFile: "final-cta-visual.png",
    section: "Final CTA",
  },
} as const satisfies Record<string, LandingAsset>;

export type LandingAssetId = keyof typeof LANDING_ASSETS;

export function getLandingAsset(id: LandingAssetId): LandingAsset {
  return LANDING_ASSETS[id];
}
