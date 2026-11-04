'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createDownloads } = require('./downloads.cjs');



test('wanted retains far playlist jobs; invalid configuration leaves the previous selection intact', async (t) => {
  const { dl } = fixture(t);
  const a = url('aaaaaaaaaaa'), far = url('zzzzzzzzzzz');
  const job = dl.handle({ op: 'start', url: far, tool: 'yt-dlp', format: 'original', cache: true, background: true }).job;
  dl.handle({ op: 'cache-config', limitGb: 0.25, protected: [a], wanted: [a, far] });
  assert.notEqual(dl.handle({ op: 'jobs' }).jobs.find(j => j.id === job.id).state, 'cancelled');
  assert.throws(() => dl.handle({ op: 'cache-config', limitGb: 0.25, protected: [a], wanted: ['https://evil.example/song'] }), /wanted/i);
  assert.throws(() => dl.handle({ op: 'cache-config', limitGb: 0.25, protected: [a, far, url('3'), url('4')] }), /protected/i);
  assert.equal((await done(dl, job.id)).state, 'done');
  const stale = dl.handle({ op: 'start', url: url('stale'), tool: 'yt-dlp', format: 'original', cache: true, background: true }).job;
  dl.handle({ op: 'cache-config', limitGb: 0.25, protected: [a] });
  assert.equal(dl.handle({ op: 'jobs' }).jobs.find(j => j.id === stale.id).state, 'cancelled');
});


function controlled(t) {
  const { dir } = fixture(t);
  const active = [];
  const dl = createDownloads({ toolsDir: dir, saveDir: path.join(dir, 'music'), cacheDir: path.join(dir, 'other-cache'), tempRoot: path.join(dir, 'work'),
    spawnImpl(_exe, args) {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      active.push({ url: args.at(-1), finish(bytes = 20) {
        const file = path.join(args[args.indexOf('--paths') + 1], 'song.opus');
        fs.writeFileSync(file, ''); fs.truncateSync(file, bytes); child.emit('close', 0);
      } });
      return child;
    } });
  return { dl, active, dir };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const start = (dl, id, background = true) => dl.handle({ op: 'start', url: url(id), tool: 'yt-dlp', format: 'original', cache: true, background }).job;

test('two background slots and independent foreground slot; queued background promotes without duplicates', async t => {
  const { dl, active } = controlled(t);
  const a = start(dl, 'a'), b = start(dl, 'b'), c = start(dl, 'c');
  await tick();
  assert.deepEqual(active.map(j => j.url), [url('a'), url('b')]);
  assert.equal(start(dl, 'c', false).id, c.id);
  assert.equal(start(dl, 'a', false).id, a.id);
  start(dl, 'd', false);
  await tick();
  assert.deepEqual(active.map(j => j.url), [url('a'), url('b'), url('c')]);
  active[2].finish(); await tick();
  assert.deepEqual(active.map(j => j.url), [url('a'), url('b'), url('c'), url('d')]);
  active[0].finish(); active[1].finish(); active[3].finish();
  assert.equal((await done(dl, b.id)).state, 'done');
  await tick();
});


test('background quota never churns wanted songs; foreground can evict wanted but not protected', async t => {
  const { dl } = fixture(t, 170 * 1024 * 1024);
  dl.handle({ op: 'cache-config', limitGb: 0.25, protected: [], wanted: [url('a'), url('b')] });
  assert.equal((await done(dl, start(dl, 'a').id)).state, 'done');
  const failed = await done(dl, start(dl, 'b').id);
  assert.equal(failed.state, 'failed'); assert.match(failed.error, /cache limit/i);
  assert.ok(dl.localFile(url('a')));
  assert.equal((await done(dl, start(dl, 'b', false).id)).state, 'done');
  assert.equal(dl.localFile(url('a')), null);
  dl.handle({ op: 'cache-config', limitGb: 0.25, protected: [url('b')], wanted: [url('a'), url('b')] });
  assert.equal((await done(dl, start(dl, 'a', false).id)).state, 'failed');
  assert.ok(dl.localFile(url('b')));
});

test('rejected quota leaves evictable files untouched and simultaneous completions respect quota', async t => {
  const { dl, active } = controlled(t);
  dl.handle({ op: 'cache-config', limitGb: 0.25, protected: [], wanted: [url('a'), url('b')] });
  const a = start(dl, 'a'), b = start(dl, 'b'); await tick();
  active[0].finish(170 * 1024 * 1024); active[1].finish(170 * 1024 * 1024);
  assert.equal((await done(dl, a.id)).state, 'done');
  assert.equal((await done(dl, b.id)).state, 'failed');
  const config = dl.handle({ op: 'cache-config', limitGb: 0.25, protected: [url('a')], wanted: [] });
  assert.ok(config.bytes <= config.limitBytes);
  const c = start(dl, 'c'); await tick(); active[2].finish(20 * 1024 * 1024); await done(dl, c.id);
  const d = start(dl, 'd', false); await tick(); active[3].finish(100 * 1024 * 1024);
  assert.equal((await done(dl, d.id)).state, 'failed');
  assert.ok(dl.localFile(url('c')), 'failed insertion must not partially evict');
});


test('latest configuration cancels obsolete jobs and their late output never enters the cache', async t => {
  const { dl, active } = controlled(t);
  const a = start(dl, 'a'), b = start(dl, 'b'), far = start(dl, 'far');
  await tick();
  dl.handle({ op: 'cache-config', limitGb: 0.25, protected: [url('a')], wanted: [url('far')] });
  assert.throws(() => dl.handle({ op: 'cache-config', limitGb: 0.25, protected: [], wanted: Array(10001).fill(url('a')) }), /wanted/i);
  active[1].finish(); await tick();
  assert.equal(dl.handle({ op: 'jobs' }).jobs.find(j => j.id === b.id).state, 'cancelled');
  assert.equal(dl.localFile(url('b')), null);
  assert.equal(active[2].url, url('far'));
  active[0].finish(); active[2].finish();
  assert.equal((await done(dl, a.id)).state, 'done');
  assert.equal((await done(dl, far.id)).state, 'done');
});

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
