"""Generate the engine golden fixture: a deterministic input set and the ranked output the Python
engine produces for it. The TypeScript engine is tested against the same output (web/src/engine/golden/engine.json).

Run from server/:  .venv/Scripts/python.exe tools/golden_engine.py
"""

import json
import sys
from datetime import date
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from airwave_discovery import engine as E  # noqa: E402
from airwave_discovery import genres as G  # noqa: E402

OUT = Path(__file__).resolve().parents[2] / "web" / "src" / "engine" / "golden" / "engine.json"
NOW = date(2026, 10, 26)
NOW_TS = 1_793_000_000.0
GENRES = ["indie rock", "pop", "jazz", "hip hop", "electronic", "rock", "soul", "lo-fi"]
ARTISTS = [f"Artist {i}" for i in range(14)]
RELS = ["related_song", "radio", "sc_recommended", "artist_radio", "related_artist_top", "recent", "genre_chart"]


def make_tracks(rng: np.random.Generator, n: int, prefix: str, seeds: list[str]) -> list[dict]:
    out = []
    for i in range(n):
        tags = [G.make_tag(GENRES[int(rng.integers(len(GENRES)))], "Deezer", "album", float(rng.uniform(0.4, 1.0)))]
        prov = []
        for s in seeds:
            if rng.uniform() < 0.5:
                prov.append({"seed": s, "relation": RELS[int(rng.integers(len(RELS)))], "rank": int(rng.integers(0, 12))})
        rel = None
        if rng.uniform() < 0.4:
            day = int(rng.integers(1, 27))
            rel = {"date": f"2026-10-{day:02d}", "precision": "day", "kind": "release", "source": "Deezer"}
        out.append({
            "key": f"{prefix}{i}",
            "title": f"{prefix} song {i}",
            "artists": [ARTISTS[int(rng.integers(len(ARTISTS)))]],
            "tags": [t for t in tags if t],
            "provenance": prov,
            "release": rel,
            "bpm": float(rng.uniform(80, 160)) if rng.uniform() < 0.7 else None,
        })
    return out


def main() -> None:
    rng = np.random.default_rng(20261026)
    seeds = [
        {"key": "seedA", "title": "Seed A", "artists": ["Artist 0"], "tags": [G.make_tag("indie rock", "Deezer", "album", 0.9)], "bpm": 120.0, "emphasis": 1.0},
        {"key": "seedB", "title": "Seed B", "artists": ["Artist 3"], "tags": [G.make_tag("jazz", "Deezer", "album", 0.9)], "bpm": 96.0, "emphasis": 1.5},
    ]
    seed_keys = [s["key"] for s in seeds]
    cands = make_tracks(rng, 60, "c", seed_keys)
    # a few with known audio vectors and a few seeds' own vectors
    vectors = {}
    dim = 8
    for k in ["seedA", "seedB"] + [c["key"] for c in cands[:12]]:
        v = rng.normal(size=dim)
        vectors[k] = (v / np.linalg.norm(v)).astype(np.float64)
    events = [
        {"event_id": "e1", "key": "c3", "kind": "like", "artist": cands[3]["artists"][0].lower(), "ts": NOW_TS - 86400},
        {"event_id": "e2", "key": "c7", "kind": "dislike", "artist": cands[7]["artists"][0].lower(), "ts": NOW_TS - 3600},
        {"event_id": "e3", "key": "c9", "kind": "hide", "artist": cands[9]["artists"][0].lower(), "ts": NOW_TS - 7200},
        {"event_id": "e4", "key": "c11", "kind": "skip", "artist": "artist 1", "ts": NOW_TS - 100},
    ]
    related = {"seedA": {"artist 1", "artist 2", "artist 5"}, "seedB": {"artist 6", "artist 8"}}
    impressions = {"c1": 2, "c5": 9}

    results = {}
    for label, adv, fresh in [("neutral", 0.5, False), ("familiar", 0.0, False), ("adventurous", 1.0, True)]:
        ctx = E.Context(
            seeds=seeds,
            vectors=vectors,
            related_artists=related,
            feedback=E.build_feedback(events, NOW_TS),
            impressions=impressions,
            settings=E.Settings(adventurous=adv, fresh=fresh).normalised(),
            now=NOW,
        )
        q = E.recommend(cands, ctx)
        results[label] = [
            {
                "key": s.track["key"],
                "final": round(s.final, 12),
                "affinity": round(s.affinity, 12),
                "coverage": round(s.coverage, 12),
                "tier": s.tier,
                "best_seed": s.best_seed,
                "exposure_penalty": round(s.exposure_penalty, 12),
                "new_release": s.new_release,
            }
            for s in q
        ]
    fixture = {
        "generator": "server/tools/golden_engine.py",
        "now": NOW.isoformat(),
        "now_ts": NOW_TS,
        "seeds": seeds,
        "candidates": cands,
        "vectors": {k: [round(float(x), 15) for x in v] for k, v in vectors.items()},
        "events": events,
        "related_artists": {k: sorted(v) for k, v in related.items()},
        "impressions": impressions,
        "expected": results,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(fixture, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes); queue sizes: " + ", ".join(f"{k}={len(v)}" for k, v in results.items()))


if __name__ == "__main__":
    main()
