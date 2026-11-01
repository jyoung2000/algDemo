"""API tests through FastAPI's TestClient. The startup health probe and every provider are stubbed:
these tests never touch a music service. Live checks live in test_live.py (-m live)."""

import json

import pytest
from fastapi.testclient import TestClient

from airwave_discovery import app as appmod
from airwave_discovery.providers import ProviderError


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(appmod, "refresh_health", lambda: {})
    with TestClient(appmod.app) as c:
        c.post("/api/reset", json={"clear_cache": True})
        yield c


def seed(key, **kw):
    return {"key": key, "provider": "deezer", "platform_id": key, "title": key, "artists": ["A"], **kw}


def test_seeds_dedupe_and_emphasis_with_no_cap(client):
    r = client.put("/api/seeds", json={"seeds": [seed("a", emphasis=9), seed("a"), seed("b")]})
    assert r.status_code == 200
    seeds = r.json()["seeds"]
    assert [s["key"] for s in seeds] == ["a", "b"]
    assert seeds[0]["emphasis"] == 2.0
    many = [seed(str(i)) for i in range(60)]
    r = client.put("/api/seeds", json={"seeds": many})
    assert r.status_code == 200 and len(r.json()["seeds"]) == 60
    assert len(client.get("/api/seeds").json()["seeds"]) == 60
    assert client.put("/api/seeds", json={"seeds": [{"title": "no id"}]}).status_code == 400


def test_recommend_needs_a_seed(client):
    r = client.post("/api/recommend", json={})
    assert r.status_code == 400


def test_settings_validate_weights(client):
    assert client.put("/api/settings", json={"weights": {"audio": -1}}).status_code == 400
    r = client.put("/api/settings", json={"fresh": True, "adventurous": 7, "daily_mb": 1})
    assert r.json()["fresh"] is True and r.json()["adventurous"] == 1.0 and r.json()["daily_mb"] == 5.0
    assert client.get("/api/settings").json()["fresh"] is True
    assert "mode" not in client.get("/api/settings").json()

def test_old_mode_setting_maps_to_slider_and_switch(client):
    s = appmod.st()
    s.store.put("settings", {"mode": "new", "adventurous": 0.8})
    got = client.get("/api/settings").json()
    assert got["fresh"] is True and got["adventurous"] == 0.8 and "mode" not in got
    s.store.put("settings", {"mode": "similar", "adventurous": 0.9})
    got = client.get("/api/settings").json()
    assert got["fresh"] is False and got["adventurous"] == 0.25


def test_playback_coverage_persisted_separately_and_used_for_completion(client):
    t = seed("preview")
    body = {"kind": "complete", "event_id": "play-coverage-1", "track": t,
            "listened": 28, "coverage": 24, "duration": 30, "medium": "preview", "session": "s-test", "origin": "queue"}
    assert client.post("/api/feedback", json=body).json()["recorded"] is True
    row = next(x for x in appmod.st().store.feedback() if x["event_id"] == "play-coverage-1")
    assert row["listened"] == 28 and row["coverage"] == 24 and row["duration"] == 30
    assert row["medium"] == "preview" and row["session"] == "s-test"
    # unique content, not elapsed looping, determines the partial-completion qualification
    expected = 3.0 * 0.6 * 0.8
    assert appmod.E.build_feedback2([dict(row, ts=1750000000)], 1750000000).track["preview"] == pytest.approx(expected)


def test_import_history_original_timestamp_dedupe_and_qualified_not_complete(client):
    event = {"event_id": "imp-lb-demo-1", "key": "daft punk|get lucky|", "kind": "qualified",
             "title": "Get Lucky", "artist": "daft punk", "ts": 1750000000,
             "listened": None, "origin": "import:listenbrainz", "confidence": 0.6}
    r = client.post("/api/import/history", json={"events": [event]})
    assert r.status_code == 200 and r.json() == {"recorded": 1, "duplicates": 0, "skipped": 0}
    assert client.post("/api/import/history", json={"events": [event]}).json()["duplicates"] == 1
    row = next(x for x in appmod.st().store.feedback() if x["event_id"] == event["event_id"])
    assert row["kind"] == "qualified" and row["ts"] == 1750000000
    assert row["listened"] is None and row["confidence"] == 0.6
    assert row["origin"] == "import:listenbrainz"
    assert appmod.E.build_feedback2([row], 1750000000).track[event["key"]] == pytest.approx(0.9)
    bad = dict(event, event_id="imp-lb-demo-2", kind="dislike")
    assert client.post("/api/import/history", json={"events": [bad]}).json()["skipped"] == 1


def test_import_history_rejects_oversize_batch(client):
    assert client.post("/api/import/history", json={"events": []}).status_code == 400
    assert client.post("/api/import/history", json={"events": [{}] * 2501}).status_code == 400


def test_feedback_dedupe_and_like_dislike_exclusive(client):
    t = seed("k")
    body = {"kind": "like", "event_id": "e1", "track": t}
    assert client.post("/api/feedback", json=body).json()["recorded"] is True
    assert client.post("/api/feedback", json=body).json()["duplicate"] is True
    client.post("/api/feedback", json={"kind": "dislike", "event_id": "e2", "track": t})
    state = client.get("/api/feedback/state").json()["state"]["k"]
    assert state == {"dislike": True}
    assert client.post("/api/feedback", json={"kind": "complete", "event_id": "e3", "track": t}).status_code == 400
    assert client.post("/api/feedback", json={"kind": "bogus", "event_id": "e4", "track": t}).status_code == 400


def test_saved_lists_likes_not_dislikes(client):
    client.post("/api/feedback", json={"kind": "like", "event_id": "1", "track": seed("x")})
    client.post("/api/feedback", json={"kind": "save", "event_id": "2", "track": seed("y")})
    client.post("/api/feedback", json={"kind": "like", "event_id": "3", "track": seed("z")})
    client.post("/api/feedback", json={"kind": "dislike", "event_id": "4", "track": seed("z")})
    keys = [i["track"]["key"] for i in client.get("/api/saved").json()["items"]]
    assert sorted(keys) == ["x", "y"]


def test_resolve_rejects_unsafe_and_non_links(client):
    for u, code in (
        ("http://127.0.0.1:8787/api/settings", 400),
        ("https://192.168.1.1/track", 400),
        ("https://open.spotify.com.evil.example/track/1", 400),
        ("https://example.com/track/1", 400),
    ):
        r = client.post("/api/resolve", json={"url": u})
        assert r.status_code == code, u
        assert r.json()["kind"] == "error"
    r = client.post("/api/resolve", json={"url": "not a link at all ::"})
    assert r.status_code in (400, 422)
    assert "Traceback" not in r.text


def test_resolve_provider_failure_is_plain_language(client, monkeypatch):
    def boom(url, meter):
        raise ProviderError("This video is private or was removed.")

    monkeypatch.setattr(appmod.st().ytm, "resolve_link", boom)
    r = client.post("/api/resolve", json={"url": "https://www.youtube.com/watch?v=zzzzzzzzzzz"})
    assert r.status_code == 422
    assert r.json()["message"] == "This video is private or was removed."


def test_preview_route_validates_ids(client):
    assert client.get("/api/preview/deezer/abc", follow_redirects=False).status_code == 400
    assert client.get("/api/preview/deezer/" + "1" * 25, follow_redirects=False).status_code == 400


def test_full_song_finds_confident_match_only(client, monkeypatch):
    s = appmod.st()
    calls = []

    def fake(t, meter=None, token=None):
        calls.append(t["title"])
        return ({"platform_id": "abcdefghijk"}, []) if t["title"] == "Known" else (None, [{"platform_id": "zzz"}])

    monkeypatch.setattr(s.ytm, "find_match", fake)
    track = lambda title: {"provider": "deezer", "platform_id": "1", "title": title, "artists": ["A"], "duration": 200}  # noqa: E731
    assert client.post("/api/full-song", json={"track": track("Known")}).json()["id"] == "abcdefghijk"
    assert client.post("/api/full-song", json={"track": track("Known")}).json()["id"] == "abcdefghijk"
    assert calls == ["Known"]  # the second answer came from the cache
    assert client.post("/api/full-song", json={"track": track("Unknown")}).json() == {"id": None, "source": "none"}  # a near miss is not played
    own = {"provider": "ytmusic", "platform_id": "vid12345678", "title": "T", "artists": ["A"]}
    assert client.post("/api/full-song", json={"track": own}).json()["id"] == "vid12345678"
    assert client.post("/api/full-song", json={"track": {"artists": []}}).status_code == 400


def test_last_result_persisted(client):
    assert client.get("/api/last").status_code == 404
    appmod.st().store.put("last_result", {"items": [{"track": seed("q")}], "saved_at": 1.0})
    assert client.get("/api/last").json()["items"][0]["track"]["key"] == "q"


def test_status_reports_budgets_and_no_telemetry(client):
    s = client.get("/api/status").json()
    assert s["telemetry"] == "none"
    assert s["storage"]["hard_cap"] == 5_000_000_000
    assert s["transfer_daily_cap"] == 100_000_000
    assert "not counted" in s["transfer_note"]


def test_export_contains_user_data(client):
    client.put("/api/seeds", json={"seeds": [seed("a")]})
    data = client.get("/api/export").json()
    assert any(s["key"] == "a" for s in data["seeds"])


def test_sample_mode_is_labelled(client):
    r = client.get("/api/sample")
    assert r.status_code == 200
    body = r.json()
    assert body["sample"]["label"].lower().startswith("sample data")
    assert body["items"], "sample data has items"
    # no live playback is implied: previews are stripped from the snapshot
    assert all(i["playback"]["preview"] is None for i in body["items"])



def test_model_selftest_out_of_allowance_is_not_a_model_failure(client, monkeypatch):
    """Running out of transfer allowance must not mark a working model unavailable."""
    from airwave_discovery.net import BudgetExceeded

    s = appmod.st()
    monkeypatch.setattr(s.encoder, "installed", lambda: True)

    def broke(*a, **k):
        raise BudgetExceeded("cdnt-preview.dzcdn.net declared 479827 bytes, over the 1000-byte cap")

    monkeypatch.setattr(s.dz, "search", broke)
    s.audio_check = {"state": "working", "detail": "Compared two real previews: A vs B", "checked": 0}
    r = client.post("/api/model/selftest", json={}).json()
    assert r["state"] == "working"
    assert "allowance" in r["detail"] and "A vs B" in r["detail"]
    r2 = client.post("/api/model/selftest", json={}).json()  # repeated runs do not nest the message
    assert r2["detail"].count("Not tested now") == 1
    s.audio_check = {"state": "not_tested"}
    assert client.post("/api/model/selftest", json={}).json()["state"] == "not_tested"


# ---- the listening queue ---------------------------------------------------------------------
def track_body(key):
    return {"key": key, "provider": "deezer", "platform_id": key, "title": key, "artists": ["A"], "url": f"https://x/{key}"}


@pytest.fixture
def no_discovery(monkeypatch):
    """Discovery calls the music services; these tests only check the queue."""
    monkeypatch.setattr(appmod, "_start_discovery", lambda s: None)


def test_queue_add_next_previous_over_http(client, no_discovery):
    q = client.get("/api/queue").json()
    assert q["entries"] == [] and q["current"] is None
    a = client.post("/api/queue/add", json={"track": track_body("a")}).json()
    client.post("/api/queue/add", json={"track": track_body("b")})
    assert [e["track"]["key"] for e in a["entries"]] == ["a"]
    assert client.post("/api/queue/add", json={"track": track_body("a")}).status_code == 409
    client.post("/api/queue/next")
    cur = client.get("/api/queue").json()["current"]
    assert cur == a["entries"][0]["id"]
    client.post("/api/queue/next")
    assert client.get("/api/queue").json()["current"] != cur
    client.post("/api/queue/previous")
    assert client.get("/api/queue").json()["current"] == cur
    client.post("/api/queue/previous")  # nothing before the first song
    assert client.post("/api/queue/previous").status_code == 409


def test_queue_remove_and_bad_input(client, no_discovery):
    a = client.post("/api/queue/add", json={"track": track_body("a")}).json()["entries"][0]["id"]
    assert client.delete(f"/api/queue/{a}").status_code == 200
    assert client.delete(f"/api/queue/{a}").status_code == 404
    assert client.post("/api/queue/add", json={"track": {"title": "no key"}}).status_code == 400
    assert client.post("/api/queue/play", json={"id": "nope"}).status_code == 404


def test_queue_events_streams_the_current_state(client, no_discovery):
    client.post("/api/queue/add", json={"track": track_body("a")})
    with client.stream("GET", "/api/queue/events") as r:
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/event-stream")
        for line in r.iter_lines():
            if line.startswith("data: "):
                body = json.loads(line[len("data: "):])
                break
    assert [e["track"]["key"] for e in body["entries"]] == ["a"]


def test_reset_taste_forgets_feedback_but_keeps_seeds_and_settings(client):
    client.put("/api/seeds", json={"seeds": [seed("keepme")]})
    client.put("/api/settings", json={"adventurous": 0.9})
    client.post("/api/feedback", json={"kind": "like", "event_id": "rt-1", "track": seed("keepme")})
    assert any(e["event_id"] == "rt-1" for e in appmod.st().store.feedback())
    r = client.post("/api/reset/taste")
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert appmod.st().store.feedback() == []
    assert [s["key"] for s in client.get("/api/seeds").json()["seeds"]] == ["keepme"]
    assert client.get("/api/settings").json()["adventurous"] == 0.9


def test_queue_clear_empties_list_but_keeps_taste_and_settings(client):
    client.put("/api/seeds", json={"seeds": [seed("gone")]})
    client.put("/api/settings", json={"adventurous": 0.8})
    client.post("/api/feedback", json={"kind": "like", "event_id": "qc-1", "track": seed("gone")})
    appmod.st().store.put("last_result", {"items": [{"rank": 1}]})
    r = client.post("/api/queue/clear")
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert client.get("/api/seeds").json()["seeds"] == []
    assert client.get("/api/last").status_code == 404
    assert any(e["event_id"] == "qc-1" for e in appmod.st().store.feedback())
    assert client.get("/api/settings").json()["adventurous"] == 0.8
