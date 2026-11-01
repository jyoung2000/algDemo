"""Provider adapters behind one capability interface.

Each provider declares which of search / resolve_link / related_candidates / artist_candidates /
recent_candidates / playback_link it implements; anything it does not implement is absent, never
faked. Runtime health is checked by `health_check()` and shown as badges; a declared capability
whose live check failed is reported as unavailable.

Identity is kept apart on purpose: `platform_id` is the id on that provider, `key` is the
conservative canonical recording key (identity.recording_key), and `audio` (only Deezer here) is
the legitimately available preview clip used for embeddings.

Network notes (verified live on 2026-10-26, see docs/CAPABILITIES.md):
- Deezer public API: keyless JSON, 30 s MP3 previews, ISRC/BPM on /track, album genres,
  artist radio/related/top/albums with day-precision release dates.
- YouTube Music via ytmusicapi (unauthenticated): song search, watch-playlist radio, "You might
  also like", artist songs / similar artists / singles (year precision only).
- SoundCloud via yt-dlp: track metadata (genre, tags, release/upload dates) and native search
  through SoundCloud's api-v2 using a client id that yt-dlp obtains itself (no developer-key
  setup, but not API-free), plus a track's /recommended list. oEmbed for the widget.
- Spotify: public oEmbed gives title + artwork + embed only (no artist), so a pasted link needs
  a cross-provider match the user confirms.
"""

from __future__ import annotations

import contextvars
import re
import threading
import time
from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Any
from urllib.parse import parse_qs, quote, urlsplit

import requests

from . import genres
from .identity import fold, match_recordings, parse_title, recording_key, split_artists
from .net import BlockedUrl, CancelToken, FetchError, Http, Meter, validate_url
from .store import Store

CAPABILITIES = ("search", "resolve_link", "related_candidates", "artist_candidates", "recent_candidates", "playback_link")

# The meter for whatever request is running on this thread (ytmusicapi/yt-dlp do their own I/O).
CURRENT_METER: contextvars.ContextVar[Meter | None] = contextvars.ContextVar("meter", default=None)


class ProviderError(Exception):
    pass


class NeedsChoice(Exception):
    """A link resolved to something that needs the user to choose (ambiguous match, playlist)."""

    def __init__(self, kind: str, message: str, payload: dict) -> None:
        super().__init__(message)
        self.kind = kind
        self.payload = payload


def _secs(text: str | None) -> int | None:
    if not text:
        return None
    try:
        parts = [int(p) for p in str(text).split(":")]
    except ValueError:
        return None
    total = 0
    for p in parts:
        total = total * 60 + p
    return total


_PREVIEW_EXP = re.compile(r"exp=(\d+)")


def preview_expiry(url: str) -> float:
    """Unix time a signed Deezer preview URL stops working; 0 when the URL carries no signature."""
    m = _PREVIEW_EXP.search(url or "")
    return float(m.group(1)) if m else 0.0


def release(date_str: str | None, kind: str, source: str) -> dict | None:
    """Release info with explicit precision. kind: release | upload | first_seen."""
    if not date_str:
        return None
    s = str(date_str)
    if re.fullmatch(r"\d{8}", s):
        s = f"{s[:4]}-{s[4:6]}-{s[6:]}"
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
        if s.startswith("0000"):
            return None
        return {"date": s, "precision": "day", "kind": kind, "source": source}
    if re.fullmatch(r"\d{4}-\d{2}", s):
        return {"date": s, "precision": "month", "kind": kind, "source": source}
    if re.fullmatch(r"\d{4}", s):
        return {"date": s, "precision": "year", "kind": kind, "source": source}
    return None


def make_track(*, provider: str, platform_id: str, title: str, artists: list[str], album: str | None = None,
               duration: float | None = None, artwork: str | None = None, url: str, isrc: str | None = None,
               version: str | None = None, rel: dict | None = None, tags: list[dict] | None = None,
               artist_ids: dict | None = None, preview: str | None = None, explicit: bool | None = None,
               bpm: float | None = None, kind: str = "song", extra: dict | None = None) -> dict:
    p = parse_title(title, version or "")
    t = {
        "id": f"{provider}:{platform_id}",
        "provider": provider,
        "platform_id": platform_id,
        "key": recording_key(title, artists, version or ""),
        "title": title,
        "artists": artists,
        "artist": ", ".join(artists),
        "album": album,
        "version": p.display_version,
        "versions": sorted(p.versions),
        "duration": round(float(duration)) if duration else None,
        "artwork": artwork,
        "url": url,
        "isrc": isrc,
        "release": rel,
        "tags": [x for x in (tags or []) if x],
        "artist_ids": artist_ids or {},
        "preview": preview,
        "explicit": explicit,
        "bpm": bpm if bpm and bpm > 0 else None,
        "kind": kind,
    }
    if extra:
        t.update(extra)
    return t


@dataclass
class Health:
    state: str  # working | degraded | unavailable | not_tested
    detail: str
    checked: float
    latency_ms: int | None = None


class Provider:
    name = "base"
    label = "Base"
    capabilities: tuple[str, ...] = ()

    def __init__(self, http: Http, store: Store) -> None:
        self.http = http
        self.store = store
        self.health: dict[str, Health] = {}

    def cached(self, key: str, kind: str, ttl: float, fn, *, allow_stale_on_error: bool = True):
        hit = self.store.cache_get(key)
        if hit is not None:
            return hit["value"]
        try:
            value = fn()
        except (FetchError, ProviderError, Exception) as e:  # noqa: BLE001 - provider libraries raise anything
            if allow_stale_on_error:
                stale = self.store.cache_get(key, allow_stale=True)
                if stale is not None:
                    return stale["value"]
            if isinstance(e, (FetchError, ProviderError, BlockedUrl, NeedsChoice)):
                raise
            raise ProviderError(f"{self.label}: {type(e).__name__}: {str(e)[:160]}") from e
        self.store.cache_put(key, kind, value, ttl)
        return value

    def health_check(self) -> dict[str, Health]:
        return {}


# ----------------------------------------------------------------------------------------------
# Deezer
# ----------------------------------------------------------------------------------------------
DZ = "https://api.deezer.com"


class Deezer(Provider):
    name = "deezer"
    label = "Deezer"
    capabilities = ("search", "resolve_link", "related_candidates", "artist_candidates", "recent_candidates", "playback_link")

    def _get(self, path: str, meter: Meter | None, token: CancelToken | None) -> dict:
        data = self.http.get_json(DZ + path, meter=meter, token=token, category="metadata", max_bytes=1_500_000)
        if isinstance(data, dict) and data.get("error"):
            err = data["error"]
            raise ProviderError(f"Deezer: {err.get('type')}: {err.get('message')}")
        return data

    def to_track(self, x: dict, album: dict | None = None) -> dict:
        alb = album or x.get("album") or {}
        contributors = [c["name"] for c in x.get("contributors") or [] if c.get("name")]
        artists = contributors or [x.get("artist", {}).get("name", "")]
        rel = release(x.get("release_date") or alb.get("release_date"), "release", "Deezer")
        tags = []
        for g in ((alb.get("genres") or {}).get("data") or []):
            tags.append(genres.make_tag(g.get("name", ""), "Deezer album genre", "album", 0.8))
        return make_track(
            provider="deezer", platform_id=str(x["id"]), title=x.get("title") or x.get("title_short") or "",
            version=x.get("title_version") or "", artists=[a for a in artists if a], album=alb.get("title"),
            duration=x.get("duration"), artwork=alb.get("cover_medium") or alb.get("cover"),
            url=x.get("link") or f"https://www.deezer.com/track/{x['id']}", isrc=x.get("isrc"), rel=rel, tags=tags,
            artist_ids={"deezer": str(x.get("artist", {}).get("id", ""))}, preview=x.get("preview") or None,
            explicit=x.get("explicit_lyrics"), bpm=x.get("bpm"),
            extra={"album_id": str(alb.get("id") or ""), "popularity": x.get("rank")},
        )

    def search(self, q: str, limit: int = 15, meter=None, token=None) -> list[dict]:
        def run():
            d = self._get(f"/search?q={quote(q)}&limit={limit}", meter, token)
            return [self.to_track(x) for x in d.get("data", []) if x.get("type", "track") == "track" and x.get("readable", True)]

        return self.cached(f"dz:search:{fold(q)}:{limit}", "search", 15 * 60, run)

    def track(self, tid: str, meter=None, token=None) -> dict:
        return self.cached(f"dz:track:{tid}", "track", 7 * 86400, lambda: self.to_track(self._get(f"/track/{tid}", meter, token)))

    def fresh_preview(self, tid: str, url: str | None = None, meter=None, token=None) -> str | None:
        """Deezer preview URLs are signed for about 15 minutes, while track metadata is cached for days.
        Return ``url`` while its signature still has a minute left; otherwise re-read the track."""
        if url and preview_expiry(url) > time.time() + 60:
            return url
        fresh = self.to_track(self._get(f"/track/{tid}", meter, token))
        self.store.cache_put(f"dz:track:{tid}", "track", fresh, 7 * 86400)
        return fresh.get("preview")

    def album(self, aid: str, meter=None, token=None) -> dict:
        def run():
            d = self._get(f"/album/{aid}", meter, token)
            return {"id": str(d.get("id")), "title": d.get("title"), "release_date": d.get("release_date"), "genres": d.get("genres"),
                    "cover_medium": d.get("cover_medium"), "record_type": d.get("record_type"),
                    "tracks": [{"id": t["id"], "title": t.get("title"), "title_version": t.get("title_version"), "duration": t.get("duration"),
                                "artist": t.get("artist"), "preview": t.get("preview"), "link": t.get("link"), "rank": t.get("rank"),
                                "explicit_lyrics": t.get("explicit_lyrics"), "readable": t.get("readable", True)}
                               for t in (d.get("tracks") or {}).get("data", [])[:40]]}

        return self.cached(f"dz:album:{aid}", "album", 7 * 86400, run)

    def resolve_link(self, url: str, meter=None, token=None) -> dict:
        parts = urlsplit(url)
        host = parts.hostname or ""
        if host in ("deezer.page.link", "link.deezer.com"):
            url = self.http.resolve_redirects(url, meter=meter, token=token)
            parts = urlsplit(url)
        m = re.search(r"/(track|album|playlist|artist)/(\d+)", parts.path)
        if not m:
            raise ProviderError("That Deezer link is not a track link.")
        kind, ident = m.groups()
        if kind != "track":
            raise ProviderError(f"That is a Deezer {kind}; paste a link to a single track.")
        return self.track(ident, meter, token)

    def with_genres(self, t: dict, meter=None, token=None) -> dict:
        if t.get("tags") or not t.get("album_id"):
            return t
        alb = self.album(t["album_id"], meter, token)
        tags = [genres.make_tag(g.get("name", ""), "Deezer album genre", "album", 0.8) for g in ((alb.get("genres") or {}).get("data") or [])]
        t = dict(t, tags=[x for x in tags if x])
        if not t.get("release"):
            t["release"] = release(alb.get("release_date"), "release", "Deezer")
        return t

    def artist_radio(self, artist_id: str, limit: int, meter=None, token=None) -> list[dict]:
        return self.cached(f"dz:artradio:{artist_id}:{limit}", "related", 6 * 3600,
                           lambda: [self.to_track(x) for x in self._get(f"/artist/{artist_id}/radio?limit={limit}", meter, token).get("data", [])])

    def artist_top(self, artist_id: str, limit: int, meter=None, token=None) -> list[dict]:
        return self.cached(f"dz:arttop:{artist_id}:{limit}", "artist", 6 * 3600,
                           lambda: [self.to_track(x) for x in self._get(f"/artist/{artist_id}/top?limit={limit}", meter, token).get("data", [])])

    def related_artists(self, artist_id: str, limit: int, meter=None, token=None) -> list[dict]:
        return self.cached(f"dz:artrel:{artist_id}:{limit}", "related", 24 * 3600,
                           lambda: [{"id": str(a["id"]), "name": a["name"]} for a in self._get(f"/artist/{artist_id}/related?limit={limit}", meter, token).get("data", [])])

    def recent_albums(self, artist_id: str, limit: int, meter=None, token=None) -> list[dict]:
        return self.cached(f"dz:artalb:{artist_id}:{limit}", "recent", 12 * 3600,
                           lambda: [{"id": str(a["id"]), "title": a["title"], "release_date": a.get("release_date"), "record_type": a.get("record_type"),
                                     "cover_medium": a.get("cover_medium")} for a in self._get(f"/artist/{artist_id}/albums?limit={limit}", meter, token).get("data", [])])

    def genre_chart(self, genre_id: int, limit: int, meter=None, token=None) -> list[dict]:
        return self.cached(f"dz:chart:{genre_id}:{limit}", "related", 12 * 3600,
                           lambda: [self.to_track(x) for x in self._get(f"/chart/{genre_id}/tracks?limit={limit}", meter, token).get("data", [])])

    def genre_ids(self, meter=None, token=None) -> dict[str, int]:
        def run():
            d = self._get("/genre", meter, token)
            out = {}
            for g in d.get("data", []):
                canon = genres.normalize(g.get("name", ""))
                if canon and g.get("id"):
                    out.setdefault(canon, int(g["id"]))
            return out

        return self.cached("dz:genres", "meta", 7 * 86400, run)

    def find_match(self, t: dict, meter=None, token=None) -> tuple[dict | None, list[dict]]:
        """Deezer recording for a track from another provider: (confident match | None, uncertain options)."""
        if t["provider"] == "deezer":
            return t, []
        q = f'{t["artists"][0] if t["artists"] else ""} {t["title"]}'.strip()
        results = self.search(q, 10, meter, token)
        uncertain = []
        for r in results:
            v = match_recordings(t, r)
            if v.verdict == "same":
                return r, []
            if v.verdict == "uncertain":
                uncertain.append(dict(r, match_note=v.reason))
        return None, uncertain[:5]

    def playback_link(self, t: dict) -> dict:
        return {"kind": "preview" if t.get("preview") else "external", "preview": t.get("preview"),
                "embed": f"https://widget.deezer.com/widget/auto/track/{t['platform_id']}", "open": t["url"], "label": "Open in Deezer"}

    def health_check(self) -> dict[str, Health]:
        t0 = time.perf_counter()
        try:
            d = self.http.get_json(DZ + "/search?q=daft%20punk&limit=1", max_bytes=200_000, retries=0)
            ok = bool(d.get("data"))
            ms = int((time.perf_counter() - t0) * 1000)
            h = Health("working" if ok else "degraded", "live search answered" if ok else "empty answer", time.time(), ms)
        except Exception as e:  # noqa: BLE001
            h = Health("unavailable", str(e)[:120], time.time(), None)
        return {c: h for c in self.capabilities}


# ----------------------------------------------------------------------------------------------
# YouTube Music (ytmusicapi, unauthenticated)
# ----------------------------------------------------------------------------------------------
class _MeteredSession(requests.Session):
    def __init__(self) -> None:
        super().__init__()
        self.hooks["response"].append(self._count)

    @staticmethod
    def _count(resp, *a, **k):
        """Count compressed bytes off the wire, then hand requests the decoded body.

        Hooks run before requests reads the body, so the raw stream is read here undecoded.
        """
        m = CURRENT_METER.get()
        if m is None or getattr(resp, "_content_consumed", False):
            return resp
        import zlib

        wire = resp.raw.read(decode_content=False) or b""
        enc = (resp.headers.get("content-encoding") or "").lower().strip()
        if enc in ("gzip", "x-gzip"):
            body = zlib.decompress(wire, 16 + zlib.MAX_WBITS)
        elif enc == "deflate":
            try:
                body = zlib.decompress(wire)
            except zlib.error:
                body = zlib.decompress(wire, -zlib.MAX_WBITS)
        else:
            body = wire
        resp._content = body
        resp._content_consumed = True
        m.add("metadata", len(wire))
        return resp


YT_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")


class YouTubeMusic(Provider):
    name = "ytmusic"
    label = "YouTube Music"
    capabilities = ("search", "resolve_link", "related_candidates", "artist_candidates", "playback_link")

    def __init__(self, http: Http, store: Store) -> None:
        super().__init__(http, store)
        self._yt = None
        self._lock = threading.Lock()

    @property
    def yt(self):
        with self._lock:
            if self._yt is None:
                from ytmusicapi import YTMusic

                self._yt = YTMusic(requests_session=_MeteredSession(), language="en")
            return self._yt

    def to_track(self, x: dict, kind: str | None = None) -> dict:
        arts = [a.get("name") for a in x.get("artists") or [] if a.get("name")]
        arts = [a for a in arts if not re.fullmatch(r"[\d.,]+[KMB]? (views|plays)", a or "")]
        thumbs = x.get("thumbnails") or x.get("thumbnail") or []
        art = thumbs[-1]["url"] if thumbs else None
        if art and "=w" in art:
            art = re.sub(r"=w\d+-h\d+", "=w240-h240", art)
        vtype = x.get("videoType") or ""
        dur = x.get("duration_seconds") or _secs(x.get("duration") or x.get("length"))
        album = (x.get("album") or {}).get("name") if isinstance(x.get("album"), dict) else None
        vid = x["videoId"]
        rel = release(x.get("year"), "release", "YouTube Music") if x.get("year") else None
        return make_track(
            provider="ytmusic", platform_id=vid, title=x.get("title") or "", artists=arts or ["Unknown artist"], album=album,
            duration=dur, artwork=art, url=f"https://music.youtube.com/watch?v={vid}", rel=rel,
            artist_ids={"ytmusic": next((a.get("id") for a in x.get("artists") or [] if a.get("id")), None) or ""},
            explicit=x.get("isExplicit"),
            kind=kind or ("song" if vtype in ("MUSIC_VIDEO_TYPE_ATV", "MUSIC_VIDEO_TYPE_OMV", "") else "video"),
            extra={"video_type": vtype},
        )

    def _run(self, meter, fn):
        tok = CURRENT_METER.set(meter)
        try:
            return fn()
        finally:
            CURRENT_METER.reset(tok)

    def search(self, q: str, limit: int = 15, meter=None, token=None) -> list[dict]:
        def run():
            res = self._run(meter, lambda: self.yt.search(q, filter="songs", limit=limit))
            return [self.to_track(x, "song") for x in res if x.get("videoId")][:limit]

        return self.cached(f"yt:search:{fold(q)}:{limit}", "search", 15 * 60, run)

    def song(self, vid: str, meter=None, token=None) -> dict:
        def run():
            try:
                w = self._run(meter, lambda: self.yt.get_watch_playlist(videoId=vid, limit=1))
            except Exception as e:  # noqa: BLE001 - ytmusicapi raises server errors for removed/private videos
                if "No content" in str(e) or "Unable to find" in str(e):
                    raise ProviderError("YouTube has no video at that link, or it is private or removed.") from e
                raise
            tracks = w.get("tracks") or []
            if not tracks:
                raise ProviderError("YouTube Music returned nothing for that video.")
            first = tracks[0]
            if first.get("videoId") != vid:
                raise ProviderError("That video is unavailable on YouTube Music.")
            t = self.to_track(first)
            t["related_browse"] = w.get("related")
            return t

        return self.cached(f"yt:song:{vid}", "track", 7 * 86400, run)

    def resolve_link(self, url: str, meter=None, token=None) -> dict:
        parts = urlsplit(url)
        host = parts.hostname or ""
        qs = parse_qs(parts.query)
        vid = None
        if host == "youtu.be":
            vid = parts.path.strip("/").split("/")[0]
        elif parts.path == "/watch":
            vid = (qs.get("v") or [None])[0]
        elif parts.path.startswith(("/shorts/", "/live/", "/embed/")):
            raise ProviderError("Shorts, live streams and embeds are videos, not songs. Paste a song or music-video link.")
        playlist = (qs.get("list") or [None])[0]
        if not vid and parts.path == "/playlist" and playlist:
            return self.playlist(playlist, meter, token)
        if not vid or not YT_ID.match(vid):
            raise ProviderError("That YouTube link does not point at a single video.")
        t = self.song(vid, meter, token)
        if t["kind"] == "video":
            t = dict(t, warning="YouTube marks this as a user upload, not an official song. It may be a mix, cover or clip.")
        return t

    def playlist(self, pid: str, meter=None, token=None, limit: int = 25) -> dict:
        if pid.startswith(("RD", "LL", "WL")):
            raise ProviderError("Mixes, Liked and Watch Later lists are personal or generated; paste a public playlist or a song.")
        try:
            p = self._run(meter, lambda: self.yt.get_playlist(pid, limit=limit))
        except Exception as e:  # noqa: BLE001
            raise ProviderError("That playlist is private, empty or not available without signing in.") from e
        tracks = [self.to_track(x) for x in (p.get("tracks") or []) if x.get("videoId")][:limit]
        raise NeedsChoice("playlist", f"“{p.get('title')}” is a playlist. Choose the songs you want from it.",
                          {"title": p.get("title"), "count": p.get("trackCount"), "tracks": tracks, "bounded": limit})

    def radio(self, vid: str, limit: int, meter=None, token=None) -> list[dict]:
        def run():
            w = self._run(meter, lambda: self.yt.get_watch_playlist(videoId=vid, limit=limit))
            return [self.to_track(x) for x in (w.get("tracks") or [])[1:] if x.get("videoId")][:limit]

        return self.cached(f"yt:radio:{vid}:{limit}", "related", 6 * 3600, run)

    def related(self, vid: str, meter=None, token=None) -> dict:
        """'You might also like' songs and 'Similar artists' for a song."""
        def run():
            song = self.song(vid, meter, token)
            browse = song.get("related_browse")
            if not browse:
                w = self._run(meter, lambda: self.yt.get_watch_playlist(videoId=vid, limit=1))
                browse = w.get("related")
            if not browse:
                return {"songs": [], "artists": []}
            sections = self._run(meter, lambda: self.yt.get_song_related(browse))
            songs, artists = [], []
            for s in sections:
                title = (s.get("title") or "").lower()
                contents = s.get("contents") or []
                if title == "you might also like":
                    songs = [self.to_track(x) for x in contents if isinstance(x, dict) and x.get("videoId")]
                elif title == "similar artists":
                    artists = [{"id": x.get("browseId"), "name": x.get("title")} for x in contents if isinstance(x, dict) and x.get("title")]
            return {"songs": songs, "artists": artists}

        return self.cached(f"yt:related:{vid}", "related", 12 * 3600, run)

    def find_match(self, t: dict, meter=None, token=None) -> tuple[dict | None, list[dict]]:
        if t["provider"] == "ytmusic":
            return t, []
        q = f'{t["artists"][0] if t["artists"] else ""} {t["title"]}'.strip()
        uncertain = []
        for r in self.search(q, 8, meter, token):
            v = match_recordings(t, r)
            if v.verdict == "same":
                return r, []
            if v.verdict == "uncertain":
                uncertain.append(dict(r, match_note=v.reason))
        return None, uncertain[:5]

    def playback_link(self, t: dict) -> dict:
        vid = t["platform_id"]
        return {"kind": "embed", "embed": f"https://www.youtube-nocookie.com/embed/{vid}?autoplay=1&rel=0", "open": f"https://music.youtube.com/watch?v={vid}", "label": "Open in YouTube Music"}

    def health_check(self) -> dict[str, Health]:
        out: dict[str, Health] = {}
        t0 = time.perf_counter()
        try:
            res = self.yt.search("daft punk", filter="songs", limit=1)
            vid = next(x["videoId"] for x in res if x.get("videoId"))
            ms = int((time.perf_counter() - t0) * 1000)
            out["search"] = Health("working", "live song search answered", time.time(), ms)
            out["resolve_link"] = out["search"]
            out["playback_link"] = Health("working", "YouTube embed / open link (browser plays it)", time.time(), None)
            t1 = time.perf_counter()
            w = self.yt.get_watch_playlist(videoId=vid, limit=5)
            ok = len(w.get("tracks") or []) > 1
            out["related_candidates"] = Health("working" if ok else "degraded", "radio answered" if ok else "radio empty", time.time(), int((time.perf_counter() - t1) * 1000))
            out["artist_candidates"] = out["related_candidates"]
        except Exception as e:  # noqa: BLE001
            h = Health("unavailable", f"{type(e).__name__}: {str(e)[:100]}", time.time(), None)
            for c in self.capabilities:
                out.setdefault(c, h)
        return out


# ----------------------------------------------------------------------------------------------
# SoundCloud (oEmbed + yt-dlp)
# ----------------------------------------------------------------------------------------------
SC_PATH = re.compile(r"^/([A-Za-z0-9_-]+)/([A-Za-z0-9_-]+)/?$")
SC_RESERVED = {"discover", "stream", "search", "you", "charts", "upload", "settings", "messages", "notifications", "pages", "terms-of-use"}


class SoundCloud(Provider):
    name = "soundcloud"
    label = "SoundCloud"
    capabilities = ("search", "resolve_link", "related_candidates", "playback_link")
    _ydl_lock = threading.Lock()

    def _ydl(self, target: str, flat: bool, limit: int | None = None) -> dict:
        import yt_dlp

        opts: dict[str, Any] = {"quiet": True, "no_warnings": True, "skip_download": True, "noplaylist": True, "socket_timeout": 10, "retries": 1}
        if flat:
            opts["extract_flat"] = "in_playlist"
        if limit:
            opts["playlistend"] = limit
        with self._ydl_lock, yt_dlp.YoutubeDL(opts) as y:
            return y.extract_info(target, download=False)

    def to_track(self, e: dict) -> dict:
        thumbs = [t for t in e.get("thumbnails") or [] if t.get("url")]
        art = next((t["url"] for t in thumbs if t.get("id") in ("t300x300", "large", "t500x500")), thumbs[-1]["url"] if thumbs else None)
        artist = e.get("artist") or e.get("uploader") or ""
        title = e.get("track") or e.get("title") or ""
        # Uploader-only titles are often "Artist - Title"; keep the uploader as artist unless that pattern is explicit.
        m = re.match(r"^(.{1,60}?)\s+[-–—]\s+(.+)$", e.get("title") or "")
        if m and not e.get("artist") and fold(m.group(1)) != fold(title):
            artist, title = m.group(1), m.group(2)
        tags = []
        if e.get("genre"):
            tags.append(genres.make_tag(e["genre"], "SoundCloud uploader genre", "track", 0.6))
        for tg in (e.get("tags") or [])[:6]:
            tags.append(genres.make_tag(tg, "SoundCloud uploader tag", "track", 0.4))
        rel = release(e.get("release_date"), "release", "SoundCloud") or release(e.get("upload_date"), "upload", "SoundCloud")
        if not rel and e.get("timestamp"):
            rel = release(datetime.fromtimestamp(e["timestamp"], tz=timezone.utc).strftime("%Y-%m-%d"), "upload", "SoundCloud")
        url = e.get("webpage_url") or e.get("url") or ""
        return make_track(provider="soundcloud", platform_id=str(e.get("id") or url), title=title, artists=split_artists(artist) and [artist] or ["Unknown artist"],
                          duration=e.get("duration"), artwork=art, url=url, rel=rel, tags=tags,
                          extra={"license": e.get("license")})

    def search(self, q: str, limit: int = 10, meter=None, token=None) -> list[dict]:
        def run():
            r = self._ydl(f"scsearch{limit}:{q}", flat=True)
            return [self.to_track(e) for e in r.get("entries") or [] if e]

        return self.cached(f"sc:search:{fold(q)}:{limit}", "search", 15 * 60, run)

    def resolve_link(self, url: str, meter=None, token=None) -> dict:
        parts = urlsplit(url)
        if parts.hostname == "on.soundcloud.com":
            url = self.http.resolve_redirects(url, meter=meter, token=token)
            validate_url(url)
            parts = urlsplit(url)
        path = parts.path
        if "/sets/" in path:
            raise ProviderError("That is a SoundCloud playlist (set). Paste a link to one track.")
        m = SC_PATH.match(path)
        if not m or m.group(1) in SC_RESERVED or m.group(2) in ("tracks", "likes", "reposts", "albums", "sets", "popular-tracks"):
            raise ProviderError("That SoundCloud link is a profile or page, not a track.")
        clean = f"https://soundcloud.com/{m.group(1)}/{m.group(2)}"

        def run():
            try:
                return self.to_track(self._ydl(clean, flat=False))
            except Exception as e:  # noqa: BLE001
                msg = str(e)
                if "404" in msg or "not found" in msg.lower():
                    raise ProviderError("SoundCloud says that track does not exist or is private.") from e
                raise

        return self.cached(f"sc:track:{clean}", "track", 7 * 86400, run)

    def related(self, t: dict, limit: int, meter=None, token=None) -> list[dict]:
        url = t["url"].rstrip("/")

        def run():
            r = self._ydl(url + "/recommended", flat=True, limit=limit)
            out = []
            for e in (r.get("entries") or [])[:limit]:
                # Flat entries carry only a URL and title; the uploader slug is the honest artist fallback.
                slug = urlsplit(e.get("url") or "").path.strip("/").split("/")[0]
                e = dict(e, webpage_url=e.get("url"), uploader=e.get("uploader") or slug.replace("-", " "), id=e.get("id") or e.get("url"))
                out.append(self.to_track(e))
            return out

        return self.cached(f"sc:related:{url}:{limit}", "related", 12 * 3600, run)

    def playback_link(self, t: dict) -> dict:
        return {"kind": "embed", "embed": "https://w.soundcloud.com/player/?url=" + quote(t["url"], safe="") + "&auto_play=true&visual=false&show_comments=false",
                "open": t["url"], "label": "Open in SoundCloud"}

    def health_check(self) -> dict[str, Health]:
        out: dict[str, Health] = {}
        t0 = time.perf_counter()
        try:
            d = self.http.get_json("https://soundcloud.com/oembed?format=json&url=https://soundcloud.com/forss/flickermood", max_bytes=100_000, retries=0)
            out["playback_link"] = Health("working" if d.get("html") else "degraded", "oEmbed/widget answered", time.time(), int((time.perf_counter() - t0) * 1000))
        except Exception as e:  # noqa: BLE001
            out["playback_link"] = Health("unavailable", str(e)[:120], time.time(), None)
        t1 = time.perf_counter()
        try:
            r = self._ydl("scsearch1:flickermood forss", flat=True)
            ok = bool(r.get("entries"))
            out["search"] = Health("working" if ok else "degraded", "yt-dlp SoundCloud search answered (client id obtained by yt-dlp)", time.time(), int((time.perf_counter() - t1) * 1000))
        except Exception as e:  # noqa: BLE001
            out["search"] = Health("unavailable", f"yt-dlp: {str(e)[:110]}", time.time(), None)
        out["resolve_link"] = Health(out["search"].state, "track pages resolved through yt-dlp", time.time(), out["search"].latency_ms)
        out["related_candidates"] = Health(out["search"].state, "track /recommended through yt-dlp (checked with search)", time.time(), None)
        return out


# ----------------------------------------------------------------------------------------------
# Spotify (public oEmbed only)
# ----------------------------------------------------------------------------------------------
SP_TRACK = re.compile(r"^/(?:intl-[a-z]{2}(?:-[A-Za-z]{2})?/)?(track|album|playlist|artist|episode|show)/([A-Za-z0-9]{22})")


class Spotify(Provider):
    name = "spotify"
    label = "Spotify"
    capabilities = ("resolve_link", "playback_link")

    def resolve_link(self, url: str, meter=None, token=None) -> dict:
        parts = urlsplit(url)
        if parts.hostname in ("spotify.link", "spotify.app.link"):
            url = self.http.resolve_redirects(url, meter=meter, token=token)
            parts = urlsplit(url)
            if parts.hostname != "open.spotify.com":
                raise ProviderError("That Spotify short link did not lead to a Spotify page.")
        m = SP_TRACK.match(parts.path)
        if not m:
            raise ProviderError("That Spotify link is not a track link.")
        kind, sid = m.groups()
        if kind != "track":
            raise ProviderError(f"That is a Spotify {kind}. Spotify's public oEmbed does not list its tracks; paste a track link instead.")

        def run():
            try:
                d = self.http.get_json(f"https://open.spotify.com/oembed?url=https://open.spotify.com/track/{sid}", meter=meter, token=token, max_bytes=100_000)
            except FetchError as e:
                if str(e).startswith(("HTTP 404", "HTTP 400")):
                    raise ProviderError("Spotify has no track at that link, or it is not available in public.") from e
                raise
            if not d.get("title"):
                raise ProviderError("Spotify did not identify that track (it may be unavailable).")
            return make_track(provider="spotify", platform_id=sid, title=d["title"], artists=[d["author_name"]] if d.get("author_name") else [],
                              artwork=d.get("thumbnail_url"), url=f"https://open.spotify.com/track/{sid}",
                              extra={"incomplete": not d.get("author_name"), "embed_url": d.get("iframe_url")})

        return self.cached(f"sp:track:{sid}", "track", 7 * 86400, run)

    def playback_link(self, t: dict) -> dict:
        return {"kind": "embed", "embed": f"https://open.spotify.com/embed/track/{t['platform_id']}", "open": t["url"], "label": "Open in Spotify"}

    def health_check(self) -> dict[str, Health]:
        t0 = time.perf_counter()
        try:
            d = self.http.get_json("https://open.spotify.com/oembed?url=https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b", max_bytes=100_000, retries=0)
            h = Health("working" if d.get("title") else "degraded", "oEmbed answered (title + artwork, no artist)", time.time(), int((time.perf_counter() - t0) * 1000))
        except Exception as e:  # noqa: BLE001
            h = Health("unavailable", str(e)[:120], time.time(), None)
        return {"resolve_link": h, "playback_link": h}


class SpicetifyCompanion:
    """Optional bridge for https://github.com/spicetify/cli: a Spicetify extension could POST the
    currently playing Spotify track (uri, title, artists, duration, ISRC when present) to
    `/api/companion/spicetify/now-playing` so it can be offered as a seed.

    Not implemented: Spotify desktop with Spicetify is not installed in this environment, so it
    cannot be tested, and an untested bridge is not shipped as working. The core demo does not
    depend on it.
    """

    state = "not_tested"


# ----------------------------------------------------------------------------------------------
# Link routing
# ----------------------------------------------------------------------------------------------
def provider_for_url(url: str) -> str:
    host = (urlsplit(url).hostname or "").lower()
    if host.endswith("deezer.com") or host == "deezer.page.link":
        return "deezer"
    if host in ("open.spotify.com", "spotify.link", "spotify.app.link"):
        return "spotify"
    if host.endswith("soundcloud.com"):
        return "soundcloud"
    if host in ("youtu.be", "www.youtube.com", "youtube.com", "m.youtube.com", "music.youtube.com"):
        return "ytmusic"
    raise BlockedUrl("Paste a Spotify, SoundCloud, YouTube, YouTube Music or Deezer link.")


def looks_like_url(text: str) -> bool:
    t = text.strip()
    return bool(re.match(r"^(https?://)?([a-z0-9-]+\.)+[a-z]{2,}(/|$)", t, re.I)) and " " not in t


def normalise_url(text: str) -> str:
    t = text.strip()
    if not re.match(r"^https?://", t, re.I):
        t = "https://" + t
    if t.lower().startswith("http://"):
        t = "https://" + t[7:]
    validate_url(t)
    return t


def today() -> date:
    return datetime.now(timezone.utc).date()
