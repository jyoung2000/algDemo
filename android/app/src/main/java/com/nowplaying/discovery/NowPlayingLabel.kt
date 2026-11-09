package com.nowplaying.discovery

/**
 * NATIVE-BRAND-001. The owner: the native player should say Airwave Discovery somewhere, so listeners
 * know which app is playing. Android 13 and later draw the system media player (quick settings, lock
 * screen) from the session's title and artist lines and a small app icon only, with no app name, so
 * the name rides on the artist line of what is playing. Browse rows in the car are left alone: the car
 * already shows the app around them.
 */
object NowPlayingLabel {
  /** Must match `app_name` in res/values/strings.xml (a JVM test holds them together). */
  const val APP = "Airwave Discovery"

  fun artistLine(artist: String?): String {
    val who = artist?.trim().orEmpty()
    return if (who.isEmpty() || who == APP) APP else "$who \u00b7 $APP"
  }
}
