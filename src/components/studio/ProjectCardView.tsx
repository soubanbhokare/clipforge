import { useState } from "react";
import styles from "../../features/studio/Studio.module.css";
import {
  formatDate,
  formatDuration,
  projectsApi,
  STATUS_LABELS,
  WORKFLOW_LABELS,
  type Project,
} from "../../services/projects";

export function StatusChipFor({ status }: { status: string }) {
  const cls =
    status === "READY_FOR_ANALYSIS"
      ? `${styles.chip} ${styles.chipOk}`
      : status === "FAILED" || status === "CANCELLED"
        ? `${styles.chip} ${styles.chipError}`
        : status === "REQUIRES_SOURCE_FILE" || status === "REQUIRES_AUTHORIZATION"
          ? `${styles.chip} ${styles.chipWarn}`
          : styles.chip;
  return <span className={cls}>{STATUS_LABELS[status] ?? status}</span>;
}

interface ProjectCardViewProps {
  project: Project;
  onRename?: (project: Project) => void;
  onDelete?: (project: Project) => void;
}

/** One real project row/card — thumbnail, workflow, source, status. */
export default function ProjectCardView({ project, onRename, onDelete }: ProjectCardViewProps) {
  const [thumbFailed, setThumbFailed] = useState(false);
  const asset = project.sourceAsset;
  const href = `#/app/projects/${project.id}`;
  return (
    <article className={styles.projectCard}>
      <div>
        {asset?.hasThumbnail && !thumbFailed ? (
          <img
            className={styles.thumb}
            src={projectsApi.thumbnailUrl(asset.id)}
            alt=""
            onError={() => setThumbFailed(true)}
          />
        ) : (
          <div className={styles.thumbEmpty}>NO THUMBNAIL</div>
        )}
      </div>
      <div className={styles.projectInfo}>
        <h3 className={styles.projectName}>
          <a href={href}>{project.name}</a>
        </h3>
        <p className={styles.projectMeta}>
          {WORKFLOW_LABELS[project.workflowType]} · {asset ? asset.originalFilename : "No source yet"}
          {asset?.duration ? ` · ${formatDuration(asset.duration)}` : ""} · {formatDate(project.createdAt)}
        </p>
        <div>
          <StatusChipFor status={project.status} />
        </div>
        <div className={styles.cardActions}>
          <a className={styles.textButton} href={href}>Open</a>
          {onRename && (
            <button type="button" className={styles.textButton} onClick={() => onRename(project)}>
              Rename
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              className={`${styles.textButton} ${styles.textButtonDanger}`}
              onClick={() => onDelete(project)}
            >
              Delete
            </button>
          )}
        </div>
      </div>
    </article>
  );
}
