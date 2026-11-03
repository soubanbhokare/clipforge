import MediaPlaceholder from "./MediaPlaceholder";
import Reveal from "./Reveal";
import { getLandingAsset } from "../../config/landingAssets";
import styles from "./ProblemSolution.module.css";

/**
 * Problem → Solution sections (locations 23 and 24).
 *
 * Copy rule: plain, truthful product language only. The problem is the
 * manual work of turning long videos into shorts; the solution is what
 * CLIPFORGE is built to do (the same capabilities described by the
 * feature sections on this page). No statistics, no customer claims,
 * no results are promised — the page-level notes and FAQ state which
 * features require connected services.
 */

const PAIN_POINTS: { title: string; text: string }[] = [
  {
    title: "Finding the moments",
    text: "You scrub through the whole recording again and again, just to spot the parts that are worth clipping.",
  },
  {
    title: "Cutting everything by hand",
    text: "Each clip is trimmed one at a time in a general-purpose editor built for long videos, not for making shorts.",
  },
  {
    title: "Reframing for vertical",
    text: "Every clip has to be re-cropped to 9:16 by hand, and the subject keeps drifting out of the frame.",
  },
  {
    title: "Captions typed from scratch",
    text: "Subtitles are written out and timed manually for every single short, starting from a blank line each time.",
  },
];

const ANSWERS: { title: string; text: string }[] = [
  {
    title: "AI-assisted clip detection",
    text: "Analysis surfaces candidate moments from your video, so you review real options instead of scrubbing blind.",
  },
  {
    title: "Batch clip creation",
    text: "The moments you select become multiple vertical clips in one workflow, ready to refine.",
  },
  {
    title: "Auto Face Lock and smart reframing",
    text: "The selected subject is tracked and kept in frame as the picture converts from 16:9 to 9:16.",
  },
  {
    title: "Captions and templates built in",
    text: "Captions and vertical templates live in the same workflow — not in another tool at the end of the process.",
  },
];

export default function ProblemSolution() {
  return (
    <>
      {/* ---- Problem (slot 23) ---- */}
      <section className={styles.section} id="problem" aria-labelledby="problem-heading">
        <Reveal>
          <p className={styles.eyebrow}>The Problem</p>
          <h2 id="problem-heading">ONE LONG VIDEO. EVERY SHORT MADE BY HAND.</h2>
          <p className={styles.intro}>
            Every long video hides moments worth posting. Getting them out
            by hand is a chain of small, repetitive jobs:
          </p>
        </Reveal>
        <div className={styles.cardGrid}>
          {PAIN_POINTS.map((p) => (
            <article key={p.title} className={styles.card}>
              <h3>{p.title}</h3>
              <p>{p.text}</p>
            </article>
          ))}
        </div>
        <Reveal>
          <MediaPlaceholder asset={getLandingAsset("problem-visual")} />
        </Reveal>
      </section>

      {/* ---- Solution (slot 24) ---- */}
      <section className={styles.section} id="solution" aria-labelledby="solution-heading">
        <Reveal>
          <p className={styles.eyebrow}>The Solution</p>
          <h2 id="solution-heading">ONE WORKFLOW, FROM LONG VIDEO TO READY SHORTS</h2>
          <p className={styles.intro}>
            CLIPFORGE is built around that chain of jobs — one place to
            find the moments, frame them, caption them and prepare them
            for posting.
          </p>
        </Reveal>
        <div className={styles.cardGrid}>
          {ANSWERS.map((a) => (
            <article key={a.title} className={styles.card}>
              <h3>{a.title}</h3>
              <p>{a.text}</p>
            </article>
          ))}
        </div>
        <Reveal>
          <MediaPlaceholder asset={getLandingAsset("solution-visual")} />
        </Reveal>
      </section>
    </>
  );
}
