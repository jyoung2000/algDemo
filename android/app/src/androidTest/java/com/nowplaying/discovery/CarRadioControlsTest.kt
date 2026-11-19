package com.nowplaying.discovery

import android.content.ComponentName
import android.content.Context
import android.media.browse.MediaBrowser
import android.media.session.MediaController as PlatformController
import android.media.session.PlaybackState
import android.os.Bundle
import android.os.SystemClock
import androidx.media3.session.legacy.MediaBrowserCompat
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.nowplaying.discovery.engine.EngineHub
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
 * CAR-RADIO-CONTROLS-001 (owner, 2026-11-18): "ensure the radio android auto controls work the same as
 * well with the exception of replay, the find similar songs, and dislike button, the user should be
 * able to shuffle stations, star songs and add to playlist and see the current elapsed and song
 * duration on radio".
 *
 * A live radio session without a network (as RadioBrowseTest): the ring is fed silence so the native
 * engine really plays; the page's now-playing report is sent exactly as the web page sends it.
 * Read through the legacy session, as Android Auto reads it.
 */
@RunWith(AndroidJUnit4::class)
class CarRadioControlsTest {
  private val ctx: Context get() = ApplicationProvider.getApplicationContext()
  private val instr get() = InstrumentationRegistry.getInstrumentation()
  private fun <T> main(block: () -> T): T { val r = AtomicReference<T>(); instr.runOnMainSync { r.set(block()) }; return r.get() }
  private fun until(what: String, timeout: Long = 10000, condition: () -> Boolean) {
    val end = System.currentTimeMillis() + timeout
    while (System.currentTimeMillis() < end) { if (condition()) return; Thread.sleep(50) }
    throw AssertionError("Timeout: $what")
  }
  private val sent = CopyOnWriteArrayList<JSONObject>()
  private val sink: (JSONObject) -> Unit = { if (it.optString("type") in setOf("feedback", "playlistAdd")) sent.add(it) }
  private var browser: MediaBrowser? = null
  private var controller: PlatformController? = null
  private var compat: MediaBrowserCompat? = null
  private val sessionField = RadioNative::class.java.getDeclaredField("session").apply { isAccessible = true }
  private lateinit var radio: RadioNative.Session

  private fun row(id: String) = JSONObject().put("id", id).put("name", "Radio test $id").put("url", "https://streams.example/$id")
  private val songId = "deezer:radio-test-777"
  private fun onAirSong() = JSONObject().put("id", songId).put("title", "Radio test song").put("artist", "Airwave diagnostic fixture")
    .put("album", "Radio control test (not catalogue music)").put("durationMs", 200000).put("ready", false)
  private fun onAirTrack() = JSONObject().put("id", "radio-test-777").put("provider", "deezer").put("platform_id", "radio-test-777")
    .put("key", songId).put("title", "Radio test song").put("artist", "Airwave diagnostic fixture").put("duration", 200)

  @Before fun setUp() {
    CarFeedback.init(ctx)
    CarFeedback.resetForTests()
    MediaHub.setCommandSink(sink)
    val lists = JSONArray().put(JSONObject().put("id", "road").put("title", "Road trip").put("songs", JSONArray()))
    main { MediaHub.apply(JSONObject().put("state", JSONObject().put("queue", JSONArray())).put("library", JSONObject().put("songs", JSONArray()).put("playlists", lists))) }
    RadioCatalog.rememberStations(JSONArray().put(row("ctl-a")).put(row("ctl-b")).put(row("ctl-c")))
    RadioCatalog.selectContext("ctl-a")
    radio = RadioNative.Session("radio-controls-test", "ctl-a", RadioRing(48000 * 60), row("ctl-a"))
    val silence = ByteArray(48000 * 4 * 30)
    radio.ring.write(silence, silence.size)
    sessionField.set(RadioNative, radio)
    main { EngineHub.fromPage(JSONObject().put("op", "radio").put("id", radio.id).put("title", "Radio test ctl-a").put("station", "ctl-a").toString()) }
  }

  @After fun tearDown() {
    runCatching { RadioNative.handle(ctx, JSONObject().put("op", "stop")) }
    main {
      EngineHub.fromPage(JSONObject().put("op", "load")
        .put("song", JSONObject().put("id", "radio-controls-cleanup").put("title", "Cleanup").put("ready", false))
        .put("play", false).put("rev", Int.MAX_VALUE).toString())
      browser?.disconnect()
      compat?.disconnect()
    }
    instr.waitForIdleSync()
    MediaHub.clearCommandSink(sink)
    CarFeedback.resetForTests()
  }

  private fun connect(): PlatformController {
    val ready = CountDownLatch(1)
    main {
      browser = MediaBrowser(ctx, ComponentName(ctx, PlaybackService::class.java), object : MediaBrowser.ConnectionCallback() {
        override fun onConnected() { controller = PlatformController(ctx, browser!!.sessionToken); ready.countDown() }
        override fun onConnectionFailed() { ready.countDown() }
      }, null)
      browser!!.connect()
    }
    assertTrue(ready.await(15, TimeUnit.SECONDS))
    return controller ?: throw AssertionError("legacy media browser did not connect")
  }

  private fun connectCar(): MediaBrowserCompat {
    val ready = CountDownLatch(1)
    val hints = Bundle().apply { putInt("androidx.media.utils.extras.CUSTOM_BROWSER_ACTION_LIMIT", 5) }
    main {
      compat = MediaBrowserCompat(ctx, ComponentName(ctx, PlaybackService::class.java), object : MediaBrowserCompat.ConnectionCallback() {
        override fun onConnected() { ready.countDown() }
        override fun onConnectionFailed() { ready.countDown() }
      }, hints).also { it.connect() }
    }
    assertTrue("car browser connects", ready.await(15, TimeUnit.SECONDS))
    return compat!!
  }

  private fun children(b: MediaBrowserCompat, parent: String): List<MediaBrowserCompat.MediaItem> {
    val got = AtomicReference<List<MediaBrowserCompat.MediaItem>>()
    val done = CountDownLatch(1)
    val cb = object : MediaBrowserCompat.SubscriptionCallback() {
      override fun onChildrenLoaded(parentId: String?, children: MutableList<MediaBrowserCompat.MediaItem>?, options: Bundle?) { got.set(children.orEmpty().toList()); done.countDown() }
      override fun onError(parentId: String?, options: Bundle?) { got.set(emptyList()); done.countDown() }
    }
    main { b.subscribe(parent, Bundle(), cb) }
    assertTrue("children of $parent", done.await(10, TimeUnit.SECONDS))
    main { b.unsubscribe(parent, cb) }
    return got.get()
  }

  private fun title(c: PlatformController) = main { c.metadata?.getString("android.media.metadata.TITLE") }
  private fun length(c: PlatformController) = main { c.metadata?.getLong("android.media.metadata.DURATION") ?: 0L }
  private fun names(c: PlatformController) = main { c.playbackState?.customActions.orEmpty().map { it.name.toString() } }
  private fun press(c: PlatformController, suffix: String) {
    val a = main { c.playbackState?.customActions.orEmpty() }.firstOrNull { it.action.endsWith(suffix) } ?: throw AssertionError("no $suffix button in ${names(c)}")
    main { c.transportControls.sendCustomAction(a.action, null) }
  }
  private fun position(c: PlatformController): Long = main {
    val s = c.playbackState ?: return@main -1L
    if (s.state != PlaybackState.STATE_PLAYING) s.position
    else s.position + ((SystemClock.elapsedRealtime() - s.lastPositionUpdateTime) * s.playbackSpeed).toLong()
  }
  private fun nowPlaying(title: String, song: JSONObject?, track: JSONObject?, start: Double?, duration: Double?) {
    val cmd = JSONObject().put("op", "nowplaying").put("id", radio.id).put("title", title).put("artist", "Airwave diagnostic fixture").put("artwork", "")
      .put("song", song ?: JSONObject.NULL).put("track", track ?: JSONObject.NULL).put("start", start ?: JSONObject.NULL).put("duration", duration ?: JSONObject.NULL)
    main { RadioNative.handle(ctx, cmd) }
  }
  private fun radioPlays(c: PlatformController) = until("the radio plays") { main { c.playbackState?.state } == PlaybackState.STATE_PLAYING && title(c) == "Radio test ctl-a" }

  @Test fun radioRowIsShuffleStarAndFavouriteStationWithoutRepeatSimilarOrDislike() {
    val c = connect()
    radioPlays(c)
    until("the radio buttons") { names(c) == listOf("Shuffle stations off", "Star", "Favourite station") }
  }

  @Test fun shuffleButtonShufflesStations() {
    val c = connect()
    radioPlays(c)
    until("shuffle is offered") { "Shuffle stations off" in names(c) }
    press(c, ".SHUFFLE")
    until("radio shuffle on") { RadioNative.shuffle && "Shuffle stations on" in names(c) }
    press(c, ".SHUFFLE")
    until("radio shuffle off") { !RadioNative.shuffle && "Shuffle stations off" in names(c) }
  }

  @Test fun starWithNoSongOnAirTellsTheDriverAndTeachesNothing() {
    val c = connect()
    radioPlays(c)
    val told = CopyOnWriteArrayList<String>()
    val listener = object : PlatformController.Callback() {
      override fun onPlaybackStateChanged(state: PlaybackState?) { state?.errorMessage?.let { told.add(it.toString()) } }
    }
    main { c.registerCallback(listener) }
    nowPlaying("Morning programme", null, null, null, null)
    until("the programme is on the card") { title(c) == "Morning programme" }
    press(c, ".STAR")
    until("the car is told why") { told.any { it.startsWith("No song has been identified") } }
    main { c.unregisterCallback(listener) }
    Thread.sleep(300)
    assertTrue("a programme never trains taste: $sent", sent.none { it.optString("type") == "feedback" })
  }

  @Test fun starTheSongOnAirLikesItAndOpensThePlaylistPicker() {
    val c = connect()
    radioPlays(c)
    nowPlaying("Radio test song", onAirSong(), onAirTrack(), null, null)
    until("the song is on the card") { title(c) == "Radio test song" }
    press(c, ".STAR")
    until("the page heard the star") { sent.any { it.optString("type") == "feedback" } }
    val like = sent.first { it.optString("type") == "feedback" }
    assertEquals(songId, like.getString("id"))
    assertEquals("like", like.getString("kind"))
    assertEquals("the song's own Track travels with it", songId, like.getJSONObject("track").getString("key"))
    until("the star shows it is starred") { "Remove star" in names(c) }
    val car = connectCar()
    // CAR-STAR-PICKER-001: the radio lists the car goes back to show the picker on top too.
    assertEquals("Add \u201cRadio test song\u201d to a playlist", children(car, "radio/favourites").first().description.title.toString())
    val top = children(car, "songs").first()
    assertEquals("Add \u201cRadio test song\u201d to a playlist", top.description.title.toString())
    val road = children(car, top.mediaId!!).first { it.description.title.toString() == "Road trip" }
    main { c.transportControls.playFromMediaId(road.mediaId, null) }
    until("added to the playlist") { sent.any { it.optString("type") == "playlistAdd" } }
    val add = sent.first { it.optString("type") == "playlistAdd" }
    assertEquals(songId, add.getString("id"))
    assertEquals("road", add.getString("list"))
    assertEquals(songId, add.getJSONObject("track").getString("key"))
    Thread.sleep(800)
    assertSame("the station keeps playing", radio, RadioNative.session)
    assertEquals("Radio test song", title(c))
    assertEquals(PlaybackState.STATE_PLAYING, main { c.playbackState?.state })
  }

  @Test fun elapsedAndLengthFollowTheSongOnAir() {
    val c = connect()
    radioPlays(c)
    // The song began 30 s before the first sample of this ring and lasts 200 s.
    nowPlaying("Radio test song", onAirSong(), onAirTrack(), -30.0, 200.0)
    until("the car knows the song's length") { length(c) == 200000L }
    val ring = radio.ring.positionFrames * 1000 / 48000
    val at = position(c)
    assertTrue("elapsed is the song's, not the time since tuning in ($at, ring $ring)", at >= 30000 + ring - 1500 && at <= 30000 + ring + 2500)
    Thread.sleep(1500)
    assertTrue("and it moves", position(c) >= at + 1000)
    // A programme with no published clock: no length and no made-up elapsed time.
    nowPlaying("Morning programme", null, null, null, null)
    until("the programme is on the card") { title(c) == "Morning programme" }
    until("no length") { length(c) <= 0L }
    assertTrue("no elapsed time is invented (${position(c)})", position(c) < 1000)
  }
}
