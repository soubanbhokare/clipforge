// Phase 5 — media library (left panel): the project's source asset,
// its Phase 4 generated clips, imported project media and uploaded
// audio. Every row can be added to a compatible timeline track; the
// add is a server operation like every other edit.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  editorApi,
  formatClock,
  type EditorDocument,
  type EditorLibrary,
} from "../../services/editor";
import { phase8Api, type LibraryAsset } from "../../services/phase8";
import styles from "../../pages/studio/Editor.module.css";

function formatBytes(bytes: number | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// DOM id for a row's inline delete-confirmation prompt, so the
// confirm button can reference it via aria-describedby.
function deleteConfirmId(ref: string): string {
  return `lib-delete-confirm-${ref.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

interface Props {
  projectId: string;
  doc: EditorDocument;
  library: EditorLibrary;
  onAddItem: (input: {
    assetKind: "source" | "candidate" | "media";
    assetId: string;
    trackKind: "main" | "broll" | "overlay" | "audio";
    sourceIn: number;
    sourceOut: number;
    duration: number | null;
  }) => void;
  onMediaUploaded: () => void;
}

type AddItemInput = Parameters<Props["onAddItem"]>[0];

function NoAudioBadge() {
  return <span className={`${styles.badge} ${styles.badgeWarn}`}>No audio</span>;
}

export default function MediaLibrary({ projectId, doc, library, onAddItem, onMediaUploaded }: Props) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);

  // Phase 8 §11 — full library browser: categories, search, sort,
  // per-asset metadata, usage tracking and safe deletion (every
  // delete needs an inline two-step confirmation; an asset used by
  // a timeline then warns via the server 409 and force delete cleans
  // the timeline items server-side; original project sources are
  // protected).
  const [libAssets, setLibAssets] = useState<LibraryAsset[]>([]);
  const [libCategories, setLibCategories] = useState<string[]>([]);
  const [libQuery, setLibQuery] = useState("");
  const [libCategory, setLibCategory] = useState("");
  const [libSort, setLibSort] = useState("newest");
  const [libError, setLibError] = useState<string | null>(null);
  const [forceRef, setForceRef] = useState<string | null>(null);
  const [previewRef, setPreviewRef] = useState<string | null>(null);
  // Ref of the row currently showing its inline delete confirmation
  // (null = none). A single value, so opening the confirmation on
  // another row moves it; loadLibrary clears it on every reload.
  const [confirmDeleteRef, setConfirmDeleteRef] = useState<string | null>(null);

  const loadLibrary = useCallback(async () => {
    // A reload replaces the rows, so any open delete confirmation
    // (which refers to the old row state) is dismissed.
    setConfirmDeleteRef(null);
    try {
      const res = await phase8Api.listLibrary({
        projectId,
        q: libQuery.trim() || undefined,
        category: libCategory || undefined,
        sort: libSort,
      });
      setLibAssets(res.assets);
      setLibCategories(res.categories);
      setLibError(null);
    } catch (err) {
      setLibError(err instanceof Error ? err.message : "Could not load the media library.");
    }
  }, [projectId, libQuery, libCategory, libSort]);

  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary, library]);

  /** Never turn an unknown media duration into sourceOut = 0: that
   *  creates a zero-length item which can only fail on the server.
   *  Block the add here, where the reason can be shown clearly. */
  const addWithKnownRange = (input: AddItemInput, label: string) => {
    const rangeDuration = input.sourceOut - input.sourceIn;
    if (!Number.isFinite(rangeDuration) || rangeDuration <= 0) {
      setAddError(
        `Could not add “${label}”: its duration is unknown, so a valid clip length cannot be set.`,
      );
      return;
    }
    setAddError(null);
    onAddItem(input);
  };

  const addBrowserAsset = (
    asset: LibraryAsset,
    trackKind: AddItemInput["trackKind"],
  ) => {
    if (asset.kind === "candidate") {
      const candidate = library.candidates.find((c) => c.id === asset.id);
      if (!candidate) {
        setAddError(
          `Could not add “${asset.filename}”: its source range is not available in this project.`,
        );
        return;
      }
      addWithKnownRange(
        {
          assetKind: "candidate",
          assetId: asset.id,
          trackKind,
          sourceIn: candidate.startSec,
          sourceOut: candidate.endSec,
          duration: null,
        },
        asset.filename,
      );
      return;
    }
    if (asset.kind === "source" || asset.kind === "media") {
      const assetKind = asset.kind === "source" ? "source" : "media";
      addWithKnownRange(
        {
          assetKind,
          assetId: asset.id,
          trackKind,
          sourceIn: 0,
          sourceOut: asset.duration ?? 0,
          duration: null,
        },
        asset.filename,
      );
    }
  };

  const deleteAsset = async (asset: LibraryAsset, force = false) => {
    setLibError(null);
    try {
      await phase8Api.deleteItem(asset.ref, force);
      setForceRef(null);
      await loadLibrary();
      onMediaUploaded();
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 409 && !force) {
        // Server refused because the asset is in use — surface the
        // usage warning and offer the explicit force path.
        setForceRef(asset.ref);
        setLibError(err instanceof Error ? err.message : "Asset is in use.");
      } else {
        setLibError(err instanceof Error ? err.message : "Delete failed.");
      }
    }
  };

  const trackEnd = (kind: string): number => {
    const track = doc.tracks.find((t) => t.kind === kind);
    if (!track) return 0;
    return doc.items.filter((i) => i.trackId === track.id).reduce((m, i) => Math.max(m, i.start + i.duration), 0);
  };

  const handleUpload = async (file: File) => {
    setUploadError(null);
    setUploading(0);
    try {
      await editorApi.uploadMedia(projectId, file, (fraction) => setUploading(fraction));
      setUploading(null);
      onMediaUploaded();
    } catch (err) {
      setUploading(null);
      setUploadError(err instanceof Error ? err.message : "Upload failed.");
    }
  };

  return (
    <div className={styles.panel} aria-label="Media library">
      <h3>Media Library</h3>
      {addError && (
        <p className={styles.errorText} role="alert">
          {addError}
        </p>
      )}

      {library.sourceAsset && (
        <>
          <h4>Source video</h4>
          <div className={styles.assetRow}>
            <div className={styles.assetRowTop}>
              <span className={styles.assetName}>{library.sourceAsset.filename}</span>
              {!library.sourceAsset.hasAudio && <NoAudioBadge />}
            </div>
            <span className={styles.small}>
              {library.sourceAsset.duration != null ? formatClock(library.sourceAsset.duration) : "—"}
              {library.sourceAsset.width ? ` · ${library.sourceAsset.width}×${library.sourceAsset.height}` : ""}
            </span>
            <span className={styles.addButtons}>
              {(["main", "broll", "overlay"] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className={styles.miniButton}
                  onClick={() =>
                    addWithKnownRange(
                      {
                        assetKind: "source",
                        assetId: library.sourceAsset!.id,
                        trackKind: kind,
                        sourceIn: 0,
                        sourceOut: library.sourceAsset!.duration ?? 0,
                        duration: null,
                      },
                      library.sourceAsset!.filename,
                    )
                  }
                >
                  + {kind === "main" ? "Main" : kind === "broll" ? "B-roll" : "Overlay"}
                </button>
              ))}
            </span>
          </div>
        </>
      )}

      {library.candidates.length > 0 && (
        <>
          <h4>Generated clips</h4>
          {library.candidates.map((candidate) => (
            <div key={candidate.id} className={styles.assetRow}>
              <div className={styles.assetRowTop}>
                <span className={styles.assetName}>{candidate.title}</span>
                {candidate.previewStatus !== "READY" && (
                  <span className={styles.badge}>{candidate.previewStatus.toLowerCase()}</span>
                )}
              </div>
              <span className={styles.small}>
                {formatClock(candidate.startSec)}–{formatClock(candidate.endSec)} · {candidate.duration.toFixed(1)}s
              </span>
              <span className={styles.addButtons}>
                {(["main", "broll", "overlay"] as const).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    className={styles.miniButton}
                    onClick={() =>
                      addWithKnownRange(
                        {
                          assetKind: "candidate",
                          assetId: candidate.id,
                          trackKind: kind,
                          sourceIn: candidate.startSec,
                          sourceOut: candidate.endSec,
                          duration: null,
                        },
                        candidate.title,
                      )
                    }
                  >
                    + {kind === "main" ? "Main" : kind === "broll" ? "B-roll" : "Overlay"}
                  </button>
                ))}
              </span>
            </div>
          ))}
        </>
      )}

      <h4>Imported media & audio</h4>
      {library.media.length === 0 && (
        <p className={styles.muted}>
          No imported files yet. Upload background music (MP3/WAV/…) or extra video below — files are
          stored on the server and probed like any other asset.
        </p>
      )}
      {library.media.map((media) => (
        <div key={media.id} className={styles.assetRow}>
          <div className={styles.assetRowTop}>
            <span className={styles.assetName}>{media.filename}</span>
            <span className={styles.badge}>{media.kind === "AUDIO" ? "Audio" : "Video"}</span>
            {!media.hasAudio && <NoAudioBadge />}
          </div>
          <span className={styles.small}>
            {media.duration != null ? formatClock(media.duration) : "—"}
            {media.width ? ` · ${media.width}×${media.height}` : ""}
          </span>
          <span className={styles.addButtons}>
            {media.hasVideo &&
              (["main", "broll", "overlay"] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className={styles.miniButton}
                  onClick={() =>
                    addWithKnownRange(
                      {
                        assetKind: "media",
                        assetId: media.id,
                        trackKind: kind,
                        sourceIn: 0,
                        sourceOut: media.duration ?? 0,
                        duration: null,
                      },
                      media.filename,
                    )
                  }
                >
                  + {kind === "main" ? "Main" : kind === "broll" ? "B-roll" : "Overlay"}
                </button>
              ))}
            {media.hasAudio && (
              <button
                type="button"
                className={styles.miniButton}
                onClick={() =>
                  addWithKnownRange(
                    {
                      assetKind: "media",
                      assetId: media.id,
                      trackKind: "audio",
                      sourceIn: 0,
                      sourceOut: media.duration ?? 0,
                      duration: null,
                    },
                    media.filename,
                  )
                }
              >
                + Music track
              </button>
            )}
          </span>
        </div>
      ))}

      <h4>Library browser (all categories)</h4>
      <label className={styles.field}>
        <span>Search filename / tags</span>
        <input type="text" value={libQuery} onChange={(e) => setLibQuery(e.target.value)} placeholder="e.g. car, music, logo" />
      </label>
      <span className={styles.addButtons}>
        <select aria-label="Category filter" value={libCategory} onChange={(e) => setLibCategory(e.target.value)}>
          <option value="">All categories</option>
          {libCategories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select aria-label="Sort" value={libSort} onChange={(e) => setLibSort(e.target.value)}>
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="name">Name</option>
          <option value="duration">Longest duration</option>
          <option value="size">Largest size</option>
        </select>
      </span>
      {libError && (
        <p className={styles.errorText} role="alert">
          {libError}
        </p>
      )}
      {libAssets.length === 0 && <p className={styles.muted}>No assets match this filter.</p>}
      {libAssets.map((asset) => (
        <div key={asset.ref} className={styles.assetRow}>
          <div className={styles.assetRowTop}>
            <span className={styles.assetName}>{asset.filename}</span>
            <span className={styles.badge}>{asset.mediaKind.toLowerCase()}</span>
            {asset.usage.timelineItems > 0 && (
              <span className={styles.badgeWarn}>on timeline ×{asset.usage.timelineItems}</span>
            )}
          </div>
          {asset.thumbnailUrl && (
            <img src={asset.thumbnailUrl} alt="" style={{ width: "100%", borderRadius: 6 }} loading="lazy" />
          )}
          <span className={styles.small}>
            {asset.duration != null ? formatClock(asset.duration) : "—"}
            {asset.width ? ` · ${asset.width}×${asset.height}` : ""}
            {asset.aspect ? ` · ${asset.aspect}` : ""} · {formatBytes(asset.fileSize)} · {asset.sourceType}
            {asset.hasAudio === false ? " · no audio" : ""}
            {asset.licenseName ? ` · licence: ${asset.licenseName}` : ""}
          </span>
          {asset.tags.length > 0 && <span className={styles.small}>Tags: {asset.tags.join(", ")}</span>}
          {previewRef === asset.ref && asset.streamUrl && asset.mediaKind === "VIDEO" && (
            <video src={asset.streamUrl} controls className={styles.brollVideo} preload="metadata" />
          )}
          {previewRef === asset.ref && asset.streamUrl && asset.mediaKind === "AUDIO" && (
            <audio src={asset.streamUrl} controls style={{ width: "100%" }} preload="metadata" />
          )}
          <span className={styles.addButtons}>
            <select
              aria-label={`Category for ${asset.filename}`}
              value={asset.category}
              onChange={(e) => {
                void (async () => {
                  try {
                    await phase8Api.patchMeta({ assetRef: asset.ref, category: e.target.value });
                    await loadLibrary();
                  } catch (err) {
                    setLibError(err instanceof Error ? err.message : "Category update failed.");
                  }
                })();
              }}
            >
              {libCategories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            {asset.streamUrl && (
              <button type="button" className={styles.miniButton} onClick={() => setPreviewRef(previewRef === asset.ref ? null : asset.ref)}>
                {previewRef === asset.ref ? "Hide" : "Preview"}
              </button>
            )}
            {(asset.kind === "source" || asset.kind === "candidate" || asset.kind === "media") &&
              asset.hasVideo &&
              (["main", "broll", "overlay"] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className={styles.miniButton}
                  onClick={() => addBrowserAsset(asset, kind)}
                >
                  + {kind === "main" ? "Main" : kind === "broll" ? "B-roll" : "Overlay"}
                </button>
              ))}
            {asset.kind === "media" && asset.hasAudio && (
              <button
                type="button"
                className={styles.miniButton}
                onClick={() =>
                  addWithKnownRange(
                    {
                      assetKind: "media",
                      assetId: asset.id,
                      trackKind: "audio",
                      sourceIn: 0,
                      sourceOut: asset.duration ?? 0,
                      duration: null,
                    },
                    asset.filename,
                  )
                }
              >
                + Music track
              </button>
            )}
            {forceRef === asset.ref ? (
              <button type="button" className={styles.miniButtonDanger} onClick={() => void deleteAsset(asset, true)}>
                Force delete (removes timeline items)
              </button>
            ) : confirmDeleteRef === asset.ref ? (
              <span role="group" aria-label={`Confirm deletion of ${asset.filename}`}>
                <span id={deleteConfirmId(asset.ref)} className={styles.small}>
                  Delete “{asset.filename}” permanently? This cannot be undone.
                </span>
                <button
                  type="button"
                  className={styles.miniButtonDanger}
                  aria-describedby={deleteConfirmId(asset.ref)}
                  onClick={() => {
                    setConfirmDeleteRef(null);
                    void deleteAsset(asset);
                  }}
                >
                  Delete permanently
                </button>
                <button type="button" className={styles.miniButton} onClick={() => setConfirmDeleteRef(null)}>
                  Cancel
                </button>
              </span>
            ) : (
              <button type="button" className={styles.miniButtonDanger} onClick={() => setConfirmDeleteRef(asset.ref)}>
                Delete
              </button>
            )}
          </span>
        </div>
      ))}

      <div>
        <input
          ref={fileRef}
          type="file"
          accept="video/mp4,video/quicktime,video/webm,audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/ogg,audio/flac,.mp4,.mov,.webm,.mp3,.wav,.m4a,.ogg,.flac"
          className={styles.fileInput}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void handleUpload(file);
          }}
        />
        <button
          type="button"
          className={styles.toolButton}
          disabled={uploading !== null}
          onClick={() => fileRef.current?.click()}
        >
          {uploading !== null ? `Uploading… ${Math.round(uploading * 100)}%` : "Upload audio / video"}
        </button>
        {uploadError && (
          <p className={styles.errorText} role="alert">
            {uploadError}
          </p>
        )}
        <p className={styles.small}>Adds to the end of the chosen track (currently main ends at {formatClock(trackEnd("main"))}).</p>
      </div>
    </div>
  );
}
