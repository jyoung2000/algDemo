#!/usr/bin/env node
// Regenerates the crossfade-planner parity vectors for the Kotlin port
// (android/app/src/main/java/com/nowplaying/discovery/engine/MixPlan.kt, checked by MixPlanTest.kt).
//
//   node tools/dsp-parity/mix-plan-vectors.mjs [--out=<file>] [--scratch=<dir>]
//
// It bundles the REAL web/src/engine/crossfade.ts with esbuild (resolved from the monorepo root
// node_modules), imports the bundle and evaluates every exported pure function over fixed grids.
// Defaults: --out = android/app/src/test/resources/mix-plan/vectors.json,
// --scratch = the OS temp dir (pass a native path: git-bash's TMPDIR=/tmp means C:	mp to node).
//
// Encoding (also written into the file's "encoding" field):
// - finite numbers are JSON numbers (JSON.stringify's shortest round-trip form);
// - NaN, Infinity and -Infinity are the strings "NaN", "Infinity", "-Infinity";
// - an `undefined` input is an ABSENT key; JS `null` is JSON null. The Kotlin port reads both as
//   `null` (unknown). For bpm and minPlayedFraction the TS treats null and undefined alike.
// - clampPlayThrough only gets numeric/NaN/undefined inputs: Number(v) coercion of strings, booleans
//   and JS null (Number(null) = 0 -> 50) is the Kotlin caller's job.
// - mixPlan.grid stores the axes once and one index per vector into mixPlan.plans (unique results),
//   in nested-loop order slider > outSeconds > inSeconds > minPlayedFraction > bpm (innermost).
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const require = createRequire(import.meta.url);

const opt = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const outFile = path.resolve(opt('out', path.join(repo, 'android/app/src/test/resources/mix-plan/vectors.json')));
const scratch = path.resolve(opt('scratch', os.tmpdir()));
const source = path.join(repo, 'web/src/engine/crossfade.ts');

const esbuild = require('esbuild');
fs.mkdirSync(scratch, { recursive: true });
const bundle = path.join(scratch, `crossfade-${process.pid}-${Date.now()}.mjs`);
await esbuild.build({ entryPoints: [source], outfile: bundle, bundle: true, format: 'esm', platform: 'node', target: 'es2022', logLevel: 'warning' });
const cf = await import(pathToFileURL(bundle).href);
fs.rmSync(bundle, { force: true });

const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const commit = git('log', '-1', '--format=%H', '--', 'web/src/engine/crossfade.ts');
const dirty = git('status', '--porcelain', '--', 'web/src/engine/crossfade.ts') !== '';
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');

/** NaN/±Infinity as strings; undefined stays undefined (the key is dropped by JSON.stringify). */
const enc = (v) => {
  if (v === undefined || v === null || typeof v !== 'number') return v;
  if (Number.isNaN(v)) return 'NaN';
  if (v === Infinity) return 'Infinity';
  if (v === -Infinity) return '-Infinity';
  return v;
};
const encPlan = (p) => ({
  seconds: enc(p.seconds),
  startAt: enc(p.startAt),
  label: p.label,
  requested: enc(p.requested),
  reason: p.reason,
  bars: enc(p.bars),
  tempo: p.tempo,
  rate: enc(p.rate),
  style: p.style,
  description: p.description,
});

const SLIDERS = [-5, 0, 1, 12, 12.4, 12.5, 24.5, 25, 25.5, 26, 37, 50, 51, 63, 75, 76, 88, 99, 100, 140, NaN];
const LENGTHS = [0, -3, NaN, Infinity, 0.2, 3, 7.5, 30, 95, 179.9, 213.37, 600];
const FRACTIONS = [undefined, 0.5, 0.75, 0.95, 1, 0.3, 1.2, NaN];
const BPM_PAIRS = [[undefined, undefined], [120, 120], [120, 123], [120, 60], [64, 128], [85, 150], [0, 120], [174, 87], [128, null]];

const sliderEdges = [-0.5, 0.49999999999999994, 0.5, 1.5, 2.5, 37.5, 50.5, 62.5, 99.5, 100.5, Infinity, -Infinity, 1e308, -1e308];
const sweep = Array.from({ length: 201 }, (_, i) => i / 2);
const sliderInputs = [...new Set([...SLIDERS, ...sliderEdges, ...sweep])];
const playThroughInputs = [undefined, NaN, Infinity, -Infinity, -20, 0, 49.4, 49.5, 50, 50.5, 72.5, 94.5, 95, 99.4, 99.5, 100, 100.5, 150];
const BPMS = [undefined, null, NaN, Infinity, -Infinity, -5, 0, 5e-324, 60, 64, 85, 87, 100, 113, 120, 123, 127, 127.2, 128, 130, 150, 174, 1e308];
const QSECONDS = [NaN, -Infinity, -1, -0, 0, 0.1, 1.9, 2, 2.1, 3.99, 4, 7.5, 9.99, 16, 30, 64, 1e300, Infinity];

const out = {
  encoding:
    'Finite numbers are JSON numbers; NaN/Infinity/-Infinity are the strings "NaN","Infinity","-Infinity"; ' +
    'an undefined input is an absent key and JS null is JSON null (Kotlin reads both as null = unknown). ' +
    'clampPlayThrough covers numeric/NaN/undefined only: Number(v) of strings/booleans/null is the caller\'s job. ' +
    'mixPlan.grid.index[k] points into mixPlan.plans for the k-th vector of the nested loops ' +
    'slider > outSeconds > inSeconds > minPlayedFraction > bpmPairs (innermost).',
  source: 'web/src/engine/crossfade.ts',
  commit,
  dirty,
  sha256,
  generator: 'tools/dsp-parity/mix-plan-vectors.mjs',
  constants: {
    MIX_LABELS: [...cf.MIX_LABELS],
    MIX_MIN: cf.MIX_MIN,
    MIX_MAX: cf.MIX_MAX,
    MIN_PLAYED_FRACTION: cf.MIN_PLAYED_FRACTION,
    PLAY_THROUGH_MIN: cf.PLAY_THROUGH_MIN,
    PLAY_THROUGH_MAX: cf.PLAY_THROUGH_MAX,
    PLAY_THROUGH_DEFAULT: cf.PLAY_THROUGH_DEFAULT,
    MAX_TRACK_FRACTION: cf.MAX_TRACK_FRACTION,
    MIN_USEFUL_SECONDS: cf.MIN_USEFUL_SECONDS,
    BEATS_PER_BAR: cf.BEATS_PER_BAR,
    MAX_TEMPO_NUDGE: cf.MAX_TEMPO_NUDGE,
    TEMPO_MATCH_TOLERANCE: cf.TEMPO_MATCH_TOLERANCE,
  },
  clampSlider: sliderInputs.map((v) => ({ in: enc(v), out: enc(cf.clampSlider(v)) })),
  clampPlayThrough: playThroughInputs.map((v) => ({ in: enc(v), out: enc(cf.clampPlayThrough(v)) })),
  requestedSeconds: sliderInputs.map((v) => ({ in: enc(v), out: enc(cf.requestedSeconds(v)) })),
  transitionStyle: sliderInputs.map((v) => ({ in: enc(v), out: cf.transitionStyle(v) })),
  mixBand: sliderInputs.map((v) => {
    const b = cf.mixBand(v);
    return { in: enc(v), label: b.label, lo: enc(b.lo), hi: enc(b.hi), mixLabel: cf.mixLabel(v) };
  }),
  barSeconds: BPMS.map((b) => ({ bpm: enc(b), out: enc(cf.barSeconds(b)) })),
  tempoRelation: [],
  tempoNudge: [],
  quantizeToBars: [],
  mixPlan: { grid: { sliders: SLIDERS.map(enc), lengths: LENGTHS.map(enc), fractions: FRACTIONS.map(enc), bpmPairs: BPM_PAIRS.map((p) => p.map(enc)), index: [] }, plans: [], random: [] },
};
for (const a of BPMS) {
  for (const b of BPMS) {
    out.tempoRelation.push({ outBpm: enc(a), inBpm: enc(b), out: cf.tempoRelation(a, b) });
    out.tempoNudge.push({ outBpm: enc(a), inBpm: enc(b), out: enc(cf.tempoNudge(a, b)) });
  }
}
for (const s of QSECONDS) {
  for (const b of BPMS) {
    const q = cf.quantizeToBars(s, b);
    out.quantizeToBars.push({ seconds: enc(s), bpm: enc(b), out: { seconds: enc(q.seconds), bars: enc(q.bars) } });
  }
}

// The dense grid: every combination, results deduplicated into `plans`.
const planIndex = new Map();
for (const slider of SLIDERS) {
  for (const o of LENGTHS) {
    for (const i of LENGTHS) {
      for (const f of FRACTIONS) {
        for (const [outBpm, inBpm] of BPM_PAIRS) {
          const inputs = {};
          if (f !== undefined) inputs.minPlayedFraction = f;
          if (outBpm !== undefined) inputs.outBpm = outBpm;
          if (inBpm !== undefined) inputs.inBpm = inBpm;
          const key = JSON.stringify(encPlan(cf.mixPlan(slider, o, i, inputs)));
          let idx = planIndex.get(key);
          if (idx === undefined) {
            idx = out.mixPlan.plans.length;
            planIndex.set(key, idx);
            out.mixPlan.plans.push(JSON.parse(key));
          }
          out.mixPlan.grid.index.push(idx);
        }
      }
    }
  }
}

// Off-grid values with full precision, from a fixed-seed generator so the file is reproducible.
let seed = 0x2f6b1d3;
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
for (let k = 0; k < 4000; k++) {
  const slider = rnd() * 110 - 5;
  const o = rnd() < 0.1 ? pick(LENGTHS) : rnd() * 400;
  const i = rnd() < 0.1 ? pick(LENGTHS) : rnd() * 400;
  const f = rnd() < 0.3 ? undefined : rnd() * 0.8 + 0.4;
  const bpmCase = rnd();
  const outBpm = bpmCase < 0.25 ? undefined : 60 + rnd() * 120;
  const inBpm = bpmCase < 0.25 ? undefined : bpmCase < 0.6 ? outBpm * (0.9 + rnd() * 0.2) * (rnd() < 0.3 ? 2 : 1) : 60 + rnd() * 120;
  const inputs = {};
  if (f !== undefined) inputs.minPlayedFraction = f;
  if (outBpm !== undefined) inputs.outBpm = outBpm;
  if (inBpm !== undefined) inputs.inBpm = inBpm;
  out.mixPlan.random.push({
    slider: enc(slider),
    outSeconds: enc(o),
    inSeconds: enc(i),
    minPlayedFraction: enc(f),
    outBpm: enc(outBpm),
    inBpm: enc(inBpm),
    plan: encPlan(cf.mixPlan(slider, o, i, inputs)),
  });
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(out) + '\n');
const scalar =
  out.clampSlider.length + out.clampPlayThrough.length + out.requestedSeconds.length + out.transitionStyle.length +
  out.mixBand.length + out.barSeconds.length + out.tempoRelation.length + out.tempoNudge.length + out.quantizeToBars.length;
const plans = out.mixPlan.grid.index.length + out.mixPlan.random.length;
console.log(
  `${scalar + plans} vectors (${out.mixPlan.grid.index.length} grid + ${out.mixPlan.random.length} random mixPlan, ` +
    `${out.mixPlan.plans.length} unique grid plans, ${scalar} helper) from crossfade.ts @ ${commit}${dirty ? ' (dirty)' : ''} -> ${outFile}`,
);
