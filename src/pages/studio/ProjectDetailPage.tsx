import { useCallback, useEffect, useState } from "react";
import GuestRestriction from "../../components/studio/GuestRestriction";
import { StatusChipFor } from "../../components/studio/ProjectCardView";
import { useAuth } from "../../features/auth/AuthContext";
import styles from "../../features/studio/Studio.module.css";
import {
  analysisApi,
  formatClock,
  formatElapsed,
  isJobActive,
  STAGE_LABELS,
  type AnalysisConfig,
  type AnalysisJob,
  type CandidateClip,
  type Transcript,
} from "../../services/analysis";
import { AuthApiError } from "../../services/auth";
import {
  formatBytes,
  formatDate,
  formatDuration,
  projectsApi,
  WORKFLOW_LABELS,
  type Project,
} from "../../services/projects";

const SETTING_LABELS: Record<string, string> = {
  clipCount: "Clip count",
  customClipCount: "Custom clip count",
  clipDuration: "Clip duration",
  customClipDurationSec: "Custom duration (sec)",
  aspectRatio: "Aspect ratio",
  resolution: "Resolution",
  targetPlatform: "Target platform",
  language: "Language",
  tracking: "Tracking",
  zoom: "Zoom",
  reframeAspect: "Auto reframe",
  faceTracking: "Face tracking",
  captionsMode: "Captions",
  discoveryPrompt: "AI discovery instructions",
  transcriptionContext: "Transcription context",
};

function settingValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (key === "captions" && typeof value === "object") {
    const c = value as { enabled?: boolean; style?: string; animatedHighlight?: boolean };
    return `${c.enabled ? "On" : "Off"} · style ${c.style ?? "—"} · animated highlighting ${c.animatedHighlight ? "on" : "off"}`;
  }
  if (Array.isArray(value)) return value.length ? value.join(", ") : "None selected";
  return String(value);
}

const PROMPT_EXAMPLES = [
  "Find interesting moments.",
  "Find educational tips.",
  "Find funny moments.",
  "Find powerful statements.",
  "Find questions and answers.",
  "Find motivational moments.",
  "Find technical explanations.",
];

/**
 * Find Clips (Phase 4): starts the real server-side analysis pipeline,
 * polls the persisted job status, and renders whatever transcript and
 * candidate clips the pipeline actually produced. Nothing here is
 * simulated: an empty transcript shows the server's NO_SPEECH outcome,
 * and an unconfigured transcription provider disables the run with the
 * server's own configuration message.
 */
function FindClipsPanel({ project, isGuest }: { project: Project; isGuest: boolean }) {
  const asset = project.sourceAsset;
  // Mirrors the server gate (analysis.ts): any source with a verified
  // local file is analysable — uploads AND URL imports. VALID is only
  // ever assigned after the server probed a stored file; link-only
  // YouTube sources stay REQUIRES_SOURCE_FILE and are excluded.
  const sourceReady = Boolean(asset && asset.validationStatus === "VALID");
  const [config, setConfig] = useState<AnalysisConfig | null>(null);
  const [job, setJob] = useState<AnalysisJob | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [candidates, setCandidates] = useState<CandidateClip[]>([]);
  const [sort, setSort] = useState<"score" | "start" | "shortest" | "longest">("score");
  const [prompt, setPrompt] = useState(project.aiInstruction ?? "");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showTranscript, setShowTranscript] = useState(false);
  const [titleDrafts, setTitleDrafts] = useState<Record<string, string>>({});

  const loadResults = useCallback(async () => {
    const [{ transcript: loadedTranscript }, { candidates: loadedCandidates }] = await Promise.all([
      analysisApi.getTranscript(project.id),
      analysisApi.listCandidates(project.id, sort),
    ]);
    setTranscript(loadedTranscript);
    setCandidates(loadedCandidates);
  }, [project.id, sort]);

  const loadAll = useCallback(async () => {
    if (isGuest) return;
    try {
      const [loadedConfig, { jobs }] = await Promise.all([
        analysisApi.getConfig(),
        analysisApi.listJobs(project.id),
      ]);
      setConfig(loadedConfig);
      setJob(jobs[0] ?? null);
      await loadResults();
    } catch (err) {
      setActionError(err instanceof AuthApiError ? err.message : "Analysis status could not be loaded.");
    }
  }, [isGuest, loadResults, project.id]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // Poll the real persisted job while it is active. The interval only
  // re-reads server state — progress is never simulated locally, and a
  // page refresh recovers the same job from the API.
  useEffect(() => {
    if (!job || !isJobActive(job)) return;
    const timer = setInterval(() => {
      analysisApi
        .getJob(job.id)
        .then(({ job: fresh }) => {
          setJob(fresh);
          if (!isJobActive(fresh)) void loadResults();
        })
        .catch(() => {
          /* keep the last known state; the next poll retries */
        });
    }, 2000);
    return () => clearInterval(timer);
  }, [job, loadResults]);

  useEffect(() => {
    if (!isGuest) void loadResults().catch(() => undefined);
  }, [sort, isGuest, loadResults]);

  const runAction = async (action: () => Promise<void>) => {
    setBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setActionError(err instanceof AuthApiError ? err.message : "That action could not be completed.");
    } finally {
      setBusy(false);
    }
  };

  const startJob = () =>
    runAction(async () => {
      if (!asset) return;
      const language = typeof project.settings.language === "string" ? project.settings.language : undefined;
      const { job: created } = await analysisApi.createJob(project.id, {
        sourceAssetId: asset.id,
        prompt,
        language,
      });
      setJob(created);
    });

  const cancelJob = () =>
    runAction(async () => {
      if (!job) return;
      const { job: updated } = await analysisApi.cancelJob(job.id);
      setJob(updated);
    });

  const retryJob = () =>
    runAction(async () => {
      if (!job) return;
      const { job: updated } = await analysisApi.retryJob(job.id);
      setJob(updated);
      setCandidates([]);
      setTranscript(null);
    });

  const saveTitle = (candidate: CandidateClip) =>
    runAction(async () => {
      const title = (titleDrafts[candidate.id] ?? candidate.title).trim();
      if (!title || title === candidate.title) return;
      const { candidate: updated } = await analysisApi.updateCandidate(candidate.id, { title });
      setCandidates((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
    });

  // Three distinct states: SELECTED (checkbox on), DESELECTED (checkbox
  // off — kept, just not in the user's working selection) and REMOVED
  // (the separate Remove action). The client service type still declares
  // the pre-v10 two-state union, hence the cast on the patch object.
  const setCandidateStatus = (
    candidate: CandidateClip,
    status: "SELECTED" | "DESELECTED" | "REMOVED",
  ) =>
    runAction(async () => {
      const { candidate: updated } = await analysisApi.updateCandidate(candidate.id, {
        status: status as CandidateClip["status"],
      });
      setCandidates((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
    });

  const active = isJobActive(job);
  const configBlocked = config !== null && !config.configured;
  const findDisabled = isGuest || !sourceReady || configBlocked || active || busy;

  return (
    <section className={styles.panel} aria-labelledby="pd-ai">
      <h3 id="pd-ai">Find Clips — AI clip detection</h3>
      {isGuest ? (
        <GuestRestriction action="Find clips in this video" />
      ) : (
        <div className={styles.stack} style={{ gap: "var(--space-4)" }}>
          <p className={styles.panelIntro} style={{ margin: 0 }}>
            CLIPFORGE transcribes the real audio with{" "}
            {config ? `${config.provider} (model ${config.model})` : "the configured speech-to-text provider"},
            finds complete-sentence moments using pauses and scene changes, ranks them from measured
            signals, and cuts genuine preview clips with FFmpeg. The original video is never modified.
          </p>

          {configBlocked && (
            <p className={`${styles.banner} ${styles.bannerError}`} role="alert">
              <strong>Transcription is not configured on this server.</strong>
              <br />
              {config?.detail}
            </p>
          )}
          {!sourceReady && (
            <p className={`${styles.banner} ${styles.bannerWarn}`} role="note">
              <strong>A valid source video is required.</strong> Add or replace the source above
              (upload a file, or import one from a URL) before running clip detection.
            </p>
          )}

          <div className={styles.field}>
            <label className={styles.label} htmlFor="pd-prompt">
              What should AI find in this video? (optional)
            </label>
            <textarea
              id="pd-prompt"
              className={styles.textarea}
              maxLength={500}
              placeholder="e.g. Find powerful statements, questions and answers, or technical explanations."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={active || busy}
            />
            <span className={styles.charCount}>{prompt.length}/500</span>
          </div>
          <div className={styles.buttonRow}>
            {PROMPT_EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                className={styles.sourceTab}
                onClick={() => setPrompt(example)}
                disabled={active || busy}
              >
                {example}
              </button>
            ))}
          </div>

          <div className={styles.buttonRow}>
            <button
              type="button"
              className={styles.textButton}
              onClick={() => void startJob()}
              disabled={findDisabled}
            >
              {active ? "Analysis running…" : "Find Clips"}
            </button>
            {active && (
              <button type="button" className={styles.textButton} onClick={() => void cancelJob()} disabled={busy}>
                Cancel job
              </button>
            )}
            {job && (job.status === "FAILED" || job.status === "CANCELLED") && (
              <button type="button" className={styles.textButton} onClick={() => void retryJob()} disabled={busy}>
                Retry job
              </button>
            )}
          </div>

          {actionError && (
            <p className={styles.errorText} role="alert">
              <strong>Problem:</strong> {actionError}
            </p>
          )}

          {job && (
            <div className={styles.banner} role="status">
              <strong>
                {job.status === "COMPLETED"
                  ? "Analysis completed"
                  : job.status === "FAILED"
                    ? job.errorCode === "CONFIGURATION_ERROR"
                      ? "Configuration problem"
                      : "Analysis failed"
                    : job.status === "CANCELLED"
                      ? "Analysis cancelled"
                      : `Working — ${STAGE_LABELS[job.stage] ?? job.stage}`}
              </strong>
              <br />
              Stage: {STAGE_LABELS[job.stage] ?? job.stage} · Elapsed:{" "}
              {formatElapsed(job.startedAt ?? job.createdAt, job.finishedAt)}
              {job.status === "COMPLETED" && job.outcome === "NO_SPEECH" && (
                <>
                  <br />
                  No speech was detected in this video, so no clips could be generated.
                </>
              )}
              {job.status === "COMPLETED" && job.outcome === "NO_CLIPS_FOUND" && (
                <>
                  <br />
                  Speech was transcribed, but no complete moment matched the clip-length settings.
                </>
              )}
              {job.status === "COMPLETED" && job.outcome === "CLIPS_FOUND" && (
                <>
                  <br />
                  {job.candidateCount} candidate clip{job.candidateCount === 1 ? "" : "s"} generated below.
                </>
              )}
              {job.error && (
                <>
                  <br />
                  <span className={styles.errorText}>{job.error}</span>
                </>
              )}
            </div>
          )}

          {transcript && (
            <div>
              <div className={styles.buttonRow}>
                <button
                  type="button"
                  className={styles.textButton}
                  aria-expanded={showTranscript}
                  onClick={() => setShowTranscript((v) => !v)}
                >
                  {showTranscript ? "Hide transcript" : "Show transcript"}
                </button>
                <span className={styles.muted}>
                  Language: {transcript.language ?? "not reported"}
                  {transcript.languageProbability !== null
                    ? ` (${Math.round(transcript.languageProbability * 100)}%)`
                    : ""}{" "}
                  · Provider: {transcript.provider} · Model: {transcript.model} · Timestamps:{" "}
                  {transcript.hasWordTimestamps ? "word-level" : "sentence-level"}
                </span>
              </div>
              {showTranscript && (
                <div className={styles.stack} style={{ gap: "var(--space-3)", marginTop: "var(--space-3)" }}>
                  <p className={`${styles.banner} ${styles.bannerWarn}`} role="note">
                    Speaker identification is not available from the configured provider, so no
                    speaker labels are shown — CLIPFORGE does not guess who is speaking.
                  </p>
                  {transcript.topics.length > 0 && (
                    <p className={styles.muted} style={{ margin: 0 }}>
                      Topic segments:{" "}
                      {transcript.topics
                        .map((t) => `${formatClock(t.startSec)} ${t.label}`)
                        .join(" · ")}
                    </p>
                  )}
                  <div>
                    {transcript.segments.map((segment) => (
                      <p key={segment.id} style={{ margin: "0 0 var(--space-2)" }}>
                        <span className={styles.muted}>
                          [{formatClock(segment.startSec)}–{formatClock(segment.endSec)}]{" "}
                        </span>
                        {segment.text}
                      </p>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {candidates.length > 0 && (
            <div>
              <div className={styles.buttonRow} style={{ marginBottom: "var(--space-3)" }}>
                <strong>Candidate clips</strong>
                <label className={styles.small}>
                  Sort{" "}
                  <select
                    className={styles.select}
                    value={sort}
                    onChange={(e) => setSort(e.target.value as "score" | "start" | "shortest" | "longest")}
                  >
                    <option value="score">Highest score</option>
                    <option value="shortest">Shortest duration</option>
                    <option value="longest">Longest duration</option>
                    <option value="start">Timeline order</option>
                  </select>
                </label>
              </div>
              <div className={styles.stack} style={{ gap: "var(--space-4)" }}>
                {candidates.map((candidate) => (
                  <article
                    key={candidate.id}
                    className={styles.panel}
                    style={candidate.status === "REMOVED" ? { opacity: 0.65 } : undefined}
                  >
                    <div className={styles.buttonRow} style={{ justifyContent: "space-between" }}>
                      <strong>Score {candidate.score}/100</strong>
                      <span className={styles.muted}>
                        {formatClock(candidate.startSec)}–{formatClock(candidate.endSec)} ·{" "}
                        {candidate.duration.toFixed(1)}s
                      </span>
                    </div>
                    {candidate.previewStatus === "READY" ? (
                      <video
                        className={styles.videoPreview}
                        controls
                        preload="metadata"
                        src={analysisApi.previewUrl(candidate.id)}
                        aria-label={`Preview of ${candidate.title}`}
                      />
                    ) : candidate.previewStatus === "FAILED" ? (
                      <p className={styles.errorText} role="alert">
                        <strong>Preview problem:</strong>{" "}
                        {candidate.previewError ?? "The preview clip could not be generated."}
                      </p>
                    ) : (
                      <p className={styles.muted}>Preview {candidate.previewStatus.toLowerCase()}…</p>
                    )}
                    <div className={styles.field} style={{ marginTop: "var(--space-3)" }}>
                      <label className={styles.label} htmlFor={`title-${candidate.id}`}>
                        Clip title
                      </label>
                      <input
                        id={`title-${candidate.id}`}
                        className={styles.input}
                        maxLength={160}
                        value={titleDrafts[candidate.id] ?? candidate.title}
                        onChange={(e) =>
                          setTitleDrafts((prev) => ({ ...prev, [candidate.id]: e.target.value }))
                        }
                        onBlur={() => void saveTitle(candidate)}
                      />
                    </div>
                    <p className={styles.muted} style={{ marginBottom: "var(--space-2)" }}>
                      Suggested title: {candidate.suggestedTitle}
                    </p>
                    <p style={{ margin: "0 0 var(--space-2)" }}>{candidate.transcriptExcerpt}</p>
                    <details>
                      <summary>Why this moment?</summary>
                      <ul>
                        {candidate.reasons.map((reason) => (
                          <li key={reason}>{reason}</li>
                        ))}
                      </ul>
                    </details>
                    <div className={styles.buttonRow} style={{ marginTop: "var(--space-3)" }}>
                      <label
                        style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)" }}
                      >
                        <input
                          type="checkbox"
                          checked={candidate.status === "SELECTED"}
                          disabled={busy || candidate.status === "REMOVED"}
                          onChange={(e) =>
                            void setCandidateStatus(
                              candidate,
                              e.target.checked ? "SELECTED" : "DESELECTED",
                            )
                          }
                        />
                        Select clip
                      </label>
                      {candidate.status === "REMOVED" ? (
                        <button
                          type="button"
                          className={styles.textButton}
                          onClick={() => void setCandidateStatus(candidate, "DESELECTED")}
                          disabled={busy}
                        >
                          Restore
                        </button>
                      ) : (
                        <button
                          type="button"
                          className={styles.textButton}
                          onClick={() => void setCandidateStatus(candidate, "REMOVED")}
                          disabled={busy}
                        >
                          Remove
                        </button>
                      )}
                      <a href={`#/app/projects/${candidate.projectId}/editor?clip=${candidate.id}`}>
                        Open in Editor
                      </a>
                      <span className={styles.muted}>
                        {candidate.status === "SELECTED"
                          ? "Selected"
                          : candidate.status === "REMOVED"
                            ? "Removed"
                            : "Not selected"}
                      </span>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Project detail (Phase 3 + 4): real overview, source + server-read
 * metadata, saved configuration, and the Phase 4 Find Clips panel
 * (real transcription, ranking and FFmpeg preview generation).
 */
export default function ProjectDetailPage({ projectId }: { projectId: string }) {
  const { isGuest } = useAuth();
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [thumbFailed, setThumbFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setProject(null);
    setError(null);
    setThumbFailed(false);
    if (isGuest) {
      setError("Demo Mode does not store projects. Create a free account to open real project pages.");
      return;
    }
    projectsApi
      .getProject(projectId)
      .then(({ project: loaded }) => {
        if (alive) setProject(loaded);
      })
      .catch((err) => {
        if (alive) {
          setError(
            err instanceof AuthApiError && err.status === 404
              ? "This project was not found. It may have been deleted, or it belongs to another account."
              : err instanceof AuthApiError
                ? err.message
                : "The project could not be loaded.",
          );
        }
      });
    return () => {
      alive = false;
    };
  }, [projectId, isGuest]);

  if (error) {
    return (
      <div className={styles.stack}>
        <p className={styles.errorText} role="alert"><strong>Problem:</strong> {error}</p>
        <p><a href="#/app/projects">← Back to Projects</a></p>
      </div>
    );
  }
  if (!project) return <p className={styles.muted} role="status">Loading project…</p>;

  const asset = project.sourceAsset;
  const editHref =
    project.workflowType === "LONG_VIDEO_TO_SHORTS"
      ? `#/app/studio/create?project=${project.id}`
      : `#/app/studio/enhance?project=${project.id}`;
  const settingsEntries = Object.entries(project.settings).filter(
    ([, v]) => v !== null && v !== undefined && v !== "",
  );

  return (
    <div className={styles.stack}>
      <p style={{ margin: 0 }}>
        <a href="#/app/projects">← Back to Projects</a> · <a href="#/app/studio">Studio</a>
      </p>

      <section aria-labelledby="pd-overview">
        <h2 id="pd-overview" className={styles.heading}>{project.name}</h2>
        <p className={styles.muted}>
          {WORKFLOW_LABELS[project.workflowType]} · Created {formatDate(project.createdAt)} · Updated{" "}
          {formatDate(project.updatedAt)}
        </p>
        <p><StatusChipFor status={project.status} /></p>
        {asset && asset.validationStatus === "VALID" && (
          <p style={{ marginTop: "var(--space-3)" }}>
            <a href={`#/app/projects/${project.id}/editor`}>
              <strong>Open in Editor →</strong>
            </a>{" "}
            <span className={styles.muted}>
              Multi-track timeline editor: trim, captions, scenes, music and real FFmpeg renders.
            </span>
          </p>
        )}
      </section>

      <section className={styles.panel} aria-labelledby="pd-source">
        <h3 id="pd-source">Original source</h3>
        {!asset ? (
          <p className={styles.muted}>
            No source yet — add a video to start creating.{" "}
            <a href={editHref}>Add a source</a>
          </p>
        ) : asset.sourceType === "YOUTUBE_URL" ? (
          <div className={`${styles.banner} ${styles.bannerWarn}`} role="note">
            <strong>YouTube link — source file required.</strong>
            <br />
            {asset.sourceUrl} (video ID {asset.externalId}). The link was validated only; no media
            was imported. Upload the original file you own or are authorized to process from the{" "}
            <a href={editHref}>workflow page</a>.
          </div>
        ) : asset.validationStatus === "VALID" ? (
          <div className={styles.stack}>
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
                <div className={styles.metaItem}><dt>Duration</dt><dd>{formatDuration(asset.duration)}</dd></div>
                <div className={styles.metaItem}><dt>File size</dt><dd>{formatBytes(asset.fileSize)}</dd></div>
                <div className={styles.metaItem}>
                  <dt>Resolution</dt>
                  <dd>{asset.width && asset.height ? `${asset.width} × ${asset.height}` : "—"}</dd>
                </div>
                <div className={styles.metaItem}><dt>Frame rate</dt><dd>{asset.frameRate ? `${asset.frameRate} fps` : "Not reported"}</dd></div>
                <div className={styles.metaItem}><dt>Video codec</dt><dd>{asset.videoCodec ?? "—"}</dd></div>
                <div className={styles.metaItem}><dt>Audio codec</dt><dd>{asset.audioCodec ?? "None"}</dd></div>
                <div className={styles.metaItem}><dt>Audio stream</dt><dd>{asset.hasAudio ? "Present" : "No audio stream"}</dd></div>
                <div className={styles.metaItem}><dt>Container</dt><dd>{asset.container ?? "—"}</dd></div>
                <div className={styles.metaItem}>
                  <dt>Bitrate</dt>
                  <dd>{asset.bitrate ? `${(asset.bitrate / 1_000_000).toFixed(2)} Mbps` : "—"}</dd>
                </div>
                <div className={styles.metaItem}><dt>Stored via</dt><dd>{asset.storageProvider} storage (this server)</dd></div>
                <div className={styles.metaItem}><dt>Source status</dt><dd><StatusChipFor status={project.status} /></dd></div>
              </dl>
            </div>
            <video
              className={styles.videoPreview}
              controls
              preload="metadata"
              src={projectsApi.streamUrl(asset.id)}
              aria-label={`Preview of ${asset.originalFilename}`}
            />
          </div>
        ) : (
          <p className={styles.errorText} role="alert">
            <strong>Source problem:</strong>{" "}
            {asset.validationError ?? `This source is in state ${asset.validationStatus}.`}{" "}
            <a href={editHref}>Replace the source</a>
          </p>
        )}
      </section>

      <section className={styles.panel} aria-labelledby="pd-config">
        <h3 id="pd-config">Saved configuration</h3>
        {settingsEntries.length === 0 ? (
          <p className={styles.muted}>No settings saved yet.</p>
        ) : (
          <dl className={styles.kvList}>
            {settingsEntries.map(([key, value]) => (
              <div key={key} className={styles.kvRow}>
                <dt>{SETTING_LABELS[key] ?? key}</dt>
                <dd>{settingValue(key, value)}</dd>
              </div>
            ))}
            {project.aiInstruction && (
              <div className={styles.kvRow}>
                <dt>AI search instruction</dt>
                <dd>{project.aiInstruction}</dd>
              </div>
            )}
          </dl>
        )}
        <div className={styles.buttonRow} style={{ marginTop: "var(--space-4)" }}>
          <a className={styles.textButton} href={editHref}>Edit source &amp; settings</a>
          <a className={styles.textButton} href="#/app/studio">Back to Studio</a>
        </div>
      </section>

      <FindClipsPanel project={project} isGuest={isGuest} />
    </div>
  );
}
