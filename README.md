# Airwave Discovery (demo)

Search for songs, or paste a Spotify, SoundCloud, YouTube, YouTube Music or Deezer link. Pick as many
starting songs as you like and press **Find my next favorite**. Airwave builds a queue of up to 30 songs from
live music sources and explains each pick. Each song plays in full in the page through YouTube's own
embedded player (with a volume slider that is remembered); a song with no YouTube Music version falls back to its
30-second Deezer preview, and SoundCloud songs play in SoundCloud's widget. There is also an "Open in …" link.

This folder stands on its own inside the Airwave monorepo. It shares the Airwave window kit,
the artwork and the icons from `packages/aqua-ui`. No other app in the repo depends on it.

- No developer keys, accounts, paid services, cloud AI or downloaded music library.
- Search runs on Apple Music (iTunes Search), Deezer, YouTube Music and SoundCloud; links from
  Spotify (public oEmbed), SoundCloud, YouTube, YouTube Music and Deezer are resolved too.
- A 22.4 MB audio model (DCLAP, AGPL-3.0, see `docs/LICENSES.md`) is bundled in both apps and
  re-orders the queue by how songs sound, using 30-second previews.
- Discovery needs an internet connection. Offline you can still see your last queue, but nothing new is found.
- **Not bundled: music downloaders (yt-dlp, spotDL).** Songs play through YouTube's own embedded player
  or SoundCloud's widget, or as a 30-second Deezer preview; nothing is ripped or saved. The apps' network
  allowlist (`web/src/engine/net.ts`) contains search and metadata hosts only.
- Spotify has no keyless catalog search, so Spotify songs come in by link, not by typing.

## Improved ranking (recsys-v2 branch)

The **Settings → Improved ranking (v2)** toggle is on by default. It improves evidence handling and learns from actual playback without replacing candidate retrieval or the original ranking path. Turn the toggle off for the original scorer; existing history stays intact. In the shipped in-app TypeScript engine, recent (10-day), long-term (120-day) and current-session taste are blended only when enough evidence exists. The Python development server honors v2 evidence, provider and feedback rules, but not the three-horizon taste layer; use the native apps or `?local=1` for that layer. A 30-second Deezer preview is never treated as full-track completion. Opening a provider link does not count as listening.

**Optional history import:** in Settings select a Spotify *extended streaming history* JSON file or extract a ListenBrainz export ZIP and choose a `listens/*.jsonl` month file (up to 25 MB per file, newest 2,000 usable events). Preview the parsed counts, then confirm. Imports stay on the device/local development server; re-imports deduplicate by event ID, original timestamps are retained, and unknown duration is not invented. ListenBrainz submissions are `qualified` plays rather than completions. Apple Music export import and ListenBrainz collaborative recommendations are not implemented. No account token or private Spotify access is required.

Reproduce the checks from the monorepo root (Node 22+, `pnpm install` already completed; Python requires `uv` for the optional dev server):

```sh
cd discovery-demo/web && pnpm typecheck && pnpm test && pnpm build
cd ../server && PYTHONPATH= uv run --frozen pytest -q -p no:warnings
cd .. && node start.mjs --port 8787
```

`web` is not a pnpm workspace member; if `pnpm` cannot resolve its scripts, use the pinned hoisted tools from `web/`: `node ../../node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`, `node ../../node_modules/vitest/vitest.mjs run --root . --dir src --exclude '**/live.smoke.test.ts'`, `node ../../node_modules/vite/bin/vite.js build`. The development server runs at `http://127.0.0.1:8787/`; `?local=1` selects the browser-local TS engine for testing, but provider fetches can fail CORS outside the native bridge. The actual Windows and Android build commands are below. Compare baseline and v2 with `web/src/engine/benchmark.ab.test.ts`; reports and pinned upstream repository reviews are in `D:/MusicRecommendationLab/reports/` and `benchmarks/`.

## Two apps, one engine

The recommender is TypeScript (`web/src/engine`) and runs inside the app. No server, Python, uv or
PC is needed on either target. `server/` (Python) is the reference the engine was ported from and the
oracle its golden tests are checked against; it is also what `node start.mjs` runs for development.

| | Windows | Android |
| --- | --- | --- |
| Shell | Electron (`windows/`) | WebView (`android/`) |
| Network | `windows/bridge.cjs`, allow-listed HTTPS | `MainActivity.Bridge`, same allowlist |
| Output | `windows/release/Airwave-Discovery-<v>-x64.exe` (portable) | `android/app/build/outputs/apk/debug/app-debug.apk` |
| Setup for the user | none: run the exe | none: install the APK |

`web/src/engine/bridge-allowlist.test.ts` fails if the page guard, the Android bridge and the Windows
bridge disagree about which hosts may be reached.

## Build

You need Node 22 or newer and `pnpm install` at the repo root. Android also needs JDK 17 and the Android SDK (platform 35).

```sh
cd discovery-demo/web && pnpm build                     # the shared web app -> web/dist
cd discovery-demo/windows && ../../node_modules/.bin/electron-builder --win portable --x64 --config electron-builder.config.cjs --publish never
cd discovery-demo/android && ./gradlew assembleDebug    # then: adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Run the Windows app from source with `../../node_modules/electron/dist/electron.exe discovery-demo/windows`
after building `web`. Both builds are unsigned or debug-signed: Windows SmartScreen warns on the first run of
the exe, and the APK has no release keystore. The Windows exe is about 107 MB because it carries Electron and
the 22 MB audio model.

## Development server (optional)

```sh
node discovery-demo/start.mjs        # needs uv; serves http://127.0.0.1:8787/
```

This runs the Python reference server (YouTube Music and Deezer search only). Options: `--check`
(diagnostics), `--rebuild`, `--port N` / `AIRWAVE_DISCOVERY_PORT`, `AIRWAVE_DISCOVERY_DATA`,
`AIRWAVE_DISCOVERY_HOST` (default `127.0.0.1`; do not expose it publicly). `launcher/install-shortcuts.ps1`
makes Desktop and Start Menu shortcuts for it. The shipped apps do not use it.

**Supported platform.** Tested on Windows 11 (x64) with Node 26.7, uv 0.12.3 and Python 3.13. The
code uses no Windows-only APIs, and every dependency publishes macOS and Linux wheels, but those
platforms were **not tested**.

### Optional: the audio model

Recommendations work without it, matched on metadata alone. To compare how songs sound, open
**Settings → Audio matching → Install**. That downloads 22,411,906 bytes (22.4 MB) from the
model's GitHub release
([NeptuneHub/AudioMuse-AI-DCLAP v1](https://github.com/NeptuneHub/AudioMuse-AI-DCLAP/releases/tag/v1))
into `.data/models/`. Settings shows the size before you install. The model runs on the CPU
through ONNX Runtime; no GPU or PyTorch is needed. Its license is AGPL-3.0 (see
[docs/LICENSES.md](docs/LICENSES.md)).

## Development

```sh
cd discovery-demo/server
PYTHONPATH= uv run --frozen pytest -q            # 73 unit and API tests, with no network access
PYTHONPATH= uv run --frozen pytest -q -m live    # 13 live checks against the running server (uses transfer allowance)

cd discovery-demo/web
node ../../node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node ../../node_modules/vite/bin/vite.js build    # or: dev (proxies /api to 127.0.0.1:8787)
```

The `PYTHONPATH=` prefix guards against shells that leak another Python's path into uv. The
launcher clears it for you.

Dependency locks: `server/uv.lock` (Python, exact pins in `server/pyproject.toml`) and the repo
root's `pnpm-lock.yaml` (web toolchain). `web/` is not a pnpm workspace member, so the demo adds
nothing to the monorepo's lockfile.

## Using it

1. Type a song title and press Enter (or Search), or paste a link. Results show the source each
   came from. Typing alone never counts as a preference; only **Add** makes a starting song.
2. Your starting songs sit on the shelf: any number, no duplicates (each extra song adds a few more service requests, so a long shelf takes longer). The star gives one song extra
   weight (2×). **Clear all** empties the shelf.
3. Choose **Similar**, **Discover** or **New releases**, and set Familiar ↔ Adventurous.
4. **Find my next favorite.** Songs matched on metadata arrive first, in under a second when
   cached. Audio comparison then refines the order without moving your focus or stopping playback.
5. Each song has Play/Open, Like, Dislike, Hide and **Why this song?** Likes and dislikes change
   the next queue. **Saved** lists your likes.
6. **Settings** holds the transfer allowances, export, reset, live source status, storage use and
   the optional sample data.

Keyboard: ↑/↓ or j/k move through the queue, Enter plays, and every control is reachable with Tab.
The click wheel is optional; everything it does is also a normal button.

## More

- [docs/CAPABILITIES.md](docs/CAPABILITIES.md): what each source does, tested on this machine.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how a recommendation is made.
- [docs/MEASUREMENTS.md](docs/MEASUREMENTS.md): startup, latency, memory, disk, transfer, test
  results.
- [docs/LICENSES.md](docs/LICENSES.md): dependency, model and data-source licenses.
- `docs/screenshots/`: captured from the running app at 1440, 768 and 390 px.
