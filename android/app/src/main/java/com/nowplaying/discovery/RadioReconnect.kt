package com.nowplaying.discovery

/**
 * RADIO-ROBUST-001 (owner, 2026-11-20): "Ensure all radio stations ... seamlessly works". A stream that was playing and
 * drops (a network blip, a server restart) reconnects by itself, up to five times in a row with growing waits; the count
 * starts again once the station has played 2 s more. A station that never played tries once more (servers refuse a
 * connection now and then), then fails with its real reason.
 */
object RadioReconnect {
  const val MAX_TRIES = 5
  private const val RECOVERED_FRAMES = 48000L * 2

  /** The new consecutive-try count, or null to give up and show the error. */
  fun next(everPlayed: Boolean, framesSinceConnect: Long, tries: Int): Int? {
    if (!everPlayed) return if (tries == 0) 1 else null
    val t = if (framesSinceConnect >= RECOVERED_FRAMES) 0 else tries
    return if (t < MAX_TRIES) t + 1 else null
  }

  fun delayMs(tries: Int): Long = minOf(8000L, 1000L shl (tries - 1).coerceIn(0, 3))

  /** Every stream address in a .pls/.m3u playlist, in order, once each. */
  fun playlistEntries(t: String): List<String> =
    t.lines().map { it.trim().replace(Regex("^File\\d+="), "") }.filter { it.startsWith("http") }.distinct()

  /** Plays the first address that gives audio; one that fails before any audio gives way to the next (stations list
   *  backup servers). A stream that played and then failed is not swapped. With every address failing, the first
   *  reason is the one reported. */
  fun <T> firstThatPlays(urls: List<String>, frames: () -> Long, open: (String) -> T): T {
    require(urls.isNotEmpty()) { "No stream in playlist" }
    var first: Throwable? = null
    for (u in urls.take(4)) {
      val mark = frames()
      try { return open(u) } catch (e: Throwable) { if (frames() > mark) throw e; if (first == null) first = e }
    }
    throw first!!
  }
}
