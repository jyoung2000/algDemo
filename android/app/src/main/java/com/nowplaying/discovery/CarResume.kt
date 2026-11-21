package com.nowplaying.discovery

import org.json.JSONObject

/**
 * CAR-RESUME-001: what plays when a car (Android Auto, or a Bluetooth head unit's Play button) asks the
 * app to play before anything is loaded: the queue the app last played, at its song and place, or else
 * the library's current queue from its start. Null when nothing was ever played.
 */
object CarResume {
  data class Plan(val entries: List<Pair<String, MediaHub.Song>>, val index: Int, val positionMs: Long)

  fun plan(saved: JSONObject?, libraryQueue: List<MediaHub.Song>, sourceAllowed: (String) -> Boolean = { true }): Plan? {
    val q = saved?.let { runCatching { NativeStateCodec.nativeOf(it, sourceAllowed) }.getOrNull() }
    if (q != null && q.entries.isNotEmpty()) {
      val i = q.control.index
      return if (i in q.entries.indices) Plan(q.entries, i, q.positionMs) else Plan(q.entries, 0, 0)
    }
    if (libraryQueue.isEmpty()) return null
    return Plan(libraryQueue.map { it.id to it }, 0, 0)
  }
}
