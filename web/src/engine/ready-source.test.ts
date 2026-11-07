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

/**
 * SOURCE-HEARTHIS-002: a creator can withdraw a download or change a license at any time, and this
 * map has no TTL. A remembered link on a revocable host is therefore never a standing permission —
 * it has to go back through the source chain so the license is re-read before yt-dlp runs again.
 */
it('never shortcuts a remembered link on a host whose permission the creator can withdraw', () => {
  const s = storage();
  const m = new ReadySourceMap(s);
  m.remember('deezer:ht', 'https://hearthis.at/kmacleod/wallpaper/');
  expect(m.get('deezer:ht')).toBeNull();
  expect(new ReadySourceMap(s).get('deezer:ht')).toBeNull();
  // A pre-existing entry written by an older build must not be honoured either.
  const s2 = storage();
  s2.setItem('airwave.ready-source.v1', JSON.stringify([['deezer:ht', 'https://hearthis.at/kmacleod/wallpaper/']]));
  expect(new ReadySourceMap(s2).get('deezer:ht')).toBeNull();
  // Hosts that are not creator-revocable keep the cold-launch shortcut.
  const s3 = storage();
  const keep = new ReadySourceMap(s3);
  keep.remember('deezer:sc', 'https://soundcloud.com/user/real-song');
  expect(keep.get('deezer:sc')).toBe('https://soundcloud.com/user/real-song');
});
