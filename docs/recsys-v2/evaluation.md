# Evaluation — recsys-v2 against the original engine

Date: 2026-11-01. Reproducible benchmark harness: `discovery-demo/web/src/engine/benchmark.ab.test.ts`; frozen pool and controlled scenario results: `D:/MusicRecommendationLab/benchmarks/frozen-pool-ab.json` and `scenario-ab.json`. Same clock, seed set, candidate set, and history slice for v1 and v2; chronological split uses only the earliest 70% (2 of 4 events) as training history. Retrieval was held fixed. Golden fixture is synthetic and is primarily a parity/invariant fixture, **not** ground truth human preference.

| Metric | Original | v2 | Interpretation |
|---|---:|---:|---|
| Golden frozen neutral queue | 26 items | 26 items | 26/26 overlap, no ranking difference |
| Neutral artist count / maximum | 14 / 2 | 14 / 2 | Original artist limit remains |
| Neutral genre count | 8 | 8 | No observed change |
| Neutral mean coverage | 0.4850 | 0.4850 | Both seeds had vectors |
| Neutral mean final score | 0.2886 | 0.2886 | Same score on v2-inert evidence |
| Familiar/adventurous queue overlap | 26/26 each | 26/26 each | Golden v1 path preserved |

**Why the golden pool is unchanged:** provenance has zero `source` fields in 66 rows, no same-day repeated playback events, no inferred candidate tags and vectors exist for both seeds. The frozen fixture cannot evaluate the new signals. Do **not** present unchanged scores as proof of better taste matching.

Controlled ablation/scenario (synthetic invariants only; not human-taste evidence):

| Path activated | v1 | v2 | Consequence |
|---|---:|---:|---|
| Six same-day preview completions of one song | feedback 17.889 | 2.683 | Diminishing returns and preview qualification stop loop-farming |
| Four full listens on four days | feedback 11.638 | 11.638 | Distinct-day evidence retained |
| No seed audio vector (same pool) | mean coverage 0.4444 | 0.7430 | Missing-impossible audio no longer flattens coverage |
| Three distinct source families | best relation strength | ≤ best + 0.16 | Bounded corroboration; same-family duplicates add zero (unit tested) |
| One accidental skipped song | no artist penalty | no artist penalty | Existing three-distinct-song threshold retained |

The scenario benchmark *adds* provenance families and controlled playback rows to the golden pool for this purpose. Its top corroborated examples did not necessarily move rank because diversity constraints, strong baseline relation scores and queue ties can dominate; the score factor test measures the bonus directly. Confidence handling and preview-vs-full qualification have dedicated unit tests, not a calibrated predictive uplift metric. Audio ablation is a coverage-counterfactual (vectors removed), **not** an audio-quality validation. Latency for full inference was not benchmarked end-to-end in this run; live browser discovery returned results but no durable per-stage timing comparison was recorded. Do not claim faster inference.

**Quality evidence:** baseline before edits 209 TypeScript tests passed / 1 skipped and 89 Python tests passed / 13 deselected. Final TypeScript suite after import and unique-coverage changes: 243 passed / 1 skipped (29 files), `tsc --noEmit` clean and `vite build` passed. Final Python suite: 105 passed / 13 deselected. Browser on localhost Python server performed a real search/discovery on existing seeds, showed a provider-corroborated explanation and an explicit no-audio evidence note; isolated browser QA on localhost:8766 imported a two-play Spotify fixture and re-import returned 0 new / 2 duplicate. A model-file HEAD request returned 405, so no live audio quality claim.

**Missing evaluation for a superiority claim:** consented personal listening sessions with actual impressions and observed negative signals, enough time for a chronological holdout, matched candidate exposures, precision/NDCG or recall on *observed* positives, exploration/diversity, artist concentration, repetition, provider coverage and latency. Unshown tracks must not be labelled negative; exposure bias and sparse history need explicit uncertainty intervals. No real history was read or exported for this report. Collaborative ALS/BPR is intentionally not trained on one user.
