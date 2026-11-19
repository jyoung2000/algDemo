/** CAR-MOOD-001: the car's queue asks the engine for the mood order with the phone app closed. */
import { describe, expect, it, vi } from 'vitest';
import type { Track } from '../api';
import { runCarMood } from './car-mood';

const t = (key: string) => ({ key, title: key, artists: ['A'], provider: 'deezer', platform_id: key } as unknown as Track);
const tracks: Record<string, Track> = { cur: t('cur'), rap: t('rap'), jazz: t('jazz'), elec: t('elec') };

describe('runCarMood', () => {
  it('sends the movable songs and the press, and answers in media ids', async () => {
    const mood = vi.fn().mockResolvedValue({ order: ['rap', 'elec', 'jazz'], moved: ['elec', 'jazz'], changed: true, leading: ['Rap'] });
    const a = await runCarMood({ current: 'cur', upcoming: ['jazz', 'rap', 'elec'], signal: { id: 'cur', kind: 'like' } }, { findTrack: (k) => tracks[k] ?? null, mood });
    const body = mood.mock.calls[0]![0];
    expect(body.upcoming.map((u: { track: Track }) => u.track.key)).toEqual(['jazz', 'rap', 'elec']);
    expect(body.current.track.key).toBe('cur');
    expect(body.signal).toEqual({ track: tracks.cur, kind: 'like' });
    expect(a.order).toEqual(['rap', 'elec', 'jazz']);
    expect(a.changed).toBe(true);
    expect(a.leading).toEqual(['Rap']);
  });

  it('keeps songs the engine cannot name in their slots', async () => {
    const mood = vi.fn().mockResolvedValue({ order: ['elec', 'rap'], moved: ['elec'], changed: true, leading: [] });
    const a = await runCarMood({ current: null, upcoming: ['rap', 'unknown', 'elec'] }, { findTrack: (k) => tracks[k] ?? null, mood });
    expect(a.order).toEqual(['elec', 'unknown', 'rap']);
  });

  it('changes nothing when the setting is off, and ignores unknown press kinds', async () => {
    const mood = vi.fn().mockResolvedValue({ order: ['rap', 'jazz'], moved: [], changed: false, off: true });
    const a = await runCarMood({ current: 'cur', upcoming: ['jazz', 'rap'], signal: { id: 'cur', kind: 'hack' } }, { findTrack: (k) => tracks[k] ?? null, mood });
    expect(mood.mock.calls[0]![0].signal).toBeUndefined();
    expect(a).toMatchObject({ order: ['jazz', 'rap'], changed: false, off: true });
  });

  it('does not ask with fewer than two songs to arrange', async () => {
    const mood = vi.fn();
    const a = await runCarMood({ current: 'cur', upcoming: ['rap'] }, { findTrack: (k) => tracks[k] ?? null, mood });
    expect(mood).not.toHaveBeenCalled();
    expect(a.changed).toBe(false);
  });
});
