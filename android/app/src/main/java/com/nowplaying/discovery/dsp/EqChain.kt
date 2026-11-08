package com.nowplaying.discovery.dsp

import kotlin.math.max
import kotlin.math.min

/**
 * The JSON shape of eq.ts's `EqConfig`. Presets arrive already expanded to explicit gains.
 *
 * @property toneHz the solfeggio resonance, or null for none.
 * @property toneDb the resonance's boost; eq.ts defaults it to [EqMath.SOLFEGGIO_DB].
 */
data class EqConfig(
  val on: Boolean = false,
  val presetId: String = "flat",
  val gains: List<Double> = List(10) { 0.0 },
  val preampDb: Double = 0.0,
  val limiter: Boolean = true,
  val toneHz: Double? = null,
  val toneDb: Double? = EqMath.SOLFEGGIO_DB,
) {
  companion object {
    /** eq.ts `EQ_DEFAULTS`. */
    val DEFAULTS = EqConfig()
  }
}

/** The pure functions and constants of web/src/engine/eq.ts, ported one for one. */
object EqMath {
  val BANDS_HZ = doubleArrayOf(32.0, 64.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0)
  const val EQ_Q = 1.1
  val SOLFEGGIO_HZ = doubleArrayOf(174.0, 285.0, 396.0, 417.0, 528.0, 639.0, 741.0, 852.0, 963.0)
  const val SOLFEGGIO_Q = 8.0
  const val SOLFEGGIO_DB = 6.0
  const val GAIN_MIN_DB = -12.0
  const val GAIN_MAX_DB = 12.0

  /** eq.ts `LIMITER`. */
  const val LIMITER_THRESHOLD_DB = -1.0
  const val LIMITER_KNEE = 0.0
  const val LIMITER_RATIO = 20.0
  const val LIMITER_ATTACK_S = 0.001
  const val LIMITER_RELEASE_S = 0.05

  const val RAMP_S = 0.04
  const val BYPASS_S = 0.03

  fun isSolfeggio(hz: Double): Boolean = SOLFEGGIO_HZ.any { it == hz }

  /** eq.ts `clamp`: non-finite → 0, else `Math.min(hi, Math.max(lo, n))`. */
  private fun clamp(n: Double, lo: Double, hi: Double): Double = if (n.isFinite()) min(hi, max(lo, n)) else 0.0

  fun clampGain(db: Double): Double = clamp(db, GAIN_MIN_DB, GAIN_MAX_DB)

  fun dbToGain(db: Double): Double = Math.pow(10.0, db / 20)

  private fun log2(x: Double): Double = StrictMath.log(x) / LN2

  private val LN2 = StrictMath.log(2.0)

  /** eq.ts `responseDbAt`: the model's level in dB at [hz], preamp included. */
  fun responseDbAt(config: EqConfig, hz: Double): Double {
    var db = config.preampDb
    for (i in BANDS_HZ.indices) {
      val gain = config.gains.getOrNull(i) ?: 0.0
      if (gain == 0.0) continue
      val centre = BANDS_HZ[i]
      val octaves = log2(hz / centre)
      val bandwidth = 1 / EQ_Q
      val r = octaves / bandwidth
      val weight = 1 / (1 + r * r * 4)
      db += gain * weight
    }
    val toneHz = config.toneHz
    if (toneHz != null && toneHz != 0.0 && !toneHz.isNaN()) {
      val octaves = log2(hz / toneHz)
      val bandwidth = 1 / SOLFEGGIO_Q
      val r = octaves / bandwidth
      db += (config.toneDb ?: SOLFEGGIO_DB) * (1 / (1 + r * r * 4))
    }
    return db
  }

  /** eq.ts `requiredHeadroomDb`: the model's peak over 96 log-spaced points from 20 Hz to 20 kHz. */
  fun requiredHeadroomDb(config: EqConfig): Double {
    var peak = 0.0
    for (i in 0 until 96) {
      val hz = 20 * Math.pow(20000.0 / 20, i / 95.0)
      peak = max(peak, responseDbAt(config, hz))
    }
    return max(0.0, peak)
  }

  fun headroomTrimDb(config: EqConfig): Double = -requiredHeadroomDb(config)

  /** crossfade.ts `equalPower`: (cos, sin) of `t·π/2`, `t` clamped to [0, 1]. */
  fun equalPower(progress: Double): Pair<Double, Double> {
    val t = max(0.0, min(1.0, if (progress.isFinite()) progress else 0.0))
    val angle = (t * Math.PI) / 2
    return StrictMath.cos(angle) to StrictMath.sin(angle)
  }
}

/**
 * One deck's equaliser. Port of eq.ts `createEqGraph`:
 *
 * `source → { wet → preamp → 10 peaking bands → solfeggio tone → trim → limiter|bypass → out,
 * dry → out } → destination`, the limiter at eq.ts `LIMITER`, and `apply()` ramping every value
 * from its present `AudioParam.value` (`cancelScheduledValues` + `setValueAtTime(param.value)` +
 * `linearRampToValueAtTime`), 30 ms for the wet/dry switch and 40 ms for everything else.
 */
class EqChain(private val ctx: RenderContext, source: AudioNode, initial: EqConfig, destination: AudioNode) {
  val preamp = GainNode(ctx)
  val trim = GainNode(ctx)
  val limiter = DynamicsCompressorNode(ctx)
  val limiterOut = GainNode(ctx)
  val limiterBypass = GainNode(ctx)
  val out = GainNode(ctx)
  val wet = GainNode(ctx)
  val dry = GainNode(ctx)
  val bands: List<BiquadFilterNode> = EqMath.BANDS_HZ.map { hz ->
    BiquadFilterNode(ctx, BiquadType.PEAKING).also { f ->
      f.frequency.value = min(hz, ctx.sampleRate / 2.0 - 1).toFloat()
      f.q.value = EqMath.EQ_Q.toFloat()
      f.gain.value = 0f
    }
  }
  val tone = BiquadFilterNode(ctx, BiquadType.PEAKING).also { t ->
    t.frequency.value = EqMath.SOLFEGGIO_HZ[0].toFloat()
    t.q.value = EqMath.SOLFEGGIO_Q.toFloat()
    t.gain.value = 0f
  }
  private var trimNow = 0.0
  var current: EqConfig = initial
    private set

  init {
    source.connect(wet)
    source.connect(dry)
    wet.connect(preamp)
    var node: AudioNode = preamp
    for (band in bands) {
      node.connect(band)
      node = band
    }
    node.connect(tone)
    tone.connect(trim)
    trim.connect(limiter)
    trim.connect(limiterBypass)
    limiter.connect(limiterOut)
    limiterOut.connect(out)
    limiterBypass.connect(out)
    dry.connect(out)
    out.connect(destination)

    limiter.kernel.threshold = EqMath.LIMITER_THRESHOLD_DB.toFloat()
    limiter.kernel.knee = EqMath.LIMITER_KNEE.toFloat()
    limiter.kernel.ratio = EqMath.LIMITER_RATIO.toFloat()
    limiter.kernel.attack = EqMath.LIMITER_ATTACK_S.toFloat()
    limiter.kernel.release = EqMath.LIMITER_RELEASE_S.toFloat()

    apply(initial)
  }

  /** The trim currently applied, in dB. */
  fun trimDb(): Double = trimNow

  /** Push a whole config into the graph, ramping every value that changed. */
  fun apply(config: EqConfig) {
    current = config
    val t = ctx.currentTime
    val live = config.on
    ramp(wet.gain, if (live) 1.0 else 0.0, t, EqMath.BYPASS_S)
    ramp(dry.gain, if (live) 0.0 else 1.0, t, EqMath.BYPASS_S)
    ramp(preamp.gain, EqMath.dbToGain(if (live) config.preampDb else 0.0), t)
    for (i in bands.indices) {
      ramp(bands[i].gain, if (live) EqMath.clampGain(config.gains.getOrNull(i) ?: 0.0) else 0.0, t)
    }
    val requested = config.toneHz
    val toneHz = if (requested != null && requested != 0.0 && EqMath.isSolfeggio(requested)) requested else null
    if (toneHz != null) tone.frequency.setValueAtTime(min(toneHz, ctx.sampleRate / 2.0 - 1).toFloat(), t)
    ramp(tone.gain, if (live && toneHz != null) EqMath.clampGain(config.toneDb ?: EqMath.SOLFEGGIO_DB) else 0.0, t)
    trimNow = if (live) EqMath.headroomTrimDb(config) else 0.0
    ramp(trim.gain, EqMath.dbToGain(trimNow), t)
    ramp(limiterOut.gain, if (config.limiter) 1.0 else 0.0, t)
    ramp(limiterBypass.gain, if (config.limiter) 0.0 else 1.0, t)
  }

  /** Every node of the chain, for disposal. */
  internal fun nodes(): List<AudioNode> = listOf(wet, dry, preamp) + bands + listOf(tone, trim, limiter, limiterOut, limiterBypass, out)

  private fun ramp(param: AudioParam, value: Double, at: Double, seconds: Double = EqMath.RAMP_S) {
    try {
      param.cancelScheduledValues(at)
      param.setValueAtTime(param.value, at)
      param.linearRampToValueAtTime(value.toFloat(), at + seconds)
    } catch (e: AudioParamException) {
      param.value = value.toFloat()
    }
  }
}
