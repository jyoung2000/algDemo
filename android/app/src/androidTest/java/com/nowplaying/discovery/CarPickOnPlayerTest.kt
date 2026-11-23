package com.nowplaying.discovery

import android.content.ComponentName
import android.content.Context
import android.media.browse.MediaBrowser
import android.media.session.MediaController as PlatformController
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
    main { controller?.transportControls?.stop(); browser?.disconnect() }
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
    until("the ordinary buttons come back") { "Remove star" in names(c) && names(c).none { it.startsWith("Add to ") } }
  }

  /** A list that already holds the song says so instead of pretending to add it again. */
  @Test fun aListThatAlreadyHoldsTheSongIsMarkedAndAddsNothing() {
    MediaHub.setCommandSink(sink)
    main { seed() }
    val c = connect()
    main { c.transportControls.playFromMediaId("pick-tone-1", null) }
    until("tone 1 plays") { title(c) == "Pick test tone 1" }
    until("star button") { "Star" in names(c) }
    press(c, "Star")
    until("Gym is marked as already holding it") { "Already in Gym" in names(c) }
    press(c, "Already in Gym")
    Thread.sleep(600)
    assertTrue("nothing was added twice", ofType("playlistAdd").isEmpty())
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
