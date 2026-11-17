package com.nowplaying.discovery
import org.junit.Assert.*
import org.junit.Test
class RadioRingTest {
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
}
