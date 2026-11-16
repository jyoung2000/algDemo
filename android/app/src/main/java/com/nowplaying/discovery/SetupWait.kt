package com.nowplaying.discovery

/**
 * DL-COLD-READY-001: a download job started before yt-dlp has finished unpacking waits for that setup,
 * bounded, instead of failing at once. Pure so the timing is testable without a device.
 */
object SetupWait {
  enum class State { READY, STARTING, FAILED }

  fun await(
    state: () -> State,
    now: () -> Long = { android.os.SystemClock.elapsedRealtime() },
    sleep: (Long) -> Unit = { Thread.sleep(it) },
    timeoutMs: Long = 90_000,
    stepMs: Long = 250,
  ): State {
    val start = now()
    while (true) {
      val s = state()
      if (s != State.STARTING) return s
      val left = timeoutMs - (now() - start)
      if (left <= 0) return s
      sleep(minOf(stepMs, left))
    }
  }
}
