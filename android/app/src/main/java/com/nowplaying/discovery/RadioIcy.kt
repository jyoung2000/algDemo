package com.nowplaying.discovery

import java.io.ByteArrayOutputStream

/**
 * RADIO-ICY-CLOCK-001: the playing stream's in-band (ICY) titles. A station asked for `Icy-MetaData: 1` interleaves a
 * title block every `icy-metaint` audio bytes; [Demux] takes the blocks out (the decoder must only see audio) and
 * reports each title CHANGE with the count of audio bytes before it, which [ringSeconds] places on the ring clock.
 * Measured on Power 92 (2026-11-20): this marks where a song begins in the audio heard, 37.5 s later than the
 * station's published start.
 */
object RadioIcy {
  class Demux(private val metaint: Int, private val onTitle: (title: String, audioBytes: Long, first: Boolean) -> Unit) {
    var audioBytes = 0L; private set
    private var untilMeta = metaint
    private var metaLeft = -1
    private val meta = ByteArrayOutputStream()
    private var last: String? = null

    /** Feeds [n] raw stream bytes; the audio among them goes to [out] in order. */
    fun feed(b: ByteArray, n: Int, out: (ByteArray, Int, Int) -> Unit) {
      var i = 0
      while (i < n) {
        if (untilMeta > 0) {
          val k = minOf(untilMeta, n - i)
          out(b, i, k); audioBytes += k; untilMeta -= k; i += k
        } else if (metaLeft < 0) {
          metaLeft = (b[i].toInt() and 0xff) * 16; i++
          if (metaLeft == 0) { metaLeft = -1; untilMeta = metaint }
        } else {
          val k = minOf(metaLeft, n - i)
          meta.write(b, i, k); metaLeft -= k; i += k
          if (metaLeft == 0) {
            val t = title(meta.toString(Charsets.UTF_8.name()))
            // The title on air when the connection opened began before it: only a CHANGE marks a start. The first one is
            // reported too (RADIO-TITLE-INBAND-001: it names what is playing now), flagged as already under way.
            if (t != null && t != last) { val first = last == null; last = t; onTitle(t, audioBytes, first) }
            meta.reset(); metaLeft = -1; untilMeta = metaint
          }
        }
      }
    }
  }

  fun title(block: String): String? =
    Regex("StreamTitle='([\\s\\S]*?)';", RegexOption.IGNORE_CASE).find(block)?.groupValues?.get(1)?.trim('\u0000', ' ')?.takeIf { it.isNotBlank() }

  /** RADIO-TITLE-INBAND-001: one in-band title on the ring clock; [first] = already playing when the connection opened. */
  data class Mark(val at: Double, val title: String, val first: Boolean)

  /** The titles of one connection. A title change is placed by its audio byte at the stream's bitrate; a station that
   *  states none (iHeart) has its bitrate worked out once 20 s of its audio are on the ring. */
  class Marks(private val ringFramesAtConnect: Long, private val kbps: Int?) {
    private val raw = mutableListOf<Triple<String, Long, Boolean>>()
    @Volatile private var known: Int? = kbps
    @Synchronized fun add(title: String, audioBytes: Long, first: Boolean) { raw += Triple(title, audioBytes, first); while (raw.size > 8) raw.removeAt(0) }
    @Synchronized fun resolved(ringEnd: Long, audioBytes: Long): List<Mark> {
      val ringS = (ringEnd - ringFramesAtConnect) / 48000.0
      if (known == null && ringS >= 20 && audioBytes > 0) known = standardKbps(audioBytes * 8 / 1000.0 / ringS)
      val k = known
      return raw.mapNotNull { (t, b, first) ->
        if (first) Mark(ringFramesAtConnect / 48000.0, t, true) else ringSeconds(ringFramesAtConnect, b, k)?.let { Mark(it, t, false) }
      }
    }
  }

  private val STANDARD_KBPS = intArrayOf(16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320)
  /** The standard bitrate within 12% of a measured one (stations encode at these), or null. */
  fun standardKbps(measured: Double): Int? = STANDARD_KBPS.minByOrNull { kotlin.math.abs(it - measured) }?.takeIf { kotlin.math.abs(it - measured) <= it * 0.12 }

  /** `icy-br` ("64", or "64,64" from some servers) in kbit/s. */
  fun kbps(header: String?): Int? = header?.substringBefore(',')?.trim()?.toIntOrNull()?.takeIf { it in 8..1024 }

  /** Ring seconds of an audio byte: where the connection began on the ring plus the bytes at the stated bitrate. */
  fun ringSeconds(ringFramesAtConnect: Long, audioBytes: Long, kbps: Int?): Double? =
    kbps?.let { ringFramesAtConnect / 48000.0 + audioBytes / (it * 125.0) }
}
