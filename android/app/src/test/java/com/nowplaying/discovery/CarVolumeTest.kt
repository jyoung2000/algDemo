package com.nowplaying.discovery

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** VOLUME-BOOST-001: the car's Volume button. */
class CarVolumeTest {
  @Test fun stepsFrom100To200ThenWraps() {
    assertEquals(listOf(1.0, 1.25, 1.5, 1.75, 2.0, 1.0), listOf(0.6, 1.0, 1.25, 1.5, 1.75, 2.0).map(CarVolume::next))
    assertEquals(1.5, CarVolume.next(1.3), 0.0)
    assertEquals(1.0, CarVolume.next(Double.NaN), 0.0)
  }

  @Test fun labelsSayTheLevelAndWhatATapDoes() {
    assertEquals("Volume 150% \u2013 tap for louder", CarVolume.label(1.5))
    assertEquals("Volume 200% \u2013 tap for 100%", CarVolume.label(2.0))
    assertEquals("Volume 80% \u2013 tap for louder", CarVolume.label(0.8))
  }

  @Test fun aWakingPageCannotUndoTheDriversPress() {
    val owed = CarVolume.Owed()
    assertTrue("nothing owed: the page decides", owed.pageSent(0.7))
    owed.carSet(1.5)
    assertFalse("the page's stale 70% is ignored", owed.pageSent(0.7))
    assertTrue("the page confirms 150%", owed.pageSent(1.5))
    assertNull(owed.value)
    assertTrue("after that the phone's slider rules again", owed.pageSent(0.4))
  }
}
