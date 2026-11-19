'use strict';
const { test } = require('node:test'); const assert = require('node:assert/strict');
const { PcmRing, publicAddress, titleFromIcy } = require('./radio.cjs');
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
  r.take(48000); // listening 9 s behind the newest audio
  r.live(); assert.equal(r.at,48000*8); // 2 s before the newest audio
  r.live(); assert.equal(r.at,48000*8); // pressing again changes nothing
  r.take(48000*2); r.live(); assert.equal(r.at,48000*10); // already at the newest audio: never backwards
  const fresh=new PcmRing(20); fresh.write(Buffer.alloc(48000*4,1)); fresh.live(); assert.equal(fresh.at,0); // under 2 s received: stays at the start
});
