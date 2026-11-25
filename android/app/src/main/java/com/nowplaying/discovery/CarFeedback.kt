package com.nowplaying.discovery

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/**
 * CAR-ACTIONS-001: what the Android Auto player's Star and Dislike buttons say about a song, and
 * (CAR-CONTROLS-001) the playlist a song was added to from the car's picker.
 *
 * The page owns taste: a judgement goes to it as `{type:"feedback", id, kind}` and is learned exactly
 * as the app's own star / thumbs-down are. With no page able to answer (the app was swiped away and
 * the service plays alone) the judgement is kept on disk and handed over when the page next opens,
 * so a press in the car is never silently lost. Until the page confirms, the buttons show what was
 * pressed, so they answer at once.
 */
object CarFeedback {
  private const val PREFS = "airwave-car-feedback"
  private const val KEY = "pending"
  private const val MAX_PENDING = 50
  /** Marks a kept press that only the phone page can save (the service's engine already said it cannot). */
  private const val PAGE_ONLY = "pageOnly"
  val KINDS = setOf("like", "unlike", "dislike", "undislike")

  @Volatile private var prefs: SharedPreferences? = null
  /** song id -> (starred, disliked) pressed in the car and not yet confirmed by the page. */
  private val pressed = ConcurrentHashMap<String, Pair<Boolean, Boolean>>()

  fun init(ctx: Context) {
    if (prefs == null) prefs = ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
  }

  /** (starred, disliked) for [songId]: a press not yet confirmed, else what the page last said. */
  fun state(songId: String?): Pair<Boolean, Boolean> {
    if (songId == null) return false to false
    pressed[songId]?.let { return it }
    val s = MediaHub.state
    return if (s.mediaId == songId) s.liked to s.disliked else false to false
  }

  fun submit(songId: String, kind: String) {
    require(kind in KINDS) { "unknown feedback $kind" }
    val (starred, disliked) = state(songId)
    pressed[songId] = when (kind) {
      "like" -> true to false
      "unlike" -> false to disliked
      "dislike" -> false to true
      else -> starred to false
    }
    val cmd = withRadioTrack(JSONObject().put("type", "feedback").put("id", songId).put("kind", kind), songId)
    send(cmd)
  }

  /**
   * CAR-SAVE-HIDDEN-001: to whoever can save it now (the page in front, else the service's engine), else kept.
   * It used to go to the phone page whenever one existed, and a page that is not in front is frozen.
   */
  private fun send(cmd: JSONObject) {
    val target = MediaHub.saveSink()
    if (target != null) target(cmd) else enqueue(cmd)
  }

  /**
   * CAR-CONTROLS-001: the car's playlist picker adds [songId] to the listener's playlist [listId].
   * The car's own Playlists show the song at once; the page saves it (or is handed the add when it
   * next opens, exactly like a star pressed while the app was closed).
   */
  fun addToPlaylist(songId: String, listId: String) {
    MediaHub.addToPlaylistNow(listId, songId)
    val cmd = withRadioTrack(JSONObject().put("type", "playlistAdd").put("id", songId).put("list", listId), songId)
    send(cmd)
  }

  /**
   * ARTIST-FAV-CAR-001: the car's Star the artist button. The phone app answers when it is open; with it closed the
   * service's own engine saves the stars (they live in the engine's store); with neither, they wait for the app.
   */
  fun starArtists(songId: String, credit: String): com.google.common.util.concurrent.ListenableFuture<MediaHub.ArtistAnswer>? {
    // CAR-ANSWERABLE-001 (owner, 2026-11-23): ask a surface that can answer and wait for it to say it
    // saved them. With nothing listening the press is kept for the app, and the caller says so.
    val track = MediaHub.radioTrack?.takeIf { MediaHub.radioSong?.id == songId }
    val keep: () -> Unit = { enqueue(withRadioTrack(JSONObject().put("type", "starArtists").put("id", songId).put("artist", credit), songId)) }
    MediaHub.starArtists(songId, credit, track, keep = keep)?.let { return it }
    keep()
    return null
  }

  /**
   * CAR-RADIO-CONTROLS-001: a song starred on the radio is in no list the page holds, so its Track goes along.
   * CAR-SAVE-HIDDEN-001: so does the original Track of any other song the phone has told us about, because the
   * engine that saves it now may be the service's, which does not hold the phone page's lists.
   */
  private fun withRadioTrack(cmd: JSONObject, songId: String): JSONObject {
    val track = MediaHub.radioTrack?.takeIf { MediaHub.radioSong?.id == songId }
      ?: runCatching { NativeLibraryState.rawTrack(songId) }.getOrNull()
    if (track != null) cmd.put("track", track)
    return cmd
  }

  /**
   * CAR-SAVE-HIDDEN-001: the service's engine could not make this save (it cannot name the song, or its write
   * failed). Kept for the phone page, and only for it: the service is not asked the same thing again.
   */
  fun keepForPage(cmd: JSONObject) {
    val type = cmd.optString("type")
    if ((type != "feedback" && type != "playlistAdd") || cmd.optString("id").isEmpty()) return
    enqueue(cmd.put(PAGE_ONLY, true))
  }

  /** The page pushed its state; a press it now agrees with no longer needs holding. */
  fun pageConfirmed(s: MediaHub.State) {
    val id = s.mediaId ?: return
    val p = pressed[id] ?: return
    if (p.first == s.liked && p.second == s.disliked) pressed.remove(id)
  }

  /** Hand every judgement kept while nothing could save it to whoever can now, oldest first. */
  fun flush() {
    val p = prefs ?: return
    val target = MediaHub.saveSink() ?: return
    val toPage = MediaHub.savesGoToPage()
    val list = synchronized(this) {
      val raw = p.getString(KEY, null) ?: return
      val all = runCatching { JSONArray(raw) }.getOrNull() ?: run { p.edit().remove(KEY).apply(); return }
      val now = JSONArray(); val later = JSONArray()
      for (i in 0 until all.length()) all.optJSONObject(i)?.let { if (toPage || !it.optBoolean(PAGE_ONLY)) now.put(it) else later.put(it) }
      if (later.length() == 0) p.edit().remove(KEY).apply() else p.edit().putString(KEY, later.toString()).apply()
      now
    }
    for (i in 0 until list.length()) list.optJSONObject(i)?.let { it.remove(PAGE_ONLY); target(it) }
  }

  fun pendingCount(): Int = runCatching { JSONArray(prefs?.getString(KEY, null) ?: "[]").length() }.getOrDefault(0)

  private fun enqueue(cmd: JSONObject) = synchronized(this) {
    val p = prefs ?: return@synchronized
    val list = runCatching { JSONArray(p.getString(KEY, "[]")) }.getOrElse { JSONArray() }
    list.put(cmd)
    while (list.length() > MAX_PENDING) list.remove(0)
    p.edit().putString(KEY, list.toString()).apply()
  }

  /** For tests: forget presses and the on-disk queue. */
  fun resetForTests() {
    pressed.clear()
    prefs?.edit()?.remove(KEY)?.commit()
  }
}
