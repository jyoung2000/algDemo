package com.nowplaying.discovery

import android.os.Handler
import android.os.Looper
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CopyOnWriteArrayList
import java.text.Normalizer
import java.util.Locale
import java.util.UUID
import java.util.concurrent.TimeoutException
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.SettableFuture

/**
 * The bridge between the WebView's Web Audio engine (which actually renders audio, with the
 * equaliser, crossfade and mixer) and the native Media3 session that the OS lock screen, quick-panel
 * media card, Bluetooth/headset buttons and Android Auto talk to.
 *
 * Design (MEDIA-NATIVE-001): the native layer never decodes audio. [WebPlayer] is a proxy
 * [androidx.media3.common.SimpleBasePlayer] whose state is whatever the page last reported here, and
 * whose transport commands are forwarded back to the page as a JSON command. So there is exactly one
 * playback — the WebView's — and every surface (in-app UI, lock screen, car) controls it, which is
 * why the in-app effects are preserved for the car and lock screen instead of being lost to a second
 * native player.
 *
 * Everything the native side reads is pushed from the page through `AirwaveNative.media(json)`:
 *  - [state]:   now playing + position + the current up-next queue, for the session/lock screen;
 *  - [songs]:   the now playing queue, for the Android Auto browse tree and typed/voice search;
 *  - [playlists]: the listener's playlists, for the browse tree.
 *
 * This object holds only the latest snapshot and a command sink; it owns no threads. Listeners are
 * notified on the main thread so [WebPlayer.invalidateState] runs on the player's Looper.
 */
object MediaHub {
  /** One song as the native side needs it: a stable id (the page's track key), display text and
   *  whether its complete audio is downloaded and ready to play right now. */
  data class Song(
    val id: String,
    val title: String,
    val artist: String,
    val album: String?,
    val artwork: String?,
    val durationMs: Long,
    val ready: Boolean,
    /** The download link whose complete audio is held on the phone (`Downloads.localFile` key),
     *  pushed only while [ready]. The native engine plays this file; without it a song is not
     *  playable natively, whatever [ready] says. */
    val source: String? = null,
    /** CAR-SEARCH-TYPES-001: the kinds the page found this song to be (single/album/feature/lyrics). */
    val kinds: Set<String> = emptySet(),
    /** SHUFFLE-ONCE-001: the page heard this queue song before; the queue's shuffle does not play it again. */
    val heard: Boolean = false,
  )

  /** A browsable folder in the Android Auto tree: the now playing queue, one playlist, or one album
   *  (ALBUM-SAVE-001: a saved album; ALBUM-CAR-001: an album a car search found, songs in album order). */
  data class Folder(
    val id: String,
    val title: String,
    val songs: List<Song>,
    val album: Boolean = false,
    val artist: String? = null,
    val artwork: String? = null,
  )

  /** The playback snapshot the session renders. [queue] is the current up-next order including the
   *  song now playing at [queueIndex]; next/previous and the car's "now playing" queue read it. */
  data class State(
    val hasTrack: Boolean = false,
    val playing: Boolean = false,
    val mediaId: String? = null,
    val title: String = "jPlay",
    val artist: String = "",
    val album: String? = null,
    val artwork: String? = null,
    val durationMs: Long = C_TIME_UNSET,
    val positionMs: Long = 0,
    val canNext: Boolean = false,
    val canPrev: Boolean = false,
    val shuffle: Boolean = false,
    val repeat: Int = 0, // 0 off, 1 one, 2 all
    val queue: List<Song> = emptyList(),
    val queueIndex: Int = 0,
    /** Wall-clock (SystemClock.elapsedRealtime) when [positionMs] was reported, so the seek bar can
     *  be extrapolated while playing without the page pushing four updates a second. */
    val reportedAt: Long = 0,
    /** CAR-ACTIONS-001: the page's Star (like) and Dislike state for [mediaId]. */
    val liked: Boolean = false,
    val disliked: Boolean = false,
    /** SHUFFLE-ONCE-001: the queue is the now playing queue under shuffle, whose songs play once. */
    val once: Boolean = false,
  )

  const val C_TIME_UNSET: Long = Long.MIN_VALUE + 1 // mirrors androidx.media3.common.C.TIME_UNSET

  @Volatile var state: State = State(); private set
  @Volatile var songs: List<Song> = emptyList(); private set
  @Volatile var playlists: List<Folder> = emptyList(); private set

  private val main = Handler(Looper.getMainLooper())
  private val listeners = CopyOnWriteArrayList<() -> Unit>()

  /** Set by [MainActivity] to forward a native transport command into the page's command handler. */
  @Volatile private var sink: ((JSONObject) -> Unit)? = null

  /** True once the page behind the current command sink has pushed its first state: it can answer. */
  @Volatile var pageAnswering: Boolean = false; private set

  /** Whether the page behind [sink] is in front of the listener. A hidden Activity's WebView cannot
   *  be relied on to answer, so then the service's own catalogue engine answers car searches. */
  @Volatile private var pageVisible: Boolean = true

  fun setCommandSink(s: (JSONObject) -> Unit) { sink = s; pageAnswering = false; pageVisible = true; pageRunning = { true } }
  fun setPageVisible(s: (JSONObject) -> Unit, visible: Boolean) {
    if (sink !== s) return
    pageVisible = visible
    // CAR-ACTIONS-EVERY-TIME-001: a hidden page may never answer; after a moment its car presses go to the service engine.
    if (!visible) main.postDelayed({ rerouteHidden() }, 3000)
    if (visible) main.post { synchronized(catalogLock) { pendingSearches.keys.toList() }.forEach(::dispatchCatalogSearch) }
    // CAR-SAVE-HIDDEN-001: back in front, the page takes what the car pressed while nothing could save it.
    if (visible && pageAnswering) CarFeedback.flush()
  }

  /** CAR-SAVE-HIDDEN-001: whether the page behind [sink] runs its JavaScript now (a paused WebView runs none). */
  @Volatile private var pageRunning: () -> Boolean = { true }
  fun setPageRunning(s: (JSONObject) -> Unit, running: () -> Boolean) { if (sink === s) pageRunning = running }

  /** CAR-SAVE-HIDDEN-001: whether the service's own page is the engine and has said it is ready. */
  @Volatile var serviceSaves: () -> Boolean = { ServiceApi.core.ready }

  /** CAR-SAVE-HIDDEN-001: where a star or a playlist choice made in the car is saved now; null: keep it. */
  fun saveSink(): ((JSONObject) -> Unit)? = when (saveRoute()) {
    CarRoute.To.PAGE -> sink
    CarRoute.To.SERVICE -> catalogSink
    CarRoute.To.KEEP -> null
  }
  /** Whether a car save made now goes to the phone page (rather than the service's engine, or nowhere). */
  fun savesGoToPage(): Boolean = saveRoute() == CarRoute.To.PAGE
  private fun saveRoute(): CarRoute.To {
    val service = catalogSink != null && catalogReady && runCatching { serviceSaves() }.getOrDefault(false)
    return CarRoute.saveTarget(sink != null, pageAnswering, pageVisible, runCatching { pageRunning() }.getOrDefault(false), service)
  }
  fun clearCommandSink(s: (JSONObject) -> Unit) {
    if (sink !== s) return
    sink = null
    pageRunning = { true }
    // CAR-CATALOG-SERVICE-001: only what the page held is lost with it; the service engine's searches carry on.
    failPending("page", "Open jPlay on your phone to search the catalogue")
  }
  fun hasPage(): Boolean = sink != null

  /**
   * CAR-CATALOG-SERVICE-001: the service-owned catalogue engine ([CatalogEngine]). Its sink is set as
   * soon as the engine starts; it answers only once its page reports its handlers installed.
   */
  @Volatile private var catalogSink: ((JSONObject) -> Unit)? = null
  @Volatile var catalogReady: Boolean = false; private set

  fun setCatalogSink(s: (JSONObject) -> Unit) { catalogSink = s; catalogReady = false }
  fun markCatalogReady(s: (JSONObject) -> Unit) {
    if (catalogSink !== s) return
    catalogReady = true
    main.post { synchronized(catalogLock) { pendingSearches.keys.toList() }.forEach(::dispatchCatalogSearch) }
    // CAR-SAVE-HIDDEN-001: the service engine takes what the car pressed while nothing could save it.
    main.post { CarFeedback.flush() }
  }
  fun clearCatalogSink(s: (JSONObject) -> Unit) {
    if (catalogSink !== s) return
    catalogSink = null
    catalogReady = false
    failPending("catalog", "The music catalogue stopped")
  }
  /** For tests: stand in for the service engine's page, and put the real one back with what this returns. */
  internal fun swapCatalogSinkForTests(s: ((JSONObject) -> Unit)?, ready: Boolean): Pair<((JSONObject) -> Unit)?, Boolean> {
    val old = catalogSink to catalogReady
    catalogSink = s; catalogReady = ready
    return old
  }

  /** Car Identify can be answered now: by the service engine, or by a page that is answering. */
  /** ARTIST-FAV-CAR-001: hands a command to the service's own engine page; false when it is not ready. */
  fun toServiceEngine(cmd: JSONObject): Boolean {
    val s = catalogSink?.takeIf { catalogReady } ?: return false
    return runCatching { s(cmd) }.isSuccess
  }
  fun canIdentify(): Boolean = (catalogSink != null && catalogReady) || (sink != null && pageAnswering)

  /** Fail the searches sent through [via], and the unsent ones nothing is left to answer. */
  private fun failPending(via: String, message: String) {
    synchronized(catalogLock) {
      val lost = pendingSearches.filter { (_, p) -> p.via == via || (!p.sent && sink == null && catalogSink == null) }
      lost.keys.forEach { pendingSearches.remove(it) }
      lost.values.forEach { it.future.setException(IllegalStateException(message)) }
    }
  }

  /** A reply from the service catalogue engine: only search and Identify answers, never playback
   *  state or library, which the phone page and the native engine own. */
  fun applyCatalog(json: JSONObject) {
    json.optJSONObject("search")?.let { acceptCatalogReply(it) }
    json.optJSONObject("identify")?.let { acceptIdentifyReply(it) }
    json.optJSONObject("similar")?.let { acceptSimilarReply(it) }
    json.optJSONObject("mood")?.let { acceptMoodReply(it) }
    json.optJSONObject("starArtists")?.let { acceptArtistsReply(it) }
  }

  /** A native surface (lock screen, Bluetooth, car) asked for something; hand it to the page. */
  fun command(cmd: JSONObject) { sink?.invoke(cmd) }

  fun addListener(l: () -> Unit) { listeners.add(l) }
  fun removeListener(l: () -> Unit) { listeners.remove(l) }

  /** Replace the snapshot from a page push and wake the session on the main thread. */
  fun apply(json: JSONObject) {
    val firstAnswer = !pageAnswering
    pageAnswering = true
    json.optJSONObject("state")?.let { state = parseState(it) }
    json.optJSONObject("library")?.let { lib ->
      lib.optJSONArray("songs")?.let { songs = parseSongs(it) }
      lib.optJSONArray("playlists")?.let { playlists = parseFolders(it) }
      recordLibrary(lib)
    }
    // NATIVE-COLD-STATE-001: the original Tracks of the library's songs, for the service engine's bootstrap.
    json.optJSONArray("rememberTracks")?.let { runCatching { NativeLibraryState.rememberTracks(it) } }
    json.optJSONObject("search")?.let { acceptCatalogReply(it) }
    json.optJSONObject("identify")?.let { acceptIdentifyReply(it) }
    json.optJSONObject("similar")?.let { acceptSimilarReply(it) }
    json.optJSONObject("starArtists")?.let { acceptArtistsReply(it) }
    // CAR-ACTIONS-001: judgements made in the car while no page could answer go to it now that it
    // can, once it holds a library to find their songs in.
    if (firstAnswer) carFeedbackDelivered = false
    if (!carFeedbackDelivered && sink != null && (songs.isNotEmpty() || playlists.isNotEmpty() || state.queue.isNotEmpty())) {
      carFeedbackDelivered = true
      CarFeedback.flush()
    }
    CarFeedback.pageConfirmed(state)
    // Android Auto may request a search before the phone page has loaded its JS entry point.
    // Dispatch only after the first page snapshot, and still after the native keyboard debounce.
    if (firstAnswer) main.post {
      synchronized(catalogLock) { pendingSearches.keys.toList() }.forEach(::dispatchCatalogSearch)
    }
    notifyListeners()
  }
  @Volatile private var carFeedbackDelivered = false

  /** NATIVE-COLD-STATE-001: the library as the page last pushed it, saved only when it changed. */
  @Volatile private var recordedLibrary: Int? = null
  private fun recordLibrary(lib: JSONObject) {
    val sig = runCatching { lib.toString().hashCode() }.getOrNull() ?: return
    if (sig == recordedLibrary) return
    if (runCatching { NativeLibraryState.recordLibrary(lib) }.getOrDefault(false)) recordedLibrary = sig
  }

  /**
   * NATIVE-COLD-STATE-001: a cold start (no page has pushed anything) shows the saved queue and
   * playlists in the car. Browse only: nothing plays from this.
   */
  fun restoreLibrary(): Boolean {
    if (pageAnswering || songs.isNotEmpty() || playlists.isNotEmpty()) return false
    val lib = NativeLibraryState.library() ?: return false
    lib.optJSONArray("songs")?.let { songs = parseSongs(it) }
    lib.optJSONArray("playlists")?.let { playlists = parseFolders(it) }
    notifyListeners()
    return songs.isNotEmpty() || playlists.isNotEmpty()
  }

  /** SERVICE-API-001: complete files the service engine's queue cache holds, by song id (bounded, newest last). */
  private val sourceOverrides = LinkedHashMap<String, String>()

  /** [s] with the file the service engine holds for it, if it holds one. */
  fun sourced(s: Song): Song {
    val url = synchronized(catalogLock) { sourceOverrides[s.id] } ?: return s
    return if (s.ready && s.source == url) s else s.copy(ready = true, source = url)
  }

  /**
   * SERVICE-API-001: `{id, key, ready, source}` patches from the service engine. Only songs this hub
   * knows under that id (and whose track key matches), and only allowed download links, are taken;
   * `ready: false` withdraws a file. Returns how many songs changed. Never plays anything.
   */
  fun applySourceUpdates(a: JSONArray): Int {
    var changed = 0
    for (i in 0 until minOf(a.length(), 200)) {
      val u = a.optJSONObject(i) ?: continue
      val id = u.optStringOrNull("id")?.takeIf { it.length <= 2048 } ?: continue
      val key = u.optStringOrNull("key") ?: continue
      val song = knownSong(id) ?: continue
      if (trackKeyOf(id, song) != key) continue
      val url = u.optStringOrNull("source")?.takeIf { u.optBoolean("ready", false) && it.length <= 2048 && Downloads.urlAllowed(it) }
      synchronized(catalogLock) {
        if (url == null) { if (sourceOverrides.remove(song.id) != null) changed++ }
        else {
          if (sourceOverrides.remove(song.id) != url) changed++
          sourceOverrides[song.id] = url
          while (sourceOverrides.size > 500) sourceOverrides.remove(sourceOverrides.keys.first())
        }
      }
    }
    return changed
  }

  /** The song a car media id names: a plain/album id, or a playlist-scoped one. */
  private fun knownSong(id: String): Song? {
    findSong(id)?.let { return it }
    val m = Regex("^playlist/([^/]+)/track/([^/]+)$").matchEntire(id) ?: return null
    val key = android.net.Uri.decode(m.groupValues[2])
    return playlist(android.net.Uri.decode(m.groupValues[1]))?.songs?.firstOrNull { it.id == key }
  }

  /** The original track key behind a car media id: an album song's id names it after `/track/`. */
  private fun trackKeyOf(id: String, song: Song): String =
    if (song.id.startsWith("calbum/")) android.net.Uri.decode(song.id.substringAfterLast("/track/")) else song.id

  /**
   * CAR-SKIP-001 / SERVICE-API-001: the list a car-search song was offered in, and where it sits: the
   * album for an album song, else the newest search answer (or Identify) that holds it.
   */
  fun catalogListAround(id: String): Pair<List<Song>, Int>? = synchronized(catalogLock) {
    if (id.startsWith("calbum/")) {
      val a = catalogAlbums.values.lastOrNull { f -> f.songs.any { it.id == id } } ?: return null
      return a.songs to a.songs.indexOfFirst { it.id == id }
    }
    val r = catalogResults.values.lastOrNull { c -> c.songs.any { it.id == id } }
    if (r != null) return r.songs to r.songs.indexOfFirst { it.id == id }
    val at = identified.indexOfFirst { it.id == id }
    if (at >= 0) identified to at else null
  }

  /** The legacy play/pause bridge (`playbackState`) carries only the flag and title; merge them into
   *  the existing snapshot so the richer queue/library a `media()` push set are not thrown away. */
  fun setPlaying(playing: Boolean, title: String) {
    val cur = state
    state = cur.copy(
      playing = playing,
      title = if (title.isNotBlank()) title else cur.title,
      hasTrack = cur.hasTrack || playing,
      reportedAt = android.os.SystemClock.elapsedRealtime(),
    )
    notifyListeners()
  }

  private fun notifyListeners() {
    val snapshot = listeners.toList()
    main.post { snapshot.forEach { runCatching { it() } } }
  }

  fun findSong(id: String): Song? = (
    state.queue.firstOrNull { it.id == id }
      ?: songs.firstOrNull { it.id == id }
      ?: playlists.firstNotNullOfOrNull { f -> f.songs.firstOrNull { it.id == id } }
      ?: synchronized(catalogLock) {
        catalogResults.values.flatMap { it.songs }.firstOrNull { it.id == id }
          ?: catalogAlbums.values.firstNotNullOfOrNull { a -> a.songs.firstOrNull { it.id == id } }
          ?: identified.firstOrNull { it.id == id }
          ?: similarFound.firstOrNull { it.id == id }
      }
      ?: radioSong?.takeIf { it.id == id }
    )?.let(::sourced)

  fun playlist(id: String): Folder? =
    if (id == PHONE_LIST) Folder(PHONE_LIST, "On this phone", phoneSongs()) else playlists.firstOrNull { it.id == id }

  /**
   * CAR-LOCAL-001: every song whose complete recording is held on the phone (the page sends a song's
   * file link only while it is), once each: the queue first, then the playlists in their order.
   */
  fun phoneSongs(): List<Song> =
    (state.queue + songs + playlists.flatMap { it.songs }).filter { it.ready && !it.source.isNullOrEmpty() }.distinctBy { it.id }

  /**
   * CAR-RADIO-CONTROLS-001: the song identified on the radio now (by fingerprint or catalogue match),
   * and its own Track as the page knows it; null for a programme or an unmatched title. The car's
   * star and playlist pick act on it, and the Track travels with them so the page can learn it.
   */
  @Volatile var radioSong: Song? = null; private set
  @Volatile var radioTrack: JSONObject? = null; private set
  fun setRadioSong(song: Song?, track: JSONObject?) {
    radioSong = song
    radioTrack = track?.takeIf { song != null && it.optString("key") == song.id }
  }

  /** CAR-CONTROLS-001: show a song added from the car in that playlist now; the page's next push confirms it. */
  fun addToPlaylistNow(listId: String, songId: String) {
    val song = findSong(songId) ?: return
    var changed = false
    // CAR-HEART-ALWAYS-001: the car's own first playlist shows in the car at once, under the name it will have.
    val starting = listId == CarPickList.NEW_LIST && playlists.none { it.id == listId || (!it.album && it.title == CarPickList.NEW_LIST_NAME) }
    if (starting) { playlists = playlists + Folder(listId, CarPickList.NEW_LIST_NAME, listOf(song)); changed = true }
    else playlists = playlists.map { f ->
      val target = f.id == listId || (listId == CarPickList.NEW_LIST && !f.album && f.title == CarPickList.NEW_LIST_NAME)
      if (!target || f.album || f.songs.any { it.id == songId }) f
      else { changed = true; f.copy(songs = f.songs + song) }
    }
    if (!changed) return
    // CAR-SAVE-HIDDEN-001: and in the saved library the car reads on a cold start, without waiting for the phone app.
    runCatching {
      val saved = playlists.firstOrNull { it.songs.any { s -> s.id == songId } && (it.id == listId || (listId == CarPickList.NEW_LIST && it.title == CarPickList.NEW_LIST_NAME)) }
      if (saved != null) NativeLibraryState.addToPlaylist(saved.id, NativeStateCodec.songJson(song), if (starting) CarPickList.NEW_LIST_NAME else null)
    }
    notifyListeners()
  }

  /** ALBUM-SAVE-001: saved albums, listed under Albums in the car; the rest are playlists. */
  /** CAR-LOCAL-001: the car's "On this phone" list (a list id no saved playlist can have). */
  const val PHONE_LIST = "airwave:on-this-phone"

  fun savedAlbums(): List<Folder> = playlists.filter { it.album }
  fun savedLists(): List<Folder> = playlists.filter { !it.album }

  /** ALBUM-CAR-001: an album a car search opened (its songs carry `calbum/<album>/track/<song>` ids). */
  fun catalogAlbum(id: String): Folder? = synchronized(catalogLock) { catalogAlbums[id] }

  /** The words name this album: its title holds them all, or they hold its whole title. */
  private fun namesAlbum(query: String, album: Folder): Boolean {
    val q = normalizeText(query)
    val t = normalizeText(album.title)
    if (q.length < 3 || t.length < 3) return false
    return q.contains(t) || t.startsWith(q) || normalizeText("${album.artist ?: ""} ${album.title}").contains(q)
  }

  /**
   * The albums a car search shows, above its songs: the saved albums the words name, then the albums
   * the page found for them.
   */
  fun albumsFor(rawQuery: String, album: Boolean = false, mode: CarSearchType = CarSearchType.ALL): List<Folder> {
    val query = rawQuery.trim().take(200)
    if (query.isBlank()) return emptyList()
    val found = synchronized(catalogLock) {
      catalogResults[catalogKey(query, album, mode.key)]?.albums ?: catalogResults[catalogKey(query, album)]?.albums ?: catalogResults[catalogKey(query, false)]?.albums
    }.orEmpty()
    return (savedAlbums().filter { namesAlbum(query, it) } + found).distinctBy { it.id }
  }

  /**
   * The song a voice request plays when it asked for an album, or its words name one: the first song of
   * a saved album (`playlist/<id>/track/<song>`), else the first song of the album the page found.
   * Null when the request is for a song.
   */
  fun albumToPlay(rawQuery: String, album: Boolean): String? {
    val query = rawQuery.trim().take(200)
    savedAlbums().firstOrNull { namesAlbum(query, it) && it.songs.isNotEmpty() }?.let { a ->
      return "playlist/${android.net.Uri.encode(a.id)}/track/${android.net.Uri.encode(a.songs.first().id)}"
    }
    return synchronized(catalogLock) { catalogResults[catalogKey(query, album)]?.play }
  }

  private fun catalogKey(query: String, album: Boolean, mode: String = "all") =
    normalizeText(query) + (if (album) "\u0000album" else "") + (if (mode != "all") "\u0000$mode" else "")

  private fun normalizeText(text: String): String = Normalizer.normalize(text, Normalizer.Form.NFD)
    .replace(Regex("\\p{M}+"), "").lowercase(Locale.ROOT).trim().replace(Regex("\\s+"), " ")

  /** Search queue + playlist-only tracks, matching all words regardless of title/artist order. */
  fun search(query: String): List<Song> {
    val terms = normalizeText(query).split(' ').filter { it.isNotEmpty() }
    if (terms.isEmpty()) return emptyList()
    val pool = (songs + state.queue + playlists.flatMap { it.songs }).distinctBy { it.id }
    return pool.filter { song ->
      val listNames = playlists.filter { list -> list.songs.any { it.id == song.id } }.joinToString(" ") { it.title }
      val text = normalizeText("${song.title} ${song.artist} ${song.album ?: ""} $listNames")
      terms.all { text.contains(it) }
    }
  }

  private data class CatalogResult(val songs: List<Song>, val at: Long, val albums: List<Folder> = emptyList(), val play: String? = null)
  /** ALBUM-CAR-001: albums opened by recent car searches, by album id, newest last (bounded). */
  private val catalogAlbums = LinkedHashMap<String, Folder>()
  private data class PendingSearch(
    val query: String,
    val key: String,
    val future: SettableFuture<List<Song>>,
    val command: JSONObject,
    val readyAt: Long,
    val waitForPage: Boolean,
    val mode: String,
    val album: Boolean,
    var sent: Boolean = false,
    /** "page" or "catalog": which sink this request went to once sent. */
    var via: String? = null,
  )
  private val catalogLock = Any()
  private val catalogResults = LinkedHashMap<String, CatalogResult>()
  private data class CatalogFailure(val error: Throwable, val at: Long)
  private val catalogFailures = LinkedHashMap<String, CatalogFailure>()
  val catalogSearchPending: Boolean get() = synchronized(catalogLock) { pendingSearches.isNotEmpty() }
  private val pendingSearches = LinkedHashMap<String, PendingSearch>()

  /** Native timer instead of a hidden WebView timer: Android Auto sends each typed prefix. */
  private fun dispatchCatalogSearch(id: String) {
    val (pending, target) = synchronized(catalogLock) {
      val p = pendingSearches[id] ?: return
      if (p.sent || android.os.SystemClock.elapsedRealtime() < p.readyAt) return
      // CAR-CATALOG-SERVICE-001: a page in front of the listener answers; otherwise the service's
      // own catalogue engine does, once ready. A page that is not answering yet is waited for only
      // when no engine exists.
      val page = sink
      val engine = catalogSink
      val pageLive = page != null && (!p.waitForPage || pageAnswering)
      val target: ((JSONObject) -> Unit)? = when {
        page != null && pageVisible && pageLive -> { p.via = "page"; page }
        engine != null -> if (catalogReady) { p.via = "catalog"; engine } else if (pageLive) { p.via = "page"; page } else return
        page != null -> if (pageLive) { p.via = "page"; page } else return
        else -> null
      }
      p.sent = true
      p to target
    }
    try {
      if (target == null) throw IllegalStateException("Open jPlay on your phone to search the catalogue")
      android.util.Log.i("AirwaveCarSearch", "request $id sent via ${pending.via}: ${pending.query}")
      target(pending.command)
    } catch (e: Exception) {
      synchronized(catalogLock) { pendingSearches.remove(id) }?.future?.setException(e)
    }
  }

  /** Local matches are immediate. New songs use the same catalogue as the phone UI, not a fake
   * empty result. Bounded requests/replies/timeouts prevent stuck car search and cross-query races.
   * This bridge still requires the Activity; service-owned cold-start acquisition remains separate. */
  fun searchCatalog(rawQuery: String, timeoutMs: Long = 24000, album: Boolean = false, mode: CarSearchType = CarSearchType.ALL, debounceMs: Long = 0): ListenableFuture<List<Song>> {
    val query = rawQuery.trim().take(200)
    if (query.isBlank()) return Futures.immediateFuture(emptyList())
    // CAR-SEARCH-TYPES-001: a lyrics search always asks the page (only it reads lyrics); another kind
    // answers from the phone's own songs only when some of them are that kind.
    val local = if (mode == CarSearchType.LYRICS) emptyList() else search(query).filter { CarSearch.matches(mode, kindsOf(it, query)) }
    // A request for an album asks the page unless a saved album already answers it (ALBUM-CAR-001).
    if (local.isNotEmpty() && (!album || savedAlbums().any { namesAlbum(query, it) })) return Futures.immediateFuture(local)
    val key = catalogKey(query, album, mode.key)
    synchronized(catalogLock) {
      val now = android.os.SystemClock.elapsedRealtime()
      catalogResults.entries.removeAll { now - it.value.at > 60000 }
      catalogResults[key]?.let { return Futures.immediateFuture(it.songs) }
      catalogFailures.entries.removeAll { now - it.value.at > 3000 }
      catalogFailures[key]?.let { return Futures.immediateFailedFuture(it.error) }
      pendingSearches.values.firstOrNull { it.key == key }?.let { return it.future }
      if (sink == null && catalogSink == null) return Futures.immediateFailedFuture(IllegalStateException("Open jPlay on your phone to search the catalogue"))
      if (debounceMs > 0) {
        // Only an unsent prefix of this same mode is obsolete. Let its car callback finish;
        // do not spend four network requests on S, Sa, Sad, Sade.
        val superseded = pendingSearches.entries.filter { (_, p) ->
          !p.sent && p.mode == mode.key && p.album == album && query.startsWith(p.query, ignoreCase = true) && query != p.query
        }.map { it.key }
        superseded.forEach { pendingSearches.remove(it)?.future?.set(emptyList()) }
      }
      if (pendingSearches.size >= 4) {
        // A slow provider may still have earlier requests in flight. Keep the final edit admissible.
        val oldest = pendingSearches.entries.first()
        pendingSearches.remove(oldest.key)
        val error = java.util.concurrent.CancellationException("Superseded by a newer search")
        catalogFailures[oldest.value.key] = CatalogFailure(error, now)
        while (catalogFailures.size > 32) catalogFailures.remove(catalogFailures.keys.first())
        oldest.value.future.setException(error)
      }
      val id = UUID.randomUUID().toString()
      val future = SettableFuture.create<List<Song>>()
      val delay = debounceMs.coerceIn(0, 1200)
      val cmd = JSONObject().put("type", "catalogSearch").put("requestId", id).put("query", query).put("album", album).put("mode", mode.key)
      pendingSearches[id] = PendingSearch(query, key, future, cmd, now + delay, delay > 0, mode.key, album)
      android.util.Log.i("AirwaveCarSearch", "request $id started")
      main.postDelayed({ synchronized(catalogLock) {
        pendingSearches.remove(id)?.let { pending ->
          val error = TimeoutException("Catalogue search timed out")
          catalogFailures[pending.key] = CatalogFailure(error, android.os.SystemClock.elapsedRealtime())
          pending.future.setException(error)
          android.util.Log.w("AirwaveCarSearch", "request $id timed out")
        }
      } }, timeoutMs.coerceIn(50, 30000))
      if (delay > 0) main.postDelayed({ dispatchCatalogSearch(id) }, delay)
      else dispatchCatalogSearch(id)
      return future
    }
  }

  /**
   * CAR-SEARCH-TYPES-001: the kinds a song is: what the page said, plus what its credits show.
   * RESULT-ARTIST-001: with the search [words], also whether they name one of its credited artists.
   */
  fun kindsOf(s: Song, words: String? = null): Set<String> = CarSearch.kindsOf(s.title, s.artist, s.album, s.kinds, words)

  /** CAR-SEARCH-TYPES-001: the songs the car's last Identify named, so tapping one plays it. */
  @Volatile var identified: List<Song> = emptyList(); private set
  private val pendingIdentify = LinkedHashMap<String, SettableFuture<List<Song>>>()

  /**
   * CAR-SEARCH-TYPES-001: ask the page to name the music in [pcm] (16 kHz mono 16-bit little-endian)
   * with the phone's own fingerprinting and Shazam lookup. Fails when no page can answer, the page
   * reports an error, or [timeoutMs] passes.
   */
  fun identify(pcm: ByteArray, timeoutMs: Long = 20000): ListenableFuture<List<Song>> {
    val page = sink?.takeIf { pageVisible && pageAnswering }
    val target = page ?: catalogSink?.takeIf { catalogReady } ?: sink
      ?: return Futures.immediateFailedFuture(IllegalStateException("Open jPlay on your phone to identify music"))
    val id = UUID.randomUUID().toString()
    val future = SettableFuture.create<List<Song>>()
    synchronized(catalogLock) { pendingIdentify[id] = future }
    main.postDelayed({
      synchronized(catalogLock) { pendingIdentify.remove(id) }?.setException(TimeoutException("Identifying the music took too long"))
    }, timeoutMs.coerceIn(50, 30000))
    try {
      target(JSONObject().put("type", "identifyAudio").put("requestId", id).put("pcm", android.util.Base64.encodeToString(pcm, android.util.Base64.NO_WRAP)))
    } catch (e: Exception) {
      synchronized(catalogLock) { pendingIdentify.remove(id) }
      future.setException(e)
    }
    return future
  }

  /** CAR-SIMILAR-001: what one press of the car's Find similar button added, or why nothing was. */
  data class SimilarAnswer(val added: Int, val minimum: Int, val reason: String, val songs: List<Song>)

  /** CAR-SIMILAR-001: the songs Find similar added from the car, so the queue can find and play them. */
  @Volatile var similarFound: List<Song> = emptyList(); private set
  private val pendingSimilar = LinkedHashMap<String, SettableFuture<SimilarAnswer>>()

  /**
   * CAR-SIMILAR-001 (owner, 2026-11-18): ask the engine page to run the phone's audio-verified sound
   * match (SIMILAR-SOUND-001) for car song [id]. The page in front answers when there is one, else the
   * service's own engine; the songs it adds are at the end of the now playing list, as on the phone.
   */
  fun findSimilar(id: String, timeoutMs: Long = 200000): ListenableFuture<SimilarAnswer> {
    // CAR-ACTIONS-EVERY-TIME-001 (owner, 2026-11-25): "ensure the find similar songs button and favorite artist work
    // everytime on android auto". A press while the service's engine was still starting failed at once ("Open jPlay"),
    // and one sent to a page that then went to the background waited out the whole timeout. Now the press waits for a
    // surface that can answer, and one the hidden page has not answered moves to the service's engine.
    if (sink == null && catalogSink == null) return Futures.immediateFailedFuture(IllegalStateException("Open jPlay on your phone to find similar songs"))
    val requestId = UUID.randomUUID().toString()
    val future = SettableFuture.create<SimilarAnswer>()
    synchronized(catalogLock) { pendingSimilar[requestId] = future }
    main.postDelayed({
      synchronized(catalogLock) { reroutable.remove(requestId) }
      synchronized(catalogLock) { pendingSimilar.remove(requestId) }?.setException(TimeoutException("Finding similar songs took too long"))
    }, timeoutMs.coerceIn(50, 300000))
    sendWhenAnswerable(requestId, JSONObject().put("type", "findSimilar").put("requestId", requestId).put("id", id), ANSWER_WAIT_MS) { why ->
      synchronized(catalogLock) { pendingSimilar.remove(requestId) }?.setException(IllegalStateException(why ?: "Open jPlay on your phone to find similar songs"))
    }
    return future
  }

  /** CAR-ACTIONS-EVERY-TIME-001: how long a car press waits for the page or the service's engine to be able to answer. */
  internal const val ANSWER_WAIT_MS = 25_000L
  /** CAR-ACTIONS-EVERY-TIME-001: a car press in flight: what was sent, and to which surface. */
  private class Reroute(val cmd: JSONObject, @Volatile var via: String)
  private val reroutable = LinkedHashMap<String, Reroute>()
  /** The surface that can answer a car press now: the page in front when it answers, else the service's engine. */
  private fun answerer(): Pair<(JSONObject) -> Unit, String>? =
    sink?.takeIf { pageVisible && pageAnswering }?.let { it to "page" } ?: catalogSink?.takeIf { catalogReady }?.let { it to "catalog" }

  private fun sendWhenAnswerable(requestId: String, cmd: JSONObject, waitMs: Long, gaveUp: (String?) -> Unit) {
    synchronized(catalogLock) {
      reroutable[requestId] = Reroute(cmd, "")
      while (reroutable.size > 32) reroutable.remove(reroutable.keys.first())
    }
    val until = System.nanoTime() + java.util.concurrent.TimeUnit.MILLISECONDS.toNanos(waitMs)
    fun attempt() {
      if (synchronized(catalogLock) { !reroutable.containsKey(requestId) }) return // answered or timed out meanwhile
      val found = answerer()
      if (found == null) {
        if (System.nanoTime() < until) main.postDelayed({ attempt() }, 250)
        else { synchronized(catalogLock) { reroutable.remove(requestId) }; gaveUp(null) }
        return
      }
      synchronized(catalogLock) { reroutable[requestId]?.via = found.second }
      try { found.first(cmd) } catch (e: Exception) { synchronized(catalogLock) { reroutable.remove(requestId) }; gaveUp(e.message) }
    }
    if (Looper.myLooper() == Looper.getMainLooper()) attempt() else main.post { attempt() }
  }

  /** CAR-ACTIONS-EVERY-TIME-001: presses the page took and has not answered since it went to the background. */
  private fun rerouteHidden() {
    if (pageVisible) return
    val engine = catalogSink?.takeIf { catalogReady } ?: return
    val moved = synchronized(catalogLock) { reroutable.values.filter { it.via == "page" && it.cmd.optString("type") == "starArtists" }.onEach { it.via = "catalog" }.map { it.cmd } }
    moved.forEach { runCatching { engine(it) } }
  }

  /** ARTIST-FAV-CAR-001: the artists a press actually starred, as the page or the engine saved them. */
  data class ArtistAnswer(val names: List<String>, val saved: Boolean)
  private val pendingArtists = LinkedHashMap<String, SettableFuture<ArtistAnswer>>()

  /**
   * CAR-ANSWERABLE-001 (owner, 2026-11-23): "sometimes the ... heart artist buttons don't work". The
   * star used to be handed to the page whether or not it could answer, and the driver was told it was
   * saved either way. Now only a surface that can answer is asked, and it says when it has saved; the
   * caller tells the driver the truth. No surface at all: the caller keeps it for the app (CarFeedback).
   */
  fun starArtists(id: String, credit: String, track: JSONObject?, timeoutMs: Long = 30000, keep: (() -> Unit)? = null): ListenableFuture<ArtistAnswer>? {
    // CAR-ACTIONS-EVERY-TIME-001: wait for a surface while one starts instead of dropping the press; a press nothing
    // could take within the wait is kept for the app (keep) and the caller says so.
    if (sink == null && catalogSink == null) return null
    val requestId = UUID.randomUUID().toString()
    val future = SettableFuture.create<ArtistAnswer>()
    synchronized(catalogLock) { pendingArtists[requestId] = future }
    main.postDelayed({
      synchronized(catalogLock) { reroutable.remove(requestId) }
      synchronized(catalogLock) { pendingArtists.remove(requestId) }?.setException(TimeoutException("Starring the artist took too long"))
    }, timeoutMs.coerceIn(50, 60000))
    val cmd = JSONObject().put("type", "starArtists").put("requestId", requestId).put("id", id).put("artist", credit)
    if (track != null) cmd.put("track", track)
    sendWhenAnswerable(requestId, cmd, minOf(ANSWER_WAIT_MS, timeoutMs.coerceIn(50, 60000) - 2000).coerceAtLeast(50)) { why ->
      keep?.invoke()
      synchronized(catalogLock) { pendingArtists.remove(requestId) }?.setException(IllegalStateException(why ?: "Kept for when jPlay opens"))
    }
    return future
  }

  private fun acceptArtistsReply(reply: JSONObject) {
    val future = synchronized(catalogLock) { reroutable.remove(reply.optString("requestId")); pendingArtists.remove(reply.optString("requestId")) } ?: return
    val error = reply.optString("error")
    if (error.isNotBlank()) { future.setException(IllegalStateException(error.take(200))); return }
    val names = reply.optJSONArray("names")
    future.set(ArtistAnswer((0 until (names?.length() ?: 0)).mapNotNull { names!!.optString(it).takeIf { s -> s.isNotBlank() } }.take(6), true))
  }

  /** CAR-MOOD-001: the engine's order for the car's movable songs, and the moods leading it. */
  data class MoodAnswer(val order: List<String>, val changed: Boolean, val leading: List<String>)
  private val pendingMood = LinkedHashMap<String, SettableFuture<MoodAnswer>>()

  /**
   * CAR-MOOD-001 (owner, 2026-11-19): ask the service's engine page for the listening-mood order of
   * the car's movable songs [upcoming], after the press [signal] (kind like/dislike/similar/complete/
   * skip on song id). Only the service page is asked: with the phone app open its own queue follows
   * the mood and is the car's queue.
   */
  fun moodOrder(current: String?, upcoming: List<String>, signal: Pair<String, String>?, timeoutMs: Long = 30000): ListenableFuture<MoodAnswer> {
    val target = catalogSink?.takeIf { catalogReady && !(pageVisible && pageAnswering) }
      ?: return Futures.immediateFailedFuture(IllegalStateException("No engine to arrange the queue"))
    val requestId = UUID.randomUUID().toString()
    val future = SettableFuture.create<MoodAnswer>()
    synchronized(catalogLock) { pendingMood[requestId] = future }
    main.postDelayed({
      synchronized(catalogLock) { pendingMood.remove(requestId) }?.setException(TimeoutException("Arranging the queue took too long"))
    }, timeoutMs.coerceIn(50, 60000))
    try {
      val cmd = JSONObject().put("type", "moodOrder").put("requestId", requestId)
        .put("current", current ?: JSONObject.NULL).put("upcoming", JSONArray(upcoming.take(500)))
      signal?.let { (id, kind) -> cmd.put("signal", JSONObject().put("id", id).put("kind", kind)) }
      target(cmd)
    } catch (e: Exception) {
      synchronized(catalogLock) { pendingMood.remove(requestId) }
      future.setException(e)
    }
    return future
  }

  private fun acceptMoodReply(reply: JSONObject) {
    val future = synchronized(catalogLock) { pendingMood.remove(reply.optString("requestId")) } ?: return
    val error = reply.optString("error")
    if (error.isNotBlank()) { future.setException(IllegalStateException(error.take(200))); return }
    fun strings(a: JSONArray?) = (0 until (a?.length() ?: 0)).mapNotNull { a!!.optString(it).takeIf { s -> s.isNotBlank() } }
    future.set(MoodAnswer(strings(reply.optJSONArray("order")).take(500), reply.optBoolean("changed"), strings(reply.optJSONArray("leading")).take(3)))
  }

  private fun acceptSimilarReply(reply: JSONObject) {
    val future = synchronized(catalogLock) { reroutable.remove(reply.optString("requestId")); pendingSimilar.remove(reply.optString("requestId")) } ?: return
    val error = reply.optString("error")
    if (error.isNotBlank()) { future.setException(IllegalStateException(error.take(200))); return }
    val songs = parseSongs(reply.optJSONArray("songs") ?: JSONArray()).distinctBy { it.id }.take(10)
    if (songs.isNotEmpty()) similarFound = (songs + similarFound).distinctBy { it.id }.take(50)
    future.set(SimilarAnswer(reply.optInt("added", songs.size), reply.optInt("minimum", 0), reply.optString("reason").take(200), songs))
  }

  private fun acceptIdentifyReply(reply: JSONObject) {
    val future = synchronized(catalogLock) { pendingIdentify.remove(reply.optString("requestId")) } ?: return
    val error = reply.optString("error")
    if (error.isNotBlank()) { future.setException(IllegalStateException(error.take(200))); return }
    val songs = parseSongs(reply.optJSONArray("songs") ?: JSONArray()).distinctBy { it.id }.take(10)
    if (songs.isNotEmpty()) identified = songs
    future.set(songs)
  }

  private fun acceptCatalogReply(reply: JSONObject) {
    synchronized(catalogLock) {
      val id = reply.optString("requestId")
      val pending = pendingSearches[id] ?: return
      if (reply.optString("query") != pending.query) return
      pendingSearches.remove(id)
      if (!reply.optString("error").isNullOrBlank()) {
        val error = IllegalStateException(reply.optString("error").take(200))
        catalogFailures[pending.key] = CatalogFailure(error, android.os.SystemClock.elapsedRealtime())
        while (catalogFailures.size > 8) catalogFailures.remove(catalogFailures.keys.first())
        pending.future.setException(error)
        android.util.Log.w("AirwaveCarSearch", "request $id failed")
        return
      }
      val results = parseSongs(reply.optJSONArray("songs") ?: JSONArray()).distinctBy { it.id }.take(25)
      // ALBUM-CAR-001: the albums found, each opened; their songs' ids name the album they play in.
      val albums = parseFolders(reply.optJSONArray("albums") ?: JSONArray(), album = true).take(5)
        .map { a -> a.copy(songs = a.songs.filter { it.id.startsWith(albumTrackPrefix(a.id)) }.take(100)) }
        .filter { it.songs.isNotEmpty() }
      for (a in albums) { catalogAlbums.remove(a.id); catalogAlbums[a.id] = a }
      while (catalogAlbums.size > 20) catalogAlbums.remove(catalogAlbums.keys.first())
      // Only a song of an album in this answer may be played for it; a forged id plays nothing.
      val play = reply.optStringOrNull("play")?.takeIf { p -> albums.any { a -> a.songs.any { it.id == p } } }
      catalogResults[pending.key] = CatalogResult(results, android.os.SystemClock.elapsedRealtime(), albums, play)
      while (catalogResults.size > 8) catalogResults.remove(catalogResults.keys.first())
      pending.future.set(results)
      android.util.Log.i("AirwaveCarSearch", "request $id completed: ${results.size} results, ${albums.size} albums")
    }
  }

  private fun parseState(o: JSONObject): State {
    val q = parseSongs(o.optJSONArray("queue") ?: JSONArray())
    return State(
      hasTrack = o.optBoolean("hasTrack", o.has("mediaId")),
      playing = o.optBoolean("playing", false),
      mediaId = o.optStringOrNull("mediaId"),
      title = o.optString("title", "jPlay").take(200),
      artist = o.optString("artist", "").take(200),
      album = o.optStringOrNull("album")?.take(200),
      artwork = o.optStringOrNull("artwork"),
      durationMs = o.optLong("durationMs", -1).let { if (it > 0) it else C_TIME_UNSET },
      positionMs = o.optLong("positionMs", 0).coerceAtLeast(0),
      canNext = o.optBoolean("canNext", false),
      canPrev = o.optBoolean("canPrev", false),
      shuffle = o.optBoolean("shuffle", false),
      repeat = o.optInt("repeat", 0).takeIf { it == 0 || it == 1 || it == 3 || it == 4 } ?: 0,
      queue = q,
      queueIndex = o.optInt("queueIndex", 0).coerceIn(0, maxOf(0, q.size - 1)),
      reportedAt = android.os.SystemClock.elapsedRealtime(),
      liked = o.optBoolean("liked", false),
      disliked = o.optBoolean("disliked", false),
      once = o.optBoolean("once", false),
    )
  }

  /** QUEUE-HEARD-001: songs a page sent for the queue, parsed like a reply's (bounded, no repeats). */
  fun songsOf(a: JSONArray): List<Song> = parseSongs(a).distinctBy { it.id }.take(60)

  private fun parseSongs(a: JSONArray): List<Song> {
    val out = ArrayList<Song>(a.length())
    for (i in 0 until a.length()) {
      val o = a.optJSONObject(i) ?: continue
      val id = o.optStringOrNull("id") ?: continue
      out.add(
        Song(
          id = id,
          title = o.optString("title", "Song").take(200),
          artist = o.optString("artist", "").take(200),
          album = o.optStringOrNull("album")?.take(200),
          artwork = o.optStringOrNull("artwork"),
          durationMs = o.optLong("durationMs", -1).let { if (it > 0) it else C_TIME_UNSET },
          ready = o.optBoolean("ready", false),
          source = o.optStringOrNull("source")?.takeIf { o.optBoolean("ready", false) && Downloads.urlAllowed(it) },
          kinds = o.optJSONArray("kinds")?.let { k -> (0 until k.length()).mapNotNull { k.optString(it).takeIf { s -> s in CarSearch.KINDS } }.toSet() } ?: emptySet(),
          heard = o.optBoolean("heard", false),
        ),
      )
    }
    return out
  }

  /** The id prefix of an album's songs from a car search (the page's `carAlbumTrackId`). */
  fun albumTrackPrefix(albumId: String) = "calbum/${android.net.Uri.encode(albumId)}/track/"

  private fun parseFolders(a: JSONArray, album: Boolean = false): List<Folder> {
    val out = ArrayList<Folder>(a.length())
    for (i in 0 until a.length()) {
      val o = a.optJSONObject(i) ?: continue
      val id = o.optStringOrNull("id") ?: continue
      out.add(
        Folder(
          id, o.optString("title", if (album) "Album" else "Playlist").take(200), parseSongs(o.optJSONArray("songs") ?: JSONArray()),
          album = album || o.optBoolean("album", false),
          artist = o.optStringOrNull("artist")?.take(200),
          artwork = o.optStringOrNull("artwork")?.takeIf { it.startsWith("https://") || it.startsWith("http://") },
        ),
      )
    }
    return out
  }

  private fun JSONObject.optStringOrNull(key: String): String? {
    if (!has(key) || isNull(key)) return null
    val s = optString(key, "")
    return s.ifBlank { null }
  }
}
