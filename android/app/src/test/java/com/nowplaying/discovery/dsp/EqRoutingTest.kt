package com.nowplaying.discovery.dsp

import com.nowplaying.discovery.NativeStateCodec
import com.nowplaying.discovery.engine.EqJson
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** Pure routing/codec checks, without an Android audio device or service. */
class EqRoutingTest {
  private fun config(db: Int) = JSONObject()
    .put("on", true)
    .put("gains", JSONArray().put(db).put(0).put(0).put(0).put(0)
      .put(0).put(0).put(0).put(0).put(0))
    .put("preampDb", 0)
    .put("limiter", true)

  @Test fun savedEqIsDecodedBeforeEitherDeckIsAttachedAndSurvivesPartialSettings() {
    val first = config(8)
    val persisted = mutableMapOf<String, String>()
    val io = object : NativeStateCodec.Io {
      override fun get(key: String): String? = persisted[key]
      override fun put(key: String, value: String?) {
        if (value == null) persisted.remove(key) else persisted[key] = value
      }
    }
    val writer = NativeStateCodec.Store(io)
    assertTrue(writer.recordSettings(JSONObject().put("eq", first).put("mix", 0)))
    assertTrue(writer.recordSettings(JSONObject().put("volume", 0.5)))
    val initial = EqJson.parse(NativeStateCodec.Store(io).settings()!!.getJSONObject("eq"))
    val bus = MixBus(RenderContext(48000f, 128), initial)
    val a = bus.attach(bus.createSource(), "a")
    val incoming = bus.attach(bus.createSource(), "b")
    assertEquals(8.0, a.eq.current.gains[0], 0.0)
    assertEquals(8.0, incoming.eq.current.gains[0], 0.0)
    assertSame(a.source, a.eq.wet.inputs.single())
    assertSame(a.source, a.eq.dry.inputs.single())
    assertSame(a.eq.preamp, a.eq.bands[0].inputs.single())
    assertSame(a.eq.out, a.bass.inputs.single())
    assertSame(incoming.source, incoming.eq.wet.inputs.single())
    assertSame(incoming.eq.out, incoming.bass.inputs.single())
  }

  @Test fun changedEqUpdatesBothLiveAndIncomingAndFutureRadioDecks() {
    val bus = MixBus(RenderContext(48000f, 128))
    val a = bus.attach(bus.createSource(), "a")
    val b = bus.attach(bus.createSource(), "b")
    bus.setEq(EqJson.parse(config(-6)))
    assertEquals(-6.0, a.eq.current.gains[0], 0.0)
    assertEquals(-6.0, b.eq.current.gains[0], 0.0)
    val frames = arrayOf(FloatArray(128) { 0.05f }, FloatArray(128) { 0.05f })
    val out = arrayOf(FloatArray(128), FloatArray(128))
    repeat(24) { bus.process(frames, null, out) } // 64 ms: past the 40 ms band ramp
    assertEquals(-6f, a.eq.bands[0].gain.intrinsicValue, 0.1f)
    assertTrue(out[0].any { it != 0f })
    val radio = bus.attach(bus.createSource(), "a") // station switch replaces the PCM source
    assertEquals(-6.0, radio.eq.current.gains[0], 0.0)
    assertSame(radio.source, radio.eq.wet.inputs.single())
    bus.setEq(EqJson.parse(JSONObject().put("on", false)))
    assertFalse(radio.eq.current.on)
    assertFalse(b.eq.current.on)
    // Off selects the dry route after the bypass ramp; flat *enabled* still selects wet.
    assertSame(radio.source, radio.eq.dry.inputs.single())
  }
}
