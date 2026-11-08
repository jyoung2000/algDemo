package com.nowplaying.discovery

import org.junit.Assert.assertEquals
import org.junit.Test

class YtdlpClientsTest {
  @Test fun youTubeLinksTryTheFastClientFirstThenYtDlpsOwnDefaults() {
    for (url in listOf(
      "https://music.youtube.com/watch?v=Rgrt_8mXrK8",
      "https://www.youtube.com/watch?v=Rgrt_8mXrK8",
      "https://youtu.be/Rgrt_8mXrK8",
    )) assertEquals(url, listOf(YtdlpClients.FAST, null), YtdlpClients.attempts(url))
  }

  @Test fun otherSitesRunOnceWithTheDefaults() {
    for (url in listOf(
      "https://soundcloud.com/artist/song",
      "https://artist.bandcamp.com/track/song",
      "https://archive.org/download/item/song.mp3",
      "https://music.youtube.com.evil.example/watch?v=x",
      "not a url",
    )) assertEquals(url, listOf<String?>(null), YtdlpClients.attempts(url))
  }

  @Test fun theFastClientIsVisionOs() {
    assertEquals("youtube:player_client=visionos", YtdlpClients.FAST)
  }
}
