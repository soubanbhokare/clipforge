// Phase 8 — AI B-roll, Smart Enhancement & Background panel.
//
// Honesty contract (mirrors the server):
//  - B-roll recommendations come from the project's REAL transcript:
//    every card shows the spoken passage, the terms that matched and
//    the overlap score. Nothing is inserted without an explicit
//    Accept; the original speech audio keeps playing under B-roll
//    (placed items start muted unless the user changes the mix).
//  - Enhancement controls map 1:1 onto real FFmpeg filters via ONE
//    server-side chain builder shared by preview and render, so the
//    before/after preview cannot drift from the export. Upscaling is
//    labelled scale-only; stabilization runs as a per-asset two-pass
//    job, never silently inside a document render.
//  - Stock import, AI generation and background removal have NO
//    provider configured in this environment: the panel shows the
//    server's own not-configured detail and surfaces the persisted
//    FAILED job — it never fakes a result.

import { useCallback, useEffect, useRef, useState } from "react";
import { editorApi, formatClock, type EditorDocument, type RenderJob } from "../../services/editor";
import {
  DEFAULT_AUDIO_ENHANCE,
  DEFAULT_VIDEO_ENHANCE,
  phase8Api,
  toClientAudioSettings,
  toClientVideoSettings,
  type AudioEnhanceSettings,
  type BrollDisplayMode,
  type BrollPlacement,
  type BrollRecommendation,
  type EffectPreset,
  type EnhancementConfig,
  type LibraryAsset,
  type Phase8Job,
  type Phase8Status,
  type VideoEnhanceSettings,
} from "../../services/phase8";
import styles from "../../pages/studio/Editor.module.css";

interface Props {
  doc: EditorDocument;
  projectId: string;
  onReplaceDocument: (doc: EditorDocument) => void;
}

// Gap-fix settings fields (detail enhancement, echo reduction,
// L/R balance, volume automation).
// The server schema (server/src/enhance.ts) defines them and the
// service coercion helpers spread server payloads, so the values
// ride through at runtime; the shared client service types predate
// the fields, so the panel keeps extended local types and converts
// at the service boundary — the wire shape stays exactly the
// server's shape.
interface VolumeAutomationPoint {
  timeSec: number;
  gainDb: number;
}
type VideoSettingsX = VideoEnhanceSettings & {
  detail: number;
  stabilization: VideoEnhanceSettings["stabilization"] & { cropCompensation: number };
};
type AudioSettingsX = AudioEnhanceSettings & {
  echoReduction: number;
  balance: number;
  volumeAutomation: VolumeAutomationPoint[];
};

const DEFAULT_VIDEO_X: VideoSettingsX = {
  ...DEFAULT_VIDEO_ENHANCE,
  detail: 0,
  stabilization: { ...DEFAULT_VIDEO_ENHANCE.stabilization, cropCompensation: 0.5 },
};
const DEFAULT_AUDIO_X: AudioSettingsX = {
  ...DEFAULT_AUDIO_ENHANCE,
  echoReduction: 0,
  balance: 0,
  volumeAutomation: [],
};

function asVideoX(raw: unknown): VideoSettingsX {
  const obj = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const base = toClientVideoSettings(obj as Partial<VideoEnhanceSettings>);
  const stab = (typeof obj.stabilization === "object" && obj.stabilization !== null
    ? obj.stabilization
    : {}) as Record<string, unknown>;
  return {
    ...base,
    detail: typeof obj.detail === "number" ? obj.detail : 0,
    stabilization: {
      ...base.stabilization,
      cropCompensation: typeof stab.cropCompensation === "number" ? stab.cropCompensation : 0.5,
    },
  };
}

function asAudioX(raw: unknown): AudioSettingsX {
  const obj = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const base = toClientAudioSettings(obj as Partial<AudioEnhanceSettings>);
  const pts = Array.isArray(obj.volumeAutomation) ? (obj.volumeAutomation as VolumeAutomationPoint[]) : [];
  return {
    ...base,
    echoReduction: typeof obj.echoReduction === "number" ? obj.echoReduction : 0,
    balance: typeof obj.balance === "number" ? obj.balance : 0,
    volumeAutomation: pts
      .filter((p) => typeof p?.timeSec === "number" && typeof p?.gainDb === "number")
      .map((p) => ({ timeSec: p.timeSec, gainDb: p.gainDb })),
  };
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  hint?: string;
}) {
  return (
    <label className={styles.field}>
      <span>
        {label}: <strong>{value}</strong>
        {hint ? <span className={styles.small}> — {hint}</span> : null}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

function JobLine({ job }: { job: Phase8Job }) {
  return (
    <span>
      <span className={styles.badge}>{job.kind.replace(/_/g, " ").toLowerCase()}</span>{" "}
      <span className={job.status === "FAILED" ? styles.badgeWarn : job.status === "COMPLETED" ? styles.badgeLime : styles.badge}>
        {job.status}
      </span>{" "}
      <span className={styles.small}>stage: {job.stage.replace(/_/g, " ").toLowerCase()}</span>
      {job.error || job.errorCode ? (
        <span className={styles.errorText}>
          {" "}
          {job.error}
          {job.errorCode ? ` (${job.errorCode})` : ""}
        </span>
      ) : null}
    </span>
  );
}

const VIDEO_SLIDERS: { key: keyof VideoEnhanceSettings; label: string; min: number; max: number; step: number; hint?: string }[] = [
  { key: "brightness", label: "Brightness", min: -1, max: 1, step: 0.05 },
  { key: "contrast", label: "Contrast", min: 0.5, max: 2, step: 0.05 },
  { key: "saturation", label: "Saturation", min: 0, max: 2, step: 0.05 },
  { key: "exposure", label: "Exposure", min: -1, max: 1, step: 0.1 },
  { key: "gamma", label: "Gamma", min: 0.4, max: 2.5, step: 0.05 },
  { key: "temperature", label: "Temperature", min: -1, max: 1, step: 0.05, hint: "colour balance" },
  { key: "tint", label: "Tint", min: -1, max: 1, step: 0.05, hint: "colour balance" },
  { key: "highlights", label: "Highlights", min: -1, max: 1, step: 0.05, hint: "curves" },
  { key: "shadows", label: "Shadows", min: -1, max: 1, step: 0.05, hint: "curves" },
  { key: "sharpen", label: "Sharpen", min: 0, max: 1, step: 0.05, hint: "unsharp mask" },
  { key: "denoise", label: "Denoise", min: 0, max: 1, step: 0.05, hint: "hqdn3d" },
  { key: "artifactReduction", label: "Artifact reduction", min: 0, max: 1, step: 0.05, hint: "deblock + denoise" },
  { key: "blur", label: "Blur", min: 0, max: 1, step: 0.05, hint: "gaussian" },
  { key: "vignette", label: "Vignette", min: 0, max: 1, step: 0.05 },
];

export function EnhancePanel({ doc, projectId, onReplaceDocument }: Props) {
  const [status, setStatus] = useState<Phase8Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Visible, sticky problem notes: a failed editor-document refresh
  // and pollers that keep failing must not fail silently.
  const [docRefreshError, setDocRefreshError] = useState<string | null>(null);
  const [pollProblem, setPollProblem] = useState(false);

  // B-roll state
  const [instructions, setInstructions] = useState("");
  const [recommendations, setRecommendations] = useState<BrollRecommendation[]>([]);
  const [placements, setPlacements] = useState<BrollPlacement[]>([]);
  const [acceptDraft, setAcceptDraft] = useState<Record<string, { mode: BrollDisplayMode; keepAudio: boolean }>>({});
  const [previewRecId, setPreviewRecId] = useState<string | null>(null);
  // Multi-accept: selected recommendation ids + honest per-item results.
  const [selectedRecs, setSelectedRecs] = useState<Set<string>>(new Set());
  const [batchResults, setBatchResults] = useState<{ id: string; ok: boolean; message: string }[]>([]);
  // Per-placement start/duration drafts (fix: timing edits in the UI).
  const [placementDraft, setPlacementDraft] = useState<Record<string, { start: number; duration: number }>>({});

  // Enhancement config state
  const [config, setConfig] = useState<EnhancementConfig | null>(null);
  const [video, setVideo] = useState<VideoSettingsX>(DEFAULT_VIDEO_X);
  const [audio, setAudio] = useState<AudioSettingsX>(DEFAULT_AUDIO_X);
  const [videoEnabled, setVideoEnabled] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [scope, setScope] = useState<"project" | "items">("project");
  const [itemIds, setItemIds] = useState<string[]>([]);

  // Library / presets / jobs
  const [assets, setAssets] = useState<LibraryAsset[]>([]);
  const [presets, setPresets] = useState<EffectPreset[]>([]);
  const [jobs, setJobs] = useState<Phase8Job[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [activeJob, setActiveJob] = useState<Phase8Job | null>(null);
  const [previewJob, setPreviewJob] = useState<Phase8Job | null>(null);
  const [renderJob, setRenderJob] = useState<RenderJob | null>(null);

  // Asset-job + background drafts
  const [assetRef, setAssetRef] = useState<string>("");
  const [stabEnabled, setStabEnabled] = useState(false);
  const [stabStrength, setStabStrength] = useState(0.5);
  const [stabCrop, setStabCrop] = useState(0.5);
  const [stabSmoothing, setStabSmoothing] = useState(30);
  // Custom preset currently being edited (fix: Edit UI for the PUT API).
  const [editingPreset, setEditingPreset] = useState<EffectPreset | null>(null);
  const [upscaleEnabled, setUpscaleEnabled] = useState(false);
  const [upscaleW, setUpscaleW] = useState(1920);
  const [upscaleH, setUpscaleH] = useState(1080);
  const [bgMode, setBgMode] = useState<
    "remove" | "blur" | "solid-dark" | "solid-light" | "custom-image" | "custom-video"
  >("blur");
  // Provider attempt drafts (stock import / AI generation). Neither
  // provider is configured in this environment, so an attempt
  // honestly ends in a persisted FAILED job (422 CONFIGURATION_ERROR)
  // — the controls exist so that failure is reachable and visible.
  const [stockAssetId, setStockAssetId] = useState("");
  const [genPrompt, setGenPrompt] = useState("");
  const [genKind, setGenKind] = useState<"video" | "image">("video");
  const [presetName, setPresetName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Poll health: a single dropped poll is fine, but repeated
  // consecutive failures mean the panel would otherwise spin on
  // stale status forever — surface that as a visible problem note.
  const jobPollFails = useRef(0);
  const renderPollFails = useRef(0);
  const notePollFailure = (which: "job" | "render") => {
    if (which === "job") jobPollFails.current += 1;
    else renderPollFails.current += 1;
    if (mounted.current && (jobPollFails.current >= 3 || renderPollFails.current >= 3)) {
      setPollProblem(true);
    }
  };
  const notePollSuccess = (which: "job" | "render") => {
    if (which === "job") jobPollFails.current = 0;
    else renderPollFails.current = 0;
    if (mounted.current && jobPollFails.current < 3 && renderPollFails.current < 3) {
      setPollProblem(false);
    }
  };

  const refreshDoc = useCallback(async () => {
    try {
      const res = await editorApi.getDocument(projectId);
      onReplaceDocument(res.document);
      setDocRefreshError(null);
    } catch {
      // The panel lists still refresh, but a stale editor document
      // must not pass silently — the user is told, visibly.
      setDocRefreshError(
        "Could not refresh the editor document after that change — the timeline may be out of date. Reload the page if it looks wrong.",
      );
    }
  }, [projectId, onReplaceDocument]);

  const loadAll = useCallback(async () => {
    try {
      const [st, recs, pls, cfg, lib, prs, jb] = await Promise.all([
        phase8Api.status(),
        phase8Api.listRecommendations(projectId, "PENDING"),
        phase8Api.listPlacements(projectId),
        phase8Api.getEnhancement(doc.id),
        phase8Api.listLibrary({ projectId }),
        phase8Api.listPresets(),
        phase8Api.listJobs(projectId),
      ]);
      if (!mounted.current) return;
      setStatus(st);
      setRecommendations(recs.recommendations);
      setPlacements(pls.placements);
      setConfig(cfg.config);
      const loadedVideo = asVideoX(cfg.config.video);
      setVideo(loadedVideo);
      // The stabilization controls mirror the saved configuration,
      // and every payload takes stabilization FROM the controls
      // (videoForPayload below) — what the user sees is what is sent.
      setStabEnabled(loadedVideo.stabilization.enabled);
      setStabStrength(loadedVideo.stabilization.strength);
      setStabSmoothing(loadedVideo.stabilization.smoothing);
      setStabCrop(loadedVideo.stabilization.cropCompensation);
      setAudio(asAudioX(cfg.config.audio));
      setVideoEnabled(cfg.config.videoEnabled);
      setAudioEnabled(cfg.config.audioEnabled);
      setScope(cfg.config.scope);
      setItemIds(cfg.config.itemIds);
      setAssets(lib.assets);
      setPresets(prs.presets);
      setJobs(jb.jobs.slice(0, 8));
      setError(null);
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : "Could not load enhancement state.");
    }
  }, [doc.id, projectId]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // Poll the active phase-8 job; refresh lists when it lands.
  useEffect(() => {
    if (!activeJobId) return;
    const timer = setInterval(async () => {
      try {
        const { job } = await phase8Api.getJob(activeJobId);
        if (!mounted.current) return;
        notePollSuccess("job");
        setActiveJob(job);
        if (job.kind === "ENHANCEMENT_PREVIEW") setPreviewJob(job);
        if (["COMPLETED", "FAILED", "CANCELLED"].includes(job.status)) {
          clearInterval(timer);
          setActiveJobId(null);
          void loadAll();
          if (job.kind === "BROLL_RECOMMENDATIONS" && job.status === "COMPLETED") {
            setNotice(`${String(job.result.recommendations ?? 0)} recommendation(s) from ${String(job.result.windowsAnalysed ?? 0)} spoken moments.`);
          }
        }
      } catch {
        /* keep polling — but repeated failures surface via notePollFailure */
        notePollFailure("job");
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [activeJobId, loadAll]);

  // Poll an enhanced render started from this panel.
  useEffect(() => {
    if (!renderJob || (renderJob.status !== "QUEUED" && renderJob.status !== "RUNNING")) return;
    const timer = setInterval(async () => {
      try {
        const { job } = await editorApi.getRender(renderJob.id);
        notePollSuccess("render");
        if (mounted.current) setRenderJob(job);
      } catch {
        /* keep polling — but repeated failures surface via notePollFailure */
        notePollFailure("render");
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [renderJob?.id, renderJob?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const startJob = (job: Phase8Job) => {
    setActiveJob(job);
    setActiveJobId(job.id);
  };

  // The server shape for frame rate is fps: { target, interpolate };
  // the form's three-way mode is derived from it (and written back
  // through the mapping in the Frame rate select below).
  const frameRateMode: "keep" | "fps" | "smooth" =
    video.fps.target == null ? "keep" : video.fps.interpolate ? "smooth" : "fps";
  const frameRateTarget = video.fps.target ?? 30;

  const videoAssets = assets.filter((a) => a.mediaKind === "VIDEO");
  const selectedAsset = assets.find((a) => a.ref === assetRef) ?? videoAssets[0];
  const effectiveRef = selectedAsset?.ref ?? "";

  // Single merge point for stabilization: EVERY payload that
  // carries video settings — saved configuration, render prep,
  // before/after preview and the per-asset job — takes
  // stabilization from the stabilization CONTROLS, never from
  // whatever value happens to sit in the loaded form state.
  const videoForPayload = (): VideoSettingsX => ({
    ...video,
    stabilization: {
      enabled: stabEnabled,
      strength: stabStrength,
      smoothing: stabSmoothing,
      cropCompensation: stabCrop,
    },
  });

  const applyPreset = (preset: EffectPreset) => {
    if (preset.kind === "background") {
      setNotice(
        `Preset “${preset.name}” is a background preset — those need the background-removal provider, which is not configured on this server, so it cannot be loaded into this form.`,
      );
      return;
    }
    if (preset.kind === "video" || preset.kind === "effect") {
      setVideo(asVideoX(preset.settings));
      setVideoEnabled(true);
    } else if (preset.kind === "audio") {
      setAudio(asAudioX(preset.settings));
      setAudioEnabled(true);
    }
    setNotice(`Preset “${preset.name}” loaded into the form — Save configuration to persist it.`);
  };

  // Multi-accept: every selected card goes through the SAME single
  // accept endpoint, one by one, and each outcome is reported on its
  // own — a failure neither blocks nor fakes the others.
  const acceptSelected = async () => {
    const targets = recommendations.filter((r) => selectedRecs.has(r.id));
    if (targets.length === 0) return;
    setBusy("accept-batch");
    setError(null);
    const results: { id: string; ok: boolean; message: string }[] = [];
    for (const rec of targets) {
      const draft = acceptDraft[rec.id] ?? { mode: "FULLSCREEN" as BrollDisplayMode, keepAudio: true };
      try {
        await phase8Api.acceptRecommendation(rec.id, {
          displayMode: draft.mode,
          keepOriginalAudio: draft.keepAudio,
        });
        results.push({ id: rec.id, ok: true, message: `${rec.assetFilename} placed on the B-roll track.` });
      } catch (err) {
        results.push({
          id: rec.id,
          ok: false,
          message: `${rec.assetFilename}: ${err instanceof Error ? err.message : "accept failed"}`,
        });
      }
    }
    if (!mounted.current) return;
    setBatchResults(results);
    // Keep failed cards selected so the user can fix and retry them.
    setSelectedRecs(new Set(results.filter((r) => !r.ok).map((r) => r.id)));
    setBusy(null);
    await Promise.all([loadAll(), refreshDoc()]);
    const okCount = results.filter((r) => r.ok).length;
    setNotice(`${okCount} of ${results.length} selected placement(s) added.`);
  };

  return (
    <section aria-label="B-roll, enhancement and background">
      <h3>B-roll & Enhancement</h3>
      {error && (
        <p className={styles.errorText} role="alert">
          {error}
        </p>
      )}
      {notice && <p className={styles.small}>{notice}</p>}
      {docRefreshError && (
        <p className={styles.errorText} role="alert">
          {docRefreshError}
        </p>
      )}
      {pollProblem && (
        <p className={styles.errorText} role="alert">
          Connection problem: live job status updates keep failing, so the job statuses below may
          be stale. Check your connection — or reload the page.
        </p>
      )}

      {status && (
        <div className={styles.gapNotice}>
          <p className={styles.small}>
            <strong>Standard filters (FFmpeg, local):</strong> {status.providers.enhancement.capabilities.classification.standardFilters}
          </p>
          <p className={styles.small}>
            <strong>AI-powered:</strong> {status.providers.enhancement.capabilities.classification.aiPowered}
          </p>
          <p className={styles.small}>
            <strong>Stock import:</strong>{" "}
            {status.providers.stock.configured ? "configured" : `not configured — ${status.providers.stock.detail}`}
          </p>
          <p className={styles.small}>
            <strong>AI generation:</strong>{" "}
            {status.providers.generation.configured ? "configured" : `not configured — ${status.providers.generation.detail}`}
          </p>
          <p className={styles.small}>
            <strong>Background removal:</strong>{" "}
            {status.providers.backgroundRemoval.configured
              ? "configured"
              : `not configured — ${status.providers.backgroundRemoval.detail}`}
          </p>
        </div>
      )}

      {/* ---------------- B-roll recommendations ---------------- */}
      <h4 className={styles.subhead}>B-roll recommendations (from the real transcript)</h4>
      <label className={styles.field}>
        <span>Optional guidance for the matcher (e.g. “city driving, dashboard close-ups”)</span>
        <input
          type="text"
          value={instructions}
          maxLength={1000}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="Leave empty to match on the transcript alone"
        />
      </label>
      <button
        type="button"
        className={styles.toolButton}
        disabled={busy !== null}
        onClick={() =>
          void run("recs", async () => {
            const { job } = await phase8Api.createRecommendations(projectId, instructions.trim() || undefined);
            startJob(job);
          })
        }
      >
        {busy === "recs" ? "Starting…" : "Find B-roll for this transcript"}
      </button>
      {activeJob?.kind === "BROLL_RECOMMENDATIONS" && (
        <p className={styles.small}>
          <JobLine job={activeJob} />
        </p>
      )}

      {recommendations.length === 0 && (
        <p className={styles.muted}>
          No pending recommendations. Run the matcher — only moments with genuine term overlap with a
          library asset produce a card; nothing is ever inserted without your Accept.
        </p>
      )}
      {recommendations.length > 0 && (
        <>
          <span className={styles.addButtons}>
            <button
              type="button"
              className={styles.toolButton}
              disabled={busy !== null || selectedRecs.size === 0}
              onClick={() => void acceptSelected()}
            >
              {busy === "accept-batch" ? "Placing…" : `Accept selected (${selectedRecs.size})`}
            </button>
            <span className={styles.small}>
              Each selected card is placed through the same accept path as “Add to timeline”, one by
              one — results are reported per card below.
            </span>
          </span>
          {batchResults.length > 0 && (
            <div>
              {batchResults.map((r) => (
                <p key={r.id} className={r.ok ? styles.small : styles.errorText}>
                  {r.ok ? "✓ " : "✗ "}
                  {r.message}
                </p>
              ))}
            </div>
          )}
        </>
      )}
      {recommendations.map((rec) => {
        const draft = acceptDraft[rec.id] ?? { mode: "FULLSCREEN" as BrollDisplayMode, keepAudio: true };
        return (
          <div key={rec.id} className={styles.assetRow}>
            <div className={styles.assetRowTop}>
              <span className={styles.assetName}>{rec.assetFilename}</span>
              <span className={styles.badgeLime}>{Math.round(rec.score * 100)}% match</span>
              <label className={styles.checkRow}>
                <input
                  type="checkbox"
                  checked={selectedRecs.has(rec.id)}
                  onChange={(e) =>
                    setSelectedRecs((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(rec.id);
                      else next.delete(rec.id);
                      return next;
                    })
                  }
                />
                Select
              </label>
            </div>
            {rec.thumbnailUrl && (
              <img
                src={rec.thumbnailUrl}
                alt={`Frame from ${rec.assetFilename}`}
                style={{ width: "100%", borderRadius: 6 }}
                loading="lazy"
              />
            )}
            <span className={styles.small}>
              Spoken at {formatClock(rec.windowStartSec)}–{formatClock(rec.windowEndSec)} · suggested{" "}
              {rec.suggestedDurationSec.toFixed(1)}s · source: {rec.source}
              {rec.license ? ` · licence: ${String((rec.license as { licenseName?: string }).licenseName ?? "see record")}` : ""}
            </span>
            <span className={styles.small}>
              <em>“{rec.passage}”</em>
            </span>
            <span className={styles.small}>{rec.reason}</span>
            {rec.matchedTerms.length > 0 && (
              <span className={styles.wordChips}>
                {rec.matchedTerms.map((t) => (
                  <span key={t} className={styles.wordChip}>
                    {t}
                  </span>
                ))}
              </span>
            )}
            {previewRecId === rec.id && rec.streamUrl && (
              <video src={rec.streamUrl} controls className={styles.brollVideo} preload="metadata" />
            )}
            <span className={styles.addButtons}>
              <button
                type="button"
                className={styles.miniButton}
                onClick={() => setPreviewRecId(previewRecId === rec.id ? null : rec.id)}
              >
                {previewRecId === rec.id ? "Hide preview" : "Preview"}
              </button>
              <select
                aria-label="Display mode"
                value={draft.mode}
                onChange={(e) =>
                  setAcceptDraft((p) => ({ ...p, [rec.id]: { ...draft, mode: e.target.value as BrollDisplayMode } }))
                }
              >
                <option value="FULLSCREEN">Full screen</option>
                <option value="PIP">Picture in picture</option>
                <option value="OVERLAY">Overlay</option>
              </select>
              <label className={styles.checkRow}>
                <input
                  type="checkbox"
                  checked={draft.keepAudio}
                  onChange={(e) =>
                    setAcceptDraft((p) => ({ ...p, [rec.id]: { ...draft, keepAudio: e.target.checked } }))
                  }
                />
                Keep speech audio
              </label>
              <button
                type="button"
                className={styles.miniButton}
                disabled={busy !== null}
                onClick={() =>
                  void run(`accept-${rec.id}`, async () => {
                    await phase8Api.acceptRecommendation(rec.id, {
                      displayMode: draft.mode,
                      keepOriginalAudio: draft.keepAudio,
                    });
                    await Promise.all([loadAll(), refreshDoc()]);
                    setNotice("B-roll placed on the B-roll track. The original speech keeps playing underneath.");
                  })
                }
              >
                Add to timeline
              </button>
              <button
                type="button"
                className={styles.miniButton}
                disabled={busy !== null}
                onClick={() =>
                  void run(`replace-${rec.id}`, async () => {
                    await phase8Api.replaceRecommendation(rec.id);
                    await loadAll();
                  })
                }
              >
                Replace suggestion
              </button>
              <button
                type="button"
                className={styles.miniButtonDanger}
                disabled={busy !== null}
                onClick={() =>
                  void run(`dismiss-${rec.id}`, async () => {
                    await phase8Api.dismissRecommendation(rec.id);
                    await loadAll();
                  })
                }
              >
                Dismiss
              </button>
            </span>
          </div>
        );
      })}
      <p className={styles.small}>
        Split-screen is not offered for B-roll placements — the timeline transform model cannot express
        half-canvas regions. Use Face Lock → Split Screen for two-subject layouts.
      </p>

      {placements.length > 0 && (
        <>
          <h4 className={styles.subhead}>Placed B-roll</h4>
          {placements.map((p) => {
            const draft = placementDraft[p.id] ?? { start: p.startSec, duration: p.durationSec };
            return (
            <div key={p.id} className={styles.assetRow}>
              <span className={styles.small}>
                {formatClock(p.startSec)} · {p.durationSec.toFixed(1)}s · {p.displayMode.toLowerCase()} ·{" "}
                {p.keepOriginalAudio ? "speech audio kept" : "B-roll audio plays"}
              </span>
              <span className={styles.addButtons}>
                <label className={styles.small}>
                  Start (s){" "}
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={draft.start}
                    aria-label="Placement start in seconds"
                    onChange={(e) =>
                      setPlacementDraft((prev) => ({
                        ...prev,
                        [p.id]: { start: Number(e.target.value), duration: draft.duration },
                      }))
                    }
                  />
                </label>
                <label className={styles.small}>
                  Duration (s){" "}
                  <input
                    type="number"
                    min={0.5}
                    step={0.1}
                    value={draft.duration}
                    aria-label="Placement duration in seconds"
                    onChange={(e) =>
                      setPlacementDraft((prev) => ({
                        ...prev,
                        [p.id]: { start: draft.start, duration: Number(e.target.value) },
                      }))
                    }
                  />
                </label>
                <button
                  type="button"
                  className={styles.miniButton}
                  disabled={busy !== null}
                  onClick={() =>
                    void run(`ptime-${p.id}`, async () => {
                      await phase8Api.updatePlacement(p.id, {
                        startSec: draft.start,
                        durationSec: draft.duration,
                      });
                      setPlacementDraft((prev) => {
                        const next = { ...prev };
                        delete next[p.id];
                        return next;
                      });
                      await Promise.all([loadAll(), refreshDoc()]);
                      setNotice("Placement timing updated on the timeline.");
                    })
                  }
                >
                  Apply timing
                </button>
                <select
                  aria-label="Placement display mode"
                  value={p.displayMode}
                  onChange={(e) =>
                    void run(`pmode-${p.id}`, async () => {
                      await phase8Api.updatePlacement(p.id, { displayMode: e.target.value as BrollDisplayMode });
                      await Promise.all([loadAll(), refreshDoc()]);
                    })
                  }
                >
                  <option value="FULLSCREEN">Full screen</option>
                  <option value="PIP">Picture in picture</option>
                  <option value="OVERLAY">Overlay</option>
                </select>
                <button
                  type="button"
                  className={styles.miniButtonDanger}
                  disabled={busy !== null}
                  onClick={() =>
                    void run(`pdel-${p.id}`, async () => {
                      await phase8Api.deletePlacement(p.id);
                      await Promise.all([loadAll(), refreshDoc()]);
                    })
                  }
                >
                  Remove
                </button>
              </span>
            </div>
            );
          })}
        </>
      )}

      {/* ---------------- Enhancement configuration ---------------- */}
      <h4 className={styles.subhead}>Smart enhancement (standard FFmpeg filters — no “AI” labels)</h4>
      <label className={styles.checkRow}>
        <input type="checkbox" checked={videoEnabled} onChange={(e) => setVideoEnabled(e.target.checked)} />
        Video enhancement enabled
      </label>
      <label className={styles.checkRow}>
        <input type="checkbox" checked={audioEnabled} onChange={(e) => setAudioEnabled(e.target.checked)} />
        Audio enhancement enabled
      </label>
      <label className={styles.field}>
        <span>Apply to</span>
        <select value={scope} onChange={(e) => setScope(e.target.value as "project" | "items")}>
          <option value="project">Whole project (post-compose pass)</option>
          <option value="items">Selected clips only (per-clip pass)</option>
        </select>
      </label>
      {scope === "items" && (
        <div className={styles.field}>
          <span className={styles.small}>Clips receiving the per-clip video chain:</span>
          {doc.items.map((item) => (
            <label key={item.id} className={styles.checkRow}>
              <input
                type="checkbox"
                checked={itemIds.includes(item.id)}
                onChange={(e) =>
                  setItemIds((prev) => (e.target.checked ? [...prev, item.id] : prev.filter((x) => x !== item.id)))
                }
              />
              {item.assetKind} clip at {formatClock(item.start)} ({item.duration.toFixed(1)}s)
            </label>
          ))}
        </div>
      )}

      <div className={styles.fieldGrid}>
        {VIDEO_SLIDERS.map((s) => (
          <Slider
            key={s.key}
            label={s.label}
            hint={s.hint}
            value={Number(video[s.key])}
            min={s.min}
            max={s.max}
            step={s.step}
            onChange={(v) => setVideo((prev) => ({ ...prev, [s.key]: v }))}
          />
        ))}
        <Slider
          label="Detail enhancement"
          hint="fine-texture unsharp — its own stage, separate from Sharpen"
          value={video.detail}
          min={0}
          max={1}
          step={0.05}
          onChange={(v) => setVideo((prev) => ({ ...prev, detail: v }))}
        />
      </div>
      <label className={styles.field}>
        <span>
          White balance: <strong>{video.whiteBalanceK} K</strong>
          <span className={styles.small}>
            {" "}
            — {video.whiteBalanceK < 6500 ? "cooler" : video.whiteBalanceK > 6500 ? "warmer" : "neutral"} (colortemperature)
          </span>
        </span>
        <input
          type="range"
          min={2500}
          max={10000}
          step={100}
          value={video.whiteBalanceK}
          onChange={(e) => setVideo((prev) => ({ ...prev, whiteBalanceK: Number(e.target.value) }))}
        />
        <span className={styles.small}>2500 K cooler — 6500 K neutral — 10000 K warmer</span>
      </label>
      <label className={styles.checkRow}>
        <input
          type="checkbox"
          checked={video.grayscale}
          onChange={(e) => setVideo((prev) => ({ ...prev, grayscale: e.target.checked }))}
        />
        Grayscale
      </label>
      <label className={styles.field}>
        <span>Frame rate</span>
        <select
          value={frameRateMode}
          onChange={(e) => {
            const mode = e.target.value as "keep" | "fps" | "smooth";
            setVideo((prev) => ({
              ...prev,
              fps:
                mode === "keep"
                  ? { target: null, interpolate: false }
                  : { target: prev.fps.target ?? 30, interpolate: mode === "smooth" },
            }));
          }}
        >
          <option value="keep">Keep source rate</option>
          <option value="fps">Convert (fps filter)</option>
          <option value="smooth">Smooth (minterpolate — standard motion estimation, not AI)</option>
        </select>
      </label>
      {frameRateMode !== "keep" && (
        <label className={styles.field}>
          <span>Target fps</span>
          <select
            value={frameRateTarget}
            onChange={(e) =>
              setVideo((prev) => ({ ...prev, fps: { target: Number(e.target.value), interpolate: prev.fps.interpolate } }))
            }
          >
            {[24, 25, 30, 48, 50, 60].map((f) => (
              <option key={f} value={f}>
                {f} fps
              </option>
            ))}
          </select>
        </label>
      )}
      <p className={styles.small}>
        {status?.providers.enhancement.capabilities.interpolationNote ?? ""}
      </p>

      <h4 className={styles.subhead}>Audio enhancement</h4>
      <div className={styles.fieldGrid}>
        <Slider label="Noise reduction" hint="afftdn" value={audio.denoise} min={0} max={1} step={0.05} onChange={(v) => setAudio((p) => ({ ...p, denoise: v }))} />
        <Slider label="Speech clarity" hint="presence EQ" value={audio.clarity} min={0} max={1} step={0.05} onChange={(v) => setAudio((p) => ({ ...p, clarity: v }))} />
        <Slider label="Gain (dB)" value={audio.gainDb} min={-24} max={24} step={0.5} onChange={(v) => setAudio((p) => ({ ...p, gainDb: v }))} />
        <Slider label="Fade in (s)" value={audio.fadeInSec} min={0} max={10} step={0.25} onChange={(v) => setAudio((p) => ({ ...p, fadeInSec: v }))} />
        <Slider label="Fade out (s)" value={audio.fadeOutSec} min={0} max={10} step={0.25} onChange={(v) => setAudio((p) => ({ ...p, fadeOutSec: v }))} />
        <Slider label="Target loudness (LUFS)" value={audio.targetLufs} min={-30} max={-8} step={1} onChange={(v) => setAudio((p) => ({ ...p, targetLufs: v }))} />
      </div>
      <label className={styles.checkRow}>
        <input
          type="checkbox"
          checked={audio.hum.enabled}
          onChange={(e) => setAudio((p) => ({ ...p, hum: { ...p.hum, enabled: e.target.checked } }))}
        />
        Hum reduction (mains notch)
      </label>
      {audio.hum.enabled && (
        <label className={styles.field}>
          <span>Mains frequency</span>
          <select
            value={audio.hum.freq}
            onChange={(e) => setAudio((p) => ({ ...p, hum: { ...p.hum, freq: Number(e.target.value) as 50 | 60 } }))}
          >
            <option value={50}>50 Hz</option>
            <option value={60}>60 Hz</option>
          </select>
        </label>
      )}
      <label className={styles.field}>
        <span>Normalization</span>
        <select value={audio.normalize} onChange={(e) => setAudio((p) => ({ ...p, normalize: e.target.value as AudioEnhanceSettings["normalize"] }))}>
          <option value="off">Off</option>
          <option value="loudnorm">Loudness normalize (loudnorm, two-pass)</option>
          <option value="dynaudnorm">Dynamic normalize (dynaudnorm)</option>
        </select>
      </label>
      <label className={styles.checkRow}>
        <input
          type="checkbox"
          checked={audio.ducking.enabled}
          onChange={(e) => setAudio((p) => ({ ...p, ducking: { ...p.ducking, enabled: e.target.checked } }))}
        />
        Duck music under speech (real sidechain compression)
      </label>
      {audio.ducking.enabled && (
        <Slider label="Duck amount" value={audio.ducking.amount} min={0} max={1} step={0.05} onChange={(v) => setAudio((p) => ({ ...p, ducking: { ...p.ducking, amount: v } }))} />
      )}
      <div className={styles.fieldGrid}>
        <Slider
          label="Echo reduction"
          hint="aecho preset — tightens short echo tails, not a dereverb model"
          value={audio.echoReduction}
          min={0}
          max={1}
          step={0.05}
          onChange={(v) => setAudio((p) => ({ ...p, echoReduction: v }))}
        />
        <Slider
          label="Balance (L/R)"
          hint="-1 full left · 0 centre · +1 full right (pan)"
          value={audio.balance}
          min={-1}
          max={1}
          step={0.05}
          onChange={(v) => setAudio((p) => ({ ...p, balance: v }))}
        />
      </div>
      <div className={styles.field}>
        <span>
          Volume automation{" "}
          <span className={styles.small}>
            — gain points over time, rendered as a real piecewise-linear contour (volume, per-frame).
            Empty = off.
          </span>
        </span>
        {audio.volumeAutomation.map((pt, i) => (
          <span key={i} className={styles.addButtons}>
            <label className={styles.small}>
              at (s){" "}
              <input
                type="number"
                min={0}
                step={0.5}
                value={pt.timeSec}
                aria-label={`Automation point ${i + 1} time in seconds`}
                onChange={(e) =>
                  setAudio((p) => ({
                    ...p,
                    volumeAutomation: p.volumeAutomation.map((q, j) =>
                      j === i ? { ...q, timeSec: Number(e.target.value) } : q,
                    ),
                  }))
                }
              />
            </label>
            <label className={styles.small}>
              gain (dB){" "}
              <input
                type="number"
                min={-24}
                max={24}
                step={1}
                value={pt.gainDb}
                aria-label={`Automation point ${i + 1} gain in dB`}
                onChange={(e) =>
                  setAudio((p) => ({
                    ...p,
                    volumeAutomation: p.volumeAutomation.map((q, j) =>
                      j === i ? { ...q, gainDb: Number(e.target.value) } : q,
                    ),
                  }))
                }
              />
            </label>
            <button
              type="button"
              className={styles.miniButtonDanger}
              onClick={() =>
                setAudio((p) => ({ ...p, volumeAutomation: p.volumeAutomation.filter((_, j) => j !== i) }))
              }
            >
              Remove point
            </button>
          </span>
        ))}
        <span className={styles.addButtons}>
          <button
            type="button"
            className={styles.miniButton}
            onClick={() =>
              setAudio((p) => ({
                ...p,
                volumeAutomation: [
                  ...p.volumeAutomation,
                  {
                    timeSec: p.volumeAutomation.length
                      ? p.volumeAutomation[p.volumeAutomation.length - 1]!.timeSec + 2
                      : 0,
                    gainDb: 0,
                  },
                ],
              }))
            }
          >
            Add point
          </button>
        </span>
      </div>

      <span className={styles.addButtons}>
        <button
          type="button"
          className={styles.toolButton}
          disabled={busy !== null}
          onClick={() =>
            void run("save-config", async () => {
              const { config: saved } = await phase8Api.putEnhancement(doc.id, {
                videoEnabled, audioEnabled, video: videoForPayload(), audio, scope, itemIds,
              });
              setConfig(saved);
              setNotice("Enhancement configuration saved. Renders started with “Render with enhancements” will use it.");
            })
          }
        >
          {busy === "save-config" ? "Saving…" : "Save configuration"}
        </button>
        <button
          type="button"
          className={styles.miniButton}
          onClick={() => {
            setVideo(DEFAULT_VIDEO_X);
            setAudio(DEFAULT_AUDIO_X);
            setNotice("Form reset to defaults — Save configuration to persist.");
          }}
        >
          Reset form
        </button>
        <button
          type="button"
          className={styles.toolButton}
          disabled={busy !== null || (!videoEnabled && !audioEnabled)}
          onClick={() =>
            void run("render-enhanced", async () => {
              await phase8Api.putEnhancement(doc.id, { videoEnabled, audioEnabled, video: videoForPayload(), audio, scope, itemIds });
              const { job } = await phase8Api.renderEnhanced(doc.id);
              setRenderJob(job);
            })
          }
        >
          Render with enhancements
        </button>
      </span>
      {config?.updatedAt && <p className={styles.small}>Saved configuration last updated {new Date(config.updatedAt).toLocaleString()}.</p>}
      {renderJob && (
        <p className={styles.small}>
          <span className={styles.badge}>render</span>{" "}
          <span className={renderJob.status === "FAILED" ? styles.badgeWarn : renderJob.status === "COMPLETED" ? styles.badgeLime : styles.badge}>
            {renderJob.status}
          </span>{" "}
          {renderJob.status === "COMPLETED" && (
            <a href={editorApi.renderDownloadUrl(renderJob.id)} download>
              Download enhanced MP4
            </a>
          )}
          {renderJob.error ? <span className={styles.errorText}> {renderJob.error}</span> : null}
        </p>
      )}

      {/* ---------------- Presets ---------------- */}
      <h4 className={styles.subhead}>Presets</h4>
      <span className={styles.addButtons}>
        <select
          aria-label="Video preset"
          defaultValue=""
          onChange={(e) => {
            const preset = presets.find((p) => p.id === e.target.value);
            if (preset) applyPreset(preset);
            e.target.value = "";
          }}
        >
          <option value="" disabled>
            Apply a video preset…
          </option>
          {presets.filter((p) => p.kind === "video" || p.kind === "effect").map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.builtin ? "" : " (custom)"}
            </option>
          ))}
        </select>
        <select
          aria-label="Audio preset"
          defaultValue=""
          onChange={(e) => {
            const preset = presets.find((p) => p.id === e.target.value);
            if (preset) applyPreset(preset);
            e.target.value = "";
          }}
        >
          <option value="" disabled>
            Apply an audio preset…
          </option>
          {presets.filter((p) => p.kind === "audio").map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.builtin ? "" : " (custom)"}
            </option>
          ))}
        </select>
      </span>
      <p className={styles.small}>
        Background presets (Soft Blur, Solid Dark/Light, Custom Image/Video) need the background-removal
        provider, which is not configured — they stay gated and are not listed as applicable here.
      </p>
      <label className={styles.field}>
        <span>Save current form as a custom preset</span>
        <input type="text" value={presetName} maxLength={80} onChange={(e) => setPresetName(e.target.value)} placeholder="Preset name" />
      </label>
      <span className={styles.addButtons}>
        <button
          type="button"
          className={styles.miniButton}
          disabled={!presetName.trim() || busy !== null}
          onClick={() =>
            void run("preset-video", async () => {
              await phase8Api.createPreset({ name: presetName.trim(), kind: "video", settings: video as unknown as Record<string, unknown> });
              setPresetName("");
              await loadAll();
            })
          }
        >
          Save as video preset
        </button>
        <button
          type="button"
          className={styles.miniButton}
          disabled={!presetName.trim() || busy !== null}
          onClick={() =>
            void run("preset-audio", async () => {
              await phase8Api.createPreset({ name: presetName.trim(), kind: "audio", settings: audio as unknown as Record<string, unknown> });
              setPresetName("");
              await loadAll();
            })
          }
        >
          Save as audio preset
        </button>
      </span>
      {editingPreset && (
        <div className={styles.gapNotice}>
          <p className={styles.small}>
            Editing custom preset “{editingPreset.name}” ({editingPreset.kind}) — its settings are loaded
            in the form above and the name field holds its name. Adjust, then save the changes back to
            this preset (built-in presets can never be edited).
          </p>
          <span className={styles.addButtons}>
            <button
              type="button"
              className={styles.toolButton}
              disabled={busy !== null}
              onClick={() =>
                void run("preset-edit-save", async () => {
                  await phase8Api.updatePreset(editingPreset.id, {
                    name: presetName.trim() || editingPreset.name,
                    kind: editingPreset.kind,
                    settings: (editingPreset.kind === "audio" ? audio : video) as unknown as Record<string, unknown>,
                  });
                  setEditingPreset(null);
                  setPresetName("");
                  await loadAll();
                  setNotice("Custom preset updated.");
                })
              }
            >
              {busy === "preset-edit-save" ? "Saving…" : "Save changes to this preset"}
            </button>
            <button type="button" className={styles.miniButton} onClick={() => setEditingPreset(null)}>
              Cancel edit
            </button>
          </span>
        </div>
      )}
      {presets.filter((p) => !p.builtin).map((p) => (
        <div key={p.id} className={styles.assetRow}>
          <span className={styles.small}>
            {p.name} · {p.kind}
            {p.basedOn ? ` · based on ${p.basedOn.replace("builtin:", "")}` : ""}
          </span>
          <span className={styles.addButtons}>
            <button type="button" className={styles.miniButton} onClick={() => applyPreset(p)}>
              Apply
            </button>
            {p.kind !== "background" && (
              <button
                type="button"
                className={styles.miniButton}
                onClick={() => {
                  applyPreset(p);
                  setEditingPreset(p);
                  setPresetName(p.name);
                }}
              >
                Edit
              </button>
            )}
            <button
              type="button"
              className={styles.miniButton}
              onClick={() =>
                void run(`dup-${p.id}`, async () => {
                  await phase8Api.duplicatePreset(p.id);
                  await loadAll();
                })
              }
            >
              Duplicate
            </button>
            <button
              type="button"
              className={styles.miniButtonDanger}
              onClick={() =>
                void run(`delp-${p.id}`, async () => {
                  await phase8Api.deletePreset(p.id);
                  await loadAll();
                })
              }
            >
              Delete
            </button>
          </span>
        </div>
      ))}

      {/* ---------------- Per-asset jobs: preview / enhance / stabilize / upscale ---------------- */}
      <h4 className={styles.subhead}>Per-asset jobs (preview, enhance, stabilize, upscale)</h4>
      <label className={styles.field}>
        <span>Asset</span>
        <select value={effectiveRef} onChange={(e) => setAssetRef(e.target.value)}>
          {videoAssets.map((a) => (
            <option key={a.ref} value={a.ref}>
              {a.filename} ({a.category})
            </option>
          ))}
          {assets.filter((a) => a.mediaKind === "AUDIO").map((a) => (
            <option key={a.ref} value={a.ref}>
              {a.filename} (audio)
            </option>
          ))}
        </select>
      </label>
      <span className={styles.addButtons}>
        <button
          type="button"
          className={styles.miniButton}
          disabled={!effectiveRef || busy !== null}
          onClick={() =>
            void run("preview-job", async () => {
              const { job } = await phase8Api.createEnhancementJob(projectId, {
                assetRef: effectiveRef,
                video: videoForPayload(),
                preview: true,
              });
              setPreviewJob(job);
              startJob(job);
            })
          }
        >
          Before / after preview (first 4s)
        </button>
        <button
          type="button"
          className={styles.miniButton}
          disabled={!effectiveRef || busy !== null}
          onClick={() =>
            void run("asset-job", async () => {
              const jobVideo: VideoSettingsX = {
                ...videoForPayload(),
                upscale: { enabled: upscaleEnabled, width: upscaleW, height: upscaleH },
              };
              const { job } = await phase8Api.createEnhancementJob(projectId, {
                assetRef: effectiveRef,
                video: jobVideo,
                audio,
              });
              startJob(job);
              setNotice("Enhancement job queued — the result is a NEW library asset; the original is never modified.");
            })
          }
        >
          Create enhanced copy
        </button>
      </span>
      <label className={styles.checkRow}>
        <input type="checkbox" checked={stabEnabled} onChange={(e) => setStabEnabled(e.target.checked)} />
        Stabilize (vidstab two-pass: detect + transform)
      </label>
      {stabEnabled && (
        <>
          <Slider label="Stabilization strength" value={stabStrength} min={0} max={1} step={0.05} onChange={setStabStrength} />
          <Slider
            label="Crop compensation"
            hint="vidstab zoom: 0 = no zoom (borders may show) · 0.5 = optimal zoom · 1 = adaptive zoom"
            value={stabCrop}
            min={0}
            max={1}
            step={0.05}
            onChange={setStabCrop}
          />
          <Slider
            label="Smoothing"
            hint="vidstab smoothing window in frames — higher follows slower camera moves"
            value={stabSmoothing}
            min={0}
            max={100}
            step={1}
            onChange={setStabSmoothing}
          />
        </>
      )}
      <label className={styles.checkRow}>
        <input type="checkbox" checked={upscaleEnabled} onChange={(e) => setUpscaleEnabled(e.target.checked)} />
        Upscale resolution (lanczos scale only — it does NOT reconstruct detail that was not in the source)
      </label>
      <p className={styles.small}>
        {status?.providers.enhancement.capabilities.upscaleNote ?? ""} AI upscaling / detail
        reconstruction is NOT configured on this machine — the only scaling available here is
        standard (lanczos) scaling, which cannot invent detail that was not in the source.
      </p>
      {upscaleEnabled && (
        <label className={styles.field}>
          <span>Target size</span>
          <select
            value={`${upscaleW}x${upscaleH}`}
            onChange={(e) => {
              const [w, h] = e.target.value.split("x").map(Number);
              setUpscaleW(w ?? 1920);
              setUpscaleH(h ?? 1080);
            }}
          >
            <option value="1280x720">1280×720</option>
            <option value="1920x1080">1920×1080</option>
            <option value="2560x1440">2560×1440</option>
            <option value="3840x2160">3840×2160</option>
          </select>
        </label>
      )}
      {previewJob?.status === "COMPLETED" && previewJob.result.beforeUrl && previewJob.result.afterUrl ? (
        <div>
          <p className={styles.small}>
            Real FFmpeg outputs of the current form settings:{" "}
            {Array.isArray(previewJob.result.appliedVideoFilters) ? (previewJob.result.appliedVideoFilters as string[]).join(", ") || "no video filters" : ""}
          </p>
          <span className={styles.small}>Before</span>
          <video src={String(previewJob.result.beforeUrl)} controls className={styles.brollVideo} preload="metadata" />
          <span className={styles.small}>After</span>
          <video src={String(previewJob.result.afterUrl)} controls className={styles.brollVideo} preload="metadata" />
        </div>
      ) : null}
      {activeJob && activeJob.kind !== "BROLL_RECOMMENDATIONS" && (
        <p className={styles.small}>
          <JobLine job={activeJob} />
          {activeJob.status === "COMPLETED" && typeof activeJob.result.note === "string" ? (
            <span> {String(activeJob.result.note)}</span>
          ) : null}
        </p>
      )}

      {/* ---------------- Background removal (honest not-configured) ---------------- */}
      <h4 className={styles.subhead}>Background removal / replacement</h4>
      <p className={styles.muted}>
        {status?.providers.backgroundRemoval.configured
          ? "A background provider is configured."
          : `Not configured on this machine. ${status?.providers.backgroundRemoval.detail ?? ""} With no provider configured the job cannot run — it fails with CONFIGURATION_ERROR and the FAILED job is recorded below.`}
      </p>
      <label className={styles.field}>
        <span>Mode</span>
        <select value={bgMode} onChange={(e) => setBgMode(e.target.value as typeof bgMode)}>
          <option value="blur">Blur background</option>
          <option value="remove">Remove background (transparent)</option>
          <option value="solid-dark">Replace with solid dark</option>
          <option value="solid-light">Replace with solid light</option>
          <option value="custom-image">Replace with custom image</option>
          <option value="custom-video">Replace with custom video</option>
        </select>
      </label>
      <button
        type="button"
        className={styles.miniButton}
        disabled={!effectiveRef || busy !== null}
        onClick={() =>
          void run("bg-job", async () => {
            try {
              await phase8Api.startBackgroundJob(projectId, effectiveRef, bgMode);
            } finally {
              // Refresh even when the call throws (the unconfigured
              // provider answers 422): the server persisted a FAILED
              // job and it must appear in the list immediately.
              await loadAll();
            }
          })
        }
      >
        Start background job
      </button>

      {/* ---------------- Provider imports / generation ---------------- */}
      <h4 className={styles.subhead}>Stock import & AI generation</h4>
      <p className={styles.muted}>
        {status?.providers.stock.configured
          ? "Stock provider configured."
          : `Not configured. ${status?.providers.stock.detail ?? ""}`}
        <br />
        {status?.providers.generation.configured
          ? "Generation provider configured."
          : `Not configured. ${status?.providers.generation.detail ?? ""}`}{" "}
        Attempts are recorded as FAILED jobs with the exact reason — nothing is scraped and nothing is faked.
      </p>
      <label className={styles.field}>
        <span>Stock provider asset ID</span>
        <input
          type="text"
          value={stockAssetId}
          maxLength={200}
          onChange={(e) => setStockAssetId(e.target.value)}
          placeholder="Asset ID from the stock provider"
        />
      </label>
      <span className={styles.addButtons}>
        <button
          type="button"
          className={styles.miniButton}
          disabled={!stockAssetId.trim() || busy !== null}
          onClick={() =>
            void run("stock-import", async () => {
              try {
                await phase8Api.importStock(projectId, stockAssetId.trim());
              } finally {
                // Same finally-refresh as the background job: on the
                // honest 422 the server persisted a FAILED job, and
                // it must appear in the list immediately.
                await loadAll();
              }
            })
          }
        >
          Attempt stock import
        </button>
      </span>
      <label className={styles.field}>
        <span>AI generation prompt</span>
        <input
          type="text"
          value={genPrompt}
          maxLength={1000}
          onChange={(e) => setGenPrompt(e.target.value)}
          placeholder="Describe the video or image to generate"
        />
      </label>
      <span className={styles.addButtons}>
        <select
          aria-label="Generated media kind"
          value={genKind}
          onChange={(e) => setGenKind(e.target.value as "video" | "image")}
        >
          <option value="video">Video</option>
          <option value="image">Image</option>
        </select>
        <button
          type="button"
          className={styles.miniButton}
          disabled={!genPrompt.trim() || busy !== null}
          onClick={() =>
            void run("ai-generate", async () => {
              try {
                await phase8Api.generateMedia(projectId, genPrompt.trim(), genKind);
              } finally {
                await loadAll();
              }
            })
          }
        >
          Attempt AI generation
        </button>
      </span>

      {/* ---------------- Recent jobs ---------------- */}
      {jobs.length > 0 && (
        <>
          <h4 className={styles.subhead}>Recent jobs</h4>
          <div className={styles.jobList}>
            {jobs.map((job) => (
              <div key={job.id} className={styles.assetRow}>
                <JobLine job={job} />
                <span className={styles.addButtons}>
                  {(job.status === "QUEUED" || job.status === "RUNNING") && (
                    <button
                      type="button"
                      className={styles.miniButton}
                      onClick={() =>
                        void run(`cancel-${job.id}`, async () => {
                          await phase8Api.cancelJob(job.id);
                          await loadAll();
                        })
                      }
                    >
                      Cancel
                    </button>
                  )}
                  {(job.status === "FAILED" || job.status === "CANCELLED") && (
                    <button
                      type="button"
                      className={styles.miniButton}
                      onClick={() =>
                        void run(`retry-${job.id}`, async () => {
                          const { job: retried } = await phase8Api.retryJob(job.id);
                          startJob(retried);
                          await loadAll();
                        })
                      }
                    >
                      Retry
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
