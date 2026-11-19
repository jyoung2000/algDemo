package com.nowplaying.discovery

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * CAR-RADIO-NOWPLAYING-001 (owner, 2026-11-19): "Ensure android auto also includes the current playing radio station
 * on screen with other song and album information". The car shows title, then "artist · album": for radio the album
 * slot names the station, with the identified song's album beside it.
 */
class RadioNowPlayingTest {
  @Test fun theStationStaysOnScreenBesideTheSongsAlbum() {
    assertEquals("Live on KEXP \u00b7 The Mouse and the Mask", NowPlayingLabel.radioAlbum("KEXP", "The Mouse and the Mask"))
    assertEquals("DANGERDOOM \u00b7 Live on KEXP \u00b7 The Mouse and the Mask",
      NowPlayingLabel.artistLine("DANGERDOOM", NowPlayingLabel.radioAlbum("KEXP", "The Mouse and the Mask")))
  }

  @Test fun noAlbumKnownStillNamesTheStation() {
    for (album in listOf(null, "", "  ", "Live radio", "KEXP")) assertEquals("Live on KEXP", NowPlayingLabel.radioAlbum("KEXP", album))
    assertEquals("Live on radio", NowPlayingLabel.radioAlbum(" ", null))
  }

  @Test fun aProgrammeCreditedToTheStationDoesNotRepeatIt() {
    assertEquals("", NowPlayingLabel.radioArtist("KEXP", "KEXP"))
    assertEquals("", NowPlayingLabel.radioArtist(" kexp ", "KEXP"))
    assertEquals("Danger Mouse", NowPlayingLabel.radioArtist("Danger Mouse", "KEXP"))
    assertEquals("Live on KEXP", NowPlayingLabel.artistLine(NowPlayingLabel.radioArtist("KEXP", "KEXP"), NowPlayingLabel.radioAlbum("KEXP", null)))
  }
}
