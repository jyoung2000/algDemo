package com.nowplaying.discovery

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.Locale

/** CAR-RADIO-FILTERS-001: genre, saved places, language and starred-only filters for Android Auto radio. */
class CarRadioFiltersTest {
  private val chicago = CarRadioFilters.Place("area:US:41.875,-87.624", "Chicago, Illinois", "area", 41.875, -87.624, 60.0, "US", "Illinois", "Chicago")
  private val canada = CarRadioFilters.Place("country:CA:ca", "Canada", "country", 56.0, -106.0, 0.0, "CA", "", "")
  private val saved = listOf(chicago, canada)

  @Test fun everySetRowSetsAValueSoAskingTwiceNeverFlipsItBack() {
    var f = CarRadioFilters.Filters()
    repeat(2) { f = CarRadioFilters.apply(CarRadioFilters.setGenre("rock"), f, saved)!! }
    assertEquals("rock", f.genre)
    repeat(2) { f = CarRadioFilters.apply(CarRadioFilters.addPlace(chicago.id), f, saved)!! }
    assertEquals(setOf(chicago.id), f.places)
    repeat(2) { f = CarRadioFilters.apply(CarRadioFilters.STARRED_ON, f, saved)!! }
    assertTrue(f.starredOnly)
    f = CarRadioFilters.apply(CarRadioFilters.setLanguage("English"), f, saved)!!
    assertEquals("english", f.language)
    assertEquals("Rock · Chicago · English · Starred only", CarRadioFilters.summary(f, saved))
    f = CarRadioFilters.apply(CarRadioFilters.ALL_PLACES, f, saved)!!
    assertEquals("Rock · Chicago +1 · English · Starred only", CarRadioFilters.summary(f, saved))
    assertEquals(CarRadioFilters.Filters(), CarRadioFilters.apply(CarRadioFilters.CLEAR, f, saved))
    assertTrue(CarRadioFilters.isSetRow(CarRadioFilters.CLEAR))
    f = CarRadioFilters.apply(CarRadioFilters.removePlace(chicago.id), f, saved)!!
    assertEquals(setOf(canada.id), f.places)
    for (id in listOf(CarRadioFilters.setGenre(null), CarRadioFilters.ANYWHERE, CarRadioFilters.setLanguage(null), CarRadioFilters.STARRED_OFF)) f = CarRadioFilters.apply(id, f, saved)!!
    assertFalse(f.any)
    assertEquals("No filters: the most listened-to stations", CarRadioFilters.summary(f, saved))
  }

  @Test fun unknownGenresPlacesAndIdsAreRefused() {
    val f = CarRadioFilters.Filters()
    assertNull(CarRadioFilters.apply("radio/f/genre/polka-death", f, saved))
    assertNull(CarRadioFilters.apply(CarRadioFilters.addPlace("area:XX:nowhere"), f, saved))
    assertNull(CarRadioFilters.apply("radio/f/starred/maybe", f, saved))
    assertNull(CarRadioFilters.apply("radio/az/0", f, saved))
    assertEquals("r&b", CarRadioFilters.apply(CarRadioFilters.setGenre("r&b"), f, saved)!!.genre)
  }

  @Test fun filtersSurviveARestartAndAPlaceDeletedOnThePhoneDropsOut() {
    val f = CarRadioFilters.Filters("jazz", setOf(chicago.id, "gone"), "french", true)
    val back = CarRadioFilters.read(CarRadioFilters.write(f))
    assertEquals(f, back)
    assertEquals(listOf(chicago), CarRadioFilters.chosen(back, saved))
    assertEquals(CarRadioFilters.Filters(), CarRadioFilters.read("not json"))
    assertEquals(CarRadioFilters.Filters(), CarRadioFilters.read(null))
  }

  @Test fun phonePlacesAreReadAsThePhoneSavesThem() {
    val phone = JSONArray()
      .put(JSONObject().put("id", chicago.id).put("label", "Chicago, Illinois").put("query", "chicago").put("kind", "area").put("lat", 41.875).put("lon", -87.624).put("radiusKm", 60).put("countryCode", "US").put("region", "Illinois").put("city", "Chicago").put("selected", true))
      .put(JSONObject().put("id", "bad").put("label", "No coordinates").put("kind", "area"))
      .put(JSONObject().put("id", canada.id).put("label", "Canada").put("kind", "country").put("lat", 56.0).put("lon", -106.0).put("countryCode", "ca"))
    val places = CarRadioFilters.placesFrom(phone)
    assertEquals(listOf(chicago.id, canada.id), places.map { it.id })
    assertEquals("CA", places[1].countryCode)
    assertEquals(places, CarRadioFilters.placesFrom(CarRadioFilters.placesJson(places)))
  }

  @Test fun starredStationsAreFilteredLikeThePhoneFiltersThem() {
    fun st(tags: List<String>, lang: String, cc: String, region: String, lat: Double?, lon: Double?) = JSONObject().put("tags", JSONArray(tags)).put("language", lang).put("countryCode", cc).put("region", region)
      .put("latitude", lat ?: JSONObject.NULL).put("longitude", lon ?: JSONObject.NULL)
    val wbez = st(listOf("news", "talk"), "english", "US", "Illinois", 41.88, -87.63)
    val cbc = st(listOf("news"), "english,french", "CA", "Ontario", null, null)
    val kexp = st(listOf("rock", "indie"), "english", "US", "Washington", 47.6, -122.3)
    val news = CarRadioFilters.Filters(genre = "news")
    assertTrue(CarRadioFilters.matches(wbez, news, emptyList())); assertFalse(CarRadioFilters.matches(kexp, news, emptyList()))
    assertTrue(CarRadioFilters.matches(cbc, CarRadioFilters.Filters(language = "french"), emptyList()))
    assertFalse(CarRadioFilters.matches(wbez, CarRadioFilters.Filters(language = "french"), emptyList()))
    assertTrue(CarRadioFilters.matches(wbez, news, listOf(chicago)))
    assertFalse(CarRadioFilters.matches(kexp, CarRadioFilters.Filters(), listOf(chicago)))
    assertTrue(CarRadioFilters.matches(cbc, CarRadioFilters.Filters(), listOf(chicago, canada)))
  }

  @Test fun directorySearchesMatchThePhonesPlacesSearch() {
    val f = CarRadioFilters.Filters(genre = "hip hop", language = "english")
    val plain = CarRadioFilters.searchPaths(f, emptyList(), 0, 50)
    assertEquals(1, plain.size)
    assertTrue(plain[0], plain[0].contains("tag=hip+hop") && plain[0].contains("tagExact=true") && plain[0].contains("language=english") && plain[0].contains("order=clickcount"))
    val placed = CarRadioFilters.searchPaths(f, listOf(chicago, canada), 50, 50)
    assertEquals(3, placed.size) // Chicago by distance and by the city it names; Canada by country
    assertTrue(placed[0].contains("geo_lat=41.87500") && placed[0].contains("geo_distance=60000") && placed[0].contains("offset=50"))
    assertTrue(placed[1].contains("state=Chicago") && placed[1].contains("countrycode=US"))
    assertTrue(placed[2].contains("countrycode=CA"))
    assertEquals(listOf("a", "c", "b", "d"), CarRadioFilters.interleave(listOf(listOf("a", "b"), listOf("c", "a", "d"))) { it })
  }

  @Test fun thePhonesOwnLanguagesComeFirst() {
    val preferred = CarRadioFilters.preferredLanguages(listOf(Locale("es", "MX"), Locale.US, Locale("es", "ES")))
    assertEquals(listOf("spanish", "english"), preferred)
    val choices = CarRadioFilters.languageChoices(preferred, "tagalog")
    assertEquals(listOf("spanish", "english", "tagalog", "french"), choices.take(4))
    assertEquals(choices.distinct(), choices)
  }
}
