import { useState, type ReactNode } from "react";
import Logo from "../../components/Logo";
import styles from "./AuthPages.module.css";

/**
 * Shared frame for every auth screen — a split composition: a
 * typographic brand panel on one side (approved logo, the landing
 * page's voice, and the product's real capabilities — no statistics,
 * no testimonials, no media) and the form column on the other. On
 * narrow screens the panel collapses to a compact header band.
 * Same branding, spacing tokens and focus style as the landing page.
 */

const BRAND_FEATURES: { title: string; description: string }[] = [
  {
    title: "AI Clip Detection",
    description:
      "Ranks the strongest moments from your transcript, pauses and scene changes.",
  },
  {
    title: "Captions Studio",
    description:
      "Word-timed captions in your brand style — burned in or exported as files.",
  },
  {
    title: "Face Lock & Auto-Reframing",
    description:
      "Follows the active speaker and reframes for 9:16, 1:1 and 16:9.",
  },
  {
    title: "Batch Export Studio",
    description:
      "Queue a single clip or a whole batch and export them together.",
  },
];

export function AuthLayout({
  headline,
  description,
  children,
  footer,
}: {
  headline: string;
  description: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className={styles.page}>
      <aside className={styles.brandPanel}>
        <div className={styles.brandTop}>
          <a className={styles.logoLink} href="#" aria-label="CLIPFORGE home">
            <Logo />
          </a>
          <p className={styles.brandTagline}>
            One video. Multiple shorts. Ready to publish.
          </p>
        </div>

        <div className={styles.brandCopy}>
          <p className={styles.brandEyebrow}>Video-to-shorts studio</p>
          <p className={styles.brandHeadline}>
            <span>One video.</span>
            <span>Multiple shorts.</span>
            <span className={styles.brandLineAccent}>Ready to publish.</span>
          </p>
          <ul className={styles.brandFeatures}>
            {BRAND_FEATURES.map((feature) => (
              <li className={styles.brandFeature} key={feature.title}>
                <span className={styles.brandFeatureText}>
                  <span className={styles.brandFeatureTitle}>{feature.title}</span>
                  <span className={styles.brandFeatureDesc}>
                    {feature.description}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <p className={styles.brandFoot}>
          Your projects, clips and exports live in your workspace — pick up
          right where you left off.
        </p>
      </aside>

      <main className={styles.main}>
        <h1 className={styles.headline}>{headline}</h1>
        <p className={styles.description}>{description}</p>
        <div className={styles.card}>{children}</div>
        {footer ? <div className={styles.footer}>{footer}</div> : null}
      </main>
    </div>
  );
}

/** Password input with an accessible show/hide toggle. */
export function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  error,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  error?: string | null;
  hint?: string | null;
}) {
  const [visible, setVisible] = useState(false);
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <div className={styles.passwordWrap}>
        <input
          id={id}
          className={styles.input}
          type={visible ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
        />
        <button
          type="button"
          className={styles.toggle}
          onClick={() => setVisible((v) => !v)}
          aria-pressed={visible}
          aria-label={visible ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
        >
          {visible ? "Hide" : "Show"}
        </button>
      </div>
      {error ? (
        <p className={styles.fieldError} id={`${id}-error`} role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className={styles.hint} id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** Email / text input with label + inline error. */
export function TextField({
  id,
  label,
  type = "text",
  value,
  onChange,
  autoComplete,
  error,
}: {
  id: string;
  label: string;
  type?: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  error?: string | null;
}) {
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className={styles.input}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
      />
      {error ? (
        <p className={styles.fieldError} id={`${id}-error`} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
