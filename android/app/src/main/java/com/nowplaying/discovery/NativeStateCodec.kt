package com.nowplaying.discovery

import org.json.JSONArray
import org.json.JSONObject

/**
 * NATIVE-COLD-STATE-001: the pure half of [NativeLibraryState]. What the service remembers across a
 * process death so a car can cold-start with the saved library, queue and sound: the page's library
 * snapshot (`songs`, `playlists`, each song optionally carrying its original Track in `track`), the
 * native player's queue state (EnginePlayer.nativeState) and the merged audio settings (`eq`, `mix`,
 * `playThrough`, `volume`, exactly as the page sent them). Plus a bounded memory of original Tracks by
 * their exact `key`, so car feedback can name a song without reconstructing it.
 *
 * Every value is stored as `{"v":VERSION,"data":...}`. A value that does not parse, has another
 * version or breaks a bound is dropped (and removed), never half-used. Nothing here logs data.
 */
object NativeStateCodec {
  const val VERSION = 1

  const val KEY_LIBRARY = "library"
  const val KEY_NATIVE = "native"
  const val KEY_SETTINGS = "settings"
  const val KEY_TRACKS = "tracks"

  /** Upper bounds on what is kept; a larger value is refused rather than truncated. */
  const val MAX_SONGS = 5000
  const val MAX_PLAYLISTS = 500
  const val MAX_QUEUE = 5000
  const val MAX_TRACKS = 2000
  const val MAX_KEY = 1024
  /** Per stored value, in UTF-16 chars; SharedPreferences keeps everything in memory. */
  const val MAX_CHARS = 4_000_000
  const val MAX_TRACK_CHARS = 16_000

  val SETTINGS_KEYS = listOf("eq", "mix", "playThrough", "volume")

  /** Key/value storage, injectable so the store is tested on the JVM; production is SharedPreferences. */
  interface Io {
    fun get(key: String): String?
    /** null removes the key. */
    fun put(key: String, value: String?)
  }

  fun wrap(data: Any): String? =
    JSONObject().put("v", VERSION).put("data", data).toString().takeIf { it.length <= MAX_CHARS }

  /** The payload of a stored value, or null when it is missing, corrupt or of another version. */
  fun unwrap(raw: String?): Any? {
    if (raw == null || raw.length > MAX_CHARS) return null
    val o = runCatching { JSONObject(raw) }.getOrNull() ?: return null
    if (o.optInt("v", -1) != VERSION || !o.has("data")) return null
    return o.opt("data")
  }

  /** A deep copy, so neither the caller nor the store can change the other's object. */
  fun copy(o: JSONObject): JSONObject = JSONObject(o.toString())

  fun validLibrary(o: JSONObject): Boolean {
    val songs = o.opt("songs")
    val playlists = o.opt("playlists")
    if (songs == null && playlists == null) return false
    if (songs != null && (songs !is JSONArray || songs.length() > MAX_SONGS)) return false
    if (playlists != null && (playlists !is JSONArray || playlists.length() > MAX_PLAYLISTS)) return false
    return true
  }

  fun validNative(o: JSONObject): Boolean {
    val q = o.opt("queue") as? JSONArray ?: return false
    if (q.length() > MAX_QUEUE) return false
    val index = o.optInt("index", -2)
    if (index < -1 || index >= q.length()) return false
    for (i in 0 until q.length()) {
      val e = q.optJSONObject(i) ?: return false
      val song = e.optJSONObject("song") ?: return false
      val id = song.optString("id")
      if (id.isEmpty() || id.length > MAX_KEY) return false
      if (e.optString("mediaId").let { it.isEmpty() || it.length > MAX_KEY }) return false
    }
    return o.optLong("positionMs", 0) >= 0
  }

  /** Only the four settings the engine applies; anything else the page may add is not ours to keep. */
  fun cleanSettings(o: JSONObject): JSONObject? {
    val out = JSONObject()
    for (k in SETTINGS_KEYS) if (o.has(k) && !o.isNull(k)) {
      val v = o.get(k)
      when (k) {
        "eq" -> if (v is JSONObject) out.put(k, JSONObject(v.toString()))
        else -> if (v is Number && v.toDouble().isFinite()) out.put(k, v)
      }
    }
    return out.takeIf { it.length() > 0 }
  }

  /** A song under MediaHub's own field names (as the page pushes them); duration unset is -1, as the page sends. */
  fun songJson(s: MediaHub.Song): JSONObject = JSONObject()
    .put("id", s.id).put("title", s.title).put("artist", s.artist)
    .put("album", s.album ?: JSONObject.NULL).put("artwork", s.artwork ?: JSONObject.NULL)
    .put("durationMs", if (s.durationMs > 0) s.durationMs else -1)
    .put("ready", s.ready).put("source", s.source ?: JSONObject.NULL)
    .put("kinds", JSONArray(s.kinds.sorted()))

  /** The saved song back, its link kept only if [sourceAllowed] still allows it. Readiness is the saved
   *  claim; the engine re-checks the file (Downloads.localFile) before it ever plays it. */
  fun songOf(o: JSONObject, sourceAllowed: (String) -> Boolean): MediaHub.Song? {
    val id = o.optString("id").takeIf { it.isNotEmpty() && it.length <= MAX_KEY } ?: return null
    fun str(k: String) = if (!o.has(k) || o.isNull(k)) null else o.optString(k).ifBlank { null }
    val source = str("source")?.takeIf { it.length <= 2048 && runCatching { sourceAllowed(it) }.getOrDefault(false) }
    return MediaHub.Song(
      id = id,
      title = o.optString("title", "Song").take(200),
      artist = o.optString("artist", "").take(200),
      album = str("album")?.take(200),
      artwork = str("artwork"),
      durationMs = o.optLong("durationMs", -1).let { if (it > 0) it else MediaHub.C_TIME_UNSET },
      ready = o.optBoolean("ready", false) && source != null,
      source = source,
      kinds = o.optJSONArray("kinds")?.let { k -> (0 until k.length()).map { k.optString(it) }.filter { it.isNotEmpty() }.toSet() } ?: emptySet(),
    )
  }

  /** What EnginePlayer saves: its queue (mediaId + song), the round by key, and a native millisecond position. */
  data class NativeQueue(
    val entries: List<Pair<String, MediaHub.Song>>,
    val control: com.nowplaying.discovery.engine.PlayQueue.Control,
    val positionMs: Long,
  )

  fun nativeJson(q: NativeQueue): JSONObject {
    val c = q.control
    val cur = q.entries.getOrNull(c.index)
    return JSONObject()
      .put("queue", JSONArray().apply { q.entries.forEach { (m, s) -> put(JSONObject().put("mediaId", m).put("song", songJson(s))) } })
      .put("index", if (cur == null) -1 else c.index)
      .put("id", cur?.second?.id ?: JSONObject.NULL)
      .put("mediaId", cur?.first ?: JSONObject.NULL)
      .put("positionMs", q.positionMs.coerceAtLeast(0))
      .put("repeat", when (c.repeat) { com.nowplaying.discovery.engine.PlayQueue.Repeat.ONE -> 1; com.nowplaying.discovery.engine.PlayQueue.Repeat.ONCE -> 3; com.nowplaying.discovery.engine.PlayQueue.Repeat.TWICE -> 4; else -> 0 })
      .put("shuffle", c.shuffle)
      .put("order", JSONArray(c.order))
      .put("nextRound", JSONArray(c.nextRound))
      .put("heard", JSONArray(c.heard))
  }

  /** Every saved entry comes back (none is silently dropped); an invalid state as a whole is null. */
  fun nativeOf(o: JSONObject, sourceAllowed: (String) -> Boolean): NativeQueue? {
    if (!validNative(o)) return null
    val q = o.getJSONArray("queue")
    val entries = ArrayList<Pair<String, MediaHub.Song>>(q.length())
    for (i in 0 until q.length()) {
      val e = q.getJSONObject(i)
      val song = songOf(e.getJSONObject("song"), sourceAllowed) ?: return null
      entries += e.getString("mediaId") to song
    }
    fun keys(k: String) = o.optJSONArray(k)?.let { a -> (0 until minOf(a.length(), MAX_QUEUE)).map { a.optString(it) }.filter { it.isNotEmpty() } } ?: emptyList()
    val repeat = when (o.optInt("repeat", 0)) { 1 -> com.nowplaying.discovery.engine.PlayQueue.Repeat.ONE; 3 -> com.nowplaying.discovery.engine.PlayQueue.Repeat.ONCE; 4 -> com.nowplaying.discovery.engine.PlayQueue.Repeat.TWICE; else -> com.nowplaying.discovery.engine.PlayQueue.Repeat.OFF }
    val control = com.nowplaying.discovery.engine.PlayQueue.Control(
      o.optInt("index", -1), repeat, o.optBoolean("shuffle", false), keys("order"), keys("nextRound"), keys("heard"),
    )
    return NativeQueue(entries, control, o.optLong("positionMs", 0).coerceAtLeast(0))
  }

  /**
   * Position-only native updates (the ticker while playing) are written at most every [intervalMs];
   * any change of queue/control [version] is written at once. Time comes from the caller's monotonic
   * clock and is never persisted.
   */
  class PositionThrottle(private val intervalMs: Long) {
    private var lastVersion: Long = Long.MIN_VALUE
    private var lastWriteAt: Long = Long.MIN_VALUE

    fun shouldWrite(version: Long, nowMs: Long): Boolean {
      val write = version != lastVersion || lastWriteAt == Long.MIN_VALUE || nowMs - lastWriteAt >= intervalMs || nowMs < lastWriteAt
      if (write) { lastVersion = version; lastWriteAt = nowMs }
      return write
    }
  }

  /** The store over [io]. Reads are cached; every accessor returns a copy. Not thread-safe: main thread. */
  class Store(private val io: Io) {
    private var library: JSONObject? = null
    private var native: JSONObject? = null
    private var settings: JSONObject? = null
    /** Insertion order is recency: the oldest track is forgotten first. */
    private val tracks = LinkedHashMap<String, JSONObject>()
    private var loaded = false

    private fun load() {
      if (loaded) return
      loaded = true
      library = read(KEY_LIBRARY) { (it as? JSONObject)?.takeIf(::validLibrary) }
      native = read(KEY_NATIVE) { (it as? JSONObject)?.takeIf(::validNative) }
      settings = read(KEY_SETTINGS) { (it as? JSONObject)?.let(::cleanSettings) }
      read(KEY_TRACKS) { data ->
        val a = data as? JSONArray ?: return@read null
        if (a.length() > MAX_TRACKS) return@read null
        for (i in 0 until a.length()) {
          val t = a.optJSONObject(i) ?: continue
          val k = t.optString("key")
          if (k.isNotEmpty() && k.length <= MAX_KEY) tracks[k] = t
        }
        a
      }
    }

    /** Parse [key]; a corrupt or out-of-bounds value is removed so it cannot fail every start. */
    private fun <T> read(key: String, accept: (Any) -> T?): T? {
      val raw = runCatching { io.get(key) }.getOrNull() ?: return null
      val got = unwrap(raw)?.let { runCatching { accept(it) }.getOrNull() }
      if (got == null) runCatching { io.put(key, null) }
      return got
    }

    private fun write(key: String, data: Any): Boolean {
      val s = wrap(data) ?: return false
      return runCatching { io.put(key, s) }.isSuccess
    }

    fun library(): JSONObject? { load(); return library?.let(::copy) }
    fun nativeState(): JSONObject? { load(); return native?.let(::copy) }
    fun settings(): JSONObject? { load(); return settings?.let(::copy) }

    fun recordLibrary(snapshot: JSONObject): Boolean {
      load()
      val c = runCatching { copy(snapshot) }.getOrNull()?.takeIf(::validLibrary) ?: return false
      if (!write(KEY_LIBRARY, c)) return false
      library = c
      // Songs that carry their original Track are remembered under its exact key.
      c.optJSONArray("songs")?.let { a -> for (i in 0 until a.length()) a.optJSONObject(i)?.optJSONObject("track")?.let { remember(it) } }
      flushTracks()
      return true
    }

    fun recordNativeState(state: JSONObject): Boolean {
      load()
      val c = runCatching { copy(state) }.getOrNull()?.takeIf(::validNative) ?: return false
      if (!write(KEY_NATIVE, c)) return false
      native = c
      return true
    }

    /** Merges into what is saved: a later {volume} alone keeps the saved EQ, as EngineHub merges. */
    fun recordSettings(s: JSONObject): Boolean {
      load()
      val add = cleanSettings(s) ?: return false
      val merged = settings?.let(::copy) ?: JSONObject()
      for (k in add.keys()) merged.put(k, add.get(k))
      if (!write(KEY_SETTINGS, merged)) return false
      settings = merged
      return true
    }

    fun rememberTrack(track: JSONObject): Boolean {
      load()
      if (!remember(track)) return false
      flushTracks()
      return true
    }

    /** Many at once, written once; returns how many were kept. */
    fun rememberTracks(list: JSONArray): Int {
      load()
      var kept = 0
      for (i in 0 until minOf(list.length(), MAX_TRACKS)) if (list.optJSONObject(i)?.let(::remember) == true) kept++
      if (kept > 0) flushTracks()
      return kept
    }

    fun rawTrack(key: String): JSONObject? { load(); return tracks[key]?.let(::copy) }

    /** Every remembered original Track, oldest first (a copy). */
    fun tracks(): JSONArray { load(); return JSONArray().apply { tracks.values.forEach { put(copy(it)) } } }

    private fun remember(track: JSONObject): Boolean {
      val k = track.optString("key")
      if (k.isEmpty() || k.length > MAX_KEY) return false
      val s = runCatching { track.toString() }.getOrNull() ?: return false
      if (s.length > MAX_TRACK_CHARS) return false
      tracks.remove(k)
      tracks[k] = JSONObject(s)
      while (tracks.size > MAX_TRACKS) tracks.remove(tracks.keys.first())
      return true
    }

    private fun flushTracks() { write(KEY_TRACKS, JSONArray().apply { tracks.values.forEach { put(it) } }) }
  }
}
