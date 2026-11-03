// Database layer — SQLite through Node's built-in node:sqlite.
//
// DECISION NOTE (Phase 2): this development machine has no PostgreSQL,
// so the server runs on SQLite with portable, standard SQL. The schema
// below mirrors exactly the tables the Phase 2 spec requires; moving to
// PostgreSQL in production means re-pointing this layer at the same
// tables (see server README, "Production database path").
//
// SECURITY: passwords are Argon2id hashes (see auth service). Session,
// verification and reset tokens are NEVER stored in plaintext — only
// their SHA-256 hashes live here.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";

// Portable SQL migration. Runs automatically on server boot.
// Written to stay close to standard SQL so the PostgreSQL port is a
// type-name change (TEXT timestamps are ISO-8601 strings here).
export const MIGRATION_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  email_verified_at TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,               -- SHA-256 hash of the session token
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hashed_token TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evt_user_id ON email_verification_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_evt_expires_at ON email_verification_tokens(expires_at);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hashed_token TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prt_user_id ON password_reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_prt_expires_at ON password_reset_tokens(expires_at);
`;

// ---- Migration v2 (Phase 3: Studio, projects, uploads) -----------------
// Added on top of v1 without changing any v1 table. Same portable-SQL
// approach: these tables map directly to PostgreSQL in production.
// Video binaries are NEVER stored here — only storage references.
export const MIGRATION_V2_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  workflow_type TEXT NOT NULL CHECK (workflow_type IN ('LONG_VIDEO_TO_SHORTS', 'SHORT_VIDEO_ENHANCEMENT')),
  status TEXT NOT NULL DEFAULT 'DRAFT',
  settings_json TEXT NOT NULL DEFAULT '{}',
  ai_instruction TEXT NULL,
  idempotency_key TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id);
CREATE INDEX IF NOT EXISTS idx_projects_user_status ON projects(user_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_user_idempotency
  ON projects(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS source_assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('UPLOAD', 'YOUTUBE_URL', 'URL_IMPORT')),
  original_filename TEXT NOT NULL,
  source_url TEXT NULL,
  external_id TEXT NULL,
  storage_key TEXT NULL,
  storage_provider TEXT NOT NULL DEFAULT 'local',
  file_size INTEGER NULL,
  duration REAL NULL,
  width INTEGER NULL,
  height INTEGER NULL,
  frame_rate REAL NULL,
  video_codec TEXT NULL,
  audio_codec TEXT NULL,
  has_audio INTEGER NULL,
  container TEXT NULL,
  bitrate INTEGER NULL,
  validation_status TEXT NOT NULL DEFAULT 'PENDING',
  validation_error TEXT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assets_project_id ON source_assets(project_id);
CREATE INDEX IF NOT EXISTS idx_assets_user_id ON source_assets(user_id);

CREATE TABLE IF NOT EXISTS upload_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_asset_id TEXT NULL REFERENCES source_assets(id) ON DELETE SET NULL,
  upload_status TEXT NOT NULL DEFAULT 'PENDING',
  bytes_uploaded INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_uploads_user_id ON upload_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_uploads_project_id ON upload_sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_uploads_expires_at ON upload_sessions(expires_at);
`;

// ---- Migration v3 (Phase 4: AI clip detection) -------------------------
// Processing jobs are persisted in SQLite and executed by an in-process
// worker (src/analysis.ts). Production path: the same job rows map to a
// PostgreSQL table drained by BullMQ/Redis workers — that queue is NOT
// running in this development environment and is never claimed to be.
// A GeneratedClip (Phase 4 spec model) is represented by a
// candidate_clips row whose preview_status is READY and whose
// preview_path points at the verified FFmpeg cut; keeping one row avoids
// two sources of truth for the same time window.
export const MIGRATION_V3_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS processing_tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_asset_id TEXT NOT NULL REFERENCES source_assets(id) ON DELETE CASCADE,
  prompt TEXT NULL,
  settings_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'QUEUED',
  stage TEXT NOT NULL DEFAULT 'QUEUED',
  error TEXT NULL,
  error_code TEXT NULL,
  outcome TEXT NULL,
  signals_json TEXT NOT NULL DEFAULT '{}',
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT NULL,
  finished_at TEXT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON processing_tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_user_status ON processing_tasks(user_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON processing_tasks(status);

CREATE TABLE IF NOT EXISTS transcripts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES processing_tasks(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_asset_id TEXT NOT NULL REFERENCES source_assets(id) ON DELETE CASCADE,
  language TEXT NULL,
  language_probability REAL NULL,
  duration REAL NULL,
  full_text TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transcripts_project_id ON transcripts(project_id);
CREATE INDEX IF NOT EXISTS idx_transcripts_task_id ON transcripts(task_id);

CREATE TABLE IF NOT EXISTS transcript_segments (
  id TEXT PRIMARY KEY,
  transcript_id TEXT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  start_sec REAL NOT NULL,
  end_sec REAL NOT NULL,
  text TEXT NOT NULL,
  words_json TEXT NULL,
  speaker TEXT NULL
);
CREATE INDEX IF NOT EXISTS idx_tsegments_transcript_id ON transcript_segments(transcript_id, idx);

CREATE TABLE IF NOT EXISTS topic_segments (
  id TEXT PRIMARY KEY,
  transcript_id TEXT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  start_sec REAL NOT NULL,
  end_sec REAL NOT NULL,
  label TEXT NOT NULL,
  summary_text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_topics_transcript_id ON topic_segments(transcript_id);

CREATE TABLE IF NOT EXISTS candidate_clips (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES processing_tasks(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_asset_id TEXT NOT NULL REFERENCES source_assets(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_sec REAL NOT NULL,
  end_sec REAL NOT NULL,
  duration REAL NOT NULL,
  score INTEGER NOT NULL,
  reasons_json TEXT NOT NULL DEFAULT '[]',
  suggested_title TEXT NOT NULL,
  title TEXT NOT NULL,
  transcript_excerpt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'SELECTED' CHECK (status IN ('SELECTED', 'REMOVED')),
  preview_path TEXT NULL,
  preview_status TEXT NOT NULL DEFAULT 'PENDING',
  preview_error TEXT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_candidates_project_id ON candidate_clips(project_id);
CREATE INDEX IF NOT EXISTS idx_candidates_task_id ON candidate_clips(task_id);
CREATE INDEX IF NOT EXISTS idx_candidates_user_id ON candidate_clips(user_id);
`;

// ---- Migration v4 (Phase 5: video editor & timeline) -------------------
// The editing document for a project lives in clip_versions (one per
// project) with its tracks, items, captions and scene overrides in
// normalized tables. Every mutation is an editing_operations row whose
// payload stores the FULL state before and after the operation
// (state-snapshot undo strategy — see src/editor.ts); the document's
// undo_cursor points at the last applied operation. project_versions
// holds named user snapshots. render_jobs are drained by the same
// DB-backed in-process worker pattern as Phase 4 (PostgreSQL/BullMQ
// remain the documented production path only). project_media holds
// additional per-project assets (audio files for music, imported
// clips) that are NOT the project's single Phase 3 source.
export const MIGRATION_V4_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS clip_versions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  base_candidate_id TEXT NULL REFERENCES candidate_clips(id) ON DELETE SET NULL,
  canvas_json TEXT NOT NULL DEFAULT '{}',
  settings_json TEXT NOT NULL DEFAULT '{}',
  undo_cursor INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_clip_versions_project ON clip_versions(project_id);
CREATE INDEX IF NOT EXISTS idx_clip_versions_user ON clip_versions(user_id);

CREATE TABLE IF NOT EXISTS timeline_tracks (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES clip_versions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('main', 'broll', 'caption', 'audio', 'overlay')),
  label TEXT NOT NULL,
  order_idx INTEGER NOT NULL DEFAULT 0,
  locked INTEGER NOT NULL DEFAULT 0,
  visible INTEGER NOT NULL DEFAULT 1,
  muted INTEGER NOT NULL DEFAULT 0,
  solo INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tracks_version ON timeline_tracks(version_id, order_idx);

CREATE TABLE IF NOT EXISTS timeline_items (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES clip_versions(id) ON DELETE CASCADE,
  track_id TEXT NOT NULL REFERENCES timeline_tracks(id) ON DELETE CASCADE,
  asset_kind TEXT NOT NULL CHECK (asset_kind IN ('source', 'candidate', 'media')),
  asset_id TEXT NOT NULL,
  start_sec REAL NOT NULL,
  duration_sec REAL NOT NULL,
  source_in_sec REAL NOT NULL,
  source_out_sec REAL NOT NULL,
  transform_json TEXT NOT NULL DEFAULT '{}',
  speed REAL NOT NULL DEFAULT 1,
  volume REAL NOT NULL DEFAULT 1,
  fade_in_sec REAL NOT NULL DEFAULT 0,
  fade_out_sec REAL NOT NULL DEFAULT 0,
  layer_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_version ON timeline_items(version_id);
CREATE INDEX IF NOT EXISTS idx_items_track ON timeline_items(track_id, start_sec);

CREATE TABLE IF NOT EXISTS editing_operations (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES clip_versions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ops_version_seq ON editing_operations(version_id, seq);

CREATE TABLE IF NOT EXISTS caption_segments (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES clip_versions(id) ON DELETE CASCADE,
  start_sec REAL NOT NULL,
  end_sec REAL NOT NULL,
  text TEXT NOT NULL,
  words_json TEXT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_captions_version ON caption_segments(version_id, start_sec);

CREATE TABLE IF NOT EXISTS scene_overrides (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES clip_versions(id) ON DELETE CASCADE,
  topic_segment_id TEXT NULL,
  range_start_sec REAL NOT NULL,
  range_end_sec REAL NOT NULL,
  overrides_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_overrides_version ON scene_overrides(version_id, range_start_sec);

CREATE TABLE IF NOT EXISTS project_versions (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES clip_versions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pversions_version ON project_versions(version_id, created_at);

CREATE TABLE IF NOT EXISTS project_media (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('AUDIO', 'VIDEO')),
  original_filename TEXT NOT NULL,
  storage_key TEXT NULL,
  storage_provider TEXT NOT NULL DEFAULT 'local',
  file_size INTEGER NULL,
  duration REAL NULL,
  width INTEGER NULL,
  height INTEGER NULL,
  video_codec TEXT NULL,
  audio_codec TEXT NULL,
  has_audio INTEGER NULL,
  has_video INTEGER NULL,
  container TEXT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pmedia_project ON project_media(project_id);
CREATE INDEX IF NOT EXISTS idx_pmedia_user ON project_media(user_id);

CREATE TABLE IF NOT EXISTS render_jobs (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES clip_versions(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'QUEUED',
  stage TEXT NOT NULL DEFAULT 'QUEUED',
  settings_json TEXT NOT NULL DEFAULT '{}',
  output_path TEXT NULL,
  error TEXT NULL,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT NULL,
  finished_at TEXT NULL
);
CREATE INDEX IF NOT EXISTS idx_render_project ON render_jobs(project_id);
CREATE INDEX IF NOT EXISTS idx_render_user_status ON render_jobs(user_id, status);
CREATE INDEX IF NOT EXISTS idx_render_status ON render_jobs(status);
`;

// ---- Migration v5 (Phase 6: Captions Studio & Brand Kit) --------------
// The editor's caption_segments table stays the single live editing
// surface for a document's ACTIVE caption track (Phase 5 decision: no
// competing caption store). v5 extends it additively (style_json +
// language, guarded below because ALTER TABLE is not idempotent) and
// adds:
//  - caption_tracks + caption_track_segments: the document's caption
//    variants (original transcript language, translations, manual
//    sets). Inactive variants live in caption_track_segments; the
//    active variant is mirrored by caption_segments.
//  - caption_templates: user-saved custom caption templates (the 10
//    built-in presets live in code, src/captions.ts).
//  - brand_assets + brand_kits: user-level brand configuration;
//    applying a kit copies its caption style/template into editor
//    documents (a copy — later kit edits never rewrite documents).
//  - translation_jobs: persisted provider-adapter jobs. No provider
//    is configured in this environment, so jobs honestly FAIL with a
//    CONFIGURATION error instead of inventing translations.
export const MIGRATION_V5_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS caption_tracks (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES clip_versions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  language TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('original', 'translation', 'manual')),
  label TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_caption_tracks_version ON caption_tracks(version_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_caption_tracks_active
  ON caption_tracks(version_id) WHERE is_active = 1;

CREATE TABLE IF NOT EXISTS caption_track_segments (
  id TEXT PRIMARY KEY,
  track_id TEXT NOT NULL REFERENCES caption_tracks(id) ON DELETE CASCADE,
  start_sec REAL NOT NULL,
  end_sec REAL NOT NULL,
  text TEXT NOT NULL,
  words_json TEXT NULL,
  style_json TEXT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ctsegments_track ON caption_track_segments(track_id, start_sec);

CREATE TABLE IF NOT EXISTS caption_templates (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  style_json TEXT NOT NULL,
  based_on TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ctemplates_user ON caption_templates(user_id);

CREATE TABLE IF NOT EXISTS brand_assets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('LOGO', 'INTRO', 'OUTRO', 'MUSIC', 'OVERLAY', 'OTHER')),
  original_filename TEXT NOT NULL,
  storage_key TEXT NULL,
  storage_provider TEXT NOT NULL DEFAULT 'local',
  file_size INTEGER NULL,
  duration REAL NULL,
  width INTEGER NULL,
  height INTEGER NULL,
  has_audio INTEGER NULL,
  has_video INTEGER NULL,
  container TEXT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_brand_assets_user ON brand_assets(user_id);

CREATE TABLE IF NOT EXISTS brand_kits (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  brand_name TEXT NOT NULL,
  primary_color TEXT NOT NULL,
  secondary_color TEXT NOT NULL,
  accent_color TEXT NOT NULL,
  font_family TEXT NULL,
  caption_template_id TEXT NULL,
  caption_style_json TEXT NULL,
  logo_asset_id TEXT NULL REFERENCES brand_assets(id) ON DELETE SET NULL,
  intro_asset_id TEXT NULL REFERENCES brand_assets(id) ON DELETE SET NULL,
  outro_asset_id TEXT NULL REFERENCES brand_assets(id) ON DELETE SET NULL,
  music_asset_id TEXT NULL REFERENCES brand_assets(id) ON DELETE SET NULL,
  overlay_asset_id TEXT NULL REFERENCES brand_assets(id) ON DELETE SET NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_brand_kits_user ON brand_kits(user_id);

CREATE TABLE IF NOT EXISTS translation_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES clip_versions(id) ON DELETE CASCADE,
  source_language TEXT NOT NULL,
  target_language TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED',
  error TEXT NULL,
  error_code TEXT NULL,
  result_track_id TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT NULL
);
CREATE INDEX IF NOT EXISTS idx_tjobs_version ON translation_jobs(version_id);
CREATE INDEX IF NOT EXISTS idx_tjobs_user ON translation_jobs(user_id);
`;

// ---- Migration v6 (Phase 7: Face Lock, Active Speaker & Reframing) ---
// Tracking jobs follow the Phase 4 pattern: persisted rows drained by
// an in-process worker (src/tracking.ts); the CV work itself runs in a
// Python child process (scripts/track.py — YuNet face detection, a
// YOLOv8-nano person model via onnxruntime, Silero VAD). Subjects are
// ANONYMOUS within one video (a per-job key like "face-1"): no identity
// is ever stored or matched. All bounding boxes and crop rectangles
// are NORMALIZED (0..1 of the source frame) so they map to any output
// resolution. Reframe configurations live per editor document
// (clip_versions); computed crop keyframes (kind='crop') are rewritten
// whenever the configuration changes, manual keyframes (kind='manual')
// are the user's own corrections and are never rewritten by the system.
export const MIGRATION_V6_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS tracking_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_asset_id TEXT NOT NULL REFERENCES source_assets(id) ON DELETE CASCADE,
  settings_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'QUEUED',
  stage TEXT NOT NULL DEFAULT 'QUEUED',
  progress_json TEXT NOT NULL DEFAULT '{}',
  scenes_json TEXT NOT NULL DEFAULT '[]',
  result_json TEXT NOT NULL DEFAULT '{}',
  error TEXT NULL,
  error_code TEXT NULL,
  outcome TEXT NULL,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT NULL,
  finished_at TEXT NULL
);
CREATE INDEX IF NOT EXISTS idx_tkjobs_project ON tracking_jobs(project_id);
CREATE INDEX IF NOT EXISTS idx_tkjobs_user_status ON tracking_jobs(user_id, status);
CREATE INDEX IF NOT EXISTS idx_tkjobs_status ON tracking_jobs(status);

CREATE TABLE IF NOT EXISTS tracked_subjects (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES tracking_jobs(id) ON DELETE CASCADE,
  subject_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('face', 'person')),
  first_seen_sec REAL NOT NULL,
  last_seen_sec REAL NOT NULL,
  present_samples INTEGER NOT NULL DEFAULT 0,
  total_samples INTEGER NOT NULL DEFAULT 0,
  mean_confidence REAL NULL,
  best_confidence REAL NULL,
  best_time_sec REAL NULL,
  best_bbox_json TEXT NULL,
  thumb_path TEXT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_subjects_job_key ON tracked_subjects(job_id, subject_key);
CREATE INDEX IF NOT EXISTS idx_subjects_job ON tracked_subjects(job_id);

CREATE TABLE IF NOT EXISTS tracking_frames (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES tracking_jobs(id) ON DELETE CASCADE,
  subject_id TEXT NOT NULL REFERENCES tracked_subjects(id) ON DELETE CASCADE,
  t_sec REAL NOT NULL,
  bbox_json TEXT NOT NULL,
  confidence REAL NULL,
  features_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tframes_subject ON tracking_frames(subject_id, t_sec);
CREATE INDEX IF NOT EXISTS idx_tframes_job ON tracking_frames(job_id);

CREATE TABLE IF NOT EXISTS subject_associations (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES tracking_jobs(id) ON DELETE CASCADE,
  subject_id TEXT NOT NULL REFERENCES tracked_subjects(id) ON DELETE CASCADE,
  window_start_sec REAL NOT NULL,
  window_end_sec REAL NOT NULL,
  speech_source TEXT NOT NULL,
  score REAL NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  is_active_pick INTEGER NOT NULL DEFAULT 0,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assoc_job ON subject_associations(job_id, window_start_sec);
CREATE INDEX IF NOT EXISTS idx_assoc_subject ON subject_associations(subject_id);

CREATE TABLE IF NOT EXISTS reframe_configurations (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES clip_versions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  job_id TEXT NULL REFERENCES tracking_jobs(id) ON DELETE SET NULL,
  mode TEXT NOT NULL DEFAULT 'smart-auto',
  enabled INTEGER NOT NULL DEFAULT 1,
  aspect TEXT NOT NULL DEFAULT '9:16',
  out_width INTEGER NOT NULL DEFAULT 720,
  out_height INTEGER NOT NULL DEFAULT 1280,
  fit_mode TEXT NOT NULL DEFAULT 'smart-crop',
  subject_key TEXT NULL,
  target_pos_x TEXT NOT NULL DEFAULT 'center',
  target_pos_y TEXT NOT NULL DEFAULT 'middle',
  controls_json TEXT NOT NULL DEFAULT '{}',
  config_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reframe_version ON reframe_configurations(version_id);
CREATE INDEX IF NOT EXISTS idx_reframe_user ON reframe_configurations(user_id);

CREATE TABLE IF NOT EXISTS tracking_keyframes (
  id TEXT PRIMARY KEY,
  config_id TEXT NOT NULL REFERENCES reframe_configurations(id) ON DELETE CASCADE,
  job_id TEXT NULL REFERENCES tracking_jobs(id) ON DELETE SET NULL,
  region_subject_key TEXT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('crop', 'manual')),
  t_sec REAL NOT NULL,
  crop_json TEXT NULL,
  fit TEXT NOT NULL DEFAULT 'fill',
  subject_key TEXT NULL,
  confidence REAL NULL,
  lost INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tkeyframes_config ON tracking_keyframes(config_id, region_subject_key, t_sec);

CREATE TABLE IF NOT EXISTS scene_tracking_overrides (
  id TEXT PRIMARY KEY,
  config_id TEXT NOT NULL REFERENCES reframe_configurations(id) ON DELETE CASCADE,
  topic_segment_id TEXT NULL,
  range_start_sec REAL NOT NULL,
  range_end_sec REAL NOT NULL,
  mode TEXT NULL,
  subject_key TEXT NULL,
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scene_tovr_config ON scene_tracking_overrides(config_id, range_start_sec);

CREATE TABLE IF NOT EXISTS split_screen_layouts (
  id TEXT PRIMARY KEY,
  config_id TEXT NOT NULL REFERENCES reframe_configurations(id) ON DELETE CASCADE,
  layout TEXT NOT NULL DEFAULT 'side-by-side',
  regions_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_split_config ON split_screen_layouts(config_id);
`;

// ---- Migration v7 (Phase 8: AI B-roll, Enhancement & Background jobs) --
// Entity mapping (Phase 8 spec §15 → this schema). The spec's MediaAsset
// is NOT a new table: media already lives in source_assets (Phase 3
// uploads), project_media (Phase 5 editor assets) and brand_assets
// (Phase 6). media_asset_meta hangs Phase 8 library semantics (category,
// folder, source type, provider, licence, processing status, tags) off
// those existing rows, keyed by a stable asset_ref ("source:<id>",
// "media:<id>", "candidate:<id>", "brand:<id>") so the library is one
// union view instead of a parallel universe. The remaining spec
// entities map as: BrollRecommendation → broll_recommendations,
// BrollPlacement → broll_placements, EnhancementJob /
// AudioEnhancementJob / BackgroundRemovalJob / GeneratedMediaAsset /
// provider import → phase8_jobs rows discriminated by `kind` (one
// persisted job table drained by one in-process worker, the Phase 4/5/7
// pattern — the spec's Redis/BullMQ queues are the production path and
// do NOT run here), EnhancementConfiguration → enhancement_configs,
// EffectPreset / CustomEffectPreset → effect_presets (built-in presets
// live in code, src/enhance.ts; this table holds user customs),
// MediaLicenseRecord → media_license_records, AssetUsageRecord →
// asset_usage_records. Derived media produced by enhancement jobs are
// ordinary project_media rows whose meta marks them GENERATED_ASSETS.
export const MIGRATION_V7_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS media_asset_meta (
  asset_ref TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NULL REFERENCES projects(id) ON DELETE CASCADE,
  category TEXT NOT NULL DEFAULT 'B-roll',
  folder_id TEXT NULL,
  source_type TEXT NOT NULL DEFAULT 'USER_UPLOAD',
  provider TEXT NULL,
  provider_asset_id TEXT NULL,
  license_name TEXT NULL,
  attribution_text TEXT NULL,
  processing_status TEXT NOT NULL DEFAULT 'READY',
  tags_json TEXT NOT NULL DEFAULT '[]',
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mmeta_user ON media_asset_meta(user_id);
CREATE INDEX IF NOT EXISTS idx_mmeta_project ON media_asset_meta(project_id);
CREATE INDEX IF NOT EXISTS idx_mmeta_category ON media_asset_meta(user_id, category);

CREATE TABLE IF NOT EXISTS media_library_folders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  parent_id TEXT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mfolders_user ON media_library_folders(user_id);

CREATE TABLE IF NOT EXISTS broll_recommendations (
  id TEXT PRIMARY KEY,
  job_id TEXT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  transcript_id TEXT NULL,
  window_start_sec REAL NOT NULL,
  window_end_sec REAL NOT NULL,
  passage TEXT NOT NULL,
  asset_ref TEXT NOT NULL,
  asset_kind TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  score REAL NOT NULL,
  matched_terms_json TEXT NOT NULL DEFAULT '[]',
  reason TEXT NOT NULL,
  suggested_start_sec REAL NOT NULL,
  suggested_duration_sec REAL NOT NULL,
  source TEXT NOT NULL DEFAULT 'LIBRARY',
  license_json TEXT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  placement_id TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_brollrec_project ON broll_recommendations(project_id, status);
CREATE INDEX IF NOT EXISTS idx_brollrec_job ON broll_recommendations(job_id);

CREATE TABLE IF NOT EXISTS broll_placements (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES clip_versions(id) ON DELETE CASCADE,
  recommendation_id TEXT NULL,
  item_id TEXT NOT NULL,
  asset_kind TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  start_sec REAL NOT NULL,
  duration_sec REAL NOT NULL,
  source_in_sec REAL NOT NULL,
  source_out_sec REAL NOT NULL,
  display_mode TEXT NOT NULL DEFAULT 'FULLSCREEN',
  keep_original_audio INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_brollplace_version ON broll_placements(version_id);
CREATE INDEX IF NOT EXISTS idx_brollplace_project ON broll_placements(project_id);

CREATE TABLE IF NOT EXISTS phase8_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version_id TEXT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('BROLL_RECOMMENDATIONS', 'ENHANCEMENT', 'ENHANCEMENT_PREVIEW', 'BACKGROUND_REMOVAL', 'PROVIDER_IMPORT', 'AI_GENERATION', 'URL_IMPORT')),
  status TEXT NOT NULL DEFAULT 'QUEUED',
  stage TEXT NOT NULL DEFAULT 'QUEUED',
  priority INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT NOT NULL DEFAULT '{}',
  error TEXT NULL,
  error_code TEXT NULL,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  dedupe_key TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT NULL,
  finished_at TEXT NULL
);
CREATE INDEX IF NOT EXISTS idx_p8jobs_project ON phase8_jobs(project_id);
CREATE INDEX IF NOT EXISTS idx_p8jobs_user_status ON phase8_jobs(user_id, status);
CREATE INDEX IF NOT EXISTS idx_p8jobs_status ON phase8_jobs(status);
CREATE INDEX IF NOT EXISTS idx_p8jobs_dedupe ON phase8_jobs(user_id, dedupe_key);

CREATE TABLE IF NOT EXISTS enhancement_configs (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES clip_versions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  video_enabled INTEGER NOT NULL DEFAULT 0,
  audio_enabled INTEGER NOT NULL DEFAULT 0,
  video_json TEXT NOT NULL DEFAULT '{}',
  audio_json TEXT NOT NULL DEFAULT '{}',
  scope TEXT NOT NULL DEFAULT 'project',
  item_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_enhcfg_version ON enhancement_configs(version_id);

CREATE TABLE IF NOT EXISTS effect_presets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('video', 'audio', 'background', 'effect')),
  settings_json TEXT NOT NULL DEFAULT '{}',
  based_on TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_epresets_user ON effect_presets(user_id, kind);

CREATE TABLE IF NOT EXISTS media_license_records (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asset_ref TEXT NOT NULL,
  provider TEXT NULL,
  license_name TEXT NULL,
  attribution_text TEXT NULL,
  source_url TEXT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mlic_asset ON media_license_records(asset_ref);

CREATE TABLE IF NOT EXISTS asset_usage_records (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NULL,
  asset_ref TEXT NOT NULL,
  usage_type TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_asset ON asset_usage_records(asset_ref);
CREATE INDEX IF NOT EXISTS idx_usage_project ON asset_usage_records(project_id);
`;

// ---- Migration v8 (Phase 9: Export Studio & Rendering Queue) ---------
//
// Spec §17 entity mapping onto the existing schema (no parallel
// renderer, no second job store):
//   ExportJob + RenderQueueItem → render_jobs rows with kind='EXPORT'
//     (an export IS a render job whose settings carry an `export`
//     block; the Phase 5 worker drains both). Queue discipline
//     (priority, pause-hold, retry count, real encoder progress)
//     arrives as guarded ADD COLUMNs below because render_jobs
//     predates this phase.
//   ExportPreset        → export_presets (built-ins live in code, in
//     src/export.ts, exactly like Phase 6/8 presets).
//   ExportAsset + RenderOutput + ExportHistory → export_outputs: one
//     row per finished export job, written only after the Phase 5
//     VERIFYING_OUTPUT gate + the Phase 9 QC extension pass. Failed
//     exports get a row too (status FAILED + failure_reason), which is
//     what makes Export History honest.
//   RenderValidationResult → render_validation_results: the persisted
//     preflight (phase PREFLIGHT) and post-render QC (phase QC) check
//     lists, so a failed job can be diagnosed, not just mourned.
//   RenderErrorLog      → render_error_log: one row per export-job
//     failure with the stage it died in.
//   ZIP bundles (§19)   → export_bundles: persisted jobs drained by
//     the bundle worker in src/export.ts.
// Production path (documented, NOT running here): these rows map to
// PostgreSQL drained by BullMQ/Redis workers with outputs in private
// object storage; this environment runs SQLite + in-process workers +
// owner-checked local file endpoints, as Phases 4–8 established.
export const MIGRATION_V8_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS export_presets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_export_presets_user ON export_presets(user_id);

CREATE TABLE IF NOT EXISTS export_outputs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES render_jobs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target_label TEXT NOT NULL DEFAULT '',
  filename TEXT NOT NULL,
  storage_key TEXT NULL,
  format TEXT NOT NULL,
  video_codec TEXT NULL,
  audio_codec TEXT NULL,
  width INTEGER NULL,
  height INTEGER NULL,
  duration REAL NULL,
  file_size INTEGER NULL,
  status TEXT NOT NULL,
  failure_reason TEXT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_export_outputs_user ON export_outputs(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_export_outputs_project ON export_outputs(project_id);

CREATE TABLE IF NOT EXISTS render_validation_results (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES render_jobs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phase TEXT NOT NULL,
  ok INTEGER NOT NULL,
  checks_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_validation_job ON render_validation_results(job_id);

CREATE TABLE IF NOT EXISTS render_error_log (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES render_jobs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_render_errors_job ON render_error_log(job_id);

CREATE TABLE IF NOT EXISTS export_bundles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'QUEUED',
  stage TEXT NOT NULL DEFAULT 'QUEUED',
  job_ids_json TEXT NOT NULL DEFAULT '[]',
  output_path TEXT NULL,
  error TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT NULL
);
CREATE INDEX IF NOT EXISTS idx_bundles_user ON export_bundles(user_id, status);
`;

// ---- Migration v9 (Phase 10: social publishing) -----------------------
// Spec §16 model mapping (SQLite names ← spec entities):
//   PlatformAccount            → platform_accounts
//   OAuthConnection            → oauth_connections (pending/completed flows)
//   OAuthTokenRecord           → oauth_token_records (AES-256-GCM ciphertext ONLY)
//   PlatformCapabilitySnapshot → platform_capability_snapshots
//   ScheduledPost              → scheduled_posts
//   PublishJob                 → publish_jobs (§12 states)
//   PublishAttempt             → publish_attempts
//   PlatformPost               → platform_posts
//   PublishingCalendarEvent    → publishing_calendar_events (a VIEW derived
//                                from scheduled_posts + publish_jobs: calendar
//                                rows are a projection of real records, never
//                                a second store that could drift)
//   PostMetadata               → post_metadata (one row per job; a job is one
//                                clip × one account, so metadata is inherently
//                                per-platform and never shared across targets)
//   PostValidationResult       → post_validation_results
//   PlatformWebhookEvent       → platform_webhook_events
//   PublishingErrorLog         → publishing_error_log
//   PostAnalyticsSnapshot      → post_analytics_snapshots (metrics NULL until
//                                a provider actually returns them — NULL is
//                                "unavailable", never a measured zero)
// Tokens are NEVER stored in plaintext anywhere in this schema.
export const MIGRATION_V9_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS platform_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,               -- youtube | instagram | tiktok
  platform_account_id TEXT NOT NULL,    -- the provider's own account id
  username TEXT NULL,
  display_name TEXT NULL,
  profile_image_url TEXT NULL,
  account_type TEXT NULL,               -- e.g. instagram BUSINESS/CREATOR/PERSONAL as reported
  status TEXT NOT NULL DEFAULT 'CONNECTED',  -- CONNECTED | AUTH_REQUIRED | DISCONNECTED
  granted_scopes_json TEXT NOT NULL DEFAULT '[]',
  token_expires_at TEXT NULL,
  last_synced_at TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, platform, platform_account_id)
);
CREATE INDEX IF NOT EXISTS idx_platform_accounts_user ON platform_accounts(user_id, platform);

CREATE TABLE IF NOT EXISTS oauth_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  state_hash TEXT NOT NULL UNIQUE,      -- SHA-256 of the OAuth state value
  code_verifier TEXT NULL,              -- PKCE verifier, server-side only, single-use
  status TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING | COMPLETED | FAILED | EXPIRED
  account_id TEXT NULL REFERENCES platform_accounts(id) ON DELETE SET NULL,
  error TEXT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_connections_user ON oauth_connections(user_id, status);

CREATE TABLE IF NOT EXISTS oauth_token_records (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL UNIQUE REFERENCES platform_accounts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  encrypted_payload TEXT NOT NULL,      -- AES-256-GCM envelope JSON (src/tokenCrypto.ts)
  key_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_capability_snapshots (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  fetched_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cap_snapshots_account ON platform_capability_snapshots(account_id, fetched_at);

CREATE TABLE IF NOT EXISTS publish_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  clip_id TEXT NULL,                    -- candidate clip id when the export came from one
  export_output_id TEXT NOT NULL REFERENCES export_outputs(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  -- DRAFT | AWAITING_APPROVAL | VALIDATING | SCHEDULED | QUEUED | UPLOADING |
  -- SUBMITTED | PLATFORM_PROCESSING | PUBLISHED | FAILED | CANCELLED | AUTH_REQUIRED
  scheduling_mode TEXT NULL,            -- platform | clipforge (set when SCHEDULED)
  client_request_id TEXT NULL,          -- Idempotency-Key supplied by the client
  approved_at TEXT NULL,
  rights_confirmed_at TEXT NULL,
  submitted_at TEXT NULL,
  published_at TEXT NULL,
  platform_post_id TEXT NULL,
  published_url TEXT NULL,
  error TEXT NULL,
  error_code TEXT NULL,
  error_class TEXT NULL,                -- transient | user_intervention | permanent | ambiguous
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT NULL,
  ambiguous INTEGER NOT NULL DEFAULT 0,
  last_status_check_at TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_publish_jobs_user ON publish_jobs(user_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_publish_jobs_due ON publish_jobs(status, next_retry_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_publish_jobs_idem
  ON publish_jobs(user_id, client_request_id) WHERE client_request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS post_metadata (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES publish_jobs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  thumbnail_storage_key TEXT NULL,      -- uploaded custom thumbnail (YouTube), local media path key
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS post_validation_results (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES publish_jobs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ok INTEGER NOT NULL,
  checks_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_post_validation_job ON post_validation_results(job_id);

CREATE TABLE IF NOT EXISTS scheduled_posts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES publish_jobs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scheduled_for_utc TEXT NOT NULL,      -- always stored in UTC
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  status TEXT NOT NULL DEFAULT 'SCHEDULED',  -- SCHEDULED | FIRED | CANCELLED
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_posts_due ON scheduled_posts(status, scheduled_for_utc);

CREATE TABLE IF NOT EXISTS publish_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES publish_jobs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL,
  kind TEXT NOT NULL,                   -- SUBMIT | STATUS_CHECK | TOKEN_REFRESH | THUMBNAIL
  status TEXT NOT NULL,                 -- STARTED | SUCCEEDED | FAILED | AMBIGUOUS
  provider_request_id TEXT NULL,        -- upload session / publish id returned by the provider
  provider_response_json TEXT NULL,     -- redacted provider response (never contains tokens)
  error TEXT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_publish_attempts_job ON publish_attempts(job_id, attempt_no);

CREATE TABLE IF NOT EXISTS platform_posts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES publish_jobs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  platform_post_id TEXT NOT NULL,
  url TEXT NULL,
  status TEXT NOT NULL DEFAULT 'PUBLISHED',
  raw_json TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_webhook_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  signature_valid INTEGER NOT NULL DEFAULT 0,
  processed INTEGER NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL,
  UNIQUE (provider, event_id)
);
CREATE INDEX IF NOT EXISTS idx_webhook_events_provider ON platform_webhook_events(provider, received_at);

CREATE TABLE IF NOT EXISTS publishing_error_log (
  id TEXT PRIMARY KEY,
  job_id TEXT NULL REFERENCES publish_jobs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NULL,
  stage TEXT NOT NULL,
  code TEXT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_publishing_errors_job ON publishing_error_log(job_id);

CREATE TABLE IF NOT EXISTS post_analytics_snapshots (
  id TEXT PRIMARY KEY,
  platform_post_id TEXT NOT NULL UNIQUE REFERENCES platform_posts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  views INTEGER NULL,
  likes INTEGER NULL,
  comments INTEGER NULL,
  shares INTEGER NULL,
  metrics_status TEXT NOT NULL DEFAULT 'unavailable',  -- unavailable | ok | error
  metric_source TEXT NULL,
  last_synced_at TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE VIEW IF NOT EXISTS publishing_calendar_events AS
SELECT
  sp.id AS id,
  sp.job_id AS job_id,
  sp.user_id AS user_id,
  j.project_id AS project_id,
  j.account_id AS account_id,
  j.platform AS platform,
  sp.scheduled_for_utc AS starts_at_utc,
  sp.timezone AS timezone,
  sp.status AS schedule_status,
  j.status AS job_status
FROM scheduled_posts sp
JOIN publish_jobs j ON j.id = sp.job_id;
`;

// ---- Migration v10 (prompt-audit fixes) --------------------------------
// a) candidate_clips gains a third state, DESELECTED: the v3 CHECK only
//    allowed SELECTED/REMOVED, conflating "user unchecked this candidate"
//    with "user removed it". SQLite cannot alter a CHECK in place, so the
//    table is rebuilt (same columns, widened CHECK) inside one
//    transaction with foreign_keys temporarily OFF (clip_versions
//    references candidate_clips(id)); every row and id is preserved, so
//    existing references keep resolving after the rename.
// b) export_outputs gains target_kind/target_id (guarded ensureColumn in
//    getDb): a finished export must remember WHAT it was made from
//    (document | version | candidate + id) — Phase 10 publishing derives
//    publish_jobs.clip_id from a candidate-targeted export.
// c) render_jobs gains worker_id (guarded ensureColumn in getDb): the
//    worker process that claimed a job records its id at claim time.
export const MIGRATION_V10_SQL = /* sql */ `
CREATE TABLE candidate_clips_new (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES processing_tasks(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_asset_id TEXT NOT NULL REFERENCES source_assets(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_sec REAL NOT NULL,
  end_sec REAL NOT NULL,
  duration REAL NOT NULL,
  score INTEGER NOT NULL,
  reasons_json TEXT NOT NULL DEFAULT '[]',
  suggested_title TEXT NOT NULL,
  title TEXT NOT NULL,
  transcript_excerpt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'SELECTED' CHECK (status IN ('SELECTED', 'DESELECTED', 'REMOVED')),
  preview_path TEXT NULL,
  preview_status TEXT NOT NULL DEFAULT 'PENDING',
  preview_error TEXT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO candidate_clips_new (id, task_id, project_id, source_asset_id, user_id, start_sec, end_sec, duration, score, reasons_json, suggested_title, title, transcript_excerpt, status, preview_path, preview_status, preview_error, created_at)
SELECT id, task_id, project_id, source_asset_id, user_id, start_sec, end_sec, duration, score, reasons_json, suggested_title, title, transcript_excerpt, status, preview_path, preview_status, preview_error, created_at FROM candidate_clips;
DROP TABLE candidate_clips;
ALTER TABLE candidate_clips_new RENAME TO candidate_clips;
CREATE INDEX IF NOT EXISTS idx_candidates_project_id ON candidate_clips(project_id);
CREATE INDEX IF NOT EXISTS idx_candidates_task_id ON candidate_clips(task_id);
CREATE INDEX IF NOT EXISTS idx_candidates_user_id ON candidate_clips(user_id);
`;

// ---- Migration v11 (Phase 11: Analytics & Performance Intelligence) ---
// Spec §19 models. Every analytics record retains its provenance:
// user / platform / account / post / metric / unit / definition / date
// range / collection time / source / API version / availability status.
// A metric the provider did not return is stored as a NULL value with
// availability_status != 'ok' — unavailable is NEVER stored as zero.
// Snapshots are idempotent per sync job (unique indexes on sync_job_id)
// so a retried stage can never duplicate a successful sync's records.
export const MIGRATION_V11_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS analytics_metric_definitions (
  metric_key TEXT NOT NULL,
  platform TEXT NOT NULL,               -- youtube | instagram | tiktok | all
  display_name TEXT NOT NULL,
  unit TEXT NOT NULL,                   -- count | seconds
  kind TEXT NOT NULL,                   -- daily_activity | lifetime_counter | gauge
  definition TEXT NOT NULL,
  source_note TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (metric_key, platform)
);

CREATE TABLE IF NOT EXISTS analytics_capabilities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL UNIQUE REFERENCES platform_accounts(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  endpoints_json TEXT NOT NULL DEFAULT '[]',
  metrics_json TEXT NOT NULL DEFAULT '[]',
  dimensions_json TEXT NOT NULL DEFAULT '[]',
  required_permissions_json TEXT NOT NULL DEFAULT '[]',
  limitations_json TEXT NOT NULL DEFAULT '[]',
  supported_range_json TEXT NOT NULL DEFAULT '{}',
  api_version TEXT NOT NULL DEFAULT '',
  last_capability_check_at TEXT NULL,
  last_successful_retrieval_at TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_analytics_capabilities_user ON analytics_capabilities(user_id, platform);

CREATE TABLE IF NOT EXISTS analytics_account_snapshots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  sync_job_id TEXT NULL,
  range_start TEXT NULL,
  range_end TEXT NULL,
  source TEXT NOT NULL DEFAULT '',
  api_version TEXT NOT NULL DEFAULT '',
  collected_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_analytics_acct_snap_job
  ON analytics_account_snapshots(sync_job_id) WHERE sync_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_analytics_acct_snap_account
  ON analytics_account_snapshots(account_id, collected_at);

CREATE TABLE IF NOT EXISTS analytics_post_snapshots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  platform_post_id TEXT NOT NULL REFERENCES platform_posts(id) ON DELETE CASCADE,
  internal_post_id TEXT NULL,           -- publish_jobs.id
  platform_post_external_id TEXT NULL,  -- the provider's own post id
  sync_job_id TEXT NULL,
  range_start TEXT NULL,
  range_end TEXT NULL,
  source TEXT NOT NULL DEFAULT '',
  api_version TEXT NOT NULL DEFAULT '',
  post_status TEXT NOT NULL DEFAULT 'ok',  -- ok | deleted | unavailable
  collected_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_analytics_post_snap_job
  ON analytics_post_snapshots(sync_job_id, platform_post_id) WHERE sync_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_analytics_post_snap_post
  ON analytics_post_snapshots(platform_post_id, collected_at);

CREATE TABLE IF NOT EXISTS analytics_metric_values (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,                  -- account | post
  snapshot_id TEXT NULL,
  platform_post_id TEXT NULL REFERENCES platform_posts(id) ON DELETE CASCADE,
  internal_post_id TEXT NULL,
  metric_key TEXT NOT NULL,
  metric_value REAL NULL,               -- NULL when unavailable — never a fake zero
  unit TEXT NOT NULL DEFAULT 'count',
  definition TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'lifetime_counter',
  range_start TEXT NULL,
  range_end TEXT NULL,
  collected_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  api_version TEXT NOT NULL DEFAULT '',
  availability_status TEXT NOT NULL DEFAULT 'ok',  -- ok | unavailable | unsupported | error
  availability_reason TEXT NULL,
  correction_flag INTEGER NOT NULL DEFAULT 0,  -- 1 when a cumulative counter decreased (platform correction)
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_analytics_values_account
  ON analytics_metric_values(user_id, account_id, metric_key, range_start);
CREATE INDEX IF NOT EXISTS idx_analytics_values_post
  ON analytics_metric_values(platform_post_id, metric_key, collected_at);
CREATE INDEX IF NOT EXISTS idx_analytics_values_user_metric
  ON analytics_metric_values(user_id, metric_key, collected_at);

CREATE TABLE IF NOT EXISTS analytics_sync_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
  platform TEXT NULL,
  scope TEXT NOT NULL,                  -- account | platform | all | post
  platform_post_id TEXT NULL,
  range_start TEXT NULL,
  range_end TEXT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED',
  -- QUEUED | VALIDATING_ACCOUNT | FETCHING_ACCOUNT_DATA | FETCHING_POST_DATA
  -- | FETCHING_METRICS | NORMALIZING_DATA | SAVING_SNAPSHOTS
  -- | COMPLETED | PARTIAL_SUCCESS | FAILED | CANCELLED | AUTH_REQUIRED
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_attempt_at TEXT NULL,
  progress_json TEXT NULL,
  error TEXT NULL,
  error_code TEXT NULL,
  error_class TEXT NULL,                -- transient | user_intervention | permanent
  source TEXT NOT NULL DEFAULT 'manual',  -- manual | schedule | post_refresh
  worker_id TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT NULL,
  finished_at TEXT NULL
);
CREATE INDEX IF NOT EXISTS idx_analytics_sync_jobs_user ON analytics_sync_jobs(user_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_sync_jobs_due ON analytics_sync_jobs(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS analytics_sync_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES analytics_sync_jobs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL,
  status TEXT NOT NULL,                 -- STARTED | SUCCEEDED | FAILED
  stage_reached TEXT NULL,
  error TEXT NULL,
  error_code TEXT NULL,
  created_at TEXT NOT NULL,
  finished_at TEXT NULL
);
CREATE INDEX IF NOT EXISTS idx_analytics_sync_attempts_job ON analytics_sync_attempts(job_id, attempt_no);

CREATE TABLE IF NOT EXISTS analytics_insights (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                   -- OBSERVATION | CORRELATION | SUGGESTION
  rule_key TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  platform TEXT NULL,
  account_id TEXT NULL,
  range_start TEXT NULL,
  range_end TEXT NULL,
  sample_size INTEGER NOT NULL DEFAULT 0,
  formula TEXT NULL,
  limitations TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ACTIVE',  -- ACTIVE | DISMISSED | SAVED
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_analytics_insights_user ON analytics_insights(user_id, status, created_at);

CREATE TABLE IF NOT EXISTS analytics_insight_evidence (
  id TEXT PRIMARY KEY,
  insight_id TEXT NOT NULL REFERENCES analytics_insights(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  metric_key TEXT NULL,
  value_json TEXT NOT NULL DEFAULT 'null',
  platform_post_id TEXT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_analytics_evidence_insight ON analytics_insight_evidence(insight_id);

CREATE TABLE IF NOT EXISTS analytics_reports (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'QUEUED',  -- QUEUED | GENERATING | COMPLETED | FAILED
  error TEXT NULL,
  range_start TEXT NULL,
  range_end TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  generated_at TEXT NULL
);
CREATE INDEX IF NOT EXISTS idx_analytics_reports_user ON analytics_reports(user_id, created_at);

CREATE TABLE IF NOT EXISTS analytics_report_exports (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES analytics_reports(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  format TEXT NOT NULL,                 -- csv | xlsx | pdf
  status TEXT NOT NULL DEFAULT 'QUEUED',  -- QUEUED | GENERATING | COMPLETED | FAILED
  storage_key TEXT NULL,
  file_size INTEGER NULL,
  error TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (report_id, format)
);
CREATE INDEX IF NOT EXISTS idx_analytics_report_exports_report ON analytics_report_exports(report_id);

CREATE TABLE IF NOT EXISTS analytics_comparison_groups (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  post_ids_json TEXT NOT NULL DEFAULT '[]',
  range_start TEXT NULL,
  range_end TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS analytics_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  auto_sync_minutes INTEGER NOT NULL DEFAULT 0,  -- 0 = scheduled sync off
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS analytics_audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_analytics_audit_user ON analytics_audit_log(user_id, created_at);
`;

// ---- Migration v12 (Phase 12: accounts, workspaces, usage, admin) -----
// Additive only. Column extensions on pre-existing tables (users,
// sessions, projects, brand_kits) go through ensureColumn in getDb —
// the same pattern earlier phases used — while every Phase 12 model
// gets its own table here. Backfill (personal workspaces, plan
// seeding, default subscriptions) runs in migrateV12Backfill because
// it needs per-row logic SQL alone cannot express; it is idempotent.
export const MIGRATION_V12_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  language TEXT NOT NULL DEFAULT 'en',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  date_format TEXT NOT NULL DEFAULT 'YYYY-MM-DD',
  time_format TEXT NOT NULL DEFAULT '24h',
  default_aspect_ratio TEXT NOT NULL DEFAULT '9:16',
  default_export_resolution TEXT NOT NULL DEFAULT '1080p',
  caption_language TEXT NOT NULL DEFAULT 'en',
  default_caption_template_id TEXT NULL,
  default_brand_kit_id TEXT NULL,
  default_workspace_id TEXT NULL,
  editor_prefs_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NULL REFERENCES users(id) ON DELETE SET NULL,
  email TEXT NOT NULL,
  event_type TEXT NOT NULL,
  ip TEXT NULL,
  user_agent TEXT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_events_user ON login_events(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_login_events_email ON login_events(email, created_at);

CREATE TABLE IF NOT EXISTS email_change_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  new_email TEXT NOT NULL,
  hashed_token TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ect_user_id ON email_change_tokens(user_id);

CREATE TABLE IF NOT EXISTS user_totp (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_encrypted TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  confirmed_at TEXT NULL
);

CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at TEXT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mfa_codes_user ON mfa_recovery_codes(user_id);

CREATE TABLE IF NOT EXISTS mfa_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  remember_me INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  logo_path TEXT NULL,
  settings_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  is_personal INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_user_id);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_ws_members_user ON workspace_members(user_id);

CREATE TABLE IF NOT EXISTS workspace_invitations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL,
  invited_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hashed_token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'PENDING',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  responded_at TEXT NULL
);
CREATE INDEX IF NOT EXISTS idx_ws_invites_ws ON workspace_invitations(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_ws_invites_email ON workspace_invitations(email, status);

CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  in_app INTEGER NOT NULL DEFAULT 1,
  email INTEGER NOT NULL DEFAULT 0,
  browser INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, category)
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT NULL,
  read_at TEXT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at);

CREATE TABLE IF NOT EXISTS usage_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NULL,
  project_id TEXT NULL,
  job_id TEXT NULL,
  operation TEXT NOT NULL,
  provider TEXT NULL,
  resource TEXT NOT NULL,
  unit TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'COMPLETED',
  entitlement_key TEXT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_user_time ON usage_ledger(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_user_op ON usage_ledger(user_id, operation, created_at);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  monthly_price_cents INTEGER NULL,
  annual_price_cents INTEGER NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plan_entitlements (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  limit_value REAL NULL,
  feature_enabled INTEGER NULL,
  UNIQUE (plan_id, key)
);

CREATE TABLE IF NOT EXISTS user_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  source TEXT NOT NULL DEFAULT 'admin',
  current_period_start TEXT NULL,
  current_period_end TEXT NULL,
  cancel_requested_at TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subs_user ON user_subscriptions(user_id, created_at);

CREATE TABLE IF NOT EXISTS subscription_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id TEXT NULL,
  event_type TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  actor_user_id TEXT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sub_events_user ON subscription_events(user_id, created_at);

CREATE TABLE IF NOT EXISTS payment_provider_records (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 0,
  config_status TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
  secret_ref TEXT NULL,
  updated_by TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_webhook_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL DEFAULT '',
  signature_valid INTEGER NOT NULL DEFAULT 0,
  processed INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (provider, event_id)
);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id TEXT NULL,
  provider TEXT NULL,
  provider_invoice_id TEXT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invoices_user ON invoices(user_id, created_at);

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT NULL,
  workspace_id TEXT NULL,
  event_type TEXT NOT NULL,
  target_type TEXT NULL,
  target_id TEXT NULL,
  result TEXT NOT NULL DEFAULT 'SUCCESS',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  ip TEXT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON admin_audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON admin_audit_log(actor_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_type ON admin_audit_log(event_type, created_at);

CREATE TABLE IF NOT EXISTS system_health_checks (
  id TEXT PRIMARY KEY,
  check_key TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  checked_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_health_key_time ON system_health_checks(check_key, checked_at);

CREATE TABLE IF NOT EXISTS provider_configurations (
  id TEXT PRIMARY KEY,
  provider_key TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  category TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  secret_ref TEXT NULL,
  last_health_status TEXT NULL,
  last_health_at TEXT NULL,
  last_error TEXT NULL,
  updated_by TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS support_tickets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  priority TEXT NOT NULL DEFAULT 'NORMAL',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tickets_user ON support_tickets(user_id, created_at);

CREATE TABLE IF NOT EXISTS support_ticket_messages (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_user_id TEXT NOT NULL,
  author_kind TEXT NOT NULL DEFAULT 'USER',
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ticket_msgs ON support_ticket_messages(ticket_id, created_at);

CREATE TABLE IF NOT EXISTS data_export_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'QUEUED',
  file_path TEXT NULL,
  error TEXT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT NULL
);
CREATE INDEX IF NOT EXISTS idx_data_exports_user ON data_export_jobs(user_id, created_at);

CREATE TABLE IF NOT EXISTS account_deletion_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED',
  detail_json TEXT NOT NULL DEFAULT '{}',
  error TEXT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT NULL
);
CREATE INDEX IF NOT EXISTS idx_deletion_user ON account_deletion_jobs(user_id, created_at);
`;

// ---- Migration v14 (fix pass: usage-ledger retention) ------------------
// The v12 usage_ledger declared user_id TEXT NOT NULL REFERENCES
// users(id) ON DELETE CASCADE, so deleting an account cascade-deleted
// its ledger rows — breaking the ledger's immutability promise (the
// audit log survives deletion precisely because its actor column is
// nullable with no FK). SQLite cannot alter a column's nullability or
// FK action in place, so the table is rebuilt (same columns, same
// UNIQUE idempotency key, same indexes) with user_id nullable and
// ON DELETE SET NULL: on account deletion the rows survive, anonymized
// to user_id NULL. Guarded by introspection in migrateV14 — it only
// runs while the live table still has the CASCADE form.
export const MIGRATION_V14_SQL = /* sql */ `
CREATE TABLE usage_ledger_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NULL REFERENCES users(id) ON DELETE SET NULL,
  workspace_id TEXT NULL,
  project_id TEXT NULL,
  job_id TEXT NULL,
  operation TEXT NOT NULL,
  provider TEXT NULL,
  resource TEXT NOT NULL,
  unit TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'COMPLETED',
  entitlement_key TEXT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
INSERT INTO usage_ledger_new (id, user_id, workspace_id, project_id, job_id, operation, provider, resource, unit, quantity, status, entitlement_key, idempotency_key, created_at)
SELECT id, user_id, workspace_id, project_id, job_id, operation, provider, resource, unit, quantity, status, entitlement_key, idempotency_key, created_at FROM usage_ledger;
DROP TABLE usage_ledger;
ALTER TABLE usage_ledger_new RENAME TO usage_ledger;
CREATE INDEX IF NOT EXISTS idx_usage_user_time ON usage_ledger(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_user_op ON usage_ledger(user_id, operation, created_at);
`;

/**
 * v12 backfill: plan seeding + per-user foundations. Idempotent —
 * every step checks for existing rows first, so re-boots and partially
 * migrated databases converge without duplicating anything.
 *  - The five plan LABELS from the spec, with NULL prices ("not set")
 *    and NULL entitlement limits until an administrator configures
 *    real values. Nothing here invents pricing or quotas.
 *  - Every user gets: a preferences row, a personal workspace they
 *    own, an OWNER membership in it, an active-workspace pointer, and
 *    a Free-plan subscription (source recorded honestly).
 *  - Pre-v12 projects and brand kits are assigned to their owner's
 *    personal workspace.
 */
const PLAN_SEED: { key: string; name: string; description: string }[] = [
  { key: "free", name: "Free", description: "Default plan. Limits are set by an administrator." },
  { key: "starter", name: "Starter", description: "Plan label — pricing and limits are configured by an administrator." },
  { key: "creator", name: "Creator", description: "Plan label — pricing and limits are configured by an administrator." },
  { key: "pro", name: "Pro", description: "Plan label — pricing and limits are configured by an administrator." },
  { key: "team", name: "Team", description: "Plan label — pricing and limits are configured by an administrator." },
];
export const ENTITLEMENT_KEYS = [
  "storage_bytes",
  "ai_processing_minutes",
  "exports_per_month",
  "connected_accounts",
  "team_members",
] as const;
export const FEATURE_KEYS = [
  "publishing",
  "analytics",
  "ai_captions",
  "face_lock",
  "broll",
  "priority_rendering",
] as const;

function migrateV12Backfill(db: DatabaseSync): void {
  const now = new Date().toISOString();
  const planCount = (db.prepare("SELECT COUNT(*) AS n FROM plans").get() as { n: number }).n;
  if (planCount === 0) {
    const insPlan = db.prepare(
      "INSERT INTO plans (id, key, name, description, monthly_price_cents, annual_price_cents, currency, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, 'USD', 1, ?, ?)",
    );
    const insEnt = db.prepare(
      "INSERT INTO plan_entitlements (id, plan_id, key, limit_value, feature_enabled) VALUES (?, ?, ?, NULL, NULL)",
    );
    for (const p of PLAN_SEED) {
      const planId = crypto.randomUUID();
      insPlan.run(planId, p.key, p.name, p.description, now, now);
      for (const key of [...ENTITLEMENT_KEYS, ...FEATURE_KEYS]) {
        insEnt.run(crypto.randomUUID(), planId, key);
      }
    }
  }
  const freePlan = db.prepare("SELECT id FROM plans WHERE key = 'free'").get() as
    | { id: string }
    | undefined;
  const users = db.prepare("SELECT id, display_name FROM users").all() as unknown as {
    id: string;
    display_name: string;
  }[];
  for (const user of users) {
    db.prepare(
      `INSERT OR IGNORE INTO user_preferences (user_id, updated_at) VALUES (?, ?)`,
    ).run(user.id, now);
    let personal = db
      .prepare("SELECT id FROM workspaces WHERE owner_user_id = ? AND is_personal = 1")
      .get(user.id) as { id: string } | undefined;
    if (!personal) {
      const wsId = crypto.randomUUID();
      db.prepare(
        "INSERT INTO workspaces (id, name, owner_user_id, logo_path, settings_json, status, is_personal, created_at, updated_at) VALUES (?, ?, ?, NULL, '{}', 'ACTIVE', 1, ?, ?)",
      ).run(wsId, "Personal", user.id, now, now);
      personal = { id: wsId };
    }
    db.prepare(
      "INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'OWNER', ?)",
    ).run(personal.id, user.id, now);
    db.prepare(
      "UPDATE users SET active_workspace_id = ? WHERE id = ? AND (active_workspace_id IS NULL OR active_workspace_id = '')",
    ).run(personal.id, user.id);
    db.prepare("UPDATE projects SET workspace_id = ? WHERE user_id = ? AND workspace_id IS NULL").run(
      personal.id,
      user.id,
    );
    db.prepare("UPDATE brand_kits SET workspace_id = ? WHERE user_id = ? AND workspace_id IS NULL").run(
      personal.id,
      user.id,
    );
    if (freePlan) {
      const hasSub = db
        .prepare("SELECT id FROM user_subscriptions WHERE user_id = ?")
        .get(user.id);
      if (!hasSub) {
        const subId = crypto.randomUUID();
        db.prepare(
          "INSERT INTO user_subscriptions (id, user_id, plan_id, status, source, created_at, updated_at) VALUES (?, ?, ?, 'ACTIVE', 'migration', ?, ?)",
        ).run(subId, user.id, freePlan.id, now, now);
        db.prepare(
          "INSERT INTO subscription_events (id, user_id, subscription_id, event_type, detail_json, actor_user_id, created_at) VALUES (?, ?, ?, 'ASSIGNED', ?, NULL, ?)",
        ).run(
          crypto.randomUUID(),
          user.id,
          subId,
          JSON.stringify({ planKey: "free", source: "migration" }),
          now,
        );
      }
    }
  }
}

/**
 * v10 candidate_clips rebuild: only runs when the live table still has
 * the v3 two-state CHECK. Transactional; foreign_keys is toggled OFF
 * outside the transaction (the pragma is a no-op inside one) so the
 * DROP cannot cascade into referencing tables, and integrity is
 * re-verified with foreign_key_check before returning.
 */
function migrateV10(db: DatabaseSync): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'candidate_clips'")
    .get() as unknown as { sql: string } | undefined;
  if (!row || row.sql.includes("'DESELECTED'")) return;
  db.exec("PRAGMA foreign_keys = OFF;");
  try {
    db.exec("BEGIN IMMEDIATE;");
    db.exec(MIGRATION_V10_SQL);
    db.exec("COMMIT;");
  } catch (err) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      /* transaction already gone */
    }
    throw err;
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }
  const violations = db.prepare("PRAGMA foreign_key_check").all();
  if (violations.length > 0) {
    throw new Error(`migration v10: foreign_key_check found ${violations.length} violation(s) after candidate_clips rebuild`);
  }
}

/**
 * v14 usage_ledger rebuild: only runs when the live table still has
 * the v12 form (user_id NOT NULL ... ON DELETE CASCADE — the only FK
 * on the table, so the CASCADE marker is unambiguous). Transactional;
 * foreign_keys is toggled OFF outside the transaction (the pragma is
 * a no-op inside one) so the DROP is safe, and integrity is
 * re-verified with foreign_key_check before returning. After the
 * rebuild the stored SQL carries ON DELETE SET NULL instead, so
 * restarts skip it.
 */
function migrateV14(db: DatabaseSync): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'usage_ledger'")
    .get() as unknown as { sql: string } | undefined;
  if (!row || !row.sql.includes("ON DELETE CASCADE")) return;
  db.exec("PRAGMA foreign_keys = OFF;");
  try {
    db.exec("BEGIN IMMEDIATE;");
    db.exec(MIGRATION_V14_SQL);
    db.exec("COMMIT;");
  } catch (err) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      /* transaction already gone */
    }
    throw err;
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }
  const violations = db.prepare("PRAGMA foreign_key_check").all();
  if (violations.length > 0) {
    throw new Error(`migration v14: foreign_key_check found ${violations.length} violation(s) after usage_ledger rebuild`);
  }
}

/**
 * v15 source_assets rebuild: widen the source_type CHECK so a source
 * imported from a user-supplied URL (yt-dlp) is stored honestly as
 * 'URL_IMPORT' instead of being mislabelled 'UPLOAD'. Same rebuild
 * discipline as v10/v14: only runs while the stored SQL lacks
 * 'URL_IMPORT', transactional, foreign_keys toggled OFF outside the
 * transaction, integrity re-verified with foreign_key_check. All
 * columns and both indexes are carried over unchanged.
 */
export const MIGRATION_V15_SQL = /* sql */ `
CREATE TABLE source_assets_new (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('UPLOAD', 'YOUTUBE_URL', 'URL_IMPORT')),
  original_filename TEXT NOT NULL,
  source_url TEXT NULL,
  external_id TEXT NULL,
  storage_key TEXT NULL,
  storage_provider TEXT NOT NULL DEFAULT 'local',
  file_size INTEGER NULL,
  duration REAL NULL,
  width INTEGER NULL,
  height INTEGER NULL,
  frame_rate REAL NULL,
  video_codec TEXT NULL,
  audio_codec TEXT NULL,
  has_audio INTEGER NULL,
  container TEXT NULL,
  bitrate INTEGER NULL,
  validation_status TEXT NOT NULL DEFAULT 'PENDING',
  validation_error TEXT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO source_assets_new (id, project_id, user_id, source_type, original_filename, source_url, external_id, storage_key, storage_provider, file_size, duration, width, height, frame_rate, video_codec, audio_codec, has_audio, container, bitrate, validation_status, validation_error, created_at)
SELECT id, project_id, user_id, source_type, original_filename, source_url, external_id, storage_key, storage_provider, file_size, duration, width, height, frame_rate, video_codec, audio_codec, has_audio, container, bitrate, validation_status, validation_error, created_at FROM source_assets;
DROP TABLE source_assets;
ALTER TABLE source_assets_new RENAME TO source_assets;
CREATE INDEX IF NOT EXISTS idx_assets_project_id ON source_assets(project_id);
CREATE INDEX IF NOT EXISTS idx_assets_user_id ON source_assets(user_id);
`;

/**
 * v15 phase8_jobs rebuild: widen the kind CHECK so URL-import jobs
 * (yt-dlp downloads) are first-class phase8_jobs rows (kind
 * 'URL_IMPORT') drained by the same worker as PROVIDER_IMPORT. Same
 * discipline as the source_assets rebuild above; all columns and all
 * four indexes are carried over unchanged.
 */
export const MIGRATION_V15_JOBS_SQL = /* sql */ `
CREATE TABLE phase8_jobs_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version_id TEXT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('BROLL_RECOMMENDATIONS', 'ENHANCEMENT', 'ENHANCEMENT_PREVIEW', 'BACKGROUND_REMOVAL', 'PROVIDER_IMPORT', 'AI_GENERATION', 'URL_IMPORT')),
  status TEXT NOT NULL DEFAULT 'QUEUED',
  stage TEXT NOT NULL DEFAULT 'QUEUED',
  priority INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT NOT NULL DEFAULT '{}',
  error TEXT NULL,
  error_code TEXT NULL,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  dedupe_key TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT NULL,
  finished_at TEXT NULL
);
INSERT INTO phase8_jobs_new (id, user_id, project_id, version_id, kind, status, stage, priority, payload_json, result_json, error, error_code, cancel_requested, dedupe_key, created_at, updated_at, started_at, finished_at)
SELECT id, user_id, project_id, version_id, kind, status, stage, priority, payload_json, result_json, error, error_code, cancel_requested, dedupe_key, created_at, updated_at, started_at, finished_at FROM phase8_jobs;
DROP TABLE phase8_jobs;
ALTER TABLE phase8_jobs_new RENAME TO phase8_jobs;
CREATE INDEX IF NOT EXISTS idx_p8jobs_project ON phase8_jobs(project_id);
CREATE INDEX IF NOT EXISTS idx_p8jobs_user_status ON phase8_jobs(user_id, status);
CREATE INDEX IF NOT EXISTS idx_p8jobs_status ON phase8_jobs(status);
CREATE INDEX IF NOT EXISTS idx_p8jobs_dedupe ON phase8_jobs(user_id, dedupe_key);
`;

function migrateV15(db: DatabaseSync): void {
  const tableLacks = (table: string): boolean => {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as unknown as { sql: string } | undefined;
    return !!row && !row.sql.includes("'URL_IMPORT'");
  };
  const rebuildSources = tableLacks("source_assets");
  const rebuildJobs = tableLacks("phase8_jobs");
  if (!rebuildSources && !rebuildJobs) return;
  db.exec("PRAGMA foreign_keys = OFF;");
  try {
    db.exec("BEGIN IMMEDIATE;");
    if (rebuildSources) db.exec(MIGRATION_V15_SQL);
    if (rebuildJobs) db.exec(MIGRATION_V15_JOBS_SQL);
    db.exec("COMMIT;");
  } catch (err) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      /* transaction already gone */
    }
    throw err;
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }
  const violations = db.prepare("PRAGMA foreign_key_check").all();
  if (violations.length > 0) {
    throw new Error(`migration v15: foreign_key_check found ${violations.length} violation(s) after rebuild`);
  }
}

/** ALTER TABLE ADD COLUMN is not idempotent — guard by introspection. */
function ensureColumn(db: DatabaseSync, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  const file = config.databaseFile;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(MIGRATION_SQL);
  db.exec(MIGRATION_V2_SQL);
  db.exec(MIGRATION_V3_SQL);
  db.exec(MIGRATION_V4_SQL);
  db.exec(MIGRATION_V5_SQL);
  ensureColumn(db, "caption_segments", "style_json", "style_json TEXT NULL");
  ensureColumn(db, "caption_segments", "language", "language TEXT NULL");
  db.exec(MIGRATION_V6_SQL);
  db.exec(MIGRATION_V7_SQL);
  db.exec(MIGRATION_V8_SQL);
  // Phase 9: queue discipline columns on the pre-existing render_jobs.
  ensureColumn(db, "render_jobs", "kind", "kind TEXT NOT NULL DEFAULT 'RENDER'");
  ensureColumn(db, "render_jobs", "priority", "priority INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "render_jobs", "retry_count", "retry_count INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "render_jobs", "progress_json", "progress_json TEXT NULL");
  ensureColumn(db, "render_jobs", "output_name", "output_name TEXT NULL");
  db.exec(MIGRATION_V9_SQL);
  // Phase 9 audit (migration v10): widen candidate_clips status to three
  // states, remember each export's target, record the claiming worker.
  migrateV10(db);
  ensureColumn(db, "export_outputs", "target_kind", "target_kind TEXT NULL");
  ensureColumn(db, "export_outputs", "target_id", "target_id TEXT NULL");
  ensureColumn(db, "render_jobs", "worker_id", "worker_id TEXT NULL");
  // Phase 11: analytics snapshots, metric values, sync jobs, insights,
  // reports (additive only — CREATE TABLE IF NOT EXISTS throughout).
  db.exec(MIGRATION_V11_SQL);
  // Phase 12: account/workspace/usage/admin foundations. Column
  // extensions on pre-v12 tables go through ensureColumn; the new
  // models are MIGRATION_V12_SQL; per-user backfill is idempotent.
  ensureColumn(db, "users", "avatar_path", "avatar_path TEXT NULL");
  ensureColumn(db, "users", "status", "status TEXT NOT NULL DEFAULT 'ACTIVE'");
  ensureColumn(db, "users", "is_admin", "is_admin INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "users", "last_login_at", "last_login_at TEXT NULL");
  ensureColumn(db, "users", "active_workspace_id", "active_workspace_id TEXT NULL");
  ensureColumn(db, "sessions", "ip", "ip TEXT NULL");
  ensureColumn(db, "sessions", "user_agent", "user_agent TEXT NULL");
  ensureColumn(db, "sessions", "last_active_at", "last_active_at TEXT NULL");
  ensureColumn(db, "projects", "workspace_id", "workspace_id TEXT NULL");
  ensureColumn(db, "brand_kits", "workspace_id", "workspace_id TEXT NULL");
  db.exec(MIGRATION_V12_SQL);
  migrateV12Backfill(db);
  // Fix pass (migration v13): TOTP replay prevention — remember the
  // last time step each user successfully authenticated with, so a
  // valid code cannot be replayed inside its window (additive only).
  ensureColumn(db, "user_totp", "last_used_step", "last_used_step INTEGER NULL");
  // Fix pass (migration v14): usage_ledger.user_id becomes nullable
  // with ON DELETE SET NULL (guarded table rebuild), so ledger rows
  // survive account deletion anonymized instead of cascade-deleting.
  migrateV14(db);
  // URL-import pass (migration v15): source_assets.source_type learns
  // 'URL_IMPORT' (guarded table rebuild — see migrateV15).
  migrateV15(db);
  db.exec("PRAGMA user_version = 15;");
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export interface UserRow {
  id: string;
  display_name: string;
  email: string;
  password_hash: string;
  email_verified_at: string | null;
  created_at: string;
  updated_at: string;
  /** Phase 12 (guarded ADD COLUMNs). Optional because register/login
   *  construct UserRow literals before insert; readers use defaults. */
  avatar_path?: string | null;
  status?: string;
  is_admin?: number;
  last_login_at?: string | null;
  active_workspace_id?: string | null;
}

export interface SessionRow {
  id: string;
  user_id: string;
  expires_at: string;
  created_at: string;
  /** Phase 12 (guarded ADD COLUMNs). */
  ip?: string | null;
  user_agent?: string | null;
  last_active_at?: string | null;
}

export interface TokenRow {
  id: number;
  user_id: string;
  hashed_token: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

// ---- Phase 3 rows --------------------------------------------------------

export interface ProjectRow {
  id: string;
  user_id: string;
  name: string;
  workflow_type: "LONG_VIDEO_TO_SHORTS" | "SHORT_VIDEO_ENHANCEMENT";
  status: string;
  settings_json: string;
  ai_instruction: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
  /** Phase 12 (guarded ADD COLUMN): owning workspace. */
  workspace_id?: string | null;
}

export interface SourceAssetRow {
  id: string;
  project_id: string;
  user_id: string;
  source_type: "UPLOAD" | "YOUTUBE_URL" | "URL_IMPORT";
  original_filename: string;
  source_url: string | null;
  external_id: string | null;
  storage_key: string | null;
  storage_provider: string;
  file_size: number | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  frame_rate: number | null;
  video_codec: string | null;
  audio_codec: string | null;
  has_audio: number | null;
  container: string | null;
  bitrate: number | null;
  validation_status: string;
  validation_error: string | null;
  created_at: string;
}

export interface UploadSessionRow {
  id: string;
  user_id: string;
  project_id: string;
  source_asset_id: string | null;
  upload_status: string;
  bytes_uploaded: number;
  total_bytes: number;
  expires_at: string;
  created_at: string;
}

// ---- Phase 4 rows --------------------------------------------------------

export interface ProcessingTaskRow {
  id: string;
  user_id: string;
  project_id: string;
  source_asset_id: string;
  prompt: string | null;
  settings_json: string;
  status: string;
  stage: string;
  error: string | null;
  error_code: string | null;
  outcome: string | null;
  signals_json: string;
  cancel_requested: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface TranscriptRow {
  id: string;
  task_id: string;
  project_id: string;
  source_asset_id: string;
  language: string | null;
  language_probability: number | null;
  duration: number | null;
  full_text: string;
  provider: string;
  model: string;
  created_at: string;
}

export interface TranscriptSegmentRow {
  id: string;
  transcript_id: string;
  idx: number;
  start_sec: number;
  end_sec: number;
  text: string;
  words_json: string | null;
  speaker: string | null;
}

export interface TopicSegmentRow {
  id: string;
  transcript_id: string;
  start_sec: number;
  end_sec: number;
  label: string;
  summary_text: string;
}

export interface CandidateClipRow {
  id: string;
  task_id: string;
  project_id: string;
  source_asset_id: string;
  user_id: string;
  start_sec: number;
  end_sec: number;
  duration: number;
  score: number;
  reasons_json: string;
  suggested_title: string;
  title: string;
  transcript_excerpt: string;
  status: "SELECTED" | "DESELECTED" | "REMOVED";
  preview_path: string | null;
  preview_status: string;
  preview_error: string | null;
  created_at: string;
}

// ---- Phase 5 rows --------------------------------------------------------

export interface ClipVersionRow {
  id: string;
  user_id: string;
  project_id: string;
  base_candidate_id: string | null;
  canvas_json: string;
  settings_json: string;
  undo_cursor: number;
  created_at: string;
  updated_at: string;
}

export interface TimelineTrackRow {
  id: string;
  version_id: string;
  kind: string;
  label: string;
  order_idx: number;
  locked: number;
  visible: number;
  muted: number;
  solo: number;
}

export interface TimelineItemRow {
  id: string;
  version_id: string;
  track_id: string;
  asset_kind: string;
  asset_id: string;
  start_sec: number;
  duration_sec: number;
  source_in_sec: number;
  source_out_sec: number;
  transform_json: string;
  speed: number;
  volume: number;
  fade_in_sec: number;
  fade_out_sec: number;
  layer_order: number;
  created_at: string;
}

export interface EditingOperationRow {
  id: string;
  version_id: string;
  seq: number;
  type: string;
  payload_json: string;
  created_at: string;
}

export interface CaptionSegmentRow {
  id: string;
  version_id: string;
  start_sec: number;
  end_sec: number;
  text: string;
  words_json: string | null;
  created_at: string;
  /** Phase 6 (migration v5): per-segment style override + language. */
  style_json: string | null;
  language: string | null;
}

export interface SceneOverrideRow {
  id: string;
  version_id: string;
  topic_segment_id: string | null;
  range_start_sec: number;
  range_end_sec: number;
  overrides_json: string;
  created_at: string;
}

export interface ProjectVersionRow {
  id: string;
  version_id: string;
  name: string;
  snapshot_json: string;
  created_at: string;
}

export interface ProjectMediaRow {
  id: string;
  project_id: string;
  user_id: string;
  kind: "AUDIO" | "VIDEO";
  original_filename: string;
  storage_key: string | null;
  storage_provider: string;
  file_size: number | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  video_codec: string | null;
  audio_codec: string | null;
  has_audio: number | null;
  has_video: number | null;
  container: string | null;
  created_at: string;
}

export interface RenderJobRow {
  id: string;
  version_id: string;
  project_id: string;
  user_id: string;
  status: string;
  stage: string;
  settings_json: string;
  output_path: string | null;
  error: string | null;
  cancel_requested: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  /** Phase 9 (guarded ADD COLUMNs; optional here because rows read
   *  through older test harnesses may predate them — runtime code
   *  reads them defensively with ?? defaults). */
  kind?: string;
  priority?: number;
  retry_count?: number;
  progress_json?: string | null;
  output_name?: string | null;
  /** Migration v10 (guarded ADD COLUMN): id of the worker process
   *  that claimed the job, set at claim time. */
  worker_id?: string | null;
}

// ---- Phase 9 rows --------------------------------------------------------

export interface ExportPresetRow {
  id: string;
  user_id: string;
  name: string;
  settings_json: string;
  created_at: string;
  updated_at: string;
}

export interface ExportOutputRow {
  id: string;
  job_id: string;
  user_id: string;
  project_id: string;
  target_label: string;
  filename: string;
  storage_key: string | null;
  format: string;
  video_codec: string | null;
  audio_codec: string | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  file_size: number | null;
  status: string;
  failure_reason: string | null;
  created_at: string;
  /** Migration v10 (guarded ADD COLUMNs): what this export was made
   *  from — target_kind is document | version | candidate, target_id
   *  the version/candidate id (NULL for document targets and for
   *  outputs recorded before v10). */
  target_kind?: string | null;
  target_id?: string | null;
}

export interface RenderValidationResultRow {
  id: string;
  job_id: string;
  user_id: string;
  phase: string;
  ok: number;
  checks_json: string;
  created_at: string;
}

export interface RenderErrorLogRow {
  id: string;
  job_id: string;
  user_id: string;
  stage: string;
  message: string;
  created_at: string;
}

export interface ExportBundleRow {
  id: string;
  user_id: string;
  status: string;
  stage: string;
  job_ids_json: string;
  output_path: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

// ---- Phase 6 rows --------------------------------------------------------

export interface CaptionTrackRow {
  id: string;
  version_id: string;
  user_id: string;
  project_id: string;
  language: string;
  kind: "original" | "translation" | "manual";
  label: string;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface CaptionTrackSegmentRow {
  id: string;
  track_id: string;
  start_sec: number;
  end_sec: number;
  text: string;
  words_json: string | null;
  style_json: string | null;
  created_at: string;
}

export interface CaptionTemplateRow {
  id: string;
  user_id: string;
  name: string;
  style_json: string;
  based_on: string | null;
  created_at: string;
  updated_at: string;
}

export interface BrandAssetRow {
  id: string;
  user_id: string;
  kind: "LOGO" | "INTRO" | "OUTRO" | "MUSIC" | "OVERLAY" | "OTHER";
  original_filename: string;
  storage_key: string | null;
  storage_provider: string;
  file_size: number | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  has_audio: number | null;
  has_video: number | null;
  container: string | null;
  created_at: string;
}

export interface BrandKitRow {
  id: string;
  user_id: string;
  name: string;
  brand_name: string;
  primary_color: string;
  secondary_color: string;
  accent_color: string;
  font_family: string | null;
  caption_template_id: string | null;
  caption_style_json: string | null;
  logo_asset_id: string | null;
  intro_asset_id: string | null;
  outro_asset_id: string | null;
  music_asset_id: string | null;
  overlay_asset_id: string | null;
  is_default: number;
  created_at: string;
  updated_at: string;
  /** Phase 12 (guarded ADD COLUMN): owning workspace. */
  workspace_id?: string | null;
}

export interface TranslationJobRow {
  id: string;
  user_id: string;
  project_id: string;
  version_id: string;
  source_language: string;
  target_language: string;
  provider: string;
  status: string;
  error: string | null;
  error_code: string | null;
  result_track_id: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

// ---- Phase 7 rows --------------------------------------------------------

export interface TrackingJobRow {
  id: string;
  user_id: string;
  project_id: string;
  source_asset_id: string;
  settings_json: string;
  status: string;
  stage: string;
  progress_json: string;
  scenes_json: string;
  result_json: string;
  error: string | null;
  error_code: string | null;
  outcome: string | null;
  cancel_requested: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface TrackedSubjectRow {
  id: string;
  job_id: string;
  subject_key: string;
  kind: "face" | "person";
  first_seen_sec: number;
  last_seen_sec: number;
  present_samples: number;
  total_samples: number;
  mean_confidence: number | null;
  best_confidence: number | null;
  best_time_sec: number | null;
  best_bbox_json: string | null;
  thumb_path: string | null;
  created_at: string;
}

export interface TrackingFrameRow {
  id: string;
  job_id: string;
  subject_id: string;
  t_sec: number;
  bbox_json: string;
  confidence: number | null;
  features_json: string;
  created_at: string;
}

export interface SubjectAssociationRow {
  id: string;
  job_id: string;
  subject_id: string;
  window_start_sec: number;
  window_end_sec: number;
  speech_source: string;
  score: number;
  confidence: "low" | "medium" | "high";
  is_active_pick: number;
  evidence_json: string;
  created_at: string;
}

export interface ReframeConfigurationRow {
  id: string;
  version_id: string;
  user_id: string;
  project_id: string;
  job_id: string | null;
  mode: string;
  enabled: number;
  aspect: string;
  out_width: number;
  out_height: number;
  fit_mode: string;
  subject_key: string | null;
  target_pos_x: string;
  target_pos_y: string;
  controls_json: string;
  config_version: number;
  created_at: string;
  updated_at: string;
}

export interface TrackingKeyframeRow {
  id: string;
  config_id: string;
  job_id: string | null;
  region_subject_key: string | null;
  kind: "crop" | "manual";
  t_sec: number;
  crop_json: string | null;
  fit: string;
  subject_key: string | null;
  confidence: number | null;
  lost: number;
  created_at: string;
}

export interface SceneTrackingOverrideRow {
  id: string;
  config_id: string;
  topic_segment_id: string | null;
  range_start_sec: number;
  range_end_sec: number;
  mode: string | null;
  subject_key: string | null;
  settings_json: string;
  created_at: string;
  updated_at: string;
}

export interface SplitScreenLayoutRow {
  id: string;
  config_id: string;
  layout: string;
  regions_json: string;
  created_at: string;
  updated_at: string;
}

// ---- Phase 8 rows --------------------------------------------------------

export interface MediaAssetMetaRow {
  asset_ref: string;
  user_id: string;
  project_id: string | null;
  category: string;
  folder_id: string | null;
  source_type: string;
  provider: string | null;
  provider_asset_id: string | null;
  license_name: string | null;
  attribution_text: string | null;
  processing_status: string;
  tags_json: string;
  hidden: number;
  created_at: string;
  updated_at: string;
}

export interface MediaLibraryFolderRow {
  id: string;
  user_id: string;
  name: string;
  parent_id: string | null;
  created_at: string;
}

export interface BrollRecommendationRow {
  id: string;
  job_id: string | null;
  user_id: string;
  project_id: string;
  transcript_id: string | null;
  window_start_sec: number;
  window_end_sec: number;
  passage: string;
  asset_ref: string;
  asset_kind: string;
  asset_id: string;
  score: number;
  matched_terms_json: string;
  reason: string;
  suggested_start_sec: number;
  suggested_duration_sec: number;
  source: string;
  license_json: string | null;
  status: string;
  placement_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface BrollPlacementRow {
  id: string;
  user_id: string;
  project_id: string;
  version_id: string;
  recommendation_id: string | null;
  item_id: string;
  asset_kind: string;
  asset_id: string;
  start_sec: number;
  duration_sec: number;
  source_in_sec: number;
  source_out_sec: number;
  display_mode: string;
  keep_original_audio: number;
  created_at: string;
  updated_at: string;
}

export interface Phase8JobRow {
  id: string;
  user_id: string;
  project_id: string;
  version_id: string | null;
  kind: string;
  status: string;
  stage: string;
  priority: number;
  payload_json: string;
  result_json: string;
  error: string | null;
  error_code: string | null;
  cancel_requested: number;
  dedupe_key: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface EnhancementConfigRow {
  id: string;
  version_id: string;
  user_id: string;
  project_id: string;
  video_enabled: number;
  audio_enabled: number;
  video_json: string;
  audio_json: string;
  scope: string;
  item_ids_json: string;
  created_at: string;
  updated_at: string;
}

export interface EffectPresetRow {
  id: string;
  user_id: string;
  name: string;
  kind: string;
  settings_json: string;
  based_on: string | null;
  created_at: string;
  updated_at: string;
}

export interface MediaLicenseRecordRow {
  id: string;
  user_id: string;
  asset_ref: string;
  provider: string | null;
  license_name: string | null;
  attribution_text: string | null;
  source_url: string | null;
  recorded_at: string;
}

export interface AssetUsageRecordRow {
  id: string;
  user_id: string;
  project_id: string | null;
  asset_ref: string;
  usage_type: string;
  detail_json: string;
  created_at: string;
}

// ---- Phase 10 row types --------------------------------------------------

export interface PlatformAccountRow {
  id: string;
  user_id: string;
  platform: string;
  platform_account_id: string;
  username: string | null;
  display_name: string | null;
  profile_image_url: string | null;
  account_type: string | null;
  status: string;
  granted_scopes_json: string;
  token_expires_at: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OAuthConnectionRow {
  id: string;
  user_id: string;
  platform: string;
  state_hash: string;
  code_verifier: string | null;
  status: string;
  account_id: string | null;
  error: string | null;
  created_at: string;
  expires_at: string;
}

export interface OAuthTokenRecordRow {
  id: string;
  account_id: string;
  user_id: string;
  encrypted_payload: string;
  key_version: number;
  created_at: string;
  updated_at: string;
}

export interface PublishJobRow {
  id: string;
  user_id: string;
  project_id: string;
  clip_id: string | null;
  export_output_id: string;
  account_id: string;
  platform: string;
  status: string;
  scheduling_mode: string | null;
  client_request_id: string | null;
  approved_at: string | null;
  rights_confirmed_at: string | null;
  submitted_at: string | null;
  published_at: string | null;
  platform_post_id: string | null;
  published_url: string | null;
  error: string | null;
  error_code: string | null;
  error_class: string | null;
  retry_count: number;
  next_retry_at: string | null;
  ambiguous: number;
  last_status_check_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PostMetadataRow {
  id: string;
  job_id: string;
  user_id: string;
  platform: string;
  metadata_json: string;
  thumbnail_storage_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScheduledPostRow {
  id: string;
  job_id: string;
  user_id: string;
  scheduled_for_utc: string;
  timezone: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface PublishAttemptRow {
  id: string;
  job_id: string;
  user_id: string;
  attempt_no: number;
  kind: string;
  status: string;
  provider_request_id: string | null;
  provider_response_json: string | null;
  error: string | null;
  created_at: string;
}

export interface PlatformPostRow {
  id: string;
  job_id: string;
  user_id: string;
  account_id: string;
  platform: string;
  platform_post_id: string;
  url: string | null;
  status: string;
  raw_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface PostAnalyticsSnapshotRow {
  id: string;
  platform_post_id: string;
  user_id: string;
  platform: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  metrics_status: string;
  metric_source: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

// ---- Phase 11: analytics rows -------------------------------------------

export interface AnalyticsMetricDefinitionRow {
  metric_key: string;
  platform: string;
  display_name: string;
  unit: string;
  kind: string;
  definition: string;
  source_note: string;
}

export interface AnalyticsCapabilityRow {
  id: string;
  user_id: string;
  account_id: string;
  platform: string;
  endpoints_json: string;
  metrics_json: string;
  dimensions_json: string;
  required_permissions_json: string;
  limitations_json: string;
  supported_range_json: string;
  api_version: string;
  last_capability_check_at: string | null;
  last_successful_retrieval_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AnalyticsAccountSnapshotRow {
  id: string;
  user_id: string;
  account_id: string;
  platform: string;
  sync_job_id: string | null;
  range_start: string | null;
  range_end: string | null;
  source: string;
  api_version: string;
  collected_at: string;
  created_at: string;
}

export interface AnalyticsPostSnapshotRow {
  id: string;
  user_id: string;
  account_id: string;
  platform: string;
  platform_post_id: string;
  internal_post_id: string | null;
  platform_post_external_id: string | null;
  sync_job_id: string | null;
  range_start: string | null;
  range_end: string | null;
  source: string;
  api_version: string;
  post_status: string;
  collected_at: string;
  created_at: string;
}

export interface AnalyticsMetricValueRow {
  id: string;
  user_id: string;
  platform: string;
  account_id: string;
  scope: string;
  snapshot_id: string | null;
  platform_post_id: string | null;
  internal_post_id: string | null;
  metric_key: string;
  metric_value: number | null;
  unit: string;
  definition: string;
  kind: string;
  range_start: string | null;
  range_end: string | null;
  collected_at: string;
  source: string;
  api_version: string;
  availability_status: string;
  availability_reason: string | null;
  correction_flag: number;
  created_at: string;
}

export interface AnalyticsSyncJobRow {
  id: string;
  user_id: string;
  account_id: string | null;
  platform: string | null;
  scope: string;
  platform_post_id: string | null;
  range_start: string | null;
  range_end: string | null;
  status: string;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string | null;
  progress_json: string | null;
  error: string | null;
  error_code: string | null;
  error_class: string | null;
  source: string;
  worker_id: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface AnalyticsSyncAttemptRow {
  id: string;
  job_id: string;
  user_id: string;
  attempt_no: number;
  status: string;
  stage_reached: string | null;
  error: string | null;
  error_code: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface AnalyticsInsightRow {
  id: string;
  user_id: string;
  kind: string;
  rule_key: string;
  subject_key: string;
  title: string;
  body: string;
  platform: string | null;
  account_id: string | null;
  range_start: string | null;
  range_end: string | null;
  sample_size: number;
  formula: string | null;
  limitations: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface AnalyticsInsightEvidenceRow {
  id: string;
  insight_id: string;
  user_id: string;
  label: string;
  metric_key: string | null;
  value_json: string;
  platform_post_id: string | null;
  created_at: string;
}

export interface AnalyticsReportRow {
  id: string;
  user_id: string;
  name: string;
  config_json: string;
  status: string;
  error: string | null;
  range_start: string | null;
  range_end: string | null;
  created_at: string;
  updated_at: string;
  generated_at: string | null;
}

export interface AnalyticsReportExportRow {
  id: string;
  report_id: string;
  user_id: string;
  format: string;
  status: string;
  storage_key: string | null;
  file_size: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface AnalyticsComparisonGroupRow {
  id: string;
  user_id: string;
  name: string;
  post_ids_json: string;
  range_start: string | null;
  range_end: string | null;
  created_at: string;
  updated_at: string;
}

// ---- Phase 12 rows -------------------------------------------------------

export interface UserPreferencesRow {
  user_id: string;
  language: string;
  timezone: string;
  date_format: string;
  time_format: string;
  default_aspect_ratio: string;
  default_export_resolution: string;
  caption_language: string;
  default_caption_template_id: string | null;
  default_brand_kit_id: string | null;
  default_workspace_id: string | null;
  editor_prefs_json: string;
  updated_at: string;
}

export interface WorkspaceRow {
  id: string;
  name: string;
  owner_user_id: string;
  logo_path: string | null;
  settings_json: string;
  status: string;
  is_personal: number;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceMemberRow {
  workspace_id: string;
  user_id: string;
  role: string;
  joined_at: string;
}

export interface WorkspaceInvitationRow {
  id: string;
  workspace_id: string;
  email: string;
  role: string;
  invited_by: string;
  hashed_token: string;
  status: string;
  expires_at: string;
  created_at: string;
  responded_at: string | null;
}

export interface NotificationRow {
  id: string;
  user_id: string;
  category: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  read_at: string | null;
  created_at: string;
}

export interface UsageLedgerRow {
  id: string;
  user_id: string;
  workspace_id: string | null;
  project_id: string | null;
  job_id: string | null;
  operation: string;
  provider: string | null;
  resource: string;
  unit: string;
  quantity: number;
  status: string;
  entitlement_key: string | null;
  idempotency_key: string;
  created_at: string;
}

export interface PlanRow {
  id: string;
  key: string;
  name: string;
  description: string;
  monthly_price_cents: number | null;
  annual_price_cents: number | null;
  currency: string;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface PlanEntitlementRow {
  id: string;
  plan_id: string;
  key: string;
  limit_value: number | null;
  feature_enabled: number | null;
}

export interface UserSubscriptionRow {
  id: string;
  user_id: string;
  plan_id: string;
  status: string;
  source: string;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_requested_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SupportTicketRow {
  id: string;
  user_id: string;
  category: string;
  subject: string;
  status: string;
  priority: string;
  created_at: string;
  updated_at: string;
}

export interface DataExportJobRow {
  id: string;
  user_id: string;
  status: string;
  file_path: string | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface AccountDeletionJobRow {
  id: string;
  user_id: string;
  status: string;
  detail_json: string;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}
