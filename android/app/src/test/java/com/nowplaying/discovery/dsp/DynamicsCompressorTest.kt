package com.nowplaying.discovery.dsp

import org.junit.Assert.assertEquals
import org.junit.Test
import kotlin.math.log10

class DynamicsCompressorTest {
  private fun limiter() = DynamicsCompressorKernel(48000f).apply {
    threshold = -1f
    knee = 0f
    ratio = 20f
    attack = 0.001f
    release = 0.05f
  }

  /**
   * Derived makeup gain for eq.ts LIMITER (threshold −1 dB, knee 0, ratio 20): with no knee,
   * Saturate(1) = −1 dB + (0 − (−1)) / 20 = −0.95 dB, and the makeup is (1 / Saturate(1))^0.6, i.e.
   * 0.95 × 0.6 = **+0.57 dB** (×1.0678).
   */
  @Test fun makeupGainForTheAppLimiterIsPlus057Db() {
    val makeup = limiter().makeupGain()
    assertEquals(0.57, 20 * log10(makeup.toDouble()), 1e-4)
  }

  /**
   * Below threshold the output is the input 288 frames (6 ms) late, times the makeup gain — once
   * settled. Chromium's kernel starts with `detector_average_ = 0` (Reset()), so the first tens of
   * milliseconds attack toward zero gain and then release; the parity fixtures contain that too.
   */
  @Test fun quietSignalIsDelayedBy6msAndRaisedByTheMakeupGain() {
    val k = limiter()
    val makeup = k.makeupGain()
    val frames = 48000
    val input = FloatArray(frames) { (0.1 * StrictMath.sin(2 * Math.PI * 440 * it / 48000)).toFloat() }
    val out = run(k, input)
    // 2e-5 absolute: the release approaches unity gain asymptotically (1.5e-5 relative left at 0.5 s).
    for (n in 24000 until frames) assertEquals("frame $n", input[n - 288] * makeup, out[n], 2e-5f)
    for (n in 0 until 288) assertEquals(0f, out[n], 0f)
  }

  /** A steady full-scale level settles at makeup × Saturate(1) = +0.57 − 0.95 = −0.38 dBFS. */
  @Test fun loudSteadyLevelIsLimitedToMinus038Db() {
    val out = run(limiter(), FloatArray(48000) { 1f })
    assertEquals(-0.38, 20 * log10(out[47999].toDouble()), 1e-3)
  }

  private fun run(k: DynamicsCompressorKernel, mono: FloatArray): FloatArray {
    val out = FloatArray(mono.size)
    val src = arrayOf(FloatArray(128), FloatArray(128))
    val dst = arrayOf(FloatArray(128), FloatArray(128))
    var off = 0
    while (off < mono.size) {
      System.arraycopy(mono, off, src[0], 0, 128)
      System.arraycopy(mono, off, src[1], 0, 128)
      k.process(src, dst, 128)
      System.arraycopy(dst[0], 0, out, off, 128)
      off += 128
    }
    return out
  }
}
