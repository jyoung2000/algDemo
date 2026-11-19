# Find similar sound (SIMILAR-SOUND-001)

The **Find similar sound** button is on each starting and recommended song in the **now playing list**. The selected song is the reference, not the listener's aggregate taste. The button adds up to ten *new recordings* to that list, leaving every existing row in place. Its minimum audio-match threshold lives at **Settings → Similar sound**, defaults to 70%, allows whole numbers 40–95%, persists across restarts, and applies to the *next* run (not retroactively). Turn on Settings' Audio matching to use it.

## What the percentage means

It is **not** a probability of a human calling the songs similar. It is the existing engine's DCLAP audio-vector cosine, calibrated by `engine.ts:calibrateAudio` (`clamp((cosine − 0.3) / 0.55, 0, 1)`), then rounded to a percentage. The source and candidate must each have a valid 512-element vector for the current model/preprocessing IDs. A missing vector, a service's “related” label, a shared genre, or a matching artist never passes the filter on its own. A full-song vector already analysed on disk takes precedence; otherwise, a legitimately available Deezer preview is analysed. A different provider's result can be compared when it has a known vector or a Deezer match; one without analysable audio is skipped rather than guessed. Preview analysis **never** replaces full-song playback. The result's explanation shows the measured score.

## Where candidates come from

`POST /api/similar {track}` uses the existing provider graph (`Pipeline.gather`: Deezer artist/genre/radio, YouTube Music related/radio, SoundCloud related) and explicitly searches **all seven full-song sources**: Deezer, YouTube Music, SoundCloud, Bandcamp, Audius, HearThis and Internet Archive. The query comes from the selected song's known genre or artist. The services' names and metadata only supply a bounded candidate pool; the sound filter makes the final decision. Search results are interleaved by source so one busy service cannot consume the comparison budget ahead of the rest. Each provider's success/failure/budget status is retained in the job's `sources` object. A provider can return no tracks; this does not fabricate a match or imply that every provider contributes to every run.

The route is asynchronous: poll `GET /api/jobs/<job>`. On completion its `result` holds `added`, `minimum`, `matches` (key, provider, measured percent), `reason` for no additions, `sources`, `audio`, and the new `queue`. The LocalApi removes the seed, existing list songs and duplicate recordings from other services (using `matchRecordings`) before persisting `last_result`. A cancelled job cannot append late. The selected track's own full-song link is preserved. The list's existing `added`-row rule keeps the manual additions through a later re-rank.

## Checks

- `similar-sound.test.ts` checks the 512-vector requirement, calibrated scoring, slider bounds and duplicate-recording selection.
- `similar-sound.integration.test.ts` exercises the real LocalApi routes/store/job with deterministic model-tagged embeddings and all seven provider adapters (offline), threshold persistence, no repeat on a second run, no audio-mode work when switched off, and no genre-only fallback.
- `similar-sound-ui.test.tsx` checks both types of list row button, busy state, and the Settings callback.
- Live Windows and Android emulator runs on November 18, 2026: both queried providers and added audio-verified new tracks at the 70% threshold; Windows added five on the first run and one on a second run (no duplicate row keys), Android added three on the first run. One added song played as a full local song on Windows and another through the native Android player. The Android slider was set to 95%, survived a WebView reload, and was restored to 70%.

**Limits:** source outages and the discovery transfer allowance can reduce coverage; a high threshold may legitimately add nothing. A source whose tracks have no legitimately analysable audio cannot provide a scored match. This is app-defined embedding similarity, not a subjective or absolute promise about acoustic identity.
