#!/usr/bin/env node
// CLIPFORGE backup — consistent SQLite snapshot + storage-tree copy.
//
// What it does:
//   1. Opens the source database with node:sqlite and takes a consistent
//      snapshot with VACUUM INTO (safe while the server is running: the
//      snapshot includes everything committed in the WAL, and the source
//      file is never written to).
//   2. Copies the storage sub-directories of the data dir (media, avatars,
//      workspace-logos, reports, data-exports, processing — whichever
//      exist) into the backup, preserving relative paths.
//   3. Verifies the snapshot (PRAGMA integrity_check on the copy) and
//      writes manifest.json with sizes + SHA-256 hashes. The manifest
//      contains NO secrets: no tokens, no credentials, no env values —
//      only file names, sizes, hashes and timestamps.
//   4. Exits non-zero if any step or the verification fails, so a cron
//      wrapper / scheduler can alert on the exit code.
//
// Usage:
//   node server/scripts/backup.mjs [--source-dir DIR] [--dest-dir DIR]
//                                  [--db-file FILE] [--label TEXT]
//
// Configuration (first match wins):
//   source data dir : --source-dir  | BACKUP_SOURCE_DIR | CLIPFORGE_DATA_DIR
//                     | directory of DATABASE_FILE | <server>/data
//   database file   : --db-file     | DATABASE_FILE | <source-dir>/clipforge.db
//   destination dir : --dest-dir    | BACKUP_DEST_DIR | <server>/backups
//
// Output: <dest-dir>/clipforge-backup-<UTC timestamp>[-<label>]/
//           clipforge.db      — the VACUUM INTO snapshot
//           <storage dirs>/   — copied storage trees (if present)
//           manifest.json     — sizes, SHA-256 hashes, integrity result
//
// Restore: see docs/BACKUP_RESTORE.md (stop server, copy clipforge.db and
// the storage dirs back into the data dir, restart, check user_version).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Storage sub-directories of the data dir that hold user files. The DB
// references them by storage_key / path; a DB-only backup is NOT a full
// backup. `outbox` (dev mail spool) is deliberately excluded.
const STORAGE_DIRS = ["media", "avatars", "workspace-logos", "reports", "data-exports", "processing"];

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(1024 * 1024);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function listFiles(root, dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(root, full, out);
    else if (entry.isFile()) {
      const stat = fs.statSync(full);
      out.push({ path: path.relative(root, full), size: stat.size, sha256: sha256File(full) });
    }
  }
  return out;
}

function main() {
  const sourceDir = path.resolve(
    argValue("--source-dir") ??
      process.env.BACKUP_SOURCE_DIR ??
      process.env.CLIPFORGE_DATA_DIR ??
      (process.env.DATABASE_FILE ? path.dirname(process.env.DATABASE_FILE) : path.join(serverDir, "data")),
  );
  const dbFile = path.resolve(argValue("--db-file") ?? process.env.DATABASE_FILE ?? path.join(sourceDir, "clipforge.db"));
  const destRoot = path.resolve(argValue("--dest-dir") ?? process.env.BACKUP_DEST_DIR ?? path.join(serverDir, "backups"));
  const label = (argValue("--label") ?? "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");

  if (!fs.existsSync(dbFile)) {
    console.error(`[backup] source database not found: ${dbFile}`);
    process.exit(1);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(destRoot, `clipforge-backup-${stamp}${label ? `-${label}` : ""}`);
  if (path.resolve(backupDir).startsWith(path.resolve(sourceDir) + path.sep)) {
    console.error("[backup] destination must not be inside the source data dir (would recurse)");
    process.exit(1);
  }
  if (fs.existsSync(backupDir)) {
    console.error(`[backup] backup directory already exists: ${backupDir}`);
    process.exit(1);
  }
  fs.mkdirSync(backupDir, { recursive: true });

  // 1 — Consistent DB snapshot via VACUUM INTO.
  const backupDbFile = path.join(backupDir, "clipforge.db");
  const source = new DatabaseSync(dbFile);
  try {
    const escaped = backupDbFile.replace(/'/g, "''");
    source.exec(`VACUUM INTO '${escaped}';`);
  } finally {
    source.close();
  }

  // 2 — Copy storage trees (reference copy: same relative layout as the
  // live data dir, so a restore is a straight copy back).
  const storage = {};
  for (const name of STORAGE_DIRS) {
    const src = path.join(sourceDir, name);
    if (!fs.existsSync(src)) continue;
    const files = listFiles(src, src);
    fs.cpSync(src, path.join(backupDir, name), { recursive: true });
    storage[name] = {
      file_count: files.length,
      total_bytes: files.reduce((a, f) => a + f.size, 0),
      files,
    };
  }

  // 3 — Verify the snapshot and build the manifest.
  const check = new DatabaseSync(backupDbFile, { readOnly: true });
  let integrity, fkViolations, userVersion;
  try {
    integrity = check.prepare("PRAGMA integrity_check").all().map((r) => r.integrity_check);
    fkViolations = check.prepare("PRAGMA foreign_key_check").all().length;
    userVersion = check.prepare("PRAGMA user_version").get()?.user_version ?? null;
  } finally {
    check.close();
  }
  const dbStat = fs.statSync(backupDbFile);
  const manifest = {
    format: 1,
    tool: "server/scripts/backup.mjs",
    created_at: new Date().toISOString(),
    label: label || null,
    database: {
      file: "clipforge.db",
      source_file_name: path.basename(dbFile),
      size_bytes: dbStat.size,
      sha256: sha256File(backupDbFile),
      user_version: userVersion,
      integrity_check: integrity,
      foreign_key_violations: fkViolations,
    },
    storage,
  };
  fs.writeFileSync(path.join(backupDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const ok = integrity.length === 1 && integrity[0] === "ok" && fkViolations === 0;
  console.log(JSON.stringify({ ok, backup_dir: backupDir, manifest: path.join(backupDir, "manifest.json"), database: manifest.database, storage_dirs: Object.keys(storage) }, null, 2));
  if (!ok) {
    console.error("[backup] verification FAILED — backup kept for inspection, treating run as failed");
    process.exit(1);
  }
}

try {
  main();
} catch (err) {
  console.error(`[backup] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
