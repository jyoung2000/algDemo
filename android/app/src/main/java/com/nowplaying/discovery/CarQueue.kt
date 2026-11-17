package com.nowplaying.discovery

/**
 * AUTO-QUEUE-001 (owner, 2026-11-17): what a single song the car chose does to the now-playing
 * queue. A search-result single or song browse leaf plays at the FRONT of the current queue and
 * keeps the rest of the queue after it; a song already in the queue plays in place. Albums and
 * saved playlists carry collection-scoped ids and are left to the surrounding-list path, which
 * replaces the whole queue with the collection. Pure Kotlin so the rules run under JVM tests.
 */
object CarQueue {
  /** A plan for the timeline: the list to play and the index of the chosen song in it. */
  class Plan<T>(val items: List<T>, val index: Int)

  /** Ids that carry their own collection: saved playlist/album tracks and car-search album songs. */
  fun collectionScoped(mediaId: String): Boolean =
    mediaId.startsWith("calbum/") || Regex("^playlist/([^/]+)/track/([^/]+)$").matches(mediaId)

  /** Radio stations and the live radio pseudo-entry never belong in a song queue. */
  private fun radioId(id: String): Boolean = id.startsWith("radio/") || id.startsWith("radio:")

  /**
   * The queue a car-chosen single plays in. Null means no plan — the caller restores the song's
   * surrounding list instead (CAR-SKIP-001): collection-scoped or radio ids, and an empty queue.
   */
  fun <T> planFor(chosen: T, queue: List<T>, idOf: (T) -> String): Plan<T>? {
    val id = idOf(chosen)
    if (collectionScoped(id) || radioId(id)) return null
    val kept = queue.filterNot { radioId(idOf(it)) }
    if (kept.isEmpty()) return null
    val at = kept.indexOfFirst { idOf(it) == id }
    if (at >= 0) return Plan(kept, at)
    return Plan(listOf(chosen) + kept, 0)
  }
}
