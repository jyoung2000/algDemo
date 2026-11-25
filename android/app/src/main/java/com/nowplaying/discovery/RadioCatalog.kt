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
  const val ALL = "radio/all"
  // RADIO-AZ-ALL-001 (owner, 2026-11-24): '#' holds every name the Latin alphabet cannot index (other scripts,
  // symbols, punctuation); digits have their own folder, so no station in the directory is left without a home.
  val LETTERS = ('A'..'Z').map { it.toString() } + "#"
  val NUMBERS = (0..9).map { it.toString() }
  const val NUMBERS_FOLDER = "radio/numbers"
  fun initial(name: String): String = RadioNames.initial(name)
  /** The car's A-Z tree: stations in order, then one folder per initial, then the numbers folder. */
  fun allFolders(): List<String> = listOf(AZ) + LETTERS.map { "radio/letter/$it/0" } + NUMBERS_FOLDER
  fun numberFolders(): List<String> = NUMBERS.map { "radio/letter/$it/0" }
  /** The initial and page of a letter folder id, or null when the id is not one (never trust a browse id). */
  fun letterFolder(id: String): Pair<String, Int>? {
    val parts = id.split('/')
    if (parts.size != 4 || parts[0] != "radio" || parts[1] != "letter") return null
    val letter = parts[2].takeIf { it in LETTERS || it in NUMBERS } ?: return null
    val offset = parts[3].toIntOrNull()?.takeIf { it in 0..1_000_000 } ?: return null
    return letter to offset
  }

  data class StationPage(val stations: List<Station>, val nextOffset: Int?)
  const val SEARCH = "radio/search"
  const val STATION_PREFIX = "radio/station/"
  const val PAGE_SIZE = 100
  /** RADIO-AZ-ALL-001: rows per directory request, and rows scanned per car page, when browsing by initial. */
  const val INITIAL_BATCH = 500
  const val INITIAL_BUDGET = 4000
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
  private val aliasIndex = linkedMapOf<String, Station>()
  private var namedMatches: List<Station> = emptyList()
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

  internal fun publicUrl(raw: String): Boolean = runCatching {
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
    // RADIO-ROBUST-001: a playlist link is read fresh each time; the resolved address behind it can be an expired
    // one-time session (WGN 720) or a retired server.
    val playlist = Regex("\\.(m3u8?|pls)(\\?|$)|/playlist/", RegexOption.IGNORE_CASE).containsMatchIn(text("url"))
    val url = if (playlist && publicUrl(text("url"))) text("url") else text("url_resolved").ifBlank { text("url") }
    if (id.isBlank() || name.isBlank() || !publicUrl(url)) return null
    val data = JSONObject().put("id", id).put("name", name).put("url", url)
    for ((key, source) in listOf("homepage" to "homepage", "image" to "favicon", "country" to "country", "countryCode" to "countrycode", "region" to "state", "language" to "language", "codec" to "codec", "call" to "call", "iheartId" to "iheartId")) {
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
  internal fun sorted(rows: List<Station>): List<Station> = rows.sortedWith(compareBy({ RadioNames.sortKey(it.name) }, { it.id }))
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
    for (station in list) {
      known[station.id] = station; contexts[station.id] = list
      val alias = RadioNames.parts(station.name)
      namedMatches = namedMatches.map { if (it.id == station.id) station else it }
      aliasIndex.remove(station.id)
      if (alias?.call != null && alias.frequency != null) aliasIndex[station.id] = station
    }
    while (aliasIndex.size > 128) aliasIndex.remove(aliasIndex.keys.first())
    while (known.size > 2000) known.remove(known.keys.first())
    while (contexts.size > 2000) contexts.remove(contexts.keys.first())
  }
  @Synchronized internal fun cachedAliases(initial: String = "", query: String = ""): List<Station> =
    (namedMatches + aliasIndex.values.toList().asReversed()).distinctBy { it.id }
      .filter { RadioNames.matchesInitial(it.name, initial) && RadioNames.matchesQuery(it.name, query) }.take(12)
  @Synchronized private fun rememberNamedQuery(query: String, stations: List<Station>) {
    if (RadioNames.parts(query)?.call != null && stations.isNotEmpty()) namedMatches = stations.take(12)
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
  /** RADIO-SHUFFLE-NO-REPEAT-001 (owner, 2026-11-25): "shuffle on radio shouldnt repeat stations and shuffle should be
   * able to load new stations". Stations tuned since shuffle went on are not drawn again; when the tuned list has no
   * other unplayed station, a random page of the whole directory (A-Z, no filter) joins the draw. */
  private val shuffleSeen = LinkedHashSet<String>()
  private val world = LinkedHashMap<String, Station>()
  @Volatile private var worldTotal = 0
  @Synchronized fun markPlayed(stationId: String) {
    shuffleSeen.remove(stationId); shuffleSeen.add(stationId)
    while (shuffleSeen.size > 5000) shuffleSeen.remove(shuffleSeen.first())
  }
  @Synchronized fun resetShuffle(current: String?) { shuffleSeen.clear(); world.clear(); current?.let { shuffleSeen.add(it) } }
  @Synchronized private fun unseenOther(stationId: String, random: kotlin.random.Random): Station? {
    val pool = (selected + world.values).distinctBy { it.id }.filter { it.id != stationId && it.id !in shuffleSeen }
    return if (pool.isEmpty()) null else pool[random.nextInt(pool.size)]
  }
  @Synchronized private fun addWorld(page: List<Station>) {
    for (st in page) { world[st.id] = st; known[st.id] = st }
    while (world.size > 2000) world.remove(world.keys.first())
    while (known.size > 2000) known.remove(known.keys.first())
  }
  /** Network: only on a catalogue worker. */
  private fun worldPage(): List<Station> {
    val total = worldTotal.takeIf { it > 0 } ?: directory.worldCount().also { worldTotal = it }
    return directory.worldPage(kotlin.random.Random.Default.nextInt(0, maxOf(1, minOf(total, 1_000_000) - PAGE_SIZE)))
  }
  private fun shuffleTarget(current: String): Station? {
    unseenOther(current, kotlin.random.Random.Default)?.let { return it }
    repeat(3) {
      runCatching { worldPage() }.getOrNull()?.let(::addWorld)
      unseenOther(current, kotlin.random.Random.Default)?.let { return it }
    }
    // Every station drawn (or the directory is down): a new round, still never the station on air.
    synchronized(this) { shuffleSeen.clear(); shuffleSeen.add(current) }
    return unseenOther(current, kotlin.random.Random.Default)
  }
  @Synchronized fun canSkip(stationId: String, shuffle: Boolean = false): Boolean =
    (selected.size > 1 && selected.any { it.id == stationId }) || (shuffle && (selected.any { it.id != stationId } || world.isNotEmpty() || selected.isNotEmpty()))
  fun adjacent(stationId: String, dir: Int): Station? {
    val list = selected
    val at = list.indexOfFirst { it.id == stationId }
    if (at < 0 || list.size < 2 || dir == 0) return null
    return list[Math.floorMod(at + if (dir > 0) 1 else -1, list.size)]
  }
  /** RADIO-SHUFFLE-001: a uniformly random OTHER station of the tuned list; null when there is no
   * other (fewer than two stations, or the tuned station is not in its list), as ordered skips. */
  fun randomOther(stationId: String, random: kotlin.random.Random = kotlin.random.Random.Default): Station? {
    if (selected.none { it.id == stationId } && synchronized(this) { !world.containsKey(stationId) }) return null
    return unseenOther(stationId, random)
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

  @Synchronized private fun remembered(): List<Station> = known.values.toList()
  fun stations(ctx: Context, query: String = "", offset: Int = 0): ListenableFuture<List<Station>> = async {
    favourites(ctx, null)
    val favourites = sorted(favouriteRows.filter { query.isNotBlank() && RadioNames.matchesQuery(it.name, query) })
    val remembered = sorted(remembered().filter { query.isNotBlank() && RadioNames.matchesQuery(it.name, query) && favouriteRows.none { f -> f.id == it.id } })
    // CAR-RADIO-IHEART-001: iHeart's own station search too (V103 and Power 92 are not in Radio Browser).
    // Asked alongside Radio Browser, not after it; its matches are listed first.
    val places = if (query.isBlank() || offset > 0) emptyList() else carFilters(ctx).places.mapNotNull { id -> savedPlaces(ctx).firstOrNull { it.id == id } }.ifEmpty { savedPlaces(ctx) }.filter { it.countryCode.equals("US", true) } // iHeart is a US directory
    val askNear = if (places.isEmpty()) null else java.util.concurrent.CompletableFuture.supplyAsync { RadioIheart.searchNear(query, places) { RadioNative.fetchText(it) } }
    val ask = if (query.isBlank() || offset > 0) null else java.util.concurrent.CompletableFuture.supplyAsync { RadioIheart.search(query) { RadioNative.fetchText(it) } }
    val rb = try { Result.success(directory.stations(query, offset)) } catch (e: Exception) { Result.failure(e) }
    val local = runCatching { askNear?.get(10, TimeUnit.SECONDS) }.getOrNull().orEmpty()
    val iheart = (local + runCatching { ask?.get(10, TimeUnit.SECONDS) }.getOrNull().orEmpty()).distinctBy { it.id }
    val found = RadioIheart.iheartFirst(RadioIheart.merge(rb.getOrElse { e -> if (favourites.isEmpty() && remembered.isEmpty() && iheart.isEmpty()) throw e else emptyList() }, iheart), local.map { it.id }.toSet())
    rememberNamedQuery(query, found)
    // Reuse real learned call-sign/frequency aliases across broad numeric searches.
    val fresh = found.associateBy { it.id }
    val result = if (query.isBlank()) found else (favourites + cachedAliases(query = query) + found + remembered).map { fresh[it.id] ?: it }.distinctBy { it.id }
    rememberStations(JSONArray(result.map { it.json() }))
    result
  }
  fun letterStations(ctx: Context, letter: String, offset: Int): ListenableFuture<StationPage> = async {
    val page = directory.letterPage(letter, offset)
    val fresh = page.stations.associateBy { it.id }
    val result = if (offset == 0) StationPage((cachedAliases(initial = letter) + page.stations).map { fresh[it.id] ?: it }.distinctBy { it.id }, page.nextOffset) else page
    rememberStations(JSONArray(result.stations.map { it.json() }))
    result
  }
  /** RADIO-AZ-ALL-001: a bounded page of the whole world in alphabetical order, with the directory's own "more". */
  fun azStations(ctx: Context, offset: Int): ListenableFuture<StationPage> = async {
    val page = directory.azPage(offset)
    rememberStations(JSONArray(page.stations.map { it.json() }))
    page
  }
  /* --------------------------------------------------------------- CAR-RADIO-FILTERS-001 */
  private const val FILTERS_KEY = "car-filters"
  private const val PLACES_KEY = "places"
  private const val FILTER_PAGE = 30
  @Volatile private var filtersCache: CarRadioFilters.Filters? = null
  @Volatile private var placesCache: List<CarRadioFilters.Place>? = null
  private fun prefs(ctx: Context) = ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  /** The car's radio filters, kept across restarts. */
  fun carFilters(ctx: Context): CarRadioFilters.Filters =
    filtersCache ?: CarRadioFilters.read(prefs(ctx).getString(FILTERS_KEY, null)).also { filtersCache = it }
  fun setCarFilters(ctx: Context, f: CarRadioFilters.Filters) { filtersCache = f; prefs(ctx).edit().putString(FILTERS_KEY, CarRadioFilters.write(f)).apply() }

  /** The places saved in the phone's Radio tab (sent by the page whenever they change). */
  fun savedPlaces(ctx: Context): List<CarRadioFilters.Place> =
    placesCache ?: CarRadioFilters.placesFrom(runCatching { JSONArray(prefs(ctx).getString(PLACES_KEY, "[]")) }.getOrNull()).also { placesCache = it }
  @Synchronized fun setPlaces(ctx: Context, array: JSONArray?): JSONArray {
    if (array != null) {
      val list = CarRadioFilters.placesFrom(array)
      placesCache = list
      prefs(ctx).edit().putString(PLACES_KEY, CarRadioFilters.placesJson(list).toString()).apply()
      listeners.forEach { it() }
    }
    return CarRadioFilters.placesJson(savedPlaces(ctx))
  }

  /** Stations for the car's filters: starred stations filtered here, otherwise the directory, most listened-to first. */
  fun filteredStations(ctx: Context, offset: Int): ListenableFuture<StationPage> = async {
    require(offset in 0..1_000_000) { "Invalid radio page" }
    val f = carFilters(ctx)
    val chosen = CarRadioFilters.chosen(f, savedPlaces(ctx))
    if (f.starredOnly) {
      favourites(ctx, null)
      return@async StationPage(favouriteRows.filter { CarRadioFilters.matches(it.json(), f, chosen) }, null)
    }
    val paths = CarRadioFilters.searchPaths(f, chosen.take(CarRadioFilters.CAR_PLACES_ASKED), offset, FILTER_PAGE)
    var full = false
    val lists = paths.map { p ->
      val raw = try { directory.raw(p) } catch (e: Exception) { if (paths.size == 1) throw e else JSONArray() }
      if (raw.length() >= FILTER_PAGE) full = true
      rows(raw, FILTER_PAGE)
    }
    var result = CarRadioFilters.interleave(lists) { it.id }
    // RADIO-ALL-STATIONS-001: every station iHeart lists around a chosen US area (V103, Power 92), on the first page.
    if (offset == 0) for (p in chosen.take(CarRadioFilters.CAR_PLACES_ASKED).filter { it.kind == "area" && it.countryCode == "US" }) {
      val extra = runCatching { RadioIheart.near(RadioNative.fetchText(RadioIheart.nearUrl(p.lat, p.lon)), p) }.getOrDefault(emptyList())
      result = RadioIheart.merge(result, extra.filter { RadioIheart.fits(it, f) })
    }
    rememberStations(JSONArray(result.map { it.json() }))
    StationPage(result, if (full && offset + FILTER_PAGE <= 1_000_000) offset + FILTER_PAGE else null)
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
      val station = (if (RadioNative.shuffle) shuffleTarget(current) else null)
        ?: adjacent(current, dir) ?: error("No other station in this list")
      // RADIO-CAR-SKIP-001: one line per press, so a skip on the car can be checked against what was tuned.
      runCatching { android.util.Log.i("jPlayRadio", "skip dir=$dir shuffle=${RadioNative.shuffle} from=$current to=${station.id} ${station.name}") }
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
  private val cache = LinkedHashMap<String, Pair<Long, JSONArray>>()
  @Synchronized private fun readRaw(path: String): JSONArray {
    cache[path]?.takeIf { System.nanoTime() - it.first < TimeUnit.MINUTES.toNanos(5) }?.let { return it.second }
    var last: Exception? = null
    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(18)
    for (mirror in mirrors) {
      if (Thread.currentThread().isInterrupted || System.nanoTime() >= deadline) break
      try {
        val text = fetch(mirror + path)
        require(text.length <= 2_000_000) { "Directory answer too large" }
        val rows = JSONArray(text)
        cache[path] = System.nanoTime() to rows
        while (cache.size > 48) cache.remove(cache.keys.first())
        return rows
      } catch (e: Exception) { last = e }
    }
    throw IllegalStateException("Station directory is unavailable; try Favourite stations or retry", last)
  }
  private fun read(path: String): List<RadioCatalog.Station> = RadioCatalog.sorted(RadioCatalog.rows(readRaw(path)))
  /** A directory answer in the directory's own order (filtered car lists keep "most listened-to first"). */
  fun raw(path: String): JSONArray { require(path.startsWith("/json/stations/search?") && path.length <= 2000) { "Invalid directory search" }; return readRaw(path) }
  // RADIO-AZ-ALL-001 (owner, 2026-11-24): Radio Browser filters names by substring only, so an initial is picked out
  // locally. A batch holding no match for this initial must not end the letter — the scan runs a bounded budget of raw
  // rows per car page and hands back an honest raw cursor, so every station in the world is reachable page by page.
  fun letterPage(letter: String, offset: Int): RadioCatalog.StationPage {
    require(letter in RadioCatalog.LETTERS + RadioCatalog.NUMBERS && offset in 0..1_000_000) { "Invalid station initial or page" }
    val out = mutableListOf<RadioCatalog.Station>(); val seen = mutableSetOf<String>()
    var cursor = offset; var scanned = 0
    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(12)
    while (scanned < RadioCatalog.INITIAL_BUDGET) {
      val q = if (letter == "#") "" else "&name=$letter"
      val raw = try { readRaw("/json/stations/search?order=name&reverse=false&limit=${RadioCatalog.INITIAL_BATCH}&offset=$cursor$q") }
      // A batch that fails keeps what this page already found and resumes there, rather than skipping those stations.
      catch (e: Exception) { if (scanned == 0) throw e else return RadioCatalog.StationPage(RadioCatalog.sorted(out), cursor.takeIf { it <= 1_000_000 }) }
      val size = raw.length()
      for (index in 0 until size) {
        val station = raw.optJSONObject(index)?.let(RadioCatalog::normalize) ?: continue
        if (!RadioNames.matchesInitial(station.name, letter) || !seen.add(station.id)) continue
        out += station
        if (out.size == RadioCatalog.PAGE_SIZE) return RadioCatalog.StationPage(RadioCatalog.sorted(out), if (index + 1 < size || size == RadioCatalog.INITIAL_BATCH) cursor + index + 1 else null)
      }
      cursor += size; scanned += size
      if (size < RadioCatalog.INITIAL_BATCH) return RadioCatalog.StationPage(RadioCatalog.sorted(out), null)
      if (System.nanoTime() >= deadline) break
    }
    return RadioCatalog.StationPage(RadioCatalog.sorted(out), cursor.takeIf { it <= 1_000_000 })
  }
  /** RADIO-AZ-ALL-001: one page of the plain A-Z list, with "More" offered whenever the directory itself has more. */
  fun azPage(offset: Int): RadioCatalog.StationPage {
    require(offset in 0..1_000_000) { "Invalid radio page" }
    val raw = readRaw("/json/stations/search?order=name&reverse=false&limit=${RadioCatalog.PAGE_SIZE}&offset=$offset")
    val size = raw.length()
    val stations = RadioCatalog.sorted((0 until size).mapNotNull { raw.optJSONObject(it)?.let(RadioCatalog::normalize) }.distinctBy { it.id })
    return RadioCatalog.StationPage(stations, (offset + size).takeIf { size == RadioCatalog.PAGE_SIZE && it <= 1_000_000 })
  }
  fun stations(query: String, offset: Int): List<RadioCatalog.Station> {
    require(offset in 0..1_000_000 && query.length <= 100) { "Invalid station search" }
    val alias = RadioNames.parts(query)
    val ordering = "order=name&reverse=false"
    val found = read("/json/stations/search?hidebroken=true&$ordering&limit=100&offset=$offset" +
      if (query.isBlank()) "" else "&name=" + URLEncoder.encode(RadioNames.source(query), "UTF-8"))
    return if (alias == null) found else found.filter { RadioNames.matchesQuery(it.name, query) }
  }
  /** RADIO-SHUFFLE-NO-REPEAT-001: how many stations the directory holds, so shuffle can open a random A-Z page. */
  fun worldCount(): Int {
    for (mirror in mirrors) {
      val n = runCatching { JSONObject(fetch("$mirror/json/stats")).optInt("stations", 0) }.getOrDefault(0)
      if (n > 0) return n
    }
    return 40_000
  }
  /** A page of every station in the world by name, with no filter (RADIO-AZ-ALL-001's whole directory). */
  fun worldPage(offset: Int): List<RadioCatalog.Station> {
    require(offset in 0..1_000_000) { "Invalid station offset" }
    return RadioCatalog.rows(readRaw("/json/stations/search?order=name&reverse=false&limit=100&offset=$offset"))
  }
  fun byId(id: String): RadioCatalog.Station? {
    RadioIheart.byIdUrl(id)?.let { url -> return RadioIheart.parse(fetch(url)).firstOrNull { it.id == id } }
    return read("/json/stations/byuuid/" + URLEncoder.encode(id, "UTF-8")).firstOrNull { it.id == id }
  }
}
