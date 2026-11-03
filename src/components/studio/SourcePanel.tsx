import { useEffect, useRef, useState } from "react";
import { useAuth } from "../../features/auth/AuthContext";
import { navigateTo } from "../../features/auth/routing";
import { useUpload } from "../../features/studio/UploadContext";
import styles from "../../features/studio/Studio.module.css";
import {
  analysisApi,
  isJobActive,
  STAGE_LABELS as ANALYSIS_STAGE_LABELS,
  type AnalysisJob,
} from "../../services/analysis";
import { AuthApiError } from "../../services/auth";
import {
  formatBytes,
  formatDuration,
  projectsApi,
  STATUS_LABELS,
  uploadFile,
  UploadCancelledError,
  type SourceAsset,
  type StudioConfig,
  type YouTubeValidation,
} from "../../services/projects";
import { phase8Api, type Phase8Job } from "../../services/phase8";
import Button from "../Button";
import ProgressBar from "../ProgressBar";

interface SourcePanelProps {
  projectId: string | null;
  asset: SourceAsset | null;
  /** Create the project on first use (upload session / save). */
  ensureProject: (suggestedName?: string) => Promise<string>;
  /** Attach a validated YouTube link as the project source. */
  onAttachYouTube: (result: YouTubeValidation) => Promise<void>;
  onAssetChange: (asset: SourceAsset | null) => void;
  /**
   * The page's current AI clip-discovery instruction. The one-click
   * Generate flow passes it to clip analysis; when empty, the
   * project's saved AI instruction is used instead.
   */
  aiInstruction?: string;
  /**
   * Show the one-click "Generate Clips" hero action beside the URL
   * field (Create Shorts workflow). Pages whose workflow never runs
   * clip discovery (Enhance) leave this off and keep import-only.
   */
  enableGenerate?: boolean;
}

type Mode = "upload" | "youtube" | "url";

const IMPORT_STAGE_LABELS: Record<string, string> = {
  QUEUED: "Queued — waiting for a free worker",
  VALIDATING: "Checking the link…",
  DOWNLOADING: "Downloading the video from the source site…",
  VALIDATING_MEDIA: "Verifying the downloaded video…",
  FINALIZING: "Saving the video to your project…",
  COMPLETED: "Import complete",
};

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof AuthApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

function StatusChip({ asset }: { asset: SourceAsset }) {
  if (asset.validationStatus === "VALID") {
    return <span className={`${styles.chip} ${styles.chipOk}`}>✓ Verified source</span>;
  }
  if (asset.validationStatus === "FAILED") {
    return <span className={`${styles.chip} ${styles.chipError}`}>× Validation failed</span>;
  }
  if (asset.validationStatus === "REQUIRES_SOURCE_FILE") {
    return <span className={`${styles.chip} ${styles.chipWarn}`}>! Source file required</span>;
  }
  return <span className={styles.chip}>{asset.validationStatus}</span>;
}

export default function SourcePanel({
  projectId,
  asset,
  ensureProject,
  onAttachYouTube,
  onAssetChange,
  aiInstruction,
  enableGenerate = false,
}: SourcePanelProps) {
  const { isGuest } = useAuth();
  const { setActiveUpload } = useUpload();
  const [mode, setMode] = useState<Mode>("upload");
  const [config, setConfig] = useState<StudioConfig | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState<{ percent: number; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [thumbFailed, setThumbFailed] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const handleRef = useRef<{ abort: () => void } | null>(null);
  const sessionRef = useRef<string | null>(null);

  const [ytUrl, setYtUrl] = useState("");
  const [ytBusy, setYtBusy] = useState(false);
  const [ytResult, setYtResult] = useState<YouTubeValidation | null>(null);
  const [ytError, setYtError] = useState<string | null>(null);

  const [urlInput, setUrlInput] = useState("");
  const [importJob, setImportJob] = useState<Phase8Job | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const importHandledRef = useRef<string | null>(null);

  // ---- One-click Generate: import, then clip analysis automatically ----
  type GeneratePhase = "idle" | "importing" | "analyzing" | "done" | "error";
  const [generatePhase, setGeneratePhase] = useState<GeneratePhase>("idle");
  const [analysisJob, setAnalysisJob] = useState<AnalysisJob | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [generateOutcome, setGenerateOutcome] = useState<string | null>(null);
  const [clipsProjectId, setClipsProjectId] = useState<string | null>(null);
  /** True while a Generate click is waiting for its import to finish. */
  const generateWantedRef = useRef(false);
  const analysisHandledRef = useRef<string | null>(null);
  const navTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (navTimerRef.current) clearTimeout(navTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (isGuest) return;
    let alive = true;
    projectsApi
      .getStudioConfig()
      .then((cfg) => {
        if (alive) setConfig(cfg);
      })
      .catch(() => {
        if (alive) {
          setNotice(
            "Studio upload limits could not be loaded, so built-in defaults are being used. The server still enforces the real limits.",
          );
        }
      });
    return () => {
      alive = false;
    };
  }, [isGuest]);

  useEffect(() => {
    setThumbFailed(false);
  }, [asset?.id]);

  const allowedExtensions = config?.allowedExtensions ?? ["mp4", "mov", "webm"];
  const maxBytes = config?.maxUploadBytes ?? 500 * 1024 * 1024;

  const startUpload = async (file: File) => {
    setError(null);
    setNotice(null);
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (!allowedExtensions.includes(ext)) {
      setError(
        `This video format is not supported by the current processing setup. Supported formats: ${allowedExtensions
          .map((e) => `.${e}`)
          .join(", ")}.`,
      );
      return;
    }
    if (file.size > maxBytes) {
      setError(
        `This file is larger than the current upload limit of ${config?.maxUploadMb ?? 500} MB. Choose a smaller file.`,
      );
      return;
    }
    setSelectedFile(file);
    try {
      const pid = await ensureProject(file.name.replace(/\.[^.]+$/, ""));
      const { session } = await projectsApi.createUploadSession(pid, file.name, file.size);
      sessionRef.current = session.id;
      setUploading({ percent: 0, name: file.name });
      setActiveUpload({ projectId: pid, filename: file.name, percent: 0 });
      const handle = uploadFile(session.id, file, (percent) => {
        setUploading({ percent, name: file.name });
        setActiveUpload({ projectId: pid, filename: file.name, percent });
      });
      handleRef.current = handle;
      const { asset: uploaded } = await handle.promise;
      onAssetChange(uploaded);
      setNotice("Source uploaded. The server verified the video stream and read its real metadata.");
    } catch (err) {
      if (err instanceof UploadCancelledError) {
        setNotice("Upload cancelled. No source was saved from that attempt.");
      } else {
        setError(errorMessage(err, "Your upload could not be completed. Please retry."));
      }
    } finally {
      setUploading(null);
      setActiveUpload(null);
      handleRef.current = null;
    }
  };

  const cancelUpload = () => {
    handleRef.current?.abort();
    const sessionId = sessionRef.current;
    if (sessionId) {
      projectsApi.cancelUploadSession(sessionId).catch((err) => {
        console.error("Could not cancel the upload session on the server.", err);
        setNotice(
          "Upload cancelled locally. The server session could not be cleaned up immediately, so it will expire automatically.",
        );
      });
    }
  };

  const removeSource = async () => {
    if (!projectId) return;
    setBusy(true);
    setError(null);
    try {
      await projectsApi.removeSource(projectId);
      onAssetChange(null);
      setSelectedFile(null);
      setYtResult(null);
      setImportJob(null);
      setImportError(null);
      generateWantedRef.current = false;
      setAnalysisJob(null);
      setGeneratePhase("idle");
      setGenerateError(null);
      setGenerateOutcome(null);
      setClipsProjectId(null);
      setNotice("Source removed. Add a video to start creating.");
    } catch (err) {
      setError(errorMessage(err, "Could not remove the source. Please try again."));
    } finally {
      setBusy(false);
    }
  };

  const validateYouTube = async () => {
    setYtBusy(true);
    setYtError(null);
    setYtResult(null);
    try {
      const result = await projectsApi.validateYouTube(ytUrl);
      setYtResult(result);
    } catch (err) {
      setYtError(errorMessage(err, "That link could not be validated."));
    } finally {
      setYtBusy(false);
    }
  };

  const attachYouTube = async () => {
    if (!ytResult) return;
    setBusy(true);
    setYtError(null);
    try {
      await onAttachYouTube(ytResult);
      setNotice(
        "YouTube link saved with the project. It is NOT imported — upload the original file below to make it processable.",
      );
      setMode("upload");
    } catch (err) {
      setYtError(errorMessage(err, "Could not save this YouTube source."));
    } finally {
      setBusy(false);
    }
  };

  // ---- URL import (yt-dlp): paste a link, the server downloads ----
  const importActive =
    importJob !== null && (importJob.status === "QUEUED" || importJob.status === "RUNNING");
  const analysisActive = isJobActive(analysisJob);
  const generateBusy = generatePhase === "importing" || generatePhase === "analyzing";

  const beginImport = async (url: string, generate: boolean) => {
    if (!url || importActive || analysisActive) return;
    setImportError(null);
    setGenerateError(null);
    setGenerateOutcome(null);
    setNotice(null);
    importHandledRef.current = null;
    analysisHandledRef.current = null;
    setAnalysisJob(null);
    generateWantedRef.current = generate;
    if (generate) setGeneratePhase("importing");
    try {
      const pid = projectId ?? (await ensureProject());
      const { job } = await projectsApi.createUrlImport(pid, url);
      setImportJob(job);
    } catch (err) {
      generateWantedRef.current = false;
      if (generate) setGeneratePhase("idle");
      setImportError(errorMessage(err, "The import could not be started."));
    }
  };

  const startUrlImport = (urlOverride?: string) =>
    beginImport((urlOverride ?? urlInput).trim(), false);

  /** One click: import the URL, then run clip analysis automatically. */
  const startGenerate = (urlOverride?: string) =>
    beginImport((urlOverride ?? urlInput).trim(), true);

  /**
   * Second half of the one-click flow: the import is done and the
   * project was reloaded, so start clip analysis on the verified
   * asset with the page's current instruction (falling back to the
   * project's saved AI instruction), mirroring the project page.
   */
  const startAnalysis = async (project: {
    id: string;
    aiInstruction: string | null;
    settings: Record<string, unknown>;
    sourceAsset: SourceAsset | null;
  }) => {
    const imported = project.sourceAsset;
    if (!imported || imported.validationStatus !== "VALID") {
      generateWantedRef.current = false;
      setGeneratePhase("error");
      setGenerateError(
        "The video was imported, but it could not be loaded for clip analysis. Open the project page and run Find Clips there.",
      );
      return;
    }
    setGeneratePhase("analyzing");
    try {
      const prompt = aiInstruction?.trim() || project.aiInstruction || undefined;
      const language =
        typeof project.settings.language === "string" ? project.settings.language : undefined;
      const { job } = await analysisApi.createJob(project.id, {
        sourceAssetId: imported.id,
        prompt,
        language,
      });
      setAnalysisJob(job);
    } catch (err) {
      generateWantedRef.current = false;
      setGeneratePhase("error");
      setGenerateError(
        errorMessage(err, "Clip analysis could not be started. Open the project page and run Find Clips there."),
      );
    }
  };

  const cancelImport = async () => {
    if (!importJob) return;
    generateWantedRef.current = false;
    if (generatePhase === "importing") setGeneratePhase("idle");
    try {
      const { job } = await phase8Api.cancelJob(importJob.id);
      setImportJob(job);
    } catch (err) {
      setImportError(errorMessage(err, "The import could not be cancelled."));
    }
  };

  const cancelAnalysis = async () => {
    if (!analysisJob) return;
    try {
      const { job } = await analysisApi.cancelJob(analysisJob.id);
      setAnalysisJob(job);
    } catch (err) {
      setGenerateError(errorMessage(err, "The clip search could not be cancelled."));
    }
  };

  useEffect(() => {
    if (!importJob) return;
    if (importJob.status === "COMPLETED") {
      if (importHandledRef.current === importJob.id) return;
      importHandledRef.current = importJob.id;
      const pid = importJob.projectId;
      if (!pid) return;
      const generate = generateWantedRef.current;
      projectsApi
        .getProject(pid)
        .then(({ project }) => {
          if (project.sourceAsset) onAssetChange(project.sourceAsset);
          if (generate) {
            void startAnalysis(project);
          } else {
            setNotice(
              "Video imported from the URL and verified by the server. You can now run clip detection, add captions, or open it in the editor.",
            );
          }
        })
        .catch(() => {
          if (generate) {
            generateWantedRef.current = false;
            setGeneratePhase("error");
            setGenerateError(
              "The import finished, but the project could not be reloaded, so clip analysis was not started. Reopen the project to see the imported video and run Find Clips.",
            );
          } else {
            setNotice(
              "The import finished, but the project could not be reloaded. Reopen the project to see the imported video.",
            );
          }
        });
      return;
    }
    if (importJob.status === "FAILED") {
      generateWantedRef.current = false;
      if (generatePhase === "importing") setGeneratePhase("idle");
      setImportError(importJob.error ?? "The import failed.");
      return;
    }
    if (importJob.status === "CANCELLED") {
      generateWantedRef.current = false;
      if (generatePhase === "importing") setGeneratePhase("idle");
      setNotice("Import cancelled. No source was saved from that attempt.");
      return;
    }
    const timer = setInterval(() => {
      phase8Api
        .getJob(importJob.id)
        .then(({ job }) => setImportJob(job))
        .catch(() => {
          /* transient poll failure — the next tick retries */
        });
    }, 1500);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importJob]);

  // Poll the chained analysis job to its terminal state, then finish
  // the one-click flow: clips found → show the count and take the user
  // to the project's clips; an honest no-result outcome stays here and
  // is stated plainly.
  useEffect(() => {
    if (!analysisJob) return;
    if (isJobActive(analysisJob)) {
      const timer = setInterval(() => {
        analysisApi
          .getJob(analysisJob.id)
          .then(({ job }) => setAnalysisJob(job))
          .catch(() => {
            /* transient poll failure — the next tick retries */
          });
      }, 2000);
      return () => clearInterval(timer);
    }
    if (analysisHandledRef.current === analysisJob.id) return;
    analysisHandledRef.current = analysisJob.id;
    generateWantedRef.current = false;
    if (analysisJob.status === "COMPLETED") {
      setGeneratePhase("done");
      if (analysisJob.outcome === "CLIPS_FOUND") {
        setClipsProjectId(analysisJob.projectId);
        setGenerateOutcome(
          `${analysisJob.candidateCount} candidate clip${analysisJob.candidateCount === 1 ? "" : "s"} generated. Taking you to your clips…`,
        );
        const pid = analysisJob.projectId;
        navTimerRef.current = setTimeout(() => navigateTo(`app/projects/${pid}`), 1500);
      } else if (analysisJob.outcome === "NO_SPEECH") {
        setGenerateOutcome(
          "Analysis completed, but no speech was detected in this video, so no clips could be generated.",
        );
      } else if (analysisJob.outcome === "NO_CLIPS_FOUND") {
        setGenerateOutcome(
          "Analysis completed — speech was transcribed, but no complete moment matched the clip-length settings, so no clips were generated.",
        );
      } else {
        setClipsProjectId(analysisJob.projectId);
        setGenerateOutcome("Analysis completed. Open the project to review the results.");
      }
    } else if (analysisJob.status === "FAILED") {
      setGeneratePhase("error");
      setGenerateError(
        analysisJob.error ?? "Clip analysis failed. You can retry from the project page.",
      );
    } else if (analysisJob.status === "CANCELLED") {
      setGeneratePhase("idle");
      setNotice("Clip search cancelled. The imported video stays saved as the project source.");
    }
  }, [analysisJob]);

  const hasValidAsset = asset?.validationStatus === "VALID";

  return (
    <div>
      {/* ---- Current source preview ---- */}
      {asset && (
        <div className={styles.stack} style={{ marginBottom: "var(--space-6)" }}>
          {asset.sourceType === "YOUTUBE_URL" ? (
            <div className={`${styles.banner} ${styles.bannerWarn}`} role="note">
              <strong>YouTube source — file still required.</strong>
              <br />
              Link: {asset.sourceUrl ?? "—"} (video ID {asset.externalId ?? "—"}). This link was
              validated only; no media was imported from YouTube. Upload the original video file
              you own or are authorized to process to continue — or paste the link under Import
              from URL to have the server download it.
            </div>
          ) : asset.validationStatus === "FAILED" ? (
            <p className={styles.errorText} role="alert">
              <strong>Source failed validation:</strong>{" "}
              {asset.validationError ?? "The file could not be verified as a video."} Choose a
              different file below.
            </p>
          ) : hasValidAsset ? (
            <>
              <div className={styles.sourceLayout}>
                <div>
                  {asset.hasThumbnail && !thumbFailed ? (
                    <img
                      className={styles.thumb}
                      src={projectsApi.thumbnailUrl(asset.id)}
                      alt={`Thumbnail of ${asset.originalFilename}`}
                      onError={() => setThumbFailed(true)}
                    />
                  ) : (
                    <div className={styles.thumbEmpty}>NO THUMBNAIL AVAILABLE</div>
                  )}
                </div>
                <dl className={styles.metaGrid}>
                  <div className={styles.metaItem}><dt>Filename</dt><dd>{asset.originalFilename}</dd></div>
                  {asset.sourceType === "URL_IMPORT" && (
                    <div className={styles.metaItem}><dt>Imported from</dt><dd>{asset.sourceUrl ?? "—"}</dd></div>
                  )}
                  <div className={styles.metaItem}><dt>Duration</dt><dd>{formatDuration(asset.duration)}</dd></div>
                  <div className={styles.metaItem}><dt>File size</dt><dd>{formatBytes(asset.fileSize)}</dd></div>
                  <div className={styles.metaItem}>
                    <dt>Resolution</dt>
                    <dd>{asset.width && asset.height ? `${asset.width} × ${asset.height}` : "—"}</dd>
                  </div>
                  <div className={styles.metaItem}>
                    <dt>Frame rate</dt>
                    <dd>{asset.frameRate ? `${asset.frameRate} fps` : "Not reported"}</dd>
                  </div>
                  <div className={styles.metaItem}><dt>Video codec</dt><dd>{asset.videoCodec ?? "—"}</dd></div>
                  <div className={styles.metaItem}><dt>Audio codec</dt><dd>{asset.audioCodec ?? "None"}</dd></div>
                  <div className={styles.metaItem}>
                    <dt>Audio stream</dt>
                    <dd>{asset.hasAudio ? "Present" : "No audio stream"}</dd>
                  </div>
                  <div className={styles.metaItem}><dt>Container</dt><dd>{asset.container ?? "—"}</dd></div>
                  <div className={styles.metaItem}>
                    <dt>Bitrate</dt>
                    <dd>{asset.bitrate ? `${(asset.bitrate / 1_000_000).toFixed(2)} Mbps` : "—"}</dd>
                  </div>
                  <div className={styles.metaItem}><dt>Source status</dt><dd><StatusChip asset={asset} /></dd></div>
                  <div className={styles.metaItem}>
                    <dt>Processing eligibility</dt>
                    <dd>Eligible — verified by the server</dd>
                  </div>
                </dl>
              </div>
              <video
                className={styles.videoPreview}
                controls
                preload="metadata"
                src={projectsApi.streamUrl(asset.id)}
                aria-label={`Preview of ${asset.originalFilename}`}
              />
            </>
          ) : (
            <p className={styles.muted}>Source status: {STATUS_LABELS[asset.validationStatus] ?? asset.validationStatus}</p>
          )}
          <div className={styles.buttonRow}>
            <Button variant="secondary" onClick={() => setMode("upload")} disabled={busy || Boolean(uploading)}>
              Replace source
            </Button>
            <Button variant="ghost" onClick={removeSource} disabled={busy || Boolean(uploading)}>
              {busy ? "Removing…" : "Remove source"}
            </Button>
          </div>
        </div>
      )}

      {/* ---- One-click Generate progress / result (stays visible
          across both phases, even after the imported asset replaces
          the source-selection section below) ---- */}
      {generatePhase === "importing" && (
        <div className={styles.banner} role="status" aria-live="polite" style={{ marginBottom: "var(--space-6)" }}>
          <strong>Generate Clips — step 1 of 2 · Importing the video…</strong>
          <br />
          {importJob
            ? (IMPORT_STAGE_LABELS[importJob.stage] ?? importJob.stage)
            : "Starting the import…"}
        </div>
      )}
      {generatePhase === "analyzing" && (
        <div className={styles.banner} role="status" aria-live="polite" style={{ marginBottom: "var(--space-6)" }}>
          <strong>Generate Clips — step 2 of 2 · Finding clips…</strong>
          <br />
          {analysisJob
            ? (ANALYSIS_STAGE_LABELS[analysisJob.stage] ?? analysisJob.stage)
            : "Starting clip analysis…"}
        </div>
      )}
      {generatePhase === "done" && generateOutcome && (
        <div className={`${styles.banner} ${styles.bannerLime}`} role="status" style={{ marginBottom: "var(--space-6)" }}>
          <strong>Generate Clips — done.</strong>
          <br />
          {generateOutcome}
          {clipsProjectId && (
            <>
              {" "}
              <a href={`#/app/projects/${clipsProjectId}`}>
                <strong>View clips →</strong>
              </a>
            </>
          )}
        </div>
      )}
      {generatePhase === "error" && generateError && (
        <p className={styles.errorText} role="alert" style={{ marginBottom: "var(--space-6)" }}>
          <strong>Generate Clips problem:</strong> {generateError}
        </p>
      )}

      {/* ---- Source selection ---- */}
      {!hasValidAsset && (
        <>
          <div className={styles.sourceTabs} role="tablist" aria-label="Source type">
            <button type="button" role="tab" aria-selected={mode === "upload"} className={mode === "upload" ? styles.sourceTabActive : styles.sourceTab} onClick={() => setMode("upload")}>
              Upload Video
            </button>
            <button type="button" role="tab" aria-selected={mode === "youtube"} className={mode === "youtube" ? styles.sourceTabActive : styles.sourceTab} onClick={() => setMode("youtube")}>
              YouTube URL
            </button>
            <button type="button" role="tab" aria-selected={mode === "url"} className={mode === "url" ? styles.sourceTabActive : styles.sourceTab} onClick={() => setMode("url")}>
              Import from URL
            </button>
          </div>

          {mode === "upload" && (
            <div>
              <div
                className={`${styles.dropzone} ${dragOver ? styles.dropzoneDrag : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  const file = e.dataTransfer.files?.[0];
                  if (file) void startUpload(file);
                }}
              >
                <strong>{asset ? "Drop a replacement video here" : "Drag and drop your video here"}</strong>
                <span>
                  Supported: {allowedExtensions.map((e) => `.${e}`).join(", ")} · up to{" "}
                  {config?.maxUploadMb ?? 500} MB · stored on this server only
                </span>
                <Button
                  variant="primary"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={Boolean(uploading)}
                >
                  Browse files
                </Button>
                <input
                  ref={fileInputRef}
                  className={styles.hiddenInput}
                  type="file"
                  accept={allowedExtensions.map((e) => `.${e}`).join(",")}
                  aria-label="Choose a video file to upload"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file) void startUpload(file);
                  }}
                />
              </div>
              <p className={styles.muted}>Choose a video you own or are authorized to process.</p>

              {uploading && (
                <div className={styles.progressWrap} role="status">
                  <ProgressBar value={uploading.percent} label={`Uploading ${uploading.name}`} />
                  <div className={styles.buttonRow}>
                    <Button variant="secondary" onClick={cancelUpload}>Cancel upload</Button>
                    <span className={styles.muted}>Upload status: Uploading — the server confirms success only after verifying the file.</span>
                  </div>
                </div>
              )}
              {!uploading && error && selectedFile && (
                <div className={styles.buttonRow}>
                  <Button variant="secondary" onClick={() => void startUpload(selectedFile)}>
                    Retry upload
                  </Button>
                </div>
              )}
            </div>
          )}

          {mode === "youtube" && (
            <div className={styles.stack}>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="yt-url">YouTube URL</label>
                <input
                  id="yt-url"
                  className={styles.input}
                  type="url"
                  placeholder="https://www.youtube.com/watch?v=…"
                  value={ytUrl}
                  onChange={(e) => setYtUrl(e.target.value)}
                />
              </div>
              <div className={styles.buttonRow}>
                <Button variant="primary" onClick={validateYouTube} loading={ytBusy} disabled={!ytUrl.trim()}>
                  Validate link
                </Button>
              </div>
              {ytError && (
                <p className={styles.errorText} role="alert"><strong>Invalid link:</strong> {ytError}</p>
              )}
              {ytResult && (
                <div className={styles.banner} role="status">
                  <dl className={styles.kvList}>
                    <div className={styles.kvRow}><dt>1. URL format valid</dt><dd>Yes — video ID {ytResult.videoId}</dd></div>
                    <div className={styles.kvRow}>
                      <dt>2. Metadata available</dt>
                      <dd>{ytResult.metadataAvailable ? `Yes — “${ytResult.metadata?.title ?? "Untitled"}” by ${ytResult.metadata?.channelTitle ?? "unknown"}` : "No"}</dd>
                    </div>
                    <div className={styles.kvRow}><dt>3. Source authorization verified</dt><dd>No</dd></div>
                    <div className={styles.kvRow}><dt>4. Media available for processing</dt><dd>No</dd></div>
                    <div className={styles.kvRow}><dt>5. Video imported</dt><dd>No — validation never downloads; use the button below to fetch it</dd></div>
                  </dl>
                  <p className={styles.muted}>{ytResult.metadataNote}</p>
                  <p>{ytResult.message}</p>
                  <p className={styles.muted}>Import the video from its URL, or upload the file — only for videos you are authorized to process.</p>
                  <div className={styles.buttonRow}>
                    <Button
                      variant="primary"
                      onClick={() => {
                        setUrlInput(ytUrl);
                        setMode("url");
                        if (enableGenerate) {
                          void startGenerate(ytUrl);
                        } else {
                          void startUrlImport(ytUrl);
                        }
                      }}
                      disabled={busy || importActive || analysisActive || generateBusy}
                    >
                      {enableGenerate ? "Import & generate clips" : "Import this video"}
                    </Button>
                    <Button variant="secondary" onClick={attachYouTube} disabled={busy}>
                      Save link to project (still needs the file)
                    </Button>
                  </div>
                </div>
              )}
              <p className={styles.muted}>Choose a video you own or are authorized to process.</p>
            </div>
          )}

          {mode === "url" && (
            <div className={styles.stack}>
              {config && config.urlImport && !config.urlImport.enabled ? (
                <div className={`${styles.banner} ${styles.bannerWarn}`} role="note">
                  <strong>URL import is unavailable on this server.</strong>
                  <br />
                  {config.urlImport.detail} Upload a video file instead.
                </div>
              ) : (
                <>
                  <div className={styles.urlRow}>
                    <div className={`${styles.field} ${styles.urlGrow}`}>
                      <label className={styles.label} htmlFor="import-url">Video URL</label>
                      <input
                        id="import-url"
                        className={styles.input}
                        type="url"
                        placeholder="https://www.youtube.com/watch?v=… or a direct link to a video file"
                        value={urlInput}
                        onChange={(e) => setUrlInput(e.target.value)}
                        disabled={generateBusy}
                      />
                    </div>
                    {enableGenerate ? (
                      <Button
                        variant="primary"
                        onClick={() => void startGenerate()}
                        disabled={!urlInput.trim() || generateBusy || importActive || analysisActive}
                      >
                        {generatePhase === "importing"
                          ? "Importing…"
                          : generatePhase === "analyzing"
                            ? "Finding clips…"
                            : "Generate Clips"}
                      </Button>
                    ) : (
                      <Button
                        variant="primary"
                        onClick={() => void startUrlImport()}
                        disabled={!urlInput.trim() || importActive}
                      >
                        {importActive ? "Importing…" : "Import video"}
                      </Button>
                    )}
                  </div>
                  <div className={styles.buttonRow}>
                    {enableGenerate && (
                      <Button
                        variant="secondary"
                        onClick={() => void startUrlImport()}
                        disabled={!urlInput.trim() || generateBusy || importActive || analysisActive}
                      >
                        Import only (no clip search)
                      </Button>
                    )}
                    {importActive && (
                      <Button variant="secondary" onClick={() => void cancelImport()}>
                        Cancel import
                      </Button>
                    )}
                    {analysisActive && (
                      <Button variant="secondary" onClick={() => void cancelAnalysis()}>
                        Cancel clip search
                      </Button>
                    )}
                  </div>
                  {importJob && importJob.status !== "FAILED" && (
                    <p className={styles.muted} role="status">
                      Import status:{" "}
                      {importJob.status === "COMPLETED"
                        ? IMPORT_STAGE_LABELS.COMPLETED
                        : importJob.status === "CANCELLED"
                          ? "Cancelled"
                          : (IMPORT_STAGE_LABELS[importJob.stage] ?? importJob.stage)}
                    </p>
                  )}
                  {importError && (
                    <p className={styles.errorText} role="alert">
                      <strong>Import failed:</strong> {importError}
                    </p>
                  )}
                  <p className={styles.muted}>
                    {enableGenerate ? (
                      <>
                        <strong>Generate Clips</strong> does the whole job in one click: the server
                        downloads the video (best quality up to 1080p, up to{" "}
                        {config?.maxUploadMb ?? 500} MB), verifies it exactly like an upload, saves
                        it as this project&apos;s source, and immediately runs clip detection with
                        your AI instruction from Step 4 — then takes you to the clips it found.
                        “Import only” stops after the download.{" "}
                      </>
                    ) : (
                      <>
                        The server downloads the video (best quality up to 1080p, up to{" "}
                        {config?.maxUploadMb ?? 500} MB), verifies it exactly like an upload, and
                        saves it as this project&apos;s source — then captions and the editor work
                        on it as usual.{" "}
                      </>
                    )}
                    Some sites block server IPs or require sign-in for some videos; those imports
                    fail here with the reason shown. Only import videos you own or are authorized
                    to process.
                  </p>
                </>
              )}
              <div className={`${styles.banner} ${styles.bannerWarn}`} role="note">
                <strong>Cloud storage import is not configured.</strong>
                <br />
                No cloud storage provider (Google Drive, Dropbox, …) is connected to this
                CLIPFORGE server, so importing from cloud storage is unavailable — use a file
                upload or a URL above. Do not treat this as a working integration.
              </div>
            </div>
          )}
        </>
      )}

      {error && mode === "upload" && (
        <p className={styles.errorText} role="alert" style={{ marginTop: "var(--space-4)" }}>
          <strong>Upload problem:</strong> {error}
        </p>
      )}
      {asset?.validationStatus !== "VALID" && !asset && !uploading && !error && mode === "upload" && (
        <p className={styles.muted} style={{ marginTop: "var(--space-4)" }}>
          No uploaded source yet — add a video to start creating.
        </p>
      )}
      {notice && (
        <p className={styles.muted} role="status" style={{ marginTop: "var(--space-4)" }}>{notice}</p>
      )}
      {projectId === null && (
        <p className={styles.small} style={{ color: "var(--text-faint)" }}>
          The project is created automatically when you add a source or save.
        </p>
      )}
    </div>
  );
}
