package com.nowplaying.discovery

import android.os.Handler
import android.os.Looper
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CopyOnWriteArrayList

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
 *  - [songs]:   the song list, for the Android Auto browse tree and typed/voice search;
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
  )

  /** A browsable folder in the Android Auto tree: the song list, or one playlist. */
  data class Folder(val id: String, val title: String, val songs: List<Song>)

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

  fun setCommandSink(s: (JSONObject) -> Unit) { sink = s }
  fun clearCommandSink(s: (JSONObject) -> Unit) { if (sink === s) sink = null }
  fun hasPage(): Boolean = sink != null

  /** A native surface (lock screen, Bluetooth, car) asked for something; hand it to the page. */
  fun command(cmd: JSONObject) { sink?.invoke(cmd) }

  fun addListener(l: () -> Unit) { listeners.add(l) }
  fun removeListener(l: () -> Unit) { listeners.remove(l) }

  /** Replace the snapshot from a page push and wake the session on the main thread. */
  fun apply(json: JSONObject) {
    json.optJSONObject("state")?.let { state = parseState(it) }
    json.optJSONObject("library")?.let { lib ->
      lib.optJSONArray("songs")?.let { songs = parseSongs(it) }
      lib.optJSONArray("playlists")?.let { playlists = parseFolders(it) }
    }
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

  fun playlist(id: String): Folder? = playlists.firstOrNull { it.id == id }

  /** Case/diacritic-insensitive substring search over the known song list, for AA typed search. */
  fun search(query: String): List<Song> {
    val q = query.trim().lowercase()
    if (q.isEmpty()) return emptyList()
    return songs.filter { "${it.title} ${it.artist} ${it.album ?: ""}".lowercase().contains(q) }
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
        ),
      )
    }
    return out
  }

  private fun parseFolders(a: JSONArray): List<Folder> {
    val out = ArrayList<Folder>(a.length())
    for (i in 0 until a.length()) {
      val o = a.optJSONObject(i) ?: continue
      val id = o.optStringOrNull("id") ?: continue
      out.add(Folder(id, o.optString("title", "Playlist").take(200), parseSongs(o.optJSONArray("songs") ?: JSONArray())))
    }
    return out
  }

  private fun JSONObject.optStringOrNull(key: String): String? {
    if (!has(key) || isNull(key)) return null
    val s = optString(key, "")
    return s.ifBlank { null }
  }
}
