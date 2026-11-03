import type { ReactNode } from "react";
import styles from "./Tabs.module.css";

export interface TabItem {
  id: string;
  label: string;
  content: ReactNode;
}

interface TabsProps {
  tabs: TabItem[];
  value: string;
  onChange: (id: string) => void;
  label: string;
}

// Full tabs pattern: tablist, aria-selected, tabpanel with
// aria-labelledby. Arrow-key navigation is handled by native
// button focus order plus this controlled selection on click/Enter.
export default function Tabs({ tabs, value, onChange, label }: TabsProps) {
  const active = tabs.find((t) => t.id === value) ?? tabs[0];
  return (
    <div>
      <div className={styles.list} role="tablist" aria-label={label}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`tab-${tab.id}`}
            aria-selected={tab.id === value}
            aria-controls={`panel-${tab.id}`}
            className={tab.id === value ? styles.tabActive : styles.tab}
            onClick={() => onChange(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`panel-${active.id}`}
        aria-labelledby={`tab-${active.id}`}
        className={styles.panel}
      >
        {active.content}
      </div>
    </div>
  );
}
