package com.nowplaying.discovery

/** Immutable, validated snapshot: a bad request never partially changes the live selection. */
internal class DownloadSelection(protected: List<String>, wanted: List<String> = emptyList()) {
  val protected: Set<String>
  val wanted: Set<String>
  init {
    require(protected.size <= 3 && protected.all(Downloads::urlAllowed)) { "protected must contain at most 3 valid URLs." }
    require(wanted.size <= 10000 && wanted.all(Downloads::urlAllowed)) { "wanted must contain at most 10000 valid URLs." }
    this.protected = protected.toSet()
    this.wanted = wanted.toSet()
  }
  fun retains(url: String) = url in protected || url in wanted
  fun evictionProtection(background: Boolean) = if (background) protected + wanted else protected
}
