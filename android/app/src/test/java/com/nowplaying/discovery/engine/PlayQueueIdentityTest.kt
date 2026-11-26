package com.nowplaying.discovery.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

/**
 * AA-SHUFFLE-ONCE-001, the half the car test cannot reach: the queue is keyed by the id a song was
 * *chosen under* (EnginePlayer passes `keyOf = { it.mediaId }`), but the same song arrives under
 * different ids - scoped `list|song` from a car browse, plain `song.id` from a page push. These tests
 * pin the rule the owner actually stated: one play per song per round, whatever id it arrives under.
 */
class PlayQueueIdentityTest {
  /** A song as the engine holds it: `key` is the id it was chosen under, `id` is the song itself. */
  private data class S(val key: String, val id: String, val ready: Boolean = true)

  private fun queue(items: List<S>, seed: Int = 7) =
    PlayQueue<S>({ it.key }, { it.ready }, Random(seed), identityOf = { it.id })
      .apply { set(items, 0) }

  private fun scoped(n: String) = S("playlist:road|song:$n", n)
  private fun plain(n: String) = S(n, n)

  /**
   * R2/1.3: play two of three under scoped ids, then re-push the same three songs under plain ids,
   * as App.tsx does on every library refresh. The round must survive: only the unheard song may play.
   */
  @Test fun aPageRepushUnderPlainIdsDoesNotReplayWhatShuffleAlreadyPlayed() {
    for (seed in 1..50) {
      val q = queue(listOf(scoped("a"), scoped("b"), scoped("c")), seed)
      q.shuffle = true
      val heard = mutableListOf(q.current!!.id)
      heard += q.items[q.advance(pressed = true)!!].id
      // Same three songs, same order, now keyed plainly - a library push, not a new list.
      val keep = q.current!!.id
      val repushed = listOf(plain("a"), plain("b"), plain("c"))
      q.set(repushed, repushed.indexOfFirst { it.id == keep }.coerceAtLeast(0))
      val next = q.advance(pressed = true)
      assertTrue("seed $seed: re-push lost the round and replayed $heard", next != null)
      val third = q.items[next!!].id
      assertTrue("seed $seed: replayed $third after $heard", third !in heard)
      heard += third
      assertEquals("seed $seed", setOf("a", "b", "c"), heard.toSet())
      assertNull("seed $seed: a finished round must not restart after a re-push", q.advance(pressed = true))
    }
  }

  /**
   * R1/1.2: a natural transition re-seats the current song under a plain id while the rest stay
   * scoped. The song must not become a second, unheard entry.
   */
  @Test fun theSameSongUnderTwoIdFormsIsOnePlayNotTwo() {
    val q = queue(listOf(scoped("a"), scoped("b")), seed = 3)
    q.shuffle = true
    val firstId = q.current!!.id
    // The current entry re-seated plainly, exactly as EnginePlayer rebuilds a list around `current`.
    val mixed = listOf(plain(firstId), scoped(if (firstId == "a") "b" else "a"))
    q.set(mixed, 0)
    val next = q.advance(pressed = true)
    assertTrue("the other song should follow", next != null && q.items[next!!].id != firstId)
    assertNull("the first song must not come back under its other id", q.advance(pressed = true))
  }

  /**
   * The measurement behind the fix. Keyed only by the id a song arrived under, a re-push restarts the
   * round on 22 of 50 seeds; told what the song is, it never does. Keep both halves: the first is the
   * owner's reported fault, the second is the guarantee.
   */
  @Test fun identityIsWhatStopsARepushFromReplaying() {
    fun replaysOver(withIdentity: Boolean): Int {
      var replayed = 0
      for (seed in 1..50) {
        val q = if (withIdentity) PlayQueue<S>({ it.key }, { it.ready }, Random(seed), identityOf = { it.id })
        else PlayQueue<S>({ it.key }, { it.ready }, Random(seed))
        q.set(listOf(scoped("a"), scoped("b"), scoped("c")), 0)
        q.shuffle = true
        val heard = mutableListOf(q.current!!.id)
        heard += q.items[q.advance(pressed = true)!!].id
        val keep = q.current!!.id
        val plain = listOf(plain("a"), plain("b"), plain("c"))
        q.set(plain, plain.indexOfFirst { it.id == keep }.coerceAtLeast(0))
        val next = q.advance(pressed = true)
        if (next != null && q.items[next].id in heard) replayed++
      }
      return replayed
    }
    assertEquals("keyed by the arrival id, a re-push replays - this was the owner's fault", 22, replaysOver(false))
    assertEquals("keyed by the song, a re-push never replays", 0, replaysOver(true))
  }

  /** A genuinely different list is still a new round - the identity fix must not freeze old marks. */
  @Test fun aDifferentListStartsAFreshRound() {
    val q = queue(listOf(plain("a"), plain("b"), plain("c")), seed = 5)
    q.shuffle = true
    q.advance(pressed = true)
    q.set(listOf(plain("x"), plain("y"), plain("z")), 0)
    val seen = mutableListOf(q.current!!.id)
    seen += q.items[q.advance(pressed = true)!!].id
    seen += q.items[q.advance(pressed = true)!!].id
    assertEquals("a new list plays all of its own songs", setOf("x", "y", "z"), seen.toSet())
  }
}
