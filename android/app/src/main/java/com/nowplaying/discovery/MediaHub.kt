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
    val title: String = "Airwave Discovery",
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

  fun setCommandSink(s: (JSONObject) -> Unit) { sink = s; pageAnswering = false }
  fun clearCommandSink(s: (JSONObject) -> Unit) {
    if (sink !== s) return
    sink = null
    synchronized(catalogLock) {
      pendingSearches.values.forEach { it.future.setException(IllegalStateException("Open Airwave on your phone to search the catalogue")) }
      pendingSearches.clear()
    }
  }
  fun hasPage(): Boolean = sink != null

  /** A native surface (lock screen, Bluetooth, car) asked for something; hand it to the page. */
  fun command(cmd: JSONObject) { sink?.invoke(cmd) }

  fun addListener(l: () -> Unit) { listeners.add(l) }
  fun removeListener(l: () -> Unit) { listeners.remove(l) }

  /** Replace the snapshot from a page push and wake the session on the main thread. */
  fun apply(json: JSONObject) {
    pageAnswering = true
    json.optJSONObject("state")?.let { state = parseState(it) }
    json.optJSONObject("library")?.let { lib ->
      lib.optJSONArray("songs")?.let { songs = parseSongs(it) }
      lib.optJSONArray("playlists")?.let { playlists = parseFolders(it) }
    }
    json.optJSONObject("search")?.let { acceptCatalogReply(it) }
    notifyListeners()
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

  fun findSong(id: String): Song? =
    state.queue.firstOrNull { it.id == id }
      ?: songs.firstOrNull { it.id == id }
      ?: playlists.firstNotNullOfOrNull { f -> f.songs.firstOrNull { it.id == id } }
      ?: synchronized(catalogLock) {
        catalogResults.values.flatMap { it.songs }.firstOrNull { it.id == id }
          ?: catalogAlbums.values.firstNotNullOfOrNull { a -> a.songs.firstOrNull { it.id == id } }
      }

  fun playlist(id: String): Folder? = playlists.firstOrNull { it.id == id }

  /** ALBUM-SAVE-001: saved albums, listed under Albums in the car; the rest are playlists. */
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
  fun albumsFor(rawQuery: String, album: Boolean = false): List<Folder> {
    val query = rawQuery.trim().take(200)
    if (query.isBlank()) return emptyList()
    val found = synchronized(catalogLock) { catalogResults[catalogKey(query, album)]?.albums ?: catalogResults[catalogKey(query, false)]?.albums }.orEmpty()
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

  private fun catalogKey(query: String, album: Boolean) = normalizeText(query) + if (album) "\u0000album" else ""

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
  private data class PendingSearch(val query: String, val key: String, val future: SettableFuture<List<Song>>)
  private val catalogLock = Any()
  private val catalogResults = LinkedHashMap<String, CatalogResult>()
  private data class CatalogFailure(val error: Throwable, val at: Long)
  private val catalogFailures = LinkedHashMap<String, CatalogFailure>()
  val catalogSearchPending: Boolean get() = synchronized(catalogLock) { pendingSearches.isNotEmpty() }
  private val pendingSearches = LinkedHashMap<String, PendingSearch>()

  /** Local matches are immediate. New songs use the same catalogue as the phone UI, not a fake
   * empty result. Bounded requests/replies/timeouts prevent stuck car search and cross-query races.
   * This bridge still requires the Activity; service-owned cold-start acquisition remains separate. */
  fun searchCatalog(rawQuery: String, timeoutMs: Long = 24000, album: Boolean = false): ListenableFuture<List<Song>> {
    val query = rawQuery.trim().take(200)
    if (query.isBlank()) return Futures.immediateFuture(emptyList())
    val local = search(query)
    // A request for an album asks the page unless a saved album already answers it (ALBUM-CAR-001).
    if (local.isNotEmpty() && (!album || savedAlbums().any { namesAlbum(query, it) })) return Futures.immediateFuture(local)
    val key = catalogKey(query, album)
    synchronized(catalogLock) {
      val now = android.os.SystemClock.elapsedRealtime()
      catalogResults.entries.removeAll { now - it.value.at > 60000 }
      catalogResults[key]?.let { return Futures.immediateFuture(it.songs) }
      catalogFailures.entries.removeAll { now - it.value.at > 3000 }
      catalogFailures[key]?.let { return Futures.immediateFailedFuture(it.error) }
      pendingSearches.values.firstOrNull { it.key == key }?.let { return it.future }
      val target = sink ?: return Futures.immediateFailedFuture(IllegalStateException("Open Airwave on your phone to search the catalogue"))
      if (pendingSearches.size >= 4) {
        // Typed search emits every prefix. Admit the newest edit instead of starving the final
        // full query behind obsolete prefixes; cached cancellation also finishes legacy callbacks.
        val oldest = pendingSearches.entries.first()
        pendingSearches.remove(oldest.key)
        val error = java.util.concurrent.CancellationException("Superseded by a newer search")
        catalogFailures[oldest.value.key] = CatalogFailure(error, now)
        while (catalogFailures.size > 32) catalogFailures.remove(catalogFailures.keys.first())
        oldest.value.future.setException(error)
      }
      val id = UUID.randomUUID().toString()
      val future = SettableFuture.create<List<Song>>()
      pendingSearches[id] = PendingSearch(query, key, future)
      android.util.Log.i("AirwaveCarSearch", "request $id started")
      main.postDelayed({ synchronized(catalogLock) {
        pendingSearches.remove(id)?.let { pending ->
          val error = TimeoutException("Catalogue search timed out")
          catalogFailures[pending.key] = CatalogFailure(error, android.os.SystemClock.elapsedRealtime())
          pending.future.setException(error)
          android.util.Log.w("AirwaveCarSearch", "request $id timed out")
        }
      } }, timeoutMs.coerceIn(50, 30000))
      try { target(JSONObject().put("type", "catalogSearch").put("requestId", id).put("query", query).put("album", album)) }
      catch (e: Exception) { pendingSearches.remove(id); future.setException(e) }
      return future
    }
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
      title = o.optString("title", "Airwave Discovery").take(200),
      artist = o.optString("artist", "").take(200),
      album = o.optStringOrNull("album")?.take(200),
      artwork = o.optStringOrNull("artwork"),
      durationMs = o.optLong("durationMs", -1).let { if (it > 0) it else C_TIME_UNSET },
      positionMs = o.optLong("positionMs", 0).coerceAtLeast(0),
      canNext = o.optBoolean("canNext", false),
      canPrev = o.optBoolean("canPrev", false),
      shuffle = o.optBoolean("shuffle", false),
      repeat = o.optInt("repeat", 0).coerceIn(0, 2),
      queue = q,
      queueIndex = o.optInt("queueIndex", 0).coerceIn(0, maxOf(0, q.size - 1)),
      reportedAt = android.os.SystemClock.elapsedRealtime(),
    )
  }

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
