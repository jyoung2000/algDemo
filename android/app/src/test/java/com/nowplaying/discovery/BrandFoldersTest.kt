package com.nowplaying.discovery

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** JPLAY-BRAND-002 (owner, 2026-11-19): the app's folders are called jPlay, earlier songs move with them. */
class BrandFoldersTest {
  @Test fun names() {
    assertEquals("jPlay", BrandFolders.NAME)
    assertEquals("Music/jPlay", BrandFolders.MUSIC_PATH)
  }

  @Test fun movesMediaStorePathsUnderTheOldFolderOnly() {
    assertEquals("Music/jPlay/", BrandFolders.moved("Music/Airwave Discovery/"))
    assertEquals("Music/jPlay/", BrandFolders.moved("Music/Airwave Discovery"))
    assertEquals("Music/jPlay/Albums/Ken Carson - A Great Chaos/", BrandFolders.moved("Music/Airwave Discovery/Albums/Ken Carson - A Great Chaos/"))
    assertNull(BrandFolders.moved("Music/jPlay/"))
    assertNull(BrandFolders.moved("Music/Other app/"))
    assertNull(BrandFolders.moved("Music/Airwave Discovery Extra/"))
  }

  @Test fun rewritesStoredFileLocationsInEveryForm() {
    val old = "/storage/emulated/0/Android/data/com.nowplaying.discovery/files/Music/Airwave Discovery"
    val neu = "/storage/emulated/0/Android/data/com.nowplaying.discovery/files/Music/jPlay"
    // Uri.fromFile encodes the space; JSONObject.toString escapes the slashes.
    val stored = """{"a":"file://$old/song.mp3","b":"file://${old.replace(" ", "%20")}/s%202.mp3","c":"file:${old.replace(" ", "%20").replace("/", "\\/")}\/x.mp3","d":"content://media/external/audio/media/12"}"""
    val out = BrandFolders.rewritePaths(stored, old, neu)
    assertEquals("""{"a":"file://$neu/song.mp3","b":"file://$neu/s%202.mp3","c":"file:${neu.replace("/", "\\/")}\/x.mp3","d":"content://media/external/audio/media/12"}""", out)
  }
}
