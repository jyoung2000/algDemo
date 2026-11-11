package com.nowplaying.discovery

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CompletableFuture

/**
 * FAST-PLAY-002. Owner: "I want to be able to play a song instantly when i click on it on all platforms".
 *
 * One yt-dlp run per source link at a time. A row warmed when it scrolled into view and the tap a
 * second later ask the same question; the tap joins the run already in flight and gets its answer
 * the moment it lands, instead of starting a second run and waiting the whole time again.
 *
 * A run that found nothing is forgotten, so a later tap may try again rather than inheriting a
 * failure for ever; a run that threw is treated as nothing found, never as a stuck entry.
 */
class StreamRuns(private val run: (String) -> Streams.Stream?) {
  private val inFlight = ConcurrentHashMap<String, CompletableFuture<Streams.Stream?>>()
  private val joined = ConcurrentHashMap<String, Int>()

  /** How many callers are waiting on a run for this link rather than starting their own. */
  fun waiting(url: String): Int = joined[url] ?: 0

  fun get(url: String): Streams.Stream? {
    val mine = CompletableFuture<Streams.Stream?>()
    val existing = inFlight.putIfAbsent(url, mine)
    if (existing != null) {
      joined.merge(url, 1, Int::plus)
      return runCatching { existing.join() }.getOrNull()
    }
    val found = runCatching { run(url) }.getOrNull()
    inFlight.remove(url)
    mine.complete(found)
    return found
  }
}
