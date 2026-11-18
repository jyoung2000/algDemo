package com.nowplaying.discovery.engine

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * DJ-XFADE-001: [StretchSource] changes a song's tempo without changing its pitch, and is not in
 * the signal path at all when the tempo is the song's own.
 */
class TimeStretchTest {
  /** A source made from a formula of the frame index, optionally delivering short reads. */
  private class Formula(seconds: Double, val shortEvery: Int = 0, val f: (Long) -> Float) : PcmSource {
    override val durationFrames = (seconds * 48000).toLong()
    override var positionFrames = 0L
    override val ready get() = true
    override val ended get() = positionFrames >= durationFrames
    override val error: Throwable? = null
    private var calls = 0
    override fun read(dst: Array<FloatArray>, offset: Int, frames: Int): Int {
      calls += 1
      val allowed = if (shortEvery > 0 && calls % shortEvery == 0) 0 else frames
      val n = min(allowed.toLong(), durationFrames - positionFrames).toInt().coerceAtLeast(0)
      for (i in 0 until n) {
        val v = f(positionFrames + i)
        dst[0][offset + i] = v
        dst[1][offset + i] = -v * 0.5f
      }
      positionFrames += n
      return n
    }
    override fun seekTo(frame: Long) { positionFrames = frame.coerceIn(0, durationFrames) }
    override fun close() {}
  }

  private fun tone(hz: Double) = { n: Long -> (0.4 * sin(2 * PI * hz * n / 48000.0)).toFloat() }
  /** A 220 Hz pad with a decaying 60 Hz kick every half second (120 BPM), like the cue tests. */
  private val beat = { n: Long ->
    val t = n / 48000.0
    val since = t % 0.5
    (0.1 * sin(2 * PI * 220 * t) + 0.6 * exp(-since * 28) * sin(2 * PI * 60 * since)).toFloat()
  }

  private fun drain(src: PcmSource, quantum: Int = 128, limit: Int = 4_000_000): Pair<FloatArray, FloatArray> {
    val l = ArrayList<Float>(); val r = ArrayList<Float>()
    val block = arrayOf(FloatArray(quantum), FloatArray(quantum))
    var idle = 0
    while (!src.ended && l.size < limit && idle < 50) {
      val got = src.read(block, 0, quantum)
      if (got == 0) idle += 1 else idle = 0
      for (i in 0 until got) { l += block[0][i]; r += block[1][i] }
    }
    return l.toFloatArray() to r.toFloatArray()
  }

  private fun level(x: FloatArray, hz: Double, from: Int, to: Int): Double {
    var re = 0.0; var im = 0.0
    for (i in from until to) { val w = 2 * PI * hz * i / 48000.0; re += x[i] * cos(w); im += x[i] * sin(w) }
    return 2 * sqrt(re * re + im * im) / max(1, to - from)
  }

  @Test fun atTheSongsOwnTempoItIsNotInTheSignalPath() {
    val plain = drain(Formula(3.0, f = beat))
    val wrapped = StretchSource(Formula(3.0, f = beat))
    assertFalse(wrapped.stretching)
    val through = drain(wrapped)
    assertArrayEquals("left is bit-identical", plain.first, through.first, 0f)
    assertArrayEquals("right is bit-identical", plain.second, through.second, 0f)
    assertEquals(144000L, wrapped.positionFrames)
    assertTrue(wrapped.ended)
  }

  @Test fun fasterAndSlowerChangeTheLengthByTheTempo() {
    for (rate in listOf(0.94, 0.97, 1.03, 1.06)) {
      val src = StretchSource(Formula(10.0, f = beat)).apply { this.rate = rate }
      val out = drain(src).first
      val want = 480000 / rate
      assertTrue("rate $rate: ${out.size} frames, want about $want", abs(out.size - want) <= 2 * StretchSource.HOP)
      assertTrue(src.ended)
    }
  }

  @Test fun thePitchStaysWhereItWas() {
    for (rate in listOf(0.94, 1.06)) {
      val out = drain(StretchSource(Formula(6.0, f = tone(440.0))).apply { this.rate = rate }).first
      val a = 48000; val b = out.size - 48000
      val kept = level(out, 440.0, a, b)
      // Resampling instead would have moved the tone to 440 * rate.
      val moved = level(out, 440.0 * rate, a, b)
      assertTrue("rate $rate: 440 Hz level $kept", kept > 0.36)
      assertTrue("rate $rate: energy at the shifted pitch $moved", moved < 0.04)
      // A steady tone stays steady: no dropouts and no overshoot where pieces join.
      var peak = 0f
      for (i in a until b) peak = max(peak, abs(out[i]))
      assertTrue("rate $rate: peak $peak", peak in 0.37f..0.45f)
    }
  }

  @Test fun theBeatsLandWhereTheTempoPutsThem() {
    val rate = 1.04
    val out = drain(StretchSource(Formula(12.0, f = beat)).apply { this.rate = rate }).first
    // Kicks every 0.5 s of song are heard every 0.5 / rate s. Find each kick as the loudest low
    // frequency burst near where it is expected, and measure how far off it is.
    val spacing = 0.5 * 48000 / rate
    var worst = 0.0
    for (k in 2 until 20) {
      val expected = (k * spacing).toInt()
      var best = 0; var bestV = 0.0
      for (c in expected - 1500..expected + 1500 step 16) {
        var s = 0.0
        for (i in c until c + 480) s += abs(out[i].toDouble())
        if (s > bestV) { bestV = s; best = c }
      }
      worst = max(worst, abs(best - expected) / 48.0)
    }
    assertTrue("a kick is $worst ms from where the tempo puts it", worst < 15.0)
  }

  @Test fun returningToTheSongsOwnTempoCarriesOnWithoutAJump() {
    val src = StretchSource(Formula(8.0, f = tone(330.0))).apply { rate = 1.05 }
    val block = arrayOf(FloatArray(128), FloatArray(128))
    val out = ArrayList<Float>()
    repeat(600) { val n = src.read(block, 0, 128); for (i in 0 until n) out += block[0][i] }
    src.rate = 1.0
    val joinAt = out.size
    repeat(600) { val n = src.read(block, 0, 128); for (i in 0 until n) out += block[0][i] }
    assertFalse("back to plain pass-through", src.stretching)
    // 330 Hz at 0.4 moves at most 0.0173 per frame; nothing around the change may exceed that.
    var jump = 0f
    for (i in max(1, joinAt - 4096) until min(out.size, joinAt + 8192)) jump = max(jump, abs(out[i] - out[i - 1]))
    assertTrue("largest step around the change: $jump", jump < 0.019f)
    // And from here on it is the source itself again, sample for sample.
    val at = src.positionFrames
    val direct = tone(330.0)
    src.read(block, 0, 128)
    for (i in 0 until 128) assertEquals(direct(at + i), block[0][i], 0f)
  }

  @Test fun aSourceThatDeliversLateIsWaitedForNotSkipped() {
    val steady = drain(StretchSource(Formula(4.0, f = beat)).apply { rate = 1.03 }).first
    val late = drain(StretchSource(Formula(4.0, shortEvery = 3, f = beat)).apply { rate = 1.03 }).first
    assertArrayEquals("the same audio, however the source delivered it", steady, late, 0f)
  }

  @Test fun seekingStartsCleanFromTheNewPlace() {
    val src = StretchSource(Formula(10.0, f = beat)).apply { rate = 1.04 }
    val block = arrayOf(FloatArray(128), FloatArray(128))
    repeat(200) { src.read(block, 0, 128) }
    src.seekTo(240000)
    assertEquals(240000L, src.positionFrames)
    src.read(block, 0, 128)
    assertTrue("position follows the song from the seek: ${src.positionFrames}", src.positionFrames in 240000L..242200L)
  }

  @Test fun aTempoOutsideWhatIsMusicalIsHeldToTheLimit() {
    val src = StretchSource(Formula(1.0, f = beat))
    src.rate = 3.0; assertEquals(StretchSource.MAX_RATE, src.rate, 0.0)
    src.rate = 0.1; assertEquals(StretchSource.MIN_RATE, src.rate, 0.0)
    src.rate = Double.NaN; assertEquals(1.0, src.rate, 0.0)
  }
}
