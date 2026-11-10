// @vitest-environment happy-dom
/**
 * LIST-SAVE-FOLDER-001 in the UI. One button on a saved list, a saved album and an album page downloads
 * every song into that list's own folder; while it runs it counts, when it is done it says where the
 * songs are and how many could not be had; the folder button beside it opens the folder.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SaveState } from './engine/list-save';

let state: SaveState = { phase: 'idle', held: 0, total: 3, folder: null, missing: 0, error: null };
const start = vi.fn();
const open = vi.fn(async () => ({ ok: true, folder: 'f' }));
let notify: () => void = () => {};
vi.mock('./engine/downloads', () => ({ downloadsAvailable: () => true, dl: {} }));
vi.mock('./engine/folder-saves', () => ({
  folderSaves: {
    state: () => state,
    start: (...a: unknown[]) => start(...a),
    open: (...a: unknown[]) => open(...(a as [])),
    subscribe: (fn: () => void) => { notify = fn; return () => {}; },
  },
}));
const { ListSaveButton } = await import('./ListSaveButton');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const tracks = [{ key: 'a', title: 'A' }, { key: 'b', title: 'B' }, { key: 'c', title: 'C' }] as never[];
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  state = { phase: 'idle', held: 0, total: 3, folder: null, missing: 0, error: null };
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  start.mockReset();
  open.mockClear();
});
const draw = () => act(async () => root.render(<ListSaveButton tracks={tracks} kind="album" name="Ken Carson - A Great Chaos" label="the album A Great Chaos" />));
const main = () => host.querySelector<HTMLButtonElement>('button.push')!;
const folder = () => host.querySelector<HTMLButtonElement>('button[aria-label="Open the folder with the album A Great Chaos"]')!;
const set = async (s: Partial<SaveState>) => { state = { ...state, ...s }; await act(async () => notify()); };

it('downloads every song into the album\u2019s own folder on one press', async () => {
  await draw();
  expect(main().textContent).toContain('Download to folder');
  expect(main().title).toBe('Download every song in the album A Great Chaos into a folder of its own');
  expect(folder().disabled).toBe(true);
  await act(async () => main().click());
  expect(start).toHaveBeenCalledWith('album', 'Ken Carson - A Great Chaos', tracks);
});

it('counts while it runs, then says where the songs are and opens the folder', async () => {
  await draw();
  await set({ phase: 'running', held: 1 });
  // Busy, but still focusable: pressing it with the keyboard must not drop focus to the page.
  expect(main().disabled).toBe(false);
  expect(main().getAttribute('aria-disabled')).toBe('true');
  main().focus();
  await act(async () => main().click());
  expect(start).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(main());
  expect(main().textContent).toContain('Downloading 1 of 3');
  expect(main().getAttribute('aria-busy')).toBe('true');
  expect(folder().disabled).toBe(false);
  await set({ phase: 'done', held: 2, missing: 1, folder: 'Music \u203a Airwave Discovery \u203a Albums \u203a Ken Carson - A Great Chaos' });
  const note = host.querySelector('[role="status"]')!.textContent!;
  expect(note).toContain('2 of 3 songs are in Music \u203a Airwave Discovery \u203a Albums \u203a Ken Carson - A Great Chaos.');
  expect(note).toContain('1 song had no full version to download.');
  // Not all in: another press tries for the rest.
  expect(main().disabled).toBe(false);
  expect(main().textContent).toContain('Download the rest');
  await act(async () => folder().click());
  expect(open).toHaveBeenCalledWith('album', 'Ken Carson - A Great Chaos');
});

it('keeps its folder button a full target, and controls clear of the docked player', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(`${process.cwd()}/src/styles.css`, 'utf8');
  expect(css).toMatch(/\.list-save__folder \{[^}]*min-width: 44px;[^}]*min-height: 44px;/);
  // A control reached by keyboard (or scrolled into view) stops above the player and the tab bar.
  expect(css).toMatch(/html \{\s*scroll-padding-bottom: calc\(var\(--dock-h\)/);
  expect(css).toMatch(/html \{\s*scroll-padding-bottom: calc\(var\(--tab-h\) \+ var\(--dock-h\)/);
});

it('shows a finished folder as done, and a failure to write it plainly', async () => {
  state = { phase: 'done', held: 3, total: 3, folder: 'F', missing: 0, error: null };
  await draw();
  expect(main().textContent).toContain('In its folder');
  // Still pressable: it puts back songs deleted from the folder since.
  expect(main().disabled).toBe(false);
  expect(main().title).toBe('Check the folder with the album A Great Chaos and put back any missing song');
  await act(async () => main().click());
  expect(start).toHaveBeenCalledWith('album', 'Ken Carson - A Great Chaos', tracks);
  await set({ phase: 'running', error: 'Disk full' });
  expect(host.querySelector('[role="status"]')!.textContent).toContain('The folder could not be written: Disk full');
});
