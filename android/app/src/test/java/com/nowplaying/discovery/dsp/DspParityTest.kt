package com.nowplaying.discovery.dsp

import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.abs
import kotlin.math.log10

/**
 * The native mixer against the reference fixtures rendered by Chromium from the app's real
 * audio-bus.ts / eq.ts (tools/dsp-parity/CONTRACT.md). Fails — never skips — without fixtures.
 */
class DspParityTest {
  private data class Metric(val name: String, val maxErr: Double, val errToSignalDb: Double, val passed: Boolean)

  @Test fun everyScenarioMatchesTheChromiumReference() {
    val manifestStream = javaClass.classLoader?.getResourceAsStream("dsp-parity/manifest.json")
      ?: fail("DSP parity fixtures are missing: no dsp-parity/manifest.json on the test classpath " +
        "(android/app/src/test/resources/dsp-parity/). Generate them with `node tools/dsp-parity/render-reference.mjs`.") as Nothing
    @Suppress("UNCHECKED_CAST")
    val manifest = MiniJson.parse(manifestStream.use { it.readBytes().toString(Charsets.UTF_8) }) as Map<String, Any?>
    assertTrue("sampleRate must be 48000", (manifest["sampleRate"] as Double) == 48000.0)
    assertTrue("quantum must be 128", (manifest["quantum"] as Double) == 128.0)
    @Suppress("UNCHECKED_CAST")
    val scenarios = manifest["scenarios"] as List<Map<String, Any?>>
    assertTrue("manifest lists no scenarios", scenarios.isNotEmpty())

    val metrics = ArrayList<Metric>()
    val problems = ArrayList<String>()
    for (sc in scenarios) {
      val name = sc["name"] as String
      val file = sc["file"] as String
      val frames = (sc["frames"] as Double).toInt()
      val reference = javaClass.classLoader?.getResourceAsStream("dsp-parity/$file")?.use { it.readBytes() }
      if (reference == null) {
        problems += "$name: fixture dsp-parity/$file is missing"
        println(String.format("%-28s MISSING FIXTURE", name))
        continue
      }
      if (reference.size != frames * 2 * 4) {
        problems += "$name: fixture has ${reference.size} bytes, expected ${frames * 8}"
        continue
      }
      val rendered = try {
        render(sc, frames)
      } catch (e: Exception) {
        problems += "$name: render threw ${e::class.simpleName}: ${e.message}"
        println(String.format("%-28s RENDER FAILED: %s", name, e.message))
        continue
      }
      val ref = ByteBuffer.wrap(reference).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer()
      var maxErr = 0.0
      var errSq = 0.0
      var refSq = 0.0
      var worstAt = 0
      for (n in 0 until frames * 2) {
        val r = ref.get(n).toDouble()
        val e = rendered[n].toDouble() - r
        if (abs(e) > maxErr || e.isNaN()) {
          maxErr = if (e.isNaN()) Double.POSITIVE_INFINITY else abs(e)
          worstAt = n
        }
        errSq += e * e
        refSq += r * r
      }
      val ratioDb = 10 * log10(errSq / refSq)
      val passed = maxErr <= 1e-3 && ratioDb <= -60.0
      metrics += Metric(name, maxErr, ratioDb, passed)
      println(String.format("%-28s max|err| = %.3e  err/signal = %8.2f dB  worst at frame %d ch %d  %s",
        name, maxErr, ratioDb, worstAt / 2, worstAt % 2, if (passed) "PASS" else "FAIL"))
      if (!passed) problems += String.format("%s: max|err| %.3e (limit 1e-3), err/signal %.2f dB (limit -60 dB)", name, maxErr, ratioDb)
    }
    if (problems.isNotEmpty()) fail("DSP parity failed:\n" + problems.joinToString("\n"))
    println("DSP parity: ${metrics.size} scenarios pass (max ${String.format("%.3e", metrics.maxOf { it.maxErr })})")
  }

  @Suppress("UNCHECKED_CAST")
  private fun render(sc: Map<String, Any?>, frames: Int): FloatArray {
    val inputs = sc["inputs"] as Map<String, Any?>
    val a = deckInput(inputs["a"] as List<Map<String, Any?>>, frames)
    val b = deckInput(inputs["b"] as List<Map<String, Any?>>, frames)
    val bus = MixBus(RenderContext(48000f, 128), eqConfig(sc["initialEq"] as Map<String, Any?>))
    bus.attach(bus.createSource(), "a")
    bus.attach(bus.createSource(), "b")
    val actions = (sc["actions"] as List<Map<String, Any?>>).map { (it["frame"] as Double).toInt() to it }
    val out = arrayOf(FloatArray(frames), FloatArray(frames))
    var offset = 0
    while (offset < frames) {
      for ((frame, action) in actions) if (frame == offset) perform(bus, action)
      bus.process(a, b, out, offset)
      offset += 128
    }
    val interleaved = FloatArray(frames * 2)
    for (n in 0 until frames) {
      interleaved[2 * n] = out[0][n]
      interleaved[2 * n + 1] = out[1][n]
    }
    return interleaved
  }

  @Suppress("UNCHECKED_CAST")
  private fun perform(bus: MixBus, action: Map<String, Any?>) {
    val args = action["args"] as List<Any?>
    when (val op = action["op"] as String) {
      "setEq" -> bus.setEq(eqConfig(args[0] as Map<String, Any?>))
      "transitionTo" -> bus.transitionTo(args[0] as String, args[1] as Double, TransitionStyle.of(args[2] as String))
      "crossfadeTo" -> bus.crossfadeTo(args[0] as String, args[1] as Double)
      "cut" -> bus.cut(args[0] as String)
      "setMasterGain" -> bus.setMasterGain(args[0] as Double)
      else -> error("unknown op $op")
    }
  }

  @Suppress("UNCHECKED_CAST")
  private fun eqConfig(m: Map<String, Any?>): EqConfig = EqConfig(
    on = m["on"] as Boolean,
    presetId = m["presetId"] as String,
    gains = (m["gains"] as List<Double>),
    preampDb = m["preampDb"] as Double,
    limiter = m["limiter"] as Boolean,
    toneHz = m["toneHz"] as Double?,
    toneDb = if (m.containsKey("toneDb")) m["toneDb"] as Double? else EqMath.SOLFEGGIO_DB,
  )

  @Suppress("UNCHECKED_CAST")
  private fun deckInput(specs: List<Map<String, Any?>>, frames: Int): Array<FloatArray> =
    Array(2) { ch ->
      val spec = specs[ch]
      generateChannel(
        (spec["seed"] as Double).toLong().toInt(),
        spec["noiseAmp"] as Double,
        (spec["sines"] as List<List<Double>>).map { it[0] to it[1] },
        frames,
      )
    }

  companion object {
    /** CONTRACT.md's input generator: xorshift32 noise + float64 sines (fdlibm sin, as V8), rounded to float32. */
    fun generateChannel(seed: Int, noiseAmp: Double, sines: List<Pair<Double, Double>>, frames: Int): FloatArray {
      val out = FloatArray(frames)
      var x = seed
      for (n in 0 until frames) {
        x = x xor (x shl 13)
        x = x xor (x ushr 17)
        x = x xor (x shl 5)
        val u = (x.toLong() and 0xffffffffL) / 4294967296.0
        val noise = (u * 2 - 1) * noiseAmp
        var value = 0.0
        for ((hz, amp) in sines) value += amp * StrictMath.sin((2 * Math.PI * hz * n) / 48000)
        out[n] = (value + noise).toFloat()
      }
      return out
    }  }
}
