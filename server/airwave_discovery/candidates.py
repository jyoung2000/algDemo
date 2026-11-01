"""Candidate generation, enrichment and audio refinement for one recommendation request.

Phase 1 (metadata): enrich seeds, ask each provider for the candidates it really offers, merge
duplicates, score and select. Phase 2 (refine): fill in genres/BPM for the leading candidates,
then embed the seeds and at most `audio_candidates_per_request` uncached candidates on a single
worker, re-score and select again. Both phases publish their result; the UI keeps its focus and
playback while the second one lands.
"""

from __future__ import annotations

import logging
import math
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import date

import numpy as np

from . import audio as A
from . import engine as E
from .config import DEFAULT_ENGINE, TRANSFER, EngineConfig
from .identity import fold, match_recordings, parse_title, split_artists
from .net import BudgetExceeded, Cancelled, CancelToken, FetchError, Http, Meter
from .providers import CURRENT_METER, Deezer, Provider, ProviderError, SoundCloud, YouTubeMusic, today
from .store import Store

SOURCE_LABELS = {
    "ytmusic-related": "YouTube Music · You might also like",
    "ytmusic-radio": "YouTube Music · radio",
    "ytmusic-similar-artists": "YouTube Music · similar artists",
    "deezer-artist-radio": "Deezer · artist radio",
    "deezer-related-artists": "Deezer · related artists",
    "deezer-artist-top": "Deezer · artist top tracks",
    "deezer-recent": "Deezer · recent releases",
    "deezer-genre-chart": "Deezer · genre chart (exploration)",
    "soundcloud-recommended": "SoundCloud · recommended",
}


@dataclass
class Job:
    id: str
    token: CancelToken = field(default_factory=CancelToken)
    phase: str = "starting"
    progress: str = ""
    result: dict | None = None
    error: str | None = None
    started: float = field(default_factory=time.time)
    timings: dict = field(default_factory=dict)
    sources: dict = field(default_factory=dict)
    audio: dict = field(default_factory=dict)
    meter: Meter | None = None
    done: bool = False


class Pipeline:
    def __init__(self, store: Store, http: Http, deezer: Deezer, ytm: YouTubeMusic, sc: SoundCloud, encoder: A.Encoder) -> None:
        self.store = store
        self.http = http
        self.dz = deezer
        self.ytm = ytm
        self.sc = sc
        self.encoder = encoder
        self.audio_lock = threading.Lock()  # one encoder worker for every request

    # ---------------------------------------------------------------------------------------
    def _meter(self, settings: dict) -> Meter:
        daily = int(settings.get("daily_mb", TRANSFER.daily / 1e6) * 1e6)
        per_req = int(settings.get("request_mb", TRANSFER.per_request / 1e6) * 1e6)
        used = sum(self.store.transfer_today().values())
        return Meter(per_req, max(0, daily - used), sink=self.store.add_transfer)

    def _call(self, job: Job, label: str, fn, default):
        job.token.check()
        t = time.perf_counter()
        tok = CURRENT_METER.set(job.meter)
        try:
            out = fn()
            job.sources[label] = {"state": "ok", "count": len(out) if hasattr(out, "__len__") else None, "ms": int((time.perf_counter() - t) * 1000)}
            return out
        except Cancelled:
            raise
        except BudgetExceeded as e:
            job.sources[label] = {"state": "budget", "detail": str(e), "ms": int((time.perf_counter() - t) * 1000)}
            return default
        except (FetchError, ProviderError, Exception) as e:  # noqa: BLE001 - degrade, never fabricate
            if not isinstance(e, (FetchError, ProviderError)):
                # A provider outage degrades quietly; a bug in our own code should leave a traceback.
                logging.getLogger("airwave").exception("source %s raised", label)
            job.sources[label] = {"state": "failed", "detail": f"{type(e).__name__}: {str(e)[:140]}", "ms": int((time.perf_counter() - t) * 1000)}
            return default
        finally:
            CURRENT_METER.reset(tok)

    # ---------------------------------------------------------------------------------------
    def profile_seed(self, job: Job, seed: dict) -> dict:
        """Find the seed on Deezer (preview, ISRC, BPM, album genres) and YouTube Music (radio)."""
        cached = self.store.cache_get(f"seedprofile:{seed['id']}")
        if cached:
            return cached["value"]
        m = job.meter
        prof = {"dz": None, "ytm_vid": None, "dz_uncertain": []}
        if seed["provider"] == "deezer":
            prof["dz"] = self._call(job, f"seed-deezer:{seed['title']}", lambda: self.dz.with_genres(self.dz.track(seed["platform_id"], m, job.token), m, job.token), None)
        else:
            res = self._call(job, f"seed-deezer-match:{seed['title']}", lambda: self.dz.find_match(seed, m, job.token), (None, []))
            if res[0] is not None:
                full = self._call(job, f"seed-deezer:{seed['title']}", lambda: self.dz.with_genres(self.dz.track(res[0]["platform_id"], m, job.token), m, job.token), None)
                prof["dz"] = full or res[0]
            prof["dz_uncertain"] = [u["title"] for u in res[1]]
        if seed["provider"] == "ytmusic":
            prof["ytm_vid"] = seed["platform_id"]
        else:
            res = self._call(job, f"seed-ytm-match:{seed['title']}", lambda: self.ytm.find_match(seed, m, job.token), (None, []))
            if res[0] is not None:
                prof["ytm_vid"] = res[0]["platform_id"]
        self.store.cache_put(f"seedprofile:{seed['id']}", "seed", prof, 86400)
        return prof

    def seed_view(self, seed: dict, prof: dict) -> dict:
        """The seed as the engine sees it: its own identity with Deezer's tags/BPM when matched."""
        s = dict(seed)
        dz = prof.get("dz")
        if dz:
            s["tags"] = s.get("tags") or dz.get("tags") or []
            s["bpm"] = s.get("bpm") or dz.get("bpm")
            s["isrc"] = s.get("isrc") or dz.get("isrc")
            s["dz_preview_id"] = dz["platform_id"]
        return s

    # ---------------------------------------------------------------------------------------
    def gather(self, job: Job, seeds: list[dict], profiles: dict[str, dict], cfg: EngineConfig, fresh: bool) -> tuple[list[dict], dict[str, set[str]]]:
        n = max(1, len(seeds))
        per_seed = max(6, math.ceil(cfg.per_source_cap / n))
        m = job.meter
        tasks: list[tuple[str, str, callable]] = []
        related_names: dict[str, set[str]] = {s["key"]: set() for s in seeds}

        def add(source: str, seed: dict, fn):
            tasks.append((source, seed["key"], fn))

        for s in seeds:
            prof = profiles[s["key"]]
            vid = prof.get("ytm_vid")
            dz = prof.get("dz")
            if vid:
                add("ytmusic-related", s, lambda vid=vid: [(t, "related_song", None) for t in self.ytm.related(vid, m, job.token)["songs"]])
                add("ytmusic-radio", s, lambda vid=vid: [(t, "radio", None) for t in self.ytm.radio(vid, per_seed + 1, m, job.token)])
            if s["provider"] == "soundcloud":
                add("soundcloud-recommended", s, lambda s=s: [(t, "sc_recommended", None) for t in self.sc.related(s, min(per_seed, 20), m, job.token)])
            dz_artist = (dz or {}).get("artist_ids", {}).get("deezer")
            if dz_artist:
                add("deezer-artist-radio", s, lambda a=dz_artist: [(t, "artist_radio", None) for t in self.dz.artist_radio(a, per_seed, m, job.token)])
                add("deezer-artist-top", s, lambda a=dz_artist: [(t, "seed_artist_top", None) for t in self.dz.artist_top(a, 5, m, job.token)])
                k = 6 if fresh else 4
                add("deezer-related-artists", s, lambda a=dz_artist, k=k: self._related_artist_tracks(a, k, m, job))
                add("deezer-recent", s, lambda a=dz_artist: self._recent(a, 6 if fresh else 3, cfg, m, job))

        # exploration pool from the seeds' own platform-stated genres
        tag_names = []
        for s in seeds:
            dz = profiles[s["key"]].get("dz") or {}
            for g in dz.get("tags") or []:
                if g["name"] not in tag_names:
                    tag_names.append((g["name"], s))
        if tag_names:
            ids = self._call(job, "deezer-genre-ids", lambda: self.dz.genre_ids(m, job.token), {})
            for name, s in tag_names[:2]:
                gid = ids.get(name)
                if gid:
                    add("deezer-genre-chart", s, lambda gid=gid, name=name: [(t, "genre_chart", name) for t in self.dz.genre_chart(gid, 10, m, job.token)])

        # similar-artist names from YT Music feed the artist factor
        for s in seeds:
            vid = profiles[s["key"]].get("ytm_vid")
            if vid:
                tasks.append(("ytmusic-similar-artists", s["key"], lambda vid=vid: [("artist", a["name"]) for a in self.ytm.related(vid, m, job.token)["artists"]]))

        results: dict[str, dict[str, list]] = {}

        def run(task):
            source, seed_key, fn = task
            out = self._call(job, f"{source}:{seed_key.split('|')[1][:30]}", fn, [])
            return source, seed_key, out

        with ThreadPoolExecutor(max_workers=4) as ex:
            for source, seed_key, out in ex.map(run, tasks):
                if source == "ytmusic-similar-artists":
                    for _, name in out:
                        related_names[seed_key].add(fold(name))
                    continue
                results.setdefault(source, {}).setdefault(seed_key, []).extend(out)

        # per-source cap, filled round-robin across seeds so the first seed cannot dominate
        merged: dict[str, dict] = {}
        order: list[str] = []
        for source, by_seed in results.items():
            lists = [by_seed.get(s["key"], []) for s in seeds]
            taken = 0
            i = 0
            while taken < cfg.per_source_cap and any(i < len(lst) for lst in lists):
                for si, lst in enumerate(lists):
                    if i < len(lst) and taken < cfg.per_source_cap:
                        t, relation, via = lst[i]
                        if relation == "related_artist_top":
                            related_names[seeds[si]["key"]].add(fold(t["artists"][0]))
                        self._merge(merged, order, t, {"seed": seeds[si]["key"], "relation": relation, "rank": i, "source": source, "via": via})
                        taken += 1
                i += 1
        cands = [merged[k] for k in order]
        cands = [c for c in cands if c.get("kind") != "video"]  # user uploads / mixes are not songs
        return cands[: cfg.merged_cap], related_names

    def _related_artist_tracks(self, artist_id: str, k: int, m: Meter, job: Job) -> list:
        out = []
        for a in self.dz.related_artists(artist_id, k, m, job.token)[:k]:
            job.token.check()
            for i, t in enumerate(self.dz.artist_top(a["id"], 3, m, job.token)):
                out.append((t, "related_artist_top", a["name"]))
        return out

    def _recent(self, artist_id: str, k: int, cfg: EngineConfig, m: Meter, job: Job) -> list:
        """Albums released inside the rolling window by the seed artist and its related artists."""
        now = today()
        artists = [{"id": artist_id, "name": None}] + self.dz.related_artists(artist_id, k, m, job.token)[:k]
        out = []
        for a in artists:
            job.token.check()
            for alb in self.dz.recent_albums(a["id"], 5, m, job.token):
                rd = alb.get("release_date") or ""
                try:
                    age = (now - date.fromisoformat(rd)).days
                except ValueError:
                    continue
                if not (-7 <= age <= cfg.new_release_days):
                    continue
                full = self.dz.album(alb["id"], m, job.token)
                for t in full.get("tracks", [])[:3]:
                    if not t.get("readable", True):
                        continue
                    tr = self.dz.to_track(t, album=full)
                    out.append((tr, "recent", a.get("name")))
        return out

    @staticmethod
    def _merge(merged: dict, order: list, t: dict, prov: dict) -> None:
        key = t["key"]
        existing = merged.get(key)
        if existing is not None:
            v = match_recordings(existing, t)
            if v.verdict == "different":
                key = f"{key}#{t['provider']}:{t['platform_id']}"
                existing = merged.get(key)
        if existing is None:
            c = dict(t)
            c["key"] = key
            c["provenance"] = [prov]
            c["links"] = {t["provider"]: {"url": t["url"], "id": t["platform_id"]}}
            merged[key] = c
            order.append(key)
            return
        if not any(p["seed"] == prov["seed"] and p["relation"] == prov["relation"] for p in existing["provenance"]):
            existing["provenance"].append(prov)
        existing["links"].setdefault(t["provider"], {"url": t["url"], "id": t["platform_id"]})
        for f in ("preview", "bpm", "isrc", "duration", "artwork", "album"):
            if not existing.get(f) and t.get(f):
                existing[f] = t[f]
        if not existing.get("tags") and t.get("tags"):
            existing["tags"] = t["tags"]
        r_new, r_old = t.get("release"), existing.get("release")
        rank = {"day": 3, "month": 2, "year": 1}
        if r_new and (not r_old or rank.get(r_new["precision"], 0) > rank.get(r_old["precision"], 0)):
            existing["release"] = r_new
        if t["provider"] == "deezer":
            existing.setdefault("dz_id", t["platform_id"])

    # ---------------------------------------------------------------------------------------
    def enrich(self, job: Job, cands: list[dict], limit: int = 40) -> None:
        """Deezer details for the leading candidates: confident match, BPM, ISRC, album genres."""
        m = job.meter

        def one(c):
            if job.token.cancelled:
                return
            if "deezer" not in c["links"]:
                res = self._call(job, f"match:{c['title'][:24]}", lambda: self.dz.find_match(c, m, job.token), (None, []))
                if res[0] is None:
                    return
                c["links"]["deezer"] = {"url": res[0]["url"], "id": res[0]["platform_id"]}
            did = c["links"]["deezer"]["id"]
            full = self._call(job, f"detail:{c['title'][:24]}", lambda: self.dz.with_genres(self.dz.track(did, m, job.token), m, job.token), None)
            if not full:
                return
            for f in ("preview", "bpm", "isrc", "artwork"):
                if not c.get(f) and full.get(f):
                    c[f] = full[f]
            if not c.get("tags") and full.get("tags"):
                c["tags"] = full["tags"]
            if full.get("release") and (not c.get("release") or c["release"]["precision"] != "day"):
                c["release"] = full["release"]
            c["dz_id"] = did

        with ThreadPoolExecutor(max_workers=3) as ex:
            list(ex.map(one, cands[:limit]))

    # ---------------------------------------------------------------------------------------
    def vector_for(self, job: Job, rec_key: str, dz_id: str | None, preview: str | None) -> np.ndarray | None:
        if not dz_id:
            return None
        vkey = f"deezer:{dz_id}"
        v = self.store.vector_get(vkey, A.MODEL_ID, A.PREPROCESS_ID)
        if v is not None:
            job.audio["cached"] = job.audio.get("cached", 0) + 1
            return v
        if not preview:
            return None
        return self._embed_preview(job, vkey, dz_id, preview)

    def _embed_preview(self, job: Job, vkey: str, dz_id: str, preview: str) -> np.ndarray | None:
        job.token.check()
        t0 = time.perf_counter()
        try:
            # Preview URLs are signed for ~15 minutes but track metadata is cached for days: re-sign first.
            url = self.dz.fresh_preview(dz_id, preview, job.meter, job.token)
            if not url:
                raise FetchError("Deezer no longer offers a preview for this track")
            resp, data = self.http.get(url, max_bytes=TRANSFER.per_audio_file, meter=job.meter, category="audio", token=job.token, retries=1)
            if resp.status_code >= 400:
                # an expired or refused signature answers with a small HTML page; never decode that as audio
                raise FetchError(f"preview HTTP {resp.status_code}")
        except BudgetExceeded as e:
            job.audio["budget_stops"] = job.audio.get("budget_stops", 0) + 1
            job.audio["last_budget"] = str(e)
            raise
        except (FetchError, ProviderError) as e:
            job.audio["failed"] = job.audio.get("failed", 0) + 1
            job.audio.setdefault("errors", []).append(str(e)[:120])
            return None
        dl_ms = (time.perf_counter() - t0) * 1000
        try:
            y = A.trim_silence(A.decode(data))
            del data  # audio is decoded in memory and never written to disk
            if len(y) < A.SR * 5:
                job.audio["too_short"] = job.audio.get("too_short", 0) + 1
                return None
            with self.audio_lock:
                job.token.check()
                r = self.encoder.embed_audio(y)
        except Cancelled:
            raise
        except Exception as e:  # noqa: BLE001
            job.audio["failed"] = job.audio.get("failed", 0) + 1
            job.audio.setdefault("errors", []).append(f"{type(e).__name__}: {str(e)[:100]}")
            return None
        finally:
            y = None
        self.store.vector_put(vkey, A.MODEL_ID, A.PREPROCESS_ID, r.vector, "deezer-preview-30s")
        job.audio["embedded"] = job.audio.get("embedded", 0) + 1
        job.audio.setdefault("infer_ms", []).append(round(r.infer_ms))
        job.audio.setdefault("download_ms", []).append(round(dl_ms))
        return r.vector
