import MediaPlaceholder from "./MediaPlaceholder";
import { getLandingAsset } from "../../config/landingAssets";
import styles from "./HeroVisual.module.css";

/**
 * Hero media area — EMPTY reserved slots only (2026-11-02 rule).
 * Slot 1: hero main video, 16:9. Slot 2: hero vertical preview, 9:16.
 * No video, image, illustration or fake player is rendered here; a real
 * player will later replace each placeholder at the same dimensions.
 * The CLIPFORGE logo in the nav is branding, not media, and is kept.
 */
export default function HeroVisual() {
  return (
    <div className={styles.stage}>
      <div className={styles.row}>
        <div className={styles.mainSlot}>
          <MediaPlaceholder asset={getLandingAsset("hero-video")} />
        </div>
        <div className={styles.verticalSlot}>
          <MediaPlaceholder asset={getLandingAsset("hero-vertical-preview")} />
        </div>
      </div>
    </div>
  );
}
