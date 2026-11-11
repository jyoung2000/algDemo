package com.nowplaying.discovery

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * FAST-PLAY-002. Owner: "I want to be able to play a song instantly when i click on it on all platforms".
 *
 * Naming a source's audio file costs a yt-dlp run (seconds on a phone), so the answer is kept and
 * reused: a song warmed before the tap, or played twice, must not pay for it again. The link the
 * source hands out expires, and a cached link past its expiry is worse than none at all.
 */
class StreamCacheTest {
  private val stream = Streams.Stream("https://rr7---sn-x.googlevideo.com/videoplayback?expire=1794371146", emptyMap())

  @Test fun reusesAFreshAnswerAndForgetsAStaleOne() {
    val cache = StreamCache(ttlMs = 1_000, max = 8)
    cache.put("u1", stream, at = 0, expiresAt = null)
    assertEquals(stream, cache.get("u1", at = 999))
    assertNull(cache.get("u1", at = 1_001))
  }

  @Test fun forgetsALinkThatIsAboutToExpireEvenInsideTheWindow() {
    val cache = StreamCache(ttlMs = 60 * 60_000, max = 8)
    cache.put("u1", stream, at = 0, expiresAt = 600_000)
    assertEquals(stream, cache.get("u1", at = 1_000))
    // Within a minute of its own expiry the link is treated as gone: a song must not start on it
    // and die mid-play.
    assertNull(cache.get("u1", at = 550_000))
  }

  @Test fun readsTheSourcesOwnExpiryFromTheLink() {
    assertEquals(1794371146_000L, StreamCache.expiryOf(stream.url))
    assertNull(StreamCache.expiryOf("https://example.com/audio.webm"))
    assertNull(StreamCache.expiryOf("https://example.com/a?expire=not-a-number"))
  }

  @Test fun leavesASourceThatGaveNothingAloneForAWhile() {
    val cache = StreamCache(ttlMs = 60 * 60_000, max = 8, failureTtlMs = 10_000)
    cache.putFailure("u1", at = 0)
    assertEquals(false, cache.shouldWarm("u1", at = 5_000))
    assertEquals(true, cache.shouldWarm("u1", at = 11_000))
    // A failure is never offered as an answer.
    assertNull(cache.get("u1", at = 5_000))
  }

  @Test fun keepsOnlyTheMostRecentAnswers() {
    val cache = StreamCache(ttlMs = 60_000, max = 2)
    cache.put("u1", stream, at = 0, expiresAt = null)
    cache.put("u2", stream, at = 1, expiresAt = null)
    cache.put("u3", stream, at = 2, expiresAt = null)
    assertNull(cache.get("u1", at = 3))
    assertEquals(stream, cache.get("u3", at = 3))
  }

  @Test fun oneSongIsWarmedOnceWhileItsAnswerIsStillGood() {
    val cache = StreamCache(ttlMs = 60_000, max = 8)
    assertEquals(true, cache.shouldWarm("u1", at = 0))
    cache.claim("u1", at = 0)
    // Claimed while the yt-dlp run is in flight, so a second hover does not start another.
    assertEquals(false, cache.shouldWarm("u1", at = 10))
    cache.put("u1", stream, at = 20, expiresAt = null)
    assertEquals(false, cache.shouldWarm("u1", at = 30))
    // A claim that never produced an answer is not held for ever: a warm dropped from the queue
    // must not leave the song unwarmable.
    val other = StreamCache(ttlMs = 60 * 60_000, max = 8, claimTtlMs = 1_000)
    other.claim("u2", at = 0)
    assertEquals(false, other.shouldWarm("u2", at = 500))
    assertEquals(true, other.shouldWarm("u2", at = 1_500))
  }
}
