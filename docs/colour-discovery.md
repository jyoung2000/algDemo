# COLOR-DISCOVERY-001 — the colours keep finding new music (0.18.9 / vc52)

Owner: **"Ensure the recommendation engine can keep recommeding new songs and music based on the users
color algoritim"**.

## What was wrong

Every source the gather step asked hung off a starting song: YouTube Music's radio and related songs
for it, Deezer's artist radio, artist top, related artists, recent releases, Apple's and Spotify's
search for its title, and the genres the services state for the seed itself. Those pools are finite
and deterministic - ask twice, get the same answer - so a second run on the same starting songs ended
in *"No new songs this time. Your list is unchanged."*

The listener's colours were only ever used to **score** what the seeds turned up. The thing that
knows what this listener likes was never allowed to ask for anything.

## What it does now

The colours are a source of their own.

1. **Asks from the colours.** Every run, the strongest colours (the same list the Sound card draws)
   are turned into asks, in proportion to how strongly the listening says them: each colour is a cell
   in the Taste Picker, each cell names real reference artists, and those names plus the cell's own
   words are searched. Six asks a run, metered like everything else.
2. **A cursor, so it never repeats itself.** `taste_cursor` advances every run: run two asks for what
   run one did not, and once a colour's pool has been walked the same terms are read a page deeper.
   An ask is a term *and* a page, and the same ask is never made twice.
3. **Widening, not just deepening.** Three reference artists per colour would fade after a few runs,
   so each run also follows one of them out to the artists Deezer puts beside them, a step further out
   each time round. That tree does not run out.
4. **Honesty.** A colour below 0.15 is not a taste and is not asked for; a colour the listener skips
   away from is never asked for; a listener with no colours yet asks nothing. A colour-found song is
   stamped `taste_colour` - exploration, not relatedness, so it cannot pose as evidence that a song
   fits - and the reason says **"Your sound leans R&B, so the services were asked for more of it."**,
   named the way the genre bubbles name it (TAGS-CANON-001), never "from Deezer's chart", which would
   be a lie about where it came from.

## Verified on the real builds

| Platform | Queue across consecutive runs | Colour-named reasons |
| --- | --- | --- |
| Windows 0.18.9 (packaged) | 31 → 61 → 91 → 121 → 148 → 172 → **200** | "Your sound leans Alternative / R&B / Soul…" |
| Android release 0.18.9/vc52 | 31 → 58 → 88 → **160** | "Your sound leans R&B, so the services were asked for more of it." |

Windows stops growing at 200 because that is the queue's own size, not because discovery ran dry.

Two runs mid-way returned nothing at all until **Check again** was pressed: the day's allowance was
at *472 MB of 100 MB*, and a refused provider call cannot find music. ALLOWANCE-REFRESH-001 clears it
in one press (475 MB cleared, then 28 new songs on the very next run).

The colours do move while listening: the engine's own line reads *"Learned from 54 songs you played:
you keep R&B, soul, Rap/Hip Hop; you stay near 105 BPM"*, and every finished or skipped song
re-reads it (`rerank` returns the taste, `refreshTaste` when there is no queue to re-rank).

Tests: `web/src/engine/color-discovery.test.ts` (14 cases, including a negative control: taking the
colour asks back out of `gather` fails the two end-to-end cases).
