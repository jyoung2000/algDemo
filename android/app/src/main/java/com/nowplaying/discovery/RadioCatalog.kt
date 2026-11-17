package com.nowplaying.discovery

import android.content.Context
import android.net.Uri
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.SettableFuture
import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.net.URLEncoder
import java.util.Locale
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executors
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/** Native, Activity-independent radio directory and phone/car shared station favourites.
 * Network access always goes through RadioNative's public-address/redirect/size guard.
 * Directory labels describe stations, never the music currently being broadcast.
 */
object RadioCatalog {
  const val ROOT = "radio"
  const val FAVOURITES = "radio/favourites"
  const val AZ = "radio/az/0"
  const val SEARCH = "radio/search"
  const val STATION_PREFIX = "radio/station/"
  const val PAGE_SIZE = 100
  const val MAX_FAVOURITES = 500
  private const val PREFS = "airwave-radio"
  private const val KEY = "favourites"

  data class Station(val id: String, val name: String, val url: String, private val data: String) {
    fun json(): JSONObject = JSONObject(data)
  }
  private val workers = ThreadPoolExecutor(2, 2, 30, TimeUnit.SECONDS, ArrayBlockingQueue(24), { r -> Thread(r, "AirwaveRadioCatalog").apply { isDaemon = true } })
  private val deadlines = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "AirwaveRadioDeadline").apply { isDaemon = true } }
  private val listeners = CopyOnWriteArraySet<() -> Unit>()
  private val directory by lazy { RadioDirectory { RadioNative.fetchText(it) } }
  private val known = LinkedHashMap<String, Station>()
  private val contexts = LinkedHashMap<String, List<Station>>()
  @Volatile private var selected: List<Station> = emptyList()
  private val tuning = Any()
  private val retainContext = ThreadLocal<Boolean>()
  @Volatile private var favouriteRows: List<Station> = emptyList()
  private var store: RadioFavouritesStore? = null

  /** A finite queue, two workers and a deadline, including queued time; never run caller IO inline. */
  fun <T> async(work: () -> T): ListenableFuture<T> {
    val out = SettableFuture.create<T>()
    try {
      val job = workers.submit { try { if (!out.isCancelled) out.set(work()) } catch (e: Exception) { out.setException(e) } }
      out.addListener({ if (out.isCancelled) job.cancel(true) }, com.google.common.util.concurrent.MoreExecutors.directExecutor())
    } catch (e: java.util.concurrent.RejectedExecutionException) { out.setException(e) }
    return Futures.withTimeout(out, 20, TimeUnit.SECONDS, deadlines)
  }

  private fun publicUrl(raw: String): Boolean = runCatching {
    val u = URI(raw)
    val h = u.host?.lowercase(Locale.ROOT) ?: return false
    u.scheme in listOf("http", "https") && u.userInfo == null && raw.length <= 4096 &&
      !Regex("^(localhost|127\\.|10\\.|0\\.|169\\.254\\.|192\\.168\\.|172\\.(1[6-9]|2[0-9]|3[01])\\.|\\[)|\\.local$").containsMatchIn(h)
  }.getOrDefault(false)

  /** Accept both Radio Browser rows and the phone's normalized RadioStation; output the latter. */
  fun normalize(o: JSONObject): Station? {
    fun text(key: String, fallback: String = "") = o.optString(key, fallback).takeUnless { it == "null" }.orEmpty().trim().take(500)
    val id = text("id").ifBlank { text("stationuuid") }
    val name = text("name")
    val url = text("url_resolved").ifBlank { text("url") }
    if (id.isBlank() || name.isBlank() || !publicUrl(url)) return null
    val data = JSONObject().put("id", id).put("name", name).put("url", url)
    for ((key, source) in listOf("homepage" to "homepage", "image" to "favicon", "country" to "country", "countryCode" to "countrycode", "region" to "state", "language" to "language", "codec" to "codec")) {
      val value = text(key).ifBlank { text(source) }
      data.put(key, if (key in listOf("homepage", "image") && !publicUrl(value)) "" else value)
    }
    val tags = o.optJSONArray("tags") ?: JSONArray(text("tags").split(',').map(String::trim).filter(String::isNotBlank).take(10))
    data.put("tags", JSONArray((0 until minOf(tags.length(), 10)).map { tags.optString(it).take(100) }))
    data.put("bitrate", o.optInt("bitrate").coerceIn(0, 100000))
    for ((key, old, bound) in listOf(Triple("latitude", "geo_lat", 90.0), Triple("longitude", "geo_long", 180.0))) {
      val number = o.optDouble(key, o.optDouble(old, Double.NaN))
      data.put(key, if (number.isFinite() && number in -bound..bound) number else JSONObject.NULL)
    }
    return Station(id, name, url, data.toString())
  }

  internal fun rows(array: JSONArray, limit: Int = PAGE_SIZE): List<Station> = (0 until minOf(array.length(), limit)).mapNotNull { array.optJSONObject(it)?.let(::normalize) }.distinctBy { it.id }
  internal fun sorted(rows: List<Station>): List<Station> = rows.sortedWith(compareBy({ it.name.lowercase(Locale.ROOT) }, { it.id }))
  fun addListener(listener: () -> Unit) { listeners += listener }
  fun removeListener(listener: () -> Unit) { listeners -= listener }
  fun isFavourite(stationId: String): Boolean = favouriteRows.any { it.id == stationId }
  fun favouriteCount(): Int = favouriteRows.size

  private fun store(ctx: Context): RadioFavouritesStore = store ?: run {
    val prefs = ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    RadioFavouritesStore({ prefs.getString(KEY, "[]") ?: "[]" }, { check(prefs.edit().putString(KEY, it).commit()) { "Could not save favourite stations" } }).also { store = it }
  }

  /** Synchronous getter/setter for the background native bridge. null=get; []=clear, not get.
   * This is the only persistence authority: the phone must delegate its favourites op here.
   */
  @Synchronized fun favourites(ctx: Context, stations: JSONArray?): JSONArray {
    val saved = store(ctx)
    if (stations != null) saved.replace(stations)
    favouriteRows = saved.rows()
    rememberStations(JSONArray(favouriteRows.map { it.json() }))
    if (stations != null) listeners.forEach { it() }
    return JSONArray(favouriteRows.map { it.json() })
  }

  fun load(ctx: Context): ListenableFuture<JSONArray> = async { favourites(ctx, null) }
  fun toggle(ctx: Context, stationId: String): ListenableFuture<JSONArray> = async {
    val station = resolve(ctx, stationId) ?: error("Station is unavailable")
    synchronized(this) {
      val saved = store(ctx)
      saved.toggle(station)
      favouriteRows = saved.rows()
      listeners.forEach { it() }
      JSONArray(favouriteRows.map { it.json() })
    }
  }

  /** Remember the phone or car list without changing a currently tuned station's skip context. */
  @Synchronized fun rememberStations(rows: JSONArray) {
    val list = rows(rows, MAX_FAVOURITES)
    for (station in list) { known[station.id] = station; contexts[station.id] = list }
    while (known.size > 2000) known.remove(known.keys.first())
    while (contexts.size > 2000) contexts.remove(contexts.keys.first())
  }
  @Synchronized fun selectContext(stationId: String) {
    if (retainContext.get() == true) return
    selected = contexts[stationId] ?: known[stationId]?.let(::listOf) ?: emptyList()
  }
  /** Native start also selects a context for phone-originated tunes. Catalogue starts have
   * already selected theirs; a skip must not adopt a later browse/favourites list for its target.
   * Scope to this worker, not a global flag that could suppress a simultaneous phone tune.
   */
  internal fun <T> retainingContext(work: () -> T): T {
    val previous = retainContext.get()
    retainContext.set(true)
    return try { work() } finally {
      if (previous == null) retainContext.remove() else retainContext.set(previous)
    }
  }
  fun canSkip(stationId: String): Boolean = selected.size > 1 && selected.any { it.id == stationId }
  fun adjacent(stationId: String, dir: Int): Station? {
    val list = selected
    val at = list.indexOfFirst { it.id == stationId }
    if (at < 0 || list.size < 2 || dir == 0) return null
    return list[Math.floorMod(at + if (dir > 0) 1 else -1, list.size)]
  }
  /** RADIO-SHUFFLE-001: a uniformly random OTHER station of the tuned list; null when there is no
   * other (fewer than two stations, or the tuned station is not in its list), as ordered skips. */
  fun randomOther(stationId: String, random: kotlin.random.Random = kotlin.random.Random.Default): Station? {
    val list = selected
    val at = list.indexOfFirst { it.id == stationId }
    if (at < 0 || list.size < 2) return null
    val others = list.filterIndexed { i, _ -> i != at }
    return others[random.nextInt(others.size)]
  }

  /** Called only on a catalogue worker; cold ids are resolved by UUID, not by an Activity map. */
  @Synchronized private fun cached(stationId: String) = known[stationId] ?: favouriteRows.firstOrNull { it.id == stationId }
  fun resolve(ctx: Context, stationId: String): Station? {
    cached(stationId)?.let { return it }
    favourites(ctx, null)
    cached(stationId)?.let { return it }
    require(stationId.matches(Regex("[A-Za-z0-9-]{1,100}"))) { "Invalid station id" }
    val station = directory.byId(stationId) ?: return null
    rememberStations(JSONArray().put(station.json()))
    return station
  }
  fun stationId(mediaId: String): String? = if (mediaId.startsWith(STATION_PREFIX)) Uri.decode(mediaId.removePrefix(STATION_PREFIX)).takeIf { it.isNotBlank() } else null
  fun item(station: Station): MediaItem {
    val data = station.json()
    val location = listOf(data.optString("region"), data.optString("country")).filter { it.isNotBlank() }.distinct().joinToString(", ")
    return MediaItem.Builder().setMediaId(STATION_PREFIX + Uri.encode(station.id)).setUri(station.url)
      .setMediaMetadata(MediaMetadata.Builder().setTitle(station.name).setArtist(location.ifBlank { "Live radio" })
        .setSubtitle(location).setArtworkUri(data.optString("image").takeIf { it.isNotBlank() }?.let(Uri::parse))
        .setIsBrowsable(false).setIsPlayable(true).setMediaType(MediaMetadata.MEDIA_TYPE_RADIO_STATION).build()).build()
  }

  fun stations(ctx: Context, query: String = "", offset: Int = 0): ListenableFuture<List<Station>> = async {
    favourites(ctx, null)
    val favourites = sorted(favouriteRows.filter { query.isNotBlank() && it.name.contains(query, true) })
    val found = try { directory.stations(query, offset) } catch (e: Exception) { if (favourites.isEmpty()) throw e else emptyList() }
    rememberStations(JSONArray((favourites + found).distinctBy { it.id }.map { it.json() }))
    // Favourites lead search results, but never disrupt the world's A-Z pagination.
    if (query.isBlank()) found else sorted(favouriteRows.filter { it.name.contains(query, true) }) + found.filterNot { s -> favouriteRows.any { it.id == s.id } }
  }
  fun favouriteItems(ctx: Context): ListenableFuture<List<MediaItem>> = async {
    val rows = rows(favourites(ctx, null), MAX_FAVOURITES)
    rememberStations(JSONArray(rows.map { it.json() }))
    rows.map(::item)
  }

  /** EnginePlayer intercepts radio/station ids and returns this future instead of song lookup. */
  fun play(ctx: Context, mediaId: String): ListenableFuture<JSONObject> = async {
    val id = stationId(mediaId) ?: mediaId
    val station = resolve(ctx, id) ?: error("Station is unavailable")
    synchronized(tuning) { selectContext(id); start(ctx, station) }
  }
  private fun start(ctx: Context, station: Station): JSONObject {
    check(!Thread.currentThread().isInterrupted) { "Radio request was cancelled" }
    return retainingContext {
      RadioNative.handle(ctx, JSONObject().put("op", "start")
        .put("stationId", station.id).put("name", station.name).put("title", "Live radio").put("url", station.url)
        .put("station", station.json()))
    }
  }

  /** +1/-1 switch stations, not timed seeks. The caller may ignore the returned future.
   * RADIO-SHUFFLE-001: with radio shuffle on, either direction tunes a random other station. */
  fun skip(ctx: Context, dir: Int): ListenableFuture<JSONObject> = async {
    synchronized(tuning) {
      val current = RadioNative.session?.station ?: error("No radio station is playing")
      val station = (if (RadioNative.shuffle) randomOther(current) else null)
        ?: adjacent(current, dir) ?: error("No other station in this list")
      start(ctx, station)
    }
  }
}

/** Plain persistence policy, tested without Android SharedPreferences stubs. */
internal class RadioFavouritesStore(private val read: () -> String, private val write: (String) -> Unit) {
  fun rows(): List<RadioCatalog.Station> = RadioCatalog.sorted(RadioCatalog.rows(runCatching { JSONArray(read()) }.getOrElse { JSONArray() }, RadioCatalog.MAX_FAVOURITES))
  fun replace(array: JSONArray) { write(JSONArray(RadioCatalog.sorted(RadioCatalog.rows(array, RadioCatalog.MAX_FAVOURITES)).map { it.json() }).toString()) }
  fun toggle(station: RadioCatalog.Station) {
    val old = rows()
    val removing = old.any { it.id == station.id }
    require(removing || old.size < RadioCatalog.MAX_FAVOURITES) { "Favourite station limit reached" }
    replace(JSONArray((if (removing) old.filterNot { it.id == station.id } else old + station).map { it.json() }))
  }
}

/** Bounded server-side A-Z pages; no eager crawl or directory work on the service thread. */
internal class RadioDirectory(private val fetch: (String) -> String) {
  private val mirrors = listOf("https://de1.api.radio-browser.info", "https://nl1.api.radio-browser.info", "https://at1.api.radio-browser.info")
  private val cache = LinkedHashMap<String, Pair<Long, List<RadioCatalog.Station>>>()
  @Synchronized private fun read(path: String): List<RadioCatalog.Station> {
    cache[path]?.takeIf { System.nanoTime() - it.first < TimeUnit.MINUTES.toNanos(5) }?.let { return it.second }
    var last: Exception? = null
    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(18)
    for (mirror in mirrors) {
      if (Thread.currentThread().isInterrupted || System.nanoTime() >= deadline) break
      try {
        val text = fetch(mirror + path)
        require(text.length <= 2_000_000) { "Directory answer too large" }
        val rows = RadioCatalog.sorted(RadioCatalog.rows(JSONArray(text)))
        cache[path] = System.nanoTime() to rows
        while (cache.size > 48) cache.remove(cache.keys.first())
        return rows
      } catch (e: Exception) { last = e }
    }
    throw IllegalStateException("Station directory is unavailable; try Favourite stations or retry", last)
  }
  fun stations(query: String, offset: Int): List<RadioCatalog.Station> {
    require(offset in 0..1_000_000 && query.length <= 100) { "Invalid station search" }
    return read("/json/stations/search?hidebroken=true&order=name&reverse=false&limit=100&offset=$offset" +
      if (query.isBlank()) "" else "&name=" + URLEncoder.encode(query.trim(), "UTF-8"))
  }
  fun byId(id: String): RadioCatalog.Station? = read("/json/stations/byuuid/" + URLEncoder.encode(id, "UTF-8")).firstOrNull { it.id == id }
}
