package com.nowplaying.discovery

import android.content.ComponentName
import android.content.Context
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.common.util.concurrent.ListenableFuture
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import kotlin.math.PI
import kotlin.math.sin

/**
 * CAR-SKIP-001. Owner: "The android auto buttons also dont skip songs but only skip ahead and back
 * 15 seconds in the same song instead of going to the next song."
 *
 * A head unit can request one item. Restore its surrounding list to give track skips actual
 * destinations; timeline length alone does not prove which controls the host will draw. Playing
 * from a car list must leave the whole list in the timeline, positioned on the tapped song.
 * Only songs whose complete audio is on
 * the phone can be skipped to, as everywhere else in this app, so the fixtures carry a source.
 */
@RunWith(AndroidJUnit4::class)
class CarSkipTest {
  private val ctx: Context get() = ApplicationProvider.getApplicationContext()
  private val instr get() = InstrumentationRegistry.getInstrumentation()
  private var controller: MediaController? = null

  private fun <T> await(call: () -> ListenableFuture<T>): T {
    val out = AtomicReference<T?>()
    val ex = AtomicReference<Throwable?>()
    val latch = CountDownLatch(1)
    instr.runOnMainSync {
      val f = call()
      f.addListener({
        try { out.set(f.get()) } catch (t: Throwable) { ex.set(t) } finally { latch.countDown() }
      }, Runnable::run)
    }
    if (!latch.await(15, TimeUnit.SECONDS)) throw AssertionError("session call timed out")
    ex.get()?.let { throw it }
    @Suppress("UNCHECKED_CAST")
    return out.get() as T
  }

  /** Read something off the controller on the main thread, as Media3 requires. */
  private fun <T> on(read: (MediaController) -> T): T {
    val out = AtomicReference<T?>()
    instr.runOnMainSync { out.set(read(controller!!)) }
    @Suppress("UNCHECKED_CAST")
    return out.get() as T
  }

  private fun seed() {
    MediaHub.apply(
      JSONObject(
        """
        {"library":{
          "songs":[
            {"id":"q1","title":"First song","artist":"A","durationMs":180000,"ready":true,"source":"https://music.youtube.com/watch?v=skiptestq1"},
            {"id":"q2","title":"Second song","artist":"B","durationMs":181000,"ready":true,"source":"https://music.youtube.com/watch?v=skiptestq2"},
            {"id":"q3","title":"Third song","artist":"C","durationMs":182000,"ready":true,"source":"https://music.youtube.com/watch?v=skiptestq3"}
          ],
          "playlists":[
            {"id":"p1","title":"Chill","songs":[
              {"id":"c1","title":"Chill one","artist":"D","durationMs":170000,"ready":true,"source":"https://music.youtube.com/watch?v=skiptestc1"},
              {"id":"c2","title":"Chill two","artist":"E","durationMs":171000,"ready":true,"source":"https://music.youtube.com/watch?v=skiptestc2"}
            ]}
          ]
        }}
        """.trimIndent(),
      ),
    )
  }

  /** Every fixture link, so each song's complete audio really is on the phone. */
  private val fixtureLinks = listOf(
    "https://music.youtube.com/watch?v=skiptestq1",
    "https://music.youtube.com/watch?v=skiptestq2",
    "https://music.youtube.com/watch?v=skiptestq3",
    "https://music.youtube.com/watch?v=skiptestc1",
    "https://music.youtube.com/watch?v=skiptestc2",
  )

  /**
   * SHUFFLE-STAY-001: a WAV stored exactly as the downloader stores a finished song, keyed by its link.
   * Without this the engine's "not on the phone" path advances the queue itself, so one press covers
   * several songs and a round looks used up while songs were never played — which hides a replay bug.
   */
  private fun storeTone(link: String, hz: Double) {
    val rate = 24000
    val frames = rate * 60
    val pcm = ByteBuffer.allocate(frames * 2).order(ByteOrder.LITTLE_ENDIAN)
    for (f in 0 until frames) pcm.putShort((0.1 * sin(2 * PI * hz / rate * f) * 32767).toInt().toShort())
    val name = MessageDigest.getInstance("SHA-256").digest(link.toByteArray()).joinToString("") { "%02x".format(it) } + ".wav"
    val file = File(File(ctx.filesDir, "audio-cache").apply { mkdirs() }, name)
    RandomAccessFile(file, "rw").use { out ->
      out.setLength(0)
      val h = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
      h.put("RIFF".toByteArray()).putInt(36 + pcm.capacity()).put("WAVEfmt ".toByteArray()).putInt(16)
        .putShort(1).putShort(1).putInt(rate).putInt(rate * 2).putShort(2).putShort(16)
        .put("data".toByteArray()).putInt(pcm.capacity())
      out.write(h.array()); out.write(pcm.array())
    }
    ctx.getSharedPreferences("airwave-private-audio", Context.MODE_PRIVATE).edit().putString(link, name).commit()
  }

  @Before fun setUp() {
    fixtureLinks.forEachIndexed { i, link -> storeTone(link, 300.0 + i * 90) }
    seed()
    val token = SessionToken(ctx, ComponentName(ctx, PlaybackService::class.java))
    controller = await { MediaController.Builder(ctx, token).buildAsync() }
    // The service outlives each test: a shuffle or repeat mode one test set must not carry into the next.
    instr.runOnMainSync {
      controller!!.stop(); controller!!.clearMediaItems()
      controller!!.shuffleModeEnabled = false; controller!!.repeatMode = Player.REPEAT_MODE_OFF
    }
  }

  @After fun tearDown() {
    // The next test class shares this service: leave it with shuffle and repeat off, as it was found.
    instr.runOnMainSync {
      controller?.shuffleModeEnabled = false; controller?.repeatMode = Player.REPEAT_MODE_OFF
      controller?.release()
    }
    controller = null
    // Take the fixture audio back out: this test writes real files into the app's own cache.
    val prefs = ctx.getSharedPreferences("airwave-private-audio", Context.MODE_PRIVATE)
    fixtureLinks.forEach { link ->
      prefs.getString(link, null)?.let { File(File(ctx.filesDir, "audio-cache"), it).delete() }
      prefs.edit().remove(link).commit()
    }
  }

  /** The session answers asynchronously; wait for the id the press should land on. */
  private fun awaitCurrent(mediaId: String): String {
    val deadline = System.currentTimeMillis() + 5000
    var seen: String? = null
    while (System.currentTimeMillis() < deadline) {
      seen = on { it.currentMediaItem?.mediaId }
      if (seen == mediaId) return seen!!
      Thread.sleep(100)
    }
    return seen ?: "none"
  }

  /** Exactly what a head unit sends when the driver taps a song in a list. */
  private fun carTaps(mediaId: String) {
    instr.runOnMainSync {
      controller!!.setMediaItem(MediaItem.Builder().setMediaId(mediaId).build())
      controller!!.prepare()
    }
    instr.waitForIdleSync()
  }

  @Test fun tappingASongInTheQueueLeavesTheRestOfTheQueueToSkipThrough() {
    carTaps("q2")
    assertEquals("q2", on { it.currentMediaItem?.mediaId })
    assertEquals(3, on { it.mediaItemCount })
    assertEquals(1, on { it.currentMediaItemIndex })
    assertTrue("a car needs a next song to skip to", on { it.hasNextMediaItem() })
    assertTrue("a car needs a previous song to skip back to", on { it.hasPreviousMediaItem() })
  }

  @Test fun skipNextMovesToTheNextSongRatherThanSeekingInsideThisOne() {
    carTaps("q1")
    instr.runOnMainSync { controller!!.seekToNextMediaItem() }
    assertEquals("q2", awaitCurrent("q2"))
    instr.runOnMainSync { controller!!.seekToPreviousMediaItem() }
    assertEquals("q1", awaitCurrent("q1"))
  }

  /** SHUFFLE-STAY-001: the current song once the session has held it for a second (after a change, when asked). */
  private fun settled(changedFrom: String? = null): String {
    val until = System.currentTimeMillis() + 8000
    var last = on { it.currentMediaItem!!.mediaId }
    var since = System.currentTimeMillis()
    while (System.currentTimeMillis() < until) {
      Thread.sleep(100)
      val now = on { it.currentMediaItem!!.mediaId }
      if (now != last) { last = now; since = System.currentTimeMillis() }
      if ((changedFrom == null || last != changedFrom) && System.currentTimeMillis() - since >= 1000) return last
    }
    return last
  }

  /** SHUFFLE-STAY-001 on the actual Android Auto transport path: each queue song once, then stop. */
  @Test fun shuffledCarQueueDoesNotReplaySongsAlreadyPlayedInThatQueue() {
    carTaps("q1")
    instr.runOnMainSync { controller!!.pause(); controller!!.shuffleModeEnabled = true }
    // Every fixture song's audio is on the phone (storeTone), so one press moves exactly one song:
    // no song may come back, all three must be reached, and a used-up round must not restart.
    val seen = mutableListOf(settled())
    repeat(2) {
      val before = seen.last()
      instr.runOnMainSync { controller!!.seekToNextMediaItem() }
      val now = settled(changedFrom = before)
      assertTrue("Next did not leave $before; seen so far: $seen", now != before)
      assertTrue("shuffle replayed $now; already heard: $seen", now !in seen)
      seen += now
    }
    assertEquals("each queue song plays once per round", setOf("q1", "q2", "q3"), seen.toSet())
    val exhausted = settled()
    instr.runOnMainSync { controller!!.seekToNextMediaItem() }
    assertEquals("with repeat off, an exhausted shuffled queue does not restart", exhausted, settled())
  }

  @Test fun aPlaylistTapKeepsThatPlaylistAsTheQueue() {
    carTaps("playlist/p1/track/c1")
    assertEquals(2, on { it.mediaItemCount })
    assertEquals(0, on { it.currentMediaItemIndex })
    assertTrue(on { it.hasNextMediaItem() })
    instr.runOnMainSync { controller!!.seekToNextMediaItem() }
    assertEquals("playlist/p1/track/c2", awaitCurrent("playlist/p1/track/c2"))
  }

  @Test fun theSkipCommandsThemselvesAreOffered() {
    carTaps("q1")
    assertTrue(on { it.isCommandAvailable(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM) })
    assertTrue(on { it.isCommandAvailable(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM) })
  }

  /**
   * Holds a car-style tap open so the host can read what the platform session advertises
   * (`adb shell dumpsys media_session`): Android Auto decides between skip buttons and its own
   * 15-second seek from those action flags. Enabled only when the host asks for it.
   */
  @Test fun holdsACarTapOpenForInspection() {
    org.junit.Assume.assumeTrue("inspection run", InstrumentationRegistry.getArguments().getString("holdForDumpsys") == "1")
    carTaps("q1")
    instr.runOnMainSync { controller!!.play() }
    Thread.sleep(15000)
  }

  /** A song the car found by voice is not part of any list; it must still play, alone is fine. */
  @Test fun aSongWithNoListStillPlays() {
    carTaps("q3")
    assertEquals("q3", on { it.currentMediaItem?.mediaId })
    assertTrue(on { it.mediaItemCount >= 1 })
  }
}
