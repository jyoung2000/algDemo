package com.nowplaying.discovery

import java.io.IOException

/** Immutable quota decision; the caller performs filesystem mutations only after a valid plan. */
internal data class CacheEntry(val url: String, val bytes: Long, val lastUsed: Long)

internal fun planCacheEvictions(
  entries: List<CacheEntry>, incoming: Long, replacing: String?, limit: Long, protected: Set<String>,
): List<String> {
  require(incoming >= 0 && limit >= 0) { "Invalid cache size." }
  if (incoming > limit) throw IOException("Audio file exceeds the private cache limit.")
  var used = entries.sumOf { it.bytes } - (entries.firstOrNull { it.url == replacing }?.bytes ?: 0L) + incoming
  val evicted = mutableListOf<String>()
  for (entry in entries.sortedWith(compareBy<CacheEntry> { it.lastUsed }.thenBy { it.url })) {
    if (used <= limit) break
    if (entry.url == replacing || entry.url in protected) continue
    evicted.add(entry.url)
    used -= entry.bytes
  }
  if (used > limit) throw IOException("Cache limit cannot fit this song without removing a protected song.")
  return evicted
}
