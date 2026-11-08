package com.nowplaying.discovery.engine

/**
 * One song's audio as the engine consumes it: **48 kHz, stereo, float PCM**, whatever the file was.
 * Decoding, down-mixing and resampling happen behind this interface (see `DecodedSource`), so the
 * mixer only ever sees one format and its tests can feed it synthetic tones.
 *
 * Contract (docs/native-engine.md):
 * - [read] never blocks. It copies up to `frames` frames into `dst[0]`/`dst[1]` from `offset` and
 *   returns how many it copied. Fewer than asked means either the end of the song ([ended] is then
 *   true) or an underrun (the decoder has not caught up; [ended] stays false). The caller zero-fills.
 * - [positionFrames] is the engine frame (48 kHz) of the next sample [read] will return; it advances
 *   only by what [read] returned. After [seekTo] it equals the requested frame.
 * - [ready] is true once enough audio is buffered to start without an immediate underrun, or the
 *   song has ended. A source that failed reports [error] and is never ready.
 * - Thread safety: [read], [seekTo], [positionFrames], [ready], [ended] and [error] are called from
 *   the engine thread; a source may decode on its own thread behind them.
 */
interface PcmSource : AutoCloseable {
  /** Total length in engine frames, or [UNKNOWN] when the container does not say. */
  val durationFrames: Long
  val positionFrames: Long
  val ready: Boolean
  val ended: Boolean
  val error: Throwable?
  fun read(dst: Array<FloatArray>, offset: Int, frames: Int): Int
  /** Jump so the next [read] starts at this engine frame (clamped to the song). Sample-accurate. */
  fun seekTo(frame: Long)

  companion object {
    const val SAMPLE_RATE = 48000
    const val UNKNOWN = -1L
  }
}

/**
 * Where the mixed audio goes: one stream, so the post-mix limiter sees the true sum of both decks.
 * The Android implementation is a float `AudioTrack`; tests capture into memory.
 */
interface AudioOutput : AutoCloseable {
  val sampleRate: Int
  /**
   * Write interleaved stereo floats (`frames * 2` values). Blocks until accepted while playing, which
   * is what paces the engine thread. Returns the frames accepted; less than asked only after
   * [pause] or [flush] interrupted it.
   */
  fun write(interleaved: FloatArray, frames: Int): Int
  fun play()
  fun pause()
  /** Drop everything written but not yet heard (seek, skip). */
  fun flush()
  /** Frames written but not yet heard, so the reported position matches what the listener hears. */
  fun pendingFrames(): Long
}
