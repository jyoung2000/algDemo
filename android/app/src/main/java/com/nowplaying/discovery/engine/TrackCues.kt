package com.nowplaying.discovery.engine

import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.ln1p
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * DJ-XFADE-001 — what a DJ listens for before mixing two songs, measured from the audio itself.
 * A line-for-line port of the pure functions in web/src/engine/track-cues.ts; TrackCuesTest checks
 * it against vectors that tools/dsp-parity/cue-vectors.mjs generates from the real TypeScript.
 *
 * A crossfade anchored to the ends of the FILES blends one song's dying tail into the next song's
 * silence, so the planner needs to know where the music really starts and stops, and where the
 * beats fall. Only the head and the tail of a song are examined.
 */

/** A beat grid near one end of a song: tempo, one beat's time in the song, and how sure it is. */
data class BeatGrid(val bpm: Double, val beatAt: Double, val confidence: Double)

data class TrackCues(
  /** Length of the audio that was measured, in seconds. */
  val duration: Double,
  /** First audible sound. */
  val start: Double,
  /** Last audible sound. */
  val end: Double,
  /** Last moment the song is still at its own level; after it the song is fading or ringing out. */
  val fullEnd: Double,
  val head: BeatGrid?,
  val tail: BeatGrid?,
)

object Cues {
  const val HEAD_SECONDS = 45.0
  const val TAIL_SECONDS = 75.0
  /** A grid is trusted at this confidence. */
  const val GRID_CONFIDENT = 1.0

  private const val ENVELOPE_SECONDS = 0.05
  private const val SILENCE_DB = 40.0
  private const val SILENCE_FLOOR_DB = -60.0
  private const val BODY_DB = 12.0
  private const val BODY_PERCENTILE = 0.7
  private const val FLUX_FPS = 86.1328125
  private const val MIN_BPM = 60
  private const val MAX_BPM = 180
  private const val PHASE_SECONDS = 20.0
  private const val TEMPO_SECONDS = 60.0
  private const val STRENGTH_FLOOR = 0.1
  private const val CONTRAST_FLOOR = 2.5
  private const val STABLE_SECONDS = 0.03
  private const val EDGE_SECONDS = 10.0

  class Flux(val flux: DoubleArray, val fps: Double)
  class Tempo(val bpm: Double, val strength: Double)
  class Phase(val frame: Double, val contrast: Double)
  private class Grid(val bpm: Double, val anchor: Double, val confidence: Double)

  /** JS `Math.round` for the non-negative values used here. */
  private fun jsRound(x: Double): Double = floor(x + 0.5)

  /** RMS level per 50 ms, in dB. */
  fun envelopeDb(x: FloatArray, rate: Double, from: Int = 0, to: Int = x.size): DoubleArray {
    val size = max(1, floor(rate * ENVELOPE_SECONDS).toInt())
    val frames = max(0, (to - from) / size)
    val out = DoubleArray(frames)
    for (f in 0 until frames) {
      var sum = 0.0
      val base = from + f * size
      for (i in 0 until size) {
        val v = x[base + i].toDouble()
        sum += v * v
      }
      out[f] = 10 * log10(sum / size + 1e-12)
    }
    return out
  }

  private fun percentile(values: DoubleArray, share: Double): Double {
    if (values.isEmpty()) return -120.0
    val sorted = values.copyOf()
    sorted.sort()
    return sorted[floor(share * (sorted.size - 1)).toInt()]
  }

  /** Onset strength per ~11.6 ms: the rise in level of the lows, mids and highs, local average removed. */
  fun onsetFlux(x: FloatArray, rate: Double, from: Int = 0, to: Int = x.size): Flux {
    val hop = max(1, jsRound(rate / FLUX_FPS).toInt())
    val fps = rate / hop
    val frames = max(0, (to - from) / hop)
    val raw = DoubleArray(frames)
    val aLow = 1 - exp((-2 * Math.PI * 200) / rate)
    val aMid = 1 - exp((-2 * Math.PI * 2000) / rate)
    var low = 0.0
    var wide = 0.0
    var pLow = 0.0
    var pMid = 0.0
    var pHigh = 0.0
    for (f in 0 until frames) {
      var eLow = 0.0
      var eMid = 0.0
      var eHigh = 0.0
      val base = from + f * hop
      for (i in 0 until hop) {
        val v = x[base + i].toDouble()
        low += aLow * (v - low)
        wide += aMid * (v - wide)
        val mid = wide - low
        val high = v - wide
        eLow += low * low
        eMid += mid * mid
        eHigh += high * high
      }
      val cLow = ln1p(100 * sqrt(eLow / hop))
      val cMid = ln1p(100 * sqrt(eMid / hop))
      val cHigh = ln1p(100 * sqrt(eHigh / hop))
      raw[f] = if (f == 0) 0.0 else max(0.0, cLow - pLow) + max(0.0, cMid - pMid) + max(0.0, cHigh - pHigh)
      pLow = cLow
      pMid = cMid
      pHigh = cHigh
    }
    val window = max(1, jsRound(fps).toInt())
    val before = window / 2
    val prefix = DoubleArray(frames + 1)
    for (i in 0 until frames) prefix[i + 1] = prefix[i] + raw[i]
    val flux = DoubleArray(frames)
    for (i in 0 until frames) {
      val a = max(0, i - before)
      val b = min(frames, i - before + window)
      flux[i] = max(0.0, raw[i] - (prefix[b] - prefix[a]) / window)
    }
    return Flux(flux, fps)
  }

  private fun lerpAt(v: DoubleArray, at: Double): Double {
    val i = floor(at).toInt()
    if (i < 0 || i + 1 >= v.size) return 0.0
    val frac = at - i
    return v[i] * (1 - frac) + v[i + 1] * frac
  }

  /** Tempo of an onset curve from its autocorrelation, or null when it is too short or flat. */
  fun tempoOf(flux: DoubleArray, fps: Double): Tempo? {
    val n = flux.size
    if (n < fps * 8) return null
    var mean = 0.0
    for (i in 0 until n) mean += flux[i]
    mean /= n
    val maxLag = min(floor(((fps * 60) / MIN_BPM) * 8).toInt() + 2, n / 2)
    val ac = DoubleArray(maxLag + 1)
    for (lag in 0..maxLag) {
      var sum = 0.0
      var i = 0
      while (i + lag < n) {
        sum += (flux[i] - mean) * (flux[i + lag] - mean)
        i += 1
      }
      ac[lag] = sum / (n - lag)
    }
    val zero = ac[0]
    if (!(zero > 0)) return null
    for (lag in 0..maxLag) ac[lag] = ac[lag] / zero
    fun score(bpm: Double, multiples: Int): Double {
      val lag = (fps * 60) / bpm
      var sum = 0.0
      var used = 0
      for (k in 1..multiples) {
        if (k * lag >= maxLag - 1) break
        sum += lerpAt(ac, k * lag)
        used += 1
      }
      return if (used > 0) sum / used else Double.NEGATIVE_INFINITY
    }
    var best = Double.NEGATIVE_INFINITY
    var bpm = 0.0
    for (step in MIN_BPM * 2..MAX_BPM * 2) {
      val candidate = step / 2.0
      val fold = ln(candidate / 118) / ln(2.0)
      val weighted = score(candidate, 4) * exp(-0.5 * fold * fold)
      if (weighted > best) {
        best = weighted
        bpm = candidate
      }
    }
    if (!(best > 0)) return null
    var fine = Double.NEGATIVE_INFINITY
    var refined = bpm
    for (d in -30..30) {
      val candidate = bpm + d / 50.0
      val s = score(candidate, 8)
      if (s > fine) {
        fine = s
        refined = candidate
      }
    }
    return Tempo(refined, best)
  }

  /** Where the beats fall in an onset curve of known tempo: first beat's frame, and how clearly. */
  fun phaseOf(flux: DoubleArray, fps: Double, bpm: Double, from: Int = 0, to: Int = flux.size): Phase? {
    val lag = (fps * 60) / bpm
    val n = to - from
    val beats = floor((n - 1) / lag).toInt() - 1
    if (beats < 4) return null
    val steps = ceil(lag * 4).toInt()
    var best = -1.0
    var bestAt = 0
    var total = 0.0
    for (q in 0 until steps) {
      var sum = 0.0
      for (k in 0 until beats) {
        val at = q / 4.0 + lag * k
        val i = floor(at).toInt()
        val frac = at - i
        sum += flux[from + i] * (1 - frac) + flux[min(from + i + 1, to - 1)] * frac
      }
      total += sum
      if (sum > best) {
        best = sum
        bestAt = q
      }
    }
    return Phase(bestAt / 4.0, best / (total / steps + 1e-12))
  }

  /** How far apart two beat times are on one grid, folded to the nearest beat: -beat/2 .. beat/2. */
  fun beatError(a: Double, b: Double, beat: Double): Double {
    val wrapped = (((a - b) % beat) + beat) % beat
    return if (wrapped > beat / 2) wrapped - beat else wrapped
  }

  private fun steadyGrid(flux: DoubleArray, fps: Double, tempo: Tempo, from: Int, third: Int, atStart: Boolean): Grid? {
    val first = phaseOf(flux, fps, tempo.bpm, from, from + third) ?: return null
    val middle = phaseOf(flux, fps, tempo.bpm, from + third, from + 2 * third) ?: return null
    val last = phaseOf(flux, fps, tempo.bpm, from + 2 * third, from + 3 * third) ?: return null
    val a = from + first.frame
    val m = from + third + middle.frame
    val b = from + 2 * third + last.frame
    val coarse = (fps * 60) / tempo.bpm
    val beats = jsRoundSigned((b - a) / coarse)
    if (beats < 1) return null
    val lag = (b - a) / beats
    if (abs(lag / coarse - 1) > 0.01) return null
    val bpm = (fps * 60) / lag
    val span = min(third, floor(EDGE_SECONDS * fps).toInt())
    val edgeFrom = if (atStart) from else from + 3 * third - span
    val near = phaseOf(flux, fps, bpm, edgeFrom, edgeFrom + span) ?: return null
    val anchor = edgeFrom + near.frame
    val drift = max(abs(beatError(m / fps, a / fps, lag / fps)), abs(beatError(anchor / fps, (if (atStart) a else b) / fps, lag / fps)))
    val contrast = min(first.contrast, min(last.contrast, near.contrast))
    val confidence = min(tempo.strength / STRENGTH_FLOOR, min(contrast / CONTRAST_FLOOR, STABLE_SECONDS / max(drift, 1e-6)))
    return Grid(bpm, anchor, confidence)
  }

  /** JS `Math.round` (halves toward +infinity) for a value that may be negative. */
  private fun jsRoundSigned(x: Double): Double {
    val f = floor(x)
    return if (x - f >= 0.5) f + 1 else f
  }

  /** Measure a song from all of its audio. */
  fun analyseCues(mono: FloatArray, rate: Double): TrackCues = analyseEnds(mono, mono, rate, mono.size / rate)

  /**
   * The same measurement from the two ends alone: [head] is the song's first seconds and [tail] its
   * last, each as long as is available (up to HEAD_SECONDS / TAIL_SECONDS are used).
   */
  fun analyseEnds(head: FloatArray, tail: FloatArray, rate: Double, duration: Double): TrackCues {
    val headTo = min(head.size, floor(HEAD_SECONDS * rate).toInt())
    val tailFrom = max(0, tail.size - floor(TAIL_SECONDS * rate).toInt())
    val tailOffset = duration - (tail.size - tailFrom) / rate
    val size = max(1, floor(rate * ENVELOPE_SECONDS).toInt())
    val step = size / rate

    val headEnv = envelopeDb(head, rate, 0, headTo)
    val headBody = percentile(headEnv, BODY_PERCENTILE)
    var first = 0
    while (first < headEnv.size && !(headEnv[first] > min(headBody - SILENCE_DB, SILENCE_FLOOR_DB))) first += 1
    val start = if (first >= headEnv.size) 0.0 else first * step

    val tailEnv = envelopeDb(tail, rate, tailFrom, tail.size)
    val tailBody = percentile(tailEnv, BODY_PERCENTILE)
    var last = tailEnv.size - 1
    while (last >= 0 && !(tailEnv[last] > min(tailBody - SILENCE_DB, SILENCE_FLOOR_DB))) last -= 1
    var full = tailEnv.size - 1
    while (full >= 0 && !(tailEnv[full] > tailBody - BODY_DB)) full -= 1
    fun edge(frame: Int): Double = if (frame >= tailEnv.size - 1) duration else min(duration, tailOffset + (frame + 1) * step)
    val end = if (last < 0) duration else edge(last)
    val fullEnd = if (full < 0) end else min(end, edge(full))

    return TrackCues(duration, start, end, fullEnd, headGrid(head, rate, start, headTo), tailGrid(tail, rate, tailFrom, tailOffset, fullEnd))
  }

  private fun headGrid(head: FloatArray, rate: Double, start: Double, to: Int): BeatGrid? {
    val from = min(to, floor(start * rate).toInt())
    val f = onsetFlux(head, rate, from, to)
    val tempo = tempoOf(f.flux, f.fps) ?: return null
    val grid = steadyGrid(f.flux, f.fps, tempo, 0, min(floor(PHASE_SECONDS * f.fps).toInt(), f.flux.size / 3), true) ?: return null
    return BeatGrid(grid.bpm, from / rate + grid.anchor / f.fps, grid.confidence)
  }

  private fun tailGrid(tail: FloatArray, rate: Double, tailFrom: Int, tailOffset: Double, fullEnd: Double): BeatGrid? {
    val to = max(tailFrom, min(tail.size, tailFrom + floor((fullEnd - tailOffset) * rate).toInt()))
    val from = max(tailFrom, to - floor(TEMPO_SECONDS * rate).toInt())
    val f = onsetFlux(tail, rate, from, to)
    val tempo = tempoOf(f.flux, f.fps) ?: return null
    val third = min(floor(PHASE_SECONDS * f.fps).toInt(), f.flux.size / 3)
    val grid = steadyGrid(f.flux, f.fps, tempo, f.flux.size - 3 * third, third, false) ?: return null
    val beat = 60 / grid.bpm
    val firstBeat = tailOffset + (from - tailFrom) / rate + grid.anchor / f.fps
    val beatAt = firstBeat + floor((fullEnd - firstBeat) / beat) * beat
    return BeatGrid(grid.bpm, beatAt, grid.confidence)
  }

  /** True when a measured grid is sure enough to mix on. */
  fun gridUsable(grid: BeatGrid?): Boolean =
    grid != null && grid.bpm.isFinite() && grid.bpm > 0 && grid.beatAt.isFinite() && grid.confidence >= GRID_CONFIDENT
}
