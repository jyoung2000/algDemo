/**
 * PLAYLIST-DELTA-001: the page's side. It remembers each list's songs under the version the engine named, says
 * what it holds on every call, and puts the songs back for the lists the engine did not send again, so the rest
 * of the app still sees whole lists.
 */
import { describe, expect, it } from 'vitest';
import { ListCache, keepTrying, type WireList } from './playlist-delta';

const item = (key: string) => ({ key, added: 1, track: null, played: false });
const wire = (id: string, rev: string, keys: string[] | null, extra: Partial<WireList> = {}): WireList =>
  ({ id, name: id.toUpperCase(), created: 1, count: keys?.length ?? 0, unplayed: 0, discovery_ready: false, album: null, rev, ...(keys ? { items: keys.map(item) } : {}), ...extra });

describe('PLAYLIST-DELTA-001: the page keeps what it was sent', () => {
  it('fills a list the engine marked unchanged from what it holds', async () => {
    const c = new ListCache();
    const asked: Record<string, string>[] = [];
    const first = await c.read(async (have) => { asked.push(have); return { lists: [wire('a', '1', ['x', 'y']), wire('b', '1', ['z'])] }; });
    expect(first.lists.map((l) => l.items.map((i) => i.key))).toEqual([['x', 'y'], ['z']]);
    const second = await c.read(async (have) => { asked.push(have); return { lists: [wire('a', '1', null, { same: true, count: 2 }), wire('b', '2', ['z', 'w'])] }; });
    expect(asked).toEqual([{}, { a: '1', b: '1' }]);
    expect(second.lists.map((l) => l.items.map((i) => i.key))).toEqual([['x', 'y'], ['z', 'w']]);
    // The fields only the wire needs do not reach the app.
    expect(second.lists.some((l) => 'same' in l || 'more' in l)).toBe(false);
  });

  it('keeps asking until every list it lacks has arrived', async () => {
    const c = new ListCache();
    const server: Record<string, string[]> = { a: ['1'], b: ['2'], c: ['3'] };
    let calls = 0;
    const answer = async (have: Record<string, string>) => {
      calls++;
      let sent = false;
      return { lists: Object.entries(server).map(([id, keys]) => {
        if (have[id] === 'r') return wire(id, 'r', null, { same: true, count: 1 });
        if (sent) return wire(id, 'r', null, { more: true, count: 1 });
        sent = true;
        return wire(id, 'r', keys);
      }) };
    };
    const r = await c.read(answer, answer);
    expect(calls).toBe(3);
    expect(r.lists.map((l) => l.items.map((i) => i.key))).toEqual([['1'], ['2'], ['3']]);
  });

  it('forgets a deleted list and survives an engine that knows nothing of versions', async () => {
    const c = new ListCache();
    await c.read(async () => ({ lists: [wire('a', '1', ['x']), wire('b', '1', ['y'])] }));
    const r = await c.read(async () => ({ lists: [wire('b', '1', null, { same: true, count: 1 })] }));
    expect(r.lists.map((l) => l.id)).toEqual(['b']);
    expect(c.held()).toEqual({ b: '1' });
    // An older engine: no rev, songs always present.
    const old = await new ListCache().read(async () => ({ lists: [{ ...wire('a', '', ['x']), rev: undefined }] }));
    expect(old.lists[0]!.items.map((i) => i.key)).toEqual(['x']);
  });

  it('asks again from nothing rather than show a list without its songs', async () => {
    const c = new ListCache();
    const seen: Record<string, string>[] = [];
    // The engine says "same" for a list this page does not hold (a page reloaded under a living engine).
    const r = await c.read(
      async (have) => { seen.push(have); return { lists: [wire('a', '7', null, { same: true, count: 1 })] }; },
      async (have) => { seen.push(have); return { lists: [wire('a', '7', ['x'])] }; },
    );
    expect(r.lists[0]!.items.map((i) => i.key)).toEqual(['x']);
    expect(seen.length).toBe(2);
  });

  it('gives up with an error, not a half list, when the engine never sends the songs', async () => {
    const c = new ListCache();
    const stuck = async () => ({ lists: [wire('a', '1', null, { more: true, count: 3 })] });
    await expect(c.read(stuck, stuck)).rejects.toThrow(/could not be loaded/i);
  });
});

describe('PLAYLIST-KEEP-001: a failed read is tried again, never shown as empty', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('delivers the first answer that arrives and nothing for the failures before it', async () => {
    const waits: (() => void)[] = [];
    const answers: (string[] | Error)[] = [new Error('busy'), new Error('timeout'), ['a', 'b']];
    const seen: string[][] = [];
    keepTrying(async () => { const a = answers.shift()!; if (a instanceof Error) throw a; return a; }, (v) => seen.push(v), { schedule: (fn) => { waits.push(fn); return fn; }, cancel: () => undefined });
    await flush();
    expect(seen).toEqual([]);
    waits.shift()!(); await flush();
    expect(seen).toEqual([]);
    waits.shift()!(); await flush();
    expect(seen).toEqual([['a', 'b']]);
    expect(waits.length).toBe(0);
  });

  it('stops asking when told to, and after its tries are spent', async () => {
    const waits: (() => void)[] = [];
    let reads = 0;
    const stop = keepTrying(async () => { reads++; throw new Error('no'); }, () => undefined, { tries: 2, schedule: (fn) => { waits.push(fn); return fn; }, cancel: (h) => { waits.splice(waits.indexOf(h as () => void), 1); } });
    await flush();
    expect(waits.length).toBe(1);
    stop();
    expect(waits.length).toBe(0);
    const spent: (() => void)[] = [];
    reads = 0;
    keepTrying(async () => { reads++; throw new Error('no'); }, () => undefined, { tries: 2, schedule: (fn) => { spent.push(fn); return fn; }, cancel: () => undefined });
    for (let i = 0; i < 6; i++) { await flush(); spent.shift()?.(); }
    expect(reads).toBe(3);
  });
});
