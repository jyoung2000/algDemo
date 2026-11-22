package com.nowplaying.discovery

import org.junit.Assert.assertEquals
import org.junit.Test

class CarArtistsTest {
  @Test fun commasAndFeatSeparateArtistsButAnAmpersandStaysInAName() {
    assertEquals(listOf("Lil Tecca", "Ken Carson"), CarArtists.names("Lil Tecca, Ken Carson"))
    assertEquals(listOf("NLE Choppa", "Dee Play4Keeps"), CarArtists.names("NLE Choppa feat. Dee Play4Keeps"))
    assertEquals(listOf("Simon & Garfunkel"), CarArtists.names("Simon & Garfunkel"))
    assertEquals(emptyList<String>(), CarArtists.names("  "))
  }
  @Test fun theCarSaysWhoWasAdded() {
    assertEquals("Added OsamaSon to your artists", CarArtists.told(listOf("OsamaSon")))
    assertEquals("Added Lil Tecca and Ken Carson to your artists", CarArtists.told(listOf("Lil Tecca", "Ken Carson")))
    assertEquals("Added A, B and C to your artists", CarArtists.told(listOf("A", "B", "C")))
  }
}
