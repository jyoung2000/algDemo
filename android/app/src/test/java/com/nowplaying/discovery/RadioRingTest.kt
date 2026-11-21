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
    r.hold() // after a pause: no automatic catch-up, so the listener is 9 s behind
    assertEquals(48000, r.read(dst, 0, 48000))
    assertEquals(48000L * 5, r.toLive()); assertEquals(48000L * 5, r.positionFrames) // 5 s before the newest (RADIO-SMOOTH-001)
    assertEquals(48000L * 5, r.toLive())
    repeat(5) { r.read(dst, 0, 48000) }
    assertEquals(48000L * 10, r.toLive())
    val fresh = RadioRing(48000 * 20); fresh.write(second, second.size)
    assertEquals(0L, fresh.toLive())
  }

  /** RADIO-LIVE-EDGE-001 (owner, 2026-11-19): "behind the actual live radio even though it says live". Servers send a
   *  burst of recent audio on connect (Power 92 ~32 s, V103 ~20 s); playback started at its oldest frame. */
  @Test fun aConnectBurstStartsFiveSecondsBeforeTheNewestAudio() {
    val r = RadioRing(48000 * 120)
    val burst = ByteArray(48000 * 4 * 30) { 1 }
    r.write(burst, burst.size)
    r.seekTo(0) // the engine's load() does this; it is not a rewind
    val dst = arrayOf(FloatArray(1200), FloatArray(1200))
    assertEquals(1200, r.read(dst, 0, 1200))
    assertEquals(48000L * 25 + 1200, r.positionFrames)
  }
  @Test fun catchingUpStopsAfterPauseRewindOrTheOpeningTenSeconds() {
    val sec = ByteArray(48000 * 4) { 1 }
    val dst = arrayOf(FloatArray(48000), FloatArray(48000))
    val a = RadioRing(48000 * 120); repeat(30) { a.write(sec, sec.size) }; a.read(dst, 0, 100); a.hold()
    repeat(20) { a.write(sec, sec.size) }; val at = a.positionFrames; a.read(dst, 0, 100); assertEquals(at + 100, a.positionFrames)
    val b = RadioRing(48000 * 120); repeat(30) { b.write(sec, sec.size) }; b.read(dst, 0, 100); b.seekTo(b.positionFrames - 48000 * 15)
    val back = b.positionFrames; b.read(dst, 0, 100); assertEquals(back + 100, b.positionFrames)
    val c = RadioRing(48000 * 120); repeat(10) { c.write(sec, sec.size); c.read(dst, 0, 48000) }
    repeat(20) { c.write(sec, sec.size) }; val before = c.positionFrames; c.read(dst, 0, 100); assertEquals(before + 100, c.positionFrames)
  }

  /** RADIO-ROBUST-001: after a network stall the stream resumes with its backlog; the listener rejoins live, not 20 s late. */
  @Test fun afterAStallPlaybackRejoinsLive() {
    val sec = 48000; val r = RadioRing(sec * 60); val buf = Array(2) { FloatArray(sec * 30) }
    repeat(12) { r.write(ByteArray(sec * 4), sec * 4); r.read(buf, 0, sec) }        // 12 s heard: the opening catch-up is over
    assertEquals(0, r.read(buf, 0, sec))                                       // network stall: nothing to play
    r.write(ByteArray(sec * 4 * 22), sec * 4 * 22)                                 // the backlog arrives
    r.read(buf, 0, 480)
    assertEquals(5.0, (r.end - r.positionFrames).toDouble() / sec, 0.02)
  }

  @Test fun aStallWhileTheListenerIsBehindOnPurposeKeepsTheirPlace() {
    val sec = 48000; val r = RadioRing(sec * 60); val buf = Array(2) { FloatArray(sec * 30) }
    repeat(12) { r.write(ByteArray(sec * 4), sec * 4); r.read(buf, 0, sec) }
    r.hold(); r.read(buf, 0, sec)
    r.write(ByteArray(sec * 4 * 22), sec * 4 * 22); r.read(buf, 0, 480)
    assertEquals(22.0, (r.end - r.positionFrames).toDouble() / sec, 0.05)
  }

  /** The engine stops pulling while the ring is low (buffering), so the stall shows as one short read, not an empty one. */
  @Test fun aShortReadBeforeBufferingAlsoCountsAsAStall() {
    val sec = 48000; val r = RadioRing(sec * 60); val buf = Array(2) { FloatArray(sec * 30) }
    repeat(12) { r.write(ByteArray(sec * 4), sec * 4); r.read(buf, 0, sec) }
    r.write(ByteArray(sec * 2), sec * 2); assertEquals(sec / 2, r.read(buf, 0, sec)) // half a second left, then buffering
    r.write(ByteArray(sec * 4 * 22), sec * 4 * 22); r.read(buf, 0, 480)
    assertEquals(5.0, (r.end - r.positionFrames).toDouble() / sec, 0.02)
  }

  /** Measured on the phone: the backlog lands over about a second, so the first jump happens before all of it arrived. */
  @Test fun aBacklogArrivingInPartsStillEndsAtLive() {
    val sec = 48000; val r = RadioRing(sec * 60); val buf = Array(2) { FloatArray(sec * 30) }
    repeat(12) { r.write(ByteArray(sec * 4), sec * 4); r.read(buf, 0, sec) }
    r.read(buf, 0, sec)                                                   // stalled
    r.write(ByteArray(sec * 4 * 4), sec * 4 * 4); r.read(buf, 0, 480)       // first 4 s of the backlog
    r.write(ByteArray(sec * 4 * 18), sec * 4 * 18); r.read(buf, 0, 480)     // the other 18 s
    assertEquals(5.0, (r.end - r.positionFrames).toDouble() / sec, 0.02)
  }

  /** RADIO-SMOOTH-001 (owner, 2026-11-20): "the radio sometimes plays back really choppy". Measured: Power 92 delivers
   *  in bursts with gaps up to 3.9 s; 2 s kept before the newest audio ran dry nine times in 45 s, then skipped ahead.
   *  Replay it: 4 s of audio at once every 4 s, read in 100 ms steps as the engine does. */
  @Test fun aStationSendingFourSecondBurstsPlaysWithoutAGap() {
    val r = RadioRing(48000 * 120); val step = 4800; val buf = Array(2) { FloatArray(step) }; var dry = 0; var skipped = 0
    r.write(ByteArray(48000 * 4 * 8), 48000 * 4 * 8)
    for (tick in 0 until 600) {
      if (tick % 40 == 0) r.write(ByteArray(48000 * 4 * 4), 48000 * 4 * 4)
      val before = r.positionFrames; val got = if (r.ready) r.read(buf, 0, step) else 0
      if (r.heard > 48000L * 10) { if (got < step) dry++; if (r.positionFrames - before > got) skipped++ }
    }
    assertEquals(0, dry); assertEquals(0, skipped)
  }

  /** RADIO-SMOOTH-001: the audio thread shares the ring's lock with the decoder and the fingerprint sampler. Reading
   *  the 10-minute disk file under it (12 s for every fingerprint) stalled playback on a busy phone, so the newest 30 s
   *  are also kept in memory and only an older rewind reads the disk. */
  @Test fun playbackAndFingerprintSamplesNearLiveNeverReadTheDisk() {
    val file = java.io.File.createTempFile("radio-tail-test", ".pcm", java.io.File(System.getenv("TMPDIR") ?: System.getProperty("java.io.tmpdir")!!))
    val sec = 48000; val r = RadioRing(sec * 120, file); val buf = Array(2) { FloatArray(sec) }
    for (i in 0 until 60) { val b = ByteArray(sec * 4) { (i + 1).toByte() }; r.write(b, b.size) }
    assertEquals(sec, r.read(buf, 0, sec)); r.hold()                   // joins 5 s before live: second 56
    assertEquals(12 * sec / 3 * 2, r.sample().size)
    assertEquals(0, r.diskReads)
    assertEquals(((56 shl 8) or 56).toShort().toFloat() / 32768f, buf[0][0], 0f) // the 56th second, from memory
    r.seekTo(sec * 5L); assertEquals(sec, r.read(buf, 0, sec))         // a long rewind is read back from the disk
    assertTrue(r.diskReads > 0)
    assertEquals(((6 shl 8) or 6).toShort().toFloat() / 32768f, buf[0][0], 0f)
    r.close()
  }

  @Test fun theFirstSoundWaitsForASecondSoItDoesNotStartAndStop() {
    val r = RadioRing(48000 * 60); val buf = Array(2) { FloatArray(4800) }
    r.write(ByteArray(48000 * 2), 48000 * 2)                              // half a second arrived
    assertFalse(r.ready); assertEquals(0, r.read(buf, 0, 4800))
    r.write(ByteArray(48000 * 2), 48000 * 2)                              // 1 s
    assertTrue(r.ready); assertEquals(4800, r.read(buf, 0, 4800))
  }

  @Test fun afterRunningDryPlaybackWaitsForASecondAndAHalf() {
    val sec = 48000; val r = RadioRing(sec * 60); val buf = Array(2) { FloatArray(sec) }
    repeat(12) { r.write(ByteArray(sec * 4), sec * 4); r.read(buf, 0, sec) }
    assertEquals(0, r.read(buf, 0, sec))                                  // network stall
    r.write(ByteArray(sec * 2), sec * 2)                                  // half a second back
    assertFalse(r.ready); assertEquals(0, r.read(buf, 0, 4800))
    r.write(ByteArray(sec * 4), sec * 4)                                  // 1.5 s back
    assertTrue(r.ready); assertEquals(4800, r.read(buf, 0, 4800))
  }
}
