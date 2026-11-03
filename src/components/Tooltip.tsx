import type { ReactNode } from "react";
import styles from "./Tooltip.module.css";

interface TooltipProps {
  text: string;
  children: ReactNode;
}

// CSS-only tooltip: visible on hover and on keyboard focus,
// so it works without a mouse. The wrapped control keeps its own label.
export default function Tooltip({ text, children }: TooltipProps) {
  return (
    <span className={styles.wrap} tabIndex={0} aria-label={text}>
      {children}
      <span className={styles.tip} role="tooltip">{text}</span>
    </span>
  );
}
