package com.nowplaying.discovery.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** RADIO-SMOOTH-001 (owner, 2026-11-20): "the radio sometimes plays back really choppy". Measured on the emulator with
 *  the app open: the output ran dry for 2.0-2.4 s of every 30 s (songs and radio alike) because the screen's drawing
 *  delayed the audio thread past an 85 ms output buffer; with the app in the background it was 0.08 s. */
class TrackOutputSizeTest {
  @Test fun theOutputHoldsAQuarterOfASecond() {
    val bytes = TrackOutput.bufferBytes(minBytes = 0)
    val ms = bytes / 8 * 1000.0 / 48000
    assertTrue("$ms ms", ms in 250.0..300.0)
    assertEquals(200_000, TrackOutput.bufferBytes(minBytes = 200_000)) // never below what the device asks for
    assertEquals(TrackOutput.bufferBytes(0), TrackOutput.bufferBytes(4000))
  }
  @Test fun theAudioThreadAsksForUrgentAudioPriority() {
    assertEquals(-19, AudioEngine.AUDIO_THREAD_PRIORITY) // android.os.Process.THREAD_PRIORITY_URGENT_AUDIO
  }
}
