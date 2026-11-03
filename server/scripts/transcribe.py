#!/usr/bin/env python3
"""CLIPFORGE local speech-to-text worker (faster-whisper).

Usage: transcribe.py <wav-path> <model> [language|auto] [initial-prompt]

IMPORTANT (machine-specific, verified): faster-whisper's own audio
decoding goes through PyAV, and on this machine that path is broken
(PyAV raises "open() got an unexpected keyword argument
'metadata_errors'"). So this script decodes the WAV itself: the server
extracts a 16 kHz mono WAV with FFmpeg, this script reads it with the
stdlib `wave` module + numpy, and passes a float32 array to
WhisperModel.transcribe(). Nothing about the transcript is invented
here — text, timestamps and probabilities come straight from the model.

Output: exactly one JSON object on stdout:
  {"language": ..., "languageProbability": ..., "duration": ...,
   "segments": [{"start": ..., "end": ..., "text": ...,
                 "words": [{"start": ..., "end": ..., "word": ...,
                            "probability": ...}]}]}
Errors go to stderr with a non-zero exit code.

faster-whisper provides NO speaker diarization, so no speaker fields
are emitted — the server stores speaker as NULL and the UI says so.
"""

import json
import sys
import wave

import numpy as np


def load_wav_mono_16k(path: str) -> np.ndarray:
    with wave.open(path, "rb") as handle:
        frames = handle.getnframes()
        rate = handle.getframerate()
        channels = handle.getnchannels()
        width = handle.getsampwidth()
        raw = handle.readframes(frames)
    if width != 2:
        raise ValueError(f"expected 16-bit PCM WAV, got sample width {width}")
    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    if rate != 16000:
        # The server always extracts at 16 kHz; resample linearly if a
        # different rate ever arrives rather than failing outright.
        target = int(round(len(audio) * 16000 / rate))
        idx = (np.arange(target) * rate / 16000).astype(int)
        idx = np.minimum(idx, len(audio) - 1)
        audio = audio[idx]
    return np.ascontiguousarray(audio, dtype=np.float32)


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: transcribe.py <wav> <model> [language|auto] [initial-prompt]", file=sys.stderr)
        return 2
    wav_path = sys.argv[1]
    model_name = sys.argv[2]
    language = sys.argv[3] if len(sys.argv) > 3 else "auto"
    initial_prompt = sys.argv[4] if len(sys.argv) > 4 else ""

    from faster_whisper import WhisperModel

    audio = load_wav_mono_16k(wav_path)
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    options = {
        "word_timestamps": True,
        "vad_filter": True,
        "beam_size": 5,
    }
    if language and language != "auto":
        options["language"] = language
    if initial_prompt:
        options["initial_prompt"] = initial_prompt

    segments_iter, info = model.transcribe(audio, **options)
    segments = []
    for seg in segments_iter:
        words = []
        for word in (seg.words or []):
            words.append(
                {
                    "start": round(float(word.start), 3),
                    "end": round(float(word.end), 3),
                    "word": word.word,
                    "probability": round(float(word.probability), 4)
                    if word.probability is not None
                    else None,
                }
            )
        segments.append(
            {
                "start": round(float(seg.start), 3),
                "end": round(float(seg.end), 3),
                "text": seg.text.strip(),
                "words": words,
            }
        )

    payload = {
        "language": info.language,
        "languageProbability": round(float(info.language_probability), 4),
        "duration": round(float(info.duration), 3),
        "segments": segments,
    }
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # surfaced to the server as the stage error
        print(f"transcribe.py failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
