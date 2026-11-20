package com.nowplaying.discovery

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** RADIO-ALL-STATIONS-001: iHeart's live-station directory in the car (V103 and Power 92 are not in Radio Browser). */
class RadioIheartTest {
  private fun hit(id: Int, name: String, call: String, city: String = "Chicago", genres: List<String> = listOf("R&B"), streams: JSONObject? = null) = JSONObject()
    .put("id", id).put("name", name).put("callLetters", call).put("freq", "102.7").put("website", "v103.iheart.com")
    .put("logo", "https://i.iheart.com/v3/re/assets/images/$id.png?ops=run(1)")
    .put("genres", JSONArray(genres.map { JSONObject().put("name", it) }))
    .put("markets", JSONArray().put(JSONObject().put("city", city).put("stateAbbreviation", "IL").put("country", "US").put("origin", true)))
    .put("streams", streams ?: JSONObject().put("hls_stream", "http://stream.revma.ihrhls.com/zc$id/hls.m3u8").put("secure_shoutcast_stream", "https://stream.revma.ihrhls.com/zc$id"))
  private val chicago = CarRadioFilters.Place("area:US:41.875,-87.624", "Chicago, Illinois", "area", 41.875, -87.624, 60.0, "US", "Illinois", "Chicago")

  @Test fun aRecordBecomesAStationTheCarCanPlay() {
    val s = RadioIheart.station(hit(865, "V103", "WVAZ-FM"))!!
    assertEquals("ihr-865", s.id)
    assertEquals("https://stream.revma.ihrhls.com/zc865", s.url)
    val j = s.json()
    assertEquals("https://i.iheart.com/v3/re/assets/images/865.png", j.getString("image"))
    assertEquals("Chicago, IL", j.getString("region"))
    assertEquals("US", j.getString("countryCode"))
    assertEquals("r&b", j.getJSONArray("tags").getString(0))
    assertTrue(s.id.matches(Regex("[A-Za-z0-9-]{1,100}")))
    assertNull(RadioIheart.station(hit(1, "X", "WXXX-FM", streams = JSONObject())))
  }

  @Test fun nearbyKeepsTheLocalMarketAndDropsALoneFarStation() {
    val body = JSONObject().put("hits", JSONArray((1..12).map { hit(it, "Station $it", "W${it}AA-FM") } + hit(99, "Far", "WFAR-FM", city = "Milwaukee")))
    val rows = RadioIheart.near(body.toString(), chicago)
    assertEquals(12, rows.size)
    assertFalse(rows.any { it.name == "Far" })
  }

  @Test fun filtersApplyToIheartRows() {
    val power = RadioIheart.station(hit(6342, "Power 92", "WPWX-FM", genres = listOf("Hip Hop and R&B")))!!
    val ley = RadioIheart.station(hit(1, "La Ley 107.9", "WLEY-FM", genres = listOf("Mexican and Tejano")))!!
    assertTrue(RadioIheart.fits(power, CarRadioFilters.Filters(genre = "hip hop")))
    assertFalse(RadioIheart.fits(ley, CarRadioFilters.Filters(genre = "hip hop")))
    assertTrue(RadioIheart.fits(ley, CarRadioFilters.Filters(language = "spanish")))
    assertFalse(RadioIheart.fits(ley, CarRadioFilters.Filters(language = "english")))
  }

  @Test fun urlsAndIds() {
    assertEquals("https://api.iheart.com/api/v2/content/liveStations?limit=200&lat=41.8750&lng=-87.6240", RadioIheart.nearUrl(41.875, -87.624))
    assertEquals("https://api.iheart.com/api/v2/content/liveStations?limit=1&id=865", RadioIheart.byIdUrl("ihr-865"))
    assertNull(RadioIheart.byIdUrl("ihr-86x"))
    assertNull(RadioIheart.byIdUrl("0f3c-uuid"))
  }

  @Test fun oneRowPerStationWithTheDirectoryRowWinning() {
    val rb = RadioCatalog.normalize(JSONObject().put("stationuuid", "rb-kiss").put("name", "103.5 KISS FM WKSC Chicago").put("url", "https://x.example/k").put("homepage", ""))!!
    val kiss = RadioIheart.station(hit(849, "103.5 Kiss FM", "WKSC-FM"))!!
    val v = RadioIheart.station(hit(865, "V103", "WVAZ-FM"))!!
    val out = RadioIheart.merge(listOf(rb), listOf(kiss, v))
    assertEquals(listOf("rb-kiss", "ihr-865"), out.map { it.id })
    assertEquals("https://i.iheart.com/v3/re/assets/images/849.png", out[0].json().getString("image"))
  }

  // CAR-RADIO-IHEART-001 (owner, 2026-11-20: "test android auto iheart stations in a real car"). On the car head unit,
  // searching stations for "V103" found nothing: car station search asked Radio Browser only.
  @Test fun carStationSearchAsksIheartByNameThenLoadsThoseStations() {
    val asked = mutableListOf<String>()
    val found = RadioIheart.search("V103") { u ->
      asked += u
      when {
        u.contains("/v3/search/all") -> JSONObject().put("results", JSONObject().put("stations", JSONArray().put(JSONObject().put("id", 865)).put(JSONObject().put("id", 849)))).toString()
        u.contains("liveStations") -> JSONObject().put("hits", JSONArray().put(hit(865, "V103", "WVAZ-FM")).put(hit(849, "103.5 Kiss FM", "WKSC-FM"))).toString()
        else -> error("unexpected $u")
      }
    }
    assertTrue(asked[0], asked[0].startsWith("https://api.iheart.com/api/v3/search/all?keywords=V103&"))
    assertTrue(asked[0].contains("station=true"))
    assertEquals("https://api.iheart.com/api/v2/content/liveStations?limit=12&id=865,849", asked[1])
    assertEquals(listOf("ihr-865"), found.map { it.id }) // KISS does not match "V103"
    val kiss = RadioIheart.search("WKSC") { u -> if (u.contains("search")) "{\"results\":{\"stations\":[{\"id\":849}]}}" else JSONObject().put("hits", JSONArray().put(hit(849, "103.5 Kiss FM", "WKSC-FM"))).toString() }
    assertEquals(listOf("ihr-849"), kiss.map { it.id }) // found by call letters
  }

  @Test fun anIheartSearchThatFailsOrFindsNothingIsEmpty() {
    assertTrue(RadioIheart.search("V103") { error("offline") }.isEmpty())
    assertTrue(RadioIheart.search("V103") { "{\"results\":{\"stations\":[]}}" }.isEmpty())
    assertTrue(RadioIheart.search(" ") { error("must not ask") }.isEmpty())
  }

  @Test fun aMergedRowPlaysIheartsStreamAndKeepsItsOwnIdNameAndTags() {
    val rb = RadioCatalog.normalize(JSONObject().put("stationuuid", "rb-kiss").put("name", "103.5 KISS FM WKSC Chicago").put("url", "https://dead.example/k.m3u8").put("homepage", "").put("tags", JSONArray().put("pop")))!!
    val out = RadioIheart.merge(listOf(rb), listOf(RadioIheart.station(hit(849, "103.5 Kiss FM", "WKSC-FM"))!!))
    assertEquals("rb-kiss", out[0].id)
    assertEquals("103.5 KISS FM WKSC Chicago", out[0].name)
    assertEquals("https://stream.revma.ihrhls.com/zc849", out[0].url)
    assertEquals("849", out[0].json().getString("iheartId"))
    assertEquals("pop", out[0].json().getJSONArray("tags").getString(0))
  }

  @Test fun aPlaylistLinkWinsOverTheDirectorysResolvedSessionAddress() {
    val wgn = RadioCatalog.normalize(JSONObject().put("stationuuid", "w").put("name", "WGN 720").put("url", "http://stream.abacast.net/playlist/wgnam-wgnammp3-ibc2.m3u").put("url_resolved", "http://18.204.34.32/wgnam-wgnammp3-ibc2?session-id=5a45db"))!!
    assertEquals("http://stream.abacast.net/playlist/wgnam-wgnammp3-ibc2.m3u", wgn.url)
    val kexp = RadioCatalog.normalize(JSONObject().put("stationuuid", "k").put("name", "KEXP").put("url", "https://kexp.org/listen").put("url_resolved", "https://kexp.streamguys1.com/kexp160.aac"))!!
    assertEquals("https://kexp.streamguys1.com/kexp160.aac", kexp.url)
  }

  /** On the head unit "power" listed 100+ alphabetical Radio Browser rows before Power 92: iHeart matches come first. */
  @Test fun iheartBackedStationsComeFirstInACarSearch() {
    fun rb(id: String, name: String) = RadioCatalog.normalize(JSONObject().put("stationuuid", id).put("name", name).put("url", "https://x.example/$id").put("homepage", ""))!!
    val merged = RadioIheart.merge(listOf(rb("a", "-=PoWeR=-"), rb("b", "181.FM Power 181"), rb("k", "103.5 KISS FM WKSC")), listOf(
      RadioIheart.station(hit(12904, "Power 92", "WPWX-FM"))!!, RadioIheart.station(hit(849, "103.5 Kiss FM", "WKSC-FM"))!!))
    assertEquals(listOf("k", "ihr-12904", "a", "b"), RadioIheart.iheartFirst(merged).map { it.id })
  }

  /** iHeart's nationwide search for "power" names New York's and Atlanta's stations, not Chicago's Power 92: the
   *  stations near the car's places that match come first. */
  @Test fun stationsNearTheCarsPlacesThatMatchComeFirst() {
    val asked = mutableListOf<String>()
    val near = RadioIheart.searchNear("power", listOf(chicago)) { u -> asked += u
      JSONObject().put("hits", JSONArray().put(hit(12904, "Power 92", "WPWX-FM")).put(hit(865, "V103", "WVAZ-FM")).put(hit(849, "103.5 Kiss FM", "WKSC-FM"))).toString() }
    assertEquals(listOf("https://api.iheart.com/api/v2/content/liveStations?limit=200&lat=41.8750&lng=-87.6240"), asked)
    assertEquals(listOf("ihr-12904"), near.map { it.id })
    assertTrue(RadioIheart.searchNear("power", listOf(chicago)) { error("offline") }.isEmpty())
    fun rb(id: String, name: String) = RadioCatalog.normalize(JSONObject().put("stationuuid", id).put("name", name).put("url", "https://x.example/$id").put("homepage", ""))!!
    val national = RadioIheart.station(hit(1481, "Power 105.1", "WWPR-FM", city = "New York"))!!
    val merged = RadioIheart.merge(listOf(rb("a", "-=PoWeR=-")), listOf(national) + near)
    assertEquals(listOf("ihr-12904", "ihr-1481", "a"), RadioIheart.iheartFirst(merged, near.map { it.id }.toSet()).map { it.id })
  }
}
