package com.nowplaying.discovery.engine

import com.nowplaying.discovery.dsp.EqConfig
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * EqJson against vectors from the real eq.ts `parseEq` (tools/dsp-parity/eq-json-vectors.mjs): the
 * native engine must read the page's EQ exactly as the app does, including hostile values. Fails —
 * never skips — when the vectors are missing.
 */
class EqJsonTest {
  @Test fun everyVectorParsesExactlyAsEqTsDoes() {
    val stream = javaClass.classLoader?.getResourceAsStream("eq-json/vectors.json")
      ?: fail("eq-json vectors are missing (android/app/src/test/resources/eq-json/). Generate them with `node tools/dsp-parity/eq-json-vectors.mjs`.") as Nothing
    val doc = JSONObject(stream.bufferedReader().readText())
    val cases = doc.getJSONArray("cases")
    assertTrue("vectors hold cases", cases.length() > 20)
    val problems = mutableListOf<String>()
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      val raw = c.getString("input")
      val input = if (raw == "null") null else JSONObject(raw)
      val got = EqJson.parse(input)
      val want = expected(c.getJSONObject("output"))
      if (got != want) problems += "$raw\n  want $want\n  got  $got"
    }
    if (problems.isNotEmpty()) fail("${problems.size} of ${cases.length()} differ from eq.ts:\n" + problems.joinToString("\n"))
  }

  @Test fun theDefaultsAreEqTsDefaults() {
    assertEquals(EqConfig.DEFAULTS, EqJson.parse(JSONObject()))
  }

  private fun expected(o: JSONObject): EqConfig {
    val g: JSONArray = o.getJSONArray("gains")
    return EqConfig(
      on = o.getBoolean("on"),
      presetId = o.getString("presetId"),
      gains = List(g.length()) { g.getDouble(it) },
      preampDb = o.getDouble("preampDb"),
      limiter = o.getBoolean("limiter"),
      toneHz = if (o.isNull("toneHz")) null else o.getDouble("toneHz"),
      toneDb = o.getDouble("toneDb"),
    )
  }
}
