package com.nowplaying.discovery

import android.content.Context
import android.net.Uri
import android.os.Looper
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.nowplaying.discovery.engine.AudioOutput
import com.nowplaying.discovery.engine.BlendPlan
import com.nowplaying.discovery.engine.BlendPlanner
import com.nowplaying.discovery.engine.DecodedSource
import com.nowplaying.discovery.engine.EnginePlayer
import com.nowplaying.discovery.dsp.TransitionStyle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * The native engine on a real device: the platform codec decodes real files, the resampler brings
 * them to 48 kHz, and [EnginePlayer] plays a queue with no Activity and no WebView involved.
 * Every file is a WAV written by the test with a known tone, so each assertion measures audio
 * against an exact expectation instead of trusting that "something played".
 */
@UnstableApi
@RunWith(AndroidJUnit4::class)
class NativeEngineTest {
  private val ctx: Context get() = ApplicationProvider.getApplicationContext()
  private val instr get() = InstrumentationRegistry.getInstrumentation()

  /** A 16-bit PCM WAV of a sine at [hz], amplitude 0.5, [channels] channels, at [rate]. */
  private fun wav(name: String, hz: Double, seconds: Double, rate: Int = 44100, channels: Int = 2): Uri {
    val frames = (seconds * rate).toInt()
    val data = ByteBuffer.allocate(frames * channels * 2).order(ByteOrder.LITTLE_ENDIAN)
    for (i in 0 until frames) {
      val v = (0.5 * sin(2 * PI * hz * i / rate) * 32767).toInt().toShort()
      repeat(channels) { data.putShort(v) }
    }
    val f = File(ctx.cacheDir, name)
    RandomAccessFile(f, "rw").use { raf ->
      raf.setLength(0)
      val h = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
      h.put("RIFF".toByteArray()).putInt(36 + data.capacity()).put("WAVE".toByteArray())
      h.put("fmt ".toByteArray()).putInt(16).putShort(1).putShort(channels.toShort()).putInt(rate)
        .putInt(rate * channels * 2).putShort((channels * 2).toShort()).putShort(16)
      h.put("data".toByteArray()).putInt(data.capacity())
      raf.write(h.array())
      raf.write(data.array())
    }
    return Uri.fromFile(f)
  }

  /** Read [frames] frames from [src], waiting for the decoder (bounded), as the engine would over time. */
  private fun readAll(src: DecodedSource, frames: Int): Array<FloatArray> {
    val out = arrayOf(FloatArray(frames), FloatArray(frames))
    var got = 0
    val deadline = System.currentTimeMillis() + 10_000
    while (got < frames && !src.ended && System.currentTimeMillis() < deadline) {
      val n = src.read(out, got, minOf(1024, frames - got))
      if (n == 0) Thread.sleep(2) else got += n
    }
    assertEquals("decoded every frame asked for", frames, got)
    return out
  }

  /** Estimated frequency from zero crossings, and RMS, over [x]. */
  private fun measure(x: FloatArray, rate: Double = 48000.0): Pair<Double, Double> {
    var crossings = 0
    for (i in 1 until x.size) if (x[i - 1] < 0 && x[i] >= 0) crossings++
    val rms = sqrt(x.sumOf { (it * it).toDouble() } / x.size)
    return crossings * rate / x.size to rms
  }

  @Test fun decodesAndResamplesToFortyEightKilohertzWithTheRightPitchAndLevel() {
    for (rate in listOf(44100, 48000, 22050)) {
      val src = DecodedSource(ctx, wav("tone-$rate.wav", 1000.0, 3.0, rate))
      try {
        assertEquals("duration in engine frames at $rate", 3.0 * 48000, src.durationFrames.toDouble(), 48.0)
        val pcm = readAll(src, 48000 * 2)
        val (hz, rms) = measure(pcm[0].copyOfRange(4800, pcm[0].size - 4800))
        assertEquals("pitch survives resampling from $rate", 1000.0, hz, 2.0)
        assertEquals("level survives resampling from $rate", 0.5 / sqrt(2.0), rms, 0.005)
        assertTrue("right channel decoded too", pcm[1].copyOfRange(4800, 9600).any { abs(it) > 0.1f })
      } finally {
        src.close()
      }
    }
  }

  /** An AAC-LC .m4a of a [hz] sine (amplitude 0.5, stereo, 44.1 kHz), encoded on the device. */
  private fun m4a(name: String, hz: Double, seconds: Double): Uri {
    val rate = 44100
    val f = File(ctx.cacheDir, name).apply { delete() }
    val fmt = android.media.MediaFormat.createAudioFormat(android.media.MediaFormat.MIMETYPE_AUDIO_AAC, rate, 2).apply {
      setInteger(android.media.MediaFormat.KEY_AAC_PROFILE, android.media.MediaCodecInfo.CodecProfileLevel.AACObjectLC)
      setInteger(android.media.MediaFormat.KEY_BIT_RATE, 256_000)
      setInteger(android.media.MediaFormat.KEY_MAX_INPUT_SIZE, 16384)
    }
    val enc = android.media.MediaCodec.createEncoderByType(android.media.MediaFormat.MIMETYPE_AUDIO_AAC)
    enc.configure(fmt, null, null, android.media.MediaCodec.CONFIGURE_FLAG_ENCODE)
    enc.start()
    val mux = android.media.MediaMuxer(f.path, android.media.MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
    var track = -1
    val total = (seconds * rate).toInt()
    var fed = 0
    var inputDone = false
    val info = android.media.MediaCodec.BufferInfo()
    while (true) {
      if (!inputDone) {
        val i = enc.dequeueInputBuffer(10_000)
        if (i >= 0) {
          val buf = enc.getInputBuffer(i)!!.order(ByteOrder.LITTLE_ENDIAN)
          val frames = minOf(buf.remaining() / 4, total - fed, 1024)
          for (k in 0 until frames) {
            val v = (0.5 * sin(2 * PI * hz * (fed + k) / rate) * 32767).toInt().toShort()
            buf.putShort(v); buf.putShort(v)
          }
          val pts = fed * 1_000_000L / rate
          fed += frames
          inputDone = fed >= total
          enc.queueInputBuffer(i, 0, frames * 4, pts, if (inputDone) android.media.MediaCodec.BUFFER_FLAG_END_OF_STREAM else 0)
        }
      }
      val o = enc.dequeueOutputBuffer(info, 10_000)
      if (o == android.media.MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) { track = mux.addTrack(enc.outputFormat); mux.start() }
      else if (o >= 0) {
        if (info.size > 0 && (info.flags and android.media.MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0) mux.writeSampleData(track, enc.getOutputBuffer(o)!!, info)
        enc.releaseOutputBuffer(o, false)
        if ((info.flags and android.media.MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) break
      }
    }
    enc.stop(); enc.release(); mux.stop(); mux.release()
    return Uri.fromFile(f)
  }

  @Test fun decodesARealCompressedSongTheWayDownloadsAreStored() {
    // The downloader stores AAC/Opus, not WAV: this is the path real songs take (compressed codec,
    // float output requested), so pitch, level, length and a seek are measured on it too.
    val src = DecodedSource(ctx, m4a("tone.m4a", 1000.0, 3.0))
    try {
      assertEquals("duration", 3.0 * 48000, src.durationFrames.toDouble(), 0.05 * 48000)
      val pcm = readAll(src, 96000)
      val (hz, rms) = measure(pcm[0].copyOfRange(9600, 86400))
      assertEquals("pitch", 1000.0, hz, 2.0)
      assertEquals("level within 0.2 dB", 0.5 / sqrt(2.0), rms, 0.5 / sqrt(2.0) * 0.023)
      src.seekTo(48000)
      assertEquals(48000L, src.positionFrames)
      val after = readAll(src, 48000)
      val (hz2, rms2) = measure(after[0].copyOfRange(2400, 45600))
      assertEquals("pitch after seek", 1000.0, hz2, 2.0)
      assertEquals("level after seek", rms, rms2, rms * 0.023)
    } finally {
      src.close()
    }
  }

  @Test fun monoFilesPlayOnBothSides() {
    val src = DecodedSource(ctx, wav("mono.wav", 440.0, 1.0, 48000, channels = 1))
    try {
      val pcm = readAll(src, 24000)
      for (i in 2000 until 24000 step 97) assertEquals(pcm[0][i], pcm[1][i], 1e-6f)
    } finally {
      src.close()
    }
  }

  @Test fun seeksAreSampleAccurate() {
    // At 48 kHz in and out there is no resampling, so after a seek the very first frame must be the
    // tone's exact value at the target: proof that nothing before the target leaks through.
    val src = DecodedSource(ctx, wav("seek.wav", 997.0, 6.0, 48000))
    try {
      readAll(src, 4800)
      for (target in listOf(100_000L, 7L, 250_123L, 48_000L)) {
        src.seekTo(target)
        assertEquals(target, src.positionFrames)
        val pcm = readAll(src, 256)
        for (k in 0 until 256) {
          val want = (0.5 * sin(2 * PI * 997.0 * (target + k) / 48000) * 32767).toInt().toShort() / 32768f
          assertEquals("frame ${target + k}", want, pcm[0][k], 2e-4f)
        }
        assertEquals(target + 256, src.positionFrames)
      }
    } finally {
      src.close()
    }
  }

  @Test fun reachesTheEndAndReportsIt() {
    val src = DecodedSource(ctx, wav("short.wav", 500.0, 0.5, 44100))
    try {
      val got = arrayOf(FloatArray(48000), FloatArray(48000))
      var total = 0
      val deadline = System.currentTimeMillis() + 5000
      while (!src.ended && System.currentTimeMillis() < deadline) {
        val n = src.read(got, total, minOf(1024, 48000 - total))
        if (n == 0) Thread.sleep(2) else total += n
      }
      assertTrue("ended", src.ended)
      assertEquals("all 0.5 s, no more, no less", 24000.0, total.toDouble(), 64.0)
    } finally {
      src.close()
    }
  }

  /** Records what the engine plays, paced like a real device (it blocks, as AudioTrack does). */
  private class PacedOutput : AudioOutput {
    override val sampleRate = 48000
    val left = ArrayList<Float>(48000 * 20)
    @Volatile var playing = false
    override fun write(interleaved: FloatArray, frames: Int): Int {
      synchronized(left) { for (i in 0 until frames) left += interleaved[2 * i] }
      Thread.sleep((frames * 1000L / 48000).coerceAtLeast(1) / 4) // 4x real time keeps the test short
      return frames
    }
    override fun play() { playing = true }
    override fun pause() { playing = false }
    override fun flush() {}
    override fun pendingFrames(): Long = 0
    override fun close() {}
  }

  @Test fun theServicePlayerPlaysAQueueToTheEndWithoutTheApp() {
    val songs = listOf(
      MediaHub.Song("s1", "One", "A", null, null, 2000, ready = true, source = "x:s1"),
      MediaHub.Song("s2", "Two (not on the phone)", "A", null, null, 2000, ready = true, source = "x:s2"),
      MediaHub.Song("s3", "Three", "A", null, null, 1000, ready = true, source = "x:s3"),
    )
    val files = mapOf("s1" to wav("q1.wav", 440.0, 2.0), "s3" to wav("q3.wav", 880.0, 1.0))
    val out = PacedOutput()
    val planner = BlendPlanner { _, _, _, _ -> BlendPlan(0.0, 0.0, TransitionStyle.CUT) }
    val player = AtomicReference<EnginePlayer>()
    instr.runOnMainSync {
      val p = EnginePlayer(
        ctx, Looper.getMainLooper(), planner,
        resolve = { files[it.id] },
        lookup = { id -> songs.firstOrNull { it.id == id } },
        output = out,
        manageFocus = false,
      )
      p.setMediaItems(songs.map { MediaItem.Builder().setMediaId(it.id).build() }, 0, 0)
      p.prepare()
      p.play()
      player.set(p)
    }
    val seen = ArrayList<String>()
    val deadline = System.currentTimeMillis() + 15_000
    var state = Player.STATE_IDLE
    while (System.currentTimeMillis() < deadline) {
      instr.runOnMainSync {
        state = player.get().playbackState
        val id = player.get().currentMediaItem?.mediaId
        if (id != null && seen.lastOrNull() != id) seen += id
      }
      if (state == Player.STATE_ENDED) break
      Thread.sleep(20)
    }
    instr.runOnMainSync { player.get().release() }
    assertEquals("reached the end", Player.STATE_ENDED, state)
    assertEquals("played 1 then 3, skipping the song that is not on the phone", listOf("s1", "s3"), seen)
    // The audio itself: 2 s of 440 Hz, then (after however long song 3 takes to open) 1 s of 880 Hz.
    val pcm = synchronized(out.left) { out.left.toFloatArray() }
    val onset = pcm.indexOfFirst { abs(it) > 0.01f }
    val last = pcm.indexOfLast { abs(it) > 0.01f }
    assertTrue("sound started", onset >= 0)
    val (hz1, _) = measure(pcm.copyOfRange(onset + 4800, onset + 4800 + 48000))
    val (hz3, _) = measure(pcm.copyOfRange(last - 36000, last - 12000))
    assertEquals("first song is the 440 Hz file", 440.0, hz1, 3.0)
    assertEquals("the last song is the 880 Hz file", 880.0, hz3, 3.0)
    val gap = (last - onset + 1) - 3 * 48000
    assertTrue("the whole of both songs played, nothing cut (gap ${gap} frames)", gap >= -64)
    assertTrue("no long silence between songs (gap ${gap} frames)", gap < 48000 / 2)
  }
}
