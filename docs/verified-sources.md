# Owner-verified sources (SOURCE-VERIFIED-001)

The strict recording matcher is what keeps discovery honest: it refuses an upload whose artist does
not match the song the owner asked for, which is correct for the general case. But a few exact
recordings only exist online under a re-uploader's name. The owner has listened to those and
confirmed the audio is the recording they want. `web/src/engine/verified-sources.ts` is the short,
hand-checked list of those confirmations.

A verified entry overrides search and identity for ONE song only. `findFullSong` checks it first,
before any provider is asked, and returns the confirmed URL. It does not loosen matching for any
other song: everything else still goes through the strict chain. The entry is skipped if that exact
link already failed this run (`exclude`), so a retry still falls through to the normal search.

Each entry names a public, streamable URL the app already downloads from through its normal path.
Today that is SoundCloud via yt-dlp — a public HLS stream, the same mechanism every SoundCloud match
in the chain uses, with no DRM or access-control bypass. The target duration is part of the match
key (within two seconds), so a mistaken URL cannot stand in for a different-length recording, and a
same-title different song or a different edit is never swapped in.

## Current entries

| Recording | ISRC | Duration | Source | Why |
| --- | --- | --- | --- | --- |
| Plant Island — My Singing Monsters | USHM81262832 | 219 s | `soundcloud.com/ghostmeow/my-singing-monsters-plant` | The exact 219.334 s recording; the owner confirmed it. It exists on SoundCloud only under a re-uploader's name, so the artist-strict matcher rejected it. |

## Adding an entry

Add a row to `VERIFIED_SOURCES` with the recording's title, artist, duration, ISRC (if known) and
the confirmed public URL. The URL host must already be one the downloader accepts (`YTDLP_HOSTS` /
`YTDLP_SUFFIXES` in `web/src/engine/downloads.ts`). Verify on packaged Android and Windows that the
song downloads complete audio and plays the full length before trusting it. This is a deliberate
human confirmation, never an automated relaxation of identity matching.
