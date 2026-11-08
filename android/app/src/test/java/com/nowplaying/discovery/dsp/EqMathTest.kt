package com.nowplaying.discovery.dsp

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * EqMath against the real web/src/engine/eq.ts. The reference numbers were produced by bundling
 * eq.ts with the repo's esbuild (`node node_modules/esbuild/bin/esbuild entry.ts --bundle
 * --platform=node`) and running it in node: `applyPreset({ ...EQ_DEFAULTS, on: true }, id)` for
 * 'rock', 'bass-booster' (limiter off) and 'solfeggio-528', then `headroomTrimDb(config)` and
 * `responseDbAt(config, hz)`.
 */
class EqMathTest {
  private val rock = EqConfig(true, "rock", listOf(5.0, 4.0, 3.0, 1.5, -0.5, -1.0, 0.5, 3.0, 4.0, 4.5), 0.0, true, null, 6.0)
  private val bass = EqConfig(true, "bass-booster", listOf(7.0, 5.5, 4.0, 2.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0), 0.0, false, null, 6.0)
  private val solfeggio = EqConfig(true, "solfeggio-528", listOf(0.0, 0.0, 0.0, 1.0, 2.0, 1.0, 0.0, 0.0, 0.0, 0.0), 0.0, true, 528.0, 6.0)

  private val eps = 1e-12

  @Test fun rockMatchesEqTs() {
    assertEquals(-5.8999263804898385, EqMath.headroomTrimDb(rock), eps)
    assertEquals(0.5069950054241423, EqMath.dbToGain(EqMath.headroomTrimDb(rock)), eps)
    assertEquals(1.9554799461256713, EqMath.responseDbAt(rock, 20.0), eps)
    assertEquals(5.896948570801287, EqMath.responseDbAt(rock, 32.0), eps)
    assertEquals(3.870293152372783, EqMath.responseDbAt(rock, 100.0), eps)
    assertEquals(0.02001159250648553, EqMath.responseDbAt(rock, 528.0), eps)
    assertEquals(-0.47110585689533996, EqMath.responseDbAt(rock, 1000.0), eps)
    assertEquals(4.0192329446472685, EqMath.responseDbAt(rock, 4000.0), eps)
    assertEquals(5.373609885145339, EqMath.responseDbAt(rock, 16000.0), eps)
  }

  @Test fun bassBoosterMatchesEqTs() {
    assertEquals(-8.192191060965936, EqMath.headroomTrimDb(bass), eps)
    assertEquals(0.3893950683764403, EqMath.dbToGain(EqMath.headroomTrimDb(bass)), eps)
    assertEquals(2.6917590755317793, EqMath.responseDbAt(bass, 20.0), eps)
    assertEquals(8.190694008445199, EqMath.responseDbAt(bass, 32.0), eps)
    assertEquals(5.201888749096251, EqMath.responseDbAt(bass, 100.0), eps)
    assertEquals(0.6914200660298947, EqMath.responseDbAt(bass, 528.0), eps)
    assertEquals(0.3174789604623119, EqMath.responseDbAt(bass, 1000.0), eps)
    assertEquals(0.11970880242558961, EqMath.responseDbAt(bass, 4000.0), eps)
    assertEquals(0.06400450747693441, EqMath.responseDbAt(bass, 16000.0), eps)
  }

  @Test fun solfeggio528MatchesEqTs() {
    assertEquals(-8.285728691769123, EqMath.headroomTrimDb(solfeggio), eps)
    assertEquals(0.38522420308632443, EqMath.dbToGain(EqMath.headroomTrimDb(solfeggio)), eps)
    assertEquals(0.04179726669296021, EqMath.responseDbAt(solfeggio, 20.0), eps)
    assertEquals(0.05862547034571458, EqMath.responseDbAt(solfeggio, 32.0), eps)
    assertEquals(0.20199203397605606, EqMath.responseDbAt(solfeggio, 100.0), eps)
    assertEquals(8.28846401943331, EqMath.responseDbAt(solfeggio, 528.0), eps)
    assertEquals(1.419062534569353, EqMath.responseDbAt(solfeggio, 1000.0), eps)
    assertEquals(0.10949275823826876, EqMath.responseDbAt(solfeggio, 4000.0), eps)
    assertEquals(0.03581603269196712, EqMath.responseDbAt(solfeggio, 16000.0), eps)
  }

  /** crossfade.ts `equalPower(0.25)` from the same bundle: { out: 0.9238795325112867, in: 0.3826834323650898 }. */
  @Test fun equalPowerMatchesCrossfadeTs() {
    val (out, inn) = EqMath.equalPower(0.25)
    assertEquals(0.9238795325112867, out, 0.0)
    assertEquals(0.3826834323650898, inn, 0.0)
  }

  @Test fun eqChainAppliesTheTrimItComputes() {
    val ctx = RenderContext()
    val bus = MixBus(ctx, rock)
    bus.attach(bus.createSource(), "a")
    assertEquals(-5.8999263804898385, bus.trimDb(), eps)
  }
}
