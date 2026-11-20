package com.nowplaying.discovery

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/** SIMILAR-NOTICE-001: the car says how many new similar songs joined the queue. */
class CarSimilarTextTest {
  @Test fun saysHowManyWereAdded() {
    assertEquals("Added 7 new similar songs to your queue (65%+ sound match)", CarSimilarText.added(7, 65))
    assertEquals("Added 1 new similar song to your queue (70%+ sound match)", CarSimilarText.added(1, 70))
    assertEquals("Added 3 new similar songs to your queue", CarSimilarText.added(3, 0))
  }

  @Test fun eachMessageIsOneSentenceSoTheCarShowsAllOfIt() {
    // tellDriver shows only the text before the first ". ".
    for (m in listOf(CarSimilarText.added(12, 65), CarSimilarText.looking("Life Is Good (feat. Drake)"), CarSimilarText.looking("Mr. Brightside"), CarSimilarText.looking(null))) {
      assertFalse(m, m.contains(". "))
    }
    assertEquals("Finding songs like Life Is Good…", CarSimilarText.looking("Life Is Good (feat. Drake)"))
    assertEquals("Finding songs like Mr Brightside…", CarSimilarText.looking("Mr. Brightside"))
    assertEquals("Finding songs like Nights…", CarSimilarText.looking(" Nights "))
    assertEquals("Finding similar songs…", CarSimilarText.looking(""))
  }
}
