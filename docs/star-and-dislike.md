# Star, playlist membership and live dislike learning — 0.18.10 / vc53

## Owner requirements
- Replace thumbs-up with a star.
- Show a checkmark next to the star when the song is already saved to a playlist.
- Dislike must affect the algorithm and better inform its taste.

## Changes
`SongStar.tsx` renders the same adjacent star/check in search (including album and artist track lists), recommendation rows and current-player controls. The check comes from `PlaylistSummary.items[].key` across named user playlists; liking, a starting-song seed, download status or an album-only save never substitutes for playlist membership. Removing the last playlist membership removes the check. Existing accessible labels/like/unlike/save-menu behavior remain; saved buttons also announce “saved to a playlist”. Dislike retains its thumbs-down icon.

The engine already handled explicit dislike: excluding that recording, lowering artist affinity and assigning negative weight to its known genres. The UI previously only refreshed the taste card after an explicit judgement. `App.learnFeedback` now saves the judgement, refreshes taste, then immediately re-ranks the existing candidate pool, as listening already does, without starting discovery/provider requests. Search likes and player actions use the same path. Current playback, played history and owner-added queue entries remain protected by the established merge policy. The dislike is reversible; no playlist files or kept Music copies are deleted.

Feedback writes must succeed before the UI marks the judgement as saved; pending per-track writes are deduplicated. No discovery pool yet is a supported case: taste still updates and the next discovery uses it. Genre learning requires actual known tags; the code does not fabricate genres for an unknown song.

## Verification
- RED before implementation: 13 failing / 6 passing frontend regression cases.
- Full web suite: **1519 passed, 7 skipped**, 153 files passed / 2 skipped; TypeScript no-emit clean.
- New targeted suite: **29 passed** (15 star/membership, 4 live feedback, 10 real engine/store cases).
- Real engine tests cover v1/v2 negative genre learning, negative artist/song feedback, cross-artist same-genre demotion, rejection exclusion without caller exclusions, undo and persistence through Store/LocalApi recreation. Zero provider calls in those deterministic tests.
- Release APK `assembleRelease` and Windows installer/portable packaging succeeded.
- Packaged Windows UI with real provider search: star -> create playlist -> adjacent check; player receives membership; dislike records a negative event (0 -> 1), undo removes it; removing the song from the playlist removes the player check. Actual playlist API readback confirmed membership changes.
- Recommendation-row Windows save/check exercised with a real “delusional” row; both glyphs remain inside their button with no document overflow at 320/360/412/1280 CSS px.
- Android release on emulator-5554: actual “overseas” search row and player gain checks after playlist save; dislike and undo persist. After playlist removal, exact playlist readback has count 0 and player has only the star. Removal/undo survive a WebView reload.
- Android populated Saved layout script passes at 320/360/412/1280 CSS px (title widths ~193/233/285/583 px, no overlap).

Evidence under `C:/Users/jalon/AppData/Local/hermes/testing/star-dislike/`: Windows smoke JSON, Android smoke/readback JSON, Windows queue geometry, screenshots. The initial Android smoke stopped at Playwright's synchronous `uncheck()` assertion; the actual async save completed. Exact-target raw-CDP readback and reload confirmed the result; this was a harness timing issue, not a claimed passing full Playwright run.

## Scope preserved
No EQ, mixer, source-permission, download, identity, Android Auto session or audio DSP logic changed. A reset must never remove copies the owner chose to Keep in their Music folder.
