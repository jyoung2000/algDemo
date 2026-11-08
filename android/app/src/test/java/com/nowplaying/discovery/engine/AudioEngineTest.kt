package com.nowplaying.discovery.engine

import com.nowplaying.discovery.dsp.TransitionStyle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * The engine's behaviour, not its DSP (DspParityTest covers that): when a blend starts, that the
 * incoming song is never restarted when it is promoted, repeat-one, the mixer off, seeking, and that
 * every frame rendered reaches the output. Synthetic sources and a stand-in planner keep it exact.
 */
class AudioEngineTest {
  /** A tone of known length; reports exactly what it was asked for, like a fully buffered song. */
  private class Tone(val hz: Double, seconds: Double, val amp: Double = 0.3) : PcmSource {
    override val durationFrames = (seconds * 48000).toLong()
    override var positionFrames = 0L
    override val ready get() = true
    override val ended get() = positionFrames >= durationFrames
    override val error: Throwable? = null
    var seeks = mutableListOf<Long>()
    var closed = false
    override fun read(dst: Array<FloatArray>, offset: Int, frames: Int): Int {
      val n = min(frames.toLong(), durationFrames - positionFrames).toInt().coerceAtLeast(0)
      for (i in 0 until n) {
        val v = (amp * sin(2 * PI * hz * (positionFrames + i) / 48000.0)).toFloat()
        dst[0][offset + i] = v
        dst[1][offset + i] = v
      }
      positionFrames += n
      return n
    }
    override fun seekTo(frame: Long) { seeks += frame; positionFrames = frame.coerceIn(0, durationFrames) }
    override fun close() { closed = true }
  }

  private class Capture : AudioOutput {
    override val sampleRate = 48000
    val left = ArrayList<Float>()
    var playing = false
    var flushes = 0
    override fun write(interleaved: FloatArray, frames: Int): Int {
      for (i in 0 until frames) left += interleaved[2 * i]
      return frames
    }
    override fun play() { playing = true }
    override fun pause() { playing = false }
    override fun flush() { flushes++ }
    override fun pendingFrames() = 0L
    override fun close() {}
  }

  private class Events : AudioEngine.Listener {
    val log = mutableListOf<String>()
    var blendSeconds = 0.0
    var onAdvance: () -> Unit = {}
    override fun onEnded(key: String) { log += "ended:$key" }
    override fun onAdvanced(key: String) { log += "advanced:$key"; onAdvance() }
    override fun onRepeated(key: String) { log += "repeated:$key" }
    override fun onBlendStarted(key: String, seconds: Double, style: TransitionStyle) { log += "blend:$key:${style.id}"; blendSeconds = seconds }
  }

  /** Stand-in for mixPlan: blend the last 5% of the outgoing song, at most 1 s, starting at the play-through point. */
  private val planner = BlendPlanner { slider, out, _, minPlayed ->
    if (slider <= 0 || !out.isFinite()) BlendPlan(0.0, Double.POSITIVE_INFINITY, TransitionStyle.CUT)
    else {
      val start = out * minPlayed
      BlendPlan(min(1.0, out - start), start, TransitionStyle.BLEND)
    }
  }

  private fun engine(events: Events = Events(), out: Capture = Capture()) = Triple(AudioEngine(out, planner, events), events, out)
  private fun quantaFor(seconds: Double) = (seconds * 48000 / 128).toInt()

  /** RMS of the captured left channel over [from, to) seconds, and its correlation with a pure tone. */
  private fun rms(out: Capture, from: Double, to: Double): Double {
    val a = (from * 48000).toInt(); val b = min((to * 48000).toInt(), out.left.size)
    var s = 0.0
    for (i in a until b) s += out.left[i].toDouble() * out.left[i]
    return sqrt(s / max(1, b - a))
  }

  private fun toneLevel(out: Capture, hz: Double, from: Double, to: Double): Double {
    val a = (from * 48000).toInt(); val b = min((to * 48000).toInt(), out.left.size)
    var re = 0.0; var im = 0.0
    for (i in a until b) {
      val w = 2 * PI * hz * i / 48000.0
      re += out.left[i] * kotlin.math.cos(w); im += out.left[i] * sin(w)
    }
    return 2 * sqrt(re * re + im * im) / max(1, b - a)
  }

  @Test fun aSongPlaysToTheEndAndTheControllerIsToldOnce() {
    val (eng, ev, out) = engine()
    eng.load("one", Tone(440.0, 2.0))
    eng.renderQuanta(quantaFor(3.0))
    assertEquals(listOf("ended:one"), ev.log)
    assertFalse("stops after the end", eng.snapshot.playing)
    assertFalse("output paused", out.playing)
    // Every frame of the song (plus the quantum it ended in) reached the output, and it was audible.
    assertTrue(out.left.size >= 96000 && out.left.size < 96000 + 128 * AudioEngine.CHUNK_QUANTA)
    assertTrue("audible", rms(out, 0.5, 1.5) > 0.1)
  }

  @Test fun withTheMixerOnTheNextSongBlendsInAtThePlayThroughPointAndIsNotRestarted() {
    val (eng, ev, out) = engine()
    val a = Tone(440.0, 10.0); val b = Tone(660.0, 10.0)
    var bAtPromotion = -1L
    ev.onAdvance = { bAtPromotion = b.positionFrames }
    eng.setMix(50)
    eng.load("a", a)
    eng.setNext("b", b)
    eng.renderQuanta(quantaFor(9.4))
    assertTrue("no blend before 95%: ${ev.log}", ev.log.isEmpty())
    assertEquals("b waits untouched", 0L, b.positionFrames)
    eng.renderQuanta(quantaFor(0.2))
    assertEquals(listOf("blend:b:blend"), ev.log)
    assertEquals(0.5, ev.blendSeconds, 0.01)
    eng.renderQuanta(quantaFor(0.5))
    assertEquals(listOf("blend:b:blend", "advanced:b"), ev.log)
    assertEquals("b", eng.snapshot.key)
    assertTrue("still playing after the handoff", eng.snapshot.playing)
    // Promotion kept b's playhead, it did not seek b back to zero a second time. At the handoff b has
    // played exactly the blend: a ends at 10.0 s, the blend began at 9.5 s.
    assertEquals(listOf(0L), b.seeks)
    assertTrue("b is ~0.5 s in at promotion: $bAtPromotion", abs(bAtPromotion - 24000) <= 128)
    assertTrue("a was released", a.closed)
    // What was heard: a alone before, b alone after.
    assertTrue(toneLevel(out, 440.0, 8.0, 9.0) > 0.25 && toneLevel(out, 660.0, 8.0, 9.0) < 0.01)
    eng.renderQuanta(quantaFor(1.0))
    assertTrue(toneLevel(out, 660.0, 10.2, 10.9) > 0.25 && toneLevel(out, 440.0, 10.2, 10.9) < 0.01)
  }

  @Test fun repeatOneReplaysTheSongAndNeverBlends() {
    val (eng, ev, _) = engine()
    val a = Tone(440.0, 2.0)
    eng.setMix(100)
    eng.setRepeatOne(true)
    eng.load("a", a)
    eng.setNext("b", Tone(660.0, 2.0))
    eng.renderQuanta(quantaFor(2.1))
    assertEquals(listOf("repeated:a"), ev.log)
    assertTrue(eng.snapshot.playing)
    assertTrue("restarted near the top: ${a.positionFrames}", a.positionFrames < 48000 * 0.2)
  }

  @Test fun withTheMixerOffSongsHandOverCleanly() {
    val (eng, ev, _) = engine()
    eng.load("a", Tone(440.0, 2.0))
    eng.setNext("b", Tone(660.0, 2.0))
    eng.renderQuanta(quantaFor(2.5))
    assertEquals(listOf("ended:a"), ev.log)
  }

  @Test fun seekingDuringABlendAbandonsIt() {
    val (eng, ev, out) = engine()
    val b = Tone(660.0, 10.0)
    eng.setMix(50)
    eng.load("a", Tone(440.0, 10.0))
    eng.setNext("b", b)
    eng.renderQuanta(quantaFor(9.7))
    assertEquals(listOf("blend:b:blend"), ev.log)
    eng.seekTo(48000L * 2)
    eng.renderQuanta(1)
    assertTrue("spare released", b.closed)
    assertEquals(null, eng.snapshot.blendingInto)
    assertTrue("output flushed for the seek", out.flushes >= 2)
    assertEquals(2.0, eng.snapshot.positionFrames / 48000.0, 0.01)
  }

  @Test fun pausedRendersNothing() {
    val (eng, _, out) = engine()
    eng.load("a", Tone(440.0, 5.0), play = false)
    eng.renderQuanta(100)
    assertEquals(0, out.left.size)
    eng.play()
    eng.renderQuanta(8)
    assertEquals(1024, out.left.size)
  }
}
