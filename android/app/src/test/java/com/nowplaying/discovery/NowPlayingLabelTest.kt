package com.nowplaying.discovery

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class NowPlayingLabelTest {
  @Test fun theArtistLineNamesTheApp() {
    assertEquals("Ken Carson \u00b7 Airwave Discovery", NowPlayingLabel.artistLine("Ken Carson"))
  }

  @Test fun aSongWithNoArtistStillSaysWhichApp() {
    assertEquals("Airwave Discovery", NowPlayingLabel.artistLine(""))
    assertEquals("Airwave Discovery", NowPlayingLabel.artistLine(null))
    assertEquals("Airwave Discovery", NowPlayingLabel.artistLine("  "))
  }

  @Test fun itIsNeverNamedTwice() {
    assertEquals("Airwave Discovery", NowPlayingLabel.artistLine("Airwave Discovery"))
  }

  @Test fun theNameIsTheAppsOwnLabel() {
    val strings = listOf("src/main/res/values/strings.xml", "app/src/main/res/values/strings.xml").map(::File).first { it.isFile }
    assertTrue(strings.readText().contains("<string name=\"app_name\">${NowPlayingLabel.APP}</string>"))
  }
}
