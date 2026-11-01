#!/usr/bin/env node
// Airwave Discovery — one launch command:  node discovery-demo/start.mjs
//
// First-run diagnostics, then: build the web app if its sources are newer than web/dist,
// and run the Python server on 127.0.0.1 (it serves the built app and the API on one port).
// Options: --check (diagnostics only), --rebuild, --port N (or AIRWAVE_DISCOVERY_PORT).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const portArg = args.indexOf('--port');
const port = Number(portArg >= 0 ? args[portArg + 1] : process.env.AIRWAVE_DISCOVERY_PORT || 8787);
const host = process.env.AIRWAVE_DISCOVERY_HOST || '127.0.0.1';

const ok = (m) => console.log(`  ok    ${m}`);
const warn = (m) => console.log(`  note  ${m}`);
const bad = (m) => console.log(`  FAIL  ${m}`);
let failed = false;

// The Hermes desktop app (and some shells) leak a PYTHONPATH that breaks uv's environment.
const env = { ...process.env, PYTHONPATH: '' };

function newest(dir) {
  let t = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? newest(p) : statSync(p).mtimeMs);
  }
  return t;
}

function portFree(p) {
  return new Promise((res) => {
    const s = net.createServer().once('error', () => res(false)).once('listening', () => s.close(() => res(true)));
    s.listen(p, host);
  });
}

console.log('Airwave Discovery — checks');
const major = Number(process.versions.node.split('.')[0]);
if (major >= 22) ok(`Node ${process.versions.node}`);
else (bad(`Node ${process.versions.node}: Node 22 or newer is needed`), (failed = true));

const uv = spawnSync('uv', ['--version'], { encoding: 'utf8', env });
if (uv.status === 0) ok(uv.stdout.trim());
else (bad('uv is not installed — https://docs.astral.sh/uv/getting-started/installation/'), (failed = true));

const vite = join(repo, 'node_modules', 'vite', 'bin', 'vite.js');
if (existsSync(vite)) ok('web toolchain (repo root node_modules)');
else (bad('web toolchain missing — run `pnpm install` at the repo root first'), (failed = true));

const model = join(process.env.AIRWAVE_DISCOVERY_DATA || join(here, '.data'), 'models', 'model_epoch_36.onnx');
if (existsSync(model)) ok('audio model installed (DCLAP epoch 36, 22.4 MB)');
else warn('audio model not installed — recommendations use metadata only. Install it from Settings → Audio matching.');

if (host !== '127.0.0.1' && host !== 'localhost') warn(`binding to ${host}: other machines on your network may reach this demo`);
if (await portFree(port)) ok(`port ${port} is free on ${host}`);
else (bad(`port ${port} is in use on ${host} — stop the other program or pass --port N`), (failed = true));

if (failed) {
  console.log('\nFix the items marked FAIL and run again.');
  process.exit(1);
}
if (flag('--check')) process.exit(0);

const web = join(here, 'web');
const dist = join(web, 'dist', 'index.html');
const stale = !existsSync(dist) || newest(join(web, 'src')) > statSync(dist).mtimeMs || newest(join(repo, 'packages', 'aqua-ui', 'src')) > statSync(dist).mtimeMs;
if (stale || flag('--rebuild')) {
  console.log('\nBuilding the web app…');
  const b = spawnSync(process.execPath, [vite, 'build'], { cwd: web, stdio: 'inherit', env });
  if (b.status !== 0) process.exit(b.status ?? 1);
}

console.log(`\nStarting on http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/  (Ctrl+C to stop)\n`);
const srv = spawn('uv', ['run', '--frozen', 'uvicorn', 'airwave_discovery.app:app', '--host', host, '--port', String(port), '--no-access-log'], {
  cwd: join(here, 'server'),
  stdio: 'inherit',
  env: { ...env, AIRWAVE_DISCOVERY_PORT: String(port), AIRWAVE_DISCOVERY_HOST: host },
});
const stop = () => srv.kill();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
srv.on('exit', (code) => process.exit(code ?? 0));
