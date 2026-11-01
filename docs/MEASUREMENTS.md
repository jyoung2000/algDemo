# Measurements and test results

Measured on 26 Oct 2026 on the development machine: Windows 11 x64, Node 26.7.0, uv 0.12.3, CPython
3.13, CPU inference only. These are single observations, not guarantees. Live latency depends on
the music services and the network.

## Startup

| What | Value | How |
| --- | --- | --- |
| Server ready (app start-up, `startup_ms`) | 221 ms | Reported by `/api/status`. Includes opening SQLite and loading the ONNX model. |
| Launcher restart to first HTTP 200 | about 0.9 s (one observation) | Timed from the end of the restart script to the first `GET /api/settings` 200 (uv already synced). |
| First run (uv creates `.venv`) | not timed | Depends on download speed. uv fetches the wheels pinned in `uv.lock`. |

## Metadata latency (`/api/search`)

Server-side handling time, from `/api/status` → `timings.search`. Each query was run twice in a row.

| Query | Uncached | Cached repeat |
| --- | --- | --- |
| "midnight city m83" | 523 ms | 2.1 ms |
| "a bar song shaboozey" | 400 ms | 1.4 ms |
| "zz top la grange" + a unique suffix | 429 ms | 2.1 ms |
| Later uncached searches | 478–574 ms | 1.8 ms |

A pasted Spotify track link answered in 2 ms when cached. It returned a 10-song choice, because
oEmbed gives no artist.

## A full uncached recommendation

Seeds: the first Deezer hit for "dreams fleetwood mac" and the first for "bad guy billie eilish",
picked from live search. Mode Discover, adventurous 0.5, audio on.

| What | Value |
| --- | --- |
| First metadata results visible to the client | 5.1 s (client-polled, 250 ms poll) |
| Finished, including audio refinement | 40.8 s (client-polled) |
| Songs returned | 30 of 30 asked |
| Max songs per artist | 2 |
| Tiers | 12 strong, 9 related, 6 emerging, 3 experimental |
| Sources | 26 YouTube Music, 4 Deezer; every source call `ok` |
| 2026 releases in the queue | 4 by year; 2 flagged new releases (day-precision Deezer dates in the 60-day window) |
| Previews embedded / candidates compared | 22 / 20 |
| Songs in the final queue with an audio factor | 12 |
| CPU inference per preview (DCLAP, 30 s excerpt, several 10 s windows) | 546–594 ms, median about 560 ms |
| Preview download per file | 44–1,227 ms |
| Audio phase wall time | 27.6 s |
| Transfer for this request | metadata 818,036 B; audio 10,556,194 B (22 previews, about 480 KB each, wire bytes) |

Earlier, a job driven from the browser at 1440 px showed first results in 1.9 s with metadata
cached, refining in 20.7 s.

## Memory

| What | Value |
| --- | --- |
| Server RSS after the job above and later searches | 202 MB (202,072,064 B) |
| Peak working set (process lifetime, includes the job) | 265 MB (265,166,848 B) |

## Disk footprint (app-managed, from `/api/status` and `du`)

| Area | Bytes | Budget |
| --- | --- | --- |
| Runtime (`server/.venv`) | 138,035,753 | 1,200,000,000 |
| Models (DCLAP ONNX + data) | 22,411,906 | 800,000,000 |
| Database (SQLite + WAL, vectors, caches) | 7,044,744 | 1,000,000,000 |
| Logs | 8,832 | 100,000,000 |
| Temporary audio | 0 (previews are decoded in memory) | 250,000,000 |
| Artwork | 0 (the browser loads it from provider CDNs) | 250,000,000 |
| **Total** | **167,501,235** | hard cap 5,000,000,000 |
| Web build (`web/dist`) | 289,280 | (served, counted with source) |

Not counted, and not app-controlled: uv's shared Python store, the pnpm store and root
`node_modules` (shared with the monorepo), the OS, the browser and its cache.

## Transfer

Every byte the server downloads is metered on the wire, against 20 MB per request and 100 MB per
day by default. The figures above come from that meter. Browser streaming of previews and embeds
goes straight from Deezer or YouTube to the browser and is **not** counted in that allowance.
Settings says so.

During development the 100 MB daily allowance ran out (99.7 MB used), and the audio step stopped
early with a plain-language message, as designed. The uncached job above was measured after
raising the allowance to 250 MB for the run; it was set back to 100 MB afterwards. By the end of
the day 111.7 MB had been downloaded (76.3 MB audio, 35.4 MB metadata), so live jobs now stop the
audio step early until the daily reset.

## Tests

```
server> PYTHONPATH= uv run --frozen pytest -q
73 passed, 13 deselected, 5 warnings in 6.24s

server> PYTHONPATH= uv run --frozen pytest -q -m live
13 passed, 73 deselected, 5 warnings in 1.68s

web> tsc -p tsconfig.json --noEmit        exit 0
web> vite build                           built in 80 ms
```

The warnings are deprecation notices from dependencies, not test failures.

Unit and API tests (no network, every provider stubbed) cover:

- **Missing-factor normalisation and coverage:** missing evidence is renormalised away, and a
  single weak signal cannot beat rich evidence.
- **Multi-seed:** the best-seed blend keeps two taste clusters, emphasis counts, and reasons name
  the supporting seed.
- **Duplicates and versions:** live, remix, acoustic, sped-up and cover versions stay distinct;
  collaborations are split; uncertain matches are not merged.
- **Feedback:** event de-duplication, decay, one skip never penalises an artist, and three skips
  give weak propagation.
- **Diversity:** at most 2 per artist, and the order is not re-sorted after selection.
- **Dates:** year-only dates are not new releases; the 60-day window applies.
- **Cache:** LRU eviction protects user data; malformed rows count as misses; concurrent store
  access works.
- **Byte limits:** declared and streamed over-cap responses are cancelled, redirects are checked
  per hop, private and loopback addresses are refused.
- **Audio:** Slaney mel filterbank, tone peak, segment coverage including the tail window, DCLAP
  determinism.
- **API:** seed cap and de-duplication, weight validation, sample data is labelled, a self-test out
  of allowance is not a model failure.

Live tests (against the running server, real services) cover title search on two queries, one
public link per service (Spotify, SoundCloud, YouTube, youtu.be, YouTube Music, Deezer), invalid
links failing plainly for three services, a public YouTube Music album giving a bounded choice,
and `/api/health` reporting runtime checks.

## Browser checks (Playwright, Chrome, the running app)

- Search by title, Add, remove, emphasis, Clear all; "Find my next favorite" is disabled with an
  explanation until a seed exists.
- Progressive results, Like/Dislike/Hide, "Why this song?", and the last queue restored after a
  reload.
- Preview playback: `<audio>` not paused, `currentTime` advancing (2.8 s at 390 px, 3.9 s at
  1440 px), source `/api/preview/deezer/{id}`.
- 390 px: no horizontal overflow (document 375 = viewport 375). Seed controls are 40 × 40 px.
  Both seeds are visible after the shelf was made to stack. The docked player (top 768 px) covers
  no button, and the last row ends at 673 px when scrolled to the bottom.
- Settings: sample-data toggle leads to the labelled sample queue (12 rows, banner "Sample data,
  not live recommendations…"); audio-model self-test and badge.

Screenshots in `docs/screenshots/`: `01` start (1440), `02` results (1440), `03` playing and
"Why this song?" (1440), `05` settings (1440), `06` results (768), `07` results (390), `08`
playing at end of the list (390), `09` sample mode (1440). `04`, `06-…-end` and `07-…-end` are extra states.
