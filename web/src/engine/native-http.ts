/**
 * The HttpPort used inside the Android WebView: every request goes through the native bridge
 * (AirwaveNative.request) because the page cannot call the music services directly (CORS). Elsewhere
 * (desktop browser, tests) it falls back to fetch, which works for the services that allow CORS.
 */
import type { HttpPort } from './net';

declare global {
  interface Window {
    AirwaveNative?: { request(id: number, json: string): void; version(): string };
    __awHttp?: (id: number, json: string) => void;
  }
}

const pending = new Map<number, (r: { status: number; headers: Record<string, string>; body: string; error?: string }) => void>();
let next = 1;

const b64 = (s: string): Uint8Array => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export const isNative = (): boolean => typeof window !== 'undefined' && !!window.AirwaveNative;

export function nativeHttpPort(): HttpPort {
  window.__awHttp = (id, json) => {
    const cb = pending.get(id);
    if (!cb) return;
    pending.delete(id);
    cb(JSON.parse(json));
  };
  return {
    request(req, signal) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
        const id = next++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('The request timed out.'));
        }, (req.timeoutMs ?? 30_000) + 5_000);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          pending.delete(id);
          reject(new DOMException('Aborted', 'AbortError'));
        });
        pending.set(id, (r) => {
          clearTimeout(timer);
          if (r.error) return reject(new Error(r.error));
          resolve({ status: r.status, headers: r.headers, body: b64(r.body) });
        });
        window.AirwaveNative!.request(id, JSON.stringify(req));
      });
    },
  };
}

export function fetchHttpPort(): HttpPort {
  return {
    async request(req, signal) {
      const init: RequestInit = { method: req.method, headers: req.headers ?? {} };
      if (req.body !== undefined) init.body = req.body;
      if (signal) init.signal = signal;
      const res = await fetch(req.url, init);
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
      return { status: res.status, headers, body: new Uint8Array(await res.arrayBuffer()) };
    },
  };
}

export const defaultHttpPort = (): HttpPort => (isNative() ? nativeHttpPort() : fetchHttpPort());
