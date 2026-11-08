package com.nowplaying.discovery.dsp

import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.sqrt

/**
 * One channel of a biquad. Port of `Biquad` (third_party/blink/renderer/platform/audio/biquad.cc and
 * biquad.h, Chromium 152.0.7977.65): `Process` (double coefficients, float in/out, state held as
 * the float values written; the per-sample coefficient path when the param values vary across the
 * quantum), `SetNormalizedCoefficients`, `SetHighpassParams` (resonance is in dB:
 * `pow10(q / 20)`), `SetLowShelfParams` (fixed slope S = 1; Q unused), `SetPeakingParams`
 * (Q clamped at 0, Q = 0 gives A²), `TailFrame` (+ `RepeatedRootResponse`, `RootFinder`), and the
 * file-local `pow10(x) = fdlibm::expf(x * ln10)` which rounds through float on both sides.
 *
 * `fdlibm::sin/cos/log` are `StrictMath` (both fdlibm).
 */
class Biquad(private val quantumFrames: Int = 128) {
  private val b0 = DoubleArray(quantumFrames)
  private val b1 = DoubleArray(quantumFrames)
  private val b2 = DoubleArray(quantumFrames)
  private val a1 = DoubleArray(quantumFrames)
  private val a2 = DoubleArray(quantumFrames)
  var hasSampleAccurateValues = false
  private var x1 = 0.0
  private var x2 = 0.0
  private var y1 = 0.0
  private var y2 = 0.0

  init {
    setNormalizedCoefficients(0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
  }

  fun coefficients(index: Int = 0): DoubleArray = doubleArrayOf(b0[index], b1[index], b2[index], a1[index], a2[index])

  fun process(source: FloatArray, dest: FloatArray, frames: Int) {
    var x1 = x1
    var x2 = x2
    var y1 = y1
    var y2 = y2
    if (hasSampleAccurateValues) {
      for (k in 0 until frames) {
        val x = source[k]
        val y = (b0[k] * x + b1[k] * x1 + b2[k] * x2 - a1[k] * y1 - a2[k] * y2).toFloat()
        dest[k] = y
        x2 = x1
        x1 = x.toDouble()
        y2 = y1
        y1 = y.toDouble()
      }
    } else {
      val b0 = b0[0]
      val b1 = b1[0]
      val b2 = b2[0]
      val a1 = a1[0]
      val a2 = a2[0]
      for (k in 0 until frames) {
        val x = source[k]
        val y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2).toFloat()
        dest[k] = y
        x2 = x1
        x1 = x.toDouble()
        y2 = y1
        y1 = y.toDouble()
      }
    }
    // DenormalDisabler::FlushDenormalFloatToZero (x86: denormals are already off; returns the float).
    this.x1 = x1.toFloat().toDouble()
    this.x2 = x2.toFloat().toDouble()
    this.y1 = y1.toFloat().toDouble()
    this.y2 = y2.toFloat().toDouble()
  }

  fun reset() {
    x1 = 0.0; x2 = 0.0; y1 = 0.0; y2 = 0.0
  }

  fun setHighpassParams(index: Int, cutoffIn: Double, resonanceIn: Double) {
    val cutoff = cutoffIn.coerceIn(0.0, 1.0)
    if (cutoff == 1.0) {
      setNormalizedCoefficients(index, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0)
    } else if (cutoff > 0) {
      val resonance = pow10(resonanceIn / 20)
      val theta = Math.PI * cutoff
      val alpha = StrictMath.sin(theta) / (2 * resonance)
      val cosw = StrictMath.cos(theta)
      val beta = (1 + cosw) / 2
      val b0 = beta
      val b1 = -2 * beta
      val b2 = beta
      val a0 = 1 + alpha
      val a1 = -2 * cosw
      val a2 = 1 - alpha
      setNormalizedCoefficients(index, b0, b1, b2, a0, a1, a2)
    } else {
      setNormalizedCoefficients(index, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
    }
  }

  fun setLowShelfParams(index: Int, frequencyIn: Double, dbGain: Double) {
    val frequency = frequencyIn.coerceIn(0.0, 1.0)
    val a = pow10(dbGain / 40)
    if (frequency == 1.0) {
      setNormalizedCoefficients(index, a * a, 0.0, 0.0, 1.0, 0.0, 0.0)
    } else if (frequency > 0) {
      val w0 = Math.PI * frequency
      val s = 1.0
      val alpha = 0.5 * StrictMath.sin(w0) * sqrt((a + 1 / a) * (1 / s - 1) + 2)
      val k = StrictMath.cos(w0)
      val k2 = 2 * sqrt(a) * alpha
      val aPlusOne = a + 1
      val aMinusOne = a - 1
      val b0 = a * (aPlusOne - aMinusOne * k + k2)
      val b1 = 2 * a * (aMinusOne - aPlusOne * k)
      val b2 = a * (aPlusOne - aMinusOne * k - k2)
      val a0 = aPlusOne + aMinusOne * k + k2
      val a1 = -2 * (aMinusOne + aPlusOne * k)
      val a2 = aPlusOne + aMinusOne * k - k2
      setNormalizedCoefficients(index, b0, b1, b2, a0, a1, a2)
    } else {
      setNormalizedCoefficients(index, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
    }
  }

  fun setPeakingParams(index: Int, frequencyIn: Double, qIn: Double, dbGain: Double) {
    val frequency = frequencyIn.coerceIn(0.0, 1.0)
    val q = max(0.0, qIn)
    val a = pow10(dbGain / 40)
    if (frequency > 0 && frequency < 1) {
      if (q > 0) {
        val w0 = Math.PI * frequency
        val alpha = StrictMath.sin(w0) / (2 * q)
        val k = StrictMath.cos(w0)
        val b0 = 1 + alpha * a
        val b1 = -2 * k
        val b2 = 1 - alpha * a
        val a0 = 1 + alpha / a
        val a1 = -2 * k
        val a2 = 1 - alpha / a
        setNormalizedCoefficients(index, b0, b1, b2, a0, a1, a2)
      } else {
        setNormalizedCoefficients(index, a * a, 0.0, 0.0, 1.0, 0.0, 0.0)
      }
    } else {
      setNormalizedCoefficients(index, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
    }
  }

  private fun setNormalizedCoefficients(index: Int, b0: Double, b1: Double, b2: Double, a0: Double, a1: Double, a2: Double) {
    val a0Inverse = 1 / a0
    this.b0[index] = b0 * a0Inverse
    this.b1[index] = b1 * a0Inverse
    this.b2[index] = b2 * a0Inverse
    this.a1[index] = a1 * a0Inverse
    this.a2[index] = a2 * a0Inverse
  }

  /** `Biquad::TailFrame`: frames until the impulse response stays under 1/32768. */
  fun tailFrame(coefIndex: Int, maxFrame: Double): Double {
    val maxTailAmplitude = 1 / 32768.0
    val a1 = a1[coefIndex]
    val a2 = a2[coefIndex]
    val b0 = b0[coefIndex]
    val b1 = b1[coefIndex]
    val b2 = b2[coefIndex]
    if (!a1.isFinite() || !a2.isFinite() || !b0.isFinite() || !b1.isFinite() || !b2.isFinite()) return 0.0
    var tailFrame: Double
    val discrim = a1 * a1 - 4 * a2
    if (discrim > 0) {
      val rplus = (-a1 + sqrt(discrim)) / 2
      val rminus = (-a1 - sqrt(discrim)) / 2
      val r1 = if (abs(rplus) >= abs(rminus)) rplus else rminus
      val r2 = a2 / r1
      val c1 = (b0 * r1 * r1 + b1 * r1 + b2) / (r2 - r1)
      val c2 = (b0 * r2 * r2 + b1 * r2 + b2) / (r2 - r1)
      tailFrame = clampLow(1 + StrictMath.log(maxTailAmplitude / (abs(c1) + abs(c2))) / StrictMath.log(abs(r1)), 0.0)
    } else if (discrim < 0) {
      val x = -a1 / 2
      val y = sqrt(-discrim) / 2
      val r = hypot(x, y)
      if (r == 1.0) {
        tailFrame = maxFrame
      } else {
        // |(b0 r1² + b1 r1 + b2) / (r2 - r1)| with r1 = x + iy, r2 = x - iy (std::complex).
        val c1 = complexResponseMagnitude(b0, b1, b2, x, y)
        val c2 = complexResponseMagnitude(b0, b1, b2, x, -y)
        tailFrame = 1 + StrictMath.log(maxTailAmplitude / (c1 + c2)) / StrictMath.log(r)
        if (c1 == 0.0 && c2 == 0.0) tailFrame = 0.0
      }
    } else {
      val r = -a1 / 2
      if (r == 0.0) {
        tailFrame = 2.0
      } else if (abs(r) >= 1) {
        tailFrame = Double.POSITIVE_INFINITY
      } else {
        val c1 = (b0 * r * r + b1 * r + b2) / (r * r)
        val c2 = b1 * r + 2 * b2
        if (c1 == 0.0 && c2 == 0.0) {
          tailFrame = 0.0
        } else {
          val logR = StrictMath.log(abs(r))
          val low = (-(1 + logR) / logR).coerceIn(1.0, maxFrame - 1)
          val high = maxFrame
          val logEps = StrictMath.log(maxTailAmplitude)
          val fLow = repeatedRootResponse(low, c1, c2, r, logEps)
          val fHigh = repeatedRootResponse(high, c1, c2, r, logEps)
          tailFrame = if (fLow <= 0) 0.0 else if (fHigh >= 0) high else rootFinder(low, high, fLow, fHigh, logEps, c1, c2, r)
        }
      }
    }
    return tailFrame
  }

  private fun complexResponseMagnitude(b0: Double, b1: Double, b2: Double, x: Double, y: Double): Double {
    // numerator = b0*r*r + b1*r + b2, r = x + iy
    val rrRe = x * x - y * y
    val rrIm = x * y + y * x
    val nRe = b0 * rrRe + b1 * x + b2
    val nIm = b0 * rrIm + b1 * y
    // denominator = r2 - r1 = (x - iy) - (x + iy) = -2iy  (sign of y as given)
    val dIm = -2 * y
    return hypot(nRe, nIm) / abs(dIm)
  }

  companion object {
    /** biquad.cc's `pow10`: `fdlibm::expf(float x)` — float argument and float result. */
    fun pow10(x: Double): Double = StrictMath.exp((x * 2.30258509299404568402).toFloat().toDouble()).toFloat().toDouble()

    /** wtf `ClampTo(value, min)`: NaN passes through, as in C++. */
    private fun clampLow(v: Double, lo: Double): Double = if (v <= lo) lo else v

    private fun repeatedRootResponse(n: Double, c1: Double, c2: Double, r: Double, logEps: Double): Double =
      (n - 2) * StrictMath.log(abs(r)) + StrictMath.log(abs(c1 * (n + 1) * r * r + c2)) - logEps

    private fun rootFinder(lowIn: Double, highIn: Double, fLowIn: Double, fHighIn: Double, logEps: Double, c1: Double, c2: Double, r: Double): Double {
      var low = lowIn
      var high = highIn
      var fLow = fLowIn
      var fHigh = fHighIn
      var side = 0
      var root = 0.0
      for (iteration in 0 until 10) {
        root = (fLow * high - fHigh * low) / (fLow - fHigh)
        if (abs(high - low) < 0.5 * abs(high + low)) break
        val fr = repeatedRootResponse(root, c1, c2, r, logEps)
        if (fr * fHigh > 0) {
          high = root; fHigh = fr; side = -1
        } else if (fLow * fr > 0) {
          low = root; fLow = fr
          if (side == 1) fHigh /= 2
          side = 1
        } else {
          break
        }
      }
      return root
    }
  }
}

enum class BiquadType { PEAKING, LOWSHELF, HIGHPASS }

/**
 * A stereo `BiquadFilterNode`. Port of `BiquadFilterHandler::Process`, `ProcessOnlyAudioParams`,
 * `TailTime`, `NormalizeFrequency`, `SetBiquadParams` and `HasConstantValues`
 * (modules/webaudio/biquad_filter_handler.cc, Chromium 152.0.7977.65; this file replaced
 * biquad_dsp_kernel.cc). If any param has sample-accurate values, all four a-rate params are
 * rendered per sample and, unless all are constant over the quantum, coefficients are computed per
 * sample; otherwise each param's `FinalValue()` gives one set of coefficients for the quantum.
 * Param ranges are `BiquadFilterNode`'s: frequency [0, nyquist], gain up to 40·log10(FLT_MAX).
 */
class BiquadFilterNode(ctx: RenderContext, val type: BiquadType) : AudioNode(ctx) {
  val frequency = AudioParam(ctx, 350f, 0f, ctx.sampleRate / 2)
  val q = AudioParam(ctx, 1f)
  val gain = AudioParam(ctx, 0f, -Float.MAX_VALUE, (40 * StrictMath.log10(Float.MAX_VALUE.toDouble())).toFloat())
  val detune = AudioParam(ctx, 0f, (-1200 * log2(Float.MAX_VALUE.toDouble())).toFloat(), (1200 * log2(Float.MAX_VALUE.toDouble())).toFloat())

  private val frames = ctx.quantumFrames
  private val nyquist = 0.5 * ctx.sampleRate
  private val biquads = arrayOf(Biquad(frames), Biquad(frames))
  private val freqValues = FloatArray(frames)
  private val qValues = FloatArray(frames)
  private val gainValues = FloatArray(frames)
  private val detuneValues = FloatArray(frames)
  private var tailTime = Double.POSITIVE_INFINITY

  override fun tailTime(): Double = tailTime

  override fun process(input: AudioBus) {
    if (frequency.hasSampleAccurateValues() || q.hasSampleAccurateValues() || gain.hasSampleAccurateValues() ||
      detune.hasSampleAccurateValues()
    ) {
      frequency.calculateSampleAccurateValues(freqValues, frames)
      q.calculateSampleAccurateValues(qValues, frames)
      gain.calculateSampleAccurateValues(gainValues, frames)
      detune.calculateSampleAccurateValues(detuneValues, frames)
      val isConstant = constant(freqValues) && constant(qValues) && constant(gainValues) && constant(detuneValues)
      val needed = if (isConstant) 1 else frames
      for (biquad in biquads) {
        biquad.hasSampleAccurateValues = needed > 1
        for (k in 0 until needed) setParams(biquad, k, normalize(freqValues[k], detuneValues[k]), qValues[k], gainValues[k])
      }
      tailTime = (biquads[0].tailFrame(needed - 1, MAX_TAIL_TIME * ctx.sampleRate) / ctx.sampleRate).coerceIn(0.0, MAX_TAIL_TIME)
    } else {
      freqValues[0] = frequency.finalValue()
      qValues[0] = q.finalValue()
      gainValues[0] = gain.finalValue()
      detuneValues[0] = detune.finalValue()
      for (biquad in biquads) {
        biquad.hasSampleAccurateValues = false
        setParams(biquad, 0, normalize(freqValues[0], detuneValues[0]), qValues[0], gainValues[0])
      }
      tailTime = (biquads[0].tailFrame(0, MAX_TAIL_TIME * ctx.sampleRate) / ctx.sampleRate).coerceIn(0.0, MAX_TAIL_TIME)
    }
    for (c in 0..1) biquads[c].process(input.channels[c], output.channels[c], frames)
  }

  override fun processOnlyAudioParams() {
    frequency.calculateSampleAccurateValues(freqValues, frames)
    q.calculateSampleAccurateValues(freqValues, frames)
    gain.calculateSampleAccurateValues(freqValues, frames)
    detune.calculateSampleAccurateValues(freqValues, frames)
  }

  private fun normalize(frequency: Float, detune: Float): Double {
    val normalized = frequency / nyquist
    return if (detune != 0f) normalized * Math.pow(2.0, detune / 1200.0) else normalized
  }

  private fun setParams(biquad: Biquad, index: Int, frequency: Double, q: Float, gain: Float) {
    when (type) {
      BiquadType.HIGHPASS -> biquad.setHighpassParams(index, frequency, q.toDouble())
      BiquadType.LOWSHELF -> biquad.setLowShelfParams(index, frequency, gain.toDouble())
      BiquadType.PEAKING -> biquad.setPeakingParams(index, frequency, q.toDouble(), gain.toDouble())
    }
  }

  private fun constant(values: FloatArray): Boolean {
    val v = values[0]
    for (i in 1 until frames) if (values[i] != v) return false
    return true
  }

  private fun log2(x: Double): Double = StrictMath.log(x) / StrictMath.log(2.0)

  /** The filter's current coefficients for one channel (index 0 = per-quantum set), for tests. */
  fun coefficients(channel: Int = 0, index: Int = 0): DoubleArray = biquads[channel].coefficients(index)

  private companion object {
    const val MAX_TAIL_TIME = 30.0
  }
}
