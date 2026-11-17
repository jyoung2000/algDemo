'use strict';
const { test } = require('node:test'); const assert = require('node:assert/strict');
const { PcmRing, publicAddress, titleFromIcy } = require('./radio.cjs');
test('public destinations only', () => { for (const a of ['127.0.0.1','10.0.0.1','169.254.169.254','192.168.1.1','172.16.1.1','::1','::ffff:8.8.8.8','100.64.0.1']) assert.equal(publicAddress(a),false,a); assert.equal(publicAddress('8.8.8.8'),true); });
test('ICY is not invented and has punctuation',()=>{ assert.equal(titleFromIcy("StreamTitle='Artist - That\'s It';StreamUrl='';"),"Artist - That's It");assert.equal(titleFromIcy("StreamTitle='';"),null); });
test('buffer remains bounded, pause is not listened, rewind is never forward',()=>{const r=new PcmRing(1);r.write(Buffer.alloc(48000*4,5));assert.equal(r.end,48000);assert.equal(r.heard,0);r.take(24000);assert.equal(r.heard,24000);r.rewind(-15);assert.equal(r.at,24000);r.rewind(15);assert.equal(r.at,0);r.write(Buffer.alloc(48000*4,7));assert.equal(r.at,48000);assert.equal(r.dropped,true);assert.equal(r.bytes.length,48000*4);assert.equal(r.take(100)[0],7);});
