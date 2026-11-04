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
}
