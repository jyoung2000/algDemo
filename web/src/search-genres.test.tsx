// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Track } from './api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const genres = vi.fn();
vi.mock('./api', async (orig) => {
  const real = await orig<typeof import('./api')>();
  return { ...real, api: { ...real.api, genres: (...a: unknown[]) => genres(...a) } };
});
const { TrackList } = await import('./Search');
const { resetRowGenres } = await import('./RowGenres');

/** TAGS-ALWAYS-001 (owner, 2026-11-19): search results are tagged like every other song list. */
const track = (key: string, title: string): Track =>
  ({ key, title, artist: 'SoFaygo', artists: ['SoFaygo'], album: '', duration: 140, artwork: null, preview: null, provider: 'ytmusic', platform_id: key, url: 'https://example.invalid/' + key, release: null }) as unknown as Track;

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => { resetRowGenres(); genres.mockReset(); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('search rows show genre bubbles (TAGS-ALWAYS-001)', () => {
  it('asks once for the whole list and shows a main genre and a subgenre on each row it gets', async () => {
    genres.mockResolvedValue({ items: {
      a: { family: 'Hip-hop', subgenre: 'Trap', families: [{ family: 'Hip-hop', subgenre: 'Trap', color: '#c4d872' }], color: '#c4d872', genres: ['Rap/Hip Hop', 'trap'] },
      b: null,
    } });
    await act(async () => {
      root.render(<TrackList tracks={[track('a', 'Knock Knock'), track('b', 'Clutch')]} seedKeys={new Set<string>()} onAdd={() => {}} onPreview={() => {}} label="Results" />);
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 120)); });
    expect(genres).toHaveBeenCalledTimes(1);
    expect((genres.mock.calls[0]![0] as Track[]).map((t) => t.key)).toEqual(['a', 'b']);
    const rows = [...host.querySelectorAll('li')];
    const tags = (li: Element) => [...li.querySelectorAll('.genre')].map((g) => g.textContent);
    expect(tags(rows[0]!).length).toBeGreaterThanOrEqual(2);
    expect(tags(rows[0]!).join(' ')).toMatch(/Trap/);
    expect(tags(rows[1]!)).toEqual([]);
  });

  it('keeps asking while the engine is still looking a song up, and fills the row when it lands', async () => {
    vi.useFakeTimers();
    try {
      const trap = { family: 'Hip-hop', subgenre: 'Trap', families: [{ family: 'Hip-hop', subgenre: 'Trap', color: '#c4d872' }], color: '#c4d872', genres: ['trap'] };
      let calls = 0;
      // The engine answers "pending" for the first 6 asks (a slow lookup), then the genre.
      genres.mockImplementation(async () => (++calls <= 6 ? { items: { a: null }, pending: ['a'] } : { items: { a: trap }, pending: [] }));
      await act(async () => {
        root.render(<TrackList tracks={[track('a', 'Yale')]} seedKeys={new Set<string>()} onAdd={() => {}} onPreview={() => {}} label="Results" />);
      });
      for (let i = 0; i < 12; i++) await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(calls).toBeGreaterThanOrEqual(7);
      expect([...host.querySelectorAll('li .genre')].map((g) => g.textContent).join(' ')).toMatch(/Trap/);
    } finally { vi.useRealTimers(); }
  });

  it('stops asking once the engine has nothing and is not looking the song up', async () => {
    vi.useFakeTimers();
    try {
      genres.mockResolvedValue({ items: { b: null }, pending: [] });
      await act(async () => {
        root.render(<TrackList tracks={[track('b', 'Clutch')]} seedKeys={new Set<string>()} onAdd={() => {}} onPreview={() => {}} label="Results" />);
      });
      for (let i = 0; i < 6; i++) await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(genres).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});
