"""FastAPI app: search/resolve, seeds, recommendation jobs, feedback, status, settings, model setup.

Bound to 127.0.0.1 by default (config.HOST). Serves the built web app from web/dist.
"""

from __future__ import annotations

import hashlib
import json
import logging
import logging.handlers
import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import audio as A
from . import engine as E
from .budget import FOOTPRINT, OverBudget, ensure_room
from .candidates import SOURCE_LABELS, Job, Pipeline
from .config import DATA_DIR, DEFAULT_ENGINE, LOG_DIR, MODELS_DIR, TRANSFER, WEB_DIST, engine_with_weights
from .identity import match_recordings
from .net import BlockedUrl, BudgetExceeded, Cancelled, CancelToken, FetchError, Http, Meter
from .providers import (CURRENT_METER, Deezer, NeedsChoice, ProviderError, SoundCloud, Spotify, SpicetifyCompanion,
                        YouTubeMusic, looks_like_url, normalise_url, provider_for_url, today)
from .queue import DISCOVERED, ListeningQueue, QueueError
from .store import DiskFull, Store

STARTED = time.perf_counter()
LOG_DIR.mkdir(parents=True, exist_ok=True)
log = logging.getLogger("airwave")
if not log.handlers:
    h = logging.handlers.RotatingFileHandler(LOG_DIR / "server.log", maxBytes=5_000_000, backupCount=3, encoding="utf-8")
    h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    log.addHandler(h)
    log.setLevel(logging.INFO)

DEFAULT_SETTINGS = {"fresh": False, "adventurous": 0.5, "audio": True, "daily_mb": TRANSFER.daily / 1e6, "request_mb": TRANSFER.per_request / 1e6, "sample_mode": False, "rank_v2": True}
TRACK_FIELDS = ("id", "provider", "platform_id", "key", "title", "artists", "artist", "album", "version", "versions", "duration", "artwork", "url",
                "isrc", "release", "tags", "preview", "explicit", "bpm", "kind", "warning", "incomplete", "embed_url", "artist_ids", "album_id")


def clean_track(t: dict) -> dict:
    out = {k: t.get(k) for k in TRACK_FIELDS if t.get(k) is not None}
    if out.get("preview"):
        out["preview"] = preview_route(t)
    return out


def preview_route(t: dict) -> str | None:
    """Deezer preview URLs are signed for ~15 minutes, longer than tracks stay cached. The browser gets a
    local route that re-signs on demand and redirects to Deezer's CDN; audio never passes through us."""
    did = t.get("dz_id") or t.get("dz_preview_id") or (t.get("platform_id") if t.get("provider") == "deezer" else None)
    if did and str(did).isdigit():
        return f"/api/preview/deezer/{did}"
    return t.get("preview")


class State:
    def __init__(self) -> None:
        self.store = Store()
        self.http = Http()
        self.dz = Deezer(self.http, self.store)
        self.ytm = YouTubeMusic(self.http, self.store)
        self.sc = SoundCloud(self.http, self.store)
        self.sp = Spotify(self.http, self.store)
        self.providers = {"deezer": self.dz, "ytmusic": self.ytm, "soundcloud": self.sc, "spotify": self.sp}
        self.encoder = A.Encoder()
        self.pipeline = Pipeline(self.store, self.http, self.dz, self.ytm, self.sc, self.encoder)
        self.jobs: dict[str, Job] = {}
        self.current_job: str | None = None
        self.health: dict = {}
        self.health_at = 0.0
        self.health_lock = threading.Lock()
        self.audio_check: dict = {"state": "not_tested"}
        self.timings: dict[str, list[float]] = {}
        self.queue = ListeningQueue(self.store.get("queue"))
        self.queue_lock = threading.Lock()  # one discovery run at a time for the listener's queue
        self.queue_job: str | None = None

    def settings(self) -> dict:
        stored = dict(self.store.get("settings", {}) or {})
        if "mode" in stored:  # the old three-way choice: "new" becomes the new-releases switch, "similar" a low slider
            old = stored.pop("mode")
            stored.setdefault("fresh", old == "new")
            if old == "similar":
                stored["adventurous"] = min(float(stored.get("adventurous", 0.5)), 0.25)
        s = dict(DEFAULT_SETTINGS)
        s.update(stored)
        return s

    def time(self, name: str, ms: float) -> None:
        xs = self.timings.setdefault(name, [])
        xs.append(round(ms, 1))
        del xs[:-50]


S: State | None = None


def st() -> State:
    assert S is not None
    return S


app = FastAPI(title="Airwave Discovery (local demo)", docs_url="/api/docs", openapi_url="/api/openapi.json")


@app.on_event("startup")
def _startup() -> None:
    global S
    S = State()
    S.store.expire_impressions(time.time() - DEFAULT_ENGINE.exposure_window_days * 86400 * 4)
    threading.Thread(target=refresh_health, daemon=True).start()
    S.startup_ms = (time.perf_counter() - STARTED) * 1000
    log.info("started in %.0f ms", S.startup_ms)


@app.on_event("shutdown")
def _shutdown() -> None:
    if S:
        for j in S.jobs.values():
            j.token.cancel("server stopping")
        S.store.close()


@app.exception_handler(DiskFull)
def _disk(_: Request, e: DiskFull):
    return JSONResponse({"error": "disk_full", "message": f"Not saved: {e}. Free some disk space and try again."}, status_code=507)


# ---------------------------------------------------------------------------------------------
# health / capabilities
# ---------------------------------------------------------------------------------------------
def refresh_health() -> dict:
    s = st()
    with s.health_lock:
        out = {}
        with ThreadPoolExecutor(max_workers=4) as ex:
            futs = {name: ex.submit(p.health_check) for name, p in s.providers.items()}
            for name, f in futs.items():
                try:
                    out[name] = {c: vars(h) for c, h in f.result(timeout=40).items()}
                except Exception as e:  # noqa: BLE001
                    out[name] = {c: {"state": "unavailable", "detail": str(e)[:120], "checked": time.time(), "latency_ms": None} for c in s.providers[name].capabilities}
        for name, p in s.providers.items():
            for c in ("search", "resolve_link", "related_candidates", "artist_candidates", "recent_candidates", "playback_link"):
                if c not in p.capabilities:
                    out[name][c] = {"state": "unsupported", "detail": "this provider offers no keyless way to do this", "checked": time.time(), "latency_ms": None}
        out["spicetify"] = {"companion": {"state": SpicetifyCompanion.state, "detail": "Optional Spotify desktop bridge; not installed here, so not tested and not enabled.", "checked": time.time(), "latency_ms": None}}
        s.health = out
        s.health_at = time.time()
        return out


@app.get("/api/health")
def health(refresh: bool = False):
    s = st()
    if refresh or not s.health or time.time() - s.health_at > 600:
        refresh_health()
    return {"providers": s.health, "checked_at": s.health_at, "audio": audio_state()}


def audio_state() -> dict:
    s = st()
    return {
        "model": A.MODEL_ID, "preprocess": A.PREPROCESS_ID, "dim": A.DIM, "installed": s.encoder.installed(),
        "download_bytes": A.MODEL_DOWNLOAD_BYTES, "source": "Deezer 30-second previews", "license": "AGPL-3.0 (AudioMuse-AI-DCLAP)",
        "check": s.audio_check, "vectors": s.store.vector_count(),
    }


# ---------------------------------------------------------------------------------------------
# search / resolve
# ---------------------------------------------------------------------------------------------
def _search_meter(s: State) -> Meter:
    settings = s.settings()
    daily = int(settings["daily_mb"] * 1e6)
    return Meter(3_000_000, max(0, daily - sum(s.store.transfer_today().values())), sink=s.store.add_transfer)


def _dedupe(lists: list[list[dict]]) -> list[dict]:
    out: list[dict] = []
    for lst in lists:
        for t in lst:
            dup = next((o for o in out if o["key"] == t["key"] and match_recordings(o, t).verdict == "same"), None)
            if dup:
                dup.setdefault("also_on", []).append({"provider": t["provider"], "url": t["url"], "id": t["platform_id"]})
                continue
            out.append(t)
    return out


@app.get("/api/search")
def search(q: str, sources: str = "ytmusic,deezer", limit: int = 12):
    s = st()
    q = q.strip()[:200]
    if not q:
        return {"query": q, "results": [], "sources": {}}
    if looks_like_url(q):
        return resolve({"url": q})
    t0 = time.perf_counter()
    meter = _search_meter(s)
    wanted = [x for x in sources.split(",") if x in ("ytmusic", "deezer", "soundcloud")] or ["ytmusic"]
    limit = max(1, min(25, limit))
    status: dict = {}

    def run(name):
        tok = CURRENT_METER.set(meter)
        t = time.perf_counter()
        try:
            res = s.providers[name].search(q, limit, meter)
            status[name] = {"state": "ok", "count": len(res), "ms": int((time.perf_counter() - t) * 1000)}
            return res
        except Exception as e:  # noqa: BLE001
            status[name] = {"state": "failed", "detail": f"{type(e).__name__}: {str(e)[:120]}", "ms": int((time.perf_counter() - t) * 1000)}
            return []
        finally:
            CURRENT_METER.reset(tok)

    with ThreadPoolExecutor(max_workers=3) as ex:
        lists = list(ex.map(run, wanted))
    results = [clean_track(t) | {"also_on": t.get("also_on", [])} for t in _dedupe(lists)]
    ms = (time.perf_counter() - t0) * 1000
    s.time("search", ms)
    return {"query": q, "results": results, "sources": status, "ms": round(ms), "bytes": meter.total}


@app.post("/api/resolve")
def resolve(body: dict):
    s = st()
    raw = str(body.get("url", ""))[:2000]
    t0 = time.perf_counter()
    meter = _search_meter(s)
    try:
        try:
            url = normalise_url(raw)
            name = provider_for_url(url)
        except BlockedUrl:
            raise
        except ValueError:
            # Not a web link at all; only this parsing step is treated as "not a link".
            return JSONResponse(
                {"kind": "error", "error": "unresolved", "message": "That does not look like a music link. Search for the song by name instead."},
                status_code=422,
            )
        tok = CURRENT_METER.set(meter)
        try:
            track = s.providers[name].resolve_link(url, meter)
        finally:
            CURRENT_METER.reset(tok)
    except NeedsChoice as e:
        p = dict(e.payload)
        p["tracks"] = [clean_track(t) for t in p.get("tracks", [])]
        return {"kind": "choice", "choice": e.kind, "message": str(e), **p}
    except BlockedUrl as e:
        return JSONResponse({"kind": "error", "error": "blocked", "message": str(e)}, status_code=400)
    except (ProviderError, FetchError) as e:
        return JSONResponse({"kind": "error", "error": "unresolved", "message": str(e)}, status_code=422)
    except Exception as e:  # noqa: BLE001
        log.exception("resolve failed")
        return JSONResponse({"kind": "error", "error": "unresolved", "message": f"Could not read that link ({type(e).__name__})."}, status_code=422)
    out = {"kind": "track", "track": clean_track(track), "ms": round((time.perf_counter() - t0) * 1000)}
    if track.get("incomplete") or not track.get("artists"):
        # Spotify oEmbed names the track but not the artist: offer matches the user can choose from.
        tok = CURRENT_METER.set(meter)
        try:
            options = s.dz.search(track["title"], 6, meter) + s.ytm.search(track["title"], 6, meter)
        except Exception:  # noqa: BLE001
            options = []
        finally:
            CURRENT_METER.reset(tok)
        out = {"kind": "choice", "choice": "artist", "message": f"Spotify identified “{track['title']}” but not its artist. Pick the matching song or type the artist.",
               "track": clean_track(track), "tracks": [clean_track(t) for t in _dedupe([options])][:10]}
    elif track.get("warning"):
        out["warning"] = track["warning"]
    return out


@app.post("/api/complete-spotify")
def complete_spotify(body: dict):
    """The user typed the missing artist for a Spotify link: search exactly that, keep the Spotify link."""
    s = st()
    title, artist = str(body.get("title", ""))[:200], str(body.get("artist", ""))[:200]
    meter = _search_meter(s)
    base = {"title": title, "artists": [artist], "duration": None, "version": None}
    tok = CURRENT_METER.set(meter)
    try:
        options = s.dz.search(f"{artist} {title}", 8, meter) + s.ytm.search(f"{artist} {title}", 8, meter)
    finally:
        CURRENT_METER.reset(tok)
    good = [t for t in options if match_recordings(base, t).verdict != "different"]
    return {"tracks": [clean_track(t) for t in _dedupe([good or options])][:10]}


# ---------------------------------------------------------------------------------------------
# seeds / settings
# ---------------------------------------------------------------------------------------------
@app.get("/api/seeds")
def get_seeds():
    return {"seeds": st().store.seeds()}


@app.put("/api/seeds")
def put_seeds(body: dict):
    seeds = body.get("seeds") or []
    if not isinstance(seeds, list):
        raise HTTPException(400, "seeds must be a list.")
    out, keys = [], set()
    for t in seeds:
        if not isinstance(t, dict) or not t.get("key") or not t.get("provider") or not t.get("platform_id"):
            raise HTTPException(400, "Each seed needs a provider, id and key.")
        if t["key"] in keys:
            continue
        keys.add(t["key"])
        c = clean_track(t)
        c["emphasis"] = min(2.0, max(0.5, float(t.get("emphasis", 1.0))))
        out.append(c)
    st().store.set_seeds(out)
    return {"seeds": st().store.seeds()}


@app.get("/api/settings")
def get_settings():
    return st().settings()


@app.put("/api/settings")
def put_settings(body: dict):
    s = st()
    cur = s.settings()
    if "fresh" in body:
        cur["fresh"] = bool(body["fresh"])
    if "adventurous" in body:
        cur["adventurous"] = min(1.0, max(0.0, float(body["adventurous"])))
    for k in ("audio", "sample_mode", "rank_v2"):
        if k in body:
            cur[k] = bool(body[k])
    if "daily_mb" in body:
        cur["daily_mb"] = min(2000.0, max(5.0, float(body["daily_mb"])))
    if "request_mb" in body:
        cur["request_mb"] = min(200.0, max(2.0, float(body["request_mb"])))
    if "weights" in body:
        try:
            engine_with_weights(body["weights"])
        except (ValueError, TypeError) as e:
            raise HTTPException(400, str(e)) from e
        cur["weights"] = body["weights"]
    s.store.put("settings", cur)
    return cur


# ---------------------------------------------------------------------------------------------
# recommendations
# ---------------------------------------------------------------------------------------------
def playback_for(c: dict) -> dict:
    links = c.get("links") or {c["provider"]: {"url": c["url"], "id": c["platform_id"]}}
    out = {"open": [], "preview": preview_route(c) if c.get("preview") else None, "embed": None}
    order = ("ytmusic", "deezer", "soundcloud", "spotify")
    labels = {"ytmusic": "YouTube Music", "deezer": "Deezer", "soundcloud": "SoundCloud", "spotify": "Spotify"}
    for p in order:
        if p in links:
            out["open"].append({"provider": p, "label": f"Open in {labels[p]}", "url": links[p]["url"]})
    if "ytmusic" in links:
        out["embed"] = {"provider": "ytmusic", "url": f"https://www.youtube-nocookie.com/embed/{links['ytmusic']['id']}?autoplay=1&rel=0"}
    elif "soundcloud" in links:
        from urllib.parse import quote

        out["embed"] = {"provider": "soundcloud", "url": "https://w.soundcloud.com/player/?url=" + quote(links["soundcloud"]["url"], safe="") + "&auto_play=true&visual=false"}
    return out


def serialise(scored: list[E.Scored], ctx: E.Context, phase: str, job: Job) -> dict:
    seeds = {s["key"]: s for s in ctx.seeds}
    items = []
    for i, x in enumerate(scored):
        c = x.track
        items.append({
            "rank": i + 1, "track": clean_track(c), "score": round(x.final, 4), "coverage": round(x.coverage, 2), "tier": x.tier,
            "evidence": "strong" if x.coverage >= 0.6 else "moderate" if x.coverage >= 0.35 else "thin",
            "best_seed": {"key": x.best_seed, "title": seeds[x.best_seed]["title"], "artist": seeds[x.best_seed]["artist"]} if x.best_seed in seeds else None,
            "reasons": x.reasons, "uncertainty": x.uncertainty, "new_release": x.new_release,
            "factors": {k: (round(v, 3) if isinstance(v, float) else v) for k, v in x.factors.items()},
            "weights": {k: round(v, 3) for k, v in x.weights_used.items()},
            "sources": sorted({SOURCE_LABELS.get(p["source"], p["source"]) for p in c.get("provenance") or []}),
            "playback": playback_for(c),
        })
    audio = dict(job.audio)
    return {"phase": phase, "items": items, "count": len(items), "asked": ctx.cfg.queue_size, "fresh": ctx.settings.fresh,
            "adventurous": ctx.settings.adventurous, "sources": job.sources, "audio": audio, "timings": job.timings,
            "transfer": dict(job.meter.counts) if job.meter else {}, "candidates": job.timings.get("candidates")}


def run_job(job: Job, seeds: list[dict], settings: dict) -> None:
    s = st()
    p = s.pipeline
    t0 = time.perf_counter()
    try:
        cfg = engine_with_weights(settings.get("weights"))
        es = E.Settings(fresh=bool(settings.get("fresh")), adventurous=settings["adventurous"]).normalised()
        job.meter = p._meter(settings)
        job.phase, job.progress = "profiling", "Looking up your starting songs"
        with ThreadPoolExecutor(max_workers=3) as ex:
            profs = list(ex.map(lambda sd: p.profile_seed(job, sd), seeds))
        profiles = {sd["key"]: pr for sd, pr in zip(seeds, profs)}
        seed_views = [p.seed_view(sd, profiles[sd["key"]]) for sd in seeds]
        job.timings["profile_ms"] = round((time.perf_counter() - t0) * 1000)
        job.phase, job.progress = "gathering", "Asking the music services for related songs"
        cands, related = p.gather(job, seed_views, profiles, cfg, es.fresh)
        job.timings["gather_ms"] = round((time.perf_counter() - t0) * 1000) - job.timings["profile_ms"]
        job.timings["candidates"] = len(cands)
        if not cands:
            job.result = {"phase": "final", "items": [], "count": 0, "asked": cfg.queue_size, "sources": job.sources, "audio": job.audio,
                          "timings": job.timings, "transfer": dict(job.meter.counts), "empty_reason": "No service returned related songs for these starting songs."}
            return
        v2 = settings.get("rank_v2", True)
        fb = (E.build_feedback2 if v2 else E.build_feedback)(s.store.feedback(), time.time(), cfg)
        imps = s.store.impressions(time.time() - cfg.exposure_window_days * 86400)
        vectors: dict = {}
        for sv in seed_views + cands:
            did = sv.get("dz_preview_id") or sv.get("dz_id") or (sv["platform_id"] if sv["provider"] == "deezer" else None)
            if did:
                v = s.store.vector_get(f"deezer:{did}", A.MODEL_ID, A.PREPROCESS_ID)
                if v is not None:
                    vectors[sv["key"]] = v
        ctx = E.Context(seeds=seed_views, vectors=vectors, related_artists={k: v for k, v in related.items() if v}, feedback=fb,
                        impressions=imps, settings=es, now=today(), cfg=cfg, rank_v2=bool(v2))
        scored = E.score_all(cands, ctx)
        chosen = E.select(scored, ctx)
        job.timings["metadata_ms"] = round((time.perf_counter() - t0) * 1000)
        job.result = serialise(chosen, ctx, "metadata", job)
        log.info("job %s metadata: %d candidates -> %d in %d ms", job.id, len(cands), len(chosen), job.timings["metadata_ms"])

        # ---- phase 2: details for the leading candidates, then audio --------------------------
        job.token.check()
        job.phase, job.progress = "enriching", "Reading genres and tempo for the leading songs"
        lead_keys = [x.track["key"] for x in scored[:40]]
        lead = [c for c in cands if c["key"] in set(lead_keys)]
        lead.sort(key=lambda c: lead_keys.index(c["key"]))
        p.enrich(job, lead, 40)
        if settings.get("audio", True) and s.encoder.installed():
            job.phase, job.progress = "listening", "Comparing how the songs sound (30-second previews)"
            ta = time.perf_counter()
            try:
                for sv in seed_views:
                    did = sv.get("dz_preview_id") or (sv["platform_id"] if sv["provider"] == "deezer" else None)
                    prof = profiles[sv["key"]].get("dz") or {}
                    if did and sv["key"] not in vectors:
                        v = p.vector_for(job, sv["key"], did, sv.get("preview") or prof.get("preview"))
                        if v is not None:
                            vectors[sv["key"]] = v
                if any(sv["key"] in vectors for sv in seed_views):
                    rescored = E.score_all(cands, ctx)
                    todo = [x.track for x in rescored if x.track["key"] not in vectors and x.track.get("dz_id") and x.track.get("preview")]
                    budget_n = cfg.audio_candidates_per_request
                    for c in todo[:budget_n]:
                        job.token.check()
                        job.progress = f"Comparing how the songs sound ({job.audio.get('embedded', 0) + 1} of {min(budget_n, len(todo))})"
                        v = p.vector_for(job, c["key"], c.get("dz_id"), c.get("preview"))
                        if v is not None:
                            vectors[c["key"]] = v
                else:
                    job.audio["skipped"] = "No starting song has a legitimately available preview, so there is nothing to compare against."
            except BudgetExceeded as e:
                # the raw reason stays in last_budget; the listener sees what it means for them
                day_left = job.meter.daily_remaining - job.meter.total if job.meter else 0
                job.audio["stopped"] = ("Stopped listening early: today's transfer allowance is nearly used (Settings → Daily allowance)."
                                        if day_left < 2_000_000 else "Stopped listening early: this request's transfer allowance is used.")
            job.audio["ms"] = round((time.perf_counter() - ta) * 1000)
            job.audio["compared"] = sum(1 for c in cands if c["key"] in vectors)
            if job.audio.get("embedded") and job.audio["compared"] and any(sv["key"] in vectors for sv in seed_views):
                # a real seed-vs-candidate comparison on downloaded previews is a runtime check of the audio path
                s.audio_check = {"state": "working", "detail": f"Compared {job.audio['compared']} songs on real previews in the last request",
                                 "infer_ms": job.audio.get("infer_ms"), "checked": time.time()}
        elif not s.encoder.installed():
            job.audio["skipped"] = "Audio model not installed (Settings → Audio matching)."
        else:
            job.audio["skipped"] = "Audio matching is turned off in Settings."
        job.token.check()
        scored = E.score_all(cands, ctx)
        chosen = E.select(scored, ctx)
        job.timings["total_ms"] = round((time.perf_counter() - t0) * 1000)
        job.result = serialise(chosen, ctx, "final", job)
        s.store.put("last_result", {**job.result, "saved_at": time.time()})
        log.info("job %s final: %d in %d ms, audio %s, bytes %s", job.id, len(chosen), job.timings["total_ms"], job.audio.get("embedded"), job.meter.counts)
    except Cancelled:
        job.error = "cancelled"
    except Exception as e:  # noqa: BLE001
        log.exception("job failed")
        job.error = f"{type(e).__name__}: {e}"
    finally:
        job.done = True
        job.phase = "done" if not job.error else ("cancelled" if job.error == "cancelled" else "failed")
        FOOTPRINT.invalidate()


@app.post("/api/recommend")
def recommend(body: dict | None = None):
    s = st()
    seeds = s.store.seeds()
    if not seeds:
        raise HTTPException(400, "Add at least one starting song first.")
    settings = s.settings()
    if s.current_job and s.current_job in s.jobs:
        s.jobs[s.current_job].token.cancel("superseded by a newer request")
    job = Job(id=uuid.uuid4().hex[:12])
    s.jobs[job.id] = job
    s.current_job = job.id
    for old in [k for k, j in s.jobs.items() if j.done and time.time() - j.started > 900]:
        s.jobs.pop(old, None)
    threading.Thread(target=run_job, args=(job, seeds, settings), daemon=True).start()
    return {"job": job.id}


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str):
    j = st().jobs.get(job_id)
    if not j:
        raise HTTPException(404, "unknown job")
    return {"job": j.id, "phase": j.phase, "progress": j.progress, "done": j.done, "error": j.error, "result": j.result,
            "elapsed_ms": round((time.time() - j.started) * 1000), "sources": j.sources}


@app.delete("/api/jobs/{job_id}")
def cancel_job(job_id: str):
    j = st().jobs.get(job_id)
    if j:
        j.token.cancel("cancelled by you")
    return {"ok": True}


# ---------------------------------------------------------------------------------------------
# the one listening queue: searched songs, then discovered songs as they are found
# ---------------------------------------------------------------------------------------------
def _queue_persist(s: State) -> None:
    s.store.put("queue", s.queue.snapshot_for_store())


def _queue_error(e: QueueError) -> JSONResponse:
    return JSONResponse({"error": "queue", "message": str(e)}, status_code=e.status)


def _queue_body(s: State) -> dict:
    return s.queue.state()


@app.get("/api/queue")
def get_queue():
    return _queue_body(st())


@app.get("/api/queue/events")
def queue_events(request: Request):
    """Server-Sent Events: the queue state on connect, then after every change, with a keep-alive comment."""
    s = st()

    def stream():
        seen = -1
        while True:
            v = s.queue.version
            if v != seen:
                seen = v
                yield f"data: {json.dumps(_queue_body(s), separators=(',', ':'))}\n\n"
            v2 = s.queue.wait_for_change(seen, 15.0)
            if v2 == seen:
                yield ": keep-alive\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/api/queue/add")
def queue_add(body: dict):
    s = st()
    t = body.get("track")
    if not isinstance(t, dict) or not t.get("key") or not t.get("provider") or not t.get("platform_id"):
        raise HTTPException(400, "A song needs a provider, id and key to be added.")
    track = clean_track(t)
    try:
        e = s.queue.add_searched(track, playback_for(t))
    except QueueError as err:
        return _queue_error(err)
    _queue_persist(s)
    _start_discovery(s)
    return _queue_body(s)


@app.delete("/api/queue/{entry_id}")
def queue_remove(entry_id: str):
    s = st()
    try:
        s.queue.remove(entry_id)
    except QueueError as err:
        return _queue_error(err)
    _queue_persist(s)
    return _queue_body(s)


@app.post("/api/queue/play")
def queue_play(body: dict):
    s = st()
    try:
        s.queue.play(str(body.get("id", "")))
    except QueueError as err:
        return _queue_error(err)
    _queue_persist(s)
    return _queue_body(s)


@app.post("/api/queue/next")
def queue_next():
    s = st()
    try:
        s.queue.next()
    except QueueError as err:
        return _queue_error(err)
    _queue_persist(s)
    return _queue_body(s)


@app.post("/api/queue/previous")
def queue_previous():
    s = st()
    try:
        s.queue.previous()
    except QueueError as err:
        return _queue_error(err)
    _queue_persist(s)
    return _queue_body(s)


def _start_discovery(s: State) -> None:
    """Discover songs from the searched songs in the queue. Runs in a thread; each song lands in the queue
    the moment it is scored. A newer search cancels an older run, so only the latest listening is shown."""
    if s.queue_job and s.queue_job in s.jobs:
        s.jobs[s.queue_job].token.cancel("superseded by a newer search")
    seeds = [dict(e.track) for e in s.queue.searched()]
    seeds = [{**t, "emphasis": 1.0} for t in seeds]
    job = Job(id=uuid.uuid4().hex[:12])
    s.jobs[job.id] = job
    s.queue_job = job.id
    s.queue.set_discovering(True, "Finding songs like the ones you searched for…")
    threading.Thread(target=run_queue_discovery, args=(job, seeds, s.settings()), daemon=True).start()


def run_queue_discovery(job: Job, seeds: list[dict], settings: dict) -> None:
    """The same pipeline as /api/recommend, with each metadata-phase result appended to the queue as it lands."""
    s = st()
    try:
        cfg = engine_with_weights(settings.get("weights"))
        es = E.Settings(fresh=bool(settings.get("fresh")), adventurous=settings["adventurous"]).normalised()
        job.meter = s.pipeline._meter(settings)
        job.phase, job.progress = "profiling", "Looking up your starting songs"
        with ThreadPoolExecutor(max_workers=3) as ex:
            profs = list(ex.map(lambda sd: s.pipeline.profile_seed(job, sd), seeds))
        profiles = {sd["key"]: pr for sd, pr in zip(seeds, profs)}
        seed_views = [s.pipeline.seed_view(sd, profiles[sd["key"]]) for sd in seeds]
        job.phase, job.progress = "gathering", "Asking the music services for related songs"
        cands, related = s.pipeline.gather(job, seed_views, profiles, cfg, es.fresh)
        if not cands:
            s.queue.set_discovering(False, "No service returned related songs for what you searched.")
            return
        fb = E.build_feedback(s.store.feedback(), time.time(), cfg)
        imps = s.store.impressions(time.time() - cfg.exposure_window_days * 86400)
        v2q = settings.get("rank_v2", True)
        if v2q:
            fb = E.build_feedback2(s.store.feedback(), time.time(), cfg)
        ctx = E.Context(seeds=seed_views, vectors={}, related_artists={k: v for k, v in related.items() if v},
                        feedback=fb, impressions=imps, settings=es, now=today(), cfg=cfg, rank_v2=bool(v2q))
        scored = E.score_all(cands, ctx)
        chosen = E.select(scored, ctx)
        added = 0
        for i, x in enumerate(chosen):
            job.token.check()
            track = clean_track(x.track)
            rec = {"rank": i + 1, "track": track, "score": round(x.final, 4), "tier": x.tier, "reasons": x.reasons,
                   "evidence": "strong" if x.coverage >= 0.6 else "moderate" if x.coverage >= 0.35 else "thin",
                   "new_release": x.new_release}
            if s.queue.append_discovered(track, playback_for(x.track), rec) is not None:
                added += 1
                _queue_persist(s)
        note = (f"Found {added} new songs." if added else "Nothing new to add yet.")
        s.queue.set_discovering(False, note)
        _queue_persist(s)
        log.info("queue discovery %s: %d candidates -> %d added", job.id, len(cands), added)
    except Cancelled:
        s.queue.set_discovering(False, "Discovery was stopped by a newer search.")
    except Exception as e:  # noqa: BLE001
        log.exception("queue discovery failed")
        s.queue.set_discovering(False, f"Discovery stopped: {type(e).__name__}.")
    finally:
        job.done = True
        job.phase = "done"
        FOOTPRINT.invalidate()


# ---------------------------------------------------------------------------------------------
# feedback / impressions / saved
# ---------------------------------------------------------------------------------------------
FEEDBACK_KINDS = {"like", "dislike", "hide", "save", "replay", "complete", "skip", "unlike", "unsave", "undislike", "unhide"}


@app.post("/api/feedback")
def feedback(body: dict):
    s = st()
    kind = body.get("kind")
    if kind not in FEEDBACK_KINDS:
        raise HTTPException(400, "unknown feedback kind")
    t = body.get("track") or {}
    key = t.get("key")
    if not key:
        raise HTTPException(400, "track.key required")
    if kind.startswith("un"):
        n = s.store.remove_feedback(key, (kind[2:],))
        return {"removed": n}
    event_id = str(body.get("event_id") or "")[:80]
    if not event_id:
        raise HTTPException(400, "event_id required (used to deduplicate)")
    listened = body.get("listened")
    if kind in ("complete", "skip", "replay"):
        if listened is None or not (0 <= float(listened) <= 3600):
            raise HTTPException(400, "playback events need the listened duration")
    if kind == "like":
        s.store.remove_feedback(key, ("dislike",))
    if kind == "dislike":
        s.store.remove_feedback(key, ("like",))
    # Optional v2 telemetry, validated with the same bounds as the TS route; absent fields stay absent.
    meta: dict = {}
    dur = body.get("duration")
    if isinstance(dur, (int, float)) and 1 <= float(dur) <= 36000:
        meta["duration"] = float(dur)
    cov = body.get("coverage")
    if isinstance(cov, (int, float)) and 0 <= float(cov) <= 36000:
        meta["coverage"] = float(cov)
    med = body.get("medium")
    if med in ("preview", "full", "embed"):
        meta["medium"] = med
    for sk in ("session", "origin"):
        sv = body.get(sk)
        if isinstance(sv, str) and 0 < len(sv) <= 64:
            meta[sk] = sv
    cv = body.get("confidence")
    if isinstance(cv, (int, float)) and 0 <= float(cv) <= 1:
        meta["confidence"] = float(cv)
    added = s.store.add_feedback(event_id, key, kind, (t.get("artists") or [""])[0].lower() if t.get("artists") else "", clean_track(t), listened, meta=meta or None)
    return {"recorded": added, "duplicate": not added}


@app.post("/api/import/history")
def import_history(body: dict):
    """Store already-parsed local history, preserving original timestamps. No upstream upload."""
    events = body.get("events")
    if not isinstance(events, list) or not events or len(events) > 2500:
        raise HTTPException(400, "events must be a nonempty list of at most 2500")
    s = st()
    now = time.time()
    recorded = duplicates = 0
    for e in events:
        if not isinstance(e, dict):
            continue
        event_id, key, kind = e.get("event_id"), e.get("key"), e.get("kind")
        ts = e.get("ts")
        if not (isinstance(event_id, str) and 0 < len(event_id) <= 80 and event_id.startswith("imp-")
                and isinstance(key, str) and 0 < len(key) <= 512
                and kind in ("complete", "skip", "qualified")
                and isinstance(ts, (int, float)) and 0 < ts <= now + 86400):
            continue
        origin = e.get("origin")
        if not (isinstance(origin, str) and origin in ("import:spotify", "import:listenbrainz")):
            continue
        title = str(e.get("title") or "")[:300]
        artist = str(e.get("artist") or "")[:300]
        listened = e.get("listened")
        listened = max(0.0, min(36000.0, float(listened))) if isinstance(listened, (int, float)) else None
        confidence = e.get("confidence")
        confidence = min(1.0, max(0.0, float(confidence))) if isinstance(confidence, (int, float)) else 0.6
        added = s.store.add_feedback(event_id, key, kind, artist.lower(),
                                     {"key": key, "title": title, "artists": [artist]}, listened,
                                     ts=float(ts), meta={"origin": origin, "confidence": confidence})
        if added:
            recorded += 1
        else:
            duplicates += 1
    return {"recorded": recorded, "duplicates": duplicates, "skipped": len(events) - recorded - duplicates}


@app.get("/api/feedback/state")
def feedback_state():
    rows = st().store.feedback()
    state: dict[str, dict] = {}
    for r in rows:
        d = state.setdefault(r["key"], {})
        d[r["kind"]] = True
    return {"state": state, "events": len(rows)}


@app.post("/api/impressions")
def impressions(body: dict):
    keys = [str(k)[:300] for k in (body.get("keys") or [])][:60]
    if keys:
        st().store.add_impressions(keys)
    return {"recorded": len(keys)}


@app.get("/api/preview/deezer/{tid}")
def preview(tid: str):
    """Re-sign a Deezer 30-second preview and redirect the browser to it. The browser streams the audio
    from Deezer's CDN itself (user-triggered playback, outside the backend transfer allowance)."""
    if not tid.isdigit() or len(tid) > 20:
        raise HTTPException(400, "Not a Deezer track id")
    s = st()
    try:
        hit = s.store.cache_get(f"dz:track:{tid}")
        url = s.dz.fresh_preview(tid, (hit or {}).get("value", {}).get("preview"))
    except (FetchError, ProviderError) as e:
        raise HTTPException(502, f"Deezer did not answer: {e}") from e
    if not url:
        raise HTTPException(404, "Deezer offers no preview for this track")
    return RedirectResponse(url, status_code=307, headers={"cache-control": "no-store"})


@app.post("/api/full-song")
def full_song(body: dict):
    """Find the full-length recording of a track that has no YouTube Music version attached yet (a song
    that only came from Deezer, which offers 30-second clips). Only a confident match is returned; a
    near miss is never played in its place. The browser then plays it in YouTube's own embedded player."""
    t = body.get("track")
    if not isinstance(t, dict) or not t.get("title") or not isinstance(t.get("artists") or [], list):
        raise HTTPException(400, "A track with a title is needed.")
    t = {**t, "artists": [str(a) for a in (t.get("artists") or [])][:6], "title": str(t["title"])[:200]}
    if t.get("provider") == "ytmusic" and t.get("platform_id"):
        return {"id": t["platform_id"], "source": "own"}
    s = st()
    key = "fullsong:" + hashlib.sha1(f"{t['title']}|{'|'.join(t['artists'])}|{t.get('duration')}".encode()).hexdigest()
    hit = s.store.cache_get(key)
    if hit is not None:
        return hit["value"]
    tok = CURRENT_METER.set(_search_meter(s))
    try:
        found, _unsure = s.ytm.find_match(t, CURRENT_METER.get())
    except (FetchError, ProviderError, BudgetExceeded) as e:
        raise HTTPException(502, f"YouTube Music did not answer: {e}") from e
    finally:
        CURRENT_METER.reset(tok)
    out = {"id": found["platform_id"], "source": "match"} if found else {"id": None, "source": "none"}
    s.store.cache_put(key, "meta", out, 7 * 86400 if found else 6 * 3600)
    return out


@app.get("/api/saved")
def saved():
    rows = st().store.feedback()
    removed = {r["key"] for r in rows if r["kind"] == "dislike"}
    out, seen = [], set()
    for r in reversed(rows):
        if r["kind"] in ("like", "save") and r["key"] not in seen and r["key"] not in removed and r["track"]:
            seen.add(r["key"])
            out.append({"track": r["track"], "kind": r["kind"], "ts": r["ts"]})
    return {"items": out}


# ---------------------------------------------------------------------------------------------
# status / export / reset / model
# ---------------------------------------------------------------------------------------------
@app.get("/api/status")
def status():
    s = st()
    fp = FOOTPRINT.get()
    settings = s.settings()
    tr = s.store.transfer_today()
    return {
        "storage": fp,
        "transfer_today": tr, "transfer_daily_cap": int(settings["daily_mb"] * 1e6), "transfer_request_cap": int(settings["request_mb"] * 1e6),
        "transfer_note": "Backend downloads only. Playing songs in the embedded players streams in your browser and is not counted here.",
        "cache": {"hits": s.store.cache_hits, "misses": s.store.cache_misses, "bytes": s.store.cache_bytes(), "vectors": s.store.vector_count()},
        "timings": s.timings, "startup_ms": round(getattr(s, "startup_ms", 0)), "memory": process_memory(),
        "audio": audio_state(), "health_checked_at": s.health_at, "telemetry": "none",
    }


def process_memory() -> dict:
    """Current and peak working set of this process (Windows API / resource module)."""
    try:
        if os.name == "nt":
            import ctypes
            from ctypes import wintypes

            class PMC(ctypes.Structure):
                _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD), ("PeakWorkingSetSize", ctypes.c_size_t),
                            ("WorkingSetSize", ctypes.c_size_t), ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                            ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]

            pmc = PMC()
            pmc.cb = ctypes.sizeof(PMC)
            k32 = ctypes.WinDLL("kernel32")
            psapi = ctypes.WinDLL("psapi")
            k32.GetCurrentProcess.restype = wintypes.HANDLE
            psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(PMC), wintypes.DWORD]
            psapi.GetProcessMemoryInfo(k32.GetCurrentProcess(), ctypes.byref(pmc), pmc.cb)
            return {"rss": pmc.WorkingSetSize, "peak": pmc.PeakWorkingSetSize}
        import resource

        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024
        return {"rss": None, "peak": peak}
    except Exception:  # noqa: BLE001
        return {"rss": None, "peak": None}


@app.get("/api/export")
def export():
    data = st().store.export()
    return JSONResponse(data, headers={"Content-Disposition": "attachment; filename=airwave-discovery-export.json"})


@app.post("/api/reset")
def reset(body: dict | None = None):
    s = st()
    keep = not (body or {}).get("clear_cache")
    s.store.reset(keep_cache=keep)
    # the listening queue is user data too: a reset clears it and stops any discovery still running for it
    if s.queue_job and s.queue_job in s.jobs:
        s.jobs[s.queue_job].token.cancel("the app was reset")
    s.queue = ListeningQueue()
    s.queue_job = None
    FOOTPRINT.invalidate()
    return {"ok": True, "cache_kept": keep}


@app.post("/api/model/install")
def install_model():
    """Download the DCLAP ONNX files (~22 MB) with SHA-256 verification inside the model budget."""
    s = st()
    if s.encoder.installed():
        return {"installed": True, "downloaded": 0}
    import httpx

    try:
        ensure_room("models", A.MODEL_DOWNLOAD_BYTES)
    except OverBudget as e:
        raise HTTPException(507, str(e)) from e
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    total = 0
    for name, (sha, size) in A.MODEL_FILES.items():
        dest = MODELS_DIR / name
        if dest.exists() and dest.stat().st_size == size:
            continue
        tmp = dest.with_suffix(dest.suffix + ".part")
        h = hashlib.sha256()
        got = 0
        with httpx.stream("GET", A.MODEL_URL + name, follow_redirects=True, timeout=60) as r:  # github release -> objects CDN
            r.raise_for_status()
            with open(tmp, "wb") as f:
                for chunk in r.iter_bytes(65536):
                    got += len(chunk)
                    if got > size:
                        tmp.unlink(missing_ok=True)
                        raise HTTPException(502, f"{name} is larger than the published size; aborted")
                    h.update(chunk)
                    f.write(chunk)
        if h.hexdigest() != sha:
            tmp.unlink(missing_ok=True)
            raise HTTPException(502, f"{name} failed its checksum; not installed")
        tmp.replace(dest)
        total += got
    s.store.add_transfer("model", total)
    FOOTPRINT.invalidate()
    return {"installed": s.encoder.installed(), "downloaded": total}


@app.post("/api/model/selftest")
def model_selftest():
    """Embed two real Deezer previews and report the cosine; this is what the audio badge shows."""
    s = st()
    if not s.encoder.installed():
        raise HTTPException(409, "Audio model is not installed.")
    job = Job(id="selftest")
    job.meter = Meter(5_000_000, max(0, int(s.settings()["daily_mb"] * 1e6) - sum(s.store.transfer_today().values())), sink=s.store.add_transfer)
    t0 = time.perf_counter()
    try:
        pairs = {}
        for q in ("daft punk around the world", "chopin nocturne op 9 no 2 rubinstein"):
            res = s.dz.search(q, 3, job.meter)
            t = next((x for x in res if x.get("preview")), None)
            if t is None:
                raise ProviderError(f"Deezer returned no preview for “{q}”")
            v = s.pipeline.vector_for(job, t["key"], t["platform_id"], t["preview"])
            if v is None:
                raise ProviderError(f"could not embed “{t['title']}”: {job.audio}")
            pairs[t["title"] + " — " + t["artist"]] = v
        (na, va), (nb, vb) = list(pairs.items())
        s.audio_check = {"state": "working", "detail": f"Compared two real previews: {na} vs {nb}", "cosine": round(A.cosine(va, vb), 3),
                         "self": round(A.cosine(va, va), 3), "infer_ms": job.audio.get("infer_ms"), "bytes": dict(job.meter.counts),
                         "ms": round((time.perf_counter() - t0) * 1000), "checked": time.time()}
    except BudgetExceeded:
        # running out of allowance says nothing about the model: keep the last real result, and say why no test ran
        prev = s.audio_check if s.audio_check.get("state") == "working" else {"state": "not_tested"}
        real = prev.get("real_detail") or prev.get("detail")
        s.audio_check = {**prev, "real_detail": real, "checked": time.time(),
                         "detail": "Not tested now: today's download allowance is nearly used (Settings → Daily download allowance)."
                         + (f" Last real test: {real}" if real else "")}
    except Exception as e:  # noqa: BLE001
        s.audio_check = {"state": "unavailable", "detail": f"{type(e).__name__}: {str(e)[:160]}", "checked": time.time()}
    return s.audio_check


@app.get("/api/last")
def last_result():
    """The last finished queue, so a reload (or a lost connection) still shows it. Never re-ranked here."""
    r = st().store.get("last_result")
    if not r:
        raise HTTPException(404, "No earlier recommendations yet.")
    return r


@app.get("/api/sample")
def sample():
    """Clearly labelled sample data for looking at the interface offline. Not recommendations."""
    import json

    path = Path(__file__).with_name("sample_data.json")
    return json.loads(path.read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------------------------
# static web app
# ---------------------------------------------------------------------------------------------
if (WEB_DIST / "assets").exists():
    app.mount("/assets", StaticFiles(directory=WEB_DIST / "assets"), name="assets")


@app.get("/{path:path}", include_in_schema=False)
def spa(path: str):
    if path.startswith("api/"):
        raise HTTPException(404)
    f = WEB_DIST / path
    if path and f.is_file() and WEB_DIST in f.resolve().parents:
        return FileResponse(f)
    index = WEB_DIST / "index.html"
    if index.exists():
        return FileResponse(index, headers={"Cache-Control": "no-cache"})
    return JSONResponse({"message": "Web app not built. Run: pnpm --dir discovery-demo/web build"}, status_code=503)
