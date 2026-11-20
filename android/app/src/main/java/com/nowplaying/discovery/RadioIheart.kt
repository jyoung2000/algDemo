package com.nowplaying.discovery

import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

/**
 * RADIO-ALL-STATIONS-001 (mirrors web/src/engine/radio-iheart.ts): iHeart's live-station directory beside Radio
 * Browser, which has no V103 (WVAZ) or Power 92 (WPWX). Station facts only; genre labels never train taste.
 */
internal object RadioIheart {
  private const val API = "https://api.iheart.com/api"
  private val SPANISH = Regex("\\b(spanish|mexican|tejano|regional mexicano|latin|tropical|reggaeton|bachata|salsa|cumbia)\\b")

  fun nearUrl(lat: Double, lon: Double) = "$API/v2/content/liveStations?limit=200&lat=${"%.4f".format(Locale.ROOT, lat)}&lng=${"%.4f".format(Locale.ROOT, lon)}"
  fun searchUrl(q: String) = "$API/v3/search/all?keywords=" + java.net.URLEncoder.encode(q.trim().take(80), "UTF-8").replace("+", "%20") +
    "&bundle=false&station=true&artist=false&track=false&playlist=false&podcast=false&keyword=true&countryCode=US&startIndex=0&maxRows=12"
  fun idsUrl(ids: List<String>) = "$API/v2/content/liveStations?limit=12&id=" + ids.take(12).joinToString(",")
  fun byIdUrl(id: String): String? = Regex("^ihr-(\\d{1,9})$").find(id)?.groupValues?.get(1)?.let { "$API/v2/content/liveStations?limit=1&id=$it" }

  private fun web(v: String): String { val t = v.trim(); if (t.isBlank()) return ""; val u = if (Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(t)) t else "https://$t"; return if (RadioCatalog.publicUrl(u)) u else "" }

  private fun stream(s: JSONObject?): String {
    for (k in listOf("secure_shoutcast_stream", "shoutcast_stream", "secure_hls_stream", "hls_stream")) {
      val u = s?.optString(k).orEmpty().trim()
      if (u.isNotBlank() && u != "null" && RadioCatalog.publicUrl(u)) return u
    }
    return ""
  }

  fun station(o: JSONObject): RadioCatalog.Station? {
    val n = o.optLong("id", -1); val name = o.optString("name").trim(); val url = stream(o.optJSONObject("streams"))
    if (n <= 0 || name.isBlank() || url.isBlank()) return null
    val markets = o.optJSONArray("markets") ?: JSONArray()
    val m = (0 until markets.length()).mapNotNull { markets.optJSONObject(it) }.let { all -> all.firstOrNull { it.optBoolean("origin") } ?: all.firstOrNull() } ?: JSONObject()
    val cc = (m.optString("country").ifBlank { o.optString("countries") }).take(2).uppercase(Locale.ROOT)
    val genres = o.optJSONArray("genres") ?: JSONArray()
    val tags = (0 until genres.length()).flatMap { i -> genres.optJSONObject(i)?.optString("name").orEmpty().lowercase(Locale.ROOT).split(Regex("\\s+(?:and|&)\\s+")) }
      .map(String::trim).filter(String::isNotBlank).distinct().take(10)
    val call = o.optString("callLetters").uppercase(Locale.ROOT).replace(Regex("-(FM|AM|HD\\d*)$"), "")
    val data = JSONObject().put("id", "ihr-$n").put("name", name).put("url", url)
      .put("homepage", web(o.optString("website"))).put("image", web(o.optString("logo")).substringBefore('?'))
      .put("country", if (cc == "US") "The United States Of America" else "").put("countryCode", cc)
      .put("region", listOf(m.optString("city"), m.optString("stateAbbreviation")).filter { it.isNotBlank() }.joinToString(", "))
      .put("language", if (tags.any { SPANISH.containsMatchIn(it) }) "spanish" else if (cc == "US") "english" else "")
      .put("tags", JSONArray(tags)).put("codec", "AAC").put("bitrate", 0).put("call", call)
    return RadioCatalog.normalize(data)
  }

  fun parse(raw: String): List<RadioCatalog.Station> = runCatching {
    val hits = JSONObject(raw).optJSONArray("hits") ?: JSONArray()
    (0 until minOf(hits.length(), 300)).mapNotNull { hits.optJSONObject(it)?.let(::station) }.distinctBy { it.id }
  }.getOrDefault(emptyList())

  /** iHeart answers with the local market(s); a lone station from a far market is dropped. */
  fun near(raw: String, p: CarRadioFilters.Place): List<RadioCatalog.Station> {
    val all = parse(raw)
    val count = all.groupingBy { it.json().optString("region") }.eachCount()
    return all.filter { (count[it.json().optString("region")] ?: 0) * 10 >= all.size || CarRadioFilters.inPlace(it.json(), p) }
  }

  fun fits(s: RadioCatalog.Station, f: CarRadioFilters.Filters): Boolean {
    val j = s.json()
    f.language?.let { if (!j.optString("language").contains(it, ignoreCase = true)) return false }
    f.genre?.let { g -> val tags = j.optJSONArray("tags") ?: JSONArray(); if ((0 until tags.length()).none { tags.optString(it).equals(g, ignoreCase = true) }) return false }
    return true
  }

  private fun host(u: String) = runCatching { java.net.URI(u).host.orEmpty().lowercase(Locale.ROOT).removePrefix("www.") }.getOrDefault("")
  private fun calls(name: String) = Regex("(?:^|[^A-Z])([WK][A-Z]{2,3})(?=$|[^A-Z])").findAll(name.uppercase(Locale.ROOT)).map { it.groupValues[1] }.toSet()

  /** CAR-RADIO-IHEART-001: iHeart stations matching a typed name, call letters or dial number (V103, WKSC, 102.7).
   *  A failure or no match is an empty list: Radio Browser still answers the search. */
  fun search(query: String, fetch: (String) -> String): List<RadioCatalog.Station> = runCatching {
    if (query.isBlank()) return emptyList()
    val st = JSONObject(fetch(searchUrl(query))).optJSONObject("results")?.optJSONArray("stations") ?: return emptyList()
    val ids = (0 until st.length()).mapNotNull { st.optJSONObject(it)?.optLong("id", -1)?.takeIf { n -> n > 0 }?.toString() }.distinct().take(12)
    if (ids.isEmpty()) return emptyList()
    parse(fetch(idsUrl(ids))).filter { s ->
      val j = s.json(); val call = j.optString("call")
      RadioNames.matchesQuery(s.name, query) || (call.isNotBlank() && RadioNames.matchesQuery(call, query))
    }
  }.getOrDefault(emptyList())

  /** Stations iHeart knows (its own rows and merged directory rows) first, each group keeping its order: in a car
   *  search they are the local commercial stations a driver means by "power" or "kiss". */
  fun iheartFirst(rows: List<RadioCatalog.Station>, local: Set<String> = emptySet()): List<RadioCatalog.Station> =
    rows.sortedBy {
      val ih = it.json().optString("iheartId").let { n -> if (n.isBlank()) "" else "ihr-$n" }
      if (it.id in local || ih in local) 0 else if (it.id.startsWith("ihr-") || ih.isNotEmpty()) 1 else 2
    }

  /** Stations near the car's places (at most two asked) whose name or call letters match the query. */
  fun searchNear(query: String, places: List<CarRadioFilters.Place>, fetch: (String) -> String): List<RadioCatalog.Station> =
    if (query.isBlank()) emptyList() else places.take(2).flatMap { p ->
      runCatching { near(fetch(nearUrl(p.lat, p.lon)), p) }.getOrDefault(emptyList()).filter { s ->
        val call = s.json().optString("call")
        RadioNames.matchesQuery(s.name, query) || (call.isNotBlank() && RadioNames.matchesQuery(call, query))
      }
    }.distinctBy { it.id }

  /** One row per station: a Radio Browser row wins (starred ids keep working), borrows a missing logo and plays
   *  iHeart's stream with iHeart's id (CAR-RADIO-IHEART-001): the volunteer directory's link can go stale (WXRT). */
  fun merge(directory: List<RadioCatalog.Station>, iheart: List<RadioCatalog.Station>): List<RadioCatalog.Station> {
    val out = directory.toMutableList()
    for (s in iheart) {
      val j = s.json(); val call = j.optString("call"); val home = host(j.optString("homepage"))
      val at = out.indexOfFirst { x -> x.id == s.id || (!x.id.startsWith("ihr-") && ((call.isNotBlank() && call in calls(x.name)) || (home.isNotBlank() && host(x.json().optString("homepage")) == home))) }
      if (at < 0) { out += s; continue }
      if (out[at].id == s.id) continue
      val old = out[at].json().put("url", s.url).put("iheartId", s.id.removePrefix("ihr-"))
      if (old.optString("image").isBlank() && j.optString("image").isNotBlank()) old.put("image", j.getString("image"))
      out[at] = RadioCatalog.normalize(old) ?: out[at]
    }
    return out
  }
}
