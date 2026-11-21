package com.nowplaying.discovery

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * CAR-RESUME-001 (owner, 2026-11-20: "Android auto doesn't work on the latest version"). Measured on the
 * DHU: Android Auto asks the app to play when the car connects, and a car or Bluetooth head unit sends a
 * Play button. With nothing loaded yet Media3 asks MediaSession.Callback.onPlaybackResumption, which the
 * app never answered: the play was dropped ("autoplay failed"), and a Play button that started the
 * service killed the app 10 s later (ForegroundServiceDidNotStartInTimeException). The answer is the
 * queue the app last played, at the song and place it was on.
 */
class CarResumeTest {
  private fun song(id: String) = JSONObject().put("id", id).put("title", "T $id").put("artist", "A").put("durationMs", 200_000).put("ready", true)
  private fun saved(index: Int, positionMs: Long, vararg ids: String) = JSONObject()
    .put("queue", JSONArray().apply { ids.forEach { put(JSONObject().put("mediaId", "m-$it").put("song", song(it))) } })
    .put("index", index).put("id", ids.getOrNull(index) ?: JSONObject.NULL).put("mediaId", ids.getOrNull(index)?.let { "m-$it" } ?: JSONObject.NULL)
    .put("positionMs", positionMs).put("repeat", 0).put("shuffle", false)
    .put("order", JSONArray()).put("nextRound", JSONArray()).put("heard", JSONArray())

  @Test fun theLastQueueComesBackAtItsSongAndPlace() {
    val r = CarResume.plan(saved(1, 61_000, "a", "b", "c"), emptyList())!!
    assertEquals(listOf("m-a", "m-b", "m-c"), r.entries.map { it.first })
    assertEquals(1, r.index)
    assertEquals(61_000L, r.positionMs)
  }

  @Test fun withNoSavedQueueTheLibraryQueuePlaysFromItsStart() {
    val lib = listOf(MediaHub.Song("x", "X", "A", null, null, 1000, true), MediaHub.Song("y", "Y", "A", null, null, 1000, true))
    val r = CarResume.plan(null, lib)!!
    assertEquals(listOf("x", "y"), r.entries.map { it.first })
    assertEquals(0, r.index)
    assertEquals(0L, r.positionMs)
  }

  @Test fun aSavedQueuePointingPastItsEndStartsAtTheFirstSong() {
    val r = CarResume.plan(saved(-1, 5_000, "a", "b"), emptyList())!!
    assertEquals(0, r.index)
    assertEquals(0L, r.positionMs)
  }

  @Test fun nothingEverPlayedIsNoPlan() {
    assertNull(CarResume.plan(null, emptyList()))
    assertNull(CarResume.plan(JSONObject().put("queue", JSONArray()), emptyList()))
  }
}
