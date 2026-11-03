import type { ReactNode } from "react";
import styles from "./States.module.css";

interface EmptyStateProps {
  title: string;
  description: string;
  action?: ReactNode;
}

export default function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className={styles.state}>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
