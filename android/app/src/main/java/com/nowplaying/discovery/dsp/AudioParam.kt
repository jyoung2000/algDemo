package com.nowplaying.discovery.dsp

import java.util.Collections
import java.util.IdentityHashMap
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

/**
 * The render clock of one graph: the frame the next render quantum starts at.
 *
 * Mirrors what Chromium's `AudioDestinationHandler` reports: `CurrentSampleFrame()` and
 * `CurrentTime() = frame / sampleRate`. Main-thread calls (the bus's actions) happen between quanta,
 * exactly where `OfflineAudioContext.suspend()` runs them.
 */
class RenderContext(val sampleRate: Float = 48000f, val quantumFrames: Int = 128) {
  var currentSampleFrame: Long = 0
    internal set
  val currentTime: Double get() = currentSampleFrame / sampleRate.toDouble()
}

/** Thrown where Chromium throws a DOMException/RangeError from an AudioParam method. */
class AudioParamException(message: String) : RuntimeException(message)

/**
 * One automation event. Port of `AudioParamHandler::ParamEvent`
 * (third_party/blink/renderer/modules/webaudio/audio_param_handler.{h,cc}, Chromium 152.0.7977.65,
 * the version inside the repo's Electron 44.1.1 that renders the reference fixtures).
 *
 * `kSetTarget` is not ported: neither eq.ts nor audio-bus.ts calls `setTargetAtTime`.
 */
internal class ParamEvent(
  val type: Type,
  var value: Float,
  var time: Double,
  val initialValue: Float = 0f,
  val callTime: Double = 0.0,
  val timeConstant: Double = 0.0,
  val duration: Double = 0.0,
  val curve: FloatArray = EMPTY,
  val curvePointsPerSecond: Double = 0.0,
  val curveEndValue: Float = 0f,
  val savedEvent: ParamEvent? = null,
) {
  enum class Type { SET_VALUE, LINEAR_RAMP, EXPONENTIAL_RAMP, SET_VALUE_CURVE, CANCEL_VALUES, SET_VALUE_CURVE_END }

  var hasDefaultCancelledValue = false
    private set

  fun setCancelledValue(v: Float) {
    value = v
    hasDefaultCancelledValue = true
  }

  companion object {
    val EMPTY = FloatArray(0)

    fun setValue(value: Float, time: Double) = ParamEvent(Type.SET_VALUE, value, time)

    fun linearRamp(value: Float, time: Double, initialValue: Float, callTime: Double) =
      ParamEvent(Type.LINEAR_RAMP, value, time, initialValue, callTime)

    fun exponentialRamp(value: Float, time: Double, initialValue: Float, callTime: Double) =
      ParamEvent(Type.EXPONENTIAL_RAMP, value, time, initialValue, callTime)

    /** `CreateSetValueCurveEvent`: curve_points = (n - 1) / duration, end value = the last point. */
    fun setValueCurve(curve: FloatArray, time: Double, duration: Double) =
      ParamEvent(Type.SET_VALUE_CURVE, 0f, time, duration = duration, curve = curve.copyOf(),
        curvePointsPerSecond = (curve.size - 1) / duration, curveEndValue = curve.last())

    fun setValueCurveEnd(value: Float, time: Double) = ParamEvent(Type.SET_VALUE_CURVE_END, value, time)

    fun cancelValues(time: Double, saved: ParamEvent?) = ParamEvent(Type.CANCEL_VALUES, 0f, time, savedEvent = saved)
  }
}

/**
 * A Web Audio `AudioParam`: the intrinsic value, the event timeline, and the per-quantum values.
 *
 * Ported statement by statement from Chromium 152.0.7977.65:
 * - `modules/webaudio/audio_param.cc` — the JS-facing `value` getter/setter (the setter also
 *   schedules `setValueAtTime(intrinsic, currentTime)`) and the ramp methods passing
 *   `IntrinsicValue()` and `currentTime` as the ramp's initial value and call time.
 * - `modules/webaudio/audio_param_handler.cc` — `SetValueAtTime`, `LinearRampToValueAtTime`,
 *   `ExponentialRampToValueAtTime`, `SetValueCurveAtTime` (+ its `kSetValueCurveEnd` marker),
 *   `InsertEvent` (stale-event removal, the implicit SetValue before a first ramp, upper-bound
 *   insertion, overlap checks), `CancelScheduledValues`, `CancelAndHoldAtTime`,
 *   `HasSampleAccurateValues`, `Value`, `FinalValue`, `CalculateSampleAccurateValues`,
 *   `CalculateFinalValues`, `ValueForContextTime`, `ValuesForFrameRange(Impl)`, `HandleFirstEvent`,
 *   `IsEventCurrent`, `ClampNewEventsToCurrentTime` (152 clamps curve events too),
 *   `HandleAllEventsInThePast`, `HandleCancelValues`, `ProcessLinearRamp` (the x86 SSE path: the
 *   reference renders on x86-64), `ProcessExponentialRamp`, `ProcessSetValueCurve` (x86 SSE path,
 *   152's fill_to_frame not limited by the next event), `ProcessCancelValues`,
 *   `RemoveCancelledEvents`, `RemoveOldEvents`, and the anonymous-namespace `LinearRampAtTime`,
 *   `ExponentialRampAtTime`, `ValueCurveAtTime`.
 *
 * `fdlibm::pow` is `StrictMath.pow` (both are fdlibm). Audio-rate connections into a param are not
 * ported (the graph has none).
 */
class AudioParam internal constructor(
  private val ctx: RenderContext,
  val defaultValue: Float,
  val minValue: Float = -Float.MAX_VALUE,
  val maxValue: Float = Float.MAX_VALUE,
  val isAudioRate: Boolean = true,
) {
  private var intrinsic: Float = defaultValue
  private val events = ArrayList<ParamEvent>()
  private val newEvents: MutableSet<ParamEvent> = Collections.newSetFromMap(IdentityHashMap())
  private var pendingError: String? = null

  private val sampleRate: Double get() = ctx.sampleRate.toDouble()

  /* ------------------------------------------------------------ JS-facing API (main thread) */

  /**
   * `AudioParam.value`. Reading off the audio thread returns the intrinsic value (the last value the
   * render thread stored); writing clamps it and schedules `setValueAtTime(intrinsic, currentTime)`.
   */
  var value: Float
    get() {
      val v = intrinsic
      setIntrinsic(v)
      return v
    }
    set(v) {
      setIntrinsic(v)
      setValueAtTime(intrinsic, ctx.currentTime)
    }

  /** The intrinsic value, for tests. */
  val intrinsicValue: Float get() = intrinsic

  fun setValueAtTime(value: Float, startTime: Double): AudioParam {
    requireNonNegative(startTime, "Time")
    insertEvent(ParamEvent.setValue(value, clampedToCurrentTime(startTime)))
    throwPending()
    return this
  }

  fun linearRampToValueAtTime(value: Float, endTime: Double): AudioParam {
    requireNonNegative(endTime, "Time")
    insertEvent(ParamEvent.linearRamp(value, clampedToCurrentTime(endTime), intrinsic, ctx.currentTime))
    throwPending()
    return this
  }

  fun exponentialRampToValueAtTime(value: Float, endTime: Double): AudioParam {
    requireNonNegative(endTime, "Time")
    if (value == 0f) throw AudioParamException("The float target value provided ($value) should not be in the range (-denorm_min, denorm_min).")
    insertEvent(ParamEvent.exponentialRamp(value, clampedToCurrentTime(endTime), intrinsic, ctx.currentTime))
    throwPending()
    return this
  }

  fun setValueCurveAtTime(curve: FloatArray, startTime: Double, duration: Double): AudioParam {
    requireNonNegative(startTime, "Time")
    if (!(duration > 0)) throw AudioParamException("Duration must be a finite positive number: $duration")
    if (curve.size < 2) throw AudioParamException("The curve length provided (${curve.size}) is less than the minimum bound (2).")
    val start = clampedToCurrentTime(startTime)
    if (insertEvent(ParamEvent.setValueCurve(curve, start, duration))) {
      insertEvent(ParamEvent.setValueCurveEnd(curve.last(), start + duration))
    }
    throwPending()
    return this
  }

  fun cancelScheduledValues(cancelTime: Double): AudioParam {
    requireNonNegative(cancelTime, "Time")
    val t = clampedToCurrentTime(cancelTime)
    for (i in events.indices) {
      val e = events[i]
      val start = e.time
      if (start >= t || (e.type == ParamEvent.Type.SET_VALUE_CURVE && start <= t && start + e.duration > t)) {
        removeCancelledEvents(i)
        break
      }
    }
    return this
  }

  fun cancelAndHoldAtTime(cancelTime: Double): AudioParam {
    requireNonNegative(cancelTime, "Time")
    val t = clampedToCurrentTime(cancelTime)
    var i = 0
    while (i < events.size) {
      if (events[i].time > t) break
      i += 1
    }
    var cancelledIndex = i
    if (i > 0 && events[i - 1].type == ParamEvent.Type.SET_VALUE_CURVE) {
      cancelledIndex = i - 1
    } else if (i >= events.size) {
      return this
    }
    val cancelled = events[cancelledIndex]
    var newEvent: ParamEvent? = null
    var newSetValueEvent: ParamEvent? = null
    when (cancelled.type) {
      ParamEvent.Type.LINEAR_RAMP, ParamEvent.Type.EXPONENTIAL_RAMP -> {
        val saved = ParamEvent(cancelled.type, cancelled.value, cancelled.time, cancelled.initialValue, cancelled.callTime,
          cancelled.timeConstant, cancelled.duration, cancelled.curve, cancelled.curvePointsPerSecond, cancelled.curveEndValue, null)
        newEvent = ParamEvent.cancelValues(t, saved)
      }
      ParamEvent.Type.SET_VALUE_CURVE -> {
        if (cancelled.time < t) {
          if (t > cancelled.time + cancelled.duration) {
            cancelledIndex += 1
          } else {
            val newDuration = t - cancelled.time
            val endValue = valueCurveAtTime(t, cancelled.time, cancelled.duration, cancelled.curve)
            newEvent = ParamEvent(cancelled.type, cancelled.value, cancelled.time, cancelled.initialValue, cancelled.callTime,
              cancelled.timeConstant, newDuration, cancelled.curve, cancelled.curvePointsPerSecond, endValue, null)
            newSetValueEvent = ParamEvent.setValue(endValue, cancelled.time + newDuration)
          }
        }
      }
      else -> Unit
    }
    if (cancelledIndex < events.size) removeCancelledEvents(cancelledIndex)
    if (newEvent != null) {
      insertEvent(newEvent)
      if (newSetValueEvent != null) insertEvent(newSetValueEvent)
    }
    throwPending()
    return this
  }

  /* ------------------------------------------------------------ render thread */

  /** `HasSampleAccurateValues()` (no connections into the param). */
  fun hasSampleAccurateValues(): Boolean {
    val n = events.size
    if (n == 0) return false
    val currentFrame = ctx.currentSampleFrame
    val sr = sampleRate
    val rq = ctx.quantumFrames
    val first = events[0]
    if (first.time > (currentFrame + rq) / sr) {
      when (first.type) {
        ParamEvent.Type.SET_VALUE, ParamEvent.Type.SET_VALUE_CURVE -> return false
        else -> Unit
      }
    }
    if (n >= 2) return true
    return when (first.type) {
      ParamEvent.Type.SET_VALUE, ParamEvent.Type.LINEAR_RAMP, ParamEvent.Type.EXPONENTIAL_RAMP,
      ParamEvent.Type.CANCEL_VALUES, ParamEvent.Type.SET_VALUE_CURVE_END -> !(first.time < currentFrame / sr)
      ParamEvent.Type.SET_VALUE_CURVE -> {
        val curveEndTime = first.time + first.duration
        val currentTime = currentFrame / sr
        first.time <= currentTime && currentTime < curveEndTime
      }
    }
  }

  /** `Value()` on the audio thread: the timeline value at the quantum's first frame. */
  internal fun valueOnRenderThread(): Float {
    var v = intrinsic
    val (has, timelineValue) = valueForContextTime(v)
    if (has) v = timelineValue
    setIntrinsic(v)
    return v
  }

  /** `FinalValue()`: `CalculateFinalValues(span_from_ref(value), false)`. */
  internal fun finalValue(): Float {
    val one = FloatArray(1)
    one[0] = intrinsic
    calculateFinalValues(one, 1, false)
    return one[0]
  }

  /** `CalculateSampleAccurateValues(values)` for the first [frames] entries. */
  internal fun calculateSampleAccurateValues(values: FloatArray, frames: Int) {
    calculateFinalValues(values, frames, isAudioRate)
  }

  private fun calculateFinalValues(values: FloatArray, frames: Int, sampleAccurate: Boolean) {
    if (sampleAccurate) {
      calculateTimelineValues(values, frames)
    } else {
      var v = intrinsic
      val (has, timelineValue) = valueForContextTime(v)
      if (has) v = timelineValue
      values.fill(v, 0, frames)
      setIntrinsic(v)
    }
  }

  private fun calculateTimelineValues(values: FloatArray, frames: Int) {
    val start = ctx.currentSampleFrame
    setIntrinsic(valuesForFrameRange(start, start + frames, intrinsic, values, frames, sampleRate, sampleRate / ctx.quantumFrames))
  }

  private fun valueForContextTime(defaultValue: Float): Pair<Boolean, Float> {
    if (events.isEmpty() || ctx.currentTime < events[0].time) return false to defaultValue
    val one = FloatArray(1)
    val start = ctx.currentSampleFrame
    val v = valuesForFrameRange(start, start + 1, defaultValue, one, 1, sampleRate, sampleRate / ctx.quantumFrames)
    return true to v
  }

  private fun valuesForFrameRange(
    startFrame: Long,
    endFrame: Long,
    defaultValue: Float,
    values: FloatArray,
    size: Int,
    sampleRate: Double,
    controlRate: Double,
  ): Float {
    val last = valuesForFrameRangeImpl(startFrame, endFrame, defaultValue, values, size, sampleRate)
    for (i in 0 until size) values[i] = values[i].coerceIn(minValue, maxValue)
    return last
  }

  private fun valuesForFrameRangeImpl(
    startFrame: Long,
    endFrame: Long,
    defaultValueIn: Float,
    values: FloatArray,
    size: Int,
    sampleRate: Double,
  ): Float {
    var defaultValue = defaultValueIn
    if (events.isEmpty() || (endFrame / sampleRate <= events[0].time)) {
      values.fill(defaultValue, 0, size)
      return defaultValue
    }
    val numberOfEvents = events.size
    if (newEvents.isNotEmpty()) clampNewEventsToCurrentTime(startFrame / sampleRate)
    // HandleAllEventsInThePast
    run {
      val currentTime = startFrame / sampleRate
      val lastEvent = events[events.size - 1]
      if (lastEvent.time + 1.5 * ctx.quantumFrames / sampleRate < currentTime) {
        values.fill(defaultValue, 0, size)
        removeOldEvents(events.size)
        return defaultValue
      }
    }
    // HandleFirstEvent
    var currentFrame = startFrame
    var writeIndex = 0
    run {
      val firstEventTime = events[0].time
      if (firstEventTime > startFrame / sampleRate) {
        var fillToEndFrame = endFrame
        val firstEventFrame = ceil(firstEventTime * sampleRate)
        if (endFrame > firstEventFrame) fillToEndFrame = firstEventFrame.toLong()
        val fillToFrame = min((fillToEndFrame - startFrame).toInt(), size)
        values.fill(defaultValue, writeIndex, fillToFrame)
        writeIndex = fillToFrame
        currentFrame += fillToFrame
      }
    }
    var value = defaultValue
    var skippedEventCount = 0
    var i = 0
    while (i < numberOfEvents && writeIndex < size) {
      val event = events[i]
      val nextEvent = if (i < numberOfEvents - 1) events[i + 1] else null
      if (!isEventCurrent(event, nextEvent, currentFrame, sampleRate)) {
        skippedEventCount += 1
        i += 1
        continue
      }
      val value1 = event.value
      val time1 = event.time
      // HandleCancelValues
      var value2 = nextEvent?.value ?: value1
      var time2 = nextEvent?.time ?: (endFrame / sampleRate + 1)
      var nextEventType: ParamEvent.Type? = nextEvent?.type
      if (nextEvent != null && nextEvent.type == ParamEvent.Type.CANCEL_VALUES && nextEvent.savedEvent != null) {
        when (event.type) {
          ParamEvent.Type.CANCEL_VALUES, ParamEvent.Type.LINEAR_RAMP, ParamEvent.Type.EXPONENTIAL_RAMP,
          ParamEvent.Type.SET_VALUE_CURVE_END, ParamEvent.Type.SET_VALUE -> {
            val saved = nextEvent.savedEvent
            time2 = nextEvent.time
            nextEventType = saved.type
            if (nextEvent.hasDefaultCancelledValue) {
              value2 = nextEvent.value
            } else {
              value2 = when (saved.type) {
                ParamEvent.Type.LINEAR_RAMP -> linearRampAtTime(nextEvent.time, value1, time1, saved.value, saved.time)
                ParamEvent.Type.EXPONENTIAL_RAMP -> exponentialRampAtTime(nextEvent.time, value1, time1, saved.value, saved.time)
                else -> error("unreachable saved event ${saved.type}")
              }
              nextEvent.setCancelledValue(value2)
            }
          }
          ParamEvent.Type.SET_VALUE_CURVE -> Unit
        }
      }
      check(time2 >= time1) { "time2 < time1" }
      val fillToEndFrame = if (endFrame > time2 * sampleRate) ceil(time2 * sampleRate).toLong() else endFrame
      val fillToFrame = min((fillToEndFrame - startFrame).toInt(), size)
      check(fillToFrame >= writeIndex) { "fill_to_frame < write_index" }
      if (nextEventType == ParamEvent.Type.LINEAR_RAMP) {
        val r = processLinearRamp(fillToFrame, time1, time2, value1, value2, sampleRate, values, currentFrame, value, writeIndex)
        currentFrame = r.frame; value = r.value; writeIndex = r.writeIndex
      } else if (nextEventType == ParamEvent.Type.EXPONENTIAL_RAMP) {
        val r = processExponentialRamp(fillToFrame, time1, time2, value1, value2, sampleRate, values, currentFrame, value, writeIndex)
        currentFrame = r.frame; value = r.value; writeIndex = r.writeIndex
      } else {
        when (event.type) {
          ParamEvent.Type.SET_VALUE, ParamEvent.Type.SET_VALUE_CURVE_END, ParamEvent.Type.LINEAR_RAMP,
          ParamEvent.Type.EXPONENTIAL_RAMP -> {
            currentFrame = fillToEndFrame
            value = event.value
            values.fill(value, writeIndex, fillToFrame)
            writeIndex = fillToFrame
          }
          ParamEvent.Type.CANCEL_VALUES -> {
            // ProcessCancelValues (the setTarget branch cannot occur: no setTarget events).
            if (event.hasDefaultCancelledValue) value = event.value
            values.fill(value, writeIndex, fillToFrame)
            writeIndex = fillToFrame
            currentFrame = fillToEndFrame
          }
          ParamEvent.Type.SET_VALUE_CURVE -> {
            val r = processSetValueCurve(fillToFrame, time1, sampleRate, startFrame, endFrame, fillToEndFrame, event, values, size,
              currentFrame, value, writeIndex)
            currentFrame = r.frame; value = r.value; writeIndex = r.writeIndex
          }
        }
      }
      i += 1
    }
    if (skippedEventCount > 0) removeOldEvents(skippedEventCount)
    values.fill(value, writeIndex, size)
    return values[size - 1]
  }

  private class Step(val frame: Long, val value: Float, val writeIndex: Int)

  /** `ProcessLinearRamp`, ARCH_CPU_X86_FAMILY branch: SSE four-lane fill, then the scalar tail. */
  private fun processLinearRamp(
    fillToFrame: Int,
    time1: Double,
    time2: Double,
    value1: Float,
    value2: Float,
    sampleRate: Double,
    values: FloatArray,
    currentFrameIn: Long,
    valueIn: Float,
    writeIndexIn: Int,
  ): Step {
    var currentFrame = currentFrameIn
    var value = valueIn
    var writeIndex = writeIndexIn
    val deltaTime = time2 - time1
    val k: Float = if (deltaTime <= java.lang.Float.MIN_NORMAL) 0f else (1 / deltaTime).toFloat()
    val valueDelta = value2 - value1
    if (fillToFrame > writeIndex) {
      val invRate = (1 / sampleRate).toFloat()
      val offset = (currentFrame / sampleRate - time1).toFloat()
      val scale = k * valueDelta
      val lane = FloatArray(4)
      for (j in 0 until 4) lane[j] = (invRate * j.toFloat() + offset) * scale + value1
      val inc = (4 / sampleRate * k * valueDelta).toFloat()
      val truncEnd = writeIndex + ((fillToFrame - writeIndex) / 4) * 4
      currentFrame += (truncEnd - writeIndex).toLong()
      while (writeIndex < truncEnd) {
        for (j in 0 until 4) {
          values[writeIndex + j] = lane[j]
          lane[j] = lane[j] + inc
        }
        writeIndex += 4
      }
    }
    if (writeIndex >= 1) value = values[writeIndex - 1]
    while (writeIndex < fillToFrame) {
      val x = ((currentFrame / sampleRate - time1) * k).toFloat()
      value = value1 + x * valueDelta
      currentFrame += 1
      values[writeIndex] = value
      writeIndex += 1
    }
    return Step(currentFrame, value, fillToFrame)
  }

  /** `ProcessExponentialRamp`. */
  private fun processExponentialRamp(
    fillToFrame: Int,
    time1: Double,
    time2: Double,
    value1: Float,
    value2: Float,
    sampleRate: Double,
    values: FloatArray,
    currentFrameIn: Long,
    valueIn: Float,
    writeIndexIn: Int,
  ): Step {
    var currentFrame = currentFrameIn
    var value = valueIn
    var writeIndex = writeIndexIn
    if (value1 * value2 <= 0 || time1 >= time2) {
      value = value1
      values.fill(value, writeIndex, fillToFrame)
      writeIndex = fillToFrame
    } else {
      val deltaTime = time2 - time1
      val numSampleFrames = deltaTime * sampleRate
      val multiplier = StrictMath.pow((value2 / value1).toDouble(), 1.0 / numSampleFrames)
      value = (value1 * StrictMath.pow(value2 / value1.toDouble(), (currentFrame / sampleRate - time1) / deltaTime)).toFloat()
      var accumulator = value.toDouble()
      while (writeIndex < fillToFrame) {
        value = accumulator.toFloat()
        accumulator *= multiplier
        currentFrame += 1
        values[writeIndex] = value
        writeIndex += 1
      }
      writeIndex = fillToFrame
      if (currentFrame > time2 * sampleRate - 0.5) value = value2
    }
    return Step(currentFrame, value, writeIndex)
  }

  /** `ProcessSetValueCurve` (Chromium 152), ARCH_CPU_X86_FAMILY branch then the scalar tail. */
  private fun processSetValueCurve(
    fillToFrameIn: Int,
    time1: Double,
    sampleRate: Double,
    startFrame: Long,
    endFrame: Long,
    fillToEndFrameIn: Long,
    event: ParamEvent,
    values: FloatArray,
    size: Int,
    currentFrameIn: Long,
    valueIn: Float,
    writeIndexIn: Int,
  ): Step {
    var currentFrame = currentFrameIn
    var value = valueIn
    var writeIndex = writeIndexIn
    var fillToFrame = fillToFrameIn
    val curve = event.curve
    val curveEndValue = event.curveEndValue
    val duration = event.duration
    val curvePointsPerFrame = event.curvePointsPerSecond / sampleRate
    if (curve.isEmpty() || duration <= 0 || sampleRate <= 0) {
      currentFrame = fillToEndFrameIn
      values.fill(value, writeIndex, fillToFrame)
      return Step(currentFrame, value, fillToFrame)
    }
    val nextEventFillToFrame = fillToFrame
    val curveEndFrame = ceil(sampleRate * (time1 + duration))
    val fillToEndFrame = if (endFrame > curveEndFrame) curveEndFrame.toLong() else endFrame
    fillToFrame = if (fillToEndFrame < startFrame) 0 else (fillToEndFrame - startFrame).toInt()
    fillToFrame = min(fillToFrame, size)
    var curveVirtualIndex = 0.0
    if (time1 < currentFrame / sampleRate) {
      val frameOffset = currentFrame - time1 * sampleRate
      curveVirtualIndex = curvePointsPerFrame * frameOffset
    }
    value = curveEndValue
    var k = 0L
    if (fillToFrame > writeIndex) {
      val vIndex = curveVirtualIndex.toFloat()
      val vPerFrame = curvePointsPerFrame.toFloat()
      val lastPoint = (curve.size - 1).toFloat()
      val vk = floatArrayOf(0f, 1f, 2f, 3f)
      val truncatedSteps = ((fillToFrame - writeIndex) / 4) * 4
      val truncEnd = writeIndex + truncatedSteps
      while (writeIndex < truncEnd) {
        for (j in 0 until 4) {
          val current = vIndex + vk[j] * vPerFrame
          vk[j] = vk[j] + 4f
          val index0 = min(current, lastPoint).toInt()
          val index1 = min(current + 1f, lastPoint).toInt()
          val c0 = curve[index0]
          val c1 = curve[index1]
          val delta = min(current - index0.toFloat(), 1f)
          values[writeIndex + j] = c0 + (c1 - c0) * delta
        }
        writeIndex += 4
      }
      k = truncatedSteps.toLong()
    }
    if (writeIndex >= 1) value = values[writeIndex - 1]
    while (writeIndex < fillToFrame) {
      val current = curveVirtualIndex + k * curvePointsPerFrame
      val index0 = if (current < curve.size) current.toInt() else curve.size - 1
      val index1 = min(index0 + 1, curve.size - 1)
      val c0 = curve[index0]
      val c1 = curve[index1]
      val delta = min(current - index0, 1.0)
      k += 1
      value = (c0 + (c1 - c0) * delta).toFloat()
      values[writeIndex] = value
      writeIndex += 1
    }
    writeIndex = fillToFrame
    if (writeIndex < nextEventFillToFrame) {
      value = curveEndValue
      values.fill(value, writeIndex, nextEventFillToFrame)
      writeIndex = nextEventFillToFrame
    }
    currentFrame += nextEventFillToFrame
    return Step(currentFrame, value, writeIndex)
  }

  /* ------------------------------------------------------------ timeline bookkeeping */

  private fun isEventCurrent(event: ParamEvent, next: ParamEvent?, currentFrame: Long, sampleRate: Double): Boolean {
    if (next == null) return true
    if (next.time * sampleRate >= currentFrame) return true
    val eventFrame = event.time * sampleRate
    return (event.type == ParamEvent.Type.SET_VALUE || event.type == ParamEvent.Type.SET_VALUE_CURVE_END) &&
      eventFrame <= currentFrame && currentFrame < eventFrame + 1
  }

  /** Chromium 152: every new event (curves included) earlier than now moves to now; stable re-sort. */
  private fun clampNewEventsToCurrentTime(currentTime: Double) {
    var clamped = false
    for (e in newEvents) {
      if (e.time < currentTime) {
        e.time = currentTime
        clamped = true
      }
    }
    if (clamped) events.sortWith { a, b -> a.time.compareTo(b.time) }
    newEvents.clear()
  }

  private fun insertEvent(event: ParamEvent): Boolean {
    val insertTime = event.time
    if (events.isNotEmpty()) {
      val currentFrame = ctx.currentSampleFrame
      var skipped = 0
      for (i in events.indices) {
        val next = if (i < events.size - 1) events[i + 1] else null
        if (isEventCurrent(events[i], next, currentFrame, sampleRate)) break else skipped += 1
      }
      if (skipped > 0) removeOldEvents(skipped)
    }
    if (events.isEmpty() && (event.type == ParamEvent.Type.LINEAR_RAMP || event.type == ParamEvent.Type.EXPONENTIAL_RAMP)) {
      val sv = ParamEvent.setValue(event.initialValue, ctx.currentTime)
      events.add(0, sv)
      newEvents.add(sv)
    }
    if (events.isEmpty()) {
      events.add(event)
      newEvents.add(event)
      return true
    }
    var insertionIndex = events.size
    var ub = insertionIndex - 1
    if (events.last().time > insertTime) {
      var lo = 0
      var hi = events.size
      while (lo < hi) {
        val mid = (lo + hi) ushr 1
        if (insertTime < events[mid].time) hi = mid else lo = mid + 1
      }
      insertionIndex = lo
      ub = insertionIndex
    }
    if (event.type == ParamEvent.Type.SET_VALUE_CURVE) {
      val endTime = event.time + event.duration
      for (i in ub downTo 0) {
        val test = events[i]
        if (test.type == ParamEvent.Type.SET_VALUE_CURVE_END || test.type == ParamEvent.Type.CANCEL_VALUES) continue
        if (test.type == ParamEvent.Type.SET_VALUE_CURVE) {
          val testEnd = test.time + test.duration
          if (event.time < testEnd && test.time < endTime) return fail("setValueCurveAtTime overlaps setValueCurveAtTime")
        } else if (test.time > event.time && test.time < endTime) {
          return fail("setValueCurveAtTime overlaps ${test.type}")
        }
        if (test.time < insertTime) break
      }
    } else {
      for (i in ub downTo 0) {
        val test = events[i]
        if (test.type == ParamEvent.Type.SET_VALUE_CURVE_END || test.type == ParamEvent.Type.CANCEL_VALUES) continue
        if (test.type == ParamEvent.Type.SET_VALUE_CURVE) {
          val end = test.time + test.duration
          if (event.type != ParamEvent.Type.SET_VALUE_CURVE_END && event.time >= test.time && event.time < end) {
            return fail("${event.type} overlaps setValueCurveAtTime")
          }
        }
        if (test.time < insertTime) break
      }
    }
    events.add(insertionIndex, event)
    newEvents.add(event)
    return true
  }

  private fun fail(message: String): Boolean {
    if (pendingError == null) pendingError = message
    return false
  }

  private fun throwPending() {
    val e = pendingError ?: return
    pendingError = null
    throw AudioParamException(e)
  }

  private fun removeCancelledEvents(first: Int) {
    for (k in first until events.size) newEvents.remove(events[k])
    events.subList(first, events.size).clear()
  }

  private fun removeOldEvents(count: Int) {
    val n = events.size
    if (n > 1) {
      val toRemove = min(count, n - 1)
      for (k in 0 until toRemove) newEvents.remove(events[k])
      events.subList(0, toRemove).clear()
    }
  }

  private fun clampedToCurrentTime(time: Double): Double = max(time, ctx.currentTime)

  private fun setIntrinsic(v: Float) {
    intrinsic = v.coerceIn(minValue, maxValue)
  }

  private fun requireNonNegative(time: Double, what: String) {
    if (!(time >= 0)) throw AudioParamException("$what must be a finite non-negative number: $time")
  }

  /** Number of scheduled events, for tests. */
  internal val eventCount: Int get() = events.size

  internal companion object {
    fun linearRampAtTime(t: Double, value1: Float, time1: Double, value2: Float, time2: Double): Float =
      (value1 + (value2 - value1) * (t - time1) / (time2 - time1)).toFloat()

    fun exponentialRampAtTime(t: Double, value1: Float, time1: Double, value2: Float, time2: Double): Float =
      if (value1 == 0f || signBit(value1) != signBit(value2)) {
        value1
      } else {
        (value1 * StrictMath.pow((value2 / value1).toDouble(), (t - time1) / (time2 - time1))).toFloat()
      }

    private fun signBit(v: Float): Boolean = java.lang.Float.floatToRawIntBits(v) < 0

    fun valueCurveAtTime(t: Double, time1: Double, duration: Double, curve: FloatArray): Float {
      val curveIndex = (curve.size - 1) / duration * (t - time1)
      val k = min(curveIndex.toLong(), (curve.size - 1).toLong()).toInt()
      val k1 = min(k + 1, curve.size - 1)
      val c0 = curve[k]
      val c1 = curve[k1]
      val delta = min(curveIndex - k, 1.0)
      return (c0 + (c1 - c0) * delta).toFloat()
    }
  }
}
