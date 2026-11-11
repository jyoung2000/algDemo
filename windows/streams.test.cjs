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
const publicLookup = async () => [{ address: '8.8.8.8', family: 4 }];

test('asks yt-dlp for one progressive audio file, the link after --, downloading nothing', () => {
  const a = streamArgs(YT);
  assert.deepEqual(a.slice(-2), ['--', YT]);
  assert.ok(a.includes('--ignore-config') && a.includes('--no-playlist'));
  assert.equal(a[a.indexOf('-f') + 1], 'bestaudio[protocol=https]/bestaudio[protocol=http]/best[protocol=https]/best[protocol=http]');
  assert.ok(!a.includes('--exec') && !a.includes('-o') && !a.includes('--output'));
});

test('offers every yt-dlp downloader-approved platform; never Spotify or an arbitrary URL', () => {
  for (const link of [
    YT,
    'https://www.youtube.com/watch?v=jfKfPfyJRdk',
    'https://soundcloud.com/forss/flickermood',
    'https://audius.co/Lofibeat/stars-in-the-sky-lofi-beats-370899',
    'https://benprunty.bandcamp.com/track/giant-step',
    'https://hearthis.at/random1-ej/deep-by-random-creative-commons-royalty-free/',
    'https://archive.org/download/cold-funk-by-kevin-macleod/cold-funk-by-kevin-macleod.mp3',
  ]) assert.equal(streamable(link), true, link);
  for (const link of [
    'https://evil.example/watch?v=x',
    'https://open.spotify.com/track/11dFghVXANMlKmJXsNCbNl',
    'http://music.youtube.com/watch?v=KavaUJxnNVU',
    'https://archive.org/download/item/evil.zip',
    'https://hearthis.at/a/song/../secret/',
  ]) assert.equal(streamable(link), false, link);
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

test('Audius single MP3 format is playable even when yt-dlp labels its video codec unknown, but video is not', () => {
  const a = parseStream(JSON.stringify({ url: 'https://api.audius.co/v1/tracks/95wro/stream', ext: 'mp3', acodec: 'mp3', vcodec: 'unknown', protocol: 'https', duration: 71 }));
  assert.equal(a.ext, 'mp3');
  assert.throws(() => parseStream(JSON.stringify({ url: 'https://cdn.example/video.mp4', ext: 'mp4', acodec: 'aac', vcodec: 'h264', protocol: 'https' })), /video/);
  assert.throws(() => parseStream(JSON.stringify({ url: 'https://cdn.example/mute.mp3', ext: 'mp3', acodec: 'none', protocol: 'https' })), /audio/);
});

test('does not fetch a private resolved URL or follow a redirect to one', async () => {
  for (const url of ['http://127.0.0.1/private', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/private']) {
    assert.throws(() => parseStream(JSON.stringify({ url, protocol: 'http', acodec: 'mp3' })), /public/);
  }
  const fetched = [];
  const s = createStreams({ toolsDir: 'C:/tools', spawnImpl: fakeSpawn(PRINTED), lookupImpl: publicLookup, fetchImpl: async (url) => {
    fetched.push(url);
    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } });
  } });
  assert.equal((await s.serve(req(), YT)).status, 502);
  assert.equal(fetched.length, 1);
});

test('refuses a public hostname resolving to a private address before fetching', async () => {
  let fetches = 0;
  const s = createStreams({ toolsDir: 'C:/tools', spawnImpl: fakeSpawn(PRINTED), lookupImpl: async () => [{ address: '169.254.169.254', family: 4 }], fetchImpl: async () => { fetches++; return new Response('audio'); } });
  assert.equal((await s.serve(req(), YT)).status, 502);
  assert.equal(fetches, 0);
});

test('a failed lookup is not remembered, and its reason is kept and logged', async () => {
  const calls = [];
  const lines = [];
  const s = createStreams({ toolsDir: 'C:/tools', spawnImpl: fakeSpawn('', 1, calls), log: (l) => lines.push(l) });
  await assert.rejects(s.resolve(YT), /Video unavailable/);
  assert.match(lines[0], /^no stream for https:\/\/music\.youtube\.com\/watch\?v=KavaUJxnNVU after \d+ ms: .*Video unavailable/);
  await assert.rejects(s.resolve(YT), /Video unavailable/);
  assert.equal(calls.length, 2);
  await assert.rejects(s.resolve('https://soundcloud.com/forss/flickermood'), /Video unavailable/);
  assert.equal(calls.length, 3);
  await assert.rejects(s.resolve('https://open.spotify.com/track/11dFghVXANMlKmJXsNCbNl'), /Not a link this app streams/);
  assert.equal(calls.length, 3);
});

test('serves the source\u2019s bytes at the app origin, passing the range and yt-dlp\u2019s headers through', async () => {
  const seen = [];
  const s = createStreams({
    toolsDir: 'C:/tools', spawnImpl: fakeSpawn(PRINTED), lookupImpl: publicLookup,
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
  const s = createStreams({ toolsDir: 'C:/tools', spawnImpl: fakeSpawn(PRINTED, 0, calls), lookupImpl: publicLookup, fetchImpl: async () => new Response('', { status }), log: () => {} });
  assert.equal((await s.serve(req(), YT)).status, 502);
  status = 200;
  assert.equal((await s.serve(req(), YT)).status, 200);
  assert.equal(calls.length, 2);
  assert.equal((await s.serve(req(), 'https://open.spotify.com/track/11dFghVXANMlKmJXsNCbNl')).status, 404);
});
