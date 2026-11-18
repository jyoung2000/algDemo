'use strict';
// RADIO-001. Public broadcasts only. Network and decoder stay out of the renderer. Ten minutes
// of 48 kHz stereo PCM are retained, including while paused; nothing is saved to the music library.
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns').promises;
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const RATE = 48000, FRAME = 4, KEEP = 600;
function publicAddress(ip) {
  if (net.isIP(ip) !== 4) return false; // use public IPv4; no mapped/ambiguous IPv6 routes
  const p = ip.split('.').map(Number);
  return !(p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224 || p[0] === 169 && p[1] === 254 || p[0] === 172 && p[1] >= 16 && p[1] <= 31 || p[0] === 192 && (p[1] === 168 || p[1] === 0) || p[0] === 100 && p[1] >= 64 && p[1] <= 127 || p[0] === 198 && (p[1] === 18 || p[1] === 19));
}
async function openPublic(raw, headers = {}, hops = 0) {
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || !u.hostname || raw.length > 4096 || (u.port && !/^\d{1,5}$/.test(u.port))) throw Error('Not a public broadcast URL');
  const ips = await dns.lookup(u.hostname, { all: true, family: 4 });
  if (!ips.length || ips.some(x => !publicAddress(x.address))) throw Error('Private and local network addresses are not allowed');
  return new Promise((resolve, reject) => {
    const q = (u.protocol === 'https:' ? https : http).get(u, { headers: { 'user-agent': 'AirwaveDiscovery/1.0 (radio listener)', connection: 'close', ...headers }, agent: false, lookup: (_h, o, cb) => o.all ? cb(null, [{ address: ips[0].address, family: 4 }]) : cb(null, ips[0].address, 4), timeout: 10000 }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) { r.destroy(); if (hops >= 5) return reject(Error('Too many redirects')); return openPublic(new URL(r.headers.location, u).href, headers, hops + 1).then(resolve, reject); }
      if (r.statusCode !== 200) { r.destroy(); return reject(Error(`Station answered HTTP ${r.statusCode}`)); }
      r.radioUrl = u.href; resolve(r);
    });
    q.on('timeout', () => q.destroy(Error('Station timed out')));
    q.on('error', reject);
  });
}
class PcmRing {
  constructor(seconds = KEEP) { this.cap = Math.round(seconds * RATE); this.bytes = Buffer.alloc(this.cap * FRAME); this.end = 0; this.at = 0; this.heard = 0; this.dropped = false; }
  get start() { return Math.max(0, this.end - this.cap); }
  write(b) {
    const n = Math.floor(b.length / FRAME); if (!n) return;
    const tail = this.end % this.cap, first = Math.min(n, this.cap - tail);
    if (n > this.cap) { this.end += n - this.cap; this.write(b.subarray((n - this.cap) * FRAME)); return; }
    b.copy(this.bytes, tail * FRAME, 0, first * FRAME); if (first < n) b.copy(this.bytes, 0, first * FRAME, n * FRAME);
    this.end += n; if (this.at < this.start) { this.at = this.start; this.dropped = true; }
  }
  take(n) { this.at = Math.max(this.start, this.at); n = Math.min(n, this.end - this.at); const b = this.slice(this.at, n); this.at += n; this.heard += n; return b; }
  slice(at, n) { at = Math.max(this.start, Math.min(this.end, at)); n = Math.min(n, this.end - at); const b = Buffer.alloc(n * FRAME), tail = at % this.cap, first = Math.min(n, this.cap - tail); this.bytes.copy(b, 0, tail * FRAME, (tail + first) * FRAME); if (first < n) this.bytes.copy(b, first * FRAME, 0, (n - first) * FRAME); return b; }
  // A recording is always described as an excerpt, never a complete programme.
  wav(from, to) {
    if (!Number.isFinite(from) || !Number.isFinite(to)) throw Error('Invalid recording range');
    const at = Math.max(this.start, Math.floor(from * RATE)), end = Math.min(this.end, Math.floor(to * RATE));
    if (end <= at) throw Error('No retained audio for this item yet');
    const pcm = this.slice(at, end - at), h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(pcm.length + 36, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * FRAME, 28);
    h.writeUInt16LE(FRAME, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([h, pcm]);
  }
  rewind(seconds) { this.at = Math.max(this.start, this.at - Math.floor(Math.max(0, Math.min(KEEP, seconds)) * RATE)); }
}
function titleFromIcy(text) { return /StreamTitle='([\s\S]*?)';/i.exec(text)?.[1]?.replace(/\u0000/g, '').trim() || null; }
async function probe(url) {
  const r = await openPublic(url, { 'icy-metadata': '1' });
  const interval = Number(r.headers['icy-metaint']);
  if (!(interval > 0 && interval <= 262144)) { r.destroy(); return { title: null, checkedAt: Date.now(), state: 'unavailable', detail: 'Broadcaster publishes no ICY now-playing information' }; }
  return new Promise(resolve => {
    let b = Buffer.alloc(0), settled = false;
    const done = v => { if (settled) return; settled = true; clearTimeout(timer); r.destroy(); resolve(v); };
    const timer = setTimeout(() => done({ title: null, checkedAt: Date.now(), state: 'unavailable', detail: 'Metadata did not arrive in time' }), 8000);
    r.on('data', c => { b = Buffer.concat([b, c]); if (b.length <= interval) return; const size = b[interval] * 16; if (b.length < interval + 1 + size) return; const title = titleFromIcy(b.subarray(interval + 1, interval + 1 + size).toString('utf8')); done({ title, checkedAt: Date.now(), state: title ? 'current' : 'unavailable', detail: title ? 'Broadcaster ICY' : 'No current item supplied by broadcaster' }); });
    r.on('error', e => done({ title: null, checkedAt: Date.now(), state: 'failed', detail: e.message }));
    r.on('end', () => done({ title: null, checkedAt: Date.now(), state: 'unavailable', detail: 'Metadata stream ended' }));
  });
}
function createRadio({ toolsDir, saveRecording }) {
  let session = null; const meta = new Map(), pending = new Map();
  let favourites = []; try { if (arguments[0].favouritesPath) favourites = JSON.parse(fs.readFileSync(arguments[0].favouritesPath, 'utf8')); } catch {}
  const favouritesPath = arguments[0].favouritesPath;
  function stop() { if (session) { session.stopped = true; session.response?.destroy(); session.proc?.kill(); } session = null; }
  async function pump(s, url, depth = 0) {
    if (depth > 4) throw Error('Too many nested station playlists');
    const r = await openPublic(url, { 'icy-metadata': '0' }); if (s.stopped) { r.destroy(); return; } s.response = r;
    const type = String(r.headers['content-type'] || '');
    if (/mpegurl|scpls/.test(type) || /\.(m3u8?|pls)(\?|$)/i.test(r.radioUrl)) {
      const bytes = []; let size = 0; for await (const c of r) { size += c.length; if (size > 1000000) { r.destroy(); throw Error('Station playlist too large'); } bytes.push(c); }
      const text = Buffer.concat(bytes).toString('utf8');
      if (!/#EXTM3U/.test(text) || !/#EXT-X-/.test(text)) { const next = text.split(/\r?\n/).map(x => x.replace(/^File\d+=/, '').trim()).find(x => /^https?:\/\//.test(x)); if (!next) throw Error('No stream in station playlist'); return pump(s, next, depth + 1); }
      if (/#EXT-X-STREAM-INF/.test(text)) { const rows = text.split(/\r?\n/); const i = rows.findIndex(x => /^#EXT-X-STREAM-INF/.test(x)); return pump(s, new URL(rows[i + 1], r.radioUrl).href, depth + 1); }
      // TS/AAC HLS. Encrypted broadcasts are not decrypted; fMP4 initialization is read once.
      if (/#EXT-X-KEY:.*METHOD=(?!NONE)/.test(text)) throw Error('Encrypted station broadcasts are not supported');
      s.hlsSeen ||= new Set();
      const init = /#EXT-X-MAP:URI="([^"]+)"/.exec(text)?.[1];
      const lines = text.split(/\r?\n/).map(x => x.trim()).filter(x => x && !x.startsWith('#'));
      const list = init && !s.hlsInit ? [init, ...lines.slice(-3)] : lines.slice(-3);
      for (const rel of list) { const u = new URL(rel, r.radioUrl).href; if (s.hlsSeen.has(u) || s.stopped) continue; s.hlsSeen.add(u); if (rel === init) s.hlsInit = true; const part = await openPublic(u); let n = 0; for await (const c of part) { n += c.length; if (n > 8000000 || s.stopped) { part.destroy(); break; } if (!s.proc.stdin.write(c)) await new Promise(ok => s.proc.stdin.once('drain', ok)); } }
      if (s.hlsSeen.size > 1000) s.hlsSeen = new Set([...s.hlsSeen].slice(-100));
      if (!s.stopped && !/#EXT-X-ENDLIST/.test(text)) { await new Promise(ok => setTimeout(ok, 1500)); return r.radioUrl; }
      return;
    }
    for await (const c of r) { if (s.stopped) break; if (!s.proc.stdin.write(c)) await new Promise(ok => s.proc.stdin.once('drain', ok)); }
    if (!s.stopped) throw Error('Station disconnected');
  }
  function snapshot(s) { return { id: s.id, stationId: s.stationId, paused: s.paused, shuffle: Boolean(s.shuffle), received: s.ring.end / RATE, position: s.ring.at / RATE, oldest: s.ring.start / RATE, heard: s.ring.heard / RATE, dropped: s.ring.dropped, state: s.error ? 'failed' : s.ring.end > RATE ? 'playing' : 'buffering', error: s.error || null, native: false, channels: 2, sampleRate: RATE }; }
  async function handle(cmd) {
    const op = cmd.op;
    if (op === 'favourites') { if (Array.isArray(cmd.stations)) { favourites = cmd.stations.slice(0, 500); if (favouritesPath) { const tmp = favouritesPath + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(favourites)); fs.renameSync(tmp, favouritesPath); } } return { stations: favourites }; }
    if (op === 'request') { const r = await openPublic(String(cmd.url)); const chunks = []; let n = 0; const deadline = setTimeout(() => r.destroy(Error('Radio lookup timed out')), 10000); try { for await (const c of r) { n += c.length; if (n > 2000000) { r.destroy(); throw Error('Radio response too large'); } chunks.push(c); } return { text: Buffer.concat(chunks).toString('utf8') }; } finally { clearTimeout(deadline); r.destroy(); } }
    if (op === 'metadata') { const u = String(cmd.url); const old = meta.get(u); if (old && Date.now() - old.checkedAt < 15000) return old; if (!pending.has(u)) pending.set(u, probe(u).catch(e => ({ title: null, checkedAt: Date.now(), state: 'failed', detail: e.message })).then(v => { meta.set(u, v); if (meta.size > 400) meta.delete(meta.keys().next().value); return v; }).finally(() => pending.delete(u))); return pending.get(u); }
    if (op === 'stop') { stop(); return { stopped: true }; }
    if (op === 'start') {
      // The stream is opened once by pump; a preflight connection consumes a broadcaster's limited listener slots.
      stop();
      const s = session = { id: randomUUID(), stationId: String(cmd.stationId).slice(0, 100), ring: new PcmRing(), paused: false, stopped: false, error: null };
      const ff = path.join(toolsDir, 'ffmpeg.exe');
      if (!fs.existsSync(ff)) { session = null; throw Error('The bundled radio audio decoder is missing. Repair the app installation.'); }
      s.proc = spawn(ff, ['-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'pipe', '-i', 'pipe:0', '-vn', '-ac', '2', '-ar', String(RATE), '-f', 's16le', 'pipe:1'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let leftover = Buffer.alloc(0); s.proc.stdout.on('data', c => { const b = Buffer.concat([leftover, c]); const n = b.length - b.length % FRAME; s.ring.write(b.subarray(0, n)); leftover = b.subarray(n); });
      s.proc.stderr.on('data', c => { s.lastError = c.toString().slice(-500); });
      s.proc.stdin.on('error', () => {}); s.proc.on('error', e => { s.error = e.message; }); s.proc.on('exit', code => { if (!s.stopped) s.error ||= s.lastError || `Radio decoder stopped (${code})`; });
      void (async () => { let u = String(cmd.url); while (!s.stopped && u) { const next = await pump(s, u); u = typeof next === 'string' ? next : ''; } })().catch(e => { if (!s.stopped) { s.error = e.message; s.proc.kill(); } });
      return snapshot(s);
    }
    const s = session; if (!s || cmd.id && cmd.id !== s.id) throw Error('Radio session has ended');
    if (op === 'export') {
      if (!saveRecording) throw Error('Radio recording destination is unavailable');
      const from = Math.max(s.ring.start / RATE, Number(cmd.from)), to = Math.min(s.ring.end / RATE, Number(cmd.to));
      const wave = s.ring.wav(from, to);
      const saved = await saveRecording(wave, String(cmd.title || 'Live radio'));
      return { ...saved, seconds: (wave.length - 44) / (RATE * FRAME), partial: true };
    }
    if (op === 'pause') s.paused = Boolean(cmd.paused);
    // RADIO-UI-005: shuffle is session state the page and any remote controller agree on.
    if (op === 'shuffle') s.shuffle = Boolean(cmd.on);
    if (op === 'rewind') s.ring.rewind(Number(cmd.seconds) || 15);
    if (op === 'pull') { const pcm = s.paused ? Buffer.alloc(0) : s.ring.take(12000); return { ...snapshot(s), pcm: pcm.toString('base64') }; }
    if (op === 'sample') { const n = Math.min(RATE * 12, s.ring.at - s.ring.start); const pcm = s.ring.slice(s.ring.at - n, n); const mono = Buffer.alloc(Math.floor(n / 3) * 2); for (let i = 0; i < mono.length / 2; i++) mono.writeInt16LE(Math.round((pcm.readInt16LE(i * 12) + pcm.readInt16LE(i * 12 + 2)) / 2), i * 2); return { pcm: mono.toString('base64'), sampleRate: 16000, seconds: mono.length / 32000 }; }
    return snapshot(s);
  }
  return { handle, shutdown: stop };
}
module.exports = { publicAddress, openPublic, titleFromIcy, PcmRing, createRadio };
