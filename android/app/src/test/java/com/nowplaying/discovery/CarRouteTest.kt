package com.nowplaying.discovery

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * CAR-SAVE-HIDDEN-001 (owner, 2026-11-23): "on android auto hearting a song doesnt bring up the playlist sub menu
 * like desired" / "the playlist dont load or save the music". Measured with the head unit: a phone page that is not
 * in front is frozen, and the car's star and playlist choice handed to it were saved late or never.
 */
class CarRouteTest {
  private fun to(page: Boolean = true, answering: Boolean = true, visible: Boolean = true, running: Boolean = true, service: Boolean = false) =
    CarRoute.saveTarget(page, answering, visible, running, service)

  @Test fun thePageInFrontSavesAsBefore() {
    assertEquals(CarRoute.To.PAGE, to())
    assertEquals("even with the service engine ready, the page in front is the one the listener sees", CarRoute.To.PAGE, to(service = true))
  }

  @Test fun aHiddenFrozenPageIsNeverAsked() {
    assertEquals("the service engine saves it", CarRoute.To.SERVICE, to(visible = false, running = false, service = true))
    assertEquals("with no engine to save it, it is kept until one can", CarRoute.To.KEEP, to(visible = false, running = false, service = false))
  }

  @Test fun aHiddenPageThatStillRunsCanSaveWhenTheServiceHasNoEngine() {
    // Older set-up: the phone page owns the audio and is kept running behind the lock screen.
    assertEquals(CarRoute.To.PAGE, to(visible = false, running = true, service = false))
    assertEquals("the service engine is preferred when it is there", CarRoute.To.SERVICE, to(visible = false, running = true, service = true))
  }

  @Test fun withTheAppClosedTheServiceEngineSavesAndWithoutItThePressIsKept() {
    assertEquals(CarRoute.To.SERVICE, to(page = false, answering = false, visible = false, running = false, service = true))
    assertEquals(CarRoute.To.KEEP, to(page = false, answering = false, visible = false, running = false, service = false))
  }

  @Test fun aPageThatHasNotAnsweredYetIsNotAsked() {
    assertEquals(CarRoute.To.KEEP, to(answering = false))
    assertEquals(CarRoute.To.SERVICE, to(answering = false, service = true))
  }
}
