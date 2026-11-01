# Source capability matrix

The status is from runtime checks on this machine (Windows 11), 26 Oct 2026. The app shows the same
checks live in **Settings → Sources**, and those badges are never constants. Evidence key: **L** =
live test in `server/tests/test_live.py` (13/13 passed), **J** = live recommendation job, **B** =
browser check, **H** = `/api/health` runtime probe.

Legend: **Working** = tested and works. **Degraded** = works with stated gaps. **Unavailable** =
tried and does not work. **Unsupported** = no keyless way exists, so the app does not offer it.
**Not tested** = not exercised here.

## Links (paste a URL)

| Source | Status | Evidence | Notes |
| --- | --- | --- | --- |
| YouTube Music `music.youtube.com/watch` | Working | L | |
| YouTube `youtube.com/watch`, `youtu.be` | Working | L | Read through YouTube Music. Removed or invalid videos fail with a plain message (L). |
| YouTube Music album playlist (`OLAK5…`) | Working | L | Offers a bounded choice of 1–25 tracks, never one song. |
| YouTube user playlist | Degraded | manual | Public playlists list tracks. The tested `PL…` list answered "private, empty or not available without signing in". |
| SoundCloud track page | Working | L | Through yt-dlp. A missing track fails plainly (L). |
| Spotify track | Degraded | L | Public oEmbed gives title and artwork, **no artist**. The app then asks you to pick the matching song from a search. A bad ID fails plainly (L). |
| Spotify album or playlist | Unsupported | manual | oEmbed does not list tracks; the app says so (HTTP 422). |
| Deezer track | Working | L | |
| Untrusted URLs | Blocked as designed | manual | Unknown hosts, look-alike hosts (`open.spotify.com.evil.example`), private IPs, loopback and non-standard ports are refused (HTTP 400). Redirects are checked hop by hop. |

## Search (titles)

| Source | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Deezer | Working | L, H, B | Public API, no key. |
| YouTube Music | Working | L, H, B | `ytmusicapi`, unauthenticated. |
| SoundCloud | Working | H, B | Windows and Android apps: the TypeScript engine (`soundcloud.ts`) searches it; results are labelled SoundCloud. Dev server only: yt-dlp. |
| Apple Music | Working | L, B | iTunes Search API, no key (`apple.ts`). Shown in the Windows and Android apps. |
| Spotify | Unsupported | — | No keyless catalog search. Spotify songs come in by link only. |

## Candidates (where recommendations come from)

| Source | Related | Artist | New releases | Evidence |
| --- | --- | --- | --- | --- |
| Deezer | Working (artist radio, related artists, genre chart) | Working (top tracks) | Working: album release dates with day precision, 60-day window | J, H |
| YouTube Music | Working (radio, "You might also like") | Working | Unsupported (no reliable release date) | J, H |
| SoundCloud | Health check answers (`/recommended`) | Unsupported | Unsupported | H only. **Not exercised by a recommendation job**, because seeds come from Deezer or YouTube Music search. |
| Spotify | Unsupported | Unsupported | Unsupported | — |
| Collaborative filtering | Unavailable | — | — | Single user only, so this weight is absent. |

The last uncached job (2 seeds, 26 Oct 2026) returned 30 songs from live responses: 26 from YouTube
Music and 4 from Deezer, with at most 2 per artist. Four carry 2026 dates. Two of those are flagged
as new releases (day-precision Deezer dates inside the 60-day window).

## Playback

| Source | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Full-song playback (YouTube IFrame Player API) + volume | Working | B (`/api/full-song` match; YouTube `onStateChange`, `currentTime`, `volume`/`muted` events; seek to 2:00; 390 and 1440 px) | The page controls YouTube's embedded player (play, pause, seek, volume, mute). Airwave never downloads that audio; it streams from YouTube to your browser and is outside the backend transfer allowance. A Deezer-only song is matched to a YouTube Music video once (cached 7 days) and only on a confident match; otherwise it plays the preview. Volume is remembered in `localStorage`. |
| Deezer 30-second previews (fallback) | Working | B (`currentTime` advancing at 390 and 1440 px) | Played through `/api/preview/deezer/{id}`, which re-signs the expiring URL and redirects (307). **This audio streams from Deezer to your browser and is outside the backend transfer allowance.** |
| YouTube / YouTube Music embed | Working (link check) | H | `youtube-nocookie.com` embed or "Open in YouTube Music". Playback inside the embed was not timed. |
| SoundCloud widget | Not tested | — | The oEmbed link answers (H); in-app widget playback was not exercised. |
| Spotify | Open link only | — | No audio extraction. "Open in Spotify". |
| Spicetify companion | Not tested | H | Optional interface only; Spicetify is not installed here, so it is disabled and marked not tested. |

The player never shows simulated progress. The bar moves only on real `<audio>` time updates.
Listening feedback is recorded only for observed listening (played to the end, or skipped after a
short real listen).

## Audio analysis

| Item | Status | Evidence |
| --- | --- | --- |
| DCLAP ONNX encoder on CPU | Working | J: 22 previews embedded, 20 candidates compared, about 0.55 s CPU per preview |
| Audio source: Deezer previews | Working | J: 10.6 MB downloaded for 22 previews, byte-capped per file |
| Seed-vs-candidate comparison in ranking | Working | J: 12 of 30 final songs carry an audio factor; the top song's first reason is audio |
| Audio-inferred genre tags | Unsupported | No verified classifier. Tags come only from providers, with their source. |
| Vocals/instrumental control | Unsupported | No measured evidence, so there is no control. |
| Tempo/energy factor | Unsupported | No measured tempo source; the weight is absent rather than guessed. |

When today's allowance runs out, the audio step stops early, says so in plain language, and the
metadata ranking stands. A self-test that cannot run for lack of allowance keeps the last real
result rather than marking the model broken (`test_model_selftest_out_of_allowance_is_not_a_model_failure`).
