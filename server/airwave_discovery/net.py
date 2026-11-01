"""Outbound HTTP: host allowlist, redirect validation, private-network blocking, byte caps,
per-host pacing, exponential backoff and transfer metering.

Pasted URLs are untrusted. Nothing here follows a redirect automatically: every hop is checked
against the allowlist and its address resolved and refused when it is loopback, private,
link-local or otherwise non-public. Bodies are streamed and cut off at the caller's byte cap, so a
"30-second preview" that turns out to be a full album download is aborted after the cap, and
the bytes actually received (not the advertised length) are what gets counted.
"""

from __future__ import annotations

import ipaddress
import socket
import threading
import time
from dataclasses import dataclass, field
from urllib.parse import urljoin, urlsplit

import httpx

ALLOWED_HOSTS = {
    # Deezer public API, previews and artwork
    "api.deezer.com", "www.deezer.com", "deezer.com", "deezer.page.link", "link.deezer.com",
    # Spotify public oEmbed and share links
    "open.spotify.com", "spotify.link", "spotify.app.link",
    # SoundCloud pages, oEmbed and share links
    "soundcloud.com", "www.soundcloud.com", "m.soundcloud.com", "on.soundcloud.com",
    # YouTube / YouTube Music pages and short links (oEmbed only through this client)
    "www.youtube.com", "youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be",
}
ALLOWED_SUFFIXES = (".dzcdn.net",)  # Deezer preview and image CDNs


class FetchError(Exception):
    pass


class BlockedUrl(FetchError):
    pass


class BudgetExceeded(FetchError):
    pass


class Cancelled(FetchError):
    pass


def host_allowed(host: str) -> bool:
    host = (host or "").lower().rstrip(".")
    return host in ALLOWED_HOSTS or any(host.endswith(s) for s in ALLOWED_SUFFIXES)


def check_public(host: str) -> None:
    try:
        infos = socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)
    except socket.gaierror as e:
        raise FetchError(f"cannot resolve {host}") from e
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global or ip.is_multicast:
            raise BlockedUrl(f"{host} resolves to a non-public address")


def validate_url(url: str) -> str:
    parts = urlsplit(url)
    if parts.scheme != "https":
        raise BlockedUrl("only https links are accepted")
    if parts.username or parts.password:
        raise BlockedUrl("links with credentials are refused")
    if parts.port not in (None, 443):
        raise BlockedUrl("non-standard ports are refused")
    if not host_allowed(parts.hostname or ""):
        raise BlockedUrl(f"{parts.hostname} is not a supported music host")
    return url


@dataclass
class CancelToken:
    event: threading.Event = field(default_factory=threading.Event)
    reason: str = ""

    def cancel(self, reason: str = "cancelled") -> None:
        self.reason = reason
        self.event.set()

    def check(self) -> None:
        if self.event.is_set():
            raise Cancelled(self.reason or "cancelled")

    @property
    def cancelled(self) -> bool:
        return self.event.is_set()


class Meter:
    """Counts bytes per category for one request and reports them to the daily store."""

    def __init__(self, per_request_cap: int, daily_remaining: int, sink=None) -> None:
        self.cap = per_request_cap
        self.daily_remaining = daily_remaining
        self.counts: dict[str, int] = {}
        self.sink = sink
        self._lock = threading.Lock()

    @property
    def total(self) -> int:
        return sum(self.counts.values())

    def remaining(self) -> int:
        return max(0, min(self.cap - self.total, self.daily_remaining - self.total))

    def add(self, category: str, n: int) -> None:
        with self._lock:
            self.counts[category] = self.counts.get(category, 0) + n
        if self.sink:
            self.sink(category, n)


class HostPacer:
    """Minimum spacing between calls to one host (Deezer documents 50 requests / 5 s)."""

    def __init__(self, spacing: dict[str, float], default: float = 0.05) -> None:
        self.spacing = spacing
        self.default = default
        self._next: dict[str, float] = {}
        self._lock = threading.Lock()

    def wait(self, host: str) -> None:
        gap = self.spacing.get(host, self.default)
        with self._lock:
            now = time.monotonic()
            at = max(now, self._next.get(host, 0.0))
            self._next[host] = at + gap
        delay = at - now
        if delay > 0:
            time.sleep(delay)


PACER = HostPacer({"api.deezer.com": 0.11, "soundcloud.com": 0.3, "open.spotify.com": 0.2})
USER_AGENT = "AirwaveDiscoveryDemo/0.1 (+local; non-commercial)"


class Http:
    def __init__(self, client: httpx.Client | None = None) -> None:
        self.client = client or httpx.Client(timeout=httpx.Timeout(10.0, connect=5.0), follow_redirects=False, headers={"User-Agent": USER_AGENT})
        self.check_dns = True

    def _hop(self, url: str) -> str:
        validate_url(url)
        if self.check_dns:
            check_public(urlsplit(url).hostname or "")
        return url

    def get(self, url: str, *, max_bytes: int, meter: Meter | None = None, category: str = "metadata",
            token: CancelToken | None = None, retries: int = 2, max_redirects: int = 4,
            params: dict | None = None) -> tuple[httpx.Response, bytes]:
        attempt = 0
        while True:
            try:
                return self._get_once(url, max_bytes=max_bytes, meter=meter, category=category, token=token, max_redirects=max_redirects, params=params)
            except (httpx.TransportError, _Retryable) as e:
                attempt += 1
                if attempt > retries:
                    raise FetchError(f"{urlsplit(url).hostname}: {e}") from e
                if token:
                    token.check()
                time.sleep(min(4.0, 0.4 * (2 ** (attempt - 1))))

    def _get_once(self, url, *, max_bytes, meter, category, token, max_redirects, params):
        current = url
        for _ in range(max_redirects + 1):
            if token:
                token.check()
            self._hop(current)
            host = urlsplit(current).hostname or ""
            PACER.wait(host)
            cap = max_bytes
            if meter is not None:
                cap = min(cap, meter.remaining())
                if cap <= 0:
                    raise BudgetExceeded("transfer allowance for this request is used up")
            with self.client.stream("GET", current, params=params) as resp:
                params = None
                if resp.status_code in (301, 302, 303, 307, 308):
                    loc = resp.headers.get("location")
                    if not loc:
                        raise FetchError("redirect without location")
                    current = urljoin(current, loc)
                    continue
                if resp.status_code == 429 or resp.status_code >= 500:
                    raise _Retryable(f"HTTP {resp.status_code}")
                declared = resp.headers.get("content-length")
                if declared and declared.isdigit() and int(declared) > cap:
                    raise BudgetExceeded(f"{host} declared {int(declared)} bytes, over the {cap}-byte cap")
                buf = bytearray()
                try:
                    for chunk in resp.iter_bytes(16_384):
                        buf += chunk
                        if token and token.cancelled:
                            raise Cancelled(token.reason)
                        if len(buf) > cap or resp.num_bytes_downloaded > cap:
                            raise BudgetExceeded(f"{host} sent more than the {cap}-byte cap; aborted")
                finally:
                    # bytes that crossed the network (compressed), not the decoded size
                    if meter is not None:
                        meter.add(category, resp.num_bytes_downloaded)
                resp.final_url = current  # type: ignore[attr-defined]
                return resp, bytes(buf)
        raise FetchError("too many redirects")

    def get_json(self, url: str, **kw) -> dict:
        import json

        resp, body = self.get(url, max_bytes=kw.pop("max_bytes", 2_000_000), **kw)
        if resp.status_code >= 400:
            raise FetchError(f"HTTP {resp.status_code} from {urlsplit(url).hostname}")
        try:
            return json.loads(body)
        except ValueError as e:
            raise FetchError("invalid JSON") from e

    def resolve_redirects(self, url: str, *, meter: Meter | None = None, token: CancelToken | None = None) -> str:
        """Follow (validated) redirects of a share link without reading the final body beyond 64 KB."""
        resp, _ = self.get(url, max_bytes=262_144, meter=meter, token=token, category="metadata", retries=1)
        return getattr(resp, "final_url", url)


class _Retryable(Exception):
    pass
