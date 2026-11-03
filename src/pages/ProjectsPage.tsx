import { useCallback, useEffect, useState } from "react";
import Button from "../components/Button";
import ConfirmationDialog from "../components/ConfirmationDialog";
import EmptyState from "../components/EmptyState";
import Modal from "../components/Modal";
import ProjectCardView from "../components/studio/ProjectCardView";
import { useAuth } from "../features/auth/AuthContext";
import styles from "../features/studio/Studio.module.css";
import { AuthApiError } from "../services/auth";
import { projectsApi, STATUS_LABELS, type Project } from "../services/projects";

const PAGE_SIZE = 10;

/**
 * Projects (Phase 3): the signed-in user's real projects with search,
 * workflow/status filters, sorting and incremental loading. Rename
 * and delete are real API operations; delete asks for confirmation.
 */
export default function ProjectsPage() {
  const { isGuest } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [workflow, setWorkflow] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [sort, setSort] = useState<"newest" | "oldest" | "name" | "name-desc" | "updated">("newest");

  const [renameTarget, setRenameTarget] = useState<Project | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(
    async (pageToLoad: number, append: boolean) => {
      if (isGuest) {
        setProjects([]);
        setTotal(0);
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const result = await projectsApi.listProjects({
          search: debouncedSearch || undefined,
          workflow: workflow || undefined,
          status: statusFilter || undefined,
          sort,
          page: pageToLoad,
          pageSize: PAGE_SIZE,
        });
        setTotal(result.total);
        setPage(result.page);
        setProjects((prev) => (append ? [...prev, ...result.projects] : result.projects));
      } catch (err) {
        setError(
          err instanceof AuthApiError ? err.message : "Projects could not be loaded. Check that the server is running.",
        );
      } finally {
        setLoading(false);
      }
    },
    [isGuest, debouncedSearch, workflow, statusFilter, sort],
  );

  useEffect(() => {
    void load(1, false);
  }, [load]);

  const doRename = async () => {
    if (!renameTarget || !renameValue.trim()) return;
    setActionBusy(true);
    setActionError(null);
    try {
      const { project } = await projectsApi.updateProject(renameTarget.id, { name: renameValue.trim() });
      setProjects((prev) => prev.map((p) => (p.id === project.id ? project : p)));
      setRenameTarget(null);
    } catch (err) {
      setActionError(err instanceof AuthApiError ? err.message : "Rename failed. Please try again.");
    } finally {
      setActionBusy(false);
    }
  };

  const doDelete = async () => {
    if (!deleteTarget) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await projectsApi.deleteProject(deleteTarget.id);
      setProjects((prev) => prev.filter((p) => p.id !== deleteTarget.id));
      setTotal((t) => Math.max(0, t - 1));
      setDeleteTarget(null);
    } catch (err) {
      setActionError(err instanceof AuthApiError ? err.message : "Delete failed. Please try again.");
    } finally {
      setActionBusy(false);
    }
  };

  if (isGuest) {
    return (
      <EmptyState
        title="Your next video starts here."
        description="Demo Mode never stores projects. Create a free account to create, save and reopen real projects here."
        action={<a className={styles.textButton} href="#/signup">Create a free account</a>}
      />
    );
  }

  return (
    <div>
      <div className={styles.controls} role="search">
        <input
          className={`${styles.input} ${styles.searchInput}`}
          type="search"
          placeholder="Search projects by name…"
          aria-label="Search projects"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select className={styles.select} aria-label="Filter by workflow" value={workflow} onChange={(e) => setWorkflow(e.target.value)}>
          <option value="">All workflows</option>
          <option value="LONG_VIDEO_TO_SHORTS">Multiple Shorts</option>
          <option value="SHORT_VIDEO_ENHANCEMENT">Enhance Video</option>
        </select>
        <select className={styles.select} aria-label="Filter by status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          {Object.entries(STATUS_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        <select className={styles.select} aria-label="Sort projects" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="updated">Recently updated</option>
          <option value="name">Name A–Z</option>
          <option value="name-desc">Name Z–A</option>
        </select>
      </div>

      {actionError && (
        <p className={styles.errorText} role="alert" style={{ marginBottom: "var(--space-4)" }}>
          <strong>Problem:</strong> {actionError}
        </p>
      )}
      {error && (
        <p className={styles.errorText} role="alert"><strong>Problem:</strong> {error}</p>
      )}

      {loading && projects.length === 0 ? (
        <p className={styles.muted} role="status">Loading projects…</p>
      ) : projects.length === 0 ? (
        <EmptyState
          title="Your next video starts here."
          description={
            debouncedSearch || workflow || statusFilter
              ? "No projects match these filters. Clear the search or filters to see everything."
              : "You have no projects yet. Start from the Studio: create multiple shorts from a long video, or enhance an existing short."
          }
          action={<a className={styles.textButton} href="#/app/studio">Go to Studio</a>}
        />
      ) : (
        <>
          <div className={styles.listGrid}>
            {projects.map((p) => (
              <ProjectCardView key={p.id} project={p} onRename={(proj) => { setRenameValue(proj.name); setRenameTarget(proj); }} onDelete={setDeleteTarget} />
            ))}
          </div>
          <p className={styles.muted} style={{ marginTop: "var(--space-4)" }}>
            Showing {projects.length} of {total} projects.
          </p>
          {projects.length < total && (
            <Button variant="secondary" onClick={() => void load(page + 1, true)} loading={loading}>
              Load more
            </Button>
          )}
        </>
      )}

      <Modal open={renameTarget !== null} title="Rename project" onClose={() => setRenameTarget(null)}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="rename-input">Project name</label>
          <input
            id="rename-input"
            className={styles.input}
            value={renameValue}
            maxLength={120}
            onChange={(e) => setRenameValue(e.target.value)}
          />
        </div>
        <div className={styles.buttonRow} style={{ marginTop: "var(--space-4)" }}>
          <Button variant="primary" onClick={doRename} loading={actionBusy} disabled={!renameValue.trim()}>
            Save name
          </Button>
          <Button variant="ghost" onClick={() => setRenameTarget(null)}>Cancel</Button>
        </div>
      </Modal>

      <ConfirmationDialog
        open={deleteTarget !== null}
        title="Delete project?"
        message={
          deleteTarget
            ? `“${deleteTarget.name}” and its uploaded source files will be permanently deleted from this server. This cannot be undone.`
            : ""
        }
        confirmLabel={actionBusy ? "Deleting…" : "Delete project"}
        onConfirm={doDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
