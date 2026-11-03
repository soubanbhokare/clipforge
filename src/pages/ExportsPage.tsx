// Phase 9 — Export Studio: batch export, the rendering queue and
// export history.
//
// Honesty rules this page follows (mirroring the server):
//  - Progress bars render ONLY from encoder-reported progress
//    (job.progress, parsed from ffmpeg's own output). A running job
//    without progress data shows its stage, never an invented %.
//  - The file-size estimate appears only for bitrate-mode exports
//    and is labelled as an estimate (it is simple arithmetic).
//  - Pause is offered ONLY for queued jobs, with copy explaining
//    why a running render cannot be paused (cancel it instead).
//  - Preflight failures surface as FAILED jobs with the persisted
//    diagnostics visible in the job details, not as silent errors.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { projectsApi, type Project } from "../services/projects";
import {
  DEFAULT_EXPORT_SETTINGS,
  exportsApi,
  type ExportBundle,
  type ExportCapabilities,
  type ExportJob,
  type ExportPreset,
  type ExportSettings,
  type ExportTargetRef,
  type ExportTargets,
  type PreflightResult,
} from "../services/export";
import styles from "./ExportsPage.module.css";

type Tab = "new" | "queue" | "history";

const STAGE_LABELS: Record<string, string> = {
  QUEUED: "Queued",
  VALIDATING: "Validating",
  PREPARING: "Preparing assets",
  COMPOSING: "Processing video & audio",
  ENHANCING: "Applying enhancement",
  RENDERING_CAPTIONS: "Rendering captions",
  ENCODING: "Encoding",
  VERIFYING_OUTPUT: "Verifying output",
  COMPLETED: "Completed",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
  PAUSED: "Paused (held)",
};

const STATUS_FILTERS = [
  { id: "all", label: "All" },
  { id: "queued", label: "Queued" },
  { id: "paused", label: "Paused" },
  { id: "processing", label: "Processing" },
  { id: "completed", label: "Completed" },
  { id: "failed", label: "Failed" },
  { id: "cancelled", label: "Cancelled" },
] as const;

function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

function targetKey(kind: string, id?: string): string {
  return `${kind}:${id ?? "document"}`;
}

/** Fill in the value a quality mode needs when it was never edited,
 *  so the form never displays a default it would not send: CRF mode
 *  needs a CRF (23) and bitrate mode needs a video bitrate
 *  (8000 kbps). The server rejects those modes with a null value,
 *  honestly — the client must not rely on display-only fallbacks. */
function normalizeQualityDefaults(s: ExportSettings): ExportSettings {
  const next = { ...s };
  if (next.qualityMode === "crf" && next.crf === null) next.crf = 23;
  if (next.qualityMode === "bitrate" && next.videoBitrateKbps === null) next.videoBitrateKbps = 8000;
  return next;
}

/** Merge a settings patch, keeping combinations valid the same way
 *  the server validates them (WebM needs VP9 + Opus; MP3 is an
 *  audio-only codec) and normalising the quality-mode values above.
 *  Compatibility is enforced on the RESULTING combination after
 *  every patch — not only when the container itself changes — so
 *  picking H.264/H.265 or AAC while WebM is selected, or MP3 in
 *  video mode, is corrected the same way the container-change path
 *  always corrected it, and an invalid combination can never be
 *  submitted. Shared by the main settings form and the per-target
 *  override editors so they can never drift. */
function applySettingsPatch(prev: ExportSettings, partial: Partial<ExportSettings>): ExportSettings {
  const next = { ...prev, ...partial };
  if (!next.audioOnly && next.container === "webm") {
    next.videoCodec = "libvpx-vp9";
    next.audioCodec = "libopus";
  }
  if (!next.audioOnly && next.container === "mp4" && next.videoCodec === "libvpx-vp9") {
    next.videoCodec = "libx264";
    if (next.audioCodec === "libopus") next.audioCodec = "aac";
  }
  if (!next.audioOnly && next.audioCodec === "libmp3lame") {
    next.audioCodec = "aac";
  }
  return normalizeQualityDefaults(next);
}

/** The export settings form, shared between the batch-wide settings
 *  and each target's per-clip override editor (spec §7). */
function SettingsForm({
  value,
  onPatch,
  qualityPresets,
}: {
  value: ExportSettings;
  onPatch: (partial: Partial<ExportSettings>) => void;
  qualityPresets: { id: string; description: string }[];
}) {
  return (
    <>
      <div className={styles.formGrid}>
        <label className={styles.field}>
          <span>Format</span>
          <select
            value={value.audioOnly ? "audio" : value.container}
            onChange={(e) => {
              if (e.target.value === "audio") onPatch({ audioOnly: true });
              else onPatch({ audioOnly: false, container: e.target.value as "mp4" | "webm" });
            }}
          >
            <option value="mp4">MP4 (widest support)</option>
            <option value="webm">WebM (web playback)</option>
            <option value="audio">Audio only</option>
          </select>
        </label>
        {!value.audioOnly && (
          <label className={styles.field}>
            <span>Video codec</span>
            <select
              value={value.videoCodec}
              onChange={(e) => onPatch({ videoCodec: e.target.value as ExportSettings["videoCodec"] })}
            >
              <option value="libx264">H.264 — plays everywhere</option>
              <option value="libx265">H.265 / HEVC — smaller files, newer devices</option>
              <option value="libvpx-vp9">VP9 — for WebM</option>
            </select>
          </label>
        )}
        <label className={styles.field}>
          <span>Audio codec</span>
          <select
            value={value.audioCodec}
            onChange={(e) => onPatch({ audioCodec: e.target.value as ExportSettings["audioCodec"] })}
          >
            <option value="aac">AAC — standard</option>
            <option value="libopus">Opus — efficient, WebM-native</option>
            <option value="libmp3lame">MP3 — audio-only exports</option>
          </select>
        </label>
        {!value.audioOnly && (
          <>
            <label className={styles.field}>
              <span>Resolution</span>
              <select
                value={value.resolution}
                onChange={(e) => onPatch({ resolution: e.target.value as ExportSettings["resolution"] })}
              >
                <option value="original">Original (as edited)</option>
                <option value="480p">480p — small</option>
                <option value="720p">720p HD</option>
                <option value="1080p">1080p Full HD</option>
                <option value="1440p">1440p QHD</option>
                <option value="2160p">2160p 4K</option>
              </select>
            </label>
            <label className={styles.field}>
              <span>Aspect ratio</span>
              <select
                value={value.aspect}
                onChange={(e) => onPatch({ aspect: e.target.value as ExportSettings["aspect"] })}
              >
                <option value="original">Original (as edited)</option>
                <option value="9:16">9:16 — Shorts / Reels</option>
                <option value="16:9">16:9 — YouTube</option>
                <option value="1:1">1:1 — Square feed</option>
                <option value="4:5">4:5 — Portrait feed</option>
                <option value="custom">Custom size…</option>
              </select>
            </label>
            {value.aspect === "custom" && (
              <>
                <label className={styles.field}>
                  <span>Custom width (px)</span>
                  <input
                    type="number"
                    min={16}
                    max={7680}
                    step={2}
                    value={value.customWidth ?? ""}
                    onChange={(e) => onPatch({ customWidth: e.target.value === "" ? null : Number(e.target.value) })}
                  />
                </label>
                <label className={styles.field}>
                  <span>Custom height (px)</span>
                  <input
                    type="number"
                    min={16}
                    max={7680}
                    step={2}
                    value={value.customHeight ?? ""}
                    onChange={(e) => onPatch({ customHeight: e.target.value === "" ? null : Number(e.target.value) })}
                  />
                </label>
              </>
            )}
            <label className={styles.field}>
              <span>Frame rate</span>
              <select
                value={value.fps === null ? "original" : String(value.fps)}
                onChange={(e) => onPatch({ fps: e.target.value === "original" ? null : Number(e.target.value) })}
              >
                <option value="original">Original frame rate</option>
                <option value="24">24 fps — film look</option>
                <option value="25">25 fps</option>
                <option value="30">30 fps</option>
                <option value="50">50 fps</option>
                <option value="60">60 fps — smooth motion</option>
              </select>
            </label>
          </>
        )}
        <label className={styles.field}>
          <span>Quality mode</span>
          <select
            value={value.qualityMode}
            onChange={(e) => onPatch({ qualityMode: e.target.value as ExportSettings["qualityMode"] })}
          >
            <option value="preset">Preset (recommended)</option>
            <option value="crf">Constant quality (CRF)</option>
            <option value="bitrate">Target bitrate</option>
          </select>
        </label>
        {value.qualityMode === "preset" && (
          <label className={styles.field}>
            <span>Quality preset</span>
            <select
              value={value.qualityPreset}
              onChange={(e) => onPatch({ qualityPreset: e.target.value as ExportSettings["qualityPreset"] })}
            >
              <option value="low">Low</option>
              <option value="standard">Standard</option>
              <option value="high">High</option>
              <option value="maximum">Maximum</option>
            </select>
          </label>
        )}
        {value.qualityMode === "crf" && (
          <label className={styles.field}>
            <span>CRF (lower = better quality; 18–28 typical)</span>
            <input
              type="number"
              min={0}
              max={63}
              value={value.crf ?? ""}
              onChange={(e) => onPatch({ crf: Number(e.target.value) })}
            />
          </label>
        )}
        {value.qualityMode === "bitrate" && !value.audioOnly && (
          <label className={styles.field}>
            <span>Video bitrate (kbps)</span>
            <input
              type="number"
              min={100}
              max={100000}
              step={100}
              value={value.videoBitrateKbps ?? ""}
              onChange={(e) => onPatch({ videoBitrateKbps: Number(e.target.value) })}
            />
          </label>
        )}
        <label className={styles.field}>
          <span>Encoder speed</span>
          <select
            value={value.encoderPreset}
            onChange={(e) => onPatch({ encoderPreset: e.target.value as ExportSettings["encoderPreset"] })}
          >
            <option value="ultrafast">Ultrafast — fastest, larger files</option>
            <option value="superfast">Superfast</option>
            <option value="veryfast">Very fast — good default</option>
            <option value="faster">Faster</option>
            <option value="fast">Fast</option>
            <option value="medium">Medium — smaller files, slower</option>
            <option value="slow">Slow — smallest files, slowest</option>
          </select>
        </label>
        {!value.audioOnly && (
          <label className={styles.field}>
            <span>Keyframe interval (seconds, optional)</span>
            <input
              type="number"
              min={0.5}
              max={60}
              step={0.5}
              value={value.keyframeInterval ?? ""}
              placeholder="Encoder default"
              onChange={(e) => onPatch({ keyframeInterval: e.target.value === "" ? null : Number(e.target.value) })}
            />
          </label>
        )}
      </div>
      {value.qualityMode === "preset" && (
        <p className={styles.hint}>
          {qualityPresets.find((q) => q.id === value.qualityPreset)?.description ??
            "Standard balances quality and file size."}{" "}
          Upscaling never adds detail the source does not have.
        </p>
      )}

      <h3 className={styles.subhead}>Audio</h3>
      <div className={styles.checkGrid}>
        <label>
          <input type="checkbox" checked={value.includeOriginalAudio} onChange={(e) => onPatch({ includeOriginalAudio: e.target.checked })} />{" "}
          Original audio
        </label>
        <label>
          <input type="checkbox" checked={value.includeMusic} onChange={(e) => onPatch({ includeMusic: e.target.checked })} />{" "}
          Music tracks
        </label>
        <label>
          <input type="checkbox" checked={value.includeBrollAudio} onChange={(e) => onPatch({ includeBrollAudio: e.target.checked })} />{" "}
          B-roll / overlay audio
        </label>
        <label>
          <input type="checkbox" checked={value.normalizeAudio} onChange={(e) => onPatch({ normalizeAudio: e.target.checked })} />{" "}
          Normalize loudness (−16 LUFS)
        </label>
      </div>
      <div className={styles.formGrid}>
        <label className={styles.field}>
          <span>Audio bitrate</span>
          <select value={value.audioBitrateKbps} onChange={(e) => onPatch({ audioBitrateKbps: Number(e.target.value) })}>
            {[96, 128, 160, 192, 256, 320].map((b) => (
              <option key={b} value={b}>
                {b} kbps
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span>Sample rate</span>
          <select value={value.audioSampleRate} onChange={(e) => onPatch({ audioSampleRate: Number(e.target.value) as 44100 | 48000 })}>
            <option value={48000}>48 kHz (video standard)</option>
            <option value={44100}>44.1 kHz</option>
          </select>
        </label>
        <label className={styles.field}>
          <span>Channels</span>
          <select value={value.audioChannels} onChange={(e) => onPatch({ audioChannels: Number(e.target.value) as 1 | 2 })}>
            <option value={2}>Stereo</option>
            <option value={1}>Mono</option>
          </select>
        </label>
      </div>
      <p className={styles.hint}>
        Fades from the edit are preserved in every export. Ducking and volume automation live in
        the edit's enhancement settings — tick "Apply the saved enhancement configuration" below
        and they are applied with the same chain the Enhance panel uses. If a project has no usable
        audio, preflight warns you — audio is never dropped silently.
      </p>

      <h3 className={styles.subhead}>Captions, enhancement & reframing</h3>
      <div className={styles.formGrid}>
        <label className={styles.field}>
          <span>Captions</span>
          <select value={value.captionMode} onChange={(e) => onPatch({ captionMode: e.target.value as ExportSettings["captionMode"] })}>
            <option value="burn">Burn into the video</option>
            <option value="separate">Separate subtitle file(s)</option>
            <option value="bundle">Video + subtitles in one ZIP</option>
            <option value="none">No captions</option>
          </select>
        </label>
        {(value.captionMode === "separate" || value.captionMode === "bundle") && (
          <label className={styles.field}>
            <span>Subtitle format</span>
            <select value={value.captionFormat} onChange={(e) => onPatch({ captionFormat: e.target.value as ExportSettings["captionFormat"] })}>
              <option value="both">SRT + VTT</option>
              <option value="srt">SRT only</option>
              <option value="vtt">VTT only</option>
            </select>
          </label>
        )}
      </div>
      <div className={styles.checkGrid}>
        <label>
          <input type="checkbox" checked={value.includeEnhancement} onChange={(e) => onPatch({ includeEnhancement: e.target.checked })} />{" "}
          Apply the saved enhancement configuration
        </label>
        <label>
          <input type="checkbox" checked={value.includeReframe} onChange={(e) => onPatch({ includeReframe: e.target.checked })} />{" "}
          Apply the saved reframing (Face Lock / auto-reframe)
        </label>
      </div>

      <h3 className={styles.subhead}>Range & file name</h3>
      <div className={styles.formGrid}>
        <label className={styles.field}>
          <span>Export from (seconds, optional)</span>
          <input
            type="number"
            min={0}
            step={0.1}
            value={value.rangeStart ?? ""}
            placeholder="Start of timeline"
            onChange={(e) => onPatch({ rangeStart: e.target.value === "" ? null : Number(e.target.value) })}
          />
        </label>
        <label className={styles.field}>
          <span>Export until (seconds, optional)</span>
          <input
            type="number"
            min={0}
            step={0.1}
            value={value.rangeEnd ?? ""}
            placeholder="End of timeline"
            onChange={(e) => onPatch({ rangeEnd: e.target.value === "" ? null : Number(e.target.value) })}
          />
        </label>
        <label className={styles.field}>
          <span>File naming</span>
          <select value={value.namingPattern} onChange={(e) => onPatch({ namingPattern: e.target.value as ExportSettings["namingPattern"] })}>
            <option value="project-clip-resolution">Project_Clip_Resolution</option>
            <option value="project-clip-date">Project_Clip_Date</option>
            <option value="clip-aspect-format">Clip_Aspect_Format</option>
            <option value="custom">Custom template…</option>
          </select>
        </label>
        {value.namingPattern === "custom" && (
          <label className={styles.field}>
            <span>Template — tokens: {"{project} {clip} {date} {resolution} {aspect} {format}"}</span>
            <input
              value={value.customName ?? ""}
              placeholder="{project}_{clip}_{resolution}"
              onChange={(e) => onPatch({ customName: e.target.value === "" ? null : e.target.value })}
            />
          </label>
        )}
      </div>
    </>
  );
}

export default function ExportsPage({ projectId: initialProjectId }: { projectId?: string }) {
  const [tab, setTab] = useState<Tab>("new");
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string>(initialProjectId ?? "");
  const [targets, setTargets] = useState<ExportTargets | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [settings, setSettings] = useState<ExportSettings>({ ...DEFAULT_EXPORT_SETTINGS });
  // Per-target settings overrides (spec §7), keyed by targetKey().
  // An entry is a full settings snapshot initialised from the shared
  // settings when the target is first customised.
  const [overrides, setOverrides] = useState<Record<string, Partial<ExportSettings>>>({});
  const [expandedOverride, setExpandedOverride] = useState<string | null>(null);
  const [presets, setPresets] = useState<ExportPreset[]>([]);
  const [presetId, setPresetId] = useState<string>("");
  const [newPresetName, setNewPresetName] = useState("");
  const [capabilities, setCapabilities] = useState<ExportCapabilities | null>(null);
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Queue state.
  const [jobs, setJobs] = useState<ExportJob[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [sort, setSort] = useState<string>("newest");
  const [expandedJob, setExpandedJob] = useState<string | null>(null);
  const [jobDetails, setJobDetails] = useState<Record<string, { validation: { phase: string; ok: boolean; checks: { id: string; ok: boolean; level: string; detail: string }[] }[]; errors: { stage: string; message: string }[] }>>({});
  const [bundleSelection, setBundleSelection] = useState<Set<string>>(new Set());
  const [bundle, setBundle] = useState<ExportBundle | null>(null);
  const [confirmDeleteJob, setConfirmDeleteJob] = useState<string | null>(null);

  // History state.
  const [history, setHistory] = useState<Awaited<ReturnType<typeof exportsApi.history>>["outputs"]>([]);
  const [confirmDeleteOutput, setConfirmDeleteOutput] = useState<string | null>(null);
  const [historyBundleSelection, setHistoryBundleSelection] = useState<Set<string>>(new Set());
  const [historyBundle, setHistoryBundle] = useState<ExportBundle | null>(null);

  // In-app viewer: the job id whose completed output is playing
  // inline (queue and history share the one viewer state).
  const [viewingJobId, setViewingJobId] = useState<string | null>(null);

  const pollRef = useRef<number | null>(null);

  const loadProjects = useCallback(async () => {
    try {
      const res = await projectsApi.listProjects({});
      setProjects(res.projects);
      if (!initialProjectId && res.projects.length > 0) {
        setProjectId((prev) => prev || res.projects[0]!.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Projects could not be loaded.");
    }
  }, [initialProjectId]);

  const loadTargets = useCallback(async (pid: string) => {
    if (!pid) {
      setTargets(null);
      return;
    }
    try {
      const t = await exportsApi.targets(pid);
      setTargets(t);
      setSelected(new Set([targetKey("document")]));
      // Override keys carry no project component — never let one
      // project's customisations leak into another's export.
      setOverrides({});
      setExpandedOverride(null);
      setPreflight(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export targets could not be loaded.");
    }
  }, []);

  const loadPresets = useCallback(async () => {
    try {
      const res = await exportsApi.presets();
      setPresets(res.presets);
    } catch (err) {
      // Presets are optional, but a failed load must not look like
      // "you have no presets" — say so without blocking the page.
      setNotice(
        `Presets could not be loaded (${err instanceof Error ? err.message : "unknown error"}) — the preset list may be incomplete.`,
      );
    }
  }, []);

  const loadQueue = useCallback(async () => {
    try {
      const res = await exportsApi.queue({ status: statusFilter, sort });
      setJobs(res.jobs);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The queue could not be loaded.");
    }
  }, [statusFilter, sort]);

  const loadHistory = useCallback(async () => {
    try {
      const res = await exportsApi.history();
      setHistory(res.outputs);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export history could not be loaded.");
    }
  }, []);

  useEffect(() => {
    void loadProjects();
    void loadPresets();
    void exportsApi
      .capabilities()
      .then(setCapabilities)
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Export capabilities could not be loaded."),
      );
  }, [loadProjects, loadPresets]);

  useEffect(() => {
    void loadTargets(projectId);
  }, [projectId, loadTargets]);

  useEffect(() => {
    if (tab === "queue") void loadQueue();
    if (tab === "history") void loadHistory();
  }, [tab, loadQueue, loadHistory]);

  // Poll the queue while anything is active (or a bundle is zipping).
  const anyActive = jobs.some((j) => j.status === "QUEUED" || j.status === "RUNNING" || j.status === "PAUSED");
  useEffect(() => {
    if (tab !== "queue" || (!anyActive && bundle?.status !== "QUEUED" && bundle?.status !== "RUNNING")) {
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = null;
      return;
    }
    if (pollRef.current) return;
    pollRef.current = window.setInterval(() => {
      void loadQueue();
      if (bundle && (bundle.status === "QUEUED" || bundle.status === "RUNNING")) {
        void exportsApi
          .bundle(bundle.id)
          .then((r) => setBundle(r.bundle))
          .catch((err) =>
            setError(err instanceof Error ? err.message : "The bundle status could not be refreshed."),
          );
      }
    }, 2500);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [tab, anyActive, bundle, loadQueue]);

  const selectedTargets = useMemo(() => {
    if (!targets) return [];
    const list: { kind: "document" | "version" | "candidate"; id?: string }[] = [];
    if (selected.has(targetKey("document"))) list.push({ kind: "document" });
    for (const v of targets.versions) {
      if (selected.has(targetKey("version", v.id))) list.push({ kind: "version", id: v.id });
    }
    for (const c of targets.candidates) {
      if (selected.has(targetKey("candidate", c.id))) list.push({ kind: "candidate", id: c.id });
    }
    return list;
  }, [targets, selected]);

  const patch = (partial: Partial<ExportSettings>) => {
    setSettings((prev) => applySettingsPatch(prev, partial));
    setPreflight(null);
  };

  const runPreflight = async () => {
    if (!projectId || selectedTargets.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await exportsApi.preflight(projectId, {
        target: selectedTargets[0]!,
        settings,
        presetId: presetId || undefined,
      });
      setPreflight(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preflight failed.");
    } finally {
      setBusy(false);
    }
  };

  /** Human label for an export target ref, resolved from the loaded
   *  target list (falls back to the ref kind before targets load). */
  const targetLabelFor = (ref: ExportTargetRef): string => {
    if (!targets) return ref.kind;
    if (ref.kind === "document") return targets.document.label;
    const pool = ref.kind === "version" ? targets.versions : targets.candidates;
    return pool.find((t) => t.id === ref.id)?.label ?? ref.kind;
  };

  const startExport = async () => {
    if (!projectId || selectedTargets.length === 0) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      // Send per-target overrides only for selected targets whose
      // customised settings actually differ from the shared ones.
      const activeOverrides: Record<string, Partial<ExportSettings>> = {};
      for (const t of selectedTargets) {
        const key = targetKey(t.kind, t.id);
        const ov = overrides[key];
        if (ov && JSON.stringify(ov) !== JSON.stringify(settings)) activeOverrides[key] = ov;
      }
      const res = await exportsApi.create(projectId, {
        targets: selectedTargets,
        settings,
        presetId: presetId || undefined,
        overrides: Object.keys(activeOverrides).length > 0 ? activeOverrides : undefined,
      });
      const failedJobs = res.jobs.filter((j) => j.status === "FAILED");
      let message = `${res.jobs.length} export job(s) added to the queue`;
      if (failedJobs.length > 0) {
        // Name the preflight checks that failed — each created job
        // carries its own preflight result, and a bare count hides
        // why the job will never render.
        const named = failedJobs.map((j) => {
          const failedChecks = (j.preflight ?? []).filter((c) => !c.ok).map((c) => c.detail || c.id);
          const label = j.exportSettings?.targetLabel ?? "Export";
          return failedChecks.length > 0 ? `${label} — failed checks: ${failedChecks.join(", ")}` : label;
        });
        message += ` — ${failedJobs.length} failed preflight (${named.join("; ")}); see the job details in the queue.`;
      } else {
        message += ".";
      }
      if (res.errors.length > 0) {
        // The server returns a reason per unprepared target — list
        // them instead of only counting the targets.
        const reasons = res.errors.map((e) => `${targetLabelFor(e.target)}: ${e.error}`);
        message += ` ${res.errors.length} target(s) could not be prepared — ${reasons.join("; ")}.`;
      }
      setNotice(message);
      setTab("queue");
      setStatusFilter("all");
    } catch (err) {
      setError(err instanceof Error ? err.message : "The export could not be started.");
    } finally {
      setBusy(false);
    }
  };

  const applyPreset = (id: string) => {
    setPresetId(id);
    const preset = presets.find((p) => p.id === id);
    if (preset) {
      setSettings(normalizeQualityDefaults({ ...preset.settings }));
      setPreflight(null);
    }
  };

  const savePreset = async () => {
    if (!newPresetName.trim()) return;
    setBusy(true);
    try {
      const res = await exportsApi.createPreset(newPresetName.trim(), settings);
      setNewPresetName("");
      await loadPresets();
      setPresetId(res.preset.id);
      setNotice(`Preset "${res.preset.name}" saved.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The preset could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const jobAction = async (jobId: string, action: "cancel" | "pause" | "resume" | "start" | "retry" | "remove") => {
    setError(null);
    try {
      if (action === "remove") await exportsApi.remove(jobId);
      else await exportsApi[action](jobId);
      await loadQueue();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That action failed.");
    }
  };

  const toggleDetails = async (jobId: string) => {
    if (expandedJob === jobId) {
      setExpandedJob(null);
      return;
    }
    setExpandedJob(jobId);
    if (!jobDetails[jobId]) {
      try {
        const detail = await exportsApi.job(jobId);
        setJobDetails((prev) => ({
          ...prev,
          [jobId]: {
            validation: detail.validation.map((v) => ({ phase: v.phase, ok: v.ok, checks: v.checks })),
            errors: detail.errors.map((e) => ({ stage: e.stage, message: e.message })),
          },
        }));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Job details could not be loaded.");
      }
    }
  };

  const createBundle = async () => {
    if (bundleSelection.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await exportsApi.createBundle([...bundleSelection]);
      setBundle(res.bundle);
      setBundleSelection(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : "The bundle could not be created.");
    } finally {
      setBusy(false);
    }
  };

  const createHistoryBundle = async () => {
    if (historyBundleSelection.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await exportsApi.createBundleFromOutputs([...historyBundleSelection]);
      setHistoryBundle(res.bundle);
      setHistoryBundleSelection(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : "The bundle could not be created.");
    } finally {
      setBusy(false);
    }
  };

  // Poll a history bundle while it zips (same pattern as the queue).
  useEffect(() => {
    if (tab !== "history" || !historyBundle || (historyBundle.status !== "QUEUED" && historyBundle.status !== "RUNNING")) {
      return;
    }
    const t = window.setInterval(() => {
      void exportsApi
        .bundle(historyBundle.id)
        .then((r) => setHistoryBundle(r.bundle))
        .catch((err) =>
          setError(err instanceof Error ? err.message : "The bundle status could not be refreshed."),
        );
    }, 2500);
    return () => window.clearInterval(t);
  }, [tab, historyBundle]);

  const exportAgain = (job: ExportJob) => {
    if (job.exportSettings) {
      const { outputName: _o, targetLabel: _t, ...rest } = job.exportSettings;
      setSettings({ ...DEFAULT_EXPORT_SETTINGS, ...rest });
    }
    if (job.projectId) setProjectId(job.projectId);
    setTab("new");
    setNotice("Settings loaded from that export — adjust anything and start a new export.");
  };

  const qualityDescriptions = capabilities?.qualityPresets ?? [];

  const toggleCustomize = (key: string) => {
    // First customisation snapshots the shared settings as this
    // target's starting point; later edits build on the snapshot.
    setOverrides((prev) => (prev[key] !== undefined ? prev : { ...prev, [key]: { ...settings } }));
    setExpandedOverride((prev) => (prev === key ? null : key));
  };

  const resetOverride = (key: string) => {
    setOverrides((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setExpandedOverride((prev) => (prev === key ? null : prev));
  };

  const patchOverride = (key: string, partial: Partial<ExportSettings>) => {
    setOverrides((prev) => {
      const current: ExportSettings = { ...settings, ...(prev[key] ?? {}) };
      return { ...prev, [key]: applySettingsPatch(current, partial) };
    });
    setPreflight(null);
  };

  /** Customize toggle, "Custom settings" badge, reset action and the
   *  expanded per-target settings editor for one target row. */
  const targetCustomisation = (key: string) => {
    if (!selected.has(key)) return null;
    const hasOverride =
      overrides[key] !== undefined && JSON.stringify(overrides[key]) !== JSON.stringify(settings);
    const effective: ExportSettings = { ...settings, ...(overrides[key] ?? {}) };
    return (
      <>
        <div className={styles.jobActions}>
          <button type="button" className={styles.smallButton} onClick={() => toggleCustomize(key)}>
            {expandedOverride === key ? "Hide custom settings" : "Customize"}
          </button>
          {hasOverride && <span className={styles.statusPill}>Custom settings</span>}
          {hasOverride && (
            <button type="button" className={styles.smallButton} onClick={() => resetOverride(key)}>
              Reset to shared settings
            </button>
          )}
        </div>
        {expandedOverride === key && (
          <div className={styles.details}>
            <SettingsForm
              value={effective}
              onPatch={(partial) => patchOverride(key, partial)}
              qualityPresets={qualityDescriptions}
            />
          </div>
        )}
      </>
    );
  };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <nav className={styles.tabs} aria-label="Export Studio sections">
          <button type="button" className={tab === "new" ? styles.tabActive : styles.tab} onClick={() => setTab("new")}>
            New Export
          </button>
          <button type="button" className={tab === "queue" ? styles.tabActive : styles.tab} onClick={() => setTab("queue")}>
            Rendering Queue
          </button>
          <button type="button" className={tab === "history" ? styles.tabActive : styles.tab} onClick={() => setTab("history")}>
            History
          </button>
        </nav>
      </header>

      {error && (
        <p className={styles.errorBanner} role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className={styles.noticeBanner} role="status">
          {notice}
        </p>
      )}

      {tab === "new" && (
        <div className={styles.newGrid}>
          <section className={styles.card} aria-label="What to export">
            <h2>1 · What to export</h2>
            <label className={styles.field}>
              <span>Project</span>
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            {targets && (
              <ul className={styles.targetList}>
                <li>
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.has(targetKey("document"))}
                      onChange={(e) =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(targetKey("document"));
                          else next.delete(targetKey("document"));
                          return next;
                        })
                      }
                    />{" "}
                    <strong>Edited project</strong>{" "}
                    <span className={styles.muted}>
                      full timeline · {targets.document.duration.toFixed(1)}s · {targets.document.canvas.width}×
                      {targets.document.canvas.height}
                    </span>
                  </label>
                  {targetCustomisation(targetKey("document"))}
                </li>
                {targets.versions.map((v) => (
                  <li key={v.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={selected.has(targetKey("version", v.id))}
                        onChange={(e) =>
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(targetKey("version", v.id));
                            else next.delete(targetKey("version", v.id));
                            return next;
                          })
                        }
                      />{" "}
                      <strong>{v.label}</strong> <span className={styles.muted}>saved version · {formatWhen(v.createdAt)}</span>
                    </label>
                    {targetCustomisation(targetKey("version", v.id))}
                  </li>
                ))}
                {targets.candidates.map((c) => (
                  <li key={c.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={selected.has(targetKey("candidate", c.id))}
                        onChange={(e) =>
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(targetKey("candidate", c.id));
                            else next.delete(targetKey("candidate", c.id));
                            return next;
                          })
                        }
                      />{" "}
                      <strong>{c.label}</strong>{" "}
                      <span className={styles.muted}>
                        generated clip · {c.duration.toFixed(1)}s · score {c.score}
                      </span>
                    </label>
                    {targetCustomisation(targetKey("candidate", c.id))}
                  </li>
                ))}
              </ul>
            )}
            <p className={styles.hint}>
              Batch export: tick several items — each one exports from its own saved editing state,
              never from the raw source twice. Use Customize on a selected item to give it its own
              export settings instead of the shared ones below.
            </p>
          </section>

          <section className={styles.card} aria-label="Export settings">
            <h2>2 · Settings</h2>
            <div className={styles.presetRow}>
              <label className={styles.field}>
                <span>Preset</span>
                <select value={presetId} onChange={(e) => applyPreset(e.target.value)}>
                  <option value="">Custom settings</option>
                  {presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.builtin ? " (built-in)" : ""}
                    </option>
                  ))}
                </select>
              </label>
              {presetId && (
                <>
                  <button
                    type="button"
                    className={styles.smallButton}
                    onClick={() =>
                      void exportsApi
                        .duplicatePreset(presetId)
                        .then(() => loadPresets())
                        .catch((err) => setError(err instanceof Error ? err.message : "The preset could not be duplicated."))
                    }
                  >
                    Duplicate
                  </button>
                  {!presets.find((p) => p.id === presetId)?.builtin && (
                    <button
                      type="button"
                      className={styles.smallButton}
                      onClick={() =>
                        void exportsApi
                          .deletePreset(presetId)
                          .then(() => {
                            setPresetId("");
                            void loadPresets();
                          })
                          .catch((err) => setError(err instanceof Error ? err.message : "The preset could not be deleted."))
                      }
                    >
                      Delete preset
                    </button>
                  )}
                </>
              )}
            </div>
            <div className={styles.presetRow}>
              <label className={styles.field}>
                <span>Save current settings as a preset</span>
                <input
                  value={newPresetName}
                  onChange={(e) => setNewPresetName(e.target.value)}
                  placeholder="Preset name"
                />
              </label>
              <button type="button" className={styles.smallButton} disabled={busy || !newPresetName.trim()} onClick={() => void savePreset()}>
                Save preset
              </button>
            </div>

            <SettingsForm value={settings} onPatch={patch} qualityPresets={qualityDescriptions} />
          </section>

          <section className={styles.card} aria-label="Review and start">
            <h2>3 · Review & start</h2>
            <button type="button" className={styles.secondaryButton} disabled={busy || selectedTargets.length === 0} onClick={() => void runPreflight()}>
              Run preflight check
            </button>
            {preflight && (
              <div className={styles.preflight}>
                {preflight.summary && (
                  <dl className={styles.summaryList}>
                    <div><dt>File name</dt><dd>{preflight.summary.outputName}</dd></div>
                    <div><dt>Target</dt><dd>{preflight.summary.targetLabel}</dd></div>
                    <div><dt>Duration</dt><dd>{preflight.summary.durationSec}s</dd></div>
                    <div><dt>Resolution</dt><dd>{preflight.summary.width}×{preflight.summary.height} ({preflight.summary.aspect})</dd></div>
                    <div><dt>Frame rate</dt><dd>{preflight.summary.fps ? `${preflight.summary.fps} fps` : "Original"}</dd></div>
                    <div><dt>Codecs</dt><dd>{preflight.summary.videoCodec ?? "audio only"} / {preflight.summary.audioCodec} · {preflight.summary.container.toUpperCase()}</dd></div>
                    <div><dt>Captions</dt><dd>{preflight.summary.captionMode} ({preflight.summary.captionCount} cues)</dd></div>
                    <div><dt>Enhancement</dt><dd>{preflight.summary.includeEnhancement ? "Applied" : "Not applied"}</dd></div>
                    <div><dt>Reframing</dt><dd>{preflight.summary.includeReframe ? "Applied" : "Not applied"}</dd></div>
                    {preflight.summary.estimatedSizeBytes !== null && (
                      <div>
                        <dt>Estimated size</dt>
                        <dd>
                          ≈ {formatBytes(preflight.summary.estimatedSizeBytes)}{" "}
                          <span className={styles.muted}>(estimate — {preflight.summary.estimateNote})</span>
                        </dd>
                      </div>
                    )}
                  </dl>
                )}
                <ul className={styles.checkList}>
                  {preflight.checks.map((c) => (
                    <li key={c.id} className={c.ok ? styles.checkOk : c.level === "warning" ? styles.checkWarn : styles.checkBad}>
                      {c.ok ? "✓" : c.level === "warning" ? "!" : "✗"} {c.detail}
                    </li>
                  ))}
                </ul>
                <p className={styles.hint}>Preflight above covers the first selected target; every target is checked again when its job is created.</p>
              </div>
            )}
            <button
              type="button"
              className={styles.primaryButton}
              disabled={busy || selectedTargets.length === 0}
              onClick={() => void startExport()}
            >
              {busy ? "Working…" : `Start export (${selectedTargets.length} selected)`}
            </button>
            <p className={styles.hint}>
              Exports render one at a time in the background. A target that fails preflight becomes a
              failed job with the reasons saved — it never starts rendering.
            </p>
          </section>
        </div>
      )}

      {tab === "queue" && (
        <section aria-label="Rendering queue">
          <div className={styles.queueToolbar}>
            <div className={styles.filterRow} role="group" aria-label="Filter by status">
              {STATUS_FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className={statusFilter === f.id ? styles.chipActive : styles.chip}
                  onClick={() => setStatusFilter(f.id)}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <label className={styles.fieldInline}>
              <span>Sort</span>
              <select value={sort} onChange={(e) => setSort(e.target.value)}>
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
                <option value="position">Queue position</option>
                <option value="project">Project</option>
                <option value="status">Status</option>
              </select>
            </label>
            <button type="button" className={styles.smallButton} onClick={() => void loadQueue()}>
              Refresh
            </button>
          </div>

          {bundleSelection.size > 0 && (
            <div className={styles.bundleBar}>
              <span>{bundleSelection.size} completed export(s) selected for a ZIP bundle.</span>
              <button type="button" className={styles.smallButton} disabled={busy} onClick={() => void createBundle()}>
                Create ZIP bundle
              </button>
              <button type="button" className={styles.smallButton} onClick={() => setBundleSelection(new Set())}>
                Clear
              </button>
            </div>
          )}
          {bundle && (
            <div className={styles.bundleBar} role="status">
              <span>
                Bundle: {bundle.status}
                {bundle.error ? ` — ${bundle.error}` : ""}
              </span>
              {bundle.status === "COMPLETED" && (
                <a className={styles.smallButton} href={exportsApi.bundleDownloadUrl(bundle.id)}>
                  Download ZIP
                </a>
              )}
            </div>
          )}

          {jobs.length === 0 && <p className={styles.muted}>No export jobs match this filter yet.</p>}
          <ul className={styles.jobList}>
            {jobs.map((job) => (
              <li key={job.id} className={styles.jobCard}>
                {job.output?.thumbnailUrl ? (
                  <img
                    src={exportsApi.thumbnailUrl(job.id)}
                    alt={`Poster frame of ${job.outputName ?? "the export"}`}
                    loading="lazy"
                    style={{ width: 160, height: 90, objectFit: "cover", borderRadius: 6, display: "block", marginBottom: "var(--space-2)" }}
                  />
                ) : (
                  <div
                    aria-hidden="true"
                    style={{ width: 160, height: 90, borderRadius: 6, marginBottom: "var(--space-2)", background: "var(--surface-2, #10131a)", border: "1px dashed var(--border, #2a2f3a)" }}
                  />
                )}
                <div className={styles.jobHead}>
                  <strong>{job.outputName ?? job.exportSettings?.targetLabel ?? "Export"}</strong>
                  <span className={`${styles.statusPill} ${styles[`status_${job.status}`] ?? ""}`}>
                    {job.status === "PAUSED" ? "PAUSED (held)" : job.status}
                  </span>
                </div>
                <p className={styles.jobMeta}>
                  {job.exportSettings?.targetLabel ?? "Export"} ·{" "}
                  {job.output
                    ? `${job.output.width ?? "?"}×${job.output.height ?? "?"} · ${job.output.format.toUpperCase()}`
                    : job.settings.canvas
                      ? `${job.settings.canvas.width}×${job.settings.canvas.height}`
                      : "—"}{" "}
                  · {job.settings.timelineDuration ? `${job.settings.timelineDuration.toFixed(1)}s` : "—"}
                  {job.queuePosition !== null && <> · Queue position {job.queuePosition}</>}
                  {job.output?.fileSize != null && <> · {formatBytes(job.output.fileSize)}</>}
                </p>
                <p className={styles.jobMeta}>
                  Stage: {STAGE_LABELS[job.stage] ?? job.stage}
                  {job.retryCount > 0 && <> · Retried {job.retryCount}×</>}
                  {job.priority !== 0 && <> · Priority {job.priority}</>}
                  {job.workerId && <> · Worker {job.workerId}</>}
                </p>
                {job.status === "RUNNING" &&
                  (job.progress?.percent != null ? (
                    <div className={styles.progressTrack} role="progressbar" aria-valuenow={Math.round(job.progress.percent)} aria-valuemin={0} aria-valuemax={100}>
                      <div className={styles.progressFill} style={{ width: `${Math.min(100, job.progress.percent).toFixed(1)}%` }} />
                      <span className={styles.progressLabel}>
                        {job.progress.percent.toFixed(0)}% · {job.progress.outTimeSec.toFixed(1)}s of{" "}
                        {job.progress.expectedSec.toFixed(1)}s
                        {job.progress.frame != null && job.progress.expectedFrames != null && (
                          <> · frame {job.progress.frame.toLocaleString()} / ~{job.progress.expectedFrames.toLocaleString()}</>
                        )}
                        {job.progress.speed != null && <> · {job.progress.speed}× speed</>}
                        {job.progress.elapsedSec != null && <> · {job.progress.elapsedSec.toFixed(0)}s elapsed</>}
                      </span>
                    </div>
                  ) : (
                    <p className={styles.muted}>Encoding — progress appears here as soon as the encoder reports it.</p>
                  ))}
                <p className={styles.jobTimes}>
                  Created {formatWhen(job.createdAt)}
                  {job.startedAt && <> · Started {formatWhen(job.startedAt)}</>}
                  {job.finishedAt && <> · Finished {formatWhen(job.finishedAt)}</>}
                </p>
                {job.error && (
                  <p className={styles.jobError} role="alert">
                    {job.error}
                  </p>
                )}
                <div className={styles.jobActions}>
                  {job.status === "QUEUED" && (
                    <>
                      <button type="button" className={styles.smallButton} onClick={() => void jobAction(job.id, "pause")}>
                        Pause (hold)
                      </button>
                      <button type="button" className={styles.smallButton} onClick={() => void jobAction(job.id, "start")}>
                        Start now
                      </button>
                      <button
                        type="button"
                        className={styles.smallButton}
                        onClick={() =>
                          void exportsApi
                            .setPriority(job.id, job.priority + 1)
                            .then(() => loadQueue())
                            .catch((err) => setError(err instanceof Error ? err.message : "The priority could not be changed."))
                        }
                      >
                        Priority +
                      </button>
                      <button
                        type="button"
                        className={styles.smallButton}
                        onClick={() =>
                          void exportsApi
                            .setPriority(job.id, job.priority - 1)
                            .then(() => loadQueue())
                            .catch((err) => setError(err instanceof Error ? err.message : "The priority could not be changed."))
                        }
                      >
                        Priority −
                      </button>
                    </>
                  )}
                  {job.status === "PAUSED" && (
                    <>
                      <button type="button" className={styles.smallButton} onClick={() => void jobAction(job.id, "start")}>
                        Start now
                      </button>
                      <button type="button" className={styles.smallButton} onClick={() => void jobAction(job.id, "resume")}>
                        Resume
                      </button>
                    </>
                  )}
                  {(job.status === "QUEUED" || job.status === "PAUSED" || job.status === "RUNNING") && (
                    <button type="button" className={styles.smallButton} onClick={() => void jobAction(job.id, "cancel")}>
                      Cancel
                    </button>
                  )}
                  {(job.status === "FAILED" || job.status === "CANCELLED") && (
                    <button type="button" className={styles.smallButton} onClick={() => void jobAction(job.id, "retry")}>
                      Retry
                    </button>
                  )}
                  <button type="button" className={styles.smallButton} onClick={() => void toggleDetails(job.id)}>
                    {expandedJob === job.id ? "Hide details" : "Details"}
                  </button>
                  <button type="button" className={styles.smallButton} onClick={() => exportAgain(job)}>
                    Export again
                  </button>
                  {job.status === "COMPLETED" && (
                    <>
                      <button
                        type="button"
                        className={styles.smallButton}
                        onClick={() => setViewingJobId((prev) => (prev === job.id ? null : job.id))}
                      >
                        {viewingJobId === job.id ? "Close viewer" : "Open"}
                      </button>
                      <a className={styles.smallButton} href={exportsApi.downloadUrl(job.id, "video")}>
                        Download
                      </a>
                      {job.exportSettings && (job.exportSettings.captionMode === "separate" || job.exportSettings.captionMode === "bundle") && (
                        <>
                          {(job.exportSettings.captionFormat === "srt" || job.exportSettings.captionFormat === "both") && (
                            <a className={styles.smallButton} href={exportsApi.downloadUrl(job.id, "srt")}>
                              SRT
                            </a>
                          )}
                          {(job.exportSettings.captionFormat === "vtt" || job.exportSettings.captionFormat === "both") && (
                            <a className={styles.smallButton} href={exportsApi.downloadUrl(job.id, "vtt")}>
                              VTT
                            </a>
                          )}
                        </>
                      )}
                      {job.exportSettings?.captionMode === "bundle" && (
                        <a className={styles.smallButton} href={exportsApi.downloadUrl(job.id, "zip")}>
                          ZIP bundle
                        </a>
                      )}
                      <label className={styles.bundleCheck}>
                        <input
                          type="checkbox"
                          checked={bundleSelection.has(job.id)}
                          onChange={(e) =>
                            setBundleSelection((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(job.id);
                              else next.delete(job.id);
                              return next;
                            })
                          }
                        />{" "}
                        Bundle
                      </label>
                    </>
                  )}
                  {job.status !== "RUNNING" &&
                    (confirmDeleteJob === job.id ? (
                      <>
                        <span className={styles.muted}>Delete this job and its exported file?</span>
                        <button
                          type="button"
                          className={styles.smallButtonDanger}
                          onClick={() => {
                            setConfirmDeleteJob(null);
                            void jobAction(job.id, "remove");
                          }}
                        >
                          Confirm delete
                        </button>
                        <button type="button" className={styles.smallButton} onClick={() => setConfirmDeleteJob(null)}>
                          Keep
                        </button>
                      </>
                    ) : (
                      <button type="button" className={styles.smallButton} onClick={() => setConfirmDeleteJob(job.id)}>
                        Remove
                      </button>
                    ))}
                </div>
                {viewingJobId === job.id && job.status === "COMPLETED" && (
                  <div style={{ marginTop: "var(--space-3)" }}>
                    <video
                      controls
                      preload="metadata"
                      src={exportsApi.inlineUrl(job.id)}
                      style={{ width: "100%", maxWidth: 640, borderRadius: 8, display: "block", background: "#000" }}
                      aria-label={`Player for ${job.outputName ?? "export"}`}
                    />
                  </div>
                )}
                {job.status === "QUEUED" && (
                  <p className={styles.hint}>
                    Pause holds a queued job so the renderer skips it. A running render cannot be paused
                    safely — cancel it instead.
                  </p>
                )}
                {expandedJob === job.id && jobDetails[job.id] && (
                  <div className={styles.details}>
                    {jobDetails[job.id]!.validation.map((v, i) => (
                      <div key={i}>
                        <strong>
                          {v.phase === "PREFLIGHT" ? "Preflight" : "Post-render quality check"} — {v.ok ? "passed" : "FAILED"}
                        </strong>
                        <ul className={styles.checkList}>
                          {v.checks.map((c) => (
                            <li key={c.id} className={c.ok ? styles.checkOk : c.level === "warning" ? styles.checkWarn : styles.checkBad}>
                              {c.ok ? "✓" : c.level === "warning" ? "!" : "✗"} {c.detail}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                    {jobDetails[job.id]!.errors.length > 0 && (
                      <div>
                        <strong>Error log</strong>
                        <ul className={styles.checkList}>
                          {jobDetails[job.id]!.errors.map((e, i) => (
                            <li key={i} className={styles.checkBad}>
                              [{e.stage}] {e.message}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {tab === "history" && (
        <section aria-label="Export history">
          {history.length === 0 && <p className={styles.muted}>No exports yet — finished exports will be recorded here.</p>}
          {historyBundleSelection.size > 0 && (
            <div className={styles.bundleBar}>
              <span>{historyBundleSelection.size} completed export(s) selected for a ZIP bundle.</span>
              <button type="button" className={styles.smallButton} disabled={busy} onClick={() => void createHistoryBundle()}>
                Create ZIP bundle
              </button>
              <button type="button" className={styles.smallButton} onClick={() => setHistoryBundleSelection(new Set())}>
                Clear
              </button>
            </div>
          )}
          {historyBundle && (
            <div className={styles.bundleBar} role="status">
              <span>
                Bundle: {historyBundle.status}
                {historyBundle.error ? ` — ${historyBundle.error}` : ""}
              </span>
              {historyBundle.status === "COMPLETED" && (
                <a className={styles.smallButton} href={exportsApi.bundleDownloadUrl(historyBundle.id)}>
                  Download bundle
                </a>
              )}
            </div>
          )}
          <ul className={styles.jobList}>
            {history.map((entry) => (
              <li key={entry.id} className={styles.jobCard}>
                {entry.thumbnailUrl ? (
                  <img
                    src={exportsApi.thumbnailUrl(entry.jobId)}
                    alt={`Poster frame of ${entry.filename}`}
                    loading="lazy"
                    style={{ width: 160, height: 90, objectFit: "cover", borderRadius: 6, display: "block", marginBottom: "var(--space-2)" }}
                  />
                ) : (
                  <div
                    aria-hidden="true"
                    style={{ width: 160, height: 90, borderRadius: 6, marginBottom: "var(--space-2)", background: "var(--surface-2, #10131a)", border: "1px dashed var(--border, #2a2f3a)" }}
                  />
                )}
                <div className={styles.jobHead}>
                  <strong>{entry.filename}</strong>
                  <span className={`${styles.statusPill} ${styles[`status_${entry.status}`] ?? ""}`}>{entry.status}</span>
                </div>
                <p className={styles.jobMeta}>
                  {entry.targetLabel} · {entry.projectName ?? ""} · {entry.format.toUpperCase()}
                  {entry.width ? ` · ${entry.width}×${entry.height}` : ""}
                  {entry.duration ? ` · ${entry.duration.toFixed(1)}s` : ""} · {formatBytes(entry.fileSize)} ·{" "}
                  {formatWhen(entry.createdAt)}
                </p>
                {entry.failureReason && <p className={styles.jobError}>{entry.failureReason}</p>}
                <div className={styles.jobActions}>
                  {entry.status === "COMPLETED" && (
                    <>
                      <button
                        type="button"
                        className={styles.smallButton}
                        onClick={() => setViewingJobId((prev) => (prev === entry.jobId ? null : entry.jobId))}
                      >
                        {viewingJobId === entry.jobId ? "Close viewer" : "Open"}
                      </button>
                      <a className={styles.smallButton} href={exportsApi.downloadUrl(entry.jobId, "video")}>
                        Download
                      </a>
                      <label className={styles.bundleCheck}>
                        <input
                          type="checkbox"
                          checked={historyBundleSelection.has(entry.id)}
                          onChange={(e) =>
                            setHistoryBundleSelection((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(entry.id);
                              else next.delete(entry.id);
                              return next;
                            })
                          }
                        />{" "}
                        Bundle
                      </label>
                    </>
                  )}
                  <a className={styles.smallButton} href={`#/app/projects/${entry.projectId}/editor`}>
                    Open project
                  </a>
                  {confirmDeleteOutput === entry.id ? (
                    <>
                      <span className={styles.muted}>Delete this exported file? The project and its source stay untouched.</span>
                      <button
                        type="button"
                        className={styles.smallButtonDanger}
                        onClick={() => {
                          setConfirmDeleteOutput(null);
                          void exportsApi
                            .deleteHistory(entry.id)
                            .then(() => loadHistory())
                            .catch((err) => setError(err instanceof Error ? err.message : "The exported file could not be deleted."));
                        }}
                      >
                        Confirm delete
                      </button>
                      <button type="button" className={styles.smallButton} onClick={() => setConfirmDeleteOutput(null)}>
                        Keep
                      </button>
                    </>
                  ) : (
                    <button type="button" className={styles.smallButton} onClick={() => setConfirmDeleteOutput(entry.id)}>
                      Delete
                    </button>
                  )}
                </div>
                {viewingJobId === entry.jobId && entry.status === "COMPLETED" && (
                  <div style={{ marginTop: "var(--space-3)" }}>
                    <video
                      controls
                      preload="metadata"
                      src={exportsApi.inlineUrl(entry.jobId)}
                      style={{ width: "100%", maxWidth: 640, borderRadius: 8, display: "block", background: "#000" }}
                      aria-label={`Player for ${entry.filename}`}
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
