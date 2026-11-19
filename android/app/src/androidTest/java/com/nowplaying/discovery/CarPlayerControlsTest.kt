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
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.PI
import kotlin.math.sin

/**
 * CAR-CONTROLS-001 (owner, 2026-11-18): the Android Auto player shows the song's length and where it
 * is, play/pause and both skip arrows; under the player shuffle (with a visible "on" mark), repeat
 * with its count, then a star that stars the song and opens a list of the listener's playlists, a
 * tap on one adding the song and going back to the player.
 *
 * Android Auto reads the legacy session: playback-view buttons are the session's custom actions and
 * actions on a song row are "custom browse actions" (Media3 command buttons for media items). The
 * row actions are read here through the same legacy browser, asking for them as the car does.
 * Songs are generated local PCM tones (test fixtures, not catalogue recordings).
 */
@RunWith(AndroidJUnit4::class)
class CarPlayerControlsTest {
  private val ctx: Context get() = ApplicationProvider.getApplicationContext()
  private val instr get() = InstrumentationRegistry.getInstrumentation()
  private fun <T> main(block: () -> T): T { val r = AtomicReference<T>(); instr.runOnMainSync { r.set(block()) }; return r.get() }
  private fun until(what: String, timeout: Long = 10000, condition: () -> Boolean) {
    val end = System.currentTimeMillis() + timeout
    while (System.currentTimeMillis() < end) { if (condition()) return; Thread.sleep(50) }
    throw AssertionError("Timeout: $what")
  }
  private val sent = CopyOnWriteArrayList<JSONObject>()
  private val seenStates = CopyOnWriteArrayList<String>()
  private val sink: (JSONObject) -> Unit = { if (it.optString("type") in setOf("feedback", "playlistAdd", "findSimilar")) sent.add(it) }
  private var browser: MediaBrowser? = null
  private var controller: PlatformController? = null
  private var compat: MediaBrowserCompat? = null

  private fun link(i: Int) = "https://music.youtube.com/watch?v=carcontrols0$i"
  private fun song(i: Int) = JSONObject().put("id", "ctl-tone-$i").put("title", "Control test tone $i")
    .put("artist", "Airwave diagnostic fixture").put("album", "Car control test (not catalogue music)")
    .put("durationMs", 60000).put("ready", true).put("source", link(i))
  private fun seed() {
    val s = JSONArray().apply { for (i in 1..4) put(song(i)) }
    val lists = JSONArray()
      .put(JSONObject().put("id", "road").put("title", "Road trip").put("songs", JSONArray()))
      .put(JSONObject().put("id", "night").put("title", "Night drive").put("songs", JSONArray().put(song(2))))
      .put(JSONObject().put("id", "alb").put("title", "A saved album").put("album", true).put("songs", JSONArray().put(song(3))))
    MediaHub.apply(JSONObject().put("state", JSONObject().put("queue", s)).put("library", JSONObject().put("songs", s).put("playlists", lists)))
  }

  @Before fun setUp() {
    CarFeedback.init(ctx)
    CarFeedback.resetForTests()
    for (i in 1..5) storeTone(i)
  }

  @After fun tearDown() {
    main {
      controller?.let { c -> c.playbackState?.customActions?.firstOrNull { it.name.toString() == "Shuffle on" }?.let { c.transportControls.sendCustomAction(it.action, null) } }
      controller?.transportControls?.stop()
      browser?.disconnect()
      compat?.disconnect()
    }
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

  /** A legacy browser that asks for row actions the way Android Auto does (a non-zero limit). */
  private fun connectCar(): MediaBrowserCompat {
    val ready = CountDownLatch(1)
    val hints = Bundle().apply { putInt(LIMIT, 5) }
    main {
      compat = MediaBrowserCompat(ctx, ComponentName(ctx, PlaybackService::class.java), object : MediaBrowserCompat.ConnectionCallback() {
        override fun onConnected() { ready.countDown() }
        override fun onConnectionFailed() { ready.countDown() }
      }, hints).also { it.connect() }
    }
    assertTrue("car browser connects", ready.await(15, TimeUnit.SECONDS))
    assertTrue(main { compat!!.isConnected })
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

  private fun rowAction(b: MediaBrowserCompat, action: String, mediaId: String): Bundle? {
    val got = AtomicReference<Bundle?>()
    val done = CountDownLatch(1)
    main {
      b.sendCustomAction(action, Bundle().apply { putString(MEDIA_ITEM_ID, mediaId) }, object : MediaBrowserCompat.CustomActionCallback() {
        override fun onResult(action: String, extras: Bundle?, resultData: Bundle?) { got.set(resultData ?: Bundle()); done.countDown() }
        override fun onError(action: String, extras: Bundle?, data: Bundle?) { done.countDown() }
      })
    }
    assertTrue("row action $action answered", done.await(10, TimeUnit.SECONDS))
    return got.get()
  }

  private fun playTone(c: PlatformController, i: Int) {
    main { c.transportControls.playFromMediaId("ctl-tone-$i", null) }
    until("tone $i is the session's song") { title(c) == "Control test tone $i" }
  }
  private fun title(c: PlatformController) = main { c.metadata?.getString("android.media.metadata.TITLE") }
  private fun actions(c: PlatformController) = main { c.playbackState?.customActions.orEmpty() }
  private fun names(c: PlatformController) = actions(c).map { it.name.toString() }
  private fun press(c: PlatformController, suffix: String) {
    val a = actions(c).firstOrNull { it.action.endsWith(suffix) } ?: throw AssertionError("no $suffix button in ${names(c)}")
    main { c.transportControls.sendCustomAction(a.action, null) }
  }
  private fun position(c: PlatformController): Long = main {
    val s = c.playbackState ?: return@main -1L
    if (s.state != PlaybackState.STATE_PLAYING) s.position
    else s.position + ((SystemClock.elapsedRealtime() - s.lastPositionUpdateTime) * s.playbackSpeed).toLong()
  }

  /** The minimised card and the full player both draw from these: length, place, and the three transport keys. */
  @Test fun carShowsTheSongLengthItsPlaceAndPlayPauseWithBothSkips() {
    MediaHub.setCommandSink(sink)
    main { seed() }
    val c = connect()
    playTone(c, 1)
    until("the song plays") { main { c.playbackState?.state } == PlaybackState.STATE_PLAYING }
    assertEquals("the car knows the song's length", 60000L, main { c.metadata!!.getLong("android.media.metadata.DURATION") })
    val seen = (0 until 8).map {
      Thread.sleep(250)
      main { c.playbackState!!.let { "${it.state}/${it.position}@${it.lastPositionUpdateTime}x${it.playbackSpeed}" } } to position(c)
    }
    assertTrue("elapsed time moves while it plays: $seen", seen.last().second >= seen.first().second + 1500)
    val transport = main { c.playbackState!!.actions }
    assertTrue("play/pause", transport and PlaybackState.ACTION_PLAY_PAUSE != 0L)
    assertTrue("skip forward", transport and PlaybackState.ACTION_SKIP_TO_NEXT != 0L)
    assertTrue("go back", transport and PlaybackState.ACTION_SKIP_TO_PREVIOUS != 0L)
  }

  /**
   * CAR-RADIO-CONTROLS-001 (owner, 2026-11-18): "dont remove the like button and dislike button on
   * android auto". Android Auto 17.9 on an 800x480 screen draws four buttons after the transport, or
   * three and a ⋮ menu when there are more; so Star and Dislike sit in the first three places, with
   * Shuffle first as on the radio, and Repeat with Find similar beside it after them.
   */
  @Test fun starAndDislikeStayInTheFirstThreePlaces() {
    MediaHub.setCommandSink(sink)
    main { seed() }
    val c = connect()
    playTone(c, 1)
    until("all the buttons") { names(c).containsAll(listOf("Shuffle off", "Repeat song: off", "Find similar songs", "Star", "Dislike")) }
    assertEquals(listOf("Shuffle off", "Star", "Dislike", "Repeat song: off", "Find similar songs"), names(c))
  }

  /** CAR-SIMILAR-001 (owner, 2026-11-18): "add the button to find similar songs ... next to the repeat icon". */
  @Test fun findSimilarSitsRightAfterRepeatWithItsOwnPicture() {
    MediaHub.setCommandSink(sink)
    main { seed() }
    val c = connect()
    playTone(c, 1)
    until("the similar button") { names(c).contains("Find similar songs") }
    val n = names(c)
    assertEquals("right after repeat: $n", n.indexOf("Repeat song: off") + 1, n.indexOf("Find similar songs"))
    assertEquals(R.drawable.car_similar, actions(c).first { it.name.toString() == "Find similar songs" }.icon)
  }

  @Test fun findSimilarAsksForSongsLikeTheCarSongAndQueuesWhatWasFound() {
    MediaHub.setCommandSink(sink)
    main { seed() }
    val c = connect()
    playTone(c, 1)
    until("the song plays") { main { c.playbackState?.state } == PlaybackState.STATE_PLAYING }
    val before = main { c.queue.orEmpty().map { it.description.title.toString() } }
    press(c, "SIMILAR")
    until("the request reaches the engine") { sent.any { it.optString("type") == "findSimilar" } }
    val ask = sent.first { it.optString("type") == "findSimilar" }
    assertEquals("for the song the car is playing", "ctl-tone-1", ask.getString("id"))
    until("the button shows it is working") { names(c).contains("Finding similar songs\u2026") }
    press(c, "SIMILAR")
    Thread.sleep(300)
    assertEquals("a second press while working asks nothing more", 1, sent.count { it.optString("type") == "findSimilar" })
    main {
      MediaHub.apply(JSONObject().put("similar", JSONObject().put("requestId", ask.getString("requestId")).put("id", "ctl-tone-1")
        .put("added", 1).put("minimum", 70).put("reason", "").put("songs", JSONArray().put(song(5)))))
    }
    until("the found song is queued at the end") { main { c.queue.orEmpty().map { it.description.title.toString() } } == before + "Control test tone 5" }
    until("the button is ready again") { names(c).contains("Find similar songs") }
    assertEquals("the song playing is not interrupted", "Control test tone 1", title(c))
    assertEquals(PlaybackState.STATE_PLAYING, main { c.playbackState?.state })
  }

  @Test fun findSimilarWithNothingFoundTellsTheDriverWhy() {
    MediaHub.setCommandSink(sink)
    main { seed() }
    val c = connect()
    playTone(c, 1)
    val before = main { c.queue.orEmpty().size }
    // Media3 shows a non-fatal error as one passing playback state (with the message), then the
    // normal state again at once; the car shows it as a message, so every state is listened to.
    val told = CopyOnWriteArrayList<String>()
    val listener = object : PlatformController.Callback() {
      override fun onPlaybackStateChanged(state: PlaybackState?) { state?.errorMessage?.let { told.add(it.toString()) } }
    }
    main { c.registerCallback(listener, android.os.Handler(android.os.Looper.getMainLooper())) }
    press(c, "SIMILAR")
    until("the request reaches the engine") { sent.any { it.optString("type") == "findSimilar" } }
    val ask = sent.first { it.optString("type") == "findSimilar" }
    // The car's message line is short: only the first sentence of the engine's reason is shown.
    val why = "No analysed audio is available for this song."
    val reason = "$why Play its full local file or choose a song with a Deezer preview, then try again."
    main {
      MediaHub.apply(JSONObject().put("similar", JSONObject().put("requestId", ask.getString("requestId")).put("id", "ctl-tone-1")
        .put("added", 0).put("minimum", 70).put("reason", reason).put("songs", JSONArray())))
    }
    until("the car is told why") { told.contains(why) }
    assertFalse("only the first sentence: $told", told.any { it.contains("Deezer") })
    main { c.unregisterCallback(listener) }
    until("the music keeps playing") { main { c.playbackState?.state } == PlaybackState.STATE_PLAYING }
    assertEquals("nothing was added", before, main { c.queue.orEmpty().size })
    until("the button is ready again") { names(c).contains("Find similar songs") }
  }

  /** The stock "shuffle on" icon looks the same as off on a real head unit; ours carries a dot when on. */
  @Test fun shuffleShowsItsOwnOnPictureWhenFlippedOn() {
    MediaHub.setCommandSink(sink)
    main { seed() }
    val c = connect()
    playTone(c, 1)
    until("shuffle off") { "Shuffle off" in names(c) }
    assertEquals(R.drawable.car_shuffle_off, actions(c).first { it.name.toString() == "Shuffle off" }.icon)
    press(c, ".SHUFFLE")
    until("shuffle on") { "Shuffle on" in names(c) }
    assertEquals(R.drawable.car_shuffle_on, actions(c).first { it.name.toString() == "Shuffle on" }.icon)
  }

  @Test fun shuffleOnPictureHasAMarkUnderTheArrowsAndOffHasNone() {
    val size = 96
    fun draw(name: String, id: Int): android.graphics.Bitmap {
      val d = androidx.core.content.ContextCompat.getDrawable(ctx, id) ?: throw AssertionError("$name does not load")
      val b = android.graphics.Bitmap.createBitmap(size, size, android.graphics.Bitmap.Config.ARGB_8888)
      d.setBounds(0, 0, size, size); d.draw(android.graphics.Canvas(b))
      File(ctx.cacheDir, "car_shuffle_$name.png").outputStream().use { b.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
      return b
    }
    fun ink(b: android.graphics.Bitmap, x0: Int, y0: Int, x1: Int, y1: Int): Int {
      var n = 0
      for (y in y0 until y1) for (x in x0 until x1) if (android.graphics.Color.alpha(b.getPixel(x, y)) > 128) n++
      return n
    }
    val off = draw("off", R.drawable.car_shuffle_off)
    val on = draw("on", R.drawable.car_shuffle_on)
    for ((name, b) in listOf("off" to off, "on" to on)) {
      assertTrue("$name: crossed arrows on the left", ink(b, 16, 8, 40, 70) > 80)
      assertTrue("$name: and on the right", ink(b, 56, 8, 80, 70) > 80)
    }
    assertEquals("off: nothing under the arrows", 0, ink(off, 36, 74, 60, 96))
    assertTrue("on: a mark under the arrows", ink(on, 36, 74, 60, 96) > 60)
  }

  /** A star on a song row stars it and opens the playlist picker for that song. */
  @Test fun starOnASongRowStarsItAndOpensThePlaylistPicker() {
    MediaHub.setCommandSink(sink)
    main { seed() }
    val car = connectCar()
    val root = main { car.extras } ?: Bundle()
    val declared = root.getParcelableArrayList<Bundle>(ROOT_LIST).orEmpty()
    val star = declared.firstOrNull { it.getString(ACTION_ID) == STAR_TO_PLAYLIST }
      ?: throw AssertionError("row star not declared: ${declared.map { it.getString(ACTION_ID) }}")
    assertEquals("Star and add to a playlist", star.getString(ACTION_LABEL))
    assertNotNull("the car can draw it", star.getString(ACTION_ICON))
    val rows = children(car, "songs")
    val row = rows.firstOrNull { it.mediaId == "ctl-tone-2" } ?: throw AssertionError("tone 2 not listed: ${rows.map { it.mediaId }}")
    assertTrue("the song row carries the star", row.description.extras?.getStringArrayList(ID_LIST).orEmpty().contains(STAR_TO_PLAYLIST))
    val result = rowAction(car, STAR_TO_PLAYLIST, "ctl-tone-2") ?: throw AssertionError("row star failed")
    assertEquals("opens the picker for this song", "addto/ctl-tone-2", result.getString(RESULT_BROWSE_NODE))
    until("the page heard the star") { sent.any { it.optString("type") == "feedback" } }
    assertEquals("like", sent.first { it.optString("type") == "feedback" }.getString("kind"))
  }

  /** The picker lists playlists (not saved albums); a tap adds the song and the song playing carries on. */
  @Test fun pickingAPlaylistAddsTheSongAndKeepsTheMusicPlaying() {
    MediaHub.setCommandSink(sink)
    main { seed() }
    val c = connect()
    playTone(c, 1)
    until("tone 1 plays") { main { c.playbackState?.state } == PlaybackState.STATE_PLAYING }
    val car = connectCar()
    val picker = children(car, "addto/ctl-tone-2")
    assertEquals(listOf("Road trip", "Night drive"), picker.map { it.description.title.toString() })
    assertTrue("a playlist is a tap target", picker.all { it.isPlayable })
    assertEquals("Already in this playlist", picker[1].description.subtitle.toString())
    main { c.transportControls.playFromMediaId(picker[0].mediaId, null) }
    until("the page is asked to add it") { sent.any { it.optString("type") == "playlistAdd" } }
    val add = sent.first { it.optString("type") == "playlistAdd" }
    assertEquals("ctl-tone-2", add.getString("id"))
    assertEquals("road", add.getString("list"))
    until("the car's Playlists show it at once") { MediaHub.playlist("road")?.songs?.any { it.id == "ctl-tone-2" } == true }
    Thread.sleep(1200)
    assertEquals("the song playing is not interrupted", "Control test tone 1", title(c))
    assertEquals(PlaybackState.STATE_PLAYING, main { c.playbackState?.state })
    val again = children(car, "addto/ctl-tone-2")
    assertEquals("Already in this playlist", again[0].description.subtitle.toString())
  }

  /**
   * Android Auto 17.9 (DHU, 2026-11-18) sends no row-action limit, so it never draws row stars. There
   * the player's own Star is the way in: once pressed, the first row of the car's Now playing tab is
   * the picker for that song, one tap from the player. Picking a list clears that row again.
   */
  @Test fun starInThePlayerPutsThePickerFirstInNowPlayingUntilAListIsPicked() {
    MediaHub.setCommandSink(sink)
    main { seed() }
    val c = connect()
    playTone(c, 1)
    val car = connectCar()
    assertFalse("no picker row before a star", children(car, "songs").any { it.mediaId!!.startsWith("addto/") })
    until("star button") { "Star" in names(c) }
    press(c, ".STAR")
    until("starred") { "Remove star" in names(c) }
    until("picker row first in Now playing") { children(car, "songs").firstOrNull()?.mediaId == "addto/ctl-tone-1" }
    val row = children(car, "songs").first()
    assertEquals("Add \u201cControl test tone 1\u201d to a playlist", row.description.title.toString())
    assertTrue("it opens a list", row.isBrowsable)
    assertEquals("a full-width row", 1, row.description.extras?.getInt("android.media.browse.CONTENT_STYLE_SINGLE_ITEM_HINT"))
    assertTrue("with the star-plus picture", row.description.iconUri.toString().endsWith("/drawable/car_star_add"))
    val picker = children(car, row.mediaId!!)
    assertEquals(listOf("Road trip", "Night drive"), picker.map { it.description.title.toString() })
    main { c.transportControls.playFromMediaId(picker[0].mediaId, null) }
    until("added") { sent.any { it.optString("type") == "playlistAdd" && it.optString("list") == "road" && it.optString("id") == "ctl-tone-1" } }
    until("picker row gone after the pick") { children(car, "songs").none { it.mediaId!!.startsWith("addto/") } }
    assertEquals("Control test tone 1", title(c))
  }

  /**
   * Android Auto opens its player on any tap in a list and shows "Could not load your selection"
   * if the request fails (seen on the DHU). So a pick answers with the queue as it is: the same
   * song at the same place, never restarted, even when it was paused.
   */
  @Test fun aPickWhilePausedReturnsToTheSameSongAtTheSamePlace() {
    MediaHub.setCommandSink(sink)
    main { seed() }
    val c = connect()
    playTone(c, 1)
    until("plays") { main { c.playbackState?.state } == PlaybackState.STATE_PLAYING }
    Thread.sleep(2500)
    main { c.transportControls.pause() }
    until("paused") { main { c.playbackState?.state } == PlaybackState.STATE_PAUSED }
    val at = position(c)
    assertTrue("got somewhere first ($at)", at >= 2000)
    val car = connectCar()
    val picker = children(car, "addto/ctl-tone-4")
    main { c.transportControls.playFromMediaId(picker[0].mediaId, null) }
    until("added") { sent.any { it.optString("type") == "playlistAdd" && it.optString("id") == "ctl-tone-4" } }
    until("the player is back with music") { main { c.playbackState?.state } == PlaybackState.STATE_PLAYING }
    assertEquals("the same song", "Control test tone 1", title(c))
    val now = position(c)
    assertTrue("from the same place, not the start ($at -> $now)", now >= at - 300 && now < at + 3000)
  }

  /**
   * CAR-STAR-PICKER-001 (owner, 2026-11-18): "ensure starring on android auto brings up the sub menu to
   * select the playlist". Android Auto has no way for a player button to open a list, so the star
   * puts the picker on top of every list the car can go back to (the one the song was chosen from
   * included) and tells the driver to go back; the car reloads those lists at once.
   */
  @Test fun starInThePlayerPutsThePickerOnTopOfEveryListTheCarGoesBackTo() {
    MediaHub.setCommandSink(sink)
    main { seed() }
    val c = connect()
    val car = connectCar()
    // The car stays subscribed to the list it opened (a second subscribe with the same options would
    // replace this callback, so the list is read from it).
    val loads = CopyOnWriteArrayList<List<MediaBrowserCompat.MediaItem>>()
    val changed = CopyOnWriteArrayList<String>()
    main { car.subscribe("playlist/night", Bundle(), object : MediaBrowserCompat.SubscriptionCallback() {
      override fun onChildrenLoaded(parentId: String?, children: MutableList<MediaBrowserCompat.MediaItem>?, options: Bundle?) {
        loads.add(children.orEmpty().toList()); changed.add(children.orEmpty().firstOrNull()?.description?.title.toString())
      }
    }) }
    until("the list opens") { loads.isNotEmpty() }
    val row = loads[0].first { it.description.title.toString() == "Control test tone 2" }
    main { c.transportControls.playFromMediaId(row.mediaId, null) }
    until("tone 2 plays") { title(c) == "Control test tone 2" }
    val told = CopyOnWriteArrayList<String>()
    val listener = object : PlatformController.Callback() {
      override fun onPlaybackStateChanged(state: PlaybackState?) { seenStates.add("${state?.state}/${state?.errorMessage}"); state?.errorMessage?.let { told.add(it.toString()) } }
    }
    main { c.registerCallback(listener, android.os.Handler(android.os.Looper.getMainLooper())) }
    press(c, ".STAR")
    val pick = "Add \u201cControl test tone 2\u201d to a playlist"
    until("the car reloads the list it came from with the picker on top") { changed.lastOrNull() == pick }
    try { until("the driver is told where the picker is") { told.any { it.contains("choose a playlist") } } }
    catch (e: AssertionError) { throw AssertionError("${e.message}; messages seen: $told; states: ${seenStates}") }
    main { c.unregisterCallback(listener) }
    for (parent in listOf("songs", "playlists", "playlist/road", "playlist/${MediaHub.PHONE_LIST}")) {
      assertEquals("picker on top of $parent", pick, children(car, parent).first().description.title.toString())
    }
    val road = children(car, children(car, "playlists").first().mediaId!!).first { it.description.title.toString() == "Road trip" }
    main { c.transportControls.playFromMediaId(road.mediaId, null) }
    until("added") { sent.any { it.optString("type") == "playlistAdd" && it.optString("list") == "road" && it.optString("id") == "ctl-tone-2" } }
    until("the picker leaves once used") { changed.lastOrNull() == "Control test tone 2" }
    assertEquals("Control test tone 2", title(c))
  }

  /** CAR-LOCAL-001 (owner, 2026-11-18): "ensure local music works on android auto". */
  @Test fun onThisPhoneListsOnlySongsHeldOnThePhoneAndPlaysThemInOrder() {
    MediaHub.setCommandSink(sink)
    val notHeld = JSONObject().put("id", "ctl-remote").put("title", "Not on this phone").put("artist", "Airwave diagnostic fixture").put("durationMs", 60000).put("ready", false)
    main {
      seed()
      val s = JSONArray().apply { for (i in 1..4) put(song(i)) }.put(notHeld)
      MediaHub.apply(JSONObject().put("library", JSONObject().put("songs", s).put("playlists", JSONArray()
        .put(JSONObject().put("id", "road").put("title", "Road trip").put("songs", JSONArray().put(song(5)).put(song(1)))))))
    }
    val c = connect()
    val car = connectCar()
    val top = children(car, "playlists").first()
    assertEquals("On this phone", top.description.title.toString())
    assertTrue("a list the car can open", top.isBrowsable)
    val local = children(car, top.mediaId!!)
    assertEquals("every song held on the phone once, nothing else",
      (1..5).map { "Control test tone $it" }, local.map { it.description.title.toString() })
    assertTrue(local.all { it.isPlayable })
    // The car keeps the Playlists list it loaded; when a song lands on the phone it is told to reload.
    val reloads = CopyOnWriteArrayList<List<String>>()
    main { car.subscribe("playlists", Bundle(), object : MediaBrowserCompat.SubscriptionCallback() {
      override fun onChildrenLoaded(parentId: String?, children: MutableList<MediaBrowserCompat.MediaItem>?, options: Bundle?) { reloads.add(children.orEmpty().map { it.description.subtitle.toString() }) }
    }) }
    until("Playlists loaded") { reloads.isNotEmpty() }
    assertEquals("5 songs saved on this phone", reloads.last().first())
    main {
      val s = JSONArray().apply { for (i in 1..4) put(song(i)) }.put(JSONObject(notHeld.toString()).put("ready", true).put("source", link(6)))
      MediaHub.apply(JSONObject().put("library", JSONObject().put("songs", s).put("playlists", JSONArray()
        .put(JSONObject().put("id", "road").put("title", "Road trip").put("songs", JSONArray().put(song(5)).put(song(1)))))))
    }
    until("the car reloads Playlists when a song lands") { reloads.last().first() == "6 songs saved on this phone" }
    main { c.transportControls.playFromMediaId(local[2].mediaId, null) }
    until("the chosen song plays") { title(c) == "Control test tone 3" && main { c.playbackState?.state } == PlaybackState.STATE_PLAYING }
    main { c.transportControls.skipToNext() }
    until("next is the next song on the phone") { title(c) == "Control test tone 4" }
    press(c, ".STAR")
    until("the star likes it") { sent.any { it.optString("type") == "feedback" && it.optString("id") == "ctl-tone-4" } }
    assertEquals("Add \u201cControl test tone 4\u201d to a playlist", children(car, top.mediaId!!).first().description.title.toString())
  }

  @Test fun aPlaylistPickWhileTheAppIsClosedReachesTheAppWhenItOpens() {
    main { seed() } // the service plays alone: no page sink
    val c = connect()
    playTone(c, 1)
    val car = connectCar()
    val picker = children(car, "addto/ctl-tone-3")
    main { c.transportControls.playFromMediaId(picker.first { it.description.title.toString() == "Night drive" }.mediaId, null) }
    until("kept on the phone") { CarFeedback.pendingCount() == 1 }
    assertTrue(sent.isEmpty())
    MediaHub.setCommandSink(sink) // the app opens
    main { seed() }
    until("delivered to the page") { sent.any { it.optString("type") == "playlistAdd" } }
    val add = sent.first { it.optString("type") == "playlistAdd" }
    assertEquals("ctl-tone-3", add.getString("id"))
    assertEquals("night", add.getString("list"))
    assertEquals(0, CarFeedback.pendingCount())
  }

  private fun storeTone(i: Int) {
    val rate = 24000; val frames = rate * 60; val pcm = ByteBuffer.allocate(frames * 2).order(ByteOrder.LITTLE_ENDIAN)
    for (f in 0 until frames) pcm.putShort((0.1 * sin(2 * PI * (330.0 + i * 70) / rate * f) * 32767).toInt().toShort())
    val name = MessageDigest.getInstance("SHA-256").digest(link(i).toByteArray()).joinToString("") { "%02x".format(it) } + ".wav"
    val file = File(File(ctx.filesDir, "audio-cache").apply { mkdirs() }, name)
    RandomAccessFile(file, "rw").use { out ->
      out.setLength(0); val h = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
      h.put("RIFF".toByteArray()).putInt(36 + pcm.capacity()).put("WAVEfmt ".toByteArray()).putInt(16)
        .putShort(1).putShort(1).putInt(rate).putInt(rate * 2).putShort(2).putShort(16).put("data".toByteArray()).putInt(pcm.capacity())
      out.write(h.array()); out.write(pcm.array())
    }
    ctx.getSharedPreferences("airwave-private-audio", Context.MODE_PRIVATE).edit().putString(link(i), name).commit()
  }

  private companion object {
    // androidx.media.utils.MediaConstants, spelt out: the keys Android Auto itself sends and reads.
    const val LIMIT = "androidx.media.utils.extras.CUSTOM_BROWSER_ACTION_LIMIT"
    const val ROOT_LIST = "androidx.media.utils.extras.CUSTOM_BROWSER_ACTION_ROOT_LIST"
    const val ID_LIST = "androidx.media.utils.extras.CUSTOM_BROWSER_ACTION_ID_LIST"
    const val ACTION_ID = "androidx.media.utils.extras.KEY_CUSTOM_BROWSER_ACTION_ID"
    const val ACTION_LABEL = "androidx.media.utils.extras.KEY_CUSTOM_BROWSER_ACTION_LABEL"
    const val ACTION_ICON = "androidx.media.utils.extras.KEY_CUSTOM_BROWSER_ACTION_ICON_URI"
    const val MEDIA_ITEM_ID = "androidx.media.utils.extras.KEY_CUSTOM_BROWSER_ACTION_MEDIA_ITEM_ID"
    const val RESULT_BROWSE_NODE = "androidx.media.utils.extras.KEY_CUSTOM_BROWSER_ACTION_RESULT_BROWSE_NODE"
    const val STAR_TO_PLAYLIST = "com.nowplaying.discovery.STAR_TO_PLAYLIST"
  }
}
