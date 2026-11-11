// @vitest-environment happy-dom
/**
 * FAST-PLAY-002, wired to the two shells. Owner: "I want to be able to play a song instantly when i
 * click on it on all platforms".
 *
 * The warmer itself is tested in engine/warm-play.test.ts; this is the wiring: which shell is asked
 * to name the file, and that nothing is asked of a browser that has no shell at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from './api';

// React needs this to run effects and renders the way the browser does.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const win = () => window as unknown as { AirwaveNative?: unknown };

/** A YouTube Music song; its id has the eleven characters the downloader insists on. */
const track = (key: string, extra: Partial<Track> = {}): Track =>
  ({ key, title: key, artist: 'Someone', artists: ['Someone'], provider: 'ytmusic', platform_id: key.padEnd(11, 'x'), duration: 200, album: null, artwork: null, url: '', tags: [], ...extra } as unknown as Track);

describe('asking the shell to warm a song (FAST-PLAY-002)', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    delete win().AirwaveNative;
    vi.resetModules();
  });

  it('uses the Windows shell’s warmStream', async () => {
    const warmStream = vi.fn();
    win().AirwaveNative = { warmStream };
    const { warmSource } = await import('./engine/warm-shell');
    warmSource('https://music.youtube.com/watch?v=abc');
    expect(warmStream).toHaveBeenCalledWith('https://music.youtube.com/watch?v=abc');
  });

  it('uses the Android engine’s own warm command, which the service runs off the main thread', async () => {
    const engine = vi.fn();
    win().AirwaveNative = { engine };
    const { warmSource } = await import('./engine/warm-shell');
    warmSource('https://music.youtube.com/watch?v=abc');
    expect(engine).toHaveBeenCalledWith(JSON.stringify({ op: 'warm', sources: ['https://music.youtube.com/watch?v=abc'] }));
  });

  it('asks nothing of a browser with no shell, and never throws', async () => {
    const { warmSource } = await import('./engine/warm-shell');
    expect(() => warmSource('https://music.youtube.com/watch?v=abc')).not.toThrow();
  });

  it('refuses anything that is not a source link the downloader accepts', async () => {
    const warmStream = vi.fn();
    win().AirwaveNative = { warmStream };
    const { warmSource } = await import('./engine/warm-shell');
    warmSource('https://example.com/not-a-source.mp3');
    warmSource('');
    warmSource('javascript:alert(1)');
    expect(warmStream).not.toHaveBeenCalled();
  });

  it('warms a row the listener points at, finding the source when the page does not know it', async () => {
    const warmStream = vi.fn();
    win().AirwaveNative = { warmStream };
    const fullSong = vi.fn().mockResolvedValue({ id: 'found1', url: 'https://music.youtube.com/watch?v=found1' });
    vi.doMock('./api', async (orig) => {
      const real = await orig<typeof import('./api')>();
      return { ...real, api: { ...real.api, fullSong } };
    });
    const { warmer } = await import('./engine/warm-shell');
    warmer().warm(track('row1', { provider: 'deezer', platform_id: '123' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(fullSong).toHaveBeenCalled();
    expect(warmStream).toHaveBeenCalledWith('https://music.youtube.com/watch?v=found1');
  });

  it('warms a row that scrolls into view, which is the only signal a phone has', async () => {
    const warmStream = vi.fn();
    win().AirwaveNative = { warmStream };
    const seen: Element[] = [];
    let fire: ((entries: { target: Element; isIntersecting: boolean }[]) => void) | null = null;
    class FakeIO {
      constructor(cb: (entries: { target: Element; isIntersecting: boolean }[]) => void) { fire = cb; }
      observe(el: Element) { seen.push(el); }
      disconnect() { seen.length = 0; }
      unobserve() {}
    }
    (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeIO;
    const { warmer, resetWarmerForTests } = await import('./engine/warm-shell');
    resetWarmerForTests();
    const { TrackList } = await import('./Search');
    const { createRoot } = await import('react-dom/client');
    const { act } = await import('react');
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const rows = [track('a'), track('b'), track('c')];
    await act(async () => root.render(
      <TrackList tracks={rows} seedKeys={new Set()} onAdd={() => {}} onPreview={() => {}} label="Results for test" />,
    ));
    expect(seen.length).toBe(3);
    await act(async () => { fire!([{ target: seen[2]!, isIntersecting: true }]); });
    // Nothing yet: a row must stay in view, so scrolling past forty rows costs nothing.
    expect(warmStream).not.toHaveBeenCalled();
    await act(async () => { await new Promise((r) => setTimeout(r, 500)); });
    // The third row, the one in view — not the first row the list happens to start with.
    expect(warmStream).toHaveBeenCalledWith('https://music.youtube.com/watch?v=cxxxxxxxxxx');
    expect(warmer().inFlight).toBe(0);
    await act(async () => root.unmount());
    host.remove();
  });
});
