'use strict';
// ALLOWANCE-ARCH-001: the Windows shell asked every service for an unpacked answer (no accept-encoding), so a
// YouTube Music songs search really carried 684 KB instead of 39 KB. It now asks for gzip, unpacks it for the
// page, and reports what the network carried and whether Windows says the connection is metered.
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { PassThrough } = require('node:stream');
const { request, receive, outgoingHeaders } = require('./bridge.cjs');

/** A response as node:https hands it over: a stream with a status and headers. */
function answer(body, headers = {}, statusCode = 200) {
  const res = new PassThrough();
  res.statusCode = statusCode;
  res.headers = headers;
  setImmediate(() => { res.end(body); });
  return res;
}
const text = (r) => Buffer.from(r.body, 'base64').toString('utf8');

test('asks for gzip unless the page chose an encoding itself', () => {
  assert.equal(outgoingHeaders({ 'user-agent': 'x' }, null)['accept-encoding'], 'gzip');
  assert.equal(outgoingHeaders({ 'Accept-Encoding': 'identity' }, null)['accept-encoding'], undefined);
  assert.equal(outgoingHeaders({ 'Accept-Encoding': 'identity' }, null)['Accept-Encoding'], 'identity');
  assert.equal(outgoingHeaders({}, Buffer.from('abc'))['content-length'], '3');
});

test('a gzip answer is unpacked for the page and the wire size is what the network carried', async () => {
  const plain = JSON.stringify({ rows: Array.from({ length: 400 }, (_, i) => ({ title: `Song ${i}`, artist: 'Someone' })) });
  const packed = zlib.gzipSync(plain);
  const r = await receive(answer(packed, { 'content-encoding': 'gzip', 'content-length': String(packed.length), 'content-type': 'application/json' }), 8_000_000, () => false);
  assert.equal(text(r), plain);
  assert.equal(r.wire, packed.length);
  assert.ok(r.wire < plain.length / 5);
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-encoding'], undefined);
  assert.equal(r.headers['content-length'], undefined);
  assert.equal(r.headers['content-type'], 'application/json');
  assert.equal(r.metered, false);
});

test('an unpacked answer passes through with its own size as the wire size', async () => {
  const r = await receive(answer('hello', { 'content-length': '5' }), 8_000_000, () => true);
  assert.equal(text(r), 'hello');
  assert.equal(r.wire, 5);
  assert.equal(r.headers['content-length'], '5');
  assert.equal(r.metered, true);
});

test('the size limit bounds the unpacked answer', async () => {
  const packed = zlib.gzipSync(Buffer.alloc(200_000, 97));
  const r = await receive(answer(packed, { 'content-encoding': 'gzip' }), 50_000, () => false);
  assert.match(r.error, /response larger than 50000 bytes/);
});

test('a broken gzip answer is an error, not a crash', async () => {
  const r = await receive(answer(Buffer.from('not gzip at all'), { 'content-encoding': 'gzip' }), 8_000_000, () => false);
  assert.ok(r.error);
});

test('a redirect keeps its location for the page to re-check', async () => {
  const r = await receive(answer('', { location: 'https://api.deezer.com/x' }, 302), 8_000_000, () => false);
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, 'https://api.deezer.com/x');
});

test('the network question is answered without using the network', async () => {
  const r = await request(JSON.stringify({ probe: 'network' }));
  assert.equal(r.status, 204);
  assert.equal(typeof r.metered, 'boolean');
  assert.equal(r.error, undefined);
});

test('hosts off the list are still refused', async () => {
  const r = await request(JSON.stringify({ url: 'https://example.com/' }));
  assert.match(r.error, /host not allowed/);
});
