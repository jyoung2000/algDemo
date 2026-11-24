# jPlay 0.20.17: recommendation, shuffle and listening mood — diagnosis and repair plan

Source: `jyoung2000/iPlay` tag `v0.20.17` (commit `80cb82d`, versionCode 79), diagnosed 2026-11-24.
Paths are relative to `discovery-demo/`. Line numbers are for that tag.
Evidence labels: **Measured** = the code at this tag was run and the number recorded. **Read** = found by reading the code, not run.

Suggested home in the repo: `docs/plans/2026-11-24-recsys-shuffle-mood.md`.

---

## 1. Summary

The shipped engine is the TypeScript one in `web/src/engine/` (the Python `server/` is a development sidecar and is out of scope). All 3,059 existing tests pass, so every defect below is behaviour the tests do not cover.

Three defects are worth fixing before anything else:

1. **A re-rank changes what is in the queue.** After every finished or skipped song the engine re-ranks its whole candidate pool, not the queue, and the page takes everything it returns. Measured: a 10-song queue became 29 songs after one re-rank, and after a top-up two unheard songs were dropped.
2. **Songs lose their evidence when a top-up runs.** Rows carried over from the previous queue are stored without `provenance`, `dz_id` and `links`, so the next re-rank scores them as if no service had recommended them and no audio existed.
3. **Most skips teach nothing.** A Next press is recorded only between 2 and 12 seconds. At 20 seconds, 60 seconds or 95% of the song nothing is written: no skip, no completion, no re-rank and no top-up.

Shuffle and mood then have their own problems:

- With a settled mood the Discover shuffle is close to a sort by mood fit (8.2 of the first 10 songs are on-mood; an even shuffle gives 3.3). After the one draw the mood never moves the order again.
- Songs a top-up mixes into a shuffled order ignore the artist-spacing rule (90% of top-ups put one artist back to back).
- The mood feeds on itself: a 24-song session of only letting songs play turned a queue that alternated four genres into ten hip-hop songs in a row, then ten electronic.
- The song playing counts as full mood evidence from second 0, so one song of another genre starting is enough to pull that genre into the lead.

Work is split into ten packages (section 5). WP0–WP3 are repairs with no behaviour the owner chose being changed. WP4–WP7 change shuffle and mood behaviour and have four owner decisions with defaults (section 6). WP8–WP10 are upgrades.

---

## 2. Baseline

| Check | Result |
|---|---|
| `web` test suite (`vitest run --root . --dir src`) | 334 files passed, 3 skipped, 1 could not load; 3,059 tests passed, 10 skipped |
| The file that could not load | `engine/store.test.ts`: `fake-indexeddb` is not installable from the published lockfile |
| Clean clone, `pnpm install` as `BUILD.md` says | Tests do not start: `Cannot find package 'vite'`. Root `package.json` declares neither `vite`, `@vitejs/plugin-react`, `react` nor `happy-dom`; they are only reachable when hoisted (`shamefully-hoist=true` made the suite run) |
| `BUILD.md` | Still headed "jPlay 0.20.3 … commit 40ddf80" |
| `engine/benchmark.ab.test.ts:23,95,173` | Writes to the literal path `D:/MusicRecommendationLab/benchmarks/`; on Linux and in cloud agents this creates a `D:` folder inside `web/` |
| Android and Windows builds | Not built or run here. Kotlin findings are **Read** only |

How the measurements were made: three scratch vitest files (delivered beside this plan in `diag/`) that call the real `LocalApi`, `arrangeShuffle`, `stepQueue`, `moodShufflePick`, `buildMood`, `moodOrder` and `moodFit` with a fake Deezer and a seeded random source. Section 8 says how to rerun them.

---

## 3. Findings

Severity: **P0** breaks a stated rule or loses data; **P1** clearly worse listening; **P2** parity, edge cases, housekeeping.

### 3.1 Recommendation algorithm

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| A1 | P0 | **Re-rank adds songs to the queue.** `runJob` stores every gathered candidate in the pool (`poolCands = [...previous, ...cands]`), `rerank()` ranks the whole pool with `queueSize = pool size`, and `mergeRerank` appends everything returned. The comment says a re-rank "adds nothing". Side effects: the page's list and the stored `last_result` disagree, so a restart or a top-up snaps the list back; listens on the extra rows are "not in the list", so they never trigger a top-up. | **Measured**: queue 10, pool 43, re-rank returned 29, queue after merge 29 (19 rows never chosen by discovery). `engine/local-api.ts:2205, 2369-2374, 2391-2420` (2406, 2414-2415), `util.ts:508-513`, `engine/local-api.ts:1980-1986` |
| A2 | P0 | **Carried-over rows lose their evidence.** `previous.map(x => x.track)` is the cleaned UI shape: `TRACK_FIELDS` has no `provenance`, `dz_id`, `dz_preview_id`, `links`. Vectors are loaded only for the seeds and the new candidates, and `relatedArtists` is only the last run's. On the next re-rank an older row's provider factor is gone, its audio factor is gone unless it is a Deezer-provider row, and its reasons change. | **Measured**: after one top-up the carried row had no `provenance`; provider factor 0.3 → `null`; reasons `artist, provider` → `artist, feedback`. `engine/shape.ts:10-13, 41-46`, `engine/local-api.ts:2230-2240, 2370, 2545`, `engine/engine.ts:529-562` |
| A3 | P0 | **Listen telemetry has a hole from 12 seconds to the end.** `next()` records a skip only when 2 s ≤ listened < 12 s. A natural end records a completion. A Next press at any other time records nothing, including at 95% of the song. No event means no feedback, no taste, no mood signal, no re-rank and no top-up, so skipping through the last five songs at 20 s each leaves the queue to run dry. The mood's own rule ("early skip = before 30 s and before a quarter") can never see a skip later than 12 s. | **Read**: `Player.tsx:808-820` (812), `Player.tsx:742-761`, `util.ts:320-323`, `engine/native-engine.ts:154-163` (same window for the Android engine), `engine/discovery.ts:37-45`, `engine/mood-queue.ts:73-78` |
| A4 | P1 | **Re-rank drops unheard rows.** `select()` still enforces 2 songs per artist over the pool. Songs heard in an earlier session (or by the phone's engine while the page was closed) are not in the page's `exclude`, score higher because they were finished, and take the artist's two places. | **Measured**: with `exclude: []` after a top-up, two unheard queue rows were missing from the re-rank. `engine/engine.ts:817`, `engine/local-api.ts:2397, 2414` |
| A5 | P1 | **One artist keeps coming back.** The cap counts only songs still waiting; songs just heard do not count, and the code comment says they do. Each top-up is seeded from the song just heard and from the listener's own artists, so the same artist can take two places in every batch. There is no artist-level fatigue; the exposure penalty is per song. This matches the complaint quoted in `artist-variety.ts:2-3`. | **Read**: `engine/local-api.ts:2086-2089` (comment vs code), `engine/artist-variety.ts:15-30`, `engine/local-api.ts:2010, 2140-2151`, `engine/engine.ts:693-694` |
| A6 | P1 | **Candidate cut-off favours the least useful sources.** Sources are merged in task order and cut at `mergedCap` 200. Apple and Spotify searches for the seed's own "artist title" (up to 40 each, mostly versions of the same song and the same artist, and not counted as relatedness) come before Deezer's related artists, recent releases, genre charts and the taste-colour sources, which are last and are the first to be cut. | **Read**: `engine/pipeline.ts:211-217, 258-281, 297-316, 344` |
| A7 | P2 | **A manual run can re-offer heard songs.** Only top-ups filter heard songs. Under Discover shuffle such a song is filed under "heard" at once and never plays, so it uses a place for nothing. | **Read**: `engine/local-api.ts:2103`, `engine/shuffle-order.ts:31` |
| A8 | P2 | **`added` means three things.** Hand-added, Find-similar and custom-discovery rows all carry `added: true`. They are pinned for the mood, never re-ranked, and `mergeRerank` moves all of them in front of the re-ranked rows rather than leaving them "where they were". The flag has already caused one shuffle bug (comment at `shuffle-order.ts:37-38`). | **Read**: `engine/local-api.ts:1036, 1775, 1839`, `engine/mood-apply.ts:10`, `util.ts:510-512` |
| A9 | — | **Session taste horizon is empty** (session ids never match). Already documented and accepted by the owner on 18 Nov; listed so nobody "fixes" it by accident. WP10 offers a replacement. | `docs/ranking-formula.md:90`, `engine/taste2.ts:83-84`, `engine/local-api.ts:2694-2704` |

### 3.2 Shuffle

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| S1 | P1 | **With a mood, the Discover shuffle is nearly a sort.** Weight is `e^(k·fit)`, `k = confidence × (10 − 7a)`. Confidence is 1.0 once two songs have finished and a third is playing. At the default slider on-mood and off-mood songs differ in weight by 68×. | **Measured** (30 songs: 10 on-mood, 10 middling, 10 off-mood; 3,000 draws): on-mood songs in the first 10 = 8.2 (even shuffle 3.3), off-mood = 0.22, Spearman fit-vs-place −0.83; Familiar −0.91. `engine/mood-shuffle.ts:22-30`, `engine/shuffle-order.ts:51-53`, `engine/mood-queue.ts:139` |
| S2 | P1 | **After the draw the mood is ignored.** The order is drawn once per round. A star, a dislike or Find similar never moves it: the mood effect returns early under Discover shuffle, and the kept-order branch does not read the mood. If the app starts with shuffle already on, the draw happens before the first mood answer, so that order has no mood in it at all. | **Measured**: an order kept unchanged when the mood turned against its first six songs. **Read**: `App.tsx:745, 784, 831-850` (deps at 850), `engine/shuffle-order.ts:58-71` |
| S3 | P1 | **Top-up songs break artist spacing.** A fresh draw never puts one artist back to back. Songs found later are inserted at a uniformly random place with no artist check. | **Measured**: fresh draw 0 same-artist neighbours in 3,000 orders; after mixing in 6 top-up songs, 90% of orders had an artist back to back (1.7 pairs on average, longest run 3). `engine/shuffle-order.ts:68` |
| S4 | P2 | **The queue and the player can disagree.** Under Discover shuffle the list is meant to be the play order, but the four-in-a-row rule makes `stepQueue` take a later song without the list changing, and the pin effect is off in this mode. | **Measured**: list showed `a5` next, player took `b1`. `util.ts:201, 208-213`, `App.tsx:821` |
| S5 | P2 | **When every song is heard, playback stops.** By the owner's once-only rule this is intended, and a top-up that arrives within 30 minutes restarts it. But "heard" is every completion or skip ever stored plus 3,000 started keys, with no expiry, and a top-up that finds nothing (offline, allowance paused, sources spent, or the A3 hole) leaves a full queue silent. | **Measured**: `stepQueue` returns `null`. **Read**: `util.ts:223`, `App.tsx:194, 285`, `engine/shuffle-order.ts:94-128`, `engine/queue-data-flow.ts:68-78` |
| S6 | P2 | **The Android engine reshuffles a list that is already in play order.** The page pushes the Discover queue in its shuffled order; `PlayQueue` then draws its own uniform order, with no mood weighting and no artist spacing (only the four-in-a-row limit). When the phone app closes, the car plays a different order from the one the phone showed. | **Read**: `App.tsx:1129, 1134`, `android/.../engine/EnginePlayer.kt:314-330, 890-896`, `android/.../engine/PlayQueue.kt:165-173, 300-318, 332-342` |
| S7 | P2 | **Artist names are split differently on the two sides.** Web splits on `, & and x feat ft featuring with vs / ;`; Kotlin splits on `, & feat ft featuring with x`. "A / B" or "A and B" is one artist in the car and two on the phone, so the four-in-a-row rule can differ. `previous()` also does not record the play for the run count. | **Read**: `engine/identity.ts:28`, `PlayQueue.kt:290-297, 363-365` |
| S8 | P2 | **The shuffled order is not kept across a restart.** It lives in a ref; reopening the app draws a new order, while the Android engine restores its own saved round. | **Read**: `App.tsx:230-232, 842` |

### 3.3 Listening mood

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| M1 | P1 | **The mood reinforces itself.** Every finished song adds +2, including songs the mood itself moved to the front, and the "engine order" term is the list's current place, which after the first re-arrangement is the mood's own previous order. | **Measured** (queue alternating hip-hop, electronic, jazz, rock; listener only lets songs play; 24 songs): played 10 hip-hop, then 10 electronic, then jazz; rock never reached; 8 re-arrangements moved 166 rows. `engine/mood-queue.ts:70, 215`, `App.tsx:728-739` |
| M2 | P1 | **The song playing is full evidence from second 0.** `current` weighs 3 (confidence 0.5, which is the lead rule's bar) the moment a song starts. One song of another genre starting gives that genre a fit above the bar before a second of it has been heard. | **Measured**: after three finished rap songs, a jazz song starting moved jazz fit from 0 to 0.656 (bar 0.5); the song playing alone re-arranged 12 rows. `engine/mood-queue.ts:70, 139, 233-241`, `engine/local-api.ts:2498` |
| M3 | P1 | **Nothing keeps one artist apart in the mood order.** A mood candidate is `key, tags, vector`; there is no artist. Songs by the starred artist share its tags and are its nearest sound, so they rise together. | **Read**: `engine/mood-queue.ts:47-51, 202-257`. **Measured** (tags only): the starred artist's share of the next five went from 1 to 2 |
| M4 | P2 | **The sound term is missing for most upcoming songs.** A full-song vector is made only when a song is played; before that only the ≤20 preview-compared candidates of a run have one. So upcoming songs are mostly matched on family and genre words, and a song that does have a vector is judged more strictly than one that does not. | **Read**: `Player.tsx:312-322`, `engine/local-api.ts:2277-2300, 2470-2474`, `engine/mood-queue.ts:168-184` |
| M5 | P2 | **A dislike spreads to the whole genre when there is no vector.** The dislike match is 65% sound; with the sound missing the remaining tag weights are rescaled to 100%, so every song of the same family and genre takes the full penalty. | **Read**: `engine/mood-queue.ts:168-173, 181` |
| M6 | P2 | **Mid-song skips never reach the mood** (consequence of A3). | See A3 |

### 3.4 Working as intended: do not change

- The plain shuffle draw is fair. **Measured**: chi-square 26.9 on the first place over 20 songs (5% critical value 30.1); with one artist holding 8 of 30 songs, that artist opens the order 26.9% of the time (26.7% expected).
- A fresh draw never puts one artist back to back when another is available (0 in 3,000 orders).
- Once per round holds on both sides, and the committed next song stays committed (`SHUFFLE-NEXT-001`).
- The owner's own mood example works. **Measured**: with a starred rap song, a starred electronic song and rap playing, the next 12 were `hiphop ×3, electronic, hiphop, electronic, hiphop, electronic, hiphop, electronic, jazz, rock`; no off-mood song in the next six.
- The v1 scorer and its golden fixtures (`engine.golden.test.ts`) are isolated behind `rankV2`. Event de-duplication by playback instance works.

---

## 4. Targets

Each row becomes an assertion in WP0 (marked `it.fails` until its package lands).

| Metric | Now | Target | Package |
|---|---|---|---|
| Rows a re-rank adds to a 10-song queue | 19 | 0 | WP1 |
| Unheard rows a re-rank drops | 2 | 0 | WP1 |
| Carried row keeps `provenance` and its provider factor after a top-up | no | yes | WP2 |
| Next press at 20 s / 60 s / 90% of a 3-minute song is recorded as | nothing / nothing / nothing | skip / partial / complete | WP3 |
| Skipping the last 5 songs at 20 s each starts a top-up | no | yes | WP3 |
| Top-ups that put an artist back to back in a shuffled order | 90% | ≤ 5% | WP4 |
| Row after the song playing is the song the player takes | not always | always | WP4 |
| Discover shuffle, full mood, default slider: on-mood songs in the first 10 of 30 | 8.2 | 4.0–5.5 | WP5 |
| Same: off-mood songs in the first 10 | 0.22 | ≥ 1.7 | WP5 |
| A star, dislike or Find similar re-deals the unheard tail of a shuffled order | never | on the next mood answer | WP5 |
| Passive 24-song session: longest same-genre run | 10 | ≤ 5 | WP6 |
| Same: genres heard in the first 12 songs | 2 | ≥ 3 | WP6 |
| Same: rows moved in total | 166 | ≤ 80 | WP6 |
| Fit of a new genre at second 0 of its first song (bar 0.5) | 0.656 | < 0.5 until 45 s are heard | WP6 |
| Starred rap + starred electronic: off-mood songs in the next 6 | 0 | 0 (must not regress) | WP6 |

For WP5 the measured effect of capping the best-to-worst weight ratio at R (same 30-song set):

| R | First song is on-mood | On-mood in first 10 | Off-mood in first 10 |
|---|---|---|---|
| even shuffle | 0.33 | 3.3 | 3.3 |
| 2 | 0.41 | 4.0 | 2.7 |
| 4 | 0.49 | 4.6 | 2.2 |
| 8 | 0.57 | 5.3 | 1.7 |
| today, default slider | 0.90 | 8.2 | 0.22 |

---

## 5. Work packages

One package is one branch and one pull request. Order matters where "After" says so.

### WP0 — Make the repo runnable and pin the baseline (P0, small)

- **Files**: root `package.json` or a root `.npmrc`, `BUILD.md`, `web/src/engine/benchmark.ab.test.ts`, new `web/src/engine/quality/*.quality.test.ts`.
- **Change**:
  1. A clean `pnpm install` must let `web` tests start: declare `vite`, `@vitejs/plugin-react`, `react`, `react-dom`, `happy-dom`, `@testing-library/*` and `fake-indexeddb` where the root install resolves them (or ship `.npmrc` with `shamefully-hoist=true` and add `fake-indexeddb`). Skip this step if work happens only in the development monorepo, where it already resolves.
  2. `benchmark.ab.test.ts`: output folder from `JPLAY_BENCH_OUT`, default `os.tmpdir()`.
  3. Update the `BUILD.md` header to the current version.
  4. Copy the three files from `diag/` to `web/src/engine/quality/` (their imports are written for `web/src/__diag__/`, so fix the relative paths), replace `writeFileSync` with assertions on the section 4 targets, and mark each target `it.fails` so the suite stays green and flips when the fix lands.
- **Done when**: clean clone → install → full suite green; no `D:` folder appears on Linux.

### WP1 — A re-rank only reorders (A1, A4, A8) (P0)

- **Files**: `web/src/engine/engine.ts`, `web/src/engine/local-api.ts` (`rerank`), `web/src/util.ts` (`mergeRerank`), `web/src/App.tsx` (the two `mergeRerank` call sites), tests.
- **Change**:
  1. `engine.ts`: add `orderAll(scored, ctx)`. Same per-pick value as `select` (final − exposure − similarity penalty + seed balance + fresh bonus), no tier quotas, no per-artist cap, no early exit: it returns every row. Do not touch `select` (golden parity).
  2. `rerank()`: candidates = pool rows whose key is in `last_result.items` and not in `exclude`. Rank with `orderAll`. Rows in the queue that have no pool row are not returned and not removed.
  3. `mergeRerank`: fill the slots of the re-ranked rows in place; played rows, pinned rows and rows the re-rank did not return keep their index. Ignore returned rows that are not in `prev`. The result always has the same keys as `prev`.
  4. Split the `added` flag: `added: true` stays for hand-added rows (pinned, `QUEUE-ADD-001`); Find-similar and custom-discovery rows get `found: 'similar' | 'custom'` instead, are movable by the mood and the shuffle, and are still not re-scored. Update `moodMovable`, `arrangeShuffle`'s comment and the three writers (`local-api.ts:1036, 1775, 1839`). Read old stored queues: a row with `added` plus `custom: true` or a `sound_match` key is a found row.
- **Tests**: the WP0 re-rank targets; a hand-added row at the end of the list stays at the end after a re-rank; a Find-similar row is moved by the mood.
- **Risk**: before this fix the hoisting in `mergeRerank` is what brought Find-similar songs up the list. Step 4 replaces that; do not ship steps 1–3 without it.

### WP2 — Evidence survives a top-up (A2) (P0). After WP1.

- **Files**: `web/src/engine/local-api.ts` (`runJob` end, `rerank`, `restorePool`), tests.
- **Change**:
  1. When building the pool, take each previous row's raw candidate from the old pool (`this.pool ?? this.restorePool()`) by key; fall back to the cleaned track only when there is none.
  2. Union `relatedArtists` per seed key and the seed views across runs (newest 40 seeds).
  3. In `rerank()`, load vectors for every pool row and seed from the store (the lookups `restorePool` already does), so a vector made since the run counts.
  4. Keep the non-chosen candidates of the last run as a separate `bench` list in `last_pool` (top 100 by score), not in `cands`. WP10 uses it. Cap `last_pool` at queue rows + 100.
- **Tests**: the WP0 evidence target; `last_pool` size bound; restore after a simulated restart gives the same factors.

### WP3 — Record every way a song ends (A3, M6) (P0). Independent of WP1–2.

- **Files**: `web/src/util.ts`, `web/src/Player.tsx`, `web/src/engine/native-engine.ts`, `web/src/engine/local-api.ts` (`FEEDBACK_KINDS`, `heardKeys`, `listeningGuard`), `web/src/engine/discovery.ts`, `web/src/engine/queue-data-flow.ts`, `web/src/engine/shuffle-order.ts` (`heardIn`), `web/src/App.tsx` (`onListen`), tests.
- **Change**:
  1. `util.ts`: `classifyNext(listened, coverage, duration, medium)` returning `'complete' | 'skip' | 'partial' | null`:
     - `complete` when `listened ≥ COMPLETE_S` and `qualifiesCompletion(...)` is true (a Next press near the end is a listen);
     - `skip` when `listened ≥ 2` and `listened < limit`, with `limit = 12` for previews, else `clamp(0.25 × duration, 12, 30)`, else 30 when the duration is unknown (this is the mood's own definition of an early skip, never narrower than today);
     - `partial` for anything else from 2 s up;
     - `null` under 2 s.
  2. `Player.next()` and `listenFromEvent` (cause `next`) use it.
  3. New stored kind `partial`. It is not added to `FEEDBACK_WEIGHTS` or `TASTE_EVENT_WEIGHTS` (the v1 scorer ignores unknown kinds at `engine.ts:276`, so golden parity holds) and it is not a mood signal. It does count as heard: `heardKeys`, `heardTest`, `heardIn`, and `needsListeningDiscovery` accept it, so the re-rank and the top-up check run.
- **Tests**: table test for `classifyNext`; integration: five 20-second skips at the low-water mark start a top-up; golden test unchanged.

### WP4 — One artist-variety rule, used everywhere (A5, S3, S4, M3) (P1). After WP1.

- **Files**: `web/src/engine/artist-variety.ts`, `engine.ts` (`orderAll` only), `local-api.ts` (`runJob` load), `shuffle-order.ts`, `util.ts` (`stepQueue`), `mood-queue.ts` (candidate type only; the plan change is WP6), tests.
- **Change**:
  1. `artist-variety.ts`: `tooClose(recentArtists, artist, gap)` and `spreadInsert(order, item, artistOf, rand)` (a random slot whose neighbours are other artists; any slot when there is none).
  2. `runJob`: make the code match its comment. The artist load is songs waiting **plus** the last 10 listens. Keep the never-dry escape: if the batch would come back with fewer than 5 songs, run the selection again without the recent listens.
  3. `arrangeShuffle`: the kept-order branch inserts with `spreadInsert`; the function takes `recentArtists` and never lets the first song to come make a fifth in a row, so under `inOrder` `stepQueue`'s `breakRun` has nothing left to change. Add a test that the row after the song playing is always the song `stepQueue` returns.
  4. `orderAll`: skip a row whose primary artist is one of the last two picked while another artist is available.
- **Tests**: WP0 targets for S3 and S4; never-dry escape.

### WP5 — Shuffle that leans on the mood and keeps listening to it (S1, S2, S8) (P1). After WP4. Needs decision D3.

- **Files**: `web/src/engine/mood-shuffle.ts`, `shuffle-order.ts`, `App.tsx` (shuffle effect, mood effect), tests.
- **Change**:
  1. `moodShufflePick`: `k = confidence × ln(R(a))`, with `R` from a small table (default: Familiar 8, middle 4, Adventurous 2; linear between). Fits stay 0..1, so no two songs differ in weight by more than R.
  2. Re-deal the tail: when a mood answer follows an **active** signal (star, dislike, Find similar), keep the song playing and the next two songs, and redraw the rest of the unheard order with the new fits. Skip the re-deal when the mean absolute change in fit over the tail is under 0.15. A finished song alone never re-deals.
  3. If the first order of a session was drawn before any mood answer, allow one tail re-deal when the first answer arrives.
  4. Keep the order across a restart: store `{order, epoch, seed}` under `airwave.shuffle-order`; restore it when at least 60% of its keys are still in the queue.
  5. Draw from a seeded generator (seed stored with the order), so an order can be reproduced from a bug report.
- **Tests**: WP0 shuffle targets with a seeded source; once-per-round and committed-next tests unchanged.

### WP6 — Mood that follows without locking in (M1, M2, M5) (P1). After WP4. Needs decisions D2 and D4.

- **Files**: `web/src/engine/mood-queue.ts`, `local-api.ts` (`mood`, `moodSignals`), `App.tsx` (mood effect: send each row's `score`, the song's seconds heard, and a re-nudge at 45 s), `api.ts` types, `Settings.tsx` (one rollback switch), tests.
- **Change**:
  1. **Ramp the song playing**: `current` weight = `1 + 2 × min(1, heard / 45)`. At second 0 it is 1 (confidence 0.17), at 45 s it is 3 as today.
  2. **Active and passive evidence**: active = star, Find similar, replay; passive = finished, playing. `confidence = min(1, (active + 0.5 × passive) / 6)`. A finished song whose key the mood moved in the last plan counts 1 instead of 2 (keep the last 64 moved keys in `LocalApi`).
  3. **Base term from the engine's score, not the list place**: the page sends `score` per row; `b` is the row's score percentile in the list. The row's current place is used only for the hysteresis comparison.
  4. **Variety share**: of the 12 planned places, `round(12 × ε)` keep the engine's best-scored rows whatever their fit (never one whose dislike match is ≥ 0.5), spread from place 4 onward. `ε = base(a) × (1 − 0.75 × activeShare)`, `base` = 0.10 Familiar, 0.20 middle, 0.35 Adventurous; `activeShare` is the active part of the positive weight. With starred songs the queue holds the mood tightly; with only passive listening it leans.
  5. **Artist spacing** in the plan with WP4's helper (gap 3); add `artist` to `MoodCandidate`.
  6. **Dislike without sound**: when neither side has a vector, the dislike match is the tag match × 0.5.
  7. Setting `mood_plan: 'v2' | 'v1'`, default `v2`, so the old order is one switch away.
- **Tests**: WP0 mood targets; the starred rap + electronic case must still give 0 off-mood songs in the next 6.

### WP7 — Android parity (S6, S7) (P2). After WP4 and WP5.

- **Files**: `android/app/src/main/java/com/nowplaying/discovery/engine/PlayQueue.kt`, `EnginePlayer.kt`, `MediaHub.kt`, `PlayQueueTest.kt`, one shared fixture file.
- **Change**:
  1. When the page marks the list as the now playing queue under shuffle (`once`), `PlayQueue` plays the unheard songs in the list's order and does not draw its own. Saved lists keep the native shuffle.
  2. Songs the engine appends on its own (`appendFound`) go in with the spacing rule.
  3. `artistKey` uses the same split as `identity.ts:28`. Add `web/src/engine/golden/artist-credits.json` (about 30 credits and their expected first artist) and read it from both a vitest and a JVM test.
  4. `previous()` records the play for the run count.
- **Tests**: JVM unit tests; `./gradlew testDebugUnitTest --tests "*PlayQueueTest*"`.

### WP8 — Candidate mix (A6, A7) (P1). Independent.

- **Files**: `web/src/engine/pipeline.ts`, `local-api.ts`, tests.
- **Change**: measure first: a gather test with fakes that return 40 rows per source, asserting how many rows of each source survive `mergedCap`. Then: cut to `mergedCap` round-robin across sources instead of by task order; cap `search_match` at 10 per seed and drop rows `matchRecordings` calls the same recording as the seed; in a manual run, drop songs heard inside the rest window of decision D1.
- **Done when**: with every source full, each relatedness and taste source keeps at least 10 rows after the cut.

### WP9 — Decision log and a local evaluator (upgrade). Independent.

The docs say several times that there is no listening data to tell whether a ranking change is better. This closes that gap without sending anything anywhere.

- **Change**: on each impression and each ending, append one compact local row: key, place, tier, score, the factor values, mood fit, shuffle on/off, source family, outcome (`complete`, `partial`, `skip`, `like`, `dislike`). Keep 5,000 rows. Add `web/scripts/eval.mjs` that reads an export and prints: skip and completion rate by place and by tier, artist concentration, genre spread, share of new artists, and a replay that re-scores logged candidates under a second weight set.
- **Done when**: Settings → Export includes the log and the script runs on it.

### WP10 — Upgrades that build on the repairs. After WP2, WP6.

1. **Bench refill**: when the queue is at the low-water mark and a top-up cannot run (offline, allowance paused) or finds nothing, promote the best `bench` rows (WP2) so the queue does not go silent.
2. **Sound for the next songs**: when the preloader finishes a file for one of the next 12 songs, embed it in the background (one at a time, only while idle, same length and size limits as today). This makes the mood's sound term real for upcoming songs (M4).
3. **Mood as the short-term taste**: replace the empty session horizon (A9) with a profile built from the last 90 minutes of mood signals, so top-up batches are scored for the mood instead of only the next 12 songs being reordered. Needs the owner's agreement, because it reverses the 18 Nov choice of stable rankings.
4. **Dry fallback** (decision D1): when no unheard song is ready and nothing new can be found, play the least recently heard starred songs with a one-line note instead of stopping.

---

## 6. Owner decisions

Agents use the default when a decision is not answered, and say so in the pull request.

| ID | Question | Default | Why it is the owner's call |
|---|---|---|---|
| D1 | Is a song "heard" for the Discover shuffle forever, or does it rest and return? | Rest 30 days; starred songs 14 days. Once per round stays absolute. | `SHUFFLE-ONCE-001` asked for once-only; forever means a starred song can never come back in Discover shuffle |
| D2 | May the song playing count less until it has been heard for 45 s? | Yes (ramp 1 → 3) | `MOOD-NOW-001` says the song playing alone is enough for the queue to follow it |
| D3 | How hard may the mood pull a shuffle? | Best-to-worst weight ratio 8 / 4 / 2 (Familiar / middle / Adventurous) | Today it is effectively 22,000 / 665 / 20; section 4 shows what each value does |
| D4 | How much variety when the listener only lets songs play? | 10% / 20% / 35% of the next 12, shrinking to a quarter of that when songs are starred | `MOOD-QUEUE-001`: "don't queue up smooth jazz next" |

---

## 7. Ground rules for agents

- Work in the development repository; the paths here match its `discovery-demo/` folder.
- One package per branch and pull request. Do not start a later package in the same change.
- Do not change `select`, `scoreOne`'s v1 path, `buildFeedback` (v1) or the golden fixtures. `engine.golden.test.ts` must pass unchanged.
- Leave `server/` (Python) alone.
- Keep the owner's rule ids in comments (`SHUFFLE-ONCE-001`, `ARTIST-RUN-001`, `MOOD-QUEUE-001`, …). A change that alters one of those rules names it and the decision (D1–D4) it rests on.
- No new network sources, no telemetry leaving the device.
- Tests: write the failing test first (or flip the WP0 `it.fails`), then the fix. Run the changed file's tests while working and the full suite once at the end:
  - `cd discovery-demo/web` then `node ../../node_modules/vitest/vitest.mjs run --root . --dir src <file>`
  - `node ../../node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`
  - Kotlin: `cd discovery-demo/android` then `./gradlew testDebugUnitTest` (`.\gradlew.bat` on Windows)
- Not verified by this diagnosis, so verify on a device before release: Android Auto with the phone app closed (S6), and the Windows shell.

Suggested releases: **0.20.18** = WP0–WP3; **0.21.0** = WP4–WP7; **0.22.0** = WP8–WP10.

---

## 8. Reproducing the measurements

1. Copy `diag/rerank.diag.test.ts`, `diag/shuffle-mood.diag.test.ts` and `diag/targets.diag.test.ts` into `discovery-demo/web/src/__diag__/`.
2. From `discovery-demo/web`: `node ../../node_modules/vitest/vitest.mjs run --root . --dir src src/__diag__/<file>`.
3. Each file writes a JSON report to `/home/claude/` (change the `writeFileSync` path in each file). The numbers in sections 3 and 4 are those reports at tag `v0.20.17` with the seeds in the files.

Not measured here: real provider answers (the candidate mix in A6 is from reading the code), audio vectors (no model in the sandbox, so every mood measurement is tags only), and anything on a device.
