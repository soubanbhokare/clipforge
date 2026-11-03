import type { WorkflowStep } from "../types/project";
import styles from "./WorkflowStrip.module.css";

// The planned CLIPFORGE workflow, shown as a roadmap on the starting
// screen. These steps are NOT implemented in Milestone 1 — no video is
// analysed, clipped, reframed, captioned or published by this build.
export const WORKFLOW_STEPS: WorkflowStep[] = [
  { id: "video-input", order: 1, title: "Video URL or upload", description: "Paste a link or upload an authorised video." },
  { id: "ai-analysis", order: 2, title: "AI video analysis", description: "Understand speech, scenes and energy." },
  { id: "best-moments", order: 3, title: "Best moments detection", description: "Find the parts worth keeping." },
  { id: "clip-generation", order: 4, title: "Automatic clip generation", description: "Cut the moments into shorts." },
  { id: "face-lock", order: 5, title: "Auto Face Lock", description: "Keep the speaker in frame." },
  { id: "reframing", order: 6, title: "Smart 9:16 reframing", description: "Reframe for vertical, without awkward crops." },
  { id: "captions", order: 7, title: "Automatic captions", description: "Readable, timed captions on every clip." },
  { id: "titles-hooks", order: 8, title: "AI titles and hooks", description: "Openers written to stop the scroll." },
  { id: "editing", order: 9, title: "Video editing", description: "Trim, reorder and polish before export." },
  { id: "export", order: 10, title: "Export", description: "Render in the format each platform needs." },
  { id: "publish", order: 11, title: "Schedule and publish", description: "Queue clips and publish on schedule." },
  { id: "analytics", order: 12, title: "Analytics", description: "See what actually performed." },
];

export default function WorkflowStrip() {
  return (
    <section className={styles.section} aria-labelledby="workflow-heading">
      <p className={styles.kicker}>Planned workflow — not yet live</p>
      <h2 id="workflow-heading" className={styles.heading}>
        From one long video to a set of shorts.
      </h2>
      <ol className={styles.list}>
        {WORKFLOW_STEPS.map((step) => (
          <li key={step.id} className={styles.item}>
            <span className={styles.number}>
              {String(step.order).padStart(2, "0")}
            </span>
            <span className={styles.itemText}>
              <strong>{step.title}</strong>
              <span>{step.description}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
