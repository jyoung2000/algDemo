"""The one listening queue: searched songs and discovered songs in a single ordered list.

Searched entries are added by the listener and seed discovery. Discovered entries are appended as the
discovery engine finds them. Playback moves through the list with `current` and `history`, so Previous
returns to the song that was actually played, not to the list position.

Every change bumps `version` and wakes subscribers, which is how the events stream pushes state to the
browser or phone. The state is persisted through the store so a restart keeps the queue.
"""

from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass, field

SEARCHED = "searched"
DISCOVERED = "discovered"
MAX_ENTRIES = 500  # discovery stops appending past this; the listener's own adds are never refused for it


class QueueError(Exception):
    """A change the queue refuses; the message is shown to the listener as is."""

    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


@dataclass
class Entry:
    id: str
    source: str  # SEARCHED or DISCOVERED
    track: dict
    playback: dict
    rec: dict | None  # the full scored item for discovered songs; None for searched ones
    added_at: float = field(default_factory=time.time)

    def public(self) -> dict:
        return {"id": self.id, "source": self.source, "track": self.track, "playback": self.playback,
                "rec": self.rec, "added_at": self.added_at}


class ListeningQueue:
    def __init__(self, saved: dict | None = None) -> None:
        self._lock = threading.Condition()
        self.entries: list[Entry] = []
        self.current: str | None = None
        self.history: list[str] = []
        self.discovering = False
        self.discover_note = ""
        self.saved_at: float | None = None
        self.version = 0
        if saved:
            self._restore(saved)

    # ---- state ----------------------------------------------------------------------------
    def _touch(self) -> None:
        self.version += 1
        self._lock.notify_all()

    def state(self) -> dict:
        with self._lock:
            return self._state()

    def _state(self) -> dict:
        return {
            "entries": [e.public() for e in self.entries],
            "current": self.current,
            "history": list(self.history),
            "discovering": self.discovering,
            "discover_note": self.discover_note,
            "saved_at": self.saved_at,
            "version": self.version,
        }

    def snapshot_for_store(self) -> dict:
        """What is written to disk. Entries keep their full JSON; playback links are recomputed on load."""
        with self._lock:
            return {"entries": [e.public() for e in self.entries], "current": self.current, "history": list(self.history)}

    def _restore(self, saved: dict) -> None:
        for raw in saved.get("entries") or []:
            if not isinstance(raw, dict) or not raw.get("id") or raw.get("source") not in (SEARCHED, DISCOVERED):
                continue
            if not isinstance(raw.get("track"), dict):
                continue
            self.entries.append(Entry(id=str(raw["id"]), source=raw["source"], track=raw["track"],
                                      playback=raw.get("playback") or {}, rec=raw.get("rec"),
                                      added_at=float(raw.get("added_at") or time.time())))
        ids = {e.id for e in self.entries}
        self.current = saved.get("current") if saved.get("current") in ids else None
        self.history = [i for i in (saved.get("history") or []) if i in ids]
        self.saved_at = time.time()

    def wait_for_change(self, since: int, timeout: float) -> int:
        """Block until `version` moves past `since` (or the timeout). Returns the version now."""
        with self._lock:
            if self.version == since:
                self._lock.wait(timeout)
            return self.version

    # ---- queries ---------------------------------------------------------------------------
    def find(self, entry_id: str) -> Entry | None:
        return next((e for e in self.entries if e.id == entry_id), None)

    def keys(self) -> set[str]:
        return {e.track.get("key") for e in self.entries if e.track.get("key")}

    def searched(self) -> list[Entry]:
        return [e for e in self.entries if e.source == SEARCHED]

    # ---- changes ---------------------------------------------------------------------------
    def add_searched(self, track: dict, playback: dict) -> Entry:
        with self._lock:
            key = track.get("key")
            if key and any(e.track.get("key") == key for e in self.entries):
                raise QueueError("That song is already in the queue.", 409)
            # A searched song goes after the last searched song, so the listener's own order is kept
            # and discovery's songs stay below them.
            e = Entry(id=uuid.uuid4().hex[:12], source=SEARCHED, track=track, playback=playback, rec=None)
            last_searched = max((i for i, x in enumerate(self.entries) if x.source == SEARCHED), default=-1)
            self.entries.insert(last_searched + 1, e)
            self._touch()
            return e

    def append_discovered(self, track: dict, playback: dict, rec: dict) -> Entry | None:
        """Add one discovered song at the end. Returns None if it is already queued or the queue is full."""
        with self._lock:
            key = track.get("key")
            if key and any(e.track.get("key") == key for e in self.entries):
                return None
            if len(self.entries) >= MAX_ENTRIES:
                return None
            e = Entry(id=uuid.uuid4().hex[:12], source=DISCOVERED, track=track, playback=playback, rec=rec)
            self.entries.append(e)
            self._touch()
            return e

    def remove(self, entry_id: str) -> None:
        with self._lock:
            if not self.find(entry_id):
                raise QueueError("That song is no longer in the queue.", 404)
            idx = next(i for i, e in enumerate(self.entries) if e.id == entry_id)
            self.entries.pop(idx)
            self.history = [i for i in self.history if i != entry_id]
            if self.current == entry_id:
                # Removing the playing song moves to the one after it, as if it had finished.
                self.current = self.entries[idx].id if idx < len(self.entries) else None
            self._touch()

    def play(self, entry_id: str) -> None:
        with self._lock:
            if not self.find(entry_id):
                raise QueueError("That song is no longer in the queue.", 404)
            if self.current and self.current != entry_id:
                self.history.append(self.current)
            self.current = entry_id
            self._touch()

    def next(self) -> None:
        with self._lock:
            if self.current is None:
                if not self.entries:
                    raise QueueError("The queue is empty.", 409)
                self._advance(self.entries[0].id)
                return
            idx = next((i for i, e in enumerate(self.entries) if e.id == self.current), None)
            if idx is None:
                self.current = None
            elif idx + 1 < len(self.entries):
                self._advance(self.entries[idx + 1].id)
            else:
                # the end of the queue: nothing after it; the playing song stays marked as played
                self.history.append(self.current)
                self.current = None
            self._touch()

    def previous(self) -> None:
        with self._lock:
            # Skip history entries whose songs were removed since they played.
            while self.history and self.find(self.history[-1]) is None:
                self.history.pop()
            if not self.history:
                raise QueueError("There is no earlier song to go back to.", 409)
            # The song now playing is dropped, not pushed back on history: Previous steps backwards once.
            self.current = self.history.pop()
            self._touch()

    def _advance(self, entry_id: str) -> None:
        if self.current:
            self.history.append(self.current)
        self.current = entry_id

    def set_discovering(self, value: bool, note: str = "") -> None:
        with self._lock:
            self.discovering = value
            self.discover_note = note
            self._touch()
