package com.nowplaying.discovery.engine

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToLong

/**
 * DJ-XFADE-001 — a song played a few percent faster or slower WITHOUT changing its pitch, so the
 * incoming song can be held on the outgoing song's beat for the length of a blend. The browser does
 * this for the web app (`preservesPitch`); this is the phone's own.
 *
 * It wraps a [PcmSource] and is one itself. At rate 1 it is not in the signal path at all: [read]
 * hands straight through to the wrapped source, bit for bit. Only while a tempo is set does it
 * run WSOLA (waveform-similarity overlap-add): the song is cut into 43 ms Hann-windowed pieces
 * taken at the new pace, each placed where it best continues the waveform before it, so pitch and
 * timbre stay and only the timing moves. Going back to rate 1 it carries on from the exact sample
 * it had reached, so there is no jump; the engine eases the rate there after a blend.
 *
 * Engine thread only, like every [PcmSource].
 */
class StretchSource(private val inner: PcmSource) : PcmSource {
  /** Tempo ratio: 1.04 plays 4% faster. Changes take effect at the next piece (about 21 ms). */
  var rate: Double = 1.0
    set(value) { field = if (value.isFinite()) value.coerceIn(MIN_RATE, MAX_RATE) else 1.0 }

  /** True while audio is being re-timed (or its last piece is still being played out). */
  val stretching: Boolean get() = active

  private var active = false
  /** Input held for the pieces: `buf[c][i]` is the source frame `base + i`. */
  private val buf = arrayOf(FloatArray(CAPACITY), FloatArray(CAPACITY))
  private var base = 0L
  private var len = 0
  /** Where the waveform would carry on from if nothing were re-timed. */
  private var natural = 0L
  /** Where the tempo says the next piece should come from. */
  private var ideal = 0.0
  /** The current hop: source frame its incoming piece started at, its audio, and how much is left. */
  private var segment = 0L
  private val hop = arrayOf(FloatArray(HOP), FloatArray(HOP))
  private var hopAt = HOP
  /** The song's last frame + 1, once the source has run out; padding lies beyond it. */
  private var songEnd = Long.MAX_VALUE
  private val scratch = arrayOf(FloatArray(CHUNK), FloatArray(CHUNK))

  override val durationFrames: Long get() = inner.durationFrames
  override val ready: Boolean get() = inner.ready
  override val error: Throwable? get() = inner.error
  override val ended: Boolean get() = if (active) finished() else inner.ended
  override val positionFrames: Long
    get() = if (!active) inner.positionFrames else if (hopAt < HOP) segment + hopAt else natural

  override fun seekTo(frame: Long) {
    inner.seekTo(frame)
    active = false
    len = 0
    hopAt = HOP
  }

  override fun close() = inner.close()

  override fun read(dst: Array<FloatArray>, offset: Int, frames: Int): Int {
    var done = 0
    while (done < frames) {
      if (!active) {
        if (rate == 1.0) return done + inner.read(dst, offset + done, frames - done)
        engage()
      }
      if (hopAt >= HOP) {
        if (rate == 1.0) {
          // Back at the song's own tempo: carry on from exactly where the waveform had got to.
          done += passThrough(dst, offset + done, frames - done)
          continue
        }
        if (finished() || !nextHop()) return done
      }
      val n = min(frames - done, HOP - hopAt)
      System.arraycopy(hop[0], hopAt, dst[0], offset + done, n)
      System.arraycopy(hop[1], hopAt, dst[1], offset + done, n)
      hopAt += n
      done += n
    }
    return done
  }

  /** Re-timing has played out everything the song had (what follows in the buffer is padding). */
  private fun finished(): Boolean = inner.ended && positionFrames >= songEnd

  private fun engage() {
    active = true
    songEnd = Long.MAX_VALUE
    base = inner.positionFrames
    len = 0
    natural = base
    ideal = base.toDouble()
    hopAt = HOP
  }

  /** Play out what is buffered from [natural], then hand back to the source untouched. */
  private fun passThrough(dst: Array<FloatArray>, offset: Int, frames: Int): Int {
    val held = (min(base + len, songEnd) - natural).toInt()
    if (held <= 0) {
      active = false
      len = 0
      return 0
    }
    val n = min(frames, held)
    val at = (natural - base).toInt()
    System.arraycopy(buf[0], at, dst[0], offset, n)
    System.arraycopy(buf[1], at, dst[1], offset, n)
    natural += n
    return n
  }

  /** Make the next [HOP] frames. False when the source has not delivered enough yet (an underrun). */
  private fun nextHop(): Boolean {
    val target = ideal.roundToLong()
    val lo = max(base, min(natural, target - SEARCH))
    if (!fill(lo, max(natural, target + SEARCH) + HOP + MATCH)) return false
    val from = max(lo, target - SEARCH)
    val to = target + SEARCH
    // The piece that best continues the waveform: smallest difference from the natural continuation.
    var best = target.coerceIn(from, to)
    var bestCost = Double.MAX_VALUE
    val n = (natural - base).toInt()
    var q = from
    while (q <= to) {
      val c = (q - base).toInt()
      var cost = 0.0
      var i = 0
      while (i < MATCH) {
        val d = (buf[0][c + i] + buf[1][c + i]) - (buf[0][n + i] + buf[1][n + i])
        cost += d * d
        i += MATCH_STEP
      }
      // Ties go to the piece nearest the one the tempo asked for.
      if (cost < bestCost || (cost == bestCost && abs(q - target) < abs(best - target))) {
        bestCost = cost
        best = q
      }
      q += 1
    }
    val c = (best - base).toInt()
    for (ch in 0..1) {
      val b = buf[ch]
      val h = hop[ch]
      for (i in 0 until HOP) h[i] = b[n + i] * FADE_OUT[i] + b[c + i] * FADE_IN[i]
    }
    segment = best
    natural = best + HOP
    ideal += HOP * rate
    hopAt = 0
    return true
  }

  /** Hold source frames `[from, to)`, reading ahead as needed. A finished song is padded with silence. */
  private fun fill(from: Long, to: Long): Boolean {
    // Never drop more than is held: the source's next frame is always `base + len`.
    val drop = min((from - base).toInt(), len)
    if (drop > 0) {
      for (ch in 0..1) System.arraycopy(buf[ch], drop, buf[ch], 0, len - drop)
      base += drop
      len -= drop
    }
    val want = (to - base).toInt()
    if (want > CAPACITY) return false
    while (len < want) {
      val ask = min(CHUNK, want - len)
      val got = if (inner.error != null) 0 else inner.read(scratch, 0, ask)
      System.arraycopy(scratch[0], 0, buf[0], len, got)
      System.arraycopy(scratch[1], 0, buf[1], len, got)
      len += got
      if (got < ask) {
        if (!inner.ended) return false
        if (songEnd == Long.MAX_VALUE) songEnd = base + len
        buf[0].fill(0f, len, want)
        buf[1].fill(0f, len, want)
        len = want
      }
    }
    return true
  }

  companion object {
    /** One piece is two hops long (about 43 ms at 48 kHz), overlapped by half. */
    const val HOP = 1024
    /** How far either side of the asked-for place a piece may be taken from (about 11 ms). */
    const val SEARCH = 512
    /** How much waveform is compared to choose it, and at what stride. */
    const val MATCH = 512
    const val MATCH_STEP = 2
    const val MIN_RATE = 0.9
    const val MAX_RATE = 1.1
    private const val CHUNK = 1024
    private const val CAPACITY = 16384
    /** The two halves of a Hann window; they sum to exactly one piece of unchanged audio. */
    private val FADE_IN = FloatArray(HOP) { i -> (0.5 - 0.5 * Math.cos(Math.PI * i / HOP)).toFloat() }
    private val FADE_OUT = FloatArray(HOP) { i -> 1f - FADE_IN[i] }
  }
}
