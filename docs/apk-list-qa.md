# Android list-download QA — APK 0.10.1 (versionCode 16)

## Result
Tested the signed release APK on emulator-5554 (userdebug, rooted adb shell), not a browser substitute or debug APK. Fixed narrow-phone Saved rows. The installed APK was pulled back from `pm path` and SHA-256 matched to the build:
`9b86c74640c4cc722eb9a88b352cb61c28482c5ebc2ec02d96deb41831d48adc`.

## Functional coverage
- Initial 0.10.0: Discovery 91/97. Backed up three visible cached Kevin MacLeod songs (not kept copies, no playing decks). Removed only those three cache files. Same mounted page detected 88/97 and meter width decreased. Native touchscreen Download all then completed three real yt-dlp jobs with up to three running together; count returned to 91/97. Files were restored by actual downloads, not simulated results.
- Initial harness tap missed: screen coordinate calculation omitted WebView's native top inset of 136 physical pixels. Recomputed using uiautomator WebView bounds; event recorded `isTrusted: true`. This was instrumentation error, not a product defect.
- Named-playlist test on both 0.10.0 and final 0.10.1: created QA APK list from an existing Saved song; denominator was 1, not global queue size. After removing its cache file, count went 1/1 → 0/1. Download all changed to Downloading… then 1/1 / All ready. Clicking the disabled All ready control produced no extra job. Deleted the QA list; original two Saved songs remained.
- All saved on final APK: 2/2, All ready disabled. Discovery retained its own denominator (97).
- Final APK local playback: Electrodoodle used a local `blob:` URL, duration 166.08 seconds, playback time advanced 0.453333 → 5.541333 seconds; no iframe and no media error. Paused via the app's Pause button afterward. This proves local playback initiation, not a full-song-duration listening test.
- Permanent Music library mapping compared before/after and was unchanged. Re-downloaded cache containers have different hashes than the backups; no claim of byte-identical media containers. Test backups remain in Hermes scratch only, not in Music or the app cache.
- No FATAL EXCEPTION, Fatal signal, Uncaught, console Error, or ANR matches in the final app process's captured logcat. Not a long-duration soak test.

## Bug fixed: SAVED-MOBILE-001
On the shipped 0.10.0 APK at 320 CSS px, four inline row buttons squeezed each Saved song's text column to **18.95 px**. No horizontal overflow occurred, so an overflow-only check missed unreadable titles.

Added an explicit two-row grid below 480px: artwork and title first, four 44×44 actions below. Existing desktop layout is unchanged. Named placement also lets the save menu span the whole row.

Device-side regression check failed on the original APK and passed on rebuilt 0.10.1:

| CSS viewport | Song text width after fix | Overlap / overflow |
|---|---:|---|
| 320 | 192.95 px | none |
| 360 | 232.95 px | none |
| 412 | 285.14 px | none |
| 1280 | 582.95 px | none |

Run against a running APK with populated Saved songs:
```
node scripts/check-apk-layout.mjs emulator-5554
```
The check attaches directly to the APK's WebView and restores device-metrics overrides afterward. Assertions cover nonempty rows, minimum readable text width, no text/action overlap, actions within their row, and no document overflow. Screenshots of the rebuilt 320/412px layouts were also inspected.

## Build and regression checks
- TypeScript: `tsc --noEmit`, exit 0.
- Web suite: 865 tests, **863 passed, 2 skipped, 0 failed**. Happy DOM printed iframe/network-abort diagnostics from existing YouTube tests; not a silent/error-free test log.
- Android: `./gradlew testDebugUnitTest`, **15 passed**. Build warning: deprecated `setDecorFitsSystemWindows`; no compile failure.
- Windows native: `node --test windows/downloads.test.cjs`, **16 passed**.
- Signed Android release built and installed; apksigner verifies APK v2 signature.
- Shared web bundle byte-matches APK assets and Windows 0.7.1 packaged resources: `index-kVzH-6R9.js` and `index-BBue57g0.css`. Both Windows executables have Valid Authenticode signatures; Windows full UI flows were not repeated in this APK-focused pass.
- Git whitespace check used `git -c core.whitespace=cr-at-eol diff --check` because the version files are committed CRLF.

## Limits
Availability changes are polled, not instantaneous. Source-less songs remain unavailable; retry cannot guarantee a usable source. Six pre-existing source failures were not fixed by this layout patch. Tests ran on the Android emulator, not a physical ARM64 handset. APK 0.10.1 and Windows 0.7.1 are local deliverables; this task did not create a public release.
