package com.nowplaying.discovery

/**
 * CAR-SAVE-HIDDEN-001 (owner, 2026-11-23): "on android auto hearting a song doesnt bring up the playlist sub menu
 * like desired" / "the playlist dont load or save the music".
 *
 * Who saves a star or a playlist choice made in the car. Measured with Android Auto's head unit on the emulator:
 * with jPlay's screen not in front, the phone page's WebView is paused and runs no timer and no task, so a save
 * handed to it happened only when the app was next opened, or never. The playback service's own engine keeps
 * running in a car, so it saves whenever the phone page is not in front.
 */
object CarRoute {
  enum class To { PAGE, SERVICE, KEEP }

  /**
   * [page]: a phone page is attached. [pageAnswering]: it has pushed its first state. [pageVisible]: it is in
   * front. [pageRunning]: its WebView is not paused. [serviceEngine]: the service owns the engine and it is ready.
   */
  fun saveTarget(page: Boolean, pageAnswering: Boolean, pageVisible: Boolean, pageRunning: Boolean, serviceEngine: Boolean): To = when {
    page && pageAnswering && pageVisible -> To.PAGE
    serviceEngine -> To.SERVICE
    page && pageAnswering && pageRunning -> To.PAGE
    else -> To.KEEP
  }
}
