package com.nowplaying.discovery.engine

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Build

/**
 * The engine's single output: a 48 kHz stereo float [AudioTrack] in streaming mode.
 *
 * One track for the whole mix is the point: the post-mix limiter in [com.nowplaying.discovery.dsp.MixBus]
 * only works if it sees the true sum of both decks, exactly as the app's AudioContext destination does.
 * The buffer is a few engine chunks deep, enough to ride out a garbage-collection pause, small enough
 * that pause, seek and EQ changes are heard within ~100 ms.
 */
class TrackOutput(override val sampleRate: Int = 48000) : AudioOutput {
  private val bytesPerFrame = 2 * 4
  private val track: AudioTrack
  @Volatile private var written = 0L

  init {
    val min = AudioTrack.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_OUT_STEREO, AudioFormat.ENCODING_PCM_FLOAT)
    // At least 4 engine chunks (4 x 1024 frames, ~85 ms) so one late chunk is not an audible gap.
    val size = maxOf(min, 4 * AudioEngine.CHUNK_QUANTA * AudioEngine.QUANTUM * bytesPerFrame)
    val builder = AudioTrack.Builder()
      .setAudioAttributes(
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_MEDIA)
          .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
          .build(),
      )
      .setAudioFormat(
        AudioFormat.Builder()
          .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
          .setSampleRate(sampleRate)
          .setChannelMask(AudioFormat.CHANNEL_OUT_STEREO)
          .build(),
      )
      .setBufferSizeInBytes(size)
      .setTransferMode(AudioTrack.MODE_STREAM)
    if (Build.VERSION.SDK_INT >= 26) builder.setPerformanceMode(AudioTrack.PERFORMANCE_MODE_NONE)
    track = builder.build()
  }

  /** The platform session id, for the visualiser/equaliser effects Android attaches by session. */
  val audioSessionId: Int get() = track.audioSessionId

  override fun write(interleaved: FloatArray, frames: Int): Int {
    val n = track.write(interleaved, 0, frames * 2, AudioTrack.WRITE_BLOCKING)
    if (n <= 0) return 0
    val f = n / 2
    written += f
    return f
  }

  override fun play() {
    if (track.playState != AudioTrack.PLAYSTATE_PLAYING) track.play()
  }

  override fun pause() {
    if (track.playState == AudioTrack.PLAYSTATE_PLAYING) track.pause()
  }

  override fun flush() {
    val wasPlaying = track.playState == AudioTrack.PLAYSTATE_PLAYING
    // flush() only discards data on a paused or stopped streaming track.
    if (wasPlaying) track.pause()
    track.flush()
    written = track.playbackHeadPosition.toLong() and 0xffffffffL
    if (wasPlaying) track.play()
  }

  override fun pendingFrames(): Long {
    val head = track.playbackHeadPosition.toLong() and 0xffffffffL
    return (written - head).coerceAtLeast(0)
  }

  override fun close() {
    runCatching { track.pause() }
    runCatching { track.flush() }
    track.release()
  }
}
