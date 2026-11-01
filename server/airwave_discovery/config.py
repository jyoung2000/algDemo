"""Paths, budgets and the recommender's starting configuration.

Every value here is a default the settings screen or an environment variable can change. The
budgets are enforced in `budget.py`; the weights are validated in `validate_weights` so a typo in
a settings file cannot silently turn a factor negative.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field, replace
from pathlib import Path

DEMO_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = Path(os.environ.get("AIRWAVE_DISCOVERY_DATA", DEMO_ROOT / ".data"))
MODELS_DIR = DATA_DIR / "models"
LOG_DIR = DATA_DIR / "logs"
DB_PATH = DATA_DIR / "airwave-discovery.db"
WEB_DIST = DEMO_ROOT / "web" / "dist"
VENV_DIR = DEMO_ROOT / "server" / ".venv"

HOST = os.environ.get("AIRWAVE_DISCOVERY_HOST", "127.0.0.1")
PORT = int(os.environ.get("AIRWAVE_DISCOVERY_PORT", "8787"))

MB = 1_000_000
GB = 1_000_000_000


@dataclass(frozen=True)
class StorageBudget:
    """Hard application footprint and the per-area ceilings inside it (bytes, decimal)."""

    hard_cap: int = 5 * GB
    target: int = int(4.5 * GB)
    runtime: int = int(1.2 * GB)
    models: int = int(0.8 * GB)
    database: int = 1 * GB
    artwork: int = int(0.25 * GB)
    temp_audio: int = int(0.25 * GB)
    logs: int = int(0.1 * GB)
    # Free disk that must remain after any write we start, so a full disk cannot corrupt SQLite.
    free_disk_floor: int = 512 * MB


@dataclass(frozen=True)
class TransferBudget:
    """Backend network allowance. Embedded-player streaming happens in the browser and is outside it."""

    daily: int = 100 * MB
    per_request: int = 20 * MB
    # One preview clip is ~0.48 MB at 128 kb/s; anything far larger is not a 30-second preview.
    per_audio_file: int = int(1.5 * MB)


@dataclass(frozen=True)
class Weights:
    audio: float = 0.35
    genre: float = 0.15
    artist: float = 0.15
    provider: float = 0.10
    feedback: float = 0.10
    tempo: float = 0.05
    freshness: float = 0.05
    novelty: float = 0.05

    def as_dict(self) -> dict[str, float]:
        return {k: getattr(self, k) for k in FACTORS}


FACTORS = ("audio", "genre", "artist", "provider", "feedback", "tempo", "freshness", "novelty")
# Factors that say something about how well a candidate fits the seeds. Freshness and novelty are
# properties of the candidate alone, so they do not raise the evidence coverage of a match.
AFFINITY_FACTORS = ("audio", "genre", "artist", "provider", "feedback", "tempo")


@dataclass(frozen=True)
class TierShares:
    strong: float = 0.40
    related: float = 0.30
    emerging: float = 0.20
    experimental: float = 0.10


@dataclass(frozen=True)
class EngineConfig:
    weights: Weights = field(default_factory=Weights)
    tiers: TierShares = field(default_factory=TierShares)
    # Multi-seed blend: best single-seed affinity vs the emphasis-weighted mean over seeds.
    best_seed_share: float = 0.70
    # final = affinity * (coverage_floor + (1 - coverage_floor) * coverage). See ARCHITECTURE.md.
    coverage_floor: float = 0.55
    # When genre and provider evidence both exist they overlap (providers relate tracks partly by
    # genre); the genre weight is discounted by this fraction so they are not two proofs of one fact.
    genre_provider_overlap: float = 0.5
    max_per_artist: int = 2
    queue_size: int = 30
    per_source_cap: int = 40
    merged_cap: int = 200
    audio_candidates_per_request: int = 20
    new_release_days: int = 60
    feedback_half_life_days: float = 45.0
    exposure_penalty: float = 0.04
    exposure_penalty_max: float = 0.16
    exposure_window_days: float = 7.0
    artist_skip_threshold: int = 3


DEFAULT_ENGINE = EngineConfig()
STORAGE = StorageBudget()
TRANSFER = TransferBudget()

FEEDBACK_WEIGHTS = {
    "seed": 6.0,  # session only — never written as history
    "like": 6.0,
    "save": 5.0,
    "replay": 4.0,
    "complete": 3.0,
    "qualified": 1.5,  # imported play: submitted listen is not proof of completion
    "dislike": -6.0,
    "hide": -3.0,
    "skip": -1.0,
}


def validate_weights(w: Weights) -> Weights:
    values = w.as_dict()
    for k, v in values.items():
        if not (0.0 <= v <= 1.0):
            raise ValueError(f"weight {k} must be within 0..1, got {v}")
    total = sum(values.values())
    if total <= 0:
        raise ValueError("at least one weight must be positive")
    return w


def engine_with_weights(overrides: dict[str, float] | None) -> EngineConfig:
    if not overrides:
        return DEFAULT_ENGINE
    w = replace(DEFAULT_ENGINE.weights, **{k: float(v) for k, v in overrides.items() if k in FACTORS})
    return replace(DEFAULT_ENGINE, weights=validate_weights(w))
