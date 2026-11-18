package com.nowplaying.discovery

import android.content.Context
import android.net.Uri
import android.os.SystemClock
import androidx.media3.common.util.UnstableApi
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.nowplaying.discovery.dsp.TransitionStyle
import com.nowplaying.discovery.engine.AudioEngine
import com.nowplaying.discovery.engine.AudioOutput
import com.nowplaying.discovery.engine.BeatGrid
import com.nowplaying.discovery.engine.BlendPlan
import com.nowplaying.discovery.engine.CrossfadeCuePlanner
import com.nowplaying.discovery.engine.CrossfadePlanner
import com.nowplaying.discovery.engine.CueReader
import com.nowplaying.discovery.engine.DecodedSource
import com.nowplaying.discovery.engine.PcmSource
import com.nowplaying.discovery.engine.TrackCues
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Real-song proof of the hard decoder-end handoff. Measured and unmeasured runs must both
 * preserve every original frame, then fade in the next song from frame zero without cue skipping.
 * Requires owner-provided <n>-a.<ext>/<n>-b.<ext> in files/real-music/dj; otherwise skipped.
 * Writes mix and isolated stems plus metadata to files/real-music/dj/out for host inspection.
 */
@UnstableApi
@RunWith(AndroidJUnit4::class)
class DjCrossfadeDeviceTest {
  private val ctx: Context get() = ApplicationProvider.getApplicationContext()
  private val dir get() = File(ctx.filesDir, "real-music/dj")
  private val outDir get() = File(dir, "out").apply { mkdirs() }

  private class MemorySource(private val from: Long, private val pcm: Array<FloatArray>, override val durationFrames: Long) : PcmSource {
    private var i = 0
    private val size = pcm[0].size
    override val positionFrames get() = from + i
    override val ready get() = true
    override val ended get() = i >= size
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
    fun source(silent: Boolean = false) = MemorySource(from, if (silent) arrayOf(FloatArray(pcm[0].size), FloatArray(pcm[0].size)) else pcm, duration)
  }

  private fun decode(file: File, from: Long, frames: Long?): Decoded {
    val src = DecodedSource(ctx, Uri.fromFile(file))
    try {
      val duration = src.durationFrames
      assertTrue("decoder knows the song's length", duration > 0)
      src.seekTo(from)
      var pcm = arrayOf(FloatArray(48000 * 20), FloatArray(48000 * 20))
      var got = 0
      val deadline = System.currentTimeMillis() + 120_000
      while (!src.ended && (frames == null || got < frames) && System.currentTimeMillis() < deadline) {
        val want = minOf(4096, if (frames == null) 4096 else (frames - got).toInt())
        if (got + want > pcm[0].size) pcm = arrayOf(pcm[0].copyOf(pcm[0].size * 2), pcm[1].copyOf(pcm[1].size * 2))
        val n = src.read(pcm, got, want)
        if (n == 0) Thread.sleep(1) else got += n
      }
      assertTrue("decoder reached EOS or requested head limit", src.ended || (frames != null && got >= frames))
      return Decoded(from, arrayOf(pcm[0].copyOf(got), pcm[1].copyOf(got)), duration)
    } finally {
      src.close()
    }
  }

  private class Capture : AudioOutput {
    override val sampleRate = 48000
    var buf = FloatArray(48000 * 2 * 40)
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

  private fun write(name: String, cap: Capture) {
    val bb = ByteBuffer.allocate(cap.frames * 8).order(ByteOrder.LITTLE_ENDIAN)
    bb.asFloatBuffer().put(cap.buf, 0, cap.frames * 2)
    File(outDir, name).writeBytes(bb.array())
  }

  private fun json(g: BeatGrid?) = if (g == null) JSONObject.NULL else JSONObject().put("bpm", g.bpm).put("beatAt", g.beatAt).put("confidence", g.confidence)
  private fun json(c: TrackCues) = JSONObject().put("duration", c.duration).put("start", c.start).put("end", c.end).put("fullEnd", c.fullEnd).put("head", json(c.head)).put("tail", json(c.tail))

  private class Run(val blendFrame: Long, val blendSeconds: Double, val advancedFrame: Long, val plan: BlendPlan?, val frames: Int)

  /** Play the full decoded tail into B; cue presence must not change the completion boundary. */
  private fun render(name: String, a: Decoded, b: Decoded, from: Long, cues: Pair<TrackCues, TrackCues>?, silentA: Boolean, silentB: Boolean, seconds: Double): Run {
    val cap = Capture()
    var blendFrame = -1L; var blendSeconds = 0.0; var advancedFrame = -1L; var plan: BlendPlan? = null
    lateinit var engine: AudioEngine
    engine = AudioEngine(cap, CrossfadePlanner, object : AudioEngine.Listener {
      override fun onBlendStarted(key: String, seconds: Double, style: TransitionStyle) { blendFrame = engine.bus.ctx.currentSampleFrame; blendSeconds = seconds }
      override fun onBlendPlanned(key: String, plan_: BlendPlan) { plan = plan_ }
      override fun onAdvanced(key: String, outgoing: AudioEngine.Heard) { advancedFrame = engine.bus.ctx.currentSampleFrame }
    }, cuePlanner = if (cues != null) CrossfadeCuePlanner else null)
    engine.setMix(MIX)
    engine.setPlayThrough(PLAY_THROUGH)
    engine.load("a", a.source(silentA), from)
    engine.setNext("b", b.source(silentB))
    if (cues != null) { engine.setCues("a", cues.first); engine.setCues("b", cues.second) }
    engine.renderQuanta((seconds * 48000 / 128).toInt())
    engine.close()
    write(name, cap)
    return Run(blendFrame, blendSeconds, advancedFrame, plan, cap.frames)
  }

  @Test fun realSongsPreserveTheEntireDecodedTailBeforeNextSongFadeIn() {
    val pairs = (dir.listFiles() ?: emptyArray()).mapNotNull { Regex("^(\\d+)-a\\.").find(it.name)?.groupValues?.get(1) }.distinct().sorted()
    assumeTrue("real songs not provided (see the class comment)", pairs.isNotEmpty())
    val meta = JSONArray()
    for (n in pairs) {
      val fa = dir.listFiles()!!.first { it.name.startsWith("$n-a.") }
      val fb = dir.listFiles()!!.first { it.name.startsWith("$n-b.") }
      // The phone measures both songs itself, the way the service does while the song before plays.
      val t0 = SystemClock.elapsedRealtime()
      val ca = requireNotNull(CueReader.read(ctx, Uri.fromFile(fa))); val t1 = SystemClock.elapsedRealtime()
      val cb = requireNotNull(CueReader.read(ctx, Uri.fromFile(fb))); val t2 = SystemClock.elapsedRealtime()
      assertNotNull("cues for ${fa.name}", ca); assertNotNull("cues for ${fb.name}", cb)
      val durA = DecodedSource(ctx, Uri.fromFile(fa)).let { s -> s.durationFrames.also { s.close() } }
      val outSeconds = durA / 48000.0
      val bHead = decode(fb, 0, 60L * 48000)
      val from = ((outSeconds - LEAD_SECONDS) * 48000).toLong().coerceAtLeast(0) / 128 * 128
      val tail = decode(fa, from, null)
      val seconds = tail.pcm[0].size / 48000.0 + 6
      val entry = JSONObject().put("pair", n).put("a", fa.name).put("b", fb.name).put("from", from).put("aDuration", durA).put("aDecodedEnd", from + tail.pcm[0].size)
        .put("cuesA", json(ca)).put("cuesB", json(cb)).put("cueMsA", t1 - t0).put("cueMsB", t2 - t1)
      for (kind in listOf("uncued", "measured")) {
        val cues = if (kind == "measured") ca to cb else null
        val mix = render("$n-$kind-mix.f32", tail, bHead, from, cues, false, false, seconds)
        render("$n-$kind-a.f32", tail, bHead, from, cues, false, true, seconds)
        render("$n-$kind-b.f32", tail, bHead, from, cues, true, false, seconds)
        val actualEnd = tail.pcm[0].size.toLong()
        assertTrue("$n $kind: no transition before actual decoded end ($actualEnd): ${mix.blendFrame}", mix.blendFrame - actualEnd in 0..127)
        assertEquals("metadata promotes at the start of the post-end fade", mix.blendFrame, mix.advancedFrame)
        assertEquals("legacy cue plans never schedule live overlap", null, mix.plan)
        val expectedFade = minOf(2.0, com.nowplaying.discovery.engine.Crossfade.requestedSeconds(MIX.toDouble()), bHead.duration / 48000.0 * 0.1)
        assertEquals(expectedFade, mix.blendSeconds, 0.000001)
        // The isolated incoming stem must be exactly silent over every decoded original frame.
        val bytes = File(outDir, "$n-$kind-b.f32").readBytes()
        val incoming = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer()
        for (i in 0 until (mix.blendFrame * 2).toInt()) {
          assertEquals("$n $kind: incoming leaked at sample $i", 0.0, incoming.get(i).toDouble(), 0.0)
        }
        entry.put(kind, JSONObject().put("blendFrame", mix.blendFrame).put("blendSeconds", mix.blendSeconds)
          .put("advancedFrame", mix.advancedFrame).put("frames", mix.frames).put("inStart", 0.0).put("rate", 1.0).put("style", "blend"))
      }
      meta.put(entry)
    }
    File(outDir, "meta.json").writeText(meta.toString(1))
    android.util.Log.i("DjCrossfadeDeviceTest", "pairs=${meta.length()}")
  }

  private companion object {
    const val MIX = 60
    const val PLAY_THROUGH = 95
    const val LEAD_SECONDS = 12.0
  }
}
