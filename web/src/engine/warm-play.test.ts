/**
 * FAST-PLAY-002. Owner: "I want to be able to play a song instantly when i click on it on all platforms".
 *
 * A click used to pay for the whole chain in front of the audio: find the song's full-song source,
 * then have the shell's yt-dlp name the source's media file (measured 3.9 s on Windows, longer on
 * the phone). Both answers are cached, so the only thing that has to change is WHEN they are asked
 * for: the warmer asks before the click, for the few songs a listener is about to press.
 *
 * It is deliberately mean with work: one song is warmed once per window, a held file is never
 * warmed at all, and no more than a couple of lookups run at a time with a hard budget on top, so
 * showing a long list never spawns a yt-dlp per row.
 */
import { describe, expect, it, vi } from 'vitest';
import { PlayWarmer, type WarmOptions } from './warm-play';
import type { Track } from '../api';

const track = (key: string, extra: Partial<Track> = {}): Track =>
  ({ key, title: key, artist: 'Someone', artists: ['Someone'], provider: 'deezer', platform_id: key, duration: 200, album: null, artwork: null, url: '', tags: [] } as unknown as Track);

function world(opts: WarmOptions = {}) {
  const found = new Map<string, string | null>();
  const find = vi.fn(async (t: Track) => found.get(t.key) ?? `https://music.youtube.com/watch?v=${t.key}`);
  const resolve = vi.fn();
  const held = vi.fn(() => false);
  const known = vi.fn((_t: Track) => null as string | null);
  const warmer = new PlayWarmer({ find, resolve, held, known }, opts);
  return { warmer, find, resolve, held, known, found };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('warming a song so a click plays it at once (FAST-PLAY-002)', () => {
  it('finds the source and has the shell resolve it, before any click', async () => {
    const w = world();
    w.warmer.warm(track('s1'));
    await settle();
    expect(w.find).toHaveBeenCalledTimes(1);
    expect(w.resolve).toHaveBeenCalledWith('https://music.youtube.com/watch?v=s1');
  });

  it('uses a source the page already knows without a lookup', async () => {
    const w = world();
    w.known.mockReturnValue('https://music.youtube.com/watch?v=known');
    w.warmer.warm(track('s1'));
    await settle();
    expect(w.find).not.toHaveBeenCalled();
    expect(w.resolve).toHaveBeenCalledWith('https://music.youtube.com/watch?v=known');
  });

  it('warms one song once a window, and again once the window has passed', async () => {
    let t = 1000;
    const w = world({ ttlMs: 60_000, now: () => t });
    w.warmer.warm(track('s1'));
    w.warmer.warm(track('s1'));
    await settle();
    expect(w.resolve).toHaveBeenCalledTimes(1);
    t += 60_001;
    w.warmer.warm(track('s1'));
    await settle();
    expect(w.resolve).toHaveBeenCalledTimes(2);
  });

  it('leaves a song whose file is already held alone', async () => {
    const w = world();
    w.known.mockReturnValue('https://music.youtube.com/watch?v=held');
    w.held.mockReturnValue(true);
    w.warmer.warm(track('s1'));
    await settle();
    expect(w.resolve).not.toHaveBeenCalled();
  });

  it('runs no more than two lookups at a time, then works through the rest', async () => {
    const w = world({ concurrency: 2 });
    let release: (() => void)[] = [];
    w.find.mockImplementation((t: Track) => new Promise<string>((r) => release.push(() => r(`https://music.youtube.com/watch?v=${t.key}`))));
    w.warmer.warmFirst([track('a'), track('b'), track('c'), track('d')], 4);
    await settle();
    expect(w.find).toHaveBeenCalledTimes(2);
    release.shift()!();
    await settle();
    expect(w.find).toHaveBeenCalledTimes(3);
  });

  it('stops after its budget, so a long list never spawns a lookup per row', async () => {
    const w = world({ budget: 3 });
    w.warmer.warmFirst(Array.from({ length: 30 }, (_, i) => track(`row${i}`)), 30);
    await settle();
    await settle();
    expect(w.find.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('warms only the first few rows of a list, in the order they are shown', async () => {
    const w = world({ concurrency: 4 });
    w.warmer.warmFirst([track('a'), track('b'), track('c'), track('d')], 2);
    await settle();
    expect(w.find.mock.calls.map((c) => (c[0] as Track).key)).toEqual(['a', 'b']);
  });

  it('a source that cannot be found is not asked for again, and never throws', async () => {
    const w = world();
    w.find.mockImplementation(async () => null as unknown as string);
    w.warmer.warm(track('s1'));
    await settle();
    w.warmer.warm(track('s1'));
    await settle();
    expect(w.find).toHaveBeenCalledTimes(1);
    expect(w.resolve).not.toHaveBeenCalled();
  });

  it('a lookup that fails outright is swallowed and does not stop the next song', async () => {
    const w = world({ concurrency: 1 });
    w.find.mockRejectedValueOnce(new Error('offline')).mockResolvedValue('https://music.youtube.com/watch?v=b');
    w.warmer.warmFirst([track('a'), track('b')], 2);
    await settle();
    await settle();
    await settle();
    expect(w.resolve).toHaveBeenCalledWith('https://music.youtube.com/watch?v=b');
  });
});
