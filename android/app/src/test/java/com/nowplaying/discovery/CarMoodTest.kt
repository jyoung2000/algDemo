package com.nowplaying.discovery

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** CAR-MOOD-001: what the car's listening mood may move, and how the engine's order lands in the queue. */
class CarMoodTest {
  private val q = listOf("played", "now", "jazz1", "rap1", "jazz2", "elec1")

  @Test fun onlySongsAfterTheCurrentOneMove() {
    assertEquals(listOf("jazz1", "rap1", "jazz2", "elec1"), CarMood.movable(q, 1, shuffle = false))
  }

  @Test fun theEngineOrderFillsTheMovableSlots() {
    val out = CarMood.apply(q, 1, false, listOf("rap1", "elec1", "jazz1", "jazz2"))
    assertEquals(listOf("played", "now", "rap1", "elec1", "jazz1", "jazz2"), out)
  }

  @Test fun songsTheEngineLeftOutKeepTheirOrderAfterTheNamedOnes() {
    val out = CarMood.apply(q, 1, false, listOf("elec1", "ghost", "now"))
    assertEquals(listOf("played", "now", "elec1", "jazz1", "rap1", "jazz2"), out)
  }

  @Test fun savedListsAndAlbumsStayInOrderUnlessShuffleIsOn() {
    val list = listOf("playlist/p/track/a", "playlist/p/track/b", "playlist/p/track/c")
    assertEquals(emptyList<String>(), CarMood.movable(list, 0, shuffle = false))
    assertNull(CarMood.apply(list, 0, false, listOf("playlist/p/track/c", "playlist/p/track/b")))
    assertEquals(listOf("playlist/p/track/a", "playlist/p/track/c", "playlist/p/track/b"),
      CarMood.apply(list, 0, true, listOf("playlist/p/track/c", "playlist/p/track/b")))
  }

  @Test fun aListSongInTheDiscoverQueueKeepsItsSlotWithoutShuffle() {
    val mixed = listOf("now", "a", "calbum/x/track/t", "b")
    assertEquals(listOf("now", "b", "calbum/x/track/t", "a"), CarMood.apply(mixed, 0, false, listOf("b", "a")))
  }

  @Test fun radioNeverMovesAndAnUnchangedOrderIsNull() {
    assertEquals(emptyList<String>(), CarMood.movable(listOf("now", "radio/station/x"), 0, true))
    assertNull(CarMood.apply(q, 1, false, listOf("jazz1", "rap1", "jazz2", "elec1")))
  }
}
