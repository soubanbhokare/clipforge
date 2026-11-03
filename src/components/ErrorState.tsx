import Button from "./Button";
import styles from "./States.module.css";

interface ErrorStateProps {
  title?: string;
  message: string;
  onRetry?: () => void;
}

export default function ErrorState({
  title = "Something went wrong",
  message,
  onRetry,
}: ErrorStateProps) {
  return (
    <div className={styles.state} role="alert">
      <h3>× {title}</h3>
      <p>{message}</p>
      {onRetry ? <Button variant="secondary" onClick={onRetry}>Try again</Button> : null}
    </div>
  );
}
