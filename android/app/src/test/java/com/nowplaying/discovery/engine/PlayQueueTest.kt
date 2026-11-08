package com.nowplaying.discovery.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

class PlayQueueTest {
  private data class S(val key: String, val ready: Boolean = true)
  private fun queue(vararg s: S, seed: Int = 7) = PlayQueue<S>({ it.key }, { it.ready }, Random(seed))
    .apply { set(s.toList(), 0) }

  @Test fun inOrderAndStopsAtTheEndWithRepeatOff() {
    val q = queue(S("a"), S("b"), S("c"))
    assertEquals(1, q.advance(pressed = false))
    assertEquals(2, q.advance(pressed = false))
    assertNull("repeat off stops after the last song", q.advance(pressed = false))
    assertEquals(2, q.index)
  }

  @Test fun skipsSongsWhoseAudioIsNotOnThePhone() {
    val q = queue(S("a"), S("b", ready = false), S("c"))
    assertEquals(2, q.peekAfterEnd())
    assertEquals(2, q.advance(pressed = false))
    assertEquals(0, q.peekPrevious())
  }

  @Test fun repeatAllWrapsAndRepeatOneRepeatsButNextStillMovesOn() {
    val q = queue(S("a"), S("b"))
    q.repeat = PlayQueue.Repeat.ALL
    q.advance(false)
    assertEquals(0, q.advance(false))
    q.repeat = PlayQueue.Repeat.ONE
    assertEquals(0, q.peekAfterEnd())
    assertEquals(0, q.advance(false))
    assertEquals("Next under repeat-one still moves on", 1, q.advance(pressed = true))
  }

  @Test fun nextPressedWrapsEvenWithRepeatOff() {
    val q = queue(S("a"), S("b"))
    q.advance(true)
    assertEquals(0, q.advance(pressed = true))
  }

  @Test fun previousStaysWithinTheRoundAndIsTheExactInverseOfNext() {
    val q = queue(S("a"), S("b"), S("c"))
    assertNull(q.peekPrevious())
    q.advance(true); q.advance(true)
    assertEquals(1, q.previous())
    assertEquals(0, q.previous())
    assertNull(q.previous())
  }

  @Test fun shufflePlaysEverySongOncePerRoundAndNeverTwiceInARowAcrossRounds() {
    for (seed in 0 until 200) {
      val songs = (0 until 6).map { S("s$it") }.toTypedArray()
      val q = queue(*songs, seed = seed)
      q.shuffle = true
      q.repeat = PlayQueue.Repeat.ALL
      val heard = mutableListOf(q.index)
      repeat(6 * 4 - 1) { heard += q.advance(false)!! }
      for (round in heard.chunked(6)) assertEquals("seed $seed round $round", (0 until 6).toSet(), round.toSet())
      for (i in 1 until heard.size) assertNotEquals("seed $seed: ${heard[i]} twice in a row at $i", heard[i - 1], heard[i])
    }
  }

  @Test fun peekAlwaysAgreesWithTheMoveThatFollows() {
    for (seed in 0 until 100) {
      val q = queue(*(0 until 5).map { S("s$it", ready = it != 3) }.toTypedArray(), seed = seed)
      q.shuffle = seed % 2 == 0
      q.repeat = PlayQueue.Repeat.ALL
      repeat(20) {
        val peek = q.peekAfterEnd()
        assertEquals("seed $seed", peek, q.advance(false))
        assertTrue("never the unready song", q.index != 3)
      }
    }
  }

  @Test fun refreshTakesFreshCopiesWithoutReshufflingTheRound() {
    val q = queue(*(0 until 6).map { S("s$it", ready = it != 4) }.toTypedArray(), seed = 3)
    q.shuffle = true
    val before = (0 until 5).map { q.advance(false) }
    val q2 = queue(*(0 until 6).map { S("s$it", ready = it != 4) }.toTypedArray(), seed = 3)
    q2.shuffle = true
    q2.advance(false)
    // s4's file lands: same songs, same places, so the round (and what was already heard) is kept.
    assertTrue(q2.refresh((0 until 6).map { S("s$it") }))
    assertEquals("current kept", before[0], q2.index)
    assertTrue("a different list is refused", !q2.refresh(listOf(S("x"))))
  }

  @Test fun selectingARowMakesItCurrent() {
    val q = queue(S("a"), S("b"), S("c"))
    assertTrue(q.select("c"))
    assertEquals(S("c"), q.current)
    assertTrue(!q.select("missing"))
  }
}
