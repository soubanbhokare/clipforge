import { useEffect, useState } from "react";
import ProjectCardView from "../components/studio/ProjectCardView";
import EmptyState from "../components/EmptyState";
import { useAuth } from "../features/auth/AuthContext";
import styles from "../features/studio/Studio.module.css";
import { AuthApiError } from "../services/auth";
import { projectsApi, type Project } from "../services/projects";

/**
 * Studio dashboard (Phase 3): the two video workflows plus the user's
 * real recent projects. Guests can look around, but starting a
 * workflow clearly requires an account — no fake projects, jobs or
 * analytics anywhere.
 */
export default function StudioPage() {
  const { status, isGuest } = useAuth();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guestNotice, setGuestNotice] = useState<string | null>(null);

  useEffect(() => {
    if (status !== "authenticated") {
      setProjects(null);
      setProjectsLoaded(false);
      setProjectsLoading(status === "loading");
      return;
    }
    let alive = true;
    setProjectsLoading(true);
    setProjectsLoaded(false);
    setError(null);
    projectsApi
      .listProjects({ pageSize: 6, sort: "newest" })
      .then((result) => {
        if (alive) {
          setProjects(result.projects);
          setProjectsLoaded(true);
        }
      })
      .catch((err) => {
        if (alive) {
          setError(
            err instanceof AuthApiError
              ? err.message
              : "Recent projects could not be loaded. Check that the CLIPFORGE server is running.",
          );
          setProjects([]);
          setProjectsLoaded(true);
        }
      })
      .finally(() => {
        if (alive) setProjectsLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [status]);

  const guestBlock = (action: string) => (e: React.MouseEvent) => {
    if (!isGuest) return;
    e.preventDefault();
    setGuestNotice(
      `${action} needs a free account. Demo Mode is for exploring the interface — it never saves projects or uploads. Use "Create a free account" above to start for real.`,
    );
  };

  return (
    <div className={styles.stack}>
      <div>
        <h2 className={styles.heading}>What are we creating today?</h2>
        <p className={styles.lede}>
          Bring your video into CLIPFORGE and prepare it for short-form content.
        </p>
      </div>

      {guestNotice && (
        <p className={`${styles.banner} ${styles.bannerLime}`} role="alert">
          {guestNotice}
        </p>
      )}

      <div className={styles.workflowGrid}>
        <a
          className={styles.workflowCard}
          href="#/app/studio/create"
          onClick={guestBlock("Create Multiple Shorts")}
          aria-label="Create Multiple Shorts — turn one long video into multiple shorts"
        >
          <h3>Create Multiple Shorts</h3>
          <p>
            Turn one long video into multiple shorts. Add a long source video, choose how many
            clips you want and how they should look, then run analysis from the project page to
            find the best moments.
          </p>
          <span className={styles.workflowCta}>Start with a long video →</span>
        </a>
        <a
          className={styles.workflowCard}
          href="#/app/studio/enhance"
          onClick={guestBlock("Enhance Existing Video")}
          aria-label="Enhance Existing Video — improve a single short video"
        >
          <h3>Enhance Existing Video</h3>
          <p>
            Make your existing video better. One short video, one editing project — reframing,
            captions and polish preferences, without clip discovery.
          </p>
          <span className={styles.workflowCta}>Start with a short video →</span>
        </a>
      </div>

      <section aria-labelledby="recent-heading">
        <h3 id="recent-heading" className={styles.sectionTitle}>Recent projects</h3>
        {isGuest ? (
          <EmptyState
            title="Your next video starts here."
            description="Demo Mode shows no projects, because demo work is never saved. Create a free account and your real projects will appear here."
          />
        ) : status === "loading" || projectsLoading || (status === "authenticated" && !projectsLoaded) ? (
          <p className={styles.muted} role="status">Loading your projects…</p>
        ) : error ? (
          <p className={styles.errorText} role="alert"><strong>Problem:</strong> {error}</p>
        ) : status !== "authenticated" ? (
          <EmptyState
            title="Sign in to see your projects."
            description="Your projects are tied to your account. Sign in and your real projects will appear here."
          />
        ) : projectsLoaded && (projects === null || projects.length === 0) ? (
          <EmptyState
            title="Your next video starts here."
            description="You have no projects yet. Create Multiple Shorts from a long video, or enhance an existing short — your projects will appear here."
          />
        ) : (
          <>
            <div className={styles.listGrid}>
              {(projects ?? []).map((p) => (
                <ProjectCardView key={p.id} project={p} />
              ))}
            </div>
            <p style={{ marginTop: "var(--space-4)" }}>
              <a href="#/app/projects">See all projects →</a>
            </p>
          </>
        )}
      </section>
    </div>
  );
}
