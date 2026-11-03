// Phase 5 — multi-track timeline. Five track kinds (main, b-roll,
// captions, audio/music, overlay) with pointer-based drag to move,
// edge drags to trim, snapping to item edges + the playhead, track
// lock/visibility/mute/solo controls and zoom. Dragging only moves a
// local preview; the edit is committed as a server operation on
// pointer-up, so the timeline always reflects persisted state.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  assetInfo,
  formatClock,
  timelineDuration,
  type EditorDocument,
  type EditorLibrary,
  type TimelineItem,
  type TimelineTrack,
} from "../../services/editor";
import styles from "../../pages/studio/Editor.module.css";

export type EditorSelection =
  | { kind: "item"; id: string }
  | { kind: "caption"; id: string }
  | null;

interface Props {
  doc: EditorDocument;
  library: EditorLibrary;
  playhead: number;
  onSeek: (t: number) => void;
  selection: EditorSelection;
  onSelect: (sel: EditorSelection) => void;
  /** Commit a full-state mutation as a named server operation. */
  onCommit: (type: string, mutate: (state: EditorDocument) => void) => void;
  onTrackPatch: (trackId: string, patch: Partial<TimelineItem> | Record<string, unknown>, kind: "track") => void;
}

interface DragState {
  mode: "move" | "trim-left" | "trim-right" | "caption-move";
  itemId: string;
  isCaption: boolean;
  startX: number;
  startY: number;
  origStart: number;
  origSourceIn: number;
  origSourceOut: number;
  origDuration: number;
  origCaptionStart: number;
  origCaptionEnd: number;
  targetTrackId: string;
  previewStart: number;
  previewSourceIn: number;
  previewSourceOut: number;
  moved: boolean;
}

const TRACK_HEIGHT: Record<string, number> = { main: 52, broll: 52, overlay: 52, audio: 52, caption: 38, captions: 38 };
const VIDEO_TRACKS = new Set(["main", "broll", "overlay"]);

/**
 * Track kinds a user can add (Phase 5 §12 add/remove tracks). These
 * are the SERVER kind values — the state schema's kind set; note the
 * caption kind is "caption" on the wire. Adding creates an empty
 * track via the track_add operation; the server enforces the same
 * guards the remove button mirrors below.
 */
const ADDABLE_TRACKS: { kind: string; label: string }[] = [
  { kind: "broll", label: "B-roll" },
  { kind: "overlay", label: "Overlay" },
  { kind: "audio", label: "Audio" },
  { kind: "caption", label: "Captions" },
  { kind: "main", label: "Main video" },
];
export const isCaptionKind = (kind: string) => kind === "caption" || kind === "captions";

function compatibleTracks(doc: EditorDocument, item: TimelineItem): string[] {
  const track = doc.tracks.find((t) => t.id === item.trackId);
  if (!track) return [item.trackId];
  if (VIDEO_TRACKS.has(track.kind)) {
    return doc.tracks.filter((t) => VIDEO_TRACKS.has(t.kind)).map((t) => t.id);
  }
  return [item.trackId]; // audio items stay on audio tracks
}

export default function Timeline({
  doc,
  library,
  playhead,
  onSeek,
  selection,
  onSelect,
  onCommit,
  onTrackPatch,
}: Props) {
  const [pxPerSec, setPxPerSec] = useState(14);
  const [addKind, setAddKind] = useState("broll");
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lanesRef = useRef<HTMLDivElement | null>(null);

  const duration = Math.max(timelineDuration(doc), 10);
  const widthPx = Math.ceil(duration * pxPerSec) + 240;
  const tracks = useMemo(() => [...doc.tracks].sort((a, b) => a.order - b.order), [doc.tracks]);
  // Captions have no trackId in the document model. Attribute the
  // single caption set to the first caption track only, rather than
  // duplicating every caption onto each caption lane.
  const firstCaptionTrackId = tracks.find((track) => isCaptionKind(track.kind))?.id ?? null;

  const snapPoints = useMemo(() => {
    const points = [0, playhead];
    for (const item of doc.items) points.push(item.start, item.start + item.duration);
    for (const cap of doc.captions) points.push(cap.start, cap.end);
    return points;
  }, [doc.items, doc.captions, playhead]);

  const snap = (t: number): number => {
    if (!doc.settings.snapEnabled) return t;
    const threshold = 9 / pxPerSec;
    let best = t;
    let bestDist = threshold;
    for (const point of snapPoints) {
      const dist = Math.abs(point - t);
      if (dist < bestDist) {
        bestDist = dist;
        best = point;
      }
    }
    return best;
  };

  const timeFromClientX = (clientX: number): number => {
    const lanes = lanesRef.current;
    if (!lanes) return 0;
    const rect = lanes.getBoundingClientRect();
    // Lane content starts after the 148px track-header column.
    return Math.max(0, (clientX - rect.left - 148) / pxPerSec);
  };

  // ---- Drag handling -------------------------------------------------
  const beginDrag = (
    e: React.PointerEvent,
    mode: DragState["mode"],
    item: TimelineItem | null,
    captionId: string | null,
  ) => {
    if (e.button !== 0) return;
    if (item) {
      const track = doc.tracks.find((t) => t.id === item.trackId);
      onSelect({ kind: "item", id: item.id });
      if (track?.locked) return;
      setDrag({
        mode,
        itemId: item.id,
        isCaption: false,
        startX: e.clientX,
        startY: e.clientY,
        origStart: item.start,
        origSourceIn: item.sourceIn,
        origSourceOut: item.sourceOut,
        origDuration: item.duration,
        origCaptionStart: 0,
        origCaptionEnd: 0,
        targetTrackId: item.trackId,
        previewStart: item.start,
        previewSourceIn: item.sourceIn,
        previewSourceOut: item.sourceOut,
        moved: false,
      });
    } else if (captionId) {
      const caption = doc.captions.find((c) => c.id === captionId);
      if (!caption) return;
      onSelect({ kind: "caption", id: captionId });
      const captionTrack = [...doc.tracks]
        .sort((a, b) => a.order - b.order)
        .find((t) => isCaptionKind(t.kind));
      if (captionTrack?.locked) return;
      setDrag({
        mode: "caption-move",
        itemId: captionId,
        isCaption: true,
        startX: e.clientX,
        startY: e.clientY,
        origStart: 0,
        origSourceIn: 0,
        origSourceOut: 0,
        origDuration: 0,
        origCaptionStart: caption.start,
        origCaptionEnd: caption.end,
        targetTrackId: "",
        previewStart: caption.start,
        previewSourceIn: 0,
        previewSourceOut: 0,
        moved: false,
      });
    }
  };

  const onDragMove = (e: { clientX: number; clientY: number }) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dxSec = (e.clientX - drag.startX) / pxPerSec;
    const next = { ...drag, moved: drag.moved || Math.abs(e.clientX - drag.startX) > 2 };
    if (drag.mode === "move") {
      next.previewStart = Math.max(0, snap(drag.origStart + dxSec));
      // Vertical: switch between compatible tracks by row.
      const lanes = lanesRef.current;
      if (lanes) {
        const rows = Array.from(lanes.querySelectorAll<HTMLElement>("[data-track-id]"));
        for (const row of rows) {
          const rect = row.getBoundingClientRect();
          if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
            const candidate = row.dataset.trackId!;
            const item = doc.items.find((i) => i.id === drag.itemId);
            if (item && compatibleTracks(doc, item).includes(candidate)) {
              const track = doc.tracks.find((t) => t.id === candidate);
              if (track && !track.locked) next.targetTrackId = candidate;
            }
          }
        }
      }
    } else if (drag.mode === "trim-left") {
      // Snap in the TIMELINE domain (the item's start edge), then map
      // back to a source-in through the item's speed.
      const snappedStart = snap(drag.origStart + dxSec);
      const newIn = Math.min(
        drag.origSourceOut - 0.1,
        Math.max(0, drag.origSourceIn + (snappedStart - drag.origStart) * itemSpeed(drag.itemId)),
      );
      next.previewSourceIn = newIn;
      next.previewStart = drag.origStart + (newIn - drag.origSourceIn) / itemSpeed(drag.itemId);
    } else if (drag.mode === "trim-right") {
      const snappedEnd = snap(drag.origStart + drag.origDuration + dxSec);
      next.previewSourceOut = Math.max(
        drag.origSourceIn + 0.1,
        drag.origSourceOut + (snappedEnd - (drag.origStart + drag.origDuration)) * itemSpeed(drag.itemId),
      );
    } else if (drag.mode === "caption-move") {
      next.previewStart = Math.max(0, snap(drag.origCaptionStart + dxSec));
    }
    setDrag(next);
  };

  const itemSpeed = (itemId: string): number =>
    doc.items.find((i) => i.id === itemId)?.speed ?? 1;

  // Drag continues outside the lane, so move/up are window-level
  // while a drag is active.
  const dragActive = drag !== null;
  useEffect(() => {
    if (!dragActive) return;
    const move = (ev: PointerEvent) => onDragMove(ev);
    const up = () => endDrag();
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    // Handlers read the live drag via dragRef, so registering once
    // per drag session is correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragActive]);

  const endDrag = () => {
    const finished = dragRef.current;
    if (!finished) return;
    setDrag(null);
    if (!finished.moved) return;
    if (finished.isCaption) {
      const delta = finished.previewStart - finished.origCaptionStart;
      if (Math.abs(delta) < 0.001) return;
      onCommit("caption_move", (state) => {
        const caption = state.captions.find((c) => c.id === finished.itemId);
        if (!caption) return;
        const len = caption.end - caption.start;
        caption.start = Math.max(0, finished.previewStart);
        caption.end = caption.start + len;
        if (caption.words) {
          const shift = caption.start - finished.origCaptionStart;
          caption.words = caption.words.map((w) => ({ ...w, start: w.start + shift, end: w.end + shift }));
        }
      });
      return;
    }
    const type = finished.mode === "move" ? "move_item" : "trim_item";
    onCommit(type, (state) => {
      const item = state.items.find((i) => i.id === finished.itemId);
      if (!item) return;
      if (finished.mode === "move") {
        item.start = finished.previewStart;
        item.trackId = finished.targetTrackId;
      } else if (finished.mode === "trim-left") {
        item.sourceIn = finished.previewSourceIn;
        item.start = finished.previewStart;
        item.duration = (item.sourceOut - item.sourceIn) / item.speed;
      } else if (finished.mode === "trim-right") {
        item.sourceOut = finished.previewSourceOut;
        item.duration = (item.sourceOut - item.sourceIn) / item.speed;
      }
    });
  };

  const displayItem = (item: TimelineItem): TimelineItem => {
    if (!drag || drag.isCaption || drag.itemId !== item.id) return item;
    if (drag.mode === "move") return { ...item, start: drag.previewStart, trackId: drag.targetTrackId };
    if (drag.mode === "trim-left") {
      return {
        ...item,
        start: drag.previewStart,
        sourceIn: drag.previewSourceIn,
        duration: (item.sourceOut - drag.previewSourceIn) / item.speed,
      };
    }
    if (drag.mode === "trim-right") {
      return { ...item, sourceOut: drag.previewSourceOut, duration: (drag.previewSourceOut - item.sourceIn) / item.speed };
    }
    return item;
  };

  const itemClass = (kind: string): string => {
    switch (kind) {
      case "broll":
        return styles.tlItemBroll;
      case "overlay":
        return styles.tlItemOverlay;
      case "audio":
        return styles.tlItemAudio;
      default:
        return "";
    }
  };

  const ticks: number[] = [];
  const tickEvery = pxPerSec >= 24 ? 1 : pxPerSec >= 8 ? 5 : 10;
  for (let t = 0; t <= duration; t += tickEvery) ticks.push(t);

  return (
    <div className={styles.timelinePanel}>
      <div className={styles.timelineToolbar}>
        <strong>Timeline</strong>
        <span className={styles.small}>Drag to move · drag edges to trim · click the ruler to seek</span>
        <span className={styles.toolbarSpacer} />
        <button type="button" className={styles.miniButton} onClick={() => setPxPerSec((v) => Math.max(2, v / 1.5))} aria-label="Zoom out">
          −
        </button>
        <span className={styles.small}>{pxPerSec.toFixed(0)} px/s</span>
        <button type="button" className={styles.miniButton} onClick={() => setPxPerSec((v) => Math.min(120, v * 1.5))} aria-label="Zoom in">
          +
        </button>
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={doc.settings.snapEnabled}
            onChange={(e) =>
              onCommit("settings_update", (state) => {
                state.settings.snapEnabled = e.target.checked;
              })
            }
          />
          Snapping
        </label>
        <label className={styles.checkRow}>
          <select
            value={addKind}
            onChange={(e) => setAddKind(e.target.value)}
            aria-label="Track type to add"
          >
            {ADDABLE_TRACKS.map((t) => (
              <option key={t.kind} value={t.kind}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className={styles.miniButton}
          disabled={doc.tracks.length >= 12}
          title={doc.tracks.length >= 12 ? "The timeline already has the maximum of 12 tracks." : "Add an empty track"}
          onClick={() => {
            const base = ADDABLE_TRACKS.find((t) => t.kind === addKind) ?? ADDABLE_TRACKS[0];
            const count = doc.tracks.filter((t) => t.kind === base.kind).length;
            const order = doc.tracks.reduce((m, t) => Math.max(m, t.order), -1) + 1;
            onCommit("track_add", (state) => {
              state.tracks.push({
                id: crypto.randomUUID(),
                // Server kind value ("caption", not the client type's
                // legacy "captions" spelling) so the state validates.
                kind: base.kind as TimelineTrack["kind"],
                label: `${base.label} ${count + 1}`,
                order,
                locked: false,
                visible: true,
                muted: false,
                solo: false,
              });
            });
          }}
        >
          Add track
        </button>
      </div>
      <div className={styles.timelineScroll} ref={scrollRef}>
        <div className={styles.timelineInner} style={{ width: widthPx + 148 }}>
          <div
            className={styles.ruler}
            style={{ width: widthPx }}
            onPointerDown={(e) => {
              onSeek(timeFromClientX(e.clientX));
              const move = (ev: PointerEvent) => onSeek(timeFromClientX(ev.clientX));
              const up = () => {
                window.removeEventListener("pointermove", move);
                window.removeEventListener("pointerup", up);
              };
              window.addEventListener("pointermove", move);
              window.addEventListener("pointerup", up);
            }}
            role="slider"
            aria-label="Seek"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            aria-valuenow={Math.round(playhead)}
          >
            {ticks.map((t) => (
              <span key={t} className={styles.rulerTick} style={{ left: t * pxPerSec }}>
                {formatClock(t)}
              </span>
            ))}
          </div>
          <div ref={lanesRef}>
            {tracks.map((track) => {
              const isCaptionKindTrack = isCaptionKind(track.kind);
              const showsCaptions = isCaptionKindTrack && track.id === firstCaptionTrackId;
              const rowItems = isCaptionKindTrack
                ? []
                : doc.items.filter((i) => (displayItem(i).trackId === track.id)).map(displayItem);
              // Remove-track eligibility mirrors the server's
              // track_remove guards (empty only, never the last
              // track, never the only caption/main track).
              const removeBlockReason: string | null =
                doc.tracks.length <= 1
                  ? "The last track cannot be removed."
                  : track.locked
                    ? "Unlock the track to remove it."
                    : doc.items.some((i) => i.trackId === track.id)
                      ? "Only an empty track can be removed — move or delete its clips first."
                      : isCaptionKind(track.kind) &&
                          doc.tracks.filter((t) => isCaptionKind(t.kind)).length <= 1
                        ? "The last caption track cannot be removed."
                        : track.kind === "main" &&
                            doc.tracks.filter((t) => t.kind === "main").length <= 1
                          ? "The timeline needs a main video track."
                          : null;
              return (
                <div key={track.id} className={styles.trackRow} style={{ height: TRACK_HEIGHT[track.kind] ?? 52 }}>
                  <div className={styles.trackHeader}>
                    <span className={styles.trackLabel}>{track.label}</span>
                    <span className={styles.trackButtons}>
                      <button
                        type="button"
                        className={`${styles.trackToggle} ${track.locked ? styles.trackToggleOn : ""}`}
                        onClick={() => onTrackPatch(track.id, { locked: !track.locked }, "track")}
                        aria-pressed={track.locked}
                        title="Lock track"
                      >
                        Lock
                      </button>
                      {(track.kind === "main" || track.kind === "broll" || track.kind === "overlay") && (
                        <button
                          type="button"
                          className={`${styles.trackToggle} ${track.visible ? styles.trackToggleBlueOn : ""}`}
                          onClick={() => onTrackPatch(track.id, { visible: !track.visible }, "track")}
                          aria-pressed={track.visible}
                          title="Toggle visibility"
                        >
                          Eye
                        </button>
                      )}
                      {(track.kind === "main" || track.kind === "broll" || track.kind === "audio" || track.kind === "overlay") && (
                        <>
                          <button
                            type="button"
                            className={`${styles.trackToggle} ${track.muted ? styles.trackToggleOn : ""}`}
                            onClick={() => onTrackPatch(track.id, { muted: !track.muted }, "track")}
                            aria-pressed={track.muted}
                            title="Mute track"
                          >
                            Mute
                          </button>
                          <button
                            type="button"
                            className={`${styles.trackToggle} ${track.solo ? styles.trackToggleOn : ""}`}
                            onClick={() => onTrackPatch(track.id, { solo: !track.solo }, "track")}
                            aria-pressed={track.solo}
                            title="Solo track"
                          >
                            Solo
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        className={styles.trackToggle}
                        disabled={removeBlockReason !== null}
                        title={removeBlockReason ?? "Remove this empty track"}
                        onClick={() =>
                          onCommit("track_remove", (state) => {
                            state.tracks = state.tracks.filter((t) => t.id !== track.id);
                          })
                        }
                      >
                        Remove
                      </button>
                    </span>
                  </div>
                  <div
                    className={`${styles.lane} ${isCaptionKindTrack ? styles.laneCaptions : ""} ${!track.visible && !isCaptionKindTrack ? styles.laneHidden : ""} ${track.locked ? styles.laneLocked : ""}`}
                    data-track-id={track.id}
                    style={{ width: widthPx }}
                  >
                    {showsCaptions
                      ? doc.captions.map((caption) => {
                          const shown =
                            drag?.isCaption && drag.itemId === caption.id
                              ? { ...caption, start: drag.previewStart, end: drag.previewStart + (caption.end - caption.start) }
                              : caption;
                          return (
                            <div
                              key={caption.id}
                              className={`${styles.tlItem} ${styles.tlItemCaption} ${selection?.kind === "caption" && selection.id === caption.id ? styles.tlItemSelected : ""}`}
                              style={{ left: shown.start * pxPerSec, width: Math.max(14, (shown.end - shown.start) * pxPerSec) }}
                              onPointerDown={(e) => beginDrag(e, "caption-move", null, caption.id)}
                              title={caption.text}
                            >
                              {caption.text}
                            </div>
                          );
                        })
                      : rowItems.map((item) => {
                          const info = assetInfo(item, library);
                          const trackMuted = track.muted;
                          return (
                            <div
                              key={item.id}
                              className={`${styles.tlItem} ${itemClass(track.kind)} ${selection?.kind === "item" && selection.id === item.id ? styles.tlItemSelected : ""} ${trackMuted ? styles.tlItemMuted : ""}`}
                              style={{ left: item.start * pxPerSec, width: Math.max(16, item.duration * pxPerSec) }}
                              onPointerDown={(e) => beginDrag(e, "move", doc.items.find((i) => i.id === item.id) ?? item, null)}
                              title={`${info.label} · ${formatClock(item.start)}–${formatClock(item.start + item.duration)}${info.hasAudio ? "" : " · no audio"}`}
                            >
                              <span
                                className={`${styles.trimHandle} ${styles.trimHandleLeft}`}
                                onPointerDown={(e) => {
                                  e.stopPropagation();
                                  beginDrag(e, "trim-left", doc.items.find((i) => i.id === item.id) ?? item, null);
                                }}
                              />
                              {info.label}
                              <span
                                className={`${styles.trimHandle} ${styles.trimHandleRight}`}
                                onPointerDown={(e) => {
                                  e.stopPropagation();
                                  beginDrag(e, "trim-right", doc.items.find((i) => i.id === item.id) ?? item, null);
                                }}
                              />
                            </div>
                          );
                        })}
                  </div>
                </div>
              );
            })}
          </div>
          <div className={styles.playhead} style={{ left: 148 + playhead * pxPerSec }} />
        </div>
      </div>
    </div>
  );
}
