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

  /** CAR-RADIO-NOWPLAYING-001: radio's album slot names the station, with the identified song's album beside it. */
  fun radioAlbum(station: String?, album: String?): String {
    val s = station?.trim()?.takeIf { it.isNotEmpty() } ?: "radio"
    val a = album?.trim()?.takeIf { it.isNotEmpty() && !it.equals("Live radio", true) && !it.equals(s, true) }
    return if (a != null) "Live on $s \u00b7 $a" else "Live on $s"
  }

  /** A programme credited to the station itself shows no artist, so the station is not named twice. */
  fun radioArtist(artist: String?, station: String?): String {
    val a = artist?.trim().orEmpty()
    return if (station != null && a.equals(station.trim(), true)) "" else a
  }
}
