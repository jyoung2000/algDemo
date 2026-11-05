package com.nowplaying.discovery

import java.io.IOException

/** Immutable quota decision; the caller performs filesystem mutations only after a valid plan. */
internal data class CacheEntry(val url: String, val bytes: Long, val lastUsed: Long)

/**
 * Retention order for a cache that rolls along the list being listened to, rather than plain LRU:
 *  1. files no longer in `wantedRank` at all go first, least recently used among them, because they
 *     are obsolete - the listener moved to another list, or the song left this one;
 *  2. then wanted songs from the TAIL of the playback order backwards, so the songs about to play
 *     are the last to be dropped instead of an arbitrary oldest next song;
 *  3. `protected` (the live decks) and `replacing` (this very song) are never candidates, and kept
 *     copies live in the user's Music folder, which this plan never touches.
 *
 * A BACKGROUND insert may only take the place of a wanted song ranked LATER than itself. That is
 * what keeps the window rolling when the list is bigger than the quota: refusing every wanted song
 * deadlocks the cache (nothing can ever be added again), while allowing any of them lets two
 * background songs evict each other forever. Ranks are a strict order, so there is no cycle.
 * A FOREGROUND insert - a song the listener asked for now - may evict any wanted song.
 */
internal fun planCacheEvictions(
  entries: List<CacheEntry>, incoming: Long, replacing: String?, limit: Long, protected: Set<String>,
  wantedRank: Map<String, Int> = emptyMap(), background: Boolean = false,
): List<String> {
  require(incoming >= 0 && limit >= 0) { "Invalid cache size." }
  if (incoming > limit) throw IOException("Audio file exceeds the private cache limit.")
  val mine = replacing?.let { wantedRank[it] }
  fun evictable(url: String): Boolean {
    if (url == replacing || url in protected) return false
    val rank = wantedRank[url] ?: return true
    if (!background) return true
    return mine != null && rank > mine
  }
  var used = entries.sumOf { it.bytes } - (entries.firstOrNull { it.url == replacing }?.bytes ?: 0L) + incoming
  val evicted = mutableListOf<String>()
  // Obsolete files (no rank) sort before wanted ones; among wanted, the latest to play goes first.
  val candidates = entries.filter { evictable(it.url) }
    .sortedWith(
      compareBy<CacheEntry> { if (it.url in wantedRank) 1 else 0 }
        .thenBy { if (it.url in wantedRank) 0L else it.lastUsed }
        .thenByDescending { wantedRank[it.url] ?: 0 }
        .thenBy { it.url },
    )
  for (entry in candidates) {
    if (used <= limit) break
    evicted.add(entry.url)
    used -= entry.bytes
  }
  if (used > limit) throw IOException("Cache limit cannot fit this song without removing a protected song.")
  return evicted
}
