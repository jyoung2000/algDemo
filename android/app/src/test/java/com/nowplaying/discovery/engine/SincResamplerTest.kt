package com.nowplaying.discovery.engine

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.random.Random

/**
 * Measures the Kotlin port of Chromium's media::SincResampler (SincResampler.kt) and the streaming
 * wrapper the native decoder uses (StreamResampler.kt). Every measured number is printed with a
 * `[resampler]` prefix so it can be read from the Gradle test report.
 */
class SincResamplerTest {
  private fun report(msg: String) = println("[resampler] $msg")

  private fun sine(frames: Int, rate: Int, hz: Double, amp: Double, channels: Int = 2): Array<FloatArray> =
    Array(channels) { c ->
      // Second channel gets a phase offset so the channels are distinguishable.
      FloatArray(frames) { n -> (amp * sin(2 * PI * hz * n / rate + c * 0.7)).toFloat() }
    }

  /** Push everything (in [pushChunks] if given), end, pull everything (in [pullChunks] if given). */
  private fun run(
    sr: StreamResampler,
    input: Array<FloatArray>,
    pushChunks: Random? = null,
    pullChunks: Random? = null,
    interleave: Boolean = false,
  ): Array<FloatArray> {
    val total = input[0].size
    val out = Array(sr.channels) { FloatArray((total.toLong() * sr.outRate / sr.inRate + 16).toInt()) }
    val buf = Array(sr.channels) { FloatArray(4096) }
    var produced = 0
    fun drain() {
      while (true) {
        val want = pullChunks?.nextInt(1, 700) ?: 4096
        val n = sr.pull(buf, want)
        for (c in 0 until sr.channels) System.arraycopy(buf[c], 0, out[c], produced, n)
        produced += n
        if (n == 0) break
      }
    }
    var pushed = 0
    while (pushed < total) {
      val n = minOf(total - pushed, pushChunks?.nextInt(1, 1500) ?: total)
      sr.push(input, pushed, n)
      pushed += n
      if (interleave) {
        drain()
        // Never produced output that needs input not yet pushed: output k reads input up to
        // floor(k * ratio) + kernelSize / 2 - 1.
        if (!sr.passthrough && produced > 0) {
          val needed = floor((produced - 1) * sr.ratio).toLong() + SincResampler.MAX_KERNEL_SIZE / 2 - 1
          assertTrue("output $produced needs input $needed but only $pushed pushed", needed < pushed)
        }
      }
    }
    sr.endOfInput()
    drain()
    return Array(sr.channels) { c -> out[c].copyOf(produced) }
  }

  /** Least-squares fit y[n] ~ a sin(w n) + b cos(w n) over [from, to): returns (amplitude, phase). */
  private fun fit(y: FloatArray, from: Int, to: Int, w: Double): Pair<Double, Double> {
    var ss = 0.0; var sc = 0.0; var cc = 0.0; var ys = 0.0; var yc = 0.0
    for (n in from until to) {
      val s = sin(w * n); val co = kotlin.math.cos(w * n)
      ss += s * s; sc += s * co; cc += co * co; ys += y[n] * s; yc += y[n] * co
    }
    val det = ss * cc - sc * sc
    val a = (ys * cc - yc * sc) / det
    val b = (yc * ss - ys * sc) / det
    return hypot(a, b) to atan2(b, a)
  }

  /** Residual RMS after removing the fitted sinusoid (THD+N) and the error vs an ideal reference (SNR). */
  private fun db(x: Double) = 20 * log10(x)

  private fun rms(y: FloatArray, from: Int, to: Int): Double {
    var s = 0.0
    for (n in from until to) s += y[n].toDouble() * y[n]
    return sqrt(s / (to - from))
  }

  /** Frequency from linearly interpolated rising zero crossings over [from, to). */
  private fun zeroCrossingHz(y: FloatArray, from: Int, to: Int, rate: Int): Double {
    var first = -1.0; var last = -1.0; var count = 0
    for (n in from + 1 until to) {
      if (y[n - 1] < 0f && y[n] >= 0f) {
        val t = n - 1 + y[n - 1] / (y[n - 1] - y[n]).toDouble()
        if (first < 0) first = t
        last = t
        count++
      }
    }
    return (count - 1) / (last - first) * rate
  }

  private class Quality(val hz: Double, val snrDb: Double, val thdnDb: Double, val gainDb: Double, val delay: Double)

  /**
   * Resample a [hz] sine at [amp] from [inRate] to [outRate] and compare the steady-state output with
   * the ideal sine sampled at output time k, i.e. input time k * ratio (ratio = Blink's float ratio).
   */
  private fun quality(inRate: Int, outRate: Int, hz: Double, amp: Double, seconds: Double = 2.0): Quality {
    val n = (inRate * seconds).toInt()
    val sr = StreamResampler(inRate, outRate)
    val out = run(sr, sine(n, inRate, hz, amp))
    assertEquals("length", Math.round(n.toDouble() * outRate / inRate), out[0].size.toLong())
    val w = 2 * PI * hz / inRate * sr.ratio // radians per output frame
    val from = 2000
    val to = out[0].size - 2000
    val ch = out[0]
    var err = 0.0; var ref = 0.0
    for (k in from until to) {
      val ideal = amp * sin(w * k)
      err += (ch[k] - ideal) * (ch[k] - ideal)
      ref += ideal * ideal
    }
    val (a, ph) = fit(ch, from, to, w)
    var resid = 0.0
    for (k in from until to) {
      val r = ch[k] - a * sin(w * k + ph)
      resid += r * r
    }
    val hzMeasured = zeroCrossingHz(ch, from, to, outRate)
    return Quality(
      hz = hzMeasured,
      snrDb = 10 * log10(ref / err),
      thdnDb = 10 * log10(resid / ((to - from) * a * a / 2)),
      gainDb = db(a / amp),
      delay = -ph / w, // positive = output lags the ideal
    )
  }

  @Test fun kernelTableMatchesChromiumInitializeKernel() {
    // Reference values computed independently (Python/numpy, same float/double mix as
    // SincResampler::InitializeKernel, platform libm): (offset index, tap) -> float bits.
    val ratio = SincResampler.blinkMediaElementRatio(44100, 48000)
    assertEquals(0.918749988079071, ratio, 1e-15)
    val expected44 = mapOf(
      (0 to 32) to 0x3f6b851f, (16 to 32) to 0x3f2187a7, (7 to 40) to 0xbc7b7d9f.toInt(),
      (31 to 5) to 0xb904a595.toInt(), (32 to 63) to 0xb814e30f.toInt(),
    )
    val expected2 = mapOf(
      (0 to 32) to 0x3eeb851f, (16 to 32) to 0x3ed7575f, (7 to 40) to 0xbcfec398.toInt(),
      (31 to 5) to 0x3891699a, (32 to 63) to 0xb7b808cd.toInt(),
    )
    for ((r, expected) in listOf(ratio to expected44, 2.0 to expected2)) {
      val s = SincResampler(r, 128) { d, o, f -> d.fill(0f, o, o + f) }
      assertEquals(64, s.kernelSize)
      val k = s.kernelForTesting()
      for ((key, bits) in expected) {
        val v = k[key.first * 64 + key.second]
        assertEquals("ratio $r kernel[${key.first}][${key.second}] = $v", bits, v.toRawBits())
      }
    }
    // 0.92 at the centre tap of the zero-offset kernel: Blackman window 1.0 times sinc_scale_factor.
    report("kernel table: 10/10 sampled taps bit-equal to the independent InitializeKernel computation")
    // Kernel geometry the media-element path gets: 128 request frames -> 64 taps; 96 would give 32.
    assertEquals(64, SincResampler.kernelSizeFromRequestFrames(128))
    assertEquals(32, SincResampler.kernelSizeFromRequestFrames(96))
    val s = SincResampler(ratio, 128) { d, o, f -> d.fill(0f, o, o + f) }
    // block_size_ = r4 - r2 = 128 - 32 = 96 on the first load; chunk = (int)(96 / ratio) = 104.
    assertEquals(104, s.chunkSize())
  }

  @Test fun setRatioRebuildsTheSameKernelAsConstruction() {
    val a = SincResampler(2.0, 128) { d, o, f -> d.fill(0f, o, o + f) }
    val b = SincResampler(0.5, 128) { d, o, f -> d.fill(0f, o, o + f) }
    b.setRatio(2.0)
    assertArrayEquals(a.kernelForTesting(), b.kernelForTesting(), 0f)
  }

  @Test fun upsample44100To48000OneKilohertzAtMinus6dB() {
    val amp = 0.5011872336272722 // -6 dBFS
    val q = quality(44100, 48000, 1000.0, amp)
    val ratio = SincResampler.blinkMediaElementRatio(44100, 48000)
    val expectedHz = 1000.0 * ratio * 48000 / 44100
    report(
      "44100->48000 1 kHz -6 dBFS: freq %.5f Hz (expected %.5f), SNR vs ideal %.2f dB, THD+N %.2f dB, gain %.6f dB, delay %.6f output frames"
        .format(q.hz, expectedHz, q.snrDb, q.thdnDb, q.gainDb, q.delay),
    )
    assertEquals(expectedHz, q.hz, 0.001)
    assertTrue("SNR ${q.snrDb}", q.snrDb >= 90.0)
    assertTrue("THD+N ${q.thdnDb}", q.thdnDb <= -90.0)
    assertTrue("delay ${q.delay}", abs(q.delay) < 1.0)
    assertTrue("delay ${q.delay}", abs(q.delay) < 0.001) // zero group delay, not just < 1 frame
  }

  @Test fun exactLengthAfterEndOfInput() {
    for ((inRate, n) in listOf(44100 to 100000, 44100 to 147, 44100 to 1, 44100 to 73, 32000 to 12345, 96000 to 99999, 22050 to 777)) {
      val sr = StreamResampler(inRate, 48000)
      val out = run(sr, sine(n, inRate, 440.0, 0.3), Random(n), Random(n + 1), interleave = true)
      val expected = Math.round(n.toDouble() * 48000 / inRate)
      assertEquals("$inRate x $n", expected, out[0].size.toLong())
      // Finished: further pulls produce nothing.
      assertEquals(0, sr.pull(Array(2) { FloatArray(64) }, 64))
    }
    report("exact length round(N*48000/inRate) after endOfInput for 7 rate/length pairs (incl. N=1, N=147)")
  }

  @Test fun passbandFlatAndTwentyKilohertzReported() {
    val amp = 0.5
    val results = listOf(100.0, 10000.0, 18000.0, 20000.0).associateWith { quality(44100, 48000, it, amp) }
    for ((hz, q) in results) {
      report("44100->48000 %.0f Hz: gain %.4f dB, SNR vs ideal %.2f dB, THD+N %.2f dB".format(hz, q.gainDb, q.snrDb, q.thdnDb))
    }
    for (hz in listOf(100.0, 10000.0, 18000.0)) assertTrue("$hz gain", abs(results.getValue(hz).gainDb) <= 0.1)
    // 20 kHz is above the kernel's 0.92 * 22050 = 20286 Hz cutoff's transition start: Chromium's
    // kernel attenuates it by ~3.5 dB (numpy prediction from the same kernel: -3.49 dB).
    val g20 = results.getValue(20000.0).gainDb
    assertEquals(-3.49, g20, 0.25)
  }

  @Test fun downsample48000To44100RejectsTwentyThreeKilohertz() {
    val amp = 0.5
    val n = 96000
    val sr = StreamResampler(48000, 44100)
    val out = run(sr, sine(n, 48000, 23000.0, amp))
    assertEquals(Math.round(n * 44100.0 / 48000), out[0].size.toLong())
    val from = 2000
    val to = out[0].size - 2000
    val attenuation = db(rms(out[0], from, to) / (amp / sqrt(2.0)))
    // The 23 kHz tone would alias to 44100 - 23000 = 21100 Hz.
    val (alias, _) = fit(out[0], from, to, 2 * PI * 21100.0 / 44100)
    report("48000->44100 23 kHz: total output %.2f dB re input, alias at 21.1 kHz %.2f dB".format(attenuation, db(alias / amp)))
    assertTrue("attenuation $attenuation", attenuation <= -60.0)
    // And the passband still passes going down.
    val q = quality(48000, 44100, 1000.0, amp)
    report("48000->44100 1 kHz: freq %.4f Hz, SNR %.2f dB, THD+N %.2f dB, gain %.6f dB, delay %.6f"
      .format(q.hz, q.snrDb, q.thdnDb, q.gainDb, q.delay))
    assertTrue(q.snrDb >= 90.0)
  }

  @Test fun sameRateIsBitIdenticalPassthrough() {
    val rnd = Random(7)
    val input = Array(2) { FloatArray(50000) { rnd.nextFloat() * 2 - 1 } }
    val sr = StreamResampler(48000, 48000)
    assertTrue(sr.passthrough)
    val out = run(sr, input, Random(1), Random(2), interleave = true)
    for (c in 0 until 2) assertArrayEquals(input[c], out[c], 0f)
    for (c in 0 until 2) for (i in input[c].indices) assertEquals(input[c][i].toRawBits(), out[c][i].toRawBits())
    report("48000->48000: 50000 random frames, bit-identical passthrough")
  }

  @Test fun otherRatesBasicCorrectness() {
    for (inRate in listOf(32000, 96000, 22050, 88200)) {
      val q = quality(inRate, 48000, 1000.0, 0.5)
      val ratio = SincResampler.blinkMediaElementRatio(inRate, 48000)
      val expectedHz = 1000.0 * ratio * 48000 / inRate
      report("%d->48000 1 kHz: freq %.5f Hz (expected %.5f), SNR %.2f dB, THD+N %.2f dB, gain %.6f dB, delay %.6f"
        .format(inRate, q.hz, expectedHz, q.snrDb, q.thdnDb, q.gainDb, q.delay))
      assertEquals(expectedHz, q.hz, 0.001)
      assertTrue("$inRate SNR ${q.snrDb}", q.snrDb >= 90.0)
      assertTrue(abs(q.delay) < 1.0)
    }
  }

  private fun music(frames: Int, rate: Int, seed: Int): Array<FloatArray> {
    val rnd = Random(seed)
    return Array(2) { c ->
      FloatArray(frames) { n ->
        (0.3 * sin(2 * PI * 440.0 * n / rate + c) + 0.2 * sin(2 * PI * 3000.0 * n / rate) +
          0.1 * (rnd.nextDouble() * 2 - 1)).toFloat()
      }
    }
  }

  @Test fun chunkingIsBitIdentical() {
    for (inRate in listOf(44100, 32000, 96000, 48000)) {
      val input = music(60000, inRate, 3)
      val whole = run(StreamResampler(inRate, 48000), input)
      for (seed in 1..5) {
        val pushChunked = run(StreamResampler(inRate, 48000), input, pushChunks = Random(seed * 11), interleave = true)
        val pullChunked = run(StreamResampler(inRate, 48000), input, pullChunks = Random(seed * 13))
        val both = run(StreamResampler(inRate, 48000), input, Random(seed * 17), Random(seed * 19), interleave = true)
        for (variant in listOf(pushChunked, pullChunked, both)) {
          for (c in 0 until 2) {
            assertEquals(whole[c].size, variant[c].size)
            for (i in whole[c].indices) assertEquals("$inRate seed $seed ch $c frame $i", whole[c][i].toRawBits(), variant[c][i].toRawBits())
          }
        }
      }
    }
    report("chunking: 4 rates x 5 seeds x (push-chunked, pull-chunked, both, interleaved) bit-identical to one-shot")
  }

  @Test fun multiChannelMatchesIndependentMonoResamplers() {
    // MultiChannelResampler must give each channel exactly what a lone SincResampler would.
    val ratio = SincResampler.blinkMediaElementRatio(44100, 48000)
    val input = music(20000, 44100, 9)
    val outFrames = 20000
    val pos = IntArray(2)
    val mono = Array(2) { c ->
      val out = FloatArray(outFrames)
      val s = SincResampler(ratio, 128) { d, o, f ->
        for (i in 0 until f) d[o + i] = if (pos[c] + i < input[c].size) input[c][pos[c] + i] else 0f
        pos[c] += f
      }
      var done = 0
      while (done < outFrames) { val n = minOf(333, outFrames - done); s.resample(out, done, n); done += n }
      out
    }
    var mpos = 0
    val m = MultiChannelSincResampler(2, ratio, 128) { _, d, f ->
      for (c in 0 until 2) for (i in 0 until f) d[c][i] = if (mpos + i < input[c].size) input[c][mpos + i] else 0f
      mpos += f
    }
    val multi = Array(2) { FloatArray(outFrames) }
    m.resample(multi, 0, outFrames)
    for (c in 0 until 2) assertArrayEquals(mono[c], multi[c], 0f)
    // BufferedFrames = request_frames - virtual_source_idx: between 0 and 128 once primed.
    val buffered = m.bufferedFrames()
    assertTrue("buffered $buffered", buffered > 0 && buffered <= 128)
    report("multi-channel: 2 x 20000 frames bit-identical to independent mono SincResamplers; BufferedFrames %.4f".format(buffered))
  }

  /**
   * Seek: reset() then push from input frame P must reproduce the unbroken stream from output frame
   * K (K * ratio == P) once the kernel has settled — the first output frames see zeros where the
   * unbroken stream saw real history. Output j reads input P + floor(j * ratio) - 32 .. + 31, so it is
   * settled from j = ceil(32 / ratio).
   */
  private fun resetMatches(inRate: Int, p: Int, k: Int): Double {
    val input = music(30000, inRate, 5)
    val sr = StreamResampler(inRate, 48000)
    val whole = run(sr, input)
    // Warm the instance (push/pull part of the stream) before resetting, as a real seek would.
    val warm = StreamResampler(inRate, 48000)
    warm.push(input, 0, 9000)
    warm.pull(Array(2) { FloatArray(4000) }, 4000)
    warm.reset()
    val tail = Array(2) { c -> input[c].copyOfRange(p, input[c].size) }
    val after = run(warm, tail)
    val settle = kotlin.math.ceil(32 / warm.ratio).toInt()
    var maxDiff = 0.0
    for (c in 0 until 2) {
      for (j in settle until after[c].size - 64) {
        maxDiff = max(maxDiff, abs(after[c][j] - whole[c][k + j].toDouble()))
      }
    }
    // Before settling the difference is real (zero history), which is why the window starts there.
    var early = 0.0
    for (j in 0 until 8) early = max(early, abs(after[0][j] - whole[0][k + j].toDouble()))
    report("reset %d->48000 at input %d (output %d): settles after %d output frames; max |diff| after = %.3g (first 8 frames differ by up to %.3g)"
      .format(inRate, p, k, settle, maxDiff, early))
    return maxDiff
  }

  @Test fun resetThenSeekReproducesTheUnbrokenStream() {
    // 96 kHz -> 48 kHz has an exact ratio (2.0), so any even input frame lines up exactly.
    assertTrue(resetMatches(96000, 20000, 10000) <= 1e-6)
    // 44.1 kHz: 147 input frames = 160 output frames. Blink's ratio is float-rounded (1.3e-8 low), so
    // the unbroken stream at output 160m sits 160m * 1.2e-8 input frames before 147m: keep m small.
    assertTrue(resetMatches(44100, 147, 160) <= 1e-6)
    // 32 kHz: 2 input frames = 3 output frames, but float(32000/48000) is 2.0e-8 high, so output 3k
    // sits 6e-8 * k input frames after 2k: align at k = 1 (at k = 100 the drift alone gives 2.4e-6).
    assertTrue(resetMatches(32000, 2, 3) <= 1e-6)
  }

  @Test fun latencyIsZeroAndLookAheadIsBounded() {
    // An impulse at input 1470 (44.1 kHz) must peak at output 1600 = 1470 / ratio, and the response
    // must be centred there (energy centroid), i.e. no delay to compensate.
    val n = 4000
    val input = Array(2) { FloatArray(n) }
    input[0][1470] = 1f; input[1][1470] = 1f
    val out = run(StreamResampler(44100, 48000), input)
    var peak = 0
    for (i in out[0].indices) if (abs(out[0][i]) > abs(out[0][peak])) peak = i
    var e = 0.0; var et = 0.0
    for (i in 1500 until 1700) { val v = out[0][i].toDouble() * out[0][i]; e += v; et += v * i }
    val centroid = et / e
    report("44100->48000 impulse at input 1470: peak at output %d (ideal 1600, value %.6f), energy centroid %.4f (ideal %.4f)"
      .format(peak, out[0][peak], centroid, 1470 / SincResampler.blinkMediaElementRatio(44100, 48000)))
    assertEquals(1600, peak)
    assertEquals(1470 / SincResampler.blinkMediaElementRatio(44100, 48000), centroid, 0.05)

    // Look-ahead: with 127 frames pushed nothing comes out; at 128 (one Web Audio render quantum,
    // SincResampler's request size) the first block is available.
    val sr = StreamResampler(44100, 48000)
    val buf = Array(2) { FloatArray(1000) }
    sr.push(input, 0, 127)
    assertEquals(0, sr.pull(buf, 1000))
    sr.push(input, 127, 1)
    val first = sr.pull(buf, 1000)
    report("look-ahead: 0 output frames with 127 input frames pushed, $first with 128")
    assertTrue(first > 0)
  }
}
