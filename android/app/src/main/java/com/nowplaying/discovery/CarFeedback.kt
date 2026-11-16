package com.nowplaying.discovery

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/**
 * CAR-ACTIONS-001: what the Android Auto player's Star and Dislike buttons say about a song.
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
    val cmd = JSONObject().put("type", "feedback").put("id", songId).put("kind", kind)
    if (MediaHub.hasPage() && MediaHub.pageAnswering) MediaHub.command(cmd) else enqueue(cmd)
  }

  /** The page pushed its state; a press it now agrees with no longer needs holding. */
  fun pageConfirmed(s: MediaHub.State) {
    val id = s.mediaId ?: return
    val p = pressed[id] ?: return
    if (p.first == s.liked && p.second == s.disliked) pressed.remove(id)
  }

  /** Hand every judgement kept while the app was closed to the page, oldest first. */
  fun flush() {
    val p = prefs ?: return
    val list = synchronized(this) {
      val raw = p.getString(KEY, null) ?: return
      p.edit().remove(KEY).apply()
      runCatching { JSONArray(raw) }.getOrNull() ?: return
    }
    for (i in 0 until list.length()) list.optJSONObject(i)?.let { MediaHub.command(it) }
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
