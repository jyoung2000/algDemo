// @vitest-environment happy-dom
/**
 * UI-R3 (owner, 2026-11-19): one song list for Discover, Radio and Saved.
 * - "title, album info and artist information should all be on there respective lines and shouldnt wrap
 *   ... too long titles or information should marquis or scroll" (LINES-001)
 * - "ensure the star icon on windows and android brings up the saved playlist submenu, even if its pressed
 *   via player controls" (STAR-MENU-001)
 * - "ensure the blue bubble is contained nicely in the play button" (PLAY-DISC-002)
 * - "If an album or playlist has already been downloaded locally 100% then remove the download icon and
 *   replace it with a folder icon ... download the missing songs, dont re download music" (LIST-FOLDER-002)
 * - "ensure the discover, radio, and saved music always generates tags for genres" (TAGS-ALWAYS-001)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { GLYPH_PATHS } from '@now-playing/aqua-ui/icons';
import type * as Api from './api';
import type { PlaylistSummary, RecItem, Track } from './api';

vi.mock('./api', async (orig) => {
  const real = await orig<typeof Api>();
  return { ...real, api: { ...real.api, playlistMix: () => new Promise(() => {}), playlistEdit: vi.fn(async () => ({ lists: [] })) } };
});
const { SongCredits } = await import('./SongCredits');
const { PlayerActions } = await import('./PlayerActions');
const { Results } = await import('./Results');
const { SavedView } = await import('./SavedView');
const { stationGenreBubbles } = await import('./Radio');
const { FolderSaves } = await import('./engine/list-save');

const here = dirname(fileURLToPath(import.meta.url));
const t = { key: 'k1', title: 'Song one', artist: 'A', artists: ['A', 'B'], album: 'An album', provider: 'deezer', platform_id: '1', duration: 180 } as Track;
const item = { track: t, rank: 1, reasons: [], playback: { kind: 'none' }, characteristics: {} } as unknown as RecItem;
const list: PlaylistSummary = { id: 'p1', name: 'Night drive', created: 1, count: 0, unplayed: 0, discovery_ready: false, album: null, items: [] } as PlaylistSummary;
const paths = (el: Element) => [...el.querySelectorAll('svg path')].map((p) => p.getAttribute('d'));
afterEach(cleanup);

describe('LINES-001: title, album and artist each keep one line', () => {
  it('scrolls a long album line and a long artist line instead of wrapping them', () => {
    const { container } = render(<SongCredits track={t} onOpenAlbum={() => {}} onOpenArtist={() => {}} />);
    expect(container.querySelector('.song-credits__album-line .mq')).not.toBeNull();
    expect(container.querySelector('.track__artist .mq, .track__artist.mq')).not.toBeNull();
    // Album and artist stay links (SONG-CREDITS-001).
    expect(screen.getByRole('button', { name: 'Open the album An album' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open the artist B' })).toBeTruthy();
  });
  it('never lets the album or artist line wrap (CSS)', () => {
    const css = readFileSync(join(here, 'song-credits.css'), 'utf8');
    expect(css).toMatch(/LINES-001[\s\S]*white-space:\s*nowrap/);
  });
});

describe('STAR-MENU-001: the star opens the saved-list menu everywhere', () => {
  const player = (over: Record<string, unknown> = {}, onFeedback = vi.fn(async () => {})) =>
    <PlayerActions flags={{}} downloadState="idle" downloadAvailable onFeedback={onFeedback} onDownload={async () => true} onDownloads={() => {}}
      songKey={t.key} songTitle={t.title} lists={[list]} onLists={() => {}} {...over} />;

  it('player: a press stars the song and opens the menu', () => {
    const onFeedback = vi.fn(async () => {});
    render(player({}, onFeedback));
    fireEvent.click(screen.getByRole('button', { name: /^Like this song/ }));
    expect(onFeedback).toHaveBeenCalledWith('like');
    expect(screen.getByRole('dialog', { name: /Save Song one to/ })).toBeTruthy();
  });

  it('player: on a starred song the press opens the menu (it does not silently unstar); the menu can remove the star', () => {
    const onFeedback = vi.fn(async () => {});
    render(player({ flags: { like: true } }, onFeedback));
    fireEvent.click(screen.getByRole('button', { name: /^Liked: choose lists for this song/ }));
    expect(onFeedback).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove star' }));
    expect(onFeedback).toHaveBeenCalledWith('unlike');
  });

  it('Discover row: a starred song opens the menu too', () => {
    const onFeedback = vi.fn();
    render(<Results seeds={[]} onRemoveSeed={() => {}} onEmphasis={() => {}} items={[item]} focusKey={null} playingKey={null} flags={{ [t.key]: { like: true } }}
      onFocus={() => {}} onPlay={() => {}} onPlayTrack={() => {}} onFeedback={onFeedback} lists={[list]} onLists={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /^Liked: choose lists for Song one/ }));
    expect(onFeedback).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: /Save Song one to/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove star' }));
    expect(onFeedback).toHaveBeenCalledWith(item, 'unlike');
  });

  it('Saved row: the star (not a folder) opens the menu, and the buttons come in the Discover order', () => {
    render(<SavedView saved={[{ track: t, kind: 'like', ts: 1 }]} lists={[list]} onLists={() => {}} onPreview={() => {}} onPlayAll={() => {}} onRemoveSaved={() => {}}
      onDownload={() => {}} onSimilar={() => {}} />);
    const row = document.querySelector('ul.tracks--saved > li.track')!;
    const labels = [...row.querySelectorAll('.track__actions > button')].map((b) => (b.getAttribute('aria-label') ?? '').split(' ')[0]);
    expect(labels).toEqual(['Play', 'Choose', 'Remove', 'Download', 'Find']);
    const star = screen.getByRole('button', { name: /^Choose lists for Song one/ });
    expect(paths(star)).toContain(GLYPH_PATHS.heart); // HEART-ICON-001: the like is a heart now
    expect(paths(star)).not.toContain(GLYPH_PATHS.folder);
    fireEvent.click(star);
    expect(screen.getByRole('dialog', { name: /Save Song one to/ })).toBeTruthy();
  });
});

describe('PLAY-DISC-002: the blue fill is the play circle', () => {
  it('draws a 44px circle with no transparent border band (a 40x44 box drew an oval fill)', () => {
    const css = readFileSync(join(here, 'song-row.css'), 'utf8');
    const rule = css.slice(css.indexOf('PLAY-DISC-002'));
    expect(rule).toMatch(/width:\s*44px/);
    expect(rule).toMatch(/height:\s*44px/);
    expect(rule).toMatch(/border:\s*0/);
    expect(rule).toMatch(/aspect-ratio:\s*1/);
  });
});

describe('TAGS-ALWAYS-001: every station row shows a genre', () => {
  it('reads a genre from the station name when the directory lists none, marked as read from the name', () => {
    const b = stationGenreBubbles([], 'Bollywood Gaane Purane');
    expect(b[0]!.label).toBe('Bollywood');
    expect(b[0]!.guess).toBe(true);
  });
  it('says the genre is not listed rather than inventing one', () => {
    const b = stationGenreBubbles([], 'Radio Zebra 7');
    expect(b).toHaveLength(1);
    expect(b[0]!.label).toBe('Genre not listed');
  });
  it('keeps the directory\'s own genres first', () => {
    expect(stationGenreBubbles(['jazz', 'latin'], 'Bollywood Jazz').map((x) => x.label)).toEqual(['Jazz', 'Latin']);
  });
});

describe('LIST-FOLDER-002: never download a song twice', () => {
  const song = (k: string) => ({ key: k, title: k, artist: 'X', artists: ['X'] }) as unknown as Track;
  it('asks only for the songs not already in the list folder', async () => {
    const downloadAll = vi.fn();
    const store: Record<string, string> = {};
    const storage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } };
    const ready = new Set(['a', 'b']);
    const deps = {
      downloadAll, readyUrl: (x: Track) => (ready.has(x.key) ? `u:${x.key}` : null),
      snapshot: () => ({ total: 3, ready: ready.size, active: 0, failed: 0, blocked: false, queued: 0, parallel: 2, bulkActive: false, retrying: 0 }) as never,
      subscribe: () => () => {}, save: vi.fn(async (_k: unknown, _n: unknown, songs: unknown[]) => ({ held: songs.length, total: 3, folder: 'F' })), open: vi.fn(), storage,
    };
    const first = new FolderSaves(deps);
    first.start('list', 'L', [song('a'), song('b'), song('c')]);
    await new Promise((r) => setTimeout(r, 0));
    // a and b went into the folder; then the cache evicts them.
    ready.clear();
    const later = new FolderSaves(deps);
    downloadAll.mockClear();
    later.start('list', 'L', [song('a'), song('b'), song('c')]);
    expect(downloadAll).toHaveBeenCalledTimes(1);
    expect((downloadAll.mock.calls[0]![0] as Track[]).map((x) => x.key)).toEqual(['c']);
  });
});
