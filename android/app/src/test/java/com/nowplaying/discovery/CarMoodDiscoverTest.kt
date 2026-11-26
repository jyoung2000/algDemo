package com.nowplaying.discovery

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CarMoodDiscoverTest {
  @Test fun rowIdCanNeverBeAQueueSongId() {
    // Queue songs of the Discover queue are media ids without '/'; the row must not look like one.
    assertTrue(CarMoodDiscover.ID.contains('/'))
  }

  @Test fun answerNamesCountAndMood() {
    assertEquals("Added 3 new songs for your mood (Chill \u00b7 R&B).", CarMoodDiscover.answerText(3, listOf("Chill", "R&B"), ""))
    assertEquals("Added 1 new song for your mood.", CarMoodDiscover.answerText(1, emptyList(), ""))
  }

  @Test fun emptyRunSaysWhy() {
    assertEquals("Daily data allowance reached.", CarMoodDiscover.answerText(0, emptyList(), "Daily data allowance reached."))
    assertTrue(CarMoodDiscover.answerText(0, emptyList(), "").startsWith("No new songs"))
  }
}
