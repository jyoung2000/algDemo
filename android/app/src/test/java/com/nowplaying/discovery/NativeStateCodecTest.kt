package com.nowplaying.discovery

import com.nowplaying.discovery.engine.PlayQueue
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** NATIVE-COLD-STATE-001: what the service keeps across a process death (synthetic songs and links only). */
class NativeStateCodecTest {
  private class MapIo : NativeStateCodec.Io {
    val map = HashMap<String, String>()
    var writes = 0
    override fun get(key: String): String? = map[key]
    override fun put(key: String, value: String?) { writes++; if (value == null) map.remove(key) else map[key] = value }
  }

  @After fun reset() = NativeLibraryState.initForTest(null)

  private fun song(id: String) = JSONObject().put("id", id).put("title", "Song $id").put("artist", "Artist").put("durationMs", 215_000).put("ready", false)
  private fun track(key: String, extra: Int = 0) = JSONObject().put("key", key).put("title", "Song $key").put("pad", "x".repeat(extra))
  private val allowed: (String) -> Boolean = { it.startsWith("https://allowed.example/") }

  @Test fun libraryRoundTripsAndRemembersItsTracks() {
    val io = MapIo()
    val lib = JSONObject()
      .put("songs", JSONArray().put(song("a").put("track", track("a"))).put(song("b")))
      .put("playlists", JSONArray().put(JSONObject().put("id", "p1").put("title", "Road").put("songs", JSONArray().put(song("b")))))
    assertTrue(NativeStateCodec.Store(io).recordLibrary(lib))
    // A fresh store over the same storage (a new process) reads back exactly what was saved.
    val again = NativeStateCodec.Store(io)
    assertEquals(lib.toString(), again.library().toString())
    assertEquals("Song a", again.rawTrack("a")!!.getString("title"))
    assertNull(again.rawTrack("b"))
    assertEquals(1, again.tracks().length())
  }

  // PLAYLIST-KEEP-001: the page pushes its songs before it has read its lists; that must not cost the car its playlists.
  @Test fun aPushThatNamesOnlyTheSongsKeepsTheSavedPlaylists() {
    val io = MapIo()
    val road = JSONArray().put(JSONObject().put("id", "p1").put("title", "Road").put("songs", JSONArray().put(song("b"))))
    val store = NativeStateCodec.Store(io)
    assertTrue(store.recordLibrary(JSONObject().put("songs", JSONArray().put(song("a"))).put("playlists", road)))
    assertTrue(store.recordLibrary(JSONObject().put("songs", JSONArray().put(song("c")))))
    val again = NativeStateCodec.Store(io).library()!!
    assertEquals("c", again.getJSONArray("songs").getJSONObject(0).getString("id"))
    assertEquals(road.toString(), again.getJSONArray("playlists").toString())
    // An explicit empty list still means the listener has none.
    assertTrue(store.recordLibrary(JSONObject().put("songs", JSONArray()).put("playlists", JSONArray())))
    assertEquals(0, NativeStateCodec.Store(io).library()!!.getJSONArray("playlists").length())
  }

  // CAR-SAVE-HIDDEN-001: a song the driver added to a playlist with the phone app away is in the saved lists the
  // car reads on its next cold start, without waiting for the app to be opened.
  @Test fun aSongAddedFromTheCarIsInTheSavedPlaylists() {
    val io = MapIo()
    val store = NativeStateCodec.Store(io)
    val lists = JSONArray().put(JSONObject().put("id", "p1").put("title", "Road").put("songs", JSONArray().put(song("b"))))
    assertTrue(store.recordLibrary(JSONObject().put("songs", JSONArray().put(song("a")).put(song("b"))).put("playlists", lists)))
    assertTrue(store.addToPlaylist("p1", song("a"), null))
    assertEquals(listOf("b", "a"), ids(NativeStateCodec.Store(io).library()!!.getJSONArray("playlists").getJSONObject(0).getJSONArray("songs")))
    assertEquals("a second add of the same song changes nothing", false, store.addToPlaylist("p1", song("a"), null))
    assertEquals("an unknown playlist is not invented", false, store.addToPlaylist("nope", song("a"), null))
    // With a name, the playlist is started (the car's own "Car picks").
    assertTrue(store.addToPlaylist("new", song("a"), "Car picks"))
    val again = NativeStateCodec.Store(io).library()!!.getJSONArray("playlists")
    assertEquals(2, again.length())
    assertEquals("Car picks", again.getJSONObject(1).getString("title"))
    assertEquals(listOf("a"), ids(again.getJSONObject(1).getJSONArray("songs")))
  }
  private fun ids(a: JSONArray) = (0 until a.length()).map { a.getJSONObject(it).getString("id") }

  @Test fun addingFromTheCarWithNothingSavedYetIsRefused() {
    assertEquals(false, NativeStateCodec.Store(MapIo()).addToPlaylist("p1", song("a"), "Car picks"))
  }

  @Test fun corruptOrOtherVersionValuesAreIgnoredAndRemoved() {
    val io = MapIo()
    io.map[NativeStateCodec.KEY_LIBRARY] = "{not json"
    io.map[NativeStateCodec.KEY_SETTINGS] = JSONObject().put("v", 99).put("data", JSONObject().put("volume", 0.5)).toString()
    io.map[NativeStateCodec.KEY_NATIVE] = NativeStateCodec.wrap(JSONObject().put("queue", "nope"))!!
    val s = NativeStateCodec.Store(io)
    assertNull(s.library())
    assertNull(s.settings())
    assertNull(s.nativeState())
    assertFalse(io.map.containsKey(NativeStateCodec.KEY_LIBRARY))
    assertFalse(io.map.containsKey(NativeStateCodec.KEY_SETTINGS))
    assertFalse(io.map.containsKey(NativeStateCodec.KEY_NATIVE))
  }

  @Test fun oversizeValuesAreRefusedNotTruncated() {
    val s = NativeStateCodec.Store(MapIo())
    val songs = JSONArray().apply { repeat(NativeStateCodec.MAX_SONGS + 1) { put(song("s$it")) } }
    assertFalse(s.recordLibrary(JSONObject().put("songs", songs)))
    assertNull(s.library())
    assertFalse(s.rememberTrack(track("big", NativeStateCodec.MAX_TRACK_CHARS)))
    assertFalse(s.rememberTrack(JSONObject().put("title", "no key")))
    assertNull(s.rawTrack("big"))
  }

  @Test fun rememberedTracksAreBoundedOldestFirstOut() {
    val io = MapIo()
    val s = NativeStateCodec.Store(io)
    val batch = JSONArray().apply { repeat(NativeStateCodec.MAX_TRACKS) { put(track("t$it")) } }
    assertEquals(NativeStateCodec.MAX_TRACKS, s.rememberTracks(batch))
    assertEquals(1, io.writes) // one write for the whole batch
    assertTrue(s.rememberTrack(track("newest")))
    assertNull(s.rawTrack("t0"))
    assertNotNull(s.rawTrack("t1"))
    assertEquals(NativeStateCodec.MAX_TRACKS, NativeStateCodec.Store(io).tracks().length())
  }

  @Test fun settingsKeepOnlyTheFourAndLaterPartialsMerge() {
    val io = MapIo()
    val s = NativeStateCodec.Store(io)
    assertTrue(s.recordSettings(JSONObject().put("eq", JSONObject().put("on", true).put("presetId", "rock")).put("mix", 40).put("volume", 0.8).put("theme", "dark")))
    assertTrue(s.recordSettings(JSONObject().put("volume", 0.3)))
    assertFalse(s.recordSettings(JSONObject().put("theme", "light")))
    val saved = NativeStateCodec.Store(io).settings()!!
    assertEquals("rock", saved.getJSONObject("eq").getString("presetId"))
    assertEquals(40, saved.getInt("mix"))
    assertEquals(0.3, saved.getDouble("volume"), 1e-9)
    assertFalse(saved.has("theme"))
  }

  @Test fun pageSettingsWinOverSavedOnes() {
    // EngineHub.init: saved settings only fill keys the page has not already sent in this process.
    NativeLibraryState.initForTest(MapIo())
    NativeLibraryState.recordSettings(JSONObject().put("volume", 0.2).put("mix", 10))
    val page = JSONObject().put("volume", 0.9)
    NativeLibraryState.settings()!!.let { saved -> for (k in saved.keys()) if (!page.has(k)) page.put(k, saved.get(k)) }
    assertEquals(0.9, page.getDouble("volume"), 1e-9)
    assertEquals(10, page.getInt("mix"))
  }

  @Test fun nativeQueueRoundTripsWithItsShuffleRoundAndDropsDisallowedLinks() {
    val entries = listOf(
      "a" to NativeStateCodec.songOf(song("a").put("ready", true).put("source", "https://allowed.example/a"), allowed)!!,
      "playlist/p1/track/b" to NativeStateCodec.songOf(song("b"), allowed)!!,
      "c" to NativeStateCodec.songOf(song("c"), allowed)!!,
    )
    val control = PlayQueue.Control(1, PlayQueue.Repeat.TWICE, true, listOf("c", "a", "b"), listOf("b", "c"), listOf("c", "a"))
    val json = NativeStateCodec.nativeJson(NativeStateCodec.NativeQueue(entries, control, 61_000))
    val io = MapIo()
    assertTrue(NativeStateCodec.Store(io).recordNativeState(json))
    val back = NativeStateCodec.nativeOf(NativeStateCodec.Store(io).nativeState()!!, allowed)!!
    assertEquals(entries.map { it.first }, back.entries.map { it.first })
    assertEquals("https://allowed.example/a", back.entries[0].second.source)
    assertTrue(back.entries[0].second.ready)
    assertEquals(215_000L, back.entries[0].second.durationMs)
    // The round is restored as saved, not restarted.
    assertEquals(control, back.control)
    assertEquals(61_000L, back.positionMs)
    // REPEAT-COUNT-001: every offered repeat state survives a restart; the retired repeat-list
    // setting (wire value 2) comes back as off rather than as something the button cannot show.
    for (r in listOf(PlayQueue.Repeat.OFF, PlayQueue.Repeat.ONCE, PlayQueue.Repeat.TWICE, PlayQueue.Repeat.ONE)) {
      val saved = NativeStateCodec.nativeJson(NativeStateCodec.NativeQueue(entries, control.copy(repeat = r), 0))
      assertEquals(r, NativeStateCodec.nativeOf(saved, allowed)!!.control.repeat)
    }
    val legacy = NativeStateCodec.nativeJson(NativeStateCodec.NativeQueue(entries, control.copy(repeat = PlayQueue.Repeat.ALL), 0))
    assertEquals(PlayQueue.Repeat.OFF, NativeStateCodec.nativeOf(legacy, allowed)!!.control.repeat)
    assertEquals(PlayQueue.Repeat.OFF, NativeStateCodec.nativeOf(JSONObject(json.toString()).put("repeat", 2), allowed)!!.control.repeat)
    // A link the guard no longer allows is dropped, and the song is then not ready.
    val strict = NativeStateCodec.nativeOf(json, { false })!!
    assertNull(strict.entries[0].second.source)
    assertFalse(strict.entries[0].second.ready)
  }

  @Test fun invalidNativeStateIsRefusedWhole() {
    val s = NativeStateCodec.Store(MapIo())
    val q = JSONArray().put(JSONObject().put("mediaId", "a").put("song", song("a")))
    assertFalse(s.recordNativeState(JSONObject().put("queue", q).put("index", 5)))
    assertFalse(s.recordNativeState(JSONObject().put("queue", JSONArray().put(JSONObject().put("mediaId", "").put("song", song("a")))).put("index", 0)))
    assertTrue(s.recordNativeState(JSONObject().put("queue", q).put("index", 0)))
  }

  @Test fun positionOnlyWritesAreThrottledButQueueChangesAreNot() {
    val t = NativeStateCodec.PositionThrottle(5000)
    assertTrue(t.shouldWrite(1, 0))
    assertFalse(t.shouldWrite(1, 1000))
    assertTrue(t.shouldWrite(2, 1500))
    assertFalse(t.shouldWrite(2, 6000))
    assertTrue(t.shouldWrite(2, 6500))
  }

  @Test fun facadeIsInertBeforeInit() {
    NativeLibraryState.initForTest(null)
    assertFalse(NativeLibraryState.recordLibrary(JSONObject().put("songs", JSONArray())))
    assertNull(NativeLibraryState.library())
    assertNull(NativeLibraryState.tracks())
    assertEquals(0, NativeLibraryState.rememberTracks(JSONArray().put(track("a"))))
  }
}
