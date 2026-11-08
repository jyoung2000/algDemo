package com.nowplaying.discovery.engine

import com.nowplaying.discovery.dsp.EqConfig
import com.nowplaying.discovery.dsp.EqMath
import org.json.JSONArray
import org.json.JSONObject

/**
 * eq.ts `parseEq`, ported rule for rule, for the config the page sends: exactly one gain per band,
 * every value clamped (a non-number becomes 0), the limiter on unless explicitly off, and only a
 * known solfeggio tone kept, so nothing the page sends can put a filter somewhere eq.ts would not.
 */
object EqJson {
  private const val PREAMP_MIN_DB = -12.0 // eq.ts EQ_PREAMP_MIN_DB
  private const val PREAMP_MAX_DB = 12.0 // eq.ts EQ_PREAMP_MAX_DB

  fun parse(o: JSONObject?): EqConfig {
    val obj = o ?: JSONObject()
    val gains = obj.opt("gains") as? JSONArray
    return EqConfig(
      on = obj.opt("on") == true,
      presetId = (obj.opt("presetId") as? String)?.takeIf { it.isNotEmpty() } ?: "flat",
      gains = List(EqMath.BANDS_HZ.size) { i ->
        if (gains == null) EqConfig.DEFAULTS.gains[i]
        else clamp(number(gains.opt(i), 0.0), EqMath.GAIN_MIN_DB, EqMath.GAIN_MAX_DB)
      },
      preampDb = clamp(number(obj.opt("preampDb"), 0.0), PREAMP_MIN_DB, PREAMP_MAX_DB),
      limiter = obj.opt("limiter") != false,
      toneHz = (obj.opt("toneHz") as? Number)?.toDouble()?.takeIf { hz -> EqMath.SOLFEGGIO_HZ.any { it == hz } },
      toneDb = clamp(number(obj.opt("toneDb"), EqMath.SOLFEGGIO_DB), EqMath.GAIN_MIN_DB, EqMath.GAIN_MAX_DB),
    )
  }

  /** JS `Number(x ?? fallback)`: missing/null is the fallback; anything not numeric is NaN. */
  private fun number(v: Any?, fallback: Double): Double = when (v) {
    null, JSONObject.NULL -> fallback
    is Number -> v.toDouble()
    is Boolean -> if (v) 1.0 else 0.0
    is String -> if (v.isBlank()) 0.0 else v.trim().toDoubleOrNull() ?: Double.NaN
    else -> Double.NaN
  }

  /** eq.ts `clamp`: a non-finite value is 0. */
  private fun clamp(n: Double, lo: Double, hi: Double): Double = if (n.isFinite()) minOf(hi, maxOf(lo, n)) else 0.0
}
