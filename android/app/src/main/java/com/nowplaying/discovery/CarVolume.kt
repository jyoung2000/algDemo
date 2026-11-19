package com.nowplaying.discovery

import kotlin.math.roundToInt

/**
 * VOLUME-BOOST-001 (owner 2026-11-19): "increase volume up to 200% with a slider or android auto". Android Auto has no
 * slider for an app, so its Volume button steps through these levels, wrapping from 200% back to 100%.
 */
object CarVolume {
  val LEVELS = doubleArrayOf(1.0, 1.25, 1.5, 1.75, 2.0)

  fun percent(v: Double): Int = ((if (v.isFinite()) v else 1.0).coerceIn(0.0, 2.0) * 100).roundToInt()

  /** The first level above [v]; 200% wraps to 100%. */
  fun next(v: Double): Double {
    if (!v.isFinite()) return LEVELS[0]
    val now = v
    return LEVELS.firstOrNull { it > now + 1e-6 } ?: LEVELS[0]
  }

  /** What the driver reads on the button (and hears from the assistant). */
  fun label(v: Double): String {
    val p = percent(v)
    return if (p >= 200) "Volume $p% \u2013 tap for 100%" else "Volume $p% \u2013 tap for louder"
  }

  /**
   * The car's choice wins until the page reports the same value. A page that was asleep wakes with its own saved
   * volume and sends it before it hears about the car's change; that stale value must not undo the driver's press.
   */
  class Owed {
    var value: Double? = null
      private set

    fun carSet(v: Double) { value = v }

    /** True when the page's volume should be applied. */
    fun pageSent(v: Double): Boolean {
      val owed = value ?: return true
      if (kotlin.math.abs(owed - v) < 0.005) { value = null; return true }
      return false
    }
  }
}
