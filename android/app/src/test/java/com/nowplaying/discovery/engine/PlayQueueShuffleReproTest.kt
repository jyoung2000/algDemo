package com.nowplaying.discovery.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import kotlin.random.Random

// Repro for the CarSkipTest shuffle failure: three ready songs, shuffle on, repeat off, Next pressed.
class PlayQueueShuffleReproTest {
  private data class S(val key: String, val ready: Boolean = true)

  private fun queue(seed: Int) = PlayQueue<S>({ it.key }, { it.ready }, Random(seed))
    .apply { set(listOf(S("q1"), S("q2"), S("q3")), 0) }

  @Test fun nextPressedThreeTimesYieldsEverySongOnceThenStops() {
    for (seed in 1..200) {
      val q = queue(seed)
      q.shuffle = true
      val seen = mutableListOf(q.current!!.key)
      repeat(2) {
        val i = q.advance(pressed = true)
        assertNotNull("seed $seed: Next found nothing after $seen", i)
        seen += q.items[i!!].key
      }
      assertEquals("seed $seed", setOf("q1", "q2", "q3"), seen.toSet())
      assertNull("seed $seed: a played-once round must end, not restart", q.advance(pressed = true))
    }
  }

  @Test fun controllerSeekToIndexThenNextStillReachesTheRemainingSong() {
    for (seed in 1..200) {
      val q = queue(seed)
      q.shuffle = true
      val first = q.advance(pressed = true)
      assertNotNull("seed $seed: first Next", first)
      // The car's guessed index (what SEEK_TO_MEDIA_ITEM carries) may name any other song.
      val guess = (0..2).first { it != q.index }
      q.select(guess)
      val after = q.advance(pressed = true)
      val played = setOf(q.items[0].key, q.items[1].key, q.items[2].key)
      assertEquals("seed $seed: all three songs should have been reached", 3, played.size)
      if (after != null) assertNotNull(q.items[after].key)
    }
  }
}
