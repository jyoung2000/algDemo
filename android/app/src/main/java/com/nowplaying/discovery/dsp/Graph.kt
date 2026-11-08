package com.nowplaying.discovery.dsp

/**
 * A stereo render-quantum buffer with Chromium's silent flag.
 *
 * Port of the parts of `platform/audio/audio_bus.cc` and `audio_channel.{h,cc}` the graph uses
 * (Chromium 152.0.7977.65): `Zero()` (fills only when not already silent, then marks silent),
 * `SumFrom()` (skips a silent source, copies into a silent destination, adds otherwise),
 * `CopyWithGainFrom()` and `CopyWithSampleAccurateGainValuesFrom()`. Every node in this graph is
 * stereo, so one flag stands for both channels (they are always zeroed and written together).
 */
class AudioBus(val frames: Int = 128) {
  val channels: Array<FloatArray> = arrayOf(FloatArray(frames), FloatArray(frames))
  var isSilent: Boolean = true
    internal set

  fun zero() {
    if (!isSilent) {
      channels[0].fill(0f)
      channels[1].fill(0f)
    }
    isSilent = true
  }

  /** `MutableSpan()` clears the flag; callers then write every frame. */
  internal fun markWritten() {
    isSilent = false
  }

  fun copyFrom(source: AudioBus) {
    if (source.isSilent) {
      zero()
      return
    }
    for (c in 0..1) System.arraycopy(source.channels[c], 0, channels[c], 0, frames)
    isSilent = false
  }

  fun sumFrom(source: AudioBus) {
    if (source.isSilent) return
    if (isSilent) {
      copyFrom(source)
      return
    }
    for (c in 0..1) {
      val d = channels[c]
      val s = source.channels[c]
      for (i in 0 until frames) d[i] = d[i] + s[i]
    }
  }

  fun copyWithGainFrom(source: AudioBus, gain: Float) {
    if (source.isSilent) {
      zero()
      return
    }
    when (gain) {
      1f -> for (c in 0..1) System.arraycopy(source.channels[c], 0, channels[c], 0, frames)
      0f -> for (c in 0..1) channels[c].fill(0f)
      else -> for (c in 0..1) {
        val d = channels[c]
        val s = source.channels[c]
        for (i in 0 until frames) d[i] = s[i] * gain
      }
    }
    isSilent = false
  }

  fun copyWithSampleAccurateGainValuesFrom(source: AudioBus, gains: FloatArray) {
    if (source.isSilent) {
      zero()
      return
    }
    for (c in 0..1) {
      val d = channels[c]
      val s = source.channels[c]
      for (i in 0 until frames) d[i] = s[i] * gains[i]
    }
    isSilent = false
  }
}

/**
 * A node in the pull graph. Port of `AudioHandler::ProcessIfNecessary`, `PropagatesSilence`,
 * `InputsAreSilent`, `SilenceOutputs`/`UnsilenceOutputs` (modules/webaudio/audio_handler.cc) and
 * `AudioNodeInput::Pull`/`SumAllConnections` (audio_node_input.cc), Chromium 152.0.7977.65.
 *
 * A node processes once per quantum. When every input is silent and the node's
 * `lastNonSilentTime + latency + tail` is in the past, the output is zeroed and only the params
 * advance (`ProcessOnlyAudioParams`) — which freezes, for example, a biquad's state exactly as
 * Chromium does. Inputs are summed in connection order.
 */
abstract class AudioNode(protected val ctx: RenderContext) {
  internal val inputs = ArrayList<AudioNode>()
  private val destinations = ArrayList<AudioNode>()
  val output = AudioBus(ctx.quantumFrames)
  private val summingBus = AudioBus(ctx.quantumFrames)
  private var lastProcessedFrame = -1L
  private var lastNonSilentTime = 0.0

  open fun tailTime(): Double = 0.0
  open fun latencyTime(): Double = 0.0

  fun connect(destination: AudioNode) {
    destination.inputs.add(this)
    destinations.add(destination)
  }

  /** Remove every connection out of this node. */
  fun disconnect() {
    for (d in destinations) d.inputs.remove(this)
    destinations.clear()
  }

  internal fun pull(): AudioBus {
    processIfNecessary()
    return output
  }

  protected open fun pullInput(): AudioBus {
    if (inputs.size == 1) return inputs[0].pull()
    summingBus.zero()
    for (node in inputs) summingBus.sumFrom(node.pull())
    return summingBus
  }

  private fun processIfNecessary() {
    if (lastProcessedFrame == ctx.currentSampleFrame) return
    lastProcessedFrame = ctx.currentSampleFrame
    val input = pullInput()
    val silentInputs = inputsAreSilent(input)
    if (silentInputs && propagatesSilence()) {
      output.zero()
      processOnlyAudioParams()
    } else {
      output.markWritten()
      process(input)
    }
    if (!silentInputs) {
      lastNonSilentTime = (ctx.currentSampleFrame + ctx.quantumFrames) / ctx.sampleRate.toDouble()
    }
  }

  protected open fun inputsAreSilent(input: AudioBus): Boolean = input.isSilent

  private fun propagatesSilence(): Boolean = lastNonSilentTime + latencyTime() + tailTime() < ctx.currentTime

  protected abstract fun process(input: AudioBus)
  protected open fun processOnlyAudioParams() {}
}

/** Port of `GainHandler::Process` / `ProcessOnlyAudioParams` (modules/webaudio/gain_handler.cc). */
class GainNode(ctx: RenderContext) : AudioNode(ctx) {
  val gain = AudioParam(ctx, 1f)
  private val values = FloatArray(ctx.quantumFrames)

  override fun process(input: AudioBus) {
    val sampleAccurate = gain.hasSampleAccurateValues()
    if (sampleAccurate && gain.isAudioRate) {
      gain.calculateSampleAccurateValues(values, ctx.quantumFrames)
      output.copyWithSampleAccurateGainValuesFrom(input, values)
      return
    }
    val g = if (sampleAccurate) gain.finalValue() else gain.valueOnRenderThread()
    if (g == 0f) output.zero() else output.copyWithGainFrom(input, g)
  }

  override fun processOnlyAudioParams() {
    gain.calculateSampleAccurateValues(values, ctx.quantumFrames)
  }
}

/**
 * The deck's input: a stereo PCM stream fed one quantum at a time (the reference's playing
 * `AudioBufferSourceNode`, which writes every frame and so is never flagged silent).
 */
class SourceNode(ctx: RenderContext) : AudioNode(ctx) {
  private var left: FloatArray = FloatArray(ctx.quantumFrames)
  private var right: FloatArray = FloatArray(ctx.quantumFrames)
  private var offset = 0

  fun feed(left: FloatArray, right: FloatArray, offset: Int = 0) {
    this.left = left
    this.right = right
    this.offset = offset
  }

  override fun pullInput(): AudioBus = output
  override fun inputsAreSilent(input: AudioBus): Boolean = false

  override fun process(input: AudioBus) {
    System.arraycopy(left, offset, output.channels[0], 0, ctx.quantumFrames)
    System.arraycopy(right, offset, output.channels[1], 0, ctx.quantumFrames)
  }
}
