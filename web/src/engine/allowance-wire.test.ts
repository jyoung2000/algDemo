/**
 * ALLOWANCE-ARCH-001: the allowance is charged what the network carried, not the unpacked answer. Measured 2026-11-20:
 * a YouTube Music song search is 683,896 bytes unpacked and 39,350 on the wire, so the day was charged 17 times the
 * data really used. The shells now report the wire size and whether the connection is metered with every answer.
 */
import { describe, expect, it } from 'vitest';
import { BudgetExceeded, Http, HostPacer, Meter, type HttpPort, type HttpResponse } from './net';
import { MemoryBackend, Store } from './store';

const URL_ = 'https://api.deezer.com/search?q=a';
const answer = (bytes: number, extra: Partial<HttpResponse> = {}): HttpPort => ({ request: async () => ({ status: 200, headers: {}, body: new Uint8Array(bytes), ...extra }) });
const http = (port: HttpPort) => new Http(port, new HostPacer({}, 0));

describe('counting what the network carried', () => {
  it('charges the wire size when the shell reports it', async () => {
    const meter = new Meter(1_000_000, 1_000_000);
    await http(answer(680_000, { wireBytes: 39_000 })).get(URL_, { maxBytes: 4_000_000, meter });
    expect(meter.total).toBe(39_000);
  });
  it('an answer bigger than what is left unpacked still fits when it was small on the wire', async () => {
    const meter = new Meter(100_000, 100_000);
    const r = await http(answer(680_000, { wireBytes: 39_000 })).get(URL_, { maxBytes: 4_000_000, meter });
    expect(r.response.body.byteLength).toBe(680_000);
    expect(meter.remaining()).toBe(61_000);
  });
  it('the request\'s own size limit still bounds the unpacked answer', async () => {
    const meter = new Meter(1_000_000, 1_000_000);
    await expect(http(answer(680_000, { wireBytes: 39_000 })).get(URL_, { maxBytes: 500_000, meter })).rejects.toBeInstanceOf(BudgetExceeded);
  });
  it('a wire size over what is left is refused and still charged', async () => {
    const meter = new Meter(30_000, 30_000);
    await expect(http(answer(680_000, { wireBytes: 39_000 })).get(URL_, { maxBytes: 4_000_000, meter })).rejects.toBeInstanceOf(BudgetExceeded);
    expect(meter.total).toBe(39_000);
  });
  it('a shell that reports no wire size is charged the answer as before', async () => {
    const meter = new Meter(1_000_000, 1_000_000);
    await http(answer(50_000)).get(URL_, { maxBytes: 4_000_000, meter });
    expect(meter.total).toBe(50_000);
    await expect(http(answer(50_000)).get(URL_, { maxBytes: 4_000_000, meter: new Meter(40_000, 40_000) })).rejects.toBeInstanceOf(BudgetExceeded);
  });
  it('a nonsense wire size is ignored', async () => {
    for (const wireBytes of [-1, Number.NaN, 1.5] as number[]) {
      const meter = new Meter(1_000_000, 1_000_000);
      await http(answer(50_000, { wireBytes })).get(URL_, { maxBytes: 4_000_000, meter });
      expect(meter.total, String(wireBytes)).toBe(50_000);
    }
  });
});

describe('hearing about the network', () => {
  it('passes on whether the connection is metered, and says nothing when the shell does not', async () => {
    const seen: (boolean | null)[] = [];
    const h = http(answer(10, { metered: false }));
    h.onMetered = (m) => seen.push(m);
    await h.get(URL_, { maxBytes: 1000 });
    const quiet = http(answer(10));
    quiet.onMetered = (m) => seen.push(m);
    await quiet.get(URL_, { maxBytes: 1000 });
    expect(seen).toEqual([false]);
  });
});

describe('the day and the lanes in the record', () => {
  it('a day is the listener\'s own calendar day, not UTC', async () => {
    const store = await Store.open(new MemoryBackend());
    store.addTransfer('metadata', 5);
    const d = new Date();
    const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    expect(store.transferToday(local)).toEqual({ metadata: 5 });
  });
  it('bytes are kept by lane and still add up by kind', async () => {
    const store = await Store.open(new MemoryBackend());
    store.addTransfer('metadata', 5, undefined, 'background');
    store.addTransfer('metadata', 7, undefined, 'interactive');
    store.addTransfer('search', 2, undefined, 'interactive');
    store.addTransfer('audio', 1);
    expect(store.transferToday()).toEqual({ metadata: 12, search: 2, audio: 1 });
    expect(store.transferLanes()).toEqual({ background: 5, interactive: 9, other: 1 });
    expect(store.clearTransfer()).toBe(15);
    expect(store.transferLanes()).toEqual({});
  });
});
