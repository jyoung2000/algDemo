"""The listening queue: ordering, history, Previous/Next, dedupe, removal and restore."""

import pytest

from airwave_discovery.queue import DISCOVERED, SEARCHED, ListeningQueue, QueueError


def tr(key):
    return {"key": key, "provider": "deezer", "platform_id": key, "title": key, "artists": ["A"]}


def pb():
    return {"open": [], "preview": None, "embed": None}


def keys(q):
    return [e.track["key"] for e in q.entries]


def test_searched_go_after_searched_and_discovered_stay_below():
    q = ListeningQueue()
    q.add_searched(tr("s1"), pb())
    q.append_discovered(tr("d1"), pb(), {"rank": 1})
    q.add_searched(tr("s2"), pb())
    assert keys(q) == ["s1", "s2", "d1"]
    assert [e.source for e in q.entries] == [SEARCHED, SEARCHED, DISCOVERED]


def test_dedupe_by_recording_key():
    q = ListeningQueue()
    q.add_searched(tr("x"), pb())
    with pytest.raises(QueueError) as e:
        q.add_searched(tr("x"), pb())
    assert e.value.status == 409
    assert q.append_discovered(tr("x"), pb(), {}) is None
    assert keys(q) == ["x"]


def test_next_and_previous_walk_the_played_order_not_the_list_position():
    q = ListeningQueue()
    for k in ("a", "b", "c"):
        q.add_searched(tr(k), pb())
    q.next()  # nothing playing: first song
    assert q.find(q.current).track["key"] == "a"
    q.next()
    q.next()
    assert q.find(q.current).track["key"] == "c"
    q.previous()
    assert q.find(q.current).track["key"] == "b"
    q.previous()
    assert q.find(q.current).track["key"] == "a"
    with pytest.raises(QueueError):
        q.previous()


def test_play_jumps_and_previous_returns_to_where_you_were():
    q = ListeningQueue()
    ids = [q.add_searched(tr(k), pb()).id for k in ("a", "b", "c")]
    q.play(ids[0])
    q.play(ids[2])  # jump ahead
    q.previous()
    assert q.current == ids[0]


def test_next_at_the_end_clears_current_and_keeps_history():
    q = ListeningQueue()
    ids = [q.add_searched(tr(k), pb()).id for k in ("a", "b")]
    q.play(ids[1])
    q.next()
    assert q.current is None
    assert q.history == [ids[1]]


def test_discovered_songs_append_while_playing_and_do_not_move_current():
    q = ListeningQueue()
    a = q.add_searched(tr("a"), pb())
    q.play(a.id)
    q.append_discovered(tr("d1"), pb(), {})
    q.append_discovered(tr("d2"), pb(), {})
    assert q.current == a.id
    assert keys(q) == ["a", "d1", "d2"]


def test_removing_the_playing_song_moves_to_the_next_one_and_drops_it_from_history():
    q = ListeningQueue()
    ids = [q.add_searched(tr(k), pb()).id for k in ("a", "b", "c")]
    q.play(ids[0])
    q.play(ids[1])  # history: [a]; playing b
    q.remove(ids[1])
    assert q.current == ids[2]
    assert q.history == [ids[0]]


def test_previous_skips_songs_removed_since_they_played():
    q = ListeningQueue()
    ids = [q.add_searched(tr(k), pb()).id for k in ("a", "b", "c")]
    q.play(ids[0])
    q.play(ids[1])
    q.play(ids[2])  # history: [a, b]; playing c
    q.remove(ids[1])  # b played earlier and is now gone
    q.previous()
    assert q.current == ids[0]


def test_state_bumps_version_and_wakes_waiters():
    q = ListeningQueue()
    v0 = q.version
    q.add_searched(tr("a"), pb())
    assert q.version > v0
    assert q.wait_for_change(q.version, 0.05) == q.version  # nothing new: times out with the same version


def test_restore_keeps_order_and_drops_dangling_references():
    q = ListeningQueue()
    a = q.add_searched(tr("a"), pb())
    b = q.append_discovered(tr("b"), pb(), {"rank": 1})
    snap = q.snapshot_for_store()
    snap["current"] = "gone"
    snap["history"] = [a.id, "gone"]
    r = ListeningQueue(snap)
    assert keys(r) == ["a", "b"]
    assert r.current is None
    assert r.history == [a.id]
    assert r.entries[1].source == DISCOVERED
    assert r.saved_at is not None


def test_restore_ignores_malformed_entries():
    r = ListeningQueue({"entries": [{"id": "x", "source": "weird", "track": {}}, {"id": "y", "source": SEARCHED}, "junk"]})
    assert r.entries == []
