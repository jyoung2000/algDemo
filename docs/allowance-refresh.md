# Refreshing the day's download allowance (ALLOWANCE-REFRESH-001)

Shipped in 0.18.5 / versionCode 48.

## Why

Every provider call — a search, a discovery run, reading a song's genres — is charged against a
per-device **daily download allowance** (default 100 MB, up to 2000 MB in Settings). When the day's
allowance is spent, every source refuses: no new music, no genre tags, and the taste colours stop
moving because the songs you played never got genres read. Before this change the only cure was to
wait for the next day or to raise the cap by hand.

Owner request, 2026-11-11: *"refresh allowance as quickly as possible, the refresh source button
should try to refresh allowance as well."*

## What Check again now does

`Settings → Sources → Check again` calls `GET /api/health?refresh=1`. That route now:

1. **Clears what today spent** (`Store.clearTransfer()`) *before* it probes the sources, so the
   probes and everything the listener does next run against a full allowance.
2. Probes the sources as it always did.
3. Returns `allowance_refreshed: { cleared_bytes, day }`, which Settings shows as
   *"Allowance refreshed: 114 MB of today's downloads cleared, so searching and discovery have room
   again."* — or *"today's allowance was not used up."* when there was nothing to clear.

Only **today** is cleared; other days' records stay. A plain health read — which Settings does every
time it opens — never clears anything, so the counter still means something while you watch it.

The day key is recomputed on every call, so a day rolling over is picked up at once; no restart
needed.

## Verified on real builds (2026-11-11)

| Build | Before | After Check again | Note shown |
| --- | --- | --- | --- |
| Android release APK 0.18.5/vc48, emulator-5554 | `downloaded today 114 MB of 100 MB` | `2.8 MB of 100 MB` | yes, "114 MB … cleared" |
| Packaged Windows 0.18.5 | `109 MB of 100 MB` | `2.8 MB of 100 MB` | yes, "109 MB … cleared" |
| Negative control: same phone on 0.18.4 | `114 MB of 100 MB` | unchanged | none |

The 2.8 MB left over is what the source probes themselves spent straight after the clear — charged
honestly against the fresh allowance.

End to end on the phone, straight after the refresh: a search for *Tyler The Creator Earfquake*
returned **41 results** (EARFQUAKE · IGOR · Tyler, The Creator) where the spent allowance had been
refusing every source.

## Tests

`web/src/engine/allowance-refresh.test.ts` — four cases: the refresh clears and reports; a plain
read does not; a refused search has room again; yesterday's record survives. They need a longer
timeout because the real probe path runs inside the refresh.
