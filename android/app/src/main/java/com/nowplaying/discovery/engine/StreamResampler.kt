package com.nowplaying.discovery.engine

/**
 * Push/pull streaming resampler for the native decoder: planar float input at [inRate] in, planar
 * float output at [outRate] out, resampled exactly the way Chromium resamples an `<audio>` element
 * routed into a Web Audio context of another rate.
 *
 * That path (Chromium 152.0.7977.65, Electron 44.1.1) is `MediaElementAudioSourceHandler::SetFormat`
 * (third_party/blink/renderer/modules/webaudio/media_element_audio_source_handler.cc) ->
 * `blink::MediaMultiChannelResampler` -> `media::MultiChannelResampler` -> one `media::SincResampler`
 * per channel, built with `io_ratio = float(source_rate) / float(context_rate)` and
 * `request_frames = RenderQuantumFrames()` = 128 (so a 64-tap kernel), never primed with silence.
 * This class drives a [MultiChannelSincResampler] with exactly those parameters
 * ([SincResampler.blinkMediaElementRatio], [SincResampler.WEB_AUDIO_RENDER_QUANTUM_FRAMES]), so the
 * output samples are the ones Chromium's `Convolve_C` would produce for the same input.
 *
 * Timing: output frame `k` (since construction or [reset]) is the input at time `k * ratio` input
 * frames, `ratio` being Blink's float-rounded ratio (for 44100 -> 48000 it is 0.918749988079071, 1.3e-8
 * below 147/160, so the output runs 0.013 ppm slow — one output frame every ~27 minutes; Chromium
 * does the same). Because Blink never calls `PrimeWithSilence()`, the first read lands at
 * `r0_ = kernel_size / 2` and the kernel's centre tap sits on input frame 0: the resampler has
 * **zero group delay** (SincResamplerTest measures it). Its only latency is look-ahead: output `k`
 * needs input up to `floor(k * ratio) + kernel_size / 2 - 1`, and SincResampler fetches input in
 * 128-frame requests. [pull] therefore stops before any request it cannot fill from pushed input,
 * so it never produces output that needs input not yet pushed; nothing has to be trimmed off the
 * front.
 *
 * After [endOfInput] the missing input is zero-padded and output stops after exactly
 * `round(totalInput * outRate / inRate)` frames. When `inRate == outRate` the input is copied
 * through bit-identically with no filtering (Blink bypasses the resampler in that case too).
 *
 * Not thread-safe: push, pull, endOfInput and reset belong to one thread (the decoder's).
 */
class StreamResampler(val inRate: Int, val outRate: Int = 48000, val channels: Int = 2) {
  init {
    require(inRate > 0 && outRate > 0) { "rates must be positive" }
    require(channels > 0) { "channels must be positive" }
  }

  /** True when the rates match and [pull] copies the input unchanged. */
  val passthrough: Boolean = inRate == outRate

  /** The io ratio handed to SincResampler (input frames per output frame), as Blink computes it. */
  val ratio: Double = SincResampler.blinkMediaElementRatio(inRate, outRate)

  private val requestFrames = SincResampler.WEB_AUDIO_RENDER_QUANTUM_FRAMES

  // FIFO of pushed input not yet handed to the resampler (or, in passthrough, not yet pulled).
  private var fifo = Array(channels) { FloatArray(4096) }
  private var fifoStart = 0
  private var fifoEnd = 0

  private var totalIn = 0L
  private var totalOut = 0L
  private var ended = false

  private val resampler: MultiChannelSincResampler? =
    if (passthrough) null
    else MultiChannelSincResampler(channels, ratio, requestFrames) { _, dst, frames -> provideInput(dst, frames) }

  /** Input frames pushed since construction or [reset]. */
  val inputFrames: Long get() = totalIn

  /** Output frames pulled since construction or [reset]. */
  val outputFrames: Long get() = totalOut

  /** Queue `input[ch][offset until offset + frames]` for every channel. */
  fun push(input: Array<FloatArray>, offset: Int, frames: Int) {
    check(!ended) { "push after endOfInput" }
    require(input.size >= channels) { "need $channels channels, got ${input.size}" }
    require(frames >= 0 && offset >= 0)
    if (frames == 0) return
    ensureCapacity(frames)
    for (c in 0 until channels) System.arraycopy(input[c], offset, fifo[c], fifoEnd, frames)
    fifoEnd += frames
    totalIn += frames
  }

  /** No more input: zero-pad what is still needed and finish at the exact output length. */
  fun endOfInput() {
    ended = true
  }

  /** Forget everything, as if newly constructed (seeking). The kernel table is kept; it depends only on the rates. */
  fun reset() {
    resampler?.flush()
    fifoStart = 0
    fifoEnd = 0
    totalIn = 0
    totalOut = 0
    ended = false
  }

  /**
   * Write up to [frames] frames into `output[ch][0 until n]` and return `n`. Returns less (possibly
   * 0) when more input is needed, or when the stream is finished after [endOfInput].
   */
  fun pull(output: Array<FloatArray>, frames: Int): Int {
    require(output.size >= channels) { "need $channels channels, got ${output.size}" }
    require(frames >= 0)
    val limit = if (ended) targetOutputFrames() - totalOut else Long.MAX_VALUE
    val want = minOf(frames.toLong(), limit).toInt()
    if (want <= 0) return 0
    if (resampler == null) {
      val n = minOf(want, fifoEnd - fifoStart)
      for (c in 0 until channels) System.arraycopy(fifo[c], fifoStart, output[c], 0, n)
      fifoStart += n
      totalOut += n
      return n
    }
    var produced = 0
    while (produced < want) {
      var n = resampler.framesBeforeNextRead()
      if (n == 0) {
        // The next frame triggers exactly one 128-frame read; only allow it when it can be filled.
        if (!ended && fifoEnd - fifoStart < requestFrames) break
        n = 1
      }
      n = minOf(n, want - produced)
      resampler.resample(output, produced, n)
      produced += n
    }
    totalOut += produced
    return produced
  }

  /** Total output length once input has ended: `round(totalIn * outRate / inRate)`, half rounding up. */
  fun targetOutputFrames(): Long = (totalIn * outRate * 2 + inRate) / (2L * inRate)

  private fun provideInput(dst: Array<FloatArray>, frames: Int) {
    val n = minOf(frames, fifoEnd - fifoStart)
    for (c in 0 until channels) {
      System.arraycopy(fifo[c], fifoStart, dst[c], 0, n)
      if (n < frames) dst[c].fill(0f, n, frames)
    }
    fifoStart += n
  }

  private fun ensureCapacity(frames: Int) {
    val cap = fifo[0].size
    if (fifoEnd + frames <= cap) return
    val live = fifoEnd - fifoStart
    val newCap = if (live + frames <= cap) cap else maxOf(cap * 2, live + frames)
    for (c in 0 until channels) {
      val dst = if (newCap == cap) fifo[c] else FloatArray(newCap)
      System.arraycopy(fifo[c], fifoStart, dst, 0, live)
      fifo[c] = dst
    }
    fifoStart = 0
    fifoEnd = live
  }
}
