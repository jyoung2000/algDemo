'use strict';
// The Windows twin of MainActivity.Bridge.request: one guarded HTTPS request on behalf of the page.
// https only, allow-listed hosts only, redirects are returned (the page re-checks every hop), the body
// is capped, and nothing is written to disk.
//
// ALLOWANCE-ARCH-001: answers are asked for packed (gzip) and unpacked here, and each one says how many
// bytes the network carried (`wire`) and whether Windows calls the connection metered (`metered`).
const https = require('node:https');
const zlib = require('node:zlib');
const { hostAllowed } = require('./hosts.cjs');
const metered = require('./metered.cjs');

/** The headers sent: the page's own, gzip asked for unless the page chose an encoding, and a body's length. */
function outgoingHeaders(asked, body) {
  const headers = {};
  for (const [k, v] of Object.entries(asked || {})) headers[k] = String(v);
  if (!Object.keys(headers).some((k) => k.toLowerCase() === 'accept-encoding')) headers['accept-encoding'] = 'gzip';
  if (body) headers['content-length'] = String(body.length);
  return headers;
}

/** Reads one response: `{status, headers, body(base64), wire, metered}` or `{error}`. `cap` bounds the unpacked body. */
function receive(res, cap, isMetered = metered.current) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
    const packed = encoding === 'gzip' || encoding === 'x-gzip';
    const chunks = [];
    let size = 0;
    let wire = 0;
    res.on('data', (c) => {
      wire += c.length;
    });
    res.on('error', (e) => done({ error: `${e.name}: ${e.message}` }));
    const body = packed ? res.pipe(zlib.createGunzip()) : res;
    if (packed) body.on('error', (e) => done({ error: `IOException: ${e.message}` }));
    body.on('data', (c) => {
      size += c.length;
      if (size > cap) {
        res.destroy();
        return done({ error: `IOException: response larger than ${cap} bytes` });
      }
      chunks.push(c);
    });
    body.on('end', () => {
      const out = {};
      for (const [k, v] of Object.entries(res.headers)) out[k.toLowerCase()] = Array.isArray(v) ? v[v.length - 1] : String(v);
      if (packed) {
        // The page gets the unpacked body: the packed length and encoding no longer describe it.
        delete out['content-encoding'];
        delete out['content-length'];
      }
      done({ status: res.statusCode || 0, headers: out, body: Buffer.concat(chunks).toString('base64'), wire, metered: isMetered() });
    });
  });
}

function request(json) {
  return new Promise((resolve) => {
    let req;
    try {
      req = JSON.parse(json);
    } catch (e) {
      return resolve({ error: 'BadRequest: not JSON' });
    }
    // Is the connection metered? Answered from what Windows says; uses no network.
    if (req && req.probe === 'network') return resolve({ status: 204, headers: {}, body: '', wire: 0, metered: metered.current() });
    let url;
    try {
      url = new URL(String(req.url));
    } catch (e) {
      return resolve({ error: 'BadRequest: bad url' });
    }
    if (url.protocol !== 'https:' || !hostAllowed(url.hostname)) {
      return resolve({ error: `SecurityException: host not allowed: ${url.hostname}` });
    }
    const cap = Number.isFinite(req.maxBytes) ? req.maxBytes : 8_000_000;
    const timeout = Number.isFinite(req.timeoutMs) ? req.timeoutMs : 30_000;
    const body = req.body != null ? Buffer.from(String(req.body), 'utf8') : null;
    const headers = outgoingHeaders(req.headers, body);
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const r = https.request(
      { protocol: 'https:', hostname: url.hostname, port: url.port || 443, path: url.pathname + url.search, method: req.method || 'GET', headers, timeout },
      (res) => {
        receive(res, cap).then(done);
      },
    );
    r.on('timeout', () => {
      r.destroy();
      done({ error: 'SocketTimeoutException: timed out' });
    });
    r.on('error', (e) => done({ error: `${e.name}: ${e.message}` }));
    if (body) r.write(body);
    r.end();
  });
}

module.exports = { request, receive, outgoingHeaders };
