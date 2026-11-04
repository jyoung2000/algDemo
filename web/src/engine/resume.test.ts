// @vitest-environment happy-dom
import { describe, expect, it, beforeEach } from 'vitest';
import { clearResume, readResume, writeResume } from './resume';
import type { Playback, Track } from '../api';

const track = (key = 'yt:abc') => ({ id: key, provider: 'ytmusic', platform_id: 'abc', key, title: 'Carefree', artist: 'Kevin MacLeod' }) as Track;
const playback = { open: [], preview: null } as unknown as Playback;
const NOW = 1_762_000_000_000;

describe('resume point (RESUME-001)', () => {
  beforeEach(() => {
    clearResume();
  });

  it('remembers a song the listener was part-way through', () => {
    expect(writeResume(track(), playback, 94.6, 240, NOW)).toBe(true);
    const p = readResume(NOW);
    expect(p?.track.key).toBe('yt:abc');
    // Rounded: a sub-second playhead is false precision for a place marker.
    expect(p?.t).toBe(95);
  });

  it('keeps no place for a song barely started or nearly over', () => {
    expect(writeResume(track(), playback, 4, 240, NOW)).toBe(false);
    expect(writeResume(track(), playback, 236, 240, NOW)).toBe(false);
    expect(readResume(NOW)).toBeNull();
  });

  it('keeps no place when the duration is unknown, so a 30s preview is not mistaken for a song', () => {
    expect(writeResume(track(), playback, 25, 0, NOW)).toBe(false);
    expect(readResume(NOW)).toBeNull();
  });

  it('drops a place older than a week instead of resurrecting it', () => {
    writeResume(track(), playback, 94, 240, NOW);
    expect(readResume(NOW + 6 * 24 * 3600 * 1000)).not.toBeNull();
    expect(readResume(NOW + 8 * 24 * 3600 * 1000)).toBeNull();
  });

  it('survives corrupt storage rather than failing the launch', () => {
    window.localStorage.setItem('airwave.resume', '{not json');
    expect(readResume(NOW)).toBeNull();
    window.localStorage.setItem('airwave.resume', JSON.stringify({ t: 10 }));
    expect(readResume(NOW)).toBeNull();
  });

  it('replaces the previous place, so only the newest one is restored', () => {
    writeResume(track('yt:one'), playback, 30, 240, NOW);
    writeResume(track('yt:two'), playback, 60, 240, NOW);
    expect(readResume(NOW)?.track.key).toBe('yt:two');
  });
});
