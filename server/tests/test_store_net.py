"""Store (SQLite) and network-guard tests. The network is mocked; nothing leaves the machine."""

import threading
import time

import httpx
import numpy as np
import pytest

from airwave_discovery import net
from airwave_discovery.genres import make_tag, normalize, similarity
from airwave_discovery.store import Store


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "t.db", cache_budget=10_000, free_floor=0)
    yield s
    s.close()


# ---- cache eviction ----------------------------------------------------------------------------
def test_lru_eviction_keeps_recent_and_protects_user_data(store):
    store.put("settings", {"mode": "discover"})
    store.set_seeds([{"key": "s", "title": "Seed", "artists": ["A"]}])
    store.add_feedback("e1", "k", "like", "a", None, None)
    for i in range(8):  # ~7.4 kB: fits the 10 kB budget
        store.cache_put(f"k{i}", "search", {"pad": "x" * 900}, ttl=60)
        time.sleep(0.002)
    store.cache_get("k0")  # touch: now the most recently used
    for i in range(8, 13):
        store.cache_put(f"k{i}", "search", {"pad": "x" * 900}, ttl=60)
        time.sleep(0.002)
    assert store.cache_bytes() <= 10_000
    assert store.cache_get("k0") is not None
    assert store.cache_get("k1") is None
    assert store.get("settings") == {"mode": "discover"}
    assert len(store.seeds()) == 1 and len(store.feedback()) == 1


def test_stale_cache_only_when_asked(store):
    store.cache_put("q", "search", [1, 2], ttl=-1)
    assert store.cache_get("q") is None
    hit = store.cache_get("q", allow_stale=True)
    assert hit["stale"] and hit["value"] == [1, 2]


def test_malformed_cache_row_is_a_miss(store):
    # regression: a row with an unusable expiry once crashed the candidate pipeline
    store._exec("INSERT INTO cache(k,kind,v,size,created,expires,accessed) VALUES('bad','x','{}',2,0,'not-a-time',0)")
    assert store.cache_get("bad") is None
    assert store._exec("SELECT COUNT(*) FROM cache WHERE k='bad'").fetchone()[0] == 0


def test_feedback_event_ids_are_unique(store):
    assert store.add_feedback("e1", "k", "like", "a", None, None)
    assert not store.add_feedback("e1", "k", "like", "a", None, None)
    assert len(store.feedback()) == 1
    assert store.remove_feedback("k", ("like",)) == 1


def test_vectors_keyed_by_model_and_preprocessing(store):
    v = np.arange(4, dtype=np.float32)
    store.vector_put("rec", "model-a", "pre-1", v, "deezer")
    assert store.vector_get("rec", "model-b", "pre-1") is None
    assert store.vector_get("rec", "model-a", "pre-2") is None
    np.testing.assert_allclose(store.vector_get("rec", "model-a", "pre-1"), v)


def test_concurrent_access(store):
    errors = []

    def work(n):
        try:
            for i in range(150):
                store.cache_put(f"{n}-{i}", "x", {"i": i}, ttl=60)
                store.cache_get(f"{n}-{i // 2}")
                store.transfer_today()
        except Exception as e:  # pragma: no cover - reported below
            errors.append(e)

    threads = [threading.Thread(target=work, args=(n,)) for n in range(6)]
    for th in threads:
        th.start()
    for th in threads:
        th.join()
    assert errors == []


# ---- URL safety -------------------------------------------------------------------------------
@pytest.mark.parametrize("url", [
    "http://open.spotify.com/track/1",
    "https://open.spotify.com.evil.example/track/1",
    "https://example.com/track/1",
    "https://user:pw@soundcloud.com/a/b",
    "https://soundcloud.com:8443/a/b",
    "https://127.0.0.1/api/settings",
    "https://192.168.1.1/track",
])
def test_blocked_urls(url):
    with pytest.raises(net.BlockedUrl):
        net.validate_url(url)


def test_allowed_urls():
    for u in ("https://open.spotify.com/track/x", "https://music.youtube.com/watch?v=x", "https://cdnt-preview.dzcdn.net/a.mp3"):
        assert net.validate_url(u) == u


def _http(handler):
    h = net.Http(httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=False))
    h.check_dns = False
    return h


def test_redirect_to_disallowed_host_is_refused():
    def handler(req):
        return httpx.Response(302, headers={"location": "https://evil.example/x"})

    with pytest.raises(net.BlockedUrl):
        _http(handler).get("https://soundcloud.com/a/b", max_bytes=1000)


def test_private_address_is_refused():
    with pytest.raises(net.BlockedUrl):
        net.check_public("localhost")


# ---- byte caps and cancellation ----------------------------------------------------------------
def test_stream_over_cap_is_aborted_and_metered():
    body = b"x" * 200_000

    def handler(req):
        # a generator body is sent chunked, without a content-length to refuse up front
        return httpx.Response(200, content=iter([body[i:i + 16_384] for i in range(0, len(body), 16_384)]))

    meter = net.Meter(per_request_cap=10_000_000, daily_remaining=10_000_000)
    with pytest.raises(net.BudgetExceeded):
        _http(handler).get("https://api.deezer.com/x", max_bytes=50_000, meter=meter, category="audio")
    assert 0 < meter.counts["audio"] <= 200_000


def test_declared_length_over_cap_refused_before_download():
    def handler(req):
        return httpx.Response(200, headers={"content-length": "9999999"}, content=b"x")

    meter = net.Meter(per_request_cap=10_000_000, daily_remaining=10_000_000)
    with pytest.raises(net.BudgetExceeded):
        _http(handler).get("https://api.deezer.com/x", max_bytes=1000, meter=meter)


def test_request_allowance_used_up():
    meter = net.Meter(per_request_cap=100, daily_remaining=10_000)
    meter.add("metadata", 100)
    with pytest.raises(net.BudgetExceeded):
        _http(lambda r: httpx.Response(200, content=b"{}")).get("https://api.deezer.com/x", max_bytes=1000, meter=meter)


def test_daily_allowance_limits_request():
    meter = net.Meter(per_request_cap=10_000, daily_remaining=50)
    assert meter.remaining() == 50


def test_cancellation_stops_fetch():
    tok = net.CancelToken()
    tok.cancel("user left")
    with pytest.raises(net.Cancelled):
        _http(lambda r: httpx.Response(200, content=b"{}")).get("https://api.deezer.com/x", max_bytes=1000, token=tok)


def test_server_errors_retry_then_fail():
    calls = []

    def handler(req):
        calls.append(1)
        return httpx.Response(503)

    with pytest.raises(net.FetchError):
        _http(handler).get("https://api.deezer.com/x", max_bytes=1000, retries=1)
    assert len(calls) == 2


# ---- genres -----------------------------------------------------------------------------------
def test_genre_aliases_and_unknowns():
    assert normalize("Hip Hop") == normalize("hip-hop")
    assert similarity([], [make_tag("rock", "Deezer", "album", 1.0)]) is None
    a = [make_tag("indie rock", "Deezer", "track", 1.0)]
    b = [make_tag("indie rock", "Deezer", "artist", 1.0)]
    assert similarity(a, a) > similarity(a, b) > 0
