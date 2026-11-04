'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createDownloads } = require('./downloads.cjs');

const scratch = path.join(process.env.LOCALAPPDATA, 'hermes', 'cache', 'scratch');
const url = (id) => `https://music.youtube.com/watch?v=${id}`;
const done = async (dl, id) => {
  for (let n = 0; n < 100; n++) {
    const job = dl.handle({ op: 'jobs' }).jobs.find((j) => j.id === id);
    if (['done', 'failed'].includes(job.state)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('download did not finish');
};
function fixture(t, bytes = 20) {
  fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, 'aw-cache-test-'));
  fs.writeFileSync(path.join(dir, 'yt-dlp.exe'), 'fixture');
  fs.writeFileSync(path.join(dir, 'ffmpeg.exe'), 'fixture');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfg = {
    toolsDir: dir, saveDir: path.join(dir, 'saved'), cacheDir: path.join(dir, 'cache'),
    tempRoot: path.join(dir, 'tmp'),
    spawnImpl(_program, args) {
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.pid = 0; child.kill = () => {};
      process.nextTick(() => {
        const jobDir = args[args.indexOf('--paths') + 1];
        fs.writeFileSync(path.join(jobDir, 'full-song.opus'), '');
        fs.truncateSync(path.join(jobDir, 'full-song.opus'), bytes);
        child.emit('close', 0);
      });
      return child;
    },
  };
  return { dir, dl: createDownloads(cfg) };
}

test('automatic full song stays in private quota cache; Keep copies it without deleting playback', async (t) => {
  const { dir, dl } = fixture(t);
  const source = url('dQw4w9WgXcQ');
  dl.handle({ op: 'cache-config', limitGb: 0.25, protected: [source] });
  const { job } = dl.handle({ op: 'start', url: source, tool: 'yt-dlp', format: 'original', label: 'Song', cache: true });
  const firstResult = await done(dl, job.id);
  assert.equal(firstResult.state, 'done', firstResult.error);
  assert.equal(dl.handle({ op: 'local', url: source }).file.bytes, 20);
  assert.equal(fs.existsSync(path.join(dir, 'saved', 'full-song.opus')), false);
  const kept = dl.handle({ op: 'keep', url: source }).job;
  assert.equal(kept.state, 'done');
  assert.equal(fs.existsSync(path.join(dir, 'saved', 'full-song.opus')), true);
  assert.equal(dl.handle({ op: 'local', url: source }).file.bytes, 20);
  assert.equal(dl.handle({ op: 'cache-config', limitGb: 0.25, protected: [] }).bytes, 20);
  dl.shutdown();
});

test('manual Keep during an automatic download persists when it completes', async (t) => {
  const { dl } = fixture(t);
  const source = url('aaaaaaaaaaa');
  const { job } = dl.handle({ op: 'start', url: source, tool: 'yt-dlp', format: 'original', label: 'Song', cache: true });
  assert.equal(dl.handle({ op: 'keep', url: source }).job.id, job.id);
  const result = await done(dl, job.id);
  assert.equal(result.state, 'done');
  assert.match(result.saved_to, /saved/);
  dl.shutdown();
});

test('LRU evicts old cache to stay under 0.25 GiB; protected playing song is never removed', async (t) => {
  const { dl } = fixture(t, 170 * 1024 * 1024);
  const a = url('aaaaaaaaaaa'), b = url('bbbbbbbbbbb');
  dl.handle({ op: 'cache-config', limitGb: 0.25, protected: [] });
  const first = dl.handle({ op: 'start', url: a, tool: 'yt-dlp', format: 'original', label: 'A', cache: true }).job;
  assert.equal((await done(dl, first.id)).state, 'done');
  const second = dl.handle({ op: 'start', url: b, tool: 'yt-dlp', format: 'original', label: 'B', cache: true }).job;
  assert.equal((await done(dl, second.id)).state, 'done');
  assert.equal(dl.handle({ op: 'local', url: a }).file, null);
  assert.equal(dl.handle({ op: 'local', url: b }).file.bytes, 170 * 1024 * 1024);
  assert.ok(dl.handle({ op: 'cache-config', limitGb: 0.25, protected: [b] }).bytes <= 0.25 * 1024 ** 3);
  const third = dl.handle({ op: 'start', url: a, tool: 'yt-dlp', format: 'original', label: 'A', cache: true }).job;
  assert.equal((await done(dl, third.id)).state, 'failed');
  assert.match(dl.handle({ op: 'local', url: a }).error, /protected songs/i);
  assert.ok(dl.handle({ op: 'local', url: b }).file);
  dl.shutdown();
});

test('health reports the queue cache usage and its limit, and reading it evicts nothing', async (t) => {
  const { dl } = fixture(t);
  const source = url('dQw4w9WgXcQ');
  dl.handle({ op: 'cache-config', limitGb: 0.25, protected: [source] });
  const { job } = dl.handle({ op: 'start', url: source, tool: 'yt-dlp', format: 'original', label: 'Song', cache: true });
  assert.equal((await done(dl, job.id)).state, 'done');
  const health = dl.handle({ op: 'health' });
  assert.equal(health.cache_bytes, 20);
  assert.equal(health.cache_limit_bytes, Math.floor(0.25 * 1024 ** 3));
  assert.equal(dl.handle({ op: 'local', url: source }).file.bytes, 20);
  dl.shutdown();
});
