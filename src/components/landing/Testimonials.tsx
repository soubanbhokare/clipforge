import MediaPlaceholder from "./MediaPlaceholder";
import Reveal from "./Reveal";
import { getLandingAsset, type LandingAssetId } from "../../config/landingAssets";
import styles from "./Testimonials.module.css";

/**
 * Testimonial slots — EMPTY reserved slots only (location 22),
 * folded into the Social Proof section so the page keeps one proof
 * beat instead of two. Three slots are reserved for creator
 * testimonials. No quotes, names or endorsements are shown: real
 * testimonials will be added only when creators supply them.
 */

const TESTIMONIAL_SLOTS: LandingAssetId[] = [
  "testimonial-01",
  "testimonial-02",
  "testimonial-03",
];

export default function Testimonials() {
  return (
    <Reveal>
      <div className={styles.testimonialGrid} role="group" aria-label="Creator testimonials">
        {TESTIMONIAL_SLOTS.map((id) => (
          <MediaPlaceholder key={id} asset={getLandingAsset(id)} />
        ))}
      </div>
    </Reveal>
  );
}
