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

/**
 * CAR-SKIP-001. Owner: "The android auto buttons also dont skip songs but only skip ahead and back
 * 15 seconds in the same song instead of going to the next song."
 *
 * A head unit plays a tapped song by sending that ONE item to the session. If the session keeps a
 * one-item timeline there is no next or previous item, so Android Auto hides the skip buttons and
 * offers its own 15-second seek instead. Playing a song from a car list must therefore leave the
 * whole list in the timeline, positioned on the tapped song. Only songs whose complete audio is on
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

  @Before fun setUp() {
    seed()
    val token = SessionToken(ctx, ComponentName(ctx, PlaybackService::class.java))
    controller = await { MediaController.Builder(ctx, token).buildAsync() }
    instr.runOnMainSync { controller!!.stop(); controller!!.clearMediaItems() }
  }

  @After fun tearDown() { instr.runOnMainSync { controller?.release() }; controller = null }

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
