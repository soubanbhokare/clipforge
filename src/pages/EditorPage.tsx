import { useEffect, useState } from "react";
import GuestRestriction from "../components/studio/GuestRestriction";
import LoadingState from "../components/LoadingState";
import ErrorState from "../components/ErrorState";
import { useAuth } from "../features/auth/AuthContext";
import { projectsApi, type Project } from "../services/projects";
import styles from "../features/studio/Studio.module.css";

/**
 * AI Editor entry (Phase 5): the editor is per-project, so this page
 * lists the user's projects and links each one into its editor. The
 * editor itself lives at #/app/projects/<id>/editor.
 */
export default function EditorPage() {
  const { isGuest } = useAuth();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isGuest) return;
    let alive = true;
    projectsApi
      .listProjects()
      .then(({ projects: loaded }) => {
        if (alive) setProjects(loaded);
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : "Projects could not be loaded.");
      });
    return () => {
      alive = false;
    };
  }, [isGuest]);

  if (isGuest) return <GuestRestriction action="Open the video editor" />;
  if (error) return <ErrorState message={error} />;
  if (!projects) return <LoadingState message="Loading your projects…" />;

  // The server editor opens any project whose source is a verified
  // local file (validation_status VALID + stored file) — uploads and
  // URL imports alike; link-only YouTube sources are excluded.
  const editable = projects.filter(
    (p) => p.sourceAsset && p.sourceAsset.validationStatus === "VALID",
  );

  return (
    <div className={styles.stack}>
      <section className={styles.panel}>
        <h3>AI Editor — choose a project</h3>
        <p className={styles.panelIntro}>
          The multi-track editor opens per project: trim and arrange clips on a timeline, edit
          captions, apply scene framing, add your own music, and render a real MP4 with FFmpeg.
          Editing is non-destructive — original files are never modified.
        </p>
        {editable.length === 0 ? (
          <p className={styles.muted}>
            No project with a verified source video yet.{" "}
            <a href="#/app/studio">Create one in the Studio</a> — the editor unlocks as soon as a
            source video is added (file upload or URL import) and verified.
          </p>
        ) : (
          <div className={styles.stack} style={{ gap: "var(--space-3)" }}>
            {editable.map((project) => (
              <div key={project.id} className={styles.buttonRow} style={{ justifyContent: "space-between" }}>
                <span>
                  <strong>{project.name}</strong>{" "}
                  <span className={styles.muted}>
                    · updated {new Date(project.updatedAt).toLocaleDateString()}
                  </span>
                </span>
                <a href={`#/app/projects/${project.id}/editor`}>
                  <strong>Open in Editor →</strong>
                </a>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
