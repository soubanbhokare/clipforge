import { useEffect, useRef, useState, type ReactNode } from "react";
import styles from "./Reveal.module.css";

/**
 * Landing-only scroll entrance. Adds `.visible` once the element enters
 * the viewport. Under prefers-reduced-motion the CSS in Reveal.module.css
 * removes the transition, so content is simply present — the global
 * reduced-motion rule is never overridden.
 */
export default function Reveal({
  children,
  label,
}: {
  children: ReactNode;
  label?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.15 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      aria-label={label}
      className={`${styles.reveal} ${visible ? styles.visible : ""}`}
    >
      {children}
    </div>
  );
}
