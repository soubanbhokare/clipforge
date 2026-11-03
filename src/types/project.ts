// CLIPFORGE shared types — Milestone 1.
// These types describe the shape planned for later phases only.
// No project, clip, publishing or analytics data exists yet, and
// nothing in Milestone 1 creates, stores or sends any of these.

export type WorkflowStepId =
  | "video-input"
  | "ai-analysis"
  | "best-moments"
  | "clip-generation"
  | "face-lock"
  | "reframing"
  | "captions"
  | "titles-hooks"
  | "editing"
  | "export"
  | "publish"
  | "analytics";

export interface WorkflowStep {
  id: WorkflowStepId;
  order: number;
  title: string;
  description: string;
}

// Future backend readiness (not implemented in Milestone 1):
// Node.js + Express API, PostgreSQL, FFmpeg, a background job queue,
// AI transcription / computer-vision services, and official
// publishing APIs will sit behind VITE_API_URL (see .env.example).
export interface FutureProject {
  id: string;
  title: string;
  sourceUrl: string | null;
  status: "queued" | "analyzing" | "ready" | "failed";
  createdAt: string;
}
