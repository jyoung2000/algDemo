// @vitest-environment happy-dom
// RADIO-AZ-ALL-001 (owner, 2026-11-24): the Radio tab's A-Z keeps looking until it finds stations or the directory ends,
// and offers # for station names in other scripts and symbols.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RadioStation } from './engine/radio';
const f = vi.hoisted(() => ({ page: vi.fn(), countries: vi.fn() }));
vi.mock('./engine/radio-client', () => ({
  matchSongBroadcast: async () => null,
  radioDirectory: { page: (...a: unknown[]) => f.page(...a), search: async () => [], countries: () => f.countries() },
  radioSession: { subscribe: () => () => {}, get: () => ({ station: null }), setStations: () => {} },
  favouriteStations: async () => [], saveFavouriteStations: async (s: unknown) => s, stationMetadata: async () => ({ state: 'unavailable', checkedAt: Date.now() }), shareRadioPlaces: async () => {},
}));
const { Radio } = await import('./Radio');
const station = (id: string, name: string): RadioStation => ({ id, name, url: `https://${id}.example/live`, homepage: '', image: '', country: 'Japan', countryCode: 'JP', region: '', language: '', tags: [], codec: 'MP3', bitrate: 128, latitude: null, longitude: null } as unknown as RadioStation);
let root: Root, host: HTMLDivElement;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); vi.clearAllMocks(); localStorage.clear(); f.countries.mockResolvedValue([]); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const flush = (ms = 10) => act(async () => { await new Promise(r => setTimeout(r, ms)); });
async function mount() { await act(async () => root.render(<Radio onTune={() => {}} />)); await flush(); }
const offsets = (letter: string) => f.page.mock.calls.map(c => c[0] as { letter: string; offset: number }).filter(o => o.letter === letter).map(o => o.offset);

describe('Radio tab A-Z reaches the whole directory (RADIO-AZ-ALL-001)', () => {
  it('keeps loading a letter on its own while batches come back empty, until stations or the end', async () => {
    f.page.mockImplementation(async (o: { letter: string; offset: number }) => o.letter !== 'Z' ? { stations: [], nextOffset: null }
      : o.offset === 0 ? { stations: [], nextOffset: 4000 } : o.offset === 4000 ? { stations: [], nextOffset: 8000 } : { stations: [station('zeta', 'Zeta FM')], nextOffset: null });
    await mount();
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Stations beginning with Z"]')!.click()); await flush(50);
    expect(offsets('Z')).toEqual([0, 4000, 8000]);
    expect(host.querySelector('.radio-station h2')?.textContent).toContain('Zeta FM');
  });
  it('offers # for names in other scripts and symbols, listed by the directory under #', async () => {
    f.page.mockImplementation(async (o: { letter: string }) => ({ stations: o.letter === '#' ? [station('pyongyang', '평양FM105.2')] : [], nextOffset: null }));
    await mount();
    const other = host.querySelector<HTMLButtonElement>('[aria-label="Stations in other scripts and symbols"]');
    expect(other?.textContent).toBe('#');
    await act(async () => other!.click()); await flush();
    expect(offsets('#')).toEqual([0]);
    expect(host.querySelector('.radio-station h2')?.textContent).toContain('평양FM105.2');
  });
});
