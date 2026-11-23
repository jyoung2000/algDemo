package com.nowplaying.discovery

/**
 * ARTIST-FAV-CAR-001: the artists a song's credit line names, and what the car says after starring them. The page and
 * the engine use the song's own artist list when they have it; this reading of the credit line is for the button's
 * label and the message. "&" is kept inside a name (Simon & Garfunkel); commas and "feat." separate artists.
 */
object CarArtists {
  private val SPLIT = Regex("""\s*,\s*|\s+(?:feat\.?|ft\.?|featuring|with)\s+""", RegexOption.IGNORE_CASE)

  fun names(credit: String?): List<String> =
    credit.orEmpty().replace(Regex("""[()\[\]]"""), " ").split(SPLIT).map { it.trim() }.filter { it.isNotEmpty() }
      .distinctBy { it.lowercase() }.take(6)

  /** CAR-ANSWERABLE-001: nothing could save them yet, so say that rather than claim it is done. */
  fun waiting(names: List<String>): String = when (names.size) {
    0 -> "This song names no artist to star."
    1 -> "${names[0]} will be added to your artists when you open jPlay"
    else -> "${names.dropLast(1).joinToString(", ")} and ${names.last()} will be added to your artists when you open jPlay"
  }

  fun told(names: List<String>): String = when (names.size) {
    0 -> "This song names no artist to star."
    1 -> "Added ${names[0]} to your artists"
    else -> "Added ${names.dropLast(1).joinToString(", ")} and ${names.last()} to your artists"
  }
}
