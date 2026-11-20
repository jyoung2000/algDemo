package com.nowplaying.discovery.engine

import android.os.Handler
import android.content.Context
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.media3.common.util.UnstableApi
import com.nowplaying.discovery.Downloads
import com.nowplaying.discovery.MediaHub
import com.nowplaying.discovery.NativeLibraryState
import com.nowplaying.discovery.NativeStateCodec
import com.nowplaying.discovery.Streams
import com.nowplaying.discovery.CarVolume
import com.nowplaying.discovery.CarSettings
import org.json.JSONObject

/**
 * Where the page (through the Activity's JavaScript bridge) meets the service's [EnginePlayer].
 * The service registers its player; the Activity registers the page. Commands from the page may
 * arrive before the service exists (the Activity starts it), so they wait, in order, until it does.
 * Everything runs on the main thread.
 *
 * Page -> engine, one JSON object per call (`AirwaveNative.engine(json)`):
 *   {op:"load", song, mediaId?, positionMs?, play, rev} the page chose this song
 *   {op:"cue", song|null}                               what the page will play after it
 *   (a song is {id, title, artist, album?, artwork?, durationMs, ready, source}; source is the
 *   download link Downloads.localFile resolves to the complete local file, sent even before the
 *   file is here so the engine can start the song when it lands)
 *   {op:"play"} {op:"pause"} {op:"seek", positionMs}
 *   {op:"settings", eq?, mix?, playThrough?, volume?}  the sound, as the page's controls set it
 *   {op:"ack", seq}                                     service-made changes the page has handled
 *   {op:"hello"}                                        the page (re)started: send everything
 * Engine -> page: `window.__awEngine(json)`, the state (see EnginePlayer.stateJson), with "event"
 * for a change the service made, and "pending" after hello.
 */
@UnstableApi
object EngineHub {
  private val main = Handler(Looper.getMainLooper())
  private var player: EnginePlayer? = null
  private val waiting = ArrayDeque<JSONObject>()
  private var page: EnginePlayer.Page? = null

  /** The last settings the page sent, re-applied to a new player (the service can be recreated). */
  private var settings = JSONObject()

  /** NATIVE-STATE-OBSERVER-001: service-side watchers of the native player's state (JSON strings). */
  private val observers = java.util.concurrent.CopyOnWriteArrayList<(String) -> Unit>()
  private var delivering = false
  private val throttle = NativeStateCodec.PositionThrottle(POSITION_SAVE_MS)

  /**
   * NATIVE-COLD-STATE-001: open the saved state and take the saved sound as the settings a new player
   * starts with. Call on the main thread before the player is created; settings the page already
   * sent in this process win over saved ones.
   */
  fun init(context: Context) {
    NativeLibraryState.init(context)
    NativeLibraryState.settings()?.let { saved -> for (k in saved.keys()) if (!settings.has(k)) settings.put(k, saved.get(k)) }
  }

  /** A copy of the settings a new player starts with (the page's, else the saved ones); main thread. */
  internal fun settingsSnapshot(): JSONObject = JSONObject(settings.toString())

  /* ---------------------------------------------------------------- VOLUME-BOOST-001 */
  private val carVolume = CarVolume.Owed()

  /** Told whenever the volume changes, from the page's slider or the car's button, so the car's Volume button reads
   *  the level actually playing (seen on the emulator: the slider set 200% and the car still said 80%). Main thread. */
  @Volatile var onCarLabels: (() -> Unit)? = null

  /** The volume the engine plays at, 0..2 (past 1 is the boost). Main thread. */
  fun volume(): Double = settings.optDouble("volume", 1.0).let { if (it.isFinite()) it.coerceIn(0.0, 2.0) else 1.0 }

  /** The car's Volume button: the next level, applied now and told to the page's slider. Main thread. */
  fun carVolumeStep(): Double {
    val next = CarVolume.next(volume())
    carVolume.carSet(next)
    mergeSettings(JSONObject().put("volume", next))
    player?.setVolume(next)
    Log.i(TAG, "car volume ${CarVolume.percent(next)}%")
    resendCarVolume()
    return next
  }

  private fun resendCarVolume() {
    val v = carVolume.value ?: return
    page?.let { if (it.live) it.command(JSONObject().put("type", "volume").put("value", v)) }
  }

  /* ---------------------------------------------------------------- CAR-SETTINGS-001
   * The car's EQ and discovery choices: applied to the engine at once, saved with the engine's settings, and told to
   * the page (which owns the stored settings). Until the page echoes a choice back, an older value it sends (a page
   * waking with yesterday's settings) is ignored, as for the car's volume. Main thread. */
  private var owedEq: String? = null
  private var owedLevel: Double? = null
  private var owedMood: Boolean? = null

  fun carEq(): String = CarSettings.presetOf(settings.optJSONObject("eq"))
  fun carLevel(): Double = settings.optDouble("adventurous", 0.5).let { if (it.isFinite()) it.coerceIn(0.0, 1.0) else 0.5 }
  fun carMood(): Boolean = settings.optBoolean("mood_queue", true)

  fun carSettings(c: CarSettings.Change) {
    val out = JSONObject()
    c.eq?.let { out.put("eq", CarSettings.eqWith(settings.optJSONObject("eq"), it)); owedEq = it }
    c.adventurous?.let { out.put("adventurous", it); owedLevel = it }
    c.mood?.let { out.put("mood_queue", it); owedMood = it }
    if (out.length() == 0) return
    mergeSettings(out)
    player?.let { applySettings(it, out) }
    Log.i(TAG, "car settings eq=${c.eq} adventurous=${c.adventurous} mood=${c.mood}")
    resendCarSettings()
  }

  private fun resendCarSettings() {
    val cmd = JSONObject().put("type", "carSettings")
    owedEq?.let { cmd.put("eq", settings.optJSONObject("eq")) }
    owedLevel?.let { cmd.put("adventurous", it) }
    owedMood?.let { cmd.put("mood", it) }
    if (cmd.length() > 1) page?.let { if (it.live) it.command(cmd) }
  }

  /** Drop what a page sends that contradicts a car choice it has not applied yet; clear a choice it echoes. */
  private fun withoutStale(cmd: JSONObject) {
    owedEq?.let { want -> if (cmd.has("eq")) { if (CarSettings.presetOf(cmd.optJSONObject("eq")) == want) owedEq = null else cmd.remove("eq") } }
    owedLevel?.let { want -> if (cmd.has("adventurous")) { if (kotlin.math.abs(cmd.optDouble("adventurous", -1.0) - want) < 1e-6) owedLevel = null else cmd.remove("adventurous") } }
    owedMood?.let { want -> if (cmd.has("mood_queue")) { if (cmd.optBoolean("mood_queue") == want) owedMood = null else cmd.remove("mood_queue") } }
  }

  fun addObserver(listener: (String) -> Unit) = main.post {
    if (listener in observers) return@post
    observers += listener
    player?.let { p -> runCatching { listener(p.snapshotForPage().toString()) } }
  }

  fun removeObserver(listener: (String) -> Unit) = main.post { observers.remove(listener) }

  /** Every native state: saved (position-only changes at most every POSITION_SAVE_MS), then told to observers. */
  private fun nativeChanged(p: EnginePlayer, json: JSONObject) {
    if (player !== p || delivering) return
    delivering = true
    try {
      saveNative(p, json)
      val s = json.toString()
      for (l in observers) runCatching { l(s) }.onFailure { Log.w(TAG, "native observer failed: ${it.javaClass.simpleName}") }
    } finally { delivering = false }
  }

  private fun saveNative(p: EnginePlayer, json: JSONObject?) {
    val v = p.queueVersion * 4 + (if (json?.optBoolean("playWhenReady") == true) 2 else 0) + (if (json?.optBoolean("waiting") == true) 1 else 0)
    if (json == null || throttle.shouldWrite(v, SystemClock.elapsedRealtime())) runCatching { NativeLibraryState.recordNativeState(p.nativeState()) }
  }

  fun attachPlayer(p: EnginePlayer) = main.post {
    player = p
    p.page = page
    if (settings.length() > 0) applySettings(p, settings)
    // NATIVE-COLD-STATE-001: a cold start (no page list yet) carries on the saved queue, paused.
    if (MediaHub.state.queue.isEmpty()) NativeLibraryState.nativeState()?.let { runCatching { p.restoreNativeState(it) } }
    p.observer = { json -> nativeChanged(p, json) }
    // CAR-QUEUE-HANDOFF-001: the first library push can precede service attachment. Replay it
    // before a pending phone load so the session gets the whole list, not only the tapped song.
    replayLibrary(p)
    while (waiting.isNotEmpty()) dispatch(p, waiting.removeFirst())
  }

  fun detachPlayer(p: EnginePlayer) = main.post {
    if (player === p) { saveNative(p, null); p.observer = null; p.page = null; player = null }
  }

  fun attachPage(pg: EnginePlayer.Page) = main.post {
    page = pg
    player?.let { p ->
      p.page = pg
      // The service can attach before the page too; libraryChanged only adopts the page's order
      // once it is live. Do not require another incidental JS library update to unlock skips.
      replayLibrary(p)
    }
  }

  private fun replayLibrary(p: EnginePlayer) {
    val s = MediaHub.state
    p.libraryChanged(s.queue, s.shuffle, s.repeat)
  }

  /** Forget [pg] if it is still the page (a newer Activity may already have attached its own). */
  fun detachPage(pg: EnginePlayer.Page) = main.post { if (page === pg) { page = null; player?.page = null } }

  /** True when the native engine is built into this app (it always is from this version). */
  const val AVAILABLE = true

  fun fromPage(json: String) {
    val cmd = runCatching { JSONObject(json) }.getOrNull() ?: return
    // FAST-PLAY-002: name these songs' files before the listener taps one. It needs no player and
    // must not queue behind one: warming a row is useful exactly while nothing is playing yet.
    // Bounded by the page (a few rows at a time) and by Streams.warm (one run, short queue).
    if (cmd.optString("op") == "warm") {
      val list = cmd.optJSONArray("sources")
      for (i in 0 until minOf(list?.length() ?: 0, 4)) {
        Streams.warm(list?.optString(i)?.takeIf { it.isNotEmpty() && it.length <= 2048 })
      }
      return
    }
    main.post {
      val p = player
      if (p == null) {
        if (cmd.optString("op") == "settings") mergeSettings(cmd) else { waiting.addLast(cmd); while (waiting.size > 32) waiting.removeFirst() }
      } else dispatch(p, cmd)
    }
  }

  /** The page pushed its list/library through MediaHub: let the player follow it. */
  fun libraryChanged() = main.post {
    val s = MediaHub.state
    player?.libraryChanged(s.queue, s.shuffle, s.repeat)
  }

  private fun dispatch(p: EnginePlayer, cmd: JSONObject) {
    when (cmd.optString("op")) {
      "radio-meta" -> p.pageRadioMetadata(
        cmd.optString("id"), cmd.optString("title"), cmd.optString("artist"), cmd.optString("artwork"),
        song = songFrom(cmd.optJSONObject("song")), track = cmd.optJSONObject("track"),
        startMs = cmd.optDouble("start", Double.NaN).takeIf { it.isFinite() && kotlin.math.abs(it) < 1e7 }?.let { (it * 1000).toLong() },
        lengthMs = cmd.optDouble("duration", Double.NaN).takeIf { it.isFinite() && it > 0 && it < 1e6 }?.let { (it * 1000).toLong() },
      )
      "radio" -> p.pageRadio(cmd.optString("id"), cmd.optString("title"), cmd.optString("station"))
      "radio-shuffle" -> p.radioShuffleChanged()
      "radio-live" -> p.radioToLive()
      "load" -> {
        val song = songFrom(cmd.optJSONObject("song")) ?: run { Log.w(TAG, "load without a usable song"); return }
        val mediaId = cmd.optString("mediaId").takeIf { it.isNotEmpty() && it.length <= 1024 && !cmd.isNull("mediaId") }
        p.pageLoad(song, mediaId, cmd.optLong("positionMs", 0), cmd.optBoolean("play", true), cmd.optInt("rev", Int.MAX_VALUE))
      }
      "cue" -> p.pageCue(songFrom(cmd.optJSONObject("song")))
      "play" -> p.pagePlay(true)
      "pause" -> p.pagePlay(false)
      "seek" -> p.pageSeek(cmd.optLong("positionMs", 0))
      "settings" -> {
        // VOLUME-BOOST-001: a page that slept through the car's Volume press sends its stale level first.
        if (cmd.has("volume") && !carVolume.pageSent(cmd.optDouble("volume", 1.0))) cmd.remove("volume")
        withoutStale(cmd)
        mergeSettings(cmd); applySettings(p, cmd)
      }
      "ack" -> p.ack(cmd.optInt("seq", 0))
      "hello" -> { page?.state(p.snapshotForPage()); p.resendRepeatToPage(); resendCarVolume(); resendCarSettings() }
      else -> Log.w(TAG, "unknown op ${cmd.optString("op").take(40)}")
    }
  }

  /**
   * QUEUE-HEARD-001: songs the service page's listening top-up found while no phone page is open, for the end of the
   * queue (EnginePlayer.appendFound ignores this while a page is open and drops songs already queued). Main thread.
   */
  fun appendFound(songs: List<MediaHub.Song>): Int = player?.appendFound(songs) ?: 0

  /** A song the page sent. Its file is trusted only through an allowed download link, and only when ready. */
  private fun songFrom(o: JSONObject?): MediaHub.Song? {
    if (o == null) return null
    val id = o.optString("id").takeIf { it.isNotEmpty() && it.length <= 512 } ?: return null
    val ready = o.optBoolean("ready", false)
    // The link may come before its file: it is only ever looked up among files the app downloaded
    // (Downloads.localFile), so a chosen song can wait on it and start when the file lands.
    val source = if (o.isNull("source")) null else o.optString("source").takeIf { it.isNotEmpty() && it.length <= 2048 && Downloads.urlAllowed(it) }
    val known = MediaHub.findSong(id)
    return MediaHub.Song(
      id = id,
      title = o.optString("title", known?.title ?: "Song").take(200),
      artist = o.optString("artist", known?.artist ?: "").take(200),
      album = (if (o.isNull("album")) null else o.optString("album").takeIf { it.isNotEmpty() })?.take(200) ?: known?.album,
      artwork = (if (o.isNull("artwork")) null else o.optString("artwork").takeIf { it.isNotEmpty() }) ?: known?.artwork,
      durationMs = o.optLong("durationMs", -1).let { if (it > 0) it else known?.durationMs ?: MediaHub.C_TIME_UNSET },
      ready = ready,
      source = source,
    )
  }

  private fun mergeSettings(cmd: JSONObject) {
    for (k in listOf("eq", "mix", "playThrough", "volume", "adventurous", "mood_queue")) if (cmd.has(k)) settings.put(k, cmd.get(k))
    NativeLibraryState.recordSettings(settings)
    if (listOf("volume", "eq", "adventurous", "mood_queue").any(cmd::has)) onCarLabels?.let { runCatching { it() } }
  }

  private fun applySettings(p: EnginePlayer, s: JSONObject) {
    Log.i(TAG, describe(s))
    if (s.has("eq")) p.setEq(EqJson.parse(s.optJSONObject("eq")))
    if (s.has("mix")) p.setMix(s.optDouble("mix", 0.0).let { if (it.isFinite()) Math.round(it).toInt() else 0 })
    if (s.has("playThrough")) p.setPlayThrough(s.optDouble("playThrough", 95.0).let { if (it.isFinite()) Math.round(it).toInt() else 95 })
    if (s.has("volume")) p.setVolume(s.optDouble("volume", 1.0).let { if (it.isFinite()) it else 1.0 })
  }

  /** One line per settings change, so a device log shows what the engine was told and when. */
  private fun describe(s: JSONObject): String = buildString {
    append("settings")
    s.optJSONObject("eq")?.let { e ->
      append(if (e.opt("on") == true) " eq=on ${e.optString("presetId")} gains=${e.optJSONArray("gains")} tone=${e.opt("toneHz")}" else " eq=off")
    }
    if (s.has("mix")) append(" mix=${s.opt("mix")}")
    if (s.has("playThrough")) append(" playThrough=${s.opt("playThrough")}")
    if (s.has("volume")) append(" volume=${s.opt("volume")}")
    if (TapOutput.frames > 0) append(" tapFrame=${TapOutput.frames}")
  }

  private const val TAG = "AirwaveEngineHub"
  private const val POSITION_SAVE_MS = 5000L
}
