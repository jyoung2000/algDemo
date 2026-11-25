package com.nowplaying.discovery

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class RadioCatalogTest {
  @Test fun aSeenFrequencyCallSignStaysInTheSameNumberIndex() {
    RadioCatalog.rememberStations(JSONArray().put(row("alias-test-wgci", "107.5 WGCI")))
    assertTrue(RadioCatalog.cachedAliases(initial = "1").any { it.id == "alias-test-wgci" })
    assertTrue(RadioCatalog.cachedAliases(query = "107").any { it.id == "alias-test-wgci" })
    assertFalse(RadioCatalog.cachedAliases(initial = "2").any { it.id == "alias-test-wgci" })
  }

  @Test fun lettersAndNumbersShareTheSameRealStationAliases() {
    for (name in listOf("107.5 WGCI", "WGCI 107.5", "107.5 FM - WGCI", "WGCI-FM 107,5")) {
      assertTrue(RadioNames.matchesInitial(name, "W")); assertTrue(RadioNames.matchesInitial(name, "1"))
      for (q in listOf("wgci", "W G C I", "107", "WGCI 107.5", "107.5 WGCI")) assertTrue("$name / $q", RadioNames.matchesQuery(name, q))
      assertFalse(RadioNames.matchesInitial(name, "2")); assertFalse(RadioNames.matchesQuery(name, "106.5"))
    }
    assertFalse(RadioNames.matchesInitial("KEXP 90.3 (MP3 128kbps)", "1"))
    assertTrue(RadioNames.matchesInitial("KEXP 90.3 (MP3 128kbps)", "9"))
  }
  @Test fun directoryCanFindNumericFirstStationsUnderWAnd1OrTyped107() {
    val urls = mutableListOf<String>()
    val d = RadioDirectory { u -> urls += u; JSONArray().put(row("wgci", "107.5 WGCI")).put(row("other", "Radio 9107")).toString() }
    assertEquals(listOf("wgci"), d.letterPage("W", 0).stations.map { it.id })
    assertEquals(listOf("wgci"), d.letterPage("1", 0).stations.map { it.id })
    assertEquals(listOf("wgci"), d.stations("107", 0).map { it.id })
    assertEquals(listOf("wgci"), d.stations("W G C I", 0).map { it.id })
    assertTrue(urls.last().contains("name=WGCI"))
  }

  @Test fun alphabetFoldsAccentsAndKeepsNumericAndOtherScriptsReachable() {
    assertEquals("E", RadioCatalog.initial(" Énergie")); assertEquals("K", RadioCatalog.initial("kexp"))
    assertEquals("W", RadioCatalog.initial("107.5 WGCI")); assertEquals("#", RadioCatalog.initial("日本"))
    assertEquals(27, RadioCatalog.LETTERS.size)
  }
  @Test fun letterBrowseScansBeyondNonmatchingRowsWithAnHonestRawCursor() {
    val urls = mutableListOf<String>()
    val batch = RadioCatalog.INITIAL_BATCH
    val d = RadioDirectory { u -> urls += u; if (u.contains("offset=0")) JSONArray((0 until batch).map { row("r$it", "Radio K") }).toString() else JSONArray().put(row("k", "KEXP")).toString() }
    val page = d.letterPage("K", 0)
    assertEquals(listOf("KEXP"), page.stations.map { it.name }); assertNull(page.nextOffset)
    assertEquals(2, urls.size); assertTrue(urls.last().contains("offset=$batch")); assertTrue(urls.first().contains("name=K"))
  }
  @Test fun boundedEmptyLetterBatchDoesNotClaimThatNoStationsExist() {
    var calls = 0; val batch = RadioCatalog.INITIAL_BATCH
    val d = RadioDirectory { calls++; JSONArray((0 until batch).map { row("r$it", "Radio K") }).toString() }
    val page = d.letterPage("K", 0)
    assertTrue(page.stations.isEmpty()); assertEquals(RadioCatalog.INITIAL_BUDGET, page.nextOffset); assertEquals(RadioCatalog.INITIAL_BUDGET / batch, calls)
  }

  private fun row(id: String, name: String) = JSONObject().put("id", id).put("name", name).put("url", "https://streams.example/$id")

  @Test fun normalizedPhoneRowsAndDirectoryRowsHaveTheSameIdentity() {
    val phone = RadioCatalog.normalize(row("kexp", "KEXP"))!!
    val api = RadioCatalog.normalize(JSONObject("""{"stationuuid":"kexp","name":"KEXP","url_resolved":"https://streams.example/kexp","countrycode":"US","state":"Washington","tags":"rock,indie","geo_lat":47.6}"""))!!
    assertEquals(phone.id, api.id)
    assertEquals(phone.url, api.url)
    assertEquals("US", api.json().getString("countryCode"))
    assertEquals("Washington", api.json().getString("region"))
    assertEquals(2, api.json().getJSONArray("tags").length())
    assertEquals(47.6, api.json().getDouble("latitude"), 0.001)
    assertNull(RadioCatalog.normalize(row("bad", "Bad").put("url", "file:///private")))
    assertNull(RadioCatalog.normalize(row("bad", "Bad").put("url", "http://127.0.0.1/")))
  }

  @Test fun favouritesPersistAcrossStoreRecreationAndDeduplicate() {
    var disk = "[]"
    val store = RadioFavouritesStore({ disk }, { disk = it })
    store.replace(JSONArray().put(row("z", "Zulu")).put(row("a", "Alpha")).put(row("a", "Alpha")))
    val restored = RadioFavouritesStore({ disk }, { disk = it })
    assertEquals(listOf("a", "z"), restored.rows().map { it.id })
    restored.toggle(RadioCatalog.normalize(row("a", "Alpha"))!!)
    assertEquals(listOf("z"), RadioFavouritesStore({ disk }, { disk = it }).rows().map { it.id })
    restored.replace(JSONArray())
    assertEquals("[]", disk)
  }

  @Test fun corruptPersistenceIsRecoverableWithoutDiscardingValidRows() {
    var disk = "not json"
    val store = RadioFavouritesStore({ disk }, { disk = it })
    assertTrue(store.rows().isEmpty())
    store.replace(JSONArray().put(JSONObject()).put(row("k", "KEXP")))
    assertEquals("k", store.rows().single().id)
  }

  @Test fun directoryPagesAreAlphabeticalBoundedAndRetryMirrors() {
    val urls = mutableListOf<String>()
    val directory = RadioDirectory { url ->
      urls += url
      if (url.contains("de1.")) error("offline")
      JSONArray().put(row("z", "Zulu")).put(row("a", "Alpha")).toString()
    }
    assertEquals(listOf("a", "z"), directory.stations("KEXP & friends", 100).map { it.id })
    assertEquals(2, urls.size)
    assertTrue(urls.last().contains("name=KEXP+%26+friends"))
    assertTrue(urls.last().contains("order=name"))
    assertTrue(urls.last().contains("offset=100"))
    assertTrue(urls.last().contains("limit=100"))
    directory.stations("KEXP & friends", 100)
    assertEquals("same page is cached", 2, urls.size)
  }

  @Test fun selectionUsesItsOwnContextAndWrapsBothWays() {
    RadioCatalog.rememberStations(JSONArray().put(row("a", "Alpha")).put(row("b", "Beta")))
    RadioCatalog.selectContext("a")
    RadioCatalog.rememberStations(JSONArray().put(row("z", "Zulu")))
    assertEquals("b", RadioCatalog.adjacent("a", 1)?.id)
    assertEquals("b", RadioCatalog.adjacent("a", -1)?.id)
    assertEquals("a", RadioCatalog.adjacent("b", 1)?.id)
    assertNull(RadioCatalog.adjacent("unknown", 1))
  }

  @Test fun directoryFailureIsNotReportedAsAnEmptySuccessfulSearch() {
    val directory = RadioDirectory { error("offline") }
    try { directory.stations("KEXP", 0); fail("must fail honestly") } catch (e: IllegalStateException) {
      assertTrue(e.message!!.contains("unavailable"))
    }
    try { directory.stations("KEXP", -1); fail("invalid page") } catch (_: IllegalArgumentException) { }
    try { directory.stations("x".repeat(101), 0); fail("unbounded query") } catch (_: IllegalArgumentException) { }
  }

  @Test fun failedPersistenceDoesNotReportSuccess() {
    val store = RadioFavouritesStore({ "[]" }, { error("disk full") })
    try { store.replace(JSONArray().put(row("a", "Alpha"))); fail("must fail") } catch (e: IllegalStateException) {
      assertEquals("disk full", e.message)
    }
    assertTrue(store.rows().isEmpty())
  }

  @Test fun directoryResponseIsBoundedAndDeduplicated() {
    val directory = RadioDirectory { JSONArray((0..150).map { row("id$it", "Station $it") }).toString() }
    assertEquals(100, directory.stations("", 0).size)
    val duplicate = RadioDirectory { JSONArray().put(row("a", "Alpha")).put(row("a", "Alpha")).put(JSONObject()).toString() }
    assertEquals(1, duplicate.stations("", 0).size)
  }

  @Test fun unrelatedBrowsesDoNotChangeTheTunedSkipContext() {
    RadioCatalog.rememberStations(JSONArray().put(row("c", "Charlie")).put(row("d", "Delta")).put(row("e", "Echo")))
    RadioCatalog.selectContext("d")
    assertTrue(RadioCatalog.canSkip("d"))
    RadioCatalog.rememberStations(JSONArray().put(row("c", "Charlie")))
    assertEquals("e", RadioCatalog.adjacent("d", 1)?.id)
    assertEquals("c", RadioCatalog.adjacent("d", -1)?.id)
    RadioCatalog.selectContext("missing")
    assertFalse(RadioCatalog.canSkip("d"))
  }

  @Test fun shuffledSkipsAreUniformOverTheOtherStationsAndNeverTheCurrentOne() {
    RadioCatalog.rememberStations(JSONArray().put(row("sh-a", "Alpha")).put(row("sh-b", "Beta")).put(row("sh-c", "Chi")).put(row("sh-d", "Delta")))
    RadioCatalog.selectContext("sh-a")
    try {
      val random = kotlin.random.Random(42)
      val picks = (1..240).map { RadioCatalog.randomOther("sh-a", random)!!.id }
      assertFalse("never the tuned station", picks.contains("sh-a"))
      assertEquals("every other station is reachable", setOf("sh-b", "sh-c", "sh-d"), picks.toSet())
      val adjacentId = RadioCatalog.adjacent("sh-a", 1)!!.id
      assertTrue("random skips are not locked to the adjacent station", picks.any { it != adjacentId })
      val counts = picks.groupingBy { it }.eachCount()
      assertTrue("uniform draw, not a biased one: $counts", counts.values.all { it in 40..160 })
    } finally { RadioCatalog.selectContext("missing-radio-test-context") }
  }

  @Test fun shuffleDoesNotRepeatAStationUntilEveryOtherOneWasPlayed() {
    // RADIO-SHUFFLE-NO-REPEAT-001 (owner, 2026-11-25): "shuffle on radio shouldnt repeat stations".
    RadioCatalog.rememberStations(JSONArray().put(row("nr-a", "Alpha")).put(row("nr-b", "Beta")).put(row("nr-c", "Chi")).put(row("nr-d", "Delta")).put(row("nr-e", "Echo")))
    RadioCatalog.selectContext("nr-a")
    try {
      repeat(20) { round ->
        RadioCatalog.resetShuffle("nr-a")
        val random = kotlin.random.Random(round)
        var on = "nr-a"
        val played = mutableListOf<String>()
        repeat(4) {
          val next = RadioCatalog.randomOther(on, random)!!.id
          RadioCatalog.markPlayed(next); played += next; on = next
        }
        assertEquals("four skips reach the four other stations once each: $played", setOf("nr-b", "nr-c", "nr-d", "nr-e"), played.toSet())
        assertNull("with every station played the list itself offers no repeat", RadioCatalog.randomOther(on, random))
      }
      assertTrue("shuffle keeps Next available", RadioCatalog.canSkip("nr-a", shuffle = true))
    } finally { RadioCatalog.resetShuffle(null); RadioCatalog.selectContext("missing-radio-test-context") }
  }

  @Test fun shuffledSkipHasNoTargetWithoutAnotherStationInTheList() {
    RadioCatalog.rememberStations(JSONArray().put(row("sh-solo", "Solo")))
    RadioCatalog.selectContext("sh-solo")
    try {
      assertNull("fewer than two stations behaves as an ordered skip", RadioCatalog.randomOther("sh-solo"))
      assertNull("a station outside its list has no random target", RadioCatalog.randomOther("sh-unknown"))
    } finally { RadioCatalog.selectContext("missing-radio-test-context") }
  }

  @Test fun typedAndVoiceRadioSearchDoesNotStealMusicQueries() {
    assertEquals("KEXP", CarSearch.radioQuery("radio KEXP"))
    assertEquals("KEXP", CarSearch.radioQuery("play radio KEXP"))
    assertEquals("BBC Radio 6", CarSearch.radioQuery("station BBC Radio 6"))
    assertNull(CarSearch.radioQuery("Radiohead"))
    assertNull(CarSearch.radioQuery("song Radio Gaga"))
  }
}
