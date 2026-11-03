// Phase 6 — Templates & Brand Kit page.
//
// Brand kits are REAL user data (server: /api/brand-kits): brand
// name, colours, font, caption template + assets (logo / intro /
// outro / music / overlay). Applying a kit writes its caption style,
// template and brand settings into the chosen projects' editor
// documents. The approved CLIPFORGE logo ships as the seeded kit's
// logo asset and is never redrawn — assets are user uploads, stored
// and served byte-for-byte.
//
// Caption templates themselves are edited inside the editor's
// Captions Studio (where the video preview lives); this page lists
// them and allows duplicate/delete for customs.

import { useCallback, useEffect, useState } from "react";
import {
  brandApi,
  captionsApi,
  DEFAULT_CAPTION_STYLE,
  type BrandAsset,
  type BrandAssetKind,
  type BrandKit,
  type BrandKitInput,
  type CaptionTemplate,
} from "../services/captions";
import { projectsApi, type Project } from "../services/projects";
import styles from "./Templates.module.css";

const ASSET_KINDS: { kind: BrandAssetKind; label: string; accept: string }[] = [
  { kind: "LOGO", label: "Logo", accept: ".png,.jpg,.jpeg,.webp,.svg,.mp4,.mov,.webm" },
  { kind: "INTRO", label: "Intro", accept: ".mp4,.mov,.webm" },
  { kind: "OUTRO", label: "Outro", accept: ".mp4,.mov,.webm" },
  { kind: "MUSIC", label: "Music", accept: ".mp3,.wav,.m4a,.ogg,.flac" },
  { kind: "OVERLAY", label: "Overlay", accept: ".png,.jpg,.jpeg,.webp,.mp4,.mov,.webm" },
];

function emptyKitForm(): BrandKitInput {
  return {
    name: "",
    brandName: "",
    primaryColor: "#1558C9",
    secondaryColor: "#030407",
    accentColor: "#D4FF24",
    fontFamily: "Noto Sans",
    captionTemplateId: "builtin:clipforge-signature",
    captionStyle: null,
    logoAssetId: null,
    introAssetId: null,
    outroAssetId: null,
    musicAssetId: null,
    overlayAssetId: null,
  };
}

function kitToForm(kit: BrandKit): BrandKitInput {
  return {
    name: kit.name,
    brandName: kit.brandName,
    primaryColor: kit.primaryColor,
    secondaryColor: kit.secondaryColor,
    accentColor: kit.accentColor,
    fontFamily: kit.fontFamily,
    captionTemplateId: kit.captionTemplateId,
    captionStyle: kit.captionStyle,
    logoAssetId: kit.logoAssetId,
    introAssetId: kit.introAssetId,
    outroAssetId: kit.outroAssetId,
    musicAssetId: kit.musicAssetId,
    overlayAssetId: kit.overlayAssetId,
  };
}

export default function TemplatesPage() {
  const [kits, setKits] = useState<BrandKit[]>([]);
  const [assets, setAssets] = useState<BrandAsset[]>([]);
  const [templates, setTemplates] = useState<CaptionTemplate[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [fonts, setFonts] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<BrandKitInput>(emptyKitForm());
  const [creating, setCreating] = useState(false);

  const [applyKitId, setApplyKitId] = useState("");
  const [applyProjects, setApplyProjects] = useState<Set<string>>(new Set());
  const [applyResults, setApplyResults] = useState<{ projectId: string; ok: boolean; error?: string }[] | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [{ kits: k }, { assets: a }, { templates: t }, fontInfo, projectList] = await Promise.all([
        brandApi.listKits(),
        brandApi.listAssets(),
        captionsApi.listTemplates(),
        captionsApi.fonts(),
        projectsApi.listProjects({ pageSize: 100 }),
      ]);
      setKits(k);
      setAssets(a);
      setTemplates(t);
      setFonts(fontInfo.fonts);
      setProjects(projectList.projects);
      setApplyKitId((prev) => prev || k.find((x) => x.isDefault)?.id || k[0]?.id || "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load brand kits.");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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

  const assetsOfKind = (kind: BrandAssetKind) => assets.filter((a) => a.kind === kind);

  const assetSelect = (
    label: string,
    kind: BrandAssetKind,
    value: string | null,
    onChange: (v: string | null) => void,
  ) => (
    <div className={styles.field}>
      <label>{label}</label>
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">None</option>
        {assetsOfKind(kind).map((a) => (
          <option key={a.id} value={a.id}>
            {a.filename}
          </option>
        ))}
      </select>
    </div>
  );

  const kitForm = (isNew: boolean) => (
    <form
      className={styles.kitForm}
      onSubmit={(e) => {
        e.preventDefault();
        void run(isNew ? "create-kit" : "save-kit", async () => {
          if (isNew) {
            const { kit } = await brandApi.createKit(form);
            setKits((prev) => [...prev, kit]);
            setCreating(false);
            setForm(emptyKitForm());
            setNotice(`Created brand kit “${kit.name}”.`);
          } else if (editingId) {
            const { kit } = await brandApi.updateKit(editingId, form);
            setKits((prev) => prev.map((x) => (x.id === kit.id ? kit : x)));
            setEditingId(null);
            setNotice(`Saved brand kit “${kit.name}”.`);
          }
        });
      }}
    >
      <div className={styles.fieldGrid}>
        <div className={styles.field}>
          <label>Kit name</label>
          <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div className={styles.field}>
          <label>Brand name</label>
          <input required value={form.brandName} onChange={(e) => setForm({ ...form, brandName: e.target.value })} />
        </div>
        <div className={styles.field}>
          <label>Primary colour</label>
          <input type="color" value={form.primaryColor} onChange={(e) => setForm({ ...form, primaryColor: e.target.value.toUpperCase() })} />
        </div>
        <div className={styles.field}>
          <label>Secondary colour</label>
          <input type="color" value={form.secondaryColor} onChange={(e) => setForm({ ...form, secondaryColor: e.target.value.toUpperCase() })} />
        </div>
        <div className={styles.field}>
          <label>Accent colour</label>
          <input type="color" value={form.accentColor} onChange={(e) => setForm({ ...form, accentColor: e.target.value.toUpperCase() })} />
        </div>
        <div className={styles.field}>
          <label>Brand font</label>
          <select value={form.fontFamily ?? ""} onChange={(e) => setForm({ ...form, fontFamily: e.target.value || null })}>
            <option value="">Template's font</option>
            {(fonts.length > 0 ? fonts : ["Noto Sans"]).map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label>Caption template</label>
          <select
            value={form.captionTemplateId ?? ""}
            onChange={(e) => setForm({ ...form, captionTemplateId: e.target.value || null })}
          >
            <option value="">Kit's own caption style below</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.builtin ? " (built-in)" : ""}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label>
            <input
              type="checkbox"
              checked={form.captionStyle !== null && form.captionStyle !== undefined}
              onChange={(e) =>
                setForm({ ...form, captionStyle: e.target.checked ? { ...DEFAULT_CAPTION_STYLE } : null })
              }
            />{" "}
            Custom caption style (derived from the brand colours)
          </label>
          {form.captionStyle && (
            <button
              type="button"
              className={styles.miniButton}
              onClick={() =>
                setForm({
                  ...form,
                  captionStyle: {
                    ...(form.captionStyle ?? DEFAULT_CAPTION_STYLE),
                    backgroundColor: form.secondaryColor,
                    highlightColor: form.accentColor,
                    fontFamily: form.fontFamily ?? DEFAULT_CAPTION_STYLE.fontFamily,
                  },
                })
              }
            >
              Sync style from brand colours + font
            </button>
          )}
        </div>
      </div>
      <div className={styles.fieldGrid}>
        {assetSelect("Logo asset", "LOGO", form.logoAssetId ?? null, (v) => setForm({ ...form, logoAssetId: v }))}
        {assetSelect("Intro asset", "INTRO", form.introAssetId ?? null, (v) => setForm({ ...form, introAssetId: v }))}
        {assetSelect("Outro asset", "OUTRO", form.outroAssetId ?? null, (v) => setForm({ ...form, outroAssetId: v }))}
        {assetSelect("Music asset", "MUSIC", form.musicAssetId ?? null, (v) => setForm({ ...form, musicAssetId: v }))}
        {assetSelect("Overlay asset", "OVERLAY", form.overlayAssetId ?? null, (v) => setForm({ ...form, overlayAssetId: v }))}
      </div>
      <div className={styles.actions}>
        <button type="submit" className={styles.primaryButton} disabled={busy !== null}>
          {isNew ? "Create kit" : "Save kit"}
        </button>
        <button
          type="button"
          className={styles.miniButton}
          onClick={() => {
            setCreating(false);
            setEditingId(null);
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );

  return (
    <div className={styles.page}>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {notice && <p className={styles.notice}>{notice}</p>}

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h3>Brand kits</h3>
          <button type="button" className={styles.primaryButton} onClick={() => { setCreating(true); setEditingId(null); setForm(emptyKitForm()); }}>
            New brand kit
          </button>
        </div>
        <p className={styles.muted}>
          Deleting all kits restores the default CLIPFORGE Brand kit — the server re-seeds it, so
          this list is never left empty.
        </p>
        {creating && kitForm(true)}
        <div className={styles.kitGrid}>
          {kits.map((kit) => (
            <article key={kit.id} className={styles.kitCard}>
              <div className={styles.kitHead}>
                <strong>{kit.name}</strong>
                {kit.isDefault && <span className={styles.badge}>Default</span>}
              </div>
              <p className={styles.kitBrand}>{kit.brandName}</p>
              <div className={styles.swatches}>
                <span style={{ background: kit.primaryColor }} title={`Primary ${kit.primaryColor}`} />
                <span style={{ background: kit.secondaryColor }} title={`Secondary ${kit.secondaryColor}`} />
                <span style={{ background: kit.accentColor }} title={`Accent ${kit.accentColor}`} />
              </div>
              <dl className={styles.kitMeta}>
                <div><dt>Font</dt><dd>{kit.fontFamily ?? "Template's"}</dd></div>
                <div><dt>Template</dt><dd>{templates.find((t) => t.id === kit.captionTemplateId)?.name ?? (kit.captionStyle ? "Custom style" : "—")}</dd></div>
                <div><dt>Logo</dt><dd>{assets.find((a) => a.id === kit.logoAssetId)?.filename ?? "—"}</dd></div>
                <div><dt>Intro / Outro</dt><dd>{assets.find((a) => a.id === kit.introAssetId)?.filename ?? "—"} / {assets.find((a) => a.id === kit.outroAssetId)?.filename ?? "—"}</dd></div>
                <div><dt>Music</dt><dd>{assets.find((a) => a.id === kit.musicAssetId)?.filename ?? "—"}</dd></div>
                <div><dt>Overlay</dt><dd>{assets.find((a) => a.id === kit.overlayAssetId)?.filename ?? "—"}</dd></div>
              </dl>
              <div className={styles.actions}>
                <button type="button" className={styles.miniButton} onClick={() => { setEditingId(kit.id); setCreating(false); setForm(kitToForm(kit)); }}>
                  Edit
                </button>
                <button
                  type="button"
                  className={styles.miniButton}
                  disabled={busy !== null}
                  onClick={() =>
                    void run("duplicate-kit", async () => {
                      const { kit: copy } = await brandApi.duplicateKit(kit.id);
                      setKits((prev) => [...prev, copy]);
                      setNotice(`Duplicated as “${copy.name}”.`);
                    })
                  }
                >
                  Duplicate
                </button>
                {!kit.isDefault && (
                  <button
                    type="button"
                    className={styles.miniButton}
                    disabled={busy !== null}
                    onClick={() =>
                      void run("default-kit", async () => {
                        await brandApi.setDefaultKit(kit.id);
                        await refresh();
                      })
                    }
                  >
                    Set as default
                  </button>
                )}
                <button
                  type="button"
                  className={`${styles.miniButton} ${styles.danger}`}
                  disabled={busy !== null}
                  onClick={() =>
                    void run("delete-kit", async () => {
                      await brandApi.deleteKit(kit.id);
                      if (editingId === kit.id) setEditingId(null);
                      // Re-fetch rather than filtering locally: when the
                      // last kit is deleted the server re-seeds the
                      // default kit, and a local filter would wrongly
                      // show an empty list here.
                      await refresh();
                      setNotice(`Deleted brand kit “${kit.name}”.`);
                    })
                  }
                >
                  Delete
                </button>
              </div>
              {editingId === kit.id && kitForm(false)}
            </article>
          ))}
          {kits.length === 0 && <p className={styles.muted}>No brand kits yet.</p>}
        </div>
      </section>

      <section className={styles.section}>
        <h3>Brand assets</h3>
        <p className={styles.muted}>
          Uploads are stored exactly as provided and served back byte-for-byte — the approved
          CLIPFORGE logo in the seeded kit is the owner's artwork, never redrawn. SVG logos are
          accepted as images (they are not probed as video/audio).
        </p>
        <p className={styles.muted}>
          Please note: intro, outro, music and overlay assets are stored and linked to the kit,
          but they are NOT composited into rendered videos — only the caption
          template/style, brand font and colours are applied to a project.
        </p>
        <div className={styles.fieldGrid}>
          {ASSET_KINDS.map(({ kind, label, accept }) => (
            <div key={kind} className={styles.field}>
              <label>{`Upload ${label.toLowerCase()}`}</label>
              <input
                type="file"
                accept={accept}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file) return;
                  void run(`upload-${kind}`, async () => {
                    const { asset } = await brandApi.uploadAsset(file, kind);
                    setAssets((prev) => [...prev, asset]);
                    setNotice(`Uploaded ${asset.filename} as a ${label.toLowerCase()} asset.`);
                  });
                }}
              />
            </div>
          ))}
        </div>
        <ul className={styles.assetList}>
          {assets.map((a) => (
            <li key={a.id}>
              <span className={styles.badge}>{a.kind}</span> {a.filename}
              {a.duration ? ` · ${a.duration.toFixed(1)}s` : ""}
              {a.width && a.height ? ` · ${a.width}×${a.height}` : ""}
              <button
                type="button"
                className={`${styles.miniButton} ${styles.danger}`}
                disabled={busy !== null}
                onClick={() =>
                  void run("delete-asset", async () => {
                    await brandApi.deleteAsset(a.id);
                    setAssets((prev) => prev.filter((x) => x.id !== a.id));
                    await refresh();
                  })
                }
              >
                Delete
              </button>
            </li>
          ))}
          {assets.length === 0 && <li className={styles.muted}>No assets uploaded yet.</li>}
        </ul>
      </section>

      <section className={styles.section}>
        <h3>Apply a kit to clips</h3>
        <p className={styles.muted}>
          Applying writes the kit's caption template/style and brand font into each selected
          project's editor document and records the kit on it, so the kit's assets stay linked
          (undoable in the editor). Projects you don't own are never touched.
        </p>
        <div className={styles.fieldGrid}>
          <div className={styles.field}>
            <label>Brand kit</label>
            <select value={applyKitId} onChange={(e) => setApplyKitId(e.target.value)}>
              {kits.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className={styles.projectList}>
          {projects.map((p) => (
            <label key={p.id} className={styles.projectRow}>
              <input
                type="checkbox"
                checked={applyProjects.has(p.id)}
                onChange={(e) =>
                  setApplyProjects((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(p.id);
                    else next.delete(p.id);
                    return next;
                  })
                }
              />
              {p.name}
              <span className={styles.muted}> · {p.workflowType}</span>
            </label>
          ))}
          {projects.length === 0 && <p className={styles.muted}>No projects yet — create one in the Studio first.</p>}
        </div>
        <button
          type="button"
          className={styles.primaryButton}
          disabled={busy !== null || !applyKitId || applyProjects.size === 0}
          onClick={() =>
            void run("apply-kit", async () => {
              const res = await brandApi.applyKit(applyKitId, [...applyProjects]);
              setApplyResults(res.results);
              const ok = res.results.filter((r) => r.ok).length;
              setNotice(`Applied the kit to ${ok} of ${res.results.length} selected projects.`);
            })
          }
        >
          {busy === "apply-kit" ? "Applying…" : `Apply to ${applyProjects.size} selected`}
        </button>
        {applyResults && (
          <ul className={styles.assetList}>
            {applyResults.map((r) => (
              <li key={r.projectId}>
                {projects.find((p) => p.id === r.projectId)?.name ?? r.projectId}:{" "}
                {r.ok ? "applied" : `failed — ${r.error ?? "unknown error"}`}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.section}>
        <h3>Caption templates</h3>
        <p className={styles.muted}>
          Templates are style configurations — open any clip in the editor and use Captions Studio
          to preview them on the video, edit them and save your own.
        </p>
        <div className={styles.kitGrid}>
          {templates.map((t) => (
            <article key={t.id} className={styles.kitCard}>
              <div
                className={styles.templatePreview}
                style={{
                  background: t.style.backgroundColor,
                  color: t.style.textColor,
                  fontFamily: t.style.fontFamily,
                  fontWeight: t.style.fontWeight,
                }}
              >
                The quick <span style={{ color: t.style.highlightColor }}>brown</span> fox
              </div>
              <div className={styles.kitHead}>
                <strong>{t.name}</strong>
                <span className={styles.badge}>{t.builtin ? "Built-in" : "Custom"}</span>
              </div>
              <p className={styles.muted}>
                {t.style.fontFamily} · {t.style.animation} · {t.style.position}
              </p>
              <div className={styles.actions}>
                {t.builtin && (
                  <button
                    type="button"
                    className={styles.miniButton}
                    disabled={busy !== null}
                    onClick={() =>
                      void run("edit-template-copy", async () => {
                        // Edit-as-copy: built-ins stay unchanged; the
                        // copy is yours to edit in Captions Studio.
                        const { template } = await captionsApi.duplicateTemplate(t.id, `${t.name} (edited)`);
                        setTemplates((prev) => [...prev, template]);
                        setNotice(
                          `Created your editable copy “${template.name}” — the built-in is unchanged. Open a clip in the editor's Captions Studio to edit it.`,
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
                    })
                  }
                >
                  Duplicate
                </button>
                {!t.builtin && (
                  <button
                    type="button"
                    className={`${styles.miniButton} ${styles.danger}`}
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
                )}
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
