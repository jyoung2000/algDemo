"""Recording identity: normalisation, version tokens, collaborations and conservative matching.

Two rows are merged only when they are the *same recording* with high confidence:
ISRC equality, or (same title core, a shared artist, identical version tokens and durations
within 3 s). Close-but-not-certain pairs are reported as `uncertain` and are never merged
automatically; the UI offers them to the user instead.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

# Version tokens that make a different recording (or a different rendition of one).
VERSION_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("live", re.compile(r"\blive\b|\bunplugged\b|\bin concert\b")),
    ("acoustic", re.compile(r"\bacoustic\b")),
    ("remix", re.compile(r"\bremix\b|\brmx\b|\bmix\)|\bedit\b(?! version)|\bflip\b|\bbootleg\b|\brework\b|\bvip\b")),
    ("sped-up", re.compile(r"\bsped[\s-]?up\b|\bspeed[\s-]?up\b|\bnightcore\b")),
    ("slowed", re.compile(r"\bslowed\b|\breverb\b")),
    ("cover", re.compile(r"\bcover\b|\btribute\b")),
    ("instrumental", re.compile(r"\binstrumental\b|\bkaraoke\b|\boff vocal\b")),
    ("demo", re.compile(r"\bdemo\b")),
    ("extended", re.compile(r"\bextended\b|\bclub mix\b|\b12 inch\b")),
    ("radio-edit", re.compile(r"\bradio edit\b|\bradio version\b|\bsingle version\b")),
    ("orchestral", re.compile(r"\borchestral\b|\bsymphonic\b")),
    ("a-cappella", re.compile(r"\ba ?cappella\b")),
]
# Edition words: shown to the user, but a remaster is the same performance, so they do not block a match.
EDITION_PATTERN = re.compile(r"\bremaster(ed)?\b|\b(19|20)\d\d (remaster|version|mix)\b|\bdeluxe\b|\bmono\b|\bstereo\b|\bexplicit\b|\bclean\b")

FEAT_PATTERN = re.compile(r"[\(\[]?\s*\b(feat\.?|ft\.?|featuring|with)\s+([^\)\]]+)[\)\]]?", re.I)
BRACKETS = re.compile(r"[\(\[]([^\)\]]*)[\)\]]")
DASH_SUFFIX = re.compile(r"\s[-–—]\s(.+)$")
ARTIST_SPLIT = re.compile(r"\s*(?:,|&|\band\b|\bx\b|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b|\bvs\.?|/|;)\s*", re.I)


def fold(text: str) -> str:
    """Lower-case, strip accents, keep letters/digits of any script, collapse spaces."""
    t = unicodedata.normalize("NFKD", text or "")
    t = "".join(c for c in t if not unicodedata.combining(c)).lower()
    t = t.replace("&", " and ").replace("’", "'")
    t = re.sub(r"[^\w\s]", " ", t, flags=re.UNICODE)
    t = t.replace("_", " ")
    return re.sub(r"\s+", " ", t).strip()


def split_artists(names: list[str] | str) -> list[str]:
    items = [names] if isinstance(names, str) else list(names)
    out: list[str] = []
    for item in items:
        for part in ARTIST_SPLIT.split(item or ""):
            f = fold(part)
            if f and f not in out:
                out.append(f)
    return out


@dataclass(frozen=True)
class ParsedTitle:
    core: str  # folded title without version/feature decorations
    versions: frozenset[str]
    edition: str | None
    featured: tuple[str, ...]
    display_version: str | None


def parse_title(title: str, extra_version: str = "") -> ParsedTitle:
    raw = f"{title or ''} {extra_version or ''}".strip()
    featured: list[str] = []
    for m in FEAT_PATTERN.finditer(raw):
        featured.extend(split_artists(m.group(2)))
    decorations = " ".join(BRACKETS.findall(raw))
    dash = DASH_SUFFIX.search(title or "")
    if dash:
        decorations += " " + dash.group(1)
    dec_fold = fold(decorations)
    versions = frozenset(name for name, pat in VERSION_PATTERNS if pat.search(dec_fold))
    edition_m = EDITION_PATTERN.search(dec_fold)
    core = BRACKETS.sub(" ", title or "")
    core = FEAT_PATTERN.sub(" ", core)
    if dash and (versions or edition_m or re.search(r"remaster|version|mix|edit|live", dash.group(1), re.I)):
        core = DASH_SUFFIX.sub("", core)
    shown = [p.strip() for p in BRACKETS.findall(raw) if p.strip() and not FEAT_PATTERN.match("(" + p + ")")]
    if extra_version and extra_version.strip("() []") and extra_version.strip() not in shown:
        shown.append(extra_version.strip("() []"))
    return ParsedTitle(
        core=fold(core),
        versions=versions,
        edition=edition_m.group(0) if edition_m else None,
        featured=tuple(featured),
        display_version=", ".join(dict.fromkeys(shown)) or None,
    )


def recording_key(title: str, artists: list[str], extra_version: str = "") -> str:
    """Stable key for dedupe: primary artist + title core + sorted version tokens."""
    p = parse_title(title, extra_version)
    names = split_artists(artists)
    primary = names[0] if names else ""
    return f"{primary}|{p.core}|{','.join(sorted(p.versions))}"


@dataclass(frozen=True)
class MatchResult:
    verdict: str  # same | uncertain | different
    reason: str


def match_recordings(a: dict, b: dict) -> MatchResult:
    """Compare two track dicts (title, artists, duration, isrc, version)."""
    pa = parse_title(a.get("title", ""), a.get("version") or "")
    pb = parse_title(b.get("title", ""), b.get("version") or "")
    # A shared ISRC is strong evidence, but providers do misfile them onto re-releases and live cuts.
    # Hard contradictions (a version tag or a duration that cannot be the same recording) win, so the
    # shortcut can never certify a different recording as the requested full song (SOURCE-ISRC-001).
    if a.get("isrc") and b.get("isrc") and a["isrc"].upper() == b["isrc"].upper():
        if pa.versions != pb.versions:
            return MatchResult("different", f"same ISRC but different version ({', '.join(sorted(pa.versions ^ pb.versions))})")
        ia, ib = a.get("duration"), b.get("duration")
        if ia and ib:
            gap = abs(float(ia) - float(ib))
            if gap > 8:
                return MatchResult("different", f"same ISRC but durations differ by {gap:.0f}s")
            if gap > 3:
                return MatchResult("uncertain", f"same ISRC but durations differ by {gap:.0f}s")
        return MatchResult("same", "same ISRC")
    arts_a = set(split_artists(a.get("artists") or [])) | set(pa.featured)
    arts_b = set(split_artists(b.get("artists") or [])) | set(pb.featured)
    if not arts_a & arts_b:
        return MatchResult("different", "no shared artist")
    if pa.core != pb.core:
        ta, tb = set(pa.core.split()), set(pb.core.split())
        if not ta or not tb or len(ta & tb) / len(ta | tb) < 0.75:
            return MatchResult("different", "different title")
        title_exact = False
    else:
        title_exact = True
    if pa.versions != pb.versions:
        return MatchResult("different", f"different version ({', '.join(sorted(pa.versions ^ pb.versions))})")
    da, db = a.get("duration"), b.get("duration")
    if da and db:
        diff = abs(float(da) - float(db))
        if diff <= 3 and title_exact:
            return MatchResult("same", f"same title, artist and version; durations within {diff:.0f}s")
        if diff <= 8:
            return MatchResult("uncertain", f"durations differ by {diff:.0f}s")
        return MatchResult("different", f"durations differ by {diff:.0f}s")
    return MatchResult("uncertain", "no duration to compare" if title_exact else "titles differ slightly")
