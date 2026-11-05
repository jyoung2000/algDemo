// @vitest-environment happy-dom
/**
 * LIST-METER-003: the list action moved out of the availability card into the list header, next to
 * Clear list, as an icon-only button matching the per-row download action.
 *
 * Owner: "move the download all button next to the clear list and make the download all button just
 * a download icon like the download button".
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import appSource from './App.tsx?raw';

const snapshot = { total: 97, ready: 91, active: 0, failed: 6, blocked: false, queued: 0, parallel: 2, bulkActive: false };
const downloadAll = vi.fn();
const subscribers = new Set<() => void>();

vi.mock('./engine/downloads', () => ({ downloadsAvailable: () => true }));
vi.mock('./engine/queue-audio', () => ({
  queueAudio: {
    snapshotFor: () => snapshot,
    subscribe: (fn: () => void) => { subscribers.add(fn); return () => subscribers.delete(fn); },
    downloadAll: (...args: unknown[]) => downloadAll(...args),
  },
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
beforeEach(() => { downloadAll.mockClear(); Object.assign(snapshot, { total: 97, ready: 91, bulkActive: false }); });
afterEach(async () => { if (root) await act(() => root!.unmount()); document.body.innerHTML = ''; });

const tracks = [{ key: 'a', title: 'A', artist: 'X' }, { key: 'b', title: 'B', artist: 'Y' }] as never[];

const mount = async () => {
  const { ListDownloadButton } = await import('./ListDownloadBar');
  const el = document.createElement('div'); document.body.append(el); root = createRoot(el);
  await act(() => root!.render(<ListDownloadButton tracks={tracks} label="this list" />));
  return el;
};

it('is an icon button with no visible text, like the row download button', async () => {
  const el = await mount();
  const btn = el.querySelector('button');
  expect(btn).not.toBeNull();
  expect(btn!.className).toContain('iconbtn');
  // Icon only: the glyph is the content, there is no "Download all" caption.
  expect(btn!.textContent?.trim()).toBe('');
  expect(el.querySelector('svg, [data-glyph]')).not.toBeNull();
});

it('still names itself for screen readers and on hover', async () => {
  const el = await mount();
  const btn = el.querySelector('button')!;
  expect(btn.getAttribute('aria-label')).toMatch(/download/i);
  expect(btn.getAttribute('aria-label')).toMatch(/this list/i);
  expect(btn.getAttribute('title')).toMatch(/download/i);
});

it('downloads the list when pressed', async () => {
  const el = await mount();
  await act(() => el.querySelector('button')!.click());
  expect(downloadAll).toHaveBeenCalledTimes(1);
});

it('is disabled once every song is already local', async () => {
  Object.assign(snapshot, { ready: 97 });
  const el = await mount();
  expect(el.querySelector('button')!.disabled).toBe(true);
  expect(el.querySelector('button')!.getAttribute('aria-label')).toMatch(/all songs ready|already/i);
});

it('is disabled while a bulk download is already running', async () => {
  Object.assign(snapshot, { bulkActive: true });
  const el = await mount();
  expect(el.querySelector('button')!.disabled).toBe(true);
});

it('sits next to Clear list in the list header, not inside the availability card', () => {
  // Both list headers that offer Clear list must offer the download icon in the same row.
  const headers = appSource.match(/<div className="queue__head">[\s\S]{0,900}?<\/div>/g) ?? [];
  const withClear = headers.filter((h) => /Clear list/.test(h));
  expect(withClear.length, 'no queue header with Clear list found').toBeGreaterThan(0);
  for (const h of withClear) expect(h).toMatch(/<ListDownloadButton/);
});
