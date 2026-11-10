package com.nowplaying.discovery

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.TimeUnit
import java.util.concurrent.ExecutionException

@RunWith(AndroidJUnit4::class)
class CarSearchTest {
  private fun seed() = MediaHub.apply(JSONObject("""{"state":{"queue":[]},"library":{"songs":[{"id":"q1","title":"Halo","artist":"Beyoncé","ready":true}],"playlists":[{"id":"p1","title":"Evening mix","songs":[{"id":"p1s1","title":"Teardrop","artist":"Massive Attack","ready":true}]}]}}"""))

  @Test fun searchIncludesPlaylistOnlyTracksAndNormalizesWordsAndAccents() {
    seed()
    assertEquals(listOf("q1"), MediaHub.search("beyonce halo").map { it.id })
    assertEquals(listOf("p1s1"), MediaHub.search("massive teardrop").map { it.id })
    assertEquals(listOf("p1s1"), MediaHub.search("Evening mix").map { it.id })
    assertTrue(MediaHub.search(" ").isEmpty())
    assertTrue(MediaHub.search("not-a-real-song-zzzz").isEmpty())
  }

  @Test fun newQueryRequestsCatalogueAndReplyRemainsSelectableWithoutAddingToQueue() {
    seed()
    val sink: (JSONObject) -> Unit = { cmd ->
      assertEquals("catalogSearch", cmd.optString("type"))
      MediaHub.apply(JSONObject().put("search", JSONObject()
        .put("requestId", cmd.getString("requestId")).put("query", cmd.getString("query"))
        .put("songs", org.json.JSONArray("""[{"id":"external1","title":"New catalogue recording","artist":"Artist","ready":false}]"""))))
    }
    MediaHub.setCommandSink(sink)
    try {
      val result = MediaHub.searchCatalog("New catalogue recording").get(2, TimeUnit.SECONDS)
      assertEquals("external1", result.single().id)
      assertEquals("external1", MediaHub.findSong("external1")?.id)
      assertEquals(listOf("q1"), MediaHub.songs.map { it.id })
    } finally { MediaHub.clearCommandSink(sink) }
  }

  @Test fun wrongRequestIdCannotInjectResultsAndMissingReplyTimesOut() {
    seed()
    val sink: (JSONObject) -> Unit = { cmd ->
      MediaHub.apply(JSONObject().put("search", JSONObject().put("requestId", "wrong-id")
        .put("query", cmd.getString("query")).put("songs", org.json.JSONArray("""[{"id":"forged","title":"Wrong song"}]"""))))
    }
    MediaHub.setCommandSink(sink)
    try {
      val pending = MediaHub.searchCatalog("unanswered-query", 100)
      try { pending.get(2, TimeUnit.SECONDS); fail("search must time out truthfully") }
      catch (e: ExecutionException) { assertTrue(e.cause is java.util.concurrent.TimeoutException) }
      assertNull(MediaHub.findSong("forged"))
    } finally { MediaHub.clearCommandSink(sink) }
  }
  /** ALBUM-CAR-001: a car search answers with albums the page opened; a voice album request plays one. */
  @Test fun albumRepliesAreBrowsableAndOnlyTheirOwnSongCanBePlayed() {
    seed()
    var asked: JSONObject? = null
    val sink: (JSONObject) -> Unit = { cmd ->
      asked = cmd
      MediaHub.apply(JSONObject().put("search", JSONObject("""{
        "requestId":"${cmd.getString("requestId")}","query":"${cmd.getString("query")}",
        "songs":[{"id":"k1","title":"Green Room","artist":"Ken Carson"}],
        "albums":[
          {"id":"dz:1","title":"A Great Chaos","artist":"Ken Carson","artwork":"https://cdn.example/c.jpg","songs":[
            {"id":"calbum/dz%3A1/track/k1","title":"Green Room","artist":"Ken Carson"},
            {"id":"calbum/dz%3A1/track/k2","title":"Jennifer's Body","artist":"Ken Carson"},
            {"id":"elsewhere","title":"Not this album's"}
          ]},
          {"id":"dz:2","title":"Empty","songs":[]}
        ],
        "play":"calbum/dz%3A1/track/k1"
      }""")))
    }
    MediaHub.setCommandSink(sink)
    try {
      MediaHub.searchCatalog("ken carson chaos", album = true).get(2, TimeUnit.SECONDS)
      assertTrue("the album request is passed to the page", asked!!.getBoolean("album"))
      val albums = MediaHub.albumsFor("ken carson chaos", album = true)
      assertEquals(listOf("dz:1"), albums.map { it.id })
      assertEquals(listOf("calbum/dz%3A1/track/k1", "calbum/dz%3A1/track/k2"), albums.single().songs.map { it.id })
      assertEquals("calbum/dz%3A1/track/k1", MediaHub.albumToPlay("ken carson chaos", true))
      assertEquals("Jennifer's Body", MediaHub.findSong("calbum/dz%3A1/track/k2")?.title)
      assertNull("a song outside the album is not taken in", MediaHub.findSong("elsewhere"))
    } finally { MediaHub.clearCommandSink(sink) }
  }

  @Test fun aForgedPlayIdIsIgnored() {
    seed()
    val sink: (JSONObject) -> Unit = { cmd ->
      MediaHub.apply(JSONObject().put("search", JSONObject()
        .put("requestId", cmd.getString("requestId")).put("query", cmd.getString("query"))
        .put("songs", org.json.JSONArray()).put("play", "playlist/p1/track/p1s1")))
    }
    MediaHub.setCommandSink(sink)
    try {
      MediaHub.searchCatalog("forged album play", album = true).get(2, TimeUnit.SECONDS)
      assertNull(MediaHub.albumToPlay("forged album play", true))
    } finally { MediaHub.clearCommandSink(sink) }
  }

  @Test fun newestTypedQueryIsNotStarvedByPendingPrefixes() {
    seed()
    var last: JSONObject? = null
    val sink: (JSONObject) -> Unit = { last = it }
    MediaHub.setCommandSink(sink)
    try {
      val queries = (0..8).map { MediaHub.searchCatalog("typed-prefix-test-$it") }
      val cmd = requireNotNull(last)
      MediaHub.apply(JSONObject().put("search", JSONObject().put("requestId", cmd.getString("requestId"))
        .put("query", cmd.getString("query")).put("songs", org.json.JSONArray("""[{"id":"final-query-result","title":"Latest typed result"}]"""))))
      assertEquals("final-query-result", queries.last().get(2, TimeUnit.SECONDS).single().id)
      assertTrue("obsolete request has terminated", queries.first().isDone)
    } finally { MediaHub.clearCommandSink(sink) }
  }

}
