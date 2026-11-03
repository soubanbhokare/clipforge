import { useEffect, useState } from "react";
import Button from "../../components/Button";
import GuestRestriction from "../../components/studio/GuestRestriction";
import SourcePanel from "../../components/studio/SourcePanel";
import { useAuth } from "../../features/auth/AuthContext";
import { navigateTo } from "../../features/auth/routing";
import {
  DEFAULT_ENHANCE_SETTINGS,
  enhanceSettingsFrom,
  type EnhanceSettings,
} from "../../features/studio/settings";
import styles from "../../features/studio/Studio.module.css";
import { useProjectEditor } from "../../features/studio/useProjectEditor";

const AUDIO_OPTIONS: { value: string; label: string }[] = [
  { value: "preserve", label: "Preserve original audio" },
  { value: "noise-reduction", label: "Noise reduction (optional, later processing service)" },
  { value: "normalization", label: "Normalization (optional, later processing service)" },
  { value: "music-layer", label: "Music layer (optional, later processing service)" },
];

const VISUAL_OPTIONS: { value: string; label: string }[] = [
  { value: "background-blur", label: "Background blur" },
  { value: "zoom", label: "Zoom" },
  { value: "text-overlay", label: "Text overlay" },
  { value: "logo-watermark", label: "Logo and watermark" },
  { value: "brand-template", label: "Brand template" },
];

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export default function EnhanceVideoPage() {
  const { isGuest } = useAuth();
  const editor = useProjectEditor("SHORT_VIDEO_ENHANCEMENT");
  const [settings, setSettings] = useState<EnhanceSettings>(DEFAULT_ENHANCE_SETTINGS);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [appliedStored, setAppliedStored] = useState(false);

  useEffect(() => {
    if (!appliedStored && editor.loadedFromUrl && editor.project) {
      setSettings(enhanceSettingsFrom(editor.project.settings));
      setAppliedStored(true);
    }
  }, [appliedStored, editor.loadedFromUrl, editor.project]);

  if (isGuest) {
    return (
      <div className={styles.stack}>
        <GuestRestriction action="Enhance an existing video" />
      </div>
    );
  }

  if (!editor.loaded) return <p className={styles.muted} role="status">Loading project…</p>;
  if (editor.loadError) {
    return (
      <div className={styles.stack}>
        <p className={styles.errorText} role="alert"><strong>Problem:</strong> {editor.loadError}</p>
        <p><a href="#/app/projects">Back to Projects</a></p>
      </div>
    );
  }
  if (editor.wrongWorkflow) {
    return (
      <div className={styles.stack}>
        <p className={styles.errorText} role="alert">
          <strong>Wrong workflow:</strong> this project is a Multiple Shorts project. Open it from{" "}
          <a href={`#/app/studio/create?project=${editor.wrongWorkflow.id}`}>Create Multiple Shorts</a>{" "}
          instead.
        </p>
      </div>
    );
  }

  const set = <K extends keyof EnhanceSettings>(key: K, value: EnhanceSettings[K]) =>
    setSettings((s) => ({ ...s, [key]: value }));

  const save = async () => {
    setSaveError(null);
    if (!editor.projectName.trim()) {
      setSaveError("Enter a project name before saving.");
      return;
    }
    setSaving(true);
    try {
      const project = await editor.saveSettings(
        settings as unknown as Record<string, unknown>,
      );
      navigateTo(`app/projects/${project.id}`);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not save the project. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.stack}>
      <div>
        <h2 className={styles.heading}>Make your existing video better.</h2>
        <p className={styles.lede}>
          One existing short video, one enhancement project. This workflow never runs multiple-clip
          detection — your preferences are saved with the single source and applied in the editor.
        </p>
      </div>

      <section className={styles.panel} aria-labelledby="en-name">
        <div className={styles.field}>
          <label className={styles.label} htmlFor="en-name">Project name</label>
          <input
            id="en-name"
            className={styles.input}
            value={editor.projectName}
            required
            maxLength={120}
            placeholder="e.g. Product teaser — vertical polish"
            onChange={(e) => editor.setProjectName(e.target.value)}
          />
        </div>
      </section>

      <section className={styles.panel} aria-labelledby="en-source">
        <h3 id="en-source">Source video</h3>
        <p className={styles.panelIntro}>
          Upload one existing short video. Duration and resolution are inspected by the server from
          the real file.
        </p>
        <SourcePanel
          projectId={editor.projectId}
          asset={editor.asset}
          ensureProject={editor.ensureProject}
          onAttachYouTube={editor.attachYouTube}
          onAssetChange={editor.setAsset}
        />
      </section>

      <section className={styles.panel} aria-labelledby="en-prefs">
        <h3 id="en-prefs">Editing preferences</h3>
        <p className={styles.panelIntro}>
          Preferences are saved with the project. Reframing, face tracking, captions and
          enhancement are applied in the editor — saving a preference here does not apply it
          by itself.
        </p>
        <div className={styles.formGrid}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="en-reframe">Auto reframe</label>
            <select id="en-reframe" className={styles.select} value={settings.reframeAspect} onChange={(e) => set("reframeAspect", e.target.value as EnhanceSettings["reframeAspect"])}>
              <option value="9:16">9:16</option>
              <option value="1:1">1:1</option>
              <option value="16:9">16:9</option>
              <option value="4:5">4:5</option>
            </select>
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="en-tracking">Face tracking</label>
            <select id="en-tracking" className={styles.select} value={settings.faceTracking} onChange={(e) => set("faceTracking", e.target.value as EnhanceSettings["faceTracking"])}>
              <option value="face-lock">Auto Face Lock</option>
              <option value="follow-speaker">Follow Speaker</option>
              <option value="center">Center</option>
              <option value="manual">Manual</option>
            </select>
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="en-captions">Captions</label>
            <select id="en-captions" className={styles.select} value={settings.captionsMode} onChange={(e) => set("captionsMode", e.target.value as EnhanceSettings["captionsMode"])}>
              <option value="generate">Generate new captions</option>
              <option value="preserve">Preserve existing captions</option>
              <option value="remove">Remove existing captions (where technically and legally appropriate)</option>
              <option value="edit-later">Edit captions later</option>
            </select>
          </div>
          <fieldset className={styles.checkGroup}>
            <legend className={styles.label}>Audio</legend>
            {AUDIO_OPTIONS.map((opt) => (
              <label key={opt.value} className={styles.checkRow}>
                <input type="checkbox" checked={settings.audio.includes(opt.value)}
                  onChange={() => set("audio", toggle(settings.audio, opt.value))} />
                {opt.label}
              </label>
            ))}
          </fieldset>
          <fieldset className={styles.checkGroup}>
            <legend className={styles.label}>Visual</legend>
            {VISUAL_OPTIONS.map((opt) => (
              <label key={opt.value} className={styles.checkRow}>
                <input type="checkbox" checked={settings.visual.includes(opt.value)}
                  onChange={() => set("visual", toggle(settings.visual, opt.value))} />
                {opt.label}
              </label>
            ))}
          </fieldset>
        </div>
      </section>

      <section aria-labelledby="en-continue">
        <h3 id="en-continue" className={styles.sectionTitle}>Continue</h3>
        {saveError && (
          <p className={styles.errorText} role="alert" style={{ marginBottom: "var(--space-3)" }}>
            <strong>Save problem:</strong> {saveError}
          </p>
        )}
        <div className={styles.buttonRow}>
          <Button variant="primary" onClick={save} loading={saving}>
            Save Project &amp; Continue
          </Button>
          <span className={styles.muted}>
            Creates exactly one enhancement project with one source — no clip detection runs here.
          </span>
        </div>
      </section>
    </div>
  );
}
