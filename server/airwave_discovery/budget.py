"""Footprint measurement and enforcement of the storage budget (config.StorageBudget).

What counts toward the 5 GB application cap: the Python environment (`server/.venv`), the web
build dependencies (`web/node_modules`) and build output (`web/dist`), model files, the SQLite
database with its WAL/SHM files, logs and temporary audio. Shared runtimes (the uv interpreter
store, the pnpm content store, the OS, the browser and its cache) are reported separately and are
not under this app's control.

Temporary audio is never written to disk: previews are capped at 1.5 MB, decoded in memory and
dropped after inference, so that area stays at 0 bytes. Artwork is loaded by the browser straight
from the providers' CDNs and lives in the browser cache, so the app keeps no artwork store.
"""

from __future__ import annotations

import os
import shutil
import threading
import time
from pathlib import Path

from .config import DATA_DIR, DB_PATH, DEMO_ROOT, LOG_DIR, MODELS_DIR, STORAGE, VENV_DIR, WEB_DIST


class OverBudget(Exception):
    pass


def dir_bytes(path: Path) -> int:
    total = 0
    if not path.exists():
        return 0
    if path.is_file():
        return path.stat().st_size
    for root, dirs, files in os.walk(path, followlinks=False):
        for f in files:
            try:
                p = os.path.join(root, f)
                if not os.path.islink(p):
                    total += os.stat(p).st_size
            except OSError:
                pass
    return total


def db_bytes() -> int:
    return sum(Path(str(DB_PATH) + s).stat().st_size for s in ("", "-wal", "-shm") if Path(str(DB_PATH) + s).exists())


class Footprint:
    """Measured sizes, refreshed in the background at most every `ttl` seconds."""

    def __init__(self, ttl: float = 300.0) -> None:
        self.ttl = ttl
        self._value: dict | None = None
        self._at = 0.0
        self._lock = threading.Lock()

    def measure(self) -> dict:
        t = time.perf_counter()
        areas = {
            "runtime": dir_bytes(VENV_DIR) + dir_bytes(DEMO_ROOT / "web" / "node_modules") + dir_bytes(WEB_DIST),
            "models": dir_bytes(MODELS_DIR),
            "database": db_bytes(),
            "logs": dir_bytes(LOG_DIR),
            "temp_audio": dir_bytes(DATA_DIR / "tmp"),
            "artwork": 0,
        }
        limits = {k: getattr(STORAGE, k) for k in areas}
        total = sum(areas.values())
        return {
            "areas": areas,
            "limits": limits,
            "total": total,
            "hard_cap": STORAGE.hard_cap,
            "target": STORAGE.target,
            "free_disk": shutil.disk_usage(DATA_DIR if DATA_DIR.exists() else DEMO_ROOT).free,
            "measured_ms": int((time.perf_counter() - t) * 1000),
            "measured_at": time.time(),
            "not_counted": "uv interpreter store, pnpm store, OS, browser and browser cache (shared, not app-managed)",
        }

    def get(self, fresh: bool = False) -> dict:
        with self._lock:
            if fresh or self._value is None or time.time() - self._at > self.ttl:
                self._value = self.measure()
                self._at = time.time()
            return self._value

    def invalidate(self) -> None:
        with self._lock:
            self._value = None


FOOTPRINT = Footprint()


def ensure_room(area: str, incoming: int) -> None:
    """Refuse a write of `incoming` bytes that would break the area ceiling or the hard cap."""
    fp = FOOTPRINT.get(fresh=True)
    limit = getattr(STORAGE, area)
    if fp["areas"].get(area, 0) + incoming > limit:
        raise OverBudget(f"{area} would exceed its {limit / 1e9:.2f} GB ceiling")
    if fp["total"] + incoming > STORAGE.hard_cap:
        raise OverBudget(f"the app would exceed its {STORAGE.hard_cap / 1e9:.1f} GB footprint cap")
    if fp["free_disk"] - incoming < STORAGE.free_disk_floor:
        raise OverBudget("not enough free disk space")
