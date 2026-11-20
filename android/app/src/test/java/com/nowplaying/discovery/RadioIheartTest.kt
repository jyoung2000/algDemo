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
}
