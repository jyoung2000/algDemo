/**
 * The HttpPort used inside the Android WebView: every request goes through the native bridge
 * (AirwaveNative.request) because the page cannot call the music services directly (CORS). Elsewhere
 * (desktop browser, tests) it falls back to fetch, which works for the services that allow CORS.
 */
import type { HttpPort } from './net';

declare global {
  interface Window {
    AirwaveNative?: {
      request(id: number, json: string): void;
      version(): string;
      /** NATIVE-CLOCK-001 (newer bridges only): call window.__awDelay(id) once, no sooner than ms. */
      delay?(id: number, ms: number): boolean;
      cancelDelay?(id: number): void;
    };
    __awHttp?: (id: number, json: string) => void;
    __awDelay?: (id: number) => void;
  }
}

const pending = new Map<number, (r: { status: number; headers: Record<string, string>; body: string; error?: string }) => void>();
let next = 1;

/** Mirrors NativeClock.MAX_DELAY_MS / MAX_PENDING on the phone. */
export const MAX_NATIVE_DELAY_MS = 120_000;
const MAX_PENDING_DELAYS = 256;
const waits = new Map<number, () => void>();
let nextWait = 1;

const b64 = (s: string): Uint8Array => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export const isNative = (): boolean => typeof window !== 'undefined' && !!window.AirwaveNative;

const hasClock = (): boolean => typeof window.AirwaveNative?.delay === 'function' && typeof window.AirwaveNative?.cancelDelay === 'function';

/**
 * Schedules `fire` on the phone's clock (a hidden page's DOM timers are suspended). Returns a cancel
 * function, or throws RangeError when the wait cannot be honoured in full: never shortened.
 */
function nativeTimer(ms: number, fire: () => void): () => void {
  if (!Number.isFinite(ms) || ms < 0 || ms > MAX_NATIVE_DELAY_MS) throw new RangeError(`native delay out of range: ${ms}`);
  if (waits.size >= MAX_PENDING_DELAYS) throw new RangeError('too many native delays pending');
  const id = nextWait++;
  waits.set(id, fire);
  let accepted = false;
  try {
    accepted = window.AirwaveNative!.delay!(id, Math.ceil(ms)) === true;
  } finally {
    if (!accepted) waits.delete(id);
  }
  if (!accepted) throw new RangeError('native delay refused');
  return () => {
    if (waits.delete(id)) window.AirwaveNative?.cancelDelay?.(id);
  };
}

/**
 * A pause that still ends while the page is hidden (CAR-SIMILAR-001 polls a job from the car with the
 * phone's screen off): the phone's clock when the bridge has one, else a DOM timer.
 */
export function phoneWait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window !== 'undefined' && hasClock() && window.__awDelay) {
      try { nativeTimer(ms, resolve); return; } catch { /* fall back to the DOM timer */ }
    }
    setTimeout(resolve, ms);
  });
}

export function nativeHttpPort(): HttpPort {
  window.__awHttp = (id, json) => {
    const cb = pending.get(id);
    if (!cb) return;
    pending.delete(id);
    cb(JSON.parse(json));
  };
  const clock = hasClock();
  if (clock) {
    window.__awDelay = (id) => {
      const fire = waits.get(id);
      if (!fire) return;
      waits.delete(id);
      fire();
    };
  }
  /** The request deadline: native when the bridge has a clock and the span fits, else a DOM timer. */
  const deadline = (ms: number, fire: () => void): (() => void) => {
    if (clock) {
      try {
        return nativeTimer(ms, fire);
      } catch {
        // fall through to the DOM timer
      }
    }
    const t = setTimeout(fire, ms);
    return () => clearTimeout(t);
  };
  const port: HttpPort = {
    request(req, signal) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
        const id = next++;
        const disarm = deadline((req.timeoutMs ?? 30_000) + 5_000, () => {
          pending.delete(id);
          reject(new Error('The request timed out.'));
        });
        signal?.addEventListener('abort', () => {
          disarm();
          pending.delete(id);
          reject(new DOMException('Aborted', 'AbortError'));
        });
        pending.set(id, (r) => {
          disarm();
          if (r.error) return reject(new Error(r.error));
          resolve({ status: r.status, headers: r.headers, body: b64(r.body) });
        });
        window.AirwaveNative!.request(id, JSON.stringify(req));
      });
    },
  };
  if (clock) {
    port.delay = (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
        const onAbort = () => {
          cancel();
          reject(new DOMException('Aborted', 'AbortError'));
        };
        const cancel = nativeTimer(ms, () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        });
        signal?.addEventListener('abort', onAbort, { once: true });
      });
  }
  return port;
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
