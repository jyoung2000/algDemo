package com.nowplaying.discovery
import org.junit.Assert.*
import org.junit.Test
class RadioRingTest {
  @Test fun audioThreadMayFinishReadingAnAlreadyClosedSessionWithoutCrashing() {
    val file = java.io.File.createTempFile("radio-close-test", ".pcm", java.io.File(System.getenv("TMPDIR") ?: System.getProperty("java.io.tmpdir")!!))
    val r = RadioRing(48000, file); val pcm = ByteArray(48000 * 4) { 3 }; r.write(pcm, pcm.size)
    r.close()
    assertEquals(0, r.read(arrayOf(FloatArray(120), FloatArray(120)), 0, 120))
    assertFalse(r.ready); assertEquals(0, r.sample().size)
    r.write(pcm, pcm.size); r.seekTo(1); r.close()
    assertEquals(0L, r.heard); assertFalse(file.exists())
  }

  @Test fun diskBackedDefaultRetainsMoreThanFiveMinutesAndStaysBounded() {
    val file = java.io.File.createTempFile("radio-retention-test", ".pcm", java.io.File(System.getenv("TMPDIR") ?: System.getProperty("java.io.tmpdir")!!))
    val r = RadioRing(file = file); val second = ByteArray(48000 * 4) { 3 }
    repeat(360) { r.write(second, second.size) }
    assertEquals(0L, r.oldest); assertEquals(0L, r.positionFrames); assertEquals(0L, r.heard)
    assertEquals(48000L * 600 * 4, file.length())
    repeat(300) { r.write(second, second.size) }
    assertEquals(48000L * 60, r.oldest); assertEquals(r.oldest, r.positionFrames); assertTrue(r.dropped)
    r.close(); assertFalse(file.exists())
  }

  @Test fun diskBackedRecordingDoesNotAdvanceTheListener() {
    val file = java.io.File.createTempFile("radio-ring-test", ".pcm", java.io.File(System.getenv("TMPDIR") ?: System.getProperty("java.io.tmpdir")!!))
    val r = RadioRing(48000, file)
    r.write(ByteArray(48000 * 4) { 7 }, 48000 * 4)
    val at = r.positionFrames; val heard = r.heard
    val out = java.io.ByteArrayOutputStream(); val seconds = r.writeWav(out, 0L, 48000L)
    val wave = out.toByteArray()
    assertEquals("RIFF", String(wave, 0, 4)); assertEquals(44 + 48000 * 4, wave.size)
    assertEquals(1.0, seconds, 0.001); assertEquals(at, r.positionFrames); assertEquals(heard, r.heard)
    r.close(); assertFalse(file.exists())
  }

  @Test fun boundedPauseRewind() {
    val r = RadioRing(48000)
    r.write(ByteArray(48000 * 4) { 5 }, 48000 * 4)
    assertEquals(48000L, r.end)
    assertEquals(0L, r.heard)
    val dst = arrayOf(FloatArray(120), FloatArray(120))
    assertEquals(120, r.read(dst, 0, 120))
    assertEquals(120L, r.heard)
    r.seekTo(99999); assertEquals(120L, r.positionFrames)
    r.seekTo(0); assertEquals(0L, r.positionFrames)
    r.write(ByteArray(48000 * 4) { 7 }, 48000 * 4)
    assertEquals(48000L, r.positionFrames)
    assertTrue(r.dropped)
    assertEquals(120, r.read(dst, 0, 120))
    assertTrue(dst[0][0] > 0)
  }

  /** RADIO-GO-LIVE-001: Go live jumps to 2 s before the newest audio received; never backwards, never past it. */
  @Test fun goLiveJumpsToJustBeforeTheNewestAudio() {
    val r = RadioRing(48000 * 20)
    val second = ByteArray(48000 * 4) { 5 }
    repeat(10) { r.write(second, second.size) }
    val dst = arrayOf(FloatArray(48000), FloatArray(48000))
    assertEquals(48000, r.read(dst, 0, 48000))
    assertEquals(48000L * 8, r.toLive()); assertEquals(48000L * 8, r.positionFrames)
    assertEquals(48000L * 8, r.toLive())
    repeat(2) { r.read(dst, 0, 48000) }
    assertEquals(48000L * 10, r.toLive())
    val fresh = RadioRing(48000 * 20); fresh.write(second, second.size)
    assertEquals(0L, fresh.toLive())
  }
}
