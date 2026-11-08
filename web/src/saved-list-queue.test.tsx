// @vitest-environment happy-dom
/**
 * PLAYLIST-QUEUE-001 / PLAYLIST-MIX-001 in the Saved view: an open list offers "Play as my queue" (or
 * says it is already the queue), and shows its own Sound card read from its songs.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type * as Api from './api';
import { SavedView } from './SavedView';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const listsCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'saved-lists.css'), 'utf8');

const mixFor = vi.fn();
vi.mock('./api', async (orig) => {
  const real = await orig<typeof Api>();
  return {
    ...real,
    api: {
      ...real.api,
      playlistMix: (id: string) => mixFor(id),
    },
  };
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(async () => {
  if (root) await act(() => root!.unmount());
  root = undefined;
  document.body.innerHTML = '';
  localStorage.clear();
  mixFor.mockReset();
});

const track = (n: number) => ({ key: `k${n}`, title: `Song ${n}`, artist: `Artist ${n}`, artists: [`Artist ${n}`], provider: 'deezer', platform_id: `${n}`, tags: [] });
const list = { id: 'L1', name: 'Late night', count: 2, unplayed: 2, discovery_ready: false, items: [{ key: 'k1', played: false }, { key: 'k2', played: false }] };
const taste = {
  events: 2, positive: 2, skips: 0,
  genres: [{ name: 'r&b', score: 2, plays: 2, skips: 0, saves: 2, likes: 0, sound: 0 }],
  artists: [], audio: {}, top: { genre: 'r&b', artist: null }, mood: {}, era: null,
};

async function mount(props: Record<string, unknown>) {
  const el = document.createElement('div');
  document.body.append(el);
  root = createRoot(el);
  await act(() =>
    root!.render(
      <SavedView
        saved={[{ track: track(1), ts: 1 }, { track: track(2), ts: 2 }] as never}
        lists={[list] as never}
        onLists={() => undefined}
        onPreview={() => undefined}
        onRemoveSaved={() => undefined}
        {...props}
      />,
    ),
  );
  // Open the list.
  const chip = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Late night'));
  await act(async () => chip!.click());
  await act(async () => undefined);
}

it('puts the open list in the now playing queue', { timeout: 20000 }, async () => {
  mixFor.mockResolvedValue({ id: 'L1', name: 'Late night', taste, songs: 2, placed: 2 });
  const use = vi.fn();
  await mount({ onUseAsQueue: use, queueListId: null });
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.includes('Play as my queue'))!;
  expect(b).toBeTruthy();
  await act(async () => b.click());
  expect(use).toHaveBeenCalledWith('L1');
});

it('says when the open list is already the now playing queue, instead of offering it again', { timeout: 20000 }, async () => {
  mixFor.mockResolvedValue({ id: 'L1', name: 'Late night', taste, songs: 2, placed: 2 });
  await mount({ onUseAsQueue: () => undefined, queueListId: 'L1' });
  expect(document.body.textContent).toContain('In your now playing queue');
  expect([...document.querySelectorAll('button')].some((x) => x.textContent?.includes('Play as my queue'))).toBe(false);
});

it('shows the list\u2019s own sound, read from its songs', { timeout: 20000 }, async () => {
  mixFor.mockResolvedValue({ id: 'L1', name: 'Late night', taste, songs: 2, placed: 2 });
  await mount({});
  expect(mixFor).toHaveBeenCalledWith('L1');
  const card = document.querySelector('section.sound[aria-label="Sound of “Late night”"]');
  expect(card).toBeTruthy();
  expect(card!.textContent).toContain("This list's mix");
});

it('gives the banner’s Bring back button a 44px target', () => {
  expect(listsCss).toMatch(/\.banner--list > \.push \{[^}]*min-height: 44px;/);
});
