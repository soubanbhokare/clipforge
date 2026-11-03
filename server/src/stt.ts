// Speech-to-text provider adapters (Phase 4).
//
// Two providers, selected with STT_PROVIDER:
//  - "local-faster-whisper" (default): runs scripts/transcribe.py on
//    this server with a local Whisper model (WHISPER_MODEL, default
//    "small"). Configured only when python3 can actually import
//    faster_whisper — verified once and cached.
//  - "openai-compatible": POSTs the WAV to an OpenAI-compatible
//    /audio/transcriptions endpoint (STT_API_BASE, OPENAI_API_KEY).
//    Configured only when an API key is present.
//
// Neither provider performs speaker diarization: transcripts carry no
// speaker labels, and nothing downstream may invent them. When the
// selected provider is not configured, callers must surface a
// CONFIGURATION error — never substitute made-up transcript text.

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config, serverDir } from "./config.js";

export interface SttWord {
  start: number;
  end: number;
  word: string;
  probability: number | null;
}

export interface SttSegment {
  start: number;
  end: number;
  text: string;
  words: SttWord[];
}

export interface SttResult {
  language: string | null;
  languageProbability: number | null;
  duration: number | null;
  segments: SttSegment[];
  provider: string;
  model: string;
}

export interface SttConfig {
  provider: string;
  configured: boolean;
  model: string;
  detail: string;
}

export class SttConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SttConfigurationError";
  }
}

type ChildRegistrar = (child: ChildProcess) => () => void;

export interface TranscribeOptions {
  language?: string | null;
  initialPrompt?: string | null;
  registerChild?: ChildRegistrar;
}

const LOCAL_PROVIDER = "local-faster-whisper";
const OPENAI_PROVIDER = "openai-compatible";

export function selectedProvider(): string {
  return config.sttProvider === OPENAI_PROVIDER ? OPENAI_PROVIDER : LOCAL_PROVIDER;
}

// ---- local provider configuration probe (cached) ------------------------

let localProbe: Promise<boolean> | null = null;

function probeLocalProvider(): Promise<boolean> {
  if (localProbe) return localProbe;
  localProbe = new Promise((resolve) => {
    const child = spawn(config.pythonBin, ["-c", "import faster_whisper, numpy"], {
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(false);
    }, 30_000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
  return localProbe;
}

export async function getSttConfig(): Promise<SttConfig> {
  const provider = selectedProvider();
  if (provider === OPENAI_PROVIDER) {
    const configured = Boolean(config.sttApiKey);
    return {
      provider,
      configured,
      model: config.whisperModel,
      detail: configured
        ? `OpenAI-compatible transcription endpoint at ${config.sttApiBase}.`
        : "STT_PROVIDER is openai-compatible but OPENAI_API_KEY is not set on the server, so transcription cannot run.",
    };
  }
  const configured = await probeLocalProvider();
  return {
    provider,
    configured,
    model: config.whisperModel,
    detail: configured
      ? `Local faster-whisper model "${config.whisperModel}" running on this server.`
      : "The local faster-whisper provider is not available on this server (python3 + faster_whisper could not be loaded), so transcription cannot run.",
  };
}

// ---- local provider -------------------------------------------------------

function transcribeLocal(wavPath: string, options: TranscribeOptions): Promise<SttResult> {
  const script = path.join(serverDir, "scripts", "transcribe.py");
  const args = [script, wavPath, config.whisperModel, options.language ?? "auto"];
  if (options.initialPrompt) args.push(options.initialPrompt);
  return new Promise((resolve, reject) => {
    const child = spawn(config.pythonBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const unregister = options.registerChild?.(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString("utf8")).slice(-8000);
    });
    child.on("error", (err) => {
      unregister?.();
      reject(new Error(`Could not start the transcription process: ${err.message}`));
    });
    child.on("close", (code) => {
      unregister?.();
      if (code !== 0) {
        const tail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 500);
        reject(new Error(`Transcription failed${tail ? `: ${tail}` : ` (exit code ${code}).`}`));
        return;
      }
      try {
        const line = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
        const parsed = JSON.parse(line) as Omit<SttResult, "provider" | "model">;
        resolve({ ...parsed, provider: LOCAL_PROVIDER, model: config.whisperModel });
      } catch {
        reject(new Error("The transcription process returned unreadable output."));
      }
    });
  });
}

// ---- OpenAI-compatible provider --------------------------------------------

interface OpenAiSegment {
  start?: number;
  end?: number;
  text?: string;
  words?: { start?: number; end?: number; word?: string }[];
}

async function transcribeOpenAi(wavPath: string, options: TranscribeOptions): Promise<SttResult> {
  const form = new FormData();
  const bytes = fs.readFileSync(wavPath);
  form.append("file", new Blob([bytes], { type: "audio/wav" }), "audio.wav");
  form.append("model", config.whisperModel);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  form.append("timestamp_granularities[]", "segment");
  if (options.language) form.append("language", options.language);
  if (options.initialPrompt) form.append("prompt", options.initialPrompt);

  let res: Response;
  try {
    res = await fetch(`${config.sttApiBase}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.sttApiKey}` },
      body: form,
      signal: AbortSignal.timeout(10 * 60_000),
    });
  } catch (err) {
    throw new Error(`Could not reach the transcription endpoint: ${err instanceof Error ? err.message : "network error"}`);
  }
  if (!res.ok) {
    throw new Error(`The transcription endpoint returned HTTP ${res.status}. Check STT_API_BASE and the API key on the server.`);
  }
  const data = (await res.json()) as {
    language?: string;
    duration?: number;
    text?: string;
    segments?: OpenAiSegment[];
  };
  const segments: SttSegment[] = (data.segments ?? []).map((s) => ({
    start: s.start ?? 0,
    end: s.end ?? s.start ?? 0,
    text: (s.text ?? "").trim(),
    words: (s.words ?? []).map((w) => ({
      start: w.start ?? 0,
      end: w.end ?? w.start ?? 0,
      word: w.word ?? "",
      probability: null, // this API does not return word probabilities
    })),
  }));
  // Some compatible endpoints omit segments; fall back to one segment
  // holding the real returned text (never invented) without word data.
  if (segments.length === 0 && data.text) {
    segments.push({ start: 0, end: data.duration ?? 0, text: data.text.trim(), words: [] });
  }
  return {
    language: data.language ?? null,
    languageProbability: null, // not reported by this API — stated, not faked
    duration: data.duration ?? null,
    segments,
    provider: OPENAI_PROVIDER,
    model: config.whisperModel,
  };
}

// ---- public entry point -----------------------------------------------------

export async function transcribeAudio(wavPath: string, options: TranscribeOptions = {}): Promise<SttResult> {
  const cfg = await getSttConfig();
  if (!cfg.configured) {
    throw new SttConfigurationError(cfg.detail);
  }
  return cfg.provider === OPENAI_PROVIDER ? transcribeOpenAi(wavPath, options) : transcribeLocal(wavPath, options);
}
