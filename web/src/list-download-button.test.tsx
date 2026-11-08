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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const snapshot = { total: 97, ready: 91, active: 0, failed: 6, blocked: false, queued: 0, parallel: 2, bulkActive: false };
const downloadAll = vi.fn();
const subscribers = new Set<() => void>();

vi.mock('./engine/downloads', () => ({ downloadsAvailable: () => true }));
vi.mock('./engine/queue-audio', () => ({
  queueAudio: {
    snapshotFor: () => ({ ...snapshot }),
    subscribe: (fn: () => void) => { subscribers.add(fn); return () => subscribers.delete(fn); },
    downloadAll: (...args: unknown[]) => downloadAll(...args),
  },
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
beforeEach(() => { downloadAll.mockClear(); Object.assign(snapshot, { total: 97, ready: 91, active: 0, bulkActive: false }); });
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

it('rests its arrow during a booked retry and spins only while a source or download is active', async () => {
  const { ListDownloadBar } = await import('./ListDownloadBar');
  Object.assign(snapshot, { active: 0, bulkActive: true });
  const el = document.createElement('div'); document.body.append(el); root = createRoot(el);
  await act(() => root!.render(<ListDownloadBar tracks={tracks} />));
  expect(el.querySelector('.list-availability__spin')).toBeNull();
  Object.assign(snapshot, { active: 1 });
  await act(() => { for (const fn of subscribers) fn(); });
  expect(el.querySelector('.list-availability__spin')).not.toBeNull();
  Object.assign(snapshot, { active: 0 });
  await act(() => { for (const fn of subscribers) fn(); });
  expect(el.querySelector('.list-availability__spin')).toBeNull();
});

it('sits next to Clear list in the list header, not inside the availability card', () => {
  // Both list headers that offer Clear list must offer the download icon in the same row.
  const headers = appSource.match(/<div className="queue__head">[\s\S]{0,900}?<\/div>/g) ?? [];
  const withClear = headers.filter((h) => /Clear now playing queue/.test(h));
  expect(withClear.length, 'no queue header with Clear list found').toBeGreaterThan(0);
  for (const h of withClear) expect(h).toMatch(/<ListDownloadButton/);
});

/**
 * Measured on the packaged 0.7.3 desktop app: dropping the icon in as a loose sibling put it on a
 * DIFFERENT wrapped line from Clear list (y 612 vs 652), and 225px away on a phone, because
 * `.queue__head > .push` takes `margin-left: auto` and forces the wrap. The two actions have to
 * travel as one group to actually sit next to each other.
 */
it('groups the two actions in one right-aligned container so they stay adjacent', () => {
  const headers = appSource.match(/<div className="queue__head">[\s\S]{0,1200}?<\/div>\s*\)?\s*\}?/g) ?? [];
  const withClear = headers.filter((h) => /Clear now playing queue/.test(h));
  expect(withClear.length).toBeGreaterThan(0);
  for (const h of withClear) {
    const group = h.match(/<div className="queue__actions">[\s\S]*?<\/div>/)?.[0] ?? '';
    expect(group, 'actions must share a queue__actions wrapper').not.toBe('');
    expect(group).toMatch(/<ListDownloadButton/);
    expect(group).toMatch(/Clear now playing queue/);
  }
});

it('right-aligns the action group as a non-shrinking row', () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'styles.css'), 'utf8');
  const at = css.indexOf('.queue__actions {');
  expect(at, '.queue__actions rule must exist').toBeGreaterThan(-1);
  const rule = css.slice(at, css.indexOf('}', at) + 1);
  expect(rule).toMatch(/display:\s*flex/);
  expect(rule).toMatch(/margin-left:\s*auto/);
  expect(rule).toMatch(/flex-shrink:\s*0/);
  expect(rule).toMatch(/align-items:\s*center/);
});
