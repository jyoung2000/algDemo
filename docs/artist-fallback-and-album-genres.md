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

## ALBUM-RAGE-001 — the record's own genre leads (0.18.8 / vc51)

Owner, looking at *More Chaos*: **"more chaos is a rage album."**

Three things kept it from reading that way:

1. **Even thirds.** Every song on an album page is placed from the same album-level tags, so each
   tag had exactly the same play count and the bar split 34/33/33. When an album's songs carry no
   tags of their own, the bar is now drawn from the strength of the evidence (`byEvidence`), not
   from 21 identical play counts.
2. **Filler.** A bare "Hip-hop" stood beside "Rage" and took a third of the bar while saying
   nothing. `dropCoveredFamilies` removes a family word when a subgenre of that same family is
   present; a family nothing finer covers still stays, because then it is all that is known.
3. **Flat confidence.** Every release-group tag was worth 0.55. Confidence now rises with votes and
   rises further when the artist is known for that genre — one listener's tag on one record is thin
   evidence beside an artist's whole catalogue.

A reissue is also the same record now: `baseAlbumTitle` strips known edition words
("A Great Chaos (Deluxe)" → "A Great Chaos", "(Bonus Track Version)", "(Remastered 2019)",
"(25th Anniversary Edition)"), so MusicBrainz is asked about the release it actually files. Brackets
that are part of a name ("Untitled (Rise)") are left alone.

### Verified on real builds

| Album | Before | Now |
| --- | --- | --- |
| *More Chaos*, Windows 0.18.8 | Rage 34% · General Hip-hop 33% · Pop-trap 33% | **Rage 59% · Pop-trap & pop-rap 41%** |
| *More Chaos*, Android release 0.18.8/vc51 | — | **Rage 50% · Southern hip-hop & crunk 50%** |
| *A Great Chaos (Deluxe)*, Windows | "No genre known yet" (the deluxe title matched no release) | **Rage 58% · Cloud & melodic rap 42%** |

The two platforms differ because each device has looked up different things: the phone had the
artist's southern-hip-hop tag cached and the desktop had the release's pop-rap tag. Both lead with
rage, and both say where they read it.

Tests: `web/src/engine/album-rage.test.ts` (6) and four more cases in `album-genres.test.ts`.
