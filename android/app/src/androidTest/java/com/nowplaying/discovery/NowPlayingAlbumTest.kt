package com.nowplaying.discovery

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/** Exercises the actual Media3 metadata builder used by EnginePlayer and the system session. */
@RunWith(AndroidJUnit4::class)
class NowPlayingAlbumTest {
  private fun song(album: String?) = MediaHub.Song(
    id = "green-room", title = "Green Room", artist = "Ken Carson", album = album,
    artwork = null, durationMs = 189000, ready = false,
  )

  @Test fun systemPlayerShowsAlbumInsteadOfAppSuffix() {
    val metadata = WebPlayer.metadataOf(song("A Great Chaos"), playable = true, nowPlaying = true)
    assertEquals("Green Room", metadata.title.toString())
    assertEquals("Ken Carson \u00b7 A Great Chaos", metadata.artist.toString())
    assertEquals("A Great Chaos", metadata.albumTitle.toString())
  }

  @Test fun browseArtistIsNotRewritten() {
    val metadata = WebPlayer.metadataOf(song("A Great Chaos"), playable = true)
    assertEquals("Ken Carson", metadata.artist.toString())
    assertEquals("A Great Chaos", metadata.albumTitle.toString())
  }

  @Test fun unknownAlbumDoesNotSubstituteAppName() {
    val metadata = WebPlayer.metadataOf(song(null), playable = true, nowPlaying = true)
    assertEquals("Ken Carson", metadata.artist.toString())
    assertEquals(null, metadata.albumTitle)
  }
}
