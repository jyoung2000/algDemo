"""The one scoring implementation. Pure and deterministic: same seeds, candidates, feedback,
vectors, settings and `now` give the same queue. No I/O happens here.

Scoring, per candidate:

1. Per-seed factors, each in 0..1 or None (= no usable evidence; never treated as 0):
   audio     cosine of DCLAP vectors, calibrated (cos 0.30 -> 0, 0.85 -> 1)
   genre     tag-hierarchy similarity, weighted by tag scope/confidence
   artist    1 same artist, 0.7 provider-listed related artist, 0 otherwise (only when the seed's
             related-artist list is known; else None unless it is the same artist)
   provider  strongest provider relation from *this* seed (YT Music "You might also like",
             radio, SoundCloud recommended, Deezer artist radio...) with a rank decay
   tempo     Deezer BPM closeness, half/double time folded
2. Seed match = weighted mean over the factors that exist for that seed. When genre and provider
   evidence both exist the genre weight is discounted by `genre_provider_overlap`, because
   providers relate tracks partly by genre and that is not two independent proofs.
3. Multi-seed blend = best_seed_share * best seed + (1 - best_seed_share) * emphasis-weighted mean.
   Taste clusters survive because a candidate only needs to fit one seed well.
4. Global factors (feedback fit, freshness, novelty) are added with their weights, renormalised
   over what is present.
5. Coverage = share of affinity weight that had evidence (best seed's factors + feedback).
   final = affinity * (coverage_floor + (1 - coverage_floor) * coverage). A candidate with one
   weak signal cannot beat a richly supported one just because its other factors are missing.
6. Exposure penalty (impressions in the last 7 days) is subtracted for selection only.

Selection keeps soft tier quotas (strong/related/emerging/experimental, shifted by the
Adventurous control), at most `max_per_artist` per artist, seed coverage, and an MMR-style
diversity penalty on genre/audio sameness. The selection order is the queue order; nothing sorts
it again afterwards.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, replace
from datetime import date

import numpy as np

from . import genres as G
from .config import AFFINITY_FACTORS, DEFAULT_ENGINE, FEEDBACK_WEIGHTS, EngineConfig, Weights
from .identity import split_artists

SEED_FACTORS = ("audio", "genre", "artist", "provider", "tempo")
GLOBAL_FACTORS = ("feedback", "freshness", "novelty")

RELATION = {
    # relation: (strength, human label, counts as provider evidence)
    "related_song": (1.0, "YouTube Music lists it under “You might also like” for", True),
    "radio": (0.85, "It plays on YouTube Music's radio for", True),
    "sc_recommended": (0.85, "SoundCloud recommends it next to", True),
    "artist_radio": (0.7, "It is on Deezer's artist radio for", True),
    "related_artist_top": (0.55, "A top song by an artist Deezer relates to", True),
    "ytm_related_artist": (0.55, "A song by an artist YouTube Music lists as similar to", True),
    "seed_artist_top": (0.6, "Another song by the artist of", True),
    "recent": (0.45, "A recent release connected to", True),
    "genre_chart": (0.0, "From the Deezer genre chart matching", False),  # exploration pool, not relatedness
}
EXPLORATION_RELATIONS = {"genre_chart"}


@dataclass
class Settings:
    adventurous: float = 0.5  # 0 familiar .. 1 adventurous; 0.5 is neutral scoring
    fresh: bool = False  # favour songs released recently, when the source gives a real date
    vocals: str = "any"  # not exposed: no measured vocal/instrumental evidence (see README)

    def normalised(self) -> "Settings":
        return Settings(adventurous=min(1.0, max(0.0, float(self.adventurous))), fresh=bool(self.fresh), vocals="any")


@dataclass
class Scored:
    track: dict
    final: float
    affinity: float
    coverage: float
    best_seed: str | None
    per_seed: dict[str, float]
    factors: dict[str, float | None]
    weights_used: dict[str, float]
    tier: str = "related"
    exposure_penalty: float = 0.0
    reasons: list[dict] = field(default_factory=list)
    uncertainty: list[str] = field(default_factory=list)
    new_release: bool = False


# ---------------------------------------------------------------------------------------------
# factor helpers
# ---------------------------------------------------------------------------------------------
def calibrate_audio(cos: float) -> float:
    return min(1.0, max(0.0, (cos - 0.30) / 0.55))


def tempo_fit(a: float | None, b: float | None) -> float | None:
    if not a or not b or a <= 0 or b <= 0:
        return None
    r = abs(math.log2(a / b))
    r = min(r, abs(r - 1.0))  # half/double time
    return max(0.0, 1.0 - r / 0.25)


def age_days(rel: dict | None, now: date) -> int | None:
    if not rel or rel.get("precision") not in ("day", "month"):
        return None
    s = rel["date"]
    try:
        d = date.fromisoformat(s if rel["precision"] == "day" else s + "-15")
    except ValueError:
        return None
    return (now - d).days


def freshness(rel: dict | None, now: date) -> float | None:
    """Day/month-precision dates only; a year alone does not say how fresh something is."""
    age = age_days(rel, now)
    if age is None or age < -7:
        return None
    score = max(0.0, 1.0 - max(0, age) / 365.0)
    if rel.get("kind") == "upload":
        score *= 0.5  # an upload date is not a release date
    if rel.get("precision") == "month":
        score *= 0.8
    return score


def is_new_release(rel: dict | None, now: date, window: int) -> bool:
    if not rel or rel.get("precision") != "day" or rel.get("kind") != "release":
        return False
    age = age_days(rel, now)
    return age is not None and -7 <= age <= window


def primary_artist(t: dict) -> str:
    names = split_artists(t.get("artists") or [])
    return names[0] if names else ""


def artist_set(t: dict) -> set[str]:
    return set(split_artists(t.get("artists") or []))


# ---------------------------------------------------------------------------------------------
# feedback
# ---------------------------------------------------------------------------------------------
@dataclass
class FeedbackView:
    track: dict[str, float]
    artist: dict[str, float]
    excluded: set[str]
    hidden: set[str]
    liked_artists: set[str]
    events: int


def decay(ts: float, now_ts: float, half_life_days: float) -> float:
    age = max(0.0, (now_ts - ts) / 86400.0)
    return 0.5 ** (age / half_life_days)


def build_feedback(events: list[dict], now_ts: float, cfg: EngineConfig = DEFAULT_ENGINE) -> FeedbackView:
    """Deduplicated by event_id upstream (UNIQUE) and again here. Seed selections are never events."""
    seen: set[str] = set()
    track: dict[str, float] = {}
    artist: dict[str, float] = {}
    skipped_by_artist: dict[str, set[str]] = {}
    latest: dict[str, tuple[float, str]] = {}
    hidden: set[str] = set()
    for e in sorted(events, key=lambda x: (x["ts"], x["event_id"])):
        if e["event_id"] in seen or e["kind"] not in FEEDBACK_WEIGHTS or e["kind"] == "seed":
            continue
        seen.add(e["event_id"])
        w = FEEDBACK_WEIGHTS[e["kind"]] * decay(e["ts"], now_ts, cfg.feedback_half_life_days)
        track[e["key"]] = track.get(e["key"], 0.0) + w
        a = e.get("artist") or ""
        if e["kind"] in ("like", "dislike", "hide"):
            latest[e["key"]] = (e["ts"], e["kind"])
        if e["kind"] == "hide" and now_ts - e["ts"] < 30 * 86400:
            hidden.add(e["key"])
        if not a:
            continue
        if e["kind"] == "skip":
            skipped_by_artist.setdefault(a, set()).add(e["key"])
        else:
            artist[a] = artist.get(a, 0.0) + w * 0.5
    # One skipped song never colours an artist; three distinct ones propagate weakly.
    for a, keys in skipped_by_artist.items():
        if len(keys) >= cfg.artist_skip_threshold:
            artist[a] = artist.get(a, 0.0) - 0.5 * len(keys)
    excluded = {k for k, (_, kind) in latest.items() if kind == "dislike"}
    liked = {a for a, v in artist.items() if v > 1.0}
    return FeedbackView(track, artist, excluded, hidden, liked, len(seen))


def feedback_fit(t: dict, fb: FeedbackView) -> float | None:
    s = 0.0
    found = False
    if t["key"] in fb.track:
        s += fb.track[t["key"]]
        found = True
    for a in artist_set(t):
        if a in fb.artist:
            s += fb.artist[a]
            found = True
    if not found:
        return None
    return 0.5 + 0.5 * math.tanh(s / 8.0)


# ---------------------------------------------------------------------------------------------
# scoring
# ---------------------------------------------------------------------------------------------
def _blend(near: float, far: float, a: float) -> float:
    """Multiplier for one factor: `near` at slider 0, 1.0 at 0.5, `far` at slider 1, linear in between."""
    if a <= 0.5:
        return 1.0 + (near - 1.0) * (0.5 - a) / 0.5
    return 1.0 + (far - 1.0) * (a - 0.5) / 0.5


def mode_weights(w: Weights, adventurous: float, fresh: bool = False) -> dict[str, float]:
    """Scoring weights for a point on the Familiar..Adventurous slider, plus the new-releases switch."""
    d = w.as_dict()
    a = min(1.0, max(0.0, adventurous))
    # factor: (multiplier at Familiar, multiplier at Adventurous)
    for key, (near, far) in {"audio": (1.3, 1.0), "artist": (1.3, 0.7), "provider": (1.2, 1.0), "novelty": (0.3, 2.5)}.items():
        d[key] *= _blend(near, far, a)
    if fresh:
        d["freshness"] *= 5.0
    return d


@dataclass
class Context:
    seeds: list[dict]
    vectors: dict[str, np.ndarray]  # recording key -> vector (one model/preprocess id only)
    related_artists: dict[str, set[str]]  # seed key -> folded related artist names (when fetched)
    feedback: FeedbackView
    impressions: dict[str, int]
    settings: Settings
    now: date
    cfg: EngineConfig = DEFAULT_ENGINE


def seed_factors(c: dict, s: dict, ctx: Context) -> dict[str, float | None]:
    f: dict[str, float | None] = {}
    va, vb = ctx.vectors.get(c["key"]), ctx.vectors.get(s["key"])
    f["audio"] = calibrate_audio(float(np.dot(va, vb))) if va is not None and vb is not None else None
    f["genre"] = G.similarity(s.get("tags") or [], c.get("tags") or [])
    shared = artist_set(c) & artist_set(s)
    rel = ctx.related_artists.get(s["key"])
    if shared:
        f["artist"] = 1.0
    elif rel is not None:
        f["artist"] = 0.7 if artist_set(c) & rel else 0.0
    else:
        f["artist"] = None
    best = None
    for p in c.get("provenance") or []:
        if p["seed"] != s["key"]:
            continue
        strength, _, counts = RELATION.get(p["relation"], (0.0, "", False))
        if not counts:
            continue
        v = strength * (1.0 / (1.0 + 0.03 * max(0, p.get("rank", 0))))
        best = v if best is None else max(best, v)
    # This seed's providers were asked; not being in their lists is weak negative evidence.
    asked = any(p["seed"] == s["key"] for p in c.get("provenance") or []) or bool(ctx.related_artists.get(s["key"]))
    f["provider"] = best if best is not None else (0.0 if asked else None)
    f["tempo"] = tempo_fit(c.get("bpm"), s.get("bpm"))
    return f


def score_one(c: dict, ctx: Context) -> Scored:
    cfg = ctx.cfg
    w = mode_weights(cfg.weights, ctx.settings.adventurous, ctx.settings.fresh)
    per_seed: dict[str, float] = {}
    per_seed_factors: dict[str, dict] = {}
    per_seed_wsum: dict[str, float] = {}
    per_seed_ws: dict[str, dict[str, float]] = {}
    for s in ctx.seeds:
        f = seed_factors(c, s, ctx)
        ws = {k: w[k] for k in SEED_FACTORS if f.get(k) is not None and w[k] > 0}
        if "genre" in ws and "provider" in ws and (f["provider"] or 0) > 0:
            ws["genre"] *= 1.0 - cfg.genre_provider_overlap
        total = sum(ws.values())
        per_seed_factors[s["key"]] = f
        per_seed_wsum[s["key"]] = total
        per_seed_ws[s["key"]] = ws
        if total > 0:
            per_seed[s["key"]] = sum(ws[k] * min(1.0, max(0.0, f[k])) for k in ws) / total
    best_key = max(per_seed, key=lambda k: (per_seed[k], per_seed_wsum[k], k)) if per_seed else None
    if per_seed:
        emph = {s["key"]: max(0.1, float(s.get("emphasis", 1.0))) for s in ctx.seeds if s["key"] in per_seed}
        mean = sum(per_seed[k] * emph[k] for k in per_seed) / sum(emph.values())
        blend = cfg.best_seed_share * per_seed[best_key] + (1 - cfg.best_seed_share) * mean
        seed_w = per_seed_wsum[best_key]
    else:
        blend, seed_w = 0.0, 0.0
    g: dict[str, float | None] = {
        "feedback": feedback_fit(c, ctx.feedback),
        "freshness": freshness(c.get("release"), ctx.now),
        "novelty": None,
    }
    seed_artists = set().union(*(artist_set(s) for s in ctx.seeds)) if ctx.seeds else set()
    related_all = set().union(*ctx.related_artists.values()) if ctx.related_artists else set()
    ca = artist_set(c)
    if ca & seed_artists:
        g["novelty"] = 0.0
    elif ca & related_all:
        # Novelty is "new to your starting songs". Liking an artist is rewarded by the feedback
        # factor; it must not also cost novelty, or a like could push that artist's songs down.
        g["novelty"] = 0.5
    else:
        g["novelty"] = 1.0
    num = blend * seed_w
    den = seed_w
    used = {}
    for k in GLOBAL_FACTORS:
        if g[k] is not None and w[k] > 0:
            num += w[k] * min(1.0, max(0.0, g[k]))
            den += w[k]
            used[k] = w[k]
    affinity = num / den if den > 0 else 0.0
    # coverage over affinity factors (seed factors of the best seed + feedback when present)
    all_aff = sum(w[k] for k in AFFINITY_FACTORS)
    have = seed_w + (w["feedback"] if g["feedback"] is not None else 0.0)
    coverage = min(1.0, have / all_aff) if all_aff else 0.0
    final = affinity * (cfg.coverage_floor + (1 - cfg.coverage_floor) * coverage)
    factors = dict(per_seed_factors.get(best_key, {}) if best_key else {})
    factors.update(g)
    if best_key:
        # The weights the score actually used (genre already discounted for provider overlap),
        # so explanations rank factors the way the score did.
        weights_used = dict(per_seed_ws[best_key])
        weights_used.update(used)
    else:
        weights_used = used
    imp = ctx.impressions.get(c["key"], 0)
    pen = min(cfg.exposure_penalty_max, cfg.exposure_penalty * imp)
    return Scored(track=c, final=final, affinity=affinity, coverage=coverage, best_seed=best_key, per_seed=per_seed,
                  factors=factors, weights_used=weights_used, exposure_penalty=pen,
                  new_release=is_new_release(c.get("release"), ctx.now, cfg.new_release_days))


def score_all(candidates: list[dict], ctx: Context) -> list[Scored]:
    seed_keys = {s["key"] for s in ctx.seeds}
    out = []
    for c in candidates:
        if c["key"] in seed_keys or c["key"] in ctx.feedback.excluded or c["key"] in ctx.feedback.hidden:
            continue
        if c.get("unavailable"):
            continue
        out.append(score_one(c, ctx))
    out.sort(key=lambda x: (-x.final, x.track["key"]))
    assign_tiers(out, ctx)
    for s in out:
        s.reasons, s.uncertainty = explain(s, ctx)
    return out


def assign_tiers(scored: list[Scored], ctx: Context) -> None:
    if not scored:
        return
    finals = sorted((s.final for s in scored), reverse=True)
    q = finals[max(0, len(finals) // 4 - 1)]
    for s in scored:
        rels = {p["relation"] for p in s.track.get("provenance") or []}
        exploration_only = rels and rels <= EXPLORATION_RELATIONS
        if exploration_only:
            s.tier = "experimental"
        elif s.final >= q and s.coverage >= 0.4:
            s.tier = "strong"
        elif s.factors.get("novelty") == 1.0:
            s.tier = "emerging"
        else:
            s.tier = "related"
        if ctx.settings.fresh and s.new_release and s.tier == "experimental":
            s.tier = "emerging"


def tier_shares(adventurous: float, cfg: EngineConfig = DEFAULT_ENGINE) -> dict[str, float]:
    t = cfg.tiers
    base = {"strong": t.strong, "related": t.related, "emerging": t.emerging, "experimental": t.experimental}
    safe = {"strong": 0.60, "related": 0.30, "emerging": 0.08, "experimental": 0.02}
    bold = {"strong": 0.20, "related": 0.25, "emerging": 0.30, "experimental": 0.25}
    a = min(1.0, max(0.0, adventurous))
    if a <= 0.5:
        k = a / 0.5
        return {n: safe[n] + (base[n] - safe[n]) * k for n in base}
    k = (a - 0.5) / 0.5
    return {n: base[n] + (bold[n] - base[n]) * k for n in base}


def _sim(a: Scored, b: Scored, vectors: dict[str, np.ndarray]) -> float:
    va, vb = vectors.get(a.track["key"]), vectors.get(b.track["key"])
    if va is not None and vb is not None:
        return max(0.0, float(np.dot(va, vb)))
    ta, tb = a.track.get("tags") or [], b.track.get("tags") or []
    if ta and tb:
        return G.similarity(ta, tb) or 0.0
    return 0.0


def select(scored: list[Scored], ctx: Context) -> list[Scored]:
    cfg = ctx.cfg
    n = cfg.queue_size
    shares = tier_shares(ctx.settings.adventurous, cfg)
    pools: dict[str, list[Scored]] = {k: [] for k in shares}
    for s in scored:
        pools[s.tier].append(s)
    for k in pools:
        pools[k].sort(key=lambda x: (-(x.final - x.exposure_penalty), x.track["key"]))
    chosen: list[Scored] = []
    per_artist: dict[str, int] = {}
    per_seed: dict[str, int] = {}
    seeds = [s["key"] for s in ctx.seeds]
    emph_total = sum(max(0.1, float(s.get("emphasis", 1.0))) for s in ctx.seeds) or 1.0
    seed_share = {s["key"]: max(0.1, float(s.get("emphasis", 1.0))) / emph_total for s in ctx.seeds}
    filled = {k: 0 for k in shares}
    lam = 0.06 + 0.06 * min(1.0, 2 * ctx.settings.adventurous)
    while len(chosen) < n:
        # tier with the largest deficit that still has an eligible item
        order = sorted(shares, key=lambda k: (-(shares[k] * (len(chosen) + 1) - filled[k]), k))
        picked = None
        for tier in order:
            best, best_val = None, -1e9
            for s in pools[tier]:
                pa = primary_artist(s.track)
                if per_artist.get(pa, 0) >= cfg.max_per_artist:
                    continue
                val = s.final - s.exposure_penalty
                if chosen:
                    recent = chosen[-6:]
                    val -= lam * max(_sim(s, r, ctx.vectors) for r in recent)
                if s.best_seed and len(seeds) > 1:
                    expected = seed_share.get(s.best_seed, 0) * (len(chosen) + 1)
                    val += 0.06 * max(-1.0, min(1.0, expected - per_seed.get(s.best_seed, 0)))
                if ctx.settings.fresh and s.new_release:
                    val += 0.15
                if val > best_val or (val == best_val and best is not None and s.track["key"] < best.track["key"]):
                    best, best_val = s, val
            if best is not None:
                picked = (tier, best)
                break
        if picked is None:
            break
        tier, s = picked
        pools[tier].remove(s)
        chosen.append(s)
        filled[tier] += 1
        pa = primary_artist(s.track)
        per_artist[pa] = per_artist.get(pa, 0) + 1
        if s.best_seed:
            per_seed[s.best_seed] = per_seed.get(s.best_seed, 0) + 1
    return chosen


# ---------------------------------------------------------------------------------------------
# explanations (only from factors that actually had evidence)
# ---------------------------------------------------------------------------------------------
def _seed_title(ctx: Context, key: str | None) -> str:
    for s in ctx.seeds:
        if s["key"] == key:
            return f"“{s['title']}”"
    return "your starting songs"


def explain(s: Scored, ctx: Context) -> tuple[list[dict], list[str]]:
    reasons: list[dict] = []
    f = s.factors
    seed = _seed_title(ctx, s.best_seed)
    t = s.track
    contrib = {k: s.weights_used.get(k, 0) * (f.get(k) or 0) for k in s.weights_used}
    provs = [p for p in t.get("provenance") or [] if p["seed"] == s.best_seed]
    provs.sort(key=lambda p: -RELATION.get(p["relation"], (0, "", False))[0])
    if provs and (f.get("provider") or 0) > 0:
        _, label, _ = RELATION[provs[0]["relation"]]
        extra = f" ({provs[0]['via']})" if provs[0].get("via") else ""
        reasons.append({"factor": "provider", "text": f"{label} {seed}{extra}.", "weight": contrib.get("provider", 0)})
    if f.get("audio") is not None and f["audio"] >= 0.55:
        reasons.append({"factor": "audio", "text": f"Sounds close to {seed}: timbre and production compared on 30-second previews (audio model).", "weight": contrib.get("audio", 0)})
    elif f.get("audio") is not None and f["audio"] < 0.25:
        reasons.append({"factor": "audio", "text": f"Sounds quite different from {seed} on the previews; it is here on other evidence.", "weight": 0})
    if f.get("genre") and f["genre"] >= 0.5:
        seed_obj = next((x for x in ctx.seeds if x["key"] == s.best_seed), {})
        st = {g["name"] for g in seed_obj.get("tags") or []}
        shared = [g for g in t.get("tags") or [] if g["name"] in st]
        g = shared[0] if shared else (t.get("tags") or [None])[0]
        if g:
            reasons.append({"factor": "genre", "text": f"{'Shares' if shared else 'Close to'} {g['label']} with {seed} ({g['source'].lower()}, {g['scope']} level).", "weight": contrib.get("genre", 0)})
    if f.get("artist") == 1.0:
        reasons.append({"factor": "artist", "text": f"Same artist as {seed}.", "weight": contrib.get("artist", 0)})
    elif f.get("artist") == 0.7:
        reasons.append({"factor": "artist", "text": f"By an artist the providers list as related to {seed}.", "weight": contrib.get("artist", 0)})
    if f.get("tempo") is not None and f["tempo"] >= 0.6 and t.get("bpm"):
        sb = next((x.get("bpm") for x in ctx.seeds if x["key"] == s.best_seed), None)
        if sb:
            reasons.append({"factor": "tempo", "text": f"Similar tempo: {t['bpm']:.0f} vs {sb:.0f} BPM (Deezer).", "weight": contrib.get("tempo", 0)})
    if f.get("feedback") is not None:
        txt = "You liked songs by this artist." if f["feedback"] > 0.55 else "Your earlier feedback lowered it."
        reasons.append({"factor": "feedback", "text": txt, "weight": contrib.get("feedback", 0)})
    rel = t.get("release")
    if s.new_release:
        reasons.append({"factor": "freshness", "text": f"New release: {rel['date']} ({rel['source']}).", "weight": contrib.get("freshness", 0)})
    if f.get("novelty") == 1.0 and ctx.settings.adventurous > 0.5:
        reasons.append({"factor": "novelty", "text": "An artist that is new to your starting songs.", "weight": contrib.get("novelty", 0)})
    explore = next((p for p in t.get("provenance") or [] if p["relation"] in EXPLORATION_RELATIONS), None)
    if explore and not any(r["factor"] in ("provider", "audio", "artist") for r in reasons):
        g = explore.get("via")
        reasons.append({"factor": "exploration", "text": f"An exploration pick from Deezer's {g + ' ' if g else 'genre '}chart, a genre Deezer gives {seed}.", "weight": 0.001})
    # Evidence first; "new artist" and freshness describe the pick rather than why it fits.
    # (len() is read first: list.sort empties the list while it runs, so the key cannot ask it.)
    several = len(reasons) > 1
    reasons.sort(key=lambda r: (several and r["factor"] in ("novelty", "freshness"), -r["weight"]))
    unc: list[str] = []
    if rel and rel.get("kind") == "upload":
        unc.append(f"Date shown is the upload date ({rel['date']}), not a release date.")
    if rel and rel.get("precision") == "year":
        unc.append(f"Only the release year ({rel['date']}) is known.")
    if t.get("artist_from_url"):
        unc.append("Artist name comes from the uploader's address on SoundCloud.")
    if s.coverage < 0.4:
        unc.append("Little evidence about this one; it is a looser suggestion.")
    if f.get("audio") is None:
        unc.append("No audio comparison: no legitimately available preview for it, or it was not analysed in this request.")
    return reasons, unc


def recommend(candidates: list[dict], ctx: Context) -> list[Scored]:
    return select(score_all(candidates, ctx), ctx)


def with_settings(ctx: Context, **kw) -> Context:
    return replace(ctx, settings=replace(ctx.settings, **kw).normalised())
