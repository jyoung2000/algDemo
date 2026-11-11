'use strict';
/**
 * STREAM-DL-001. Owner: "can we listen to a song while downloading it from source platforms".
 *
 * While a chosen song's download runs, the page can play the same song straight from its source:
 * yt-dlp names the source's own audio file (the format the download keeps, Opus in WebM from
 * YouTube), and this module serves it at the app's origin so the page routes it through its own
 * deck and EQ, exactly as it does a finished file. Range requests pass through, so the player knows
 * the song's length and can seek in it.
 *
 * A progressive audio file from any yt-dlp-approved source is served at the app's origin so the
 * existing deck/EQ works and Range requests allow seeking. Sources that expose only segmented HLS
 * need a separate playlist path; they must never be mislabelled as progressive audio.
 *
 * Measured 2026-11-10 with the bundled yt-dlp: a 3-minute YouTube song's download took 2.65 s
 * against 2.87 s to its first streamed bytes; a 63 MB hour-long upload took 6.5 s against 2.75 s.
 */
const { spawn } = require('node:child_process');
const dns = require('node:dns').promises;
const https = require('node:https');
const { Readable } = require('node:stream');
const path = require('node:path');
const { urlAllowedFor } = require('./downloads.cjs');
const { publicUrl, publicAddress } = require('./hls.cjs');

/** A resolved link is reused this long at most, and never past the source's own expiry. */
const STREAM_TTL_MS = 20 * 60 * 1000;
const RESOLVE_TIMEOUT_MS = 25_000;
/** Response headers worth passing to the page; everything else stays behind. */
const PASS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];

/** Match the downloader's single-source URL check; the media format is checked after yt-dlp resolves. */
function streamable(raw) {
  return urlAllowedFor('yt-dlp', raw);
}

/** yt-dlp's arguments: name the best progressive audio file, print it as JSON, download nothing. */
function streamArgs(url) {
  return ['--ignore-config', '--no-colors', '--no-cache-dir', '--no-playlist', '--no-warnings', '-f', 'bestaudio[protocol=https]/bestaudio[protocol=http]/best[protocol=https]/best[protocol=http]', '--print', '%(.{url,http_headers,ext,acodec,vcodec,protocol,duration})j', '--', url];
}

/** The printed JSON, checked: an http(s) file on the open web, with the headers yt-dlp would send. */
function parseStream(stdout) {
  const line = String(stdout || '').split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith('{'));
  if (!line) throw new Error('yt-dlp named no audio file.');
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    throw new Error('yt-dlp answered in a form this app does not read.');
  }
  if (o.protocol !== 'https' && o.protocol !== 'http') throw new Error(`The source offers this song only as ${o.protocol || 'segments'}, which cannot be streamed here.`);
  if (o.acodec === 'none' || o.acodec === null) throw new Error('The source named no audio stream.');
  if (o.vcodec && !['none', 'unknown'].includes(o.vcodec)) throw new Error('The source named video rather than an audio-only song.');
  if (o.ext && !['mp3', 'm4a', 'aac', 'flac', 'opus', 'ogg', 'oga', 'wav', 'webm'].includes(o.ext)) throw new Error('The source named an unsupported audio file.');
  let u;
  try { u = new URL(String(o.url)); } catch { throw new Error('yt-dlp named no audio file.'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('yt-dlp named no audio file.');
  u = publicUrl(u.href);
  const headers = {};
  for (const k of ['User-Agent', 'Referer', 'Origin', 'Accept', 'Accept-Language']) if (typeof o.http_headers?.[k] === 'string' && o.http_headers[k].length < 1024) headers[k] = o.http_headers[k];
  const expire = Number(u.searchParams.get('expire'));
  return { url: u.toString(), headers, ext: String(o.ext || ''), duration: Number(o.duration) || null, expiresAt: Number.isFinite(expire) && expire > 0 ? expire * 1000 : null };
}

/**
 * @param {{ toolsDir: string, spawnImpl?: typeof spawn, fetchImpl?: (url: string, init: any) => Promise<Response>, lookupImpl?: typeof dns.lookup, requestImpl?: typeof https.request, now?: () => number }} cfg
 */
function createStreams(cfg) {
  const run = cfg.spawnImpl || spawn;
  // One line per stream that could not be had, so a song that waited for its download says why.
  const log = cfg.log || ((line) => console.warn(`[stream] ${line}`));
  const now = cfg.now || Date.now;
  const lookupImpl = cfg.lookupImpl || dns.lookup;
  // Electron's net.fetch performs its own DNS lookup, so production uses https.request with a
  // validated, pinned address while retaining the original hostname for TLS and Host.
  function requestPinned(u, headers, selected, signal) {
    return new Promise((resolve, reject) => {
      const r = (cfg.requestImpl || https.request)(u, {
        headers, signal, timeout: 12000,
        lookup: (_host, opts, callback) => opts?.all ? callback(null, [selected]) : callback(null, selected.address, selected.family),
      }, (upstream) => {
        const responseHeaders = {};
        for (const k of [...PASS, 'location']) if (upstream.headers[k]) responseHeaders[k] = upstream.headers[k];
        resolve(new Response(Readable.toWeb(upstream), { status: upstream.statusCode, headers: responseHeaders }));
      });
      r.on('timeout', () => r.destroy(new Error('Media request timed out.')));
      r.on('error', reject);
      r.end();
    });
  }
  async function fetchPublic(raw, headers, signal, hops = 0) {
    const u = publicUrl(raw);
    const addresses = await lookupImpl(u.hostname, { all: true });
    if (!addresses.length || addresses.some((address) => !publicAddress(address))) throw new Error('Private media address refused.');
    const r = cfg.fetchImpl
      ? await cfg.fetchImpl(u.href, { headers, signal, redirect: 'manual' })
      : await requestPinned(u, headers, addresses[0], signal);
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      void r.body?.cancel().catch(() => {});
      if (hops >= 4 || !r.headers.get('location')) throw new Error('Too many media redirects.');
      return fetchPublic(new URL(r.headers.get('location'), u).href, headers, signal, hops + 1);
    }
    return r;
  }
  /** @type {Map<string, { at: number, value?: any, pending?: Promise<any> }>} */
  const known = new Map();

  function lookUp(url) {
    return new Promise((resolve, reject) => {
      const child = run(path.join(cfg.toolsDir, 'yt-dlp.exe'), streamArgs(url), { windowsHide: true });
      let out = '';
      let err = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('The source took too long to answer.')); }, RESOLVE_TIMEOUT_MS);
      child.stdout?.on('data', (d) => { out += d; });
      child.stderr?.on('data', (d) => { err += d; });
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(String(err).split(/\r?\n/).reverse().find((l) => /error/i.test(l))?.slice(0, 300) || `yt-dlp stopped (${code}).`));
        try { resolve(parseStream(out)); } catch (e) { reject(e); }
      });
    });
  }

  /** The source's audio file for a link: asked once, shared by every request that arrives meanwhile. */
  function resolve(url) {
    if (!streamable(url)) return Promise.reject(new Error('Not a link this app streams from.'));
    const hit = known.get(url);
    const t = now();
    if (hit?.pending) return hit.pending;
    if (hit?.value && t - hit.at < STREAM_TTL_MS && (!hit.value.expiresAt || hit.value.expiresAt - t > 60_000)) return Promise.resolve(hit.value);
    const pending = lookUp(url).then(
      (value) => { known.set(url, { at: now(), value }); return value; },
      (e) => { known.delete(url); log(`no stream for ${url} after ${now() - t} ms: ${e && e.message || e}`); throw e; },
    );
    known.set(url, { at: t, pending });
    if (known.size > 64) known.delete(known.keys().next().value);
    return pending;
  }

  /** Serve the source's audio for `sourceUrl` at the app's origin, one range at a time. */
  async function serve(req, sourceUrl) {
    let s;
    try {
      s = await resolve(sourceUrl);
    } catch (e) {
      return new Response(String(e && e.message || e), { status: 404, headers: { 'content-type': 'text/plain' } });
    }
    const range = req.headers.get('range');
    const headers = { ...s.headers, ...(range && /^bytes=\d*-\d*$/.test(range) ? { Range: range } : {}) };
    let r;
    try {
      r = await fetchPublic(s.url, headers, req.signal);
    } catch (e) {
      return new Response(String(e && e.message || e), { status: 502, headers: { 'content-type': 'text/plain' } });
    }
    if (r.status === 403 || r.status === 410) known.delete(sourceUrl); // the link expired: ask afresh next time
    if (r.status !== 200 && r.status !== 206) {
      log(`the source answered ${r.status} for ${sourceUrl}`);
      return new Response(`The source answered ${r.status}.`, { status: 502, headers: { 'content-type': 'text/plain' } });
    }
    const out = { 'cache-control': 'no-cache' };
    for (const k of PASS) { const v = r.headers.get(k); if (v) out[k] = v; }
    if (r.status === 206 && !out['accept-ranges']) out['accept-ranges'] = 'bytes';
    return new Response(r.body, { status: r.status, headers: out });
  }

  return { resolve, serve, streamable };
}

module.exports = { createStreams, streamArgs, parseStream, streamable };
