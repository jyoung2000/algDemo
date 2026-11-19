// @vitest-environment happy-dom
// RADIO-TOP-001: when the station list loads, the page stays at the TOP. Nothing in the radio view
// may steal focus, call scrollIntoView, or hand the browser a bottom scroll anchor.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RadioStation } from './engine/radio';
const f = vi.hoisted(() => ({ search: vi.fn(), countries: vi.fn(), favourites: vi.fn(), save: vi.fn(), probe: vi.fn(), setStations: vi.fn(), tune: vi.fn(), match: vi.fn() }));
vi.mock('./engine/radio-client', () => ({
  matchSongBroadcast: (...a: unknown[]) => f.match(...a),
  radioDirectory: { page: async (...a: unknown[]) => ({ stations: await f.search(...a), nextOffset: null }), countries: () => f.countries() },
  radioSession: { subscribe: () => () => {}, get: () => ({ station: null }), setStations: (a: unknown) => f.setStations(a) },
  favouriteStations: () => f.favourites(), saveFavouriteStations: (s: unknown) => f.save(s), stationMetadata: (s: RadioStation) => f.probe(s), shareRadioPlaces: async () => {},
}));
const { Radio } = await import('./Radio');
const station = (id: string): RadioStation => ({ id, name: `Station ${id}`, url: `https://station-${id}.example/live`, homepage: '', image: '', country: 'Canada', countryCode: 'CA', region: 'Quebec', language: 'french', tags: ['jazz'], codec: 'MP3', bitrate: 128, latitude: 45, longitude: -73 });
let root: Root, host: HTMLDivElement;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); vi.clearAllMocks(); localStorage.clear(); f.countries.mockResolvedValue([{ name: 'CA', code: 'CA', count: 3 }]); f.search.mockResolvedValue([station('a'), station('b')]); f.favourites.mockResolvedValue([]); f.save.mockImplementation(async v => v); f.probe.mockImplementation(async s => ({ state: 'current', kind: 'song', title: `Song ${s.id}`, artist: 'Artist', source: 'Broadcaster', checkedAt: Date.now() })); f.match.mockResolvedValue(null); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 10)); });
async function mount() { await act(async () => root.render(<Radio onTune={f.tune} />)); await flush(); }

describe('the directory presents from the top (RADIO-TOP-001)', () => {
  it('keeps the page at the top when the station list loads: no focus steal, no scrollIntoView, no downward scroll', async () => {
    const tops: number[] = [];
    window.scrollTo = ((a?: ScrollToOptions | number, b?: number) => { tops.push(typeof a === 'object' && a !== null ? Number(a.top ?? 0) : Number(b ?? a ?? 0)); }) as typeof window.scrollTo;
    const intoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: intoView, configurable: true, writable: true });
    try {
      await mount();
      expect(host.querySelectorAll('.radio-station')).toHaveLength(2); // the list really loaded
      expect(intoView).not.toHaveBeenCalled(); // nothing pulled a bottom element into view
      expect(document.activeElement === document.body || document.activeElement === null).toBe(true); // no autofocus stole the scroll
      expect(tops.length).toBeGreaterThan(0); // the fresh page actively presents from the top…
      expect(tops.every(t => t === 0)).toBe(true); // …and no programmatic scroll went anywhere else
    } finally { delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView; }
  });
  it('keeps bottom-jumping primitives out of the radio view and pins its scroll anchoring', async () => {
    const src = await readFile(join(process.cwd(), 'src', 'Radio.tsx'), 'utf8');
    // The only focus call is the user-invoked search Clear button; nothing may autofocus,
    // scrollIntoView, or navigate to a hash anchor when data arrives.
    expect(src).not.toMatch(/scrollIntoView|autoFocus|autofocus|location\.hash|href="#/);
    expect(src).toContain('SkeletonList'); // the loading view keeps full height, so there is no short page to clamp to the bottom of
    const css = await readFile(join(process.cwd(), 'src', 'styles.css'), 'utf8');
    expect(css).toMatch(/\.radio-page\s*\{[^}]*overflow-anchor:\s*none/); // the browser may not adopt the footer as a scroll anchor
  });
});
