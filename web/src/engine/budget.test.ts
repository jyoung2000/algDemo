/**
 * ALLOWANCE-ARCH-001 (owner, 2026-11-20): "architect the app so the user doesn't hit the daily limit and the app
 * automatically tries to refresh the user daily limit"; "the allowance shouldn't apply on wifi, keep 100mb as default,
 * full song download shouldn't get limited".
 *
 * Before: one bucket per calendar day (UTC) for everything. Background work (queue top-ups, genre and album look-ups)
 * emptied it, and then the listener's own search was refused until the next day or a manual refresh.
 * Now: three lanes. What the listener asks for and what a song needs to play are counted but never refused; only
 * background work draws on the allowance, which is a reserve that refills all day and does not apply off mobile data.
 */
import { describe, expect, it } from 'vitest';
import { Budget, RESERVE_KEY } from './budget';
import { MemoryBackend, Store } from './store';

const MB = 1_000_000;
async function open(capMb = 100, backend = new MemoryBackend()) {
  const store = await Store.open(backend);
  const clock = { now: 1_800_000_000, cap: capMb };
  const budget = new Budget(store, () => clock.cap * MB, () => clock.now);
  return { store, budget, clock, backend };
}
const spend = (b: Budget, lane: 'interactive' | 'playback' | 'background', n: number) => b.meter(lane, 50 * MB).add('metadata', n);

describe('the allowance governs background work only', () => {
  it('starts full at the Settings value', async () => {
    const { budget } = await open();
    expect(budget.state()).toMatchObject({ capacity: 100 * MB, level: 100 * MB, paused: false, resumes_at: null, unmetered: false });
  });
  it('what the listener asks for and what a song needs to play are never limited, even with the reserve empty', async () => {
    const { budget } = await open();
    spend(budget, 'background', 100 * MB);
    expect(budget.state().level).toBe(0);
    expect(budget.meter('interactive', 6 * MB).remaining()).toBe(6 * MB);
    expect(budget.meter('playback', 8 * MB).remaining()).toBe(8 * MB);
    spend(budget, 'interactive', 30 * MB);
    spend(budget, 'playback', 30 * MB);
    expect(budget.state().level).toBe(0);
  });
  it('asked-for and playback bytes do not drain the reserve, but are counted by lane', async () => {
    const { budget } = await open();
    spend(budget, 'interactive', 7 * MB);
    spend(budget, 'playback', 5 * MB);
    spend(budget, 'background', 3 * MB);
    const s = budget.state();
    expect(s.level).toBe(97 * MB);
    expect(s.today).toEqual({ interactive: 7 * MB, playback: 5 * MB, background: 3 * MB });
  });
  it('background work is bounded by what is left of the reserve, and by its own request cap', async () => {
    const { budget } = await open();
    expect(budget.meter('background', 20 * MB).remaining()).toBe(20 * MB);
    spend(budget, 'background', 97 * MB);
    expect(budget.meter('background', 20 * MB).remaining()).toBe(3 * MB);
    spend(budget, 'background', 3 * MB);
    expect(budget.meter('background', 20 * MB).remaining()).toBe(0);
  });
});

describe('the reserve refills by itself', () => {
  it('a twenty-fourth of the allowance comes back every hour, never past full', async () => {
    const { budget, clock } = await open();
    spend(budget, 'background', 100 * MB);
    clock.now += 3600;
    expect(budget.state().level).toBeCloseTo((100 * MB) / 24, -2);
    clock.now += 100 * 3600;
    expect(budget.state().level).toBe(100 * MB);
  });
  it('empty, it says when it resumes (about a quarter of an hour at 100 MB) and then does', async () => {
    const { budget, clock } = await open();
    spend(budget, 'background', 100 * MB);
    const s = budget.state();
    expect(s.paused).toBe(true);
    expect(s.resumes_at! - clock.now).toBeCloseTo(864, 0); // 1 MB at 100 MB a day
    clock.now = s.resumes_at! + 1;
    expect(budget.state()).toMatchObject({ paused: false, resumes_at: null });
    expect(budget.meter('background', 20 * MB).remaining()).toBeGreaterThanOrEqual(MB);
  });
  // Measured on the phone (2026-11-20): with the reserve emptied, Settings said "resumes in about 14 min", yet 60 kB of
  // background look-ups went through 90 seconds later, out of the little that had come back. Dribbling like that keeps
  // the reserve from ever reaching the level it resumes at.
  it('while paused nothing in the background is let through, so the reserve reaches the level it resumes at', async () => {
    const { budget, clock } = await open();
    spend(budget, 'background', 100 * MB);
    clock.now += 90; // about 104 kB has come back
    expect(budget.state().paused).toBe(true);
    expect(budget.meter('background', 20 * MB).remaining()).toBe(0);
    // (A request is refused before it is sent when its meter has nothing remaining: see net.test.)
    clock.now = budget.state().resumes_at! + 1;
    expect(budget.state().paused).toBe(false);
    expect(budget.meter('background', 20 * MB).remaining()).toBeGreaterThanOrEqual(1 * MB);
  });
  it('"Check again" still fills it at once and says what it gave back', async () => {
    const { budget } = await open();
    spend(budget, 'background', 60 * MB);
    expect(budget.refill()).toBe(60 * MB);
    expect(budget.state().level).toBe(100 * MB);
  });
  it('raising the allowance in Settings adds the difference at once; lowering it caps what is left', async () => {
    const { budget, clock } = await open();
    spend(budget, 'background', 100 * MB);
    clock.cap = 400;
    expect(budget.state()).toMatchObject({ capacity: 400 * MB, level: 300 * MB });
    clock.cap = 50;
    expect(budget.state()).toMatchObject({ capacity: 50 * MB, level: 50 * MB });
  });
  it('is remembered across a restart', async () => {
    const a = await open();
    spend(a.budget, 'background', 80 * MB);
    await a.store.flush?.();
    const store = await Store.open(a.backend);
    const again = new Budget(store, () => 100 * MB, () => a.clock.now + 3600);
    expect(again.state().level).toBeCloseTo(20 * MB + (100 * MB) / 24, -2);
    expect(store.get(RESERVE_KEY)).toBeTruthy();
  });
});

describe('off mobile data the allowance does not apply', () => {
  it('on Wi-Fi background work is not limited and does not drain the reserve', async () => {
    const { budget } = await open();
    spend(budget, 'background', 100 * MB);
    budget.network(false);
    expect(budget.state()).toMatchObject({ unmetered: true, paused: false, resumes_at: null });
    expect(budget.meter('background', 20 * MB).remaining()).toBe(20 * MB);
    spend(budget, 'background', 40 * MB);
    expect(budget.state().level).toBe(0);
    expect(budget.state().today.background).toBe(140 * MB);
  });
  it('back on mobile data the allowance applies again', async () => {
    const { budget } = await open();
    budget.network(false);
    spend(budget, 'background', 100 * MB);
    budget.network(true);
    expect(budget.state()).toMatchObject({ unmetered: false, level: 100 * MB });
    spend(budget, 'background', 100 * MB);
    expect(budget.meter('background', 20 * MB).remaining()).toBe(0);
  });
  it('a shell that says nothing about the network leaves the allowance applying (browser, older shell)', async () => {
    const { budget } = await open();
    budget.network(undefined);
    budget.network(null);
    expect(budget.state().unmetered).toBe(false);
  });
  it('the last known network is remembered across a restart', async () => {
    const a = await open();
    a.budget.network(false);
    await a.store.flush?.();
    const again = new Budget(await Store.open(a.backend), () => 100 * MB, () => a.clock.now);
    expect(again.state().unmetered).toBe(true);
  });
});

describe('background work slows down before it stops', () => {
  it('full batches with plenty left, half below a quarter, none while paused, full on Wi-Fi', async () => {
    const { budget } = await open();
    expect(budget.batch(12)).toBe(12);
    spend(budget, 'background', 80 * MB);
    expect(budget.batch(12)).toBe(6);
    expect(budget.batch(1)).toBe(1);
    spend(budget, 'background', 20 * MB);
    expect(budget.batch(12)).toBe(0);
    budget.network(false);
    expect(budget.batch(12)).toBe(12);
  });
});
