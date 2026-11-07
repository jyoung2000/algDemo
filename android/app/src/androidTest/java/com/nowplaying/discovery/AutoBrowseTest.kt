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

      val playlists = await { b.getChildren("playlists", 0, 50, null) }.value!!
      assertEquals(listOf("playlist/p1"), playlists.map { it.mediaId })
      assertTrue("playlist folder is browsable", playlists.first().mediaMetadata.isBrowsable == true)

      val plSongs = await { b.getChildren("playlist/p1", 0, 50, null) }.value!!
      assertTrue("playlist exposes its tracks", plSongs.map { it.mediaId }.contains("s3"))

      await { b.search("plant", null) }
      val results = await { b.getSearchResult("plant", 0, 50, null) }.value!!
      assertTrue("search finds Plant Island", results.map { it.mediaId }.contains("s1"))
    } finally {
      instr.runOnMainSync { b.release() }
    }
  }
}
