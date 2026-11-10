package com.nowplaying.discovery

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * LIST-SAVE-FOLDER-001: where a saved list or album goes on the phone, and the names it carries there.
 * (Copying into MediaStore runs on the device; see the emulator check.)
 */
class ListSaveTest {
  @Test fun albumsAndListsGetTheirOwnFolderUnderMusic() {
    assertEquals("Music/Airwave Discovery/Albums/Ken Carson - A Great Chaos", ListSave.relativePath("album", "Ken Carson - A Great Chaos"))
    assertEquals("Music/Airwave Discovery/Lists/Late night", ListSave.relativePath("list", "Late night"))
    assertEquals("Music › Airwave Discovery › Albums › Ken Carson - A Great Chaos", ListSave.label("album", "Ken Carson - A Great Chaos"))
    assertThrows(IllegalArgumentException::class.java) { ListSave.relativePath("other", "x") }
  }

  @Test fun aNameCannotClimbOutHideOrBeEmpty() {
    assertEquals("_ .._Windows", ListSave.folderName("album", "../ ..\\Windows"))
    assertEquals("hidden", ListSave.folderName("list", "...hidden"))
    assertEquals("Album", ListSave.folderName("album", ""))
    assertEquals("List", ListSave.folderName("list", "..."))
  }

  @Test fun aSongKeepsItsOwnExtension() {
    assertEquals("opus", ListSave.extension("6d9ff95e.opus"))
    assertEquals("m4a", ListSave.extension("Carefree.M4A"))
    assertEquals(null, ListSave.extension("1000000042"))
    assertEquals(null, ListSave.extension(null))
    assertEquals(null, ListSave.extension("weird.name with space"))
  }

  @Test fun theMusicTableIsGivenAnAudioType() {
    assertEquals("audio/mp4", ListSave.audioType("audio/mp4", "m4a"))
    assertEquals("audio/ogg", ListSave.audioType("application/octet-stream", "opus"))
    assertEquals("audio/webm", ListSave.audioType("video/webm", "webm"))
    assertEquals("audio/mpeg", ListSave.audioType("", ""))
  }
}
