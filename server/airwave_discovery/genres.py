"""Genre/tag normalisation with a small documented hierarchy.

Tags keep their provenance: `source` (deezer/soundcloud/...), `scope` (track/album/artist),
`confidence` (0..1) and `inferred` (True only when a verified classifier produced it; nothing in
this demo infers genres, so every tag here is platform-stated). Unknown stays unknown: search
text, playlist names and provider relatedness are never turned into tags.
"""

from __future__ import annotations

from .identity import fold

# alias -> canonical
ALIASES = {
    "r b": "r&b", "rnb": "r&b", "r and b": "r&b", "rhythm and blues": "r&b", "contemporary r b": "r&b",
    "hip hop": "hip-hop", "rap hip hop": "hip-hop", "rap": "hip-hop", "hiphop": "hip-hop", "hip hop rap": "hip-hop", "trap": "trap",
    "electro": "electronic", "electronica": "electronic", "edm": "electronic", "electronic dance music": "electronic",
    "dance": "dance", "dance pop": "dance-pop",
    "soul funk": "soul", "soul and funk": "soul", "funk": "funk",
    "latin music": "latin", "musica latina": "latin", "reggaeton": "reggaeton",
    "alternative": "alternative", "alternative rock": "alternative", "indie": "indie", "indie rock": "indie", "indie pop": "indie-pop",
    "films games": "soundtrack", "film scores": "soundtrack", "soundtrack": "soundtrack",
    "drum and bass": "drum-and-bass", "dnb": "drum-and-bass", "d b": "drum-and-bass",
    "deep house": "deep-house", "tech house": "tech-house", "lofi": "lo-fi", "lo fi": "lo-fi", "lo fi hip hop": "lo-fi",
    "kpop": "k-pop", "k pop": "k-pop", "jpop": "j-pop", "j pop": "j-pop",
    "heavy metal": "metal", "hard rock": "rock", "classic rock": "rock",
    "singer songwriter": "singer-songwriter", "downtempo": "downtempo", "chillout": "downtempo", "ambient": "ambient",
    "afrobeats": "afrobeats", "african music": "african", "asian music": "asian", "brazilian music": "brazilian",
}
# child -> parent
PARENT = {
    "trap": "hip-hop", "lo-fi": "hip-hop",
    "dance-pop": "pop", "k-pop": "pop", "j-pop": "pop", "indie-pop": "indie",
    "house": "electronic", "deep-house": "house", "tech-house": "house", "techno": "electronic",
    "drum-and-bass": "electronic", "dubstep": "electronic", "trance": "electronic", "downtempo": "electronic",
    "ambient": "electronic", "dance": "electronic",
    "reggaeton": "latin", "funk": "soul", "metal": "rock", "alternative": "rock", "indie": "alternative",
    "afrobeats": "african", "singer-songwriter": "folk",
}
KNOWN = set(ALIASES.values()) | set(PARENT) | set(PARENT.values()) | {
    "pop", "rock", "jazz", "classical", "country", "folk", "blues", "reggae", "electronic", "house", "techno",
    "soul", "r&b", "hip-hop", "latin", "metal", "punk", "gospel", "world", "soundtrack", "kids",
}
SCOPE_WEIGHT = {"track": 1.0, "album": 0.8, "artist": 0.55}


def normalize(name: str) -> str | None:
    f = fold(name)
    if not f or len(f) > 40:
        return None
    canon = ALIASES.get(f, f.replace(" ", "-"))
    return canon if canon in KNOWN else None  # free-form uploader tags ("meh", "free download") are dropped


def make_tag(name: str, source: str, scope: str, confidence: float) -> dict | None:
    canon = normalize(name)
    if not canon:
        return None
    return {"name": canon, "label": name, "source": source, "scope": scope, "confidence": round(confidence, 2), "inferred": False}


def ancestors(g: str) -> list[str]:
    out = []
    while g in PARENT:
        g = PARENT[g]
        out.append(g)
    return out


def pair_similarity(a: str, b: str) -> float:
    if a == b:
        return 1.0
    if b in ancestors(a) or a in ancestors(b):
        return 0.6
    pa, pb = PARENT.get(a), PARENT.get(b)
    if pa and pa == pb:
        return 0.4
    return 0.0


def tag_strength(t: dict) -> float:
    return SCOPE_WEIGHT.get(t.get("scope", "artist"), 0.5) * float(t.get("confidence", 0.5))


def similarity(tags_a: list[dict], tags_b: list[dict]) -> float | None:
    """Best-match similarity weighted by tag strength; None when either side has no tags."""
    if not tags_a or not tags_b:
        return None
    total = 0.0
    weight = 0.0
    for ta in tags_a:
        sa = tag_strength(ta)
        best = max(pair_similarity(ta["name"], tb["name"]) * tag_strength(tb) for tb in tags_b)
        total += sa * best
        weight += sa
    return max(0.0, min(1.0, total / weight)) if weight else None
