"""SQLite persistence (WAL). User data (seeds, settings, feedback) is protected; caches and vectors
are recomputable and LRU-evicted against the storage budget.

Every write that can grow the file first checks the free-disk floor, so running out of disk ends
in a refused write rather than a half-written database.
"""

from __future__ import annotations

import json
import shutil
import sqlite3
import threading
import time
from pathlib import Path

import numpy as np

from .config import DB_PATH, STORAGE

SCHEMA = """
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated REAL NOT NULL);
CREATE TABLE IF NOT EXISTS seeds (
  pos INTEGER NOT NULL, key TEXT PRIMARY KEY, track TEXT NOT NULL, emphasis REAL NOT NULL DEFAULT 1.0, added REAL NOT NULL);
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL, key TEXT NOT NULL, kind TEXT NOT NULL,
  artist TEXT NOT NULL DEFAULT '', track TEXT, listened REAL, ts REAL NOT NULL);
CREATE INDEX IF NOT EXISTS feedback_key ON feedback(key);
CREATE TABLE IF NOT EXISTS impressions (key TEXT NOT NULL, ts REAL NOT NULL);
CREATE INDEX IF NOT EXISTS impressions_key ON impressions(key, ts);
CREATE TABLE IF NOT EXISTS cache (
  k TEXT PRIMARY KEY, kind TEXT NOT NULL, v BLOB NOT NULL, size INTEGER NOT NULL,
  created REAL NOT NULL, expires REAL NOT NULL, accessed REAL NOT NULL);
CREATE INDEX IF NOT EXISTS cache_lru ON cache(accessed);
CREATE TABLE IF NOT EXISTS vectors (
  rec_key TEXT NOT NULL, model_id TEXT NOT NULL, preprocess_id TEXT NOT NULL, dim INTEGER NOT NULL,
  v BLOB NOT NULL, source TEXT NOT NULL, created REAL NOT NULL, accessed REAL NOT NULL,
  PRIMARY KEY (rec_key, model_id, preprocess_id));
CREATE TABLE IF NOT EXISTS transfer (day TEXT NOT NULL, category TEXT NOT NULL, bytes INTEGER NOT NULL,
  PRIMARY KEY (day, category));
"""


class DiskFull(Exception):
    pass


class _Rows:
    """Rows already fetched under the store lock; mirrors the cursor methods the store uses."""

    __slots__ = ("_rows", "rowcount")

    def __init__(self, rows: list, rowcount: int) -> None:
        self._rows = rows
        self.rowcount = rowcount

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self) -> list:
        return list(self._rows)


class Store:
    def __init__(self, path: Path = DB_PATH, cache_budget: int = STORAGE.database, free_floor: int = STORAGE.free_disk_floor) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.cache_budget = cache_budget
        self.free_floor = free_floor
        self._lock = threading.RLock()
        self.db = sqlite3.connect(str(self.path), check_same_thread=False, isolation_level=None)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=NORMAL")
        self.db.execute("PRAGMA busy_timeout=5000")
        self.db.executescript(SCHEMA)
        # v2 telemetry (migration: additive, nullable; old rows and old readers are unaffected)
        cols = {r[1] for r in self.db.execute("PRAGMA table_info(feedback)").fetchall()}
        if "meta" not in cols:
            self.db.execute("ALTER TABLE feedback ADD COLUMN meta TEXT")
        self.cache_hits = 0
        self.cache_misses = 0

    # ---- low level -------------------------------------------------------------------------
    def _guard_disk(self, incoming: int = 0) -> None:
        free = shutil.disk_usage(self.path.parent).free
        if free - incoming < self.free_floor:
            raise DiskFull(f"only {free // 1_000_000} MB free; refusing to write")

    def _exec(self, sql: str, args: tuple = ()) -> "_Rows":
        # Rows are fetched while the lock is held: the pipeline reads this connection from several
        # worker threads, and a cursor read after the lock is released can interleave with another
        # thread's statement on the same connection.
        with self._lock:
            cur = self.db.execute(sql, args)
            return _Rows(cur.fetchall() if cur.description else [], cur.rowcount)

    def close(self) -> None:
        with self._lock:
            self.db.close()

    # ---- settings ----------------------------------------------------------------------------
    def get(self, k: str, default=None):
        row = self._exec("SELECT v FROM kv WHERE k=?", (k,)).fetchone()
        return json.loads(row[0]) if row else default

    def put(self, k: str, v) -> None:
        self._guard_disk()
        self._exec("INSERT INTO kv(k,v,updated) VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated=excluded.updated", (k, json.dumps(v), time.time()))

    # ---- seeds -----------------------------------------------------------------------------
    def seeds(self) -> list[dict]:
        rows = self._exec("SELECT track, emphasis FROM seeds ORDER BY pos").fetchall()
        out = []
        for track, emphasis in rows:
            t = json.loads(track)
            t["emphasis"] = emphasis
            out.append(t)
        return out

    def set_seeds(self, seeds: list[dict]) -> None:
        self._guard_disk()
        with self._lock:
            self.db.execute("BEGIN")
            try:
                self.db.execute("DELETE FROM seeds")
                for i, s in enumerate(seeds):
                    emphasis = float(s.get("emphasis", 1.0))
                    body = {k: v for k, v in s.items() if k != "emphasis"}
                    self.db.execute("INSERT INTO seeds(pos,key,track,emphasis,added) VALUES(?,?,?,?,?)", (i, s["key"], json.dumps(body), emphasis, time.time()))
                self.db.execute("COMMIT")
            except Exception:
                self.db.execute("ROLLBACK")
                raise

    # ---- feedback --------------------------------------------------------------------------
    def add_feedback(self, event_id: str, key: str, kind: str, artist: str, track: dict | None, listened: float | None, ts: float | None = None, meta: dict | None = None) -> bool:
        """Returns False when the event id was already recorded (deduplicated)."""
        self._guard_disk()
        cur = self._exec(
            "INSERT OR IGNORE INTO feedback(event_id,key,kind,artist,track,listened,ts,meta) VALUES(?,?,?,?,?,?,?,?)",
            (event_id, key, kind, artist, json.dumps(track) if track else None, listened, ts or time.time(),
             json.dumps({"schema": 2, **meta}) if meta else None),
        )
        return cur.rowcount == 1

    def feedback(self) -> list[dict]:
        rows = self._exec("SELECT event_id,key,kind,artist,track,listened,ts,meta FROM feedback ORDER BY id").fetchall()
        out = []
        for r in rows:
            d = {"event_id": r[0], "key": r[1], "kind": r[2], "artist": r[3], "track": json.loads(r[4]) if r[4] else None, "listened": r[5], "ts": r[6]}
            if r[7]:
                try:
                    m = json.loads(r[7])
                    for k in ("duration", "medium", "session", "origin", "confidence"):
                        if k in m:
                            d[k] = m[k]
                except (ValueError, TypeError):
                    pass  # a corrupt meta blob only loses telemetry, never the event
            out.append(d)
        return out

    def remove_feedback(self, key: str, kinds: tuple[str, ...]) -> int:
        q = ",".join("?" * len(kinds))
        return self._exec(f"DELETE FROM feedback WHERE key=? AND kind IN ({q})", (key, *kinds)).rowcount

    # ---- impressions -----------------------------------------------------------------------
    def add_impressions(self, keys: list[str], ts: float | None = None) -> None:
        self._guard_disk()
        now = ts or time.time()
        with self._lock:
            self.db.executemany("INSERT INTO impressions(key,ts) VALUES(?,?)", [(k, now) for k in keys])

    def impressions(self, since: float) -> dict[str, int]:
        rows = self._exec("SELECT key, COUNT(*) FROM impressions WHERE ts>=? GROUP BY key", (since,)).fetchall()
        return {k: n for k, n in rows}

    def expire_impressions(self, before: float) -> int:
        return self._exec("DELETE FROM impressions WHERE ts<?", (before,)).rowcount

    # ---- cache -----------------------------------------------------------------------------
    def cache_get(self, k: str, allow_stale: bool = False):
        row = self._exec("SELECT v, expires, created FROM cache WHERE k=?", (k,)).fetchone()
        if not row:
            self.cache_misses += 1
            return None
        v, expires, created = row
        now = time.time()
        if not isinstance(expires, (int, float)):
            # A malformed row is a cache miss, never a crash: callers read the cache outside their error handling.
            self._exec("DELETE FROM cache WHERE k=?", (k,))
            self.cache_misses += 1
            return None
        if expires < now and not allow_stale:
            self.cache_misses += 1
            return None
        self._exec("UPDATE cache SET accessed=? WHERE k=?", (now, k))
        self.cache_hits += 1
        return {"value": json.loads(v), "created": created, "stale": expires < now}

    def cache_put(self, k: str, kind: str, value, ttl: float) -> None:
        blob = json.dumps(value).encode()
        self._guard_disk(len(blob))
        now = time.time()
        self._exec(
            "INSERT INTO cache(k,kind,v,size,created,expires,accessed) VALUES(?,?,?,?,?,?,?) "
            "ON CONFLICT(k) DO UPDATE SET v=excluded.v,size=excluded.size,created=excluded.created,expires=excluded.expires,accessed=excluded.accessed",
            (k, kind, blob, len(blob), now, now + ttl, now),
        )
        self.evict()

    def cache_bytes(self) -> int:
        a = self._exec("SELECT COALESCE(SUM(size),0) FROM cache").fetchone()[0]
        b = self._exec("SELECT COALESCE(SUM(LENGTH(v)),0) FROM vectors").fetchone()[0]
        return int(a + b)

    def evict(self, budget: int | None = None) -> int:
        """LRU-evict cache rows, then vectors, until recomputable data fits the budget."""
        budget = self.cache_budget if budget is None else budget
        removed = 0
        with self._lock:
            total = self.cache_bytes()
            if total <= budget:
                return 0
            for table, size_expr, key_cols in (("cache", "size", "k"), ("vectors", "LENGTH(v)", "rec_key, model_id, preprocess_id")):
                rows = self.db.execute(f"SELECT {key_cols}, {size_expr} FROM {table} ORDER BY accessed ASC").fetchall()
                for row in rows:
                    if total <= budget:
                        break
                    *keys, size = row
                    if table == "cache":
                        self.db.execute("DELETE FROM cache WHERE k=?", (keys[0],))
                    else:
                        self.db.execute("DELETE FROM vectors WHERE rec_key=? AND model_id=? AND preprocess_id=?", tuple(keys))
                    total -= size
                    removed += 1
        return removed

    def clear_cache(self) -> None:
        self._exec("DELETE FROM cache")

    # ---- vectors ---------------------------------------------------------------------------
    def vector_get(self, rec_key: str, model_id: str, preprocess_id: str) -> np.ndarray | None:
        row = self._exec("SELECT v, dim FROM vectors WHERE rec_key=? AND model_id=? AND preprocess_id=?", (rec_key, model_id, preprocess_id)).fetchone()
        if not row:
            return None
        self._exec("UPDATE vectors SET accessed=? WHERE rec_key=? AND model_id=? AND preprocess_id=?", (time.time(), rec_key, model_id, preprocess_id))
        return np.frombuffer(row[0], dtype=np.float32, count=row[1]).copy()

    def vector_put(self, rec_key: str, model_id: str, preprocess_id: str, v: np.ndarray, source: str) -> None:
        blob = np.asarray(v, dtype=np.float32).tobytes()
        self._guard_disk(len(blob))
        now = time.time()
        self._exec(
            "INSERT OR REPLACE INTO vectors(rec_key,model_id,preprocess_id,dim,v,source,created,accessed) VALUES(?,?,?,?,?,?,?,?)",
            (rec_key, model_id, preprocess_id, int(v.shape[0]), blob, source, now, now),
        )
        self.evict()

    def vector_count(self) -> int:
        return self._exec("SELECT COUNT(*) FROM vectors").fetchone()[0]

    # ---- transfer accounting ---------------------------------------------------------------
    def add_transfer(self, category: str, n: int, day: str | None = None) -> None:
        if n <= 0:
            return
        day = day or time.strftime("%Y-%m-%d")
        self._exec(
            "INSERT INTO transfer(day,category,bytes) VALUES(?,?,?) ON CONFLICT(day,category) DO UPDATE SET bytes=bytes+excluded.bytes",
            (day, category, n),
        )

    def transfer_today(self, day: str | None = None) -> dict[str, int]:
        day = day or time.strftime("%Y-%m-%d")
        return {c: b for c, b in self._exec("SELECT category, bytes FROM transfer WHERE day=?", (day,)).fetchall()}

    # ---- footprint / export / reset ---------------------------------------------------------
    def file_bytes(self) -> int:
        total = 0
        for suffix in ("", "-wal", "-shm"):
            p = Path(str(self.path) + suffix)
            if p.exists():
                total += p.stat().st_size
        return total

    def export(self) -> dict:
        return {
            "format": "airwave-discovery-export/1",
            "exported": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "seeds": self.seeds(),
            "settings": self.get("settings", {}),
            "feedback": self.feedback(),
        }

    def reset(self, keep_cache: bool = True) -> None:
        with self._lock:
            self.db.execute("BEGIN")
            self.db.execute("DELETE FROM seeds")
            self.db.execute("DELETE FROM feedback")
            self.db.execute("DELETE FROM impressions")
            self.db.execute("DELETE FROM kv")
            if not keep_cache:
                self.db.execute("DELETE FROM cache")
                self.db.execute("DELETE FROM vectors")
            self.db.execute("COMMIT")
        self.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
