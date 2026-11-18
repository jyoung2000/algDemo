package com.nowplaying.discovery

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** CAR-SEARCH-TYPES-001: the spoken lead words and the kinds of result the car's icons narrow to. */
class CarSearchTest {
  @Test fun directStationCallSignsAndFrequenciesAreRecognizedWithoutHijackingExplicitMusicKinds() {
    for (q in listOf("WGCI", "wgci", "W G C I", "play WGCI")) assertEquals("WGCI", CarSearch.radioQuery(q))
    for (q in listOf("107", "107.5", "107.5 WGCI", "WGCI 107.5")) assertEquals(q, CarSearch.radioQuery(q))
    for (q in listOf("album 107", "single WGCI", "artist KISS", "song called Work", "Ken Carson")) assertEquals(q, null, CarSearch.radioQuery(q))
    assertEquals(null, CarSearch.radioQuery("WGCI", sticky = CarSearchType.ARTISTS))
    assertEquals("WGCI", CarSearch.radioQuery("radio WGCI", sticky = CarSearchType.ARTISTS))
  }

  @Test fun spokenLeadWordsPickTheKindAndAreNotSearchedFor() {
    assertEquals(CarSearchType.ALBUMS to "A Great Chaos", CarSearch.parse("album A Great Chaos"))
    assertEquals(CarSearchType.ALBUMS to "Pink Floyd", CarSearch.parse("the album called Pink Floyd"))
    assertEquals(CarSearchType.LYRICS to "i got a feeling", CarSearch.parse("lyrics i got a feeling"))
    assertEquals(CarSearchType.LYRICS to "never gonna give you up", CarSearch.parse("song that goes never gonna give you up"))
    assertEquals(CarSearchType.SINGLES to "Overseas", CarSearch.parse("single Overseas"))
    assertEquals(CarSearchType.SINGLES to "Overseas", CarSearch.parse("song called Overseas"))
    assertEquals(CarSearchType.FEATURES to "Ken Carson", CarSearch.parse("featuring Ken Carson"))
    for (s in listOf("what song is this", "What's this song", "identify", "identify this song", "shazam", "name this song")) {
      assertEquals(s, CarSearchType.IDENTIFY, CarSearch.parse(s).first)
    }
  }

  @Test fun plainWordsSearchEverythingUnlessAKindWasPickedOnTheSearchTab() {
    assertEquals(CarSearchType.ALL to "ken carson", CarSearch.parse("  ken   carson "))
    assertEquals(CarSearchType.LYRICS to "ken carson", CarSearch.parse("ken carson", sticky = CarSearchType.LYRICS))
    // Spoken lead words win over the picked kind; Identify is never sticky for a typed search.
    assertEquals(CarSearchType.ALBUMS to "x", CarSearch.parse("album x", sticky = CarSearchType.LYRICS))
    assertEquals(CarSearchType.ALL to "x", CarSearch.parse("x", sticky = CarSearchType.IDENTIFY))
    // A title that merely starts with a kind's word, with nothing after it, is a plain search.
    assertEquals(CarSearchType.ALL to "Album", CarSearch.parse("Album"))
    assertEquals(CarSearchType.ALL to "Lyrics", CarSearch.parse("Lyrics"))
  }

  @Test fun kindsFollowThePhoneIconMenuRules() {
    assertEquals(setOf("single"), CarSearch.kindsOf("Overseas", "Ken Carson", "Overseas"))
    assertEquals(setOf("single", "feature"), CarSearch.kindsOf("Margiela (feat. Destroy Lonely)", "Ken Carson", "Margiela - Single"))
    assertEquals(setOf("album"), CarSearch.kindsOf("Green Room", "Ken Carson", "A Great Chaos"))
    assertEquals(setOf("album", "feature"), CarSearch.kindsOf("Fell In Love", "Lil Tecca, Ken Carson", "We Love You Tecca 2"))
    assertEquals(emptySet<String>(), CarSearch.kindsOf("Loose", "Someone", null))
    assertEquals(setOf("album", "lyrics"), CarSearch.kindsOf("Rock N Roll", "Ken Carson", "A Great Chaos", setOf("lyrics", "bogus")))
  }

  @Test fun eachIconShowsOnlyItsKind() {
    val lyric = setOf("album", "lyrics")
    assertTrue(CarSearch.matches(CarSearchType.ALL, lyric))
    assertTrue(CarSearch.matches(CarSearchType.LYRICS, lyric))
    assertTrue(CarSearch.matches(CarSearchType.ALBUMS, lyric))
    assertFalse(CarSearch.matches(CarSearchType.SINGLES, lyric))
    assertFalse(CarSearch.matches(CarSearchType.FEATURES, lyric))
    assertFalse(CarSearch.matches(CarSearchType.IDENTIFY, lyric))
    assertEquals(listOf("all", "artists", "singles", "albums", "features", "lyrics"), CarSearchType.FILTERS.map { it.key })
  }

  // RESULT-ARTIST-001 (owner, 2026-11-15): "add a single user icon for artist to the search results
  // list and android auto so users can search by artist".
  @Test fun anArtistSearchIsSaidOrPickedAndShowsOnlyThatArtistsSongs() {
    assertEquals(listOf("All", "Artists", "Singles", "Albums", "Features", "Lyrics", "Identify"), CarSearchType.entries.map { it.title })
    assertEquals("car_type_artist", CarSearchType.ARTISTS.icon)
    assertEquals(CarSearchType.ARTISTS to "Ken Carson", CarSearch.parse("artist Ken Carson"))
    assertEquals(CarSearchType.ARTISTS to "Sade", CarSearch.parse("the artist called Sade"))
    assertEquals(CarSearchType.ARTISTS to "Ken Carson", CarSearch.parse("songs by Ken Carson"))
    assertEquals(CarSearchType.ARTISTS to "Sade", CarSearch.parse("music by Sade"))
    assertEquals(CarSearchType.ALL to "Artist", CarSearch.parse("Artist"))
    assertEquals(CarSearchType.ARTISTS to "ken carson", CarSearch.parse("ken carson", sticky = CarSearchType.ARTISTS))
    // Credited (lead or featured) counts; a song merely named after the artist does not.
    assertTrue("artist" in CarSearch.kindsOf("Overseas", "Ken Carson", "Overseas", words = "ken carson"))
    assertTrue("artist" in CarSearch.kindsOf("Fell In Love", "Lil Tecca, Ken Carson", "TEC", words = "Ken  Carson!"))
    assertTrue("artist" in CarSearch.kindsOf("Overseas", "Ken Carson", "Overseas", words = "ken carson tn737"))
    assertFalse("artist" in CarSearch.kindsOf("Ken Carson Tribute", "Cover Band", null, words = "ken carson"))
    assertFalse("artist" in CarSearch.kindsOf("Overseas", "Ken Carson", "Overseas", words = "carson"))
    assertFalse("artist" in CarSearch.kindsOf("Overseas", "Ken Carson", "Overseas"))
    assertTrue("artist" in CarSearch.kindsOf("x", "Someone", null, setOf("artist")))
    assertTrue(CarSearch.matches(CarSearchType.ARTISTS, setOf("album", "artist")))
    assertFalse(CarSearch.matches(CarSearchType.ARTISTS, setOf("album", "feature")))
    // Picking Artists on the Search tab applies to the next search, like the other kinds.
    CarSearch.pick(CarSearchType.ARTISTS, 1_000L)
    assertEquals(CarSearchType.ARTISTS, CarSearch.picked(2_000L))
    CarSearch.pick(CarSearchType.ALL, 3_000L)
  }
}
