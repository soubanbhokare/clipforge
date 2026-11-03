import { useEffect, useRef, useState, type ReactNode } from "react";
import styles from "./Dropdown.module.css";

interface DropdownProps {
  label: string;
  triggerLabel: string;
  children: ReactNode;
  dropUp?: boolean;
}

// Keyboard-operable dropdown: Enter/Space toggles, Escape closes,
// click outside closes. Used for profile and notification menus.
export default function Dropdown({ label, triggerLabel, children, dropUp = false }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open ]);

  return (
    <div className={styles.wrap} ref={ref}>
      <button
        type="button"
        className={styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
      >
        {triggerLabel}
      </button>
      {open && (
        <div className={dropUp ? styles.menuUp : styles.menu} role="menu">
          {children}
        </div>
      )}
    </div>
  );
}
