// Phase 6 — Captions Studio (inside the Phase 5 editor inspector).
//
// Everything here is backed by the real server:
//  - the caption style lives in the editor document settings and is
//    rendered by libass (generated .ass) — preview and render share
//    the same style object;
//  - templates are reusable style configurations (10 built-ins +
//    user customs) served by /api/caption-templates;
//  - word-level editing only appears when the transcript genuinely
//    provided word timestamps — otherwise the limitation is labelled;
//  - caption tracks keep original / translation / manual languages
//    separate; activating a track swaps the document's captions;
//  - translation runs through the server's provider adapter and
//    honestly reports "not configured" on this machine;
//  - brand kits apply caption style/template + brand settings to
//    this (or other) editor documents.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  editorApi,
  formatClock,
  type EditorDocument,
} from "../../services/editor";
import {
  brandApi,
  captionsApi,
  DEFAULT_CAPTION_STYLE,
  type BrandKit,
  type CaptionStyleConfig,
  type CaptionStudioState,
  type CaptionTemplate,
  type TranslationJob,
} from "../../services/captions";
import styles from "../../pages/studio/Editor.module.css";

interface Props {
  doc: EditorDocument;
  projectId: string;
  playhead: number;
  selectedCaptionId: string | null;
  onSeek: (t: number) => void;
  onSelectCaption: (id: string) => void;
  onCommit: (type: string, mutate: (state: EditorDocument) => void) => void;
  onPatchSettings: (patch: { settings?: Partial<EditorDocument["settings"]> }) => void;
  onReplaceDocument: (doc: EditorDocument) => void;
}

const ANIMATIONS: { value: CaptionStyleConfig["animation"]; label: string }[] = [
  { value: "none", label: "None (static)" },
  { value: "minimal", label: "Minimal reveal" },
  { value: "fade", label: "Fade in" },
  { value: "pop", label: "Pop in" },
  { value: "slide-up", label: "Slide up" },
  { value: "word-reveal", label: "Word-by-word reveal" },
  { value: "highlight", label: "Highlight active word" },
  { value: "karaoke", label: "Karaoke sweep" },
  { value: "keyword-emphasis", label: "Keyword emphasis" },
];

const POSITIONS: { value: CaptionStyleConfig["position"]; label: string }[] = [
  { value: "top", label: "Top" },
  { value: "upper-middle", label: "Upper middle" },
  { value: "center", label: "Center" },
  { value: "lower-middle", label: "Lower middle" },
  { value: "bottom", label: "Bottom" },
  { value: "custom", label: "Custom (drag on preview)" },
];

const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "hi", label: "Hindi (हिन्दी)" },
  { code: "mr", label: "Marathi (मराठी)" },
];

function languageLabel(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.label ?? code.toUpperCase();
}

function ColorField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
}) {
  return (
    <div className={styles.field}>
      <label>{label}</label>
      <div className={styles.colorRow}>
        <input
          type="color"
          value={value}
          onChange={(e) => onCommit(e.target.value.toUpperCase())}
          aria-label={label}
        />
        <input
          type="text"
          value={value}
          onChange={(e) => {
            const v = e.target.value.trim();
            if (/^#[0-9a-fA-F]{6}$/.test(v)) onCommit(v.toUpperCase());
          }}
          aria-label={`${label} hex`}
        />
      </div>
    </div>
  );
}

function RangeField({
  label,
  value,
  min,
  max,
  step,
  suffix,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  onCommit: (v: number) => void;
}) {
  return (
    <div className={styles.field}>
      <label>
        {label}: {value}
        {suffix ?? ""}
      </label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onCommit(Number(e.target.value))}
        aria-label={label}
      />
    </div>
  );
}

export function CaptionStudio({
  doc,
  projectId,
  playhead,
  selectedCaptionId,
  onSeek,
  onSelectCaption,
  onCommit,
  onPatchSettings,
  onReplaceDocument,
}: Props) {
  const style = doc.settings.captionStyle;
  const [studio, setStudio] = useState<CaptionStudioState | null>(null);
  const [templates, setTemplates] = useState<CaptionTemplate[]>([]);
  const [fonts, setFonts] = useState<string[]>([]);
  const [kits, setKits] = useState<BrandKit[]>([]);
  const [jobs, setJobs] = useState<TranslationJob[]>([]);
  const [jobsStale, setJobsStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [newTemplateName, setNewTemplateName] = useState("");
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [importMode, setImportMode] = useState<"replace-active" | "new-track">("replace-active");
  const [importLanguage, setImportLanguage] = useState("en");
  const [manualLanguage, setManualLanguage] = useState("hi");
  const [manualKind, setManualKind] = useState<"manual" | "translation">("translation");
  const [manualTexts, setManualTexts] = useState<Record<string, string>>({});
  const [translationTarget, setTranslationTarget] = useState("hi");
  const [kitToApply, setKitToApply] = useState<string>("");
  const [regenConfirm, setRegenConfirm] = useState(false);
  const [kitsLoaded, setKitsLoaded] = useState(false);
  const [wordIndex, setWordIndex] = useState<number | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const docId = doc.id;

  const refreshStudio = useCallback(async () => {
    try {
      const { studio: next } = await captionsApi.getStudio(docId);
      setStudio(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load caption studio state.");
    }
  }, [docId]);

  const refreshJobs = useCallback(async () => {
    try {
      const { jobs: list } = await captionsApi.listTranslationJobs(docId);
      setJobs(list);
      setJobsStale(false);
    } catch {
      // Jobs are advisory in the UI, but a stale list must say so.
      setJobsStale(true);
    }
  }, [docId]);

  useEffect(() => {
    setSelected(new Set());
    setWordIndex(null);
    setRegenConfirm(false);
    void refreshStudio();
    void refreshJobs();
  }, [docId, refreshStudio, refreshJobs]);

  const refreshCatalog = useCallback(async () => {
    try {
      const [{ templates: list }, fontInfo, { kits: kitList }] = await Promise.all([
        captionsApi.listTemplates(),
        captionsApi.fonts(),
        brandApi.listKits(),
      ]);
      setTemplates(list);
      setFonts(fontInfo.fonts);
      setKits(kitList);
      setKitsLoaded(true);
      setKitToApply((prev) => prev || kitList.find((k) => k.isDefault)?.id || kitList[0]?.id || "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load templates/fonts.");
    }
  }, []);

  useEffect(() => {
    void refreshCatalog();
  }, [refreshCatalog]);

  // Retry for the load-failure state: re-runs every load the panel
  // depends on (studio state, translation jobs, templates/fonts/kits).
  const retryLoad = () => {
    setError(null);
    void refreshStudio();
    void refreshJobs();
    void refreshCatalog();
  };

  const focused = useMemo(
    () => doc.captions.find((c) => c.id === selectedCaptionId) ?? null,
    [doc.captions, selectedCaptionId],
  );
  const sortedCaptions = useMemo(
    () => [...doc.captions].sort((a, b) => a.start - b.start),
    [doc.captions],
  );
  const activeLanguage = studio?.activeTrack.language ?? focused?.language ?? "en";

  // The applied-kit note must reflect the loaded kit list: a kit that
  // was deleted after being applied no longer exists, and until the
  // list has loaded the studio claims neither way.
  const appliedKitId = doc.settings.brandKitId;
  const appliedKitNote =
    !appliedKitId || !kitsLoaded
      ? ""
      : kits.some((k) => k.id === appliedKitId)
        ? " A brand kit is currently applied to this document."
        : " The brand kit previously applied to this document no longer exists; its caption style remains on this document.";

  const patchStyle = (patch: Partial<CaptionStyleConfig>) =>
    onPatchSettings({ settings: { captionStyle: { ...style, ...patch } } });

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  };

  // Regenerate is destructive when the document's captions have been
  // edited: the server answers 409 CONFIRMATION_REQUIRED in that case
  // and the studio asks inline before retrying with confirm=true.
  const doRegenerate = async (confirm: boolean) => {
    setBusy("regenerate");
    setError(null);
    setNotice(null);
    setRegenConfirm(false);
    try {
      const res = await captionsApi.regenerate(docId, confirm);
      onReplaceDocument(res.document);
      setStudio(res.studio);
      setNotice(
        res.generated > 0
          ? `Generated ${res.generated} caption segments from the transcript (${languageLabel(res.studio.activeTrack.language)}). The transcript itself was not changed.`
          : "No transcript segments were available to generate captions from.",
      );
    } catch (e) {
      if (!confirm && (e as { code?: string } | null)?.code === "CONFIRMATION_REQUIRED") {
        setRegenConfirm(true);
      } else {
        setError(e instanceof Error ? e.message : "Something went wrong.");
      }
    } finally {
      setBusy(null);
    }
  };

  const applyStyleTo = (ids: string[] | "all") =>
    onCommit("caption_style_apply", (state) => {
      const docStyle = state.settings.captionStyle;
      for (const c of state.captions) {
        if (ids === "all" || ids.includes(c.id)) c.style = { ...docStyle };
      }
    });

  const resetStyleOf = (ids: string[] | "all") =>
    onCommit("caption_style_reset", (state) => {
      for (const c of state.captions) {
        if (ids === "all" || ids.includes(c.id)) c.style = null;
      }
    });

  const toggleSelected = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <section aria-label="Captions Studio">
      <h3>Captions Studio</h3>
      {error && (
        <>
          <p className={styles.error} role="alert">
            {error}
          </p>
          <div className={styles.addButtons}>
            <button type="button" className={styles.miniButton} onClick={retryLoad}>
              Retry loading
            </button>
          </div>
        </>
      )}
      {notice && <p className={styles.small}>{notice}</p>}

      <div className={styles.field}>
        <label>
          <input
            type="checkbox"
            checked={doc.settings.showCaptions}
            onChange={(e) => onPatchSettings({ settings: { showCaptions: e.target.checked } })}
          />{" "}
          Captions enabled (burned into renders when on)
        </label>
        <label>
          <input
            type="checkbox"
            checked={doc.settings.safeZones}
            onChange={(e) => onPatchSettings({ settings: { safeZones: e.target.checked } })}
          />{" "}
          Show safe-zone guides on the preview
        </label>
      </div>

      <div className={styles.addButtons}>
        <button
          type="button"
          className={styles.miniButton}
          disabled={busy !== null}
          onClick={() => void doRegenerate(false)}
        >
          {busy === "regenerate" ? "Generating…" : "Regenerate from transcript"}
        </button>
        <a className={styles.miniButton} href={captionsApi.exportUrl(docId, "srt", studio?.activeTrack.id)}>
          Export SRT
        </a>
        <a className={styles.miniButton} href={captionsApi.exportUrl(docId, "vtt", studio?.activeTrack.id)}>
          Export VTT
        </a>
      </div>
      {regenConfirm && (
        <div className={styles.field} role="alert">
          <p className={styles.error}>
            Regenerating will replace your current captions, including edits.
          </p>
          <div className={styles.addButtons}>
            <button
              type="button"
              className={`${styles.miniButton} ${styles.miniButtonDanger}`}
              disabled={busy !== null}
              onClick={() => void doRegenerate(true)}
            >
              Replace captions
            </button>
            <button
              type="button"
              className={styles.miniButton}
              disabled={busy !== null}
              onClick={() => setRegenConfirm(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      <p className={styles.small}>
        Active track: {studio ? `${studio.activeTrack.label} · ${languageLabel(studio.activeTrack.language)} · ${studio.captionCount} segments` : error ? "unavailable — the studio state failed to load" : "loading…"}. Exports follow the edited
        timeline exactly.
      </p>

      <h4 className={styles.subhead}>Templates</h4>
      <div className={styles.templateGrid}>
        {templates.map((t) => (
          <div key={t.id} className={`${styles.templateCard} ${doc.settings.captionTemplateId === t.id ? styles.templateCardActive : ""}`}>
            <div
              className={styles.templatePreview}
              style={{
                background: t.style.backgroundColor,
                color: t.style.textColor,
                fontFamily: t.style.fontFamily,
                fontWeight: t.style.fontWeight,
                fontStyle: t.style.italic ? "italic" : "normal",
              }}
            >
              The quick <span style={{ color: t.style.highlightColor }}>brown</span> fox
            </div>
            <div className={styles.templateMeta}>
              <strong>{t.name}</strong>
              <span className={styles.small}>{t.builtin ? "Built-in" : "Custom"}</span>
            </div>
            <div className={styles.addButtons}>
              <button
                type="button"
                className={styles.miniButton}
                onClick={() =>
                  onPatchSettings({
                    settings: { captionStyle: { ...t.style }, captionTemplateId: t.id },
                  })
                }
              >
                Apply
              </button>
              {t.builtin && (
                <button
                  type="button"
                  className={styles.miniButton}
                  disabled={busy !== null}
                  onClick={() =>
                    void run("edit-template-copy", async () => {
                      // Edit-as-copy: built-ins themselves can never be
                      // modified (the server refuses), so Edit creates
                      // an editable user copy and applies it to this
                      // document — the appearance controls and "Save
                      // current style" then work on the copy.
                      const { template } = await captionsApi.duplicateTemplate(t.id, `${t.name} (edited)`);
                      setTemplates((prev) => [...prev, template]);
                      onPatchSettings({
                        settings: { captionStyle: { ...template.style }, captionTemplateId: template.id },
                      });
                      setNotice(
                        `Built-in templates stay unchanged — you are now editing your copy “${template.name}”. Adjust the appearance, then use “Save current style” on the copy to keep your changes.`,
                      );
                    })
                  }
                >
                  Edit
                </button>
              )}
              <button
                type="button"
                className={styles.miniButton}
                disabled={busy !== null}
                onClick={() =>
                  void run("duplicate-template", async () => {
                    const { template } = await captionsApi.duplicateTemplate(t.id);
                    setTemplates((prev) => [...prev, template]);
                    setNotice(`Duplicated as “${template.name}”.`);
                  })
                }
              >
                Duplicate
              </button>
              {!t.builtin && (
                <>
                  <button
                    type="button"
                    className={styles.miniButton}
                    onClick={() => {
                      setRenameId(t.id);
                      setRenameValue(t.name);
                    }}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    className={styles.miniButton}
                    disabled={busy !== null}
                    onClick={() =>
                      void run("save-template-style", async () => {
                        const { template } = await captionsApi.updateTemplate(t.id, { style });
                        setTemplates((prev) => prev.map((x) => (x.id === template.id ? template : x)));
                        setNotice(`Saved the current appearance into “${template.name}”.`);
                      })
                    }
                  >
                    Save current style
                  </button>
                  <button
                    type="button"
                    className={`${styles.miniButton} ${styles.miniButtonDanger}`}
                    disabled={busy !== null}
                    onClick={() =>
                      void run("delete-template", async () => {
                        await captionsApi.deleteTemplate(t.id);
                        setTemplates((prev) => prev.filter((x) => x.id !== t.id));
                      })
                    }
                  >
                    Delete
                  </button>
                </>
              )}
            </div>
            {renameId === t.id && (
              <div className={styles.colorRow}>
                <input
                  type="text"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  aria-label="Template name"
                />
                <button
                  type="button"
                  className={styles.miniButton}
                  disabled={busy !== null || renameValue.trim().length === 0}
                  onClick={() =>
                    void run("rename-template", async () => {
                      const { template } = await captionsApi.updateTemplate(t.id, { name: renameValue.trim() });
                      setTemplates((prev) => prev.map((x) => (x.id === template.id ? template : x)));
                      setRenameId(null);
                    })
                  }
                >
                  Save
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className={styles.colorRow}>
        <input
          type="text"
          placeholder="Name for a new custom template"
          value={newTemplateName}
          onChange={(e) => setNewTemplateName(e.target.value)}
          aria-label="New template name"
        />
        <button
          type="button"
          className={styles.miniButton}
          disabled={busy !== null || newTemplateName.trim().length === 0}
          onClick={() =>
            void run("create-template", async () => {
              const { template } = await captionsApi.createTemplate({
                name: newTemplateName.trim(),
                style,
                basedOn: doc.settings.captionTemplateId,
              });
              setTemplates((prev) => [...prev, template]);
              setNewTemplateName("");
              setNotice(`Saved “${template.name}” as a custom template.`);
            })
          }
        >
          Save current as template
        </button>
      </div>

      <h4 className={styles.subhead}>Appearance</h4>
      <div className={styles.field}>
        <label>Font family (rendered by libass from the server font library)</label>
        <select
          value={style.fontFamily}
          onChange={(e) => patchStyle({ fontFamily: e.target.value })}
        >
          {fonts.length === 0 && <option value={style.fontFamily}>{style.fontFamily}</option>}
          {fonts.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        <p className={styles.small}>
          If a font is missing at render time the renderer falls back to a Devanagari-safe font
          instead of failing. Noto Sans Devanagari is installed for Hindi/Marathi captions.
        </p>
      </div>
      <div className={styles.fieldGrid}>
        <RangeField label="Font size" value={style.fontSize} min={8} max={200} step={1} suffix="px" onCommit={(v) => patchStyle({ fontSize: v })} />
        <div className={styles.field}>
          <label>Font weight</label>
          <select value={style.fontWeight} onChange={(e) => patchStyle({ fontWeight: Number(e.target.value) })}>
            {[100, 200, 300, 400, 500, 600, 700, 800, 900].map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label>
            <input type="checkbox" checked={style.italic} onChange={(e) => patchStyle({ italic: e.target.checked })} /> Italic
          </label>
        </div>
        <div className={styles.field}>
          <label>Alignment</label>
          <select value={style.alignment} onChange={(e) => patchStyle({ alignment: e.target.value as CaptionStyleConfig["alignment"] })}>
            <option value="left">Left</option>
            <option value="center">Center</option>
            <option value="right">Right</option>
          </select>
        </div>
        <div className={styles.field}>
          <label>Casing</label>
          <select value={style.casing} onChange={(e) => patchStyle({ casing: e.target.value as CaptionStyleConfig["casing"] })}>
            <option value="none">As typed</option>
            <option value="upper">UPPERCASE</option>
            <option value="lower">lowercase</option>
            <option value="title">Title Case</option>
          </select>
        </div>
        <div className={styles.field}>
          <label>Animation</label>
          <select value={style.animation} onChange={(e) => patchStyle({ animation: e.target.value as CaptionStyleConfig["animation"] })}>
            {ANIMATIONS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
          <p className={styles.small}>
            Pop and slide animations are approximated in the preview; the render uses the
            subtitle renderer&apos;s own transforms.
          </p>
        </div>
      </div>
      <div className={styles.fieldGrid}>
        <ColorField label="Text colour" value={style.textColor} onCommit={(v) => patchStyle({ textColor: v })} />
        <ColorField label="Highlight colour" value={style.highlightColor} onCommit={(v) => patchStyle({ highlightColor: v })} />
        <ColorField label="Background colour" value={style.backgroundColor} onCommit={(v) => patchStyle({ backgroundColor: v })} />
        <ColorField label="Outline colour" value={style.outlineColor} onCommit={(v) => patchStyle({ outlineColor: v })} />
      </div>
      <div className={styles.fieldGrid}>
        <RangeField label="Background opacity" value={style.backgroundOpacity} min={0} max={1} step={0.05} onCommit={(v) => patchStyle({ backgroundOpacity: v })} />
        <RangeField label="Outline width" value={style.outlineWidth} min={0} max={20} step={0.5} suffix="px" onCommit={(v) => patchStyle({ outlineWidth: v })} />
        <RangeField label="Shadow depth" value={style.shadowDepth} min={0} max={20} step={0.5} suffix="px" onCommit={(v) => patchStyle({ shadowDepth: v })} />
        <RangeField label="Letter spacing" value={style.letterSpacing} min={-2} max={40} step={0.5} suffix="px" onCommit={(v) => patchStyle({ letterSpacing: v })} />
      </div>
      <div className={styles.field}>
        <RangeField label="Line spacing" value={style.lineSpacing} min={0.8} max={2.5} step={0.05} onCommit={(v) => patchStyle({ lineSpacing: v })} />
        <p className={styles.small}>
          Line spacing is preview-only: the libass renderer does not expose a line-height control,
          so rendered line breaks follow the font's own metrics. Every other control on this panel
          reaches the render.
        </p>
      </div>
      <div className={styles.fieldGrid}>
        <RangeField label="Max words per line" value={style.maxWordsPerLine} min={1} max={20} step={1} onCommit={(v) => patchStyle({ maxWordsPerLine: v })} />
        <RangeField label="Max lines" value={style.maxLines} min={1} max={6} step={1} onCommit={(v) => patchStyle({ maxLines: v })} />
      </div>
      <div className={styles.field}>
        <label>Position</label>
        <select value={style.position} onChange={(e) => patchStyle({ position: e.target.value as CaptionStyleConfig["position"] })}>
          {POSITIONS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        <p className={styles.small}>
          With “Custom”, drag the caption on the preview (or set X/Y below) — the render preserves
          the exact placement.
        </p>
      </div>
      {style.position === "custom" && (
        <div className={styles.fieldGrid}>
          <RangeField label="Custom X" value={Math.round(style.positionX * 100)} min={0} max={100} step={1} suffix="%" onCommit={(v) => patchStyle({ positionX: v / 100 })} />
          <RangeField label="Custom Y" value={Math.round(style.positionY * 100)} min={0} max={100} step={1} suffix="%" onCommit={(v) => patchStyle({ positionY: v / 100 })} />
        </div>
      )}
      <div className={styles.fieldGrid}>
        <RangeField label="Horizontal margin" value={style.marginH} min={0} max={400} step={2} suffix="px" onCommit={(v) => patchStyle({ marginH: v })} />
        <RangeField label="Vertical margin" value={style.marginV} min={0} max={400} step={2} suffix="px" onCommit={(v) => patchStyle({ marginV: v })} />
      </div>
      <div className={styles.addButtons}>
        <button
          type="button"
          className={styles.miniButton}
          onClick={() =>
            onPatchSettings({
              settings: {
                captionStyle: { ...style, ...DEFAULT_CAPTION_STYLE },
                captionTemplateId: "builtin:clean-minimal",
              },
            })
          }
        >
          Reset styling
        </button>
      </div>

      <h4 className={styles.subhead}>Segments</h4>
      <p className={styles.small}>
        Tick segments to style them individually (a per-segment style overrides the document style
        above), or style the whole clip at once.
      </p>
      <div className={styles.segmentList}>
        {sortedCaptions.map((c) => (
          <div key={c.id} className={`${styles.segmentRow} ${c.id === selectedCaptionId ? styles.segmentRowActive : ""}`}>
            <input
              type="checkbox"
              checked={selected.has(c.id)}
              onChange={() => toggleSelected(c.id)}
              aria-label={`Select caption at ${formatClock(c.start)}`}
            />
            <button
              type="button"
              className={styles.miniButton}
              onClick={() => {
                onSelectCaption(c.id);
                onSeek(c.start);
              }}
            >
              {formatClock(c.start)}–{formatClock(c.end)}
            </button>
            <span className={styles.segmentText}>{c.text || "—"}</span>
            {c.style && <span className={`${styles.badge} ${styles.badgeLime}`}>Styled</span>}
            {!c.words && <span className={styles.badge}>No word timing</span>}
          </div>
        ))}
        {sortedCaptions.length === 0 &&
          (studio && !studio.hasTranscript ? (
            <p className={styles.muted}>
              No transcript yet — captions are generated from a transcript of the source video.{" "}
              <a href={`#/app/projects/${projectId}`}>Open the project page</a> and run Find Clips
              to transcribe the video first.
            </p>
          ) : (
            <p className={styles.muted}>No captions yet — generate them from the transcript above.</p>
          ))}
      </div>
      <div className={styles.addButtons}>
        <button type="button" className={styles.miniButton} disabled={selected.size === 0} onClick={() => applyStyleTo([...selected])}>
          Apply style to selected ({selected.size})
        </button>
        <button type="button" className={styles.miniButton} onClick={() => applyStyleTo("all")}>
          Apply style to whole clip
        </button>
        <button type="button" className={styles.miniButton} disabled={selected.size === 0} onClick={() => resetStyleOf([...selected])}>
          Reset selected
        </button>
        <button type="button" className={styles.miniButton} onClick={() => resetStyleOf("all")}>
          Reset all
        </button>
      </div>

      <h4 className={styles.subhead}>Word editor</h4>
      {!focused && <p className={styles.muted}>Select a caption segment to edit its words.</p>}
      {focused && !focused.words && (
        <p className={styles.small}>
          Word-level timing is unavailable for this caption
          {studio && !studio.hasWordTimestamps
            ? " — this project's transcript has no word-level timestamps, so animations use segment timing. Word timings are never invented."
            : " — this caption was typed or imported without word timings, so animations use its segment timing."}
        </p>
      )}
      {focused && focused.words && (
        <>
          <p className={styles.small}>
            Real word timings from the transcript. Click a word to select it; the preview highlights
            the word under the playhead.
          </p>
          <div className={styles.wordChips}>
            {focused.words.map((w, i) => (
              <button
                key={`${focused.id}-${i}`}
                type="button"
                className={`${styles.wordChip} ${wordIndex === i ? styles.wordChipActive : ""} ${w.emphasized ? styles.wordChipEmphasis : ""} ${playhead >= w.start && playhead < w.end ? styles.wordChipPlaying : ""}`}
                onClick={() => {
                  setWordIndex(i);
                  onSeek(w.start);
                }}
              >
                {w.word}
                <span className={styles.wordChipTime}>
                  {w.start.toFixed(2)}–{w.end.toFixed(2)}
                </span>
              </button>
            ))}
          </div>
          {wordIndex !== null && focused.words[wordIndex] && (
            <WordControls
              key={`${focused.id}-${wordIndex}-${focused.words[wordIndex].word}`}
              word={focused.words[wordIndex]}
              onCommitWord={(patch) =>
                onCommit("caption_words_update", (state) => {
                  const target = state.captions.find((c) => c.id === focused.id);
                  if (!target || !target.words || !target.words[wordIndex]) return;
                  Object.assign(target.words[wordIndex], patch);
                  target.text = target.words.map((x) => x.word).join(" ");
                })
              }
              onDelete={() =>
                onCommit("caption_words_update", (state) => {
                  const target = state.captions.find((c) => c.id === focused.id);
                  if (!target || !target.words) return;
                  target.words = target.words.filter((_, i) => i !== wordIndex);
                  if (target.words.length === 0) target.words = null;
                  else target.text = target.words.map((x) => x.word).join(" ");
                  setWordIndex(null);
                })
              }
            />
          )}
        </>
      )}

      <h4 className={styles.subhead}>Languages & tracks</h4>
      <p className={styles.small}>
        The original transcript language is never overwritten: translations and manual corrections
        live on their own tracks, and switching tracks swaps which captions the editor shows.
      </p>
      <div className={styles.segmentList}>
        {(studio?.tracks ?? []).map((t) => (
          <div key={t.id} className={styles.segmentRow}>
            <span className={styles.segmentText}>
              {t.label} · {languageLabel(t.language)} · {t.kind} · {t.segmentCount} segments
            </span>
            {t.isActive ? (
              <span className={`${styles.badge} ${styles.badgeLime}`}>Active</span>
            ) : (
              <button
                type="button"
                className={styles.miniButton}
                disabled={busy !== null}
                onClick={() =>
                  void run("activate-track", async () => {
                    const res = await captionsApi.activateTrack(docId, t.id);
                    onReplaceDocument(res.document);
                    setStudio(res.studio);
                    setNotice(`Switched to the ${t.label} track. The other tracks are unchanged.`);
                  })
                }
              >
                Activate
              </button>
            )}
          </div>
        ))}
        {!studio &&
          (error ? (
            <p className={styles.muted}>Tracks could not be loaded — use “Retry loading” above.</p>
          ) : (
            <p className={styles.muted}>Loading tracks…</p>
          ))}
      </div>

      <div className={styles.field}>
        <label>Automatic translation</label>
        {studio && !studio.translationConfigured ? (
          <p className={styles.small}>
            Translation is not configured on this server — no translation provider is connected, so
            automatic translation cannot run and no fake translation will be produced. You can
            still type a translation yourself below; it is stored on its own track and never
            replaces the original.
          </p>
        ) : (
          <p className={styles.small}>Provider: {studio?.translationProvider ?? "—"}</p>
        )}
        <div className={styles.colorRow}>
          <select value={translationTarget} onChange={(e) => setTranslationTarget(e.target.value)} aria-label="Translation target language">
            {LANGUAGES.filter((l) => l.code !== activeLanguage).map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={styles.miniButton}
            disabled={busy !== null}
            onClick={() =>
              void run("translate", async () => {
                const res = await captionsApi.createTranslationJob(docId, translationTarget);
                await refreshJobs();
                if (res.job.status === "COMPLETED") {
                  await refreshStudio();
                  setNotice("Translation finished — activate its track above to review it.");
                } else if (res.job.status === "FAILED") {
                  setError(
                    res.job.error ??
                      "The translation job failed — its recorded state is in the job list below.",
                  );
                } else if (res.deduplicated) {
                  setNotice("That translation was already requested — see the job list below.");
                }
              })
            }
          >
            {busy === "translate" ? "Requesting…" : "Request translation"}
          </button>
        </div>
        {jobsStale && (
          <p className={styles.small} role="status">
            The translation job list could not be refreshed — what is shown below may be out of
            date.
          </p>
        )}
        {jobs.length > 0 && (
          <ul className={styles.jobList}>
            {jobs.slice(0, 5).map((j) => (
              <li key={j.id} className={styles.small}>
                {languageLabel(j.sourceLanguage)} → {languageLabel(j.targetLanguage)} · {j.status}
                {j.error ? ` — ${j.error}` : ""}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className={styles.field}>
        <label>Manual captions (correction or your own translation)</label>
        <p className={styles.small}>
          Edit the text of the active track below and save it as a separate track — timings are
          copied, the original stays untouched.
        </p>
        <div className={styles.colorRow}>
          <select value={manualLanguage} onChange={(e) => setManualLanguage(e.target.value)} aria-label="Manual track language">
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
          <select value={manualKind} onChange={(e) => setManualKind(e.target.value as "manual" | "translation")} aria-label="Manual track kind">
            <option value="translation">Translation (typed by me)</option>
            <option value="manual">Manual correction</option>
          </select>
        </div>
        <div className={styles.segmentList}>
          {sortedCaptions.map((c) => (
            <div key={c.id} className={styles.segmentRow}>
              <span className={styles.small}>
                {formatClock(c.start)}–{formatClock(c.end)}
              </span>
              <input
                type="text"
                className={styles.segmentTextInput}
                defaultValue={manualTexts[c.id] ?? c.text}
                key={`${c.id}-${manualKind}-${manualLanguage}`}
                onChange={(e) => setManualTexts((prev) => ({ ...prev, [c.id]: e.target.value }))}
                aria-label={`Manual text for caption at ${formatClock(c.start)}`}
              />
            </div>
          ))}
        </div>
        <button
          type="button"
          className={styles.miniButton}
          disabled={busy !== null || sortedCaptions.length === 0}
          onClick={() =>
            void run("manual-track", async () => {
              const { track } = await captionsApi.createManualTrack(docId, {
                language: manualLanguage,
                kind: manualKind,
                segments: sortedCaptions.map((c) => ({
                  start: c.start,
                  end: c.end,
                  text: (manualTexts[c.id] ?? c.text).trim(),
                })),
              });
              setManualTexts({});
              await refreshStudio();
              setNotice(`Saved “${track.label}” as its own track — activate it above to use it.`);
            })
          }
        >
          {busy === "manual-track" ? "Saving…" : "Save as separate track"}
        </button>
      </div>

      <h4 className={styles.subhead}>Import subtitles</h4>
      <div className={styles.field}>
        <div className={styles.colorRow}>
          <select value={importMode} onChange={(e) => setImportMode(e.target.value as "replace-active" | "new-track")} aria-label="Import mode">
            <option value="replace-active">Replace the active track</option>
            <option value="new-track">Add as a new track</option>
          </select>
          {importMode === "new-track" && (
            <select value={importLanguage} onChange={(e) => setImportLanguage(e.target.value)} aria-label="Import language">
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          )}
        </div>
        <input
          ref={importRef}
          type="file"
          accept=".srt,.vtt,text/plain"
          className={styles.hiddenInput}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            void run("import", async () => {
              const res = await captionsApi.importSubtitles(docId, file, {
                mode: importMode,
                language: importMode === "new-track" ? importLanguage : undefined,
                kind: importMode === "new-track" ? "manual" : undefined,
              });
              if (res.document) onReplaceDocument(res.document);
              if (res.studio) setStudio(res.studio);
              else await refreshStudio();
              setNotice(`Imported ${res.imported} caption segments from ${file.name}.`);
            });
          }}
        />
        <button type="button" className={styles.miniButton} disabled={busy !== null} onClick={() => importRef.current?.click()}>
          {busy === "import" ? "Importing…" : "Choose .srt / .vtt file"}
        </button>
        <p className={styles.small}>
          Files are validated on the server (timestamps, ordering, non-empty cues) — invalid files
          are rejected with the reason, never half-imported.
        </p>
      </div>

      <h4 className={styles.subhead}>Brand kit</h4>
      <div className={styles.field}>
        <div className={styles.colorRow}>
          <select value={kitToApply} onChange={(e) => setKitToApply(e.target.value)} aria-label="Brand kit">
            {kits.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
                {k.isDefault ? " (default)" : ""}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={styles.miniButton}
            disabled={busy !== null || !kitToApply}
            onClick={() =>
              void run("apply-kit", async () => {
                const res = await brandApi.applyKit(kitToApply, [projectId]);
                const first = res.results[0];
                if (!first?.ok) throw new Error(first?.error ?? "Applying the brand kit failed.");
                const { document } = await editorApi.getDocument(projectId);
                onReplaceDocument(document);
                await refreshStudio();
                setNotice("Brand kit applied to this clip — caption style, template and brand font now follow the kit.");
              })
            }
          >
            {busy === "apply-kit" ? "Applying…" : "Apply to this clip"}
          </button>
        </div>
        <p className={styles.small}>
          Manage kits, assets and multi-clip apply on the Templates &amp; Brand Kit page. The
          approved CLIPFORGE logo is never redrawn — kits reference uploaded assets only.
          {appliedKitNote}
        </p>
      </div>
    </section>
  );
}

function WordControls({
  word,
  onCommitWord,
  onDelete,
}: {
  word: { start: number; end: number; word: string; probability?: number | null; emphasized?: boolean };
  onCommitWord: (patch: { start?: number; end?: number; word?: string; emphasized?: boolean }) => void;
  onDelete: () => void;
}) {
  const [text, setText] = useState(word.word);
  const [start, setStart] = useState(String(word.start));
  const [end, setEnd] = useState(String(word.end));
  const [timingError, setTimingError] = useState<string | null>(null);

  // Mirror of the cue timing rule: a word must end after it starts.
  // An invalid pair is flagged and NEVER committed — previously the
  // blur handlers only clamped with Math.max(0, v), so an end at or
  // before the start saved silently and corrupted the word timings.
  const commitTiming = (which: "start" | "end") => {
    const s = Number(start);
    const e = Number(end);
    if (!Number.isFinite(s) || !Number.isFinite(e)) {
      setTimingError("Start and end must be numbers, in seconds. The change was not saved.");
      return;
    }
    if (e <= s) {
      setTimingError("End must be after start — a word cannot end at or before it begins. The change was not saved.");
      return;
    }
    setTimingError(null);
    if (which === "start") {
      const v = Math.max(0, s);
      if (v !== word.start) onCommitWord({ start: v });
    } else {
      const v = Math.max(0, e);
      if (v !== word.end) onCommitWord({ end: v });
    }
  };
  return (
    <div className={styles.wordControls}>
      <div className={styles.field}>
        <label>Word</label>
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            if (text.trim() && text !== word.word) onCommitWord({ word: text.trim() });
          }}
        />
      </div>
      <div className={styles.fieldGrid}>
        <div className={styles.field}>
          <label>Start (s)</label>
          <input
            type="number"
            step={0.01}
            min={0}
            value={start}
            aria-invalid={timingError ? true : undefined}
            onChange={(e) => setStart(e.target.value)}
            onBlur={() => commitTiming("start")}
          />
        </div>
        <div className={styles.field}>
          <label>End (s)</label>
          <input
            type="number"
            step={0.01}
            min={0}
            value={end}
            aria-invalid={timingError ? true : undefined}
            onChange={(e) => setEnd(e.target.value)}
            onBlur={() => commitTiming("end")}
          />
        </div>
      </div>
      {timingError && (
        <p className={styles.error} role="alert">
          {timingError}
        </p>
      )}
      {typeof word.probability === "number" && (
        <p className={styles.small}>Transcript confidence for this word: {Math.round(word.probability * 100)}%.</p>
      )}
      <div className={styles.addButtons}>
        <button
          type="button"
          className={styles.miniButton}
          aria-pressed={!!word.emphasized}
          onClick={() => onCommitWord({ emphasized: !word.emphasized })}
        >
          {word.emphasized ? "Remove keyword emphasis" : "Mark as keyword"}
        </button>
        <button type="button" className={`${styles.miniButton} ${styles.miniButtonDanger}`} onClick={onDelete}>
          Delete word
        </button>
      </div>
      <p className={styles.small}>
        Marking a keyword renders it in the highlight colour with the “Keyword emphasis” animation.
      </p>
    </div>
  );
}
