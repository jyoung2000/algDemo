"""Audio embeddings with AudioMuse-AI DCLAP (distilled LAION-CLAP audio tower, 512-d, ONNX).

Preprocessing follows the model's README exactly: 48 kHz mono, int16 round-trip, 10 s segments
with 50 % overlap, 128-band Slaney mel (n_fft 2048, hop 480, fmin 0, fmax 14 kHz, power 2),
`power_to_db(ref=1, amin=1e-10, top_db=None)`, one segment per run, mean of segment embeddings,
L2-normalised. The mel filterbank below reimplements librosa's defaults (Slaney scale and norm)
in numpy so the runtime does not need librosa/numba; `tests/test_mel_parity.py` checks it
against librosa when librosa is importable.

Vectors are stored with MODEL_ID and PREPROCESS_ID; vectors from any other model or
preprocessing are never compared with these.
"""

from __future__ import annotations

import io
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .config import MODELS_DIR

MODEL_ID = "audiomuse-dclap-v1-epoch36"
PREPROCESS_ID = "sr48k-int16-seg10s-hop5s-tail1-mel128-nfft2048-hop480-f0-14k-db"
DIM = 512
SR = 48_000
SEGMENT = 480_000
HOP = 240_000
N_MELS = 128
N_FFT = 2048
HOP_MELS = 480
FMAX = 14_000.0

MODEL_FILES = {
    "model_epoch_36.onnx": ("17860403f8fc90aff8ac0632a0741eb5e58d8c0b0ad2fce5ced967274b0ea971", 1_243_778),
    "model_epoch_36.onnx.data": ("2a735b23c2aad7b12d9ffc85334cebcc659c07696d2ff60e2e378da28b6df657", 21_168_128),
}
MODEL_URL = "https://github.com/NeptuneHub/AudioMuse-AI-DCLAP/releases/download/v1/"
MODEL_DOWNLOAD_BYTES = sum(size for _, size in MODEL_FILES.values())


def _hz_to_mel(f: np.ndarray) -> np.ndarray:
    f = np.asarray(f, dtype=np.float64)
    f_sp = 200.0 / 3
    mels = f / f_sp
    min_log_hz = 1000.0
    min_log_mel = min_log_hz / f_sp
    logstep = np.log(6.4) / 27.0
    return np.where(f >= min_log_hz, min_log_mel + np.log(np.maximum(f, 1e-10) / min_log_hz) / logstep, mels)


def _mel_to_hz(m: np.ndarray) -> np.ndarray:
    m = np.asarray(m, dtype=np.float64)
    f_sp = 200.0 / 3
    freqs = f_sp * m
    min_log_hz = 1000.0
    min_log_mel = min_log_hz / f_sp
    logstep = np.log(6.4) / 27.0
    return np.where(m >= min_log_mel, min_log_hz * np.exp(logstep * (m - min_log_mel)), freqs)


def mel_filterbank(sr: int = SR, n_fft: int = N_FFT, n_mels: int = N_MELS, fmin: float = 0.0, fmax: float = FMAX) -> np.ndarray:
    """librosa.filters.mel(sr, n_fft, n_mels, fmin, fmax, htk=False, norm='slaney')."""
    fftfreqs = np.fft.rfftfreq(n=n_fft, d=1.0 / sr)
    mel_f = _mel_to_hz(np.linspace(_hz_to_mel(fmin), _hz_to_mel(fmax), n_mels + 2))
    fdiff = np.diff(mel_f)
    ramps = np.subtract.outer(mel_f, fftfreqs)
    weights = np.zeros((n_mels, 1 + n_fft // 2), dtype=np.float64)
    for i in range(n_mels):
        lower = -ramps[i] / fdiff[i]
        upper = ramps[i + 2] / fdiff[i + 1]
        weights[i] = np.maximum(0, np.minimum(lower, upper))
    enorm = 2.0 / (mel_f[2 : n_mels + 2] - mel_f[:n_mels])
    weights *= enorm[:, np.newaxis]
    return weights.astype(np.float32)


_MEL = mel_filterbank()
_WINDOW = (0.5 - 0.5 * np.cos(2 * np.pi * np.arange(N_FFT) / N_FFT)).astype(np.float32)  # periodic hann


def log_mel(segment: np.ndarray) -> np.ndarray:
    """(n_mels, frames) log-power mel for one 10 s segment, center=True, reflect padding."""
    pad = N_FFT // 2
    y = np.pad(segment.astype(np.float32), (pad, pad), mode="reflect")
    n_frames = 1 + (len(y) - N_FFT) // HOP_MELS
    idx = np.arange(N_FFT)[None, :] + HOP_MELS * np.arange(n_frames)[:, None]
    frames = y[idx] * _WINDOW
    spec = np.abs(np.fft.rfft(frames, n=N_FFT, axis=1)) ** 2  # (frames, bins)
    mel = _MEL @ spec.T.astype(np.float32)
    return (10.0 * np.log10(np.maximum(1e-10, mel))).astype(np.float32)


def segments_of(y: np.ndarray) -> list[np.ndarray]:
    total = len(y)
    if total <= SEGMENT:
        return [np.pad(y, (0, SEGMENT - total))]
    starts = list(range(0, total - SEGMENT + 1, HOP))
    segs = [y[s : s + SEGMENT] for s in starts]
    if starts[-1] + SEGMENT < total:  # cover the tail once, without repeating the last window
        segs.append(y[-SEGMENT:])
    return segs


def strip_id3v2(data: bytes) -> bytes:
    """Remove leading ID3v2 tags. libsndfile rejects some (e.g. a zero-length tag) as unknown format."""
    while len(data) >= 10 and data[:3] == b"ID3":
        size = (data[6] << 21) | (data[7] << 14) | (data[8] << 7) | data[9]
        footer = 10 if data[5] & 0x10 else 0
        data = data[10 + size + footer :]
    return data


def decode(data: bytes) -> np.ndarray:
    """Decode an MP3/other container to 48 kHz mono float32 (libsndfile + soxr HQ, as librosa.load)."""
    import soundfile as sf
    import soxr

    y, sr = sf.read(io.BytesIO(strip_id3v2(data)), dtype="float32", always_2d=True)
    y = y.mean(axis=1)
    if sr != SR:
        y = soxr.resample(y, sr, SR, quality="HQ")
    y = np.clip(y, -1.0, 1.0)
    return ((y * 32767.0).astype(np.int16) / 32767.0).astype(np.float32)


def trim_silence(y: np.ndarray, threshold_db: float = -45.0, frame: int = 4800) -> np.ndarray:
    """Drop leading/trailing near-silence so a quiet intro does not dominate a short excerpt."""
    if len(y) < frame * 4:
        return y
    n = len(y) // frame
    rms = np.sqrt(np.mean(y[: n * frame].reshape(n, frame) ** 2, axis=1) + 1e-12)
    db = 20 * np.log10(rms + 1e-12)
    loud = np.where(db > threshold_db)[0]
    if len(loud) == 0:
        return y[:0]
    return y[loud[0] * frame : (loud[-1] + 1) * frame]


@dataclass
class EmbedResult:
    vector: np.ndarray
    segments: int
    seconds: float
    infer_ms: float


class Encoder:
    """One ONNX session, one worker: calls are serialised by a lock."""

    def __init__(self, model_dir: Path = MODELS_DIR) -> None:
        self.model_dir = model_dir
        self._session = None
        self._lock = threading.Lock()
        self.error: str | None = None

    def installed(self) -> bool:
        return all((self.model_dir / name).exists() and (self.model_dir / name).stat().st_size == size for name, (_, size) in MODEL_FILES.items())

    def _load(self):
        if self._session is None:
            import onnxruntime as ort

            opts = ort.SessionOptions()
            opts.intra_op_num_threads = 2
            opts.inter_op_num_threads = 1
            self._session = ort.InferenceSession(str(self.model_dir / "model_epoch_36.onnx"), sess_options=opts, providers=["CPUExecutionProvider"])
        return self._session

    def embed_audio(self, y: np.ndarray) -> EmbedResult:
        with self._lock:
            sess = self._load()
            t = time.perf_counter()
            embs = []
            segs = segments_of(y)
            for seg in segs:
                mel = log_mel(seg)[np.newaxis, np.newaxis, :, :]
                out = sess.run(None, {"mel_spectrogram": mel})[0]
                embs.append(out[0])
            v = np.mean(embs, axis=0).astype(np.float32)
            v /= np.linalg.norm(v) + 1e-9
            return EmbedResult(vector=v, segments=len(segs), seconds=len(y) / SR, infer_ms=(time.perf_counter() - t) * 1000)


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.dot(a, b) / ((np.linalg.norm(a) * np.linalg.norm(b)) + 1e-9))
