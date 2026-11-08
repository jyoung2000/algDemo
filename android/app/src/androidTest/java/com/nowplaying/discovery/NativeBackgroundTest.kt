package com.nowplaying.discovery

import android.content.ComponentName
import android.content.Context
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.nowplaying.discovery.engine.EngineHub
import com.nowplaying.discovery.engine.EnginePlayer
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
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.PI
import kotlin.math.sin

/**
 * Plan Task 2: playback belongs to the service. A real [MediaController] (what the lock screen,
 * Bluetooth and Android Auto use) drives the real [PlaybackService] with no Activity and no page:
 * songs resolve through the real download store, the queue advances on its own, and pause, play,
 * seek and next all act on audio the service renders. The page, when there is one, is still asked
 * to choose (it knows the playlist context); without one the service decides.
 */
@UnstableApi
@RunWith(AndroidJUnit4::class)
class NativeBackgroundTest {
  private val ctx: Context get() = ApplicationProvider.getApplicationContext()
  private val instr get() = InstrumentationRegistry.getInstrumentation()
  private var controller: MediaController? = null

  /** A short WAV stored exactly as the downloader stores a finished song, keyed by its link. */
  private fun store(link: String, hz: Double, seconds: Double) {
    val rate = 44100
    val frames = (seconds * rate).toInt()
    val data = ByteBuffer.allocate(frames * 4).order(ByteOrder.LITTLE_ENDIAN)
    for (i in 0 until frames) {
      val v = (0.4 * sin(2 * PI * hz * i / rate) * 32767).toInt().toShort()
      data.putShort(v); data.putShort(v)
    }
    val hash = MessageDigest.getInstance("SHA-256").digest(link.toByteArray()).joinToString("") { "%02x".format(it) }
    val name = "$hash.wav"
    val file = File(File(ctx.filesDir, "audio-cache").apply { mkdirs() }, name)
    RandomAccessFile(file, "rw").use { raf ->
      raf.setLength(0)
      val h = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
      h.put("RIFF".toByteArray()).putInt(36 + data.capacity()).put("WAVE".toByteArray())
      h.put("fmt ".toByteArray()).putInt(16).putShort(1).putShort(2).putInt(rate).putInt(rate * 4).putShort(4).putShort(16)
      h.put("data".toByteArray()).putInt(data.capacity())
      raf.write(h.array()); raf.write(data.array())
    }
    ctx.getSharedPreferences("airwave-private-audio", Context.MODE_PRIVATE).edit().putString(link, name).commit()
  }

  private val links = (1..3).map { "https://music.youtube.com/watch?v=bgtest00${it}xx" }

  private fun seed(withPlaylist: Boolean = false) {
    val songs = JSONArray()
    links.forEachIndexed { i, link ->
      songs.put(JSONObject().put("id", "bg${i + 1}").put("title", "Background ${i + 1}").put("artist", "Test")
        .put("durationMs", 3000).put("ready", true).put("source", link))
    }
    val lib = JSONObject().put("songs", songs)
    if (withPlaylist) lib.put("playlists", JSONArray().put(JSONObject().put("id", "p1").put("title", "Road").put("songs", JSONArray().put(songs.getJSONObject(2)))))
    MediaHub.apply(JSONObject().put("state", JSONObject().put("queue", songs)).put("library", lib))
  }

  @Before fun setUp() {
    store(links[0], 440.0, 3.0)
    store(links[1], 660.0, 3.0)
    store(links[2], 880.0, 3.0)
    val token = SessionToken(ctx, ComponentName(ctx, PlaybackService::class.java))
    val ready = CountDownLatch(1)
    instr.runOnMainSync {
      val f = MediaController.Builder(ctx, token).buildAsync()
      f.addListener({ controller = f.get(); ready.countDown() }, Runnable::run)
    }
    assertTrue("controller connected to the service", ready.await(15, TimeUnit.SECONDS))
  }

  @After fun tearDown() {
    instr.runOnMainSync {
      controller?.stop()
      controller?.clearMediaItems()
      controller?.release()
    }
  }

  private fun <T> onMain(f: (MediaController) -> T): T {
    val out = AtomicReference<T>()
    instr.runOnMainSync { out.set(f(controller!!)) }
    return out.get()
  }

  private fun waitFor(what: String, timeoutMs: Long = 10_000, cond: (MediaController) -> Boolean) {
    val end = System.currentTimeMillis() + timeoutMs
    while (System.currentTimeMillis() < end) {
      if (onMain(cond)) return
      Thread.sleep(50)
    }
    throw AssertionError("timed out waiting for: $what (state=${onMain { it.playbackState }}, item=${onMain { it.currentMediaItem?.mediaId }}, pos=${onMain { it.currentPosition }})")
  }

  @Test fun theServicePlaysAdvancesAndObeysTheSessionWithNoAppOpen() {
    seed()
    onMain {
      it.setMediaItems(listOf("bg1", "bg2", "bg3").map { id -> MediaItem.Builder().setMediaId(id).build() }, 0, 0)
      it.prepare()
      it.play()
    }
    waitFor("playing the first song") { it.isPlaying && it.currentMediaItem?.mediaId == "bg1" }
    waitFor("the playhead moves") { it.currentPosition > 500 }

    // Pause holds the place; play carries on from it.
    onMain { it.pause() }
    waitFor("paused") { !it.playWhenReady && !it.isPlaying }
    val held = onMain { it.currentPosition }
    Thread.sleep(600)
    val still = onMain { it.currentPosition }
    assertTrue("paused playhead does not move ($held -> $still)", still - held < 150)
    onMain { it.play() }
    waitFor("playing again") { it.isPlaying }

    // Seek lands where asked.
    onMain { it.seekTo(2000) }
    waitFor("seeked to ~2 s") { it.currentPosition in 1900..2600 }

    // The song ends and the next one starts by itself: no page is there to choose.
    waitFor("advanced to the second song on its own") { it.currentMediaItem?.mediaId == "bg2" && it.isPlaying }

    // Next from the session.
    onMain { it.seekToNext() }
    waitFor("Next reached the third song") { it.currentMediaItem?.mediaId == "bg3" && it.isPlaying }

    // The end of the list with repeat off: playback ends cleanly, no phantom PLAYING.
    waitFor("ended at the end of the list", timeoutMs = 8_000) { it.playbackState == Player.STATE_ENDED && !it.isPlaying }

    // Play on a finished song starts it again from the top, as the app's own player does.
    onMain { it.play() }
    waitFor("the last song plays again from the start") { it.isPlaying && it.currentMediaItem?.mediaId == "bg3" && it.currentPosition < 1500 }
  }

  @Test fun aChosenSongStartsWhenItsFileLandsEvenIfThePageSaysNothingMore() {
    seed()
    val late = "https://music.youtube.com/watch?v=bgtestlatex"
    // Not downloaded yet: forget any copy an earlier run left.
    ctx.getSharedPreferences("airwave-private-audio", Context.MODE_PRIVATE).edit().remove(late).commit()
    val page = object : EnginePlayer.Page {
      override val live = true
      override fun command(cmd: JSONObject) {}
      override fun state(json: JSONObject) {}
    }
    EngineHub.attachPage(page)
    try {
      val song = JSONObject().put("id", "late").put("title", "Late").put("artist", "Test").put("durationMs", 3000)
        .put("ready", false).put("source", late)
      EngineHub.fromPage(JSONObject().put("op", "load").put("song", song).put("positionMs", 0).put("play", true).put("rev", 0).toString())
      waitFor("waiting for the file, as loading") { it.playbackState == Player.STATE_BUFFERING && it.playWhenReady && it.currentMediaItem?.mediaId == "late" }
      Thread.sleep(1500)
      assertTrue("nothing plays before the file is here", onMain { !it.isPlaying })
      // The download finishes; the page (asleep, say) sends nothing more.
      store(late, 550.0, 3.0)
      waitFor("the song starts by itself once its file lands", timeoutMs = 5_000) { it.isPlaying && it.currentMediaItem?.mediaId == "late" }
    } finally {
      EngineHub.detachPage(page)
    }
  }

  @Test fun aCarChoiceGoesToTheOpenAppButTheServicePlaysItItselfWhenNoneIsOpen() {
    seed(withPlaylist = true)
    // With an app open the app chooses (it knows the playlist's context and order).
    val asked = AtomicReference<JSONObject?>()
    val delivered = CountDownLatch(1)
    val page = object : EnginePlayer.Page {
      override val live = true
      override fun command(cmd: JSONObject) { asked.set(cmd); delivered.countDown() }
      override fun state(json: JSONObject) {}
    }
    EngineHub.attachPage(page)
    try {
      onMain { it.setMediaItems(listOf(MediaItem.Builder().setMediaId("playlist/p1/track/bg3").build()), 0, 0) }
      assertTrue("the open app was asked to play the car's choice", delivered.await(5, TimeUnit.SECONDS))
      assertEquals("playId", asked.get()?.optString("type"))
      assertEquals("playlist/p1/track/bg3", asked.get()?.optString("id"))
    } finally {
      EngineHub.detachPage(page)
    }
    // With no app open the service plays it, keeping the playlist-scoped id for the car's queue.
    instr.waitForIdleSync()
    onMain {
      it.setMediaItems(listOf(MediaItem.Builder().setMediaId("playlist/p1/track/bg3").build()), 0, 0)
      it.prepare()
      it.play()
    }
    waitFor("the service plays the chosen playlist song itself") { it.isPlaying && it.currentMediaItem?.mediaId == "playlist/p1/track/bg3" }
  }
}
