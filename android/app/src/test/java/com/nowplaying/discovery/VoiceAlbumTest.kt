package com.nowplaying.discovery

import android.provider.MediaStore
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** ALBUM-CAR-001: which voice requests ask for an album rather than a song. */
class VoiceAlbumTest {
  @Test fun theAlbumFocusOrAnAlbumWithoutASongAsksForTheAlbum() {
    assertTrue(VoiceRequest.asksForAlbum(MediaStore.Audio.Albums.ENTRY_CONTENT_TYPE, null, null))
    assertTrue(VoiceRequest.asksForAlbum(null, "A Great Chaos", null))
    assertFalse(VoiceRequest.asksForAlbum(null, "A Great Chaos", "Green Room"))
    assertFalse(VoiceRequest.asksForAlbum("vnd.android.cursor.item/audio", null, null))
    assertFalse(VoiceRequest.asksForAlbum(null, " ", null))
  }
}
