package com.nowplaying.discovery

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.IOException

class CacheQuotaTest {
  private val songs = listOf(
    CacheEntry("old", 80, 1),
    CacheEntry("current", 90, 2),
    CacheEntry("next", 70, 3),
  )

  @Test fun evictsLeastRecentlyUsedButNeverTheCuedOrActiveUrl() {
    assertEquals(listOf("old"), planCacheEvictions(songs, 50, "new", 210, setOf("current", "next")))
  }

  @Test fun replacingExistingFileCountsItsOldSizeOnlyOnce() {
    assertEquals(emptyList<String>(), planCacheEvictions(songs, 60, "old", 220, emptySet()))
  }

  @Test fun shrinkingQuotaRejectsWhenAllEntriesAreProtected() {
    assertThrows(IOException::class.java) {
      planCacheEvictions(songs, 0, null, 200, setOf("old", "current", "next"))
    }
  }

  @Test fun rejectsFileLargerThanQuotaBeforeEvictingAnything() {
    assertThrows(IOException::class.java) { planCacheEvictions(songs, 201, "new", 200, emptySet()) }
  }

  @Test fun evictsOldestFirstUntilTheNewSongFits() {
    assertEquals(listOf("old", "current"), planCacheEvictions(songs, 100, "new", 170, emptySet()))
  }

  // Rolling-cache retention (ROLLING-CACHE-001): the cache follows the list being listened to.
  private val head = "s0"
  private val mid = "s1"
  private val tail = "s2"
  private val three = listOf(CacheEntry(head, 70, 1), CacheEntry(mid, 70, 2), CacheEntry(tail, 70, 3))
  private val order = mapOf(head to 0, mid to 1, tail to 2)

  @Test fun obsoleteFilesGoBeforeAnySongStillOnTheListEvenWhenTheyAreTheNewest() {
    // "left" was cached a moment ago but the listener switched lists, so it is the first to go -
    // plain LRU would have taken the song about to play instead.
    val entries = three.dropLast(1) + CacheEntry("left", 70, 99)
    assertEquals(listOf("left"), planCacheEvictions(entries, 70, "new", 210, emptySet(), mapOf(head to 0, mid to 1), false))
  }

  @Test fun amongObsoleteFilesTheLeastRecentlyUsedGoesFirstAndOnlyAsManyAsNeeded() {
    val entries = listOf(CacheEntry("leftB", 70, 9), CacheEntry("leftA", 70, 2), CacheEntry(head, 70, 5))
    assertEquals(listOf("leftA"), planCacheEvictions(entries, 70, "new", 210, emptySet(), mapOf(head to 0), false))
  }

  @Test fun aWantedSongGivesWayFromTheTailOfThePlaybackOrderBackwards() {
    // The insert plays second, so only the songs further down the list may give way, furthest first.
    assertEquals(listOf(tail), planCacheEvictions(three, 70, "s0b", 210, emptySet(), order + ("s0b" to 1), true))
  }

  @Test fun aBackgroundSongNeverDisplacesTheSongsThatPlayBeforeIt() {
    // Nothing is ranked after it, so it is refused rather than churning the songs ahead of it.
    assertThrows(IOException::class.java) {
      planCacheEvictions(three, 70, "last", 210, emptySet(), order + ("last" to 9), true)
    }
  }

  @Test fun aListLongerThanTheQuotaRollsForwardInsteadOfDeadlocking() {
    // Every cached song is still wanted. Blanket-protecting the list would make the cache
    // unfillable forever; the song furthest from playing gives way to the one playing next.
    assertEquals(listOf(tail), planCacheEvictions(three, 70, "next0", 210, emptySet(), mapOf("next0" to 0, head to 1, mid to 2, tail to 3), true))
  }

  @Test fun protectedDecksAndTheIncomingSongItselfAreNeverCandidates() {
    // head is a live deck and mid is the file being re-downloaded: only the tail is available.
    assertEquals(listOf(tail), planCacheEvictions(three, 70, mid, 140, setOf(head), order, false))
    assertThrows(IOException::class.java) {
      planCacheEvictions(three, 70, mid, 140, setOf(head, tail), order, false)
    }
  }

  @Test fun aForegroundSongMayEvictAWantedTailEvenWhenItIsNotOnTheListAtAll() {
    assertEquals(listOf(tail), planCacheEvictions(three, 70, "manual", 210, emptySet(), order, false))
  }
}
