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

  @Test fun withNoListsThereIsNothingToPickAndTheCarSaysWhy() {
    assertEquals(emptyList<CarPickList.Choice>(), CarPickList.choices(emptyList(), emptySet()))
    assertEquals(
      "\u201cOne More Time\u201d is starred. Make a playlist in jPlay to save it to one.",
      CarPickList.hint("One More Time", emptyList()),
    )
  }

  @Test fun theHintPointsAtTheMenuOnlyWhenListsDoNotFit() {
    assertEquals("\u201cSong\u201d is starred. Choose a playlist.", CarPickList.hint("Song", CarPickList.choices(lists, emptySet())))
    val many = (1..6).map { "p$it" to "List $it" }
    assertEquals("\u201cSong\u201d is starred. Choose a playlist, or open the menu for all 6.", CarPickList.hint("Song", CarPickList.choices(many, emptySet())))
  }

  @Test fun anUnnamedListStillReadsAsSomething() {
    assertEquals("Playlist", CarPickList.choices(listOf("p9" to "  "), emptySet()).first().label)
  }

  @Test fun thePickIsReportedHonestly() {
    assertEquals("Added to Gym", CarPickList.added("Gym", already = false))
    assertEquals("Already in Gym", CarPickList.added("Gym", already = true))
  }
}
