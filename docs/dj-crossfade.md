# Music-aware DJ crossfade (DJ-XFADE-001)

jPlay blends **full songs**, not catalogue preview clips, in the installed Windows and Android players. The crossfader sets the maximum overlap and transition style; “Play before blending” still defaults to 95%. It is not a master-volume control.

## What changed

Previously, a blend was timed from the end of the *file*. Many full songs have a fading or silent tail. A linear overlap into the next song’s quiet intro consequently makes a gap even with both decks running.

The player now measures the first and last parts of each local song. It records the first audible sound, last audible sound, last section at normal level, and an optional beat grid at each edge. A measured blend starts after the play-through threshold, tries to meet the outgoing song’s final music rather than its container’s silent end, and hands over when that blend is complete. When the outgoing and incoming grids are steady and tempos close, it places their entrances together and makes a small, pitch-preserving tempo nudge for the overlap; then the incoming song eases back to its own tempo. Bass moves between decks in a short, positioned handoff. Unreliable grids get a timed blend, **not** a purported beat match. Missing cues preserve the former file-anchored path; an unavailable incoming song does not interrupt the outgoing song.

`web/src/engine/track-cues.ts`, `crossfade.ts`, `preview-mixer.ts`, `audio-bus.ts`, `Player.tsx` implement the web/Windows path. `android/.../engine/{CueReader,TrackCues,MixPlan,TimeStretch,AudioEngine,EnginePlayer}.kt` and `dsp/MixBus.kt` implement native/background playback. The service measures only local files on a separate worker; it does not request a remote audio URL to analyse it. `tools/dsp-parity/cue-vectors.mjs` generates cross-language test vectors; the DSP parity fixtures include shaped bass swaps.

## What was actually checked (November 17, 2026)

- A study of 133 downloaded full songs found a median 2.57 seconds of outgoing tail more than 12 dB below the song’s main level. On 300 random pairs with slider 40 and 95% play-through, a preliminary level-dip simulation reduced mean ≥12 dB low-level overlap from 0.76 to 0.33 seconds; pairs with at least a second of it fell from 23% to 12%. These are **simulations**, not listening-preference scores.
- In the strong-grid subset, 194 measured blends had a 4 ms median kick offset, versus 138 ms with the old plan. About 20% of those predicted matches were still off beat; selective detection is not perfect. Beat lock is used only when confidence is high.
- TypeScript/Vitest and Kotlin/JVM tests cover cue measurements, 565 web→Kotlin plan vectors, tempo-preserving time stretch, scheduling, cancellation and play-through. Existing 13 DSP reference renders remained byte-identical; 2 shaped renders were added.
- On an Android emulator, a real service-side `EnginePlayer` queued and blended two local WAV songs and reached the measured cue planner without an Activity. A separate `DjCrossfadeDeviceTest` decoded five pairs of real Opus songs, measured cues, rendered before/after 48 kHz mixes with the native engine and asserted planned start and handoff within 1–4 render quanta (1 test, five pairs). One pair was beat-locked, two used the incoming entry, and two used timed blends. Per-song cue extraction on that emulator took about 34–37 seconds; a song shorter than the preparation period can still use the old fallback.
- A separate Windows Electron test profile loaded the new web bundle and played a cached full song, prepared the next, changed the crossfader to 60 and sought near the end. Two decks overlapped, promoted to the next song, and the status correctly reported full songs. This live smoke test confirms the player flow, not subjective preference over other apps.

Device test `meta.json` and ten paired FLAC audition excerpts are in the local Hermes scratch `crossfade-work/audition/native/` (not in source or a release). They are copyrighted music and should not be packaged or published as fixtures. The five native renders show narrower deepest level dips in four pairs and a slightly larger fraction of low-level time in one; a listener must still decide whether the mix *feels* better. Do not claim universal beat matching or superiority to Spotify or YouTube from these measurements.

## Reproduce without a release

From `web/`: `node ../../node_modules/vitest/vitest.mjs run --root . --dir src --maxWorkers=2`, `node ../../node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`, then `node ../../node_modules/vite/bin/vite.js build`.

From `android/`: `./gradlew --offline testDebugUnitTest`, `./gradlew --offline assembleDebug assembleDebugAndroidTest`; install with `adb install -r`, never uninstall. `TrackCuesTest` checks the vectors; `DspParityTest` checks all 15 bus scenarios. `NativeEngineTest#servicePlayerReceivesMeasuredCuesAndUsesItsCuePlannerToBlendFullLocalSongs` checks the real service/player path. The separate five-pair test requires legitimately held songs under `files/real-music/dj/`, as described in its class comment. Read `INSTRUMENTATION_STATUS_CODE` (0 per pass) and `INSTRUMENTATION_CODE: -1`; a shell exit code of zero is insufficient.

No commit, signed release, or delivery is implied by a passing debug build. The owner approves release/signing separately. Keep older versioned deliveries untouched.
