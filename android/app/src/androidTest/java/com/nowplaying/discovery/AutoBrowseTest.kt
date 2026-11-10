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
            {"id":"p1","title":"Chill","songs":[{"id":"s3","title":"Aria Math","artist":"C418","durationMs":200000,"ready":true}]},
            {"id":"A1","title":"A Great Chaos","album":true,"artist":"Ken Carson","artwork":"https://cdn.example/c.jpg","songs":[
              {"id":"g1","title":"Green Room","artist":"Ken Carson","durationMs":189000,"ready":true},
              {"id":"g2","title":"Jennifer's Body","artist":"Ken Carson","durationMs":160000,"ready":true}
            ]}
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
      val rootResult = await { b.getLibraryRoot(null) }
      val root = rootResult.value!!
      assertTrue("car host can offer search", rootResult.params?.extras?.getBoolean("android.media.browse.SEARCH_SUPPORTED") == true)
      val sections = await { b.getChildren(root.mediaId, 0, 10, null) }.value!!
      assertEquals(listOf("songs", "playlists", "albums"), sections.map { it.mediaId })
      assertEquals(listOf("Now playing queue", "Playlists", "Albums"), sections.map { it.mediaMetadata.title.toString() })
      assertTrue("top-level sections are browsable, not dead-end play buttons", sections.all { it.mediaMetadata.isBrowsable == true && it.mediaMetadata.isPlayable == false })
      assertEquals("Your playback queue", sections[0].mediaMetadata.subtitle?.toString())
      assertEquals("Your saved playlists", sections[1].mediaMetadata.subtitle?.toString())
      instr.runOnMainSync {
        assertTrue("search exposed to controllers", b.isSessionCommandAvailable(androidx.media3.session.SessionCommand.COMMAND_CODE_LIBRARY_SEARCH))
        for (cmd in listOf(androidx.media3.common.Player.COMMAND_PLAY_PAUSE, androidx.media3.common.Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM,
          androidx.media3.common.Player.COMMAND_SEEK_TO_NEXT, androidx.media3.common.Player.COMMAND_SEEK_TO_PREVIOUS,
          androidx.media3.common.Player.COMMAND_GET_TIMELINE)) {
          assertTrue("car player control available: $cmd", b.isCommandAvailable(cmd))
        }
      }

      val songs = await { b.getChildren("songs", 0, 50, null) }.value!!
      assertTrue("song list contains seeded songs", songs.map { it.mediaId }.containsAll(listOf("s1", "s2")))
      assertTrue("songs are playable", songs.first().mediaMetadata.isPlayable == true)
      assertEquals(listOf("s1"), ids(await { b.getChildren("songs", 0, 1, null) }))
      assertEquals(listOf("s2"), ids(await { b.getChildren("songs", 1, 1, null) }))
      assertEquals(emptyList<String>(), ids(await { b.getChildren("songs", 2, 1, null) }))

      val playlists = await { b.getChildren("playlists", 0, 50, null) }.value!!
      assertEquals(listOf("playlist/p1"), playlists.map { it.mediaId })
      assertTrue("playlist folder is browsable", playlists.first().mediaMetadata.isBrowsable == true)

      // ALBUM-SAVE-001: a saved album is under Albums, not Playlists, with its artist and cover, songs in order.
      val albums = await { b.getChildren("albums", 0, 50, null) }.value!!
      assertEquals(listOf("playlist/A1"), albums.map { it.mediaId })
      assertEquals("Ken Carson", albums.single().mediaMetadata.subtitle?.toString())
      assertEquals("https://cdn.example/c.jpg", albums.single().mediaMetadata.artworkUri?.toString())
      assertEquals(androidx.media3.common.MediaMetadata.MEDIA_TYPE_ALBUM, albums.single().mediaMetadata.mediaType)
      assertEquals(listOf("playlist/A1/track/g1", "playlist/A1/track/g2"), ids(await { b.getChildren("playlist/A1", 0, 50, null) }))
      // ALBUM-CAR-001: the car's search shows the saved album the words name, above its songs.
      await { b.search("a great chaos", null) }
      assertEquals("playlist/A1", ids(await { b.getSearchResult("a great chaos", 0, 50, null) }).first())

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
