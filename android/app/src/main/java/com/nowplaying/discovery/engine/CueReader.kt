package com.nowplaying.discovery.engine

import android.content.Context
import android.net.Uri
import android.os.SystemClock
import kotlin.math.max
import kotlin.math.min

/**
 * DJ-XFADE-001: measure a downloaded song's cues on the phone. The song's first and last stretch
 * are decoded with the same [DecodedSource] the player uses, folded to mono at a quarter of the
 * engine rate, and handed to [Cues.analyseEnds]. Runs on a background thread, once per song, while
 * the song before it is still playing; a song that cannot be read simply has no cues and is blended
 * over the tail of its file as before.
 */
object CueReader {
  /** Every fourth engine frame, after averaging the four: 12 kHz, ample for beats and levels. */
  private const val DECIMATE = 4
  const val RATE = PcmSource.SAMPLE_RATE.toDouble() / DECIMATE
  private const val HEAD_SECONDS = 50
  private const val TAIL_SECONDS = 80
  /** Give up on a file that will not decode rather than hold the worker thread. */
  private const val STALL_MS = 4000L

  fun read(context: Context, uri: Uri): TrackCues? {
    val source = runCatching { DecodedSource(context, uri) }.getOrNull() ?: return null
    try {
      val total = source.durationFrames
      if (total <= 0) return null
      val headFrames = min(total, HEAD_SECONDS.toLong() * PcmSource.SAMPLE_RATE)
      val tailFrames = min(total, TAIL_SECONDS.toLong() * PcmSource.SAMPLE_RATE)
      val head = pull(source, headFrames) ?: return null
      // A short song is one stretch: its head is also its tail.
      val tailFrom = if (total <= headFrames) 0L else total - tailFrames
      val tail = if (tailFrom == 0L) head else {
        source.seekTo(tailFrom)
        pull(source, tailFrames) ?: return null
      }
      // The container's length is an estimate. Where the tail was read from is exact, so the song
      // ends where that decoding ended, and every cue is a position the player itself will report.
      val decodedEnd = tailFrom.toDouble() / PcmSource.SAMPLE_RATE + tail.size / RATE
      return Cues.analyseEnds(head, tail, RATE, decodedEnd)
    } catch (e: Throwable) {
      return null
    } finally {
      source.close()
    }
  }

  /** Read up to [frames] engine frames from where the source stands, as mono at [RATE]. */
  private fun pull(source: PcmSource, frames: Long): FloatArray? {
    val out = FloatArray((frames / DECIMATE).toInt())
    val block = arrayOf(FloatArray(4096), FloatArray(4096))
    var written = 0
    var carry = 0f
    var carried = 0
    var idleSince = SystemClock.elapsedRealtime()
    while (written < out.size) {
      if (source.error != null) return null
      val got = source.read(block, 0, block[0].size)
      if (got == 0) {
        if (source.ended) break
        if (SystemClock.elapsedRealtime() - idleSince > STALL_MS) return null
        Thread.sleep(4)
        continue
      }
      idleSince = SystemClock.elapsedRealtime()
      for (i in 0 until got) {
        carry += (block[0][i] + block[1][i]) * 0.5f
        carried += 1
        if (carried == DECIMATE) {
          if (written < out.size) out[written++] = carry / DECIMATE
          carry = 0f
          carried = 0
        }
      }
    }
    // The container's length is an estimate; what was decoded is the truth.
    return if (written == out.size) out else out.copyOf(max(0, written))
  }
}
