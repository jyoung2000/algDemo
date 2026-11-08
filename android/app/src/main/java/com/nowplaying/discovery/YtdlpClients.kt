package com.nowplaying.discovery

import java.net.URI

/**
 * Which YouTube player clients yt-dlp asks, in order (DL-FAST-001).
 *
 * yt-dlp's default clients make every download fetch YouTube's player script and solve its JS
 * challenge in quickjs, measured on the emulator at 5.4 s of a 16.4 s download whose audio took
 * 0.8 s. The visionOS client answers with the same Opus audio (format 251) and no challenge: 8.1 s
 * on five songs out of five. It is asked first; when it fails, the same download runs again with
 * yt-dlp's own defaults, so a song that needs them still arrives, only no faster than before.
 *
 * Mirrored by windows/downloads.cjs (`clientAttempts`).
 */
object YtdlpClients {
  const val FAST = "youtube:player_client=visionos"
  private val YOUTUBE = setOf("youtu.be", "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com")

  /** One entry per attempt: the `--extractor-args` value, or null for yt-dlp's defaults. */
  fun attempts(url: String): List<String?> {
    val host = runCatching { URI(url).host?.lowercase() }.getOrNull()
    return if (host in YOUTUBE) listOf(FAST, null) else listOf(null)
  }
}
