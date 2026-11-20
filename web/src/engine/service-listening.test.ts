/**
 * QUEUE-HEARD-001 (owner, 2026-11-20): "my discover queue is the same set of songs even though I listened to every
 * song". With the phone app closed (screen off, Android Auto) the phone's engine played the Discover queue on its
 * own, and nobody recorded those listens or topped the queue up until the app was opened again: the car went round
 * the same songs. The service's engine page now does what the phone page does when a song ends.
 */
import { describe, expect, it, vi } from 'vitest';
import { engineEventId, ServiceListening, type ListeningDeps } from './service-listening';
import type { Track } from '../api';

const track = (key: string): Track => ({ key, title: key, artists: ['A'], provider: 'deezer', platform_id: key, tags: [] }) as unknown as Track;
const state = (o: Record<string, unknown>) => JSON.stringify({ rev: 3, id: 'k1', mediaId: 'k1', playing: true, pageLive: false, ...o });
const end = (seq: number, id = 'k0', heardMs = 200_000) => ({ seq, cause: 'end', advanced: true, at: 1_795_000_000_000 + seq, from: { id, heardMs, durationMs: 210_000 } });

function deps(over: Partial<ListeningDeps> = {}) {
  let queue = ['k0', 'k1', 'k2'];
  const d: ListeningDeps & { appended: string[][] } = {
    appended: [],
    findTrack: async (k) => (queue.includes(k) ? track(k) : null),
    feedback: vi.fn(async () => ({})),
    recommend: vi.fn(async () => ({ job: 'j1' })),
    job: vi.fn(async () => {
      queue = [...queue, 'n1', 'n2', 'n3'];
      return { done: true, error: null };
    }),
    last: async () => ({ items: queue.map((k) => ({ track: track(k) })) }),
    song: (t) => ({ id: t.key, title: t.title }),
    append: (songs) => { d.appended.push(songs.map((s) => s.id)); },
    wait: async () => undefined,
    ...over,
  };
  return d;
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('with the phone app closed, a song the engine finished', () => {
  it('is recorded as a listen, starts a top-up, and the new songs join the end of the car\u2019s queue', async () => {
    const d = deps();
    const s = new ServiceListening(d);
    s.onState(state({ event: end(7) }));
    await s.idle();
    expect(d.feedback).toHaveBeenCalledTimes(1);
    const [kind, t, extra] = (d.feedback as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(kind).toBe('complete');
    expect((t as Track).key).toBe('k0');
    expect(extra).toMatchObject({ origin: 'queue', medium: 'full', event_id: engineEventId('complete', 'k0', end(7)) });
    expect(d.recommend).toHaveBeenCalledWith({ event_id: engineEventId('complete', 'k0', end(7)), exclude: [] });
    expect(d.appended).toEqual([['n1', 'n2', 'n3']]);
  });
  it('a Next press a few seconds in counts as a skip (SKIP_MIN_S..SKIP_MAX_S); a song cut off at once teaches nothing and asks nothing', async () => {
    const d = deps();
    const s = new ServiceListening(d);
    s.onState(state({ event: { ...end(8), cause: 'next', from: { id: 'k0', heardMs: 8_000, durationMs: 210_000 } } }));
    await s.idle();
    expect((d.feedback as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe('skip');
    const quiet = deps();
    const q = new ServiceListening(quiet);
    q.onState(state({ event: { ...end(9), cause: 'next', from: { id: 'k0', heardMs: 1_000, durationMs: 210_000 } } }));
    await q.idle();
    expect(quiet.feedback).not.toHaveBeenCalled();
    expect(quiet.recommend).not.toHaveBeenCalled();
  });
  it('the engine needing nothing (job null) adds nothing', async () => {
    const d = deps({ recommend: vi.fn(async () => ({ job: null, reason: 'The list does not need more songs yet.' })) });
    const s = new ServiceListening(d);
    s.onState(state({ event: end(10) }));
    await s.idle();
    expect(d.job).not.toHaveBeenCalled();
    expect(d.appended).toEqual([]);
  });
});

describe('it stays out of the way', () => {
  it('does nothing while the phone app is open: that page tops its own queue up', async () => {
    const d = deps();
    const s = new ServiceListening(d);
    s.onState(state({ pageLive: true, event: end(11) }));
    s.onState(state({ event: end(12) }).replace('"pageLive":false,', ''));
    await s.idle();
    expect(d.feedback).not.toHaveBeenCalled();
  });
  it('does nothing for a saved list or an album (their songs are not the Discover queue)', async () => {
    const d = deps();
    const s = new ServiceListening(d);
    s.onState(state({ mediaId: 'playlist/abc/track/k1', event: end(13) }));
    await s.idle();
    expect(d.feedback).not.toHaveBeenCalled();
  });
  it('a song that is not in the Discover queue is not reported', async () => {
    const d = deps();
    const s = new ServiceListening(d);
    s.onState(state({ event: end(14, 'elsewhere') }));
    await s.idle();
    expect(d.feedback).not.toHaveBeenCalled();
  });
  it('the same event seen twice (states repeat) is handled once', async () => {
    const d = deps();
    const s = new ServiceListening(d);
    s.onState(state({ event: end(15) }));
    s.onState(state({ event: end(15) }));
    await s.idle();
    expect(d.feedback).toHaveBeenCalledTimes(1);
  });
  it('a failing engine is swallowed, and the next song still gets its turn', async () => {
    const d = deps({ recommend: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ job: 'j2' }) });
    const s = new ServiceListening(d);
    s.onState(state({ event: end(16) }));
    await s.idle();
    s.onState(state({ event: end(17, 'k1') }));
    await s.idle();
    await settle();
    expect(d.appended).toEqual([['n1', 'n2', 'n3']]);
  });
});

describe('the listen id', () => {
  it('is the same one the phone page uses for the same engine event, so the store keeps one copy', () => {
    expect(engineEventId('complete', 'k0', end(7))).toBe(`complete:k0:engine-7-${end(7).at}`);
    expect(engineEventId('complete', 'x'.repeat(90), end(7)).length).toBeLessThanOrEqual(80);
  });
});
