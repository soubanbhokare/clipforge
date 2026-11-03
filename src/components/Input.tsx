import type { InputHTMLAttributes } from "react";
import styles from "./Form.module.css";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  id: string;
  hint?: string;
  error?: string;
}

export default function Input({ label, id, hint, error, ...rest }: InputProps) {
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>{label}</label>
      <input
        id={id}
        className={`${styles.control} ${error ? styles.controlInvalid : ""}`}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy}
        {...rest}
      />
      {error ? <span id={`${id}-error`} className={styles.error} role="alert">{error}</span>
        : hint ? <span id={`${id}-hint`} className={styles.hint}>{hint}</span> : null}
    </div>
  );
}
