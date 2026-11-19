package com.nowplaying.discovery

import android.content.ComponentName
import android.content.Context
import android.media.browse.MediaBrowser
import android.media.session.MediaController as PlatformController
import android.media.session.PlaybackState
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
 * CAR-ACTIONS-001 (owner, 2026-11-15): "The android auto player should also have buttons for
 * staring a song, shuffle, and dislike". Android Auto draws a music app's extra buttons from the
 * platform session's custom actions, so these tests read the same legacy surface the car does.
 * Songs are generated local PCM tones (test fixtures, not catalogue recordings).
 */
@RunWith(AndroidJUnit4::class)
class CarActionButtonsTest {
  private val ctx: Context get() = ApplicationProvider.getApplicationContext()
  private val instr get() = InstrumentationRegistry.getInstrumentation()
  private fun <T> main(block: () -> T): T { val r = AtomicReference<T>(); instr.runOnMainSync { r.set(block()) }; return r.get() }
  private fun until(what: String, timeout: Long = 10000, condition: () -> Boolean) {
    val end = System.currentTimeMillis() + timeout
    while (System.currentTimeMillis() < end) { if (condition()) return; Thread.sleep(50) }
    throw AssertionError("Timeout: $what")
  }
  private val sent = CopyOnWriteArrayList<JSONObject>()
  private val sink: (JSONObject) -> Unit = { if (it.optString("type") == "feedback") sent.add(it) }
  private var browser: MediaBrowser? = null
  private var controller: PlatformController? = null

  private fun link(i: Int) = "https://music.youtube.com/watch?v=caractions0$i"
  private fun songs() = JSONArray().apply {
    for (i in 1..4) put(JSONObject().put("id", "act-tone-$i").put("title", "Action test tone $i")
      .put("artist", "Airwave diagnostic fixture").put("album", "Car action test (not catalogue music)")
      .put("durationMs", 60000).put("ready", true).put("source", link(i)))
  }
  private fun seed() {
    val s = songs()
    MediaHub.apply(JSONObject().put("state", JSONObject().put("queue", s)).put("library", JSONObject().put("songs", s)))
  }

  @Before fun setUp() {
    CarFeedback.init(ctx)
    CarFeedback.resetForTests()
    for (i in 1..4) storeTone(i)
  }

  @After fun tearDown() {
    main {
      controller?.let { c -> actionNamed(c, "Shuffle on")?.let { c.transportControls.sendCustomAction(it.action, null) } }
      controller?.let { c ->
        // REPEAT-COUNT-001: the service outlives a test; leave the song repeat off for the next one.
        for (n in 0 until 3) {
          val a = c.playbackState?.customActions?.firstOrNull { it.action.endsWith(".REPEAT") } ?: break
          if (a.name.toString() == "Repeat song: off") break
          c.transportControls.sendCustomAction(a.action, null)
          Thread.sleep(250)
        }
      }
      controller?.transportControls?.stop()
      browser?.disconnect()
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
  private fun playTone(c: PlatformController, i: Int) {
    main { c.transportControls.playFromMediaId("act-tone-$i", null) }
    until("tone $i is the session's song") { title(c) == "Action test tone $i" }
  }
  private fun title(c: PlatformController) = main { c.metadata?.getString("android.media.metadata.TITLE") }
  private fun actions(c: PlatformController) = main { c.playbackState?.customActions.orEmpty() }
  private fun actionNamed(c: PlatformController, name: String) = c.playbackState?.customActions?.firstOrNull { it.name.toString() == name }
  private fun names(c: PlatformController) = actions(c).map { it.name.toString() }
  private fun press(c: PlatformController, prefix: String) {
    val a = actions(c).firstOrNull { it.action.endsWith(prefix) } ?: throw AssertionError("no $prefix button in ${names(c)}")
    main { c.transportControls.sendCustomAction(a.action, null) }
  }

  @Test fun carPlayerOffersStarDislikeAndShuffleBesideTrackSkips() {
    MediaHub.setCommandSink(sink)
    main { seed() }
    val c = connect()
    playTone(c, 2)
    until("star, dislike and shuffle buttons") { names(c).containsAll(listOf("Star", "Dislike", "Shuffle off")) }
    val a = actions(c)
    assertTrue("each button carries an icon the car can draw", a.all { it.icon != 0 })
    val transport = main { c.playbackState!!.actions }
    assertTrue("previous track stays", transport and PlaybackState.ACTION_SKIP_TO_PREVIOUS != 0L)
    assertTrue("next track stays", transport and PlaybackState.ACTION_SKIP_TO_NEXT != 0L)
    assertTrue("play/pause stays", transport and PlaybackState.ACTION_PLAY_PAUSE != 0L)
    assertEquals("no timed fast-forward", 0L, transport and PlaybackState.ACTION_FAST_FORWARD)
    assertEquals("no timed rewind", 0L, transport and PlaybackState.ACTION_REWIND)
  }

  @Test fun starTeachesTheAppAndFlipsToRemoveStar() {
    MediaHub.setCommandSink(sink)
    main { seed() }
    val c = connect()
    playTone(c, 2)
    until("star button") { "Star" in names(c) }
    press(c, ".STAR")
    until("the page heard the star") { sent.isNotEmpty() }
    assertEquals("act-tone-2", sent[0].getString("id"))
    assertEquals("like", sent[0].getString("kind"))
    until("button shows the song is starred") { "Remove star" in names(c) }
    press(c, ".STAR")
    until("unstar sent") { sent.size == 2 }
    assertEquals("unlike", sent[1].getString("kind"))
    until("button back to Star") { "Star" in names(c) }
  }

  @Test fun dislikeTeachesTheAppAndSkipsToTheNextSong() {
    MediaHub.setCommandSink(sink)
    main { seed() }
    val c = connect()
    playTone(c, 2)
    until("dislike button") { "Dislike" in names(c) }
    press(c, ".DISLIKE")
    until("the page heard the dislike") { sent.isNotEmpty() }
    assertEquals("act-tone-2", sent[0].getString("id"))
    assertEquals("dislike", sent[0].getString("kind"))
    until("a disliked song is skipped") { title(c) == "Action test tone 3" }
  }

  @Test fun shuffleButtonTogglesTheSessionShuffleMode() {
    MediaHub.setCommandSink(sink)
    main { seed() }
    val c = connect()
    playTone(c, 1)
    until("shuffle button") { "Shuffle off" in names(c) }
    press(c, ".SHUFFLE")
    until("shuffle turned on") { "Shuffle on" in names(c) }
    press(c, ".SHUFFLE")
    until("shuffle turned off") { "Shuffle off" in names(c) }
    assertTrue("shuffle is not a taste judgement", sent.isEmpty())
  }

  /**
   * REPEAT-COUNT-001 (owner, 2026-11-18): the car shows how many more times this song will play,
   * with the same four states and wording as the phone: off, 1, 2, infinity.
   */
  @Test fun repeatButtonCyclesOffOneTwoInfinityWithItsOwnIconEach() {
    MediaHub.setCommandSink(sink)
    main { seed() }
    val c = connect()
    playTone(c, 1)
    val order = listOf("Repeat song: off", "Repeat song: 1 extra play", "Repeat song: 2 extra plays", "Repeat song: infinite plays")
    until("repeat button starts off") { order[0] in names(c) }
    val icons = mutableListOf<Int>()
    for (step in 0 until 4) {
      until("repeat shows ${order[step]}") { order[step] in names(c) }
      icons += actions(c).first { it.name.toString() == order[step] }.icon
      press(c, ".REPEAT")
    }
    until("repeat is off again") { order[0] in names(c) }
    assertTrue("every state has an icon the car can draw", icons.all { it != 0 })
    assertEquals("each count is its own picture", 4, icons.toSet().size)
    assertTrue("repeat is not a taste judgement", sent.isEmpty())
    assertTrue("star, dislike and shuffle keep their places", names(c).containsAll(listOf("Star", "Dislike", "Shuffle off")))
  }

  /**
   * REPEAT-COUNT-001: the car draws these four pictures itself, so prove Android can: each renders
   * a ring (ink on both the left and the right half, none at the very top or bottom where the two
   * arrows part), the centre is empty only when repeat is off, and no two states look alike.
   * The bitmaps are kept in the cache directory so a person can look at exactly what was drawn.
   */
  @Test fun repeatIconsDrawTwoArrowsAndACountTheCarCanShow() {
    val ids = listOf("off" to R.drawable.car_repeat_off, "once" to R.drawable.car_repeat_once, "twice" to R.drawable.car_repeat_twice, "infinite" to R.drawable.car_repeat_infinite)
    val size = 96
    fun ink(b: android.graphics.Bitmap, x0: Int, y0: Int, x1: Int, y1: Int): Int {
      var n = 0
      for (y in y0 until y1) for (x in x0 until x1) if (android.graphics.Color.alpha(b.getPixel(x, y)) > 128) n++
      return n
    }
    val drawn = ids.map { (name, id) ->
      val d = androidx.core.content.ContextCompat.getDrawable(ctx, id) ?: throw AssertionError("$name does not load")
      val b = android.graphics.Bitmap.createBitmap(size, size, android.graphics.Bitmap.Config.ARGB_8888)
      d.setBounds(0, 0, size, size); d.draw(android.graphics.Canvas(b))
      File(ctx.cacheDir, "car_repeat_$name.png").outputStream().use { b.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
      name to b
    }
    for ((name, b) in drawn) {
      assertTrue("$name: left arrow", ink(b, 0, 28, 28, 68) > 60)
      assertTrue("$name: right arrow", ink(b, 68, 28, 96, 68) > 60)
      assertEquals("$name: the arrows part at the top", 0, ink(b, 44, 0, 52, 22))
      assertEquals("$name: and at the bottom", 0, ink(b, 44, 74, 52, 96))
      val centre = ink(b, 34, 32, 62, 64) // inside the heads' inner corners
      if (name == "off") assertEquals("off: nothing in the middle", 0, centre) else assertTrue("$name: a count in the middle", centre > 40)
    }
    val pictures = drawn.map { (_, b) -> (0 until size).flatMap { y -> (0 until size).map { x -> android.graphics.Color.alpha(b.getPixel(x, y)) > 128 } } }
    assertEquals("four different pictures", 4, pictures.toSet().size)
  }

  @Test fun aStarPressedWhileTheAppIsClosedReachesTheAppWhenItOpens() {
    main { seed() } // the service plays alone: no page sink
    val c = connect()
    playTone(c, 3)
    until("star button") { "Star" in names(c) }
    press(c, ".STAR")
    until("kept on the phone") { CarFeedback.pendingCount() == 1 }
    until("button answers at once") { "Remove star" in names(c) }
    assertTrue(sent.isEmpty())
    MediaHub.setCommandSink(sink) // the app opens
    main { seed() }
    until("delivered to the page") { sent.size == 1 }
    assertEquals("act-tone-3", sent[0].getString("id"))
    assertEquals("like", sent[0].getString("kind"))
    assertEquals(0, CarFeedback.pendingCount())
  }

  private fun storeTone(i: Int) {
    val rate = 24000; val frames = rate * 60; val pcm = ByteBuffer.allocate(frames * 2).order(ByteOrder.LITTLE_ENDIAN)
    for (f in 0 until frames) pcm.putShort((0.1 * sin(2 * PI * (300.0 + i * 90) / rate * f) * 32767).toInt().toShort())
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
