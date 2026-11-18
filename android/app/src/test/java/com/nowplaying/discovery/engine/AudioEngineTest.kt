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
    val heard = mutableListOf<AudioEngine.Heard>()
    override fun onEnded(key: String, heard: AudioEngine.Heard) { log += "ended:$key"; this.heard += heard }
    override fun onAdvanced(key: String, outgoing: AudioEngine.Heard) { log += "advanced:$key"; heard += outgoing; onAdvance() }
    override fun onRepeated(key: String, heard: AudioEngine.Heard) { log += "repeated:$key"; this.heard += heard }
    override fun onBlendStarted(key: String, seconds: Double, style: TransitionStyle) { log += "blend:$key:${style.id}"; blendSeconds = seconds }
    var planned: BlendPlan? = null
    override fun onBlendPlanned(key: String, plan: BlendPlan) { planned = plan }
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

  @Test fun legacyPlayThroughAndEarlyCuePlanCannotStartTheNextSongBeforeDecoderEnd() {
    val plan = BlendPlan(1.0, 1.0, TransitionStyle.BLEND, endAt = 2.0, inStart = 0.5, rate = 0.96, beat = BeatFit.LOCKED)
    val (eng, ev, out) = cued(plan)
    val a = Tone(440.0, 10.0); val b = Tone(660.0, 10.0)
    eng.setMix(50)
    eng.setPlayThrough(50)
    eng.load("a", a)
    eng.setNext("b", b)
    eng.setCues("a", TrackCues(10.0, 0.0, 2.0, 1.0, null, null))
    eng.renderQuanta(quantaFor(9.9))
    assertEquals("the actual source remains primary", "a", eng.snapshot.key)
    assertTrue("no pre-end transition: ${ev.log}", ev.log.isEmpty())
    assertEquals("no incoming frames skipped or read", 0L, b.positionFrames)
    assertTrue("no cue seek before completion", b.seeks.isEmpty())
    assertTrue("original tail stays at full level", toneLevel(out, 440.0, 9.0, 9.8) > 0.25)
    assertTrue("no incoming audio over original", toneLevel(out, 660.0, 9.0, 9.8) < 0.01)
  }

  @Test fun aSongPlaysToTheEndAndTheControllerIsToldOnce() {
    val (eng, ev, out) = engine()
    eng.load("one", Tone(440.0, 2.0))
    eng.renderQuanta(quantaFor(3.0))
    assertEquals(listOf("ended:one"), ev.log)
    assertEquals("the whole song was heard", listOf(AudioEngine.Heard("one", 96000, 96000)), ev.heard)
    assertFalse("stops after the end", eng.snapshot.playing)
    assertFalse("output paused", out.playing)
    // Every frame of the song (plus the quantum it ended in) reached the output, and it was audible.
    assertTrue(out.left.size >= 96000 && out.left.size < 96000 + 128 * AudioEngine.CHUNK_QUANTA)
    assertTrue("audible", rms(out, 0.5, 1.5) > 0.1)
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

  @Test fun pausedRendersNothing() {
    val (eng, _, out) = engine()
    eng.load("a", Tone(440.0, 5.0), play = false)
    eng.renderQuanta(100)
    assertEquals(0, out.left.size)
    eng.play()
    eng.renderQuanta(8)
    assertEquals(1024, out.left.size)
  }

  @Test fun aSkippedStretchIsNotCountedAsHeard() {
    val (eng, ev, _) = engine()
    eng.load("a", Tone(440.0, 4.0))
    eng.renderQuanta(quantaFor(1.0))
    eng.seekTo(3 * 48000)
    eng.renderQuanta(quantaFor(1.5))
    assertEquals(listOf("ended:a"), ev.log)
    val h = ev.heard.single()
    assertEquals("heard = 1 s before the seek + the last 1 s, not 4 s", 2.0 * 48000, h.heardFrames.toDouble(), 2.0 * 128)
    assertEquals(4L * 48000, h.durationFrames)
  }

  /** A stand-in for the cue planner: whatever plan the test wants, for a song whose cues are known. */
  private fun cued(plan: BlendPlan, events: Events = Events(), out: Capture = Capture()): Triple<AudioEngine, Events, Capture> {
    val cuePlanner = CuePlanner { slider, _, _, _, _, _ -> if (slider <= 0) BlendPlan(0.0, Double.POSITIVE_INFINITY, TransitionStyle.CUT) else plan }
    return Triple(AudioEngine(out, planner, events, cuePlanner = cuePlanner), events, out)
  }
  private val anyCues = TrackCues(10.0, 0.0, 10.0, 10.0, null, null)

  @Test fun handoffHappensOnlyAfterTheLastOriginalFrameAndIncomingStartsAtZero() {
    val (eng, ev, out) = engine()
    val a = Tone(440.0, 1.0); val b = Tone(660.0, 8.0)
    var atPromotion = -1L
    ev.onAdvance = { atPromotion = b.positionFrames }
    eng.setMix(50); eng.load("a", a); eng.setNext("b", b)
    eng.renderQuanta(374)
    assertTrue(ev.log.isEmpty()); assertEquals("a", eng.snapshot.key)
    assertEquals(0L, b.positionFrames)
    eng.renderQuanta(1)
    assertEquals(listOf("blend:b:blend", "advanced:b"), ev.log)
    assertEquals(48000, out.left.size)
    assertEquals(0L, atPromotion)
    assertEquals(listOf(0L), b.seeks)
    assertEquals(listOf(AudioEngine.Heard("a", 48000, 48000)), ev.heard)
    assertTrue(a.closed); assertEquals("b", eng.snapshot.key)
    eng.renderQuanta(100)
    assertEquals("promotion never restarts the new source", listOf(0L), b.seeks)
    assertEquals(12800L, b.positionFrames)
  }

  @Test fun originalTailIsUnattenuatedAndPostEndRampSurvivesPreparingAnotherSong() {
    val (eng, ev, out) = engine()
    eng.setVolume(0.7); eng.setMix(50)
    eng.load("a", Tone(440.0, 1.0)); eng.setNext("b", Tone(660.0, 20.0))
    eng.renderQuanta(375)
    assertEquals(2.0, ev.blendSeconds, 0.0)
    assertTrue(toneLevel(out, 440.0, 0.7, 0.99) > 0.19)
    assertTrue(toneLevel(out, 660.0, 0.7, 0.99) < 0.01)
    eng.setNext("c", Tone(880.0, 8.0))
    eng.renderQuanta(quantaFor(2.5))
    val early = toneLevel(out, 660.0, 1.02, 1.10)
    val late = toneLevel(out, 660.0, 3.1, 3.4)
    assertTrue("not cut to full level on promotion/preparation: $early vs $late", early < late / 4)
    assertTrue("ramp reaches full level: $late", late > 0.19)
    assertEquals("slider never changes master volume", 0.7, eng.bus.masterGain().toDouble(), 0.0001)
    assertEquals("c is only prepared, not primary", "b", eng.snapshot.key)
  }

  private fun assertDurationCannotTriggerHandoff(reported: Long) {
    val (eng, ev, out) = engine()
    val real = Tone(440.0, 2.0)
    val misleading = object : PcmSource by real { override val durationFrames = reported }
    val b = Tone(660.0, 8.0)
    eng.setMix(100); eng.setPlayThrough(50)
    eng.load("a", misleading); eng.setNext("b", b)
    eng.renderQuanta(quantaFor(1.9))
    assertEquals("a", eng.snapshot.key); assertTrue(ev.log.isEmpty())
    assertEquals(0L, b.positionFrames)
    assertTrue(toneLevel(out, 440.0, 1.2, 1.8) > 0.25)
    eng.renderQuanta(quantaFor(0.2))
    assertEquals("b", eng.snapshot.key)
    assertEquals(96000L, ev.heard.single().heardFrames)
  }

  @Test fun unknownDurationWaitsForActualDecoderEnd() = assertDurationCannotTriggerHandoff(PcmSource.UNKNOWN)
  @Test fun shortenedContainerDurationDoesNotCutOriginalPcm() = assertDurationCannotTriggerHandoff(24000)
  @Test fun overlongContainerDurationDoesNotDelayActualCompletion() = assertDurationCannotTriggerHandoff(480000)

  @Test fun partialFinalQuantumIsRenderedBeforeIncomingIsRead() {
    val (eng, ev, out) = engine()
    val a = Tone(440.0, 1.001); val b = Tone(660.0, 8.0)
    eng.setMix(20); eng.load("a", a); eng.setNext("b", b)
    eng.renderQuanta(376)
    assertEquals(a.durationFrames, ev.heard.single().heardFrames)
    assertEquals(0L, b.positionFrames)
    assertTrue(out.left.size >= a.durationFrames)
    eng.renderQuanta(1); assertEquals(128L, b.positionFrames)
  }

  @Test fun temporaryUnderrunIsNotCompletionEvenPastReportedDuration() {
    val (eng, ev, _) = engine()
    var allow = false
    val real = Tone(440.0, 2.0)
    val source = object : PcmSource by real {
      override val durationFrames = 1L
      override fun read(dst: Array<FloatArray>, offset: Int, frames: Int) = if (allow) real.read(dst, offset, frames) else 0
    }
    val b = Tone(660.0, 8.0)
    eng.setMix(50); eng.load("a", source); eng.setNext("b", b)
    eng.renderQuanta(20)
    assertTrue(ev.log.isEmpty()); assertEquals(0L, b.positionFrames)
    allow = true
    eng.renderQuanta(quantaFor(2.1)); assertEquals("b", eng.snapshot.key)
  }

  @Test fun mixerOffStillPromotesPreparedNextButNeverSchedulesFade() {
    val (eng, ev, _) = engine()
    eng.load("a", Tone(440.0, 1.0)); eng.setNext("b", Tone(660.0, 8.0))
    eng.renderQuanta(375)
    assertEquals(listOf("advanced:b"), ev.log)
    assertEquals("b", eng.snapshot.key)
    assertEquals(null, eng.snapshot.blendingInto)
  }

  @Test fun turningMixerOffKeepsPreparedNextForEndOnlyHandoff() {
    val (eng, ev, _) = engine()
    val b = Tone(660.0, 8.0)
    eng.setMix(50); eng.load("a", Tone(440.0, 1.0)); eng.setNext("b", b)
    eng.renderQuanta(200); eng.setMix(0); eng.renderQuanta(175)
    assertEquals(listOf("advanced:b"), ev.log); assertFalse(b.closed)
  }

  @Test fun seekKeepsPreparedNextButNeverUsesAnEarlyCueBoundary() {
    val (eng, ev, _) = cued(BlendPlan(1.0, 3.0, TransitionStyle.BLEND, endAt = 4.0, inStart = 0.5))
    val b = Tone(660.0, 8.0)
    eng.setMix(50); eng.load("a", Tone(440.0, 10.0)); eng.setNext("b", b); eng.setCues("a", anyCues)
    eng.renderQuanta(quantaFor(5.0)); eng.seekTo(2 * 48000); eng.renderQuanta(quantaFor(7.9))
    assertTrue(ev.log.isEmpty()); assertEquals("a", eng.snapshot.key); assertEquals(0L, b.positionFrames)
    eng.renderQuanta(quantaFor(0.2))
    assertEquals(listOf("blend:b:blend", "advanced:b"), ev.log); assertEquals(listOf(0L), b.seeks)
  }

  @Test fun legacyTempoAndIntroCuesCannotSkipOrRetimeTheIncomingSource() {
    val plan = BlendPlan(1.0, 0.0, TransitionStyle.BASS_SWAP, endAt = 0.5, inStart = 0.75, rate = 0.94, beat = BeatFit.LOCKED)
    val (eng, _, _) = cued(plan)
    val b = Tone(660.0, 8.0)
    eng.setMix(60); eng.load("a", Tone(440.0, 1.0)); eng.setNext("b", b); eng.setCues("a", anyCues)
    eng.renderQuanta(375); eng.renderQuanta(100)
    assertEquals(listOf(0L), b.seeks); assertEquals(12800L, b.positionFrames)
  }

  @Test fun sliderControlsPostEndFadeDurationOnly() {
    fun span(slider: Int): Double {
      val (eng, ev, _) = engine()
      eng.setMix(slider); eng.load("a", Tone(440.0, 1.0)); eng.setNext("b", Tone(660.0, 120.0))
      eng.renderQuanta(375)
      assertEquals(48000L, ev.heard.single().heardFrames)
      return ev.blendSeconds.also { eng.close() }
    }
    assertTrue(span(1) < span(25)); assertEquals(2.0, span(50), 0.0)
  }

  @Test fun shortIncomingSongLimitsFadeToTenPercentAndUnknownDurationUsesTwoSeconds() {
    for ((reported, expected) in listOf(192000L to 0.4, PcmSource.UNKNOWN to 2.0)) {
      val (eng, ev, _) = engine()
      val tone = Tone(660.0, 8.0)
      val b = object : PcmSource by tone { override val durationFrames = reported }
      eng.setMix(100); eng.load("a", Tone(440.0, 1.0)); eng.setNext("b", b)
      eng.renderQuanta(375)
      assertEquals(expected, ev.blendSeconds, 0.000001)
      assertEquals(0L, b.positionFrames)
      eng.close()
    }
  }

  @Test fun incomingDecoderErrorCannotInterruptOrShortenTheOriginal() {
    val (eng, ev, _) = engine()
    val tone = Tone(660.0, 8.0)
    val broken = object : PcmSource by tone { override val error = IllegalStateException("bad incoming decoder") }
    eng.setMix(100); eng.load("a", Tone(440.0, 1.0)); eng.setNext("b", broken)
    eng.renderQuanta(374)
    assertTrue(ev.log.isEmpty()); assertEquals("a", eng.snapshot.key)
    eng.renderQuanta(1)
    assertEquals(listOf("ended:a"), ev.log); assertEquals(0L, tone.positionFrames)
    assertEquals(48000L, ev.heard.single().heardFrames)
  }

  @Test fun explicitManualLoadMayReplaceTheOriginalBeforeEnd() {
    val (eng, ev, _) = engine()
    eng.load("a", Tone(440.0, 10.0)); eng.renderQuanta(100)
    eng.load("b", Tone(660.0, 8.0)); eng.renderQuanta(1)
    assertEquals("b", eng.snapshot.key); assertTrue(ev.log.isEmpty())
  }

  @Test fun unavailableNextReportsEndWithoutReadingIt() {
    val (eng, ev, _) = engine()
    val b = Tone(660.0, 8.0)
    val waiting = object : PcmSource by b { override val ready = false }
    eng.setMix(50); eng.load("a", Tone(440.0, 1.0)); eng.setNext("b", waiting)
    eng.renderQuanta(375)
    assertEquals(listOf("ended:a"), ev.log); assertEquals(0L, b.positionFrames)
  }
}
