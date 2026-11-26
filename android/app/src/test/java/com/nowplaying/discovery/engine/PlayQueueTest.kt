package com.nowplaying.discovery.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
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
    assertNull("shuffle never starts a new round with repeat off", q.advance(true))
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

  // SHUFFLE-ONCE-001 (owner, 2026-11-24): "shuffle should only play a song once before finding a new song". A song the
  // page marks as heard before (the now playing queue's songs heard in any session) is not shuffled to again, and the
  // shuffle never starts another round over heard songs: it stops and waits for a new one.
  private data class H(val key: String, val heard: Boolean = false)
  private fun onceQueue(vararg s: H, seed: Int = 7) = PlayQueue<H>({ it.key }, { true }, Random(seed), heardBefore = { it.heard })
    .apply { shuffle = true; playsOnce = true; set(s.toList(), 0) }

  @Test fun shuffleSkipsSongsHeardBefore() {
    val q = onceQueue(H("a"), H("b", heard = true), H("c"), H("d", heard = true))
    val played = mutableListOf(q.items[q.index].key)
    while (true) { val i = q.advance(pressed = false) ?: break; played += q.items[i].key }
    assertEquals(listOf("a", "c"), played.sorted())
  }

  @Test fun shuffleNeverStartsAnotherRoundOverHeardSongsEvenOnNext() {
    val q = onceQueue(H("a"), H("b"))
    assertEquals(1, q.advance(pressed = false))
    assertNull("Next does not wrap round to a song just heard", q.advance(pressed = true))
    assertNull(q.peekNextPressed())
    assertNull(q.peekAfterEnd())
  }

  @Test fun aNewSongArrivingAfterTheEndIsTheNextOne() {
    val q = onceQueue(H("a"), H("b"))
    q.advance(pressed = false)
    assertNull(q.advance(pressed = true))
    q.set(listOf(H("a"), H("b"), H("e")), 1)
    assertEquals(2, q.peekAfterEnd())
    assertEquals(2, q.advance(pressed = false))
  }

  @Test fun shuffleNeverReplaysAnyQueueSongBeforeAllSongsHavePlayed() {
    for (seed in 0 until 200) {
      val q = PlayQueue<H>({ it.key }, { true }, Random(seed)).apply { shuffle = true; set(listOf(H("a"), H("b"), H("c")), 0) }
      val played = linkedSetOf(q.current!!.key)
      repeat(2) {
        val next = q.advance(pressed = true) ?: error("unheard song must remain")
        assertTrue("seed $seed repeated ${q.items[next].key} after $played", played.add(q.items[next].key))
      }
      assertEquals(setOf("a", "b", "c"), played)
      assertNull("shuffle with repeat off waits when this round is exhausted", q.advance(pressed = true))
    }
  }

  // CAR-X-001 (owner, 2026-11-24): "ensure the X button works on android auto". The car's X takes the song playing out
  // of the queue and moves on to another song, whatever its place in the list; with nothing left to move to it says so.
  private fun plain(vararg k: String, shuffle: Boolean = false, at: Int = 0) =
    PlayQueue<H>({ it.key }, { true }, Random(3)).apply { this.shuffle = shuffle; set(k.map { H(it) }, at) }

  @Test fun theXInTheMiddlePlaysTheOneAfterAndTheSongIsGone() {
    val q = plain("a", "b", "c", at = 1)
    val i = q.leave("b")
    assertEquals("c", i?.let { q.items[it].key })
    assertEquals(listOf("a", "c"), q.items.map { it.key })
    assertEquals("c", q.current?.key)
  }

  @Test fun theXOnTheLastSongGoesBackToTheFirst() {
    val q = plain("a", "b", "c", at = 2)
    assertEquals("a", q.leave("c")?.let { q.items[it].key })
    assertEquals(listOf("a", "b"), q.items.map { it.key })
  }

  @Test fun theXUnderShuffleMovesOnWhereverTheSongSits() {
    for (start in 0..3) {
      val q = plain("a", "b", "c", "d", shuffle = true, at = start)
      val gone = q.current!!.key
      val i = q.leave(gone) ?: throw AssertionError("nothing after $gone")
      assertTrue(q.items[i].key != gone)
      assertTrue(q.items.none { it.key == gone })
    }
  }

  @Test fun theXSkipsSongsTheListenerAlsoTurnedDown() {
    val q = plain("a", "b", "c", at = 0)
    assertEquals("c", q.leave("a", avoid = { it.key == "b" })?.let { q.items[it].key })
  }

  /**
   * CAR-X-001 vs AA-SHUFFLE-ONCE-001: X removes the song playing, so it must always be possible to leave it.
   * A round that has used up its songs may not trap the car on a song the listener just turned down - that is
   * what a page "heard before" mark is for, and this is not one.
   */
  @Test fun theXAlwaysLeavesADislikedSongEvenWhenTheRoundIsUsedUp() {
    for (start in 0..3) {
      val q = plain("a", "b", "c", "d", shuffle = true, at = start)
      while (q.advance(pressed = true) != null) Unit // play the round out
      val gone = q.current!!.key
      val i = q.leave(gone) ?: throw AssertionError("start $start: X could not leave $gone")
      assertTrue("start $start: the disliked song must go", q.items.none { it.key == gone })
      assertTrue("start $start: something else must play", q.items[i].key != gone)
    }
  }

  @Test fun theXWithOnlyHeardSongsLeftUnderOnceHasNothingToPlay() {
    val q = onceQueue(H("a"), H("b", heard = true), H("c", heard = true))
    assertNull(q.leave("a"))
    assertEquals("the song stays until something can follow it", "a", q.current?.key)
  }

  @Test fun theXIsOnlyForTheSongPlaying() {
    val q = plain("a", "b", at = 0)
    assertNull(q.leave("b"))
    assertEquals(listOf("a", "b"), q.items.map { it.key })
  }

  // ARTIST-RUN-001 (owner, 2026-11-24): "On shuffle ensure the same artist cant be played more than 4 times in a row on
  // the discover tab if the discover / now playing queue has multiple artist". The car playing on alone keeps it too.
  private data class A(val key: String, val artist: String)
  private fun runQueue(vararg s: A, playsOnce: Boolean = true) =
    PlayQueue<A>({ it.key }, { true }, Random(11), artistOf = { it.artist }).apply { shuffle = true; this.playsOnce = playsOnce; set(s.toList(), 0) }

  @Test fun neverMoreThanFourInARowByOneArtistWhileAnotherIsLeft() {
    val songs = (1..9).map { A("s$it", if (it % 3 == 0) "Slayr feat. Someone" else "SLAYR") } + listOf(A("k1", "Ken Carson"), A("k2", "Ken Carson"))
    for (seed in 0 until 25) {
      val q = PlayQueue<A>({ it.key }, { true }, Random(seed), artistOf = { it.artist }).apply { shuffle = true; playsOnce = true; set(songs, 0) }
      val played = mutableListOf(q.items[q.index].artist)
      while (true) { val i = q.advance(pressed = true) ?: break; played += q.items[i].artist }
      val norm = played.map { PlayQueue.artistKey(it) }
      val firstKen = norm.indexOfFirst { it == "ken carson" }
      // Up to the last Ken Carson song, no run of five.
      val lastKen = norm.indexOfLast { it == "ken carson" }
      var run = 0
      for (i in 0..lastKen) { run = if (i > 0 && norm[i] == norm[i - 1]) run + 1 else 1; assertTrue("seed $seed: $norm", run <= 4) }
      assertTrue(firstKen >= 0)
      assertEquals(11, played.size)
    }
  }

  @Test fun oneArtistAloneStillPlaysOn() {
    val q = runQueue(*(1..6).map { A("s$it", "Slayr") }.toTypedArray())
    var n = 1
    while (q.advance(pressed = true) != null) n++
    assertEquals(6, n)
  }

  @Test fun theXMovesToASongStillToFetchWhenNothingIsDownloaded() {
    data class F(val key: String, val ready: Boolean)
    val q = PlayQueue<F>({ it.key }, { it.ready }, Random(3)).apply { set(listOf(F("a", true), F("b", false), F("c", false)), 0) }
    assertNull("nothing ready and no fetch allowed", q.leave("a"))
    assertEquals("b", q.leave("a", canFetch = { true })?.let { q.items[it].key })
    assertEquals(listOf("b", "c"), q.items.map { it.key })
  }

  // SHUFFLE-STAY-001 (owner, 2026-11-24): "the song should stay in the queue but the song shouldnt be played again if
  // other songs in the queue havent been played once". Repeat semantics are unchanged: repeat off waits at the end of
  // the round; only repeat all opens a fresh round, which plays without replacement.

  @Test fun aSongPlayedUnderShuffleStaysInTheQueueList() {
    val q = onceQueue(H("a"), H("b"), H("c"))
    val keys = listOf("a", "b", "c")
    while (true) {
      q.advance(pressed = false) ?: break
      assertEquals("a played song stays in the queue", keys, q.items.map { it.key })
    }
    assertEquals(keys, q.items.map { it.key })
  }

  @Test fun repeatOffStillWaitsAtTheEndOfAPlayOnceRoundAndKeepsEverySong() {
    val q = onceQueue(H("a"), H("b"), H("c", heard = true))
    assertEquals("b", q.advance(pressed = false)?.let { q.items[it].key })
    assertNull("repeat off waits for a new song instead of starting another round", q.advance(pressed = false))
    assertNull(q.advance(pressed = true))
    assertEquals("nothing is taken out of the queue", listOf("a", "b", "c"), q.items.map { it.key })
  }

  @Test fun repeatAllOpensAFreshRoundOverThePlayOnceQueueWithoutReplacement() {
    val q = onceQueue(H("a"), H("b"), H("c", heard = true))
    q.repeat = PlayQueue.Repeat.ALL
    val played = mutableListOf(q.items[q.index].key)
    repeat(7) { q.advance(pressed = false)?.let { played += q.items[it].key } }
    assertEquals("repeat all keeps playing", 8, played.size)
    assertEquals("the queue list never loses a song", listOf("a", "b", "c"), q.items.map { it.key })
    assertEquals("heard-on-record songs come after the unheard ones", listOf("a", "b"), played.take(2))
    assertTrue("a heard-on-record song is not excluded forever: $played", played.contains("c"))
    for (i in 1 until played.size) assertNotEquals("no song follows itself: $played", played[i - 1], played[i])
  }

  @Test fun aFreshRoundNeverOpensWithTheSongJustPlayed() {
    for (seed in 0 until 12) {
      val q = PlayQueue<H>({ it.key }, { true }, Random(seed), heardBefore = { it.heard })
        .apply { shuffle = true; playsOnce = true; repeat = PlayQueue.Repeat.ALL; set(listOf(H("a"), H("b"), H("c")), 0) }
      val played = mutableListOf(q.items[q.index].key)
      repeat(5) { q.advance(pressed = false)?.let { played += q.items[it].key } }
      for (i in 1 until played.size) assertNotEquals("seed $seed: $played", played[i - 1], played[i])
    }
  }

  // WP7-ORDER-001: the page's now playing queue is already shuffled by the page, so under shuffle the queue plays its
  // unheard songs in the list's order. A saved list carries no such order and keeps the queue's own shuffle.

  @Test fun theNowPlayingQueueUnderShuffleKeepsThePagesOrder() {
    for (seed in 0 until 5) {
      val q = onceQueue(*(1..6).map { H("s$it") }.toTypedArray(), seed = seed)
      val played = mutableListOf(q.items[q.index].key)
      while (true) { val i = q.advance(pressed = false) ?: break; played += q.items[i].key }
      assertEquals("seed $seed: the page already shuffled its queue", (1..6).map { "s$it" }, played)
    }
  }

  @Test fun aSavedListKeepsItsNativeShuffle() {
    val keys = (1..8).map { "s$it" }
    var differed = false
    for (seed in 0 until 8) {
      val q = PlayQueue<H>({ it.key }, { true }, Random(seed)).apply { shuffle = true; set(keys.map { H(it) }, 0) }
      val played = mutableListOf(q.items[q.index].key)
      while (played.size < keys.size) { val i = q.advance(pressed = false) ?: break; played += q.items[i].key }
      assertEquals(keys.toSet(), played.toSet())
      if (played != keys) differed = true
    }
    assertTrue("a saved list is shuffled by the queue itself", differed)
  }

  // WP7-APPEND-001: a song the engine found itself goes into the order at a random slot whose neighbours are other
  // artists (any slot when every one of them is the same artist), never before the song playing.

  @Test fun appendedSongsLandBetweenOtherArtists() {
    for (seed in 0 until 20) {
      val q = PlayQueue<A>({ it.key }, { true }, Random(seed), artistOf = { it.artist })
        .apply { shuffle = true; playsOnce = true; set(listOf(A("a1", "Alpha"), A("b1", "Beta"), A("c1", "Gamma"), A("d1", "Delta")), 0) }
      assertTrue(q.insertSpaced(listOf(A("n1", "Nova"), A("n2", "Nova"))))
      assertEquals(6, q.items.size)
      assertEquals("the song playing carries on", "a1", q.current?.key)
      val artists = q.items.map { PlayQueue.artistKey(it.artist) }
      for (i in 1 until artists.size) assertNotEquals("seed $seed: $artists", artists[i - 1], artists[i])
    }
  }

  @Test fun appendedSongsAreSpacedInTheShuffleRoundToo() {
    for (seed in 0 until 20) {
      val q = PlayQueue<A>({ it.key }, { true }, Random(seed), artistOf = { it.artist })
        .apply { shuffle = true; set((1..5).map { A("s$it", "Artist $it") }, 0) }
      assertTrue(q.insertSpaced(listOf(A("n1", "Nova"), A("n2", "Nova"))))
      val round = listOf(q.current!!.key) + q.roundAhead()
      assertEquals("every song of the round shows once", 7, round.size)
      val artists = round.map { k -> PlayQueue.artistKey(q.items.first { it.key == k }.artist) }
      for (i in 1 until artists.size) assertNotEquals("seed $seed: $artists", artists[i - 1], artists[i])
    }
  }

  @Test fun appendedSongsGoSomewhereEvenWhenEveryNeighbourIsTheSameArtist() {
    val q = PlayQueue<A>({ it.key }, { true }, Random(5), artistOf = { it.artist })
      .apply { shuffle = true; playsOnce = true; set((1..3).map { A("s$it", "Nova") }, 0) }
    assertTrue(q.insertSpaced(listOf(A("n1", "Nova"))))
    assertEquals(4, q.items.size)
    assertEquals("s1", q.current?.key)
    assertTrue("never before the song playing", q.items.indexOfFirst { it.key == "n1" } >= 1)
  }

  // ARTIST-RUN-001: Previous plays a song, so it counts towards the four-in-a-row limit like any other play.
  @Test fun previousCountsTowardsTheFourInARowLimit() {
    val q = PlayQueue<A>({ it.key }, { true }, Random(4), artistOf = { it.artist }).apply {
      shuffle = true; playsOnce = true
      set(listOf(A("a1", "Alpha"), A("a2", "Alpha"), A("a3", "Alpha"), A("a4", "Alpha"), A("b1", "Beta")), 0)
    }
    assertEquals(1, q.advance(pressed = false))
    assertEquals(2, q.advance(pressed = false))
    assertEquals("Previous plays a2 again: a fourth Alpha", 1, q.previous())
    assertEquals("a fifth Alpha in a row while Beta is left", 4, q.advance(pressed = false))
  }

  // Car path: the list is set (a car tap), then shuffle is turned on, then Next is pressed. Every song must be reached.
  @Test fun carTapThenShuffleNextReachesEverySongOnce() {
    for (seed in 0 until 60) {
      for (shuffleFirst in listOf(false, true)) {
        val q = PlayQueue<S>({ it.key }, { it.ready }, Random(seed))
        if (shuffleFirst) q.shuffle = true
        q.set(listOf(S("q1"), S("q2"), S("q3")), 0)
        q.shuffle = true
        val played = mutableListOf(q.items[q.index].key)
        repeat(2) {
          val i = q.advance(pressed = true)
          assertNotNull("seed $seed shuffleFirst=$shuffleFirst: Next found nothing after $played", i)
          played += q.items[i!!].key
        }
        assertEquals("seed $seed shuffleFirst=$shuffleFirst", setOf("q1", "q2", "q3"), played.toSet())
      }
    }
  }
}
