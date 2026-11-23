package com.nowplaying.discovery

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** CAR-PICK-ON-PLAYER-001: the heart brings the playlist picker to the car's player at once. */
class CarPickListTest {
  private val lists = listOf("p1" to "Night drive", "p2" to "Gym", "p3" to "Sunday")

  @Test fun everyPlaylistIsAChoiceAndCancelIsLast() {
    val c = CarPickList.choices(lists, emptySet())
    assertEquals(listOf("Night drive", "Gym", "Sunday", "Cancel"), c.map { it.label })
    assertEquals("", c.last().listId)
    assertTrue(c.dropLast(1).none { it.holds })
  }

  @Test fun aListThatAlreadyHoldsTheSongIsOfferedLast() {
    val c = CarPickList.choices(lists, setOf("p1"))
    assertEquals(listOf("Gym", "Sunday", "Night drive", "Cancel"), c.map { it.label })
    assertTrue(c.first { it.listId == "p1" }.holds)
  }

  // CAR-HEART-ALWAYS-001 (owner, 2026-11-23): "hearting a song doesnt bring up the playlist sub menu like desired".
  @Test fun withNoListsThePickerStillOpensAndOffersToStartOne() {
    val c = CarPickList.choices(emptyList(), emptySet())
    assertEquals(listOf(CarPickList.NEW_LIST, ""), c.map { it.listId })
    assertEquals(listOf("New playlist \u201cCar picks\u201d", "Cancel"), c.map(CarPickList::buttonLabel))
    assertEquals("\u201cOne More Time\u201d starred: start a playlist for it", CarPickList.hint("One More Time", c))
  }

  @Test fun aSongAlreadyStarredGetsThePickerWithRemoveStarInsteadOfLosingItsStar() {
    val c = CarPickList.choices(lists, setOf("p2"), starredBefore = true)
    assertEquals(listOf("p1", "p3", "p2", CarPickList.UNSTAR, ""), c.map { it.listId })
    assertEquals(
      listOf("Add to Night drive", "Add to Sunday", "Already in Gym", "Remove star", "Cancel"),
      c.map(CarPickList::buttonLabel),
    )
    assertEquals("\u201cSong\u201d is already starred: choose a playlist", CarPickList.hint("Song", c, starredBefore = true))
    // A song starred by this very press is not offered "Remove star": Cancel leaves it starred.
    assertTrue(CarPickList.choices(lists, emptySet()).none { it.listId == CarPickList.UNSTAR })
  }

  @Test fun removeStarAndCancelAreNeverCountedAsPlaylists() {
    val many = (1..6).map { "p$it" to "List $it" }
    assertEquals(
      "\u201cSong\u201d is already starred: choose a playlist, or open the menu for all 6",
      CarPickList.hint("Song", CarPickList.choices(many, emptySet(), starredBefore = true), starredBefore = true),
    )
  }

  @Test fun theHintPointsAtTheMenuOnlyWhenListsDoNotFit() {
    assertEquals("\u201cSong\u201d starred: choose a playlist", CarPickList.hint("Song", CarPickList.choices(lists, emptySet())))
    val many = (1..6).map { "p$it" to "List $it" }
    assertEquals("\u201cSong\u201d starred: choose a playlist, or open the menu for all 6", CarPickList.hint("Song", CarPickList.choices(many, emptySet())))
  }

  /**
   * CAR-PICK-LIST-001 (owner, 2026-11-23): "on android auto the playlist menu should replace the current playing
   * track player and quick controls, open up a list where the user can select playlist then get taken back to the
   * song player once the track is added". Measured on the head unit: the player's buttons are pictures with no
   * words, so two playlists looked the same. The list names every playlist.
   */
  @Test fun theCarsListNamesEveryPlaylistWithTheWayBackFirst() {
    val many = (1..9).map { "p$it" to "List $it" }
    val rows = CarPickList.rows("Rapture", CarPickList.choices(many, setOf("p2")))
    assertEquals("the way back, then every playlist: none is left for a menu", 10, rows.size)
    assertEquals(CarPickList.Row(CarPickList.CANCEL, "Back to \u201cRapture\u201d", "It is starred. Pick a playlist below to add it too."), rows[0])
    assertEquals(CarPickList.Row("p1", "Add to List 1", "\u201cRapture\u201d"), rows[1])
    assertEquals("a list that holds the song says so, last", CarPickList.Row("p2", "Already in List 2", "Tap to go back to the song"), rows.last())
  }

  @Test fun theCarsListOffersToStartAPlaylistAndToRemoveAStar() {
    val none = CarPickList.rows("Rapture", CarPickList.choices(emptyList(), emptySet()))
    assertEquals(listOf(CarPickList.CANCEL, CarPickList.NEW_LIST), none.map { it.listId })
    assertEquals(CarPickList.Row(CarPickList.NEW_LIST, "New playlist \u201cCar picks\u201d", "Starts it with \u201cRapture\u201d"), none[1])
    val starred = CarPickList.rows("Rapture", CarPickList.choices(lists, emptySet(), starredBefore = true))
    assertEquals(CarPickList.Row(CarPickList.UNSTAR, "Remove star", "\u201cRapture\u201d will no longer be starred"), starred.last())
    assertEquals("It was already starred. Pick a playlist below to add it too.", starred[0].subtitle)
  }

  @Test fun aSongWithNoNameStillGetsAList() {
    val rows = CarPickList.rows(null, CarPickList.choices(lists, emptySet()))
    assertEquals("Back to the song", rows[0].title)
    assertEquals("This song", rows[1].subtitle)
  }

  /** The row ids the car sends back: the playlist and the song, whatever characters they hold. */
  @Test fun aRowIdCarriesItsPlaylistAndItsSong() {
    val id = CarPickList.rowId("pl night/1", "tobe nwigwe|i choose you|")
    assertTrue(id.startsWith(CarPickList.ROW_PREFIX))
    assertEquals("pl night/1" to "tobe nwigwe|i choose you|", CarPickList.parseRow(id))
    assertEquals(CarPickList.CANCEL to "s", CarPickList.parseRow(CarPickList.rowId(CarPickList.CANCEL, "s")))
    assertEquals(null, CarPickList.parseRow("addto/x/y"))
    assertEquals(null, CarPickList.parseRow(CarPickList.ROW_PREFIX + "only-one-part"))
    assertEquals(null, CarPickList.parseRow(CarPickList.ROW_PREFIX + "a/b/c"))
  }

  /** The car shows a message's first sentence only, so the whole hint has to be one. */
  @Test fun theHintIsOneSentenceSoTheCarShowsAllOfIt() {
    val many = (1..6).map { "p$it" to "List $it" }
    for (h in listOf(
      CarPickList.hint("Song", CarPickList.choices(lists, emptySet())),
      CarPickList.hint("Song", CarPickList.choices(many, emptySet(), starredBefore = true), starredBefore = true),
      CarPickList.hint("Song", CarPickList.choices(emptyList(), emptySet())),
    )) {
      assertEquals("nothing after a full stop: $h", h, h.trim().substringBefore(". "))
      assertTrue("says what to do: $h", h.contains("playlist"))
    }
  }

  @Test fun anUnnamedListStillReadsAsSomething() {
    assertEquals("Playlist", CarPickList.choices(listOf("p9" to "  "), emptySet()).first().label)
  }

  @Test fun thePickIsReportedHonestly() {
    assertEquals("Added to Gym", CarPickList.added("Gym", already = false))
    assertEquals("Already in Gym", CarPickList.added("Gym", already = true))
  }
}
