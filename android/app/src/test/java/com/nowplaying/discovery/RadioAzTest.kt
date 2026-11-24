package com.nowplaying.discovery

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.net.URI
import java.net.URLDecoder
import java.text.Normalizer
import java.util.Locale

/** RADIO-AZ-ALL-001 (owner, 2026-11-24): the car's A-Z reaches every directory station, a bounded page at a time. */
class RadioAzTest {
  private fun fold(s: String) = Normalizer.normalize(s, Normalizer.Form.NFKD).replace(Regex("\\p{M}"), "").uppercase(Locale.ROOT)
  private fun row(id: String, name: String, url: String = "https://streams.example/$id") = JSONObject().put("stationuuid", id).put("name", name).put("url_resolved", url)

  private fun world(): List<JSONObject> {
    val words = listOf("Alpha", "Bravo", "Écho", "delta", "Øresund", "zeta", "Kilo", "Radio", "Ümit", "yankee", "Quebec", "Xray")
    val out = mutableListOf<JSONObject>()
    for (i in 0 until 4200) out += row("l$i", "${words[i % words.size]} ${'A' + (i * 7) % 26}$i")
    for (i in 0 until 26) out += row("c$i", "10$i.5 W${'A' + i}CI")
    for (i in 0 until 150) out += row("d$i", "${100 + i}.${i % 10}")
    for (i in 0 until 120) out += row("n$i", listOf("Радио $i", "평양 $i", "日本ラジオ $i", "📻 $i")[i % 4])
    for (i in 0 until 30) out += row("l${i * 13}", out.first { it.getString("stationuuid") == "l${i * 13}" }.getString("name"))
    for (i in 0 until 12) out += row("bad$i", "Broken $i", "file:///nope")
    return out.sortedBy { fold(it.getString("name").trim()) }
  }

  /** Radio Browser as measured: name= is an accent/case-insensitive substring match; offset/limit paging. */
  private class Fake(val rows: List<JSONObject>, val fold: (String) -> String, var failAt: Int = -1, var failures: Int = 0) {
    var raw = 0; var calls = 0
    fun fetch(url: String): String {
      calls++
      val q = URI(url).rawQuery.split('&').associate { it.substringBefore('=') to URLDecoder.decode(it.substringAfter('=', ""), "UTF-8") }
      val offset = q["offset"]!!.toInt(); val limit = q["limit"]!!.toInt(); val name = q["name"]
      if (offset == failAt && failures > 0) { failures--; throw java.io.IOException("mirror down") }
      val hits = if (name.isNullOrEmpty()) rows else rows.filter { fold(it.getString("name")).contains(fold(name)) }
      val page = hits.drop(offset).take(limit); raw += page.size
      return JSONArray(page).toString()
    }
  }

  private fun expected(rows: List<JSONObject>, letter: String) = rows.mapNotNull { RadioCatalog.normalize(it) }.filter { RadioNames.matchesInitial(it.name, letter) }.map { it.id }.toSet()

  @Test fun everyInitialPagesToTheEndWithoutSkipsOrRepeats() {
    val rows = world()
    for (letter in RadioCatalog.LETTERS + RadioCatalog.NUMBERS) {
      val fake = Fake(rows, ::fold); val d = RadioDirectory(fake::fetch)
      val ids = mutableListOf<String>(); var offset: Int? = 0; var pages = 0
      while (offset != null && pages < 200) {
        val before = fake.raw
        val page = d.letterPage(letter, offset)
        assertTrue("$letter page is bounded", page.stations.size <= RadioCatalog.PAGE_SIZE)
        if (page.nextOffset != null) {
          assertTrue("$letter cursor moves forward", page.nextOffset!! > offset)
          if (page.stations.size < RadioCatalog.PAGE_SIZE) assertTrue("$letter gave up early after ${fake.raw - before} rows", fake.raw - before >= 4000)
        }
        ids += page.stations.map { it.id }; offset = page.nextOffset; pages++
      }
      assertEquals("$letter repeats", ids.size, ids.toSet().size)
      assertEquals("$letter complete", expected(rows, letter), ids.toSet())
    }
  }

  @Test fun otherScriptsAtTheFarEndAreReachedInAFewCarPages() {
    val rows = (0 until 5000).map { row("l$it", "Latin $it") } + (0 until 20).map { row("n$it", "평양 $it") }
    val fake = Fake(rows, ::fold); val d = RadioDirectory(fake::fetch)
    var offset: Int? = 0; var pages = 0; val ids = mutableSetOf<String>()
    while (offset != null && pages < 100) { val p = d.letterPage("#", offset); ids += p.stations.map { it.id }; offset = p.nextOffset; pages++ }
    assertEquals(expected(rows, "#"), ids); assertTrue("took $pages pages", pages <= 3)
  }

  @Test fun aFailedLaterBatchKeepsFoundStationsAndResumesThere() {
    val radio = (0 until 1000).map { row("r$it", "Radio k ${it.toString().padStart(4, '0')}") }
    val rows = radio.take(100) + row("k1", "Kilo 1") + radio.subList(100, 700) + row("k2", "Kilo 2") + radio.drop(700)
    val fake = Fake(rows, ::fold, failAt = 500, failures = 3); val d = RadioDirectory(fake::fetch)
    val one = d.letterPage("K", 0)
    assertEquals(listOf("k1"), one.stations.map { it.id }); assertEquals(500, one.nextOffset)
    val two = d.letterPage("K", one.nextOffset!!)
    assertEquals(listOf("k2"), two.stations.map { it.id }); assertNull(two.nextOffset)
  }

  @Test fun hashListsOtherScriptsAndNumbersHaveTheirOwnFolder() {
    val folders = RadioCatalog.allFolders()
    assertEquals(RadioCatalog.AZ, folders.first())
    assertTrue(folders.contains("radio/letter/#/0")); assertTrue(folders.contains(RadioCatalog.NUMBERS_FOLDER))
    assertEquals(('A'..'Z').map { "radio/letter/$it/0" }, folders.filter { it.matches(Regex("radio/letter/[A-Z]/0")) })
    assertEquals(RadioCatalog.NUMBERS.map { "radio/letter/$it/0" }, RadioCatalog.numberFolders())
    assertEquals("#" to 0, RadioCatalog.letterFolder("radio/letter/#/0"))
    assertEquals("Z" to 4000, RadioCatalog.letterFolder("radio/letter/Z/4000"))
    assertNull(RadioCatalog.letterFolder("radio/letter/ZZ/0")); assertNull(RadioCatalog.letterFolder("radio/letter/A/-1")); assertNull(RadioCatalog.letterFolder("radio/letter/A/1000001"))
  }

  @Test fun azPageContinuesPastARawPageWithNoPlayableStations() {
    val rows = (0 until 100).map { row("bad$it", "Broken $it", "file:///x") } + (0 until 50).map { row("ok$it", "Okay $it") }
    val d = RadioDirectory(Fake(rows, ::fold)::fetch)
    val first = d.azPage(0)
    assertTrue(first.stations.isEmpty()); assertEquals(100, first.nextOffset)
    val second = d.azPage(100)
    assertEquals(50, second.stations.size); assertNull(second.nextOffset)
  }

  @Test fun sortFoldsCaseAndAccentsWithIdTiebreak() {
    val s = { id: String, name: String -> RadioCatalog.normalize(row(id, name))!! }
    val sorted = RadioCatalog.sorted(listOf(s("5", "zeta"), s("4", "Énergie"), s("3", "echo"), s("1", "Echo"), s("2", "ECHO"), s("6", "Energie")))
    assertEquals(listOf("1", "2", "3", "4", "6", "5"), sorted.map { it.id })
  }
}
