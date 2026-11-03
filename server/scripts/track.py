#!/usr/bin/env python3
"""CLIPFORGE Phase 7 computer-vision worker (face/person detection + VAD).

Usage: track.py <video-path> <workdir> <options-json-path>

What this does — real detection only, nothing simulated:
  * Samples the video at a fixed interval (default 0.5 s) at reduced
    width (default 480 px) with FFmpeg — never every frame at full
    resolution (Phase 7 spec section 15).
  * Detects FACES per sample with YuNet (OpenCV FaceDetectorYN, ONNX
    model) — bounding box, the detector's own confidence score and the
    5 facial landmarks are reported verbatim.
  * Detects PEOPLE per sample with a YOLOv8-nano ONNX model through
    onnxruntime (COCO class 0 = person), when that model file exists.
  * Computes speech activity with the Silero VAD ONNX model named by
    the vadModel option (the server resolves SILERO_VAD_MODEL first and
    otherwise defaults to the model that ships with faster-whisper),
    when a 16 kHz mono WAV path is provided.
  * For each face it also reports two landmark-derived mouth-region
    measurements (mouth width and nose-to-mouth distance, normalised
    by the face box). YuNet exposes only the two mouth CORNERS, so
    these are motion proxies — the server uses their variance over
    time as one piece of visual speaking evidence and labels it as a
    proxy.

Progress is streamed on stdout as JSON lines:
  {"type": "progress", "stage": ..., "done": k, "total": n}
and the final line is {"type": "result", ...payload}. Errors go to
stderr with a non-zero exit code. All coordinates in the payload are
normalised to 0..1 of the sampled frame (same aspect as the source),
so they map to any output resolution.

Subjects are anonymous: no identity, name or external matching of any
kind is performed — detections are just boxes in this video.
"""

import json
import math
import os
import subprocess
import sys

import numpy as np


def emit(obj) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def extract_frames(video_path: str, workdir: str, interval: float, width: int) -> list:
    frames_dir = os.path.join(workdir, "frames")
    os.makedirs(frames_dir, exist_ok=True)
    fps = 1.0 / interval
    cmd = [
        "ffmpeg", "-v", "error", "-y", "-i", video_path,
        "-vf", f"fps={fps:.6f},scale={width}:-2",
        "-q:v", "4",
        os.path.join(frames_dir, "%06d.jpg"),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg frame extraction failed: {proc.stderr.strip()[-400:]}")
    files = sorted(f for f in os.listdir(frames_dir) if f.endswith(".jpg"))
    return [os.path.join(frames_dir, f) for f in files]


class FaceDetector:
    def __init__(self, model_path: str, score_threshold: float):
        import cv2

        self.detector = cv2.FaceDetectorYN.create(
            model_path, "", (320, 320), score_threshold, 0.3, 5000
        )

    def detect(self, img) -> list:
        h, w = img.shape[:2]
        self.detector.setInputSize((w, h))
        _, faces = self.detector.detect(img)
        out = []
        if faces is None:
            return out
        for f in faces:
            x, y, bw, bh = (float(f[0]), float(f[1]), float(f[2]), float(f[3]))
            if bw <= 2 or bh <= 2:
                continue
            re_ = (float(f[4]), float(f[5]))
            le = (float(f[6]), float(f[7]))
            nose = (float(f[8]), float(f[9]))
            rm = (float(f[10]), float(f[11]))
            lm = (float(f[12]), float(f[13]))
            mouth_mid = ((rm[0] + lm[0]) / 2.0, (rm[1] + lm[1]) / 2.0)
            mouth_width = math.hypot(lm[0] - rm[0], lm[1] - rm[1]) / max(bw, 1.0)
            nose_mouth = math.hypot(nose[0] - mouth_mid[0], nose[1] - mouth_mid[1]) / max(bh, 1.0)
            out.append(
                {
                    "bbox": [
                        round(x / w, 5),
                        round(y / h, 5),
                        round(bw / w, 5),
                        round(bh / h, 5),
                    ],
                    "confidence": round(float(f[14]), 4),
                    "mouthWidth": round(mouth_width, 4),
                    "noseMouth": round(nose_mouth, 4),
                    "eyeDist": round(math.hypot(le[0] - re_[0], le[1] - re_[1]) / max(bw, 1.0), 4),
                }
            )
        return out


def _nms(boxes: np.ndarray, scores: np.ndarray, iou_thr: float = 0.45) -> list:
    order = scores.argsort()[::-1]
    keep = []
    while order.size > 0:
        i = int(order[0])
        keep.append(i)
        if order.size == 1:
            break
        rest = order[1:]
        xx1 = np.maximum(boxes[i][0], boxes[rest][:, 0])
        yy1 = np.maximum(boxes[i][1], boxes[rest][:, 1])
        xx2 = np.minimum(boxes[i][0] + boxes[i][2], boxes[rest][:, 0] + boxes[rest][:, 2])
        yy2 = np.minimum(boxes[i][1] + boxes[i][3], boxes[rest][:, 1] + boxes[rest][:, 3])
        inter = np.maximum(0.0, xx2 - xx1) * np.maximum(0.0, yy2 - yy1)
        area_i = boxes[i][2] * boxes[i][3]
        areas = boxes[rest][:, 2] * boxes[rest][:, 3]
        union = area_i + areas - inter
        iou = np.where(union > 0, inter / np.maximum(union, 1e-9), 0.0)
        order = rest[iou <= iou_thr]
    return keep


class PersonDetector:
    """YOLOv8-nano ONNX via onnxruntime; COCO class 0 = person."""

    def __init__(self, model_path: str, score_threshold: float):
        import onnxruntime as ort

        self.session = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
        self.input_name = self.session.get_inputs()[0].name
        self.score_threshold = score_threshold
        self.size = 640

    def detect(self, img) -> list:
        import cv2

        h, w = img.shape[:2]
        size = self.size
        scale = min(size / w, size / h)
        nw, nh = int(round(w * scale)), int(round(h * scale))
        resized = cv2.resize(img, (nw, nh))
        canvas = np.full((size, size, 3), 114, dtype=np.uint8)
        pad_x, pad_y = (size - nw) // 2, (size - nh) // 2
        canvas[pad_y:pad_y + nh, pad_x:pad_x + nw] = resized
        blob = canvas[:, :, ::-1].transpose(2, 0, 1)[None].astype(np.float32) / 255.0
        outputs = self.session.run(None, {self.input_name: blob})
        pred = outputs[0][0]  # (84, N): cx, cy, w, h, then 80 class scores
        person_scores = pred[4]
        mask = person_scores >= self.score_threshold
        if not np.any(mask):
            return []
        idxs = np.nonzero(mask)[0]
        boxes = []
        scores = []
        for i in idxs:
            cx, cy, bw, bh = (float(pred[0][i]), float(pred[1][i]), float(pred[2][i]), float(pred[3][i]))
            x = (cx - bw / 2.0 - pad_x) / scale
            y = (cy - bh / 2.0 - pad_y) / scale
            bw_o, bh_o = bw / scale, bh / scale
            x = max(0.0, min(x, w - 1))
            y = max(0.0, min(y, h - 1))
            bw_o = min(bw_o, w - x)
            bh_o = min(bh_o, h - y)
            if bw_o <= 4 or bh_o <= 4:
                continue
            boxes.append([x / w, y / h, bw_o / w, bh_o / h])
            scores.append(float(person_scores[i]))
        if not boxes:
            return []
        boxes_np = np.array(boxes, dtype=np.float64)
        scores_np = np.array(scores, dtype=np.float64)
        keep = _nms(boxes_np, scores_np)
        return [
            {"bbox": [round(float(v), 5) for v in boxes_np[k]], "confidence": round(float(scores_np[k]), 4)}
            for k in keep
        ]


def silero_speech_segments(wav_path: str, model_path: str) -> list:
    """Speech segments from a Silero VAD ONNX model (16 kHz mono WAV).

    The model that is actually loaded is the one at ``model_path`` —
    the server resolves it from SILERO_VAD_MODEL and falls back to the
    silero_vad_v6.onnx bundled with faster-whisper. Probabilities and
    thresholding come from faster-whisper's own VAD helper (its
    SileroVADModel handles the v6 model's split h/c LSTM state and
    64-sample context correctly), so results stay consistent with the
    transcription pipeline.

    faster-whisper 1.2.1's get_speech_timestamps() accepts no model
    argument: it obtains its model exclusively through the module-level
    get_vad_model(). So when the configured path is NOT the bundled
    file, we build a SileroVADModel from the configured path (that
    class is a thin onnxruntime wrapper around whatever file it is
    given) and substitute it as get_vad_model() for the duration of
    this one call, restoring the original loader afterwards. When the
    configured path IS the bundled file, the stock call runs untouched
    and the outcome is identical to before.
    """
    import wave

    with wave.open(wav_path, "rb") as handle:
        rate = handle.getframerate()
        channels = handle.getnchannels()
        width = handle.getsampwidth()
        raw = handle.readframes(handle.getnframes())
    if width != 2 or rate != 16000:
        raise ValueError("VAD expects a 16 kHz 16-bit WAV")
    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)

    import faster_whisper.vad as vad_module
    from faster_whisper.utils import get_assets_path
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    options = VadOptions(
        threshold=0.5,
        min_speech_duration_ms=250,
        min_silence_duration_ms=350,
        speech_pad_ms=100,
    )
    bundled_path = os.path.join(get_assets_path(), "silero_vad_v6.onnx")
    if model_path and os.path.realpath(model_path) != os.path.realpath(bundled_path):
        # Honour the configured model: load THAT ONNX file and let the
        # stock thresholding run on its probabilities. A model that
        # fails to load raises here and surfaces as vadError upstream —
        # it is never silently replaced by the bundled model.
        custom_model = vad_module.SileroVADModel(model_path)
        original_loader = vad_module.get_vad_model
        vad_module.get_vad_model = lambda: custom_model
        try:
            stamps = get_speech_timestamps(audio, options, sampling_rate=16000)
        finally:
            vad_module.get_vad_model = original_loader
    else:
        stamps = get_speech_timestamps(audio, options, sampling_rate=16000)
    return [
        {"start": round(s["start"] / 16000.0, 3), "end": round(s["end"] / 16000.0, 3)}
        for s in stamps
    ]


def main() -> int:
    if len(sys.argv) != 4:
        print("usage: track.py <video> <workdir> <options.json>", file=sys.stderr)
        return 2
    video_path, workdir, options_path = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(options_path, "r", encoding="utf-8") as fh:
        options = json.load(fh)

    interval = float(options.get("sampleInterval", 0.5))
    width = int(options.get("sampleWidth", 480))
    face_threshold = float(options.get("faceScoreThreshold", 0.6))
    person_threshold = float(options.get("personScoreThreshold", 0.35))

    face_detector = FaceDetector(options["faceModel"], face_threshold)

    person_detector = None
    person_model = options.get("personModel")
    if person_model and os.path.exists(person_model):
        try:
            person_detector = PersonDetector(person_model, person_threshold)
        except Exception as exc:  # model present but unusable: report, don't fake
            emit({"type": "warning", "message": f"person model failed to load: {exc}"})
            person_detector = None
            person_model = None
    else:
        person_model = None

    emit({"type": "progress", "stage": "DETECTING_SUBJECTS", "done": 0, "total": 0})
    frame_files = extract_frames(video_path, workdir, interval, width)

    import cv2

    frames = []
    sample_w = sample_h = 0
    total = len(frame_files)
    for idx, frame_path in enumerate(frame_files):
        img = cv2.imread(frame_path)
        if img is None:
            continue
        sample_h, sample_w = img.shape[:2]
        faces = face_detector.detect(img)
        persons = person_detector.detect(img) if person_detector else []
        frames.append({"t": round(idx * interval, 3), "faces": faces, "persons": persons})
        if idx % 4 == 0 or idx == total - 1:
            emit({"type": "progress", "stage": "TRACKING_SUBJECTS", "done": idx + 1, "total": total})

    vad_segments = None
    vad_error = None
    wav_path = options.get("vadWav")
    vad_model = options.get("vadModel")
    if wav_path and vad_model and os.path.exists(wav_path) and os.path.exists(vad_model):
        try:
            vad_segments = silero_speech_segments(wav_path, vad_model)
        except Exception as exc:
            vad_error = str(exc)[:300]

    emit(
        {
            "type": "result",
            "sampleInterval": interval,
            "sampleWidth": sample_w,
            "sampleHeight": sample_h,
            "frames": frames,
            "vadSpeech": vad_segments,
            "vadError": vad_error,
            "personModel": os.path.basename(person_model) if person_model else None,
            "faceModel": os.path.basename(options["faceModel"]),
        }
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"track.py failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
