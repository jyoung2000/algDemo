package com.nowplaying.discovery

import com.nowplaying.discovery.engine.PcmSource
import kotlin.math.min
import java.io.File
import java.io.RandomAccessFile
import java.io.OutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/** RADIO-001. Ten-minute bounded, session-only PCM ring (disk-backed in the native session). A paused reader does not advance or
 * earn listening credit; a backward seek can only enter retained audio, never skip toward live — except [toLive]
 * (RADIO-GO-LIVE-001), which jumps to just before the newest audio received. */
class RadioRing(private val capacity: Int = 48000 * 600, private val file: File? = null) : PcmSource {
  private val pcm = if (file == null) ByteArray(capacity * 4) else null
  private val disk = file?.let { RandomAccessFile(it, "rw").also { f -> f.setLength(capacity.toLong() * 4) } }
  /** RADIO-SMOOTH-001: the newest audio is also kept in memory, so playback near live and the fingerprint sample never
   *  wait on the disk; only a rewind further back than [TAIL_FRAMES] reads the file. */
  private val tailFrames = if (disk == null) 0 else min(capacity.toLong(), TAIL_FRAMES).toInt()
  private val tail = if (disk == null) null else ByteArray(tailFrames * 4)
  /** Disk reads made so far (tests). */
  @Volatile var diskReads = 0; private set
  private fun copyFrames(from: Long, frames: Int): ByteArray {
    val out = ByteArray(frames * 4)
    var done = 0
    while (done < frames) {
      val pos = from + done
      if (tail != null && pos >= end - tailFrames) {
        val t = (pos % tailFrames).toInt(); val n = min(frames - done, tailFrames - t)
        System.arraycopy(tail, t * 4, out, done * 4, n * 4); done += n; continue
      }
      val at = (pos % capacity).toInt()
      var n = min(frames - done, capacity - at)
      if (tail != null) n = min(n.toLong(), end - tailFrames - pos).toInt() // the rest comes from memory
      if (disk != null) { diskReads++; disk.seek(at.toLong() * 4); disk.readFully(out, done * 4, n * 4) }
      else System.arraycopy(pcm!!, at * 4, out, done * 4, n * 4)
      done += n
    }
    return out
  }
  @Volatile var end = 0L; private set
  @Volatile var at = 0L; private set
  @Volatile var heard = 0L; private set
  @Volatile var dropped = false; private set
  /** RADIO-LIVE-EDGE-001: set once the listener pauses or rewinds; from then on playback is never moved for them. */
  @Volatile var held = false; private set
  @Volatile private var catchUpUntil = 0L
  /** RADIO-SMOOTH-001: set when playback ran dry; it resumes once [REFILL_FRAMES] are back, not in scraps. */
  @Volatile private var refilling = false
  @Volatile private var started = false // the first sound waits for [START_FRAMES]
  val starved: Boolean get() = heard < catchUpUntil
  @Synchronized fun hold() { held = true }
  @Volatile var failed: Throwable? = null
  /** RADIO-ROBUST-001: the first error is the real reason; a decoder stopping because of it must not replace it. */
  @Synchronized fun fail(e: Throwable) { if (failed == null) failed = e }
  @Volatile var closed = false
  val oldest: Long get() = (end - capacity).coerceAtLeast(0)
  override val durationFrames = PcmSource.UNKNOWN
  override val positionFrames: Long get() = synchronized(this) { at }
  override val ready: Boolean get() = synchronized(this) { !closed && (if (refilling) end - at >= REFILL_FRAMES else if (!started) end - at >= START_FRAMES else end - at > 4800L) }
  override val ended = false
  override val error: Throwable? get() = failed
  /** Called by the decoder thread only. The disk copy is written outside the lock (RADIO-SMOOTH-001): the audio thread
   *  reads recent audio from memory, so it never waits behind a slow file write. */
  fun write(bytes: ByteArray, count: Int) {
    val frames = count / 4
    val start: Long
    synchronized(this) {
      if (closed) return
      start = end
      var done = 0
      while (done < frames) {
        if (tail != null) { val t = ((start + done) % tailFrames).toInt(); val n = min(frames - done, tailFrames - t); System.arraycopy(bytes, done * 4, tail, t * 4, n * 4); done += n }
        else { val at = ((start + done) % capacity).toInt(); val n = min(frames - done, capacity - at); System.arraycopy(bytes, done * 4, pcm!!, at * 4, n * 4); done += n }
      }
      end += frames
      if (at < oldest) { at = oldest; dropped = true }
    }
    if (disk == null) return
    try {
      var done = 0
      while (done < frames) {
        val at = ((start + done) % capacity).toInt(); val n = min(frames - done, capacity - at)
        disk.seek(at.toLong() * 4); disk.write(bytes, done * 4, n * 4); done += n
      }
    } catch (e: java.io.IOException) { if (!closed) fail(e) } // closed while writing: the session is gone
  }
  @Synchronized override fun read(dst: Array<FloatArray>, offset: Int, frames: Int): Int {
    if (closed) return 0
    if (refilling) { if (end - at < REFILL_FRAMES) return 0; refilling = false }
    if (!started) { if (end - at < START_FRAMES) return 0; started = true }
    // RADIO-LIVE-EDGE-001: a connect burst of old audio is skipped; until a pause or rewind, and only in the opening
    // 10 s heard, playback stays 5 s before the newest audio (RADIO-SMOOTH-001: rides out stations that deliver in bursts).
    // RADIO-ROBUST-001: playback that ran dry (a network stall, not the listener's pause) rejoins live when audio returns.
    // Like the opening, the first 5 s heard after a stall keep catching up: the backlog lands over about a second.
    if (!held && (heard < 48000L * 10 || heard < catchUpUntil) && end - at > LIVE_CUSHION_FRAMES + 48000) at = end - LIVE_CUSHION_FRAMES
    at = at.coerceAtLeast(oldest)
    val n = min(frames.toLong(), end - at).toInt()
    if (n < frames && heard > 0) { catchUpUntil = heard + n + 48000L * 5; refilling = true } // ran dry; the engine then stops pulling until audio returns
    val pcm = copyFrames(at, n)
    for (i in 0 until n) {
      val p = i * 4
      dst[0][offset + i] = (((pcm[p + 1].toInt() shl 8) or (pcm[p].toInt() and 255)).toShort()).toFloat() / 32768f
      dst[1][offset + i] = (((pcm[p + 3].toInt() shl 8) or (pcm[p + 2].toInt() and 255)).toShort()).toFloat() / 32768f
    }
    at += n; heard += n
    return n
  }
  @Synchronized override fun seekTo(frame: Long) { if (closed) return; if (frame < at) held = true /* a rewind; the engine's seekTo(0) on load is not */; at = frame.coerceIn(oldest, at.coerceAtLeast(oldest)) }
  /** RADIO-GO-LIVE-001 (owner, 2026-11-19): "a button to go to live". Jump to [cushion] frames before the newest audio
   *  received (never backwards, never past what has arrived), so playback carries on without an immediate stall. */
  @Synchronized fun toLive(cushion: Long = LIVE_CUSHION_FRAMES): Long { if (closed) return at; at = maxOf(at, (end - cushion).coerceAtLeast(oldest)).coerceAtMost(end); return at }
  // RADIO-SMOOTH-001 (owner, 2026-11-20): "the radio sometimes plays back really choppy". Power 92 delivers in bursts with
  // gaps up to 3.9 s (measured); 2 s before the newest audio ran dry nine times in 45 s. Same values as windows/radio.cjs.
  companion object { const val LIVE_CUSHION_FRAMES = 48000L * 5; const val REFILL_FRAMES = 48000L * 3 / 2; const val START_FRAMES = 48000L; const val TAIL_FRAMES = 48000L * 30 }
  @Synchronized fun sample(): ByteArray {
    if (closed) return ByteArray(0)
    val n = min(12 * 48000L, at - oldest).toInt()
    val out = ByteArray(n / 3 * 2)
    val pcm = copyFrames(at - n, n)
    for (i in 0 until n / 3) {
      val p = i * 3 * 4
      val l = ((pcm[p + 1].toInt() shl 8) or (pcm[p].toInt() and 255)).toShort().toInt()
      val r = ((pcm[p + 3].toInt() shl 8) or (pcm[p + 2].toInt() and 255)).toShort().toInt()
      val v = (l + r) / 2
      out[i * 2] = v.toByte(); out[i * 2 + 1] = (v shr 8).toByte()
    }
    return out
  }
  /** Export a retained excerpt without changing position or credit. All output is native-side. */
  @Synchronized fun writeWav(out: OutputStream, from: Long, to: Long): Double {
    check(!closed)
    val start = from.coerceAtLeast(oldest); val stop = to.coerceAtMost(end)
    require(stop > start) { "No retained audio for this item yet" }
    val size = ((stop - start) * 4).toInt()
    val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
    header.put("RIFF".toByteArray()).putInt(36 + size).put("WAVEfmt ".toByteArray()).putInt(16)
      .putShort(1).putShort(2).putInt(48000).putInt(192000).putShort(4).putShort(16)
      .put("data".toByteArray()).putInt(size)
    out.write(header.array())
    var pos = start
    while (pos < stop) { val n = min(48000L, stop - pos).toInt(); out.write(copyFrames(pos, n)); pos += n }
    return (stop - start) / 48000.0
  }
  @Synchronized override fun close() { if (!closed) { closed = true; disk?.close(); file?.delete() } }
}
