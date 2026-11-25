import { describe, expect, it } from 'vitest';
import {
  IDLE_LIMIT_MS,
  SESSION_STOPPED_KEY,
  countPlay,
  isNewSession,
  readStoppedAt,
  resetSessionCounts,
  sessionOnLaunch,
  shadeStep,
  writeStoppedAt,
  clearStoppedAt,
} from './session';

const MIN = 60_000;

function memoryStorage(): Storage {
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

describe('idle limit', () => {
  it('is exactly four minutes', () => {
    expect(IDLE_LIMIT_MS).toBe(4 * MIN);
  });

  it('a stop just under four minutes keeps the session', () => {
    expect(isNewSession(0, 4 * MIN - 1)).toBe(false);
  });

  it('exactly four minutes keeps the session', () => {
    expect(isNewSession(0, 4 * MIN)).toBe(false);
  });

  it('just over four minutes starts a new session', () => {
    expect(isNewSession(0, 4 * MIN + 1)).toBe(true);
  });

  it('with no recorded stop, nothing is a new session (audio was never stopped)', () => {
    expect(isNewSession(null, 10 * MIN)).toBe(false);
  });

  it('a long background listen is one session: nothing is written while audio runs', () => {
    const s = memoryStorage();
    clearStoppedAt(s); // audio started: the stop marker is cleared
    expect(readStoppedAt(s)).toBeNull();
    expect(isNewSession(readStoppedAt(s), 10 * MIN)).toBe(false);
  });
});

describe('stop marker storage', () => {
  it('writes the stop time in epoch milliseconds and reads it back', () => {
    const s = memoryStorage();
    writeStoppedAt(s, 1_700_000_000_000);
    expect(s.getItem(SESSION_STOPPED_KEY)).toBe('1700000000000');
    expect(readStoppedAt(s)).toBe(1_700_000_000_000);
  });

  it('a corrupt or missing value reads as no stop', () => {
    const s = memoryStorage();
    s.setItem(SESSION_STOPPED_KEY, 'not-a-number');
    expect(readStoppedAt(s)).toBeNull();
  });

  it('clearing removes the marker', () => {
    const s = memoryStorage();
    writeStoppedAt(s, 5);
    clearStoppedAt(s);
    expect(readStoppedAt(s)).toBeNull();
  });
});

describe('launch decision', () => {
  it('a stop longer than the limit starts fresh, paused, at zero', () => {
    expect(sessionOnLaunch(0, 4 * MIN + 1)).toEqual({ fresh: true, paused: true, playheadSec: 0 });
  });

  it('a short stop keeps the current session', () => {
    expect(sessionOnLaunch(0, 60_000)).toEqual({ fresh: false });
  });
});

describe('per-session play counts', () => {
  it('counts plays per song', () => {
    let c = countPlay({}, 'a');
    c = countPlay(c, 'a');
    c = countPlay(c, 'b');
    expect(c).toEqual({ a: 2, b: 1 });
  });

  it('does not mutate the map it was given', () => {
    const before = { a: 1 };
    countPlay(before, 'a');
    expect(before).toEqual({ a: 1 });
  });

  it('a reset clears every count to zero', () => {
    expect(resetSessionCounts({ a: 2, b: 5 })).toEqual({});
  });
});

describe('row shade', () => {
  it('a song never played this session keeps the white default', () => {
    expect(shadeStep(0)).toBe(0);
  });

  it('darkens one step per play', () => {
    expect(shadeStep(1)).toBe(1);
    expect(shadeStep(2)).toBe(2);
  });

  it('is capped so text and icons stay legible', () => {
    expect(shadeStep(3)).toBe(3);
    expect(shadeStep(50)).toBe(3);
  });

  it('ignores nonsense counts', () => {
    expect(shadeStep(-1)).toBe(0);
    expect(shadeStep(Number.NaN)).toBe(0);
  });
});
