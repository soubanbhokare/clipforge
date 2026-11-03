import type { SelectHTMLAttributes } from "react";
import styles from "./Form.module.css";

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  id: string;
  hint?: string;
  error?: string;
  options: { value: string; label: string }[];
}

export default function Select({ label, id, hint, error, options, ...rest }: SelectProps) {
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>{label}</label>
      <select
        id={id}
        className={`${styles.control} ${error ? styles.controlInvalid : ""}`}
        aria-invalid={Boolean(error)}
        {...rest}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {error ? <span className={styles.error} role="alert">{error}</span>
        : hint ? <span className={styles.hint}>{hint}</span> : null}
    </div>
  );
}
