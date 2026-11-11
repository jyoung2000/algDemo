package com.nowplaying.discovery

/**
 * NATIVE-ALBUM-001. Show artist and album on the system player's second line, replacing the former
 * app-name suffix. Keep albumTitle separate too for car/Bluetooth controllers that show that field.
 * Android's own app attribution is not song metadata and is left to the system.
 */
object NowPlayingLabel {
  fun artistLine(artist: String?, album: String? = null): String =
    listOfNotNull(artist?.trim()?.takeIf { it.isNotEmpty() }, album?.trim()?.takeIf { it.isNotEmpty() })
      .distinct()
      .joinToString(" \u00b7 ")
}
