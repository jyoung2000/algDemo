# Architecture

```
browser (React + Vite, web/)                       server (FastAPI, server/airwave_discovery/)
 Search ─ Shelf ─ Results ─ Player ─ Settings  ──►  app.py      routes, jobs, settings, status
        │ /api/* on 127.0.0.1:8787                  providers.py adapters: Deezer, YouTube Music, SoundCloud, Spotify
        ▼                                           net.py      allowlist, redirect checks, private-IP refusal, byte caps, backoff
 <audio> ◄── 307 ── /api/preview/deezer/{id}         candidates.py two-phase pipeline (metadata, then audio)
 (streams from Deezer's CDN to the browser)         engine.py   the one deterministic scorer and diversifier
                                                    identity.py recording identity, versions, collaborations
                                                    audio.py    DCLAP ONNX encoder, numpy mel front end
                                                    store.py    SQLite (WAL): seeds, feedback, impressions, caches, vectors
                                                    budget.py   storage footprint and hard caps
```

## A recommendation, step by step

1. **Seeds.** Only songs you Add become seeds (at least 1, no upper limit, de-duplicated by recording key). Search text
   is never a preference signal. Emphasis is 1× or 2×.
2. **Phase 1: metadata.** Each seed is matched to Deezer and YouTube Music. Source calls are
   spread across seeds so the first seed does not dominate. Calls cover related/radio, the seed
   artist's tracks, related artists, Deezer genre charts (exploration), and Deezer recent albums
   (new releases, 60-day window, day-precision dates only). Each source is capped at 40 candidates
   and the merge at 200. Duplicates are resolved early and provenance is kept. Seeds, dislikes and
   hidden songs are excluded. The first scored queue is published, typically within 1–5 s.
3. **Phase 2: audio.** If the model is installed, the seeds' 30-second Deezer previews and at most
   20 uncached top candidates are embedded on a single worker. Previews are decoded in memory,
   never written to disk, and each is capped at 1.5 MB on the wire. Cosine similarity feeds the
   `audio` factor and the queue is re-scored. The client keeps your focused row and playback.
4. **Budget.** Every byte the server downloads is metered on the wire (metadata and audio counted
   separately) against 20 MB per request and 100 MB per day. Going over stops that work cleanly.
   The audio step then says so and the metadata ranking stands.

## Scoring (`engine.py`)

- Factors and starting weights: audio 0.35, genre 0.15, artist 0.15, provider 0.10, feedback
  0.10, tempo 0.05, freshness 0.05, novelty 0.05. `validate_weights` rejects negative, missing or
  non-finite weights.
- Each component is clamped to 0–1. Missing evidence is `None`, not 0, and the weights are
  renormalised over factors that have evidence. Missing audio is never a penalty. Tempo has no
  measured source, so its weight is always absent.
- **Coverage adjustment:** `final = affinity × (0.55 + 0.45 × coverage)`. Coverage is the share
  of affinity weight with real evidence. A song backed by one weak signal therefore cannot
  outrank a well-supported one just because its other factors dropped out. Freshness and novelty
  describe the candidate, not the match, so they do not raise coverage.
- **Overlap:** when genre and provider evidence both exist, the genre weight is halved, so the two
  are not counted as independent proof.
- **Multi-seed:** affinity is computed per seed, then blended as 70% best seed + 30%
  emphasis-weighted mean. Unrelated taste clusters survive instead of averaging into nothing. The
  reason names the seed that supported the song.
- **Modes:** Similar raises seed/audio weight. Discover raises novelty and diversity. New releases
  uses freshness only when the date is reliable (day precision, `release` kind, named source).
- **Feedback:** seed +6 (session only), like +6, save +5, replay +4, completed listen +3,
  dislike −6, hide −3, with a 45-day half-life. Events are de-duplicated. One skip never touches
  an artist; 3 distinct observed skips are needed for weak artist propagation.
- **Selection:** soft tier quotas of 40% strong, 30% related, 20% emerging and 10% experimental,
  shifted by Familiar ↔ Adventurous. At most 2 songs per artist. Soft diversity on corroborated
  genre and audio. Exposure penalties expire after 7 days, and an impression is counted only
  when a result is shown. The diversified order is final and is never re-sorted.
- **Reasons** list the strongest real signals, evidence first. "Sounds close to …" appears only
  when an audio comparison exists. Scores are relative rankings and are never shown as a
  percentage match.

## Identity

`platform_id` (a provider's ID), the recording key (normalised artists + title + version tokens)
and the audio source (Deezer preview) are kept separate. Live, acoustic, remix, sped-up, cover
and similar versions stay distinct. Collaborations are split. ISRC is used when Deezer supplies
it. Uncertain matches go to the user as a choice and are never merged automatically.

## Persistence and storage

SQLite in WAL mode at `.data/airwave-discovery.db`. User data (seeds, settings, feedback, last
queue) is protected. Caches and vectors are LRU-evicted against the database budget, and writes
check free disk first. Vectors carry `MODEL_ID` and `PREPROCESS_ID` and are never compared across
either. The hard cap is 5,000,000,000 bytes across runtime, models, database, logs, temporary
audio and artwork, measured by `budget.py` and shown in Settings. Shared runtimes (uv's Python
store, pnpm store), the OS and browser caches are reported as not counted.

## Privacy

The server binds to 127.0.0.1. There is no telemetry, cookies or session tokens are never read,
and feedback stays in the local database. Export gives a JSON copy; Reset deletes it.

## Front end

Built on the Airwave window kit (`packages/aqua-ui/src/styles/airwave-window.css`), aqua-ui's
artwork and provider marks, with a pearl desk and an LCD-style now-playing panel. The click wheel
is an optional extra; every action is also a normal button or key. Narrow screens stack the shelf
and keep the bottom player clear of the last row.
