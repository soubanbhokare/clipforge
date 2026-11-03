import MediaPlaceholder from "./MediaPlaceholder";
import Testimonials from "./Testimonials";
import Reveal from "./Reveal";
import { getLandingAsset, type LandingAssetId } from "../../config/landingAssets";
import styles from "./SocialProof.module.css";

/**
 * Social Proof strip — EMPTY reserved slots only (location 21).
 * Six wide logo slots are reserved for creator/brand logos. No logos,
 * brand names or endorsement claims are shown: real, authorised logo
 * assets will replace these placeholders later.
 */

const LOGO_SLOTS: LandingAssetId[] = [
  "social-proof-logo-01",
  "social-proof-logo-02",
  "social-proof-logo-03",
  "social-proof-logo-04",
  "social-proof-logo-05",
  "social-proof-logo-06",
];

export default function SocialProof() {
  return (
    <section className={styles.section} id="social-proof" aria-labelledby="social-proof-heading">
      <Reveal>
        <p className={styles.eyebrow}>Social Proof</p>
        <h2 id="social-proof-heading">BUILT FOR CREATORS</h2>
      </Reveal>
      <Reveal>
        <div className={styles.logoGrid}>
          {LOGO_SLOTS.map((id) => (
            <MediaPlaceholder key={id} asset={getLandingAsset(id)} />
          ))}
        </div>
      </Reveal>
      <Testimonials />
    </section>
  );
}
