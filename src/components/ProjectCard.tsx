import StatusIndicator, { type StatusKind } from "./StatusIndicator";
import styles from "./Cards.module.css";

interface ProjectCardProps {
  title: string;
  detail: string;
  status: StatusKind;
  statusLabel: string;
}

// Used only with real projects in later phases. No instance of
// this card is rendered with fake data in Phase 2.
export default function ProjectCard({ title, detail, status, statusLabel }: ProjectCardProps) {
  return (
    <article className={styles.card}>
      <div className={styles.body}>
        <h3>{title}</h3>
        <p>{detail}</p>
        <div style={{ marginTop: 10 }}>
          <StatusIndicator status={status} label={statusLabel} />
        </div>
      </div>
    </article>
  );
}
