import StatusIndicator, { type StatusKind } from "./StatusIndicator";
import styles from "./Cards.module.css";

interface VideoCardProps {
  title: string;
  durationLabel: string;
  status: StatusKind;
  statusLabel: string;
}

// Used only with real clips in later phases. No instance of this
// card is rendered with fake data in Phase 2.
export default function VideoCard({ title, durationLabel, status, statusLabel }: VideoCardProps) {
  return (
    <article className={styles.card}>
      <div className={styles.thumb}>9:16 · {durationLabel}</div>
      <div className={styles.body}>
        <h3>{title}</h3>
        <StatusIndicator status={status} label={statusLabel} />
      </div>
    </article>
  );
}
