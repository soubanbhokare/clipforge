import { useEffect, useState } from "react";
import Button from "../../components/Button";
import GuestRestriction from "../../components/studio/GuestRestriction";
import SourcePanel from "../../components/studio/SourcePanel";
import { useAuth } from "../../features/auth/AuthContext";
import { navigateTo } from "../../features/auth/routing";
import {
  DEFAULT_SHORTS_SETTINGS,
  shortsSettingsFrom,
  type ShortsSettings,
} from "../../features/studio/settings";
import styles from "../../features/studio/Studio.module.css";
import { useProjectEditor } from "../../features/studio/useProjectEditor";
import { AuthApiError } from "../../services/auth";

const PROMPT_SUGGESTIONS = [
  "Find the funniest moments.",
  "Find the most useful educational tips.",
  "Find strong podcast statements.",
  "Find important questions and answers.",
  "Find motivational moments.",
  "Extract all moments related to a particular topic",
];

const AUDIO_OPTIONS: { value: string; label: string }[] = [
  { value: "preserve", label: "Preserve original audio" },
  { value: "silence-removal", label: "Silence removal (later processing service)" },
  { value: "enhancement", label: "Audio enhancement (later processing service)" },
  { value: "background-music", label: "Background music (later processing service)" },
  { value: "voice-emphasis", label: "Voice emphasis (later processing service)" },
];

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export default function CreateShortsPage() {
  const { isGuest } = useAuth();
  const editor = useProjectEditor("LONG_VIDEO_TO_SHORTS");
  const [settings, setSettings] = useState<ShortsSettings>(DEFAULT_SHORTS_SETTINGS);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [appliedStored, setAppliedStored] = useState(false);

  useEffect(() => {
    if (!appliedStored && editor.loadedFromUrl && editor.project) {
      setSettings(shortsSettingsFrom(editor.project.settings));
      setAppliedStored(true);
    }
  }, [appliedStored, editor.loadedFromUrl, editor.project]);

  if (isGuest) {
    return (
      <div className={styles.stack}>
        <GuestRestriction action="Create multiple shorts" />
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
          <strong>Wrong workflow:</strong> this project is an Enhance Video project. Open it from{" "}
          <a href={`#/app/studio/enhance?project=${editor.wrongWorkflow.id}`}>Enhance Existing Video</a>{" "}
          instead.
        </p>
      </div>
    );
  }

  const set = <K extends keyof ShortsSettings>(key: K, value: ShortsSettings[K]) =>
    setSettings((s) => ({ ...s, [key]: value }));

  const save = async () => {
    setSaveError(null);
    if (!editor.projectName.trim()) {
      setSaveError("Enter a project name before saving.");
      return;
    }
    if (settings.clipCount === "custom") {
      const count = settings.customClipCount;
      if (count === null || !Number.isInteger(count) || count < 1 || count > 50) {
        setSaveError("Enter a custom clip count between 1 and 50.");
        return;
      }
    }
    if (settings.clipDuration === "custom") {
      const duration = settings.customClipDurationSec;
      if (duration === null || !Number.isFinite(duration) || duration < 5 || duration > 600) {
        setSaveError("Enter a custom clip duration between 5 and 600 seconds.");
        return;
      }
    }
    setSaving(true);
    try {
      const project = await editor.saveSettings(
        settings as unknown as Record<string, unknown>,
      );
      navigateTo(`app/projects/${project.id}`);
    } catch (err) {
      setSaveError(err instanceof AuthApiError ? err.message : "Could not save the project. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.stack}>
      <div>
        <h2 className={styles.heading}>Turn one long video into multiple shorts.</h2>
        <p className={styles.lede}>
          A long source video is prepared and saved here as a project. Paste a URL below and
          hit <strong>Generate Clips</strong> to import the video and find its clips in one
          click — or upload a file and generate from the project page.
        </p>
      </div>

      <section className={styles.panel} aria-labelledby="cs-name">
        <div className={styles.field}>
          <label className={styles.label} htmlFor="cs-name">Project name</label>
          <input
            id="cs-name"
            className={styles.input}
            value={editor.projectName}
            required
            maxLength={120}
            placeholder="e.g. Podcast episode 12 — shorts"
            onChange={(e) => editor.setProjectName(e.target.value)}
          />
        </div>
      </section>

      <section className={styles.panel} aria-labelledby="cs-source">
        <h3 id="cs-source">Step 1–2 · Select source &amp; preview</h3>
        <p className={styles.panelIntro}>
          Add a source video. Its real metadata is read by the server after upload — nothing is
          invented here.
        </p>
        <SourcePanel
          projectId={editor.projectId}
          asset={editor.asset}
          ensureProject={editor.ensureProject}
          onAttachYouTube={editor.attachYouTube}
          onAssetChange={editor.setAsset}
          aiInstruction={settings.discoveryPrompt}
          enableGenerate
        />
      </section>

      <section className={styles.panel} aria-labelledby="cs-settings">
        <h3 id="cs-settings">Step 3 · Generation settings</h3>
        <p className={styles.panelIntro}>
          These preferences are saved with the project and used when its clips are generated,
          tracked and enhanced. Saving a preference here does not apply it — processing runs
          from the project page and the editor.
        </p>
        <div className={styles.formGrid}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="cs-count">Clip count</label>
            <select id="cs-count" className={styles.select} value={settings.clipCount} onChange={(e) => set("clipCount", e.target.value as ShortsSettings["clipCount"])}>
              <option value="1">1</option>
              <option value="3">3</option>
              <option value="5">5</option>
              <option value="10">10</option>
              <option value="custom">Custom</option>
            </select>
          </div>
          {settings.clipCount === "custom" && (
            <div className={styles.field}>
              <label className={styles.label} htmlFor="cs-count-custom">Custom clip count (1–50)</label>
              <input id="cs-count-custom" className={styles.input} type="number" min={1} max={50}
                value={settings.customClipCount ?? ""} onChange={(e) => set("customClipCount", e.target.value === "" ? null : Number(e.target.value))} />
            </div>
          )}
          <div className={styles.field}>
            <label className={styles.label} htmlFor="cs-duration">Clip duration</label>
            <select id="cs-duration" className={styles.select} value={settings.clipDuration} onChange={(e) => set("clipDuration", e.target.value as ShortsSettings["clipDuration"])}>
              <option value="auto">Automatic</option>
              <option value="15">15 seconds</option>
              <option value="30">30 seconds</option>
              <option value="45">45 seconds</option>
              <option value="60">60 seconds</option>
              <option value="custom">Custom</option>
            </select>
          </div>
          {settings.clipDuration === "custom" && (
            <div className={styles.field}>
              <label className={styles.label} htmlFor="cs-duration-custom">Custom duration (seconds, 5–600)</label>
              <input id="cs-duration-custom" className={styles.input} type="number" min={5} max={600}
                value={settings.customClipDurationSec ?? ""} onChange={(e) => set("customClipDurationSec", e.target.value === "" ? null : Number(e.target.value))} />
            </div>
          )}
          <div className={styles.field}>
            <label className={styles.label} htmlFor="cs-aspect">Output aspect ratio</label>
            <select id="cs-aspect" className={styles.select} value={settings.aspectRatio} onChange={(e) => set("aspectRatio", e.target.value as ShortsSettings["aspectRatio"])}>
              <option value="9:16">9:16</option>
              <option value="1:1">1:1</option>
              <option value="16:9">16:9</option>
              <option value="4:5">4:5</option>
            </select>
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="cs-resolution">Output resolution</label>
            <select id="cs-resolution" className={styles.select} value={settings.resolution} onChange={(e) => set("resolution", e.target.value as ShortsSettings["resolution"])}>
              <option value="720p">720p</option>
              <option value="1080p">1080p</option>
              <option value="4k">4K (where the processing pipeline supports it)</option>
            </select>
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="cs-platform">Target platform</label>
            <select id="cs-platform" className={styles.select} value={settings.targetPlatform} onChange={(e) => set("targetPlatform", e.target.value as ShortsSettings["targetPlatform"])}>
              <option value="youtube-shorts">YouTube Shorts</option>
              <option value="instagram-reels">Instagram Reels</option>
              <option value="tiktok">TikTok</option>
              <option value="custom">Custom</option>
            </select>
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="cs-language">Language</label>
            <select id="cs-language" className={styles.select} value={settings.language} onChange={(e) => set("language", e.target.value as ShortsSettings["language"])}>
              <option value="auto">Auto Detect</option>
              <option value="en">English</option>
              <option value="hi">Hindi</option>
              <option value="mr">Marathi</option>
              <option value="other">Other (from the connected transcription provider)</option>
            </select>
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="cs-capstyle">Caption style</label>
            <select id="cs-capstyle" className={styles.select} value={settings.captions.style}
              onChange={(e) => set("captions", { ...settings.captions, style: e.target.value as ShortsSettings["captions"]["style"] })}>
              <option value="clean">Clean</option>
              <option value="bold">Bold</option>
              <option value="minimal">Minimal</option>
              <option value="highlight">Highlight</option>
            </select>
          </div>
          <div className={styles.field}>
            <span className={styles.label}>Caption preferences</span>
            <label className={styles.checkRow}>
              <input type="checkbox" checked={settings.captions.enabled}
                onChange={(e) => set("captions", { ...settings.captions, enabled: e.target.checked })} />
              Automatic captions on
            </label>
            <label className={styles.checkRow}>
              <input type="checkbox" checked={settings.captions.animatedHighlight}
                onChange={(e) => set("captions", { ...settings.captions, animatedHighlight: e.target.checked })} />
              Animated word highlighting
            </label>
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="cs-tracking">Face and subject tracking</label>
            <select id="cs-tracking" className={styles.select} value={settings.tracking} onChange={(e) => set("tracking", e.target.value as ShortsSettings["tracking"])}>
              <option value="face-lock">Auto Face Lock</option>
              <option value="auto-follow">Auto Follow</option>
              <option value="active-speaker">Active Speaker</option>
              <option value="center">Center Subject</option>
              <option value="manual">Manual Selection</option>
              <option value="none">No Tracking</option>
            </select>
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="cs-zoom">Zoom</label>
            <select id="cs-zoom" className={styles.select} value={settings.zoom} onChange={(e) => set("zoom", e.target.value as ShortsSettings["zoom"])}>
              <option value="subtle">Subtle</option>
              <option value="balanced">Balanced</option>
              <option value="dynamic">Dynamic</option>
              <option value="manual">Manual</option>
            </select>
          </div>
          <fieldset className={styles.checkGroup}>
            <legend className={styles.label}>Audio options</legend>
            {AUDIO_OPTIONS.map((opt) => (
              <label key={opt.value} className={styles.checkRow}>
                <input type="checkbox" checked={settings.audio.includes(opt.value)}
                  onChange={() => set("audio", toggle(settings.audio, opt.value))} />
                {opt.label}
              </label>
            ))}
          </fieldset>
        </div>
      </section>

      <section className={styles.panel} aria-labelledby="cs-prompt">
        <h3 id="cs-prompt">Step 4 · What should AI find in this video?</h3>
        <p className={styles.panelIntro}>
          Used by clip analysis — including the one-click Generate Clips beside the URL field
          above, and Find Clips on the project page. Suggestions:
        </p>
        <div className={styles.buttonRow} style={{ marginBottom: "var(--space-4)" }}>
          {PROMPT_SUGGESTIONS.map((s) => (
            <button key={s} type="button" className={styles.sourceTab} onClick={() => set("discoveryPrompt", s)}>
              {s}
            </button>
          ))}
        </div>
        <div className={styles.formGrid}>
          <div className={`${styles.field} ${styles.fieldFull}`}>
            <label className={styles.label} htmlFor="cs-prompt-input">Clip discovery instructions</label>
            <textarea
              id="cs-prompt-input"
              className={styles.textarea}
              maxLength={500}
              placeholder="Find the funniest moments."
              value={settings.discoveryPrompt}
              onChange={(e) => set("discoveryPrompt", e.target.value)}
            />
            <span className={styles.charCount}>{settings.discoveryPrompt.length}/500</span>
          </div>
          <div className={`${styles.field} ${styles.fieldFull}`}>
            <label className={styles.label} htmlFor="cs-context">Transcription context (optional)</label>
            <textarea
              id="cs-context"
              className={styles.textarea}
              maxLength={1000}
              placeholder="Speaker names, brand names, technical terms, product names, acronyms…"
              value={settings.transcriptionContext}
              onChange={(e) => set("transcriptionContext", e.target.value)}
            />
            <span className={styles.charCount}>{settings.transcriptionContext.length}/1000</span>
          </div>
        </div>
      </section>

      <section aria-labelledby="cs-continue">
        <h3 id="cs-continue" className={styles.sectionTitle}>Step 5 · Continue</h3>
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
            This step only saves the project and its configuration. If you pasted a URL above,
            Generate Clips there already imports the video and searches for clips in one click;
            you can also generate and review clips from the project page.
          </span>
        </div>
      </section>
    </div>
  );
}
