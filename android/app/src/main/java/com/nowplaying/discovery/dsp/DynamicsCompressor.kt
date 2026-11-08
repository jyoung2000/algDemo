package com.nowplaying.discovery.dsp

import kotlin.math.max
import kotlin.math.min

/**
 * Chromium's dynamics compressor kernel, ported statement by statement from
 * `DynamicsCompressor` (third_party/blink/renderer/platform/audio/dynamics_compressor.cc and .h,
 * Chromium 152.0.7977.65): the 6 ms pre-delay (look-ahead) ring of 1024 frames, 32-frame
 * divisions, the per-division envelope rate (adaptive release from the four release zones'
 * polynomial; attack from the largest compression difference seen), the per-sample detector with
 * its saturation release, `sin(π/2 · gain)` post-warp, metering, the knee curve and the 15-step
 * geometric search for `k` (`KAtSlope`), `UpdateStaticCurveParameters`, and the automatic makeup
 * gain `pow(1 / Saturate(1, k), 0.6)`. Detection is linked stereo: the louder channel drives both.
 *
 * Float/double exactly as in C++: `fdlibm::powf/asinf` evaluate in double and round to float,
 * `powf`/`log10f` (audio_utilities `DecibelsToLinear`/`LinearToDecibels`) are float functions.
 */
class DynamicsCompressorKernel(private val sampleRate: Float) {
  var threshold = -24f
  var knee = 30f
  var ratio = 12f
  var attack = 0.003f
  var release = 0.250f
  var reduction = 0f
    private set

  private var detectorAverage = 0f
  private var compressorGain = 1f
  private var meteringGain = 1f
  private val meteringReleaseK = (1 - StrictMath.exp(-1 / (sampleRate.toDouble() * METERING_RELEASE_TIME_CONSTANT))).toFloat()

  private var lastPreDelayFrames = DEFAULT_PRE_DELAY_FRAMES
  private val preDelayBuffers = arrayOf(FloatArray(MAX_PRE_DELAY_FRAMES), FloatArray(MAX_PRE_DELAY_FRAMES))
  private var preDelayReadIndex = 0
  private var preDelayWriteIndex = DEFAULT_PRE_DELAY_FRAMES
  private var dbMaxAttackCompressionDiff = -1f

  private var ratioState = UNINITIALIZED
  private var slope = UNINITIALIZED
  private var linearThreshold = UNINITIALIZED
  private var dbThreshold = UNINITIALIZED
  private var dbKnee = UNINITIALIZED
  private var kneeThreshold = UNINITIALIZED
  private var dbKneeThreshold = UNINITIALIZED
  private var dbYKneeThreshold = UNINITIALIZED
  private var kneeK = UNINITIALIZED

  val latencyTime: Double get() = lastPreDelayFrames / sampleRate.toDouble()
  val tailTime: Double get() = (5 * METERING_RELEASE_TIME_CONSTANT).toDouble()

  /** The makeup gain the kernel applies for the current threshold/knee/ratio. */
  fun makeupGain(): Float {
    val k = updateStaticCurveParameters(threshold, knee, ratio)
    return powfFdlibm(1 / saturate(1f, k), 0.6f)
  }

  fun process(source: Array<FloatArray>, dest: Array<FloatArray>, frames: Int) {
    val dbThreshold = threshold
    val dbKnee = knee
    val ratio = ratio
    val attackTime = attack
    val releaseTime = release
    val sampleRate = sampleRate
    val k = updateStaticCurveParameters(dbThreshold, dbKnee, ratio)
    val linearPostGain = powfFdlibm(1 / saturate(1f, k), 0.6f)
    val attackFrames = max(0.001f, attackTime) * sampleRate
    val releaseFrames = sampleRate * releaseTime
    val satReleaseFrames = SAT_RELEASE_TIME * sampleRate
    val a = releaseFrames * A_BASE
    val b = releaseFrames * B_BASE
    val c = releaseFrames * C_BASE
    val d = releaseFrames * D_BASE
    val e = releaseFrames * E_BASE
    setPreDelayTime(PRE_DELAY)
    val numberOfDivisions = frames / DIVISION_FRAMES
    var frameIndex = 0
    for (i in 0 until numberOfDivisions) {
      detectorAverage = ensureFinite(detectorAverage, 1f)
      val desiredGain = detectorAverage
      val scaledDesiredGain = StrictMath.asin(desiredGain.toDouble()).toFloat() / PI_OVER_TWO_FLOAT
      var envelopeRate: Float
      val isReleasing = scaledDesiredGain > compressorGain
      var dbCompressionDiff: Float = if (scaledDesiredGain == 0f) {
        if (isReleasing) -1f else 1f
      } else {
        linearToDecibels(compressorGain / scaledDesiredGain)
      }
      if (isReleasing) {
        dbMaxAttackCompressionDiff = -1f
        dbCompressionDiff = ensureFinite(dbCompressionDiff, -1f)
        var x = dbCompressionDiff
        x = x.coerceIn(-12.0f, 0.0f)
        x = 0.25f * (x + 12)
        val x2 = x * x
        val x3 = x2 * x
        val x4 = x2 * x2
        val calcReleaseFrames = a + b * x + c * x2 + d * x3 + e * x4
        val dbPerFrame = DB_SPACING / calcReleaseFrames
        envelopeRate = decibelsToLinear(dbPerFrame)
      } else {
        dbCompressionDiff = ensureFinite(dbCompressionDiff, 1f)
        if (dbMaxAttackCompressionDiff == -1f || dbMaxAttackCompressionDiff < dbCompressionDiff) {
          dbMaxAttackCompressionDiff = dbCompressionDiff
        }
        val dbEffAttenDiff = max(0.5f, dbMaxAttackCompressionDiff)
        val x = 0.25f / dbEffAttenDiff
        envelopeRate = 1 - powfFdlibm(x, 1 / attackFrames)
      }
      var readIndex = preDelayReadIndex
      var writeIndex = preDelayWriteIndex
      var detectorAverage = detectorAverage
      var compressorGain = compressorGain
      var loopFrames = DIVISION_FRAMES
      while (loopFrames-- > 0) {
        var compressorInput = 0f
        for (j in 0..1) {
          val undelayedSource = source[j][frameIndex]
          preDelayBuffers[j][writeIndex] = undelayedSource
          val absUndelayedSource = if (undelayedSource > 0) undelayedSource else -undelayedSource
          if (compressorInput < absUndelayedSource) compressorInput = absUndelayedSource
        }
        val scaledInput = compressorInput
        val absInput = if (scaledInput > 0) scaledInput else -scaledInput
        val shapedInput = saturate(absInput, k)
        val attenuation = if (absInput <= 0.0001f) 1f else shapedInput / absInput
        val dbAttenuation = max(2.0f, -linearToDecibels(attenuation))
        val dbPerFrame = dbAttenuation / satReleaseFrames
        val satReleaseRate = decibelsToLinear(dbPerFrame) - 1
        val isRelease = attenuation > detectorAverage
        val rate = if (isRelease) satReleaseRate else 1f
        detectorAverage += (attenuation - detectorAverage) * rate
        detectorAverage = min(1.0f, detectorAverage)
        detectorAverage = ensureFinite(detectorAverage, 1f)
        if (envelopeRate < 1) {
          compressorGain += (scaledDesiredGain - compressorGain) * envelopeRate
        } else {
          compressorGain *= envelopeRate
          compressorGain = min(1.0f, compressorGain)
        }
        val postWarpCompressorGain = Math.sin((PI_OVER_TWO_FLOAT * compressorGain).toDouble()).toFloat()
        val totalGain = linearPostGain * postWarpCompressorGain
        val dbRealGain = linearToDecibels(postWarpCompressorGain)
        if (dbRealGain < meteringGain) {
          meteringGain = dbRealGain
        } else {
          meteringGain += (dbRealGain - meteringGain) * meteringReleaseK
        }
        for (j in 0..1) dest[j][frameIndex] = preDelayBuffers[j][readIndex] * totalGain
        frameIndex++
        readIndex = (readIndex + 1) and MAX_PRE_DELAY_FRAMES_MASK
        writeIndex = (writeIndex + 1) and MAX_PRE_DELAY_FRAMES_MASK
      }
      preDelayReadIndex = readIndex
      preDelayWriteIndex = writeIndex
      this.detectorAverage = flushDenormal(detectorAverage)
      this.compressorGain = flushDenormal(compressorGain)
    }
    reduction = meteringGain
  }

  private fun setPreDelayTime(preDelayTime: Float) {
    var preDelayFrames = (preDelayTime * sampleRate).toLong().toInt()
    if (preDelayFrames > MAX_PRE_DELAY_FRAMES - 1) preDelayFrames = MAX_PRE_DELAY_FRAMES - 1
    if (lastPreDelayFrames != preDelayFrames) {
      lastPreDelayFrames = preDelayFrames
      for (buffer in preDelayBuffers) buffer.fill(0f)
      preDelayReadIndex = 0
      preDelayWriteIndex = preDelayFrames
    }
  }

  private fun kneeCurve(x: Float, k: Float): Float {
    if (x < linearThreshold) return x
    return linearThreshold + (1 - Math.exp((-k * (x - linearThreshold)).toDouble()).toFloat()) / k
  }

  private fun saturate(x: Float, k: Float): Float {
    if (x < kneeThreshold) return kneeCurve(x, k)
    val dbX = linearToDecibels(x)
    val dbY = dbYKneeThreshold + slope * (dbX - dbKneeThreshold)
    return decibelsToLinear(dbY)
  }

  private fun kAtSlope(desiredSlope: Float): Float {
    val dbX = dbThreshold + dbKnee
    val x = decibelsToLinear(dbX)
    var x2 = 1f
    var dbX2 = 0f
    if (!(x < linearThreshold)) {
      x2 = (x * 1.001).toFloat()
      dbX2 = linearToDecibels(x2)
    }
    var minK = 0.1f
    var maxK = 10000f
    var k = 5f
    var slope = 1f
    for (i in 0 until 15) {
      if (!(x < linearThreshold)) {
        val dbY = linearToDecibels(kneeCurve(x, k))
        val dbY2 = linearToDecibels(kneeCurve(x2, k))
        slope = (dbY2 - dbY) / (dbX2 - dbX)
      }
      if (slope < desiredSlope) maxK = k else minK = k
      k = kotlin.math.sqrt(minK * maxK)
    }
    return k
  }

  private fun updateStaticCurveParameters(dbThreshold: Float, dbKnee: Float, ratio: Float): Float {
    if (dbThreshold != this.dbThreshold || dbKnee != this.dbKnee || ratio != ratioState) {
      this.dbThreshold = dbThreshold
      linearThreshold = decibelsToLinear(dbThreshold)
      this.dbKnee = dbKnee
      ratioState = ratio
      slope = 1 / ratioState
      val k = kAtSlope(1 / ratioState)
      dbKneeThreshold = dbThreshold + dbKnee
      kneeThreshold = decibelsToLinear(dbKneeThreshold)
      dbYKneeThreshold = linearToDecibels(kneeCurve(kneeThreshold, k))
      kneeK = k
    }
    return kneeK
  }

  companion object {
    private const val METERING_RELEASE_TIME_CONSTANT = 0.325f
    private const val UNINITIALIZED = -1f
    private const val PRE_DELAY = 0.006f
    private const val RELEASE_ZONE_1 = 0.09f
    private const val RELEASE_ZONE_2 = 0.16f
    private const val RELEASE_ZONE_3 = 0.42f
    private const val RELEASE_ZONE_4 = 0.98f
    private val A_BASE = 0.9999999999999998f * RELEASE_ZONE_1 + 1.8432219684323923e-16f * RELEASE_ZONE_2 -
      1.9373394351676423e-16f * RELEASE_ZONE_3 + 8.824516011816245e-18f * RELEASE_ZONE_4
    private val B_BASE = -1.5788320352845888f * RELEASE_ZONE_1 + 2.3305837032074286f * RELEASE_ZONE_2 -
      0.9141194204840429f * RELEASE_ZONE_3 + 0.1623677525612032f * RELEASE_ZONE_4
    private val C_BASE = 0.5334142869106424f * RELEASE_ZONE_1 - 1.272736789213631f * RELEASE_ZONE_2 +
      0.9258856042207512f * RELEASE_ZONE_3 - 0.18656310191776226f * RELEASE_ZONE_4
    private val D_BASE = 0.08783463138207234f * RELEASE_ZONE_1 - 0.1694162967925622f * RELEASE_ZONE_2 +
      0.08588057951595272f * RELEASE_ZONE_3 - 0.00429891410546283f * RELEASE_ZONE_4
    private val E_BASE = -0.042416883008123074f * RELEASE_ZONE_1 + 0.1115693827987602f * RELEASE_ZONE_2 -
      0.09764676325265872f * RELEASE_ZONE_3 + 0.028494263462021576f * RELEASE_ZONE_4
    private const val SAT_RELEASE_TIME = 0.0025f
    private const val DB_SPACING = 5f
    private const val DIVISION_FRAMES = 32
    private const val MAX_PRE_DELAY_FRAMES = 1024
    private const val MAX_PRE_DELAY_FRAMES_MASK = MAX_PRE_DELAY_FRAMES - 1
    private const val DEFAULT_PRE_DELAY_FRAMES = 256
    private const val PI_OVER_TWO_FLOAT = (Math.PI.toFloat() / 2.0f)

    private fun ensureFinite(x: Float, default: Float): Float = if (x.isFinite()) x else default

    /** wtf math_extras / denormal_disabler on x86 (FTZ via MXCSR): the value is returned as is. */
    private fun flushDenormal(f: Float): Float = f

    /** `fdlibm::powf(x, y)` = (float) fdlibm pow((double) x, (double) y). */
    fun powfFdlibm(x: Float, y: Float): Float = StrictMath.pow(x.toDouble(), y.toDouble()).toFloat()

    /** audio_utilities `DecibelsToLinear`: `powf(10, 0.05f * dB)`. */
    fun decibelsToLinear(db: Float): Float = Math.pow(10.0, (0.05f * db).toDouble()).toFloat()

    /** audio_utilities `LinearToDecibels`: `20 * log10f(linear)`. */
    fun linearToDecibels(linear: Float): Float = 20 * Math.log10(linear.toDouble()).toFloat()
  }
}

/**
 * `DynamicsCompressorNode`: port of `DynamicsCompressorHandler::Process` and its tail/latency
 * (modules/webaudio/dynamics_compressor_handler.cc). Its params are k-rate and fixed; the graph
 * sets them once and never automates them, so they are plain values here.
 */
class DynamicsCompressorNode(ctx: RenderContext) : AudioNode(ctx) {
  val kernel = DynamicsCompressorKernel(ctx.sampleRate)

  override fun tailTime(): Double = kernel.tailTime
  override fun latencyTime(): Double = kernel.latencyTime

  override fun process(input: AudioBus) {
    kernel.process(input.channels, output.channels, ctx.quantumFrames)
  }
}
