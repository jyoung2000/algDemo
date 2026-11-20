package com.nowplaying.discovery

/**
 * SIMILAR-NOTICE-001 (owner, 2026-11-20): "find similar songs needs a pop up or indicator on how many new similar
 * songs it found and added on all platforms like windows, android and android auto". What the car says over the
 * player when Find similar starts and when it has added songs. One sentence each: the car's message shows only the
 * first sentence (PlaybackService.tellDriver).
 */
object CarSimilarText {
  /** " (feat. Drake)" and the like: measured on the DHU, its ". " cut the message to "Finding songs like Life Is Good (feat.". */
  private val FEATURING = Regex("""\s*[(\[](?:feat|ft|featuring|with)\b[^)\]]*[)\]]""", RegexOption.IGNORE_CASE)

  fun looking(title: String?): String {
    val t = title?.replace(FEATURING, "")?.replace(". ", " ")?.trim().orEmpty()
    return if (t.isEmpty()) "Finding similar songs…" else "Finding songs like ${t.take(60)}…"
  }

  fun added(count: Int, minimum: Int): String {
    val songs = if (count == 1) "1 new similar song" else "$count new similar songs"
    val match = if (minimum > 0) " ($minimum%+ sound match)" else ""
    return "Added $songs to your queue$match"
  }
}
