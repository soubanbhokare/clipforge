// Phase 5 — composition preview. Plays the main-track composition
// from the existing preview/stream files (never full-res processing):
// the playhead advances through items in timeline order, switching
// the <video> source / in-out per item and applying per-item volume,
// speed, fades and transforms, scene overrides, the caption overlay,
// a muted b-roll layer and the music track's <audio> element.
//
// Playback state is local to this component: the clock runs on
// requestAnimationFrame and only reports the playhead up (throttled),
// so the rest of the editor does not re-render per frame.
//
// Phase 6: the caption overlay renders the document's REAL caption
// style (the same object the server feeds to libass) — font, colours,
// highlight/karaoke word states from genuine word timestamps,
// position + margins, casing and line wrapping. Dragging the caption
// sets a custom position that the render preserves exactly.
//
// Phase 7: when the page supplies the document's reframe state and
// it is enabled for the clip under the playhead, the persisted crop
// path crops the main video inside the frame (see reframeCropAtTime
// and the wrapper below), so the preview shows the same framing
// the reframe render produces.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  assetInfo,
  formatClock,
  resolvePlayback,
  timelineDuration,
  type CaptionSegment,
  type EditorDocument,
  type EditorLibrary,
  type ItemTransform,
  type TimelineItem,
} from "../../services/editor";
import {
  applyCasing,
  wrapLines,
  wrapWords,
  type CaptionStyleConfig,
} from "../../services/captions";
import type { NormBox, ReframeState, TrackingKeyframe } from "../../services/tracking";
import styles from "../../pages/studio/Editor.module.css";

interface Props {
  doc: EditorDocument;
  library: EditorLibrary;
  /** Phase 7: the document's reframe state (owned/polled by the
   *  editor page). When its config is enabled and the active main
   *  item plays the analysed source, the persisted crop path crops
   *  the preview exactly as the render does. Null = not loaded /
   *  no reframe — rendering is then unchanged. */
  reframe?: ReframeState | null;
  playhead: number;
  onPlayheadChange: (t: number) => void;
  onSelectItem: (itemId: string | null) => void;
  onToggleCaptions: () => void;
  onToggleGuides: () => void;
  /** Phase 6: caption dragged to a custom position (fractions 0–1). */
  onCaptionCustomPosition: (x: number, y: number) => void;
}

const FRAME_STEP = 1 / 30;

/**
 * Phase 7: the framing the persisted reframe path specifies at a
 * source time. The keyframes are dense per-sample points of an
 * already-smoothed path (manual keyframes, the manual-crop
 * rectangle, pause and fit mode are all folded into them by the
 * server), so between two bracketing keyframes the box is linearly
 * interpolated; outside the sampled range the end keyframes are
 * held. A keyframe with crop === null is the "fit" framing (the
 * whole source fitted into the output, no crop) and cannot be
 * interpolated towards — the keyframe in effect wins.
 */
function reframeCropAtTime(
  keyframes: TrackingKeyframe[],
  time: number,
): { crop: NormBox | null; fit: "fill" | "fit" } | null {
  if (keyframes.length === 0) return null;
  let prev: TrackingKeyframe | null = null;
  let next: TrackingKeyframe | null = null;
  for (const kf of keyframes) {
    if (kf.t <= time) prev = kf;
    else {
      next = kf;
      break;
    }
  }
  if (!prev) return { crop: keyframes[0]!.crop, fit: keyframes[0]!.fit };
  if (!next) return { crop: prev.crop, fit: prev.fit };
  if (prev.crop && next.crop && next.t > prev.t) {
    const a = Math.min(1, Math.max(0, (time - prev.t) / (next.t - prev.t)));
    const lerp = (u: number, v: number) => u + (v - u) * a;
    return {
      crop: {
        x: lerp(prev.crop.x, next.crop.x),
        y: lerp(prev.crop.y, next.crop.y),
        w: lerp(prev.crop.w, next.crop.w),
        h: lerp(prev.crop.h, next.crop.h),
      },
      fit: prev.fit,
    };
  }
  return { crop: prev.crop, fit: prev.fit };
}

function fadeGain(item: TimelineItem, playhead: number): number {
  const pos = playhead - item.start;
  let gain = 1;
  if (item.fadeIn > 0.01) gain = Math.min(gain, Math.max(0, pos / item.fadeIn));
  const remaining = item.duration - pos;
  if (item.fadeOut > 0.01) gain = Math.min(gain, Math.max(0, remaining / item.fadeOut));
  return gain;
}

/** Tracks that carry sound, for mute/solo resolution. */
function audibleTracks(doc: EditorDocument): Set<string> {
  const soundKinds = new Set(["main", "broll", "audio", "overlay"]);
  const sound = doc.tracks.filter((t) => soundKinds.has(t.kind));
  const anySolo = sound.some((t) => t.solo);
  const audible = new Set<string>();
  for (const track of sound) {
    if (anySolo ? track.solo : !track.muted) audible.add(track.id);
  }
  return audible;
}

export default function PreviewCanvas({
  doc,
  library,
  reframe,
  playhead,
  onPlayheadChange,
  onSelectItem,
  onToggleCaptions,
  onToggleGuides,
  onCaptionCustomPosition,
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const brollRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  // Centre guide lines have their own toggle, independent of the
  // safe-area guides. The local override starts unset: the effective
  // value then follows the document setting, which itself defaults
  // to the showGuides behaviour for documents that never set it.
  const [centerGuidesOverride, setCenterGuidesOverride] = useState<boolean | null>(null);
  const [fsNote, setFsNote] = useState<string | null>(null);
  const centerGuidesOn = centerGuidesOverride ?? doc.settings.centerGuides ?? doc.settings.showGuides;
  const playheadRef = useRef(playhead);
  playheadRef.current = playhead;
  const playingRef = useRef(playing);
  playingRef.current = playing;
  // The last playhead value the rAF clock itself produced. A prop
  // value that differs from it did not come from playback — it is an
  // external seek (timeline scrub, inspector field, step buttons)
  // and the media elements must be moved to match (see below).
  const clockRef = useRef(playhead);
  const lastReportRef = useRef(0);

  const duration = timelineDuration(doc);
  const tracksById = useMemo(() => new Map(doc.tracks.map((t) => [t.id, t])), [doc.tracks]);
  const mainTrack = doc.tracks.find((t) => t.kind === "main");
  const brollTrack = doc.tracks.find((t) => t.kind === "broll");
  const overlayTrack = doc.tracks.find((t) => t.kind === "overlay");
  const audioTrack = doc.tracks.find((t) => t.kind === "audio");

  const mainItems = useMemo(
    () =>
      doc.items
        .filter((i) => i.trackId === mainTrack?.id)
        .sort((a, b) => a.start - b.start || a.layerOrder - b.layerOrder),
    [doc.items, mainTrack?.id],
  );
  // The reframe path is consumed in time order; the API returns it
  // ordered, but sort defensively before interpolating.
  const reframeKeyframes = useMemo(
    () => [...(reframe?.keyframes ?? [])].sort((a, b) => a.t - b.t),
    [reframe],
  );
  const activeMain: TimelineItem | null =
    mainItems.find((i) => playhead >= i.start && playhead < i.start + i.duration) ?? null;
  const activeBroll: TimelineItem | null =
    doc.items.find(
      (i) =>
        (i.trackId === brollTrack?.id || i.trackId === overlayTrack?.id) &&
        playhead >= i.start &&
        playhead < i.start + i.duration,
    ) ?? null;
  const activeMusic: TimelineItem | null =
    doc.items.find(
      (i) => i.trackId === audioTrack?.id && playhead >= i.start && playhead < i.start + i.duration,
    ) ?? null;
  const activeCaption = doc.settings.showCaptions
    ? doc.captions.find((c) => playhead >= c.start && playhead < c.end) ?? null
    : null;

  const mainPlayback = activeMain ? resolvePlayback(activeMain, library) : null;
  const brollPlayback = activeBroll ? resolvePlayback(activeBroll, library) : null;
  const musicPlayback = activeMusic ? resolvePlayback(activeMusic, library) : null;
  const audible = audibleTracks(doc);
  const mainHidden = mainTrack ? !mainTrack.visible : false;

  // ---- Source switching: when the resolved file changes, load it
  // and seek to the position that matches the playhead.
  const mainKey = activeMain && mainPlayback ? `${activeMain.id}|${mainPlayback.url}` : "";
  const mainKeyRef = useRef("");
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !activeMain || !mainPlayback) return;
    if (mainKeyRef.current !== mainKey) {
      mainKeyRef.current = mainKey;
      if (video.getAttribute("src") !== mainPlayback.url) video.src = mainPlayback.url;
      const target = mainPlayback.fileStart + (playheadRef.current - activeMain.start) * activeMain.speed;
      const apply = () => {
        video.currentTime = Math.max(0, target);
        // Never start playback on a source switch while the
        // transport is paused — load paused and wait for Play.
        if (playingRef.current) void video.play().catch(() => undefined);
      };
      if (video.readyState >= 1) apply();
      else video.addEventListener("loadedmetadata", apply, { once: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mainKey]);

  const brollKey = activeBroll && brollPlayback?.hasVideo ? `${activeBroll.id}|${brollPlayback.url}` : "";
  const brollKeyRef = useRef("");
  useEffect(() => {
    const video = brollRef.current;
    if (!video || !activeBroll || !brollPlayback?.hasVideo) return;
    if (brollKeyRef.current !== brollKey) {
      brollKeyRef.current = brollKey;
      if (video.getAttribute("src") !== brollPlayback.url) video.src = brollPlayback.url;
      const target = brollPlayback.fileStart + (playheadRef.current - activeBroll.start) * activeBroll.speed;
      const apply = () => {
        video.currentTime = Math.max(0, target);
        if (playingRef.current) void video.play().catch(() => undefined);
      };
      if (video.readyState >= 1) apply();
      else video.addEventListener("loadedmetadata", apply, { once: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brollKey]);

  const musicKey = activeMusic && musicPlayback ? `${activeMusic.id}|${musicPlayback.url}` : "";
  const musicKeyRef = useRef("");
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !activeMusic || !musicPlayback) return;
    if (musicKeyRef.current !== musicKey) {
      musicKeyRef.current = musicKey;
      if (audio.getAttribute("src") !== musicPlayback.url) audio.src = musicPlayback.url;
      const target = musicPlayback.fileStart + (playheadRef.current - activeMusic.start) * activeMusic.speed;
      const apply = () => {
        audio.currentTime = Math.max(0, target);
        if (playingRef.current) void audio.play().catch(() => undefined);
      };
      if (audio.readyState >= 1) apply();
      else audio.addEventListener("loadedmetadata", apply, { once: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [musicKey]);

  // ---- Transport state -> media elements.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !activeMain) return;
    // Per-item effective rate: the transport speed multiplies the
    // item's own speed — the same product the clock's source-time
    // mapping divides back out, so layers cannot drift apart.
    video.playbackRate = speed * activeMain.speed;
    const shouldPlay = playing && !mainHidden;
    if (shouldPlay) void video.play().catch(() => undefined);
    else video.pause();
    // Item volume & fades, resolved through mute/solo.
    const track = activeMain ? tracksById.get(activeMain.trackId) : undefined;
    const trackAudible = track ? audible.has(track.id) : false;
    video.muted = !trackAudible;
    video.volume = Math.min(1, Math.max(0, activeMain.volume * fadeGain(activeMain, playhead)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, speed, activeMain?.id, playhead, mainHidden]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!activeMusic || !musicPlayback) {
      audio.pause();
      return;
    }
    audio.playbackRate = speed * activeMusic.speed;
    const track = tracksById.get(activeMusic.trackId);
    audio.muted = track ? !audible.has(track.id) : true;
    audio.volume = Math.min(1, Math.max(0, activeMusic.volume * fadeGain(activeMusic, playhead)));
    if (playing) void audio.play().catch(() => undefined);
    else audio.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, speed, activeMusic?.id, playhead]);

  useEffect(() => {
    const video = brollRef.current;
    if (!video) return;
    video.muted = true; // b-roll layer is visual in the preview; its audio stays in the render
    video.playbackRate = activeBroll ? speed * activeBroll.speed : speed;
    if (activeBroll && playing) void video.play().catch(() => undefined);
    else video.pause();
  }, [playing, speed, activeBroll?.id, activeBroll?.speed]);

  // ---- External seeks: the transport effects above mirror
  // play/pause/rate/volume only, so when the playhead prop moves
  // WITHOUT the clock producing the move (timeline scrub, inspector
  // seek, another panel), the elements must be repositioned —
  // otherwise the picture stays on the old frame while every other
  // part of the editor shows the new playhead. Clock-produced
  // values are recognised through clockRef and skipped.
  const seekElement = (el: HTMLMediaElement | null, target: number) => {
    if (!el) return;
    const t = Math.max(0, target);
    if (el.readyState >= 1) el.currentTime = t;
    else el.addEventListener("loadedmetadata", () => { el.currentTime = t; }, { once: true });
  };
  useEffect(() => {
    if (Math.abs(playhead - clockRef.current) <= 0.05) return;
    clockRef.current = playhead;
    if (activeMain && mainPlayback) {
      seekElement(videoRef.current, mainPlayback.fileStart + (playhead - activeMain.start) * activeMain.speed);
    }
    if (activeBroll && brollPlayback?.hasVideo) {
      seekElement(brollRef.current, brollPlayback.fileStart + (playhead - activeBroll.start) * activeBroll.speed);
    }
    if (activeMusic && musicPlayback) {
      seekElement(audioRef.current, musicPlayback.fileStart + (playhead - activeMusic.start) * activeMusic.speed);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playhead]);

  // ---- The clock: follow the main video element; advance through
  // gaps and across item boundaries.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let lastTs: number | null = null;
    const tick = (ts: number) => {
      const video = videoRef.current;
      const current = mainItems.find(
        (i) => playheadRef.current >= i.start && playheadRef.current < i.start + i.duration,
      );
      let next: number | null = null;
      // True when the playhead sits on a main item whose element owns
      // the clock but cannot advance it (play() rejected, element
      // stalled): the playhead then HOLDS instead of fabricating
      // motion the media is not making.
      let elementBlocked = false;
      if (current && video && mainKeyRef.current) {
        const playback = resolvePlayback(current, library);
        if (playback?.hasVideo) {
          if (!video.paused && !video.ended) {
            // Follow the element: currentTime advances at the
            // effective rate (transport speed × item speed, set by
            // the transport effect); dividing by the item speed maps
            // source time back to timeline time at the transport
            // speed — the two stay in lock-step.
            next = current.start + (video.currentTime - playback.fileStart) / current.speed;
            if (next >= current.start + current.duration - 0.02) {
              const following = mainItems.find((i) => i.start >= current.start + current.duration - 0.001);
              next = following ? following.start : current.start + current.duration;
              if (!following) {
                clockRef.current = Math.min(next, duration);
                setPlaying(false);
                onPlayheadChange(Math.min(next, duration));
                return;
              }
            }
          } else if (video.ended) {
            const following = mainItems.find((i) => i.start >= current.start + current.duration - 0.001);
            next = following ? following.start : current.start + current.duration;
            if (!following) {
              clockRef.current = Math.min(next, duration);
              setPlaying(false);
              onPlayheadChange(Math.min(next, duration));
              return;
            }
          } else {
            elementBlocked = true;
          }
        }
      }
      if (next === null && !elementBlocked) {
        // Gap (no main item under the playhead, or the item has no
        // previewable video): advance by the REAL elapsed time
        // between frames — never a fixed per-tick step, which made
        // the rate depend on the display's refresh rate. The step is
        // clamped so returning to a hidden tab cannot teleport.
        const dt = lastTs === null ? 0 : Math.min(0.1, Math.max(0, (ts - lastTs) / 1000));
        const stepped = playheadRef.current + dt * speed;
        next = stepped;
        const following = mainItems.find(
          (i) => i.start >= stepped - 0.001 && i.start <= stepped + Math.max(dt * speed, 0.001),
        );
        if (following) next = following.start;
        if (next >= duration) {
          clockRef.current = duration;
          setPlaying(false);
          onPlayheadChange(duration);
          return;
        }
      }
      lastTs = ts;
      if (next !== null) {
        clockRef.current = next;
        const now = performance.now();
        if (now - lastReportRef.current > 90 || Math.abs(next - playheadRef.current) > 0.5) {
          lastReportRef.current = now;
          onPlayheadChange(next);
        } else {
          playheadRef.current = next;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, speed, mainItems, duration]);

  const seek = (t: number) => {
    const clamped = Math.min(Math.max(0, t), duration);
    clockRef.current = clamped; // own seek — not an external one
    onPlayheadChange(clamped);
    // Force the media elements to the new position.
    mainKeyRef.current = "";
    brollKeyRef.current = "";
    musicKeyRef.current = "";
    const item = mainItems.find((i) => clamped >= i.start && clamped < i.start + i.duration);
    const video = videoRef.current;
    if (item && video) {
      const playback = resolvePlayback(item, library);
      if (playback) {
        if (video.getAttribute("src") !== playback.url) video.src = playback.url;
        video.currentTime = playback.fileStart + (clamped - item.start) * item.speed;
      }
    }
  };

  // ---- Transform: item default, scene override wins inside a scene.
  const effectiveTransform = (item: TimelineItem | null): ItemTransform => {
    if (!item) return { crop: null, x: 0, y: 0, scale: 1, zoom: 1, rotation: 0, fit: "fill" };
    const merged: ItemTransform = { ...item.transform };
    const sourcePos = item.sourceIn + (playhead - item.start) * item.speed;
    const sourceAssetId =
      item.assetKind === "candidate"
        ? (library.candidates.find((c) => c.id === item.assetId)?.sourceAssetId ?? null)
        : item.assetKind === "source"
          ? item.assetId
          : null;
    if (sourceAssetId && sourceAssetId === library.transcriptSourceAssetId) {
      const override = doc.sceneOverrides.find((o) => sourcePos >= o.rangeStart && sourcePos < o.rangeEnd);
      if (override) {
        const t = override.overrides;
        if (t.crop !== undefined) merged.crop = t.crop;
        if (t.x !== undefined) merged.x = t.x;
        if (t.y !== undefined) merged.y = t.y;
        if (t.scale !== undefined) merged.scale = t.scale;
        if (t.zoom !== undefined) merged.zoom = t.zoom;
        if (t.rotation !== undefined) merged.rotation = t.rotation;
        if (t.fit !== undefined) merged.fit = t.fit;
      }
    }
    return merged;
  };

  const transform = effectiveTransform(activeMain);

  // ---- Phase 7 reframe crop: when the reframe config is enabled
  // and the active main item plays the analysed source, the
  // persisted crop path (the same keyframes the reframe render
  // consumes) crops the preview. The mapping is the Inspector's
  // sourceTimeAtPlayhead mapping: through the main item under the
  // playhead, in the item's own source time. Split Screen has no
  // single-crop output — its layout is a separate composition — so
  // it is never faked as one crop here.
  const reframeConfig = reframe?.config ?? null;
  let reframeBox: NormBox | null = null;
  let reframeFit = false;
  if (reframe && reframeConfig?.enabled && reframeConfig.mode !== "split-screen" && activeMain) {
    const sourceAssetId =
      activeMain.assetKind === "candidate"
        ? (library.candidates.find((c) => c.id === activeMain.assetId)?.sourceAssetId ?? null)
        : activeMain.assetKind === "source"
          ? activeMain.assetId
          : null;
    if (sourceAssetId !== null && reframe.sourceAsset?.id === sourceAssetId) {
      const sourceTime = activeMain.sourceIn + (playhead - activeMain.start) * activeMain.speed;
      const at = reframeCropAtTime(reframeKeyframes, sourceTime);
      if (at) {
        reframeBox = at.crop && at.crop.w > 0.005 && at.crop.h > 0.005 ? at.crop : null;
        // crop === null with fit "fit" is the path's whole-frame
        // framing: the source is fitted into the output, not cropped.
        reframeFit = at.crop === null && at.fit === "fit";
      } else if (reframeConfig.fitMode === "manual-crop" && reframeConfig.manualCrop) {
        // No keyframes exist yet (tracking never ran): the only
        // framing the config truthfully specifies is the stored
        // manual-crop rectangle — the same constant crop the
        // server's path builder applies for this fit mode.
        reframeBox = reframeConfig.manualCrop;
      }
    }
  }
  // The crop is applied by scaling/translating an inner wrapper
  // around the video (the technique the ReframePanel's own output
  // preview uses): the wrapper is sized to the full source and
  // offset so exactly the crop window lands on the frame, and the
  // frame's overflow clips the rest. With no crop the wrapper is
  // exactly the frame, so rendering is unchanged.
  const reframeWrapStyle: React.CSSProperties = reframeBox
    ? {
        position: "absolute",
        width: `${100 / Math.max(reframeBox.w, 0.01)}%`,
        height: `${100 / Math.max(reframeBox.h, 0.01)}%`,
        left: `${-(reframeBox.x / Math.max(reframeBox.w, 0.01)) * 100}%`,
        top: `${-(reframeBox.y / Math.max(reframeBox.h, 0.01)) * 100}%`,
      }
    : { position: "absolute", inset: 0 };

  const videoStyle: React.CSSProperties = {
    // With a reframe crop the wrapper already carries the source's
    // framing, and the render crops + scales to the output — so the
    // video fills the wrapper exactly ("fill"). On the path's "fit"
    // framing the whole source is letterboxed ("contain").
    objectFit: reframeBox
      ? "fill"
      : reframeFit
        ? "contain"
        : transform.fit === "fill"
          ? "cover"
          : "contain",
    transform: `translate(${transform.x * 100}%, ${transform.y * 100}%) scale(${transform.scale * transform.zoom}) rotate(${transform.rotation}deg)`,
    clipPath: transform.crop
      ? `inset(${transform.crop.y * 100}% ${(1 - transform.crop.x - transform.crop.w) * 100}% ${(1 - transform.crop.y - transform.crop.h) * 100}% ${transform.crop.x * 100}%)`
      : undefined,
  };

  const canvas = doc.canvas;
  const frameStyle: React.CSSProperties = {
    aspectRatio: `${canvas.width} / ${canvas.height}`,
    height: canvas.height >= canvas.width ? 380 : undefined,
    width: canvas.height >= canvas.width ? undefined : "100%",
    maxHeight: 420,
  };
  if (canvas.width > canvas.height) frameStyle.height = undefined;

  const mainInfo = activeMain ? assetInfo(activeMain, library) : null;

  return (
    <div className={styles.previewPanel}>
      <div className={styles.stage} ref={stageRef}>
        <div className={styles.frame} style={frameStyle}>
          {!mainHidden && mainPlayback?.hasVideo ? (
            <div className={styles.frameVideoWrap}>
              <div style={reframeWrapStyle}>
                <video
                  ref={videoRef}
                  className={styles.frameVideo}
                  style={videoStyle}
                  playsInline
                  preload="auto"
                  onClick={() => activeMain && onSelectItem(activeMain.id)}
                />
              </div>
            </div>
          ) : null}
          {brollPlayback?.hasVideo && activeBroll ? (
            <video ref={brollRef} className={styles.brollVideo} playsInline preload="auto" muted />
          ) : null}
          {!activeMain && <div className={styles.gapNotice}>No clip at the playhead</div>}
          {mainHidden && <div className={styles.gapNotice}>Main track hidden</div>}
          {doc.settings.showGuides && <div className={styles.guideSafe} />}
          {centerGuidesOn && (
            <>
              <div className={styles.guideCenterV} />
              <div className={styles.guideCenterH} />
            </>
          )}
          {doc.settings.safeZones && (
            <>
              <div className={styles.safeZoneTitle} />
              <div className={styles.safeZoneCaption}>
                <span>Caption safe zone</span>
              </div>
            </>
          )}
          {activeCaption && (
            <CaptionOverlay
              caption={activeCaption}
              docStyle={doc.settings.captionStyle}
              canvasWidth={canvas.width}
              playhead={playhead}
              onDrag={onCaptionCustomPosition}
            />
          )}
        </div>
      </div>
      <audio ref={audioRef} preload="auto" />
      <div className={styles.transport}>
        <button type="button" className={styles.toolButton} onClick={() => seek(playhead - FRAME_STEP)} aria-label="Step back one frame">
          ◂|
        </button>
        <button
          type="button"
          className={styles.toolButton}
          onClick={() => {
            if (!playing && playhead >= duration) seek(0);
            setPlaying(!playing);
          }}
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? "❚❚ Pause" : "▶ Play"}
        </button>
        <button type="button" className={styles.toolButton} onClick={() => seek(playhead + FRAME_STEP)} aria-label="Step forward one frame">
          |▸
        </button>
        <span className={styles.transportTime}>
          {formatClock(playhead)} / {formatClock(duration)}
        </span>
        <label className={styles.small}>
          Speed{" "}
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Playback speed">
            {[0.25, 0.5, 1, 1.5, 2].map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className={styles.toolButton}
          onClick={onToggleCaptions}
          aria-pressed={doc.settings.showCaptions}
        >
          Captions {doc.settings.showCaptions ? "on" : "off"}
        </button>
        <button
          type="button"
          className={styles.toolButton}
          onClick={onToggleGuides}
          aria-pressed={doc.settings.showGuides}
        >
          Guides {doc.settings.showGuides ? "on" : "off"}
        </button>
        <button
          type="button"
          className={styles.toolButton}
          onClick={() => setCenterGuidesOverride(!centerGuidesOn)}
          aria-pressed={centerGuidesOn}
        >
          Centre guides {centerGuidesOn ? "on" : "off"}
        </button>
        <button
          type="button"
          className={styles.toolButton}
          onClick={() => {
            const el = stageRef.current;
            if (el && document.fullscreenElement) void document.exitFullscreen();
            else if (el) {
              void el
                .requestFullscreen()
                .then(() => setFsNote(null))
                .catch(() =>
                  setFsNote(
                    "Fullscreen was blocked — the browser or this viewer denied it, so the preview stays inline.",
                  ),
                );
            }
          }}
        >
          Fullscreen
        </button>
      </div>
      {fsNote && (
        <p className={styles.muted} role="status">
          {fsNote}
        </p>
      )}
      <p className={styles.muted} aria-live="polite">
        {activeMain
          ? `Now previewing: ${mainInfo?.label ?? "clip"} (${formatClock(activeMain.start)}–${formatClock(activeMain.start + activeMain.duration)})${mainInfo && !mainInfo.hasAudio ? " · no audio in source" : ""}`
          : "Move the playhead onto a main-track clip to preview it."}
      </p>
    </div>
  );
}

// ---- Phase 6 styled caption overlay -------------------------------------

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * Renders one caption with the document's caption style — the same
 * style object the server turns into ASS for the burn-in render, so
 * preview placement/styling matches the exported video. Word states
 * come from the caption's genuine word timestamps. Without word
 * timestamps the preview degrades exactly like the renderer: karaoke
 * becomes one whole-cue sweep, word-reveal and highlight become a
 * whole-line fade, and keyword emphasis a plain line — per-word
 * progression is only ever shown for genuine word timings.
 */
function CaptionOverlay({
  caption,
  docStyle,
  canvasWidth,
  playhead,
  onDrag,
}: {
  caption: CaptionSegment;
  docStyle: CaptionStyleConfig;
  canvasWidth: number;
  playhead: number;
  onDrag: (x: number, y: number) => void;
}) {
  const style = caption.style ?? docStyle;
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(0.35);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    const parent = el?.parentElement;
    if (!parent) return;
    const update = () => setScale(parent.clientWidth / Math.max(1, canvasWidth));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [canvasWidth]);

  const segStart = caption.start;
  const segDur = Math.max(0.05, caption.end - caption.start);
  const words = caption.words;
  const hasWords = !!words && words.length > 0;

  const wordState = (index: number, total: number, w?: { start: number; end: number }) => {
    const start = w ? w.start : segStart + (index * segDur) / total;
    const end = w ? w.end : segStart + ((index + 1) * segDur) / total;
    return {
      active: playhead >= start && playhead < end,
      done: playhead >= end,
      revealed: playhead >= start - 0.02,
    };
  };

  const animationClass =
    style.animation === "fade"
      ? styles.captionAnimFade
      : style.animation === "pop"
        ? styles.captionAnimPop
        : style.animation === "slide-up"
          ? styles.captionAnimSlide
          : style.animation === "minimal"
            ? styles.captionAnimMinimal
            : undefined;

  // Without word timings the renderer fades the whole line for
  // word-reveal / highlight (\fad(150,120)); mirror that here.
  const overlayAnimClass =
    !hasWords && (style.animation === "word-reveal" || style.animation === "highlight")
      ? styles.captionAnimFade
      : animationClass;

  const renderWord = (
    text: string,
    key: string,
    state: { active: boolean; done: boolean; revealed: boolean },
    emphasized: boolean,
  ) => {
    const anim = style.animation;
    let color = style.textColor;
    if (emphasized) color = style.highlightColor;
    if ((anim === "highlight" || anim === "keyword-emphasis") && state.active) color = style.highlightColor;
    if (anim === "karaoke" && (state.active || state.done)) color = style.highlightColor;
    const hidden = anim === "word-reveal" && !state.revealed;
    return (
      <span
        key={key}
        style={{
          color,
          fontWeight: emphasized ? 800 : style.fontWeight,
          visibility: hidden ? "hidden" : "visible",
        }}
      >
        {text}{" "}
      </span>
    );
  };

  const lineStyle: React.CSSProperties = {
    background:
      style.backgroundOpacity > 0 ? hexToRgba(style.backgroundColor, style.backgroundOpacity) : "transparent",
    padding: style.backgroundOpacity > 0 ? "0.08em 0.3em" : undefined,
    borderRadius: "0.15em",
  };
  const textCss: React.CSSProperties = {
    fontFamily: `${style.fontFamily}, "Noto Sans Devanagari", sans-serif`,
    fontSize: Math.max(8, style.fontSize * scale),
    fontWeight: style.fontWeight,
    fontStyle: style.italic ? "italic" : "normal",
    letterSpacing: style.letterSpacing * scale,
    lineHeight: style.lineSpacing,
    textAlign: style.alignment,
    WebkitTextStroke: style.outlineWidth > 0 ? `${style.outlineWidth * scale}px ${style.outlineColor}` : undefined,
    textShadow:
      style.shadowDepth > 0
        ? `${style.shadowDepth * scale}px ${style.shadowDepth * scale}px 0 ${style.outlineColor}`
        : undefined,
  };

  let lines: React.ReactNode[];
  if (words && words.length > 0) {
    lines = wrapWords(words, style).map((lineWords, li) => (
      <div key={li} style={lineStyle}>
        {lineWords.map((w) =>
          renderWord(applyCasing(w.word, style.casing), `${li}-${w.start}`, wordState(words.indexOf(w), words.length, w), !!w.emphasized),
        )}
      </div>
    ));
  } else if (style.animation === "karaoke") {
    // No word timings: the renderer emits ONE \kf sweep across the
    // whole cue, so the preview colours the whole text as a single
    // unit over the segment duration. The gradient offset is just the
    // sweep front passing over the text — never per-word timing.
    const wrapped = wrapLines(applyCasing(caption.text, style.casing), style);
    const progress = Math.min(1, Math.max(0, (playhead - segStart) / segDur));
    const totalChars = Math.max(1, wrapped.reduce((n, l) => n + l.length, 0));
    let offset = 0;
    lines = wrapped.map((line, li) => {
      const lineFraction = line.length / totalChars;
      const local = lineFraction > 0 ? (progress - offset / totalChars) / lineFraction : 1;
      offset += line.length;
      const pct = Math.min(100, Math.max(0, local * 100));
      return (
        <div key={li} style={lineStyle}>
          <span
            style={{
              backgroundImage: `linear-gradient(90deg, ${style.highlightColor} ${pct}%, ${style.textColor} ${pct}%)`,
              WebkitBackgroundClip: "text",
              backgroundClip: "text",
              color: "transparent",
            }}
          >
            {line}
          </span>
        </div>
      );
    });
  } else {
    // No word timings: word-reveal, highlight and keyword-emphasis
    // degrade to whole-line rendering in the renderer too (a fade for
    // reveal/highlight via overlayAnimClass, a plain line for
    // emphasis), so the whole line is rendered as one unit here.
    lines = wrapLines(applyCasing(caption.text, style.casing), style).map((line, li) => (
      <div key={li} style={lineStyle}>
        {line}
      </div>
    ));
  }

  // ---- positioning (mirrors the ASS alignment/pos logic) ----
  const pos: React.CSSProperties = { position: "absolute", maxWidth: "92%", cursor: "grab", touchAction: "none" };
  const marginVpx = style.marginV * scale;
  const marginHpx = style.marginH * scale;
  const anchorX =
    style.alignment === "left" ? "0%" : style.alignment === "right" ? "-100%" : "-50%";
  const effective = dragPos ?? (style.position === "custom" ? { x: style.positionX, y: style.positionY } : null);
  if (effective) {
    pos.left = `${effective.x * 100}%`;
    pos.top = `${effective.y * 100}%`;
    pos.transform = `translate(${anchorX}, -50%)`;
  } else {
    switch (style.position) {
      case "top":
        pos.top = marginVpx;
        pos.left = "50%";
        pos.transform = "translateX(-50%)";
        break;
      case "upper-middle":
        // Renderer: top-row alignment with MarginV = 16% of the canvas
        // height, so the block's top edge sits 16% from the top —
        // anchored exactly like "top" above.
        pos.top = "16%";
        pos.left = "50%";
        pos.transform = "translateX(-50%)";
        break;
      case "center":
        pos.top = "50%";
        pos.left = "50%";
        pos.transform = "translate(-50%, -50%)";
        break;
      case "lower-middle":
        // Renderer: bottom-row alignment with MarginV = 16% of the
        // canvas height, so the block's bottom edge sits 16% from the
        // bottom — anchored exactly like "bottom" below.
        pos.bottom = "16%";
        pos.left = "50%";
        pos.transform = "translateX(-50%)";
        break;
      default:
        pos.bottom = marginVpx;
        pos.left = "50%";
        pos.transform = "translateX(-50%)";
        break;
    }
    if (style.alignment === "left") {
      pos.left = marginHpx;
      pos.transform = pos.transform?.replace("translateX(-50%)", "none").replace("translate(-50%, -50%)", "translateY(-50%)");
    } else if (style.alignment === "right") {
      pos.left = undefined;
      pos.right = marginHpx;
      pos.transform = pos.transform?.replace("translateX(-50%)", "none").replace("translate(-50%, -50%)", "translateY(-50%)");
    }
  }

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const parent = wrapRef.current?.parentElement;
    if (!parent) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const move = (ev: PointerEvent) => {
      const rect = parent.getBoundingClientRect();
      const x = Math.min(0.98, Math.max(0.02, (ev.clientX - rect.left) / rect.width));
      const y = Math.min(0.98, Math.max(0.02, (ev.clientY - rect.top) / rect.height));
      dragRef.current = { x, y };
      setDragPos({ x, y });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (dragRef.current) onDrag(dragRef.current.x, dragRef.current.y);
      dragRef.current = null;
      setDragPos(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      ref={wrapRef}
      className={`${styles.captionOverlayStyled} ${overlayAnimClass ?? ""}`}
      style={{ ...pos, ...textCss }}
      onPointerDown={handlePointerDown}
      title="Drag to reposition (saved as a custom position)"
      role="img"
      aria-label={`Caption: ${caption.text}`}
    >
      {lines}
    </div>
  );
}
