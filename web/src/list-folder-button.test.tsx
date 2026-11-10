// @vitest-environment happy-dom
/**
 * LIST-FOLDER-001. Owner: "add a button where the user can open the local folder with the current
 * song list / queue". An icon button beside the list's download and clear actions asks the shell to
 * lay the list's downloaded songs out in one folder, in play order, and open it in the system's file
 * manager. Songs not downloaded yet are left out, and the button says so.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ready = new Map<string, string>();
const openList = vi.fn(async (_name: string, songs: unknown[]) => ({ ok: true, held: songs.length, total: songs.length }));
vi.mock('./engine/downloads', () => ({ downloadsAvailable: () => true, dl: { openList: (...a: [string, unknown[]]) => openList(...a) } }));
vi.mock('./engine/queue-audio', () => ({
  queueAudio: {
    snapshotFor: () => ({ total: 3, ready: ready.size, active: 0, failed: 0, blocked: false, queued: 0, parallel: 2, bulkActive: false }),
    subscribe: () => () => {},
    readyUrl: (t: { key: string }) => ready.get(t.key) ?? null,
    downloadAll: () => {},
  },
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
beforeEach(() => { ready.clear(); openList.mockClear(); });
afterEach(async () => { if (root) await act(() => root!.unmount()); document.body.innerHTML = ''; });

const tracks = [
  { key: 'a', title: 'Yale', artist: 'Ken Carson' },
  { key: 'b', title: 'ss', artist: 'Ken Carson' },
  { key: 'c', title: 'Succubus', artist: 'Ken Carson' },
] as never[];

const mount = async () => {
  const { ListFolderButton } = await import('./ListDownloadBar');
  const el = document.createElement('div'); document.body.append(el); root = createRoot(el);
  await act(() => root!.render(<ListFolderButton tracks={tracks} name="Late night" label="the now playing queue" />));
  return el.querySelector('button')!;
};

it('opens a folder of the downloaded songs, in list order, named after the list', async () => {
  ready.set('a', 'https://music.youtube.com/watch?v=aaaaaaaaaaa');
  ready.set('c', 'https://music.youtube.com/watch?v=ccccccccccc');
  const b = await mount();
  expect(b.getAttribute('aria-label')).toBe('Open the folder with the now playing queue');
  expect(b.title).toMatch(/2 of 3 songs are downloaded/);
  await act(async () => b.click());
  expect(openList).toHaveBeenCalledWith('Late night', [
    { url: 'https://music.youtube.com/watch?v=aaaaaaaaaaa', title: 'Yale', artist: 'Ken Carson' },
    { url: 'https://music.youtube.com/watch?v=ccccccccccc', title: 'Succubus', artist: 'Ken Carson' },
  ]);
});

it('is disabled, and says why, while no song in the list is downloaded', async () => {
  const b = await mount();
  expect(b.disabled).toBe(true);
  expect(b.title).toMatch(/No song in the now playing queue is downloaded yet/);
});

it('sits in both queue headers, beside the download action; a saved list opens its own folder', () => {
  const app = readFileSync(join(process.cwd(), 'src', 'App.tsx'), 'utf8');
  const groups = app.match(/<div className="queue__actions">[\s\S]*?<\/div>/g) ?? [];
  expect(groups.length).toBe(2);
  for (const g of groups) expect(g).toMatch(/<ListDownloadButton[\s\S]*<ListFolderButton/);
  // LIST-SAVE-FOLDER-001: a saved list or album downloads into a folder of its own, and its folder
  // button (part of ListSaveButton) opens that folder.
  const saved = readFileSync(join(process.cwd(), 'src', 'SavedView.tsx'), 'utf8');
  expect(saved).toMatch(/<ListSaveButton.*kind="list"/);
  expect(saved).toMatch(/<ListSaveButton.*kind="album"/);
});
