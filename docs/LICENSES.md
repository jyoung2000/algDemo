# Licenses

The demo's own code follows the Airwave repository (MIT, as declared in the root `package.json`).
Versions are the exact ones in `server/uv.lock` and the repo's `pnpm-lock.yaml`. License
identifiers are read from each installed package's metadata.

## Python runtime (server)

| Package | Version | License |
| --- | --- | --- |
| fastapi | 0.162.0 | MIT |
| starlette | 1.10.0 | BSD-3-Clause |
| pydantic | 2.14.1 | MIT |
| uvicorn | 0.54.0 | BSD-3-Clause |
| httpx | 0.28.1 | BSD-3-Clause |
| ytmusicapi | 1.12.3 | MIT |
| yt-dlp | 2026.10.21 | Unlicense |
| yt-dlp (downloader, Windows exe and Android) | 2026.10.26 | Unlicense |
| spotDL (downloader, Windows exe only) | 4.6.0 | MIT |
| ffmpeg (downloader audio conversion; Windows: gyan.dev essentials 6.1.1, Android: youtubedl-android) | 6.1.1 | GPL-3.0-or-later build on Windows; LGPL on Android. Its source is available from the sources named here; a release must ship or link it. |
| youtubedl-android (Android downloader runtime, with its Python) | 0.18.1 | GPL-3.0 (the library) with Python under PSF-2.0. The whole Android app is already AGPL-3.0 through the bundled audio model. |
| onnxruntime | 1.31.0 | MIT |
| numpy | 2.5.4 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 |
| soundfile | 0.14.0 | BSD-3-Clause (bundles libsndfile, LGPL-2.1) |
| soxr | 1.1.0 | LGPL-2.1-or-later |
| pytest (dev) | 9.1.1 | MIT |

The LGPL libraries are used unmodified as dynamically loaded wheels.

## Web toolchain (hoisted from the monorepo)

| Package | Version | License |
| --- | --- | --- |
| react, react-dom | 19.2.8 | MIT |
| vite | 8.2.2 | MIT |
| @vitejs/plugin-react | 6.1.1 | MIT |
| typescript | 6.0.3 | Apache-2.0 |
| @now-playing/aqua-ui (repo package) | workspace | MIT |

## Audio model (optional)

| Item | Detail |
| --- | --- |
| Model | AudioMuse-AI-DCLAP, `model_epoch_36.onnx` + `.onnx.data` (22,411,906 bytes, SHA-256 checked on install) |
| Source | <https://github.com/NeptuneHub/AudioMuse-AI-DCLAP>, release `v1` |
| License | **AGPL-3.0** (GitHub license API, `spdx_id: AGPL-3.0`) |

AGPL-3.0 is a strong copyleft license that also covers network use. Running the model locally for
yourself is fine. If you offer this demo as a network service, or ship it with the model, check
the AGPL obligations. The model is not committed to the repository, but the owner chose to ship it
inside both the Android APK and the Windows exe. Each release must therefore carry this app's
corresponding source (see `docs/standalone-plan.md`).

Other candidates were looked at and not used. `yassinsolim/soundalike` was not chosen as the
encoder. `asg017/sqlite-vec` was not needed, because brute-force cosine over a short list of at
most a few hundred vectors is enough.

## Song identification (audio and lyrics search)

| Item | Detail |
| --- | --- |
| Audio fingerprint | `web/src/engine/listen/fingerprint.ts` is a TypeScript port of SongRec's signature algorithm and format (<https://github.com/marin-m/SongRec>, commit `40372e5`, `src/core/fingerprinting/algorithm.rs` and `signature_format.rs`). |
| License | **GPL-3.0-or-later** (SongRec `Cargo.toml` and `LICENSE`). The port is a derivative work under the same license. GPL-3.0 section 13 allows combining it with the AGPL-3.0 code this app already ships, and each release already carries its corresponding source. |
| Request shape | The Shazam tag request and response fields follow ShazamIO (<https://github.com/shazamio/ShazamIO>, MIT). No ShazamIO code is included. |

Only the fingerprint, a list of spectral peaks, is sent to Shazam. Sound never leaves the device, and it cannot be rebuilt from the fingerprint.

## Data sources and terms

| Source | How it is used | Terms to note |
| --- | --- | --- |
| Deezer public API | Search, related/artist/chart/recent candidates, 30-second previews, artwork | Deezer's API terms (<https://developers.deezer.com/termsofuse>) allow **non-commercial** use and require attribution. Every Deezer song links back to deezer.com. |
| YouTube Music (via ytmusicapi) | Unauthenticated search, radio, related | ytmusicapi is an unofficial client. YouTube's terms apply. Playback is YouTube's own embed or an outbound link. |
| SoundCloud (via yt-dlp) | Resolving public track links; widget/oEmbed links | yt-dlp obtains a public client id itself, so there is no developer key, but this is not an official API grant. SoundCloud's terms apply. |
| Spotify oEmbed | Title and artwork for pasted track links | Public oEmbed endpoint. No audio is extracted; songs open in Spotify. |
| Genius lyric search (`genius.com/api/search/lyric`) | Names songs from words the user types | Unofficial, keyless endpoint, used by the MIT `lyricsgenius` library's public API. No lyrics are stored or displayed beyond the short matching snippet Genius returns. It can change or throttle without notice. |
| Shazam tag endpoint (`amp.shazam.com`) | Names a song from an on-device audio fingerprint | Undocumented, reverse-engineered endpoint, as SongRec and ShazamIO use it. Its terms are unclear and it can be rate limited (HTTP 429) or changed without notice. The app reports that as "busy" and does not retry on its own. |

This is a local demo for personal, non-commercial use. It is not affiliated with Apple, Deezer,
Google/YouTube, SoundCloud or Spotify.
