# Baseline audit — Airwave discovery engine (jyoung2000/algDemo)

Date: 2026-11-01 · Branch: `recsys-v2` (from `main` @ 22ffd3e) · Engine: `web/src/engine/` (TypeScript, deterministic; Python sidecar `server/airwave_discovery` is the dev server + golden-test oracle).

Baseline verified before changes: **TS suite 209 passed / 1 skipped (25 files); Python suite 89 passed, 13 deselected.** Spec claims in the owner's brief checked against code; every item below has a code reference.

## Spec-vs-code verification

| Spec claim | Verdict | Where |
|---|---|---|
| Weights .35/.15/.15/.10/.10/.05/.05/.05 | Confirmed | `config.ts:63-65` |
| Missing factors excluded from weighted mean | Confirmed (with exceptions below) | `engine.ts:310-323, 366-373` |
| Seed blend .7 best + .3 emphasis mean | Confirmed | `config.ts:71`, `engine.ts:345` |
| Taste blend .85/.15 | Confirmed (`TASTE_WEIGHT=0.15`) | `taste.ts:34`, `engine.ts:379` |
| Coverage ×(.55+.45·coverage) | Confirmed | `config.ts:73`, `engine.ts:385` |
| Feedback weights +6/+5/+4/+3/−1/−3/−6, 45-day half-life | Confirmed | `config.ts:89-98` |
| Artist spillover halved; 3-skip threshold | Confirmed | `engine.ts:200, 203-206` |
| Dislike exclusion; hide 30 days | Confirmed | `engine.ts:193-194, 207-208` |
| Queue 30, max 2/artist, MMR, seed fairness, exposure | Confirmed | `config.ts:76-77`, `engine.ts:473-538` |
| ~512-d DCLAP embeddings for ~20 candidates | Confirmed: `audioCandidatesPerRequest: 20` | `config.ts:80`, `local-api.ts` enrich |
| Python parity maintained | Confirmed: golden fixtures `engine.golden.test.ts` vs `server/` suite | both suites green |

## Audited defect list (the ten named audits)

1. **Provider absence scored 0.0 despite "unknown is neutral" — CONFIRMED DEFECT (partial).** `engine.ts:293-295`: `f.provider = best ?? (asked ? 0.0 : null)`. `asked` is true when the candidate has *any* provenance from that seed — including non-counting relations (`search_match`, `genre_chart`, `RELATION[...][2]===false`). An Apple catalogue match (same catalogue, not a relatedness opinion) therefore scores provider **0.0** = active negative, not neutral. Also `asked` is true merely because `relatedArtists` was fetched for the seed, so in multi-seed runs every cross-seed candidate takes a 0.0 on the other seeds. The cross-seed case matches the documented intent ("not being in their lists is weak negative evidence") and is kept; the non-counting-provenance case is a defect. **Fixed in v2** (provider stays null when the candidate's only link to the seed is a non-counting relation).
2. **Best-provider max does not reward independent corroboration — CONFIRMED.** `engine.ts:285-292` takes `max` over counting provenance; a song found by YTM-related *and* Deezer artist-radio *and* SoundCloud scores the same as YTM alone. **Fixed in v2**: bounded corroboration bonus per extra *distinct provider family* (provenance is traced per relation source; duplicate entries from one family never stack), +0.08 each, cap +0.16, clamped to 1.
3. **Inferred seed genres masquerade as candidate evidence — CONFIRMED.** `infer.ts:98-104` (`inferFromSeed`) copies the best seed's leading tag onto the candidate at confidence 0.25, then `seedFactors` (`engine.ts:279`) computes genre similarity between the seed's tags and that copied tag → guaranteed hit (1.0 pair similarity × strength). The seed's own guess scores the candidate's fit *to the same seed*. **Fixed in v2**: seed-inferred tags are excluded from the genre factor (they remain for display/classification).
4. **Correlated evidence double-counted — PARTIALLY HANDLED.** Genre↔provider overlap is discounted (`engine.ts:314`, `genreProviderOverlap=0.5`) but (a) same-artist candidates get artist=1.0 *and* provider credit from `seed_artist_top` — one fact counted twice; (b) sound-inferred tags (`inferFromSound`) are derived from the same vectors as the audio factor, so genre correlates with audio when both present. **Fixed in v2**: provider weight halved when artist=1.0 and the best counting relation is `seed_artist_top`; sound-inferred tags excluded from the genre factor when an audio factor is present for that seed pair.
5. **Coverage punishes metadata-poor providers — CONFIRMED (bounded).** `engine.ts:382-385`: denominator is the sum of *all* affinity weights, including audio (effective ~0.35–0.46 of the pool). When no seed has a vector (no previews → nothing can have audio), every candidate's coverage is capped at ~0.54 and the multiplier applies a blanket penalty that distinguishes nobody but still depresses tiering (`coverage >= 0.4` gate at `engine.ts:440`). **Fixed in v2**: audio is removed from the coverage denominator when no seed in the run has a vector (pool-impossible evidence is not "missing" evidence).
6. **Audio enrichment of initial top-20 reinforces early bias — CONFIRMED.** `local-api.ts` enriches the first `audioCandidatesPerRequest=20` of the *pre-audio* ranking, so early metadata leaders get vectors (and audio score, and higher coverage) while the rest never do. **Fixed in v2**: band sampling — top 8, then deterministic strides through ranks 8–40 and 40–120, same budget of 20.
7. **Preview completion mistaken for full-track completion — CONFIRMED.** `Player.tsx` records `complete` after ≥20 s listened of a ~30 s preview; the event (`store.ts:183`) carries no medium or total duration, so a 20 s preview listen weighs the same (+3) as finishing a 6-minute track. **Fixed in v2**: events carry `medium`, `duration`, `listened`; preview completes are down-weighted and completion ratio qualifies the weight; duration unknown → no manufactured ratio.
8. **tanh saturation — CONFIRMED in stacking.** `feedbackFit` = `tanh(s/8)` (`engine.ts:227`); one song liked+saved+replayed+completed reaches s≈18 → tanh(2.25)≈0.978, and the 46th like of an artist moves nothing. The curve itself is fine for single events (like alone: tanh(0.75)=0.64); the defect is that one listening session stacks complete+replay+like+save as four independent endorsements. **Fixed in v2**: per-(track,day) behavioral events (complete/replay) count once at full weight + 50 % for the second, 0 beyond; explicit events unaffected; artist aggregation uses √(distinct positive tracks) rather than raw sums.
9. **Repeat events from retries/duplicate callbacks — CONFIRMED GAP.** Dedupe is by `event_id` (`store.ts:185`, UNIQUE + in-memory set) but `newEventId` (`api.ts:417-420`) embeds a fresh UUID per call, so a duplicated end-of-track callback or UI retry mints a *different* id and passes dedupe. **Fixed in v2**: the Player allocates one playback-instance nonce when a track loads; terminal events (`complete`/`skip`) for that instance reuse it, making duplicate callbacks idempotent.
10. **Arbitrary audio calibration / model identity — VERIFIED, documented, kept.** `calibrateAudio` maps cosine 0.3→0 and 0.85→1 (`engine.ts:93-95`) — admittedly arbitrary but harmless (monotone) and baked into golden fixtures; vectors are cached per model+preprocess id so incompatible spaces are never compared. Unchanged in v2; recalibration needs a labelled similarity set that does not exist locally.

## Other observations

- `ListenMeter` (`util.ts:87-102`) already guards against seek-inflation (only timeupdate deltas < 1.5 s while playing count) and pause time. Good; v2 adds unique-coverage tracking on top rather than replacing it.
- Impressions are recorded when rows are rendered (`App.tsx:177-182` gated on real results, deduped per session) — spec-compliant.
- Event-schema gap: no session id, no playback origin, no telemetry confidence, no schema version on rows. Added in v2 as optional columns (back-compatible with stored v1 rows).
- `replay` weight exists (`config.ts:93`) but nothing in the web UI ever emits a `replay` event (grep: only type unions). Dead signal in practice; v2 emits it when the same playback instance crosses the completion threshold a second time (loop) — at most once per instance.
- Taste (`taste.ts`) is a single 14-day-half-life store: no long-term/recent/session separation; one full listen writes complete (+ like if pressed) and both hit the same genre bucket — same correlated-evidence shape as #8. Addressed by the v2 taste split.
