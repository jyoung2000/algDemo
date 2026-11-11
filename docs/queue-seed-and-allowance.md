# One added song starts discovery; a spent allowance says so (0.18.3 / vc46)

## QUEUE-SEED-001
Adding a song to the now playing queue with the row's + button now also makes that song a starting
song and asks for recommendations straight away. One song is enough: no second control, no hunting
for Like. A song already among the starting songs is not added twice, and a discovery already
running is left to finish rather than being cancelled and restarted.

Before this change only Like made a starting song, so a listener who added songs to the queue saw
"Add at least one starting song first" and never got recommendations, genre tags or taste colours.

## ALLOWANCE-SEEN-001
Each app has a daily download allowance (Settings, default 100 MB) covering metadata, artwork and
previews. When it is spent, every source is refused, so discovery finds nothing, genres are not read
and the Taste Picker colours never appear. The app used to say this only in a small Settings line.
The discovery area now shows a note where the new music would have been, with a button to Settings.

Measured on the owner's test devices on 2026-11-11: the Android profile had spent 104 MB of its
100 MB day (metadata 104 MB, search 31 kB) and produced no tags, colours or recommendations; raising
the allowance made all three appear immediately from the same song. The Windows profile had spent
21 MB of 100 MB and worked. The allowance is per app profile, per day, and discovery is what spends
it, so the device that discovers most is the one that goes quiet first.

## Verified
- web 1420 tests pass, 7 skipped; TypeScript clean; Android unit tests pass; Windows node tests pass.
- Android release APK 0.18.3/vc46 on a device, starting from an empty list: pressing + on one search
  result produced 32 recommendation rows and 98 genre tags with their colours (Alternative #e1712d,
  Indie #2de19e, Electronic #442de1, Indie pop #27ff91).
- Packaged Windows 0.18.3, same flow: 32 recommendation rows, 96 tags, same colours.
- The allowance note is covered by unit tests (shown when every source is refused, absent when they
  answer). It was not reproduced on a device, because forcing a real refusal needs a spent day.
