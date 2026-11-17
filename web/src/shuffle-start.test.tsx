// @vitest-environment happy-dom
/**
 * SHUFFLE-START-001. Owner: "shuffle shouldnt play songs that arent fully loaded", seen "right after
 * pressing Play songs / Play album / Play as my queue with shuffle on". Automatic movement already kept
 * to loaded songs; the START of a whole list did not: it always began on the first row. With shuffle on,
 * a whole-list Play now begins on a loaded song when the list has one. With none loaded it begins on
 * the first song, at once, as before (the owner's choice). A tapped row is still that row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Track, RecItem, RecResult } from './api';
import { api } from './api';
import { App } from './App';
import { LIST_LOOK_MS, listStart, resetShuffleNextForTests } from './util';

const tracks = ['a', 'b', 'c', 'd'].map(key => ({ key, title: key.toUpperCase(), artists: ['Test'], provider: 'deezer', platform_id: key, preview: `/fixture/${key}`, tags: [] } as unknown as Track));
const rows = tracks.map((track, i) => ({ track, rank: i + 1, reasons: [], playback: { preview: track.preview, embed: null, open: [] }, characteristics: {} } as unknown as RecItem));
const lists = ['p', 'q'].map(id => ({ id, name: id, items: tracks.map(track => ({ key: track.key, track, played: false })), count: tracks.length, unplayed: tracks.length }));
const shell = vi.hoisted(() => ({ on: false, ready: new Set<string>(), look: null as null | ((list: readonly { key: string }[]) => Promise<void>) }));
vi.mock('./engine/downloads', async orig => ({ ...await orig<typeof import('./engine/downloads')>(), downloadsAvailable: () => shell.on }));
vi.mock('./engine/queue-audio', () => ({ queueAudio: {
  subscribe: () => () => {}, expiredKeys: () => new Set<string>(), cardOf: () => null,
  isReady: (t: Track) => shell.ready.has(t.key), readyUrl: (t: Track) => shell.ready.has(t.key) ? `/fixture/${t.key}` : null,
  // Present only where a test supplies one: an older loader has no look() at all.
  get look() { return shell.look ?? undefined; },
} }));
vi.mock('./QueuePreparation', () => ({ QueuePreparation: () => null }));
vi.mock('./ListDownloadBar', () => ({ ListDownloadBar: () => null, ListDownloadButton: () => null, ListFolderButton: () => null }));
vi.mock('./api', async orig => {
  const real = await orig<typeof import('./api')>();
  return { ...real, api: { ...real.api,
    seeds: vi.fn().mockResolvedValue({ seeds: [] }), settings: vi.fn().mockResolvedValue(null),
    feedbackState: vi.fn().mockResolvedValue({ state: {}, taste: null }), last: vi.fn(),
    playlists: vi.fn(), saved: vi.fn(), impressions: vi.fn().mockResolvedValue({ recorded: 0 }),
    health: vi.fn(() => new Promise(() => {})), status: vi.fn(() => new Promise(() => {})),
  } };
});
// Keep the real App queue/round/history decisions; replace only audio and list-view boundaries.
vi.mock('./Player', () => ({ Player: (p: { playing: { track: Track } | null; onNext: () => void; onPrev: () => void; onShuffle: () => void; canNext: boolean; upNext: { key: string }[] }) => <div>
  <output data-testid="current">{p.playing?.track.key ?? '-'}</output>
  <output data-testid="upnext">{p.upNext.map(x => x.key).join(',')}</output>
  <button onClick={p.onNext} disabled={!p.canNext}>Fixture Next</button>
  <button onClick={p.onPrev}>Fixture Previous</button>
  <button onClick={p.onShuffle}>Fixture Shuffle</button>
</div> }));
vi.mock('./SavedView', () => ({ SavedView: (p: { onPreview: (t: Track, id?: string) => void; onPlayAll?: (list: Track[], id: string) => void; onUseAsQueue?: (id: string) => void }) => <div><button onClick={() => p.onPlayAll?.(tracks, 'p')}>Saved p play all</button><button onClick={() => p.onUseAsQueue?.('p')}>Saved p as queue</button>{['p', 'q'].flatMap(id => tracks.map(t => <button key={id + t.key} onClick={() => p.onPreview(t, id)}>Saved {id} {t.key}</button>))}</div> }));
vi.mock('./Artists', async orig => ({ ...await orig<typeof import('./Artists')>(), ArtistView: (p: { onPlayAll?: (list: Track[]) => void; onPreview: (t: Track, list: Track[]) => void }) => <div><button onClick={() => p.onPlayAll?.(tracks)}>Artist play all</button><button onClick={() => p.onPreview(tracks[0]!, tracks)}>Artist row a</button><button onClick={() => p.onPreview(tracks[1]!, tracks)}>Artist row b</button></div> }));
vi.mock('./Albums', async orig => ({ ...await orig<typeof import('./Albums')>(), AlbumView: (p: { onPlayAll?: (list: Track[]) => void }) => <div><button onClick={() => p.onPlayAll?.(tracks)}>Album play all</button></div> }));
vi.mock('./Results', async orig => ({ ...await orig<typeof import('./Results')>(), Results: (p: { onPlay: (r: RecItem) => void }) => <div>{rows.map(r => <button key={r.track.key} onClick={() => p.onPlay(r)}>Queue {r.track.key}</button>)}</div> }));
vi.mock('./Search', async orig => ({ ...await orig<typeof import('./Search')>(), Search: (p: { onPreview: (t: Track, list: Track[]) => void; onOpenArtist?: (t: { name: string }) => void; onOpenAlbumTarget?: (t: { id: string }) => void }) => <div><button onClick={() => p.onOpenArtist?.({ name: 'Test' })}>Open artist</button><button onClick={() => p.onOpenAlbumTarget?.({ id: 'dz:1' })}>Open album</button>{tracks.map(t => <button key={t.key} onClick={() => p.onPreview(t, tracks)}>Search {t.key}</button>)}</div> }));
const current = () => screen.getByTestId('current').textContent;
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const T = (k: string) => tracks.find(t => t.key === k)!;
beforeEach(() => {
  vi.clearAllMocks(); resetShuffleNextForTests(); localStorage.clear();
  shell.on = true; shell.ready.clear(); shell.look = null;
  localStorage.setItem('airwave.shuffle', 'on'); localStorage.setItem('airwave.repeat', 'off');
  vi.spyOn(Math, 'random').mockReturnValue(0);
  vi.mocked(api.last).mockResolvedValue({ items: rows, count: tracks.length, asked: tracks.length, phase: 'final', sources: {}, transfer: {} } as unknown as RecResult);
  vi.mocked(api.playlists).mockResolvedValue({ lists } as never);
  vi.mocked(api.saved).mockResolvedValue({ items: tracks.map(track => ({ track })) } as never);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });

describe('SHUFFLE-START-001: which song a whole list starts on', () => {
  const ready = (keys: string[]) => (t: Track) => keys.includes(t.key);
  it('is the first song when shuffle is off, loaded or not', () => {
    expect(listStart(tracks, { shuffle: false, ready: ready(['c']) })).toBe(T('a'));
  });
  it('is a loaded song when shuffle is on and the list has one, never an unloaded one', () => {
    for (const r of [0, 0.2, 0.49, 0.5, 0.99, 1]) {
      expect(['b', 'd']).toContain(listStart(tracks, { shuffle: true, ready: ready(['b', 'd']), rand: () => r })!.key);
    }
    expect(listStart(tracks, { shuffle: true, ready: ready(['b', 'd']), rand: () => 0 })).toBe(T('b'));
    expect(listStart(tracks, { shuffle: true, ready: ready(['b', 'd']), rand: () => 0.99 })).toBe(T('d'));
  });
  it('is the first song when shuffle is on and nothing is loaded yet: it starts at once and loads as it plays', () => {
    expect(listStart(tracks, { shuffle: true, ready: ready([]) })).toBe(T('a'));
  });
  it('is the first song where the shell cannot say what is loaded (a plain browser)', () => {
    expect(listStart(tracks, { shuffle: true })).toBe(T('a'));
  });
  it('is nothing for an empty list', () => {
    expect(listStart([], { shuffle: true, ready: ready(['a']) })).toBeNull();
  });
});

describe('SHUFFLE-START-001: the real App starts a whole list on a loaded song', () => {
  it('Play songs on an artist page', () => {
    shell.ready.add('c');
    render(<App />); click('Open artist'); click('Artist play all');
    expect(current()).toBe('c');
  });
  it('Play album on an album page', () => {
    shell.ready.add('c');
    render(<App />); click('Open album'); click('Album play all');
    expect(current()).toBe('c');
  });
  it('Play album on a saved album', async () => {
    shell.ready.add('d');
    render(<App />); click('Saved');
    await waitFor(() => expect(api.playlists).toHaveBeenCalled());
    click('Saved p play all');
    expect(current()).toBe('d');
  });
  it('Play as my queue', async () => {
    shell.ready.add('b');
    (api as unknown as { queuePlaylist: unknown }).queuePlaylist = vi.fn().mockResolvedValue({ seeds: tracks, playlist: { id: 'p', name: 'p' }, can_restore: true });
    (api as unknown as { run: unknown }).run = vi.fn(() => new Promise(() => {}));
    render(<App />); click('Saved');
    await waitFor(() => expect(api.playlists).toHaveBeenCalled());
    click('Saved p as queue');
    await waitFor(() => expect(current()).toBe('b'));
  });
  it('then moves on only to loaded songs, each once', () => {
    shell.ready.add('c'); shell.ready.add('d');
    render(<App />); click('Open artist'); click('Artist play all');
    expect(current()).toBe('c');
    click('Fixture Next'); expect(current()).toBe('d');
    expect(screen.getByRole('button', { name: 'Fixture Next' })).toHaveProperty('disabled', true);
  });
  it('starts the first song at once when nothing in the list is loaded', () => {
    render(<App />); click('Open artist'); click('Artist play all');
    expect(current()).toBe('a');
  });
  it('starts the first song when shuffle is off, even with another song loaded', () => {
    localStorage.setItem('airwave.shuffle', 'off'); shell.ready.add('c');
    render(<App />); click('Open artist'); click('Artist play all');
    expect(current()).toBe('a');
  });
  it('leaves a tapped row alone: the listener chose that song', () => {
    shell.ready.add('c');
    render(<App />); click('Open artist'); click('Artist row a');
    expect(current()).toBe('a');
  });
});

describe('SHUFFLE-START-001: a list the app has not examined yet', () => {
  it('looks before it chooses, and starts on a held song it had not known about', async () => {
    const looked: string[][] = [];
    shell.look = async (list) => { looked.push(list.map(t => t.key)); shell.ready.add('c'); };
    render(<App />); click('Open artist'); click('Artist play all');
    await waitFor(() => expect(current()).toBe('c'));
    expect(looked).toEqual([['a', 'b', 'c', 'd']]);
  });
  it('starts the first song when the look finds nothing held', async () => {
    shell.look = async () => {};
    render(<App />); click('Open artist'); click('Artist play all');
    await waitFor(() => expect(current()).toBe('a'));
  });
  it('starts the first song when the look fails', async () => {
    shell.look = async () => { throw new Error('the service did not answer'); };
    render(<App />); click('Open artist'); click('Artist play all');
    await waitFor(() => expect(current()).toBe('a'));
  });
  it('does not wait on a look that never answers', async () => {
    shell.look = () => new Promise<void>(() => {});
    render(<App />); click('Open artist'); click('Artist play all');
    expect(current()).toBe('-');
    await waitFor(() => expect(current()).toBe('a'), { timeout: LIST_LOOK_MS + 1500 });
  });
  it('still looks when it already knows of one held song: knowing one is not having examined the list', async () => {
    // Seen on Windows: after a launch the app knew only the song it had resumed, so a shuffled
    // "Play songs" chose from that one song and nothing seemed to happen.
    shell.ready.add('d');
    shell.look = async () => { shell.ready.add('b'); shell.ready.add('c'); };
    render(<App />); click('Open artist'); click('Artist play all');
    await waitFor(() => expect(current()).toBe('b'));
  });
  it('does not look when shuffle is off', () => {
    const look = vi.fn(async () => {});
    shell.look = look; shell.ready.add('c');
    localStorage.setItem('airwave.shuffle', 'off');
    render(<App />); click('Open artist'); click('Artist play all');
    expect(current()).toBe('a');
    expect(look).not.toHaveBeenCalled();
  });
  it('lets a row tapped while it looks win', async () => {
    let done: (() => void) | undefined;
    shell.look = () => new Promise<void>((r) => { done = () => { shell.ready.add('c'); r(); }; });
    render(<App />); click('Open artist'); click('Artist play all'); click('Artist row b');
    expect(current()).toBe('b');
    // The look starts a moment after the press; wait for it, then let it answer.
    await waitFor(() => expect(done).toBeDefined());
    done!();
    await new Promise((r) => setTimeout(r, 30));
    expect(current()).toBe('b');
  });
  it('looks for Play as my queue too', async () => {
    shell.look = async () => { shell.ready.add('d'); };
    (api as unknown as { queuePlaylist: unknown }).queuePlaylist = vi.fn().mockResolvedValue({ seeds: tracks, playlist: { id: 'p', name: 'p' }, can_restore: true });
    (api as unknown as { run: unknown }).run = vi.fn(() => new Promise(() => {}));
    render(<App />); click('Saved');
    await waitFor(() => expect(api.playlists).toHaveBeenCalled());
    click('Saved p as queue');
    await waitFor(() => expect(current()).toBe('d'));
  });
});
