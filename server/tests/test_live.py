"""Live smoke checks against the running local server (node discovery-demo/start.mjs).
Not part of the default run: `uv run pytest -m live`. They talk to real services and use transfer allowance."""

import json
import os
import urllib.error
import urllib.request

import pytest

pytestmark = pytest.mark.live
BASE = os.environ.get("AIRWAVE_DISCOVERY_URL", "http://127.0.0.1:8787")


def call(path, body=None, method=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method or ("POST" if data else "GET"), headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


@pytest.mark.parametrize("q", ["weird fishes radiohead", "not like us kendrick"])
def test_live_title_search(q):
    code, body = call("/api/search?q=" + urllib.request.quote(q))
    assert code == 200
    assert body["results"], body
    assert {r["provider"] for r in body["results"]} <= {"deezer", "ytmusic"}


@pytest.mark.parametrize("url,provider", [
    ("https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b", "spotify"),
    ("https://soundcloud.com/forss/flickermood", "soundcloud"),
    ("https://www.youtube.com/watch?v=J7p4bzqLvCw", "ytmusic"),
    ("https://youtu.be/J7p4bzqLvCw", "ytmusic"),
    ("https://music.youtube.com/watch?v=J7p4bzqLvCw", "ytmusic"),
    ("https://www.deezer.com/track/3129775", "deezer"),
])
def test_live_link_per_service(url, provider):
    code, body = call("/api/resolve", {"url": url})
    assert code == 200, body
    assert body["kind"] in ("track", "choice")
    if body["kind"] == "track":
        assert body["track"]["provider"] == provider
        assert body["track"]["title"]


@pytest.mark.parametrize("url", [
    "https://www.youtube.com/watch?v=zzzzzzzzzzz",
    "https://soundcloud.com/forss/this-track-does-not-exist-xyz",
    "https://open.spotify.com/track/0000000000000000000000",
])
def test_live_invalid_links_fail_plainly(url):
    code, body = call("/api/resolve", {"url": url})
    assert code == 422
    assert body["message"] and "Traceback" not in body["message"]


def test_live_public_album_playlist_offers_bounded_choice():
    # A public YouTube Music album playlist (Daft Punk, Random Access Memories): never treated as one song.
    code, body = call("/api/resolve", {"url": "https://music.youtube.com/playlist?list=OLAK5uy_kNhM2yaBTOVwrcZJepB1C9P3-n5_Sfy5c"})
    assert code == 200, body
    assert body["kind"] == "choice"
    assert 1 <= len(body["tracks"]) <= 25


def test_live_health_reports_runtime_checks():
    code, body = call("/api/health")
    assert code == 200
    states = {c["state"] for p in body["providers"].values() for c in p.values()}
    assert states <= {"working", "degraded", "unavailable", "unsupported", "not_tested"}
