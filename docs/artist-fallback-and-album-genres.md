# An artist tap never dead-ends, and albums are classified in detail

Shipped in 0.18.7 / versionCode 50.

## ARTIST-FALLBACK-001 — "No artist named …" is gone

Owner, on the error screen: *"ensure this error doesnt happen"* (the name was `jackiegalama`).

Song credits carry names the music services have no page for: uploader handles, small
self-releases, names a provider spells differently. `/api/artist` used to answer 404 with
*No artist named "x" was found on Deezer or YouTube Music* and the screen showed a red alert.

Now, when both services come back empty for a **name**, the route answers 200 with a page built
from what this app already holds credited to that name — the same `knownTracks()` the saved-list
mix reads, split into their own songs and features the usual way — marked `local: true` with both
sources recorded as `none`. The screen shows a plain note above the page:

> Neither Deezer nor YouTube Music has a page for "jackiegalama". These are the songs you already
> have by them.

…or *"You have no songs by them yet, so there is nothing to show."* when the app holds none. A
lookup **by id** still fails loudly: an id that resolves to nothing is a real error, not a thin page.

Tests: `web/src/engine/artist-fallback.test.ts` (5) and `web/src/artist-fallback-ui.test.tsx` (3).

## ALBUM-GENRE-DETAIL-001 — detailed, and right

Owner: *"album tag / genre & sub genre classification is detailed and correct."*

Album songs arrive from a provider with no tags of their own, so the album card could only show one
flat family. The album route now reads, in order:

1. the song's own tags, then what the services said when it was a starting song, then its artist's
   learned genres (`genresOfTrack`);
2. **what this artist is known for** — one MusicBrainz artist lookup, cached a month, remembered in
   `artist_subs` for everything else that reads a genre;
3. **what MusicBrainz's listeners call this record** — a release-group search that proves which
   release is meant (exact title and artist, or nothing), then the lookup that carries its genres,
   both cached a month;
4. the genre the service states for the album itself.

Ties — and most album tags have a single vote — go to the tags the artist is also known for, so a
stray vote cannot take a slot from the style a record is actually in.

### Three wrong mappings found and fixed

Detail is only worth having when it is true. Reading real MusicBrainz answers through the table
exposed three:

| Word | Was placed as | Now |
| --- | --- | --- |
| `gangsta rap` | West Coast / G-funk | Hip-hop, no subgenre (it is a stance, not a coast) |
| `hardcore hip hop` | Conscious / jazz rap | Hip-hop, no subgenre |
| `chicago drill` | NY / Brooklyn drill | Hip-hop, no subgenre (that cell is the NY one: Pop Smoke, Fivio, Ice Spice) |

A wrong subgenre is worse than none, so each now names the family and stops.

### Verified on real builds

| Album | Before | After |
| --- | --- | --- |
| *More Chaos* (Ken Carson), Windows | NY & Brooklyn drill 34% · Conscious & jazz rap 33% · General Hip-hop 33% | **Rage 34% · General Hip-hop 33% · Pop-trap & pop-rap 33%** |
| *A Great Chaos (Deluxe)*, Android | — | **Rage 34% · Southern hip-hop & crunk 33% · General Hip-hop 33%** |
| *Live From NPR's Tiny Desk* (Sasha Keable), both | General R&B 100% | General Soul 50% · General R&B 50% (MusicBrainz has no tags for this release, so the artist's own are all there is — and it says so) |

Tests: `web/src/engine/album-genres.test.ts` (18), `web/src/engine/genre-aliases.test.ts` (7).
