// NATIVE-CLOCK-001. A hidden Android WebView suspends its DOM timers, so metadata pacing, retry backoff
// and the native HTTP deadline must wait on the phone's own clock when the bridge offers one. The DOM
// timers are faked and never advanced here: anything that still waits on setTimeout stalls.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostPacer, Http, type HttpPort, type HttpRequest } from './net';
import { MAX_NATIVE_DELAY_MS, fetchHttpPort, nativeHttpPort } from './native-http';

const ok = (body = '{}') => ({ status: 200, headers: {}, body: new TextEncoder().encode(body) });
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function nativePort(replies: Array<ReturnType<typeof ok>>) {
  const sent: HttpRequest[] = [];
  const waits: Array<{ ms: number; fire: () => void }> = [];
  const port: HttpPort = {
    async request(req) {
      sent.push(req);
      return replies.shift() ?? ok();
    },
    delay(ms) {
      return new Promise<void>((fire) => waits.push({ ms, fire }));
    },
  };
  return { port, sent, waits };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('NATIVE-CLOCK-001 pacing and backoff on the native clock', () => {
  it('holds a second same-host request until the native wait is fulfilled, then completes without DOM timers', async () => {
    const { port, sent, waits } = nativePort([]);
    const http = new Http(port, new HostPacer({ 'api.deezer.com': 0.5 }));
    await http.getJson('https://api.deezer.com/a', { maxBytes: 1000 });
    const second = http.getJson('https://api.deezer.com/b', { maxBytes: 1000 });
    await flush();
    expect(sent.map((r) => r.url)).toEqual(['https://api.deezer.com/a']);
    expect(waits).toHaveLength(1);
    expect(waits[0]!.ms).toBeGreaterThanOrEqual(500);
    waits[0]!.fire();
    await expect(second).resolves.toEqual({});
    expect(sent).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps one spacing across Http instances sharing a pacer', async () => {
    const a = nativePort([]);
    const b = nativePort([]);
    const pacer = new HostPacer({ 'api.deezer.com': 0.5 });
    await new Http(a.port, pacer).getJson('https://api.deezer.com/a', { maxBytes: 1000 });
    const second = new Http(b.port, pacer).getJson('https://api.deezer.com/b', { maxBytes: 1000 });
    await flush();
    expect(b.sent).toHaveLength(0);
    expect(b.waits[0]!.ms).toBeGreaterThanOrEqual(500);
    b.waits[0]!.fire();
    await second;
    expect(b.sent).toHaveLength(1);
  });

  it('backs off a retry on the native clock and never retries early', async () => {
    const { port, sent, waits } = nativePort([{ status: 503, headers: {}, body: new Uint8Array() }, ok('{"x":1}')]);
    const http = new Http(port, new HostPacer({}, 0));
    const got = http.getJson('https://api.deezer.com/a', { maxBytes: 1000 });
    await flush();
    expect(sent).toHaveLength(1);
    expect(waits.map((w) => w.ms)).toEqual([400]);
    waits[0]!.fire();
    await expect(got).resolves.toEqual({ x: 1 });
    expect(sent).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('falls back to DOM timers when the port has no native clock', async () => {
    const sent: string[] = [];
    const port: HttpPort = { request: async (req) => (sent.push(req.url), ok()) };
    const http = new Http(port, new HostPacer({ 'api.deezer.com': 0.5 }));
    await http.getJson('https://api.deezer.com/a', { maxBytes: 1000 });
    const second = http.getJson('https://api.deezer.com/b', { maxBytes: 1000 });
    await vi.advanceTimersByTimeAsync(499);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(sent).toHaveLength(2);
  });

  it('does not bypass the spacing when the native clock refuses a wait', async () => {
    const sent: string[] = [];
    const port: HttpPort = { request: async (req) => (sent.push(req.url), ok()), delay: () => Promise.reject(new RangeError('refused')) };
    const http = new Http(port, new HostPacer({ 'api.deezer.com': 0.5 }));
    await http.getJson('https://api.deezer.com/a', { maxBytes: 1000 });
    const second = http.getJson('https://api.deezer.com/b', { maxBytes: 1000 });
    await vi.advanceTimersByTimeAsync(499);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(sent).toHaveLength(2);
  });
});

function stubBridge(withClock = true) {
  const scheduled: Array<{ id: number; ms: number }> = [];
  const cancelled: number[] = [];
  const requests: Array<{ id: number; json: string }> = [];
  const bridge: Record<string, unknown> = {
    version: () => 'test',
    request: (id: number, json: string) => requests.push({ id, json }),
  };
  if (withClock) {
    bridge.delay = (id: number, ms: number) => (scheduled.push({ id, ms }), true);
    bridge.cancelDelay = (id: number) => cancelled.push(id);
  }
  const win: Record<string, unknown> = { AirwaveNative: bridge };
  vi.stubGlobal('window', win);
  const fire = (id: number) => (win.__awDelay as (id: number) => void)(id);
  const reply = (id: number, r: object) => (win.__awHttp as (id: number, json: string) => void)(id, JSON.stringify(r));
  return { scheduled, cancelled, requests, fire, reply, bridge };
}

describe('NATIVE-CLOCK-001 Android adapter', () => {
  it('resolves a wait from the native callback only', async () => {
    const b = stubBridge();
    const port = nativeHttpPort();
    let done = false;
    const w = port.delay!(250).then(() => (done = true));
    expect(b.scheduled).toEqual([{ id: expect.any(Number), ms: 250 }]);
    await flush();
    expect(done).toBe(false);
    b.fire(b.scheduled[0]!.id);
    await w;
    expect(done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels the native job and forgets the callback on abort', async () => {
    const b = stubBridge();
    const port = nativeHttpPort();
    const ac = new AbortController();
    const w = port.delay!(250, ac.signal);
    const id = b.scheduled[0]!.id;
    ac.abort();
    await expect(w).rejects.toMatchObject({ name: 'AbortError' });
    expect(b.cancelled).toEqual([id]);
    expect(() => b.fire(id)).not.toThrow();
  });

  it('rejects out-of-range waits instead of shortening them', async () => {
    const b = stubBridge();
    const port = nativeHttpPort();
    await expect(port.delay!(-1)).rejects.toThrow(RangeError);
    await expect(port.delay!(Number.NaN)).rejects.toThrow(RangeError);
    await expect(port.delay!(MAX_NATIVE_DELAY_MS + 1)).rejects.toThrow(RangeError);
    expect(b.scheduled).toEqual([]);
    port.delay!(10.2);
    expect(b.scheduled[0]!.ms).toBe(11);
  });

  it('rejects when the bridge refuses the job', async () => {
    const b = stubBridge();
    b.bridge.delay = () => false;
    await expect(nativeHttpPort().delay!(10)).rejects.toThrow(RangeError);
  });

  it('arms the request deadline on the native clock and cancels it on reply', async () => {
    const b = stubBridge();
    const port = nativeHttpPort();
    const got = port.request({ url: 'https://api.deezer.com/a', method: 'GET', timeoutMs: 1000 });
    expect(b.scheduled).toEqual([{ id: expect.any(Number), ms: 6000 }]);
    b.reply(b.requests[0]!.id, { status: 200, headers: {}, body: btoa('{}') });
    await expect(got).resolves.toMatchObject({ status: 200 });
    expect(b.cancelled).toEqual([b.scheduled[0]!.id]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times a request out from the native deadline', async () => {
    const b = stubBridge();
    const port = nativeHttpPort();
    const got = port.request({ url: 'https://api.deezer.com/a', method: 'GET', timeoutMs: 1000 });
    b.fire(b.scheduled[0]!.id);
    await expect(got).rejects.toThrow('timed out');
    b.reply(b.requests[0]!.id, { status: 200, headers: {}, body: '' });
  });

  it('keeps an older bridge without a clock on DOM timers', async () => {
    stubBridge(false);
    const port = nativeHttpPort();
    expect(port.delay).toBeUndefined();
    const got = port.request({ url: 'https://api.deezer.com/a', method: 'GET', timeoutMs: 1000 });
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(6000);
    await expect(got).rejects.toThrow('timed out');
    expect(fetchHttpPort().delay).toBeUndefined();
  });
});
