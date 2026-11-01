# Standalone Airwave Discovery APK: plan

## Decisions
- **Standalone.** The APK carries the UI, the discovery engine and the audio model. Nothing is installed
  on the phone and no PC server is needed. Music lookups (Deezer, YouTube Music, SoundCloud) still need
  an internet connection; the app says so.
- **Audio model bundled (decided 2026-10-28).** The AudioMuse-AI-DCLAP ONNX model (~22 MB, AGPL-3.0) ships
  inside the APK. Compliance: publish the complete corresponding source of the app with each APK release,
  keep the AGPL notice in the app's About screen, and keep the licence file in the APK assets.
- **One engine, two implementations, one test oracle (revised 2026-10-28: TypeScript, not Kotlin).** The
  engine runs as TypeScript inside the WebView (`web/src/engine/`), next to the UI that already exists. The
  Python code and golden fixtures generated from it (`server/tools/golden_*.py` -> `web/src/engine/golden/`)
  are the oracle; each TS module is tested against them.
- **Runtime.** `onnxruntime-web` (wasm, single thread) in the WebView; it reproduced the Python embedding at
  cosine 0.9999999999999 on the real model. No Chaquopy, no native ONNX.
- **Kotlin shell is thin.** It serves the built web app and the model from assets over
  `https://appassets.androidplatform.net/` (WebViewAssetLoader) and exposes two bridges: HTTP (the WebView
  cannot call Deezer/YouTube because of CORS) and nothing else; storage is IndexedDB in the WebView.

## Milestones (each one verified before the next)
1. **Network check.** The emulator reaches api.deezer.com, music.youtube.com, soundcloud.com over HTTPS.
2. **HTTP providers (TypeScript, revised 2026-10-28: the engine is TS, so providers are too).** Deezer is done
   (`web/src/engine/deezer.ts`, tested against recorded Deezer JSON). YouTube Music and SoundCloud search/related
   are still to port; they need recorded fixtures from the Python providers.
3. **Identity and engine port.** `identity.py`, `engine.py`, `candidates.py`, `config.py`, `genres.py`.
   Oracle tests from `server/tests`.
4. **Store.** `store.py` replaced by Room or a single SQLite file: seeds, settings, feedback, impressions,
   cache, queue.
5. **Queue.** `queue.py` port, plus the SSE-equivalent: a Kotlin Flow that the WebView subscribes to.
6. **Audio model.** `audio.py` port: decode (Android MediaCodec or a bundled decoder), log-mel in Kotlin,
   ONNX inference on the bundled model, checksum verification of the model file.
7. **Bridge.** The web UI (`web/`) runs in the WebView from the APK assets. The `/api/*` calls go through a
   JavaScript bridge into Kotlin instead of HTTP to a server.
8. **Verification on the emulator.** Install the APK on a clean emulator image with no PC server running;
   run a full search, add, discover, skip and previous cycle; check the screen at phone and tablet sizes.

## Open risks
- Deezer previews are copyrighted; the model runs on 30-second previews from Deezer's CDN, under the same
  terms as the server.
- The Python engine is about 4,000 lines; the port is multi-session work, not one change.
- Bundled ONNX Runtime adds size (tens of MB); measure after milestone 6.

## Status
- Milestone 1 PASSED (2026-10-28) on `Pixel_7_API_34` (`emulator-5556`, started with
  `emulator -avd Pixel_7_API_34 -port 5556 -no-snapshot-save -no-audio -gpu swiftshader_indirect`):
  Chrome loaded `https://api.deezer.com/chart/0/tracks` and showed real track JSON. `dumpsys connectivity`
  shows Wi-Fi validated with default route 10.0.2.2.
- Correction: the earlier "Network is unreachable / no DNS" result was an artefact of running `ping` and `nc`
  as the adb `shell` user, which does not follow Android's per-network routing. Test network from an app or
  Chrome, never from `adb shell ping/nc`. `RS_MBL_Isolated_API_34` (`emulator-5554`) is the Marvel project's
  deliberately isolated AVD; leave it alone.
- The emulator image has no curl or wget.
- Done and tested in TS (`cd web && node ../../node_modules/vitest/vitest.mjs run --root . --dir src`):
  `engine/queue.ts` (11 tests), `engine/audio.ts` mel front end vs Python (6 tests), `engine/encoder.ts`
  ONNX embedding vs Python (cosine 0.99999999999986). `engine/decode.ts` (Web Audio decode) is untested until
  it runs in the WebView.
- Done (TS, vitest): `engine/net.ts` guard (73 tests with net.test.ts), `engine/deezer.ts` + `engine/track.ts` (adapter).
- In progress: YouTube Music + SoundCloud adapters; candidates; store.
- Still to do: store (IndexedDB), candidates + discovery orchestration (`app.py` equivalents), `LocalApi`
  replacing `fetch('/api/...')` in `web/src/api.ts`, Kotlin shell, APK build, emulator run.
