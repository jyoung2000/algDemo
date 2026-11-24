# Prompts for Claude Code and Codex — jPlay recsys / shuffle / mood plan

Put `jplay-recsys-shuffle-mood-plan.md` in the repo first as
`discovery-demo/docs/plans/2026-11-24-recsys-shuffle-mood.md`, and the three `diag/*.diag.test.ts` files in
`discovery-demo/docs/plans/diag/`. Every prompt below points at those paths.

Suggested split (each agent reviews the other's pull requests):

| Agent | Packages | Why |
|---|---|---|
| Codex | WP0, WP3, WP7, WP8, WP9 | Self-contained files; WP0 makes a cloud checkout runnable |
| Claude Code | WP1 → WP2 → WP4 → WP5 → WP6 → WP10 | One chain through `local-api.ts`, `shuffle-order.ts`, `mood-queue.ts`, `App.tsx`; must be done in order |

WP3 can run at the same time as WP1–WP2 (different functions of `local-api.ts`; rebase before merge).
WP7 starts only after WP4 and WP5 are merged.

---

## 1. Implement one package (Claude Code or Codex)

Replace `WPn` and paste.

```
Task: implement WPn from discovery-demo/docs/plans/2026-11-24-recsys-shuffle-mood.md. Only WPn.

Read first, in this order, and nothing else until you need it:
1. Sections 5 (WPn only), 6 and 7 of the plan.
2. The finding rows WPn names in section 3 (for example A1, A4).
3. The exact line ranges those rows cite. Grep, then read only the range.

Rules:
- Branch: fix/wpn-<short-name>. One pull request. No version bump, no release notes.
- Write the failing test first. If WP0 is merged, flip the matching `it.fails` in
  web/src/engine/quality/; otherwise add the test next to the code you change.
- Do not change select(), the v1 path of scoreOne, buildFeedback (v1) or anything under engine/golden/.
  engine.golden.test.ts must pass unchanged. Leave server/ alone.
- Keep the owner's rule ids in comments. If you alter one of those rules, name the rule and the
  decision (D1-D4) from section 6 in the comment and in the pull request.
- An owner decision that is not answered: use the default in section 6 and say so in the pull request.
- If the code no longer matches a line number or a claim in the plan, stop and report what you found
  instead of adapting the fix.
- Lean session: grep before reading, read ranges not files, cap shell output to the last 40 lines,
  run only the changed files' tests while working.

Verify once at the end, from discovery-demo/web:
  node ../../node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
  node ../../node_modules/vitest/vitest.mjs run --root . --dir src
(Kotlin packages: from discovery-demo/android run the unit tests for the classes you touched.)

Finish with a pull request description that has exactly these parts:
  What changed (files, 5 lines at most)
  Findings fixed (ids) and the section 4 metric before -> after, measured
  Decisions used (D-ids and values)
  Not done / follow-ups
Then write session-notes.md (state, next package, files touched).
```

## 2. Start with WP0 in a cloud checkout (Codex)

```
Task: WP0 from discovery-demo/docs/plans/2026-11-24-recsys-shuffle-mood.md.

Setup in this checkout: `pnpm install --frozen-lockfile` at the root, then `npm ci` in discovery-demo/web.
Expected today: the web tests do not start ("Cannot find package 'vite'") and engine/store.test.ts cannot
load fake-indexeddb. Fixing that is step 1 of WP0. Do not use --shamefully-hoist as the final answer
unless it is committed as .npmrc; say which option you chose and why.

Then do steps 2-4 of WP0. For step 4, copy docs/plans/diag/*.diag.test.ts into
web/src/engine/quality/ as *.quality.test.ts, replace each writeFileSync report with assertions on the
section 4 targets, and mark each target `it.fails` so the suite is green now.
Also assert the "must not regress" facts of section 3.4 as normal passing tests.

Done when: clean clone -> install -> full suite green, and no `D:` folder is created under web/.
Follow the rules and the finish format of prompt 1.
```

## 3. Review the other agent's pull request

```
Review pull request <link> against WPn of discovery-demo/docs/plans/2026-11-24-recsys-shuffle-mood.md.
You did not write this change. Read the diff and the plan's WPn; do not re-read whole files.

Check, and answer each with yes / no and one line of evidence (file:line):
1. Does it change only what WPn lists? Name anything outside it.
2. Is every section 4 target for WPn asserted by a test that failed before and passes now?
   Run those tests and report the numbers you measured.
3. Does engine.golden.test.ts pass unchanged? Is select(), scoreOne's v1 path, buildFeedback (v1)
   or server/ touched?
4. Is an owner rule (SHUFFLE-ONCE-001, ARTIST-RUN-001, MOOD-QUEUE-001, MOOD-NOW-001, QUEUE-ADD-001,
   QUEUE-NEVER-DRY-001, SHUFFLE-NEXT-001, SHUFFLE-ORDER-001) altered without naming a decision?
5. One realistic input the new code handles wrongly, if you can find one. Write it as a failing test.

Do not fix anything. Return findings most severe first, then "approve" or "changes needed".
```

## 4. Decisions to answer before WP5 and WP6 (for Jalon)

Reply with a line such as `D1 default, D2 yes, D3 8/4/2, D4 default` and paste it into the WP5 / WP6 prompt.

- **D1** Heard songs in Discover shuffle: rest 30 days (starred 14) and then return, or never return?
- **D2** May the song playing count less toward the mood until 45 seconds of it are heard?
- **D3** How hard the mood pulls a shuffle: weight ratio Familiar / middle / Adventurous (default 8 / 4 / 2).
- **D4** Variety when only letting songs play: share of the next 12 kept in engine order (default 10% / 20% / 35%).
