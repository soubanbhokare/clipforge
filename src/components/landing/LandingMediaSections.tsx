import MediaPlaceholder from "./MediaPlaceholder";
import Reveal from "./Reveal";
import { getLandingAsset, type LandingAssetId } from "../../config/landingAssets";
import styles from "./LandingMediaSections.module.css";

/**
 * Landing sections whose visuals are EMPTY reserved slots:
 * editor preview (9), template thumbnails (10–13), use-case images
 * (14–17), B-roll gallery (18) and the publishing demonstration (19).
 * All slots come from src/config/landingAssets.ts — replacing a slot
 * with a real asset later is an asset-reference update, not a redesign.
 */

const TEMPLATES: { title: string; text: string; assetId: LandingAssetId }[] = [
  { title: "Podcast", text: "Two-speaker framing with clean caption space.", assetId: "podcast-thumbnail" },
  { title: "Gaming", text: "Face-cam friendly layout for gameplay highlights.", assetId: "gaming-thumbnail" },
  { title: "Educational", text: "Board-and-speaker layout for lessons and explainers.", assetId: "education-thumbnail" },
  { title: "Tutorial", text: "Step-focused layout for how-to and walkthrough videos.", assetId: "tutorial-thumbnail" },
];

const USE_CASES: { title: string; text: string; assetId: LandingAssetId }[] = [
  { title: "Gaming", text: "Turn long streams and matches into vertical highlights.", assetId: "gaming-usecase" },
  { title: "Education", text: "Cut lectures and lessons into short revision clips.", assetId: "education-usecase" },
  { title: "Podcast", text: "Pull shareable moments out of full podcast episodes.", assetId: "podcast-usecase" },
  { title: "Business", text: "Repurpose talks, webinars and product videos as shorts.", assetId: "business-usecase" },
];

const B_ROLL: LandingAssetId[] = [
  "b-roll-gallery-01",
  "b-roll-gallery-02",
  "b-roll-gallery-03",
  "b-roll-gallery-04",
];

export default function LandingMediaSections() {
  return (
    <>
      {/* ---- Professional Video Editor preview (slot 9) ---- */}
      <section className={styles.section} id="editor" aria-labelledby="editor-heading">
        <Reveal>
          <p className={styles.eyebrow}>Editor</p>
          <h2 id="editor-heading">A PROFESSIONAL EDITOR, BUILT IN</h2>
          <p className={styles.intro}>
            Trim, caption and polish each clip in one editor before export.
          </p>
        </Reveal>
        <Reveal>
          <MediaPlaceholder asset={getLandingAsset("editor-preview")} />
        </Reveal>
      </section>

      {/* ---- Templates (slots 10–13) ---- */}
      <section className={styles.section} id="templates" aria-labelledby="templates-heading">
        <Reveal>
          <p className={styles.eyebrow}>Templates</p>
          <h2 id="templates-heading">START FROM A TEMPLATE</h2>
          <p className={styles.intro}>
            Vertical layouts for the formats creators publish most.
          </p>
        </Reveal>
        <div className={styles.templateGrid}>
          {TEMPLATES.map((t) => (
            <article key={t.assetId} className={styles.card}>
              <MediaPlaceholder asset={getLandingAsset(t.assetId)} />
              <h3>{t.title}</h3>
              <p>{t.text}</p>
            </article>
          ))}
        </div>
      </section>

      {/* ---- Use cases (slots 14–17) ---- */}
      <section className={styles.section} id="use-cases" aria-labelledby="use-cases-heading">
        <Reveal>
          <p className={styles.eyebrow}>Use Cases</p>
          <h2 id="use-cases-heading">MADE FOR YOUR KIND OF VIDEO</h2>
          <p className={styles.intro}>
            One workflow, four kinds of long-form content.
          </p>
        </Reveal>
        <div className={styles.useCaseGrid}>
          {USE_CASES.map((u) => (
            <article key={u.assetId} className={styles.card}>
              <MediaPlaceholder asset={getLandingAsset(u.assetId)} />
              <h3>{u.title}</h3>
              <p>{u.text}</p>
            </article>
          ))}
        </div>
      </section>

      {/* ---- B-roll gallery (slot 18, four gallery slots) ---- */}
      <section className={styles.section} id="b-roll" aria-labelledby="b-roll-heading">
        <Reveal>
          <p className={styles.eyebrow}>B-Roll Gallery</p>
          <h2 id="b-roll-heading">B-ROLL, READY TO DROP IN</h2>
          <p className={styles.intro}>
            Supporting footage for cutaways and transitions.
          </p>
        </Reveal>
        <div className={styles.brollGrid}>
          {B_ROLL.map((id) => (
            <MediaPlaceholder key={id} asset={getLandingAsset(id)} />
          ))}
        </div>
      </section>

      {/* ---- Publishing demonstration (slot 19) ---- */}
      <section className={styles.section} id="publishing" aria-labelledby="publishing-heading">
        <Reveal>
          <p className={styles.eyebrow}>Publishing</p>
          <h2 id="publishing-heading">PUBLISHING WORKFLOW</h2>
          <p className={styles.intro}>
            Publishing depends on authorisation: a platform can only receive
            a clip once you have connected and authorised it through its
            official integration. Until then, you can review and export
            your clips.
          </p>
        </Reveal>
        <Reveal>
          <MediaPlaceholder asset={getLandingAsset("publishing-demo")} />
        </Reveal>
      </section>
    </>
  );
}
