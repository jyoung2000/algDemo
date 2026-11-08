package com.nowplaying.discovery.dsp

import java.util.IdentityHashMap
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/** crossfade.ts `TransitionStyle`. */
enum class TransitionStyle(val id: String) {
  CUT("cut"),
  BLEND("blend"),
  BASS_SWAP("bass-swap"),
  FILTER("filter");

  companion object {
    fun of(id: String): TransitionStyle = entries.firstOrNull { it.id == id } ?: throw IllegalArgumentException("unknown transition style $id")
  }
}

/**
 * The two-deck mixer. Port of web/src/engine/audio-bus.ts `createAudioBus`:
 *
 * `per deck: source → EqChain → lowshelf 180 Hz (bass) → highpass sweep (Q 0.7, parked at 20 Hz)
 * → deck gain → master gain → DynamicsCompressor (eq.ts LIMITER) → output`.
 *
 * It carries the bus's automation MIRROR too (`valueAt`, `hold`, `setParam`, `rampParam`,
 * `chainParam`, `rampCurve`, `resetFilter`, `restFilters`) because the bus reads its own record of
 * every ramp to anchor the next one — those values are what the audio does, so they are ported
 * statement by statement in double precision, as JS computes them.
 *
 * Main-thread calls ([attach], [setEq], [crossfadeTo], [transitionTo], [cut], [setMasterGain]) act at
 * [currentTime], between quanta; [process] renders one 128-frame quantum.
 */
class MixBus(val ctx: RenderContext = RenderContext(), initialEq: EqConfig = EqConfig.DEFAULTS) {
  class Deck internal constructor(
    val id: String,
    val source: SourceNode,
    val gain: GainNode,
    val eq: EqChain,
    val bass: BiquadFilterNode,
    val sweep: BiquadFilterNode,
  )

  private class Automation(val start: Double, val seconds: Double, val values: DoubleArray, val exponential: Boolean = false)

  val master = GainNode(ctx)
  val limiter = DynamicsCompressorNode(ctx)
  private val decks = LinkedHashMap<String, Deck>()
  private val automation = IdentityHashMap<AudioParam, Automation>()
  private var liveDeck = "a"
  private var eqConfig = initialEq

  /** ctx.currentTime: frames rendered / sample rate. */
  val currentTime: Double get() = ctx.currentTime

  init {
    master.gain.value = 1f
    limiter.kernel.threshold = EqMath.LIMITER_THRESHOLD_DB.toFloat()
    limiter.kernel.knee = EqMath.LIMITER_KNEE.toFloat()
    limiter.kernel.ratio = EqMath.LIMITER_RATIO.toFloat()
    limiter.kernel.attack = EqMath.LIMITER_ATTACK_S.toFloat()
    limiter.kernel.release = EqMath.LIMITER_RELEASE_S.toFloat()
    master.connect(limiter)
  }

  /** A deck's input stream, fed by [process]. */
  fun createSource(): SourceNode = SourceNode(ctx)

  fun deck(id: String): Deck? = decks[id]

  fun attach(source: SourceNode, id: String): Deck {
    val existing = decks[id]
    if (existing != null && existing.source === source) return existing
    if (existing != null) releaseDeck(existing)
    val previous = decks.values.firstOrNull { it.source === source }
    if (previous != null) {
      if (previous.id == liveDeck) liveDeck = id
      releaseDeck(previous)
    }
    val gain = GainNode(ctx)
    gain.gain.value = if (id == liveDeck) 1f else 0f
    gain.connect(master)
    val bass = BiquadFilterNode(ctx, BiquadType.LOWSHELF)
    bass.frequency.value = BASS_HZ.toFloat()
    bass.gain.value = 0f
    val sweep = BiquadFilterNode(ctx, BiquadType.HIGHPASS)
    sweep.frequency.value = SWEEP_PARKED_HZ.toFloat()
    sweep.q.value = 0.7f
    bass.connect(sweep)
    sweep.connect(gain)
    val eq = EqChain(ctx, source, eqConfig, bass)
    val deck = Deck(id, source, gain, eq, bass, sweep)
    decks[id] = deck
    return deck
  }

  fun setEq(config: EqConfig) {
    eqConfig = config
    for (deck in decks.values) deck.eq.apply(config)
  }

  fun live(): String = liveDeck

  fun crossfadeTo(target: String, seconds: Double): String {
    if (target == liveDeck || !decks.containsKey(target)) return liveDeck
    val from = decks[liveDeck]
    val to = decks[target]
    val at = ctx.currentTime
    if (to != null) {
      restFilters(to, at)
      rampCurve(to.gain.gain, 1.0, at, seconds)
    }
    if (from != null) rampCurve(from.gain.gain, 0.0, at, seconds)
    liveDeck = target
    return liveDeck
  }

  fun transitionTo(target: String, seconds: Double, style: TransitionStyle): String {
    if (target == liveDeck || !decks.containsKey(target)) return liveDeck
    val from = decks[liveDeck]
    val to = decks[target]
    val at = ctx.currentTime
    val span = duration(seconds)
    if (style == TransitionStyle.CUT) {
      cutTo(target)
      return liveDeck
    }
    if (to != null) restFilters(to, at)
    if (to != null) rampCurve(to.gain.gain, 1.0, at, span)
    if (from != null) rampCurve(from.gain.gain, 0.0, at, span)
    if (style == TransitionStyle.BASS_SWAP || style == TransitionStyle.FILTER) {
      if (to != null) {
        rampParam(to.bass.gain, BASS_DUCK_DB, at, at + CUT_SECONDS)
        chainParam(to.bass.gain, BASS_DUCK_DB, 0.0, at + CUT_SECONDS, at + span / 2)
      }
      if (from != null) rampParam(from.bass.gain, BASS_DUCK_DB, at, at + span / 2)
    }
    if (style == TransitionStyle.FILTER) {
      if (from != null) rampParam(from.sweep.frequency, SWEEP_TOP_HZ, at, at + span, true)
    }
    liveDeck = target
    return liveDeck
  }

  fun cut(target: String) = cutTo(target)

  fun masterGain(): Float = master.gain.value

  fun setMasterGain(v: Double) {
    val want = max(0.0, min(1.0, if (v.isFinite()) v else 1.0))
    val now = ctx.currentTime
    rampParam(master.gain, want, now, now + CUT_SECONDS)
  }

  /** The live deck's EQ trim in dB. */
  fun trimDb(): Double = decks[liveDeck]?.eq?.trimDb() ?: 0.0

  /**
   * Render one quantum: deck `a` and `b` read `[offset, offset + 128)` of their stereo inputs
   * (null = no input for that deck), the mix lands in `out[0]`/`out[1]` at the same offset.
   */
  fun process(a: Array<FloatArray>?, b: Array<FloatArray>?, out: Array<FloatArray>, offset: Int = 0) {
    a?.let { decks["a"]?.source?.feed(it[0], it[1], offset) }
    b?.let { decks["b"]?.source?.feed(it[0], it[1], offset) }
    val bus = limiter.pull()
    System.arraycopy(bus.channels[0], 0, out[0], offset, ctx.quantumFrames)
    System.arraycopy(bus.channels[1], 0, out[1], offset, ctx.quantumFrames)
    ctx.currentSampleFrame += ctx.quantumFrames
  }

  private fun releaseDeck(deck: Deck) {
    deck.source.disconnect()
    for (node in deck.eq.nodes()) node.disconnect()
    for (node in listOf(deck.bass, deck.sweep, deck.gain)) node.disconnect()
    decks.remove(deck.id)
  }

  private fun cutTo(target: String) {
    if (!decks.containsKey(target)) return
    val at = ctx.currentTime
    for (deck in decks.values) {
      val want = if (deck.id == target) 1.0 else 0.0
      restFilters(deck, at)
      rampParam(deck.gain.gain, want, at, at + CUT_SECONDS)
    }
    liveDeck = target
  }

  /* ------------------------------------------------------------ the automation mirror */

  private fun duration(seconds: Double): Double =
    if (seconds.isFinite()) max(CUT_SECONDS, min(60.0, seconds)) else CUT_SECONDS

  private fun valueAt(param: AudioParam, at: Double): Double {
    val event = automation[param] ?: return param.value.toDouble()
    val progress = if (event.seconds > 0) max(0.0, min(1.0, (at - event.start) / event.seconds)) else 1.0
    val position = progress * (event.values.size - 1)
    val i = floor(position).toInt()
    val from = event.values[i]
    val to = event.values[min(i + 1, event.values.size - 1)]
    return if (event.exponential) from * Math.pow(to / from, position - i) else from + (to - from) * (position - i)
  }

  private fun hold(param: AudioParam, at: Double): Double {
    val value = valueAt(param, at)
    param.cancelAndHoldAtTime(at)
    param.setValueAtTime(value.toFloat(), at)
    automation[param] = Automation(at, 0.0, doubleArrayOf(value))
    return value
  }

  private fun setParam(param: AudioParam, value: Double, at: Double) {
    param.cancelScheduledValues(at)
    param.setValueAtTime(value.toFloat(), at)
    automation[param] = Automation(at, 0.0, doubleArrayOf(value))
  }

  private fun rampParam(param: AudioParam, value: Double, at: Double, end: Double, exponential: Boolean = false) {
    val from = hold(param, at)
    val exp = exponential && from > 0 && value > 0
    if (exp) param.exponentialRampToValueAtTime(value.toFloat(), end) else param.linearRampToValueAtTime(value.toFloat(), end)
    automation[param] = Automation(at, max(0.0, end - at), doubleArrayOf(from, value), exp)
  }

  private fun chainParam(param: AudioParam, from: Double, value: Double, start: Double, end: Double) {
    param.linearRampToValueAtTime(value.toFloat(), end)
    automation[param] = Automation(start, max(0.0, end - start), doubleArrayOf(from, value))
  }

  private fun rampCurve(param: AudioParam, to: Double, start: Double, seconds: Double) {
    val from = hold(param, start)
    val span = duration(seconds)
    val values = FloatArray(CURVE_STEPS + 1)
    for (i in 0..CURVE_STEPS) {
      val (out, inn) = EqMath.equalPower(i.toDouble() / CURVE_STEPS)
      values[i] = sqrt(from * from * out * out + to * to * inn * inn).toFloat()
    }
    values[0] = from.toFloat()
    values[CURVE_STEPS] = to.toFloat()
    param.setValueCurveAtTime(values, start, span)
    automation[param] = Automation(start, span, DoubleArray(values.size) { values[it].toDouble() })
  }

  private fun resetFilter(param: AudioParam, value: Double, at: Double, silent: Boolean, exponential: Boolean = false) {
    val event = automation[param]
    if (valueAt(param, at) == value && (event == null || at >= event.start + event.seconds)) return
    if (silent) setParam(param, value, at) else rampParam(param, value, at, at + FILTER_REST_SECONDS, exponential)
  }

  private fun restFilters(deck: Deck, at: Double) {
    val silent = valueAt(deck.gain.gain, at) == 0.0
    resetFilter(deck.bass.gain, 0.0, at, silent)
    resetFilter(deck.sweep.frequency, SWEEP_PARKED_HZ, at, silent, true)
  }

  companion object {
    /** audio-bus.ts constants. */
    const val BASS_DUCK_DB = -18.0
    const val BASS_HZ = 180.0
    const val SWEEP_TOP_HZ = 900.0
    const val SWEEP_PARKED_HZ = 20.0
    const val CURVE_STEPS = 48
    const val CUT_SECONDS = 0.012
    const val FILTER_REST_SECONDS = 0.04
  }
}
