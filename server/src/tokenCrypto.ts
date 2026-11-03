// Phase 10 — OAuth token encryption at rest.
//
// Provider access/refresh tokens are secrets. They are stored ONLY
// as AES-256-GCM ciphertext in oauth_token_records.encrypted_payload
// and decrypted in server memory at the moment an API call is made.
// They never appear in API responses, logs, or frontend payloads.
//
// Key resolution:
//  1. TOKEN_ENCRYPTION_KEY env var (base64-encoded 32 bytes) — the
//     production path; README documents setting it. In production,
//     src/config.ts validateProductionConfig() (called from
//     src/index.ts before listen) is the primary gate and fails fast
//     when this key is missing/invalid; the lazy length check in
//     loadKey() below remains only as a backstop.
//  2. Development fallback: a random key generated once into
//     server/data/.token-key with 0600 permissions and a clear
//     console warning. This keeps local development honest (tokens
//     are still encrypted at rest) without pretending an env-managed
//     key exists — Platform Settings reports which mode is active.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config, serverDir } from "./config.js";

const ALGO = "aes-256-gcm";
const KEY_FILE = path.join(serverDir, "data", ".token-key");

let cachedKey: Buffer | null = null;
let cachedMode: "env" | "dev-file" | null = null;
let warned = false;

function loadKey(): { key: Buffer; mode: "env" | "dev-file" } {
  if (cachedKey && cachedMode) return { key: cachedKey, mode: cachedMode };
  const envKey = config.publishing.tokenEncryptionKey.trim();
  if (envKey) {
    const key = Buffer.from(envKey, "base64");
    if (key.length !== 32) {
      throw new Error(
        "TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key (generate one with: openssl rand -base64 32).",
      );
    }
    cachedKey = key;
    cachedMode = "env";
    return { key, mode: "env" };
  }
  // Development fallback key file.
  let key: Buffer;
  if (fs.existsSync(KEY_FILE)) {
    key = Buffer.from(fs.readFileSync(KEY_FILE, "utf8").trim(), "base64");
    if (key.length !== 32) {
      throw new Error("server/data/.token-key is corrupt (expected a base64 32-byte key).");
    }
  } else {
    key = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
    fs.writeFileSync(KEY_FILE, key.toString("base64"), { mode: 0o600 });
    try {
      fs.chmodSync(KEY_FILE, 0o600);
    } catch {
      /* best effort on exotic filesystems */
    }
  }
  if (!warned) {
    warned = true;
    console.warn(
      "[publishing] TOKEN_ENCRYPTION_KEY is not set — using the development key file server/data/.token-key (0600). " +
        "Set TOKEN_ENCRYPTION_KEY in the environment for production.",
    );
  }
  cachedKey = key;
  cachedMode = "dev-file";
  return { key, mode: "dev-file" };
}

export function tokenEncryptionStatus(): { mode: "env" | "dev-file"; ready: boolean } {
  try {
    const { mode } = loadKey();
    return { mode, ready: true };
  } catch {
    return { mode: config.publishing.tokenEncryptionKey ? "env" : "dev-file", ready: false };
  }
}

interface TokenEnvelope {
  v: 1;
  iv: string;
  tag: string;
  ct: string;
}

export interface StoredTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null; // ISO — when the access token expires, if the provider said
  scope: string | null;
  tokenType: string | null;
  /** Provider extras needed later (e.g. TikTok open_id). Never secrets beyond tokens. */
  extra?: Record<string, string>;
}

export function encryptTokens(tokens: StoredTokens): string {
  const { key } = loadKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const plaintext = Buffer.from(JSON.stringify(tokens), "utf8");
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope: TokenEnvelope = {
    v: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ct: ct.toString("base64"),
  };
  return JSON.stringify(envelope);
}

export function decryptTokens(payload: string): StoredTokens {
  const { key } = loadKey();
  const envelope = JSON.parse(payload) as TokenEnvelope;
  if (envelope.v !== 1) throw new Error("Unsupported token envelope version.");
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(envelope.ct, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(pt.toString("utf8")) as StoredTokens;
}

// ---- Phase 12: generic secret text --------------------------------------
// Same AES-256-GCM envelope + key as the OAuth tokens, for other
// at-rest secrets (currently: TOTP MFA secrets). The plaintext is an
// arbitrary string; the stored form is the same JSON envelope.

export function encryptText(plaintext: string): string {
  return encryptTokens({
    accessToken: plaintext,
    refreshToken: null,
    expiresAt: null,
    scope: null,
    tokenType: "secret-text",
  });
}

export function decryptText(payload: string): string {
  return decryptTokens(payload).accessToken;
}
