// Phase 5 — Professional Video Editor page (#/app/projects/<id>/
// editor, optional ?clip=<candidateId> seed). Layout: toolbar
// (project name, truthful save status, undo/redo, versions shortcut,
// render), media library (left), preview canvas (centre), inspector
// (right), multi-track timeline (bottom).
//
// Every edit is a server operation: mutations are serialised through
// a queue, the server-returned document replaces local state, and the
// save indicator shows saving/saved/error from real request results.
// Nothing is kept in web storage; a refresh re-reads the document.

import { useCallback, useEffect, useRef, useState } from "react";
import GuestRestriction from "../../components/studio/GuestRestriction";
import LoadingState from "../../components/LoadingState";
import ErrorState from "../../components/ErrorState";
import EmptyState from "../../components/EmptyState";
import { useAuth } from "../../features/auth/AuthContext";
import { parseHash } from "../../features/auth/routing";
import {
  editorApi,
  stateOf,
  timelineDuration,
  AuthApiError,
  type EditorDocument,
  type EditorLibrary,
  type ProjectVersion,
  type RenderJob,
} from "../../services/editor";
import { projectsApi, type Project } from "../../services/projects";
import { trackingApi, type ReframeState } from "../../services/tracking";
import MediaLibrary from "../../components/editor/MediaLibrary";
import PreviewCanvas from "../../components/editor/PreviewCanvas";
import Inspector from "../../components/editor/Inspector";
import Timeline, { isCaptionKind, type EditorSelection } from "../../components/editor/Timeline";
import styles from "./Editor.module.css";

type SaveState = "saved" | "saving" | "error";

/**
 * Operations whose mutation only assigns, filters or otherwise
 * deterministically rewrites existing state. Re-running one after a
 * failed request cannot append a second copy if the first request
 * reached the server but its response was lost. Appending/structural
 * operations (add, split, duplicate, merge, track add) are excluded.
 */
const RETRYABLE_OPERATION_TYPES = new Set([
  "caption_delete",
  "caption_move",
  "caption_style_apply",
  "caption_style_reset",
  "caption_update",
  "caption_words_update",
  "delete_item",
  "move_item",
  "reset_item",
  "scene_override_reset",
  "scene_override_set",
  "settings_update",
  "track_remove",
  "track_update",
  "trim_item",
  "update_item",
]);

export default function VideoEditorPage({ projectId }: { projectId: string }) {
  const { isGuest } = useAuth();
  const [project, setProject] = useState<Project | null>(null);
  const [doc, setDoc] = useState<EditorDocument | null>(null);
  const [library, setLibrary] = useState<EditorLibrary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [failedMutation, setFailedMutation] = useState<{
    task: () => Promise<EditorDocument>;
  } | null>(null);
  const [versionsRendersError, setVersionsRendersError] = useState<string | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [selection, setSelection] = useState<EditorSelection>(null);
  const [versions, setVersions] = useState<ProjectVersion[]>([]);
  const [renders, setRenders] = useState<RenderJob[]>([]);
  // Phase 7: the document's reframe state, owned here so the
  // PreviewCanvas can apply the reframed crop (see the poll below).
  const [reframe, setReframe] = useState<ReframeState | null>(null);
  const reframeFingerprintRef = useRef("");

  const docRef = useRef<EditorDocument | null>(null);
  docRef.current = doc;
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const seedRef = useRef<string | null>(parseHash().params.get("clip"));
  const loadedProjectRef = useRef<string | null>(null);

  const refreshVersionsAndRenders = useCallback(async (docId: string) => {
    try {
      const [{ versions: v }, { jobs }] = await Promise.all([
        editorApi.listVersions(docId),
        editorApi.listRenders(docId),
      ]);
      setVersions(v);
      setRenders(jobs);
      setVersionsRendersError(null);
    } catch (err) {
      setVersionsRendersError(
        `Versions and renders could not be loaded${err instanceof Error ? `: ${err.message}` : "."}`,
      );
    }
  }, []);

  const load = useCallback(async () => {
    setLoadError(null);
    // A document loaded for another project must never be rendered
    // as though it belonged to the newly selected project. Clear the
    // project-scoped shell state before the replacement load starts;
    // same-project reloads keep the current document on screen.
    if (loadedProjectRef.current !== projectId) {
      loadedProjectRef.current = projectId;
      setProject(null);
      setDoc(null);
      setLibrary(null);
      setVersions([]);
      setRenders([]);
      setReframe(null);
      reframeFingerprintRef.current = "";
      setVersionsRendersError(null);
      setSelection(null);
      setPlayhead(0);
    }
    setFailedMutation(null);
    try {
      const [{ project: loadedProject }, response] = await Promise.all([
        projectsApi.getProject(projectId),
        editorApi.getDocument(projectId, seedRef.current),
      ]);
      // Ignore a response for a project the shell has already left;
      // otherwise a slow previous-project load could overwrite the
      // current project's document after its own load has finished.
      if (loadedProjectRef.current !== projectId) return;
      seedRef.current = null; // seed only applies to the first load
      setProject(loadedProject);
      setDoc(response.document);
      setLibrary(response.library);
      void refreshVersionsAndRenders(response.document.id);
    } catch (err) {
      if (loadedProjectRef.current !== projectId) return;
      setLoadError(
        err instanceof AuthApiError || err instanceof Error
          ? err.message
          : "The editor could not be loaded.",
      );
    }
  }, [projectId, refreshVersionsAndRenders]);

  useEffect(() => {
    if (isGuest) return;
    // Re-read the seed on every project load: the ref is not a
    // one-shot value tied to this component's first mount.
    seedRef.current = parseHash().params.get("clip");
    void load();
  }, [isGuest, load]);

  // Hash routing keeps this component mounted when only the query
  // changes (for example, opening another ?clip= seed for the same
  // project), so listen for that change explicitly and reload with
  // the newly read seed.
  useEffect(() => {
    const onHashChange = () => {
      const parsed = parseHash();
      const routeMatches =
        parsed.path === `projects/${projectId}/editor` ||
        parsed.path === `app/projects/${projectId}/editor`;
      if (!routeMatches) return;
      const nextSeed = parsed.params.get("clip");
      if (nextSeed === seedRef.current) return;
      seedRef.current = nextSeed;
      if (!isGuest) void load();
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [isGuest, load, projectId]);

  // Poll while any render is active so stage/status stay truthful.
  const hasActiveRender = renders.some((r) => r.status === "QUEUED" || r.status === "RUNNING");
  useEffect(() => {
    if (!doc || !hasActiveRender) return;
    const timer = window.setInterval(() => {
      void editorApi
        .listRenders(doc.id)
        .then(({ jobs }) => setRenders(jobs))
        .catch(() => undefined);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [doc, hasActiveRender]);

  // Phase 7 preview wiring: keep this page's copy of the reframe
  // state fresh so the PreviewCanvas shows the reframed crop. The
  // ReframePanel (mounted inside the Inspector) holds its own copy
  // and exposes no change callback, so freshness comes from a light
  // poll while the editor is open — the same pattern as the render
  // poll above — plus an immediate refresh when the tab regains
  // focus/visibility. Panel edits reach the preview within one poll
  // tick at the latest, and instantly on refocus.
  useEffect(() => {
    const docId = doc?.id;
    if (!docId || isGuest) return;
    let cancelled = false;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await trackingApi.getReframe(docId);
        if (cancelled) return;
        // The preview consumes config + keyframes only; skip the
        // state update when neither changed so polling does not
        // re-render the editor several times a minute for nothing.
        const fingerprint = JSON.stringify({ config: next.config, keyframes: next.keyframes });
        if (fingerprint !== reframeFingerprintRef.current) {
          reframeFingerprintRef.current = fingerprint;
          setReframe(next);
        }
      } catch {
        // Keep the last known state (or none): a failed refresh must
        // not blank a crop that is already on screen.
      } finally {
        inFlight = false;
      }
    };
    const onFocus = () => {
      void refresh();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 4000);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [doc?.id, isGuest]);

  // Warn before leaving with a save in flight or failed.
  useEffect(() => {
    if (saveState === "saved") return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [saveState]);

  /** Serialise mutations: each op applies to the latest server doc. */
  const runMutation = useCallback((task: () => Promise<EditorDocument>, retryable = false) => {
    const run = async () => {
      setFailedMutation(null);
      setSaveState("saving");
      setSaveError(null);
      try {
        const next = await task();
        setDoc(next);
        setSaveState("saved");
      } catch (err) {
        // Only deterministic operations are offered for retry. A
        // stored task is discarded as soon as another mutation runs,
        // so Retry can never replay it against a newer document.
        if (retryable) setFailedMutation({ task });
        setSaveState("error");
        setSaveError(err instanceof Error ? err.message : "The edit could not be saved.");
      }
    };
    queueRef.current = queueRef.current.then(run, run);
  }, []);

  const retryFailedMutation = useCallback(() => {
    if (!failedMutation) return;
    const { task } = failedMutation;
    setFailedMutation(null);
    runMutation(task, true);
  }, [failedMutation, runMutation]);

  /** Surface a non-mutation action failure without offering to
   *  retry an unrelated earlier edit. */
  const surfaceActionError = useCallback((message: string) => {
    setFailedMutation(null);
    setSaveState("error");
    setSaveError(message);
  }, []);

  const commit = useCallback(
    (type: string, mutate: (state: EditorDocument) => void) => {
      const current = docRef.current;
      if (!current) return;
      runMutation(async () => {
        const latest = docRef.current ?? current;
        const state = stateOf(latest);
        mutate(state as unknown as EditorDocument);
        const { document } = await editorApi.applyOperation(latest.id, type, state, latest.undoCursor);
        return document;
      }, RETRYABLE_OPERATION_TYPES.has(type));
    },
    [runMutation],
  );

  const undo = useCallback(() => {
    const current = docRef.current;
    if (!current) return;
    runMutation(async () => (await editorApi.undo(current.id)).document);
  }, [runMutation]);

  const redo = useCallback(() => {
    const current = docRef.current;
    if (!current) return;
    runMutation(async () => (await editorApi.redo(current.id)).document);
  }, [runMutation]);

  const patchSettings = useCallback(
    (patch: { canvas?: EditorDocument["canvas"]; settings?: Partial<EditorDocument["settings"]> }) => {
      const current = docRef.current;
      if (!current) return;
      runMutation(async () => (await editorApi.patchSettings(current.id, patch)).document, true);
    },
    [runMutation],
  );

  // Phase 6: Caption Studio actions that replace the document
  // server-side (caption regeneration, track activation, brand-kit
  // apply) hand back the fresh document — adopt it directly.
  const replaceDocument = useCallback((document: EditorDocument) => {
    // Adopting a server-produced document must not erase an
    // unrelated save failure. Preserve the current save state/error;
    // only drop the retry handle, whose task was written against the
    // superseded document.
    setFailedMutation(null);
    setDoc(document);
  }, []);

  const captionCustomPosition = useCallback(
    (x: number, y: number) => {
      const current = docRef.current;
      if (!current) return;
      patchSettings({
        settings: {
          captionStyle: { ...current.settings.captionStyle, position: "custom", positionX: x, positionY: y },
        },
      });
    },
    [patchSettings],
  );

  const trackPatch = useCallback(
    (trackId: string, patch: Record<string, unknown>) => {
      commit("track_update", (state) => {
        const track = state.tracks.find((t) => t.id === trackId);
        if (track) Object.assign(track, patch);
      });
    },
    [commit],
  );

  const addItem = useCallback(
    (input: {
      assetKind: "source" | "candidate" | "media";
      assetId: string;
      trackKind: "main" | "broll" | "overlay" | "audio";
      sourceIn: number;
      sourceOut: number;
      duration: number | null;
    }) => {
      const current = docRef.current;
      if (!current) return;
      const rangeDuration = input.sourceOut - input.sourceIn;
      if (!Number.isFinite(rangeDuration) || rangeDuration <= 0) {
        surfaceActionError(
          "Could not add that asset: its duration is unknown, so a valid clip length cannot be set.",
        );
        return;
      }
      const track = current.tracks.find((t) => t.kind === input.trackKind);
      if (!track) {
        surfaceActionError(`Could not add that asset: this project has no ${input.trackKind} track.`);
        return;
      }
      if (track.locked) {
        surfaceActionError(
          `Could not add that asset: the ${track.label} track is locked. Unlock it and try again.`,
        );
        return;
      }
      const start = current.items
        .filter((i) => i.trackId === track.id)
        .reduce((max, i) => Math.max(max, i.start + i.duration), 0);
      commit("add_item", (state) => {
        state.items.push({
          id: crypto.randomUUID(),
          trackId: track.id,
          assetKind: input.assetKind,
          assetId: input.assetId,
          start,
          duration: rangeDuration,
          sourceIn: input.sourceIn,
          sourceOut: input.sourceOut,
          transform: { crop: null, x: 0, y: 0, scale: 1, zoom: 1, rotation: 0, fit: "fill" },
          speed: 1,
          volume: 1,
          fadeIn: 0,
          fadeOut: 0,
          layerOrder: state.items.filter((i) => i.trackId === track.id).length,
        });
      });
    },
    [commit, surfaceActionError],
  );

  // Keyboard: Ctrl/Cmd+Z undo, Ctrl+Shift+Z / Ctrl+Y redo, Delete
  // removes the selection, space is left to the preview transport.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT");
      if (typing) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      } else if ((e.key === "Delete" || e.key === "Backspace") && selection) {
        e.preventDefault();
        const current = docRef.current;
        if (!current) return;
        if (selection.kind === "item") {
          const selectedItem = current.items.find((i) => i.id === selection.id);
          const itemTrack = selectedItem
            ? current.tracks.find((t) => t.id === selectedItem.trackId)
            : undefined;
          if (itemTrack?.locked) return; // locked tracks cannot be edited
          const id = selection.id;
          setSelection(null);
          commit("delete_item", (state) => {
            state.items = state.items.filter((i) => i.id !== id);
          });
        } else {
          const captionTrack = [...current.tracks]
            .sort((a, b) => a.order - b.order)
            .find((t) => isCaptionKind(t.kind));
          if (captionTrack?.locked) return; // locked tracks cannot be edited
          const id = selection.id;
          setSelection(null);
          commit("caption_delete", (state) => {
            state.captions = state.captions.filter((c) => c.id !== id);
          });
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [undo, redo, commit, selection]);

  if (isGuest) {
    return <GuestRestriction action="Open the video editor" />;
  }
  if (loadError) {
    return <ErrorState message={loadError} onRetry={() => void load()} />;
  }
  if (!doc || !library || doc.projectId !== projectId) {
    return <LoadingState message="Loading the editor…" />;
  }

  const duration = timelineDuration(doc);

  return (
    <div className={styles.editor}>
      <div className={styles.toolbar}>
        <div className={styles.toolbarTitle}>
          <strong>{project?.name ?? "Project"} — Editor</strong>
          <span
            className={`${styles.saveState} ${saveState === "error" ? styles.saveStateError : ""}`}
            role="status"
          >
            {saveState === "saving" && "Saving…"}
            {saveState === "saved" && `All changes saved · ${formatTime(doc.updatedAt)}`}
            {saveState === "error" &&
              `Save failed: ${saveError ?? "unknown error"} — this change was NOT saved and must be redone.`}
          </span>
          {versionsRendersError && (
            <span className={`${styles.saveState} ${styles.saveStateError}`} role="alert">
              {versionsRendersError}
            </span>
          )}
          {saveState === "error" && failedMutation && (
            <button
              type="button"
              className={styles.toolButton}
              style={{ alignSelf: "flex-start" }}
              onClick={retryFailedMutation}
            >
              Retry save
            </button>
          )}
        </div>
        <span className={styles.toolbarSpacer} />
        <div className={styles.toolGroup}>
          <button type="button" className={styles.toolButton} onClick={undo} disabled={doc.undoCursor <= 0 || saveState === "saving"}>
            ↩ Undo
          </button>
          <button type="button" className={styles.toolButton} onClick={redo} disabled={doc.undoCursor >= doc.opCount || saveState === "saving"}>
            ↪ Redo
          </button>
          <span className={styles.small}>
            {doc.canvas.width}×{doc.canvas.height} · {duration.toFixed(1)}s
          </span>
          <button
            type="button"
            className={styles.toolButtonAccent}
            style={{ padding: "7px 14px", borderRadius: "var(--radius-sm)", border: "1px solid var(--lime)", cursor: "pointer", font: "inherit" }}
            disabled={renders.some((r) => r.status === "QUEUED" || r.status === "RUNNING")}
            title={
              renders.some((r) => r.status === "QUEUED" || r.status === "RUNNING")
                ? "A render is already running — wait for it to finish before starting another."
                : undefined
            }
            onClick={() => {
              void (async () => {
                try {
                  const { job } = await editorApi.startRender(doc.id);
                  setRenders((prev) => [job, ...prev]);
                } catch (err) {
                  surfaceActionError(
                    err instanceof Error ? err.message : "The render could not be started.",
                  );
                }
              })();
            }}
          >
            {renders.some((r) => r.status === "QUEUED" || r.status === "RUNNING")
              ? "Rendering…"
              : "Export / Render"}
          </button>
          <a
            className={styles.toolButton}
            style={{ padding: "7px 14px", borderRadius: "var(--radius-sm)", textDecoration: "none", display: "inline-flex", alignItems: "center" }}
            href={`#/app/projects/${projectId}/exports`}
          >
            Export Studio
          </a>
        </div>
      </div>

      {doc.items.length === 0 && (
        <EmptyState
          title="This timeline is empty"
          description="Add the source video, a generated clip, or imported media from the Media Library to start building the edit."
        />
      )}

      <div className={styles.mainGrid}>
        <MediaLibrary
          projectId={projectId}
          doc={doc}
          library={library}
          onAddItem={addItem}
          onMediaUploaded={() => void load()}
        />
        <PreviewCanvas
          doc={doc}
          library={library}
          reframe={reframe}
          playhead={playhead}
          onPlayheadChange={setPlayhead}
          onSelectItem={(id) => setSelection(id ? { kind: "item", id } : null)}
          onToggleCaptions={() =>
            patchSettings({ settings: { showCaptions: !doc.settings.showCaptions } })
          }
          onToggleGuides={() => patchSettings({ settings: { showGuides: !doc.settings.showGuides } })}
          onCaptionCustomPosition={captionCustomPosition}
        />
        <Inspector
          doc={doc}
          projectId={projectId}
          onReplaceDocument={replaceDocument}
          library={library}
          selection={selection}
          playhead={playhead}
          onSeek={setPlayhead}
          onSelect={setSelection}
          onCommit={commit}
          onPatchSettings={patchSettings}
          versions={versions}
          onCreateVersion={(name) => {
            void (async () => {
              try {
                await editorApi.createVersion(doc.id, name);
                await refreshVersionsAndRenders(doc.id);
              } catch (err) {
                surfaceActionError(
                  err instanceof Error ? err.message : "The version could not be saved.",
                );
              }
            })();
          }}
          onRestoreVersion={(versionId) => {
            runMutation(async () => (await editorApi.restoreVersion(doc.id, versionId)).document);
          }}
          renders={renders}
          onStartRender={() => {
            void (async () => {
              try {
                const { job } = await editorApi.startRender(doc.id);
                setRenders((prev) => [job, ...prev]);
              } catch (err) {
                surfaceActionError(
                  err instanceof Error ? err.message : "The render could not be started.",
                );
              }
            })();
          }}
          onCancelRender={(jobId) => {
            void (async () => {
              try {
                const { job } = await editorApi.cancelRender(jobId);
                setRenders((prev) => prev.map((r) => (r.id === job.id ? job : r)));
              } catch (err) {
                surfaceActionError(
                  err instanceof Error ? err.message : "The render could not be cancelled.",
                );
              }
            })();
          }}
        />
      </div>

      <Timeline
        doc={doc}
        library={library}
        playhead={playhead}
        onSeek={setPlayhead}
        selection={selection}
        onSelect={setSelection}
        onCommit={commit}
        onTrackPatch={(trackId, patch) => trackPatch(trackId, patch as Record<string, unknown>)}
      />
    </div>
  );
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString();
}
