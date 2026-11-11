package com.nowplaying.discovery

import org.junit.Assert.assertEquals
import org.junit.Test

/** NATIVE-ALBUM-001: album replaces the app-name suffix on the system player's artist line. */
class NowPlayingLabelTest {
  @Test fun albumReplacesAppName() {
    assertEquals("Ken Carson \u00b7 A Great Chaos", NowPlayingLabel.artistLine("Ken Carson", "A Great Chaos"))
  }

  @Test fun missingAlbumLeavesOnlyTheArtist() {
    for (album in listOf(null, "", "  ")) {
      assertEquals("Ken Carson", NowPlayingLabel.artistLine("Ken Carson", album))
    }
  }

  @Test fun missingArtistStillShowsTheAlbum() {
    assertEquals("A Great Chaos", NowPlayingLabel.artistLine(null, "A Great Chaos"))
    assertEquals("", NowPlayingLabel.artistLine(null, null))
  }

  @Test fun trimsWhitespaceWithoutRepeatingTheSameLabel() {
    assertEquals("Ken Carson \u00b7 A Great Chaos", NowPlayingLabel.artistLine(" Ken Carson ", " A Great Chaos "))
    assertEquals("Same Name", NowPlayingLabel.artistLine("Same Name", "Same Name"))
  }
}
