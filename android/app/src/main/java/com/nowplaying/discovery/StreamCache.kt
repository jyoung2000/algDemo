package com.nowplaying.discovery

import java.net.URI

/**
 * FAST-PLAY-002. Owner: "I want to be able to play a song instantly when i click on it on all platforms".
 *
 * What [Streams] remembers, so naming a source's audio file is paid for once: a yt-dlp run takes
 * seconds on a phone, and the same song gets warmed before a tap, tapped, and often played again.
 *
 * Two things are held per source link: the answer, and the fact that a run is already in flight
 * ([claim]), so a row hovered twice does not start two processes. A link the source stamped with its
 * own expiry is dropped a minute before it, because a song must not start on a link that dies
 * mid-play. Mirrors the 20-minute window and 64-entry bound of windows/streams.cjs.
 */
class StreamCache(
  private val ttlMs: Long = 20 * 60 * 1000,
  private val max: Int = 64,
  /**
   * How long a claim ("a run for this link is in flight") is believed. Short, because a warm can be
   * dropped from the queue before it ever runs, and a song must not be left unwarmable because of a
   * run that never happened.
   */
  private val claimTtlMs: Long = 90_000,
  /** How long a source that gave nothing is left alone by warming. */
  private val failureTtlMs: Long = 5 * 60_000,
) {
  private class Entry(val at: Long, val stream: Streams.Stream?, val expiresAt: Long?, val failed: Boolean = false)

  private val entries = LinkedHashMap<String, Entry>()

  companion object {
    /** The source's own expiry for this link, in epoch milliseconds, when it stamps one. */
    fun expiryOf(url: String): Long? {
      val query = runCatching { URI(url).rawQuery }.getOrNull() ?: return null
      val raw = query.split('&').firstOrNull { it.startsWith("expire=") }?.removePrefix("expire=") ?: return null
      val seconds = raw.toLongOrNull() ?: return null
      return if (seconds > 0) seconds * 1000 else null
    }
  }

  @Synchronized
  fun get(url: String, at: Long): Streams.Stream? {
    val entry = entries[url] ?: return null
    if (at - entry.at >= ttlMs) {
      entries.remove(url)
      return null
    }
    val expiresAt = entry.expiresAt
    if (expiresAt != null && expiresAt - at <= 60_000) {
      entries.remove(url)
      return null
    }
    return entry.stream
  }

  @Synchronized
  fun put(url: String, stream: Streams.Stream, at: Long, expiresAt: Long? = expiryOf(stream.url)) {
    entries.remove(url)
    entries[url] = Entry(at, stream, expiresAt)
    while (entries.size > max) entries.remove(entries.keys.first())
  }

  /** Remember that a run for this link is in flight, so nothing starts a second one. */
  @Synchronized
  fun claim(url: String, at: Long) {
    if (entries[url]?.stream != null) return
    entries.remove(url)
    entries[url] = Entry(at, null, null)
    while (entries.size > max) entries.remove(entries.keys.first())
  }

  /** True when this link is worth a yt-dlp run right now: no good answer and none in flight. */
  @Synchronized
  fun shouldWarm(url: String, at: Long): Boolean {
    val entry = entries[url] ?: return true
    if (at - entry.at >= ttlMs) return true
    if (entry.failed) return at - entry.at >= failureTtlMs
    if (entry.stream == null) return at - entry.at >= claimTtlMs
    val expiresAt = entry.expiresAt
    return expiresAt != null && expiresAt - at <= 60_000
  }

  @Synchronized
  fun forget(url: String) {
    entries.remove(url)
  }

  /**
   * This source would not give a file. Remembered briefly so scrolling past the same row again does
   * not spend another yt-dlp run on it; a tap still tries, because that is the listener asking.
   */
  @Synchronized
  fun putFailure(url: String, at: Long) {
    entries.remove(url)
    entries[url] = Entry(at, null, null, failed = true)
    while (entries.size > max) entries.remove(entries.keys.first())
  }
}
