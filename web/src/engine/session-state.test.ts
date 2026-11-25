import { describe, expect, it } from 'vitest';
import { heardIn, unionHeard, QUEUE_STARTED_KEY } from './shuffle-order';
import { SESSION_STOPPED_KEY, writeStoppedAt } from './session';
import {
  SESSION_CLEARED_KEY,
  SESSION_PLAYS_KEY,
  beginFreshSession,
  clearQueueForSession,
  clearedKeys,
  forgetStarted,
  readPlays,
  subtractCleared,
  unclearKey,
  writePlays,
} from './session-state';

const MIN = 60_000;

function store(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    key: (i: number) => Array.from(m.keys())[i] ?? null,
    removeItem: (k: string) => void m.delete(k),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
  } as Storage;
}

describe('fresh session on open', () => {
  it('a pause of more than four minutes clears the play counts and the stop marker', () => {
    const s = store();
    writePlays(s, { a: 2 });
    writeStoppedAt(s, 0);
    expect(beginFreshSession(s, 4 * MIN + 1)).toBe(true);
    expect(readPlays(s)).toEqual({});
    expect(s.getItem(SESSION_STOPPED_KEY)).toBeNull();
  });

  it('exactly four minutes is still the same session', () => {
    const s = store();
    writePlays(s, { a: 2 });
    writeStoppedAt(s, 0);
    expect(beginFreshSession(s, 4 * MIN)).toBe(false);
    expect(readPlays(s)).toEqual({ a: 2 });
    expect(s.getItem(SESSION_STOPPED_KEY)).toBe('0');
  });

  it('no stop marker means nothing to reset', () => {
    const s = store();
    writePlays(s, { a: 2 });
    expect(beginFreshSession(s, 99 * MIN)).toBe(false);
    expect(readPlays(s)).toEqual({ a: 2 });
  });
});

describe('play counts storage', () => {
  it('ignores junk entries and keeps whole positive counts', () => {
    const s = store();
    s.setItem(SESSION_PLAYS_KEY, JSON.stringify({ a: 2, b: 'x', c: -1, d: 0.5 }));
    expect(readPlays(s)).toEqual({ a: 2 });
  });

  it('round-trips what was written', () => {
    const s = store();
    writePlays(s, { a: 1, b: 3 });
    expect(readPlays(s)).toEqual({ a: 1, b: 3 });
  });
});

describe('queue shuffle eligibility', () => {
  it('forgetStarted drops only the given keys and keeps the order', () => {
    const s = store();
    s.setItem(QUEUE_STARTED_KEY, JSON.stringify(['a', 'b', 'c']));
    forgetStarted(s, ['b']);
    expect(JSON.parse(s.getItem(QUEUE_STARTED_KEY) as string)).toEqual(['a', 'c']);
  });

  it('clearQueueForSession forgets the started record and marks the keys as cleared', () => {
    const s = store();
    s.setItem(QUEUE_STARTED_KEY, JSON.stringify(['a', 'b']));
    clearQueueForSession(s, ['a']);
    expect(JSON.parse(s.getItem(QUEUE_STARTED_KEY) as string)).toEqual(['b']);
    expect(clearedKeys(s).has('a')).toBe(true);
  });

  it('an empty queue changes nothing', () => {
    const s = store();
    clearQueueForSession(s, []);
    expect(clearedKeys(s).size).toBe(0);
  });

  it('queued songs stay eligible after the server feedback re-marks them heard', () => {
    const s = store();
    clearQueueForSession(s, ['a']);
    const serverHeard = heardIn({ a: { complete: true }, z: { skip: true } });
    const heard = subtractCleared(unionHeard(serverHeard, new Set<string>()), clearedKeys(s));
    expect(heard.has('a')).toBe(false);
    expect(heard.has('z')).toBe(true);
  });

  it('a queued song becomes heard again once it plays', () => {
    const s = store();
    clearQueueForSession(s, ['a']);
    unclearKey(s, 'a');
    const heard = subtractCleared(unionHeard(heardIn({ a: { complete: true } }), new Set(['a'])), clearedKeys(s));
    expect(heard.has('a')).toBe(true);
  });

  it('unclearKey leaves other cleared keys alone', () => {
    const s = store();
    clearQueueForSession(s, ['a', 'b']);
    unclearKey(s, 'a');
    expect([...clearedKeys(s)]).toEqual(['b']);
    expect(JSON.parse(s.getItem(SESSION_CLEARED_KEY) as string)).toEqual(['b']);
  });
});
