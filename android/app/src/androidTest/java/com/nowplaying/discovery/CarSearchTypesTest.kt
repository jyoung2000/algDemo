package com.nowplaying.discovery

import android.content.ComponentName
import android.content.Context
import androidx.media3.session.legacy.MediaBrowserCompat as MediaBrowser
import android.os.Bundle
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * CAR-SEARCH-TYPES-001 (owner, 2026-11-15): "Ensure the search feature on android auto also has the
 * icon feature where you can select search then select the all label or a specific icon to voice
 * search for a single name, album name, lyrics, or reverse search through playing music like shazam".
 * RESULT-ARTIST-001 (owner, 2026-11-15): "add a single user icon for artist to the search results
 * list and android auto so users can search by artist".
 * Read through the platform MediaBrowser, the surface Android Auto itself consumes. The page is a
 * fake sink answering as the real page does; songs are metadata fixtures, not catalogue proof.
 */
@RunWith(AndroidJUnit4::class)
class CarSearchTypesTest {
  private val ctx: Context get() = ApplicationProvider.getApplicationContext()
  private val instr get() = InstrumentationRegistry.getInstrumentation()
  private fun <T> main(block: () -> T): T { val r = AtomicReference<T>(); instr.runOnMainSync { r.set(block()) }; return r.get() }
  private val asked = CopyOnWriteArrayList<JSONObject>()
  private var browser: MediaBrowser? = null
  private val tag = System.nanoTime().toString(36)

  private fun song(id: String, title: String, artist: String, album: String, vararg kinds: String) =
    JSONObject().put("id", id).put("title", title).put("artist", artist).put("album", album).put("durationMs", 150000).put("ready", false)
      .put("kinds", JSONArray(kinds.toList()))
  private val answer = JSONArray()
    .put(song("s1-$tag", "Overseas", "Ken Carson", "Overseas", "single"))
    .put(song("a1-$tag", "Green Room", "Ken Carson", "A Great Chaos", "album"))
    .put(song("f1-$tag", "Fell In Love", "Lil Tecca, Ken Carson", "TEC", "album", "feature"))
    .put(song("l1-$tag", "Rock N Roll", "Ken Carson", "A Great Chaos", "album", "lyrics"))
    // Named after the artist, sung by someone else: the Artists icon must leave it out.
    .put(song("o1-$tag", "Ken Carson Tribute", "Cover Band", "Tribute Hits", "album"))
  private var identifiedReply: JSONObject = JSONObject().put("songs", JSONArray().put(song("heard-$tag", "Heard Song", "Someone", "Heard Song", "single")))

  @Volatile private var failLyrics: String? = null
  private val sink: (JSONObject) -> Unit = sink@{ cmd ->
    asked.add(cmd)
    when (cmd.optString("type")) {
      "catalogSearch" -> {
        val mode = cmd.optString("mode", "all")
        val failure = failLyrics
        if (mode == "lyrics" && failure != null) {
          MediaHub.apply(JSONObject().put("search", JSONObject().put("requestId", cmd.getString("requestId")).put("query", cmd.getString("query")).put("songs", JSONArray()).put("error", failure)))
          return@sink
        }
        val songs = JSONArray()
        for (i in 0 until answer.length()) {
          val s = answer.getJSONObject(i)
          val kinds = s.getJSONArray("kinds").let { k -> (0 until k.length()).map { k.getString(it) } }
          val keep = when (mode) { "singles" -> "single" in kinds; "albums" -> "album" in kinds; "features" -> "feature" in kinds; "lyrics" -> "lyrics" in kinds; else -> true }
          if (keep) songs.put(s)
        }
        MediaHub.apply(JSONObject().put("search", JSONObject().put("requestId", cmd.getString("requestId")).put("query", cmd.getString("query")).put("songs", songs)))
      }
      "identifyAudio" -> MediaHub.apply(JSONObject().put("identify", JSONObject(identifiedReply.toString()).put("requestId", cmd.getString("requestId"))))
    }
  }

  @Before fun setUp() {
    MediaHub.setCommandSink(sink)
    MediaHub.apply(JSONObject().put("state", JSONObject().put("queue", JSONArray())).put("library", JSONObject().put("songs", JSONArray()).put("playlists", JSONArray())))
    CarListener.fixture = null
    CarVoice.fixture = null
    // Each Identify test listens afresh; the car's re-ask reuse window must not carry between tests.
    CarIdentifyReuse.reset()
  }

  @After fun tearDown() {
    CarListener.fixture = null
    CarSearch.pick(CarSearchType.ALL, 0)
    main { browser?.disconnect() }
    MediaHub.clearCommandSink(sink)
  }

  private fun connect(): MediaBrowser {
    val ready = CountDownLatch(1)
    main {
      browser = MediaBrowser(ctx, ComponentName(ctx, PlaybackService::class.java), object : MediaBrowser.ConnectionCallback() {
        override fun onConnected() { ready.countDown() }
      }, null)
      browser!!.connect()
    }
    assertTrue("media browser connected", ready.await(15, TimeUnit.SECONDS))
    return browser!!
  }

  private fun children(b: MediaBrowser, id: String, timeout: Long = 20): List<MediaBrowser.MediaItem> {
    val got = AtomicReference<List<MediaBrowser.MediaItem>>()
    val done = CountDownLatch(1)
    main {
      b.subscribe(id, Bundle(), object : MediaBrowser.SubscriptionCallback() {
        override fun onChildrenLoaded(parentId: String?, children: MutableList<MediaBrowser.MediaItem>?, options: Bundle?) { got.set(children.orEmpty().toList()); done.countDown() }
        override fun onChildrenLoaded(parentId: String?, children: MutableList<MediaBrowser.MediaItem>?) { got.set(children.orEmpty().toList()); done.countDown() }
        override fun onError(parentId: String?) { got.set(emptyList()); done.countDown() }
        override fun onError(parentId: String?, options: Bundle?) { got.set(emptyList()); done.countDown() }
      })
    }
    assertTrue("children of $id", done.await(timeout, TimeUnit.SECONDS))
    main { b.unsubscribe(id) }
    return got.get()
  }

  private fun search(b: MediaBrowser, query: String): List<MediaBrowser.MediaItem> {
    val got = AtomicReference<List<MediaBrowser.MediaItem>>()
    val done = CountDownLatch(1)
    main {
      b.search(query, Bundle(), object : MediaBrowser.SearchCallback() {
        override fun onSearchResult(q: String, extras: Bundle?, items: List<MediaBrowser.MediaItem>) { got.set(items.toList()); done.countDown() }
        override fun onError(q: String, extras: Bundle?) { got.set(emptyList()); done.countDown() }
      })
    }
    assertTrue("search $query answered", done.await(30, TimeUnit.SECONDS))
    return got.get()
  }

  private val MediaBrowser.MediaItem.title: String get() = description.title.toString()
  private val MediaBrowser.MediaItem.group get() = description.extras?.getString("android.media.browse.CONTENT_STYLE_GROUP_TITLE_HINT")
  private fun songsOf(items: List<MediaBrowser.MediaItem>) = items.filter { it.isPlayable }.map { it.title }

  @Test fun searchTabOffersAllArtistsSinglesAlbumsFeaturesLyricsAndIdentifyAsIcons() {
    val b = connect()
    val tabs = children(b, b.root)
    assertEquals("Search is the last tab", "Search", tabs.last().title)
    assertTrue(tabs.size <= 4)
    val tiles = children(b, "search")
    assertEquals(listOf("All", "Artists", "Singles", "Albums", "Features", "Lyrics", "Identify"), tiles.map { it.title })
    assertEquals("car_type_artist", tiles[1].description.iconUri?.lastPathSegment)
    for (t in tiles) {
      assertTrue("${t.title} opens", t.isBrowsable)
      val icon = t.description.iconUri
      assertNotNull("${t.title} has an icon", icon)
      assertEquals("android.resource", icon!!.scheme)
      assertTrue("${t.title} icon resolves", ctx.resources.getIdentifier(icon.lastPathSegment, "drawable", ctx.packageName) != 0)
      assertEquals("${t.title} is drawn as an icon tile", 4, t.description.extras?.getInt("android.media.browse.CONTENT_STYLE_SINGLE_ITEM_HINT"))
    }
  }

  @Test fun carKeyboardCoalescesTypedPrefixesBeforeStartingNetworkSearches() {
    val b = connect()
    val final = "Sade $tag"
    val seen = CountDownLatch(1)
    main {
      listOf("S", "Sa", "Sad", final).forEach { q ->
        b.search(q, Bundle(), object : MediaBrowser.SearchCallback() {
          override fun onSearchResult(query: String, extras: Bundle?, items: List<MediaBrowser.MediaItem>) { if (query == final) seen.countDown() }
          override fun onError(query: String, extras: Bundle?) { if (query == final) seen.countDown() }
        })
      }
    }
    assertTrue("final typed request answered", seen.await(10, TimeUnit.SECONDS))
    val requests = asked.filter { it.optString("type") == "catalogSearch" }.map { it.optString("query") }
    assertEquals("only the completed phrase uses network providers", listOf(final), requests)
  }

  /** CAR-RESULTS-FIRST-001: the type tiles behind a search's one trailing "Show only" row. */
  private fun chooser(b: MediaBrowser, items: List<MediaBrowser.MediaItem>): List<MediaBrowser.MediaItem> {
    val row = items.last()
    assertTrue("the last row is the one chooser: ${row.mediaId}", row.mediaId!!.startsWith("schoose/") && row.isBrowsable && !row.isPlayable)
    assertEquals("one chooser row", 1, items.count { it.mediaId!!.startsWith("schoose/") })
    return children(b, row.mediaId!!)
  }

  @Test fun everySearchListsWhatItFoundFirstThenOneShowOnlyRow() {
    val b = connect()
    val items = search(b, "ken carson $tag")
    assertTrue("no type tile ahead of the results", items.none { it.mediaId!!.startsWith("sfilter/") || it.mediaId == "identify" })
    assertEquals(listOf("Overseas", "Green Room", "Fell In Love", "Rock N Roll", "Ken Carson Tribute"), songsOf(items))
    assertTrue(items.dropLast(1).all { it.group == "Songs" })
    val tiles = chooser(b, items)
    assertEquals(listOf("All", "Artists", "Singles", "Albums", "Features", "Lyrics", "Identify"), tiles.map { it.title })
    assertTrue(tiles.all { it.group == "Show only" && it.isBrowsable && !it.isPlayable })
    assertEquals("All is showing", "Showing now", tiles[0].description.subtitle?.toString())
  }

  @Test fun eachIconInTheResultsShowsOnlyThatKind() {
    val b = connect()
    val items = search(b, "ken carson two $tag")
    val byTitle = chooser(b, items).associateBy { it.title }
    assertEquals(listOf("Overseas"), songsOf(children(b, byTitle.getValue("Singles").mediaId!!)))
    assertEquals(listOf("Fell In Love"), songsOf(children(b, byTitle.getValue("Features").mediaId!!)))
    asked.clear()
    val lyrics = children(b, byTitle.getValue("Lyrics").mediaId!!)
    assertEquals(listOf("Rock N Roll"), songsOf(lyrics))
    assertTrue(lyrics.all { it.group == "Lyrics" })
    assertEquals("the page is asked for lyrics", "lyrics", asked.last { it.optString("type") == "catalogSearch" }.getString("mode"))
    assertEquals(listOf("Green Room", "Fell In Love", "Rock N Roll", "Ken Carson Tribute"), songsOf(children(b, byTitle.getValue("Albums").mediaId!!)))
    asked.clear()
    val artists = children(b, byTitle.getValue("Artists").mediaId!!)
    assertEquals("credited songs only, featured ones too", listOf("Overseas", "Green Room", "Fell In Love", "Rock N Roll"), songsOf(artists))
    assertTrue(artists.all { it.group == "Artists" })
    assertEquals("the page is asked for the artist", "artists", asked.last { it.optString("type") == "catalogSearch" }.getString("mode"))
  }

  // CAR-LYRICS-TRUTH-001: DHU 2026-11-16. A lyric lookup that could not run (the daily transfer allowance
  // was used up) showed "No lyrics found". The Lyrics folder must say it did not finish, and why.
  @Test fun aLyricsSearchThatCouldNotRunSaysWhyInsteadOfNoneFound() {
    val b = connect()
    val items = search(b, "operator $tag")
    val byTitle = chooser(b, items).associateBy { it.title }
    failLyrics = "The daily transfer allowance is used up."
    try {
      val lyrics = children(b, byTitle.getValue("Lyrics").mediaId!!)
      assertEquals(1, lyrics.size)
      assertFalse(lyrics[0].isPlayable)
      assertEquals("Lyrics search didn\u2019t finish", lyrics[0].title)
      assertEquals("The daily transfer allowance is used up.", lyrics[0].description.subtitle?.toString())
    } finally { failLyrics = null }
  }

  @Test fun sayingSongsByAnArtistSearchesForThatArtist() {
    val b = connect()
    asked.clear()
    val items = search(b, "songs by Ken Carson $tag")
    val req = asked.last { it.optString("type") == "catalogSearch" }
    assertEquals("artists", req.getString("mode"))
    assertEquals("Ken Carson $tag", req.getString("query"))
    assertEquals("Artists is showing", "Showing now", chooser(b, items).first { it.title == "Artists" }.description.subtitle?.toString())
    assertEquals(listOf("Overseas", "Green Room", "Fell In Love", "Rock N Roll"), songsOf(items))
    // Picked on the Search tab, Artists applies to the next plain voice search.
    children(b, "stype/artists")
    asked.clear()
    search(b, "ken carson again $tag")
    assertEquals("artists", asked.last { it.optString("type") == "catalogSearch" }.getString("mode"))
  }

  @Test fun spokenLeadWordsSearchForThatKind() {
    val b = connect()
    asked.clear()
    val items = search(b, "lyrics i got a feeling $tag")
    val req = asked.last { it.optString("type") == "catalogSearch" }
    assertEquals("lyrics", req.getString("mode"))
    assertEquals("i got a feeling $tag", req.getString("query"))
    assertEquals("Lyrics is showing", "Showing now", chooser(b, items).first { it.title == "Lyrics" }.description.subtitle?.toString())
    assertEquals(listOf("Rock N Roll"), songsOf(items))
    asked.clear()
    search(b, "album A Great Chaos $tag")
    assertEquals("albums", asked.last { it.optString("type") == "catalogSearch" }.getString("mode"))
  }

  @Test fun anIconPickedOnTheSearchTabAppliesToTheNextVoiceSearch() {
    // A phone with no speech recognizer: the tile sends the driver to the search button, which uses the kind.
    CarVoice.fixture = CarVoice.Outcome.Unavailable
    val b = connect()
    val hint = children(b, "stype/singles")
    assertTrue(hint.first().title.contains("search button"))
    assertEquals("On for your next search", children(b, "search").first { it.title == "Singles" }.description.subtitle?.toString())
    asked.clear()
    val items = search(b, "overseas $tag")
    assertEquals("singles", asked.last { it.optString("type") == "catalogSearch" }.getString("mode"))
    assertEquals(listOf("Overseas"), songsOf(items))
    children(b, "stype/all") // All turns it off
    asked.clear()
    search(b, "overseas again $tag")
    assertEquals("all", asked.last { it.optString("type") == "catalogSearch" }.getString("mode"))
  }

  /**
   * CAR-QUICK-SEARCH-001 (owner, 2026-11-22): "the search icon should bring up the quick search tab where the user can
   * select the search filter like song name, artist, album, lyric, shazam reverse search before voice searching".
   */
  @Test fun tappingAKindListensForTheWordsThenListsOnlyThatKind() {
    CarVoice.fixture = CarVoice.Outcome.Heard("A Great Chaos $tag")
    val b = connect()
    asked.clear()
    val got = children(b, "stype/albums", timeout = 30)
    assertEquals("albums", asked.last { it.optString("type") == "catalogSearch" }.getString("mode"))
    assertEquals("You said \u201cA Great Chaos $tag\u201d", got.first().title)
    assertFalse(got.first().isPlayable)
    assertEquals(listOf("Green Room", "Fell In Love", "Rock N Roll", "Ken Carson Tribute"), songsOf(got))
    // Saying a lead word on the All tile picks that kind.
    CarVoice.fixture = CarVoice.Outcome.Heard("lyrics rock n roll $tag")
    asked.clear()
    val lyr = children(b, "stype/all", timeout = 30)
    assertEquals("lyrics", asked.last { it.optString("type") == "catalogSearch" }.getString("mode"))
    assertEquals(listOf("Rock N Roll"), songsOf(lyr))
  }

  @Test fun aKindThatHeardNothingSaysSoAndOffersTheSearchButton() {
    CarVoice.fixture = CarVoice.Outcome.NothingHeard
    val b = connect()
    val got = children(b, "stype/artists", timeout = 30)
    assertEquals(listOf("Didn\u2019t catch that", "Tap the search button. ${CarSearchType.ARTISTS.hint}"), got.map { it.title.toString() })
    assertTrue(got.none { it.isPlayable })
  }

  @Test fun identifyListensThenListsTheSongsThePhoneNamed() {
    // A generated 4 s tone stands in for the microphone (the emulator has no music playing).
    val pcm = ByteArray(16000 * 4 * 2) { i -> if (i % 2 == 0) (i * 7).toByte() else ((i / 64) % 32).toByte() }
    CarListener.fixture = pcm
    val b = connect()
    asked.clear()
    val heard = children(b, "identify", timeout = 40)
    val req = asked.last { it.optString("type") == "identifyAudio" }
    assertEquals("the recorded clip goes to the page", pcm.size, android.util.Base64.decode(req.getString("pcm"), android.util.Base64.NO_WRAP).size)
    assertEquals(listOf("Heard Song"), songsOf(heard))
    assertEquals("Identified", heard.first().group)
    assertNotNull("tapping it can play it", MediaHub.findSong("heard-$tag"))
  }

  @Test fun identifySaysWhatToDoWhenItCannotName() {
    CarListener.fixture = ByteArray(16000 * 4 * 2) { 1 }
    identifiedReply = JSONObject().put("songs", JSONArray()).put("error", "Shazam is offline")
    val b = connect()
    val got = children(b, "identify", timeout = 40)
    assertEquals(1, got.size)
    assertFalse(got[0].isPlayable)
    assertEquals("Couldn't identify the music", got[0].title)
    assertEquals("Shazam is offline", got[0].description.subtitle?.toString())
  }
}
