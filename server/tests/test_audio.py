import io
from pathlib import Path

import numpy as np
import pytest

from airwave_discovery import audio as A


def test_slaney_filterbank_shape_and_area():
    fb = A.mel_filterbank()
    assert fb.shape == (A.N_MELS, A.N_FFT // 2 + 1)
    assert (fb >= 0).all()
    # Slaney normalisation: every filter has unit area in Hz (weights are per-bin densities)
    df = A.SR / A.N_FFT
    areas = fb.sum(axis=1) * df
    # narrow low bands span only a few FFT bins, so their discrete area wobbles around 1
    assert 0.9 < areas.min() and areas.max() < 1.12
    assert abs(np.median(areas) - 1.0) < 0.02
    # nothing above fmax
    top_bin = int(np.ceil(A.FMAX / df)) + 1
    assert fb[:, top_bin + 1 :].sum() == 0


def test_mel_of_a_tone_peaks_at_the_right_band():
    t = np.arange(A.SEGMENT) / A.SR
    y = (0.5 * np.sin(2 * np.pi * 1000 * t)).astype(np.float32)
    m = A.log_mel(y)
    assert m.shape == (A.N_MELS, 1 + A.SEGMENT // A.HOP_MELS)
    band = int(np.argmax(m.mean(axis=1)))
    centres = A._mel_to_hz(np.linspace(A._hz_to_mel(0.0), A._hz_to_mel(A.FMAX), A.N_MELS + 2))[1:-1]
    assert abs(centres[band] - 1000) < 60


def test_segments_cover_audio():
    assert len(A.segments_of(np.zeros(100, dtype=np.float32))) == 1
    y = np.zeros(int(A.SR * 30), dtype=np.float32)
    segs = A.segments_of(y)
    assert all(len(s) == A.SEGMENT for s in segs)
    assert len(segs) == 5  # 0,5,10,15,20 s starts for 10 s windows over 30 s; no repeated tail
    assert len(A.segments_of(np.zeros(int(A.SR * 32), dtype=np.float32))) == 6  # tail window added once


def test_strip_id3v2_handles_empty_tag():
    tag = b"ID3\x04\x00\x00\x00\x00\x00\x00"
    assert A.strip_id3v2(tag + b"\xff\xfbDATA") == b"\xff\xfbDATA"
    assert A.strip_id3v2(b"\xff\xfbDATA") == b"\xff\xfbDATA"


def test_trim_silence_drops_quiet_intro():
    y = np.concatenate([np.zeros(A.SR * 3), 0.3 * np.ones(A.SR * 2)]).astype(np.float32)
    out = A.trim_silence(y)
    assert len(out) <= A.SR * 2 + 4800


def test_decode_wav_resamples_to_48k():
    sf = pytest.importorskip("soundfile")
    buf = io.BytesIO()
    sf.write(buf, (0.2 * np.sin(np.linspace(0, 2000, 44_100))).astype(np.float32), 44_100, format="WAV")
    y = A.decode(buf.getvalue())
    assert abs(len(y) - 48_000) <= 2


# conftest points the data dir at a temp folder, so look for the demo's own installed model.
REAL_MODELS = Path(A.__file__).resolve().parents[2] / ".data" / "models"


@pytest.mark.skipif(not A.Encoder(REAL_MODELS).installed(), reason="DCLAP model not installed")
def test_encoder_is_deterministic_and_discriminates():
    enc = A.Encoder(REAL_MODELS)
    t = np.arange(A.SR * 12) / A.SR
    tone = (0.3 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
    noise = np.random.default_rng(0).normal(0, 0.2, len(t)).astype(np.float32)
    a1, a2, b = enc.embed_audio(tone), enc.embed_audio(tone), enc.embed_audio(noise)
    assert a1.vector.shape == (A.DIM,)
    assert A.cosine(a1.vector, a2.vector) > 0.9999
    assert A.cosine(a1.vector, b.vector) < 0.95
    assert a1.infer_ms > 0
