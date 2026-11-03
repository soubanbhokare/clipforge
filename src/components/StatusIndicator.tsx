import styles from "./StatusIndicator.module.css";

export type StatusKind = "idle" | "ready" | "processing" | "success" | "warning" | "error";

interface StatusIndicatorProps {
  status: StatusKind;
  label: string;
}

// Status is NEVER colour alone: the label text and the marker
// character are always present, so the meaning survives without colour.
const MARKER: Record<StatusKind, string> = {
  idle: "○",
  ready: "●",
  processing: "◐",
  success: "✓",
  warning: "!",
  error: "×",
};

export default function StatusIndicator({ status, label }: StatusIndicatorProps) {
  return (
    <span className={`${styles.indicator} ${styles[status]}`}>
      <span aria-hidden="true">{MARKER[status]}</span>
      <span>{label}</span>
    </span>
  );
}
