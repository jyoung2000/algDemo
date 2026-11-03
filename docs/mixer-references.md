# Where the mixer's behaviour comes from

The crossfader in `web/src/engine/crossfade.ts` and `web/src/engine/audio-bus.ts` was written for
this app, but its *behaviour* was taken from established auto-DJ players rather than invented. This
file records what was read, what was taken, and what could not be.

## Licence boundary

This matters more than the attribution. Airwave Discovery must not become copyleft by accident.

| Project | Licence | What was done |
|---|---|---|
| [songs-automixer_python](https://github.com/LaRambla20/songs-automixer_python) | MIT | Behaviour studied. No code copied, but MIT would have permitted it with this notice. |
| [BKmasterplayer](https://github.com/thieggs/bkmasterplayer) | MIT | Behaviour studied. Same. |
| [BitChord](https://github.com/kushagrasinghx/BitChord) | **GPL-3.0** | Documented behaviour only. **No code read into this implementation** — linking it would force GPL-3.0 on this repo. |
| [Mixxx](https://github.com/mixxxdj/mixxx) | **GPL-2.0** | Documented behaviour only, same reason. |
| [MixCanvas](https://github.com/sebedard-creator/MixCanvas) | **AGPL-3.0** | Documented behaviour only. AGPL is stricter still. |
| [ai-dj-generator](https://github.com/shenzi418/ai-dj-generator) | MIT | Read and rejected — see below. |

Behaviour is not copyrightable; an implementation is. Everything below was implemented from
scratch against the behaviour these projects document.

## What was taken

**Equal-power crossfade as the fallback** (`equalPower`). BitChord's automix "falls back to a normal
equal-power crossfade when it cannot mix a pair cleanly". That is exactly the right default: a
linear pair dips about 3 dB in the middle and is heard as a sag. Ours holds `out² + in² = 1`.

**A 12-second ceiling.** BitChord's crossfade is "adjustable 0–12s". We arrived at 12s independently
from `MAX_TRACK_FRACTION` (40% of a 30-second preview); the agreement is a useful check that the
bound is sane rather than arbitrary.

**Bar-quantised transitions** (`quantizeToBars`). The single most important thing these projects do
that a plain volume ramp does not. BKmasterplayer states the criticism directly: *"Crossfade is a
volume ramp; it does not care that one song mixes on the bar, the way a DJ would."*
songs-automixer_python snaps its mix point "to the nearest bar". Ours snaps **down** to whole bars
of the outgoing song, never up, because rounding up would push the blend past the end of the track.

**Half and double time count as a match** (`tempoRelation`). songs-automixer_python flags "a 64 BPM
track against a 128 BPM track" as mixable. They share a beat grid, so refusing the pair would reject
a transition that works. Those pairs get no tempo nudge at all — the grids already coincide.

**Pitch-preserving tempo nudge** (`tempoNudge`, applied via `preservesPitch`). BKmasterplayer
"stretch[es] the tempo without touching the pitch"; songs-automixer_python uses Rubber Band for the
same end. A WebView cannot run Rubber Band, but `HTMLMediaElement.playbackRate` with
`preservesPitch` is the same idea at lower quality, so the nudge is capped at ±6%
(`MAX_TEMPO_NUDGE`) — beyond that it warbles, and two slightly different tempos sound better than
one smeared track.

**Transition styles** (`TransitionStyle`). The vocabulary is BKmasterplayer's: "bass swap, filter,
echo, blend or cut". We implement `cut`, `blend`, `bass-swap` and `filter`; `echo` is listed below
as not done.

**The bass handoff** (`BASS_DUCK_DB`). BitChord lists "bass handoffs" and BKmasterplayer a "bass
swap". Two basslines at full level is the worst artefact an auto-DJ produces — they are the loudest
part of each track and they fight. The incoming deck arrives with its lows shelved down and takes
them at the halfway point as the outgoing one gives them up.

## What was deliberately not taken

**Neural beat detection.** BKmasterplayer runs "Beat This!" and BitChord does on-device beat-grid
and key analysis. Both are far beyond what belongs in this WebView, and both note the cost — the
BKmaster docs say phone analysis "is slow and uses a smaller model", recommending a computer
pre-analyse the library. We use the BPM already in the catalogue instead, and when it is missing we
say so and fall back to a plain crossfade rather than guessing.

**Key matching / harmonic mixing.** Camelot-key matching needs key detection we do not have. A
clashing key is a real limitation of this mixer, not something it quietly handles.

**ACE-Step transition generation** (ai-dj-generator). It generates new audio around the transition
with a model needing an NVIDIA GPU or Colab. It cannot run on a phone, and the project is a course
exercise rather than a shipped player. Rejected on both counts.

**Stem separation / full phrase detection.** No intro/outro or vocal-presence analysis, so the
mixer cannot avoid mixing over a vocal. A known gap.

**Backspin, echo-out, gating.** songs-automixer_python has a backspin transition (with an SFX
sample) and a tempo-synced gate. Both need audio the preview does not contain or effects not yet
built. `echo` from BKmaster's style list is the obvious next one to add — a feedback delay on the
outgoing deck — and would fit the existing `TransitionStyle` union.

## The hard limit neither this nor any of them escapes here

Only Deezer-preview audio is reachable. YouTube and SoundCloud playback happens inside a
cross-origin iframe, and no page script can filter, fade or even measure it. Those references all
own their decoders (ExoPlayer, PortAudio, ffmpeg) and so have the samples; a WebView embedding
someone else's player does not. The mixer reports this rather than appearing broken — see
`REASON_TEXT` in `web/src/audio-engine.ts`.

A crossfade needs *both* songs under Web Audio control, so only preview→preview pairs can blend.

### What that forced, measured rather than assumed

With the crossfader at maximum on the real Windows app, **all ten songs tried played in YouTube's
iframe** — every one had a confident YouTube match, so the preview path was never chosen and the
mixer had nothing to work with. A correctly wired crossfader would still have done nothing.

So `mixerNeedsPreview` in `web/src/Player.tsx` makes the mixer's own choice explicit: while the
crossfader is on, a song that has a preview plays as that preview, and the YouTube lookup is
skipped entirely. This is the opposite of the default preference, and it is deliberate — the
alternative is a control that silently does nothing. The listener is told plainly in Settings, and
the trade is 30 seconds a song, mixed, instead of full songs that cannot be.

This is also why the lookup is skipped rather than merely ignored: while it ran, the song's source
counted as unresolved, and the player's load effect tore down the deck the blend had just handed
over.

