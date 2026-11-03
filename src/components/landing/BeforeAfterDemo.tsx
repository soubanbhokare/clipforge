import MediaPlaceholder from "./MediaPlaceholder";
import { getLandingAsset } from "../../config/landingAssets";
import styles from "./BeforeAfterDemo.module.css";

/**
 * Before / After media area — EMPTY reserved slots only.
 * Slot 3: before video, 16:9. Slot 4: after video, 9:16.
 * Both slots are always visible side by side so neither dimension is
 * ever hidden or collapsed. No fake play button, no fake progress and
 * no sample video — a real player replaces each slot later.
 */
export default function BeforeAfterDemo() {
  return (
    <div className={styles.demo}>
      <div className={styles.frames}>
        <figure className={styles.before}>
          <MediaPlaceholder asset={getLandingAsset("before-after-original")} />
          <figcaption>Before · Original 16:9 frame</figcaption>
        </figure>
        <span className={styles.arrow} aria-hidden="true">→</span>
        <figure className={styles.after}>
          <MediaPlaceholder asset={getLandingAsset("before-after-vertical")} />
          <figcaption>After · Vertical 9:16, reframed</figcaption>
        </figure>
      </div>
    </div>
  );
}
