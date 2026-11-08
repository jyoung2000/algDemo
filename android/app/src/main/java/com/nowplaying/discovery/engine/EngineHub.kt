package com.nowplaying.discovery.engine

import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.media3.common.util.UnstableApi
import com.nowplaying.discovery.Downloads
import com.nowplaying.discovery.MediaHub
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

  fun attachPlayer(p: EnginePlayer) = main.post {
    player = p
    p.page = page
    if (settings.length() > 0) applySettings(p, settings)
    while (waiting.isNotEmpty()) dispatch(p, waiting.removeFirst())
  }

  fun detachPlayer(p: EnginePlayer) = main.post { if (player === p) { p.page = null; player = null } }

  fun attachPage(pg: EnginePlayer.Page) = main.post { page = pg; player?.page = pg }

  /** Forget [pg] if it is still the page (a newer Activity may already have attached its own). */
  fun detachPage(pg: EnginePlayer.Page) = main.post { if (page === pg) { page = null; player?.page = null } }

  /** True when the native engine is built into this app (it always is from this version). */
  const val AVAILABLE = true

  fun fromPage(json: String) {
    val cmd = runCatching { JSONObject(json) }.getOrNull() ?: return
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
      "load" -> {
        val song = songFrom(cmd.optJSONObject("song")) ?: run { Log.w(TAG, "load without a usable song"); return }
        val mediaId = cmd.optString("mediaId").takeIf { it.isNotEmpty() && it.length <= 1024 && !cmd.isNull("mediaId") }
        p.pageLoad(song, mediaId, cmd.optLong("positionMs", 0), cmd.optBoolean("play", true), cmd.optInt("rev", Int.MAX_VALUE))
      }
      "cue" -> p.pageCue(songFrom(cmd.optJSONObject("song")))
      "play" -> p.pagePlay(true)
      "pause" -> p.pagePlay(false)
      "seek" -> p.pageSeek(cmd.optLong("positionMs", 0))
      "settings" -> { mergeSettings(cmd); applySettings(p, cmd) }
      "ack" -> p.ack(cmd.optInt("seq", 0))
      "hello" -> page?.state(p.snapshotForPage())
      else -> Log.w(TAG, "unknown op ${cmd.optString("op").take(40)}")
    }
  }

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
    for (k in listOf("eq", "mix", "playThrough", "volume")) if (cmd.has(k)) settings.put(k, cmd.get(k))
  }

  private fun applySettings(p: EnginePlayer, s: JSONObject) {
    if (s.has("eq")) p.setEq(EqJson.parse(s.optJSONObject("eq")))
    if (s.has("mix")) p.setMix(s.optDouble("mix", 0.0).let { if (it.isFinite()) Math.round(it).toInt() else 0 })
    if (s.has("playThrough")) p.setPlayThrough(s.optDouble("playThrough", 95.0).let { if (it.isFinite()) Math.round(it).toInt() else 95 })
    if (s.has("volume")) p.setVolume(s.optDouble("volume", 1.0).let { if (it.isFinite()) it else 1.0 })
  }

  private const val TAG = "AirwaveEngineHub"
}
