#!/usr/bin/env node
// Regenerates the DSP parity fixtures (see CONTRACT.md): bundles harness.ts with esbuild, then runs
// it in the repo's Electron (Chromium OfflineAudioContext) via electron-main.cjs.
//
//   node tools/dsp-parity/render-reference.mjs [--out=<dir>] [--profile=<electron user-data-dir>]
//
// Defaults: --out = android/app/src/test/resources/dsp-parity, --profile = $DSP_PARITY_PROFILE or
// <os tmp>/dsp-parity-profile. esbuild and electron resolve from the monorepo root node_modules.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const require = createRequire(import.meta.url);

const opt = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const outDir = path.resolve(opt('out', path.join(repo, 'android/app/src/test/resources/dsp-parity')));
const profile = path.resolve(opt('profile', process.env.DSP_PARITY_PROFILE ?? path.join(os.tmpdir(), 'dsp-parity-profile')));
const bundleDir = path.join(here, '.out');

const esbuild = require('esbuild');
fs.mkdirSync(bundleDir, { recursive: true });
await esbuild.build({
  entryPoints: [path.join(here, 'harness.ts')],
  outfile: path.join(bundleDir, 'harness.js'),
  bundle: true,
  format: 'iife',
  globalName: 'DspParity',
  platform: 'browser',
  target: 'es2022',
  logLevel: 'warning',
});
fs.writeFileSync(
  path.join(bundleDir, 'page.html'),
  '<!doctype html><meta charset="utf-8"><title>dsp-parity</title><script src="harness.js"></script>\n',
);

const electron = require('electron'); // the package's main export is the binary path
const child = spawn(
  electron,
  [`--user-data-dir=${profile}`, path.join(here, 'electron-main.cjs'), `--bundle-dir=${bundleDir}`, `--out=${outDir}`, `--repo=${repo}`],
  { stdio: 'inherit', windowsHide: true },
);
const code = await new Promise((resolve) => child.on('exit', (c) => resolve(c ?? 1)));
if (code !== 0) {
  console.error(`electron exited with ${code}`);
  process.exit(code);
}
console.log(`fixtures in ${outDir}`);
