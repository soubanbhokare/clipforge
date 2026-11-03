// Phase 7 — Face Lock, Active Speaker & Smart Auto-Reframing panel.
//
// Everything shown here is backed by real server data: detector
// confidences from YuNet, thumbnails cropped from the actual source
// frames, persisted job status (polled, never timer-faked) and the
// same persisted crop keyframes the render worker consumes — so the
// preview below is the render's framing, not a mock of it.
//
// Honesty notes surfaced in the UI itself: subjects are anonymous
// (never named), active-speaker picks show their evidence (speech
// activity + a mouth-motion PROXY + presence) and state plainly that
// no diarization or identity is involved.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { projectsApi } from "../../services/projects";
import { editorApi, type EditorCanvas, type RenderJob } from "../../services/editor";
import {
  REFRAME_MODE_LABELS,
  trackingApi,
  type FollowControls,
  type NormBox,
  type ReframeMode,
  type ReframeState,
  type TrackingKeyframe,
} from "../../services/tracking";
import styles from "../../pages/studio/Editor.module.css";

const MODES = Object.keys(REFRAME_MODE_LABELS) as ReframeMode[];
const CONTROL_LABELS: { key: keyof FollowControls; label: string; hint: string }[] = [
  { key: "sensitivity", label: "Tracking sensitivity", hint: "Detector confidence floor for accepting a detection." },
  { key: "followSpeed", label: "Follow speed", hint: "How fast the crop centre may move." },
  { key: "smoothing", label: "Crop smoothing", hint: "Higher = steadier, slower camera moves." },
  { key: "margin", label: "Subject margin", hint: "Breathing room kept around the subject." },
  { key: "zoom", label: "Zoom strength", hint: "Higher = tighter crop on the subject." },
  { key: "aggressiveness", label: "Reframing aggressiveness", hint: "How quickly the crop size adapts." },
];

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

function boxAtTime<T extends { t: number }>(frames: T[], time: number): T | null {
  if (frames.length === 0) return null;
  let best: T | null = null;
  for (const frame of frames) {
    if (frame.t <= time) best = frame;
    else break;
  }
  return best ?? frames[0]!;
}

function cropAtTime(keyframes: TrackingKeyframe[], time: number): TrackingKeyframe | null {
  return boxAtTime(keyframes, time);
}

interface Props {
  docId: string;
  projectId: string;
  /** The shared editor playhead, mapped by the Inspector into the
   *  analysed source's time base (this panel's native base). The
   *  panel follows it by default; scrubbing this panel's own
   *  preview video overrides it only while interacting. */
  playhead: number;
  /** Patch the document — saving a reframe aspect or custom size
   *  also resizes the document canvas, so the editor preview frame
   *  and the render share the same output size. */
  onPatchSettings: (patch: { canvas: EditorCanvas }) => void;
}

interface SplitRegionEdit {
  subjectKey: string;
  rect: NormBox;
  crop?: { zoom?: number; offsetX?: number; offsetY?: number };
}

export function ReframePanel({ docId, projectId, playhead, onPatchSettings }: Props) {
  const [state, setState] = useState<ReframeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Local clock override: set while the user scrubs/plays THIS
  // panel's own preview video; null = follow the shared playhead.
  const [scrubOverride, setScrubOverride] = useState<number | null>(null);
  const [pollWarning, setPollWarning] = useState<string | null>(null);
  const [showSafeZones, setShowSafeZones] = useState(true);
  const [renderJob, setRenderJob] = useState<RenderJob | null>(null);
  const [manualCropDraft, setManualCropDraft] = useState<{ x: string; y: string; w: string; h: string }>({
    x: "0.25",
    y: "0.10",
    w: "0.50",
    h: "0.80",
  });
  const [selectedScenes, setSelectedScenes] = useState<Set<number>>(new Set());
  const [regionEdits, setRegionEdits] = useState<SplitRegionEdit[] | null>(null);
  const [draftCrop, setDraftCrop] = useState<{ x: string; y: string; w: string; h: string }>({
    x: "0.25",
    y: "0.10",
    w: "0.50",
    h: "0.80",
  });
  const [editingKeyframeId, setEditingKeyframeId] = useState<string | null>(null);
  const [sceneDraft, setSceneDraft] = useState<{ mode: string; subjectKey: string }>({ mode: "", subjectKey: "" });
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const slaveRef = useRef<HTMLVideoElement | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await trackingApi.getReframe(docId);
      setState(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load reframing state.");
    }
  }, [docId]);

  useEffect(() => {
    void load();
  }, [load]);

  const activeJob = state?.latestJob && (state.latestJob.status === "QUEUED" || state.latestJob.status === "RUNNING")
    ? state.latestJob
    : null;

  // Real job polling — the panel reflects persisted server status.
  useEffect(() => {
    if (!activeJob) return;
    let failures = 0;
    const timer = setInterval(async () => {
      try {
        const { job } = await trackingApi.getJob(activeJob.id);
        failures = 0;
        setPollWarning(null);
        setState((prev) => (prev ? { ...prev, latestJob: job } : prev));
        if (job.status === "COMPLETED" || job.status === "FAILED" || job.status === "CANCELLED") {
          clearInterval(timer);
          void load();
        }
      } catch {
        // Keep polling, but never fail silently: after repeated
        // failures the user is told the shown status may be stale.
        failures += 1;
        if (failures >= 3) {
          setPollWarning("Connection problem — the analysis status below may be stale; still retrying.");
        }
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [activeJob?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Render job polling for reframe exports started from this panel.
  useEffect(() => {
    if (!renderJob || (renderJob.status !== "QUEUED" && renderJob.status !== "RUNNING")) return;
    let failures = 0;
    const timer = setInterval(async () => {
      try {
        const { job } = await editorApi.getRender(renderJob.id);
        failures = 0;
        setPollWarning(null);
        setRenderJob(job);
      } catch {
        failures += 1;
        if (failures >= 3) {
          setPollWarning("Connection problem — the render status below may be stale; still retrying.");
        }
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [renderJob?.id, renderJob?.status]);

  const config = state?.config;
  const subjects = state?.subjects ?? [];
  const faceCount = subjects.filter((s) => s.kind === "face").length;
  // Auto-Follow pause is PERSISTED on the server config: when paused,
  // the computed crop path itself is static (preview and render).
  const followPaused = config?.paused === true;
  // Shared editor playhead by default; the local override (this
  // panel's own preview video) wins only while interacting with it.
  const previewTime = scrubOverride ?? playhead;

  const manualCropJson = JSON.stringify(config?.manualCrop ?? null);
  useEffect(() => {
    const mc = config?.manualCrop;
    if (mc) {
      setManualCropDraft({
        x: mc.x.toFixed(3),
        y: mc.y.toFixed(3),
        w: mc.w.toFixed(3),
        h: mc.h.toFixed(3),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manualCropJson]);

  // Follow the shared playhead: while this panel's own preview video
  // is paused, an external playhead move clears the local scrub
  // override and aligns the preview frame, so the crop/subject
  // overlays and the keyframe timestamps track the editor.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !video.paused) return;
    setScrubOverride(null);
    if (Math.abs(video.currentTime - playhead) > 0.3) {
      video.currentTime = playhead;
    }
  }, [playhead]);

  const currentKeyframe = useMemo(() => {
    if (!state) return null;
    if (config?.mode === "split-screen") return null;
    return cropAtTime(state.keyframes, previewTime);
  }, [state, config?.mode, previewTime]);

  const selectedSubject = config?.subjectKey
    ? subjects.find((s) => s.key === config.subjectKey)
    : undefined;
  const subjectBox = useMemo(() => {
    if (!state || !selectedSubject) return null;
    const frames = state.subjectFrames[selectedSubject.key] ?? [];
    const frame = boxAtTime(frames, previewTime);
    return frame && Math.abs(frame.t - previewTime) <= 0.75 ? frame : null;
  }, [state, selectedSubject, previewTime]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  };

  const patchConfig = (patch: Parameters<typeof trackingApi.updateConfig>[1]) =>
    run("config", async () => {
      const next = await trackingApi.updateConfig(docId, patch);
      setState(next);
    });

  // Output aspect / size live in two places that must agree: the
  // reframe config (what the reframe render consumes) and the
  // document canvas (what the editor preview frames from and the
  // main render outputs). Saving either here patches the other.
  const ASPECT_CANVAS: Record<string, { width: number; height: number }> = {
    "9:16": { width: 1080, height: 1920 },
    "16:9": { width: 1920, height: 1080 },
    "1:1": { width: 1080, height: 1080 },
    "4:5": { width: 1080, height: 1350 },
  };
  const syncDocumentCanvas = (aspect: string, outWidth: number, outHeight: number) => {
    if (aspect === "custom") {
      onPatchSettings({ canvas: { aspect: "custom", width: outWidth, height: outHeight, custom: true } });
    } else {
      const dims = ASPECT_CANVAS[aspect];
      if (dims) onPatchSettings({ canvas: { aspect, width: dims.width, height: dims.height, custom: false } });
    }
  };

  /** Persisted extras (Auto-Follow pause, Manual Crop) — typed API. */
  const patchConfigExtra = (patch: { paused?: boolean; manualCrop?: NormBox | null }) =>
    run("config", async () => {
      const next =
        patch.paused !== undefined
          ? await trackingApi.setFollowPaused(docId, patch.paused)
          : await trackingApi.setManualCrop(docId, patch.manualCrop ?? null);
      setState(next);
    });

  const resetTracking = () =>
    run("reset-tracking", async () => {
      const next = await trackingApi.resetTracking(docId);
      setRegionEdits(null);
      setSelectedScenes(new Set());
      setState(next);
    });

  // Split edits start from the server's regions whenever they change.
  const splitRegionsJson = JSON.stringify(state?.split?.regions ?? []);
  useEffect(() => {
    setRegionEdits(null);
  }, [splitRegionsJson]);

  if (!state) {
    return (
      <section className={styles.panel} aria-label="Face Lock and reframing">
        <h3>Face Lock &amp; Reframing</h3>
        {error ? <p className={styles.error} role="alert">{error}</p> : <p className={styles.muted}>Loading reframing…</p>}
      </section>
    );
  }

  const job = state.latestJob;
  const jobActive = job && (job.status === "QUEUED" || job.status === "RUNNING");
  const tracked = Boolean(state.job && state.job.status === "COMPLETED");
  const splitDisabled = (state.splitEligibleKeys ?? []).length < 2;

  return (
    <section className={styles.panel} aria-label="Face Lock and reframing">
      <h3>Face Lock &amp; Reframing</h3>
      <p className={styles.small}>
        Detects faces and people in the source video (YuNet + person model, sampled frames), tracks
        them and computes the crop the renderer will use. Subjects are anonymous — never named or
        matched anywhere.
      </p>
      {!state.provider.configured && (
        <p className={styles.error} role="alert">{state.provider.detail}</p>
      )}
      {error && <p className={styles.error} role="alert">{error}</p>}
      {pollWarning && <p className={styles.error} role="alert">{pollWarning}</p>}

      {/* --- analysis job ------------------------------------------------ */}
      <div className={styles.fieldGrid}>
        <button
          type="button"
          className={styles.miniButton}
          disabled={busy !== null || Boolean(jobActive) || !state.provider.configured}
          onClick={() =>
            run("analyse", async () => {
              const { job: created } = await trackingApi.createJob(projectId);
              setState((prev) => (prev ? { ...prev, latestJob: created } : prev));
            })
          }
        >
          {tracked ? "Re-analyse subjects" : "Analyse subjects"}
        </button>
        {jobActive && (
          <button
            type="button"
            className={styles.miniButton}
            disabled={busy !== null}
            onClick={() =>
              run("cancel", async () => {
                const { job: updated } = await trackingApi.cancelJob(job!.id);
                setState((prev) => (prev ? { ...prev, latestJob: updated } : prev));
              })
            }
          >
            Cancel analysis
          </button>
        )}
        {job && (job.status === "FAILED" || job.status === "CANCELLED") && (
          <button
            type="button"
            className={styles.miniButton}
            disabled={busy !== null}
            onClick={() =>
              run("retry", async () => {
                const { job: created } = await trackingApi.retryJob(job.id);
                setState((prev) => (prev ? { ...prev, latestJob: created } : prev));
              })
            }
          >
            Retry analysis
          </button>
        )}
      </div>
      {job && (
        <p className={styles.small} aria-live="polite">
          Analysis: <strong>{job.status}</strong> · stage {job.stage}
          {jobActive && job.progress?.total ? ` · frames ${job.progress.done ?? 0}/${job.progress.total}` : ""}
          {job.status === "COMPLETED" &&
            ` · ${job.result.faceSubjects ?? 0} face subject(s), ${job.result.personSubjects ?? 0} person subject(s)`}
          {job.status === "COMPLETED" && job.outcome === "NO_SUBJECTS" &&
            " · No faces or people were detected in this video — reframing falls back to a static centre crop."}
          {job.error ? ` · ${job.error}${job.errorCode ? ` (${job.errorCode})` : ""}` : ""}
        </p>
      )}

      {/* --- subjects ------------------------------------------------------ */}
      {subjects.length > 0 && (
        <>
          <h4>Detected subjects</h4>
          <div className={styles.fieldGrid}>
            {subjects.map((subject) => (
              <button
                key={subject.id}
                type="button"
                className={styles.miniButton}
                aria-pressed={config?.subjectKey === subject.key}
                onClick={() => void patchConfig({ subjectKey: subject.key })}
                title={`${subject.kind} · seen ${subject.firstSeenSec.toFixed(1)}s–${subject.lastSeenSec.toFixed(1)}s`}
              >
                {subject.hasThumbnail && subject.thumbnailUrl ? (
                  <img
                    src={subject.thumbnailUrl}
                    alt={`${subject.kind} subject ${subject.key}`}
                    width={48}
                    height={48}
                    style={{ objectFit: "cover", borderRadius: 6, verticalAlign: "middle", marginRight: 6 }}
                  />
                ) : null}
                {subject.key} · {subject.kind} ·{" "}
                {subject.bestConfidence !== null ? `${Math.round(subject.bestConfidence * 100)}%` : "—"}
              </button>
            ))}
          </div>
          <p className={styles.small}>
            Confidence is the detector&apos;s real score. Pick a subject for Face Lock / Person
            Follow; with exactly one face it is selected automatically.
          </p>
        </>
      )}


      {/* --- preview -------------------------------------------------------- */}
      {state.sourceAsset && (
        <>
          <h4>Tracking preview</h4>
          <div className={styles.field}>
            <label htmlFor="reframe-safezones">
              <input
                id="reframe-safezones"
                type="checkbox"
                checked={showSafeZones}
                onChange={(e) => setShowSafeZones(e.target.checked)}
              />{" "}
              Safe-zone guides (title + caption, same as the editor preview)
            </label>
          </div>
          <div style={{ position: "relative", width: "100%", background: "#000", borderRadius: 8, overflow: "hidden" }}>
            <video
              ref={videoRef}
              src={projectsApi.streamUrl(state.sourceAsset.id)}
              controls
              style={{ width: "100%", display: "block" }}
              onTimeUpdate={(e) => {
                const t = e.currentTarget.currentTime;
                setScrubOverride(t);
                const slave = slaveRef.current;
                if (slave && Math.abs(slave.currentTime - t) > 0.35) slave.currentTime = t;
              }}
              onPlay={() => void slaveRef.current?.play().catch(() => undefined)}
              onPause={() => slaveRef.current?.pause()}
            />
            {subjectBox && (
              <div
                aria-hidden
                style={{
                  position: "absolute",
                  left: `${subjectBox.box.x * 100}%`,
                  top: `${subjectBox.box.y * 100}%`,
                  width: `${subjectBox.box.w * 100}%`,
                  height: `${subjectBox.box.h * 100}%`,
                  border: "2px solid #1558C9",
                  borderRadius: 4,
                  pointerEvents: "none",
                }}
              />
            )}
            {currentKeyframe?.crop && config?.mode !== "split-screen" && (
              <div
                aria-hidden
                style={{
                  position: "absolute",
                  left: `${currentKeyframe.crop.x * 100}%`,
                  top: `${currentKeyframe.crop.y * 100}%`,
                  width: `${currentKeyframe.crop.w * 100}%`,
                  height: `${currentKeyframe.crop.h * 100}%`,
                  border: "2px solid #D4FF24",
                  borderRadius: 4,
                  pointerEvents: "none",
                }}
              />
            )}
            {config?.mode === "split-screen" &&
              (state.split?.regions ?? []).map((region) => (
                <div
                  key={region.subjectKey}
                  aria-hidden
                  style={{
                    position: "absolute",
                    left: `${region.rect.x * 100}%`,
                    top: `${region.rect.y * 100}%`,
                    width: `${region.rect.w * 100}%`,
                    height: `${region.rect.h * 100}%`,
                    border: "2px dashed #D4FF24",
                    pointerEvents: "none",
                  }}
                />
              ))}
            {showSafeZones && (
              <>
                <div className={styles.safeZoneTitle} />
                <div className={styles.safeZoneCaption}>
                  <span>Caption safe zone</span>
                </div>
              </>
            )}
          </div>
          <p className={styles.small}>
            Blue box = tracked subject{selectedSubject ? ` (${selectedSubject.key})` : ""}. Lime box
            = output crop at {fmtTime(previewTime)}
            {currentKeyframe?.lost ? " · subject lost here — holding last framing" : ""}
            {currentKeyframe?.confidence != null
              ? ` · detection confidence ${Math.round(currentKeyframe.confidence * 100)}%`
              : ""}
            .
          </p>
          {currentKeyframe?.crop && config && (
            <div
              style={{
                position: "relative",
                width: "55%",
                aspectRatio: `${config.outWidth} / ${config.outHeight}`,
                background: "#000",
                borderRadius: 8,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  width: `${100 / Math.max(currentKeyframe.crop.w, 0.01)}%`,
                  left: `${-(currentKeyframe.crop.x / Math.max(currentKeyframe.crop.w, 0.01)) * 100}%`,
                  top: `${-(currentKeyframe.crop.y / Math.max(currentKeyframe.crop.h, 0.01)) * 100}%`,
                }}
              >
                <video
                  ref={slaveRef}
                  src={projectsApi.streamUrl(state.sourceAsset.id)}
                  muted
                  style={{ width: "100%", display: "block" }}
                />
              </div>
            </div>
          )}
          <div className={styles.fieldGrid}>
            <button
              type="button"
              className={styles.miniButton}
              disabled={busy !== null}
              onClick={() => void patchConfigExtra({ paused: !followPaused })}
            >
              {followPaused ? "Resume auto follow" : "Pause auto follow"}
            </button>
            <span className={styles.small}>
              {followPaused
                ? "Auto follow is paused and saved: the crop path is static in the preview and in renders until you resume."
                : "Pausing is saved on the configuration — the crop path (preview and render) holds a static framing."}
            </span>
            <button
              type="button"
              className={styles.miniButton}
              disabled={!currentKeyframe?.crop}
              title={!currentKeyframe?.crop ? "No tracked crop at the playhead yet" : undefined}
              onClick={() => {
                const crop = currentKeyframe?.crop;
                if (crop) {
                  setDraftCrop({
                    x: crop.x.toFixed(3),
                    y: crop.y.toFixed(3),
                    w: crop.w.toFixed(3),
                    h: crop.h.toFixed(3),
                  });
                  setEditingKeyframeId(null);
                }
              }}
            >
              Use current crop for a manual keyframe
            </button>
          </div>
        </>
      )}

      {/* --- mode + framing --------------------------------------------------- */}
      {config && (
        <>
          <h4>Reframe mode</h4>
          <div className={styles.field}>
            <label htmlFor="reframe-mode">Mode</label>
            <select
              id="reframe-mode"
              value={config.mode}
              onChange={(e) => {
                const mode = e.target.value as ReframeMode;
                if (mode === "split-screen") {
                  void run("split", async () => {
                    const next = await trackingApi.setSplit(docId, state.split?.layout ?? "side-by-side");
                    setState(next);
                  });
                } else {
                  void patchConfig({ mode });
                }
              }}
            >
              {MODES.map((mode) => (
                <option key={mode} value={mode} disabled={mode === "split-screen" && splitDisabled}>
                  {REFRAME_MODE_LABELS[mode]}
                  {mode === "split-screen" && splitDisabled ? " (needs 2+ subjects)" : ""}
                </option>
              ))}
            </select>
          </div>
          {splitDisabled && (
            <p className={styles.small}>
              Split Screen is not offered: this video has fewer than two distinct tracked people
              (a person box containing a tracked face is the same human, not a second subject).
            </p>
          )}
          {config.mode === "face-lock" && (
            <div className={styles.field}>
              <label htmlFor="facelock-on">
                <input
                  id="facelock-on"
                  type="checkbox"
                  checked={config.enabled}
                  onChange={(e) => void patchConfig({ enabled: e.target.checked })}
                />{" "}
                Face Lock on
              </label>
              <p className={styles.small}>
                Off = static framing in the preview and the persisted crop path, and reframe
                renders are refused (FACE_LOCK_OFF).
              </p>
            </div>
          )}
          <div className={styles.fieldGrid}>
            <button
              type="button"
              className={styles.miniButton}
              disabled={busy !== null}
              onClick={() => void resetTracking()}
            >
              Reset tracking
            </button>
            <span className={styles.small}>
              Clears this configuration (mode, controls, pause, manual crop), all manual
              keyframes, scene overrides and the split layout back to defaults. The tracking
              analysis and its subjects are kept.
            </span>
          </div>
          {config.mode === "split-screen" && (
            <div className={styles.field}>
              <label htmlFor="split-layout">Split layout</label>
              <select
                id="split-layout"
                value={state.split?.layout ?? "side-by-side"}
                onChange={(e) =>
                  void run("split", async () => {
                    const next = await trackingApi.setSplit(docId, e.target.value, undefined);
                    setState(next);
                  })
                }
              >
                <option value="side-by-side">Two-person side-by-side</option>
                <option value="speaker-focused">Speaker-focused</option>
                <option value="equal-split">Equal split</option>
                <option value="main-secondary">Main + secondary</option>
                <option value="custom">Custom arrangement</option>
              </select>
              <p className={styles.small}>
                Regions: {(state.split?.regions ?? []).map((r) => r.subjectKey).join(" + ") || "—"}.
                Each subject is cropped independently from its own tracking path.
              </p>
              {(regionEdits ?? state.split?.regions ?? []).map((region, ri, arr) => (
                <div key={`${region.subjectKey}-${ri}`} className={styles.field}>
                  <strong className={styles.small}>
                    Region {ri + 1}: {region.subjectKey}
                  </strong>
                  {state.split?.layout === "custom" && (
                    <div className={styles.fieldGrid}>
                      <div className={styles.field}>
                        <label htmlFor={`region-subject-${ri}`}>Assigned subject</label>
                        <select
                          id={`region-subject-${ri}`}
                          value={region.subjectKey}
                          onChange={(e) => {
                            const next = arr.map((r, i) => (i === ri ? { ...r, subjectKey: e.target.value } : r));
                            setRegionEdits(next);
                          }}
                        >
                          {(state.splitEligibleKeys ?? []).map((key) => (
                            <option key={key} value={key} disabled={key !== region.subjectKey && arr.some((r) => r.subjectKey === key)}>
                              {key}
                            </option>
                          ))}
                        </select>
                      </div>
                      {(["x", "y", "w", "h"] as const).map((axis) => (
                        <div className={styles.field} key={axis}>
                          <label htmlFor={`region-${ri}-${axis}`}>Rect {axis}</label>
                          <input
                            id={`region-${ri}-${axis}`}
                            type="number"
                            step={0.05}
                            min={0}
                            max={1}
                            value={region.rect[axis]}
                            onChange={(e) => {
                              const v = Math.min(1, Math.max(0, Number(e.target.value) || 0));
                              const next = arr.map((r, i) =>
                                i === ri ? { ...r, rect: { ...r.rect, [axis]: v } } : r,
                              );
                              setRegionEdits(next);
                            }}
                          />
                        </div>
                      ))}
                      <button
                        type="button"
                        className={styles.miniButton}
                        disabled={ri === 0}
                        onClick={() => {
                          const next = [...arr];
                          const [moved] = next.splice(ri, 1);
                          next.splice(ri - 1, 0, moved!);
                          setRegionEdits(next);
                        }}
                      >
                        Move earlier
                      </button>
                      <button
                        type="button"
                        className={styles.miniButton}
                        disabled={ri === arr.length - 1}
                        onClick={() => {
                          const next = [...arr];
                          const [moved] = next.splice(ri, 1);
                          next.splice(ri + 1, 0, moved!);
                          setRegionEdits(next);
                        }}
                      >
                        Move later
                      </button>
                    </div>
                  )}
                  <div className={styles.fieldGrid}>
                    <div className={styles.field}>
                      <label htmlFor={`region-zoom-${ri}`}>
                        {region.subjectKey} crop zoom — {Math.round((region.crop?.zoom ?? config.controls.zoom) * 100)}%
                      </label>
                      <input
                        id={`region-zoom-${ri}`}
                        type="range"
                        min={0}
                        max={100}
                        value={Math.round((region.crop?.zoom ?? config.controls.zoom) * 100)}
                        onChange={(e) => {
                          const next = arr.map((r, i) =>
                            i === ri ? { ...r, crop: { ...r.crop, zoom: Number(e.target.value) / 100 } } : r,
                          );
                          setRegionEdits(next);
                        }}
                      />
                    </div>
                    {(["offsetX", "offsetY"] as const).map((axis) => (
                      <div className={styles.field} key={axis}>
                        <label htmlFor={`region-${ri}-${axis}`}>{region.subjectKey} crop {axis} (−0.5–0.5)</label>
                        <input
                          id={`region-${ri}-${axis}`}
                          type="number"
                          step={0.01}
                          min={-0.5}
                          max={0.5}
                          value={region.crop?.[axis] ?? 0}
                          onChange={(e) => {
                            const v = Math.min(0.5, Math.max(-0.5, Number(e.target.value) || 0));
                            const next = arr.map((r, i) =>
                              i === ri ? { ...r, crop: { ...r.crop, [axis]: v } } : r,
                            );
                            setRegionEdits(next);
                          }}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              {regionEdits && (
                <div className={styles.fieldGrid}>
                  <button
                    type="button"
                    className={styles.miniButton}
                    disabled={busy !== null}
                    onClick={() =>
                      void run("split", async () => {
                        const next = await trackingApi.setSplit(
                          docId,
                          state.split?.layout ?? "custom",
                          regionEdits.map((r) => ({
                            subjectKey: r.subjectKey,
                            rect: r.rect,
                            ...(r.crop ? { crop: r.crop } : {}),
                          })),
                        );
                        setState(next);
                      })
                    }
                  >
                    {state.split?.layout === "custom" ? "Save split arrangement" : "Save per-subject crops"}
                  </button>
                  <button
                    type="button"
                    className={styles.miniButton}
                    disabled={busy !== null}
                    onClick={() => setRegionEdits(null)}
                  >
                    Discard changes
                  </button>
                </div>
              )}
            </div>
          )}
          <div className={styles.fieldGrid}>
            <div className={styles.field}>
              <label htmlFor="reframe-aspect">Output aspect</label>
              <select
                id="reframe-aspect"
                value={config.aspect}
                onChange={(e) => {
                  void patchConfig({ aspect: e.target.value });
                  syncDocumentCanvas(e.target.value, config.outWidth, config.outHeight);
                }}
              >
                <option value="9:16">9:16 (1080×1920)</option>
                <option value="16:9">16:9 (1920×1080)</option>
                <option value="1:1">1:1 (1080×1080)</option>
                <option value="4:5">4:5 (1080×1350)</option>
                <option value="custom">Custom</option>
              </select>
            </div>
            <div className={styles.field}>
              <label htmlFor="reframe-fit">Fit</label>
              <select
                id="reframe-fit"
                value={config.fitMode}
                onChange={(e) => void patchConfig({ fitMode: e.target.value as ReframeState["config"]["fitMode"] })}
              >
                <option value="smart-crop">Smart Crop</option>
                <option value="fill">Fill</option>
                <option value="fit">Fit (whole frame)</option>
                <option value="center-crop">Center Crop</option>
                <option value="manual-crop">Manual Crop</option>
              </select>
            </div>
            <div className={styles.field}>
              <label htmlFor="reframe-posx">Subject position</label>
              <select
                id="reframe-posx"
                value={config.targetPosX}
                onChange={(e) => void patchConfig({ targetPosX: e.target.value as "left" | "center" | "right" })}
              >
                <option value="left">Left third</option>
                <option value="center">Centre</option>
                <option value="right">Right third</option>
              </select>
            </div>
            <div className={styles.field}>
              <label htmlFor="reframe-posy">Vertical position</label>
              <select
                id="reframe-posy"
                value={config.targetPosY}
                onChange={(e) => void patchConfig({ targetPosY: e.target.value as "upper" | "middle" })}
              >
                <option value="upper">Upper</option>
                <option value="middle">Middle</option>
              </select>
            </div>
          </div>
          {config.aspect === "custom" && (
            <div className={styles.fieldGrid}>
              <div className={styles.field}>
                <label htmlFor="reframe-w">Custom width</label>
                <input
                  id="reframe-w"
                  type="number"
                  min={16}
                  max={4096}
                  defaultValue={config.outWidth}
                  onBlur={(e) => {
                    const outWidth = Number(e.target.value) || config.outWidth;
                    void patchConfig({ outWidth });
                    syncDocumentCanvas("custom", outWidth, config.outHeight);
                  }}
                />
              </div>
              <div className={styles.field}>
                <label htmlFor="reframe-h">Custom height</label>
                <input
                  id="reframe-h"
                  type="number"
                  min={16}
                  max={4096}
                  defaultValue={config.outHeight}
                  onBlur={(e) => {
                    const outHeight = Number(e.target.value) || config.outHeight;
                    void patchConfig({ outHeight });
                    syncDocumentCanvas("custom", config.outWidth, outHeight);
                  }}
                />
              </div>
            </div>
          )}

          {config.fitMode === "manual-crop" && (
            <>
              <h4>Manual crop</h4>
              {config.manualCrop ? (
                <p className={styles.small}>
                  Manual Crop uses exactly your rectangle — x{config.manualCrop.x.toFixed(2)} y
                  {config.manualCrop.y.toFixed(2)} w{config.manualCrop.w.toFixed(2)} h
                  {config.manualCrop.h.toFixed(2)} — for the whole scene. No subject following, no
                  smoothing.
                </p>
              ) : (
                <p className={styles.error} role="alert">
                  Manual Crop needs a crop rectangle. Set one below — until then the path holds a
                  static centre crop and never falls back to subject tracking.
                </p>
              )}
              <div className={styles.fieldGrid}>
                {(["x", "y", "w", "h"] as const).map((axis) => (
                  <div className={styles.field} key={axis}>
                    <label htmlFor={`mc-${axis}`}>Manual crop {axis} (0–1)</label>
                    <input
                      id={`mc-${axis}`}
                      type="number"
                      step={0.01}
                      min={0}
                      max={1}
                      value={manualCropDraft[axis]}
                      onChange={(e) => setManualCropDraft((d) => ({ ...d, [axis]: e.target.value }))}
                    />
                  </div>
                ))}
              </div>
              <div className={styles.fieldGrid}>
                <button
                  type="button"
                  className={styles.miniButton}
                  disabled={busy !== null}
                  onClick={() =>
                    void patchConfigExtra({
                      manualCrop: {
                        x: Math.min(1, Math.max(0, Number(manualCropDraft.x) || 0)),
                        y: Math.min(1, Math.max(0, Number(manualCropDraft.y) || 0)),
                        w: Math.min(1, Math.max(0.01, Number(manualCropDraft.w) || 0.5)),
                        h: Math.min(1, Math.max(0.01, Number(manualCropDraft.h) || 0.5)),
                      },
                    })
                  }
                >
                  Set manual crop
                </button>
                <button
                  type="button"
                  className={styles.miniButton}
                  disabled={busy !== null || !currentKeyframe?.crop}
                  title={!currentKeyframe?.crop ? "No tracked crop at the playhead yet" : undefined}
                  onClick={() => {
                    if (currentKeyframe?.crop) {
                      setManualCropDraft({
                        x: currentKeyframe.crop.x.toFixed(3),
                        y: currentKeyframe.crop.y.toFixed(3),
                        w: currentKeyframe.crop.w.toFixed(3),
                        h: currentKeyframe.crop.h.toFixed(3),
                      });
                    }
                  }}
                >
                  Use current crop
                </button>
                {config.manualCrop && (
                  <button
                    type="button"
                    className={styles.miniButton}
                    disabled={busy !== null}
                    onClick={() => void patchConfigExtra({ manualCrop: null })}
                  >
                    Clear manual crop
                  </button>
                )}
              </div>
            </>
          )}

          <h4>Auto Follow</h4>
          {CONTROL_LABELS.map(({ key, label, hint }) => (
            <div className={styles.field} key={key}>
              <label htmlFor={`ctl-${key}`}>
                {label} — {Math.round(config.controls[key] * 100)}%
              </label>
              <input
                id={`ctl-${key}`}
                type="range"
                min={0}
                max={100}
                value={Math.round(config.controls[key] * 100)}
                onChange={(e) =>
                  setState((prev) =>
                    prev
                      ? {
                          ...prev,
                          config: {
                            ...prev.config,
                            controls: { ...prev.config.controls, [key]: Number(e.target.value) / 100 },
                          },
                        }
                      : prev,
                  )
                }
                onPointerUp={(e) =>
                  void patchConfig({
                    controls: { [key]: Number((e.target as HTMLInputElement).value) / 100 } as Partial<FollowControls>,
                  })
                }
                onKeyUp={(e) =>
                  void patchConfig({
                    controls: { [key]: Number((e.target as HTMLInputElement).value) / 100 } as Partial<FollowControls>,
                  })
                }
              />
              <p className={styles.small}>{hint}</p>
            </div>
          ))}
        </>
      )}


      {/* --- active speaker evidence ------------------------------------------ */}
      {state.associations.length > 0 && (
        <>
          <h4>Active speaker evidence</h4>
          <p className={styles.small}>
            Picks combine speech activity (transcript/VAD) with a mouth-motion proxy and presence.
            There is no speaker diarization and no identity — low-evidence windows make no pick and
            the framing stays stable.
          </p>
          <ul className={styles.jobList}>
            {state.associations
              .filter((a) => a.isActivePick)
              .slice(0, 12)
              .map((a, i) => (
                <li key={`${a.subjectKey}-${a.windowStart}-${i}`} className={styles.small}>
                  {fmtTime(a.windowStart)}–{fmtTime(a.windowEnd)} · {a.subjectKey} · {a.confidence}{" "}
                  confidence · score {a.score.toFixed(2)} · speech: {a.speechSource} · mouth-motion
                  proxy {a.evidence.mouthMotion ?? "—"} · presence{" "}
                  {Math.round(a.evidence.presenceRatio * 100)}%
                </li>
              ))}
          </ul>
          {state.associations.every((a) => !a.isActivePick) && (
            <p className={styles.small}>
              No window had enough combined evidence for a speaker pick — Active Speaker mode keeps
              stable framing instead of guessing.
            </p>
          )}
        </>
      )}

      {/* --- scene overrides ----------------------------------------------------- */}
      {state.scenes.length > 0 && (
        <>
          <h4>Scene reframing</h4>
          <p className={styles.small}>
            Scenes come from the tracking analysis (real scene-cut detection). An override changes
            only its own scene; subjects never carry across a cut.
          </p>
          <ul className={styles.jobList}>
            {state.scenes.map((scene, idx) => {
              const override = state.sceneOverrides.find(
                (o) => Math.abs(o.rangeStart - scene.start) < 0.05 && Math.abs(o.rangeEnd - scene.end) < 0.05,
              );
              return (
                <li key={`${scene.start}-${idx}`} className={styles.small}>
                  <input
                    type="checkbox"
                    aria-label={`Select scene ${idx + 1} for multi-scene apply`}
                    checked={selectedScenes.has(idx)}
                    onChange={(e) =>
                      setSelectedScenes((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(idx);
                        else next.delete(idx);
                        return next;
                      })
                    }
                  />{" "}
                  Scene {idx + 1}: {fmtTime(scene.start)}–{fmtTime(scene.end)}
                  {override
                    ? ` · override: ${override.mode ? REFRAME_MODE_LABELS[override.mode] : "auto"}${override.subjectKey ? ` · ${override.subjectKey}` : ""}`
                    : " · auto"}
                  {override && (
                    <button
                      type="button"
                      className={styles.miniButton}
                      onClick={() =>
                        void run("scene", async () => {
                          const next = await trackingApi.setSceneOverrides(
                            docId,
                            state.sceneOverrides
                              .filter((o) => o.id !== override.id)
                              .map((o) => ({
                                topicSegmentId: o.topicSegmentId,
                                rangeStart: o.rangeStart,
                                rangeEnd: o.rangeEnd,
                                mode: o.mode,
                                subjectKey: o.subjectKey,
                                controls: o.settings.controls ?? undefined,
                                fitMode: (o.settings.fitMode as ReframeState["config"]["fitMode"] | null) ?? undefined,
                              })),
                          );
                          setState(next);
                        })
                      }
                    >
                      Restore auto
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          <div className={styles.fieldGrid}>
            <div className={styles.field}>
              <label htmlFor="scene-mode">Override mode</label>
              <select
                id="scene-mode"
                value={sceneDraft.mode}
                onChange={(e) => setSceneDraft((d) => ({ ...d, mode: e.target.value }))}
              >
                <option value="">Auto (config mode)</option>
                {MODES.filter((m) => m !== "split-screen").map((mode) => (
                  <option key={mode} value={mode}>{REFRAME_MODE_LABELS[mode]}</option>
                ))}
              </select>
            </div>
            <div className={styles.field}>
              <label htmlFor="scene-subject">Override subject</label>
              <select
                id="scene-subject"
                value={sceneDraft.subjectKey}
                onChange={(e) => setSceneDraft((d) => ({ ...d, subjectKey: e.target.value }))}
              >
                <option value="">Auto subject</option>
                {subjects.map((s) => (
                  <option key={s.key} value={s.key}>{s.key} ({s.kind})</option>
                ))}
              </select>
            </div>
          </div>
          <div className={styles.fieldGrid}>
            {state.scenes.map((scene, idx) => (
              <button
                key={`apply-${scene.start}`}
                type="button"
                className={styles.miniButton}
                disabled={busy !== null}
                onClick={() =>
                  void run("scene", async () => {
                    const kept = state.sceneOverrides
                      .filter((o) => !(Math.abs(o.rangeStart - scene.start) < 0.05 && Math.abs(o.rangeEnd - scene.end) < 0.05))
                      .map((o) => ({
                        topicSegmentId: o.topicSegmentId,
                        rangeStart: o.rangeStart,
                        rangeEnd: o.rangeEnd,
                        mode: o.mode,
                        subjectKey: o.subjectKey,
                        controls: o.settings.controls ?? undefined,
                        fitMode: (o.settings.fitMode as ReframeState["config"]["fitMode"] | null) ?? undefined,
                      }));
                    kept.push({
                      topicSegmentId: null,
                      rangeStart: scene.start,
                      rangeEnd: scene.end,
                      mode: (sceneDraft.mode || null) as ReframeMode | null,
                      subjectKey: sceneDraft.subjectKey || null,
                      controls: undefined,
                      fitMode: undefined,
                    });
                    const next = await trackingApi.setSceneOverrides(docId, kept);
                    setState(next);
                  })
                }
              >
                Apply to scene {idx + 1}
              </button>
            ))}
            <button
              type="button"
              className={styles.miniButton}
              disabled={busy !== null || selectedScenes.size === 0}
              onClick={() =>
                void run("scene", async () => {
                  const chosen = state.scenes.filter((_, idx) => selectedScenes.has(idx));
                  const kept = state.sceneOverrides
                    .filter(
                      (o) =>
                        !chosen.some(
                          (scene) =>
                            Math.abs(o.rangeStart - scene.start) < 0.05 &&
                            Math.abs(o.rangeEnd - scene.end) < 0.05,
                        ),
                    )
                    .map((o) => ({
                      topicSegmentId: o.topicSegmentId,
                      rangeStart: o.rangeStart,
                      rangeEnd: o.rangeEnd,
                      mode: o.mode,
                      subjectKey: o.subjectKey,
                      controls: o.settings.controls ?? undefined,
                      fitMode: (o.settings.fitMode as ReframeState["config"]["fitMode"] | null) ?? undefined,
                    }));
                  for (const scene of chosen) {
                    kept.push({
                      topicSegmentId: null,
                      rangeStart: scene.start,
                      rangeEnd: scene.end,
                      mode: (sceneDraft.mode || null) as ReframeMode | null,
                      subjectKey: sceneDraft.subjectKey || null,
                      controls: undefined,
                      fitMode: undefined,
                    });
                  }
                  const next = await trackingApi.setSceneOverrides(docId, kept);
                  setState(next);
                })
              }
            >
              Apply to selected scenes ({selectedScenes.size})
            </button>
            <button
              type="button"
              className={styles.miniButton}
              disabled={busy !== null || state.scenes.length === 0}
              onClick={() =>
                void run("scene", async () => {
                  const next = await trackingApi.setSceneOverrides(
                    docId,
                    state.scenes.map((scene) => ({
                      topicSegmentId: null,
                      rangeStart: scene.start,
                      rangeEnd: scene.end,
                      mode: (sceneDraft.mode || null) as ReframeMode | null,
                      subjectKey: sceneDraft.subjectKey || null,
                      controls: undefined,
                      fitMode: undefined,
                    })),
                  );
                  setState(next);
                })
              }
            >
              Apply to all scenes
            </button>
            <button
              type="button"
              className={styles.miniButton}
              disabled={busy !== null || state.scenes.length === 0}
              onClick={() =>
                void run("scene", async () => {
                  const duration = state.sourceAsset?.duration ?? state.scenes[state.scenes.length - 1]!.end;
                  const next = await trackingApi.setSceneOverrides(docId, [
                    {
                      topicSegmentId: null,
                      rangeStart: 0,
                      rangeEnd: duration,
                      mode: (sceneDraft.mode || null) as ReframeMode | null,
                      subjectKey: sceneDraft.subjectKey || null,
                      controls: undefined,
                      fitMode: undefined,
                    },
                  ]);
                  setState(next);
                })
              }
            >
              Apply to whole clip
            </button>
            <button
              type="button"
              className={styles.miniButton}
              disabled={busy !== null || state.sceneOverrides.length === 0}
              onClick={() =>
                void run("scene", async () => {
                  const next = await trackingApi.setSceneOverrides(docId, []);
                  setState(next);
                })
              }
            >
              Reset all scenes
            </button>
          </div>
        </>
      )}

      {/* --- manual keyframes ------------------------------------------------------ */}
      <h4>Manual keyframes</h4>
      <p className={styles.small}>
        A manual keyframe overrides the AI crop from its timestamp until the next manual keyframe
        (the last one holds for 5 s). Everything outside that range stays on AI tracking.
      </p>
      <ul className={styles.jobList}>
        {state.manualKeyframes.map((kf) => (
          <li key={kf.id} className={styles.small}>
            {fmtTime(kf.t)} ·{" "}
            {kf.crop
              ? `crop x${kf.crop.x.toFixed(2)} y${kf.crop.y.toFixed(2)} w${kf.crop.w.toFixed(2)} h${kf.crop.h.toFixed(2)}`
              : "whole frame"}
            <button
              type="button"
              className={styles.miniButton}
              onClick={() => {
                setEditingKeyframeId(kf.id);
                if (kf.crop) {
                  setDraftCrop({
                    x: kf.crop.x.toFixed(3),
                    y: kf.crop.y.toFixed(3),
                    w: kf.crop.w.toFixed(3),
                    h: kf.crop.h.toFixed(3),
                  });
                }
              }}
            >
              Edit
            </button>
            <button
              type="button"
              className={styles.miniButton}
              onClick={() =>
                void run("keyframe", async () => {
                  const next = await trackingApi.deleteKeyframe(docId, kf.id);
                  setState(next);
                })
              }
            >
              Delete
            </button>
          </li>
        ))}
        {state.manualKeyframes.length === 0 && <li className={styles.small}>No manual keyframes yet.</li>}
      </ul>
      <div className={styles.fieldGrid}>
        {(["x", "y", "w", "h"] as const).map((axis) => (
          <div className={styles.field} key={axis}>
            <label htmlFor={`kf-${axis}`}>Crop {axis} (0–1)</label>
            <input
              id={`kf-${axis}`}
              type="number"
              step={0.01}
              min={0}
              max={1}
              value={draftCrop[axis]}
              onChange={(e) => setDraftCrop((d) => ({ ...d, [axis]: e.target.value }))}
            />
          </div>
        ))}
      </div>
      <div className={styles.fieldGrid}>
        <button
          type="button"
          className={styles.miniButton}
          disabled={busy !== null}
          onClick={() =>
            void run("keyframe", async () => {
              const crop = {
                x: Math.min(1, Math.max(0, Number(draftCrop.x) || 0)),
                y: Math.min(1, Math.max(0, Number(draftCrop.y) || 0)),
                w: Math.min(1, Math.max(0.01, Number(draftCrop.w) || 0.5)),
                h: Math.min(1, Math.max(0.01, Number(draftCrop.h) || 0.5)),
              };
              const next = editingKeyframeId
                ? await trackingApi.updateKeyframe(docId, editingKeyframeId, { t: previewTime, crop })
                : await trackingApi.addKeyframe(docId, { t: previewTime, crop });
              setEditingKeyframeId(null);
              setState(next);
            })
          }
        >
          {editingKeyframeId ? `Save keyframe at ${fmtTime(previewTime)}` : `Add keyframe at ${fmtTime(previewTime)}`}
        </button>
        <button
          type="button"
          className={styles.miniButton}
          disabled={busy !== null || state.manualKeyframes.length === 0}
          onClick={() =>
            void run("keyframe", async () => {
              // Reset to AI tracking: remove every manual keyframe.
              let next = state;
              for (const kf of state.manualKeyframes) {
                next = await trackingApi.deleteKeyframe(docId, kf.id);
              }
              setState(next);
            })
          }
        >
          Reset to AI tracking
        </button>
      </div>

      {/* --- reframe render ---------------------------------------------------------- */}
      <h4>Reframed export</h4>
      <p className={styles.small}>
        Renders the timeline through the Phase 5/6 pipeline using this configuration&apos;s crop
        path — original audio and caption burn-in are preserved.
      </p>
      <div className={styles.fieldGrid}>
        <button
          type="button"
          className={styles.miniButton}
          disabled={busy !== null || !tracked}
          onClick={() =>
            void run("render", async () => {
              const { job: created } = await trackingApi.reframeRender(docId);
              setRenderJob(created);
            })
          }
        >
          Render reframed export
        </button>
        {renderJob && (
          <span className={styles.small}>
            {renderJob.status} · {renderJob.stage}
            {renderJob.status === "COMPLETED" && (
              <>
                {" · "}
                <a href={editorApi.renderDownloadUrl(renderJob.id)}>Download MP4</a>
              </>
            )}
            {renderJob.error ? ` · ${renderJob.error}` : ""}
          </span>
        )}
      </div>
      {!tracked && <p className={styles.small}>Run subject analysis first — a reframe render needs tracking data.</p>}
      <p className={styles.small}>Project: {projectId} · {faceCount} face subject(s) tracked.</p>
    </section>
  );
}
