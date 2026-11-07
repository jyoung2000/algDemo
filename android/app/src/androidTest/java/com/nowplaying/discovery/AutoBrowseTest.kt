package com.nowplaying.discovery

import androidx.media3.common.MediaItem
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaBrowser
import androidx.media3.session.SessionToken
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import android.content.ComponentName
import android.content.Context
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.ListenableFuture
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * Proves the Android Auto browse tree (MEDIA-NATIVE-001): a real [MediaBrowser] connects to
 * [PlaybackService] and sees the song list, the playlists and search results — the exact surface a
 * head unit browses. The library is seeded into [MediaHub] in the app process, as the WebView does
 * at runtime. Every MediaBrowser call is made on the application main thread, as Media3 requires.
 */
@RunWith(AndroidJUnit4::class)
class AutoBrowseTest {
  private val ctx: Context get() = ApplicationProvider.getApplicationContext()
  private val instr get() = InstrumentationRegistry.getInstrumentation()

  /** Make a MediaBrowser call on the main thread and block the test thread for its result. */
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
    if (!latch.await(15, TimeUnit.SECONDS)) throw AssertionError("MediaBrowser call timed out")
    ex.get()?.let { throw it }
    @Suppress("UNCHECKED_CAST")
    return out.get() as T
  }

  private fun seed() {
    MediaHub.apply(
      JSONObject(
        """
        {"library":{
          "songs":[
            {"id":"s1","title":"Plant Island","artist":"My Singing Monsters","durationMs":219000,"ready":true},
            {"id":"s2","title":"Wallpaper","artist":"Kevin MacLeod","durationMs":180000,"ready":true}
          ],
          "playlists":[
            {"id":"p1","title":"Chill","songs":[{"id":"s3","title":"Aria Math","artist":"C418","durationMs":200000,"ready":true}]}
          ]
        }}
        """.trimIndent(),
      ),
    )
  }

  private fun ids(result: LibraryResult<ImmutableList<MediaItem>>) = result.value!!.map { it.mediaId }

  @Test
  fun nowPlayingOutsideQueueStillHasMatchingSessionMetadata() {
    MediaHub.apply(JSONObject("""{"state":{"hasTrack":true,"playing":true,"mediaId":"s3","title":"Playlist Only","artist":"Owner","durationMs":240000,"queueIndex":0,"queue":[{"id":"s1","title":"Other","artist":"Other Artist","durationMs":180000,"ready":true}]}}"""))
    val actual = AtomicReference<MediaItem?>()
    instr.runOnMainSync {
      val player = WebPlayer(android.os.Looper.getMainLooper())
      try { actual.set(player.currentMediaItem) } finally { player.release() }
    }
    assertEquals("s3", actual.get()?.mediaId)
    assertEquals("Playlist Only", actual.get()?.mediaMetadata?.title?.toString())
  }

  @Test
  fun playlistSelectionReachesWebWithItsListContext() {
    seed()
    val command = AtomicReference<JSONObject?>()
    val delivered = CountDownLatch(1)
    val sink: (JSONObject) -> Unit = { command.set(it); delivered.countDown() }
    MediaHub.setCommandSink(sink)
    val browser = AtomicReference<MediaBrowser>()
    val connected = CountDownLatch(1)
    instr.runOnMainSync {
      val token = SessionToken(ctx, ComponentName(ctx, PlaybackService::class.java))
      val f = MediaBrowser.Builder(ctx, token).buildAsync()
      f.addListener({ browser.set(f.get()); connected.countDown() }, Runnable::run)
    }
    try {
      assertTrue("browser connected", connected.await(15, TimeUnit.SECONDS))
      instr.runOnMainSync {
        browser.get().setMediaItems(listOf(MediaItem.Builder().setMediaId("playlist/p1/track/s3").build()), 0, 0)
      }
      assertTrue("MediaBrowser did not deliver selection to player", delivered.await(5, TimeUnit.SECONDS))
      assertEquals("playId", command.get()?.optString("type"))
      assertEquals("playlist/p1/track/s3", command.get()?.optString("id"))
    } finally {
      MediaHub.clearCommandSink(sink)
      browser.get()?.let { instr.runOnMainSync { it.release() } }
    }
  }

  @Test
  fun browseTreeExposesSongListPlaylistsAndSearch() {
    seed()
    val browser = AtomicReference<MediaBrowser>()
    val built = CountDownLatch(1)
    instr.runOnMainSync {
      val token = SessionToken(ctx, ComponentName(ctx, PlaybackService::class.java))
      val f = MediaBrowser.Builder(ctx, token).buildAsync()
      f.addListener({ browser.set(f.get()); built.countDown() }, Runnable::run)
    }
    assertTrue("browser connected", built.await(15, TimeUnit.SECONDS))
    val b = browser.get()
    try {
      val root = await { b.getLibraryRoot(null) }.value!!
      assertEquals(listOf("songs", "playlists"), ids(await { b.getChildren(root.mediaId, 0, 10, null) }))

      val songs = await { b.getChildren("songs", 0, 50, null) }.value!!
      assertTrue("song list contains seeded songs", songs.map { it.mediaId }.containsAll(listOf("s1", "s2")))
      assertTrue("songs are playable", songs.first().mediaMetadata.isPlayable == true)
      assertEquals(listOf("s1"), ids(await { b.getChildren("songs", 0, 1, null) }))
      assertEquals(listOf("s2"), ids(await { b.getChildren("songs", 1, 1, null) }))
      assertEquals(emptyList<String>(), ids(await { b.getChildren("songs", 2, 1, null) }))

      val playlists = await { b.getChildren("playlists", 0, 50, null) }.value!!
      assertEquals(listOf("playlist/p1"), playlists.map { it.mediaId })
      assertTrue("playlist folder is browsable", playlists.first().mediaMetadata.isBrowsable == true)

      val plSongs = await { b.getChildren("playlist/p1", 0, 50, null) }.value!!
      assertEquals(listOf("playlist/p1/track/s3"), plSongs.map { it.mediaId })
      assertEquals("playlist/p1/track/s3", await { b.getItem("playlist/p1/track/s3") }.value?.mediaId)

      await { b.search("plant", null) }
      val results = await { b.getSearchResult("plant", 0, 50, null) }.value!!
      assertTrue("search finds Plant Island", results.map { it.mediaId }.contains("s1"))
      await { b.search("a", null) }
      assertEquals(listOf("s1"), ids(await { b.getSearchResult("a", 0, 1, null) }))
      assertEquals(listOf("s2"), ids(await { b.getSearchResult("a", 1, 1, null) }))
    } finally {
      instr.runOnMainSync { b.release() }
    }
  }
}
