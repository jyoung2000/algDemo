# Ready Play tint — READY-PLAY-001 (0.18.11 / vc54)

Owner: “make the play button a slightly different color if its ready to play”.

The small song-card Play control now has a subtle blue background and blue icon when `cacheOf(key).state === 'ready'`. This includes both the automatic full-song cache and permanently kept copies. Queued, downloading, failed, blocked and unknown states remain neutral. The style is applied to recommendation rows and standalone starting-song rows, using the existing cache subscription/state; no download, preloading or playback behavior changed.

The existing cache checkmark and screen-reader readiness text remain, and ready Play tooltips read “Play — ready locally”. The tint is not a playlist-save indicator; the adjacent star/check still represents playlist membership.

## Verification
- Regression RED: 5 failing/5 passing cases before implementation (after correcting test fixture/import issues).
- GREEN: 10/10 cases, including readiness completion/eviction, kept copies and unchanged play callbacks.
- Full web suite: 1529 passed / 7 skipped; TypeScript clean.
- Web, release APK and signed Windows setup/portable built successfully.
- Real packaged Windows + release APK: actual ready buttons use background `rgb(230, 239, 251)` and icon `rgb(31, 111, 209)`; neutral CSS negative control is transparent with `rgb(86, 91, 96)` icon. Test profiles happened to have all visible tracks cached, so non-ready runtime transitions are covered by component tests, not claimed as native eviction testing.
- Clicking a ready button activated the intended song on both Windows (“Naked”) and Android (“overseas”). APK installed as 0.18.11/vc54.
- Native evidence: `C:/Users/jalon/AppData/Local/hermes/testing/ready-play/{windows,android}.{json,png}`.
