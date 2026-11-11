'use strict';
// Audio-only HLS at the app origin. The page never chooses upstream URLs: opaque resource IDs
// are issued only while rewriting playlists obtained from a downloader-approved song.
const { spawn } = require('node:child_process');
const dns = require('node:dns').promises;
const https = require('node:https');
const net = require('node:net');
const crypto = require('node:crypto');
const path = require('node:path');
const { urlAllowedFor } = require('./downloads.cjs');
const LIMIT = 8 * 1024 * 1024;
const TTL = 20 * 60 * 1000;
const blocked = new net.BlockList();
for (const [ip, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked.addSubnet(ip, bits, 'ipv4');
// net.BlockList maps IPv4 into IPv6: blocking ::ffff:0:0/96 also blocks ALL public IPv4.
// Reject mapped addresses explicitly instead, without disabling public IPv4 CDNs.
for (const [ip, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32]]) blocked.addSubnet(ip, bits, 'ipv6');
function publicUrl(raw) {
  const u = new URL(raw);
  if (u.protocol !== 'https:' || u.username || u.password || u.port && u.port !== '443' || !u.hostname.includes('.') || u.hostname.length > 253 || raw.length > 4096 || net.isIP(u.hostname) || u.hostname.endsWith('.local')) throw new Error('Not a public HTTPS media URL.');
  return u;
}
function publicAddress(record) {
  return record && net.isIP(record.address) && !record.address.toLowerCase().startsWith('::ffff:') && !blocked.check(record.address, record.family === 6 ? 'ipv6' : 'ipv4');
}
function args(url) {
  return ['--ignore-config', '--no-colors', '--no-cache-dir', '--no-playlist', '--no-warnings', '-f', 'bestaudio[protocol=m3u8_native]/bestaudio[protocol=m3u8]', '--print', '%(.{url,http_headers,protocol,acodec,vcodec,ext})j', '--', url];
}
function parse(stdout) {
  const line = String(stdout).split(/\r?\n/).find((s) => s.trim().startsWith('{'));
  if (!line) throw new Error('No HLS audio playlist.');
  const o = JSON.parse(line);
  if (!['m3u8', 'm3u8_native'].includes(o.protocol) || !o.acodec || o.acodec === 'none' || o.vcodec && !['none', 'unknown'].includes(o.vcodec)) throw new Error('No audio-only HLS playlist.');
  const u = publicUrl(String(o.url));
  const headers = {};
  for (const k of ['User-Agent', 'Referer', 'Origin', 'Accept', 'Accept-Language']) if (typeof o.http_headers?.[k] === 'string' && o.http_headers[k].length < 1024) headers[k] = o.http_headers[k];
  return { url: u.href, headers };
}
function createHls({ toolsDir, spawnImpl = spawn, lookupImpl = dns.lookup, requestImpl = https.request, now = Date.now } = {}) {
  const sessions = new Map();
  function collect() {
    for (const [k, s] of sessions) if (now() - s.at > TTL) sessions.delete(k);
    while (sessions.size > 12) sessions.delete(sessions.keys().next().value);
  }
  function resolve(source) {
    if (!urlAllowedFor('yt-dlp', source)) return Promise.reject(new Error('Not a downloader-approved song.'));
    return new Promise((resolve, reject) => {
      const child = spawnImpl(path.join(toolsDir, 'yt-dlp.exe'), args(source), { windowsHide: true });
      let out = '', err = '', done = false;
      const finish = (error, result) => { if (done) return; done = true; clearTimeout(timer); if (error) reject(error); else resolve(result); };
      const timer = setTimeout(() => { child.kill(); finish(new Error('HLS lookup timed out.')); }, 25000);
      child.stdout?.on('data', (x) => { out += x; if (out.length > 65536) { child.kill(); finish(new Error('HLS lookup too large.')); } });
      child.stderr?.on('data', (x) => { err += x; if (err.length > 65536) err = err.slice(-65536); });
      child.on('error', (e) => finish(e));
      child.on('close', (code) => { if (code) return finish(new Error(err.slice(-300) || 'No HLS playlist.')); try { finish(null, parse(out)); } catch (e) { finish(e); } });
    });
  }
  async function info(source) {
    try {
      collect();
      const media = await resolve(source);
      const token = crypto.randomBytes(24).toString('hex');
      sessions.set(token, { at: now(), headers: media.headers, entries: [media.url] });
      return new Response(JSON.stringify({ url: `/hls-resource?t=${token}&i=0` }), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    } catch (e) { return new Response(String(e.message || e), { status: 404 }); }
  }
  function upstream(raw, headers, signal, hops = 0) {
    return new Promise(async (resolve, reject) => {
      let u, records;
      try {
        u = publicUrl(raw);
        records = await lookupImpl(u.hostname, { all: true });
        if (!records.length || records.some((r) => !publicAddress(r))) throw new Error('Private media address refused.');
      } catch (e) { return reject(e); }
      const selected = records[0];
      let done = false;
      const finish = (err, val) => { if (done) return; done = true; if (signal) signal.removeEventListener('abort', abort); err ? reject(err) : resolve(val); };
      const abort = () => { req.destroy(new Error('Cancelled.')); };
      const req = requestImpl(u, { headers, timeout: 12000, autoSelectFamily: false, lookup: (_host, opts, cb) => opts?.all ? cb(null, [selected]) : cb(null, selected.address, selected.family) }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          if (hops >= 4 || !res.headers.location) return finish(new Error('Too many media redirects.'));
          let next;
          try { next = publicUrl(new URL(res.headers.location, u).href).href; } catch (e) { return finish(e); }
          return upstream(next, headers, signal, hops + 1).then((r) => finish(null, r), (e) => finish(e));
        }
        if (res.statusCode !== 200 && res.statusCode !== 206) { res.resume(); return finish(new Error(`Media status ${res.statusCode}.`)); }
        const chunks = []; let size = 0;
        res.on('data', (chunk) => { size += chunk.length; if (size > LIMIT) res.destroy(new Error('Media response too large.')); else chunks.push(chunk); });
        res.on('error', (e) => finish(e));
        res.on('end', () => finish(null, { url: u.href, body: Buffer.concat(chunks), type: res.headers['content-type'] || '' }));
      });
      req.on('timeout', () => req.destroy(new Error('Media request timed out.')));
      req.on('error', (e) => finish(e));
      if (signal) { if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true }); }
      req.end();
    });
  }
  async function resource(req, token, index) {
    collect();
    const s = sessions.get(token);
    const i = Number(index);
    if (!s || !Number.isSafeInteger(i) || i < 0 || i >= s.entries.length) return new Response('Unknown HLS resource.', { status: 404 });
    try {
      const r = await upstream(s.entries[i], s.headers, req.signal);
      // Detect by content, not extension: signed SoundCloud playlists need not end in .m3u8.
      const text = r.body.subarray(0, 7).toString('utf8');
      if (text !== '#EXTM3U') return new Response(r.body, { headers: { 'content-type': /^(audio\/|video\/|application\/octet-stream)/i.test(r.type) ? r.type : 'application/octet-stream', 'cache-control': 'no-store' } });
      const playlist = r.body.toString('utf8');
      if (/#EXT-X-(?:KEY|SESSION-KEY):/i.test(playlist) || !playlist.startsWith('#EXTM3U') || playlist.length > 2_000_000) throw new Error('Encrypted or oversized HLS playlist.');
      let base = r.url;
      const add = (relative) => {
        const url = publicUrl(new URL(relative, base).href).href;
        if (s.entries.length >= 3000) throw new Error('Too many HLS resources.');
        const n = s.entries.push(url) - 1;
        return `/hls-resource?t=${token}&i=${n}`;
      };
      const rewritten = playlist.split(/\r?\n/).map((line) => {
        if (/^#/.test(line)) return line.replace(/URI="([^"]+)"/g, (_match, uri) => `URI="${add(uri)}"`);
        return line.trim() ? add(line.trim()) : line;
      }).join('\n');
      return new Response(rewritten, { headers: { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' } });
    } catch (e) { return new Response(String(e.message || e), { status: 502 }); }
  }
  return { info, resource, resolve };
}
module.exports = { createHls, args, parse, publicUrl, publicAddress };
