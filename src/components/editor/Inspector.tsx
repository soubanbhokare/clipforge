// Phase 5 — contextual inspector (right panel). Sections:
//  - Clip: numeric trim/crop/position/scale/zoom/rotation/speed/
//    volume/fades for the selected timeline item + split, duplicate,
//    merge, delete, reset. All edits are server operations.
//  - Caption: text + timing for the selected caption.
//  - Captions Studio (Phase 6): templates, appearance, word-level
//    editing, tracks/languages, subtitle import/export, brand kits.
//  - Scenes: Phase 4 topic segments with per-scene transform
//    overrides (one / multiple / all scenes, reset).
//  - Canvas: aspect presets + custom size + background fill.
//  - Versions: named snapshots, restore.
//  - Export: real render jobs with live stage + download.

import { useEffect, useState } from "react";
import {
  DEFAULT_TRANSFORM,
  RENDER_ACTIVE,
  assetInfo,
  editorApi,
  formatClock,
  type EditorCanvas,
  type EditorDocument,
  type EditorLibrary,
  type ItemTransform,
  type ProjectVersion,
  type RenderJob,
  type SceneOverride,
} from "../../services/editor";
import type { EditorSelection } from "./Timeline";
import { CaptionStudio } from "./CaptionStudio";
import { ReframePanel } from "./ReframePanel";
import { EnhancePanel } from "./EnhancePanel";
import styles from "../../pages/studio/Editor.module.css";

interface Props {
  doc: EditorDocument;
  projectId: string;
  library: EditorLibrary;
  selection: EditorSelection;
  /** Phase 6: server-driven document replacements (regenerate /
   *  track activation) that are not regular operations. */
  onReplaceDocument: (doc: EditorDocument) => void;
  playhead: number;
  onSeek: (t: number) => void;
  onSelect: (sel: EditorSelection) => void;
  onCommit: (type: string, mutate: (state: EditorDocument) => void) => void;
  onPatchSettings: (patch: { canvas?: EditorCanvas; settings?: Partial<EditorDocument["settings"]> }) => void;
  versions: ProjectVersion[];
  onCreateVersion: (name: string) => void;
  onRestoreVersion: (id: string) => void;
  renders: RenderJob[];
  onStartRender: () => void;
  onCancelRender: (jobId: string) => void;
}

function NumField({
  label,
  value,
  step = 0.1,
  min,
  max,
  disabled,
  onCommit,
}: {
  label: string;
  value: number;
  step?: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(Math.round(value * 1000) / 1000);
  return (
    <div className={styles.field}>
      <label>{label}</label>
      <input
        type="number"
        step={step}
        min={min}
        max={max}
        disabled={disabled}
        value={shown}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== null) {
            const parsed = Number(draft);
            if (Number.isFinite(parsed)) onCommit(parsed);
          }
          setDraft(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
    </div>
  );
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

const CANVAS_PRESETS: { label: string; canvas: EditorCanvas }[] = [
  { label: "9:16 Vertical", canvas: { aspect: "9:16", width: 1080, height: 1920, custom: false } },
  { label: "16:9 Wide", canvas: { aspect: "16:9", width: 1920, height: 1080, custom: false } },
  { label: "1:1 Square", canvas: { aspect: "1:1", width: 1080, height: 1080, custom: false } },
  { label: "4:5 Portrait", canvas: { aspect: "4:5", width: 1080, height: 1350, custom: false } },
];

export default function Inspector({
  doc,
  projectId,
  onReplaceDocument,
  library,
  selection,
  playhead,
  onSeek,
  onSelect,
  onCommit,
  onPatchSettings,
  versions,
  onCreateVersion,
  onRestoreVersion,
  renders,
  onStartRender,
  onCancelRender,
}: Props) {
  const [versionName, setVersionName] = useState("");
  // Phase 7 fix: visible note when a caption start/end edit was
  // clamped to keep the minimum 0.1 s cue length (see Caption section).
  const [captionTimingHint, setCaptionTimingHint] = useState<string | null>(null);
  const [seekNote, setSeekNote] = useState<string | null>(null);
  const [sceneSelection, setSceneSelection] = useState<Set<string>>(new Set());
  const [sceneDraft, setSceneDraft] = useState<{
    zoom: number;
    x: number;
    y: number;
    scale: number;
    rotation: number;
    fit: "fit" | "fill";
    useCrop: boolean;
    cropX: number;
    cropY: number;
    cropW: number;
    cropH: number;
    // Source-time range the override covers. Only editable when a
    // single scene is selected (each scene owns its range); synced
    // from that scene's existing override / full range below.
    rangeStart: number;
    rangeEnd: number;
  }>({
    zoom: 1,
    x: 0,
    y: 0,
    scale: 1,
    rotation: 0,
    fit: "fill",
    useCrop: false,
    cropX: 0,
    cropY: 0,
    cropW: 1,
    cropH: 1,
    rangeStart: 0,
    rangeEnd: 0,
  });

  const item = selection?.kind === "item" ? doc.items.find((i) => i.id === selection.id) : undefined;
  const caption = selection?.kind === "caption" ? doc.captions.find((c) => c.id === selection.id) : undefined;
  // Whether the selected caption has a following caption to merge
  // into — gates the "Merge with next" button so it is never a
  // silent no-op on the last caption.
  const sortedCaptions = [...doc.captions].sort((a, b) => a.start - b.start);
  const selectedCaptionIdx = caption ? sortedCaptions.findIndex((c) => c.id === caption.id) : -1;
  const hasNextCaption = selectedCaptionIdx >= 0 && selectedCaptionIdx < sortedCaptions.length - 1;
  const itemTrack = item ? doc.tracks.find((t) => t.id === item.trackId) : undefined;
  const itemInfo = item ? assetInfo(item, library) : null;
  const trackLocked = itemTrack?.locked ?? false;

  useEffect(() => {
    setSceneSelection(new Set());
  }, [doc.id]);

  // The clamp hint belongs to one caption's edit — clear it when the
  // selection moves to another caption.
  useEffect(() => {
    setCaptionTimingHint(null);
  }, [caption?.id]);

  const patchItem = (patch: Partial<import("../../services/editor").TimelineItem>, type = "update_item") => {
    if (!item || trackLocked) return; // locked tracks cannot be edited
    onCommit(type, (state) => {
      const target = state.items.find((i) => i.id === item.id);
      if (target) Object.assign(target, patch);
    });
  };

  const patchTransform = (patch: Partial<ItemTransform>) => {
    if (!item || trackLocked) return; // locked tracks cannot be edited
    onCommit("update_item", (state) => {
      const target = state.items.find((i) => i.id === item.id);
      if (target) target.transform = { ...target.transform, ...patch };
    });
  };

  // ---- Merge-with-next gating: only a truly mergeable neighbour may
  // merge — same track, directly adjacent (no gap), same asset, same
  // speed, track unlocked. Anything else would silently corrupt the
  // item's source window, so the control stays disabled with a reason.
  const trackItemsSorted = item
    ? doc.items.filter((i) => i.trackId === item.trackId).sort((a, b) => a.start - b.start)
    : [];
  const itemIndex = item ? trackItemsSorted.findIndex((i) => i.id === item.id) : -1;
  const nextItem = itemIndex >= 0 ? trackItemsSorted[itemIndex + 1] : undefined;
  const mergeBlockReason: string | null = !item
    ? null
    : trackLocked
      ? "This track is locked — unlock it to merge."
      : !nextItem
        ? "There is no next clip on this track."
        : Math.abs(item.start + item.duration - nextItem.start) > 0.01
          ? "The next clip is not directly adjacent (there is a gap or overlap)."
          : nextItem.assetKind !== item.assetKind || nextItem.assetId !== item.assetId
            ? "The next clip uses a different asset."
            : Math.abs(nextItem.speed - item.speed) > 0.001
              ? "The next clip has a different speed."
              : null;

  // ---- Reset item: back to the item's original state — default
  // transform, speed/volume 1, no fades, and the full original source
  // window when it can be resolved from the library (whole source /
  // media asset, or the candidate's full window startSec–endSec;
  // item source times are source-asset times). Duration is recomputed
  // for the restored window at speed 1. If the window cannot be
  // resolved, trim is left unchanged and duration is still recomputed
  // for speed 1 from the existing window.
  const resetItem = () => {
    if (!item || trackLocked) return;
    let window: { sourceIn: number; sourceOut: number } | null = null;
    if (item.assetKind === "candidate") {
      const candidate = library.candidates.find((c) => c.id === item.assetId);
      if (candidate) window = { sourceIn: candidate.startSec, sourceOut: candidate.endSec };
    } else if (itemInfo && itemInfo.sourceDuration !== null && itemInfo.sourceDuration > 0) {
      window = { sourceIn: 0, sourceOut: itemInfo.sourceDuration };
    }
    onCommit("reset_item", (state) => {
      const target = state.items.find((i) => i.id === item.id);
      if (!target) return;
      if (window) {
        target.sourceIn = window.sourceIn;
        target.sourceOut = window.sourceOut;
      }
      target.speed = 1;
      target.volume = 1;
      target.fadeIn = 0;
      target.fadeOut = 0;
      target.duration = target.sourceOut - target.sourceIn;
      target.transform = { ...DEFAULT_TRANSFORM };
    });
  };

  /** Map a source-time (scene range) onto the timeline via main items. */
  const seekToSourceTime = (sourceSec: number) => {
    const mainTrack = doc.tracks.find((t) => t.kind === "main");
    if (mainTrack) {
      for (const candidate of doc.items.filter((i) => i.trackId === mainTrack.id)) {
        const underlying =
          candidate.assetKind === "candidate"
            ? (library.candidates.find((c) => c.id === candidate.assetId)?.sourceAssetId ?? null)
            : candidate.assetKind === "source"
              ? candidate.assetId
              : null;
        if (underlying !== library.transcriptSourceAssetId) continue;
        if (sourceSec >= candidate.sourceIn && sourceSec < candidate.sourceOut) {
          setSeekNote(null);
          onSeek(candidate.start + (sourceSec - candidate.sourceIn) / candidate.speed);
          return;
        }
      }
    }
    setSeekNote(
      "That scene's source range is not placed on the main track, so the playhead cannot jump to it.",
    );
  };

  // The single selected scene (if any) — the only case where the
  // draft range is editable, since every scene owns its own range.
  const singleTopic =
    sceneSelection.size === 1 ? library.topics.find((t) => sceneSelection.has(t.id)) : undefined;

  // Sync the draft range when the single selection changes: start
  // from the scene's existing override range, else its full range.
  useEffect(() => {
    if (!singleTopic) return;
    const existing = doc.sceneOverrides.find((o) => o.topicSegmentId === singleTopic.id);
    const start = existing ? existing.rangeStart : singleTopic.startSec;
    const end = existing ? existing.rangeEnd : singleTopic.endSec;
    setSceneDraft((d) =>
      Math.abs(d.rangeStart - start) < 0.001 && Math.abs(d.rangeEnd - end) < 0.001
        ? d
        : { ...d, rangeStart: start, rangeEnd: end },
    );
  }, [singleTopic, doc.sceneOverrides]);

  const sceneRangeError: string | null = !singleTopic
    ? null
    : sceneDraft.rangeStart < singleTopic.startSec - 0.001 ||
        sceneDraft.rangeEnd > singleTopic.endSec + 0.001
      ? `Range must stay inside the scene (${formatClock(singleTopic.startSec)}–${formatClock(singleTopic.endSec)}).`
      : sceneDraft.rangeEnd <= sceneDraft.rangeStart
        ? "Range end must be after range start."
        : null;

  const applySceneOverrides = (scope: "selected" | "all") => {
    const topics = scope === "all" ? library.topics : library.topics.filter((t) => sceneSelection.has(t.id));
    if (topics.length === 0) return;
    if (scope === "selected" && sceneRangeError) return;
    // Server shape (sceneOverrideSchema): fields live under
    // `overrides`, the range under rangeStart/rangeEnd.
    const overrides: SceneOverride["overrides"] = {
      zoom: sceneDraft.zoom,
      x: sceneDraft.x,
      y: sceneDraft.y,
      scale: sceneDraft.scale,
      rotation: sceneDraft.rotation,
      fit: sceneDraft.fit,
      ...(sceneDraft.useCrop
        ? { crop: { x: sceneDraft.cropX, y: sceneDraft.cropY, w: sceneDraft.cropW, h: sceneDraft.cropH } }
        : {}),
    };
    onCommit("scene_override_set", (state) => {
      for (const topic of topics) {
        // A single selected scene uses the edited draft range; every
        // other application keeps the scene's own full range.
        const useDraftRange = scope === "selected" && topics.length === 1;
        const rangeStart = useDraftRange ? sceneDraft.rangeStart : topic.startSec;
        const rangeEnd = useDraftRange ? sceneDraft.rangeEnd : topic.endSec;
        const existing = state.sceneOverrides.find((o) => o.topicSegmentId === topic.id);
        if (existing) {
          existing.rangeStart = rangeStart;
          existing.rangeEnd = rangeEnd;
          existing.overrides = { ...existing.overrides, ...overrides };
        } else {
          state.sceneOverrides.push({
            id: crypto.randomUUID(),
            topicSegmentId: topic.id,
            rangeStart,
            rangeEnd,
            overrides: { ...overrides },
          });
        }
      }
    });
  };

  const resetSceneOverrides = (scope: "selected" | "all") => {
    onCommit("scene_override_reset", (state) => {
      state.sceneOverrides =
        scope === "all"
          ? []
          : state.sceneOverrides.filter(
              (o) => o.topicSegmentId === null || !sceneSelection.has(o.topicSegmentId),
            );
    });
  };

  // Source-time position of the shared playhead, for the panel whose
  // native time base is the analysed source (ReframePanel): map the
  // timeline playhead through the main item under it — the inverse of
  // seekToSourceTime above. 0 when the playhead is not over the
  // analysed source.
  const sourceTimeAtPlayhead = (() => {
    const main = doc.tracks.find((t) => t.kind === "main");
    if (!main) return 0;
    const current = doc.items.find(
      (i) => i.trackId === main.id && playhead >= i.start && playhead < i.start + i.duration,
    );
    if (!current) return 0;
    const underlying =
      current.assetKind === "candidate"
        ? (library.candidates.find((c) => c.id === current.assetId)?.sourceAssetId ?? null)
        : current.assetKind === "source"
          ? current.assetId
          : null;
    return underlying !== null && underlying === library.transcriptSourceAssetId
      ? current.sourceIn + (playhead - current.start) * current.speed
      : 0;
  })();

  const activeRender = renders.find((r) => RENDER_ACTIVE.includes(r.status));

  return (
    <div className={styles.panel} aria-label="Inspector">
      {item && itemInfo && (
        <>
          <h3>Clip — {itemInfo.label}</h3>
          {!itemInfo.hasAudio && <span className={`${styles.badge} ${styles.badgeWarn}`}>Source has no audio</span>}
          {trackLocked && <p className={styles.muted}>This track is locked — unlock it to edit.</p>}
          <div className={styles.fieldGrid}>
            <NumField label="Timeline start (s)" value={item.start} min={0} disabled={trackLocked} onCommit={(v) => patchItem({ start: Math.max(0, v) }, "move_item")} />
            <NumField
              label="Duration (s)"
              value={item.duration}
              min={0.1}
              disabled={trackLocked}
              onCommit={(v) =>
                patchItem({ sourceOut: item.sourceIn + Math.max(0.1, v) * item.speed, duration: Math.max(0.1, v) }, "trim_item")
              }
            />
            <NumField
              label="Source in (s)"
              value={item.sourceIn}
              min={0}
              disabled={trackLocked}
              onCommit={(v) => {
                const sourceIn = Math.min(Math.max(0, v), item.sourceOut - 0.1);
                patchItem(
                  { sourceIn, start: item.start + (sourceIn - item.sourceIn) / item.speed, duration: (item.sourceOut - sourceIn) / item.speed },
                  "trim_item",
                );
              }}
            />
            <NumField
              label="Source out (s)"
              value={item.sourceOut}
              min={0.1}
              disabled={trackLocked}
              onCommit={(v) => {
                const sourceOut = Math.max(item.sourceIn + 0.1, v);
                patchItem({ sourceOut, duration: (sourceOut - item.sourceIn) / item.speed }, "trim_item");
              }}
            />
            <NumField label="Speed (×)" value={item.speed} step={0.05} min={0.25} max={4} disabled={trackLocked} onCommit={(v) => { const speed = clamp(v, 0.25, 4); patchItem({ speed, duration: (item.sourceOut - item.sourceIn) / speed }); }} />
            <NumField label="Volume" value={item.volume} step={0.05} min={0} max={2} disabled={trackLocked} onCommit={(v) => patchItem({ volume: clamp(v, 0, 2) })} />
            <NumField label="Fade in (s)" value={item.fadeIn} step={0.1} min={0} disabled={trackLocked} onCommit={(v) => patchItem({ fadeIn: Math.max(0, v) })} />
            <NumField label="Fade out (s)" value={item.fadeOut} step={0.1} min={0} disabled={trackLocked} onCommit={(v) => patchItem({ fadeOut: Math.max(0, v) })} />
          </div>
          <h4>Transform</h4>
          <div className={styles.fieldGrid}>
            <NumField label="Position X" value={item.transform.x} step={0.01} min={-1} max={1} disabled={trackLocked} onCommit={(v) => patchTransform({ x: clamp(v, -1, 1) })} />
            <NumField label="Position Y" value={item.transform.y} step={0.01} min={-1} max={1} disabled={trackLocked} onCommit={(v) => patchTransform({ y: clamp(v, -1, 1) })} />
            <NumField label="Scale" value={item.transform.scale} step={0.05} min={0.1} max={4} disabled={trackLocked} onCommit={(v) => patchTransform({ scale: clamp(v, 0.1, 4) })} />
            {(itemTrack?.kind === "broll" || itemTrack?.kind === "overlay") && (
              <NumField label="Opacity" value={item.transform.opacity ?? 1} step={0.05} min={0.05} max={1} disabled={trackLocked} onCommit={(v) => patchTransform({ opacity: clamp(v, 0.05, 1) })} />
            )}
            <NumField label="Zoom" value={item.transform.zoom} step={0.05} min={0.25} max={4} disabled={trackLocked} onCommit={(v) => patchTransform({ zoom: clamp(v, 0.25, 4) })} />
            <NumField label="Rotation (°)" value={item.transform.rotation} step={1} min={-180} max={180} disabled={trackLocked} onCommit={(v) => patchTransform({ rotation: clamp(v, -180, 180) })} />
            <div className={styles.field}>
              <label>Fit</label>
              <select value={item.transform.fit} disabled={trackLocked} onChange={(e) => patchTransform({ fit: e.target.value as "fit" | "fill" })}>
                <option value="fill">Fill (crop to canvas)</option>
                <option value="fit">Fit (whole frame)</option>
              </select>
            </div>
          </div>
          <h4>Crop (normalised 0–1)</h4>
          <div className={styles.fieldGrid}>
            <NumField label="Crop X" value={item.transform.crop?.x ?? 0} step={0.01} min={0} max={0.99} disabled={trackLocked} onCommit={(v) => patchTransform({ crop: { x: v, y: item.transform.crop?.y ?? 0, w: item.transform.crop?.w ?? 1 - v, h: item.transform.crop?.h ?? 1 } })} />
            <NumField label="Crop Y" value={item.transform.crop?.y ?? 0} step={0.01} min={0} max={0.99} disabled={trackLocked} onCommit={(v) => patchTransform({ crop: { x: item.transform.crop?.x ?? 0, y: v, w: item.transform.crop?.w ?? 1, h: item.transform.crop?.h ?? 1 - v } })} />
            <NumField label="Crop width" value={item.transform.crop?.w ?? 1} step={0.01} min={0.05} max={1} disabled={trackLocked} onCommit={(v) => patchTransform({ crop: { x: item.transform.crop?.x ?? 0, y: item.transform.crop?.y ?? 0, w: v, h: item.transform.crop?.h ?? 1 } })} />
            <NumField label="Crop height" value={item.transform.crop?.h ?? 1} step={0.01} min={0.05} max={1} disabled={trackLocked} onCommit={(v) => patchTransform({ crop: { x: item.transform.crop?.x ?? 0, y: item.transform.crop?.y ?? 0, w: item.transform.crop?.w ?? 1, h: v } })} />
          </div>
          <div className={styles.addButtons}>
            <button
              type="button"
              className={styles.miniButton}
              disabled={trackLocked || playhead <= item.start || playhead >= item.start + item.duration}
              title="Move the playhead inside this clip to split it"
              onClick={() =>
                onCommit("split_item", (state) => {
                  const idx = state.items.findIndex((i) => i.id === item.id);
                  if (idx < 0) return;
                  const orig = state.items[idx];
                  const cutSource = orig.sourceIn + (playhead - orig.start) * orig.speed;
                  const first = { ...orig, sourceOut: cutSource, duration: playhead - orig.start };
                  const second = {
                    ...orig,
                    id: crypto.randomUUID(),
                    sourceIn: cutSource,
                    start: playhead,
                    duration: orig.start + orig.duration - playhead,
                  };
                  state.items.splice(idx, 1, first, second);
                })
              }
            >
              Split at playhead
            </button>
            <button
              type="button"
              className={styles.miniButton}
              disabled={trackLocked}
              onClick={() =>
                onCommit("duplicate_item", (state) => {
                  const orig = state.items.find((i) => i.id === item.id);
                  if (orig) state.items.push({ ...orig, id: crypto.randomUUID(), start: orig.start + orig.duration });
                })
              }
            >
              Duplicate
            </button>
            <button
              type="button"
              className={styles.miniButton}
              disabled={mergeBlockReason !== null}
              title={mergeBlockReason ?? "Merge this clip with the next clip on the same track"}
              onClick={() => {
                if (!nextItem || mergeBlockReason !== null) return;
                const nextId = nextItem.id;
                onCommit("merge_items", (state) => {
                  const a = state.items.find((i) => i.id === item.id);
                  const b = state.items.find((i) => i.id === nextId);
                  if (!a || !b) return;
                  a.sourceOut = b.sourceOut;
                  a.duration = (b.sourceOut - a.sourceIn) / a.speed;
                  state.items = state.items.filter((i) => i.id !== b.id);
                });
              }}
            >
              Merge with next
            </button>
            <button
              type="button"
              className={styles.miniButton}
              disabled={trackLocked}
              onClick={() => patchTransform({ ...DEFAULT_TRANSFORM })}
            >
              Reset transform
            </button>
            <button
              type="button"
              className={styles.miniButton}
              disabled={trackLocked}
              title="Restore the full original source window, speed and volume 1, no fades, default transform"
              onClick={resetItem}
            >
              Reset item
            </button>
            <button
              type="button"
              className={`${styles.miniButton} ${styles.miniButtonDanger}`}
              disabled={trackLocked}
              onClick={() => {
                onSelect(null);
                onCommit("delete_item", (state) => {
                  state.items = state.items.filter((i) => i.id !== item.id);
                });
              }}
            >
              Delete clip
            </button>
          </div>
        </>
      )}

      {caption && (
        <>
          <h3>Caption</h3>
          <div className={styles.field}>
            <label>Text</label>
            <textarea
              rows={3}
              defaultValue={caption.text}
              key={caption.id + caption.text}
              onBlur={(e) => {
                const text = e.target.value;
                if (text !== caption.text) {
                  onCommit("caption_update", (state) => {
                    const target = state.captions.find((c) => c.id === caption.id);
                    if (target) target.text = text;
                  });
                }
              }}
            />
          </div>
          <div className={styles.fieldGrid}>
            <NumField
              label="Start (s)"
              value={caption.start}
              min={0}
              onCommit={(v) => {
                const clamped = Math.min(v, caption.end - 0.1);
                setCaptionTimingHint(
                  clamped !== v
                    ? `Start adjusted to ${clamped.toFixed(2)}s — a caption keeps at least 0.1s between its start and end.`
                    : null,
                );
                onCommit("caption_update", (state) => {
                  const target = state.captions.find((c) => c.id === caption.id);
                  if (target) target.start = Math.min(v, target.end - 0.1);
                });
              }}
            />
            <NumField
              label="End (s)"
              value={caption.end}
              min={0.1}
              onCommit={(v) => {
                const clamped = Math.max(v, caption.start + 0.1);
                setCaptionTimingHint(
                  clamped !== v
                    ? `End adjusted to ${clamped.toFixed(2)}s — a caption keeps at least 0.1s between its start and end.`
                    : null,
                );
                onCommit("caption_update", (state) => {
                  const target = state.captions.find((c) => c.id === caption.id);
                  if (target) target.end = Math.max(v, target.start + 0.1);
                });
              }}
            />
          </div>
          {captionTimingHint && (
            <p className={styles.small} role="note">
              {captionTimingHint}
            </p>
          )}
          {caption.words && <p className={styles.small}>Word-level timing from the transcript is preserved on this caption — refine it in the Word editor below.</p>}
          <div className={styles.addButtons}>
            <button
              type="button"
              className={styles.miniButton}
              disabled={playhead <= caption.start || playhead >= caption.end}
              title="Move the playhead inside this caption to split it"
              onClick={() =>
                onCommit("caption_split", (state) => {
                  const idx = state.captions.findIndex((c) => c.id === caption.id);
                  if (idx < 0) return;
                  const orig = state.captions[idx];
                  const wordsA = orig.words?.filter((w) => w.end <= playhead) ?? null;
                  const wordsB = orig.words?.filter((w) => w.start >= playhead) ?? null;
                  const first = { ...orig, end: playhead, words: wordsA && wordsA.length > 0 ? wordsA : null };
                  const second = {
                    ...orig,
                    id: crypto.randomUUID(),
                    start: playhead,
                    text: wordsB && wordsB.length > 0 ? wordsB.map((w) => w.word).join(" ") : orig.text,
                    words: wordsB && wordsB.length > 0 ? wordsB : null,
                  };
                  state.captions.splice(idx, 1, first, second);
                })
              }
            >
              Split at playhead
            </button>
            <button
              type="button"
              className={styles.miniButton}
              disabled={!hasNextCaption}
              title={hasNextCaption ? undefined : "There is no next caption to merge with"}
              onClick={() => {
                const sorted = [...doc.captions].sort((a, b) => a.start - b.start);
                const idx = sorted.findIndex((c) => c.id === caption.id);
                const next = sorted[idx + 1];
                if (!next) return;
                onCommit("caption_merge", (state) => {
                  const a = state.captions.find((c) => c.id === caption.id);
                  const b = state.captions.find((c) => c.id === next.id);
                  if (!a || !b) return;
                  a.end = b.end;
                  a.text = `${a.text} ${b.text}`.trim();
                  a.words = a.words || b.words ? [...(a.words ?? []), ...(b.words ?? [])] : null;
                  state.captions = state.captions.filter((c) => c.id !== b.id);
                });
              }}
            >
              Merge with next
            </button>
            <button
              type="button"
              className={styles.miniButton}
              onClick={() =>
                onCommit("caption_add", (state) => {
                  state.captions.push({
                    id: crypto.randomUUID(),
                    start: playhead,
                    end: playhead + 2,
                    text: "New caption",
                    words: null,
                    style: null,
                    language: caption.language,
                  });
                })
              }
            >
              Add caption at playhead
            </button>
            <button
              type="button"
              className={`${styles.miniButton} ${styles.miniButtonDanger}`}
              onClick={() => {
                onSelect(null);
                onCommit("caption_delete", (state) => {
                  state.captions = state.captions.filter((c) => c.id !== caption.id);
                });
              }}
            >
              Delete caption
            </button>
          </div>
        </>
      )}

      {!item && !caption && <p className={styles.muted}>Select a clip or caption on the timeline to edit it here.</p>}

      <CaptionStudio
        doc={doc}
        projectId={projectId}
        playhead={playhead}
        selectedCaptionId={caption?.id ?? null}
        onSeek={onSeek}
        onSelectCaption={(id) => onSelect({ kind: "caption", id })}
        onCommit={onCommit}
        onPatchSettings={onPatchSettings}
        onReplaceDocument={onReplaceDocument}
      />

      <ReframePanel
        docId={doc.id}
        projectId={projectId}
        playhead={sourceTimeAtPlayhead}
        onPatchSettings={onPatchSettings}
      />

      <EnhancePanel doc={doc} projectId={projectId} onReplaceDocument={onReplaceDocument} />

      <h3>Scenes</h3>
      {library.topics.length === 0 ? (
        <p className={styles.muted}>
          No scenes yet — scenes come from the transcript analysis of this project. Run “Find
          Clips” on the project first.
        </p>
      ) : (
        <>
          {library.topics.map((topic) => {
            const override = doc.sceneOverrides.find((o) => o.topicSegmentId === topic.id);
            const hasCustomRange =
              override &&
              (Math.abs(override.rangeStart - topic.startSec) > 0.01 ||
                Math.abs(override.rangeEnd - topic.endSec) > 0.01);
            return (
              <div key={topic.id} className={styles.sceneRow}>
                <input
                  type="checkbox"
                  checked={sceneSelection.has(topic.id)}
                  onChange={(e) => {
                    setSceneSelection((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(topic.id);
                      else next.delete(topic.id);
                      return next;
                    });
                  }}
                  aria-label={`Select scene ${topic.label}`}
                />
                <button
                  type="button"
                  className={styles.miniButton}
                  onClick={() => seekToSourceTime(topic.startSec)}
                >
                  {formatClock(topic.startSec)}
                </button>
                <span style={{ flex: 1 }}>{topic.label}</span>
                {hasCustomRange && (
                  <span className={styles.badge}>
                    Range {formatClock(override.rangeStart)}–{formatClock(override.rangeEnd)}
                  </span>
                )}
                {override && <span className={`${styles.badge} ${styles.badgeLime}`}>Override</span>}
              </div>
            );
          })}
          {seekNote && (
            <p className={styles.small} role="status">
              {seekNote}
            </p>
          )}
          <div className={styles.fieldGrid}>
            <NumField label="Scene zoom" value={sceneDraft.zoom} step={0.05} min={0.25} max={4} onCommit={(v) => setSceneDraft((d) => ({ ...d, zoom: clamp(v, 0.25, 4) }))} />
            <NumField label="Scene scale" value={sceneDraft.scale} step={0.05} min={0.1} max={4} onCommit={(v) => setSceneDraft((d) => ({ ...d, scale: clamp(v, 0.1, 4) }))} />
            <NumField label="Scene X" value={sceneDraft.x} step={0.01} min={-1} max={1} onCommit={(v) => setSceneDraft((d) => ({ ...d, x: clamp(v, -1, 1) }))} />
            <NumField label="Scene Y" value={sceneDraft.y} step={0.01} min={-1} max={1} onCommit={(v) => setSceneDraft((d) => ({ ...d, y: clamp(v, -1, 1) }))} />
            <NumField label="Scene rotation (°)" value={sceneDraft.rotation} step={1} min={-180} max={180} onCommit={(v) => setSceneDraft((d) => ({ ...d, rotation: clamp(v, -180, 180) }))} />
            <div className={styles.field}>
              <label>Scene layout</label>
              <select value={sceneDraft.fit} onChange={(e) => setSceneDraft((d) => ({ ...d, fit: e.target.value as "fit" | "fill" }))}>
                <option value="fill">Fill — crop to canvas</option>
                <option value="fit">Fit — whole frame on background</option>
              </select>
            </div>
            <NumField
              label="Scene range start (s)"
              value={sceneDraft.rangeStart}
              step={0.1}
              min={0}
              disabled={!singleTopic}
              onCommit={(v) => setSceneDraft((d) => ({ ...d, rangeStart: Math.max(0, v) }))}
            />
            <NumField
              label="Scene range end (s)"
              value={sceneDraft.rangeEnd}
              step={0.1}
              min={0}
              disabled={!singleTopic}
              onCommit={(v) => setSceneDraft((d) => ({ ...d, rangeEnd: Math.max(0, v) }))}
            />
          </div>
          {singleTopic ? (
            <p className={styles.small}>
              Range applies to “{singleTopic.label}” only, in source time ({formatClock(singleTopic.startSec)}–
              {formatClock(singleTopic.endSec)}); the render splits clips at these boundaries and applies the
              override inside the range.
            </p>
          ) : (
            <p className={styles.small}>
              Select exactly one scene to adjust the range its override covers; each scene keeps its own range.
            </p>
          )}
          {sceneRangeError && (
            <p className={styles.errorText} role="alert">
              {sceneRangeError}
            </p>
          )}
          <div className={styles.field}>
            <label>
              <input
                type="checkbox"
                checked={sceneDraft.useCrop}
                onChange={(e) => setSceneDraft((d) => ({ ...d, useCrop: e.target.checked }))}
              />{" "}
              Crop scenes (normalised 0–1)
            </label>
          </div>
          {sceneDraft.useCrop && (
            <div className={styles.fieldGrid}>
              <NumField label="Scene crop X" value={sceneDraft.cropX} step={0.01} min={0} max={1} onCommit={(v) => setSceneDraft((d) => ({ ...d, cropX: clamp(v, 0, 1) }))} />
              <NumField label="Scene crop Y" value={sceneDraft.cropY} step={0.01} min={0} max={1} onCommit={(v) => setSceneDraft((d) => ({ ...d, cropY: clamp(v, 0, 1) }))} />
              <NumField label="Scene crop width" value={sceneDraft.cropW} step={0.01} min={0.05} max={1} onCommit={(v) => setSceneDraft((d) => ({ ...d, cropW: clamp(v, 0.05, 1) }))} />
              <NumField label="Scene crop height" value={sceneDraft.cropH} step={0.01} min={0.05} max={1} onCommit={(v) => setSceneDraft((d) => ({ ...d, cropH: clamp(v, 0.05, 1) }))} />
            </div>
          )}
          <div className={styles.addButtons}>
            <button type="button" className={styles.miniButton} disabled={sceneSelection.size === 0 || sceneRangeError !== null} onClick={() => applySceneOverrides("selected")}>
              Apply to selected ({sceneSelection.size})
            </button>
            <button type="button" className={styles.miniButton} onClick={() => applySceneOverrides("all")}>
              Apply to all scenes
            </button>
            <button type="button" className={styles.miniButton} disabled={sceneSelection.size === 0} onClick={() => resetSceneOverrides("selected")}>
              Reset selected
            </button>
            <button type="button" className={styles.miniButton} onClick={() => resetSceneOverrides("all")}>
              Reset all
            </button>
          </div>
          <p className={styles.small}>
            Overrides apply where the main track plays the analysed source; in preview and render they
            win over the clip's own transform. Layout is per scene: Fill crops the frame to the canvas,
            Fit shows the whole frame over the document's background fill — these are the two layouts
            the render pipeline supports per scene.
          </p>
        </>
      )}

      <h3>Canvas</h3>
      <div className={styles.addButtons}>
        {CANVAS_PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            className={styles.miniButton}
            aria-pressed={doc.canvas.aspect === preset.canvas.aspect && !doc.canvas.custom}
            onClick={() => onPatchSettings({ canvas: preset.canvas })}
          >
            {preset.label}
          </button>
        ))}
      </div>
      <div className={styles.fieldGrid}>
        <NumField label="Custom width (px)" value={doc.canvas.width} step={10} min={16} max={7680} onCommit={(v) => onPatchSettings({ canvas: { aspect: "custom", width: Math.round(v), height: doc.canvas.height, custom: true } })} />
        <NumField label="Custom height (px)" value={doc.canvas.height} step={10} min={16} max={7680} onCommit={(v) => onPatchSettings({ canvas: { aspect: "custom", width: doc.canvas.width, height: Math.round(v), custom: true } })} />
      </div>
      <div className={styles.field}>
        <label>Background fill (when a clip does not fill the canvas)</label>
        <select
          value={doc.settings.backgroundFill}
          onChange={(e) => onPatchSettings({ settings: { backgroundFill: e.target.value as "blur" | "solid" } })}
        >
          <option value="blur">Blurred source frame</option>
          <option value="solid">Solid midnight black</option>
        </select>
      </div>
      <p className={styles.small}>
        Canvas: {doc.canvas.width}×{doc.canvas.height} — the render output uses exactly this size.
      </p>

      <h3>Versions</h3>
      <div className={styles.addButtons}>
        <input
          type="text"
          placeholder="Version name"
          value={versionName}
          onChange={(e) => setVersionName(e.target.value)}
          style={{
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            color: "var(--text)",
            padding: "5px 7px",
            font: "inherit",
            fontSize: "0.85rem",
            flex: 1,
          }}
        />
        <button
          type="button"
          className={styles.miniButton}
          disabled={!versionName.trim()}
          onClick={() => {
            onCreateVersion(versionName.trim());
            setVersionName("");
          }}
        >
          Save version
        </button>
      </div>
      {versions.length === 0 && <p className={styles.muted}>No saved versions yet.</p>}
      {versions.map((version) => (
        <div key={version.id} className={styles.assetRow}>
          <div className={styles.assetRowTop}>
            <span className={styles.assetName}>{version.name}</span>
            <button type="button" className={styles.miniButton} onClick={() => onRestoreVersion(version.id)}>
              Restore
            </button>
          </div>
          <span className={styles.small}>{new Date(version.createdAt).toLocaleString()}</span>
        </div>
      ))}
      <p className={styles.small}>Restoring a version is itself an edit — undo can take you back.</p>

      <h3>Export</h3>
      <button type="button" className={styles.toolButtonPrimary} style={{ padding: "8px 12px", borderRadius: "var(--radius-sm)", border: "1px solid var(--cobalt)", cursor: "pointer", font: "inherit" }} disabled={Boolean(activeRender)} onClick={onStartRender}>
        {activeRender ? `Rendering… ${activeRender.stage}` : "Render video (MP4)"}
      </button>
      <p className={styles.small}>
        Renders the actual timeline with FFmpeg on the server — trims, transforms, scene overrides,
        captions burned in, music mixed. The original files are never modified.
      </p>
      {renders.map((job) => (
        <div key={job.id} className={styles.renderJob}>
          <span>
            <strong>{job.status}</strong> · {job.stage} · {new Date(job.createdAt).toLocaleTimeString()}
          </span>
          {job.error && <span className={styles.errorText}>{job.error}</span>}
          <span className={styles.addButtons}>
            {job.status === "COMPLETED" && job.hasOutput && (
              <a className={styles.miniButton} href={editorApi.renderDownloadUrl(job.id)} download>
                Download MP4
              </a>
            )}
            {RENDER_ACTIVE.includes(job.status) && (
              <button type="button" className={styles.miniButton} onClick={() => onCancelRender(job.id)}>
                Cancel render
              </button>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
