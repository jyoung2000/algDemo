import { expect, it, vi } from 'vitest';
import { DiscoveryExpiryMap, ReadySourceMap } from './ready-source';

function storage() {
  const saved = new Map<string, string>();
  return { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); } };
}

it('restores a verified source link on a cold launch instead of repeating a network search', () => {
  const s = storage();
  const one = new ReadySourceMap(s);
  const link = 'https://soundcloud.com/user/real-song';
  one.remember('deezer:123', link);
  expect(new ReadySourceMap(s).get('deezer:123')).toBe(link);
  expect(new ReadySourceMap(s).get('deezer:other')).toBeNull();
});

it('keeps a missing discovery song out across relaunch, but not forever or after a manual retry', () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date('2026-11-06T12:00:00Z'));
    const s = storage();
    new DiscoveryExpiryMap(s).remember('missing', true);
    expect(new DiscoveryExpiryMap(s).keys()).toContain('missing');
    new DiscoveryExpiryMap(s).remember('missing', false);
    expect(new DiscoveryExpiryMap(s).keys()).not.toContain('missing');
    new DiscoveryExpiryMap(s).remember('missing', true);
    vi.advanceTimersByTime(24 * 60 * 60_000 + 1);
    expect(new DiscoveryExpiryMap(s).keys()).not.toContain('missing');
  } finally { vi.useRealTimers(); }
});

it('refuses unsupported URLs even if local storage was tampered with', () => {
  const s = storage();
  s.setItem('airwave.ready-source.v1', JSON.stringify([['deezer:123', 'https://evil.example/song']]));
  expect(new ReadySourceMap(s).get('deezer:123')).toBeNull();
  new ReadySourceMap(s).remember('deezer:123', 'https://evil.example/song');
  expect(new ReadySourceMap(s).get('deezer:123')).toBeNull();
});
