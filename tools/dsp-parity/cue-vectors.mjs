#!/usr/bin/env node
// Regenerates the parity vectors for the Kotlin ports of the DJ-XFADE-001 maths:
//   web/src/engine/track-cues.ts  -> engine/TrackCues.kt   (checked by TrackCuesTest.kt)
//   web/src/engine/crossfade.ts   -> engine/MixPlan.kt     (cued plans, checked by MixPlanTest.kt)
//
//   node tools/dsp-parity/cue-vectors.mjs [--out=<file>] [--scratch=<dir>]
//
// It bundles the REAL TypeScript with esbuild and evaluates it over synthesised songs and a grid of
// cue combinations. The songs are generated from a formula both sides implement (see `song`), so no
// audio is stored: each case carries its spec and the cues the TypeScript measured.
// Encoding: finite numbers are JSON numbers; a missing grid or swap is JSON null.
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
const outFile = path.resolve(opt('out', path.join(repo, 'android/app/src/test/resources/track-cues/vectors.json')));
const scratch = path.resolve(opt('scratch', os.tmpdir()));

const esbuild = require('esbuild');
fs.mkdirSync(scratch, { recursive: true });
const load = async (name) => {
  const bundle = path.join(scratch, `${name}-${process.pid}-${Date.now()}.mjs`);
  await esbuild.build({ entryPoints: [path.join(repo, 'web/src/engine', `${name}.ts`)], outfile: bundle, bundle: true, format: 'esm', platform: 'node', target: 'es2022', logLevel: 'warning' });
  try {
    return await import(pathToFileURL(bundle).href);
  } finally {
    fs.rmSync(bundle, { force: true });
  }
};
const tc = await load('track-cues');
const cf = await load('crossfade');

/**
 * The synthetic song both sides build: a 220 Hz pad, xorshift32 hiss, and a decaying 60 Hz kick on
 * every beat; optional silence in front, a linear fade-out, silence behind, and a half-beat slip.
 * All arithmetic is float64 and the sample is rounded to float32 once, at the end.
 */
function song(spec) {
  const rate = tc.CUE_RATE;
  const n = Math.floor(spec.seconds * rate);
  const x = new Float32Array(n);
  const musicEnd = spec.seconds - spec.trail;
  const fadeFrom = musicEnd - spec.fade;
  let seed = spec.seed >>> 0;
  const beat = spec.bpm > 0 ? 60 / spec.bpm : 0;
  for (let i = 0; i < n; i += 1) {
    const t = i / rate;
    seed = (seed ^ (seed << 13)) >>> 0;
    seed = (seed ^ (seed >>> 17)) >>> 0;
    seed = (seed ^ (seed << 5)) >>> 0;
    if (t < spec.lead || t >= musicEnd) continue;
    const level = t > fadeFrom ? Math.max(0, (musicEnd - t) / spec.fade) : 1;
    let v = 0.08 * Math.sin(2 * Math.PI * 220 * t) + 0.02 * ((seed / 4294967296) * 2 - 1);
    if (beat > 0) {
      const origin = spec.first + (spec.slipAt >= 0 && t >= spec.slipAt ? beat / 2 : 0);
      const since = (((t - origin) % beat) + beat) % beat;
      if (t >= origin) v += 0.7 * Math.exp(-since * 28) * Math.sin(2 * Math.PI * 60 * since);
    }
    x[i] = v * level;
  }
  return x;
}

const spec = (o) => ({ seconds: 120, bpm: 0, first: 0, lead: 0, fade: 1, trail: 0, slipAt: -1, seed: 1, ...o });
const SONGS = [
  spec({ seconds: 150, bpm: 120, lead: 0.5, first: 0.5, fade: 4, trail: 1 }),
  spec({ seconds: 150, bpm: 90, lead: 0.5, first: 0.5, fade: 4, trail: 1, seed: 2 }),
  spec({ seconds: 140, bpm: 128, lead: 0.2, first: 0.31, fade: 6, trail: 2.5, seed: 3 }),
  spec({ seconds: 130, bpm: 140, first: 0.1, fade: 0.001, seed: 4 }),
  spec({ seconds: 160, bpm: 174, lead: 1.2, first: 1.2, fade: 8, trail: 0.4, seed: 5 }),
  spec({ seconds: 150, bpm: 100, first: 0.25, fade: 3, trail: 3, seed: 6 }),
  spec({ seconds: 150, bpm: 120, slipAt: 130, fade: 0.001, seed: 7 }),
  spec({ seconds: 120, seed: 9, fade: 5, trail: 1 }),
  spec({ seconds: 70, bpm: 96, lead: 0.3, first: 0.3, fade: 2, trail: 0.5, seed: 10 }),
  spec({ seconds: 30, bpm: 110, fade: 1, seed: 11 }),
  spec({ seconds: 6, bpm: 110, fade: 0.5, seed: 12 }),
];
const grid = (g) => (g ? { bpm: g.bpm, beatAt: g.beatAt, confidence: g.confidence } : null);
const cuesOut = (c) => ({ duration: c.duration, start: c.start, end: c.end, fullEnd: c.fullEnd, head: grid(c.head), tail: grid(c.tail) });

const songs = SONGS.map((s) => ({ spec: s, cues: cuesOut(tc.analyseCues(song(s), tc.CUE_RATE)) }));
// The same song measured from its two ends alone, as the phone does.
const ends = SONGS.filter((s) => s.seconds >= 130).map((s) => {
  const x = song(s);
  const head = Math.floor(50 * tc.CUE_RATE);
  const tail = Math.floor(80 * tc.CUE_RATE);
  return { spec: s, headFrames: head, tailFrames: tail, cues: cuesOut(tc.analyseEnds(x.subarray(0, head), x.subarray(x.length - tail), tc.CUE_RATE, s.seconds)) };
});

// Cued plans: every combination of measured outgoing/incoming song above plus hand-made edge cases.
const plan = (p) => ({ seconds: p.seconds, startAt: p.startAt, endAt: p.endAt, inStart: p.inStart, rate: p.rate, swapAt: p.swapAt, swapSeconds: p.swapSeconds, beat: p.beat, bars: p.bars, tempo: p.tempo, style: p.style, reason: p.reason, label: p.label, requested: p.requested, description: p.description });
const g = (bpm, beatAt, confidence = 3) => ({ bpm, beatAt, confidence });
const c = (o) => ({ duration: 200, start: 0, end: 200, fullEnd: 200, head: null, tail: null, ...o });
const HAND = [
  [c({ end: 197, fullEnd: 194 }), c({ duration: 180, start: 0.4, end: 180, fullEnd: 180 })],
  [c({ end: 200, fullEnd: 198, tail: g(120, 193.25) }), c({ duration: 180, start: 0.4, head: g(120, 0.62) })],
  [c({ end: 200, fullEnd: 198, tail: g(120, 193.25) }), c({ duration: 180, head: g(124, 0.5) })],
  [c({ end: 200, fullEnd: 198, tail: g(120, 193.25) }), c({ duration: 180, head: g(62, 0.5) })],
  [c({ end: 200, fullEnd: 198, tail: g(120, 193.25) }), c({ duration: 180, start: 0.3, head: g(96, 0.3) })],
  [c({ end: 200, fullEnd: 198, tail: g(120, 193.25, 0.6) }), c({ duration: 180, head: g(120, 0.5) })],
  [c({ end: 198, fullEnd: 170, tail: g(60, 169.7) }), c({ duration: 180, start: 0.4 })],
  [c({ end: 189, fullEnd: 186 }), c({ duration: 180, start: 0.4 })],
  [c({ end: 200, fullEnd: 199 }), c({ duration: 8, end: 8, fullEnd: 8 })],
  [c({ end: 200, fullEnd: 198, tail: g(87.3, 99.9) }), null],
  [c({ end: 200, fullEnd: 198, tail: g(174, 150.01) }), c({ duration: 240, start: 1.1, head: g(86.2, 1.3) })],
];
const cases = [];
const push = (slider, share, out, inn, maxNudge) => {
  const outSeconds = out.duration;
  const inSeconds = inn ? inn.duration : 180;
  const inputs = { minPlayedFraction: share, outCues: out, inCues: inn };
  if (maxNudge !== undefined) inputs.maxNudge = maxNudge;
  cases.push({ slider, minPlayedFraction: share, maxNudge: maxNudge === undefined ? null : maxNudge, outSeconds, inSeconds, outCues: out, inCues: inn, plan: plan(cf.mixPlan(slider, outSeconds, inSeconds, inputs)) });
};
for (const [out, inn] of HAND) for (const slider of [0, 10, 25, 40, 60, 100]) for (const share of [0.5, 0.95, 1]) push(slider, share, out, inn);
for (const [out, inn] of HAND.slice(1, 5)) push(40, 0.95, out, inn, 0);
for (const a of songs) for (const b of songs) for (const slider of [20, 40, 80]) push(slider, 0.95, a.cues, b.cues);

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, `${JSON.stringify({ generator: 'tools/dsp-parity/cue-vectors.mjs', rate: tc.CUE_RATE, songs, ends, plans: cases })}\n`);
console.log(`wrote ${outFile} (${songs.length} songs, ${ends.length} from the ends, ${cases.length} plans)`);
