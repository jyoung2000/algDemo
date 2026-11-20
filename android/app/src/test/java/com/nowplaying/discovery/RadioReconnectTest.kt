package com.nowplaying.discovery

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** RADIO-ROBUST-001 (owner, 2026-11-20): "Ensure all radio stations ... seamlessly works on Android". */
class RadioReconnectTest {
  private val sec = 48000L

  @Test fun aStationThatNeverPlayedTriesOnceMoreThenFails() {
    // a one-off refusal (iHeart's server answered 404 once after several quick connects, then played) is retried once
    assertEquals(1, RadioReconnect.next(everPlayed = false, framesSinceConnect = 0, tries = 0))
    assertNull(RadioReconnect.next(everPlayed = false, framesSinceConnect = 0, tries = 1))
  }

  @Test fun aDroppedStreamReconnectsUpToFiveTimesWithGrowingWaits() {
    var tries = RadioReconnect.next(true, 600 * sec, 0)
    assertEquals(1, tries)
    for (n in 2..5) { tries = RadioReconnect.next(true, 0, tries!!); assertEquals(n, tries) }
    assertNull(RadioReconnect.next(true, 0, tries!!))
    assertEquals(listOf(1000L, 2000L, 4000L, 8000L, 8000L), (1..5).map { RadioReconnect.delayMs(it) })
  }

  @Test fun theCountStartsAgainOnceTheStationPlaysAgain() {
    assertEquals(1, RadioReconnect.next(true, 3 * sec, 4))
    assertEquals(5, RadioReconnect.next(true, sec, 4)) // a second of audio is not a recovered station
  }

  @Test fun theFirstErrorIsTheOneShown() {
    val r = RadioRing(48000)
    r.fail(IllegalStateException("Station answered HTTP 404"))
    r.fail(IllegalStateException("Radio decoder stopped"))
    assertEquals("Station answered HTTP 404", r.failed?.message)
  }

  @Test fun everyAddressInAPlaylistIsACandidate() {
    val pls = "[playlist]\r\nNumberOfEntries=3\r\nFile1=http://a.example:80/X_SC\r\nTitle1=X\r\nFile2=http://a.example:3690/X_SC\r\nFile3=http://b.example/X_SC\r\nFile3=http://b.example/X_SC\r\n"
    assertEquals(listOf("http://a.example:80/X_SC", "http://a.example:3690/X_SC", "http://b.example/X_SC"), RadioReconnect.playlistEntries(pls))
    assertEquals(listOf("http://98.82.2.45/w?session-id=1", "http://98.83.219.79/w?session-id=1"), RadioReconnect.playlistEntries("#EXTM3U\nhttp://98.82.2.45/w?session-id=1\n\nhttp://98.83.219.79/w?session-id=1\n"))
  }

  @Test fun theNextAddressIsTriedWhenOneFailsBeforePlaying() {
    var frames = 0L; val tried = mutableListOf<String>()
    val r = RadioReconnect.firstThatPlays(listOf("a", "b", "c"), { frames }) { tried += it; if (it == "a") error("Station answered HTTP 503"); frames += 10; "played $it" }
    assertEquals("played b", r); assertEquals(listOf("a", "b"), tried)
  }

  @Test fun aStreamThatPlayedAndThenDroppedIsNotSwappedForTheNextAddress() {
    var frames = 0L; val tried = mutableListOf<String>()
    val e = runCatching { RadioReconnect.firstThatPlays(listOf("a", "b"), { frames }) { tried += it; frames += 10; error("read interrupted") } }.exceptionOrNull()
    assertEquals("read interrupted", e?.message); assertEquals(listOf("a"), tried)
  }

  @Test fun whenEveryAddressFailsTheFirstReasonIsKept() {
    val e = runCatching { RadioReconnect.firstThatPlays(listOf("a", "b"), { 0L }) { error("fail $it") } }.exceptionOrNull()
    assertEquals("fail a", e?.message)
  }
}
