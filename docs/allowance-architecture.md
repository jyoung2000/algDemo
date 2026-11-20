# Daily download allowance: why it runs out and how to rebuild it (ALLOWANCE-ARCH-001)

Status: implemented 2026-11-20 on branch `claude/allowance-lanes` (see section 8 for what was built and
measured afterwards). Sections 1 to 7 are the proposal as written before the work. Measured on jPlay 0.20.5 code
(Windows dev app with a temporary per-host counter in `engine/net.ts`, since removed) and on the
Android emulator's and Windows test profile's own `transfer` tables.

## 1. What was measured

Spent per day, from the apps' own records (`transfer` store):

| Profile | Day (UTC) | metadata | search | audio | Limit set |
|---|---|---|---|---|---|
| Android emulator | 2026-11-19 | 464.0 MB | 1.3 MB | 8.2 MB | 400 MB |
| Android emulator | 2026-11-20 | 457.2 MB | 7.7 MB | 0 | 400 MB |
| Windows test profile | 2026-11-19 | 622.1 MB | 0.3 MB | 0 | 2000 MB |
| Windows test profile | 2026-11-20 | 146.0 MB | 2.2 MB | 0 | 2000 MB |

Both are heavy test profiles, but the default limit is 100 MB.

Cost of one action (Windows, bytes as the app charges them today):

| Action | Charged | Of which YouTube Music |
|---|---|---|
| One "Find my next favorite" run (+6 songs) | 5.26 MB, 94 calls | 4.19 MB in 6 calls (706 KB each) |
| One search, new words | about 2.2 to 2.5 MB | 1.3 to 2.6 MB |
| Same search again within 15 min | about 0.3 MB | 0 |
| Loading the full song for newly added rows | about 0.7 MB per call | all of it |
| Opening one artist page (first 25 s) | 1.59 MB | 1.28 MB (one 1.25 MB answer) |
| Idle on Discover, 30 s and 45 s | 0 | 0 |

At 100 MB a day that is about 19 discovery runs, or about 40 searches, before everything stops.

Real network size of the same answers (requested with gzip, 2026-11-20):

| Request | Charged (decoded) | On the wire | Ratio |
|---|---|---|---|
| YouTube Music song search, as asked today | 683,896 | 39,350 | 17x |
| same, `prettyPrint=false` | 196,423 | 13,638 | |
| same, with the field mask already used for paged search | 53,970 | 5,529 | 20 rows in all three |
| YouTube Music `next` (radio), as asked today | 1,796,253 | 103,058 | 17x |
| same, `prettyPrint=false` | 476,378 | 33,173 | 50 rows in both |
| Deezer search (25) | 53,462 | 7,179 | 7x |
| Deezer album | 23,149 | 2,490 | 9x |
| Deezer artist top 50 | 126,208 | 9,168 | 14x |
| iTunes search | 39,781 | 5,661 | 7x |

## 2. Why the limit is hit

1. **The counter counts unpacked bytes, not network bytes.** `Http.getOnce` adds
   `response.body.byteLength` after the shell has already unpacked gzip. Every service measured
   sends gzip, so the day is charged 7 to 17 times what the connection carried. A "457 MB" day
   was roughly 30 to 60 MB of real traffic (estimate from the ratios above).
2. **YouTube Music is about 80 % of the charge and most of it is waste.** `ytmusic.ts` already has
   a field mask (`SONG_PAGE_PARTS`, `GRID_PARTS`) but only the paged features search and the
   discography grid use it. The hot paths (plain song search line 439, video search 451, `next`
   351, artist browse 379, related 520) ask for the whole page: 684 KB where 54 KB holds the same
   20 rows.
3. **One bucket for everything, and background work drains it first.** Search, artist pages,
   Customize, discovery runs, the listening top-up, the genre/album fill and the features paging
   all draw on the same day total. When it is gone the things a person explicitly asked for are
   refused ("Today's download allowance is used up, so artists cannot be searched").
4. **The playback lane is exempt from the limit but still fills the bucket.** `playbackMeter()`
   is deliberately independent of the day (a song must always play) yet reports every byte to the
   same total. With "keep the whole queue loaded" (the default) that is about 0.7 MB charged per
   queue song, so a long queue alone can spend the day. (Inferred from the per-call measurement
   and the code; not isolated in a separate run.)
5. **0.20.5 makes it more likely.** The queue now tops up at 5 songs left and after skips, so
   discovery runs happen more often.
6. **The day ends at midnight UTC.** `store.ts` `day()` uses `toISOString()`: in Chicago the
   allowance comes back at 6 pm in winter, not at midnight, and nothing tells the listener when.
7. **Refreshing is manual and all-or-nothing.** Settings -> Sources -> Check again zeroes today.
   There is no automatic recovery, and using it makes the limit meaningless.
8. **No idea of the network.** The same limit applies on home Wi-Fi and on mobile data, while
   full-song downloads (up to the 1 GB+ queue cache) are not limited at all. The limit guards the
   small traffic and ignores the large.
9. Search answers are kept 15 minutes only; a Spotify page bundle of 4.63 MB is read once per app
   start outside the counter (real data, not counted).

## 3. Target architecture

Three parts: spend less, count honestly, and make the budget a refilling reserve for background
work only.

### 3.1 Spend less (no behaviour change)
- Put `prettyPrint=false` plus a field mask on every `youtubei` call, each with the existing
  "mask refused -> ask plainly once" fallback that `GRID_PARTS` has.
- Keep discovery's own look-ups longer: search answers used by discovery and genre fill 24 h
  (a person's typed search stays 15 min, or serves the kept answer and refreshes behind it).
- Keep the Spotify bundle hash/token and SoundCloud client id across app starts.
- Make "keep the next N songs loaded" the default rather than the whole queue, or resolve the
  rest only on an unmetered network.

### 3.2 Count honestly
- Shells report `wireBytes` with each response (Android `NativeHttp.kt`: ask for gzip itself and
  count the stream before unpacking; Windows `bridge.cjs`: same). `Meter.add` charges
  `wireBytes ?? body.byteLength`.
- Ledger key becomes `day | lane | host`, with the day in local time. Settings can then show
  "Today: 6.2 MB - discovery 3.1, search 1.4, loading songs 1.2" instead of one number.

### 3.3 One budget module with lanes
`engine/budget.ts`, replacing the six ad-hoc `new Meter(...)` sites:

```ts
type Lane = 'interactive' | 'playback' | 'background';
interface BudgetGovernor {
  meter(lane: Lane, purpose: string, perRequestCap: number): Meter;
  state(): { level: number; capacity: number; refillPerHour: number; unmetered: boolean; resumesAt: number | null };
  onChange(fn: () => void): () => void;
}
```

| Lane | What | Limited by the allowance? |
|---|---|---|
| interactive | search, open artist/album, Customize artist search, identify a song | No. Per-request cap only. Counted and shown. |
| playback | finding the audio for the song being played or next up | No (as today). Counted in its own lane, no longer eating the others. |
| background | discovery runs, listening top-up, genre/album fill, features paging, loading songs far down the queue | Yes. This is the only thing the allowance governs. |

Background work asks the governor before it starts and scales with what is left: full batches
above 50 %, smaller and rarer batches below 25 %, pause at 0. Explicitly asked work is never
refused for budget reasons.

### 3.4 Automatic refill
- **Reserve that refills continuously** instead of a calendar day: capacity = the Settings value,
  refill = capacity / 24 per hour, stored as `{ level, at }`. No cliff, no midnight, and a paused
  queue resumes by itself within minutes.
- **Unmetered network = no limit on background work.** Android: `ConnectivityManager`
  `NET_CAPABILITY_NOT_METERED` pushed to the page on change. Windows: unmetered unless the
  listener says otherwise in Settings. The Settings label becomes "Mobile data allowance".
- **Self-healing.** When the background lane pauses, the governor publishes `resumesAt`; the
  queue top-up and genre fill re-arm for that time. The UI says "Finding new songs is paused to
  save data - resumes in 12 min" with "Continue now", never "used up, raise it in Settings".
- "Check again" keeps working as a manual top-up.

## 4. Expected effect (estimates from the measured sizes, not yet run end to end)

| | Charged today | Field masks only | Masks + network bytes |
|---|---|---|---|
| One discovery run | 5.26 MB | about 1.4 MB | about 0.17 MB |
| Runs per 100 MB | 19 | about 70 | about 600 |
| One new search | about 2.3 MB | about 0.5 MB | about 0.1 MB |

## 5. Order of work
1. Field masks on all `youtubei` calls; local-time day; interactive lane never refused. Web only,
   small, removes most of the problem.
2. `engine/budget.ts` governor with lanes, the refilling reserve, `resumesAt`, the paused/resume
   wording, Settings breakdown.
3. `wireBytes` from both shells; unmetered-network signal on Android; "next N songs" preload default.

## 6. Open questions for the owner
- Should the allowance apply on Wi-Fi at all? (Proposal: no.)
- Keep 100 MB as the default once bytes are counted honestly? (Proposal: yes; it then means
  roughly a full day of listening on mobile data.)
- Should full-song downloads on mobile data get their own limit? They are far larger than
  everything this allowance covers.

## 7. Not verified
- A field mask for `next`, artist browse and related (only song search was tested with a mask;
  `prettyPrint=false` was tested on `next`).
- That the shells can report network bytes for every response (chunked answers have no length
  header; the stream has to be counted).
- The split of a real listener's day between lanes; both measured profiles are test profiles.

## 8. What was built (2026-11-20)

Owner decisions: the allowance does not apply on Wi-Fi; the default stays 100 MB; full-song downloads are never limited.

- `web/src/engine/budget.ts`: three lanes. `interactive` (search, artist and album pages, a discovery the listener
  started) and `playback` are counted and never refused. `background` (listening top-ups, genre and album look-ups)
  is the only lane limited, and only on a metered connection.
- The allowance is a reserve the size of the Settings value that refills a twenty-fourth every hour. Below 1% (at
  least 1 MB) background work pauses and nothing is let through until the reserve is back at that level; the engine
  says when (`resumes_at`) and the queue asks again by itself then (`useQueueGenres`).
- The day in the ledger is the listener's local date; rows carry the lane.
- Metered or not comes from the shell: Android `ConnectivityManager.isActiveNetworkMetered` (new permission
  `ACCESS_NETWORK_STATE`, no prompt), Windows `NetworkInformation.GetConnectionCost` through `windows/metered.cjs`.
  Unknown (browser, older shell) leaves the allowance applying. The engine asks again before a top-up, a genre pass
  and the status page, at most twice a minute.
- Both shells ask for gzip, unpack it, and report the bytes the network carried; that is what is charged.
- `youtubei` requests always ask for compact JSON; songs search, videos search and the watch panel ask only for the
  parts that are read, and fall back to the whole page once if the short form is refused.
- Settings: "Mobile data allowance", a status line (not metered / MB left / paused and when it resumes), today's
  reading by lane. The Discover note offers "Continue now" instead of "Raise the allowance in Settings".

Measured afterwards:

| What | Before | After |
|---|---|---|
| One "Find my next favorite" run, Windows, same profile (2 runs) | 5.26 MB charged | 163 kB and 189 kB |
| One new song search, Windows | about 2.5 MB (section 2: about 40 searches used 100 MB) | 180 kB (68 kB asked for, 112 kB background tags) |
| Opening one artist page, Windows | not isolated | 857 kB |
| Deezer search of 25, Android bridge | 53,462 bytes charged | 7,179 on the wire |

On the Android emulator: Wi-Fi reads as not metered and mobile data as metered. With the reserve emptied on mobile
data a typed search still returned results, Settings said when background work resumes, and no background bytes were
read in the following two minutes. Back on Wi-Fi a full song (6.89 MiB) downloaded with the reserve still empty and
nothing was charged to the allowance.

Not done or not checked:

- Loading only the next N songs instead of the whole queue, and keeping discovery's own look-ups for 24 hours
  (section 5, step 1) were not started.
- Radio, artist and "related" `youtubei` requests are compact but not yet reduced to the parts that are read.
- A full-song download on real mobile data was not completed: on the emulator's mobile link the downloader's
  connection to YouTube failed with a TLS error and a 328 kB page timed out through the bridge, while small requests
  worked. The download path has no allowance check, and the same download worked on Wi-Fi.
- "Continue now" was exercised in component tests only, not on a device.
- The Windows metered answer was only seen as "not metered" (this machine has no metered connection).
- The two discovery runs are single measurements on a warm profile, not a controlled comparison.
