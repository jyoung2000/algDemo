# Repository review — seven reference projects

Reviewed 2026-11-01 at pinned shallow-clone commits listed below. Implementation paths and limitations are transcribed from the two detailed reviews; no code was copied into algDemo. These are research notes, not evidence of installing or running each upstream project.

1|# Review: TuneLog (3 repos) + BeatFinder — recommendation-engine ideas
2|
3|**Review date:** 2026-11-01
4|**Reviewer context:** evaluating for a local-first, deterministic, single-user TypeScript music discovery engine (no server required; source ships publicly under an AGPL-style model).
5|**Method:** implementation files read directly (not READMEs); all claims cite `path:line` in the local clones at `D:/MusicRecommendationLab/repos/`. All four clones are shallow (`.git/shallow` present), so commit hashes below are tip-of-default-branch at clone time.
6|
7|---
8|
9|## 1. Repo relationship: which TuneLog is canonical
10|
11|| Repo | URL | Commit | Last commit | Role |
12||---|---|---|---|---|
13|| tunelog | github.com/adiiverma40/tunelog | `108cd54` | 2026-08-26 | **Docs/deploy shell only.** `git ls-files` shows no source code: only README, LICENSE, ARCHITECTURE/*.md, Screenshots/, docker-compose yamls, `data/genre.json`. README:13-19 states migration from mono-repo to poly-repo. |
14|| tunelog-backend | github.com/adiiverma40/tunelog-backend | `438266b` | 2026-08-29 (v1.3.0) | **Canonical.** All algorithms live here (Python/FastAPI/SQLite). |
15|| tunelog-frontend | github.com/adiiverma40/tunelog-frontend | `94ccb80` | 2026-08-29 (v1.2.0) | React+TS dashboard; pure API client. `src/API/discovery.ts:12` just POSTs `/generateDiscoveryQueue` to the backend. No recommendation logic client-side. |
16|
17|**Licenses:** all three TuneLog repos ship an MIT LICENSE file (`LICENSE:1-3`, "MIT License, Copyright (c) 2026 Aditya Verma"). MIT is compatible with redistribution inside a public-source app: adaptation requires only preserving the copyright/permission notice. No copyleft obligations.
18|
19|tunelog/README.md:5-10 honestly discloses AI assistance ("AI were used in some sql Query", playlist page rewritten with Claude). Treat SQL correctness with extra suspicion (see bugs below — justified).
20|
21|---
22|
23|## 2. TuneLog backend — event collection → scoring → playlists
24|
25|### 2.1 Event collection (watcher)
26|
27|Navidrome is polled/SSE-watched (`navidrome/watcher.py:20-86` subscribes to `/api/events`; `nowPlayingCount` events trigger a `getNowPlaying` poll at `watcher.py:150-152`).
28|
29|**Position tracking.** `PlaybackTracker` (`watcher.py:99-125`) anchors `(position_ms, monotonic_time)` on each `starting`/`playing` state and projects elapsed playtime:
30|```python
31|# watcher.py:120-125
32|def get_projected_time(self):
33|    if not self.is_playing:
34|        return self.anchor_position_ms
35|    elapsed_real_time_ms = (time.monotonic() - self.anchor_time) * 1000
36|    return self.anchor_position_ms + elapsed_real_time_ms
37|```
38|A listen is finalized when the user's now-playing song changes (`watcher.py:180-181`) or the user disappears from now-playing (`watcher.py:191-195`).
39|
40|**Partial vs completed vs skip (signal_system).** `watcher.py:289-293` computes `percent_played = min(round(played/duration*100), 100)` then classifies (`watcher.py:206-213`):
41|- `percent_played <= 30` → **skip** (`skip_threshold_pct: 30`, `navidrome/state.py:115`)
42|- `30 < percent < 80` → **partial** (`positive_threshold_pct: 80`, `state.py:116`)
43|- `>= 80` → **positive**
44|
45|**Repeat detection.** A positive is upgraded to **repeat** if a prior positive/repeat for the same song exists within `repeat_time_window_min: 30` (`state.py:117`). **BUG:** the SQL at `watcher.py:220-228` embeds `datetime('now', '-{window} minutes')` in a *non-f-string*, so SQLite receives the literal modifier `-{window} minutes`, which is invalid → `datetime()` yields NULL → the `timestamp > NULL` comparison is never true → `valid_prior_positives` is always 0 and **live repeat detection never fires**. (Repeat detection in the ListenBrainz import path is computed in Python and does work — see 2.4.)
46|
47|### 2.2 Scoring (incremental, per-listen)
48|
49|`calculate_dynamic_score` (`watcher.py:239-266`) is the core formula. Signal weights are `{"repeat": 3, "positive": 2, "partial": 0, "skip": -2}` (`state.py:104`). Given `past_listen_count` n:
50|
51|```python
52|# watcher.py:251-266
53|if base_signal_value <= 0: return base_signal_value          # skip always -2, partial always 0
54|if n <= 3:                 awarded = base * 2.0              # novelty boost, first 3 listens double
55|elif n <= 10:              awarded = base                    # flat (n_threshold=10)
56|else:                      awarded = (base - 0.1) * exp(-0.15 * (n - 10)) + 0.1   # decay to floor 0.1
57|```
58|Each new listen row stores cumulative `finalScore = score + last_score` (`watcher.py:297-299`), i.e., a song's score is a running sum over its listen history. A batch re-scorer exists for rows with NULL scores (`CORN/SongScoring.py:69-125`), replaying history in timestamp order with the same function.
59|
60|**Star rating push-back.** After each listen, `push_star` (`misc/misc.py:78-146`) recomputes a 1–5 star rating from the most recent listens using exponential recency weighting: `star_map = {skip: -2.0, partial: 0.5, positive: 2.0, repeat: 3.0}` (`misc.py:47-52`), `weightage = decay**i` with `historical_decay_factor: 0.9` (`state.py:120`), `songScore = Σ rating·0.9^i / Σ 0.9^i` (`misc.py:121-135`), then thresholds ≥2.5→5★, ≥1.5→4★, ≥0.5→3★, ≥0→2★, else 1★ (`misc.py:137-146`). Requires `min_listens_for_star: 3` (`state.py:119`, gate at `misc.py:103-104`).
61|
62|### 2.3 Skip timeout ("n skip timeout")
63|
64|`misc/timeout.py:13-33`: a song with ≥10 total listens (`len(rows) <= 9` early-return at :16) whose **most recent consecutive run** of listens are all skips, reaching `skip_count: 3` (`state.py:156`), gets a timeout row with expiry `now + 30 days` (`timeout.py:35-49`, `timeout: 30` days at `state.py:157`). Rationale documented in `tunelog/ARCHITECTURE/ALGO.md:29-34`: a high-scored song would otherwise need ~25 skips at -2 each to leave the playlist. Timed-out songs are excluded from CF playlists via `NOT IN (SELECT song_id FROM log_db.timeout WHERE user_id = '…')` (`playlists/listenbrainz_playlist.py:145-146`). **Note:** that exclusion string-interpolates `user_id` into SQL (injection risk; harmless single-user, sloppy regardless), and nothing checks the `timeout` expiry timestamp in this query — once timed out, a song appears excluded until the row is deleted elsewhere.
65|
66|### 2.4 ListenBrainz integration
67|
68|Base URL `https://api.listenbrainz.org` (`Workers/LB_Worker.py:14`), all calls through a rate-limited worker queue. Endpoints used:
69|- `GET /1/user/{lb_username}/listens` with `count` + `max_ts` pagination for full-history backfill (`scrobble/LB/history_sync.py:56-104`) and `min_ts`+`count=100` for incremental sync (`history_sync.py:132-141`).
70|- `GET /1/cf/recommendation/user/{user}/recording` with `count=1000, offset=0` → payload `{mbids:[{recording_mbid, score, latest_listened_at}], total_mbid_count, last_updated}` (`scrobble/LB/lb_cf.py:33-54`); stored in an `LB_CF` table, wiped+rewritten only when `last_updated` changes (`lb_cf.py:73-118`).
71|- `GET /1/user/{user}/similar-users` → fetches the top similar user's CF recs too (`lb_cf.py:121-126, 270-311`).
72|- `GET /1/validate-token` for token→username resolution (`lb_master.py:42-53`).
73|- `POST /1/feedback/recording-feedback` with payload `{"recording_mbid": …, "score": 1}` to push local starred songs as LB "loves" (`CORN/pushHeartLB.py:126-140`).
74|
75|**Import normalization.** Imported listens get a configurable default signal (`treat_data_as: "partial"` default, `state.py:147`; "complete"→"positive" mapping at `history_sync.py:188-189`), synthetic percent via `percent_map = {skip: 15, partial: 55, positive: 100}` (`history_sync.py:193`). Dedup: a listen within 30 min of an existing row for the same song is dropped (`history_sync.py:191, 244-247`). Repeat upgrade computed in Python: if gap to previous play ≤ `repeat_time_window_min*60`, signal becomes repeat at 100% (`history_sync.py:269-278`).
76|
77|**Local matching of LB metadata → library IDs** (`scrobble/LB/local_matching.py`): 3-stage fallback with rapidfuzz `token_set_ratio` — stage 1 exact artist/album/title index then fuzzy title ≥85 (`local_matching.py:106-119`); stage 2 fuzzy artist ≥80 then title ≥85 (`:154-169`); stage 3 global fuzzy title ≥85 + artist ≥80 confirmation (`:231-240`). MusicBrainz recording MBIDs are hydrated into a `hydration_cache` with PENDING/FAILED/retry states (`lb_cf.py:343-562`).
78|
79|### 2.5 Playlist generation
80|
81|**Blend playlist** (`playlists/blend_playlist.py`, orchestrated at `:687+`):
82|1. Score each song from its last 20 listens, oldest→newest, `weight×2` for the first 3 listens (`score_song`, `blend_playlist.py:93-141`); DB score overrides if present (`:139-141`). A `dominant_signal` = signal with largest positive contribution (`:143-154`).
83|2. Budget split `injection_breakdown = {signal: 0.57, unheard: 0.35, wildcard: 0.08}` (`state.py:111`), signal budget further split by `slot_ratios = {positive: .35, repeat: .35, partial: .25, skip: .05}` (`state.py:105-110`).
84|3. `fill_slots` keeps the top-K per signal bucket with a min-heap (`blend_playlist.py:162-217`); negative-score songs excluded (`:172`).
85|4. **Wildcards**: songs not played for ≥ `wildcard_day: 60` days with positive score (`:302-319`), sampled score-proportionally via `weighted_sample` (`:322-341`).
86|5. **Unheard injection, genre-proportional**: user's historical genre distribution (`base_playlist.py:33-57`) sets `target_counts[cat] = max(1, round(count/total * slots))` (`blend_playlist.py:498-505`); unheard songs fill those genre quotas (`fill_genre_slots`, `:220-255` — note it deliberately seeds 2 "unknown-genre" songs at `:243-244`), remainder filled by top-artist match (`fill_artist_slots`, `:258-278`).
87|6. Backfills: score-ordered heard songs with `score>=0 and signal != 'skip'` (`:560-572`), then random unheard (`:594-600`).
88|
89|**Discovery playlist** (`playlists/discovery_playlist.py`): candidate pool = library songs with **zero** listen rows for the user, within a `created`-date window (`NOT EXISTS` anti-join, `:105-121`), with a backtrack widening query when the pool is short (`:138-162`); selection again genre-proportional with non-genre and random fallbacks (`:189-255`).
90|
91|**Tiered playlists** (`playlists/tier_playlist.py`): dedupe to latest listen per song via `ROW_NUMBER() OVER (PARTITION BY song_id ORDER BY timestamp DESC)`, keep `score >= 0`, order by score desc (`:14-33`), then chunk into fixed-size tiers (`:40-58`) pushed as "Tunelog - Tier N" playlists. **Docs/code mismatch:** `tunelog/ARCHITECTURE/ALGO.md:62-70` describes a score-cursor handoff between tiers and "bottoming out at -1"; the code is a plain chunk-by-100 with a `score >= 0` filter — simpler than documented. Debug `print(rows)` left in (`tier_playlist.py:34-35, 65`).
92|
93|**LB CF playlist** (`playlists/listenbrainz_playlist.py:170-359`): splits CF candidates into heard (`latest_listened_at` set) vs unheard (`:206-207`), applies a **descending score cursor** so successive generations walk down the CF ranking (`apply_score_cursor`, `:215-221`; new cursor = min used score, `:338-348`; wraps to top when a bucket runs dry, `:232-252`), optional genre-proportional filtering (`filter_pool_by_genre`, `:77-117`), fixed heard/unheard quotas (default 25/25 of 50, `state.py:168-171`), then unheard backfill and local-blend fallback (`:312-336`).
94|
95|### 2.6 Honest defects list (tunelog-backend)
96|
97|- **Broken live repeat detection** — non-f-string SQL, `watcher.py:225` (detailed in 2.1).
98|- SQL built by string interpolation with user_id (`listenbrainz_playlist.py:146`) and attached DB paths (`discovery_playlist.py:95`).
99|- Timeout expiry never checked at query time (2.3).
100|- Tier "cursor" documented but not implemented (2.5).
101|- `CORN/SongScoring.py:6` imports `trunc` from `numpy._core.umath` (private API) and never uses it; function named `songScoringCorn_IDK_WHAT_TO_NAME_THE_FUNCTION` (`:69`) — hobby-grade hygiene throughout ("CORN" = cron).
102|- Heavy console-printing inside scoring loops; everything synchronous SQLite with retry-on-locked loops (`lb_master.py:56-69`).
103|
104|### 2.7 Verdict: **ADAPT (ideas only, reimplement)**
105|
106|The architecture (signals → incremental score → slot-based playlist assembly) maps cleanly onto a deterministic TS engine, and MIT permits anything. But the code itself is multi-user server Python tied to Navidrome's SSE/now-playing API, with at least one show-stopper bug in the hot path; port the *formulas and thresholds*, not the code. Specifically worth adapting:
107|- The 4-signal classification (skip ≤30%, partial, positive ≥80%, repeat-within-30-min) — trivially computable from local play events.
108|- `calculate_dynamic_score`'s three-phase curve (2× novelty boost for listens 1–3, flat to 10, exponential decay `(w−0.1)·e^(−0.15·k)+0.1`) — a good anti-saturation design preventing play-count monopolies.
109|- Consecutive-skip timeout (3 consecutive skips + ≥10 listens → 30-day exclusion) — cheap, effective negative feedback.
110|- Recency-weighted star score (`Σ r·0.9^i / Σ 0.9^i` + thresholds) for a 1–5 "affinity" readout.
111|- Slot-ratio playlist assembly + genre-proportional unheard injection + ≥60-day wildcard resurfacing — directly portable; all deterministic except the random sampling (replace with seeded PRNG).
112|- LB CF **score-cursor pagination** (walk down CF ranking across regenerations, wrap on dry) — a neat idea even against a different rec source.
113|- ListenBrainz endpoints/payloads (2.4) documented here are usable as-is from TS if LB sync is wanted; the 30-min dedup window and `treat_data_as` defaulting are sane import policies.
114|
115|Reject: the DB-accumulating cumulative score column (replay-from-history is cleaner in a local-first store), the multi-DB ATTACH gymnastics, and all the Navidrome-specific transport.
116|
117|---
118|
119|## 3. BeatFinder — artist discovery from Apple Music history
120|
121|**URL:** github.com/sammcj/beatfinder · **Commit:** `4257b31` (2025-11-04) · **License: MIT per README.md:444-446 ("## Licence / MIT") — but no LICENSE file exists in the repo** (`ls` shows none). For a publicly-shipped adaptation, either obtain/await a proper LICENSE file or treat the README declaration as the grant (it is an explicit statement by the author; low practical risk, worth noting in a NOTICE).
122|
123|Single-user local CLI, ~2,800 LOC Python. Pipeline (verified, matches README:431-442): parse library → classify artists → Last.fm similar-artist expansion → score → filter → interactive review → markdown/HTML output → optional Apple Music playlist.
124|
125|### 3.1 History import formats
126|
127|Two parsers, same output shape (per-artist dict of `play_count, loved, disliked, rating, track_count, last_played, skip_count, …`):
128|1. **iTunes/Music `Library.xml`** (plist) — `library_parser.py:80-119`: per-track `Play Count`, `Rating` (0–100), `Loved`, `Disliked`, `Play Date UTC` aggregated by artist.
129|2. **Apple privacy export** (privacy.apple.com) — `apple_export_parser.py:57-60` requires `Apple Music - Favorites.csv` + `Apple Music - Play History Daily Tracks.csv`. Play History columns consumed: `Track Description` ("Artist - Song", artist split on `' - '`/`': '` at `:107-132`), `Date Played` (%Y%m%d), `Play Count`, `Skip Count`, `Play Duration Milliseconds` (`:235-240`). Favorites CSV supplies explicit liked/disliked via `Preference` on `Favorite Type == 'Song'` rows (`:170-180`). Caching: JSON for stats, pickle for parsed frames, 7-day expiry (`config.py:35-36`).
130|
131|**BUG (export path):** `total_media_duration_ms` is initialized to 0 (`apple_export_parser.py:316`) and **never populated** — no code reads a media-duration column — so `completion_rate` is always 0.0 (`:366-369`) and the inferred engagement rating `completion_rate × (1 − skip_count/play_count)` (`:371-376`) is **always 0** for export-based libraries. The `LOVED_MIN_TRACK_RATING` path (`recommendation_engine.py:297`) is therefore dead code on the export path; "loved" classification silently degrades to explicit-favorite OR ≥50 plays only.
132|
133|### 3.2 Artist classification (thresholds in `config.py:25-32`)
134|
135|- **Known** (excluded from recs): `play_count ≥ 3` OR `track_count ≥ 5` (`recommendation_engine.py:220-225`).
136|- **Loved** (taste seeds): explicit loved, OR `play_count ≥ 50`, OR `rating ≥ 4★×20 AND play_count ≥ 10` (`:285-298`); optional recency filter `LAST_MONTHS_FILTER` using `last_played` (`:282-283, 301-303`).
137|- **Disliked** (excluded both as seed and rec): `disliked_track_count ≥ 2 AND loved_track_count == 0` (`:226-231, 289-291`).
138|
139|### 3.3 Discovery flow and frequency weighting
140|
141|For each loved artist, fetch Last.fm `artist.getSimilar` (20 per seed, concurrent, rate-limited; client at `recommendation_engine.py:68-214`). Candidate filtering (`:415-434`): drop if normalized name ∈ known; drop **collaboration names containing a known artist** — splits on `' & '`, `', '`, `' feat. '`, `' ft. '`, `' featuring '` and checks each part (`_contains_known_artist`, `:241-275`) — a genuinely clever dedup most engines miss; drop disliked; re-check raw-name thresholds.
142|
143|Scoring (`:467-500`):
144|- `frequency_score = len(recommended_by)` (# of seeds that surfaced this candidate) — or, with `ENABLE_PLAY_FREQUENCY_WEIGHTING`, mean seed play count / 100 (`:471-473`).
145|- `avg_match` = mean Last.fm similarity (`:475`).
146|- **Novelty/rarity:** `rarity_score = 1/(1 + listeners/1_000_000)` (`:477-478`) from Last.fm global listener count.
147|- Default mode blends with a **single user-facing "rarity preference" knob 1–15** mapped linearly to weights (`:492-500`):
148|  ```
149|  rarity_weight    = 0.1 + (pref-1)·0.4/14      # 0.1 → 0.5
150|  frequency_weight = 0.5 − (pref-1)·0.15/14     # 0.5 → 0.35
151|  match_weight     = 1 − rarity_weight − frequency_weight
152|  score = frequency·fw + avg_match·mw + rarity·rw
153|  ```
154|- Advanced mode adds **tag-profile similarity**: profile = play-count-weighted tag histogram over loved artists, normalized (`build_tag_profile`, `:308-360`, ignore-list filtered); candidate similarity = mean profile weight of its tags (`:362-376`); fixed weights `0.3/0.3/0.2/0.2` freq/tag/match/rarity (`config.py:76-79`, `:484-490`).
155|- Scores are recomputed after fetching exact listener counts for the top 100 (`:517-540`) — honest two-pass refinement.
156|
157|### 3.4 Novelty handling & known-artist filtering (summary)
158|
159|Novelty = rarity term above + hard exclusion of known/disliked/collab-with-known + **persistent rejected-artist memory**: `interactive_filter.py:20-63` stores rejections in `data/rejected_artists.json` (survives cache clears), filters future runs case-insensitively; interactive checkbox TUI pre-selects all and permanently rejects deselected (`:66-136`). Tag blacklist hard-filters candidates (`recommendation_engine.py:451-465`). Recommendations cache is invalidated when the rarity knob changes (`:561-580`).
160|
161|### 3.5 Verdict: **ADAPT (direct port of the scoring core)**
162|
163|This is the closest match to the target engine: single-user, local-first, batch, deterministic given fixed API snapshots (the only nondeterminism is upstream Last.fm data). The entire scoring core (3.2–3.4) is ~300 lines of dependency-free arithmetic that ports to TypeScript almost mechanically. Adopt: classification thresholds, frequency-of-recommendation voting, `1/(1+listeners/1M)` rarity, the 1–15 rarity-knob weight interpolation, collaboration-name filtering, persistent rejected-artists file, tag-profile similarity. Adapt: swap Last.fm for ListenBrainz/MusicBrainz equivalents if avoiding API keys (LB has `similar-artists` via labs API); fix the completion-rate bug if reusing the export parser concept. Reject: Apple-export CSV specifics (unless importing Apple history is in scope), the pickle caches, and the AppleScript/web-API playlist pushers (`apple_music_integration.py`, `apple_music_web_api.py` — macOS-only).
164|
165|---
166|
167|## 4. Cross-cutting recommendation for the TS engine
168|
169|Combine the two: TuneLog supplies the **event→signal→score** layer (track-level, behavioral, incremental) and BeatFinder supplies the **artist-discovery** layer (library→seeds→similar-artist expansion→rarity-blended ranking). Both are MIT (BeatFinder: README-declared, no LICENSE file — add attribution in a NOTICE either way), so adaptation into a public-source app carries only attribution obligations, compatible with the app's AGPL-style distribution. Port formulas with cited constants into pure functions; replace every `random.shuffle/choices` with a seeded PRNG to keep the engine deterministic; keep all state in one local store (SQLite/JSON) instead of TuneLog's five attached databases.

---

1|# Review: ListenBrainz Server, Troi, and implicit
2|
3|**Review date:** 2026-11-01
4|**Reviewer context:** evaluating for a local-first, single-user TypeScript music discovery engine.
5|**Method:** read implementation files in local clones at `D:/MusicRecommendationLab/repos/`. All claims cite `path:line` in the pinned commit.
6|
7|| Repo | URL | Commit | License (read from LICENSE file) |
8||---|---|---|---|
9|| listenbrainz-server | https://github.com/metabrainz/listenbrainz-server | `8e1ed89` | GPL-2.0 ("GNU GENERAL PUBLIC LICENSE Version 2, June 1991", `LICENSE:1-2`) |
10|| troi-recommendation-playground | https://github.com/metabrainz/troi-recommendation-playground | `044398b` | GPL-2.0 (`LICENSE:1-2`; also declared `pyproject.toml:11`) |
11|| implicit | https://github.com/benfred/implicit | `8a95dbe` | MIT, © 2016 Ben Frederickson (`LICENSE:1-3`) |
12|
13|---
14|
15|## 1. listenbrainz-server (metabrainz)
16|
17|A huge Flask + TimescaleDB + Spark monolith. Only the recommendation/similarity logic and the public REST API matter for a client app. Verified behaviors below.
18|
19|### 1.1 Listen ingestion & dedup
20|
21|- **Dedup key is `(listened_at, user_id, recording_msid)`** enforced at insert time with `ON CONFLICT ... DO NOTHING`:
22|  - Timescale store: `listenbrainz/listenstore/timescale_listenstore.py:183-188`
23|  - Listens DB copy: `listenbrainz/db/listens.py:24-25`
24|  - Write order is deliberate: Timescale first, listens DB second, so a retry after a partial failure still reports new rows (`timescale_listenstore.py:180-182` comment).
25|- **Takeaway:** dedup is purely *(timestamp, user, track-identity)* — no fuzzy time-window dedup. Two listens of the same song 1 second apart are both kept. Simple, deterministic, idempotent re-import.
26|
27|### 1.2 Identity: MSID (MessyBrainz) → MBID mapping
28|
29|Two-layer identity, which is the single most reusable design in the repo:
30|
31|1. **MSID (messy ID)** — a stable UUID assigned to the raw submitted metadata tuple. Lookup key is case-insensitive `(title, artist, release, track_number, duration)` (`listenbrainz/messybrainz/__init__.py:98-110`); existing match is found with a bulk `lower(...) IS NOT DISTINCT FROM lower(...)` join keeping the earliest submission (`messybrainz/__init__.py:126-139`); otherwise a new `uuid4` is minted (`messybrainz/__init__.py:73-83`). In-batch duplicates are collapsed before the DB round-trip (`:58-66`).
32|2. **MSID → MBID mapping** — an async worker matches MSIDs to MusicBrainz recording MBIDs: exact Postgres lookup first, then fuzzy (`listenbrainz/mbid_mapping_writer/matcher.py:107-115`). Unmatched rows get a "no match" marker and a `check_again` timestamp so they are *rechecked ~2 weeks later* instead of re-queried on every listen (`matcher.py:19-35`); `last_updated = '1970-01-01'` is the manual "recheck me" sentinel (`matcher.py:32`).
33|
34|**Takeaway:** raw listens are immutable and keyed by messy metadata; canonical identity is a separate, retryable, improvable mapping layer. This cleanly survives metadata edits and mapping-algorithm upgrades.
35|
36|### 1.3 Collaborative filtering recommendations (offline Spark batch, NOT online)
37|
38|All CF runs as offline Spark jobs under `listenbrainz_spark/`, triggered via RabbitMQ requests (`listenbrainz/spark/request_manage.py`), results written back to Postgres. Nothing is computed per-request.
39|
40|- **Input matrix:** per-user playcounts per recording, users below a minimum listen-count threshold dropped (`listenbrainz_spark/recommendations/recording/create_dataframes.py:199-205`, CLI default threshold 0, `request_manage.py:268`).
41|- **Confidence transform** (the interesting part) — raw playcounts are compressed before ALS (`create_dataframes.py:83-89` and SQL at `:172-182`):
42|  ```
43|  ZERO_POINT = 30, MAX_PLAYCOUNT = 20, ONE_PLAYCOUNT_CONFIDENCE = 30 - 20/2 = 20
44|  transformed = CASE WHEN playcount = 0 THEN 0
45|                     WHEN playcount = 1 THEN 20
46|                     ELSE 30 + LEAST(playcount, 20) END
47|  ```
48|  i.e. a single listen already earns confidence 20, and everything above 20 plays is capped at 50. This flattens heavy-rotation bias — directly portable to any scoring function.
49|- **Model:** Spark ML ALS with `implicitPrefs=True`, `coldStartStrategy="drop"` (`listenbrainz_spark/recommendations/recording/train_models.py:154-160`), grid-searched via CrossValidator (`:162-178`) over defaults **rank ∈ {100,120}, λ ∈ {0.1, 10.0}, α = 3.0, iterations ∈ {5,10}** (`listenbrainz/spark/request_manage.py:296-299`), best model picked by RMSE.
50|- **Serving:** `model.transform(candidate_set)` then top-`limit` per user by predicted score (`recommendations/recording/recommend.py:82-108`), left-joined with a `recording_discovery` table that records `max(listened_at)` per (user, recording) (`recommendations/recording/discovery.py:17-25`) so clients can filter "already heard" — this powers "exploration vs. jams" playlist splits.
51|
52|### 1.4 Similar users
53|
54|Pure cosine similarity over the user-recording playcount matrix: build a CoordinateMatrix of (recording_id, user_id, playcount), convert to RowMatrix, call Spark's `columnSimilarities()` (`listenbrainz_spark/similarity/user.py:102-114`), keep top-N per user (`:83-86`), symmetrize pairs (`:70-81`). Result lands in Postgres and is served by `db_user.get_similar_users` (`listenbrainz/db/user.py:429`).
55|
56|### 1.5 Similar recordings — session-based co-occurrence (NOT ALS)
57|
58|The recording-similarity dataset (what powers LB Radio and similar-track browsing) is **not** matrix factorization. It is a windowed co-listening count, all in one SQL template (`listenbrainz_spark/similarity/recording/common.py:75-132`):
59|
60|1. Order a user's listens; compute gap = `listened_at - LAG(listened_at) - LAG(duration)` (`:90`, default track length 180s when unknown, `:17,79`).
61|2. New session when gap > `session` seconds (`:98`); a listen is "skipped" when the *next* gap < `-skip_threshold` (`:99`), and skipped listens are excluded (`:104-110`).
62|3. Count pairs of distinct recordings co-occurring in the same user session, **excluding same-artist pairs** via `NOT arrays_overlap(artist_credit_mbids)` (`:111-121`).
63|4. Cap each user's contribution per pair: `SUM(LEAST(part_score, max_contribution))` (`:128`).
64|5. Combine chunks, keep pairs with `total_score > threshold`, rank per seed, keep top `limit` (`common.py:143-172`).
65|
66|**Production parameters** (`listenbrainz/spark/request_manage.py:577-578`): `days=7500, session=300s, max_contribution=5, threshold=10, limit=100, skip_threshold=30s`. The same abstract base runs over either regular listens or the MLHD+ dataset (`similarity/recording/__init__.py:5-11`, `listens.py:10-34`).
67|
68|**Takeaway:** this is the most adoptable algorithm in the whole review — it needs only one user's (or a community dump's) ordered listen history, no ratings, no factorization, and it encodes skip-detection and anti-same-artist diversity for free.
69|
70|### 1.6 Public REST API usable by a client without running the server
71|
72|All blueprints mount under `API_PREFIX = '/1'` (`listenbrainz/webserver/__init__.py:22`, registrations `:478,496,502,526`). Verified endpoints:
73|
74|| Endpoint | Code | Notes |
75||---|---|---|
76|| `GET /1/user/<user_name>/similar-users` | `listenbrainz/webserver/views/api.py:316` | `{user_name, similarity}` list |
77|| `GET /1/user/<user_name>/similar-to/<other_user>` | `api.py:352` | single similarity score |
78|| `GET /1/cf/recommendation/user/<user_name>/recording` | `views/recommendations_cf_recording_api.py:21`, prefix `/1/cf/recommendation` from `webserver/__init__.py:496` | ALS recs: `{recording_mbid, score, latest_listened_at}`, `artist_type=raw` only (`recommendations_cf_recording_api.py:17-19`) |
79|| `GET /1/explore/lb-radio?prompt=...&mode=easy|medium|hard` | `views/explore_api.py:159-213` | runs Troi's LBRadioPatch server-side, returns JSPF; **requires a user token** (`explore_api.py:184`) and is rate-limited per token (`:186-189`) |
80|| `GET /1/lb-radio/tags` | `api.py:819` | tag → recordings with popularity windows |
81|| `GET /1/lb-radio/artist/<seed_artist_mbid>` | `api.py:899` | similar-artist radio candidates with `total_listen_count` |
82|| `GET /1/user/<user>/playlists/createdfor` | `api.py:651` | server-generated playlists (daily/weekly jams), public, no auth |
83|| `GET /1/user/<user>/listens`, `/listen-count`, `/playing-now` | `api.py:166,200,230` | history read-back |
84|| `POST /1/submit-listens` | `api.py:54` | if you ever want to sync local history up |
85|
86|Plus the separate **labs API** (`https://labs.api.listenbrainz.org`): similar-recordings viewer (`listenbrainz/labs_api/labs/api/similar_recordings/base.py:49-74`, algorithm names are keys of the dataset metadata) and `bulk-tag-lookup` (consumed by Troi at `troi/content_resolver/metadata_lookup.py:71`).
87|
88|### 1.7 Limitations
89|
90|- Everything CF-related assumes a multi-thousand-user Spark cluster + HDFS; zero of the batch pipeline is runnable locally in a reasonable way (per repo guidance, not attempted).
91|- `similar-users` / CF recs only exist for users registered on listenbrainz.org with enough history; data freshness is batch-cadence (recs payload carries `last_updated`).
92|- `/1/explore/lb-radio` is explicitly an expensive, token-gated endpoint — not suitable as a high-frequency client dependency.
93|- GPL-2.0: see §4.
94|
95|### 1.8 Decision: **ADAPT (ideas + API), REJECT (code)**
96|
97|- Reimplement in TS: the session-based co-occurrence similarity (§1.5 formulas/thresholds), the playcount→confidence transform (§1.3), the MSID/MBID two-layer identity and the `(timestamp,user,track)` dedup key, and the `recording_discovery.latest_listened_at` join for "new to you" filtering.
98|- Consume as remote service: `/1/lb-radio/*`, labs similar-recordings, `createdfor` playlists, and (if the user links an LB account) `/1/cf/recommendation/.../recording` — this is exactly how a client gets global CF without running anything.
99|- Do not vendor code: Python/Spark, GPL-2.0, and server-shaped.
100|
101|---
102|
103|## 2. troi-recommendation-playground (metabrainz)
104|
105|Troi is the playlist-pipeline engine that LB runs server-side for radio/jams, but it is also a standalone CLI with a genuinely local mode.
106|
107|### 2.1 Pipeline architecture — Patch chains Elements
108|
109|- **Element** is the node abstraction: `troi/__init__.py:20-158`. Each element has `sources` (`set_sources`, `:46-56`), declares `inputs()`/`outputs()` entity types which are **type-checked at wiring time** (`:59-68`) and again at runtime against actual output (`:97-101`). `generate()` is a recursive pull: it runs all sources, passes their lists into this element's `read(source_lists)` (`:82-115`). An element returning `None` aborts the whole pipeline (`:94-95`).
110|- **Patch** builds a pipeline in `create(inputs)` and owns shared `local_storage` plus a **service registry** (`troi/patch.py:26-110`): e.g. `RecordingSearchByTagService` resolves against `https://api.listenbrainz.org/1/lb-radio/tags` (`troi/recording_search_service.py:30`) but a patch can swap in `LocalRecordingSearchByTagService` backed by SQLite (`troi/content_resolver/lb_radio.py:32-33`) — same slug, different backend. `is_local()` (`patch.py:112-117`) tells the runner to open the local DB first.
111|- Example chain (`troi/patches/periodic_jams.py:99+` and local variant `periodic_jams_local.py:52-84`): LB recs → recent-listens timestamp lookup → `LatestListenedAtFilterElement(60 days)` → hate-feedback filter → MB metadata lookup → (local only) `RecordingResolverElement(0.8)` → `PlaylistMakerElement(max 50 tracks, max_artist_occurrence=2, shuffle)`.
112|
113|### 2.2 Server dependencies vs. standalone
114|
115|- **Needs MetaBrainz servers:** every `troi/listenbrainz/*` element — recs (`troi/listenbrainz/recs.py:48` via `liblistenbrainz`, paginated 100/call, max 1000, `recs.py:10,22`), listens (`listens.py:48`), feedback (`feedback.py:47`); playlist upload (`troi/playlist.py:21-23`); tag/artist radio search (`recording_search_service.py:30,62`); MB artist lookups (`patches/lb_radio.py:88,110`); tag metadata via labs `bulk-tag-lookup` (`content_resolver/metadata_lookup.py:71`). The old datasethoster client is parked in `troi/listenbrainz/unused/dataset_fetcher.py`.
116|- **Runs fully client-side:** the **content resolver** subsystem — SQLite via peewee (`content_resolver/model/database.py:1-8`), scans local music dirs reading FLAC/MP3/M4A/Ogg/WMA tags (`content_resolver/database.py:145`, `content_resolver/formats/`), can also index a Subsonic server (`content_resolver/subsonic.py`).
117|- **Hybrid (the interesting mode):** `periodic-jams-local` and `ListenBrainzRadioLocal` fetch global candidates from LB API but resolve them to *your local files* and never upload.
118|
119|### 2.3 Local content resolution (global recs → local library)
120|
121|Three-stage matching worth copying wholesale as a design:
122|
123|1. MBID exact match if the local file has one (`content_resolver/content_resolver.py:63-74`, confidence 1.0, method "MBID").
124|2. Fuzzy match: TF-IDF over **character trigrams** of `unidecode`-normalized, punctuation/space-stripped `artist+title` strings (`content_resolver/fuzzy_index.py:20-26,43-69`), nearest-neighbour via nmslib `simple_invindx`/`negdotprod_sparse_fast` (`fuzzy_index.py:67`), k=1 (`:87`). Match accepted at confidence ≥ threshold (0.8 in the local jams patch, `troi/local/periodic_jams_local.py:72`).
125|3. Retry loop: failures are re-queried after `lb_matching_tools.MetadataCleaner` strips remix/feat./paren noise from title and artist independently (`content_resolver.py:57-112`), and unresolved MBIDs are tracked persistently for later re-scan (`content_resolver.py:114-116`).
126|
127|### 2.4 Limitations
128|
129|- `troi/listenbrainz/recs.py` et al. hard-code `api.listenbrainz.org` / `labs.api.listenbrainz.org` (`troi/playlist.py:20-23`, `recording_search_service.py:30`) — no base-URL injection; standalone use still means *their* servers for anything CF.
130|- Fuzzy resolution silently returns no matches if optional `nmslib` isn't installed (`fuzzy_index.py:75-77`); nmslib is a build-fragile native dep (`pyproject.toml:38-40`, metabrainz fork).
131|- Pipeline is eager list-passing, no streaming; type system is informal (lists of entity classes).
132|- GPL-2.0.
133|
134|### 2.5 Decision: **ADAPT (architecture + resolver design), REJECT (code)**
135|
136|- Reimplement in TS: the Element/Patch pull-pipeline with wiring-time type checks (maps naturally to typed generics), the service-slug registry for local-vs-remote candidate sources, and the 3-stage local resolver (MBID → trigram TF-IDF kNN with 0.8 threshold → metadata-cleaner retry + unresolved tracker). A TS equivalent of the fuzzy index is trivial with a small cosine-over-trigram implementation; no nmslib needed at single-library scale.
137|- Copy the filter constants as defaults: exclude last-60-days listens for jams, `max_artist_occurrence=2`, aspire-to-25 minimum.
138|- GPL blocks vendoring code; the pipeline shape and thresholds are ideas (not copyrightable expression) — clean-room reimplementation is fine.
139|
140|---
141|
142|## 3. implicit (benfred)
143|
144|MIT-licensed CPython/Cython/CUDA library of implicit-feedback recommenders. Small, focused, readable.
145|
146|### 3.1 Algorithms and exact input shape
147|
148|All models consume a **`scipy.sparse.csr_matrix` of shape users × items** where the value is the confidence/weight (`implicit/cpu/als.py:116-119`); negatives are implicit — unset entries mean `P_ui=0, C_ui=1`, and *explicit dislikes can be passed as negative values* (`cpu/als.py:108-112`).
149|
150|- **ALS** (`implicit/als.py:7-15` → `implicit/cpu/als.py:20+`): Hu/Koren/Volinsky "Collaborative Filtering for Implicit Feedback Datasets" with the Conjugate-Gradient speedup (docstring `cpu/als.py:22-26`). Defaults: `factors=100, regularization=0.01, alpha=1.0, iterations=15`. Alpha is applied by simply scaling the matrix: `Cui = self.alpha * Cui` (`cpu/als.py:133-134`). Per-user fold-in for new/updated users exists via `recalculate_user` (`cpu/als.py:204`).
151|- **BPR** (`implicit/bpr.py:8-12`): Bayesian Personalized Ranking, SGD; defaults `factors=100, learning_rate=0.01, iterations=100`.
152|- **Item-item kNN** (`implicit/nearest_neighbours.py`): `ItemItemRecommender` computes an all-pairs top-K item similarity matrix (`K=20` default, `:24,35-41`) and scores a user by their own item vector against it (`:84-90`). Variants differ only in pre-weighting:
153|  - Cosine: normalize columns then dot product (`:193-198`, `normalize` at `:235-240`).
154|  - TF-IDF: `X.data = sqrt(tf) * idf` where `idf = log(N) - log1p(bincount(col))` (`:222-232`).
155|  - BM25: `w = tf·(K1+1) / (K1·((1-B) + B·row_len/avg_len) + tf) · idf`, exactly `:243-258`; function defaults `K1=100, B=0.8`, class defaults `K1=1.2, B=0.75` (`:212`).
156|- Models persist as plain `.npz` arrays (`nearest_neighbours.py:166-190`), i.e. the learned artifact is portable to any language.
157|
158|### 3.2 Minimum data scale to be meaningful
159|
160|The library's own benchmark datasets set the realistic floor: last.fm 360k users (`implicit/datasets/lastfm.py:14-24`), MovieLens, MSD. ALS/BPR factorize a users×items matrix — with **one user the matrix has one row and the factorization is degenerate** (there is nothing to co-factor; item factors collapse to that user's preferences). Item-item kNN likewise needs many users: with one user, every pair of listened items is "similar" with trivial counts. Rough practical floor for non-garbage output is thousands of users / hundreds of thousands of interactions; grid-searching rank/α/λ (as LB does, §1.3) matters below that.
161|
162|### 3.3 Does any part make sense for a single local user? (honest answer)
163|
164|- **Not as the core engine.** CF across users is definitionally unavailable locally. Any design that pretends otherwise is cargo cult.
165|- Legitimate uses:
166|  1. **Optional multi-user path** — if the app ever syncs several users' histories (household/server mode), a TS port of `CosineRecommender`/BM25 item-item is ~100 LOC and the right first model (no training loop, interpretable).
167|  2. **Over precomputed public data** — build the users×items matrix from a ListenBrainz/MLHD public dump *offline*, ship or cache only the top-K item-similarity table (exactly what LB itself serves; §1.5/§1.6), then do local scoring with the user's own playcounts using the `NearestNeighboursScorer` logic (`nearest_neighbours.py:84-90`). The BM25/TF-IDF weighting formulas (§3.1) are directly portable to weight the *single user's* item vector when querying any similarity table.
168|  3. The **negative-confidence convention** (dislikes as negative matrix values, `cpu/als.py:108-112`) is a clean pattern for encoding thumbs-down in local scoring.
169|
170|### 3.4 Limitations
171|
172|- Core loops are Cython/C++/CUDA (`cpu/_als.pyx`, `cpu/bpr.pyx`, `_nearest_neighbours.pyx`) — not callable from TS; a port keeps the math, not the speed (irrelevant at single-user scale).
173|- No session/sequence awareness at all; pure matrix models.
174|- `similar_users` not implemented for item-item models (`nearest_neighbours.py:108-109`).
175|
176|### 3.5 Decision: **ADAPT (port formulas; MIT makes this frictionless)**
177|
178|Port BM25/TF-IDF/cosine weighting + the item-vector × similarity-matrix scorer to TS for use over (a) precomputed LB similarity data and (b) a future optional multi-user mode. Reject ALS/BPR for the single-user core — be explicit in the product design that latent-factor CF only enters via ListenBrainz's hosted output.
179|
180|---
181|
182|## 4. Licensing implications for a publicly shipped TS app
183|
184|- **listenbrainz-server, troi: GPL-2.0.** Translating/porting their *code* into the app makes the app a derivative work → the whole app must ship under GPL-2.0. If that's unacceptable, do **clean-room reimplementation of algorithms, formulas, thresholds, and schemas** (ideas and functional specifications are not copyrightable; the specific parameter values documented above — session=300s, max_contribution=5, threshold=10, skip=30s, ZERO_POINT=30, cap=20, confidence 0.8 — are facts). Calling their **public HTTP APIs creates no license obligation** at all. Keep this report as the provenance record that the TS implementation was written from behavioral specs, not from the GPL source.
185|- **implicit: MIT.** Direct porting/vendoring is fine with copyright-notice attribution.
186|- MusicBrainz/ListenBrainz **data** has its own terms (largely CC0/open for core data); check rate limits and the labs API's experimental status before building a hard dependency.
187|
188|---
189|
190|## 5. Consolidated adoption plan for the TS engine
191|
192|| Idea | Source | Action |
193||---|---|---|
194|| Session-based co-occurrence similarity (gap>300s splits, skip<30s drop, same-artist exclusion, per-user cap 5, threshold 10) | LB `similarity/recording/common.py:75-172` | **Adopt** — works on one user's history; core local algorithm |
195|| Playcount→confidence transform (1→20, else 30+min(pc,20)) | LB `create_dataframes.py:83-89,172-182` | **Adopt** as local scoring weight |
196|| Dedup key (ts,user,track) + MSID/MBID layered identity with recheck-later | LB `timescale_listenstore.py:183-188`, `messybrainz/__init__.py:98-110`, `matcher.py:19-35` | **Adopt** schema design |
197|| `latest_listened_at` discovery join → "jams vs exploration" split | LB `discovery.py:17-25`, Troi `periodic_jams.py:12,35-38` | **Adopt** |
198|| Remote enrichment: `/1/lb-radio/*`, labs similar-recordings, `/1/cf/recommendation/.../recording`, `createdfor` | LB API (§1.6) | **Adopt as optional online tier** |
199|| Typed pull-pipeline (Element/Patch) + service registry for local/remote swapping | Troi `__init__.py:20-158`, `patch.py:26-117` | **Adapt** (clean-room TS) |
200|| 3-stage local resolver: MBID → trigram TF-IDF kNN (0.8) → metadata-cleaner retry + unresolved tracker | Troi `content_resolver.py:44-117`, `fuzzy_index.py:20-97` | **Adapt** (clean-room TS) |
201|| BM25/TF-IDF/cosine item weighting + kNN scorer, dislikes as negative weights, npz-style portable model | implicit `nearest_neighbours.py:193-258`, `cpu/als.py:108-112` | **Port** (MIT) |
202|| ALS/BPR latent factors locally | implicit `als.py`, `bpr.py` | **Reject** for single user; revisit only for multi-user/community-dump mode |
