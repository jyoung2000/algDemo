package com.nowplaying.discovery.engine

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.ceil

/**
 * A port of Chromium's `media::SincResampler` (media/base/sinc_resampler.cc and .h, Chromium tag
 * 152.0.7977.65 — the Chromium inside Electron 44.1.1), generic path (`Convolve_C`).
 *
 * This is the resampler Chromium uses when an `<audio>` element at one rate is routed into a Web
 * Audio context at another rate: `MediaElementAudioSourceHandler::SetFormat`
 * (third_party/blink/renderer/modules/webaudio/media_element_audio_source_handler.cc) creates a
 * `MediaMultiChannelResampler` with `scale_factor = source_sample_rate / Context()->sampleRate()`
 * (two floats, divided in float, then widened to double) and
 * `request_frames = GetDeferredTaskHandler().RenderQuantumFrames()` (128 unless `renderSizeHint`),
 * which wraps a `media::MultiChannelResampler` ([MultiChannelSincResampler] here) holding one
 * `SincResampler` per channel. With 128 request frames [kernelSizeFromRequestFrames] picks the 64-tap
 * kernel. When the rates match the handler bypasses resampling altogether.
 *
 * Single channel. [readCb] is called to fill exactly [requestFrames] frames (zero-padded by the
 * provider if it has fewer). The output frame `k` (counting from the last [flush]) is the input
 * interpolated at input position `k * ioSampleRateRatio`: the kernel is centred on the virtual
 * source index and the history before the first input is the zeroed `r1_` region, so the
 * resampler adds no signal delay; it only reads ahead (`kernelSize / 2` frames plus block
 * granularity).
 *
 * Deviations from the C++, none of which change a sample in the normal range:
 * - `cc::ScopedSubnormalFloatDisabler` (FTZ/DAZ) is not available on the JVM, so subnormal values
 *   (|x| < 1.2e-38) are kept instead of flushed to zero.
 * - Regions `r0_..r4_` are offsets into [inputBuffer] rather than spans.
 * - `sin`/`cos` use `StrictMath` (fdlibm) for reproducibility; Chromium uses the platform libm.
 * - On ARM Chromium selects `Convolve_NEON` and on x86 `Convolve_AVX2`/`Convolve_SSE`, whose lane-wise
 *   partial sums round differently from `Convolve_C` (last-bit differences; not measured here). This port is the
 *   C path, as specified.
 * - [framesBeforeNextRead] is an addition (not in Chromium) so a streaming caller can avoid
 *   triggering a read before it has the input.
 */
class SincResampler(
  ioSampleRateRatio: Double,
  val requestFrames: Int,
  private val readCb: ReadCB,
) {
  /** `SincResampler::ReadCB`: render [frames] frames into [destination] from [offset]. */
  fun interface ReadCB {
    fun read(destination: FloatArray, offset: Int, frames: Int)
  }

  /** `kernel_size_`: 64, or 32 when [requestFrames] is too small (`KernelSizeFromRequestFrames`). */
  val kernelSize: Int = kernelSizeFromRequestFrames(requestFrames)

  /** `io_sample_rate_ratio_`: input rate / output rate. */
  var ioSampleRateRatio: Double = ioSampleRateRatio
    private set

  // `virtual_source_idx_`: index on the source input buffer with sub-sample precision (double, to
  // avoid drift).
  private var virtualSourceIdx = 0.0
  private var bufferPrimed = false
  private var blockSize = 0
  private var chunkSize = 0

  private val inputBufferSize = requestFrames + kernelSize
  private val kernelStorage = FloatArray(kernelSize * (KERNEL_OFFSET_COUNT + 1))
  private val kernelPreSincStorage = FloatArray(kernelSize * (KERNEL_OFFSET_COUNT + 1))
  private val kernelWindowStorage = FloatArray(kernelSize * (KERNEL_OFFSET_COUNT + 1))
  private val inputBuffer = FloatArray(inputBufferSize)

  // Region offsets into inputBuffer (see the diagram at the top of sinc_resampler.cc).
  private val r1 = 0
  private val r2 = kernelSize / 2
  private var r0 = 0
  private var r3 = 0
  private var r4 = 0

  init {
    // SincResampler::SincResampler: CHECK_GT(request_frames, kernel_size_ * 3 / 2).
    require(requestFrames > kernelSize * 3 / 2) {
      "request_frames must be greater than 1.5 kernels to allow sufficient data for resampling"
    }
    flush()
    initializeKernel()
  }

  /** `SincResampler::UpdateRegions`: on the second load r0_ slides right by kernel_size_ / 2. */
  private fun updateRegions(secondLoad: Boolean) {
    r0 = if (secondLoad) kernelSize else kernelSize / 2
    r3 = r0 + requestFrames - kernelSize
    r4 = r0 + requestFrames - kernelSize / 2
    blockSize = r4 - r2
    chunkSize = calculateChunkSize(blockSize, ioSampleRateRatio)
    check(r2 - r1 == r4 - r3)
    check(r2 < r3)
  }

  /**
   * `SincResampler::InitializeKernel`: `KERNEL_OFFSET_COUNT + 1` Blackman-windowed sinc kernels for
   * sub-sample offsets 0.0..1.0, with the same float/double mix as the C++ (pre-sinc and window
   * argument in float, window and sinc in double, stored as float).
   */
  private fun initializeKernel() {
    val sincScaleFactor = sincScaleFactor(ioSampleRateRatio, kernelSize)
    for (offsetIdx in 0..KERNEL_OFFSET_COUNT) {
      val subsampleOffset = offsetIdx.toFloat() / KERNEL_OFFSET_COUNT
      for (i in 0 until kernelSize) {
        val idx = i + offsetIdx * kernelSize
        val preSinc = PI_F * (i - kernelSize / 2 - subsampleOffset)
        kernelPreSincStorage[idx] = preSinc
        // Blackman window, matching the offset of the sinc().
        val x = (i - subsampleOffset) / kernelSize
        val window = (A0 - A1 * StrictMath.cos(2.0 * PI * x) + A2 * StrictMath.cos(4.0 * PI * x)).toFloat()
        kernelWindowStorage[idx] = window
        kernelStorage[idx] = (window * windowedSinc(preSinc, sincScaleFactor)).toFloat()
      }
    }
  }

  /**
   * `SincResampler::SetRatio`: ignores changes below double epsilon, otherwise recomputes the
   * kernels from the cached window and pre-sinc values.
   */
  fun setRatio(ioSampleRateRatio: Double) {
    if (abs(this.ioSampleRateRatio - ioSampleRateRatio) < Math.ulp(1.0)) return
    this.ioSampleRateRatio = ioSampleRateRatio
    chunkSize = calculateChunkSize(blockSize, ioSampleRateRatio)
    val sincScaleFactor = sincScaleFactor(ioSampleRateRatio, kernelSize)
    for (offsetIdx in 0..KERNEL_OFFSET_COUNT) {
      for (i in 0 until kernelSize) {
        val idx = i + offsetIdx * kernelSize
        val window = kernelWindowStorage[idx]
        val preSinc = kernelPreSincStorage[idx]
        kernelStorage[idx] = (window * windowedSinc(preSinc, sincScaleFactor)).toFloat()
      }
    }
  }

  /** `SincResampler::Resample`: write [frames] output frames into [destination] from [offset]. */
  fun resample(destination: FloatArray, offset: Int, frames: Int) {
    var remainingFrames = frames
    var d = offset

    // Step (1) -- Prime the input buffer at the start of the input stream.
    if (!bufferPrimed && remainingFrames > 0) {
      readCb.read(inputBuffer, r0, requestFrames)
      bufferPrimed = true
    }

    // Step (2) -- Resample!
    while (remainingFrames > 0) {
      while (virtualSourceIdx < blockSize) {
        // virtual_source_idx_ lies in between two kernel offsets so figure out what they are.
        val sourceIdx = virtualSourceIdx.toInt()
        val virtualOffsetIdx = (virtualSourceIdx - sourceIdx) * KERNEL_OFFSET_COUNT
        val offsetIdx = virtualOffsetIdx.toInt()
        // "Convolutions" for the two kernels which straddle virtual_source_idx_.
        val startingIdx = offsetIdx * kernelSize
        val kernelInterpolationFactor = virtualOffsetIdx - offsetIdx
        destination[d++] = convolveC(
          inputBuffer, r1 + sourceIdx, kernelStorage, startingIdx, startingIdx + kernelSize,
          kernelSize, kernelInterpolationFactor,
        )
        virtualSourceIdx += ioSampleRateRatio
        if (--remainingFrames == 0) return
      }

      // Wrap back around to the start.
      virtualSourceIdx -= blockSize

      // Step (3) -- Copy r3_, r4_ to r1_, r2_.
      System.arraycopy(inputBuffer, r3, inputBuffer, r1, kernelSize)

      // Step (4) -- Reinitialize regions if necessary.
      if (r0 == r2) updateRegions(true)

      // Step (5) -- Refresh the buffer with more input.
      readCb.read(inputBuffer, r0, requestFrames)
    }
  }

  /** `SincResampler::ChunkSize`: max output frames that make [resample] call [readCb] at most once. */
  fun chunkSize(): Int = chunkSize

  /** `SincResampler::GetMaxInputFramesRequested` (the division is in float, as in the C++). */
  fun getMaxInputFramesRequested(outputFramesRequested: Int): Int {
    val numChunks = ceil(outputFramesRequested.toFloat() / chunkSize).toInt()
    return numChunks * requestFrames
  }

  /** `SincResampler::PrimeWithSilence`: must be called before the first [resample] after a [flush]. */
  fun primeWithSilence() {
    check(!bufferPrimed)
    check(inputBuffer[0] == 0f)
    updateRegions(true)
  }

  /** `SincResampler::Flush`: drop all buffered input and reset the indices. */
  fun flush() {
    virtualSourceIdx = 0.0
    bufferPrimed = false
    inputBuffer.fill(0f)
    updateRegions(false)
  }

  /** `SincResampler::BufferedFrames`: input frames read but not yet consumed (fractional). */
  fun bufferedFrames(): Double = if (bufferPrimed) requestFrames - virtualSourceIdx else 0.0

  /**
   * Not in Chromium: how many output frames [resample] can produce before it next calls [readCb]
   * (0 when the next output frame needs a read, including before priming). Replays the exact double
   * accumulation of [resample], so the answer is exact.
   */
  fun framesBeforeNextRead(): Int {
    if (!bufferPrimed) return 0
    var v = virtualSourceIdx
    var n = 0
    while (v < blockSize) {
      n++
      v += ioSampleRateRatio
    }
    return n
  }

  /** `get_kernel_for_testing()`: the kernel table, `(KERNEL_OFFSET_COUNT + 1) * kernelSize` floats. */
  internal fun kernelForTesting(): FloatArray = kernelStorage

  companion object {
    /** `kMaxKernelSize`. */
    const val MAX_KERNEL_SIZE = 64

    /** `kMinKernelSize`. */
    const val MIN_KERNEL_SIZE = 32

    /** `kDefaultRequestSize`. */
    const val DEFAULT_REQUEST_SIZE = 512

    /** `kSmallRequestSize`. */
    const val SMALL_REQUEST_SIZE = MAX_KERNEL_SIZE * 2

    /** `kKernelOffsetCount`: number of sub-sample kernel shifts. */
    const val KERNEL_OFFSET_COUNT = 32

    /** What the Web Audio media-element path asks for: one render quantum (`RenderQuantumFrames()`). */
    const val WEB_AUDIO_RENDER_QUANTUM_FRAMES = 128

    // Blackman window parameters (InitializeKernel).
    private const val ALPHA = 0.16
    private const val A0 = 0.5 * (1.0 - ALPHA)
    private const val A1 = 0.5
    private const val A2 = 0.5 * ALPHA

    /** `std::numbers::pi_v<float>`. */
    private val PI_F = PI.toFloat()

    /** `SincResampler::KernelSizeFromRequestFrames`: 64 taps unless request_frames <= 96. */
    fun kernelSizeFromRequestFrames(requestFrames: Int): Int {
      val smallKernelLimit = MAX_KERNEL_SIZE * 3 / 2
      return if (requestFrames <= smallKernelLimit) MIN_KERNEL_SIZE else MAX_KERNEL_SIZE
    }

    /**
     * `SincScaleFactor` (sinc_resampler.cc): the normalized low-pass cutoff, `1 / io_ratio` when
     * downsampling, else 1, then pulled down by 0.92 (64 taps) or 0.90 (32 taps).
     */
    fun sincScaleFactor(ioRatio: Double, kernelSize: Int): Double {
      var sincScaleFactor = if (ioRatio > 1.0) 1.0 / ioRatio else 1.0
      sincScaleFactor *= if (kernelSize == MAX_KERNEL_SIZE) 0.92 else {
        require(kernelSize == MIN_KERNEL_SIZE)
        0.90
      }
      return sincScaleFactor
    }

    /**
     * The ratio Blink hands to the resampler: `source_sample_rate / Context()->sampleRate()` where
     * both are `float` (media_element_audio_source_handler.cc, `SetFormat`). For 44100 -> 48000 this is
     * 0.918749988079071, not 0.91875.
     */
    fun blinkMediaElementRatio(sourceRate: Int, contextRate: Int): Double =
      (sourceRate.toFloat() / contextRate.toFloat()).toDouble()

    /** `CalculateChunkSize`: `block_size_ / io_ratio`, truncated to int. */
    private fun calculateChunkSize(blockSize: Int, ioRatio: Double): Int = (blockSize / ioRatio).toInt()

    private fun windowedSinc(preSinc: Float, sincScaleFactor: Double): Double =
      if (preSinc != 0f) StrictMath.sin(sincScaleFactor * preSinc) / preSinc else sincScaleFactor

    /**
     * `SincResampler::Convolve_C`: both dot products accumulate in float (`float sum1 += in * k`, no
     * fused multiply-add on the JVM), then the two are blended in double and narrowed to float.
     */
    fun convolveC(
      input: FloatArray,
      inputOffset: Int,
      kernels: FloatArray,
      k1Offset: Int,
      k2Offset: Int,
      size: Int,
      kernelInterpolationFactor: Double,
    ): Float {
      var sum1 = 0f
      var sum2 = 0f
      for (i in 0 until size) {
        val x = input[inputOffset + i]
        sum1 += x * kernels[k1Offset + i]
        sum2 += x * kernels[k2Offset + i]
      }
      // Linearly interpolate the two "convolutions".
      return ((1.0 - kernelInterpolationFactor) * sum1 + kernelInterpolationFactor * sum2).toFloat()
    }
  }
}

/**
 * A port of Chromium's `media::MultiChannelResampler` (media/base/multi_channel_resampler.cc, tag
 * 152.0.7977.65): one [SincResampler] per channel, all with the same ratio and request size, driven
 * in [SincResampler.chunkSize] chunks so each channel reads at most once per chunk; channel 0's read
 * pulls every channel from [readCb] and the other channels copy their share.
 *
 * Chromium lets channel 0's read land directly in that resampler's buffer and stages the others in
 * `resampler_audio_bus_`; here all channels are staged in [scratch] and copied, which gives the
 * same samples.
 */
class MultiChannelSincResampler(
  val channels: Int,
  ioSampleRateRatio: Double,
  val requestSize: Int,
  private val readCb: ReadCB,
) {
  /** `MultiChannelResampler::ReadCB`: fill `destination[c][0 until frames]` for every channel. */
  fun interface ReadCB {
    fun read(frameDelay: Int, destination: Array<FloatArray>, frames: Int)
  }

  private val scratch = Array(channels) { FloatArray(requestSize) }
  private var outputFramesReady = 0

  private val resamplers: List<SincResampler> = List(channels) { channel ->
    SincResampler(ioSampleRateRatio, requestSize) { dst, off, frames -> provideInput(channel, dst, off, frames) }
  }

  /** `MultiChannelResampler::Resample`: write [frames] frames into each `bus[c]` from [offset]. */
  fun resample(bus: Array<FloatArray>, offset: Int, frames: Int) {
    require(bus.size == channels)
    // Optimize the single channel case to avoid the chunking process below.
    if (channels == 1) {
      resamplers[0].resample(bus[0], offset, frames)
      return
    }
    // Chunk so SincResampler only calls ProvideInput once per channel per chunk.
    outputFramesReady = 0
    while (outputFramesReady < frames) {
      val chunkSize = resamplers[0].chunkSize()
      val framesThisTime = minOf(frames - outputFramesReady, chunkSize)
      for (i in resamplers.indices) {
        check(chunkSize == resamplers[i].chunkSize())
        resamplers[i].resample(bus[i], offset + outputFramesReady, framesThisTime)
      }
      outputFramesReady += framesThisTime
    }
  }

  /** `MultiChannelResampler::ProvideInput`. */
  private fun provideInput(channel: Int, destination: FloatArray, offset: Int, frames: Int) {
    if (channel == 0) {
      readCb.read(outputFramesReady, scratch, frames)
    } else {
      // All channels must ask for the same amount.
      check(frames == requestSize)
    }
    System.arraycopy(scratch[channel], 0, destination, offset, frames)
  }

  /** `MultiChannelResampler::Flush`. */
  fun flush() = resamplers.forEach { it.flush() }

  /** `MultiChannelResampler::SetRatio`. */
  fun setRatio(ioSampleRateRatio: Double) = resamplers.forEach { it.setRatio(ioSampleRateRatio) }

  /** `MultiChannelResampler::ChunkSize`. */
  fun chunkSize(): Int = resamplers[0].chunkSize()

  /** `MultiChannelResampler::GetMaxInputFramesRequested`. */
  fun getMaxInputFramesRequested(outputFramesRequested: Int): Int =
    resamplers[0].getMaxInputFramesRequested(outputFramesRequested)

  /** `MultiChannelResampler::BufferedFrames`. */
  fun bufferedFrames(): Double = resamplers[0].bufferedFrames()

  /** `MultiChannelResampler::PrimeWithSilence`. */
  fun primeWithSilence() = resamplers.forEach { it.primeWithSilence() }

  /** `MultiChannelResampler::KernelSize`. */
  fun kernelSize(): Int = resamplers[0].kernelSize

  /** See [SincResampler.framesBeforeNextRead]; every channel advances in lockstep. */
  fun framesBeforeNextRead(): Int = resamplers[0].framesBeforeNextRead()
}
