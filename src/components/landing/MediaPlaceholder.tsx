import type { LandingAsset } from "../../config/landingAssets";
import styles from "./MediaPlaceholder.module.css";

/**
 * Empty, reserved media slot for the CLIPFORGE landing page.
 *
 * Deliberately renders NO image, NO video, NO play button and NO fake
 * progress — only an elegant dark reserved area with a dashed border
 * and a muted label. A real asset later replaces this component in the
 * same container, keeping the reserved aspect ratio and dimensions.
 */
export default function MediaPlaceholder({ asset }: { asset: LandingAsset }) {
  return (
    <div
      className={styles.placeholder}
      style={{ aspectRatio: asset.aspectRatio }}
      data-asset-id={asset.id}
      data-media-type={asset.type}
      data-aspect-ratio={asset.aspectLabel}
      role="img"
      aria-label={`Reserved ${asset.type} slot ${asset.code}, ${asset.aspectLabel}. Asset to be added.`}
    >
      <span className={styles.code}>{asset.code}</span>
      <span className={styles.kind}>
        {asset.aspectLabel} {asset.type === "video" ? "VIDEO SLOT" : "IMAGE SLOT"}
      </span>
      <span className={styles.state}>ASSET TO BE ADDED</span>
    </div>
  );
}
