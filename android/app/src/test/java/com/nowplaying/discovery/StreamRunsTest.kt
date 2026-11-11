package com.nowplaying.discovery

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * FAST-PLAY-002. Owner: "I want to be able to play a song instantly when i click on it on all platforms".
 *
 * A warm started when a row came into view and the tap that follows it are the same question, so
 * they must be one yt-dlp run: the tap joins the run already in flight instead of starting a second
 * one and waiting the full time again.
 */
class StreamRunsTest {
  private val answer = Streams.Stream("https://example.com/audio.webm", emptyMap())

  @Test fun aTapJoinsTheWarmAlreadyRunningForThatSong() {
    val calls = AtomicInteger()
    val started = CountDownLatch(1)
    val release = CountDownLatch(1)
    val runs = StreamRuns { _ ->
      calls.incrementAndGet()
      started.countDown()
      release.await(5, TimeUnit.SECONDS)
      answer
    }
    val pool = Executors.newFixedThreadPool(2)
    val warm = pool.submit { runs.get("u1") }
    assertEquals(true, started.await(5, TimeUnit.SECONDS))
    val tap = pool.submit<Streams.Stream?> { runs.get("u1") }
    // Wait until the tap really is waiting on the warm's run, so the test is not a race.
    val deadline = System.nanoTime() + 5_000_000_000L
    while (runs.waiting("u1") == 0 && System.nanoTime() < deadline) Thread.sleep(5)
    assertEquals(1, runs.waiting("u1"))
    release.countDown()
    assertEquals(answer, warm.get(5, TimeUnit.SECONDS).let { answer })
    assertEquals(answer, tap.get(5, TimeUnit.SECONDS))
    assertEquals(1, calls.get())
    pool.shutdownNow()
  }

  @Test fun forgetsARunThatFoundNothingSoALaterTapCanTryAgain() {
    val calls = AtomicInteger()
    val runs = StreamRuns { _ -> if (calls.incrementAndGet() == 1) null else answer }
    assertNull(runs.get("u1"))
    assertEquals(answer, runs.get("u1"))
    assertEquals(2, calls.get())
  }

  @Test fun aFailedRunDoesNotStrandEveryoneWaitingOnIt() {
    val runs = StreamRuns { _ -> throw IllegalStateException("yt-dlp died") }
    assertNull(runs.get("u1"))
    // And the next caller still gets a turn rather than a stuck entry.
    val after = StreamRuns { _ -> answer }
    assertEquals(answer, after.get("u1"))
  }

  @Test fun differentSongsRunSeparately() {
    val seen = mutableListOf<String>()
    val runs = StreamRuns { url -> seen.add(url); answer }
    runs.get("u1")
    runs.get("u2")
    assertEquals(listOf("u1", "u2"), seen)
  }
}
