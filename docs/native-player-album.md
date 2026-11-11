# Native now-playing album label (0.18.1 / Android vc44)

The native player's second line shows `artist · album` instead of `artist · Airwave Discovery`.
If the album is missing, only the artist is shown. Album title remains a separate Media3 metadata
field for controllers that display it. Android's own app attribution is unchanged. Browse rows keep
the plain artist. This supersedes NATIVE-BRAND-001 (NATIVE-ALBUM-001).

Implementation: `NowPlayingLabel.artistLine(artist, album)`, used by `WebPlayer.metadataOf` (the
service-owned EnginePlayer uses this same builder) and the standalone local playback slice.

Verification:
- Before fix: connected metadata tests failed on the old app-name suffix (2 failures).
- After fix: 109 JVM tests pass; connected suite reports 30 tests, 0 failures, 1 skipped optional
  real-music fixture. Includes 3 actual Media3 builder tests for album, missing album, browse artist.
- Signed release APK installed and exercised on emulator-5554 with a real catalogue song:
  `Wallpaper` by `Kevin MacLeod`, album `Light Electronic`; native position advanced to 5.6 seconds.
- `dumpsys media_session`: `description=Wallpaper, Kevin MacLeod · Light Electronic, Light Electronic`.
- Expanded Android Quick Settings media card UI text: `Wallpaper` / `Kevin MacLeod · Light Electronic`.
- APK signature verification succeeds and badging identifies 0.18.1 / versionCode 44.
- Web: 1369 tests pass, 7 skipped; TypeScript clean. No web-player label change required.
- Windows stays version-aligned at 0.18.1; portable, installer, unpacked executable signatures Valid;
  packaged app launched and returned its 0.18.1 bridge version.

Evidence: `C:/Users/jalon/AppData/Local/hermes/testing/native-album/` contains the actual
`release-media-session.txt`, `release-system-ui.xml`, `page.json`, test/build logs and Windows build.

This patch does not claim completion of the separate instant-play request or new Android Auto DHU
UI testing. Album metadata is exercised through the same session builder the car consumes.
