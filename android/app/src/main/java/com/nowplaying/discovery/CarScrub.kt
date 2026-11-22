package com.nowplaying.discovery

/**
 * CAR-SCRUB-001 (owner, 2026-11-22): "on android auto let the user hold down the skip and back arrows to x2 scrub
 * through the current song and adjust the player progress just by using the in car / android auto buttons".
 *
 * A tap on Next or Previous still skips. Held past [HOLD_MS] (a key that repeats, or one marked as a long press), the
 * song moves at twice real time, forward for Next and backward for Previous, until the button is let go; letting go
 * then does not skip. Fast forward and Rewind keys scrub for as long as they are held. Pure Kotlin: the clock and the
 * timer are passed in, so the rules run under JVM tests.
 */
class CarScrub(
  private val now: () -> Long,
  private val later: (delayMs: Long, run: () -> Unit) -> Any,
  private val cancel: (Any) -> Unit,
  private val positionMs: () -> Long,
  private val durationMs: () -> Long,
  private val seek: (Long) -> Unit,
  private val skip: (forward: Boolean) -> Unit,
) {
  enum class Key { NEXT, PREVIOUS, FAST_FORWARD, REWIND }

  private var held: Key? = null
  private var holdTimer: Any? = null
  private var tickTimer: Any? = null
  private var scrubbing = false
  /** This press already scrubbed (it may have stopped by itself at the start or end): letting go never skips. */
  private var scrubbed = false
  private var dir = 1
  private var fromMs = 0L
  private var startedAt = 0L

  val isScrubbing: Boolean get() = scrubbing

  /** One key event. [repeat] is the key's repeat count; [longPress] its long-press flag. True when handled here. */
  fun key(key: Key, down: Boolean, repeat: Int = 0, longPress: Boolean = false): Boolean {
    val forward = key == Key.NEXT || key == Key.FAST_FORWARD
    if (down) {
      if (key == Key.FAST_FORWARD || key == Key.REWIND) { held = key; if (!scrubbing) start(forward); return true }
      if (repeat > 0 || longPress) {
        held = key
        clearHold()
        if (!scrubbing && !scrubbed) start(forward)
        return true
      }
      if (held == key && (holdTimer != null || scrubbing || scrubbed)) return true
      held = key
      scrubbed = false
      clearHold()
      holdTimer = later(HOLD_MS) { holdTimer = null; if (held == key && !scrubbing) start(forward) }
      return true
    }
    // Let go.
    val was = held
    held = null
    clearHold()
    if (scrubbing) { stop(); scrubbed = false; return true }
    if (scrubbed) { scrubbed = false; return true }
    if (key == Key.FAST_FORWARD || key == Key.REWIND) return true
    if (was == key || was == null) skip(forward)
    return true
  }

  /** Stops any scrub (the song changed, playback stopped). */
  fun reset() { held = null; scrubbed = false; clearHold(); if (scrubbing) stop() }

  private fun start(forward: Boolean) {
    scrubbing = true
    scrubbed = true
    dir = if (forward) 1 else -1
    fromMs = positionMs().coerceAtLeast(0)
    startedAt = now()
    tick()
  }

  private fun tick() {
    tickTimer = null
    if (!scrubbing) return
    val elapsed = now() - startedAt
    val end = durationMs().let { if (it > END_GAP_MS) it - END_GAP_MS else Long.MAX_VALUE }
    val target = (fromMs + dir * SPEED * elapsed).coerceIn(0, end)
    seek(target)
    // Safety: a key release the car never sent must not scrub forever.
    if (elapsed >= MAX_MS || (dir < 0 && target == 0L) || (dir > 0 && target == end)) { stop(); return }
    tickTimer = later(TICK_MS) { tick() }
  }

  private fun stop() {
    scrubbing = false
    tickTimer?.let(cancel); tickTimer = null
  }

  private fun clearHold() { holdTimer?.let(cancel); holdTimer = null }

  companion object {
    const val HOLD_MS = 500L
    const val TICK_MS = 200L
    /** Twice real time. */
    const val SPEED = 2L
    /** A forward scrub stops this far before the end, so it never runs the song out by itself. */
    const val END_GAP_MS = 1500L
    const val MAX_MS = 120_000L
  }
}
