package com.nowplaying.discovery.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * REPEAT-COUNT-001: the page sends its repeat setting with every list push. A push made before
 * the page heard that the service counted a replay down (or that the car's button changed the
 * mode) must not put the old count back, or "1 extra play" would never run out.
 */
class RepeatSyncTest {
  @Test fun thePageDecidesUntilTheServiceChangesTheModeItself() {
    val s = RepeatSync()
    assertEquals(0, s.fromPage(0))
    assertEquals(4, s.fromPage(4))
    assertEquals(4, s.fromPage(4))
    assertNull(s.owed)
  }

  @Test fun aStalePagePushCannotPutACountedReplayBack() {
    val s = RepeatSync()
    assertEquals(4, s.fromPage(4)) // two extra plays, chosen on the phone
    s.serviceSet(3)                // the first extra play began
    assertNull("the page has not heard yet", s.fromPage(4))
    assertNull(s.fromPage(4))
    assertEquals(3, s.owed)
    assertNull("the page caught up: nothing to apply", s.fromPage(3))
    assertNull(s.owed)
    s.serviceSet(0)                // the second extra play began
    assertNull(s.fromPage(3))
    assertNull(s.fromPage(0))
    assertEquals("the page decides again", 1, s.fromPage(1))
  }

  @Test fun aNewChoiceOnThePhoneWinsOverAChangeItHasNotEchoed() {
    val s = RepeatSync()
    assertEquals(0, s.fromPage(0))
    s.serviceSet(3)                // the car's button, while the page slept
    assertNull(s.fromPage(0))
    assertEquals("the listener pressed the phone's button", 1, s.fromPage(1))
    assertNull(s.owed)
  }

  @Test fun aPageThatJustOpenedHasNotChosenAnythingYet() {
    // The driver chose "1 extra play" in the car while the phone app was closed. The app opens
    // and pushes the setting it saved last time; that is not a choice made now.
    val s = RepeatSync()
    s.serviceSet(3)
    assertNull(s.fromPage(0))
    assertEquals(3, s.owed)
    assertNull("still the same stale value", s.fromPage(0))
    assertNull("told, the page follows", s.fromPage(3))
    assertNull(s.owed)
    assertEquals("and from then on its button decides", 0, s.fromPage(0))
  }

  @Test fun withNothingOwedTheFirstPushDecides() {
    assertEquals(4, RepeatSync().fromPage(4))
  }
}
