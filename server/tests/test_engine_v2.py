"""Ranking v2 (rank_v2=True): Python mirror of web/src/engine/engine-v2.test.ts invariants.

The two implementations must agree on v2 semantics the same way the golden fixture pins v1.
"""

from datetime import date

from airwave_discovery import engine as E
from airwave_discovery import genres as G
from airwave_discovery.config import DEFAULT_ENGINE

NOW = date(2026, 10, 26)
NOW_TS = 1_793_000_000.0


def track(key, artist, *, tags=(), prov=(), bpm=None, inferred_tags=()):
    t = {
        "key": key,
        "title": key,
        "artists": [artist],
        "tags": [G.make_tag(x, "Deezer", "album", 0.9) for x in tags],
        "provenance": list(prov),
        "release": None,
        "bpm": bpm,
    }
    for name, source in inferred_tags:
        tag = G.make_tag(name, source, "artist", 0.3)
        tag["inferred"] = True
        t["tags"].append(tag)
    return t


def ctx(seeds, *, vectors=None, related=None, events=(), v2=True):
    build = E.build_feedback2 if v2 else E.build_feedback
    return E.Context(
        seeds=seeds,
        vectors=vectors or {},
        related_artists=related or {},
        feedback=build(list(events), NOW_TS),
        impressions={},
        settings=E.Settings().normalised(),
        now=NOW,
        rank_v2=v2,
    )


def ev(kind, key, event_id, *, ts=NOW_TS - 3600, artist=None, **extra):
    return {"event_id": event_id, "key": key, "kind": kind, "artist": artist or key.split("|")[0], "ts": ts, **extra}


SEED = track("seed|song", "seedartist", tags=("rock",))


def test_catalogue_only_provenance_stays_null_in_v2():
    c = track("x|hit", "x", prov=[{"seed": SEED["key"], "relation": "search_match", "rank": 0, "source": "apple-search"}])
    f1 = E.seed_factors(c, SEED, ctx([SEED], v2=False))
    f2 = E.seed_factors(c, SEED, ctx([SEED], v2=True))
    assert f1["provider"] == 0.0
    assert f2["provider"] is None


def test_independent_families_corroborate_duplicates_do_not():
    base = {"seed": SEED["key"], "relation": "related_song", "rank": 0, "source": "ytmusic-related"}
    one = track("x|a", "x", prov=[base])
    dup = track("x|b", "x", prov=[base, {"seed": SEED["key"], "relation": "radio", "rank": 0, "source": "ytmusic-radio"}])
    three = track("x|c", "x", prov=[
        base,
        {"seed": SEED["key"], "relation": "sc_recommended", "rank": 0, "source": "soundcloud-recommended"},
        {"seed": SEED["key"], "relation": "artist_radio", "rank": 0, "source": "deezer-artist-radio"},
    ])
    c = ctx([SEED], v2=True)
    p1 = E.seed_factors(one, SEED, c)["provider"]
    assert E.seed_factors(dup, SEED, c)["provider"] == p1
    assert abs(E.seed_factors(three, SEED, c)["provider"] - min(1.0, p1 + 0.16)) < 1e-12


def test_seed_artist_top_no_double_dip():
    same = track("deeper|cut", "seedartist", prov=[{"seed": SEED["key"], "relation": "seed_artist_top", "rank": 0, "source": "deezer-artist-top"}])
    f1 = E.seed_factors(same, SEED, ctx([SEED], v2=False))
    f2 = E.seed_factors(same, SEED, ctx([SEED], v2=True))
    assert f1["artist"] == 1.0 and f2["artist"] == 1.0
    assert abs(f2["provider"] - f1["provider"] * 0.5) < 1e-12


def test_seed_donated_inferred_tag_is_not_evidence():
    donated = track("x|unknown", "x", inferred_tags=[("rock", "Guessed from the starting song")])
    real = track("y|known", "y", tags=("rock",))
    assert E.seed_factors(donated, SEED, ctx([SEED], v2=False))["genre"] > 0
    assert E.seed_factors(donated, SEED, ctx([SEED], v2=True))["genre"] is None
    assert E.seed_factors(real, SEED, ctx([SEED], v2=True))["genre"] > 0


def test_coverage_drops_audio_when_no_seed_vector():
    c = track("x|hit", "x", tags=("rock",), prov=[{"seed": SEED["key"], "relation": "related_song", "rank": 0, "source": "ytmusic-related"}])
    related = {SEED["key"]: set()}
    s1 = E.score_all([c], ctx([SEED], related=related, v2=False))[0]
    s2 = E.score_all([c], ctx([SEED], related=related, v2=True))[0]
    assert s2.coverage > s1.coverage


def test_same_day_repeats_collapse():
    one = E.build_feedback2([ev("complete", "a|x", "e1")], NOW_TS)
    spam = E.build_feedback2([ev("complete", "a|x", f"e{i}") for i in range(1, 6)], NOW_TS)
    assert abs(spam.track["a|x"] - one.track["a|x"] * 1.5) < 1e-9


def test_cross_day_replays_still_add():
    two = E.build_feedback2([ev("complete", "a|x", "d1", ts=NOW_TS - 2 * 86400), ev("complete", "a|x", "d2")], NOW_TS)
    one = E.build_feedback2([ev("complete", "a|x", "d2")], NOW_TS)
    assert two.track["a|x"] > one.track["a|x"] * 1.5


def test_preview_completion_weighs_less():
    prev = E.build_feedback2([ev("complete", "a|x", "p", medium="preview", listened=28, duration=30)], NOW_TS)
    full = E.build_feedback2([ev("complete", "a|x", "f", medium="full", listened=200, duration=210)], NOW_TS)
    assert prev.track["a|x"] < full.track["a|x"]


def test_unknown_duration_not_manufactured():
    unk = E.build_feedback2([ev("complete", "a|x", "u", medium="full", listened=200)], NOW_TS)
    known = E.build_feedback2([ev("complete", "a|x", "k", medium="full", listened=200, duration=205)], NOW_TS)
    assert abs(unk.track["a|x"] - known.track["a|x"]) < 1e-9


def test_artist_spillover_breadth_beats_looping():
    same = E.build_feedback2([ev("complete", "band|one", f"s{i}", ts=NOW_TS - i * 86400, artist="band") for i in range(1, 5)], NOW_TS)
    spread = E.build_feedback2([ev("complete", f"band|song{i}", f"d{i}", artist="band") for i in range(1, 5)], NOW_TS)
    assert spread.artist["band"] > same.artist["band"]


def test_one_skip_never_colours_artist():
    only = E.build_feedback2([ev("skip", "band|x", "s1", artist="band")], NOW_TS)
    assert "band" not in only.artist


def test_confidence_scales_imports():
    live = E.build_feedback2([ev("complete", "a|x", "l")], NOW_TS)
    imported = E.build_feedback2([ev("complete", "a|x", "i", confidence=0.5)], NOW_TS)
    assert abs(imported.track["a|x"] - live.track["a|x"] * 0.5) < 1e-9


def test_v1_golden_path_unchanged_by_v2_additions():
    """The parity guard: rank_v2=False must reproduce exactly what v1 produced."""
    events = [ev("like", "a|x", "e1"), ev("skip", "b|y", "e2")]
    old = E.build_feedback(events, NOW_TS)
    c = track("x|hit", "x", tags=("rock",), prov=[{"seed": SEED["key"], "relation": "related_song", "rank": 0}])
    f = E.seed_factors(c, SEED, ctx([SEED], events=events, v2=False))
    assert f["provider"] is not None
    assert old.track["a|x"] == E.build_feedback(events, NOW_TS, DEFAULT_ENGINE).track["a|x"]


def test_three_consecutive_skips_rest_the_song_until_renewed_interest_or_30_days():
    def skips(n, start, prefix="sk"):
        return [ev("skip", "a|x", f"{prefix}{i}", ts=start + i * 3600) for i in range(n)]

    assert "a|x" not in E.build_feedback2(skips(2, NOW_TS - 86400), NOW_TS).excluded
    assert "a|x" in E.build_feedback2(skips(3, NOW_TS - 86400), NOW_TS).excluded
    # a completion between skips breaks the streak
    broken = skips(2, NOW_TS - 86400) + [
        ev("complete", "a|x", "c", ts=NOW_TS - 80000),
        ev("skip", "a|x", "sk9", ts=NOW_TS - 70000),
    ]
    assert "a|x" not in E.build_feedback2(broken, NOW_TS).excluded
    # the rest expires after 30 days
    assert "a|x" not in E.build_feedback2(skips(3, NOW_TS - 32 * 86400), NOW_TS).excluded
    # v1 reading is unchanged
    assert "a|x" not in E.build_feedback(skips(3, NOW_TS - 86400), NOW_TS).excluded
