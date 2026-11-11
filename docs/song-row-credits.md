# Song rows: album and artist navigation (SONG-CREDITS-001, 0.18.2 / vc45)

The album action icon is removed from song rows. A row now reads:

1. song title
2. album name, when the song names one
3. every credited artist, lead first

A song with no album puts the artist straight under the title, with no blank gap. Tapping the album
name opens that album's page; tapping an artist name opens that artist's page. Neither starts
playback. Shared by search results, the now playing queue rows and saved/playlist rows through
`web/src/SongCredits.tsx`; an album page's own numbered rows omit the redundant album line.

Guest credits: `web/src/engine/credited-names.ts` turns artists written explicitly in the title
("Singapore (feat. Destroy Lonely)") into links when the provider lists only the lead. It never
infers an artist from ordinary title words, never alters recording identity or album matching, and
never rewrites the stored track.

## Verified
- web 1413 tests pass, 7 skipped; TypeScript clean; Android unit 109 pass.
- Signed release APK 0.18.2 / versionCode 45 and signed Windows 0.18.2 (portable, setup, unpacked).
- Real packaged Windows app: album name opened "A Great Chaos"; "Ken Carson" and "Destroy Lonely"
  each opened their own page; Back returned to the same results; layout measured at 1440, 900, 412
  and 360 px with no horizontal overflow and the credit lines stacked in order.
- Release APK on an Android device: album name opened "A Great Chaos", "Ken Carson" opened its page,
  412 px layout measured with no overflow.

## Known defect, not introduced here
Opening an artist by name alone fails inside the Android app ("No artist named X was found on Deezer
or YouTube Music") while the same name opens on Windows. Reproduced with the shipped plain
artist-search card, which uses none of this change's code, so guest names on Android can hit it.
