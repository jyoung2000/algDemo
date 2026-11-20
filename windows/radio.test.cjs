'use strict';
const { test } = require('node:test'); const assert = require('node:assert/strict');
const { PcmRing, publicAddress, titleFromIcy, latestIcyTitle } = require('./radio.cjs');
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
