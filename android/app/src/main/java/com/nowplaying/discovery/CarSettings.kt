package com.nowplaying.discovery

import org.json.JSONArray
import org.json.JSONObject
import java.net.URLDecoder
import java.net.URLEncoder

/**
 * CAR-SETTINGS-001 (owner, 2026-11-19): "On android auto add a button for settings to quickly change the algorithm and
 * eq presets". Android Auto lets a player button do one thing per tap (it cannot open a list), so the player's menu has
 * two buttons that step through a short list each, and a "Sound & discovery settings" folder (top of Playlists) picks
 * any EQ preset or discovery level directly. The phone and the car always show the same choice. Pure policy here.
 */
object CarSettings {
  data class Preset(val id: String, val name: String, val gains: List<Double>)

  /** The phone's built-in presets (web/src/engine/eq.ts EQ_PRESETS, less the solfeggio tones), same order and gains. */
  val PRESETS = listOf(
    Preset("flat", "Flat", listOf(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0)),
    Preset("acoustic", "Acoustic", listOf(4.0, 3.5, 2.5, 0.5, 1.0, 1.0, 2.5, 3.0, 2.5, 1.5)),
    Preset("bass-booster", "Bass booster", listOf(7.0, 5.5, 4.0, 2.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0)),
    Preset("bass-reducer", "Bass reducer", listOf(-7.0, -5.5, -4.0, -2.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0)),
    Preset("classical", "Classical", listOf(5.0, 4.0, 3.0, 2.5, -1.5, -1.5, 0.0, 2.0, 3.0, 4.0)),
    Preset("dance", "Dance", listOf(6.0, 5.0, 2.0, 0.0, 1.5, 3.0, 4.0, 3.5, 2.0, 0.0)),
    Preset("deep", "Deep", listOf(6.0, 4.5, 2.0, 1.0, 3.0, 2.0, 1.0, -2.0, -3.5, -4.0)),
    Preset("electronic", "Electronic", listOf(5.0, 4.0, 1.0, 0.0, -1.5, 1.5, 0.5, 1.5, 4.0, 5.0)),
    Preset("hip-hop", "Hip-hop", listOf(6.5, 5.5, 2.0, 2.5, -1.0, -0.5, 1.5, -0.5, 2.0, 3.0)),
    Preset("jazz", "Jazz", listOf(4.0, 3.0, 1.5, 2.0, -1.5, -1.5, 0.0, 1.5, 3.0, 4.0)),
    Preset("latin", "Latin", listOf(5.0, 3.5, 0.0, 0.0, -1.5, -1.5, -1.5, 0.0, 3.0, 5.0)),
    Preset("loudness", "Loudness", listOf(7.0, 5.5, 0.0, 0.0, -2.0, 0.0, -1.0, -5.0, 5.0, 1.0)),
    Preset("lounge", "Lounge", listOf(-3.0, -1.5, -0.5, 1.5, 4.0, 2.5, 0.0, -1.5, 2.0, 1.0)),
    Preset("piano", "Piano", listOf(3.0, 2.0, 0.0, 2.5, 3.0, 1.5, 3.5, 4.5, 3.0, 2.5)),
    Preset("pop", "Pop", listOf(-1.5, -1.0, 0.0, 2.5, 4.5, 4.5, 2.5, 0.0, -1.0, -1.5)),
    Preset("rb", "R&B", listOf(3.0, 6.5, 5.5, 1.5, -2.0, -1.5, 2.0, 2.5, 3.0, 3.5)),
    Preset("rock", "Rock", listOf(5.0, 4.0, 3.0, 1.5, -0.5, -1.0, 0.5, 3.0, 4.0, 4.5)),
    Preset("small-speakers", "Small speakers", listOf(6.0, 5.0, 4.0, 2.0, 0.0, -1.0, -2.0, -3.0, -4.0, -5.0)),
    Preset("spoken-word", "Spoken word", listOf(-3.5, -0.5, 0.0, 1.0, 4.0, 4.5, 5.0, 4.0, 2.0, 0.0)),
    Preset("treble-booster", "Treble booster", listOf(0.0, 0.0, 0.0, 0.0, 0.0, 1.5, 3.0, 4.5, 6.0, 7.0)),
    Preset("treble-reducer", "Treble reducer", listOf(0.0, 0.0, 0.0, 0.0, 0.0, -1.5, -3.0, -4.5, -6.0, -7.0)),
    Preset("vocal-booster", "Vocal booster", listOf(-2.0, -3.0, -3.0, 1.5, 4.0, 4.0, 3.0, 1.5, 0.0, -1.5)),
  )
  /** What the player's EQ button steps through: off first, then the presets that suit a car most. */
  val QUICK_EQ = listOf(OFF, "flat", "bass-booster", "hip-hop", "rock", "pop", "rb", "electronic", "vocal-booster", "loudness")
  const val OFF = "off"

  /** Familiar to Adventurous (App.tsx adventureLabel), five stops for the car. */
  val LEVELS = listOf(0.1, 0.3, 0.5, 0.7, 0.9)
  fun levelLabel(a: Double): String = when {
    a < 0.2 -> "Close to your starting songs"
    a < 0.4 -> "Mostly familiar artists"
    a <= 0.6 -> "A mix of familiar and new"
    a <= 0.8 -> "Mostly new artists"
    else -> "Far from your starting songs"
  }
  fun levelShort(a: Double): String = when {
    a < 0.2 -> "Familiar"; a < 0.4 -> "Mostly familiar"; a <= 0.6 -> "Balanced"; a <= 0.8 -> "Mostly new"; else -> "Adventurous"
  }

  /* -------------------------------------------------------------------------------------- media ids */
  const val ROOT = "car/settings"
  const val EQ = "car/settings/eq"
  const val DISCOVERY = "car/settings/disc"
  const val MOOD_ON = "car/settings/mood/on"
  const val MOOD_OFF = "car/settings/mood/off"
  fun setEq(id: String) = "$EQ/${URLEncoder.encode(id, "UTF-8")}"
  fun setLevel(a: Double) = "$DISCOVERY/${(a * 100).toInt()}"
  fun isSettings(id: String) = id == ROOT || id.startsWith("$ROOT/")

  data class Change(val eq: String? = null, val adventurous: Double? = null, val mood: Boolean? = null)

  /** The change a set row's id asks for, or null when the id is not a set row (or names something unknown). */
  fun parse(id: String): Change? {
    if (id == MOOD_ON) return Change(mood = true)
    if (id == MOOD_OFF) return Change(mood = false)
    if (id.startsWith("$EQ/")) {
      val p = runCatching { URLDecoder.decode(id.removePrefix("$EQ/"), "UTF-8") }.getOrNull() ?: return null
      return if (p == OFF || PRESETS.any { it.id == p }) Change(eq = p) else null
    }
    if (id.startsWith("$DISCOVERY/")) {
      val n = id.removePrefix("$DISCOVERY/").toIntOrNull() ?: return null
      return if (n in 0..100) Change(adventurous = n / 100.0) else null
    }
    return null
  }

  /* ------------------------------------------------------------------------------------- reading */
  /** The preset the engine's EQ settings name: "off" when the EQ is off, "custom" for moved sliders. */
  fun presetOf(eq: JSONObject?): String = when {
    eq == null || !eq.optBoolean("on") -> OFF
    else -> eq.optString("presetId").ifBlank { "flat" }
  }
  fun presetName(id: String): String = when (id) {
    OFF -> "Off"; "custom" -> "Custom"
    else -> PRESETS.firstOrNull { it.id == id }?.name ?: if (id.startsWith("solfeggio-")) "${id.removePrefix("solfeggio-")} Hz tone" else "Custom"
  }

  /** The EQ config with [preset] chosen; preamp, limiter and anything else the phone set are kept. */
  fun eqWith(current: JSONObject?, preset: String): JSONObject {
    val o = JSONObject((current ?: JSONObject()).toString())
    if (preset == OFF) return o.put("on", false)
    val p = PRESETS.first { it.id == preset }
    return o.put("on", true).put("presetId", p.id).put("gains", JSONArray(p.gains)).put("toneHz", JSONObject.NULL)
      .apply { if (!has("preampDb")) put("preampDb", 0); if (!has("limiter")) put("limiter", true) }
  }

  /* --------------------------------------------------------------------------------- the buttons */
  /** A preset outside the quick list (Jazz, Custom...) steps to the first preset, never straight to Off. */
  fun nextEq(current: String): String { val i = QUICK_EQ.indexOf(current); return if (i < 0) QUICK_EQ[1] else QUICK_EQ[(i + 1) % QUICK_EQ.size] }
  fun nextLevel(a: Double): Double = LEVELS.firstOrNull { it > a + 1e-6 } ?: LEVELS.first()
  fun eqLabel(current: String) = "EQ: ${presetName(current)} \u2013 tap for ${presetName(nextEq(current))}"
  fun levelLabelButton(a: Double) = "Discovery: ${levelShort(a)} \u2013 tap for ${levelShort(nextLevel(a))}"
  fun summary(eq: String, a: Double, mood: Boolean) = "EQ ${presetName(eq)} \u00b7 ${levelShort(a)}${if (mood) " \u00b7 Mood on" else ""}"
}
