import MediaPlaceholder from "./MediaPlaceholder";
import Reveal from "./Reveal";
import { getLandingAsset, type LandingAssetId } from "../../config/landingAssets";
import styles from "./FeatureShowcase.module.css";

/**
 * Feature showcase — every visual is an EMPTY reserved MediaPlaceholder
 * (2026-11-02 rule). No illustrations, sample timelines or decorative
 * pictures stand in for media. Each feature keeps its copy and its
 * anchored id (footer links depend on them) and gains one named slot
 * from the centralized asset map in src/config/landingAssets.ts.
 */

interface FeatureDef {
  id: string;
  headingId: string;
  title: string;
  text: string;
  assetId: LandingAssetId;
  /** Narrow centred column for 9:16 slots so they keep a sane width. */
  narrow?: boolean;
}

const FEATURES: FeatureDef[] = [
  {
    id: "face-lock",
    headingId: "face-lock-heading",
    title: "AUTO FACE LOCK",
    text: "Auto Face Lock keeps the selected subject framed during vertical conversion, so the speaker does not drift out of shot when the frame narrows. It runs on your clips in the Studio and in the editor's Reframe panel.",
    assetId: "face-lock-demo",
  },
  {
    id: "active-speaker",
    headingId: "active-speaker-heading",
    title: "ACTIVE SPEAKER DETECTION",
    text: "When more than one person is on screen, active-speaker detection follows whoever is speaking, so the vertical frame stays on the active speaker instead of a static centre crop.",
    assetId: "active-speaker-demo",
  },
  {
    id: "clip-detection",
    headingId: "clip-detection-heading",
    title: "AI HIGHLIGHT DETECTION",
    text: "The system helps you find interesting sections without manually scrubbing through the entire recording. Candidate moments are highlighted on one long timeline for review — you keep the final say on what becomes a clip.",
    assetId: "highlight-detection-demo",
  },
  {
    id: "captions",
    headingId: "captions-heading",
    title: "ANIMATED CAPTIONS",
    text: "Captions are designed to stay readable at small sizes on a phone: short lines, strong contrast, and restrained word highlighting — one word at a time, never a flashing wall of text.",
    assetId: "caption-demo",
    narrow: true,
  },
  {
    id: "reframing",
    headingId: "reframing-heading",
    title: "SMART REFRAMING",
    text: "The vertical crop follows the subject instead of cutting to the centre of the frame and hoping for the best.",
    assetId: "reframing-demo",
  },
  {
    id: "batch",
    headingId: "batch-heading",
    title: "BATCH CLIP CREATION",
    text: "Several clips can be produced from a single source video in one pass, then reviewed together before anything is exported. The Export Studio can also render a whole batch of clips in one queue.",
    assetId: "batch-demo",
  },
];

export default function FeatureShowcase() {
  return (
    <div className={styles.showcase}>
      {FEATURES.map((f) => (
        <Reveal key={f.id}>
          <section className={styles.feature} id={f.id} aria-labelledby={f.headingId}>
            <div className={styles.copy}>
              <h3 id={f.headingId}>{f.title}</h3>
              <p>{f.text}</p>
            </div>
            <div className={f.narrow ? styles.mediaNarrow : styles.media}>
              <MediaPlaceholder asset={getLandingAsset(f.assetId)} />
            </div>
          </section>
        </Reveal>
      ))}
    </div>
  );
}
