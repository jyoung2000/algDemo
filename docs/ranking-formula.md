# Editing the discovery ranking formula (RANK-FORMULA-001)

In the standalone Android and Windows apps, open **Settings → Discovery algorithm**. Edit the expression or use **Paste formula**, review the illustrative preview, then **Save formula**. Copy exports the draft, not necessarily the applied formula. **Use default formula** fills the editor; save it to restore the built-in scorer. Normal keyboard/touch selection, copy and paste remain available when browser clipboard permission is unavailable.

The default is:

```text
affinity * (coverage_floor + (1 - coverage_floor) * coverage)
```

A replacement example is:

```text
0.7 * genre + 0.3 * novelty
```

This is a score expression, not arbitrary executable JavaScript or a replacement for the entire discovery pipeline. It applies to subsequent discovery scoring and listening re-ranks; saving does not replace the currently playing song or immediately replace the queue.

## Inputs

- `base`: the existing score before exposure/repetition penalties.
- `affinity`: the engine's seed/listening-taste affinity.
- `coverage`: evidence coverage; `coverage_floor`: the configured confidence floor.
- `audio`, `genre`, `artist`, `provider`, `feedback`, `tempo`, `freshness`, `novelty`, `taste`: actual normalized engine signals, each 0–1 when known.
- `has_audio`, `has_genre`, and equivalent `has_` flags for the other signals: 1 if known, 0 if missing. Missing signal values are 0, **not proof of negative evidence**.

Operators: `+ - * / ^` and parentheses. `^` is exponentiation, not JavaScript XOR. Functions: `min(a,b,...)`, `max(a,b,...)`, `abs(x)`, `sqrt(x)`, `pow(x,y)`, `log(x)`, `clamp(x,low,high)`. Min/max accept 2–16 arguments. The preview uses clearly labelled illustrative inputs, not invented song evidence.

## Boundaries

- Maximum 2,048 characters, 512 tokens and 32 parser nesting levels; only approved identifiers and functions.
- No eval, JavaScript statements, object/property access, filesystem or network operations.
- Common non-finite/domain errors fail validation. Unexpected non-finite results on actual songs fall back to that song's built-in score and are reported in its evidence.
- Custom results are bounded to 0–1; existing exposure penalties, hidden/unavailable exclusions, artist diversity and queue-selection rules still apply. Formula editing cannot change source eligibility, full-song playback, licensing rules or the audio DSP.
- Settings persist as `ranking_formula`; null/blank/the exact default expression removes the override. `PUT /api/settings` validates atomically and returns the accepted value. The UI refuses to claim Saved when an outdated engine does not echo it.
- The standalone apps share the TypeScript LocalApi/scorer. The legacy Python development sidecar does not implement this override; it must not be used to validate the shipped app's formula behaviour.

Tests cover real LocalApi/Store persistence and restart, ranking changes, exclusions, runtime fallback, bounded arithmetic/security, explicit UI save, copy/paste permission fallback and old-engine rejection. Signed APK smoke testing also edits/saves, restarts the process, verifies persistence and restores the default.

## Formula audit, 18 November 2026

The six formula lines shown in Profile and Settings were checked term by term against `web/src/engine/engine.ts` (`scoreOne`, `modeWeights`, `select`) by two independent reviewers (Claude Fable 5.2 reading the code; GPT-6 Astra reviewing the same code from a written brief). Both reached the same findings.

| Line | Matches the scorer? | What the scorer actually does |
| --- | --- | --- |
| seed fit | Partly | Averages audio, genre, artist, provider and tempo that have evidence. **Feedback is not in the average**; its seed-fit weight only counts towards coverage. Genre is halved when the services also relate the song. |
| blend | Yes | `bestSeedShare × best + (1 − bestSeedShare) × emphasis-weighted mean`. With one starting song the share changes nothing. |
| affinity | Yes | `seedWeight` is the sum of the seed-fit weights used for the best starting song. Global factors count only when known. |
| affinity′ | Original scorer only | With improved ranking on (the default) the taste share is not the fixed number: it grows with listening history from 0 to `0.25 × tasteWeight / 0.15`. No history means no taste step. |
| final | Yes | Custom final steps are clamped to 0–1 and fall back to this line when they fail. |
| ranked | Yes | Shows are counted over the last 7 days. |

Not in the six lines at all: the Familiar–Adventurous slider and "Prefer new releases" multiply weights before scoring, and the queue is then picked with tier shares, an artist limit, a similarity penalty and a turn for each starting song.

### What changed

- **FORMULA-NOTES-001.** The six lines are the owner's wording and are unchanged. Under them, Profile now lists "How the engine applies this formula": five sentences generated from the active algorithm's own numbers and from the same constants the scorer reads (`MODE_MULTIPLIERS`, `FRESH_WEIGHT_MULTIPLIER`, `genreProviderOverlap`, `TASTE2_MAX_WEIGHT`, `maxPerArtist`).
- **COVERAGE-FULL-001** (improved ranking only). The half of the genre weight set aside as a repeat of the services' evidence was still counted as evidence that could have been known, so a song with every kind of evidence read as 92% covered and lost about 4% of its score. That half now leaves both sides: full evidence is coverage 1. The original scorer is untouched.
- **NOVELTY-UNKNOWN-001** (improved ranking only). A song with no artist named was scored as a brand-new artist. It now has no novelty score.
- An algorithm whose weights are all 0 (apart from the seed-fit feedback weight, which scores nothing by itself) is refused: it would score every song 0.

### Proposals not taken, and why

- *Make dislikes and hides authoritative.* Already the case: `scoreAll` drops disliked and hidden songs before scoring.
- *Put feedback into the seed-fit average, as the first line reads.* It would count the same feedback twice (it is already a global factor). The note says what happens instead.
- *Shrink scores towards neutral by coverage instead of multiplying; scale the best-song share by how many starting songs have evidence; evidence-weighted provider corroboration; make the repeat penalty proportional.* Each changes the order of every queue. There is no listening data to show any of them is better, so they are recorded here as candidates rather than shipped as a guess.
- The Python development sidecar still does not implement named algorithms or custom formulas.

## Songs heard on the radio (RADIO-TASTE-001, 18 November 2026)

A song heard on a radio station counts towards the listener's algorithm the same way a song played in the player does, with two conditions: the song has to be **identified**, and it has to have been **heard**.

| What happened on the station | What is recorded | Weight next to a full listen in the player |
| --- | --- | --- |
| An identified song, 30 seconds or more of it heard | A part listen (`qualified`) | About a third |
| An identified song, 70% or more of its own length heard | A full listen (`complete`), in place of the part listen | 70%, less when under 90% of the song was heard |
| A programme, an advert, or a song nobody could identify | Nothing | 0 |
| The station's own tags ("jazz", "talk") | Nothing | 0 |

- **Identified** means an audio fingerprint named the recording, or the broadcaster named a song and the catalogue has that song by that artist. A title on its own is not enough.
- **Heard** is counted from the audio that was actually played: pausing, buffering and rewinding over the same seconds add nothing, and it can never exceed the recording's length. A song of unknown length is never a full listen.
- The 0.7 is the confidence of the event: an identification is not as sure as the listener choosing the song themselves.
- One listen is one event. The full listen replaces the part listen; if more of the song is heard after that, the same event is updated when the song is left. Reporting twice (the phone page and the background service both follow a station on Android) changes nothing.
- The event carries the song's own genres and tempo from the usual genre lookup. The note waits for that lookup, but never past the end of the listen.

What it changes in the ranking: the song, its artist and its album gain feedback weight; its genres and tempo enter the taste (long and recent); and those genres are among the ones discovery asks the services about. Profile shows the count under "Heard on radio" and marks the rows "radio".

### Found while doing this, not changed

**The "this session" third of the taste currently has no listens in it.** The engine compares each listen's session name with a private name of its own that no listen carries, so the session horizon is empty and taste uses the long + recent horizons. The owner chose **stable rankings across app restarts** on 18 November 2026 rather than a true session layer that resets at launch. Leave the current ranking unchanged; do not claim the session horizon is active. A future rolling short-term horizon would need its own specification and tests.
