package com.nowplaying.discovery

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/** CAR-SETTINGS-001: quick EQ and discovery settings from Android Auto. */
class CarSettingsTest {
  @Test fun presetsMatchThePhonesTableExactly() {
    val ts = listOf(File("../web/src/engine/eq.ts"), File("../../web/src/engine/eq.ts")).first { it.exists() }.readText()
    val rows = Regex("""\{ id: '([a-z-]+)', name: '([^']+)', gains: \[([^\]]+)\] \}""").findAll(ts).map {
      CarSettings.Preset(it.groupValues[1], it.groupValues[2], it.groupValues[3].split(',').map { g -> g.trim().toDouble() })
    }.toList()
    assertEquals(22, rows.size)
    assertEquals(rows, CarSettings.PRESETS)
  }

  @Test fun levelsReadFamiliarToAdventurous() {
    assertEquals(listOf("Familiar", "Mostly familiar", "Balanced", "Mostly new", "Adventurous"), CarSettings.LEVELS.map(CarSettings::levelShort))
    assertEquals("A mix of familiar and new", CarSettings.levelLabel(0.5))
    assertEquals("Off", CarSettings.presetName(CarSettings.OFF)); assertEquals("R&B", CarSettings.presetName("rb"))
  }

  @Test fun rowsNameWhatTheySetAndUnknownValuesAreRefused() {
    assertEquals(CarSettings.Change(eq = "rb"), CarSettings.parse(CarSettings.setEq("rb")))
    assertEquals(CarSettings.Change(eq = CarSettings.OFF), CarSettings.parse(CarSettings.setEq(CarSettings.OFF)))
    assertEquals(CarSettings.Change(adventurous = 0.7), CarSettings.parse(CarSettings.setLevel(0.7)))
    assertEquals(CarSettings.Change(mood = false), CarSettings.parse(CarSettings.MOOD_OFF))
    assertNull(CarSettings.parse(CarSettings.setEq("polka")))
    assertNull(CarSettings.parse("car/settings/disc/400"))
    assertNull(CarSettings.parse(CarSettings.EQ))
    assertTrue(CarSettings.isSettings(CarSettings.ROOT)); assertFalse(CarSettings.isSettings("car/settingsx"))
  }

  @Test fun choosingAPresetKeepsThePhonesOtherEqSettings() {
    val phone = JSONObject().put("on", false).put("presetId", "custom").put("preampDb", -3).put("limiter", false).put("toneHz", 528)
    val rock = CarSettings.eqWith(phone, "rock")
    assertTrue(rock.getBoolean("on")); assertEquals("rock", rock.getString("presetId"))
    assertEquals(5.0, rock.getJSONArray("gains").getDouble(0), 1e-9)
    assertEquals(-3, rock.getInt("preampDb")); assertFalse(rock.getBoolean("limiter")); assertTrue(rock.isNull("toneHz"))
    assertEquals("rock", CarSettings.presetOf(rock))
    val off = CarSettings.eqWith(rock, CarSettings.OFF)
    assertEquals(CarSettings.OFF, CarSettings.presetOf(off)); assertEquals("rock", off.getString("presetId"))
    assertEquals(CarSettings.OFF, CarSettings.presetOf(null))
    assertEquals("EQ Rock \u00b7 Balanced \u00b7 Mood on", CarSettings.summary("rock", 0.5, true))
  }
}
