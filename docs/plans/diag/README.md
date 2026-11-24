# diag/ — not supplied

The plan `2026-11-24-recsys-shuffle-mood.md` refers to `diag/*.diag.test.ts` measurement files. They were never supplied
with the plan, so they are not in this repository.

WP0 step 4 quality tests were derived instead from the plan's sections 3 (findings) and 4 (targets), on the real code
with seeded random sources and fake data:

- `web/src/engine/quality/recsys.quality.test.ts`: A1/A4 (WP1), A2 (WP2), A3 (WP3), through LocalApi with a fake Deezer.
- `web/src/engine/quality/shuffle.quality.test.ts`: section 3.4 shuffle facts, S3/S4 (WP4), S1/S2 (WP5).
- `web/src/engine/quality/mood.quality.test.ts`: M1/M2 (WP6) and the section 3.4 mood example.
- `web/src/engine/quality/fixtures.ts`: seeded generator, queue rows, fake Deezer.

Targets of packages not landed yet are `it.fails`; when a package lands, its `it.fails` starts failing the run and is
turned into a plain `it`. Some sample sizes are smaller than the plan's (noted in comments) to keep the folder fast; the
measured values are far from the bounds at those sizes. The harness values differ from the plan's diag numbers (for
example the passive session moves 147 rows here, 166 in the plan) because the fixtures are not the diag ones.

Run from `web/`: `node ../../node_modules/vitest/vitest.mjs run --root . --dir src src/engine/quality`.
