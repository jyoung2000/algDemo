package com.nowplaying.discovery

/** Immutable, validated snapshot: a bad request never partially changes the live selection. */
internal class DownloadSelection(protected: List<String>, wanted: List<String> = emptyList()) {
  val protected: Set<String>
  val wanted: Set<String>
  /** url -> position in the listening order the page asked for. Rank 0 plays soonest. */
  val wantedRank: Map<String, Int>
  init {
    require(protected.size <= 3 && protected.all(Downloads::urlAllowed)) { "protected must contain at most 3 valid URLs." }
    require(wanted.size <= 10000 && wanted.all(Downloads::urlAllowed)) { "wanted must contain at most 10000 valid URLs." }
    this.protected = protected.toSet()
    this.wanted = wanted.toSet()
    // Order is meaning here, not decoration: it is the playback order the retention plan rolls along.
    // A repeated song keeps its earliest position, because that is when it is next needed.
    val ranks = LinkedHashMap<String, Int>()
    wanted.forEachIndexed { index, url -> ranks.putIfAbsent(url, index) }
    this.wantedRank = ranks
  }
  fun retains(url: String) = url in protected || url in wanted
  /**
   * Protected decks are untouchable in both lanes. Wanted songs are no longer blanket-protected in
   * the background lane: that deadlocked a list larger than the quota. Ordering in
   * `planCacheEvictions` is what keeps a background song from taking an earlier song's place.
   */
  fun evictionProtection(background: Boolean) = protected
}
