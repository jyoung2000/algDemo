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
    val audio = ByteArrayOutputStream(); val titles = mutableListOf<Pair<String, Long>>(); val first = mutableListOf<String>()
    val d = RadioIcy.Demux(4) { t, at, isFirst -> if (isFirst) first += t else titles += t to at }
    // fed in awkward pieces, as a network read delivers them
    val sizes = listOf(3, 1, 7, 2, 30, 5); var i = 0; var j = 0; while (i < raw.size) { val k = minOf(sizes[j++ % sizes.size], raw.size - i); d.feed(raw.copyOfRange(i, i + k), k) { b, off, len -> audio.write(b, off, len) }; i += k }
    assertArrayEquals((1..16).map { it.toByte() }.toByteArray(), audio.toByteArray())
    // the title on air at connect is not a song start: only a change is
    assertEquals(listOf("Young Thug - Best Friend" to 16L), titles)
    assertEquals(listOf("Mario - Let Me Love You"), first) // reported too, but marked as already playing (RADIO-TITLE-INBAND-001)
    assertEquals(16L, d.audioBytes)
  }

  /** RADIO-TITLE-INBAND-001 (owner, 2026-11-20): "the radio tab is not updating the song on the player fast enough, it lags
   *  almost a full minute behind". Measured over 12 minutes: V103's iHeart feed named each song 27-28 s after its title
   *  changed in the stream, Power 92's Futuri feed 30-31 s before, 103.5 KISS's iHeart feed about 3 minutes before. The
   *  stream's own titles are the only ones in step with the audio. iHeart's streams send no icy-br, so the bitrate is
   *  worked out from the audio received (V103 measured 47.8-48.0 kbit/s: 48). */
  @Test fun titlesAreOnTheRingClockEvenWhenTheStationSendsNoBitrate() {
    val m = RadioIcy.Marks(ringFramesAtConnect = 10L * 48000, kbps = null)
    m.add("Usher - text=\"U Don't Have To Call\"", 16000, first = true)
    m.add("Womack And Womack - text=\"Baby I'm Scared Of You\"", 400_000, first = false)
    // 10 s on the ring since the connection: too soon to know the bitrate; the title already playing is placed at once
    assertEquals(listOf(RadioIcy.Mark(10.0, "Usher - text=\"U Don't Have To Call\"", true)), m.resolved(ringEnd = 20L * 48000, audioBytes = 60_000))
    // 30 s on the ring and 179,250 bytes: 47.8 kbit/s, a 48 kbit/s stream; 400,000 bytes is 66.67 s of audio
    val r = m.resolved(ringEnd = 40L * 48000, audioBytes = 179_250)
    assertEquals(2, r.size); assertEquals(10.0 + 400_000 / 6000.0, r[1].at, 1e-6); assertEquals(false, r[1].first)
    // a stated bitrate is used as it is
    val k = RadioIcy.Marks(0, 64); k.add("A - B", 8000, false)
    assertEquals(1.0, k.resolved(48000, 8000).single().at, 1e-9)
  }

  @Test fun anEstimatedBitrateIsTheNearestStandardOne() {
    assertEquals(48, RadioIcy.standardKbps(47.8)); assertEquals(64, RadioIcy.standardKbps(66.5)); assertEquals(128, RadioIcy.standardKbps(129.1))
    assertEquals(null, RadioIcy.standardKbps(3.0))
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
