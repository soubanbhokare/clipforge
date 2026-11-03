import type { TextareaHTMLAttributes } from "react";
import styles from "./Form.module.css";

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  id: string;
  hint?: string;
  error?: string;
}

export default function Textarea({ label, id, hint, error, ...rest }: TextareaProps) {
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>{label}</label>
      <textarea
        id={id}
        className={`${styles.control} ${styles.textarea} ${error ? styles.controlInvalid : ""}`}
        aria-invalid={Boolean(error)}
        {...rest}
      />
      {error ? <span className={styles.error} role="alert">{error}</span>
        : hint ? <span className={styles.hint}>{hint}</span> : null}
    </div>
  );
}
