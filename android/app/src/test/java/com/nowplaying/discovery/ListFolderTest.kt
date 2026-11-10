package com.nowplaying.discovery

import org.junit.Assert.assertEquals
import org.junit.Test

/** LIST-FOLDER-001: the names the songs carry in the Files app's "Airwave Discovery" folder. */
class ListFolderTest {
  @Test fun songsAreNumberedInPlayOrderWithTitleAndArtist() {
    assertEquals("01 Yale - Ken Carson.opus", ListFolder.entryName(1, "Yale", "Ken Carson", "opus"))
    assertEquals("12 Succubus_ - Ken Carson.m4a", ListFolder.entryName(12, "Succubus?", "Ken Carson", "m4a"))
    assertEquals("03 Untitled.mp3", ListFolder.entryName(3, "Untitled", "", "mp3"))
    assertEquals("04 Song", ListFolder.entryName(4, "", "", ""))
  }

  @Test fun aListNameCannotClimbOutOrHide() {
    assertEquals("_ .._Windows", ListFolder.listName("../ ..\\Windows"))
    assertEquals("Now playing queue", ListFolder.listName(""))
    assertEquals("hidden", ListFolder.listName("...hidden"))
  }
}
