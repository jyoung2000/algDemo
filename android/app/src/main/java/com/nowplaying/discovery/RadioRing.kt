package com.nowplaying.discovery

import com.nowplaying.discovery.engine.PcmSource
import kotlin.math.min

/** RADIO-001. Five-minute bounded, session-only PCM ring. A paused reader does not advance or
 * earn listening credit; a backward seek can only enter retained audio, never skip toward live. */
class RadioRing(private val capacity: Int = 48000 * 300) : PcmSource {
  private val pcm = ByteArray(capacity * 4)
  @Volatile var end = 0L; private set
  @Volatile var at = 0L; private set
  @Volatile var heard = 0L; private set
  @Volatile var dropped = false; private set
  @Volatile var failed: Throwable? = null
  @Volatile var closed = false
  val oldest: Long get() = (end - capacity).coerceAtLeast(0)
  override val durationFrames = PcmSource.UNKNOWN
  override val positionFrames: Long get() = synchronized(this) { at }
  override val ready: Boolean get() = synchronized(this) { end - at > 4800 }
  override val ended = false
  override val error: Throwable? get() = failed
  @Synchronized fun write(bytes: ByteArray, count: Int) {
    val frames = count / 4
    for (i in 0 until frames) {
      val p = ((end + i) % capacity).toInt() * 4
      System.arraycopy(bytes, i * 4, pcm, p, 4)
    }
    end += frames
    if (at < oldest) { at = oldest; dropped = true }
  }
  @Synchronized override fun read(dst: Array<FloatArray>, offset: Int, frames: Int): Int {
    at = at.coerceAtLeast(oldest)
    val n = min(frames.toLong(), end - at).toInt()
    for (i in 0 until n) {
      val p = ((at + i) % capacity).toInt() * 4
      dst[0][offset + i] = (((pcm[p + 1].toInt() shl 8) or (pcm[p].toInt() and 255)).toShort()).toFloat() / 32768f
      dst[1][offset + i] = (((pcm[p + 3].toInt() shl 8) or (pcm[p + 2].toInt() and 255)).toShort()).toFloat() / 32768f
    }
    at += n; heard += n
    return n
  }
  @Synchronized override fun seekTo(frame: Long) { at = frame.coerceIn(oldest, at.coerceAtLeast(oldest)) }
  @Synchronized fun sample(): ByteArray {
    val n = min(12 * 48000L, at - oldest).toInt()
    val out = ByteArray(n / 3 * 2)
    for (i in 0 until n / 3) {
      val p = ((at - n + i * 3) % capacity).toInt() * 4
      val l = ((pcm[p + 1].toInt() shl 8) or (pcm[p].toInt() and 255)).toShort().toInt()
      val r = ((pcm[p + 3].toInt() shl 8) or (pcm[p + 2].toInt() and 255)).toShort().toInt()
      val v = (l + r) / 2
      out[i * 2] = v.toByte(); out[i * 2 + 1] = (v shr 8).toByte()
    }
    return out
  }
  override fun close() { closed = true }
}
