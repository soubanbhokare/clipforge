import styles from "./States.module.css";

export default function LoadingState({ message = "Loading…" }: { message?: string }) {
  return (
    <div className={styles.state} role="status" aria-live="polite">
      <div className={styles.spinner} aria-hidden="true" />
      <p>{message}</p>
    </div>
  );
}
