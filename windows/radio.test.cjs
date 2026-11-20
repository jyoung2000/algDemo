'use strict';
const { test } = require('node:test'); const assert = require('node:assert/strict');
const { PcmRing, publicAddress, titleFromIcy, latestIcyTitle, reconnectStep, playlistEntries, firstThatPlays } = require('./radio.cjs');
test('public destinations only', () => { for (const a of ['127.0.0.1','10.0.0.1','169.254.169.254','192.168.1.1','172.16.1.1','::1','::ffff:8.8.8.8','100.64.0.1']) assert.equal(publicAddress(a),false,a); assert.equal(publicAddress('8.8.8.8'),true); });
test('ICY is not invented and has punctuation',()=>{ assert.equal(titleFromIcy("StreamTitle='Artist - That\'s It';StreamUrl='';"),"Artist - That's It");assert.equal(titleFromIcy("StreamTitle='';"),null); });
test('buffer remains bounded, pause is not listened, rewind is never forward',()=>{const r=new PcmRing(1);r.write(Buffer.alloc(48000*4,5));assert.equal(r.end,48000);assert.equal(r.heard,0);r.take(24000);assert.equal(r.heard,24000);r.rewind(-15);assert.equal(r.at,24000);r.rewind(15);assert.equal(r.at,0);r.write(Buffer.alloc(48000*4,7));assert.equal(r.at,48000);assert.equal(r.dropped,true);assert.equal(r.bytes.length,48000*4);assert.equal(r.take(100)[0],7);});

test('radio retains ten minutes and exports a bounded WAV without moving the listener', () => {
  const r = new PcmRing(); assert.equal(r.cap, 48000 * 600);
  r.write(Buffer.alloc(48000 * 4, 7)); r.take(12000); const at = r.at, heard = r.heard;
  const wave = r.wav(0, 1); assert.equal(wave.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wave.readUInt32LE(40), 48000 * 4); assert.equal(wave.length, 44 + 48000 * 4);
  assert.equal(wave.readUInt32LE(24), 48000); assert.equal(r.at, at); assert.equal(r.heard, heard);
  assert.throws(() => r.wav(2, 3), /retained audio/);
});
test('Go live jumps to just before the newest audio, never backwards or past it (RADIO-GO-LIVE-001)',()=>{
  const r=new PcmRing(20);
  for(let i=0;i<10;i++) r.write(Buffer.alloc(48000*4,1)); // 10 s received
  r.hold(); r.take(48000); // listening 9 s behind the newest audio (after a pause, so no automatic catch-up)
  r.live(); assert.equal(r.at,48000*8); // 2 s before the newest audio
  r.live(); assert.equal(r.at,48000*8); // pressing again changes nothing
  r.take(48000*2); r.live(); assert.equal(r.at,48000*10); // already at the newest audio: never backwards
  const fresh=new PcmRing(20); fresh.write(Buffer.alloc(48000*4,1)); fresh.live(); assert.equal(fresh.at,0); // under 2 s received: stays at the start
});

// RADIO-LIVE-EDGE-001 (owner, 2026-11-19): "the radio ... is behind the actual live radio even though it says live".
// Servers send a burst of recent audio on connect (Power 92: 254 KB at 64 kbit/s = ~32 s; V103 ~20 s; KEXP ~6.5 s)
// and playback started at the oldest frame of that burst.
test('a connect burst does not leave playback behind live: it starts 2 s before the newest audio', () => {
  const r = new PcmRing(120); r.write(Buffer.alloc(48000 * 4 * 30, 1));
  r.take(1200);
  assert.equal(r.at, 48000 * 28 + 1200);
});
test('catching up stops once the listener pauses or rewinds, and after the opening 10 s', () => {
  const a = new PcmRing(120); a.write(Buffer.alloc(48000 * 4 * 30, 1)); a.take(100); a.hold();
  a.write(Buffer.alloc(48000 * 4 * 20, 1)); const at = a.at; a.take(100); assert.equal(a.at, at + 100);
  const b = new PcmRing(120); b.write(Buffer.alloc(48000 * 4 * 30, 1)); b.take(100); b.rewind(15);
  const back = b.at; b.take(100); assert.equal(b.at, back + 100);
  const c = new PcmRing(120); for (let i = 0; i < 10; i++) { c.write(Buffer.alloc(48000 * 4, 1)); c.take(48000); } // heard 10 s, in step
  c.write(Buffer.alloc(48000 * 4 * 20, 1)); const before = c.at; c.take(100); assert.equal(c.at, before + 100);
  // Go live still works after a hold
  a.live(); assert.equal(a.at, a.end - 48000 * 2);
});
test('the title is the newest one in the connect burst, not the first (the first is ~30 s old)', () => {
  const block = (title) => { const t = Buffer.from(title ? `StreamTitle='${title}';` : ''); const n = Math.ceil(t.length / 16); const b = Buffer.alloc(1 + n * 16); b[0] = n; t.copy(b, 1); return b; };
  const audio = Buffer.alloc(8, 9);
  const bytes = Buffer.concat([audio, block('Old - Song'), audio, block(''), audio, block('Sexyy Red - Now'), audio, block(''), audio.subarray(0, 3)]);
  assert.equal(latestIcyTitle(bytes, 8), 'Sexyy Red - Now');
  assert.equal(latestIcyTitle(Buffer.concat([audio, block('')]), 8), null);
  assert.equal(latestIcyTitle(Buffer.alloc(5), 8), null);
});

// RADIO-ROBUST-001 (owner, 2026-11-20): a dropped stream reconnects; a station that never played fails at once.
test('reconnect rule: never-played fails, dropped stream retries 5 times with growing waits, resets after 2 s of audio', () => {
  assert.deepEqual(reconnectStep(false, 0, 0), { tries: 1, wait: 1000 }); // a one-off refusal is retried once
  assert.equal(reconnectStep(false, 0, 1), null);
  let t = reconnectStep(true, 600, 0); assert.deepEqual(t, { tries: 1, wait: 1000 });
  const waits = [1000]; for (let n = 2; n <= 5; n++) { t = reconnectStep(true, 0, t.tries); assert.equal(t.tries, n); waits.push(t.wait); }
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 8000]);
  assert.equal(reconnectStep(true, 0, 5), null);
  assert.equal(reconnectStep(true, 3, 4).tries, 1);
  assert.equal(reconnectStep(true, 1, 4).tries, 5);
});

test('every address in a playlist is tried in turn until one plays; a stream that played is not swapped', async () => {
  assert.deepEqual(playlistEntries('[playlist]\r\nFile1=http://a.example:80/X\r\nTitle1=X\r\nFile2=http://a.example:3690/X\r\nFile2=http://a.example:3690/X\r\n'), ['http://a.example:80/X', 'http://a.example:3690/X']);
  let frames = 0; const tried = [];
  assert.equal(await firstThatPlays(['a', 'b', 'c'], () => frames, async u => { tried.push(u); if (u === 'a') throw Error('HTTP 503'); frames += 10; return 'played ' + u; }), 'played b');
  assert.deepEqual(tried, ['a', 'b']);
  tried.length = 0;
  await assert.rejects(firstThatPlays(['a', 'b'], () => frames, async u => { tried.push(u); frames += 10; throw Error('read interrupted'); }), /read interrupted/);
  assert.deepEqual(tried, ['a']);
  await assert.rejects(firstThatPlays(['a', 'b'], () => 0, async u => { throw Error('fail ' + u); }), /fail a/);
});

test('after a network stall the backlog does not leave the listener 20 s late: playback rejoins live (unless they paused)', () => {
  const sec = 48000, F = 4;
  const play12 = (x) => { for (let i = 0; i < 12; i++) { x.write(Buffer.alloc(sec * F)); x.take(sec); } assert.ok(x.heard >= sec * 10); };
  const r = new PcmRing(60); play12(r);
  assert.equal(r.take(sec).length, 0); // stalled
  r.write(Buffer.alloc(sec * F * 22)); r.take(480);
  assert.ok(Math.abs((r.end - r.at) / sec - 2) < 0.02, String((r.end - r.at) / sec));
  const h = new PcmRing(60); play12(h); h.hold(); h.take(sec);
  h.write(Buffer.alloc(sec * F * 22)); h.take(480);
  assert.ok(Math.abs((h.end - h.at) / sec - 22) < 0.05);
});

test('a short read before buffering also counts as a stall', () => {
  const sec = 48000, F = 4; const r = new PcmRing(60);
  for (let i = 0; i < 12; i++) { r.write(Buffer.alloc(sec * F)); r.take(sec); }
  r.write(Buffer.alloc(sec * 2)); assert.equal(r.take(sec).length, sec * 2);
  r.write(Buffer.alloc(sec * F * 22)); r.take(480);
  assert.ok(Math.abs((r.end - r.at) / sec - 2) < 0.02, String((r.end - r.at) / sec));
});

test('a backlog arriving in parts still ends at live (measured on the phone: it lands over about a second)', () => {
  const sec = 48000, F = 4; const r = new PcmRing(60);
  for (let i = 0; i < 12; i++) { r.write(Buffer.alloc(sec * F)); r.take(sec); }
  r.take(sec);
  r.write(Buffer.alloc(sec * F * 4)); r.take(480);
  r.write(Buffer.alloc(sec * F * 18)); r.take(480);
  assert.ok(Math.abs((r.end - r.at) / sec - 2) < 0.02, String((r.end - r.at) / sec));
});
