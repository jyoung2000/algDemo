# Android Auto skip buttons move songs (CAR-SKIP-001, 0.18.4 / vc47)

## What was wrong
A head unit plays a tapped song by sending that one song to the media session. The session kept
exactly that one song in its timeline, so there was no next or previous song to move to. Android
Auto then hides its skip buttons and offers its own 15-second seek instead, which is why the car's
buttons jumped inside the song rather than changing song.

## The change
`PlaybackService.onSetMediaItems` now puts the list the song came from back around it when a
controller sends a single item:

- a playlist track id (`playlist/<list>/track/<song>`) restores that playlist, positioned on the
  tapped song;
- a plain song id restores the now playing queue, positioned on that song;
- a song that belongs to no list still plays on its own.

Controllers that already send a full list are untouched, and nothing about what plays first changes.

## What still limits skipping
Only songs whose complete audio is on the phone can be skipped to (the same rule the phone screen
uses). In a car, Next moves to the next downloaded song in the list and passes over ones that are
not ready yet.

## Verified
- New device test `CarSkipTest` (5 cases) on a real Android device, doing exactly what a head unit
  does: `setMediaItem(id)` + `prepare()`, then `seekToNextMediaItem()` / `seekToPreviousMediaItem()`.
  Tapping the second queue song leaves 3 items with index 1 and both a next and a previous; Next
  moves q1 -> q2 and Previous moves back; a playlist tap keeps that playlist as the queue.
- Negative control: with the fix removed the same tests fail with a one-item timeline
  (`expected:<3> but was:<1>`), which is the state that makes Android Auto show the 15-second seek.
- Whole connected suite: 38 tests pass on the Pixel device; Android unit tests pass.

## Not verified
The Desktop Head Unit could not be driven to a visual check: the Android Auto head-unit server on
the DHU emulator would not start from the command line (activity missing, broadcast ignored,
service refused as not exported), so the car screen itself was not photographed. The session-level
behaviour above is what Android Auto reads to decide between skip buttons and a seek.
