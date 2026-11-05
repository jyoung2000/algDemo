# LIST-AVAILABILITY-001 — List download and local availability

Design consulted: actual gpt-6-astra response via configured ExpLabs gateway (requested and returned model matched). Raw design saved in Hermes scratch/aw/design-list-bar-astra.md.

## Layout
- Discovery: directly above combined starting-song/discovery rows.
- Saved: below playlist controls, above chosen playlist rows; never count unrelated lists.
- Windows: count left, Download all right, thin blue meter below.
- Android: count, full-width 44px button, meter; wrap helper text, no horizontal overflow at 320–412px.
- Existing Aqua palette/tokens and .push button; no shimmer or invented percent.

## Meaning and behavior
- "N of M songs ready locally" means confirmed complete files on disk (including permanent kept copies), NOT decoded audio in memory. RAM unloading alone does not change it; disk eviction does.
- Download all requests the displayed list's missing songs into queue cache, not permanent Music-folder copies. Capture unique track keys at click; navigation cannot retarget request.
- Respect cache GB and download-concurrency settings; temporarily override preload count only for explicitly requested songs.
- Bar is semantic meter (min 0, max total, value ready), goes up on completion AND down on invalidation; never cumulative peak.
- Reuse available files, dedupe repeated requests, preserve player-protected files. No infinite eviction/refill churn.
- No songs: disabled Download all, no meter. All ready: disabled All ready. Active bulk: disabled Downloading. Blocked/failed: explain and offer retry without implying everything fits.
- Single polite atomic announcement coalesces fast events; visual count reflects each event. Native keyboard button, focus ring, text not just color, no motion required.

## Coverage
Existing surfaces only: Results.tsx song list, SavedView.tsx All saved + named playlists. Discovery-demo is not an input of suite player/hub/companion generated mockups (design/manifest.json); no unrelated mockup changes.
Behavior tests: list-availability.test.tsx plus queue-preload/local-audio backend tests. Functional gates: actual app Download all click, count increase/decrease, playlist-local denominator, responsive 320/412/1280px measurements.
