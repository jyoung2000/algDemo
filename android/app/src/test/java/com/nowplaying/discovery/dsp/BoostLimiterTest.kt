package com.nowplaying.discovery.dsp

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * VOLUME-BOOST-001 (owner 2026-11-19): up to 200% "and the audio still sound crisp and audible".
 * A loud three-tone signal (60 Hz bass, 1 kHz, 3.2 kHz; peak about -0.6 dBFS) through the real MixBus.
 */
class BoostLimiterTest {
  private val freqs = doubleArrayOf(60.0, 1000.0, 3200.0)
  private val amps = doubleArrayOf(0.55, 0.3, 0.1)

  /** Returns the steady-state peak and the residual (everything that is not the three tones) as % of the tones. */
  private fun run(gain: Double, scale: Double = 1.0): Pair<Double, Double> = runFull(gain, scale).let { Pair(it[0], it[1]) }

  /** peak, residual %, rms */
  private fun runFull(gain: Double, scale: Double = 1.0): DoubleArray {
    val bus = MixBus(RenderContext(48000f, 128))
    bus.attach(bus.createSource(), "a")
    bus.setMasterGain(gain)
    val q = 128
    val seconds = 3
    val n = 48000 * seconds
    val input = Array(2) { FloatArray(n) }
    for (i in 0 until n) {
      var v = 0.0
      for (j in freqs.indices) v += scale * amps[j] * sin(2 * PI * freqs[j] * i / 48000)
      input[0][i] = v.toFloat(); input[1][i] = v.toFloat()
    }
    val out = Array(2) { FloatArray(n) }
    var at = 0
    while (at + q <= n) { bus.process(input, null, out, at); at += q }
    val from = 48000
    val m = n - from
    val y = DoubleArray(m) { out[0][it + from].toDouble() }
    val peak = y.maxOf { abs(it) }
    val fit = DoubleArray(m)
    for (f in freqs) for (basis in listOf({ i: Int -> sin(2 * PI * f * (i + from) / 48000) }, { i: Int -> cos(2 * PI * f * (i + from) / 48000) })) {
      var dot = 0.0; var nn = 0.0
      for (i in 0 until m) { val b = basis(i); dot += y[i] * b; nn += b * b }
      val c = dot / nn
      for (i in 0 until m) fit[i] += c * basis(i)
    }
    var res = 0.0; var sig = 0.0
    for (i in 0 until m) { res += (y[i] - fit[i]) * (y[i] - fit[i]); sig += fit[i] * fit[i] }
    return doubleArrayOf(peak, 100 * sqrt(res / sig), sqrt(y.sumOf { it * it } / m))
  }

  @Test fun masterGainGoesTo200PercentAndNoFurther() {
    val bus = MixBus(RenderContext(48000f, 128))
    bus.setMasterGain(5.0)
    repeat(40) { bus.process(null, null, Array(2) { FloatArray(128) }) }
    assertEquals(2.0f, bus.masterGain(), 1e-3f)
    bus.setMasterGain(Double.NaN)
    repeat(40) { bus.process(null, null, Array(2) { FloatArray(128) }) }
    assertEquals(1.0f, bus.masterGain(), 1e-3f)
  }

  @Test fun boostedOutputNeverReachesFullScaleAndStaysClean() {
    for (g in listOf(1.5, 2.0)) {
      val (peak, residual) = run(g)
      println("BOOST gain=$g peak=$peak residual=$residual%")
      assertTrue("gain $g peaked at $peak: it must stay under full scale", peak < 1.0)
      assertTrue("gain $g distorts $residual%: must stay under 2%", residual < 2.0)
      assertTrue("gain $g is not louder than 100% would be", peak > 0.85)
    }
  }

  @Test fun atOrBelow100PercentNothingChanges() {
    val half = runFull(0.5, 0.4)
    val full = runFull(1.0, 0.4)
    assertEquals("half volume is half as loud", 0.5, half[2] / full[2], 0.01)
  }

  @Test fun aQuietSongAt200PercentIsTwiceAsLoudAndUndistorted() {
    // A quiet master (peak about -8 dBFS) has room: 200% doubles it without touching the limiter.
    val one = runFull(1.0, 0.4)
    val two = runFull(2.0, 0.4)
    println("QUIET rms 100%=${one[2]} 200%=${two[2]} residual=${two[1]}%")
    // At least twice as loud. A little more: the compressor's automatic make-up gain (Web Audio spec, also in
    // Chromium's node on Windows) grows when the boost lowers the threshold from -1 to -2 dB.
    assertTrue("200% is ${two[2] / one[2]}x", two[2] / one[2] in 2.0..2.25)
    assertTrue(two[1] < 1.0)
  }
}
