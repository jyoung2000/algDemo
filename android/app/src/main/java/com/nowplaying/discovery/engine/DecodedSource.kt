package com.nowplaying.discovery.engine

import android.content.Context
import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.net.Uri
import android.os.Build
import java.nio.ByteOrder
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToLong

/**
 * A local song decoded by the platform codec, resampled to 48 kHz stereo float, as a [PcmSource].
 *
 * The app plays a song through an `<audio>` element routed into Web Audio, so Chromium decodes it
 * and resamples it to the AudioContext rate with media::SincResampler before the EQ ever sees it.
 * This does the same with MediaCodec and the ported [StreamResampler], so the engine's input
 * matches the app's.
 *
 * Decoding runs on its own thread into a bounded ring ([CAPACITY_FRAMES], ~4 s); [read] never
 * blocks. A seek clears the ring and bumps a generation number, so nothing decoded for the old
 * position can land after it. Seeks are sample-accurate: the extractor jumps to the sync frame at
 * or before the target, and decoded frames before the target are discarded.
 *
 * Only mono and stereo are expected (the downloader writes music files); a file with more channels
 * plays its first two (front left/right in every standard layout) rather than failing.
 */
class DecodedSource(context: Context, uri: Uri) : PcmSource {
  private val extractor = MediaExtractor()
  private val codec: MediaCodec
  private val trackFormat: MediaFormat

  private val lock = Object()
  private val ringL = FloatArray(CAPACITY_FRAMES)
  private val ringR = FloatArray(CAPACITY_FRAMES)
  private var head = 0
  private var count = 0
  private var generation = 0
  private var pendingSeek: Long = 0
  private var decodedToEnd = false

  @Volatile private var failure: Throwable? = null
  @Volatile private var running = true
  private var position = 0L

  override val durationFrames: Long
  private val thread: Thread

  init {
    try {
      extractor.setDataSource(context, uri, null)
      val track = (0 until extractor.trackCount).firstOrNull {
        extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true
      } ?: throw IllegalArgumentException("No audio track in $uri")
      extractor.selectTrack(track)
      trackFormat = extractor.getTrackFormat(track)
      val us = if (trackFormat.containsKey(MediaFormat.KEY_DURATION)) trackFormat.getLong(MediaFormat.KEY_DURATION) else -1L
      durationFrames = if (us > 0) (us * PcmSource.SAMPLE_RATE / 1_000_000.0).roundToLong() else PcmSource.UNKNOWN
      val mime = trackFormat.getString(MediaFormat.KEY_MIME)!!
      // For a compressed codec this asks for float output (no 16-bit rounding before the EQ, as in
      // Chromium). For audio/raw the same key describes the INPUT, so it must keep the file's own
      // encoding: setting float there makes the raw decoder pass 16-bit bytes off as floats.
      if (Build.VERSION.SDK_INT >= 24 && mime != MediaFormat.MIMETYPE_AUDIO_RAW) {
        trackFormat.setInteger(MediaFormat.KEY_PCM_ENCODING, AudioFormat.ENCODING_PCM_FLOAT)
      }
      codec = MediaCodec.createDecoderByType(mime)
      codec.configure(trackFormat, null, null, 0)
      codec.start()
    } catch (e: Throwable) {
      extractor.release()
      throw e
    }
    thread = Thread({ decodeLoop() }, "AirwaveDecode").apply { isDaemon = true; start() }
  }

  override val positionFrames: Long get() = synchronized(lock) { position }
  override val ready: Boolean get() = synchronized(lock) { failure == null && (count >= READY_FRAMES || decodedToEnd) }
  override val ended: Boolean get() = synchronized(lock) { decodedToEnd && count == 0 }
  override val error: Throwable? get() = failure

  override fun read(dst: Array<FloatArray>, offset: Int, frames: Int): Int = synchronized(lock) {
    val n = min(frames, count)
    var tail = head
    for (i in 0 until n) {
      dst[0][offset + i] = ringL[tail]
      dst[1][offset + i] = ringR[tail]
      tail = (tail + 1) % CAPACITY_FRAMES
    }
    head = tail
    count -= n
    position += n
    if (n > 0) lock.notifyAll()
    n
  }

  override fun seekTo(frame: Long) = synchronized(lock) {
    val target = if (durationFrames > 0) frame.coerceIn(0, durationFrames) else max(0, frame)
    generation++
    pendingSeek = target
    head = 0
    count = 0
    position = target
    decodedToEnd = false
    lock.notifyAll()
  }

  override fun close() {
    running = false
    synchronized(lock) { lock.notifyAll() }
    thread.join(1000)
    runCatching { codec.stop() }
    runCatching { codec.release() }
    runCatching { extractor.release() }
  }

  /* ------------------------------------------------------------------ decode thread */

  private var inRate = 0
  private var inChannels = 0
  private var encoding = AudioFormat.ENCODING_PCM_16BIT
  private var resampler: StreamResampler? = null
  private val pullL = FloatArray(PULL_FRAMES)
  private val pullR = FloatArray(PULL_FRAMES)
  private val pullPlanar = arrayOf(pullL, pullR)
  private var pushL = FloatArray(4096)
  private var pushR = FloatArray(4096)

  private fun decodeLoop() {
    val info = MediaCodec.BufferInfo()
    var myGeneration = -1
    var inputDone = false
    var outputDone = false
    var skipUntilInputFrame = 0L
    try {
      while (running) {
        // Pick up a seek (and the initial position) before decoding anything more.
        val seek: Long?
        synchronized(lock) {
          seek = if (myGeneration != generation) { myGeneration = generation; pendingSeek } else null
        }
        if (seek != null) {
          val us = (seek * 1_000_000.0 / PcmSource.SAMPLE_RATE).roundToLong()
          extractor.seekTo(us, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)
          codec.flush()
          resampler?.reset()
          inputDone = false
          outputDone = false
          skipUntilInputFrame = -1 - seek // resolved to an input frame once the rate is known
        }

        if (!drainResampler(myGeneration)) { waitForSpace(myGeneration); continue }
        if (outputDone) { waitForSpace(myGeneration, idle = true); continue }

        if (!inputDone) {
          val idx = codec.dequeueInputBuffer(TIMEOUT_US)
          if (idx >= 0) {
            val buf = codec.getInputBuffer(idx)!!
            val size = extractor.readSampleData(buf, 0)
            if (size < 0) {
              codec.queueInputBuffer(idx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
              inputDone = true
            } else {
              codec.queueInputBuffer(idx, 0, size, extractor.sampleTime, 0)
              extractor.advance()
            }
          }
        }

        val out = codec.dequeueOutputBuffer(info, TIMEOUT_US)
        when {
          out == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> configureFrom(codec.outputFormat)
          out >= 0 -> {
            if (inRate == 0) configureFrom(codec.outputFormat)
            if (skipUntilInputFrame < 0) {
              val target = -1 - skipUntilInputFrame
              skipUntilInputFrame = floor(target * inRate.toDouble() / PcmSource.SAMPLE_RATE).toLong()
            }
            val firstFrame = (info.presentationTimeUs * inRate / 1_000_000.0).roundToLong()
            val frames = convert(codec.getOutputBuffer(out)!!, info)
            codec.releaseOutputBuffer(out, false)
            // Sample-accurate seek: drop what precedes the target.
            val drop = (skipUntilInputFrame - firstFrame).coerceIn(0, frames.toLong()).toInt()
            if (frames - drop > 0) resampler!!.push(arrayOf(pushL, pushR), drop, frames - drop)
            if ((info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
              resampler?.endOfInput()
              outputDone = true
            }
          }
        }
        if (outputDone && drainResampler(myGeneration)) {
          synchronized(lock) { if (myGeneration == generation) { decodedToEnd = true; lock.notifyAll() } }
        }
      }
    } catch (e: Throwable) {
      if (running) failure = e
    }
  }

  private fun configureFrom(format: MediaFormat) {
    inRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
    inChannels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
    encoding = if (format.containsKey(MediaFormat.KEY_PCM_ENCODING)) format.getInteger(MediaFormat.KEY_PCM_ENCODING) else AudioFormat.ENCODING_PCM_16BIT
    resampler = StreamResampler(inRate, PcmSource.SAMPLE_RATE, 2)
  }

  private fun bytesPerSample(): Int = when (encoding) {
    AudioFormat.ENCODING_PCM_8BIT -> 1
    AudioFormat.ENCODING_PCM_FLOAT, ENCODING_PCM_32BIT -> 4
    ENCODING_PCM_24BIT_PACKED -> 3
    else -> 2
  }

  /** One sample at byte [at] of [b] (little-endian, as every Android PCM encoding is), as float. */
  private fun sample(b: java.nio.ByteBuffer, at: Int): Float = when (encoding) {
    AudioFormat.ENCODING_PCM_FLOAT -> b.getFloat(at)
    AudioFormat.ENCODING_PCM_8BIT -> ((b.get(at).toInt() and 0xff) - 128) / 128f
    ENCODING_PCM_24BIT_PACKED ->
      (((b.get(at).toInt() and 0xff) or ((b.get(at + 1).toInt() and 0xff) shl 8) or (b.get(at + 2).toInt() shl 16)) / 8388608f)
    ENCODING_PCM_32BIT -> (b.getInt(at) / 2147483648.0).toFloat()
    else -> b.getShort(at) / 32768f
  }

  /** Decoded buffer -> planar stereo float in [pushL]/[pushR]. Returns the frame count. */
  private fun convert(buf: java.nio.ByteBuffer, info: MediaCodec.BufferInfo): Int {
    val ch = max(1, inChannels)
    val bps = bytesPerSample()
    val frames = info.size / (bps * ch)
    if (pushL.size < frames) { pushL = FloatArray(frames); pushR = FloatArray(frames) }
    val b = buf.duplicate().order(ByteOrder.LITTLE_ENDIAN)
    for (i in 0 until frames) {
      val at = info.offset + i * ch * bps
      val l = sample(b, at)
      pushL[i] = l
      pushR[i] = if (ch > 1) sample(b, at + bps) else l
    }
    return frames
  }

  /**
   * Move whatever the resampler can produce into the ring. Returns true when the resampler has
   * nothing left to give (so more input may be decoded), false when the ring is full first.
   */
  private fun drainResampler(gen: Int): Boolean {
    val rs = resampler ?: return true
    while (running) {
      val room = synchronized(lock) { if (gen != generation) return true; CAPACITY_FRAMES - count }
      if (room < PULL_FRAMES) return false
      val n = rs.pull(pullPlanar, PULL_FRAMES)
      if (n <= 0) return true
      synchronized(lock) {
        if (gen != generation) return true
        var tail = (head + count) % CAPACITY_FRAMES
        for (i in 0 until n) {
          ringL[tail] = pullL[i]
          ringR[tail] = pullR[i]
          tail = (tail + 1) % CAPACITY_FRAMES
        }
        count += n
        lock.notifyAll()
      }
    }
    return true
  }

  private fun waitForSpace(gen: Int, idle: Boolean = false) = synchronized(lock) {
    if (running && gen == generation) lock.wait(if (idle) 200 else 20)
  }

  companion object {
    /** ~4 s at 48 kHz: plenty for a GC pause or a slow storage read, small enough to seek cheaply. */
    const val CAPACITY_FRAMES = 4 * 48000
    /** A song counts as ready once ~250 ms is buffered (or it is shorter than that and fully decoded). */
    const val READY_FRAMES = 12000
    private const val PULL_FRAMES = 4096
    private const val TIMEOUT_US = 5_000L
    // AudioFormat.ENCODING_PCM_24BIT_PACKED / ENCODING_PCM_32BIT (API 31), by value so minSdk 26 compiles.
    private const val ENCODING_PCM_24BIT_PACKED = 21
    private const val ENCODING_PCM_32BIT = 22
  }
}
