# Android Auto queue handoff and discovery — 0.18.12 / Android code 55

## Changes

`EngineHub` replays the last library snapshot when the native service player attaches and when the phone page attaches. A library update could previously arrive before either attachment; the pending phone load then left only the selected song in the native timeline. Both attachment orders now retain the complete queue and selected index without waiting for another incidental library push.

`EnginePlayer` now implements removal for its advertised `CHANGE_MEDIA_ITEMS` command. Clearing a populated queue previously threw through the media service. Removal keeps the current item if retained, otherwise selects the surviving successor; an empty queue pauses and invalidates in-flight loads so old audio cannot reappear.

No production EQ, mixer, decoder, crossfade or audio-output implementation changed.

## What was verified

- Two attachment-order regressions failed before the fix (one item instead of three), then passed.
- Populated clear/current-item removal failed before the removal handler, then passed.
- Platform MediaBrowser/MediaController advertised Play/Pause and Previous/Next, not timed Rewind/Fast-forward. Progress-bar seek remains available.
- The actual Google Android Auto Desktop Head Unit displayed jPlay in its launcher after reconnecting projection. jPlay opened to Now playing queue and Playlists, with the host Search affordance.
- On the projected debug build, generated, clearly labelled local PCM test recordings showed Previous Track, Play/Pause and Next Track, with no ±15-second controls. Tapping Next moved tone 1 to tone 2; Previous moved tone 2 to tone 1; Play advanced decoded playback position and Pause stopped it. These fixtures are not catalogue-song acquisition evidence.
- Full Android instrumentation: 39 behavioral checks passed, 3 optional checks assumption-skipped, 0 failures. The three skips were two opt-in interactive inspection helpers and the real-catalogue PCM comparison requiring supplied songs. One interactive helper was separately exercised with the real DHU. The foreground ADB capture timed out after 420 seconds; completion was recovered from the SAME runner PID's logcat: `run finished: 42 tests, 0 failed, 0 ignored`, with the three assumptions counted separately.
- Android JVM: 109 tests, zero failures/errors. Web: 1,529 passed, 7 skipped; TypeScript clean.

## Test-harness corrections

The unattached-player tests borrow/restore the EngineHub bridge rather than stopping a service during an in-flight foreground promotion. The late-file background fixture adopts the service revision through `hello`, as the real page does, rather than sending stale revision zero.

The output-recording DSP probe now runs at the actual output sample rate instead of artificially consuming audio at 4× real time. The accelerated probe reported a 30-second tone spanning 30.10–30.14 seconds; real-time recording passed the original duration, no-overlap, EQ and blend assertions. No DSP tolerance or production audio behavior was relaxed.

## Missing launcher entry on a sideloaded phone

jPlay already declares an exported media browsing service and the automotive media descriptor. This release does not pretend to programmatically toggle Android Auto's host settings. While parked:

1. Install the new APK and open jPlay on the phone once.
2. In Android Auto settings, enable developer mode if needed, then enable **Unknown sources** in Android Auto's developer settings. This is different from the Android permission to install an APK.
3. Under **Customize launcher**, check **jPlay**.
4. Disconnect and reconnect Android Auto after the install. A running head unit can retain its old app list.

## Evidence limits

The owner's installed phone version and physical vehicle have not been inspected. DHU transport/audio evidence is from a debug build of the same native source, not a claim of physical-car testing. The release APK and signed Windows packages are separately built and smoke-tested before delivery. Catalogue acquisition, physical voice/microphone recognition and cold native catalogue persistence are not established by the transport fixture. Open the phone app once after installation; do not infer cold-library behavior from a live page or populated fixture.

A one-item timeline alone is NOT proof that Android Auto will choose timed-seek controls. Diagnose the active owning session, platform action mask, attachment path and actual host rendering separately.

A reset must never remove copies the owner chose to Keep in their Music folder.
