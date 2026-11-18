package com.nowplaying.discovery.engine

import com.nowplaying.discovery.dsp.MiniJson
import com.nowplaying.discovery.dsp.TransitionStyle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.sin

/**
 * DJ-XFADE-001 parity: engine/TrackCues.kt and the cued half of engine/MixPlan.kt against vectors
 * that tools/dsp-parity/cue-vectors.mjs produced from the real web/src/engine/track-cues.ts and
 * crossfade.ts. The songs are synthesised here from the same formula, so the phone is shown to
 * measure the same cues from the same audio, and to plan the same blend from the same cues.
 */
class TrackCuesTest {
  @Suppress("UNCHECKED_CAST")
  private fun Any?.obj() = this as Map<String, Any?>

  @Suppress("UNCHECKED_CAST")
  private fun Any?.list() = this as List<Any?>

  private fun d(v: Any?): Double = v as Double

  private val vectors: Map<String, Any?> by lazy {
    val stream = javaClass.classLoader?.getResourceAsStream("track-cues/vectors.json")
      ?: fail("cue vectors are missing: no track-cues/vectors.json on the test classpath. " +
        "Generate them with `node tools/dsp-parity/cue-vectors.mjs`.") as Nothing
    MiniJson.parse(stream.use { it.readBytes().toString(Charsets.UTF_8) }).obj()
  }

  /** cue-vectors.mjs `song`: float64 arithmetic, rounded to float32 once. */
  private fun song(spec: Map<String, Any?>, rate: Double): FloatArray {
    val seconds = d(spec["seconds"]); val bpm = d(spec["bpm"]); val first = d(spec["first"]); val lead = d(spec["lead"])
    val fade = d(spec["fade"]); val trail = d(spec["trail"]); val slipAt = d(spec["slipAt"])
    val n = floor(seconds * rate).toInt()
    val x = FloatArray(n)
    val musicEnd = seconds - trail
    val fadeFrom = musicEnd - fade
    var seed = d(spec["seed"]).toLong().toInt()
    val beat = if (bpm > 0) 60 / bpm else 0.0
    for (i in 0 until n) {
      val t = i / rate
      seed = seed xor (seed shl 13)
      seed = seed xor (seed ushr 17)
      seed = seed xor (seed shl 5)
      if (t < lead || t >= musicEnd) continue
      val level = if (t > fadeFrom) max(0.0, (musicEnd - t) / fade) else 1.0
      val u = (seed.toLong() and 0xffffffffL) / 4294967296.0
      var v = 0.08 * sin(2 * Math.PI * 220 * t) + 0.02 * (u * 2 - 1)
      if (beat > 0) {
        val origin = first + (if (slipAt >= 0 && t >= slipAt) beat / 2 else 0.0)
        val since = (((t - origin) % beat) + beat) % beat
        if (t >= origin) v += 0.7 * exp(-since * 28) * sin(2 * Math.PI * 60 * since)
      }
      x[i] = (v * level).toFloat()
    }
    return x
  }

  private fun grid(v: Any?): BeatGrid? = (v as Map<*, *>?)?.let { BeatGrid(d(it["bpm"]), d(it["beatAt"]), d(it["confidence"])) }

  private fun cues(v: Any?): TrackCues? = (v as Map<*, *>?)?.let {
    TrackCues(d(it["duration"]), d(it["start"]), d(it["end"]), d(it["fullEnd"]), grid(it["head"]), grid(it["tail"]))
  }

  private val problems = ArrayList<String>()
  private fun near(where: String, expected: Double, actual: Double, tolerance: Double) {
    if (!(abs(expected - actual) <= tolerance) && problems.size < 30) problems += "$where: expected $expected, got $actual"
  }

  private fun compareGrid(where: String, expected: BeatGrid?, actual: BeatGrid?) {
    if ((expected == null) != (actual == null)) { problems += "$where: expected $expected, got $actual"; return }
    if (expected == null || actual == null) return
    // The grid is a search over float sums; JS and the JVM may differ in the last bits of exp/sin.
    near("$where.bpm", expected.bpm, actual.bpm, 1e-6)
    near("$where.beatAt", expected.beatAt, actual.beatAt, 1e-6)
    near("$where.confidence", expected.confidence, actual.confidence, 1e-6 * max(1.0, expected.confidence))
    if (Cues.gridUsable(expected) != Cues.gridUsable(actual)) problems += "$where: trusted differs"
  }

  private fun compareCues(where: String, expected: TrackCues, actual: TrackCues) {
    near("$where.duration", expected.duration, actual.duration, 1e-9)
    near("$where.start", expected.start, actual.start, 1e-9)
    near("$where.end", expected.end, actual.end, 1e-9)
    near("$where.fullEnd", expected.fullEnd, actual.fullEnd, 1e-9)
    compareGrid("$where.head", expected.head, actual.head)
    compareGrid("$where.tail", expected.tail, actual.tail)
  }

  @Test fun theSameAudioGivesTheSameCuesAsTrackCuesTs() {
    val rate = d(vectors["rate"])
    val songs = vectors["songs"].list()
    assertTrue("too few songs: ${songs.size}", songs.size >= 10)
    var trusted = 0
    for ((i, entry) in songs.withIndex()) {
      val e = entry.obj()
      val want = cues(e["cues"])!!
      val got = Cues.analyseCues(song(e["spec"].obj(), rate), rate)
      compareCues("song[$i]", want, got)
      if (Cues.gridUsable(got.tail)) trusted += 1
    }
    assertTrue("mismatches:\n" + problems.joinToString("\n"), problems.isEmpty())
    // The vectors exercise both outcomes: grids that are trusted and grids that are not.
    assertTrue("trusted tails: $trusted of ${songs.size}", trusted in 4 until songs.size)
  }

  @Test fun measuringFromTheTwoEndsAloneMatchesToo() {
    val rate = d(vectors["rate"])
    val ends = vectors["ends"].list()
    assertTrue(ends.size >= 5)
    for ((i, entry) in ends.withIndex()) {
      val e = entry.obj()
      val x = song(e["spec"].obj(), rate)
      val head = d(e["headFrames"]).toInt(); val tail = d(e["tailFrames"]).toInt()
      val got = Cues.analyseEnds(x.copyOfRange(0, head), x.copyOfRange(x.size - tail, x.size), rate, d(e["spec"].obj()["seconds"]))
      compareCues("ends[$i]", cues(e["cues"])!!, got)
    }
    assertTrue("mismatches:\n" + problems.joinToString("\n"), problems.isEmpty())
  }

  @Test fun theSameCuesGiveTheSamePlanAsCrossfadeTs() {
    val plans = vectors["plans"].list()
    assertTrue("too few plans: ${plans.size}", plans.size >= 500)
    val fits = HashSet<String>()
    for ((i, entry) in plans.withIndex()) {
      val e = entry.obj()
      val want = e["plan"].obj()
      val got = Crossfade.mixPlan(d(e["slider"]), d(e["outSeconds"]), d(e["inSeconds"]),
        MixInputs(minPlayedFraction = d(e["minPlayedFraction"]), outCues = cues(e["outCues"]), inCues = cues(e["inCues"]), maxNudge = e["maxNudge"] as Double?))
      val where = "plan[$i]"
      near("$where.seconds", d(want["seconds"]), got.seconds, 1e-9)
      near("$where.startAt", d(want["startAt"]), got.startAt, 1e-9)
      near("$where.endAt", d(want["endAt"]), got.endAt, 1e-9)
      near("$where.inStart", d(want["inStart"]), got.inStart, 1e-9)
      near("$where.rate", d(want["rate"]), got.rate, 1e-12)
      near("$where.swapSeconds", d(want["swapSeconds"]), got.swapSeconds, 1e-9)
      near("$where.bars", d(want["bars"]), got.bars, 1e-9)
      near("$where.requested", d(want["requested"]), got.requested, 1e-12)
      val swap = want["swapAt"] as Double?
      if ((swap == null) != (got.swapAt == null)) problems += "$where.swapAt: expected $swap, got ${got.swapAt}"
      else if (swap != null) near("$where.swapAt", swap, got.swapAt!!, 1e-9)
      for ((name, a, b) in listOf(
        Triple("beat", want["beat"], got.beat.id), Triple("tempo", want["tempo"], got.tempo.id), Triple("style", want["style"], got.style.id),
        Triple("reason", want["reason"], got.reason.id), Triple("label", want["label"], got.label.text), Triple("description", want["description"], got.description),
      )) if (a != b && problems.size < 30) problems += "$where.$name: expected \"$a\", got \"$b\""
      fits += got.beat.id
    }
    assertTrue("mismatches:\n" + problems.joinToString("\n"), problems.isEmpty())
    assertEquals("every kind of beat fit is covered", setOf("locked", "entry", "none"), fits)
  }

  @Test fun theEnginesCuePlannerIsTheAppsPlannerCalledAsPreviewMixerCallsIt() {
    val out = TrackCues(200.0, 0.0, 200.0, 198.0, null, BeatGrid(120.0, 193.25, 3.0))
    val inn = TrackCues(180.0, 0.4, 180.0, 180.0, BeatGrid(124.0, 0.62, 3.0), null)
    for (slider in listOf(0, 20, 40, 80)) {
      val want = Crossfade.mixPlan(slider.toDouble(), 200.0, 180.0, MixInputs(minPlayedFraction = 0.95, outCues = out, inCues = inn))
      val got = CrossfadeCuePlanner.plan(slider, 200.0, 180.0, 0.95, out, inn)
      assertEquals(BlendPlan(want.seconds, want.startAt, want.style, want.endAt, want.inStart, want.rate, want.swapAt, want.swapSeconds, want.beat), got)
    }
    val locked = CrossfadeCuePlanner.plan(40, 200.0, 180.0, 0.95, out, inn)
    assertEquals(BeatFit.LOCKED, locked.beat)
    assertEquals(120.0 / 124.0, locked.rate, 1e-12)
    assertEquals(TransitionStyle.BASS_SWAP, locked.style)
    assertTrue("never before the play-through point", locked.startAt >= 190.0)
  }

  @Test fun withoutCuesThePlanIsTheOneItAlwaysWas() {
    for (slider in listOf(10.0, 40.0, 60.0, 100.0)) {
      val plain = Crossfade.mixPlan(slider, 200.0, 180.0, MixInputs(minPlayedFraction = 0.95))
      val nothingMeasured = Crossfade.mixPlan(slider, 200.0, 180.0, MixInputs(minPlayedFraction = 0.95, outCues = null, inCues = TrackCues(180.0, 0.4, 180.0, 180.0, null, null)))
      assertEquals(plain, nothingMeasured)
      assertEquals(200.0, plain.endAt, 0.0)
      assertEquals(0.0, plain.inStart, 0.0)
      assertEquals(null, plain.swapAt)
      assertEquals(BeatFit.NONE, plain.beat)
    }
  }
}
