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

  @Test fun streamsYouTubeLinksOnlyOverHttps() {
    assertTrue(Streams.streamable("https://music.youtube.com/watch?v=KavaUJxnNVU"))
    assertTrue(Streams.streamable("https://youtu.be/KavaUJxnNVU"))
    assertFalse(Streams.streamable("http://music.youtube.com/watch?v=KavaUJxnNVU"))
    assertFalse(Streams.streamable("https://soundcloud.com/frank-ocean/nikes"))
    assertFalse(Streams.streamable("https://music.youtube.com.evil.example/watch?v=x"))
    assertFalse(Streams.streamable("https://user@music.youtube.com/watch?v=x"))
    assertFalse(Streams.streamable(null))
  }

  @Test fun readsTheFileAndKeepsOnlyWellFormedHeaders() {
    val s = Streams.parse("[youtube] noise\n$printed\n")!!
    assertTrue(s.url.startsWith("https://rr7---sn-x.googlevideo.com/videoplayback?"))
    assertEquals(mapOf("User-Agent" to "Mozilla/5.0 Chrome/151", "Accept" to "text/html"), s.headers)
  }

  @Test fun refusesSegmentListsNonWebLinksAndEmptyAnswers() {
    assertNull(Streams.parse("""{"url": "https://x/playlist.m3u8", "protocol": "m3u8_native"}"""))
    assertNull(Streams.parse("""{"url": "file:///data/data/x", "protocol": "https"}"""))
    assertNull(Streams.parse(""))
    assertNull(Streams.parse(null))
    assertNull(Streams.parse("{not json"))
  }

  @Test fun asksForOneProgressiveFileAndDownloadsNothing() {
    val opts = Streams.options(YtdlpClients.FAST).toMap()
    assertEquals("bestaudio[protocol=https]/bestaudio[protocol=http]", opts["-f"])
    assertEquals(YtdlpClients.FAST, opts["--extractor-args"])
    assertTrue(opts.containsKey("--ignore-config") && opts.containsKey("--no-playlist"))
    assertFalse(opts.containsKey("--output") || opts.containsKey("--exec") || opts.containsKey("--paths"))
    assertFalse(Streams.options(null).toMap().containsKey("--extractor-args"))
  }
}
