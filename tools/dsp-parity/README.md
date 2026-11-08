# DSP parity reference renderer

Produces the fixtures `DspParityTest` compares the native Android mixer against, by running the
app's **real** `web/src/engine/audio-bus.ts` + `eq.ts` (+ `crossfade.ts` via the bus), unmodified,
in Chromium's `OfflineAudioContext` inside the repo's Electron. The spec is [CONTRACT.md](CONTRACT.md).

## Regenerate

From `discovery-demo/` (needs the monorepo root `node_modules` — `esbuild` and `electron`):

```sh
node tools/dsp-parity/render-reference.mjs
# options: --out=<dir>          (default android/app/src/test/resources/dsp-parity)
#          --profile=<dir>      Electron --user-data-dir (default $DSP_PARITY_PROFILE or <tmp>/dsp-parity-profile)
#          DSP_PARITY_STABLE_AFTER=<n>  env, see "Summation order" (default 150)
```

It takes about two minutes and writes `manifest.json` and one `<scenario>.f32` per scenario
(interleaved stereo little-endian float32, no header). Commit the fixtures together with any change
to `web/src/engine` — `manifest.generator.webEngineCommit` records which engine commit they came from.

## Files

- `harness.ts` — scenario table (inputs, expanded `EqConfig`s from `eq.ts`'s own `applyPreset`,
  actions), the contract's input generator, and `render(name)`: builds the buffer sources, wraps the
  context so `createMediaElementSource(fakeEl)` returns that deck's source (everything else delegates
  to the real context), `createAudioBus(wrapped, initialEq)`, attaches `a` then `b`, schedules each
  action with `ctx.suspend(frame / 48000)`, renders.
- `electron-main.cjs` — hidden window (`show:false`, `backgroundThrottling:false`), runs every
  scenario through `executeJavaScript`, writes the files and the manifest from the main process.
- `render-reference.mjs` — bundles `harness.ts` (esbuild, iife, global `DspParity`) into `.out/`
  and launches Electron.

## Summation order (why each scenario is rendered many times)

Chromium sums an `AudioNode`'s inputs in pointer-hash order, which changes from render to render.
With two inputs that is exact (addition commutes); with three or more non-zero inputs the float
rounding depends on the order. The EQ's `out` node has three (limited wet, limiter bypass, dry), and
all three are non-zero while the initial ramps run (GainNode default 1 → configured value over
30–40 ms). So the same graph renders to 3 variants per audible deck (9 with both decks audible),
differing by at most ~1e-4 (−80 dBFS), far inside the parity tolerance (1e-3).

To keep fixtures byte-reproducible, `renderCanonical` renders each scenario until no new variant
has appeared for `stableAfter` consecutive renders and writes the variant with the smallest sha256.
`manifest.generator.summationOrder` lists, per scenario, the variant count, renders and the largest
sample difference between the chosen variant and any other — the native side cannot be expected to
match closer than that spread.

## Known reference behaviour worth knowing when porting

`xfade-reversal`: at frame 32000 (`crossfadeTo('a', 0.5)` while the 1.0 s filter transition is in
flight) the render quantum 32000–32127 has deck `a` at its final gain (~1) and deck `b` at ~0, and
the next quantum continues from the held levels (~0.86 / 0.63). This is Chromium's handling of
`cancelAndHoldAtTime(t)` + `setValueAtTime(v, t)` + `setValueCurveAtTime(curve, t, …)` inside a
curve that is still running (reproduced with a bare `GainNode`), which is what the bus's
`hold()`/`rampCurve()` issue on a reversal. The fixture is the real graph's output, so it contains
that 2.7 ms jump.
