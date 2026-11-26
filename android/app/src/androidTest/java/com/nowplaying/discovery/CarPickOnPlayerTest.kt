package com.nowplaying.discovery

import android.content.ComponentName
import android.content.Context
import android.media.browse.MediaBrowser
import android.media.session.MediaController as PlatformController
import android.media.session.PlaybackState
import android.os.SystemClock
import android.view.KeyEvent
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
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
 * CAR-PICK-ON-PLAYER-001 and CAR-SIMILAR-ID-001 (owner, 2026-11-23): "the heart button doesn't
 * immediately bring up the playlist selector on android auto. Also sometimes the find similar songs
 * and heart artist buttons don't work on android auto".
 *
 * These read the same platform session surface Android Auto draws, on a device.
 */
@RunWith(AndroidJUnit4::class)
class CarPickOnPlayerTest {
  private val ctx: Context get() = ApplicationProvider.getApplicationContext()
  private val instr get() = InstrumentationRegistry.getInstrumentation()
  private fun <T> main(block: () -> T): T { val r = AtomicReference<T>(); instr.runOnMainSync { r.set(block()) }; return r.get() }
  private fun until(what: String, timeout: Long = 12000, condition: () -> Boolean) {
    val end = System.currentTimeMillis() + timeout
    while (System.currentTimeMillis() < end) { if (condition()) return; Thread.sleep(50) }
    throw AssertionError("Timeout: $what (buttons now: ${controller?.let { names(it) }})")
  }
  private val sent = CopyOnWriteArrayList<JSONObject>()
  private val sink: (JSONObject) -> Unit = { sent.add(it) }
  private var browser: MediaBrowser? = null
  private var controller: PlatformController? = null

  private fun link(i: Int) = "https://music.youtube.com/watch?v=carpick0$i"
  private fun songs() = JSONArray().apply {
    for (i in 1..3) put(JSONObject().put("id", "pick-tone-$i").put("title", "Pick test tone $i")
      .put("artist", "Airwave diagnostic fixture").put("album", "Car picker test (not catalogue music)")
      .put("durationMs", 60000).put("ready", true).put("source", link(i)))
  }
  private fun lists() = JSONArray().apply {
    put(JSONObject().put("id", "pl-night").put("title", "Night drive").put("songs", JSONArray()))
    put(JSONObject().put("id", "pl-gym").put("title", "Gym").put("songs", JSONArray().put(
      JSONObject().put("id", "pick-tone-1").put("title", "Pick test tone 1").put("artist", "Airwave diagnostic fixture")
        .put("durationMs", 60000).put("ready", true).put("source", link(1)))))
  }
  private fun seed() {
    val s = songs()
    MediaHub.apply(JSONObject().put("state", JSONObject().put("queue", s))
      .put("library", JSONObject().put("songs", s).put("playlists", lists())))
  }

  @Before fun setUp() {
    CarFeedback.init(ctx)
    CarFeedback.resetForTests()
    for (i in 1..3) storeTone(i)
  }

  @After fun tearDown() {
    CarPickList.listForTests = null
    main { controller?.transportControls?.sendCustomAction("com.nowplaying.discovery.PICK_LIST", null); controller?.transportControls?.stop(); browser?.disconnect() }
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
  private fun actions(c: PlatformController) = main { c.playbackState?.customActions.orEmpty() }
  private fun names(c: PlatformController) = actions(c).map { it.name.toString() }
  private fun title(c: PlatformController) = main { c.metadata?.getString("android.media.metadata.TITLE") }
  private fun press(c: PlatformController, name: String) {
    val a = actions(c).firstOrNull { it.name.toString() == name } ?: throw AssertionError("no \"$name\" button in ${names(c)}")
    main { c.transportControls.sendCustomAction(a.action, a.extras) }
  }
  private fun ofType(t: String) = sent.filter { it.optString("type") == t }
  private fun state(c: PlatformController) = main { c.playbackState?.state }
  private fun position(c: PlatformController): Long = main {
    val s = c.playbackState ?: return@main -1L
    if (s.state != PlaybackState.STATE_PLAYING) s.position
    else s.position + ((SystemClock.elapsedRealtime() - s.lastPositionUpdateTime) * s.playbackSpeed).toLong()
  }
  /** What the car's list [parent] holds now, as the car's browser reads it. */
  private fun children(parent: String): List<MediaBrowser.MediaItem> {
    val got = AtomicReference<List<MediaBrowser.MediaItem>>()
    val done = CountDownLatch(1)
    val cb = object : MediaBrowser.SubscriptionCallback() {
      override fun onChildrenLoaded(parentId: String, children: MutableList<MediaBrowser.MediaItem>) { got.set(children.toList()); done.countDown() }
      override fun onError(parentId: String) { got.set(emptyList()); done.countDown() }
    }
    main { browser!!.subscribe(parent, cb) }
    assertTrue("children of $parent", done.await(10, TimeUnit.SECONDS))
    main { browser!!.unsubscribe(parent, cb) }
    return got.get()
  }
  private fun rowTitles(parent: String) = children(parent).map { it.description.title.toString() }
  /** Where the song was, and when: to tell a song that played on from one that stopped or started again. */
  private class Mark(val position: Long, val at: Long, val queued: Int)
  /** Tone 2 playing steadily, as the car sees it. */
  private fun playingInTheCar(c: PlatformController): Mark {
    // The service outlives a test: go by way of another song, so "tone 2 plays" is this test's own start and not
    // what the last test left on the session.
    main { c.transportControls.playFromMediaId("pick-tone-1", null) }
    until("tone 1 plays") { title(c) == "Pick test tone 1" && state(c) == PlaybackState.STATE_PLAYING }
    main { c.transportControls.playFromMediaId("pick-tone-2", null) }
    until("tone 2 plays") { title(c) == "Pick test tone 2" && state(c) == PlaybackState.STATE_PLAYING }
    until("star button") { "Star" in names(c) }
    until("the clock runs at the song's own speed") { val a = position(c); Thread.sleep(400); (position(c) - a) in 250..600 }
    return Mark(position(c), SystemClock.elapsedRealtime(), main { c.queue.orEmpty().size })
  }
  /** The song is where it would be had nothing happened to it since [m]. */
  private fun assertPlayedOn(c: PlatformController, m: Mark) {
    val moved = position(c) - m.position
    val passed = SystemClock.elapsedRealtime() - m.at
    assertTrue("the song played on without stopping or starting again: moved $moved ms in $passed ms", moved in (passed - 600)..(passed + 600))
  }

  /**
   * CAR-PICK-LIST-001 (owner, 2026-11-23): "on android auto the playlist menu should replace the current playing
   * track player and quick controls, open up a list where the user can select playlist then get taken back to the
   * song player once the track is added to the right playlist".
   */
  @Test fun inTheCarTheHeartShowsAListOfPlaylistsInPlaceOfThePlayerAndAPickGoesBackToTheSong() {
    CarPickList.listForTests = true
    MediaHub.setCommandSink(sink)
    main { seed() }
    val c = connect()
    val before = playingInTheCar(c)
    assertEquals("the car's first list is the songs", "Pick test tone 1", rowTitles("songs").first())
    press(c, "Star")
    // What makes Android Auto leave its player for the lists (measured on the head unit): nothing playing to show.
    until("the car is shown nothing playing") { state(c) == PlaybackState.STATE_NONE && title(c) == null }
    assertEquals("and no queue", 0, main { c.queue.orEmpty().size })
    assertEquals("the star was saved at once", listOf("like"), ofType("feedback").map { it.getString("kind") })
    val rows = children("songs")
    assertEquals(listOf("Back to \u201cPick test tone 2\u201d", "Add to Night drive", "Add to Gym"), rows.map { it.description.title.toString() })
    assertEquals("every other list the car can be in shows the same", rows.map { it.mediaId }, children("playlists").map { it.mediaId })
    Thread.sleep(1200)
    main { c.transportControls.playFromMediaId(rows[2].mediaId, null) }
    until("added to the playlist picked") { ofType("playlistAdd").any { it.getString("list") == "pl-gym" && it.getString("id") == "pick-tone-2" } }
    until("the car is back on the song") { title(c) == "Pick test tone 2" && state(c) == PlaybackState.STATE_PLAYING }
    assertEquals("the queue is as it was", before.queued, main { c.queue.orEmpty().size })
    assertPlayedOn(c, before)
    until("the ordinary buttons") { CarPickList.STARRED_LABEL in names(c) }
    assertEquals("and the lists are the lists again", "Pick test tone 1", rowTitles("songs").first())
    assertEquals(1, ofType("playlistAdd").size)
  }

  /** CAR-PICK-LIST-001: the first row is the way back; it adds the song nowhere and keeps its star. */
  @Test fun theWayBackRowReturnsToTheSongAndAddsItNowhere() {
    CarPickList.listForTests = true
    MediaHub.setCommandSink(sink)
    main { seed() }
    val c = connect()
    val before = playingInTheCar(c)
    press(c, "Star")
    until("the list") { state(c) == PlaybackState.STATE_NONE }
    Thread.sleep(1500)
    val back = children("songs").first()
    assertEquals("Back to \u201cPick test tone 2\u201d", back.description.title.toString())
    main { c.transportControls.playFromMediaId(back.mediaId, null) }
    until("back on the song") { title(c) == "Pick test tone 2" && state(c) == PlaybackState.STATE_PLAYING }
    assertPlayedOn(c, before)
    Thread.sleep(400)
    assertTrue(ofType("playlistAdd").isEmpty())
    assertEquals("it stays starred", listOf("like"), ofType("feedback").map { it.getString("kind") })
  }

  /** CAR-PICK-LIST-001: a key on the wheel during the list acts on the real player; it must not reload the queue. */
  @Test fun aWheelKeyDuringTheListClosesItAndTheSongGoesOnFromWhereItWas() {
    CarPickList.listForTests = true
    MediaHub.setCommandSink(sink)
    main { seed() }
    val c = connect()
    val before = playingInTheCar(c)
    press(c, "Star")
    until("the list") { state(c) == PlaybackState.STATE_NONE }
    Thread.sleep(1500)
    main {
      c.dispatchMediaButtonEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_MEDIA_PLAY))
      c.dispatchMediaButtonEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_MEDIA_PLAY))
    }
    until("the player is back") { title(c) == "Pick test tone 2" && state(c) == PlaybackState.STATE_PLAYING }
    assertEquals(before.queued, main { c.queue.orEmpty().size })
    assertPlayedOn(c, before)
    assertEquals("the songs list is the songs again", "Pick test tone 1", rowTitles("songs").first())
  }

  /** CAR-PICK-LIST-001: left alone, the list goes by itself and the song was playing all along. */
  @Test fun leftAloneTheListGoesAndTheSongWasPlayingAllAlong() {
    CarPickList.listForTests = true
    MediaHub.setCommandSink(sink)
    main { seed() }
    val c = connect()
    val before = playingInTheCar(c)
    press(c, "Star")
    until("the list") { state(c) == PlaybackState.STATE_NONE }
    until("the player comes back by itself", timeout = 32000) { title(c) == "Pick test tone 2" && state(c) == PlaybackState.STATE_PLAYING }
    assertTrue("it stayed up for the driver to read", SystemClock.elapsedRealtime() - before.at >= 20000)
    assertPlayedOn(c, before)
    assertTrue(ofType("playlistAdd").isEmpty())
  }

  /** The heart brings the playlist choice to the player itself: no trip back to a browse list. */
  @Test fun theHeartTurnsThePlayerButtonsIntoThePlaylistPicker() {
    MediaHub.setCommandSink(sink)
    main { seed() }
    val c = connect()
    main { c.transportControls.playFromMediaId("pick-tone-2", null) }
    until("tone 2 plays") { title(c) == "Pick test tone 2" }
    until("star button") { "Star" in names(c) }
    press(c, "Star")
    until("the lists are the buttons") { names(c).containsAll(listOf("Add to Night drive", "Add to Gym", "Cancel")) }
    assertTrue("each picker button carries an icon the car can draw", actions(c).all { it.icon != 0 })

    press(c, "Add to Gym")
    until("the page was told which list") { ofType("playlistAdd").isNotEmpty() }
    assertEquals("pick-tone-2", ofType("playlistAdd")[0].getString("id"))
    assertEquals("pl-gym", ofType("playlistAdd")[0].getString("list"))
    until("the ordinary buttons come back") { CarPickList.STARRED_LABEL in names(c) && names(c).none { it.startsWith("Add to ") } }
  }

  /**
   * CAR-HEART-ALWAYS-001 (owner, 2026-11-23): "on android auto hearting a song doesnt bring up the playlist sub menu
   * like desired". A song that is already starred used to lose its star on the next press and show no lists.
   */
  @Test fun theHeartOnAnAlreadyStarredSongBringsThePickerAgainAndKeepsTheStar() {
    MediaHub.setCommandSink(sink)
    main { seed() }
    val c = connect()
    main { c.transportControls.playFromMediaId("pick-tone-2", null) }
    until("tone 2 plays") { title(c) == "Pick test tone 2" }
    until("star button") { "Star" in names(c) }
    press(c, "Star")
    until("the picker is up") { "Cancel" in names(c) }
    assertTrue("a song starred by this press is not offered Remove star", "Remove star" !in names(c))
    press(c, "Cancel")
    until("starred, ordinary buttons") { CarPickList.STARRED_LABEL in names(c) }

    press(c, CarPickList.STARRED_LABEL)
    until("the lists come up again") { names(c).containsAll(listOf("Add to Night drive", "Add to Gym", "Remove star", "Cancel")) }
    assertEquals("the second press did not take the star off", listOf("like"), ofType("feedback").map { it.getString("kind") })
    press(c, "Add to Night drive")
    until("added") { ofType("playlistAdd").any { it.getString("list") == "pl-night" } }

    press(c, CarPickList.STARRED_LABEL)
    until("the picker again") { "Remove star" in names(c) }
    press(c, "Remove star")
    until("the star came off because the driver asked") { ofType("feedback").map { it.getString("kind") } == listOf("like", "unlike") }
    until("heart is empty again") { "Star" in names(c) }
  }

  /** CAR-HEART-ALWAYS-001: with no playlist at all the heart still brings a choice: start one. */
  @Test fun withNoPlaylistTheHeartOffersToStartOne() {
    MediaHub.setCommandSink(sink)
    main {
      val s = songs()
      MediaHub.apply(JSONObject().put("state", JSONObject().put("queue", s)).put("library", JSONObject().put("songs", s).put("playlists", JSONArray())))
    }
    val c = connect()
    main { c.transportControls.playFromMediaId("pick-tone-3", null) }
    until("tone 3 plays") { title(c) == "Pick test tone 3" }
    until("star button") { "Star" in names(c) }
    press(c, "Star")
    until("a playlist is offered") { names(c) == listOf("New playlist \u201cCar picks\u201d", "Cancel") }
    press(c, "New playlist \u201cCar picks\u201d")
    until("the page is asked to start the list with this song") { ofType("playlistAdd").isNotEmpty() }
    assertEquals(CarPickList.NEW_LIST, ofType("playlistAdd")[0].getString("list"))
    assertEquals("pick-tone-3", ofType("playlistAdd")[0].getString("id"))
  }

  /**
   * CAR-SAVE-HIDDEN-001 (owner, 2026-11-23): "on android auto hearting a song doesnt bring up the playlist sub menu
   * like desired" / "the playlist dont load or save the music". Measured with the head unit: with jPlay not in
   * front its page is frozen, and the star and the playlist choice handed to it were saved late or never. They go
   * to the service's own engine, which keeps running in a car.
   */
  @Test fun withThePhonePageHiddenTheServiceEngineSavesTheStarAndThePlaylistChoice() {
    val service = CopyOnWriteArrayList<JSONObject>()
    val serviceSink: (JSONObject) -> Unit = { service.add(it) }
    val oldSaves = MediaHub.serviceSaves
    val old = MediaHub.swapCatalogSinkForTests(serviceSink, true)
    MediaHub.serviceSaves = { true }
    try {
      MediaHub.setCommandSink(sink)
      main { seed() }
      // The phone goes into a pocket: the page is hidden and its WebView paused.
      main { MediaHub.setPageVisible(sink, false); MediaHub.setPageRunning(sink) { false } }
      val c = connect()
      main { c.transportControls.playFromMediaId("pick-tone-2", null) }
      until("tone 2 plays") { title(c) == "Pick test tone 2" }
      until("star button") { "Star" in names(c) }
      press(c, "Star")
      until("the service engine is asked to save the star") { service.any { it.optString("type") == "feedback" && it.optString("kind") == "like" && it.optString("id") == "pick-tone-2" } }
      until("the picker") { "Add to Night drive" in names(c) }
      press(c, "Add to Night drive")
      until("and the playlist choice") { service.any { it.optString("type") == "playlistAdd" && it.optString("list") == "pl-night" && it.optString("id") == "pick-tone-2" } }
      assertTrue("the frozen page was asked nothing: $sent", ofType("feedback").isEmpty() && ofType("playlistAdd").isEmpty())
      assertEquals("nothing is left waiting", 0, CarFeedback.pendingCount())
    } finally {
      MediaHub.serviceSaves = oldSaves
      MediaHub.swapCatalogSinkForTests(old.first, old.second)
    }
  }

  /** CAR-SAVE-HIDDEN-001: a save the service's engine hands back is kept for the phone page, and never offered to the service again. */
  @Test fun aSaveTheServiceEngineCouldNotMakeIsKeptForThePhonePageOnly() {
    val service = CopyOnWriteArrayList<JSONObject>()
    val serviceSink: (JSONObject) -> Unit = { service.add(it) }
    val oldSaves = MediaHub.serviceSaves
    val old = MediaHub.swapCatalogSinkForTests(serviceSink, true)
    MediaHub.serviceSaves = { true }
    try {
      CarFeedback.keepForPage(JSONObject().put("type", "feedback").put("id", "unknown-song").put("kind", "like"))
      CarFeedback.keepForPage(JSONObject().put("type", "somethingElse").put("id", "x"))
      assertEquals("only a save is kept", 1, CarFeedback.pendingCount())
      main { CarFeedback.flush() }
      assertTrue("the service is not asked again: $service", service.isEmpty())
      assertEquals(1, CarFeedback.pendingCount())
      MediaHub.setCommandSink(sink) // the phone app opens
      main { seed() }
      until("the page is asked") { ofType("feedback").size == 1 }
      assertEquals("unknown-song", ofType("feedback")[0].getString("id"))
      assertTrue("the marker stays inside", !ofType("feedback")[0].has("pageOnly"))
      assertEquals(0, CarFeedback.pendingCount())
    } finally {
      MediaHub.serviceSaves = oldSaves
      MediaHub.swapCatalogSinkForTests(old.first, old.second)
    }
  }

  /** CAR-SAVE-HIDDEN-001: with no engine able to save, the press is kept and goes to the page when it is back in front. */
  @Test fun withNothingAbleToSaveThePressIsKeptForThePageComingBack() {
    val oldSaves = MediaHub.serviceSaves
    MediaHub.serviceSaves = { false }
    try {
      MediaHub.setCommandSink(sink)
      main { seed() }
      main { MediaHub.setPageVisible(sink, false); MediaHub.setPageRunning(sink) { false } }
      val c = connect()
      main { c.transportControls.playFromMediaId("pick-tone-3", null) }
      until("tone 3 plays") { title(c) == "Pick test tone 3" }
      until("star button") { "Star" in names(c) }
      press(c, "Star")
      until("kept on the phone") { CarFeedback.pendingCount() == 1 }
      assertTrue("the frozen page was asked nothing: $sent", ofType("feedback").isEmpty())
      main { MediaHub.setPageRunning(sink) { true }; MediaHub.setPageVisible(sink, true) }
      until("the page gets it when it is back in front") { ofType("feedback").map { it.getString("kind") } == listOf("like") }
      assertEquals(0, CarFeedback.pendingCount())
    } finally { MediaHub.serviceSaves = oldSaves }
  }

  /** PLAYLIST-KEEP-001: the page's first push names only its songs; the car must keep the playlists it has. */
  @Test fun aPushWithoutPlaylistsKeepsTheCarsPlaylists() {
    main { seed() }
    assertEquals(listOf("Night drive", "Gym"), MediaHub.playlists.map { it.title })
    main { MediaHub.apply(JSONObject().put("state", JSONObject().put("queue", songs())).put("library", JSONObject().put("songs", songs()))) }
    assertEquals(listOf("Night drive", "Gym"), MediaHub.playlists.map { it.title })
    main { MediaHub.apply(JSONObject().put("library", JSONObject().put("songs", songs()).put("playlists", JSONArray()))) }
    assertTrue("an explicit empty list still clears them", MediaHub.playlists.isEmpty())
  }

  /** CAR-NO-DUP-LIST-001: a list that already holds the song is not offered, so it cannot be picked. */
  @Test fun aListThatAlreadyHoldsTheSongIsNotOfferedAndAddsNothing() {
    MediaHub.setCommandSink(sink)
    main { seed() }
    val c = connect()
    main { c.transportControls.playFromMediaId("pick-tone-1", null) }
    until("tone 1 plays") { title(c) == "Pick test tone 1" }
    until("star button") { "Star" in names(c) }
    press(c, "Star")
    until("the picker is up") { "Cancel" in names(c) }
    assertTrue("Night drive is offered: ${names(c)}", "Add to Night drive" in names(c))
    assertTrue("Gym holds the song and is not offered: ${names(c)}", names(c).none { it == "Add to Gym" || it == "Already in Gym" })
    press(c, "Cancel")
    until("the ordinary buttons come back") { names(c).none { it == "Cancel" } }
    assertTrue("nothing was added", ofType("playlistAdd").isEmpty())
  }

  /** CAR-NO-DUP-LIST-001: a row the car showed before the song reached the list must not add it a second time. */
  @Test fun aStalePickOfAListThatNowHoldsTheSongAddsNothing() {
    CarPickList.listForTests = true
    MediaHub.setCommandSink(sink)
    main { seed() }
    val c = connect()
    playingInTheCar(c)
    press(c, "Star")
    until("the car is shown nothing playing") { state(c) == PlaybackState.STATE_NONE && title(c) == null }
    val gymRow = children("songs").first { it.description.title.toString() == "Add to Gym" }
    assertEquals("Gym holds one song before the phone adds the other", 1, main { MediaHub.playlist("pl-gym")?.songs?.size })
    // The phone adds the song to Gym while the car still has the old row from before.
    main { MediaHub.addToPlaylistNow("pl-gym", "pick-tone-2") }
    assertEquals(2, main { MediaHub.playlist("pl-gym")?.songs?.size })
    Thread.sleep(1200)
    main { c.transportControls.playFromMediaId(gymRow.mediaId, null) }
    Thread.sleep(800)
    assertTrue("the stale row sent no second add", ofType("playlistAdd").isEmpty())
    assertEquals("Gym still holds the song once", 2, main { MediaHub.playlist("pl-gym")?.songs?.size })
  }

  /** Cancel puts the player back without saving the song to anything. */
  @Test fun cancelLeavesThePickerWithoutAddingTheSong() {
    MediaHub.setCommandSink(sink)
    main { seed() }
    val c = connect()
    main { c.transportControls.playFromMediaId("pick-tone-3", null) }
    until("tone 3 plays") { title(c) == "Pick test tone 3" }
    until("star button") { "Star" in names(c) }
    press(c, "Star")
    until("the picker is up") { "Cancel" in names(c) }
    press(c, "Cancel")
    until("the ordinary buttons come back") { names(c).none { it == "Cancel" } }
    assertTrue("cancel saves nothing", ofType("playlistAdd").isEmpty())
  }

  /**
   * CAR-SIMILAR-ID-001: a playlist row's media id carries its list, which the page cannot look up.
   * Find similar must ask about the song itself.
   */
  @Test fun findSimilarAsksAboutTheSongNotThePlaylistRow() {
    MediaHub.setCommandSink(sink)
    main { seed() }
    val c = connect()
    main { c.transportControls.playFromMediaId("playlist/pl-gym/track/pick-tone-1", null) }
    until("the playlist row plays") { title(c) == "Pick test tone 1" }
    until("find similar button") { names(c).any { it.startsWith("Find similar") } }
    press(c, "Find similar songs")
    until("the page was asked") { ofType("findSimilar").isNotEmpty() }
    assertEquals("the song's own id, not the row's", "pick-tone-1", ofType("findSimilar")[0].getString("id"))
  }

  /** ARTIST-FAV-CAR-001 + CAR-ANSWERABLE-001: the star reaches the page with a request to answer. */
  @Test fun starTheArtistAsksAPageThatCanAnswerAndWaitsForIt() {
    MediaHub.setCommandSink(sink)
    main { seed() }
    val c = connect()
    main { c.transportControls.playFromMediaId("pick-tone-2", null) }
    until("tone 2 plays") { title(c) == "Pick test tone 2" }
    until("star the artist button") { names(c).any { it.startsWith("Star the artist") } }
    press(c, "Star the artist")
    until("the page was asked to star the artist") { ofType("starArtists").isNotEmpty() }
    val ask = ofType("starArtists")[0]
    assertEquals("pick-tone-2", ask.getString("id"))
    assertEquals("Airwave diagnostic fixture", ask.getString("artist"))
    assertTrue("the car waits for an answer", ask.optString("requestId").isNotBlank())
  }

  private fun storeTone(i: Int) {
    val rate = 24000; val frames = rate * 60; val pcm = ByteBuffer.allocate(frames * 2).order(ByteOrder.LITTLE_ENDIAN)
    for (f in 0 until frames) pcm.putShort((0.1 * sin(2 * PI * (320.0 + i * 70) / rate * f) * 32767).toInt().toShort())
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
}
