# One song, one row, and what an album sounds like

Shipped in 0.18.6 / versionCode 49.

## SEED-DUPE-001 — a starting song is never drawn twice

Owner: *"Ensure adding a starting song the recommendation engine doesnt recommend the same song
again."*

Since QUEUE-SEED-001 the row's **+** both queues a song and makes it a starting song, so the same
recording was drawn twice in the Now playing queue: once as the "Starting song" row and once as
queue entry 1. Reproduced on the live 0.18.5 build — *tell me what you want* (Sasha Keable) appeared
at rows 1 and 2.

`Results` now keeps **one row per song**: a starting song that is also in the queue below loses its
separate row, and the queue row — the playable one, with its rank, cache state and feedback —
carries a *Starting song* marker plus the emphasise and "stop being a starting song" buttons. A
starting song that is not in the queue still gets its own row, unchanged.

Sameness is the engine's own `matchRecordings`, so the same recording from a different service
counts as one song, not two.

The engine already excluded seeds from candidates (`newDiscoveryTracks` against
`store.seeds()`); this was the list drawing, not the ranking.

### Verified
| Build | Rows matching the added song | Marker | Duplicate titles anywhere |
| --- | --- | --- | --- |
| Packaged Windows 0.18.6 | 1 (queue row, not a seed row) | yes | none |
| Android release APK 0.18.6/vc49 | 1 (queue row) | yes | none |

Tests: `web/src/seed-dupe.test.tsx`, six cases. Negative control: with the filter removed, three of
them fail again.

## ALBUM-SOUND-001 — an album's own colour bar

Owner: *"when an album is opened a your sound color bar should let you see the color gradient for
the album so the user can see what the album sounds like."*

The album page now draws the same Sound card the listener's taste and a saved list use, titled
*Sound of "<album>"*, from the genres of the album's songs (`playlistMix`, the PLAYLIST-MIX-001
machinery). Album songs come straight from a provider and rarely carry tags of their own, so the
lookup order is: the song's own tags → what the services said when it was a starting song → its
artist's other songs → **what the service says about the album itself** (Deezer and Apple state an
album genre). When none of them knows, the bar is drawn empty and the card says
*"No genre known yet for the N songs on this album"* rather than inventing a gradient.

### Verified
On both the packaged Windows 0.18.6 and the Android release APK, opening *Live From NPR's Tiny Desk*
(Sasha Keable) draws **General R&B 100%** with gradient stops `#e12d71` — the Taste Picker's R&B
colour — under the line *"From the genres of the 8 songs on this album."* An album whose songs and
album record carry no genre (a YouTube Music album) shows the empty bar and the honest note.

Tests: `web/src/album-sound.test.tsx`, four cases (card drawn, bar coloured, honest empty state, no
card for an album with no songs).
