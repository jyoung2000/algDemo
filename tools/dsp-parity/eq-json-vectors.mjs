#!/usr/bin/env node
/**
 * Vectors for the Kotlin port of eq.ts `parseEq` (android/.../engine/EqJson.kt): the real, unmodified
 * web/src/engine/eq.ts is bundled with esbuild and run on a set of inputs, good and hostile, and each
 * input with its parsed config is written to android/app/src/test/resources/eq-json/vectors.json.
 * EqJsonTest feeds the same inputs to the port and requires identical configs.
 *
 *   node tools/dsp-parity/eq-json-vectors.mjs [--out=<file>] [--scratch=<dir>]
 */
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
const outFile = path.resolve(opt('out', path.join(repo, 'android/app/src/test/resources/eq-json/vectors.json')));
const scratch = path.resolve(opt('scratch', os.tmpdir()));
const source = path.join(repo, 'web/src/engine/eq.ts');

const esbuild = require('esbuild');
fs.mkdirSync(scratch, { recursive: true });
const bundle = path.join(scratch, `eq-${process.pid}-${Date.now()}.mjs`);
await esbuild.build({ entryPoints: [source], outfile: bundle, bundle: true, format: 'esm', platform: 'node', target: 'es2022', logLevel: 'warning' });
const eq = await import(pathToFileURL(bundle).href);
fs.rmSync(bundle, { force: true });

const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

// Inputs are JSON text: that is what crosses the bridge, so values JSON cannot carry are not cases.
const inputs = [
  null,
  {},
  eq.EQ_DEFAULTS,
  { on: true, presetId: 'rock', gains: [5, 4, 3, 1, -1, -1, 1, 3, 4, 5], preampDb: -3, limiter: true },
  { on: true, presetId: 'custom', gains: [12, -12, 12, -12, 12, -12, 12, -12, 12, -12], preampDb: 6, limiter: true, toneHz: null, toneDb: 6 },
  { on: true, presetId: 'solfeggio-528', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], toneHz: 528, toneDb: 6 },
  { on: true, toneHz: 527.9, toneDb: 6 },
  { on: true, toneHz: '528' },
  { on: true, toneHz: 963, toneDb: 40 },
  { on: true, toneHz: 174, toneDb: -40 },
  { on: 'true', presetId: '', limiter: 'false' },
  { on: 1, limiter: false },
  { gains: [99, -99, '3', 'x', null, true, false, '', ' 2 ', 1e309 > 0 ? 1e300 : 0] },
  { gains: [1, 2, 3] },
  { gains: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
  { gains: 'loud' },
  { gains: {} },
  { preampDb: 13 },
  { preampDb: -13.5 },
  { preampDb: '4' },
  { preampDb: 'NaN' },
  { preampDb: null },
  { presetId: 7 },
  { presetId: 'x'.repeat(80) },
  { toneDb: 'abc', toneHz: 285 },
  { toneDb: null, toneHz: 396 },
];

const cases = inputs.map((input) => {
  const json = JSON.stringify(input);
  return { input: json, output: eq.parseEq(JSON.parse(json)) };
});

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify({
  source: 'web/src/engine/eq.ts parseEq',
  commit: git('log', '-1', '--format=%H', '--', 'web/src/engine/eq.ts'),
  dirty: git('status', '--porcelain', '--', 'web/src/engine/eq.ts') !== '',
  sha256: crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'),
  generator: 'tools/dsp-parity/eq-json-vectors.mjs',
  cases,
}, null, 1) + '\n');
console.log(`${cases.length} parseEq vectors -> ${path.relative(repo, outFile)}`);
