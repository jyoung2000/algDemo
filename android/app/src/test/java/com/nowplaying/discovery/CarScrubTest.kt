package com.nowplaying.discovery

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** CAR-SCRUB-001: a tap skips; a hold scrubs at twice real time and the release does not skip. */
class CarScrubTest {
  private var t = 0L
  private val timers = sortedMapOf<Long, MutableList<Pair<Int, () -> Unit>>>()
  private var nextId = 0
  private val cancelled = mutableSetOf<Int>()
  private var pos = 60_000L
  private val seeks = mutableListOf<Long>()
  private val skips = mutableListOf<Boolean>()
  private val scrub = CarScrub(
    now = { t },
    later = { d, run -> val id = nextId++; timers.getOrPut(t + d) { mutableListOf() }.add(id to run); id },
    cancel = { cancelled.add(it as Int) },
    positionMs = { pos },
    durationMs = { 200_000L },
    seek = { pos = it; seeks.add(it) },
    skip = { skips.add(it) },
  )
  private fun advance(ms: Long) {
    val end = t + ms
    while (true) {
      val at = timers.keys.firstOrNull { it <= end } ?: break
      t = at
      val due = timers.remove(at)!!
      for ((id, run) in due) if (id !in cancelled) run()
    }
    t = end
  }

  @Test fun aTapSkips() {
    assertTrue(scrub.key(CarScrub.Key.NEXT, down = true))
    advance(120)
    scrub.key(CarScrub.Key.NEXT, down = false)
    assertEquals(listOf(true), skips)
    assertTrue(seeks.isEmpty())
    scrub.key(CarScrub.Key.PREVIOUS, down = true); scrub.key(CarScrub.Key.PREVIOUS, down = false)
    assertEquals(listOf(true, false), skips)
  }

  @Test fun holdingNextScrubsForwardAtTwiceRealTimeAndLettingGoDoesNotSkip() {
    scrub.key(CarScrub.Key.NEXT, down = true)
    advance(CarScrub.HOLD_MS)
    assertTrue(scrub.isScrubbing)
    advance(3_000)
    assertEquals(66_000L, pos)
    scrub.key(CarScrub.Key.NEXT, down = false)
    assertFalse(scrub.isScrubbing)
    assertTrue("no skip after a scrub", skips.isEmpty())
    val after = seeks.size
    advance(2_000)
    assertEquals("nothing moves after the release", after, seeks.size)
  }

  @Test fun holdingPreviousScrubsBackAndStopsAtTheStart() {
    pos = 4_000
    scrub.key(CarScrub.Key.PREVIOUS, down = true, repeat = 1)
    assertTrue(scrub.isScrubbing)
    advance(1_000)
    assertEquals(2_000L, pos)
    advance(5_000)
    assertEquals(0L, pos)
    assertFalse(scrub.isScrubbing)
    scrub.key(CarScrub.Key.PREVIOUS, down = false)
    assertTrue(skips.isEmpty())
  }

  @Test fun repeatedDownEventsFromAHeldKeyKeepOneScrub() {
    scrub.key(CarScrub.Key.NEXT, down = true)
    for (i in 1..10) { advance(100); scrub.key(CarScrub.Key.NEXT, down = true, repeat = i) }
    assertTrue(scrub.isScrubbing)
    scrub.key(CarScrub.Key.NEXT, down = false)
    assertTrue(skips.isEmpty())
    // 1 s held: about 2 s of song, never a second scrub stacked on the first.
    assertTrue("moved $pos", pos in 61_000L..62_200L)
  }

  @Test fun fastForwardAndRewindScrubWhileHeld() {
    scrub.key(CarScrub.Key.FAST_FORWARD, down = true)
    advance(1_000)
    assertEquals(62_000L, pos)
    scrub.key(CarScrub.Key.FAST_FORWARD, down = false)
    scrub.key(CarScrub.Key.REWIND, down = true)
    advance(2_000)
    assertEquals(58_000L, pos)
    scrub.key(CarScrub.Key.REWIND, down = false)
    assertTrue(skips.isEmpty())
  }

  @Test fun aForwardScrubStopsJustBeforeTheEnd() {
    pos = 198_000
    scrub.key(CarScrub.Key.FAST_FORWARD, down = true)
    advance(5_000)
    assertEquals(200_000L - CarScrub.END_GAP_MS, pos)
    assertFalse(scrub.isScrubbing)
  }
}
