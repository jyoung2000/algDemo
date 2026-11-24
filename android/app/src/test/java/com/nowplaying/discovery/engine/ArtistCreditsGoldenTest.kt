package com.nowplaying.discovery.engine

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * WP7-ARTIST-KEY-001: [PlayQueue.artistKey] names the first-credited artist of a song exactly as the
 * web engine's identity.ts (splitArtists, identity.ts:28) does, so the car and the page agree on who
 * a song is by for the four-in-a-row shuffle rule (ARTIST-RUN-001). Both sides read one golden file:
 * web/src/engine/golden/artist-credits.json (web/src/engine/artist-credits.golden.test.ts is the other half).
 */
class ArtistCreditsGoldenTest {
  /** The golden file, from the android project (../web/src/engine/golden/...) whatever the test working dir is. */
  private fun goldenFile(): File {
    val relative = "web/src/engine/golden/artist-credits.json"
    var dir: File? = File(".").absoluteFile
    while (dir != null) {
      val f = File(dir, relative)
      if (f.isFile) return f
      dir = dir.parentFile
    }
    throw AssertionError("golden not found walking up from ${File(".").absolutePath} for $relative")
  }

  @Test fun theFirstCreditedArtistMatchesTheWebEngineForEveryGoldenCredit() {
    val root = JSONObject(goldenFile().readText())
    val credits = root.getJSONArray("credits")
    assertTrue("the golden file should cover the collaboration spellings", credits.length() >= 30)
    val wrong = mutableListOf<String>()
    for (i in 0 until credits.length()) {
      val o = credits.getJSONObject(i)
      val credit = o.getString("credit")
      val expected = o.getString("first")
      val actual = PlayQueue.artistKey(credit)
      if (actual != expected) wrong += "${JSONObject.quote(credit)}: expected ${JSONObject.quote(expected)}, got ${JSONObject.quote(actual)}"
    }
    assertEquals(wrong.joinToString("\n"), emptyList<String>(), wrong)
  }
}
