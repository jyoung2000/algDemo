package com.nowplaying.discovery

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeClockTest {
  private class FakeScheduler : NativeClock.Scheduler {
    val posted = mutableListOf<Pair<Runnable, Long>>()
    override fun post(job: Runnable, delayMs: Long) { posted += job to delayMs }
    override fun remove(job: Runnable) { posted.removeAll { it.first === job } }
    fun runAll() = posted.toList().also { posted.clear() }.forEach { it.first.run() }
  }

  @Test fun firesOnceWithExactDelay() {
    val s = FakeScheduler()
    val clock = NativeClock(s)
    val fired = mutableListOf<Int>()
    assertTrue(clock.schedule(7, 110, fired::add))
    assertEquals(110L, s.posted.single().second)
    assertTrue(fired.isEmpty())
    s.runAll()
    assertEquals(listOf(7), fired)
    assertEquals(0, clock.pending)
  }

  @Test fun refusesOutOfRangeDuplicateAndExcess() {
    val s = FakeScheduler()
    val clock = NativeClock(s, maxPending = 2)
    assertFalse(clock.schedule(1, -1) {})
    assertFalse(clock.schedule(1, NativeClock.MAX_DELAY_MS + 1) {})
    assertFalse(clock.schedule(0, 10) {})
    assertTrue(clock.schedule(1, 10) {})
    assertFalse(clock.schedule(1, 10) {})
    assertTrue(clock.schedule(2, 10) {})
    assertFalse(clock.schedule(3, 10) {})
    assertEquals(2, s.posted.size)
  }

  @Test fun cancelRemovesTheJob() {
    val s = FakeScheduler()
    val clock = NativeClock(s)
    var fired = false
    clock.schedule(1, 10) { fired = true }
    clock.cancel(1)
    assertTrue(s.posted.isEmpty())
    assertEquals(0, clock.pending)
    assertFalse(fired)
  }

  @Test fun disposeDropsEveryJobAndRefusesNewOnes() {
    val s = FakeScheduler()
    val clock = NativeClock(s)
    var fired = 0
    clock.schedule(1, 10) { fired++ }
    val stale = s.posted.single().first
    clock.dispose()
    assertTrue(s.posted.isEmpty())
    stale.run()
    assertEquals(0, fired)
    assertFalse(clock.schedule(2, 10) { fired++ })
  }
}
