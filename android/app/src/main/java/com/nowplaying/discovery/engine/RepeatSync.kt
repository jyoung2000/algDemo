package com.nowplaying.discovery.engine

/**
 * REPEAT-COUNT-001: who holds the repeat setting when the page and the service both change it.
 *
 * The page sends its setting with every list push. The service also changes it by itself: it
 * counts an extra play down when that play really starts, drops a count when the listener leaves
 * the song, and takes the car's repeat button. A push the page made before it heard of such a
 * change still carries the old value, and applying it would put the old count back.
 *
 * So a service-made value is [owed] to the page until the page echoes it. Until then an unchanged
 * page value is stale and ignored, and so is the first value of a page that has just opened (it
 * saved that before it was told); a value the page newly changed to is the listener's own choice
 * on the phone and wins. Modes are the wire numbers (0 off, 1 infinite, 3 one extra, 4 two extra).
 */
class RepeatSync {
  private var seen = -1

  /** A value the service set itself that the page has not sent back yet. */
  var owed: Int? = null
    private set

  fun serviceSet(mode: Int) { owed = mode }

  /** The page sent [mode]. Returns the mode to apply, or null to keep what the service has. */
  fun fromPage(mode: Int): Int? {
    // A page that has only just opened is sending what it saved last time, not a new choice.
    val changed = seen != -1 && mode != seen
    seen = mode
    val waiting = owed ?: return mode
    return when {
      mode == waiting -> { owed = null; null }
      !changed -> null
      else -> { owed = null; mode }
    }
  }
}
