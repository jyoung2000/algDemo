# DSP parity contract: native Android mixer vs the app's Web Audio graph

The Android app is moving playback from the WebView into a service-owned native engine (owner
decision 2026-11-07). The owner's condition: the EQ, DJ crossfade and mixer must sound **the same**,
measured, not approximated. This contract defines the measurement.

There are two halves, built independently and meeting only here:

1. **Reference renderer** (`tools/dsp-parity/`): runs the app's REAL `web/src/engine/audio-bus.ts`,
   `eq.ts` and `crossfade.ts` (unmodified, bundled with esbuild) in Chromium's `OfflineAudioContext`
   inside the repo's Electron, and writes the rendered PCM as fixtures.
2. **Native DSP** (`android/app/src/main/java/com/nowplaying/discovery/dsp/`): pure Kotlin, no
   `android.*` imports, so it runs in JVM unit tests (`./gradlew :app:testDebugUnitTest`).
   `DspParityTest` feeds it the same inputs and actions and compares against the fixtures.

Nothing in `web/src` changes for this. The reference must be the code the app actually runs.

## Fixture location and format

`android/app/src/test/resources/dsp-parity/`

- `manifest.json` — the scenarios (schema below), plus `generator` metadata: Electron version,
  `process.versions.chrome`, ISO timestamp, and the git commit of `web/src/engine` used.
- `<scenario>.f32` — the rendered output: **interleaved stereo, little-endian float32**,
  `frames × 2` values, frame 0 first. No header.

## Rendering parameters (fixed for every scenario)

- `sampleRate` **48000**, **2 channels**, render quantum **128** frames.
- `frames` per scenario as listed (all multiples of 128).
- Every action happens at a frame that is a multiple of 128, so `OfflineAudioContext.suspend(frame
  / 48000)` lands exactly and `ctx.currentTime === frame / 48000` when the action runs.

## Deterministic inputs (both halves generate them; inputs are NOT stored)

Each deck has two channel specs. A channel spec is
`{ "seed": <uint32, nonzero>, "noiseAmp": <number>, "sines": [[hz, amp], ...] }`.

Sample `n` (0-based frame index) of a channel is:

```
noise stream: x = seed (uint32). For each sample, in order n = 0,1,2,…:
    x ^= x << 13;  x ^= x >>> 17;  x ^= x << 5;      // all as uint32 (JS: >>> 0 after each)
    u = x / 4294967296                               // x as unsigned, so u in [0, 1)
    noise = (u * 2 - 1) * noiseAmp
value = Σ_k amp_k * sin(2π * hz_k * n / 48000) + noise     // computed in float64
sample = Math.fround(value)                                // stored/fed as float32
```

Each channel has its own independent noise stream (its own seed). A deck whose specs are all zero
amplitude is silent but **still attached**, exactly like a loaded-but-unplayed deck.

## How a scenario runs (reference side)

1. `ctx = new OfflineAudioContext(2, frames, 48000)`.
2. Build one `AudioBufferSourceNode` per deck from the generated inputs; start both at time 0.
3. Wrap `ctx` so `createMediaElementSource(el)` returns the prepared buffer source for that fake
   element (`el` = `{ currentSrc: 'blob:a' }` / `'blob:b'`). Everything else delegates to `ctx`.
4. `bus = createAudioBus(wrapped, initialEq)` (pageOrigin omitted). `bus.attach(elA, 'a')` then
   `bus.attach(elB, 'b')` — so deck `a` is live at gain 1 and deck `b` sits at gain 0.
5. For each action, `ctx.suspend(frame/48000)` and run it, then `ctx.resume()`.
6. `startRendering()`; write channel data interleaved.

## How a scenario runs (native side)

Same inputs, same `initialEq`, attach `a` then `b`, process in 128-frame quanta, and perform each
action **before** processing the quantum that starts at its frame. Output must match the fixture.

## Actions

`{ "frame": <multiple of 128>, "op": <name>, "args": [...] }` where op is one of the bus methods,
called with exactly these args:

- `setEq` `[EqConfig]` · `transitionTo` `[deck, seconds, style]` · `crossfadeTo` `[deck, seconds]`
- `cut` `[deck]` · `setMasterGain` `[value]`

`EqConfig` is the JSON shape of `eq.ts`'s `EqConfig` (`on, presetId, gains[10], preampDb, limiter,
toneHz, toneDb`). Presets are expanded to explicit gains in the manifest — the native side must not
need the preset table to run a fixture.

## Scenarios

| name | frames | what it exercises |
|---|---|---|
| `eq-off-passthrough` | 48000 | EQ off: dry path at unity, then master limiter makeup gain |
| `eq-rock` | 48000 | ten peaking bands + headroom trim + per-deck limiter |
| `eq-bass-booster-no-limiter` | 48000 | per-deck limiter OFF (bypass path); master limiter still on |
| `eq-solfeggio-528` | 48000 | the Q 8 tone filter at 528 Hz on top of its band shape |
| `eq-extreme-custom` | 48000 | gains `[12,-12,12,-12,12,-12,12,-12,12,-12]`, preamp +6 |
| `eq-toggle-ramp` | 72064 | starts off; at frame 24064 `setEq` turns Rock on (30/40 ms ramps) |
| `xfade-blend` | 72064 | at 12800: `transitionTo('b', 0.8, 'blend')` |
| `xfade-bass-swap` | 72064 | at 12800: `transitionTo('b', 0.8, 'bass-swap')` |
| `xfade-filter` | 72064 | at 12800: `transitionTo('b', 0.8, 'filter')` |
| `xfade-cut` | 72064 | at 12800: `transitionTo('b', 0.8, 'cut')` |
| `xfade-reversal` | 72064 | 12800: `transitionTo('b', 1.0, 'filter')`; 32000: `crossfadeTo('a', 0.5)` |
| `loud-sum-limiter` | 72064 | both decks loud (sines ~0.8) during a blend — master compressor engaged |
| `master-gain` | 48000 | at 9600: `setMasterGain(0.5)` |

Inputs (unless a row says otherwise): deck `a` ch0 `{seed: 1, noiseAmp: 0.08, sines: [[55,0.12],[440,0.1],[3000,0.05]]}`,
ch1 `{seed: 2, noiseAmp: 0.08, sines: [[82.5,0.12],[660,0.1],[5000,0.04]]}`; deck `b` ch0
`{seed: 3, noiseAmp: 0.08, sines: [[110,0.12],[880,0.1],[2000,0.05]]}`, ch1
`{seed: 4, noiseAmp: 0.08, sines: [[165,0.12],[1320,0.1],[7000,0.04]]}`. EQ-only scenarios keep deck
`b` attached but silent (all amplitudes 0). `loud-sum-limiter` uses sines at ~0.8 on both decks so
the sum exceeds −1 dBFS.

## Pass criterion (DspParityTest)

Per scenario, over all samples and both channels:

- **max |native − reference| ≤ 1e-3** (−60 dBFS), and
- **error-to-signal ratio ≤ −60 dB** (`10·log10(Σerr² / Σref²)`).

The test prints both numbers for every scenario, passing or not, and **fails — never skips — if the
fixtures are missing**. A threshold is never loosened to make a scenario pass; a mismatch is a bug
in the port until the reference is shown to be the thing that is wrong.

## Known, deliberate scope limits

- **Resampling is out of scope here.** In the app, Chromium resamples a 44.1 kHz song to the
  context rate before this graph; the native decoder will do its own. That is measured separately
  with real songs on a device, not in these fixtures.
- **The crossfade planner** (`crossfade.ts`: when to start, how long, which style) is decision
  logic, not DSP. It is ported and tested separately against shared vectors.
- **BPM / tempo nudging is not live behaviour** in the app and must not be added.
