import styles from "./ProgressBar.module.css";

interface ProgressBarProps {
  // Render ONLY when real progress exists. Callers must not pass a
  // guessed or fake value — with no job running, render nothing.
  value: number;
  label: string;
}

export default function ProgressBar({ value, label }: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div>
      <div className={styles.row}>
        <span>{label}</span>
        <span>{clamped}%</span>
      </div>
      <div
        className={styles.track}
        role="progressbar"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div className={styles.fill} style={{ width: `${clamped}%` }} />
      </div>
    </div>
  );
}
