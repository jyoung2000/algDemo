import { describe, expect, it, vi } from 'vitest';
import type { Track } from '../api';
import { runCarSimilar, similarSeedKey } from './car-similar';
import { songFromTrack } from './media-native';

const t = (key: string, title = key): Track => ({ id: key, provider: 'deezer', platform_id: key, key, title, artist: 'A', duration: 200 } as Track);

describe('CAR-SIMILAR-001: the car\u2019s Find similar runs the phone\u2019s own sound match', () => {
  it('reads the song key out of a playlist or car-album id', () => {
    expect(similarSeedKey('k1')).toBe('k1');
    expect(similarSeedKey('playlist/road/track/a%7Cb')).toBe('a|b');
    expect(similarSeedKey('calbum/dz%3A1/track/ken%20carson')).toBe('ken carson');
    expect(similarSeedKey('radio/kexp')).toBeNull();
    expect(similarSeedKey('')).toBeNull();
  });

  it('starts the same job as the phone button, waits for it and returns only the songs it added', async () => {
    const seed = t('k1', 'Seed');
    const statuses = [
      { done: false, progress: 'Comparing song 1 of 3' },
      { done: true, result: { added: 2, minimum: 70, reason: '', matches: [{ key: 'n1' }, { key: 'n2' }],
        queue: { items: [{ track: seed }, { track: t('old') }, { track: t('n1') }, { track: t('n2') }] } } },
    ];
    const similar = vi.fn(async () => ({ job: 'j1' }));
    const job = vi.fn(async () => statuses.shift()!);
    const onQueue = vi.fn();
    const out = await runCarSimilar('playlist/road/track/k1', {
      findTrack: async (key) => (key === 'k1' ? seed : null), similar, job, song: (x) => songFromTrack(x, x.key === 'n1'), wait: async () => undefined, onQueue,
    });
    expect(onQueue).toHaveBeenCalledTimes(1);
    expect(similar).toHaveBeenCalledWith(seed);
    expect(job).toHaveBeenCalledTimes(2);
    expect(out.added).toBe(2);
    expect(out.minimum).toBe(70);
    expect(out.songs.map((s) => [s.id, s.ready])).toEqual([['n1', true], ['n2', false]]);
  });

  it('passes the job\u2019s own reason on when nothing reached the bar', async () => {
    const out = await runCarSimilar('k1', {
      findTrack: () => t('k1'), similar: async () => ({ job: 'j' }), song: (x: Track) => songFromTrack(x, false), wait: async () => undefined,
      job: async () => ({ done: true, result: { added: 0, minimum: 80, reason: 'None of the 9 analysed songs reached 80% without duplicating your list.' } }),
    });
    expect(out).toEqual({ added: 0, minimum: 80, reason: 'None of the 9 analysed songs reached 80% without duplicating your list.', songs: [] });
  });

  it('fails plainly for a song it does not know or a job that failed', async () => {
    const base = { similar: async () => ({ job: 'j' }), song: (x: Track) => songFromTrack(x, false), wait: async () => undefined };
    await expect(runCarSimilar('k1', { ...base, findTrack: () => null, job: async () => ({ done: true }) }))
      .rejects.toThrow('Play a song from your list first');
    await expect(runCarSimilar('k1', { ...base, findTrack: () => t('k1'), job: async () => ({ done: true, error: 'cancelled' }) }))
      .rejects.toThrow('cancelled');
  });
});
