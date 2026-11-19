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

  @Test fun finiteRepeatCountsExtraWholePlaysThenReturnsToTheNextSong() {
    val q = queue(S("a"), S("b"))
    q.repeat = PlayQueue.Repeat.TWICE
    assertEquals(0, q.peekAfterEnd())
    assertEquals(PlayQueue.Repeat.ONCE, q.consumeRepeat())
    assertEquals(0, q.peekAfterEnd())
    assertEquals(PlayQueue.Repeat.OFF, q.consumeRepeat())
    assertEquals(1, q.peekAfterEnd())
    q.repeat = PlayQueue.Repeat.ONCE
    assertEquals(PlayQueue.Repeat.OFF, q.consumeRepeat())
    q.repeat = PlayQueue.Repeat.ONE
    assertEquals(PlayQueue.Repeat.ONE, q.consumeRepeat())
  }

  @Test fun aCountedReplayBelongsToItsSongAndIsDroppedWhenTheListenerLeavesIt() {
    val changes = mutableListOf<PlayQueue.Repeat>()
    fun fresh() = queue(S("a"), S("b"), S("c")).also { q -> q.onRepeatChanged = { changes += q.repeat } }
    var q = fresh(); q.repeat = PlayQueue.Repeat.TWICE
    assertEquals(1, q.advance(pressed = true))
    assertEquals("Next leaves the song: no replays carried to the next one", PlayQueue.Repeat.OFF, q.repeat)
    q = fresh(); q.select(1); q.repeat = PlayQueue.Repeat.ONCE
    assertEquals(0, q.previous())
    assertEquals(PlayQueue.Repeat.OFF, q.repeat)
    q = fresh(); q.repeat = PlayQueue.Repeat.ONCE
    assertTrue(q.select(2))
    assertEquals(PlayQueue.Repeat.OFF, q.repeat)
    q = fresh(); q.repeat = PlayQueue.Repeat.TWICE
    assertTrue("choosing the same song again keeps its count", q.select(0))
    assertEquals(PlayQueue.Repeat.TWICE, q.repeat)
    q = fresh(); q.repeat = PlayQueue.Repeat.ONE
    q.advance(pressed = true); q.select(2); q.previous()
    assertEquals("infinity is a mode, not a count: it stays", PlayQueue.Repeat.ONE, q.repeat)
    assertEquals(
      listOf(PlayQueue.Repeat.TWICE, PlayQueue.Repeat.OFF, PlayQueue.Repeat.ONCE, PlayQueue.Repeat.OFF, PlayQueue.Repeat.ONCE, PlayQueue.Repeat.OFF, PlayQueue.Repeat.TWICE, PlayQueue.Repeat.ONE),
      changes,
    )
  }

  @Test fun everyRepeatChangeIsAnnouncedOnceIncludingTheCountdown() {
    val q = queue(S("a"), S("b"))
    var n = 0
    q.onRepeatChanged = { n++ }
    q.repeat = PlayQueue.Repeat.TWICE; q.repeat = PlayQueue.Repeat.TWICE
    assertEquals(1, n)
    q.consumeRepeat(); q.consumeRepeat(); q.consumeRepeat()
    assertEquals("twice, once, off; a third end changes nothing", 3, n)
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

  @Test fun libraryPushesDoNotForgetSongsAlreadyHeard() {
    for (seed in 0 until 40) {
      val q = queue(*(0 until 6).map { S("s$it") }.toTypedArray(), seed = seed)
      q.shuffle = true
      q.repeat = PlayQueue.Repeat.ALL
      val heard = mutableSetOf(q.current!!.key)
      repeat(5) { step ->
        // EnginePlayer.libraryChanged re-sends fresh entries and the current index on each push.
        val copies = q.items.map { it.copy() }.let { if (step % 2 == 0) it.reversed() else it }
        q.set(copies, copies.indexOfFirst { it.key == q.current!!.key })
        val peek = q.peekAfterEnd()!!
        repeat(4) { assertEquals(peek, q.peekAfterEnd()) }
        assertEquals(peek, q.advance(false))
        assertTrue("seed $seed repeated ${q.current!!.key} before the list finished: $heard", heard.add(q.current!!.key))
      }
      assertEquals(6, heard.size)
    }
  }

  @Test fun selectingThePeekAsNativeEndAndBlendDoKeepsTheRound() {
    for (seed in 0 until 40) {
      val q = queue(*(0 until 5).map { S("s$it") }.toTypedArray(), seed = seed)
      q.shuffle = true
      q.repeat = PlayQueue.Repeat.ALL
      repeat(4) {
        val heard = mutableSetOf(q.current!!.key)
        repeat(4) {
          val next = q.items[q.peekAfterEnd()!!].key
          assertTrue(q.select(next))
          assertTrue("native select repeated $next: $heard", heard.add(next))
        }
        val last = q.current!!.key
        val next = q.items[q.peekAfterEnd()!!].key
        assertNotEquals(last, next)
        assertTrue(q.select(next))
      }
    }
  }

  @Test fun manualReplayDoesNotResetAutomaticProgress() {
    for (seed in 0 until 40) {
      val q = queue(S("a"), S("b"), S("c"), S("d"), seed = seed)
      q.shuffle = true
      q.repeat = PlayQueue.Repeat.ALL
      val heard = mutableSetOf(q.current!!.key)
      q.advance(false)
      heard += q.current!!.key
      assertTrue(q.select("a")) // An intentional replay is allowed, not a new shuffle round.
      repeat(2) {
        q.advance(false)
        assertTrue("seed $seed automatic replay before unplayed songs: $heard", heard.add(q.current!!.key))
      }
    }
  }

  @Test fun metadataAndReorderKeepTheSamePreparedSongByKey() {
    val q = queue(S("a"), S("b"), S("c"), S("d"))
    q.shuffle = true
    q.repeat = PlayQueue.Repeat.ALL
    repeat(12) {
      val prepared = q.items[q.peekAfterEnd()!!].key
      val current = q.current!!.key
      val reordered = q.items.reversed().map { it.copy() }
      q.set(reordered, reordered.indexOfFirst { it.key == current })
      assertEquals(current, q.current!!.key)
      assertEquals(prepared, q.items[q.peekAfterEnd()!!].key)
      assertTrue(q.select(prepared))
    }
  }

  @Test fun pageLoadsUsingSetAlsoKeepHeardHistory() {
    for (seed in 0 until 40) {
      val q = queue(S("a"), S("b"), S("c"), S("d"), seed = seed)
      q.shuffle = true
      q.repeat = PlayQueue.Repeat.ALL
      val heard = mutableSetOf(q.current!!.key)
      repeat(15) {
        if (heard.size == 4) heard.clear()
        val peek = q.peekAfterEnd()!!
        q.set(q.items.map { it.copy() }, peek)
        assertTrue("page load repeated before unplayed: $heard", heard.add(q.current!!.key))
      }
    }
  }

  @Test fun shuffleKeepsRepeatOneAndNextPressedSemantics() {
    val q = queue(S("a"), S("missing", false), S("b"))
    q.shuffle = true
    q.repeat = PlayQueue.Repeat.ONE
    assertEquals(0, q.peekAfterEnd())
    assertEquals(0, q.advance(false))
    assertEquals(2, q.peekNextPressed())
    assertEquals(2, q.advance(true))
    assertEquals(2, q.advance(false))
    q.repeat = PlayQueue.Repeat.OFF
    assertNull(q.peekAfterEnd())
    assertNull(q.advance(false))
    assertEquals(0, q.advance(true))
  }

  @Test fun noReadySongsStopAndASingleReadySongCanRepeat() {
    val q = queue(S("a", false), S("b", false))
    q.shuffle = true
    q.repeat = PlayQueue.Repeat.ALL
    assertNull(q.peekAfterEnd())
    assertNull(q.advance(true))
    assertTrue(q.refresh(listOf(S("a", false), S("b"))))
    repeat(4) {
      assertEquals(1, q.peekAfterEnd())
      assertEquals(1, q.advance(false))
    }
    q.set(emptyList(), 0)
    assertNull(q.current)
    assertNull(q.advance(true))
  }

  @Test fun editsAndNewlyReadySongsGetTheirTurnWithoutResurrectingHeardSongs() {
    for (seed in 0 until 40) {
      val q = queue(S("a"), S("b"), S("c"), S("waiting", false), seed = seed)
      q.shuffle = true
      q.repeat = PlayQueue.Repeat.ALL
      val heard = mutableSetOf(q.current!!.key)
      q.advance(false)
      heard += q.current!!.key
      val remaining = q.items.first { it.ready && it.key !in heard }.key
      val changed = listOf(S("waiting"), S("new"), S(remaining), q.current!!.copy())
      q.set(changed, changed.indexOfFirst { it.key == q.current!!.key })
      // Re-add a removed heard song; it must still wait for the next round.
      q.set(q.items + S("a"), q.index)
      val turns = mutableSetOf<String>()
      repeat(3) {
        q.advance(false)
        assertTrue("heard track returned early: ${q.current}", q.current!!.key !in heard)
        assertTrue(turns.add(q.current!!.key))
      }
      assertEquals(setOf("waiting", "new", remaining), turns)
    }
  }

  @Test fun refreshMakesSkippedUnreadySongsEligibleBeforeAnotherRound() {
    val q = queue(S("a"), S("b", false), S("c"))
    q.shuffle = true
    q.repeat = PlayQueue.Repeat.ALL
    q.advance(false)
    assertEquals("c", q.current!!.key)
    assertTrue(q.refresh(q.items.map { it.copy(ready = true) }))
    assertEquals("b", q.items[q.peekAfterEnd()!!].key)
    assertEquals("b", q.items[q.advance(false)!!].key)
  }

  @Test fun shuffleRoundBoundariesAvoidImmediateRepeatWithUnreadyEntries() {
    for (seed in 0 until 100) {
      val q = queue(S("a"), S("missing", false), S("b"), S("also-missing", false), seed = seed)
      q.shuffle = true
      q.repeat = PlayQueue.Repeat.ALL
      repeat(12) {
        val previous = q.current!!.key
        val peek = q.peekAfterEnd()
        assertEquals(peek, q.advance(false))
        assertTrue(q.current!!.ready)
        assertNotEquals("seed $seed", previous, q.current!!.key)
      }
    }
  }

  @Test fun togglingShuffleDoesNotForgetTheCurrentRound() {
    for (seed in 0 until 40) {
      val q = queue(S("a"), S("b"), S("c"), S("d"), seed = seed)
      q.shuffle = true
      val heard = mutableSetOf(q.current!!.key)
      q.advance(true)
      heard += q.current!!.key
      q.shuffle = false
      q.shuffle = true
      repeat(2) {
        q.advance(true)
        assertTrue("shuffle toggle repeated before unplayed: $heard", heard.add(q.current!!.key))
      }
    }
  }

  @Test fun enablingShuffleKeepsSequentiallyPlayedSongsAccountedFor() {
    for (seed in 0 until 40) {
      val q = queue(S("a"), S("b"), S("c"), S("d"), seed = seed)
      q.advance(false)
      assertEquals("b", q.current!!.key)
      q.set(q.items.map { it.copy() }, q.index)
      q.shuffle = true
      val heard = mutableSetOf("a", "b")
      repeat(2) {
        q.advance(true)
        assertTrue("enabling shuffle forgot sequential play: $heard", heard.add(q.current!!.key))
      }
    }
  }

  @Test fun aDifferentListStartsItsOwnRound() {
    for (seed in 0 until 40) {
      val q = queue(S("a"), S("b"), S("c"), S("d"), seed = seed)
      q.shuffle = true
      repeat(3) { q.advance(true) }
      // Another playlist sharing one song: that song is not "already played" in the new list.
      val other = listOf(S("x"), S("y"), S("z"), S(q.current!!.key))
      q.set(other, 0)
      val turns = mutableSetOf(q.current!!.key)
      repeat(3) { q.advance(false); assertTrue("new list skipped or repeated: $turns", turns.add(q.current!!.key)) }
      assertEquals(4, turns.size)
    }
  }

  @Test fun selectingARowMakesItCurrent() {
    val q = queue(S("a"), S("b"), S("c"))
    assertTrue(q.select("c"))
    assertEquals(S("c"), q.current)
    assertTrue(!q.select("missing"))
  }

  /** CAR-MOOD-001: the listening mood re-arranges what is still to come in a shuffle round, nothing else. */
  @Test fun theMoodReArrangesOnlyTheRestOfAShuffleRound() {
    val q = queue(S("a"), S("b"), S("c"), S("d"), S("e"))
    q.shuffle = true
    val ahead = q.roundAhead()
    assertEquals(4, ahead.size)
    assertTrue("the playing song is not ahead", q.current!!.key !in ahead)
    val wanted = ahead.reversed()
    assertTrue(q.arrangeRound(wanted))
    assertEquals(wanted, q.roundAhead())
    val first = q.advance(pressed = false)!!
    assertEquals(wanted[0], q.items[first].key)
    assertEquals("a heard song never comes back", wanted.drop(1), q.roundAhead())
    assertTrue(!q.arrangeRound(listOf(wanted[0])))
  }

  @Test fun theMoodLeavesAnInOrderQueueToTheList() {
    val q = queue(S("a"), S("b"), S("c"))
    assertEquals(emptyList<String>(), q.roundAhead())
    assertTrue(!q.arrangeRound(listOf("c", "b")))
  }
}
