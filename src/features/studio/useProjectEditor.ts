// Shared project-editing state for the two Studio workflow pages:
// lazy project creation (with an idempotency key, so a double click
// or a retry can never create two projects), loading an existing
// project for editing, YouTube-source attachment, and settings save.

import { useCallback, useEffect, useRef, useState } from "react";
import { parseHash } from "../auth/routing";
import {
  projectsApi,
  type Project,
  type SourceAsset,
  type WorkflowType,
  type YouTubeValidation,
} from "../../services/projects";

function newKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? `studio-${crypto.randomUUID()}`
    : `studio-${Date.now()}`;
}

export interface ProjectEditor {
  project: Project | null;
  /** True when the project was loaded from a ?project= link (edit mode). */
  loadedFromUrl: boolean;
  projectId: string | null;
  projectName: string;
  setProjectName: (name: string) => void;
  asset: SourceAsset | null;
  setAsset: (asset: SourceAsset | null) => void;
  loaded: boolean;
  loadError: string | null;
  wrongWorkflow: Project | null;
  ensureProject: (suggestedName?: string) => Promise<string>;
  attachYouTube: (result: YouTubeValidation) => Promise<void>;
  saveSettings: (settings: Record<string, unknown>) => Promise<Project>;
}

export function useProjectEditor(workflowType: WorkflowType): ProjectEditor {
  const [initialProjectId] = useState<string | null>(() => parseHash().params.get("project"));
  const [project, setProject] = useState<Project | null>(null);
  const [loadedFromUrl, setLoadedFromUrl] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(initialProjectId);
  const [projectName, setProjectName] = useState("");
  const [asset, setAsset] = useState<SourceAsset | null>(null);
  const [loaded, setLoaded] = useState(initialProjectId === null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [wrongWorkflow, setWrongWorkflow] = useState<Project | null>(null);
  const idemRef = useRef<string>(newKey());
  const projectIdRef = useRef<string | null>(initialProjectId);
  const nameRef = useRef("");

  const adopt = useCallback((project: Project) => {
    projectIdRef.current = project.id;
    setProject(project);
    setProjectId(project.id);
    setProjectName(project.name);
    nameRef.current = project.name;
    setAsset(project.sourceAsset);
  }, []);

  useEffect(() => {
    if (!initialProjectId) return;
    let alive = true;
    projectsApi
      .getProject(initialProjectId)
      .then(({ project }) => {
        if (!alive) return;
        if (project.workflowType !== workflowType) {
          setWrongWorkflow(project);
        } else {
          adopt(project);
          setLoadedFromUrl(true);
        }
        setLoaded(true);
      })
      .catch(() => {
        if (alive) {
          setLoadError("This project could not be loaded. It may have been deleted, or it belongs to another account.");
          setLoaded(true);
        }
      });
    return () => {
      alive = false;
    };
  }, [initialProjectId, workflowType, adopt]);

  const ensureProject = useCallback(
    async (suggestedName?: string): Promise<string> => {
      if (projectIdRef.current) return projectIdRef.current;
      const typedName = nameRef.current.trim() ? nameRef.current : undefined;
      const suggested = suggestedName?.trim() ? suggestedName : undefined;
      const name = typedName ?? suggested;
      if (!name) {
        throw new Error("Enter a project name before continuing.");
      }
      const { project } = await projectsApi.createProject({
        name,
        workflowType,
        idempotencyKey: idemRef.current,
      });
      adopt(project);
      return project.id;
    },
    [workflowType, adopt],
  );

  const attachYouTube = useCallback(
    async (result: YouTubeValidation): Promise<void> => {
      // A YouTube source is attached at project creation. If this page
      // already created an (empty or upload-pending) project, replace
      // it — form state lives on this page, so nothing is lost.
      if (projectIdRef.current && asset?.validationStatus === "VALID") {
        throw new Error("This project already has a verified source. Remove it before attaching a YouTube link.");
      }
      if (projectIdRef.current) {
        // If replacing the placeholder project fails, surface the
        // error to the caller instead of silently continuing.
        await projectsApi.deleteProject(projectIdRef.current);
        projectIdRef.current = null;
        setProjectId(null);
      }
      idemRef.current = newKey();
      const { project } = await projectsApi.createProject({
        name: nameRef.current || "YouTube source project",
        workflowType,
        sourceType: "YOUTUBE_URL",
        youtube: { url: result.canonicalUrl, videoId: result.videoId },
        idempotencyKey: idemRef.current,
      });
      adopt(project);
    },
    [workflowType, adopt, asset],
  );

  const saveSettings = useCallback(
    async (settings: Record<string, unknown>): Promise<Project> => {
      const id = await ensureProject();
      const { project } = await projectsApi.updateProject(id, {
        name: nameRef.current || undefined,
        settings,
      });
      adopt(project);
      return project;
    },
    [ensureProject, adopt],
  );

  const setName = useCallback((name: string) => {
    nameRef.current = name;
    setProjectName(name);
  }, []);

  return {
    project,
    loadedFromUrl,
    projectId,
    projectName,
    setProjectName: setName,
    asset,
    setAsset,
    loaded,
    loadError,
    wrongWorkflow,
    ensureProject,
    attachYouTube,
    saveSettings,
  };
}
