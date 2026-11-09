// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { TrackList } from './Search';
import type { Track } from './api';

/**
 * QUEUE-ADD-001 / SEARCH-QUEUE-001 in the search list. The owner: replace the icon that opens the song
 * on its own service with a button that adds the song to what the listener is listening to; and play
 * from the search list steps through the results like a playlist.
 */
const track = (k: string): Track =>
  ({ key: k, title: `Song ${k}`, artist: 'Ken Carson', artists: ['Ken Carson'], album: null, duration: 136, artwork: null, preview: null,
    provider: 'ytmusic', platform_id: k, url: `https://music.youtube.com/watch?v=${k}`, release: null }) as unknown as Track;
const tracks = [track('a'), track('b'), track('c')];

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
const show = async (props: Partial<Parameters<typeof TrackList>[0]> = {}) => {
  await act(async () => {
    root.render(<TrackList tracks={tracks} seedKeys={new Set<string>()} onAdd={() => {}} onPreview={() => {}} label="Results" {...props} />);
  });
};

it('no longer links out to the song\u2019s own service', async () => {
  await show({ onQueueAdd: () => {}, addLabel: 'Now playing queue' });
  expect(host.querySelector('a[href*="music.youtube.com"]')).toBeNull();
  expect(host.querySelector('[aria-label^="Open "]')).toBeNull();
});

it('adds the song to what is playing, named on the button', async () => {
  const add = vi.fn();
  await show({ onQueueAdd: add, addLabel: '\u201cLate night\u201d' });
  const b = host.querySelector<HTMLButtonElement>('button[aria-label="Add Song b to \u201cLate night\u201d"]')!;
  expect(b).toBeTruthy();
  expect(b.className).toMatch(/iconbtn/);
  expect(b.title).toBe('Add to \u201cLate night\u201d');
  await act(async () => b.click());
  expect(add).toHaveBeenCalledWith(tracks[1]);
});

it('shows a song already there as added, and does not add it twice', async () => {
  const add = vi.fn();
  await show({ onQueueAdd: add, addLabel: 'Now playing queue', addedKeys: new Set(['a']) });
  const b = host.querySelector<HTMLButtonElement>('button[aria-label="Song a is in Now playing queue"]')!;
  expect(b.getAttribute('aria-pressed')).toBe('true');
  await act(async () => b.click());
  expect(add).not.toHaveBeenCalled();
});

it('plays a song with the whole result list, so the player can skip through it', async () => {
  const play = vi.fn();
  await show({ onPreview: play });
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Play Song b"]')!.click());
  expect(play).toHaveBeenCalledWith(tracks[1], tracks);
});
