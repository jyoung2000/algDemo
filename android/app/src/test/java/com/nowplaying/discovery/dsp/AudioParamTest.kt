package com.nowplaying.discovery.dsp

import org.junit.Assert.assertEquals
import org.junit.Test
import kotlin.math.pow

class AudioParamTest {
  private val ctx = RenderContext(48000f, 128)

  /** Render [quanta] quanta of [param] the way an a-rate GainNode does, returning every sample. */
  private fun render(param: AudioParam, quanta: Int): FloatArray {
    val out = FloatArray(quanta * 128)
    val q = FloatArray(128)
    repeat(quanta) {
      param.calculateSampleAccurateValues(q, 128)
      System.arraycopy(q, 0, out, it * 128, 128)
      ctx.currentSampleFrame += 128
    }
    return out
  }

  private fun t(frame: Int) = frame / 48000.0

  @Test fun linearRampIsLinearPerFrame() {
    val p = AudioParam(ctx, 0f)
    p.setValueAtTime(0f, 0.0)
    p.linearRampToValueAtTime(1f, t(256))
    val v = render(p, 3)
    assertEquals(0f, v[0], 0f)
    assertEquals(0.25f, v[64], 1e-6f)
    assertEquals(200f / 256, v[200], 1e-6f)
    assertEquals(1f, v[256], 0f)
    assertEquals(1f, v[383], 0f)
  }

  @Test fun exponentialRampIsGeometricPerFrame() {
    val p = AudioParam(ctx, 1f)
    p.setValueAtTime(1f, 0.0)
    p.exponentialRampToValueAtTime(100f, t(256))
    val v = render(p, 3)
    assertEquals(1f, v[0], 1e-6f)
    assertEquals(10f, v[128], 1e-4f)
    assertEquals(100.0.pow(255 / 256.0).toFloat(), v[255], 1e-3f)
    assertEquals(100f, v[256], 0f)
  }

  @Test fun valueCurveInterpolatesLinearlyAndHoldsItsLastPoint() {
    val p = AudioParam(ctx, 0f)
    p.setValueCurveAtTime(floatArrayOf(0f, 1f, 0.5f), 0.0, t(256))
    val v = render(p, 3)
    assertEquals(0f, v[0], 0f)
    assertEquals(0.5f, v[64], 1e-6f)
    assertEquals(1f, v[128], 1e-6f)
    assertEquals(0.75f, v[192], 1e-6f)
    assertEquals(0.5f, v[256], 0f)
    assertEquals(0.5f, v[383], 0f)
  }

  @Test fun cancelAndHoldFreezesARampWhereItIs() {
    val p = AudioParam(ctx, 0f)
    p.setValueAtTime(0f, 0.0)
    p.linearRampToValueAtTime(1f, t(256))
    render(p, 1)
    // The value getter returns what the render thread stored: the quantum's last sample.
    assertEquals(127f / 256, p.value, 1e-6f)
    p.cancelAndHoldAtTime(t(128))
    val v = render(p, 2)
    assertEquals(0.5f, v[0], 1e-6f)
    assertEquals(0.5f, v[200], 1e-6f)
  }

  @Test fun cancelScheduledValuesDropsLaterEventsAndRampsStartFromIntrinsic() {
    val p = AudioParam(ctx, 0.25f)
    p.setValueAtTime(1f, t(512))
    p.cancelScheduledValues(t(256))
    assertEquals(0, p.eventCount)
    // A first ramp anchors at the intrinsic value at the call's currentTime.
    p.linearRampToValueAtTime(0.75f, t(128))
    val v = render(p, 2)
    assertEquals(0.25f, v[0], 0f)
    assertEquals(0.5f, v[64], 1e-6f)
    assertEquals(0.75f, v[200], 0f)
  }

  @Test fun valueSetterSchedulesAtCurrentTimeAndClamps() {
    val p = AudioParam(ctx, 350f, 0f, 24000f)
    p.value = 30000f
    assertEquals(24000f, p.value, 0f)
    val v = render(p, 1)
    assertEquals(24000f, v[0], 0f)
  }
}
