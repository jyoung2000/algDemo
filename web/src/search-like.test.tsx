// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { TrackList } from './Search';
import type { Track } from './api';

/**
 * SEARCH-LIKE-001 — the search list's own action is Like, never Add.
 *
 * The owner's rule: no Add button in the search list; the like button takes its place, and liking a
 * song must teach the algorithm and be able to put the song in a playlist. So liking from search
 * does what Add did (the song becomes a starting song, which is what the algorithm reads) and what
 * the song list's like does (feedback, then the playlist menu). Every button is the song list's
 * round icon button (SEARCH-ICONS-001): no text pills in this list.
 */
const track = (over: Partial<Track> = {}): Track =>
  ({
    key: 'k1',
    title: 'gynecologist',
    artist: 'Ken Carson',
    artists: ['Ken Carson'],
    album: 'A Great Chaos',
    duration: 136,
    artwork: null,
    preview: null,
    provider: 'ytmusic',
    platform_id: 'Ep9sGk4BM6g',
    url: 'https://music.youtube.com/watch?v=Ep9sGk4BM6g',
    release: null,
    ...over,
  }) as Track;

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

const show = async (props: Partial<Parameters<typeof TrackList>[0]> = {}) => {
  await act(async () => {
    root.render(
      <TrackList tracks={[track()]} seedKeys={new Set<string>()} onAdd={() => {}} onPreview={() => {}} label="Results" {...props} />,
    );
  });
};

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const actions = () => [...host.querySelectorAll('.track__actions > *')] as HTMLElement[];
const byLabel = (re: RegExp) => actions().find((b) => re.test(b.getAttribute('aria-label') ?? ''));

describe('the search list (SEARCH-LIKE-001)', () => {
  it('offers no Add button at all', async () => {
    await show();
    expect(byLabel(/add/i)).toBeUndefined();
    expect(host.querySelector('.addbtn')).toBeNull();
    expect(host.textContent).not.toMatch(/\bAdd\b/);
  });

  it('likes the song, keeps it as a starting song, and opens the playlist menu', async () => {
    const added: string[] = [];
    const liked: Array<[string, boolean]> = [];
    await show({
      onAdd: (t: Track) => void added.push(t.title),
      onLike: (t: Track, like: boolean) => void liked.push([t.title, like]),
      lists: [{ id: 'p1', name: 'Late drives', created: 0, count: 3, unplayed: 1, discovery_ready: true, items: [] }],
      onLists: () => {},
    });
    const like = byLabel(/^Like /)!;
    expect(like).toBeTruthy();
    expect(like.className).toContain('iconbtn');
    await act(async () => like.click());
    // The algorithm hears it twice over: as a like, and as a starting song (what Add used to do).
    expect(liked).toEqual([['gynecologist', true]]);
    expect(added).toEqual(['gynecologist']);
    // And the list menu is right there, so the song can go into a playlist in one gesture.
    expect(host.querySelector('.track__savemenu')).not.toBeNull();
    expect(host.textContent).toContain('Late drives');
  });

  it('shows a song already in the starting songs as pressed, and takes the like back on a second press', async () => {
    const liked: Array<[string, boolean]> = [];
    const removed: string[] = [];
    await show({
      seedKeys: new Set(['k1']),
      onLike: (t: Track, like: boolean) => void liked.push([t.title, like]),
      onRemoveSeed: (t: Track) => void removed.push(t.title),
    });
    const like = byLabel(/ike/)!;
    expect(like.getAttribute('aria-pressed')).toBe('true');
    expect(like.className).toContain('is-on');
    await act(async () => like.click());
    expect(liked).toEqual([['gynecologist', false]]);
    expect(removed).toEqual(['gynecologist']);
  });

  it('draws every action as the round icon button the song list uses, with no text pill', async () => {
    await show({ onDownload: () => {} });
    expect(actions().length).toBeGreaterThan(1);
    for (const b of actions()) {
      expect(b.className).toMatch(/iconbtn/);
      expect((b.textContent ?? '').trim()).toBe('');
    }
  });
});
