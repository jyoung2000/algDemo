package com.nowplaying.discovery

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Service startup must only queue work during onCreate, and cancel it on destroy. */
class CatalogStartGateTest {
  @Test fun startIsDeferredUntilTheQueuedCallbackRuns() {
    val gate = CatalogStartGate()
    val queued = ArrayDeque<() -> Unit>()
    var starts = 0
    if (gate.schedule()) queued.addLast { if (gate.runQueued()) starts++ }
    assertEquals("onCreate only queues the engine", 0, starts)
    queued.removeFirst().invoke()
    assertEquals(1, starts)
  }

  @Test fun aDestroyedServiceCannotStartItsQueuedEngine() {
    val gate = CatalogStartGate()
    assertTrue(gate.schedule())
    gate.destroy()
    assertFalse(gate.runQueued())
    assertFalse(gate.schedule())
  }

  @Test fun aQueuedStartAndAStartedEngineCannotStartTwice() {
    val gate = CatalogStartGate()
    assertTrue(gate.schedule())
    assertFalse(gate.schedule())
    assertTrue(gate.runQueued())
    assertFalse(gate.runQueued())
    assertFalse(gate.schedule())
  }

  @Test fun destroyBeforeSchedulingPreventsAllStarts() {
    val gate = CatalogStartGate()
    gate.destroy()
    assertFalse(gate.schedule())
    assertFalse(gate.runQueued())
  }
}
