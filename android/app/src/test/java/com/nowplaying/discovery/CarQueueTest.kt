package com.nowplaying.discovery

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** AUTO-QUEUE-001: a found single joins the front of the queue; collections replace it wholesale. */
class CarQueueTest {
  private fun plan(chosen: String, queue: List<String>) = CarQueue.planFor(chosen, queue) { it }

  @Test fun aFoundSingleJoinsTheFrontOfTheQueueInsteadOfWipingIt() {
    val plan = plan("found", listOf("q1", "q2", "q3"))!!
    assertEquals(listOf("found", "q1", "q2", "q3"), plan.items)
    assertEquals(0, plan.index)
  }

  @Test fun aSingleAlreadyInTheQueuePlaysInPlaceWithoutDuplication() {
    val plan = plan("q2", listOf("q1", "q2", "q3"))!!
    assertEquals(listOf("q1", "q2", "q3"), plan.items)
    assertEquals(1, plan.index)
  }

  @Test fun collectionsAndEmptyQueuesKeepTheSurroundingListPath() {
    assertNull("a saved playlist/album track replaces the queue", plan("playlist/p1/track/s3", listOf("q1")))
    assertNull("a car-search album song replaces the queue", plan("calbum/a1/track/t1", listOf("q1")))
    assertNull("an empty queue falls back to the surrounding list", plan("found", emptyList()))
  }

  @Test fun radioEntriesNeverMixIntoASongQueue() {
    assertNull("a station id is radio, never a queue plan", plan("radio/station/kexp", listOf("q1")))
    val plan = plan("found", listOf("radio:live-session", "q1"))!!
    assertEquals(listOf("found", "q1"), plan.items)
    assertNull("a queue holding only radio keeps the old path", CarQueue.planFor("found", listOf("radio:live-session")) { it })
  }
}
