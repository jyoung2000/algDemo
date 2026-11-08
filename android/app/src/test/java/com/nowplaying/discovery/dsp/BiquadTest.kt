package com.nowplaying.discovery.dsp

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.log10
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

class BiquadTest {
  /** |H(e^{jw})| of normalized coefficients [b0, b1, b2, a1, a2]. */
  private fun magnitude(c: DoubleArray, w: Double): Double {
    val nRe = c[0] + c[1] * cos(-w) + c[2] * cos(-2 * w)
    val nIm = c[1] * sin(-w) + c[2] * sin(-2 * w)
    val dRe = 1 + c[3] * cos(-w) + c[4] * cos(-2 * w)
    val dIm = c[3] * sin(-w) + c[4] * sin(-2 * w)
    return hypot(nRe, nIm) / hypot(dRe, dIm)
  }

  private fun normalized(b0: Double, b1: Double, b2: Double, a0: Double, a1: Double, a2: Double) =
    doubleArrayOf(b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0)

  @Test fun peakingCoefficientsFollowTheCookbookAsChromiumWritesThem() {
    val f = 1000.0 / 24000
    val q = 1.1
    val db = 6.0
    val bq = Biquad()
    bq.setPeakingParams(0, f, q, db)
    val a = 10.0.pow(db / 40)
    val w0 = PI * f
    val alpha = sin(w0) / (2 * q)
    val k = cos(w0)
    val expected = normalized(1 + alpha * a, -2 * k, 1 - alpha * a, 1 + alpha / a, -2 * k, 1 - alpha / a)
    // pow10 goes through fdlibm::expf (float), so A carries float rounding: ~1e-7 relative.
    assertArrayEquals(expected, bq.coefficients(), 1e-6)
  }

  @Test fun peakingMagnitudeAtItsCentreIsItsGain() {
    for (db in listOf(-12.0, -3.5, 6.0, 12.0)) {
      val bq = Biquad()
      val f = 528.0 / 24000
      bq.setPeakingParams(0, f, 8.0, db)
      assertEquals("gain $db dB", db, 20 * log10(magnitude(bq.coefficients(), PI * f)), 1e-4)
    }
  }

  @Test fun highpassQIsInDecibels() {
    val f = 900.0 / 24000
    val bq = Biquad()
    bq.setHighpassParams(0, f, 20.0)
    // Q = 20 dB is a linear resonance of 10: the cookbook HPF with Q = 10.
    val w0 = PI * f
    val alpha = sin(w0) / (2 * 10.0)
    val cosw = cos(w0)
    val beta = (1 + cosw) / 2
    val expected = normalized(beta, -2 * beta, beta, 1 + alpha, -2 * cosw, 1 - alpha)
    assertArrayEquals(expected, bq.coefficients(), 1e-6)
    // And the response at the cutoff is the resonance itself: +20 dB.
    assertEquals(20.0, 20 * log10(magnitude(bq.coefficients(), w0)), 1e-3)
    // Q = 0.7 (the sweep's) means 0.7 dB, i.e. a linear Q of 10^(0.7/20) ≈ 1.084 — not 0.7.
    val sweep = Biquad()
    sweep.setHighpassParams(0, f, 0.7)
    assertEquals(0.7, 20 * log10(magnitude(sweep.coefficients(), w0)), 1e-3)
  }

  @Test fun lowshelfIgnoresQ() {
    val ctx = RenderContext()
    val coefficients = listOf(0.1f, 1f, 30f).map { q ->
      val node = BiquadFilterNode(ctx, BiquadType.LOWSHELF)
      node.frequency.value = 180f
      node.gain.value = -18f
      node.q.value = q
      node.pull()
      node.coefficients()
    }
    assertArrayEquals(coefficients[0], coefficients[1], 0.0)
    assertArrayEquals(coefficients[0], coefficients[2], 0.0)
    // Shelf depth at DC is the gain; S = 1 (Chromium's fixed slope).
    assertEquals(-18.0, 20 * log10(magnitude(coefficients[0], 0.0)), 1e-4)
    val f = 180.0 / 24000
    val a = 10.0.pow(-18.0 / 40)
    val w0 = PI * f
    val alpha = 0.5 * sin(w0) * sqrt(2.0)
    val k = cos(w0)
    val k2 = 2 * sqrt(a) * alpha
    val expected = normalized(
      a * (a + 1 - (a - 1) * k + k2), 2 * a * (a - 1 - (a + 1) * k), a * (a + 1 - (a - 1) * k - k2),
      a + 1 + (a - 1) * k + k2, -2 * (a - 1 + (a + 1) * k), a + 1 + (a - 1) * k - k2,
    )
    assertArrayEquals(expected, coefficients[0], 1e-6)
  }

  @Test fun specialCasesNearZeroAndNyquist() {
    val bq = Biquad()
    bq.setPeakingParams(0, 0.0, 1.0, 12.0)
    assertArrayEquals(doubleArrayOf(1.0, 0.0, 0.0, 0.0, 0.0), bq.coefficients(), 0.0)
    bq.setPeakingParams(0, 0.25, 0.0, 12.0)
    assertEquals(Biquad.pow10(12.0 / 40).pow(2), bq.coefficients()[0], 0.0)
    bq.setHighpassParams(0, 1.0, 0.0)
    assertArrayEquals(doubleArrayOf(0.0, 0.0, 0.0, 0.0, 0.0), bq.coefficients(), 0.0)
    bq.setHighpassParams(0, 0.0, 0.0)
    assertArrayEquals(doubleArrayOf(1.0, 0.0, 0.0, 0.0, 0.0), bq.coefficients(), 0.0)
  }
}
