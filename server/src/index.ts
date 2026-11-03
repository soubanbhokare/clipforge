import { createApp } from "./app.js";
import { startAnalysisWorker } from "./analysis.js";
import { startRenderWorker } from "./editor.js";
import { startTrackingWorker } from "./tracking.js";
import { startPhase8Worker } from "./broll.js";
import { startExportWorker } from "./export.js";
import { startPublishingWorker } from "./publishing.js";
import { startAnalyticsWorker } from "./analytics.js";
import { startAccountWorker } from "./account.js";
import {
  config,
  emailConfigured,
  googleConfigured,
  validateProductionConfig,
} from "./config.js";
import { closeDb, getDb } from "./db.js";

// Phase 13 (§11): production startup validation — BEFORE migrations,
// workers or listening. In production a hard failure prints a clear
// operator message and exits(1); in development/test it never fails.
try {
  validateProductionConfig();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

// Boot: run migrations (idempotent) before accepting traffic.
getDb();

// Phase 4: recover interrupted analysis jobs, then start the
// DB-backed in-process worker that drains processing_tasks.
startAnalysisWorker();

// Phase 5: same pattern for render_jobs (one render at a time —
// encoding is CPU-bound on this machine).
startRenderWorker();

// Phase 7: same pattern for tracking_jobs (CV runs in a Python child
// process, one job at a time).
startTrackingWorker();

// Phase 8: same pattern for phase8_jobs (B-roll recommendations,
// enhancement + preview jobs; one at a time — FFmpeg is CPU-bound).
startPhase8Worker();

// Phase 9: ZIP bundle worker for batch exports (render recovery for
// export jobs themselves is handled by the shared render worker).
startExportWorker();

// Phase 10: publishing scheduler/status worker — claims due
// scheduled posts, submits approved jobs, polls platform status.
startPublishingWorker();

// Phase 11: analytics worker — claims sync jobs (capability-checked,
// snapshot-writing), generates queued reports, enqueues scheduled
// syncs for users who configured a refresh frequency.
startAnalyticsWorker();

// Phase 12: account worker — data-export ZIP generation and the
// account-deletion workflow (both DB-backed, boot-recovered).
startAccountWorker();

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`CLIPFORGE server listening on http://localhost:${config.port}`);
  console.log(
    `[config] email=${emailConfigured ? "SMTP" : "outbox (dev)"} googleOAuth=${
      googleConfigured ? "configured" : "not configured"
    } requireEmailVerification=${config.requireEmailVerification}`,
  );
  // Phase 13 (§11): concise boot config summary — values only,
  // never secret material (no keys, passwords or tokens).
  console.log(
    `[config] env=${config.nodeEnv} db=${config.databaseFile} ` +
      `emailMode=${emailConfigured ? "smtp" : "outbox"} ` +
      `googleConfigured=${googleConfigured ? "y" : "n"} ` +
      `emailVerificationRequired=${config.requireEmailVerification ? "y" : "n"} ` +
      `adminCount=${config.account.adminEmails.length}`,
  );
});

// Phase 13 (§12): graceful shutdown on SIGTERM / SIGINT.
// - server.close() stops accepting new connections and drains the
//   in-flight HTTP requests before its callback fires.
// - The 8 in-process workers expose NO stop API: every
//   start*Worker(): void in analysis/editor/tracking/broll/export/
//   publishing/analytics/account.ts keeps its setInterval timer in a
//   module-private variable and returns nothing. No stop API is
//   invented here. That is safe because every worker's jobs are
//   DB-backed and boot-recovered by its start function on the next
//   boot (interrupted jobs are re-queued or honestly marked failed).
// - The DB is closed via the existing closeDb() export in db.ts.
// - Clean close exits 0; a 10-second timeout forces exit(1).
let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received — shutting down gracefully`);

  const forceTimer = setTimeout(() => {
    console.error("[shutdown] timed out after 10s — forcing exit");
    process.exit(1);
  }, 10_000);
  forceTimer.unref();

  console.log(
    "[shutdown] stopping HTTP server (no new connections; in-process workers have no stop API — their DB-backed jobs are boot-recovered on next start)",
  );
  server.close((err) => {
    clearTimeout(forceTimer);
    if (err) {
      console.error(`[shutdown] HTTP server close error: ${err.message}`);
    } else {
      console.log("[shutdown] HTTP server closed");
    }
    try {
      closeDb();
      console.log("[shutdown] database closed");
    } catch (dbErr) {
      console.error(
        `[shutdown] database close error: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`,
      );
    }
    console.log("[shutdown] shutdown complete");
    process.exit(err ? 1 : 0);
  });
  // Drop idle keep-alive sockets so close() is not held open by them;
  // in-flight requests are still allowed to finish.
  if (typeof server.closeIdleConnections === "function") {
    server.closeIdleConnections();
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
