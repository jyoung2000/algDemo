package com.nowplaying.discovery.engine

import com.nowplaying.discovery.dsp.TransitionStyle
import java.math.BigDecimal
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * MIXER-001 — the single mixing slider and the crossfade maths behind it. A line-for-line port of
 * the pure functions in web/src/engine/crossfade.ts; MixPlanTest checks it against vectors that
 * tools/dsp-parity/mix-plan-vectors.mjs generates from the real TypeScript.
 *
 * JS semantics are kept on purpose: every number is a Double, `null` stands for an unknown value
 * (the TS `undefined`/`null`/NaN), rounding is JS `Math.round` (half toward +infinity) and the
 * description prints numbers the way JS template literals do ("3", not "3.0").
 */

/** The five words under the slider (crossfade.ts `MIX_LABELS`). */
enum class MixLabel(val text: String) {
  OFF("Off"),
  SUBTLE("Subtle"),
  SMOOTH("Smooth"),
  CREATIVE("Creative"),
  LONG_AND_CREATIVE("Long & Creative");

  companion object {
    fun of(text: String): MixLabel = entries.firstOrNull { it.text == text } ?: throw IllegalArgumentException("unknown mix label $text")
  }
}

/** crossfade.ts `TempoRelation`. */
enum class TempoRelation(val id: String) {
  SAME("same"),
  HALF_OR_DOUBLE("half-or-double"),
  UNRELATED("unrelated"),
  UNKNOWN("unknown");

  companion object {
    fun of(id: String): TempoRelation = entries.firstOrNull { it.id == id } ?: throw IllegalArgumentException("unknown tempo relation $id")
  }
}

/** crossfade.ts `MixReason`. */
enum class MixReason(val id: String) {
  OFF("off"),
  AS_REQUESTED("as-requested"),
  KEPT_FOR_SONG("kept-for-song"),
  SHORTENED_FOR_PAIR("shortened-for-pair"),
  TOO_SHORT_TO_BLEND("too-short-to-blend");

  companion object {
    fun of(id: String): MixReason = entries.firstOrNull { it.id == id } ?: throw IllegalArgumentException("unknown mix reason $id")
  }
}

/** One band of the slider: its label and the overlap range it asks for, in seconds. */
data class MixBand(val label: MixLabel, val lo: Double, val hi: Double)

/** `quantizeToBars` result: the shortened length and the whole bars it spans (0 = not quantised). */
data class BarFit(val seconds: Double, val bars: Double)

/**
 * What the planner knows about the two songs beyond their length (crossfade.ts `MixInputs`).
 * `null` is "not given": the default play-through share, an unknown tempo.
 */
data class MixInputs(
  /** Share of the outgoing song that must play before the blend starts (0.5..1). Default 0.95. */
  val minPlayedFraction: Double? = null,
  val outBpm: Double? = null,
  val inBpm: Double? = null,
)

/** crossfade.ts `MixPlan`: the blend for one pair of songs. */
data class MixPlan(
  /** Seconds of overlap actually scheduled. 0 means a clean handoff. */
  val seconds: Double,
  /** Where in the outgoing track the blend begins, in seconds from its start. */
  val startAt: Double,
  val label: MixLabel,
  val requested: Double,
  val reason: MixReason,
  /** Whole bars the blend spans, or 0 when it could not be quantised. */
  val bars: Double,
  /** How the two tempos relate, which is why the blend was or was not beat-matched. */
  val tempo: TempoRelation,
  /** Playback rate for the incoming deck. 1 means leave it alone. */
  val rate: Double,
  /** What the transition is allowed to do. */
  val style: TransitionStyle,
  /** One read-only line for the UI, e.g. "Smooth • about 9 seconds". */
  val description: String,
)

object Crossfade {
  /** MIXER-001: the five words under the slider. */
  val MIX_LABELS: List<String> = MixLabel.entries.map { it.text }

  const val MIX_MIN = 0.0
  const val MIX_MAX = 100.0

  private class Band(val upTo: Double, val label: MixLabel, val lo: Double, val hi: Double)

  /**
   * MIXER-001: requested overlap for each band of the slider, in seconds. A request is an upper
   * bound that [mixPlan] clamps against the material.
   */
  private val BANDS = listOf(
    Band(0.0, MixLabel.OFF, 0.0, 0.0),
    Band(25.0, MixLabel.SUBTLE, 0.5, 6.0),
    Band(50.0, MixLabel.SMOOTH, 6.0, 16.0),
    Band(75.0, MixLabel.CREATIVE, 16.0, 32.0),
    Band(100.0, MixLabel.LONG_AND_CREATIVE, 32.0, 64.0),
  )

  /**
   * MIXER-PLAY-THROUGH-001: every song plays at least this much of its length before the next one
   * is blended in, so at most 5% of the outgoing song overlaps, whatever the slider asks.
   */
  const val MIN_PLAYED_FRACTION = 0.95

  /** MIXER-PLAY-THROUGH-002: the "Play before blending" setting's range, as a percentage. */
  const val PLAY_THROUGH_MIN = 50.0
  const val PLAY_THROUGH_MAX = 100.0
  val PLAY_THROUGH_DEFAULT: Double = jsRound(MIN_PLAYED_FRACTION * 100)

  /** No blend may eat more than this share of the INCOMING track. */
  const val MAX_TRACK_FRACTION = 0.4

  /** Below this there is nothing to fade; hand over cleanly instead. */
  const val MIN_USEFUL_SECONDS = 0.25

  /** Beats per bar assumed for quantising. */
  const val BEATS_PER_BAR = 4.0

  /** How far the incoming track's tempo may be nudged to meet the outgoing one, as a ratio. */
  const val MAX_TEMPO_NUDGE = 0.06

  /** Two tempos this close (after half/double folding) count as the same grid. Tied to [MAX_TEMPO_NUDGE]. */
  const val TEMPO_MATCH_TOLERANCE = MAX_TEMPO_NUDGE

  /**
   * MIXER-PLAY-THROUGH-002: the listener's play-through setting, clamped to 50..100 and rounded, or
   * the default (95) when it is missing or not finite.
   *
   * The TS takes `unknown` and coerces with `Number(v)`; here `null` means `undefined` (-> 95).
   * Coercing strings, booleans or a JS `null` (Number(null) = 0 -> 50) is the caller's job.
   */
  fun clampPlayThrough(v: Double?): Double =
    if (v != null && v.isFinite()) jsRound(clamp(v, PLAY_THROUGH_MIN, PLAY_THROUGH_MAX)) else PLAY_THROUGH_DEFAULT

  /**
   * MIXER-PLAY-THROUGH-001/-002: the fraction the plan uses for a setting, or the default (0.95)
   * when the value is out of 0.5..1 or missing.
   */
  fun playedFraction(v: Double?): Double =
    if (v != null && v.isFinite() && v >= PLAY_THROUGH_MIN / 100 && v <= PLAY_THROUGH_MAX / 100) v else MIN_PLAYED_FRACTION

  /** MIXER-001: seconds in one bar at this tempo, or null when the tempo is unknown. */
  fun barSeconds(bpm: Double?): Double? {
    if (bpm == null || !bpm.isFinite() || bpm <= 0) return null
    return (BEATS_PER_BAR * 60) / bpm
  }

  /** MIXER-001: how two tempos relate, folding half and double time together. */
  fun tempoRelation(outBpm: Double?, inBpm: Double?): TempoRelation {
    // Number(null) is 0 and Number(undefined) NaN: both land on 'unknown'.
    val a = outBpm ?: Double.NaN
    val b = inBpm ?: Double.NaN
    if (!a.isFinite() || !b.isFinite() || a <= 0 || b <= 0) return TempoRelation.UNKNOWN
    fun near(x: Double, y: Double) = abs(x - y) / max(x, y) <= TEMPO_MATCH_TOLERANCE
    if (near(a, b)) return TempoRelation.SAME
    if (near(a * 2, b) || near(a, b * 2)) return TempoRelation.HALF_OR_DOUBLE
    return TempoRelation.UNRELATED
  }

  /**
   * MIXER-001: the playback rate that lines the incoming deck's beat grid up with the outgoing one;
   * 1 when the tempos are unknown, half/double, already matched or too far apart to bridge.
   */
  fun tempoNudge(outBpm: Double?, inBpm: Double?): Double {
    val rel = tempoRelation(outBpm, inBpm)
    if (rel == TempoRelation.UNKNOWN || rel == TempoRelation.UNRELATED || rel == TempoRelation.HALF_OR_DOUBLE) return 1.0
    val ratio = outBpm!! / inBpm!!
    if (!ratio.isFinite() || ratio <= 0) return 1.0
    return clamp(ratio, 1 - MAX_TEMPO_NUDGE, 1 + MAX_TEMPO_NUDGE)
  }

  /**
   * MIXER-001: shorten a blend DOWN to a whole number of bars. Returns the original length when the
   * tempo is unknown or a single bar will not fit; a non-finite or non-positive length becomes
   * `max(0, seconds || 0)` exactly as in the TS (NaN -> 0, +Infinity stays, negatives -> 0).
   */
  fun quantizeToBars(seconds: Double, bpm: Double?): BarFit {
    val bar = barSeconds(bpm)
    if (bar == null || bar == 0.0 || !seconds.isFinite() || seconds <= 0) {
      val falsyToZero = if (seconds.isNaN() || seconds == 0.0) 0.0 else seconds
      return BarFit(max(0.0, falsyToZero), 0.0)
    }
    val bars = floor(seconds / bar)
    if (bars < 1) return BarFit(seconds, 0.0)
    return BarFit(bars * bar, bars)
  }

  /** MIXER-001: which techniques the slider has unlocked. Higher asks for more, never more volume. */
  fun transitionStyle(slider: Double): TransitionStyle {
    val s = clampSlider(slider)
    if (s <= 0) return TransitionStyle.CUT
    if (s <= 25) return TransitionStyle.BLEND
    if (s <= 50) return TransitionStyle.BASS_SWAP
    return TransitionStyle.FILTER
  }

  /** MIXER-001: the slider clamped to 0..100 and rounded (JS `Math.round`); 0 when not finite. */
  fun clampSlider(v: Double): Double = if (v.isFinite()) jsRound(clamp(v, MIX_MIN, MIX_MAX)) else MIX_MIN

  /** MIXER-001: which band a slider value sits in. */
  fun mixBand(slider: Double): MixBand {
    val s = clampSlider(slider)
    val band = BANDS.firstOrNull { s <= it.upTo } ?: BANDS.last()
    return MixBand(band.label, band.lo, band.hi)
  }

  /** MIXER-001: the word under the slider. */
  fun mixLabel(slider: Double): MixLabel = mixBand(slider).label

  /** MIXER-001: the overlap the slider is asking for, before the material gets a say. */
  fun requestedSeconds(slider: Double): Double {
    val s = clampSlider(slider)
    if (s <= 0) return 0.0
    val index = BANDS.indexOfFirst { s <= it.upTo }
    val band = BANDS[index]
    val prev = if (index > 0) BANDS[index - 1].upTo else 0.0
    val span = band.upTo - prev
    val t = if (span <= 0) 1.0 else (s - prev) / span
    return band.lo + (band.hi - band.lo) * t
  }

  /**
   * MIXER-001, MIXER-PLAY-THROUGH-001/-002: work out the blend for one pair of songs.
   *
   * An unknown length (0, negative, NaN, Infinity) skips the blend. The overlap is the slider's
   * request capped by the outgoing song's tail (1 - play-through share) and 40% of the incoming
   * song; with related tempos it snaps DOWN to whole bars of the outgoing song and the incoming deck
   * gets a playback rate within ±6%.
   */
  fun mixPlan(slider: Double, outSeconds: Double, inSeconds: Double, inputs: MixInputs = MixInputs()): MixPlan {
    val s = clampSlider(slider)
    val label = mixLabel(s)
    val requested = requestedSeconds(s)
    fun known(n: Double) = n.isFinite() && n > 0
    val style = transitionStyle(s)
    val tempo = tempoRelation(inputs.outBpm, inputs.inBpm)
    fun flat(seconds: Double, startAt: Double, reason: MixReason, description: String, style: TransitionStyle = transitionStyle(s)) =
      MixPlan(seconds, startAt, label, requested, reason, 0.0, tempo, 1.0, style, description)

    if (s <= 0) {
      return flat(0.0, if (known(outSeconds)) outSeconds else 0.0, MixReason.OFF, describe(label, 0.0, MixReason.OFF), TransitionStyle.CUT)
    }
    if (!known(outSeconds) || !known(inSeconds)) {
      return flat(0.0, if (known(outSeconds)) outSeconds else 0.0, MixReason.TOO_SHORT_TO_BLEND, describe(label, 0.0, MixReason.TOO_SHORT_TO_BLEND))
    }

    val songCeiling = outSeconds * (1 - playedFraction(inputs.minPlayedFraction))
    val pairCeiling = inSeconds * MAX_TRACK_FRACTION
    val capped = min(requested, min(songCeiling, pairCeiling))
    val quantised = if (tempo == TempoRelation.UNRELATED || tempo == TempoRelation.UNKNOWN) BarFit(capped, 0.0) else quantizeToBars(capped, inputs.outBpm)
    val seconds = quantised.seconds
    if (seconds < MIN_USEFUL_SECONDS) {
      return flat(0.0, outSeconds, MixReason.TOO_SHORT_TO_BLEND, describe(label, 0.0, MixReason.TOO_SHORT_TO_BLEND))
    }
    val reason = when {
      capped >= requested - 0.05 -> MixReason.AS_REQUESTED
      songCeiling <= pairCeiling -> MixReason.KEPT_FOR_SONG
      else -> MixReason.SHORTENED_FOR_PAIR
    }
    return MixPlan(
      seconds = seconds,
      startAt = max(0.0, outSeconds - seconds),
      label = label,
      requested = requested,
      reason = reason,
      bars = quantised.bars,
      tempo = tempo,
      rate = tempoNudge(inputs.outBpm, inputs.inBpm),
      style = style,
      description = describe(label, seconds, reason, quantised.bars, tempo),
    )
  }

  private fun describe(label: MixLabel, seconds: Double, reason: MixReason, bars: Double = 0.0, tempo: TempoRelation = TempoRelation.UNKNOWN): String {
    if (reason == MixReason.OFF) return "Off • songs play one after another"
    if (reason == MixReason.TOO_SHORT_TO_BLEND) return "${label.text} • too short to blend, clean handoff"
    val about = if (seconds >= 10) jsString(jsRound(seconds)) else jsString(round1(seconds))
    val tail = when (reason) {
      MixReason.KEPT_FOR_SONG -> ", kept so the song plays through"
      MixReason.SHORTENED_FOR_PAIR -> ", shortened for this pair"
      else -> ""
    }
    val beat = when {
      bars > 0 -> ", ${jsString(bars)} ${if (bars == 1.0) "bar" else "bars"} on the beat"
      tempo == TempoRelation.UNRELATED -> ", tempos too far apart to beat-match"
      else -> ""
    }
    return "${label.text} • about $about seconds$tail$beat"
  }

  private fun round1(n: Double) = jsRound(n * 10) / 10

  /** crossfade.ts `clamp`: `Math.max(lo, Math.min(hi, n))`. */
  private fun clamp(n: Double, lo: Double, hi: Double) = max(lo, min(hi, n))

  /**
   * JS `Math.round`: halves go toward +infinity (-2.5 -> -2), unlike [kotlin.math.roundToLong]'s
   * half-away-from-zero, and 0.49999999999999994 -> 0 (a naive `floor(x + 0.5)` gives 1).
   */
  internal fun jsRound(x: Double): Double {
    if (!x.isFinite()) return x
    val f = floor(x)
    return if (x - f >= 0.5) f + 1 else f
  }

  /**
   * JS `Number.prototype.toString` for the values a description holds: integers print without a
   * fraction ("3", not Kotlin's "3.0"), other values in plain decimal digits.
   */
  internal fun jsString(x: Double): String = when {
    x.isNaN() -> "NaN"
    x == Double.POSITIVE_INFINITY -> "Infinity"
    x == Double.NEGATIVE_INFINITY -> "-Infinity"
    x == 0.0 -> "0"
    x == floor(x) && abs(x) < 1e21 -> BigDecimal(x).toPlainString()
    else -> BigDecimal(x.toString()).stripTrailingZeros().toPlainString()
  }
}

/**
 * The app's planner for the engine, called exactly as PreviewMixer calls `mixPlan`: no tempos, the
 * play-through share given (MIXER-PLAY-THROUGH-001/-002).
 */
val CrossfadePlanner = BlendPlanner { slider, outSeconds, inSeconds, minPlayedFraction ->
  val p = Crossfade.mixPlan(slider.toDouble(), outSeconds, inSeconds, MixInputs(minPlayedFraction = minPlayedFraction))
  BlendPlan(p.seconds, p.startAt, p.style)
}
