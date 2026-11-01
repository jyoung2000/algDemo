"""Deterministic engine tests: no network, fixed `now`."""

from datetime import date

import numpy as np
import pytest

from airwave_discovery import engine as E
from airwave_discovery import genres as G
from airwave_discovery.config import DEFAULT_ENGINE, Weights, engine_with_weights, validate_weights

NOW = date(2026, 10, 26)
NOW_TS = 1_793_000_000.0


def track(key, artist, title=None, *, tags=(), prov=(), release=None, bpm=None):
    return {
        "key": key,
        "title": title or key,
        "artists": [artist],
        "tags": [G.make_tag(t, "Deezer", "album", 0.9) for t in tags],
        "provenance": [{"seed": s, "relation": r, "rank": rank} for s, r, rank in prov],
        "release": release,
        "bpm": bpm,
    }


def ctx(seeds, *, vectors=None, related=None, events=(), fresh=False, adventurous=0.5, impressions=None):
    return E.Context(
        seeds=seeds,
        vectors=vectors or {},
        related_artists=related or {},
        feedback=E.build_feedback(list(events), NOW_TS),
        impressions=impressions or {},
        settings=E.Settings(fresh=fresh, adventurous=adventurous).normalised(),
        now=NOW,
    )


# ---- missing-factor normalisation -----------------------------------------------------------
def test_missing_audio_is_not_a_negative_score():
    seed = track("s", "Seed Artist", tags=["indie rock"])
    with_audio_missing = track("a", "Other", tags=["indie rock"], prov=[("s", "related_song", 0)])
    c = ctx([seed])
    sc = E.score_one(with_audio_missing, c)
    assert sc.factors["audio"] is None
    assert "audio" not in sc.weights_used
    assert 0.0 <= sc.final <= 1.0
    assert sc.affinity > 0.5


def test_one_weak_signal_does_not_beat_rich_evidence():
    seed = track("s", "Seed", tags=["indie rock"], bpm=120)
    # only novelty is known about the sparse one
    sparse = track("sparse", "Unknown Act")
    rich = track("rich", "Rel", tags=["indie rock"], prov=[("s", "related_song", 0)], bpm=121)
    c = ctx([seed])
    a, b = E.score_one(sparse, c), E.score_one(rich, c)
    assert b.coverage > a.coverage
    assert b.final > a.final


def test_genre_and_provider_are_not_double_counted():
    seed = track("s", "Seed", tags=["indie rock"])
    both = track("x", "X", tags=["indie rock"], prov=[("s", "related_song", 0)])
    sc = E.score_one(both, ctx([seed]))
    # genre weight discounted when provider evidence is positive
    w = E.mode_weights(DEFAULT_ENGINE.weights, 1.0)
    seed_ws = {"genre": w["genre"] * (1 - DEFAULT_ENGINE.genre_provider_overlap), "provider": w["provider"]}
    expected = (seed_ws["genre"] * sc.factors["genre"] + seed_ws["provider"] * sc.factors["provider"]) / sum(seed_ws.values())
    assert sc.per_seed["s"] == pytest.approx(expected)


def test_scoring_is_deterministic():
    seeds = [track("s1", "A", tags=["pop"]), track("s2", "B", tags=["jazz"])]
    cands = [track(f"c{i}", f"Art{i % 7}", tags=["pop" if i % 2 else "jazz"], prov=[("s1" if i % 3 else "s2", "radio", i)]) for i in range(40)]
    q1 = [s.track["key"] for s in E.recommend(cands, ctx(seeds))]
    q2 = [s.track["key"] for s in E.recommend(list(reversed(cands)), ctx(seeds))]
    assert q1 == q2


# ---- multi-seed -------------------------------------------------------------------------------
def test_multi_seed_keeps_both_taste_clusters():
    seeds = [track("rock", "Rocker", tags=["rock"]), track("jazz", "Jazzer", tags=["jazz"])]
    cands = [track(f"r{i}", f"R{i}", tags=["rock"], prov=[("rock", "radio", i)]) for i in range(20)]
    cands += [track(f"j{i}", f"J{i}", tags=["jazz"], prov=[("jazz", "radio", i)]) for i in range(20)]
    q = E.recommend(cands, ctx(seeds))
    by_seed = {"rock": 0, "jazz": 0}
    for s in q:
        by_seed[s.best_seed] += 1
    assert by_seed["rock"] >= 10 and by_seed["jazz"] >= 10


def test_best_seed_blend_beats_plain_average():
    seeds = [track("rock", "Rocker", tags=["rock"]), track("jazz", "Jazzer", tags=["jazz"])]
    c = track("x", "X", tags=["rock"], prov=[("rock", "related_song", 0)])
    sc = E.score_one(c, ctx(seeds))
    plain_mean = sum(sc.per_seed.values()) / len(sc.per_seed)
    assert sc.best_seed == "rock"
    assert sc.affinity > plain_mean * 0.9  # the blend leans on the best seed
    blend = 0.7 * sc.per_seed["rock"] + 0.3 * plain_mean
    assert blend > plain_mean


def test_seed_emphasis_shifts_queue_share():
    a = track("a", "A", tags=["rock"])
    b = track("b", "B", tags=["jazz"])
    cands = [track(f"r{i}", f"R{i}", tags=["rock"], prov=[("a", "radio", i)]) for i in range(30)]
    cands += [track(f"j{i}", f"J{i}", tags=["jazz"], prov=[("b", "radio", i)]) for i in range(30)]
    even = E.recommend(cands, ctx([a, b]))
    a2 = dict(a, emphasis=2.0)
    leaning = E.recommend(cands, ctx([a2, b]))
    count = lambda q: sum(1 for s in q if s.best_seed == "a")  # noqa: E731
    assert count(leaning) > count(even)


# ---- selection and diversity ------------------------------------------------------------------
def test_max_two_per_artist_and_no_resort():
    seed = track("s", "Seed", tags=["pop"])
    cands = [track(f"c{i}", f"Artist{i % 5}", tags=["pop"], prov=[("s", "radio", i)]) for i in range(40)]
    q = E.recommend(cands, ctx([seed]))
    per = {}
    for s in q:
        per[E.primary_artist(s.track)] = per.get(E.primary_artist(s.track), 0) + 1
    assert max(per.values()) <= 2
    assert len(q) == 10  # 5 artists x 2: never padded up to 30


def test_selection_spreads_audio_lookalikes():
    seed = track("s", "Seed")
    rng = np.random.default_rng(1)
    base = rng.normal(size=8)
    base /= np.linalg.norm(base)
    other = rng.normal(size=8)
    other -= other.dot(base) * base
    other /= np.linalg.norm(other)
    vectors = {"s": base}
    cands = []
    for i in range(6):
        k = f"same{i}"
        vectors[k] = base
        cands.append(track(k, f"S{i}", prov=[("s", "radio", 0)]))
    k = "diff"
    vectors[k] = 0.8 * base + 0.6 * other
    cands.append(track(k, "D", prov=[("s", "radio", 0)]))
    q = [s.track["key"] for s in E.recommend(cands, ctx([seed], vectors=vectors))]
    # the different-sounding one is not pushed to the very end by its lower raw score
    assert q.index("diff") < len(q) - 1


def test_seeds_disliked_and_hidden_are_excluded():
    seed = track("s", "Seed", tags=["pop"])
    cands = [track(k, k.upper(), tags=["pop"], prov=[("s", "radio", 0)]) for k in ("s", "bad", "hid", "ok")]
    events = [
        {"event_id": "1", "key": "bad", "kind": "dislike", "artist": "BAD", "ts": NOW_TS - 10},
        {"event_id": "2", "key": "hid", "kind": "hide", "artist": "HID", "ts": NOW_TS - 10},
    ]
    q = [s.track["key"] for s in E.recommend(cands, ctx([seed], events=events))]
    assert q == ["ok"]


def test_adventurous_moves_tier_shares():
    safe, bold = E.tier_shares(0.0), E.tier_shares(1.0)
    mid = E.tier_shares(0.5)
    assert mid == pytest.approx({"strong": 0.4, "related": 0.3, "emerging": 0.2, "experimental": 0.1})
    assert safe["strong"] > mid["strong"] > bold["strong"]
    assert safe["experimental"] < bold["experimental"]
    for s in (safe, mid, bold):
        assert sum(s.values()) == pytest.approx(1.0)


def test_exposure_penalty_is_bounded():
    seed = track("s", "Seed", tags=["pop"])
    c = track("c", "C", tags=["pop"], prov=[("s", "radio", 0)])
    sc = E.score_one(c, ctx([seed], impressions={"c": 50}))
    assert sc.exposure_penalty == pytest.approx(DEFAULT_ENGINE.exposure_penalty_max)


# ---- feedback ---------------------------------------------------------------------------------
def test_feedback_events_deduplicated_and_decayed():
    ev = {"event_id": "e1", "key": "k", "kind": "like", "artist": "A", "ts": NOW_TS}
    once = E.build_feedback([ev], NOW_TS)
    twice = E.build_feedback([ev, dict(ev)], NOW_TS)
    assert once.track == twice.track and twice.events == 1
    old = E.build_feedback([dict(ev, ts=NOW_TS - 45 * 86400)], NOW_TS)
    assert old.track["k"] == pytest.approx(once.track["k"] / 2)


def test_seed_selection_is_never_history():
    fb = E.build_feedback([{"event_id": "s", "key": "k", "kind": "seed", "artist": "A", "ts": NOW_TS}], NOW_TS)
    assert fb.events == 0 and not fb.track


def test_one_skip_does_not_penalise_artist_but_three_do():
    skips = [{"event_id": f"x{i}", "key": f"t{i}", "kind": "skip", "artist": "A", "ts": NOW_TS} for i in range(3)]
    assert "A" not in E.build_feedback(skips[:1], NOW_TS).artist
    assert "A" not in E.build_feedback(skips[:2], NOW_TS).artist
    # the same track skipped three times is still one track
    same = [dict(skips[0], event_id=f"y{i}") for i in range(3)]
    assert "A" not in E.build_feedback(same, NOW_TS).artist
    assert E.build_feedback(skips, NOW_TS).artist["A"] < 0


def test_like_reranks_artist_up():
    seed = track("s", "Seed", tags=["pop"])
    a, b = track("a", "Liked Act", tags=["pop"], prov=[("s", "radio", 5)]), track("b", "Other", tags=["pop"], prov=[("s", "radio", 5)])
    events = [{"event_id": "l", "key": "earlier", "kind": "like", "artist": "liked act", "ts": NOW_TS}]
    before = E.score_one(a, ctx([seed])).final
    after = E.score_one(a, ctx([seed], events=events)).final
    assert after > before
    assert E.score_one(b, ctx([seed], events=events)).factors["feedback"] is None


# ---- dates ------------------------------------------------------------------------------------
def test_date_precision_rules():
    day = {"date": "2026-10-01", "precision": "day", "kind": "release", "source": "Deezer"}
    month = {"date": "2026-10", "precision": "month", "kind": "release", "source": "Deezer"}
    year = {"date": "2026", "precision": "year", "kind": "release", "source": "YouTube Music"}
    upload = dict(day, kind="upload")
    assert E.is_new_release(day, NOW, 60)
    assert not E.is_new_release(month, NOW, 60)
    assert not E.is_new_release(year, NOW, 60)
    assert not E.is_new_release(upload, NOW, 60)
    assert E.freshness(year, NOW) is None
    assert E.freshness(upload, NOW) == pytest.approx(E.freshness(day, NOW) / 2)
    old = dict(day, date="2026-06-01")
    assert not E.is_new_release(old, NOW, 60)


def test_year_only_date_is_flagged_as_uncertain():
    seed = track("s", "Seed")
    c = track("c", "C", prov=[("s", "radio", 0)], release={"date": "2026", "precision": "year", "kind": "release", "source": "YouTube Music"})
    q = E.recommend([c], ctx([seed]))
    assert any("year" in u for u in q[0].uncertainty)


# ---- explanations -----------------------------------------------------------------------------
def test_reasons_lead_with_evidence_and_never_claim_audio_without_vectors():
    seed = track("s", "Seed", title="Seed Song", tags=["indie rock"])
    c = track("c", "Brand New", tags=["indie rock"], prov=[("s", "related_song", 0)])
    sc = E.recommend([c], ctx([seed], adventurous=1.0))[0]  # the old "discover" default: the novelty reason shows at the adventurous end
    factors = [r["factor"] for r in sc.reasons]
    assert factors[0] == "provider"
    assert "audio" not in factors
    assert factors[-1] == "novelty"
    assert "“Seed Song”" in sc.reasons[0]["text"]
    assert any("No audio comparison" in u for u in sc.uncertainty)


def test_audio_reason_only_with_real_vectors():
    v = np.ones(4) / 2.0
    seed = track("s", "Seed")
    c = track("c", "C", prov=[("s", "radio", 0)])
    sc = E.recommend([c], ctx([seed], vectors={"s": v, "c": v}))[0]
    assert sc.factors["audio"] == pytest.approx(1.0)
    assert any(r["factor"] == "audio" for r in sc.reasons)


# ---- weights ----------------------------------------------------------------------------------
def test_weight_validation():
    with pytest.raises(ValueError):
        validate_weights(Weights(audio=-0.1))
    with pytest.raises(ValueError):
        validate_weights(Weights(audio=1.5))
    with pytest.raises(ValueError):
        validate_weights(Weights(*([0.0] * 8)))
    cfg = engine_with_weights({"audio": 0.5, "typo_factor": 9})
    assert cfg.weights.audio == 0.5
    assert sum(DEFAULT_ENGINE.weights.as_dict().values()) == pytest.approx(1.0)
