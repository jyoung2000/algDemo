'use strict';
// The Windows twin of MainActivity.Bridge.request: one guarded HTTPS request on behalf of the page.
// https only, allow-listed hosts only, redirects are returned (the page re-checks every hop), the body
// is capped, and nothing is written to disk.
const https = require('node:https');
const { hostAllowed } = require('./hosts.cjs');

function request(json) {
  return new Promise((resolve) => {
    let req;
    try {
      req = JSON.parse(json);
    } catch (e) {
      return resolve({ error: 'BadRequest: not JSON' });
    }
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
    const headers = {};
    for (const [k, v] of Object.entries(req.headers || {})) headers[k] = String(v);
    const body = req.body != null ? Buffer.from(String(req.body), 'utf8') : null;
    if (body) headers['content-length'] = String(body.length);
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
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > cap) {
            res.destroy();
            return done({ error: `IOException: response larger than ${cap} bytes` });
          }
          chunks.push(c);
        });
        res.on('end', () => {
          const out = {};
          for (const [k, v] of Object.entries(res.headers)) out[k.toLowerCase()] = Array.isArray(v) ? v[v.length - 1] : String(v);
          done({ status: res.statusCode || 0, headers: out, body: Buffer.concat(chunks).toString('base64') });
        });
        res.on('error', (e) => done({ error: `${e.name}: ${e.message}` }));
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

module.exports = { request };
