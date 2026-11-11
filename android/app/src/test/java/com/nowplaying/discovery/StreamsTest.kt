package com.nowplaying.discovery

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** STREAM-DL-001: playing a song from its source while its download runs. */
class StreamsTest {
  // The shape yt-dlp printed for a YouTube Music song on 2026-11-10 (link shortened).
  private val printed = """{"url": "https://rr7---sn-x.googlevideo.com/videoplayback?expire=1794371146&itag=251&mime=audio%2Fwebm", "http_headers": {"User-Agent": "Mozilla/5.0 Chrome/151", "Accept": "text/html", "Bad Header": "x"}, "protocol": "https"}"""

  @Test fun streamsOnlyDownloaderApprovedSourcesOverHttps() {
    for (link in listOf(
      "https://music.youtube.com/watch?v=KavaUJxnNVU",
      "https://youtu.be/KavaUJxnNVU",
      "https://soundcloud.com/forss/flickermood",
      "https://audius.co/Lofibeat/stars-in-the-sky-lofi-beats-370899",
      "https://benprunty.bandcamp.com/track/giant-step",
      "https://hearthis.at/random1-ej/deep-by-random-creative-commons-royalty-free/",
      "https://archive.org/download/cold-funk-by-kevin-macleod/cold-funk-by-kevin-macleod.mp3",
    )) assertTrue(link, Streams.streamable(link))
    for (link in listOf(
      "http://music.youtube.com/watch?v=KavaUJxnNVU",
      "https://open.spotify.com/track/11dFghVXANMlKmJXsNCbNl",
      "https://archive.org/download/item/evil.zip",
      "https://music.youtube.com.evil.example/watch?v=x",
      "https://user@music.youtube.com/watch?v=x",
    )) assertFalse(link, Streams.streamable(link))
    assertFalse(Streams.streamable(null))
  }

  @Test fun readsTheFileAndKeepsOnlyWellFormedHeaders() {
    val s = Streams.parse("[youtube] noise\n$printed\n")!!
    assertTrue(s.url.startsWith("https://rr7---sn-x.googlevideo.com/videoplayback?"))
    assertEquals(mapOf("User-Agent" to "Mozilla/5.0 Chrome/151", "Accept" to "text/html"), s.headers)
  }

  @Test fun refusesSegmentListsNonWebLinksAndEmptyAnswers() {
    assertNull(Streams.parse("""{"url": "https://x/playlist.m3u8", "protocol": "m3u8_native"}"""))
    assertNull(Streams.parse("""{"url": "https://x/video.mp4", "protocol": "https", "ext": "mp4", "vcodec": "h264", "acodec": "aac"}"""))
    assertNull(Streams.parse("""{"url": "https://x/mute.mp3", "protocol": "https", "ext": "mp3", "acodec": "none"}"""))
    assertNull(Streams.parse("""{"url": "file:///data/data/x", "protocol": "https"}"""))
    assertNull(Streams.parse(""))
    assertNull(Streams.parse(null))
    assertNull(Streams.parse("{not json"))
  }

  @Test fun asksForOneProgressiveFileAndDownloadsNothing() {
    val opts = Streams.options(YtdlpClients.FAST).toMap()
    assertEquals("bestaudio[protocol=https]/bestaudio[protocol=http]/best[protocol=https]/best[protocol=http]", opts["-f"])
    assertEquals(YtdlpClients.FAST, opts["--extractor-args"])
    assertTrue(opts.containsKey("--ignore-config") && opts.containsKey("--no-playlist"))
    assertFalse(opts.containsKey("--output") || opts.containsKey("--exec") || opts.containsKey("--paths"))
    assertFalse(Streams.options(null).toMap().containsKey("--extractor-args"))
  }
}
