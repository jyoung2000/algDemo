package com.nowplaying.discovery

import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

class DownloadSelectionTest {
  private val a = "https://music.youtube.com/watch?v=a"
  private val far = "https://music.youtube.com/watch?v=far"

  @Test fun farWantedJobsSurviveButOmittedWantedRestoresLegacyCancellation() {
    val selection = DownloadSelection(listOf(a), listOf(a, far))
    assertTrue(selection.retains(far))
    assertTrue(selection.retains(a))
    assertFalse(selection.retains("https://music.youtube.com/watch?v=stale"))
    assertFalse(DownloadSelection(listOf(a)).retains(far))
  }

  @Test fun invalidUrlsAndOversizedListsAreRejectedNotSilentlyTruncated() {
    assertThrows(IllegalArgumentException::class.java) { DownloadSelection(listOf(a, a, a, a)) }
    assertThrows(IllegalArgumentException::class.java) { DownloadSelection(listOf(a), listOf("https://evil.example/song")) }
    assertThrows(IllegalArgumentException::class.java) { DownloadSelection(emptyList(), List(10001) { a }) }
    assertTrue(DownloadSelection(emptyList(), List(10000) { a }).retains(a))
  }

  @Test fun backgroundCannotEvictWantedButForegroundCanAndProtectedAlwaysSurvives() {
    val selection = DownloadSelection(listOf(a), listOf(far))
    val entries = listOf(CacheEntry(a, 90, 1), CacheEntry(far, 90, 2))
    // A background insert that is not itself on the list may never displace a song that is.
    assertThrows(IOException::class.java) {
      planCacheEvictions(entries, 30, null, 200, selection.evictionProtection(true), selection.wantedRank, true)
    }
    assertEquals(listOf(far), planCacheEvictions(entries, 30, null, 200, selection.evictionProtection(false), selection.wantedRank, false))
    assertThrows(IOException::class.java) {
      planCacheEvictions(entries, 120, null, 200, selection.evictionProtection(false), selection.wantedRank, false)
    }
    assertEquals(2, entries.size)
  }

  @Test fun wantedRankFollowsPlaybackOrderAndARepeatKeepsItsEarliestPosition() {
    val b = "https://music.youtube.com/watch?v=b"
    val selection = DownloadSelection(emptyList(), listOf(far, b, a, far))
    assertEquals(mapOf(far to 0, b to 1, a to 2), selection.wantedRank)
    // Protection is the decks only: blanket-protecting the list deadlocked a long one.
    assertEquals(emptySet<String>(), selection.evictionProtection(true))
  }
}
