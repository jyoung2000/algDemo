package com.nowplaying.discovery

import android.content.Context
import android.net.Uri
import androidx.media3.common.util.UnstableApi
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.nowplaying.discovery.dsp.TransitionStyle
import com.nowplaying.discovery.engine.AudioEngine
import com.nowplaying.discovery.engine.AudioOutput
import com.nowplaying.discovery.engine.CrossfadePlanner
import com.nowplaying.discovery.engine.DecodedSource
import com.nowplaying.discovery.engine.EqJson
import com.nowplaying.discovery.engine.PcmSource
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * The EQ and the crossfade on REAL songs, through the service's own engine on the device.
 *
 * Not part of the normal suite's evidence on its own: it needs two real songs the test cannot ship
 * (copied into `files/real-music/a.*` and `b.*` with `run-as`, plus `configs.json`, the page's EQ
 * configs generated from eq.ts). Without them it is skipped. With them it decodes the songs with the
 * phone's own decoder, plays them through [AudioEngine] exactly as the service does (same EQ JSON
 * parse, same crossfade planner, same mixer), and writes, to `files/real-music/out/`:
 * - the decoded input (`a-seg.f32`, `a-tail.f32`, `b-head.f32`), so the app's Web Audio graph can be
 *   rendered on exactly the same samples on the host and compared;
 * - what the engine played for each EQ setting (`eq-<name>.f32`), a live EQ change (`eq-live.f32`) and
 *   a real crossfade (`xfade.f32`), with the frames where things happened in `meta.json`.
 * All `.f32` files are interleaved stereo little-endian float32 at 48 kHz.
 */
@UnstableApi
@RunWith(AndroidJUnit4::class)
class RealMusicTest {
  private val ctx: Context get() = ApplicationProvider.getApplicationContext()
  private val dir get() = File(ctx.filesDir, "real-music")
  private val outDir get() = File(dir, "out").apply { mkdirs() }
  private fun song(name: String) = dir.listFiles()?.firstOrNull { it.name.startsWith("$name.") && !it.name.endsWith(".json") }

  /** A decoded stretch of a song held in memory, reporting the song's real length and positions. */
  private class MemorySource(private val from: Long, private val pcm: Array<FloatArray>, override val durationFrames: Long) : PcmSource {
    private var i = 0
    private val size = pcm[0].size
    override val positionFrames get() = from + i
    override val ready get() = true
    override val ended get() = i >= size && from + size >= durationFrames
    override val error: Throwable? get() = null
    override fun read(dst: Array<FloatArray>, offset: Int, frames: Int): Int {
      val n = minOf(frames, size - i)
      if (n <= 0) return 0
      System.arraycopy(pcm[0], i, dst[0], offset, n)
      System.arraycopy(pcm[1], i, dst[1], offset, n)
      i += n
      return n
    }
    override fun seekTo(frame: Long) { i = (frame - from).coerceIn(0, size.toLong()).toInt() }
    override fun close() {}
  }

  private class Decoded(val from: Long, val pcm: Array<FloatArray>, val duration: Long) {
    fun source() = MemorySource(from, pcm, duration)
  }

  /** Decode [frames] frames of [file] from [from] (or to the end, if shorter) with the phone's decoder. */
  private fun decode(file: File, from: Long, frames: Long?): Decoded {
    val src = DecodedSource(ctx, Uri.fromFile(file))
    try {
      val deadline0 = System.currentTimeMillis() + 10_000
      while (src.durationFrames == PcmSource.UNKNOWN && System.currentTimeMillis() < deadline0) Thread.sleep(5)
      val duration = src.durationFrames
      assertTrue("decoder knows the song's length", duration > 0)
      val want = (frames ?: (duration - from)).coerceAtMost(duration - from).toInt()
      src.seekTo(from)
      val pcm = arrayOf(FloatArray(want), FloatArray(want))
      var got = 0
      val deadline = System.currentTimeMillis() + 120_000
      while (got < want && !src.ended && System.currentTimeMillis() < deadline) {
        val n = src.read(pcm, got, minOf(4096, want - got))
        if (n == 0) Thread.sleep(1) else got += n
      }
      assertTrue("decoded $got of $want frames", got >= want - 2048)
      return Decoded(from, if (got == want) pcm else arrayOf(pcm[0].copyOf(got), pcm[1].copyOf(got)), duration)
    } finally {
      src.close()
    }
  }

  /** Captures everything the engine writes, interleaved stereo. */
  private class Capture : AudioOutput {
    override val sampleRate = 48000
    var buf = FloatArray(48000 * 2 * 30)
    var frames = 0
    override fun write(interleaved: FloatArray, frames: Int): Int {
      val need = (this.frames + frames) * 2
      if (need > buf.size) buf = buf.copyOf(maxOf(buf.size * 2, need))
      System.arraycopy(interleaved, 0, buf, this.frames * 2, frames * 2)
      this.frames += frames
      return frames
    }
    override fun play() {}
    override fun pause() {}
    override fun flush() {}
    override fun pendingFrames(): Long = 0
    override fun close() {}
  }

  private fun write(name: String, interleaved: FloatArray, frames: Int) {
    val bb = ByteBuffer.allocate(frames * 8).order(ByteOrder.LITTLE_ENDIAN)
    bb.asFloatBuffer().put(interleaved, 0, frames * 2)
    File(outDir, name).writeBytes(bb.array())
  }

  private fun write(name: String, d: Decoded) {
    val n = d.pcm[0].size
    val inter = FloatArray(n * 2)
    for (i in 0 until n) { inter[2 * i] = d.pcm[0][i]; inter[2 * i + 1] = d.pcm[1][i] }
    write(name, inter, n)
  }

  @Test fun realSongsThroughTheEqAndTheCrossfade() {
    val a = song("a"); val b = song("b")
    val configsFile = File(dir, "configs.json")
    assumeTrue("real songs not provided (see the class comment)", a != null && b != null && configsFile.exists())
    val configs = JSONObject(configsFile.readText())
    val meta = JSONObject()

    // EQ: 20 s of song A from 60 s, once per setting, each through a fresh engine as the service builds it.
    val segFrom = 60L * 48000
    val segFrames = 20L * 48000
    val seg = decode(a!!, segFrom, segFrames)
    write("a-seg.f32", seg)
    meta.put("segFrom", segFrom).put("segFrames", seg.pcm[0].size).put("aDuration", seg.duration)
    val quanta = seg.pcm[0].size / 128
    for (name in configs.keys()) {
      val cap = Capture()
      val engine = AudioEngine(cap, CrossfadePlanner, initialEq = EqJson.parse(configs.getJSONObject(name)))
      engine.load("a", seg.source(), segFrom)
      engine.renderQuanta(quanta)
      engine.close()
      assertEquals("rendered all of $name", quanta * 128, cap.frames)
      write("eq-$name.f32", cap.buf, cap.frames)
    }
    // A slider change while the song plays: EQ off, then Bass booster from 5 s.
    run {
      val cap = Capture()
      val engine = AudioEngine(cap, CrossfadePlanner, initialEq = EqJson.parse(configs.getJSONObject("off")))
      engine.load("a", seg.source(), segFrom)
      engine.renderQuanta(LIVE_AT / 128)
      engine.setEq(EqJson.parse(configs.getJSONObject("bass-booster")))
      engine.renderQuanta(quanta - LIVE_AT / 128)
      engine.close()
      write("eq-live.f32", cap.buf, cap.frames)
      meta.put("liveAt", LIVE_AT)
    }

    // Crossfade: A's last stretch into B, at the mixer slider and play-through the app defaults to.
    val bHead = decode(b!!, 0, 40L * 48000)
    val plan = CrossfadePlanner.plan(MIX, seg.duration / 48000.0, bHead.duration / 48000.0, PLAY_THROUGH / 100.0)
    assertTrue("the app's planner blends these two songs ($plan)", plan.seconds > 1)
    val tailFrom = ((plan.startAt - 10) * 48000).toLong()
    val tail = decode(a, tailFrom, null)
    write("a-tail.f32", tail)
    write("b-head.f32", bHead)
    val cap = Capture()
    var blendFrame = -1L; var blendSeconds = 0.0; var blendStyle: TransitionStyle? = null; var advancedFrame = -1L
    lateinit var engine: AudioEngine
    engine = AudioEngine(cap, CrossfadePlanner, object : AudioEngine.Listener {
      override fun onBlendStarted(key: String, seconds: Double, style: TransitionStyle) {
        blendFrame = engine.bus.ctx.currentSampleFrame; blendSeconds = seconds; blendStyle = style
      }
      override fun onAdvanced(key: String, outgoing: AudioEngine.Heard) { advancedFrame = engine.bus.ctx.currentSampleFrame }
    }, EqJson.parse(configs.getJSONObject("off")))
    engine.setMix(MIX)
    engine.setPlayThrough(PLAY_THROUGH)
    engine.load("a", tail.source(), tailFrom)
    engine.setNext("b", bHead.source())
    val total = tail.pcm[0].size + 8 * 48000
    engine.renderQuanta(total / 128)
    engine.close()
    write("xfade.f32", cap.buf, cap.frames)
    assertTrue("the blend started", blendFrame > 0)
    assertTrue("B took over when A ended", advancedFrame > blendFrame)
    meta.put("mix", MIX).put("playThrough", PLAY_THROUGH).put("tailFrom", tailFrom).put("bDuration", bHead.duration)
      .put("planStartAt", plan.startAt).put("planSeconds", plan.seconds).put("planStyle", plan.style.id)
      .put("blendFrame", blendFrame).put("blendSeconds", blendSeconds).put("blendStyle", blendStyle!!.id)
      .put("advancedFrame", advancedFrame).put("xfadeFrames", cap.frames)
    File(outDir, "meta.json").writeText(meta.toString(1))
    android.util.Log.i("RealMusicTest", meta.toString())
  }

  private companion object {
    const val MIX = 60
    const val PLAY_THROUGH = 95
    const val LIVE_AT = 5 * 48000
  }
}
