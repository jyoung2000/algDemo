package com.nowplaying.discovery

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * DL-COLD-READY-001: DHU 2026-11-15, a car tap with the phone app never opened. Only MainActivity
 * warmed yt-dlp up, so every service-started download failed at once ("still unpacking") and the
 * car song waited forever. A job now waits, bounded, for setup that is under way.
 */
class SetupWaitTest {
  private class Clock { var now = 0L }

  private fun wait(states: List<SetupWait.State>, timeoutMs: Long = 60_000, step: Long = 500): Pair<SetupWait.State, Long> {
    val clock = Clock()
    var i = 0
    val got = SetupWait.await(
      state = { states[minOf(i, states.size - 1)] },
      now = { clock.now },
      sleep = { ms -> clock.now += ms; i++ },
      timeoutMs = timeoutMs,
      stepMs = step,
    )
    return got to clock.now
  }

  @Test fun readyAtOnceDoesNotWait() {
    assertEquals(SetupWait.State.READY to 0L, wait(listOf(SetupWait.State.READY)))
  }

  @Test fun setupUnderWayIsWaitedForUntilReady() {
    val (s, waited) = wait(listOf(SetupWait.State.STARTING, SetupWait.State.STARTING, SetupWait.State.READY))
    assertEquals(SetupWait.State.READY, s)
    assertEquals(1_000L, waited)
  }

  @Test fun aSetupFailureEndsTheWaitWithTheFailure() {
    assertEquals(SetupWait.State.FAILED, wait(listOf(SetupWait.State.STARTING, SetupWait.State.FAILED)).first)
  }

  @Test fun neverReadyGivesUpAtTheBound() {
    val (s, waited) = wait(listOf(SetupWait.State.STARTING), timeoutMs = 3_000)
    assertEquals(SetupWait.State.STARTING, s)
    assertEquals(3_000L, waited)
  }
}
