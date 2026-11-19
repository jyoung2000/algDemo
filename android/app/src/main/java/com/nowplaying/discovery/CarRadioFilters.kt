package com.nowplaying.discovery

import org.json.JSONArray
import org.json.JSONObject
import java.net.URLDecoder
import java.net.URLEncoder
import java.util.Locale
import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * CAR-RADIO-FILTERS-001 (owner, 2026-11-19): "Ensure the user can filter by genre, select their radio location presets,
 * and filter by preferred language, and filter by starred stations on android auto".
 *
 * The same four filters as the phone's Radio tab, combined: a genre, any number of the places saved on the phone, a
 * language, and starred stations only. Android Auto has no menus, so each filter is a folder whose rows SET a value:
 * every set row's id names the value it sets (never a toggle), so a car that asks for a list twice cannot flip it back.
 * Pure policy here (tested on the JVM); persistence and the browse tree live in RadioCatalog and PlaybackService.
 */
object CarRadioFilters {
  /** The phone's genre and language menus (Radio.tsx GENRE_SECTIONS / LANGUAGE_CHOICES), in the same order. */
  val GENRES = listOf("jazz", "classical", "rock", "pop", "hip hop", "r&b", "electronic", "house", "techno", "ambient", "metal", "country", "latin", "reggae", "soul", "blues", "folk", "news", "talk", "world")
  val LANGUAGES = listOf("english", "spanish", "french", "german", "italian", "portuguese", "dutch", "arabic", "hindi", "japanese", "korean", "chinese")
  const val PLACES_MAX = 24

  /* -------------------------------------------------------------------------------------- media ids */
  const val FILTERS = "radio/filters"
  const val STATIONS = "radio/filtered/"
  const val GENRE = "radio/f/genre"
  const val PLACE = "radio/f/place"
  const val LANGUAGE = "radio/f/lang"
  const val STARRED = "radio/f/starred"
  const val ANY = "any"
  fun stations(offset: Int) = "$STATIONS$offset"
  fun setGenre(genre: String?) = "$GENRE/${enc(genre ?: ANY)}"
  fun setLanguage(language: String?) = "$LANGUAGE/${enc(language ?: ANY)}"
  fun addPlace(id: String) = "$PLACE/add/${enc(id)}"
  fun removePlace(id: String) = "$PLACE/remove/${enc(id)}"
  const val ANYWHERE = "$PLACE/anywhere"
  const val ALL_PLACES = "$PLACE/all"
  const val STARRED_ON = "$STARRED/on"
  const val STARRED_OFF = "$STARRED/off"
  const val CLEAR = "radio/f/clear"
  /** Places asked for at once from the car (each is one or two directory searches). */
  const val CAR_PLACES_ASKED = 3
  private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")
  private fun dec(s: String) = runCatching { URLDecoder.decode(s, "UTF-8") }.getOrNull()

  data class Place(val id: String, val label: String, val kind: String, val lat: Double, val lon: Double, val radiusKm: Double, val countryCode: String, val region: String, val city: String)

  data class Filters(val genre: String? = null, val places: Set<String> = emptySet(), val language: String? = null, val starredOnly: Boolean = false) {
    val any get() = genre != null || places.isNotEmpty() || language != null || starredOnly
  }

  /* ----------------------------------------------------------------------------------- persistence */
  fun read(text: String?): Filters = runCatching {
    val o = JSONObject(text ?: return Filters())
    val places = o.optJSONArray("places")?.let { a -> (0 until a.length()).map { a.optString(it) }.filter { it.isNotBlank() }.take(PLACES_MAX).toSet() } ?: emptySet()
    Filters(o.optString("genre").takeIf { it in GENRES }, places, o.optString("language").trim().lowercase(Locale.ROOT).take(40).takeIf { it.isNotBlank() }, o.optBoolean("starredOnly"))
  }.getOrDefault(Filters())

  fun write(f: Filters): String = JSONObject().put("genre", f.genre ?: "").put("places", JSONArray(f.places.toList())).put("language", f.language ?: "").put("starredOnly", f.starredOnly).toString()

  /** The phone's saved places (radio-places.ts RadioPlace), checked as the phone checks them. */
  fun placesFrom(array: JSONArray?): List<Place> {
    if (array == null) return emptyList()
    val out = mutableListOf<Place>()
    for (i in 0 until array.length()) {
      val o = array.optJSONObject(i) ?: continue
      val id = o.optString("id"); val label = o.optString("label"); val kind = o.optString("kind")
      val lat = o.optDouble("lat", Double.NaN); val lon = o.optDouble("lon", Double.NaN)
      if (id.isBlank() || id.length > 200 || label.isBlank() || kind !in listOf("area", "region", "country") || !lat.isFinite() || !lon.isFinite()) continue
      if (out.any { it.id == id }) continue
      out += Place(id, label.take(200), kind, lat, lon, o.optDouble("radiusKm", 0.0).takeIf { it.isFinite() }?.coerceIn(0.0, 200.0) ?: 0.0,
        o.optString("countryCode").uppercase(Locale.ROOT).take(2), o.optString("region").take(100), o.optString("city").take(100))
      if (out.size == PLACES_MAX) break
    }
    return out
  }

  fun placesJson(list: List<Place>): JSONArray = JSONArray(list.map {
    JSONObject().put("id", it.id).put("label", it.label).put("kind", it.kind).put("lat", it.lat).put("lon", it.lon).put("radiusKm", it.radiusKm)
      .put("countryCode", it.countryCode).put("region", it.region).put("city", it.city)
  })

  /* --------------------------------------------------------------------------------------- choosing */
  /** The filters a set row's id asks for, or null when the id is not a set row. Idempotent by construction. */
  fun apply(id: String, f: Filters, saved: List<Place>): Filters? {
    val rest = id.removePrefix("radio/f/")
    if (rest == id) return null
    val parts = rest.split('/')
    return when {
      parts.size == 1 && parts[0] == "clear" -> Filters()
      parts.size == 2 && parts[0] == "genre" -> when (val g = dec(parts[1])) { ANY -> f.copy(genre = null); in GENRES -> f.copy(genre = g); else -> null }
      parts.size == 2 && parts[0] == "lang" -> when (val l = dec(parts[1])?.trim()?.lowercase(Locale.ROOT)) { null, "" -> null; ANY -> f.copy(language = null); else -> if (l.length <= 40) f.copy(language = l) else null }
      parts.size == 2 && parts[0] == "starred" -> when (parts[1]) { "on" -> f.copy(starredOnly = true); "off" -> f.copy(starredOnly = false); else -> null }
      parts.size == 2 && parts[0] == "place" && parts[1] == "anywhere" -> f.copy(places = emptySet())
      parts.size == 2 && parts[0] == "place" && parts[1] == "all" -> f.copy(places = saved.map { it.id }.toSet())
      parts.size == 3 && parts[0] == "place" && parts[1] in listOf("add", "remove") -> {
        val pid = dec(parts[2]) ?: return null
        if (parts[1] == "add") { if (saved.none { it.id == pid }) null else f.copy(places = f.places + pid) } else f.copy(places = f.places - pid)
      }
      else -> null
    }
  }

  fun isSetRow(id: String) = id == CLEAR || id.startsWith("$GENRE/") || id.startsWith("$LANGUAGE/") || id.startsWith("$PLACE/") || id.startsWith("$STARRED/")

  /** Saved places the filters still name (a place deleted on the phone simply drops out). */
  fun chosen(f: Filters, saved: List<Place>): List<Place> = saved.filter { it.id in f.places }

  /* ------------------------------------------------------------------------------------------ words */
  fun genreLabel(g: String) = when (g) { "r&b" -> "R&B"; "hip hop" -> "Hip Hop"; else -> words(g) }
  fun words(s: String) = s.split(Regex("\\s+")).filter { it.isNotBlank() }.joinToString(" ") { w -> w.replaceFirstChar { it.titlecase(Locale.ROOT) } }
  fun placesLabel(chosen: List<Place>) = when (chosen.size) { 0 -> "Anywhere"; 1 -> short(chosen[0]); else -> "${short(chosen[0])} +${chosen.size - 1}" }
  fun short(p: Place) = p.label.substringBefore(',').trim().ifBlank { p.label }

  /** One line for the car: "Rock · Chicago +1 · English · Starred only". */
  fun summary(f: Filters, saved: List<Place>): String {
    val chosen = chosen(f, saved)
    val parts = listOfNotNull(f.genre?.let(::genreLabel), chosen.takeIf { it.isNotEmpty() }?.let(::placesLabel), f.language?.let(::words), if (f.starredOnly) "Starred only" else null)
    return if (parts.isEmpty()) "No filters: the most listened-to stations" else parts.joinToString(" · ")
  }

  /** The languages the phone is set to (in English, lowercase as the directory writes them), then the phone's menu. */
  fun preferredLanguages(locales: List<Locale>): List<String> =
    locales.map { it.getDisplayLanguage(Locale.ENGLISH).trim().lowercase(Locale.ROOT) }.filter { it.isNotBlank() && it.length <= 40 }.distinct()

  fun languageChoices(preferred: List<String>, current: String?): List<String> = (preferred + listOfNotNull(current) + LANGUAGES).distinct()

  /* -------------------------------------------------------------------------------------- matching */
  fun distanceKm(aLat: Double, aLon: Double, bLat: Double, bLon: Double): Double {
    fun r(d: Double) = d * Math.PI / 180
    val h = sin(r(bLat - aLat) / 2).let { it * it } + cos(r(aLat)) * cos(r(bLat)) * sin(r(bLon - aLon) / 2).let { it * it }
    return 2 * 6371 * asin(min(1.0, sqrt(h)))
  }

  private fun norm(s: String) = java.text.Normalizer.normalize(s.lowercase(Locale.ROOT), java.text.Normalizer.Form.NFKD).replace(Regex("[\\u0300-\\u036f]"), "").replace(Regex("[^a-z0-9]+"), " ").trim()
  private fun names(text: String, name: String) = name.isNotBlank() && " ${norm(text)} ".contains(" ${norm(name)} ")

  /** radio-places.ts stationInPlace: by coordinates when the station has them, else by the location it names. */
  fun inPlace(station: JSONObject, p: Place): Boolean {
    val cc = station.optString("countryCode").uppercase(Locale.ROOT)
    if (p.kind == "country") return cc == p.countryCode
    if (p.countryCode.isNotBlank() && cc.isNotBlank() && cc != p.countryCode) return false
    if (p.kind == "region") return names(station.optString("region"), p.region)
    val lat = station.optDouble("latitude", Double.NaN); val lon = station.optDouble("longitude", Double.NaN)
    if (lat.isFinite() && lon.isFinite() && !(lat == 0.0 && lon == 0.0)) return distanceKm(p.lat, p.lon, lat, lon) <= p.radiusKm
    return names(station.optString("region"), p.city)
  }

  /** A starred station against the filters (starred stations are filtered here, without asking the directory). */
  fun matches(station: JSONObject, f: Filters, chosen: List<Place>): Boolean {
    val tags = station.optJSONArray("tags")?.let { a -> (0 until a.length()).map { a.optString(it).trim().lowercase(Locale.ROOT) } } ?: emptyList()
    if (f.genre != null && f.genre !in tags) return false
    if (f.language != null && !station.optString("language").lowercase(Locale.ROOT).contains(f.language)) return false
    return chosen.isEmpty() || chosen.any { inPlace(station, it) }
  }

  /**
   * The directory searches for the filters (radio.ts placesPage): the most listened-to first; each chosen place
   * asked for itself (an area by distance and by the city it names, a region by state, a country by country code).
   */
  fun searchPaths(f: Filters, chosen: List<Place>, offset: Int, limit: Int): List<String> {
    fun base(): MutableList<Pair<String, String>> = mutableListOf("hidebroken" to "true", "order" to "clickcount", "reverse" to "true", "limit" to "$limit", "offset" to "$offset").apply {
      f.genre?.let { add("tag" to it); add("tagExact" to "true") }
      f.language?.let { add("language" to it) }
    }
    fun path(q: List<Pair<String, String>>) = "/json/stations/search?" + q.joinToString("&") { (k, v) -> "$k=${enc(v)}" }
    if (chosen.isEmpty()) return listOf(path(base()))
    val out = mutableListOf<String>()
    for (p in chosen.take(8)) {
      when (p.kind) {
        "country" -> out += path(base() + ("countrycode" to p.countryCode))
        "region" -> out += path(base() + ("state" to p.region) + listOfNotNull(p.countryCode.takeIf { it.isNotBlank() }?.let { "countrycode" to it }))
        else -> {
          out += path(base() + ("geo_lat" to "%.5f".format(Locale.ROOT, p.lat)) + ("geo_long" to "%.5f".format(Locale.ROOT, p.lon)) + ("geo_distance" to "${Math.round(p.radiusKm * 1000)}"))
          if (p.city.isNotBlank()) out += path(base() + ("state" to p.city) + listOfNotNull(p.countryCode.takeIf { it.isNotBlank() }?.let { "countrycode" to it }))
        }
      }
    }
    return out
  }

  /** Several answers interleaved so every place shows near the top; one row per station. */
  fun <T> interleave(lists: List<List<T>>, id: (T) -> String): List<T> {
    val out = mutableListOf<T>(); val seen = mutableSetOf<String>()
    var i = 0
    while (lists.any { i < it.size }) { for (l in lists) if (i < l.size && seen.add(id(l[i]))) out += l[i]; i++ }
    return out
  }
}
