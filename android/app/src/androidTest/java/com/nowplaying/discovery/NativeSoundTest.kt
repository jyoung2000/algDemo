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
import com.nowplaying.discovery.engine.Crossfade
import com.nowplaying.discovery.engine.EngineHub
import com.nowplaying.discovery.engine.EnginePlayer
import com.nowplaying.discovery.engine.MixInputs
import com.nowplaying.discovery.engine.EqJson
import com.nowplaying.discovery.dsp.EqMath
import org.json.JSONArray
import org.json.JSONObject
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
import kotlin.math.cos
import kotlin.math.log10
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * The EQ and the DJ crossfade, heard through the service's own player on the device.
 *
 * Every setting goes in the way the page sends it (`{op:"settings", eq, mix, playThrough}` into
 * [EngineHub], the JSON `eqConfig()` builds), and every assertion measures what the engine wrote
 * to its audio output: the level of a known tone, and when each song's tone starts and stops.
 * The DSP math itself is checked against the app's Web Audio graph in the JVM tests; this checks
 * that the settings reach the sound on a phone and do what the controls say (EQ-NATIVE,
 * SOLFEGGIO-001, MIXER-PLAY-THROUGH-001/002).
 */
@UnstableApi
@RunWith(AndroidJUnit4::class)
class NativeSoundTest {
  private val ctx: Context get() = ApplicationProvider.getApplicationContext()
  private val instr get() = InstrumentationRegistry.getInstrumentation()

  private fun wav(name: String, hz: Double, seconds: Double, amp: Double): Uri {
    val rate = 48000
    val frames = (seconds * rate).toInt()
    val data = ByteBuffer.allocate(frames * 4).order(ByteOrder.LITTLE_ENDIAN)
    for (i in 0 until frames) {
      val v = (amp * sin(2 * PI * hz * i / rate) * 32767).toInt().toShort()
      data.putShort(v); data.putShort(v)
    }
    val f = File(ctx.cacheDir, name)
    RandomAccessFile(f, "rw").use { raf ->
      raf.setLength(0)
      val h = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
      h.put("RIFF".toByteArray()).putInt(36 + data.capacity()).put("WAVE".toByteArray())
      h.put("fmt ".toByteArray()).putInt(16).putShort(1).putShort(2).putInt(rate)
        .putInt(rate * 4).putShort(4).putShort(16)
      h.put("data".toByteArray()).putInt(data.capacity())
      raf.write(h.array())
      raf.write(data.array())
    }
    return Uri.fromFile(f)
  }

  /** Records the left channel into a growable array, paced at about 4x real time like a blocking AudioTrack. */
  private class Recorder : AudioOutput {
    override val sampleRate = 48000
    private var buf = FloatArray(48000 * 30)
    @Volatile var size = 0
      private set
    override fun write(interleaved: FloatArray, frames: Int): Int {
      synchronized(this) {
        if (size + frames > buf.size) buf = buf.copyOf(maxOf(buf.size * 2, size + frames))
        for (i in 0 until frames) buf[size + i] = interleaved[2 * i]
        size += frames
      }
      Thread.sleep((frames * 1000L / 48000).coerceAtLeast(1) / 4)
      return frames
    }
    fun pcm(): FloatArray = synchronized(this) { buf.copyOf(size) }
    override fun play() {}
    override fun pause() {}
    override fun flush() {}
    override fun pendingFrames(): Long = 0
    override fun close() {}
  }

  private fun hubField(name: String) = EngineHub::class.java.getDeclaredField(name).apply { isAccessible = true }

  /**
   * Play [songs] (id to file) through a fresh service player attached to [EngineHub], after sending
   * [settings] as the page does. [during] runs once, from the test thread, after 1.5 s of sound.
   */
  private fun play(songs: List<Pair<String, Uri>>, settings: JSONObject, during: ((Recorder) -> Unit)? = null): Pair<FloatArray, Recorder> {
    val rec = Recorder()
    val list = songs.map { (id, _) -> MediaHub.Song(id, id, "Test", null, null, 0, ready = true, source = "x:$id") }
    val files = songs.toMap()
    val prevPlayer = hubField("player").get(EngineHub) as EnginePlayer?
    val prevSettings = JSONObject((hubField("settings").get(EngineHub) as JSONObject).toString())
    val player = AtomicReference<EnginePlayer>()
    instr.runOnMainSync {
      player.set(EnginePlayer(
        ctx, Looper.getMainLooper(),
        resolve = { files[it.id] },
        lookup = { id -> list.firstOrNull { it.id == id } },
        output = rec,
        manageFocus = false,
      ))
    }
    try {
      EngineHub.attachPlayer(player.get())
      EngineHub.fromPage(settings.put("op", "settings").toString())
      instr.waitForIdleSync()
      instr.runOnMainSync {
        val p = player.get()
        p.setMediaItems(list.map { MediaItem.Builder().setMediaId(it.id).build() }, 0, 0)
        p.prepare()
        p.play()
      }
      var ran = during == null
      var state = Player.STATE_IDLE
      val deadline = System.currentTimeMillis() + 90_000
      while (System.currentTimeMillis() < deadline) {
        instr.runOnMainSync { state = player.get().playbackState }
        if (state == Player.STATE_ENDED) break
        if (!ran && rec.size > 48000 * 3 / 2) { during!!(rec); ran = true }
        Thread.sleep(20)
      }
      assertEquals("played to the end", Player.STATE_ENDED, state)
      return rec.pcm() to rec
    } finally {
      instr.runOnMainSync { player.get().release() }
      EngineHub.detachPlayer(player.get())
      instr.waitForIdleSync()
      hubField("settings").set(EngineHub, prevSettings)
      if (prevPlayer != null) EngineHub.attachPlayer(prevPlayer)
      instr.waitForIdleSync()
    }
  }

  /** Hann-windowed single-bin DFT: the amplitude of [hz] in [x] from [start], [n] frames long. */
  private fun amp(x: FloatArray, hz: Double, start: Int, n: Int = 2400): Double {
    var re = 0.0; var im = 0.0; var wsum = 0.0
    for (k in 0 until n) {
      val w = 0.5 - 0.5 * cos(2 * PI * k / (n - 1))
      val v = x[start + k] * w
      val ph = 2 * PI * hz * (start + k) / 48000
      re += v * cos(ph); im -= v * sin(ph); wsum += w
    }
    return 2 * sqrt(re * re + im * im) / wsum
  }

  private fun db(ratio: Double) = 20 * log10(ratio)

  /** The level of [hz] over one second starting [from] frames after the first sound. */
  private fun level(pcm: FloatArray, hz: Double, from: Int = 14400): Double {
    val onset = pcm.indexOfFirst { kotlin.math.abs(it) > 0.005f }
    assertTrue("sound started", onset >= 0)
    var sum = 0.0
    for (w in 0 until 20) sum += amp(pcm, hz, onset + from + w * 2400)
    return sum / 20
  }

  private fun eq(on: Boolean, gains: DoubleArray = DoubleArray(10), toneHz: Double? = null) = JSONObject()
    .put("on", on).put("presetId", if (toneHz != null) "solfeggio-${toneHz.toInt()}" else "custom")
    .put("gains", JSONArray(gains.toList())).put("preampDb", 0).put("limiter", true)
    .put("toneHz", toneHz ?: JSONObject.NULL).put("toneDb", 6)

  private fun gainsAt(band: Int, db: Double) = DoubleArray(10).also { it[band] = db }

  @Test fun theEqThePageSetsShapesWhatTheServicePlays() {
    val k1 = wav("eq-1k.wav", 1000.0, 3.0, 0.25)
    val k528 = wav("eq-528.wav", 528.0, 3.0, 0.25)
    fun run(file: Uri, e: JSONObject, hz: Double) = level(play(listOf("e" to file), JSONObject().put("eq", e).put("mix", 0)).first, hz)

    val flat1k = run(k1, eq(on = false), 1000.0)
    // The limiter is Web Audio's DynamicsCompressor (threshold -1 dB, ratio 20), which adds its own
    // makeup gain: (1 - 1/20) dB of full-range gain, raised to 0.6, = +0.57 dB. The app does the same.
    val makeup = Math.pow(10.0, 0.6 * (1.0 - 1.0 / 20.0) / 20.0)
    assertEquals("EQ off: only the limiter's makeup gain", 0.25 * makeup, flat1k, 0.25 * 0.005)
    // With the EQ on, eq.ts lowers everything by its headroom trim (minus the loudest point of the
    // curve, so a boost cannot clip) and runs its own limiter, which adds the same +0.57 dB makeup.
    // So a band set to G changes a tone at its centre by G + trim + 0.57 dB, relative to EQ off.
    val makeupDb = 0.6 * (1.0 - 1.0 / EqMath.LIMITER_RATIO) * -EqMath.LIMITER_THRESHOLD_DB
    fun expect(e: JSONObject, atCentre: Double) = atCentre + EqMath.headroomTrimDb(EqJson.parse(e)) + makeupDb
    fun check(what: String, file: Uri, e: JSONObject, hz: Double, ref: Double, atCentre: Double, tol: Double): Double {
      val got = db(run(file, e, hz) / ref)
      val want = expect(e, atCentre)
      android.util.Log.i("NativeSoundTest", "$what: heard $got dB, the app's EQ gives $want dB")
      assertEquals(what, want, got, tol)
      return got
    }
    val cut = check("1 kHz band at -12 dB, 1 kHz tone", k1, eq(on = true, gains = gainsAt(5, -12.0)), 1000.0, flat1k, -12.0, 0.15)
    val boostEq = eq(on = true, gains = gainsAt(5, 6.0))
    val boost = check("1 kHz band at +6 dB, 1 kHz tone", k1, boostEq, 1000.0, flat1k, 6.0, 0.15)
    // The same boost heard against a tone outside the band: the boosted band stands 6 dB above it.
    val k125 = wav("eq-125.wav", 125.0, 3.0, 0.25)
    val flat125 = run(k125, eq(on = false), 125.0)
    val other = db(run(k125, boostEq, 125.0) / flat125)
    android.util.Log.i("NativeSoundTest", "1 kHz +6: 1 kHz tone $boost dB, 125 Hz tone $other dB")
    assertEquals("a +6 dB band stands 6 dB above music outside it", 6.0, boost - other, 0.2)
    val bypassed = db(run(k1, eq(on = false, gains = gainsAt(5, 6.0)), 1000.0) / flat1k)
    assertEquals("EQ switched off ignores its sliders", 0.0, bypassed, 0.05)
    check("64 Hz band at +12 dB, 1 kHz tone (outside the band)", k1, eq(on = true, gains = gainsAt(1, 12.0)), 1000.0, flat1k, 0.0, 0.15)
    val flat528 = run(k528, eq(on = false), 528.0)
    check("Solfeggio 528 Hz preset, 528 Hz tone", k528, eq(on = true, toneHz = 528.0), 528.0, flat528, 6.0, 0.15)
    check("Solfeggio 528 Hz preset, 1 kHz tone (outside it)", k1, eq(on = true, toneHz = 528.0), 1000.0, flat1k, 0.0, 0.15)
    assertTrue("the cut is a cut", cut < -11.0)

    // Moving a slider while a song plays changes it at once, not from the next song.
    val long = wav("eq-live.wav", 1000.0, 5.0, 0.25)
    var changedAt = 0
    val (pcm, _) = play(listOf("live" to long), JSONObject().put("eq", eq(on = false)).put("mix", 0)) { rec ->
      changedAt = rec.size
      EngineHub.fromPage(JSONObject().put("op", "settings").put("eq", eq(on = true, gains = gainsAt(5, -12.0))).toString())
    }
    val before = amp(pcm, 1000.0, changedAt - 9600)
    val after = amp(pcm, 1000.0, changedAt + 24000)
    android.util.Log.i("NativeSoundTest", "live change at frame $changedAt: ${db(after / before)} dB")
    val makeup2 = 0.6 * (1.0 - 1.0 / EqMath.LIMITER_RATIO) * -EqMath.LIMITER_THRESHOLD_DB
    assertEquals("a live EQ change takes effect within half a second", -12.0 + makeup2, db(after / before), 0.15)
  }

  /** Where each tone is: the first and last 10 ms hop with its amplitude above -40 dBFS. */
  private fun span(pcm: FloatArray, hz: Double): IntRange {
    var first = -1; var last = -1
    var s = 0
    while (s + 2400 <= pcm.size) {
      if (amp(pcm, hz, s) > 0.005) { if (first < 0) first = s + 1200; last = s + 1200 }
      s += 480
    }
    assertTrue("$hz Hz was heard", first >= 0)
    return first..last
  }

  private fun blend(mix: Int, playThrough: Int): Triple<IntRange, IntRange, FloatArray> {
    val a = wav("mix-a.wav", 440.0, SONG_S, 0.5)
    val b = wav("mix-b.wav", 880.0, SONG_S, 0.5)
    val (pcm, _) = play(listOf("a" to a, "b" to b), JSONObject().put("eq", eq(on = false)).put("mix", mix).put("playThrough", playThrough))
    return Triple(span(pcm, 440.0), span(pcm, 880.0), pcm)
  }

  @Test fun theCrossfaderBlendsTheNextSongOnlyAfterThePlayThroughShare() {
    for (pt in listOf(95, 80)) {
      val plan = Crossfade.mixPlan(MIX.toDouble(), SONG_S, SONG_S, MixInputs(minPlayedFraction = pt / 100.0))
      assertTrue("the app's planner blends at slider $MIX ($plan)", plan.seconds > 0.5)
      val (a, b, pcm) = blend(MIX, pt)
      val startS = (b.first - a.first) / 48000.0
      val overlapS = (a.last - b.first) / 48000.0
      val bLenS = (b.last - b.first) / 48000.0
      android.util.Log.i("NativeSoundTest", "playThrough $pt: plan start ${plan.startAt} s for ${plan.seconds} s (${plan.style}); heard B from $startS s, overlap $overlapS s, B lasted $bLenS s")
      assertTrue("song A played at least $pt% before B came in ($startS s)", startS >= pt / 100.0 * SONG_S - 0.03)
      assertEquals("B comes in where the app's planner says", plan.startAt, startS, 0.1)
      assertTrue("both songs sound together for most of the planned ${plan.seconds} s (heard $overlapS s)", overlapS >= 0.6 * plan.seconds)
      assertTrue("A is gone by the end of the planned blend (overlap $overlapS s)", overlapS <= plan.seconds + 0.1)
      assertEquals("B plays whole, from its start", SONG_S, bLenS, 0.1)
      // Halfway through the blend both are clearly audible: a mix, not a gap or a jump.
      val mid = (b.first + a.last) / 2 - 1200
      assertTrue("A audible mid-blend", amp(pcm, 440.0, mid) > 0.05)
      assertTrue("B audible mid-blend", amp(pcm, 880.0, mid) > 0.05)
    }
  }

  /**
   * The progress bar, as the page drives it (`{op:"seek"}` into [EngineHub]): a seek must not lose
   * the song lined up next. It once did — the engine dropped the spare deck on every seek and the
   * service never offered it again, so a song seeked in the app never blended.
   */
  @Test fun theCrossfaderStillBlendsAfterTheProgressBarIsMoved() {
    val a = wav("mix-a.wav", 440.0, SONG_S, 0.5)
    val b = wav("mix-b.wav", 880.0, SONG_S, 0.5)
    val plan = Crossfade.mixPlan(MIX.toDouble(), SONG_S, SONG_S, MixInputs(minPlayedFraction = 0.95))
    var seekedAt = 0
    val (pcm, _) = play(listOf("a" to a, "b" to b), JSONObject().put("eq", eq(on = false)).put("mix", MIX).put("playThrough", 95)) { rec ->
      seekedAt = rec.size
      EngineHub.fromPage(JSONObject().put("op", "seek").put("positionMs", SEEK_S * 1000).toString())
    }
    val aSpan = span(pcm, 440.0)
    // The seek's jump in A is a click that briefly shows energy at every frequency, 880 Hz included:
    // count B as present only once it has been there for 200 ms straight.
    var run = 0; var bFirst = -1; var s = seekedAt + 9600
    while (s + 2400 <= pcm.size && bFirst < 0) {
      if (amp(pcm, 880.0, s) > 0.005) { run++; if (run == 20) bFirst = s + 1200 - 19 * 480 } else run = 0
      s += 480
    }
    assertTrue("B was heard after the seek", bFirst > 0)
    // In the output, A runs from the seek at SEEK_S to its end; B should come in at the planned point.
    val bInS = (bFirst - seekedAt) / 48000.0 + SEEK_S
    val overlapS = (aSpan.last - bFirst) / 48000.0
    android.util.Log.i("NativeSoundTest", "after a seek to $SEEK_S s: B came in at song time $bInS s (plan ${plan.startAt}), overlap $overlapS s (plan ${plan.seconds})")
    assertEquals("B blends in where the app's planner says, after the seek", plan.startAt, bInS, 0.15)
    assertTrue("both songs sound together through the blend ($overlapS s)", overlapS >= 0.6 * plan.seconds)
  }

  @Test fun theCrossfaderAtOffPlaysEachSongWholeWithNoOverlap() {
    val (a, b, pcm) = blend(0, 95)
    android.util.Log.i("NativeSoundTest", "mix off: A ${(a.last - a.first) / 48000.0} s, B from ${(b.first - a.first) / 48000.0} s")
    assertEquals("A plays whole", SONG_S, (a.last - a.first) / 48000.0, 0.1)
    // A tone's span is smeared by the 50 ms analysis window, so a gapless handoff reads as up to one
    // window of "overlap"; check each side of the switch directly instead.
    assertTrue("no blend longer than the analysis window", b.first >= a.last - 2400)
    val switch = (b.first + a.last) / 2
    assertTrue("only A just before the switch", amp(pcm, 880.0, switch - 4800 - 2400) < 0.005 && amp(pcm, 440.0, switch - 4800 - 2400) > 0.3)
    assertTrue("only B just after it", amp(pcm, 440.0, switch + 4800) < 0.005 && amp(pcm, 880.0, switch + 4800) > 0.3)
    assertEquals("B plays whole", SONG_S, (b.last - b.first) / 48000.0, 0.1)
  }

  private companion object {
    const val SONG_S = 30.0
    const val SEEK_S = 20.0
    const val MIX = 60
  }
}
