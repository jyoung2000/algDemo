'use strict';
// STREAM-DL-001: playing a song from its source while its download runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createStreams, streamArgs, parseStream, streamable } = require('./streams.cjs');

const YT = 'https://music.youtube.com/watch?v=KavaUJxnNVU';
// The shape yt-dlp printed for that song on 2026-11-10 (link shortened).
const PRINTED = JSON.stringify({
  url: 'https://rr7---sn-x.googlevideo.com/videoplayback?expire=1794371146&itag=251&mime=audio%2Fwebm',
  http_headers: { 'User-Agent': 'Mozilla/5.0 Chrome/151', Accept: 'text/html', 'Sec-Fetch-Mode': 'navigate' },
  ext: 'webm', acodec: 'opus', protocol: 'https', duration: 184,
});

function fakeSpawn(stdout, code = 0, calls = []) {
  return (exe, args) => {
    calls.push({ exe, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      if (code === 0) child.stdout.emit('data', stdout);
      else child.stderr.emit('data', 'ERROR: [youtube] KavaUJxnNVU: Video unavailable\n');
      child.emit('close', code);
    });
    return child;
  };
}
const req = (range) => ({ headers: new Headers(range ? { range } : {}), signal: undefined });

test('asks yt-dlp for one progressive audio file, the link after --, downloading nothing', () => {
  const a = streamArgs(YT);
  assert.deepEqual(a.slice(-2), ['--', YT]);
  assert.ok(a.includes('--ignore-config') && a.includes('--no-playlist'));
  assert.equal(a[a.indexOf('-f') + 1], 'bestaudio[protocol=https]/bestaudio[protocol=http]');
  assert.ok(!a.includes('--exec') && !a.includes('-o') && !a.includes('--output'));
});

test('streams YouTube links only; never a host the downloader refuses, nor SoundCloud\u2019s segments', () => {
  assert.equal(streamable(YT), true);
  assert.equal(streamable('https://www.youtube.com/watch?v=jfKfPfyJRdk'), true);
  assert.equal(streamable('https://soundcloud.com/frank-ocean/nikes'), false);
  assert.equal(streamable('https://evil.example/watch?v=x'), false);
  assert.equal(streamable('http://music.youtube.com/watch?v=KavaUJxnNVU'), false);
});

test('reads the printed file: link, headers and when it expires', () => {
  const s = parseStream(`[youtube] noise\n${PRINTED}\n`);
  assert.match(s.url, /^https:\/\/rr7---sn-x\.googlevideo\.com\/videoplayback\?/);
  assert.equal(s.headers['User-Agent'], 'Mozilla/5.0 Chrome/151');
  assert.equal(s.expiresAt, 1794371146000);
  assert.equal(s.duration, 184);
});

test('refuses a segment list, a non-web link and an empty answer', () => {
  assert.throws(() => parseStream(JSON.stringify({ url: 'https://x/playlist.m3u8', protocol: 'm3u8_native' })), /cannot be streamed/);
  assert.throws(() => parseStream(JSON.stringify({ url: 'file:///C:/Windows/win.ini', protocol: 'https' })), /no audio file/);
  assert.throws(() => parseStream(''), /no audio file/);
});

test('asks once for songs requested together, and reuses the answer until near its expiry', async () => {
  const calls = [];
  let t = 1794371146000 - 3600_000;
  const s = createStreams({ toolsDir: 'C:/tools', spawnImpl: fakeSpawn(PRINTED, 0, calls), now: () => t });
  const [a, b] = await Promise.all([s.resolve(YT), s.resolve(YT)]);
  assert.equal(calls.length, 1);
  assert.equal(a, b);
  assert.match(calls[0].exe, /yt-dlp\.exe$/);
  await s.resolve(YT);
  assert.equal(calls.length, 1);
  t = 1794371146000 - 30_000; // inside the last minute before the link expires
  await s.resolve(YT);
  assert.equal(calls.length, 2);
});

test('a failed lookup is not remembered, and its reason is kept and logged', async () => {
  const calls = [];
  const lines = [];
  const s = createStreams({ toolsDir: 'C:/tools', spawnImpl: fakeSpawn('', 1, calls), log: (l) => lines.push(l) });
  await assert.rejects(s.resolve(YT), /Video unavailable/);
  assert.match(lines[0], /^no stream for https:\/\/music\.youtube\.com\/watch\?v=KavaUJxnNVU after \d+ ms: .*Video unavailable/);
  await assert.rejects(s.resolve(YT), /Video unavailable/);
  assert.equal(calls.length, 2);
  await assert.rejects(s.resolve('https://soundcloud.com/frank-ocean/nikes'), /Not a link this app streams/);
  assert.equal(calls.length, 2);
});

test('serves the source\u2019s bytes at the app origin, passing the range and yt-dlp\u2019s headers through', async () => {
  const seen = [];
  const s = createStreams({
    toolsDir: 'C:/tools', spawnImpl: fakeSpawn(PRINTED),
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return new Response('OPUS', { status: 206, headers: { 'content-type': 'audio/webm', 'content-length': '4', 'content-range': 'bytes 0-3/3367064', 'set-cookie': 'x=1', 'access-control-allow-origin': 'https://music.youtube.com' } });
    },
  });
  const r = await s.serve(req('bytes=0-3'), YT);
  assert.equal(r.status, 206);
  assert.equal(await r.text(), 'OPUS');
  assert.equal(r.headers.get('content-range'), 'bytes 0-3/3367064');
  assert.equal(r.headers.get('content-type'), 'audio/webm');
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
  assert.equal(r.headers.get('set-cookie'), null);
  assert.equal(r.headers.get('access-control-allow-origin'), null);
  assert.equal(seen[0].init.headers.Range, 'bytes=0-3');
  assert.equal(seen[0].init.headers['User-Agent'], 'Mozilla/5.0 Chrome/151');
  // A malformed range is not forwarded.
  await s.serve(req('bytes=0-3, 9-'), YT);
  assert.equal(seen[1].init.headers.Range, undefined);
});

test('an expired link is asked for afresh; a refused link is a 404 the page falls back from', async () => {
  const calls = [];
  let status = 403;
  const s = createStreams({ toolsDir: 'C:/tools', spawnImpl: fakeSpawn(PRINTED, 0, calls), fetchImpl: async () => new Response('', { status }), log: () => {} });
  assert.equal((await s.serve(req(), YT)).status, 502);
  status = 200;
  assert.equal((await s.serve(req(), YT)).status, 200);
  assert.equal(calls.length, 2);
  assert.equal((await s.serve(req(), 'https://soundcloud.com/frank-ocean/nikes')).status, 404);
});
