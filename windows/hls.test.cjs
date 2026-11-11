'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { createHls, parse, publicUrl, args } = require('./hls.cjs');
const source = 'https://soundcloud.com/forss/flickermood';
test('selects audio-only HLS, not progressive or video', () => {
  assert.match(args(source).join(' '), /bestaudio\[protocol=m3u8_native\]/);
  const media = parse(JSON.stringify({ protocol: 'm3u8_native', acodec: 'aac', vcodec: 'none', url: 'https://cdn.example.com/playlist.m3u8', http_headers: { 'User-Agent': 'test', Cookie: 'secret' } }));
  assert.deepEqual(media, { url: 'https://cdn.example.com/playlist.m3u8', headers: { 'User-Agent': 'test' } });
  assert.throws(() => parse(JSON.stringify({ protocol: 'https', acodec: 'aac', url: media.url })), /HLS/);
  assert.throws(() => publicUrl('https://127.0.0.1/a'), /public/);
});
function fakeSpawn() {
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  process.nextTick(() => { child.stdout.emit('data', Buffer.from(JSON.stringify({ protocol: 'm3u8_native', acodec: 'aac', vcodec: 'none', url: 'https://cdn.example.com/list.m3u8' }))); child.emit('close', 0); });
  return child;
}
function fakeRequest(url, _opts, callback) {
  const req = new EventEmitter(); req.end = () => {
    const res = Readable.from([Buffer.from(url.pathname.endsWith('list.m3u8') ? '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nsegment.aac\n#EXT-X-ENDLIST\n' : 'AAC DATA')]);
    res.statusCode = 200; res.headers = { 'content-type': 'application/octet-stream' };
    callback(res);
  }; req.destroy = (error) => req.emit('error', error); return req;
}
test('opaque same-origin playlist and segment, no arbitrary URLs', async () => {
  const hls = createHls({ toolsDir: '.', spawnImpl: fakeSpawn, lookupImpl: async () => [{ address: '8.8.8.8', family: 4 }], requestImpl: fakeRequest });
  const info = await hls.info(source);
  assert.equal(info.status, 200);
  const url = new URL((await info.json()).url, 'https://appassets.androidplatform.net');
  const playlist = await hls.resource(new Request(url), url.searchParams.get('t'), url.searchParams.get('i'));
  assert.equal(playlist.status, 200, await playlist.clone().text());
  const text = await playlist.text();
  assert.ok(text.startsWith('#EXTM3U'));
  assert.ok(!text.includes('cdn.example.com'));
  const segment = new URL(text.split('\n').find((line) => line.startsWith('/hls-resource')), url);
  const bytes = await hls.resource(new Request(segment), segment.searchParams.get('t'), segment.searchParams.get('i'));
  assert.equal(await bytes.text(), 'AAC DATA');
  assert.equal((await hls.resource(new Request(url), 'bad', '0')).status, 404);
});
test('refuses private DNS before any upstream request', async () => {
  let requested = false;
  const hls = createHls({ toolsDir: '.', spawnImpl: fakeSpawn, lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }], requestImpl: () => { requested = true; } });
  const info = new URL((await (await hls.info(source)).json()).url, 'https://appassets.androidplatform.net');
  assert.equal((await hls.resource(new Request(info), info.searchParams.get('t'), '0')).status, 502);
  assert.equal(requested, false);
});
test('checks a redirected address before sending any private request', async () => {
  let requested = 0;
  const requestImpl = (_url, _opts, callback) => {
    requested++;
    const req = new EventEmitter(); req.end = () => {
      const res = Readable.from([]);
      res.statusCode = 302; res.headers = { location: 'https://private.example.com/segment.aac' };
      callback(res);
    }; req.destroy = (error) => req.emit('error', error); return req;
  };
  const hls = createHls({ toolsDir: '.', spawnImpl: fakeSpawn, lookupImpl: async (host) => [{ address: host.startsWith('private') ? '127.0.0.1' : '8.8.8.8', family: 4 }], requestImpl });
  const info = new URL((await (await hls.info(source)).json()).url, 'https://appassets.androidplatform.net');
  assert.equal((await hls.resource(new Request(info), info.searchParams.get('t'), '0')).status, 502);
  assert.equal(requested, 1);
});
