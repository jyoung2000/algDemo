package com.nowplaying.discovery

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.ByteArrayOutputStream

/**
 * RADIO-ICY-CLOCK-001 (owner, 2026-11-20: Android Auto should show "a player bar with the song elapsed time and
 * duration"). Measured on Power 92: its feed published a song's start 37.5 s before the song's title changed inside
 * the audio stream, so a clock from the feed ran 37 s ahead. The playing stream now carries its in-band (ICY) titles:
 * the title blocks are taken out of the audio and each new title is placed on the ring clock where its audio begins.
 */
class RadioIcyTest {
  /** A stream with metaint 4: 4 audio bytes, a length byte (x16) and the padded block, repeated. */
  private fun stream(vararg parts: Pair<ByteArray, String?>): ByteArray {
    val o = ByteArrayOutputStream()
    for ((audio, title) in parts) {
      o.write(audio)
      if (title == null) o.write(0) else {
        val text = "StreamTitle='$title';StreamUrl='';".toByteArray()
        val blocks = (text.size + 15) / 16
        o.write(blocks); o.write(text); repeat(blocks * 16 - text.size) { o.write(0) }
      }
    }
    return o.toByteArray()
  }

  @Test fun titleBlocksAreTakenOutOfTheAudioAndEachTitleChangeIsPlacedAtItsAudioByte() {
    val raw = stream(byteArrayOf(1, 2, 3, 4) to "Mario - Let Me Love You", byteArrayOf(5, 6, 7, 8) to null,
      byteArrayOf(9, 10, 11, 12) to "Mario - Let Me Love You", byteArrayOf(13, 14, 15, 16) to "Young Thug - Best Friend")
    val audio = ByteArrayOutputStream(); val titles = mutableListOf<Pair<String, Long>>()
    val d = RadioIcy.Demux(4) { t, at -> titles += t to at }
    // fed in awkward pieces, as a network read delivers them
    val sizes = listOf(3, 1, 7, 2, 30, 5); var i = 0; var j = 0; while (i < raw.size) { val k = minOf(sizes[j++ % sizes.size], raw.size - i); d.feed(raw.copyOfRange(i, i + k), k) { b, off, len -> audio.write(b, off, len) }; i += k }
    assertArrayEquals((1..16).map { it.toByte() }.toByteArray(), audio.toByteArray())
    // the title on air at connect is not a song start: only a change is
    assertEquals(listOf("Young Thug - Best Friend" to 16L), titles)
    assertEquals(16L, d.audioBytes)
  }

  @Test fun anAudioByteIsASecondOnTheRingFromTheStationsBitrate() {
    // 64 kbit/s = 8000 bytes a second; the connection began when the ring already held 10 s
    assertEquals(10.0 + 387.072, RadioIcy.ringSeconds(10L * 48000, 3_096_576L, 64)!!, 1e-9)
    assertEquals(null, RadioIcy.ringSeconds(0, 100, null))
    assertEquals(64, RadioIcy.kbps("64"))
    assertEquals(128, RadioIcy.kbps("128,128"))
    assertEquals(null, RadioIcy.kbps("fast"))
  }

  @Test fun theTitleIsReadFromTheBlock() {
    assertEquals("Frank Ocean - Thinkin Bout You", RadioIcy.title("StreamTitle='Frank Ocean - Thinkin Bout You';StreamUrl='';"))
    assertEquals("It's Late", RadioIcy.title("StreamTitle='It's Late';StreamUrl='x';"))
    assertEquals(null, RadioIcy.title("StreamTitle='';"))
    assertEquals(null, RadioIcy.title("StreamUrl='x';"))
  }
}
