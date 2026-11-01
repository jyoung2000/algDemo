"""Golden fixtures for the TypeScript audio front end (web/src/engine/audio.ts).

Dumps, from the Python implementation, the mel filterbank, log-mel of a deterministic signal, segmenting,
silence trimming, ID3 stripping, the int16 round trip, and (when the model is installed) the ONNX embedding
of that signal. The TS tests assert equality within float tolerance.

  cd discovery-demo/server && PYTHONPATH= uv run --frozen python tools/golden_audio.py
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from airwave_discovery import audio as A

OUT = Path(__file__).resolve().parents[2] / "web" / "src" / "engine" / "golden"


def signal(seconds: float, seed: int) -> np.ndarray:
    """A deterministic 48 kHz mono signal: three tones with a slow envelope plus a little noise."""
    n = int(seconds * A.SR)
    t = np.arange(n) / A.SR
    y = 0.4 * np.sin(2 * np.pi * 220 * t) + 0.25 * np.sin(2 * np.pi * 1330 * t) + 0.1 * np.sin(2 * np.pi * 6100 * t)
    y *= 0.6 + 0.4 * np.sin(2 * np.pi * 0.7 * t)
    # a cheap deterministic "noise" (an integer hash) that the TypeScript tests reproduce exactly
    i = np.arange(n, dtype=np.uint64)
    h = ((i + np.uint64(seed) * np.uint64(7919)) * np.uint64(2654435761)) & np.uint64(0xFFFFFFFF)
    y += 0.02 * ((h.astype(np.float64) / 4294967296.0) * 2 - 1)
    return np.clip(y, -1, 1).astype(np.float32)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    out: dict = {}

    fb = A.mel_filterbank()
    out["filterbank"] = {"shape": list(fb.shape), "rows": {str(i): fb[i].tolist() for i in (0, 1, 17, 63, 100, 127)}, "sum": float(fb.sum())}

    seg = signal(10, 1)
    lm = A.log_mel(seg)
    out["log_mel"] = {"shape": list(lm.shape), "head": lm[:, :3].tolist(), "mid": lm[:, 500:502].tolist(), "mean": float(lm.mean()), "std": float(lm.std())}
    out["log_mel_signal"] = {"seconds": 10, "seed": 1}

    # int16 round trip and trim_silence on a signal with silent edges
    y = np.concatenate([np.zeros(48_000, np.float32), signal(3, 2), np.zeros(96_000, np.float32)])
    rt = (np.clip(y, -1, 1) * 32767.0).astype(np.int16) / 32767.0
    out["int16"] = {"in_head": y[48_000:48_010].tolist(), "out_head": rt.astype(np.float32)[48_000:48_010].tolist()}
    tr = A.trim_silence(rt.astype(np.float32))
    out["trim"] = {"in_len": int(len(y)), "out_len": int(len(tr)), "head": tr[:5].tolist()}

    # segmenting at the boundaries that matter
    segs = {}
    for total in (100_000, 480_000, 480_001, 720_000, 1_000_000, 1_440_000):
        parts = A.segments_of(np.arange(total, dtype=np.float32))
        segs[str(total)] = [[float(p[0]), len(p)] for p in parts]
    out["segments"] = segs

    out["id3"] = {
        "input_hex": (b"ID3\x04\x00\x00\x00\x00\x00\x05" + b"abcde" + b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\xff\xfb\x90\x00").hex(),
        "output_hex": A.strip_id3v2(b"ID3\x04\x00\x00\x00\x00\x00\x05" + b"abcde" + b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\xff\xfb\x90\x00").hex(),
    }

    enc = A.Encoder()
    if enc.installed():
        r = enc.embed_audio(signal(25, 3))
        out["embedding"] = {"signal": {"seconds": 25, "seed": 3}, "segments": r.segments, "dim": int(len(r.vector)), "vector": r.vector.tolist()}
    else:
        out["embedding"] = None

    (OUT / "audio.json").write_text(json.dumps(out), encoding="utf-8")
    print("wrote", OUT / "audio.json", "embedding:", out["embedding"] is not None)


if __name__ == "__main__":
    main()
