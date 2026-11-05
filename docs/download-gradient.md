# Download visualizer gradient (DL-GRADIENT-001)

All three downloader visualizers run blue `#1f6fd1` -> green `#3a9a5e`, from two shared tokens in
`web/src/styles.css`. One web bundle ships in the APK and the Windows package, so the rule covers
both platforms; the device checks measure rendered pixels on each.

## Surfaces
- `.list-availability__meter > span` — the list availability bar.
- `.meter--dl span` — the Downloads screen per-job progress bar.
- `.rec__dl-rail` — the 3px rail on a downloading song row (Discover and Saved).

Excluded on purpose: the Settings storage meter keeps `--gel-thumb`. It is a **capacity** meter, and
turning green as it approaches the cache limit would read as success when it is a warning. The
`.meter--dl` modifier exists only to keep the two apart; `download-gradient.test.ts` asserts
Settings never gains it.

## Full-track gradient, revealed by clip-path
The gradient layer is `width: 100%` and is revealed with
`clip-path: inset(0 calc(100% - var(--fill)) 0 0)`. Sizing the layer to the fill fraction instead
would rescale the gradient on every change, so 10% ready and 100% ready would both end green and
the colour would say nothing about how much of the list is on the device. Measured: the colour at a
fixed x is identical at 25%, 60% and 100% ready (max channel drift **0**).

Flat states override both properties (`clip-path: none`): `ready` is a quiet full hairline,
`failed`/`blocked` are danger, `queued` is a hairline, and the indeterminate sweep keeps its own
35% width because there is no percent to reveal.

## Verification
```
# 1. stylesheet contract (runs in the normal suite)
cd web && node ../../node_modules/vitest/vitest.mjs run src/download-gradient.test.ts

# 2. rendered pixels, against a running app
node scripts/check-download-gradient.mjs   # via a CDP driver; writes frames + report.json
python scripts/analyse-download-gradient.py <out-dir>
```
The analyser crops the meter from a full-viewport screenshot and asserts on real colour channels:
blue at the left at every fill level, green at the right end when full, a monotone handover, an
untinted grey track beyond the fill, and the scale invariance above.

Measured on the shipped builds (Android 0.10.2 / Windows 0.7.2):

| | left edge | right end (full) | empty track |
|---|---|---|---|
| Android APK | `rgb(31, 112, 207)` | `rgb(58, 153, 96)` | `rgb(222, 222, 222)` |
| Windows | `rgb(32, 112, 207)` | `rgb(58, 153, 96)` | `rgb(222, 222, 222)` |

Job meter during a real download (Windows): gradient painted, layer **728.09 px** across a
**728.09 px** track, `clip-path: inset(0px 96% 0px 0px)` at 4%. Row rail on a live download:
gradient painted, state `downloading`. Android WebView resolves both tokens and supports
`clip-path: inset`, so the same markup renders identically there.

**Negative control:** forcing the wrong implementation (`width: var(--available)`, no clip) makes
the analyser fail with "gradient is scaled to the fill, not the track" — drift 51 and 28. A check
that cannot fail proves nothing.

## Pitfalls
- `Page.captureScreenshot`'s `clip` was interpreted against a different origin than
  `getBoundingClientRect` in the Android WebView; the crop landed on genre pills while still
  reporting a confident colour. Capture the full viewport and crop in the analyser using
  `rect * (image width / innerWidth)`.
- A *ready* rail is deliberately flat, so a probe that grabs the first `.rec__dl-rail` finds no
  gradient and looks like a bug. Remove cache files first and sample while a download is in flight.
- The availability bar only exists on a list screen. A probe that left Settings open earlier finds
  no bar at all.
