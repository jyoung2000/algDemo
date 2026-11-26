package com.nowplaying.discovery

/**
 * MOOD-DEFAULT-CAR-001 (owner, 2026-11-25): "ensure the discover tab by default tries to find music based on your
 * current listening mood, ensure it works on windows, android, and android auto". Android Auto has no Discover tab
 * (four tabs at most), so Playlists > "Discover for my mood" runs the phone's Discover run, which starts from the
 * listening mood, and the new songs join the end of the car's now playing queue.
 */
object CarMoodDiscover {
  /** The row under Playlists. Has a '/', so it can never be taken for a queue song id. */
  const val ID = "car/mood/discover"
  /** Opening the row again this soon after a run shows that run's answer instead of starting another. */
  const val SHOW_ANSWER_MS = 20_000L

  fun subtitle(moodOn: Boolean, busy: Boolean): String = when {
    busy -> "Finding songs\u2026 they join the end of your queue"
    moodOn -> "New songs for how you are listening now"
    else -> "Follow my listening mood is off; finds songs from your taste"
  }

  /** What the car says when a run ends. */
  fun answerText(added: Int, leading: List<String>, reason: String): String {
    if (added <= 0) return reason.ifBlank { "No new songs for this mood right now. Your queue is unchanged." }
    val mood = if (leading.isEmpty()) " for your mood" else " for your mood (${leading.take(3).joinToString(" \u00b7 ")})"
    return "Added $added new song${if (added == 1) "" else "s"}$mood."
  }
}
