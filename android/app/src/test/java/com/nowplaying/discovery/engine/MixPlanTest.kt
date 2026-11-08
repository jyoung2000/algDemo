package com.nowplaying.discovery.engine

import com.nowplaying.discovery.dsp.MiniJson
import com.nowplaying.discovery.dsp.TransitionStyle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import kotlin.math.abs

/**
 * The Kotlin crossfade planner against vectors generated from the real web/src/engine/crossfade.ts
 * by tools/dsp-parity/mix-plan-vectors.mjs (encoding documented in that script and in the file).
 * Fails — never skips — when the vectors are missing.
 */
class MixPlanTest {
  private class Check {
    var count = 0
    val problems = ArrayList<String>()

    fun num(where: String, expected: Double?, actual: Double?) {
      val ok = when {
        expected == null || actual == null -> expected == actual
        expected.isNaN() || actual.isNaN() -> expected.isNaN() && actual.isNaN()
        expected.isInfinite() || actual.isInfinite() -> expected == actual
        else -> abs(expected - actual) <= 1e-12
      }
      if (!ok) problem("$where: expected $expected, got $actual")
    }

    fun str(where: String, expected: Any?, actual: String) {
      if (expected != actual) problem("$where: expected \"$expected\", got \"$actual\"")
    }

    private fun problem(text: String) {
      if (problems.size < 40) problems += text else if (problems.size == 40) problems += "…more"
    }
  }

  /** The file's number encoding: JSON numbers, "NaN"/"Infinity"/"-Infinity", absent or null = unknown. */
  private fun n(v: Any?): Double? = when (v) {
    null -> null
    is Double -> v
    "NaN" -> Double.NaN
    "Infinity" -> Double.POSITIVE_INFINITY
    "-Infinity" -> Double.NEGATIVE_INFINITY
    else -> error("not an encoded number: $v")
  }

  private fun nn(v: Any?): Double = n(v) ?: error("expected a number, got null")

  @Suppress("UNCHECKED_CAST")
  private fun Any?.obj() = this as Map<String, Any?>

  @Suppress("UNCHECKED_CAST")
  private fun Any?.list() = this as List<Any?>

  private fun loadVectors(): Map<String, Any?> {
    val stream = javaClass.classLoader?.getResourceAsStream("mix-plan/vectors.json")
      ?: fail("mix-plan vectors are missing: no mix-plan/vectors.json on the test classpath " +
        "(android/app/src/test/resources/mix-plan/). Generate them with `node tools/dsp-parity/mix-plan-vectors.mjs`.") as Nothing
    return MiniJson.parse(stream.use { it.readBytes().toString(Charsets.UTF_8) }).obj()
  }

  private fun comparePlan(c: Check, where: String, expected: Map<String, Any?>, actual: MixPlan) {
    c.num("$where.seconds", nn(expected["seconds"]), actual.seconds)
    c.num("$where.startAt", nn(expected["startAt"]), actual.startAt)
    c.str("$where.label", expected["label"], actual.label.text)
    c.num("$where.requested", nn(expected["requested"]), actual.requested)
    c.str("$where.reason", expected["reason"], actual.reason.id)
    c.num("$where.bars", nn(expected["bars"]), actual.bars)
    c.str("$where.tempo", expected["tempo"], actual.tempo.id)
    c.num("$where.rate", nn(expected["rate"]), actual.rate)
    c.str("$where.style", expected["style"], actual.style.id)
    c.str("$where.description", expected["description"], actual.description)
    c.count++
  }

  @Test fun everyVectorMatchesCrossfadeTs() {
    val v = loadVectors()
    val c = Check()

    val k = v["constants"].obj()
    c.str("MIX_LABELS", k["MIX_LABELS"].list().joinToString("|"), Crossfade.MIX_LABELS.joinToString("|"))
    c.num("MIX_MIN", nn(k["MIX_MIN"]), Crossfade.MIX_MIN)
    c.num("MIX_MAX", nn(k["MIX_MAX"]), Crossfade.MIX_MAX)
    c.num("MIN_PLAYED_FRACTION", nn(k["MIN_PLAYED_FRACTION"]), Crossfade.MIN_PLAYED_FRACTION)
    c.num("PLAY_THROUGH_MIN", nn(k["PLAY_THROUGH_MIN"]), Crossfade.PLAY_THROUGH_MIN)
    c.num("PLAY_THROUGH_MAX", nn(k["PLAY_THROUGH_MAX"]), Crossfade.PLAY_THROUGH_MAX)
    c.num("PLAY_THROUGH_DEFAULT", nn(k["PLAY_THROUGH_DEFAULT"]), Crossfade.PLAY_THROUGH_DEFAULT)
    c.num("MAX_TRACK_FRACTION", nn(k["MAX_TRACK_FRACTION"]), Crossfade.MAX_TRACK_FRACTION)
    c.num("MIN_USEFUL_SECONDS", nn(k["MIN_USEFUL_SECONDS"]), Crossfade.MIN_USEFUL_SECONDS)
    c.num("BEATS_PER_BAR", nn(k["BEATS_PER_BAR"]), Crossfade.BEATS_PER_BAR)
    c.num("MAX_TEMPO_NUDGE", nn(k["MAX_TEMPO_NUDGE"]), Crossfade.MAX_TEMPO_NUDGE)
    c.num("TEMPO_MATCH_TOLERANCE", nn(k["TEMPO_MATCH_TOLERANCE"]), Crossfade.TEMPO_MATCH_TOLERANCE)
    val constants = k.size

    for (e in v["clampSlider"].list().map { it.obj() }) {
      c.num("clampSlider(${e["in"]})", nn(e["out"]), Crossfade.clampSlider(nn(e["in"]))); c.count++
    }
    for (e in v["clampPlayThrough"].list().map { it.obj() }) {
      c.num("clampPlayThrough(${e["in"]})", nn(e["out"]), Crossfade.clampPlayThrough(n(e["in"]))); c.count++
    }
    for (e in v["requestedSeconds"].list().map { it.obj() }) {
      c.num("requestedSeconds(${e["in"]})", nn(e["out"]), Crossfade.requestedSeconds(nn(e["in"]))); c.count++
    }
    for (e in v["transitionStyle"].list().map { it.obj() }) {
      c.str("transitionStyle(${e["in"]})", e["out"], Crossfade.transitionStyle(nn(e["in"])).id); c.count++
    }
    for (e in v["mixBand"].list().map { it.obj() }) {
      val s = nn(e["in"])
      val b = Crossfade.mixBand(s)
      c.str("mixBand($s).label", e["label"], b.label.text)
      c.num("mixBand($s).lo", nn(e["lo"]), b.lo)
      c.num("mixBand($s).hi", nn(e["hi"]), b.hi)
      c.str("mixLabel($s)", e["mixLabel"], Crossfade.mixLabel(s).text)
      c.count++
    }
    for (e in v["barSeconds"].list().map { it.obj() }) {
      c.num("barSeconds(${e["bpm"]})", n(e["out"]), Crossfade.barSeconds(n(e["bpm"]))); c.count++
    }
    for (e in v["tempoRelation"].list().map { it.obj() }) {
      c.str("tempoRelation(${e["outBpm"]}, ${e["inBpm"]})", e["out"], Crossfade.tempoRelation(n(e["outBpm"]), n(e["inBpm"])).id); c.count++
    }
    for (e in v["tempoNudge"].list().map { it.obj() }) {
      c.num("tempoNudge(${e["outBpm"]}, ${e["inBpm"]})", nn(e["out"]), Crossfade.tempoNudge(n(e["outBpm"]), n(e["inBpm"]))); c.count++
    }
    for (e in v["quantizeToBars"].list().map { it.obj() }) {
      val q = Crossfade.quantizeToBars(nn(e["seconds"]), n(e["bpm"]))
      val o = e["out"].obj()
      c.num("quantizeToBars(${e["seconds"]}, ${e["bpm"]}).seconds", nn(o["seconds"]), q.seconds)
      c.num("quantizeToBars(${e["seconds"]}, ${e["bpm"]}).bars", nn(o["bars"]), q.bars)
      c.count++
    }
    val helpers = c.count
    c.count = 0

    val mp = v["mixPlan"].obj()
    val grid = mp["grid"].obj()
    val plans = mp["plans"].list().map { it.obj() }
    val index = grid["index"].list()
    val sliders = grid["sliders"].list().map(::nn)
    val lengths = grid["lengths"].list().map(::nn)
    val fractions = grid["fractions"].list().map(::n)
    val bpmPairs = grid["bpmPairs"].list().map { p -> p.list().let { n(it[0]) to n(it[1]) } }
    assertEquals("grid index length", sliders.size * lengths.size * lengths.size * fractions.size * bpmPairs.size, index.size)
    var at = 0
    for (s in sliders) for (o in lengths) for (i in lengths) for (f in fractions) for ((ob, ib) in bpmPairs) {
      val plan = Crossfade.mixPlan(s, o, i, MixInputs(f, ob, ib))
      comparePlan(c, "mixPlan($s, $o, $i, {fraction=$f, outBpm=$ob, inBpm=$ib})", plans[nn(index[at++]).toInt()], plan)
    }
    for (e in mp["random"].list().map { it.obj() }) {
      val s = nn(e["slider"])
      val o = nn(e["outSeconds"])
      val i = nn(e["inSeconds"])
      val inputs = MixInputs(n(e["minPlayedFraction"]), n(e["outBpm"]), n(e["inBpm"]))
      comparePlan(c, "mixPlan($s, $o, $i, $inputs)", e["plan"].obj(), Crossfade.mixPlan(s, o, i, inputs))
    }
    val planned = c.count

    println("mix-plan parity vs crossfade.ts @ ${v["commit"]}${if (v["dirty"] == true) " (dirty)" else ""}: " +
      "${helpers + planned} vectors checked ($planned mixPlan, $helpers helper) + $constants constants, ${c.problems.size} mismatches")
    assertTrue("vectors file holds no mixPlan vectors", planned > 0)
    if (c.problems.isNotEmpty()) fail("Kotlin MixPlan differs from crossfade.ts:\n" + c.problems.joinToString("\n"))
  }

  /**
   * MIXER-PLAY-THROUGH-001: a 200 s song at the default play-through blends for at most 10 s, from 190 s on.
   * Like crossfade.ts, 200 * (1 - 0.95) is 10.000000000000009 in doubles, hence the 1e-9 slack.
   */
  @Test fun aWholeSongPlaysThroughBeforeTheBlend() {
    for (slider in listOf(1.0, 25.0, 50.0, 75.0, 100.0)) {
      val plan = Crossfade.mixPlan(slider, 200.0, 200.0)
      assertTrue("slider $slider blends ${plan.seconds}s", plan.seconds <= 10.0 + 1e-9)
      assertTrue("slider $slider starts at ${plan.startAt}s", plan.startAt >= 190.0 - 1e-9)
    }
    assertEquals(MixReason.KEPT_FOR_SONG, Crossfade.mixPlan(100.0, 200.0, 200.0).reason)
    assertEquals(95.0, Crossfade.PLAY_THROUGH_DEFAULT, 0.0)
  }

  /** MIXER-PLAY-THROUGH-002: play-through 100% hands over cleanly at the end of the song, with no overlap. */
  @Test fun playThroughHundredGivesNoOverlap() {
    val fraction = Crossfade.clampPlayThrough(100.0) / 100
    val plan = Crossfade.mixPlan(100.0, 200.0, 200.0, MixInputs(minPlayedFraction = fraction))
    assertEquals(0.0, plan.seconds, 0.0)
    assertEquals(200.0, plan.startAt, 0.0)
    assertEquals(MixReason.TOO_SHORT_TO_BLEND, plan.reason)
  }

  /** MIXER-001: slider 0 is a cut, labelled Off. */
  @Test fun sliderZeroIsCutAndOff() {
    val plan = Crossfade.mixPlan(0.0, 200.0, 200.0, MixInputs(outBpm = 120.0, inBpm = 120.0))
    assertEquals(TransitionStyle.CUT, plan.style)
    assertEquals(MixReason.OFF, plan.reason)
    assertEquals(MixLabel.OFF, plan.label)
    assertEquals("Off • songs play one after another", plan.description)
    assertEquals(0.0, plan.seconds, 0.0)
    assertEquals(TransitionStyle.CUT, Crossfade.transitionStyle(0.0))
    assertEquals("Off", Crossfade.mixLabel(0.0).text)
  }

  @Test fun theEnginesPlannerIsTheAppsPlannerCalledAsPreviewMixerCallsIt() {
    for (slider in listOf(0, 1, 25, 50, 75, 100)) for (frac in listOf(0.5, 0.95, 1.0)) {
      val want = Crossfade.mixPlan(slider.toDouble(), 214.0, 187.0, MixInputs(minPlayedFraction = frac))
      val got = CrossfadePlanner.plan(slider, 214.0, 187.0, frac)
      assertEquals("slider $slider frac $frac", BlendPlan(want.seconds, want.startAt, want.style), got)
      assertTrue("the outgoing song plays at least $frac before the blend", got.startAt >= frac * 214.0 - 1e-9 || got.seconds == 0.0)
    }
  }
}
