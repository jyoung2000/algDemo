# Service-Owned Android Music Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Full-song playback from discovery song list, playlists and voice search via a service-owned native player, including background/lock-screen/Android Auto and audible EQ/mixer/crossfade parity.

**Architecture:** Replace the Media3 `WebPlayer` proxy with a service-owned playback coordinator whose state is the truth. Keep the WebView as UI/controller/catalogue client; move audio ownership, local-file queue and DSP to `PlaybackService`. Two ExoPlayers are only a decoding/control slice: independent sinks cannot reproduce the existing master → **post-sum compressor**. Full parity needs two decoded PCM streams mixed into one synchronized output (e.g., a streaming AudioTrack), with per-deck EQ/filter/gain before summing and the compressor after. Persist a bounded playable catalogue and queue for cold Auto startup; never equate metadata or a source link with downloadable audio. Add native integration gates for activity/task removal, cold browser, voice selection, playback and DSP comparison.

**Tech Stack:** Kotlin, Media3 1.9.3 ExoPlayer/session/common, Android foreground MediaLibraryService, existing Downloads cache/bridge, React/TypeScript, Vitest + connected Android tests.

**Spec:** Owner's attached 2026-11-06 Android media-player research (composer-pastes/pasted_content_2026-11-07_03-14-37-420_d9a381.txt), 2026-11-07 choice of native service-owned engine with ported EQ/crossfade/mixer and measured parity; checkpoint `C:/Users/jalon/AppData/Local/hermes/task-checkpoints/discovery-demo-android-auto.md`.

## Global Constraints
- No previews, alternate recordings or Deezer-only unavailable tracks in playable lists. Preserve exact recording identity and locally verified complete audio.
- "A reset must never remove copies the owner chose to Keep in their Music folder."
- Keep app EQ, crossfade and mixer audible behavior, not just UI controls; compare measured output with Web Audio.
- Android Auto exposes a driver-safe browser/search; no speculative voice result or unverified download; no DRM/access bypass.
- Windows remains on its Web Audio path unless a shared behavior contract requires parity; verify the Windows packaged flow when touching shared web code.
- New release version, signed APK, real emulator tests and fast-forward push only after ALL acceptance gates.

## Review Focus
- Cold service before opening Activity: browsable nonempty saved library, tap playback starts; test at Task 3.
- Activity task removed while playing: audio advances, media buttons work, no phantom PLAYING; test Task 2.
- Uncached song/evicted file: truthful buffering/download, strict identity, clean failure; test Task 3.
- Multiple playlist copies of one song: preserve list-specific next/previous context; test Task 4.
- DSP parity across two decks with play-through minimum and EQ parameters; compare PCM/response and transitions in Task 5.

---

### Task 1: Native single-track vertical slice
**Files:** Modify `android/app/build.gradle.kts`, `android/app/src/main/java/com/nowplaying/discovery/PlaybackService.kt`, replace `WebPlayer.kt` as necessary; add `NativePlaybackTest.kt`.
**Interfaces:** `NativePlayback.load(localUri: Uri, metadata: MediaMetadata): MediaItem`; service exposes genuine Media3 Player; existing `Downloads.localFile(ctx, sourceUrl)` is the local-cache authority.
- [x] RED: native local-file player test failed compilation without implementation; negative remote and missing-file controls.
- [x] GREEN (component): NativePlayback ExoPlayer loaded synthetic full WAV, reached READY, position advanced, seek/pause worked on isolated emulator; rejects remote URI/missing bytes. `connectedDebugAndroidTest`: 5/5 pass.
- [ ] Integrate NativePlayback as the service's session Player, replace proxy and verify from UI/Auto; this is not done by component test.
- [ ] Verify task-removal/screen-off and live full-song playback; commit.

### Task 2: Background lifecycle and bridge control
**Files:** Modify `MainActivity.kt`, `PlaybackService.kt`, `web/src/Player.tsx`, `web/src/engine/media-native.ts`; add instrumented `NativeBackgroundTest.kt`.
**Interfaces:** Web UI issues commands through MediaController / bridge; service holds renderer, queue and playback state independent of Activity.
- [ ] RED: play local fixture, remove Activity task, screen off; media-session pause/play/seek/next still controls advancing audio; no stale session after error.
- [ ] GREEN: drive native service from web UI rather than from Activity-owned audio; do not run competing Web and native decks or double audio.
- [ ] Verify screen-off and task-removal on emulator, and ensure UI returns to correct position; commit.

### Task 3: Durable cold-start library and source resolution
**Files:** Add `NativeCatalog.kt`/repository and tests; modify `MediaHub.kt`, `PlaybackService.kt`, `Downloads.kt` only where necessary.
**Interfaces:** Persist bounded catalogue, playlists and queue/index/position; `resolve(songId)` rechecks local file and permission before playback; on-demand download uses existing strict source chain or fails cleanly.
- [ ] RED: kill app, cold `MediaBrowser` before Activity; songs/playlists remain, selecting a cached full song starts audio and resumption restores position. Missing cache/creator permission shows no false READY.
- [ ] GREEN: native persistence + resolver + onPlaybackResumption + source revalidation/explicit buffering/error; keep owner-kept Music safe.
- [ ] Verify cold browse/play/voice on isolated emulator; commit.

### Task 4: Queue, playlist context, search/add
**Files:** `PlaybackService.kt`, `MediaHub.kt`, `web/src/App.tsx`, `web/src/engine/media-native.ts` and Android/web tests.
**Interfaces:** Scoped playlist IDs (`playlist/<encoded id>/track/<encoded key>`), browse/search callbacks paginated; native queue honours playlist order; catalog search can add a verified new song to a list on explicit user command.
- [ ] RED: browse/select first playlist song, Next plays second from same list; voice search finds existing track; new catalog result is not played/added until full-song provenance and readiness verified; unsupported terms return empty/error.
- [ ] GREEN: keep queue and browse trees in sync; route typed/voice **play/search** through safe catalog path. Add an explicit save-to-list command where the host supports it; for unsupported spoken add-to-list requests, require phone-side confirmation rather than promising a universal Android Auto voice callback.
- [ ] Verify from actual controller and web UI, commit.

### Task 5: Native DSP and audio parity
**Files:** Add focused native DSP/effect classes and tests; modify native player and web mixer bridge. Do not alter Windows audible behavior.
**Interfaces:** Port the actual Web Audio graph: per-deck preamp + ten peaking bands at 32/64/125/250/500/1k/2k/4k/8k/16k Hz (Q 1.1, ±12 dB), optional 174–963 Hz tone (Q 8), 180 Hz shelf, 20→900 Hz high-pass, 96-point headroom trim, wet/dry ramps (30/40 ms), per-deck compressor, gain; sum both decks, then master and always-on post-mix compressor (threshold −1 dB, knee 0, ratio 20:1, 1 ms attack, 50 ms release). Mix uses cos/sin equal-power 49-point curve, requested overlap capped by outgoing × (1−playThrough/100) and incoming × 0.4; 95% default, 12 ms cut. BPM tempo nudging is *not* live behavior; do not add it.
- [ ] RED: deterministic PCM fixtures show native output differs from Web Audio reference (EQ bands, gain, transition envelope, post-sum compression).
- [ ] GREEN: implement processors and two synchronized decoded PCM streams feeding **one** mix/output sink; two ExoPlayer outputs with `setVolume()` alone cannot pass post-sum parity. Disable offload/passthrough/float paths that bypass PCM processors.
- [ ] Verify on-device with real full local songs across modes and compare response/transition within measured tolerances; commit.

### Task 6: Release and actual Android Auto proof
**Files:** version bump (`android/app/build.gradle.kts`), docs, tests.
- [ ] Run full web, Android unit/instrumented and Windows parity gates; package signed APK and verify signature/version/asset parity.
- [ ] Test DHU with functional updated Android Auto; current emulator Gearhead `1.2.531830-stub` cannot start head-unit server. If no updated device is available, mark DHU blocked explicitly, do not claim car UI verified.
- [ ] Fresh independent code review, fix important findings RED→GREEN, commit and fast-forward push only after real playback acceptance gates; never overwrite prior delivered APKs.

## Rulings
- 2026-11-07: the original Media3 proxy is not a playback owner; an unattached application-context WebView AudioContext stopped responding after screen off in an isolated instrumentation spike. Owner selected a native service-owned engine with ported effects rather than weakening background/Auto support.
