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
    "r b": "r&b", "rnb": "r&b", "r and b": "r&b", "rhythm and blues": "r&b", "contemporary r b": "r&b", "neo soul": "neo-soul", "neosoul": "neo-soul", "motown": "soul",
    "hip hop": "hip-hop", "rap hip hop": "hip-hop", "rap": "hip-hop", "hiphop": "hip-hop", "hip hop rap": "hip-hop", "trap": "trap",
    "boom bap": "hip-hop", "crunk": "hip-hop", "g funk": "hip-hop", "uk drill": "drill", "drill": "drill", "grime": "grime", "phonk": "phonk",
    "electro": "electronic", "electronica": "electronic", "edm": "electronic", "electronic dance music": "electronic", "idm": "electronic",
    "dance": "dance", "dance pop": "dance-pop", "eurodance": "dance", "disco": "disco", "nu disco": "disco",
    "synthpop": "synth-pop", "synth pop": "synth-pop", "electropop": "synth-pop", "electro pop": "synth-pop",
    "synthwave": "synthwave", "retrowave": "synthwave", "vaporwave": "synthwave",
    "soul funk": "soul", "soul and funk": "soul", "funk": "funk",
    "latin music": "latin", "musica latina": "latin", "reggaeton": "reggaeton", "salsa": "latin", "bachata": "latin", "cumbia": "latin", "regional mexican": "latin", "corridos": "latin", "banda": "latin",
    "alternative": "alternative", "alternative rock": "alternative", "alt rock": "alternative", "indie": "indie", "indie rock": "indie", "indie pop": "indie-pop",
    "bedroom pop": "indie-pop", "dream pop": "dream-pop", "shoegaze": "shoegaze", "grunge": "grunge", "garage rock": "rock", "pop rock": "rock", "psychedelic rock": "psychedelic", "psychedelic": "psychedelic",
    "films games": "soundtrack", "film scores": "soundtrack", "soundtrack": "soundtrack",
    "drum and bass": "drum-and-bass", "dnb": "drum-and-bass", "d b": "drum-and-bass", "jungle": "drum-and-bass", "breakbeat": "breakbeat", "breaks": "breakbeat",
    "deep house": "deep-house", "tech house": "tech-house", "house music": "house", "french house": "house", "filter house": "house", "progressive house": "house", "electro house": "house", "big room": "house",
    "tropical house": "tropical-house", "future bass": "future-bass", "hardstyle": "hardstyle", "melodic techno": "techno", "minimal techno": "techno",
    "uk garage": "uk-garage", "2 step": "uk-garage", "trip hop": "trip-hop", "triphop": "trip-hop",
    "lofi": "lo-fi", "lo fi": "lo-fi", "lo fi hip hop": "lo-fi",
    "kpop": "k-pop", "k pop": "k-pop", "jpop": "j-pop", "j pop": "j-pop", "city pop": "j-pop",
    "heavy metal": "metal", "hard rock": "rock", "classic rock": "rock", "pop punk": "pop-punk", "post punk": "post-punk", "emo": "emo", "hardcore punk": "punk",
    "singer songwriter": "singer-songwriter", "downtempo": "downtempo", "chillout": "downtempo", "ambient": "ambient", "new age": "ambient",
    "afrobeats": "afrobeats", "afrobeat": "african", "amapiano": "amapiano", "african music": "african", "asian music": "asian",
    "brazilian music": "brazilian", "bossa nova": "brazilian", "mpb": "brazilian", "samba": "brazilian",
    "ska": "ska", "dancehall": "dancehall", "dub": "dub",
    "opera": "classical", "orchestral": "classical", "baroque": "classical", "bluegrass": "country", "americana": "folk", "folk rock": "folk",
    "smooth jazz": "jazz", "bebop": "jazz", "swing": "jazz",
    "christian": "gospel", "worship": "gospel", "children s music": "kids", "children": "kids",
    "hyperpop": "hyperpop",
}
# child -> parent
PARENT = {
    "trap": "hip-hop", "lo-fi": "hip-hop", "drill": "hip-hop", "grime": "hip-hop", "phonk": "hip-hop",
    "dance-pop": "pop", "k-pop": "pop", "j-pop": "pop", "indie-pop": "indie", "synth-pop": "pop", "hyperpop": "pop", "dream-pop": "indie-pop",
    "house": "electronic", "deep-house": "house", "tech-house": "house", "tropical-house": "house", "techno": "electronic",
    "drum-and-bass": "electronic", "dubstep": "electronic", "trance": "electronic", "downtempo": "electronic",
    "ambient": "electronic", "dance": "electronic", "disco": "dance", "synthwave": "electronic", "breakbeat": "electronic",
    "future-bass": "electronic", "hardstyle": "electronic", "uk-garage": "electronic", "trip-hop": "downtempo",
    "reggaeton": "latin", "funk": "soul", "neo-soul": "soul", "metal": "rock", "alternative": "rock", "indie": "alternative",
    "shoegaze": "alternative", "grunge": "rock", "psychedelic": "rock", "punk": "rock", "pop-punk": "punk", "post-punk": "punk", "emo": "punk",
    "afrobeats": "african", "amapiano": "african", "singer-songwriter": "folk",
    "ska": "reggae", "dancehall": "reggae", "dub": "reggae",
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
