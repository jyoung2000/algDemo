// Electron main process for the DSP parity reference renderer (see CONTRACT.md, README.md).
// Loads the esbuild bundle of harness.ts in a hidden window, renders every scenario in Chromium's
// OfflineAudioContext, and writes <scenario>.f32 + manifest.json from this (main) process.
//
// Args: --bundle-dir=<dir with page.html + harness.js> --out=<fixture dir> --repo=<discovery-demo>
'use strict';

const { app, BrowserWindow } = require('electron');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) throw new Error(`missing --${name}=`);
  return hit.slice(name.length + 3);
}

app.disableHardwareAcceleration();

async function run() {
  const bundleDir = arg('bundle-dir');
  const outDir = arg('out');
  const repo = arg('repo');
  fs.mkdirSync(outDir, { recursive: true });

  const win = new BrowserWindow({
    show: false,
    webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true },
  });
  await win.loadFile(path.join(bundleDir, 'page.html'));

  const meta = await win.webContents.executeJavaScript('({ sampleRate: DspParity.SAMPLE_RATE, channels: DspParity.CHANNELS, quantum: DspParity.QUANTUM, scenarios: DspParity.scenarios() })');
  const webEngineCommit = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%H', '--', 'web/src/engine'], { encoding: 'utf8' }).trim();

  const stableAfter = Number(process.env.DSP_PARITY_STABLE_AFTER || 150);
  const summation = [];
  for (const sc of meta.scenarios) {
    const r = await win.webContents.executeJavaScript(`DspParity.renderCanonical(${JSON.stringify(sc.name)}, ${stableAfter})`);
    const bytes = Buffer.from(r.base64, 'base64');
    const want = sc.frames * meta.channels * 4;
    if (bytes.length !== want) throw new Error(`${sc.name}: got ${bytes.length} bytes, want ${want}`);
    fs.writeFileSync(path.join(outDir, sc.file), bytes);
    summation.push({ name: sc.name, variants: r.variants, renders: r.renders, maxSpread: r.maxSpread, sha256: r.sha256 });
    console.log(`wrote ${sc.file} (${bytes.length} bytes; ${r.variants} variant(s) in ${r.renders} renders, spread ${r.maxSpread.toExponential(2)})`);
  }

  const manifest = {
    generator: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      createdAt: new Date().toISOString(),
      webEngineCommit,
      // Chromium sums a node's inputs in pointer-hash order, so the same graph renders to a few
      // float-rounding variants; each fixture is the smallest-sha256 variant (see README.md).
      summationOrder: { rule: 'smallest-sha256-of-all-variants', stableAfter, scenarios: summation },
    },
    sampleRate: meta.sampleRate,
    channels: meta.channels,
    quantum: meta.quantum,
    scenarios: meta.scenarios.map((s) => ({
      name: s.name,
      frames: s.frames,
      file: s.file,
      inputs: s.inputs,
      initialEq: s.initialEq,
      actions: s.actions,
    })),
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`wrote manifest.json (${manifest.scenarios.length} scenarios, chrome ${process.versions.chrome})`);
  win.destroy();
}

app.whenReady()
  .then(run)
  .then(() => app.exit(0))
  .catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    app.exit(1);
  });
