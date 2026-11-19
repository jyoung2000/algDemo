// @vitest-environment happy-dom
// RADIO-PLACES-001 (owner, 2026-11-19): type and save a city, address or region under Anywhere; choose several
// at once; the choices survive closing and opening the app.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RadioStation } from './engine/radio';
import type { RadioPlace } from './engine/radio-places';

const f = vi.hoisted(() => ({ search: vi.fn(), countries: vi.fn(), favourites: vi.fn(), save: vi.fn(), probe: vi.fn(), geocode: vi.fn(), sharePlaces: vi.fn() }));
vi.mock('./engine/radio-client', () => ({
  matchSongBroadcast: async () => null,
  radioDirectory: { page: async (...a: unknown[]) => ({ stations: await f.search(...a), nextOffset: null }), search: (...a: unknown[]) => f.search(...a), countries: () => f.countries() },
  radioSession: { subscribe: () => () => {}, get: () => ({ station: null }), setStations: () => {} },
  favouriteStations: () => f.favourites(), saveFavouriteStations: (s: unknown) => f.save(s), stationMetadata: (s: RadioStation) => f.probe(s),
  radioGeocode: (q: string) => f.geocode(q),
  shareRadioPlaces: (p: unknown) => f.sharePlaces(p),
}));
const { Radio } = await import('./Radio');

const place = (label: string, o: Partial<RadioPlace> = {}): RadioPlace => ({ id: `area:US:${label}`, label, query: label, kind: 'area', lat: 41.77, lon: -88.15, radiusKm: 40, countryCode: 'US', region: 'Illinois', city: label.split(',')[0]!, selected: true, ...o });
const station = (id: string): RadioStation => ({ id, name: `Station ${id}`, url: `https://s-${id}.example/live`, homepage: '', image: '', country: 'US', countryCode: 'US', region: 'Illinois', language: 'english', tags: [], codec: 'MP3', bitrate: 128, latitude: null, longitude: null });

let root: Root, host: HTMLDivElement;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); vi.clearAllMocks(); localStorage.clear();
  f.countries.mockResolvedValue([{ name: 'CA', code: 'CA', count: 3 }]); f.search.mockResolvedValue([station('a')]); f.favourites.mockResolvedValue([]); f.probe.mockResolvedValue({ state: 'unavailable', kind: 'programme', title: '', artist: null, source: 'test', checkedAt: Date.now() });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 10)); });
const mount = async () => { await act(async () => root.render(<Radio onTune={() => {}} />)); await flush(); };
const openMenu = () => act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Country filter"]')!.click());
const typeInto = (el: HTMLInputElement, value: string) => act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
const savePlace = async (text: string) => {
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Add a place"]')!;
  await typeInto(input, text);
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Save place"]')!.click());
  await flush();
};
const lastPlaces = () => ((f.search.mock.calls.at(-1)?.[0] as { places?: RadioPlace[] }).places ?? []).map((p) => p.label);

describe('radio places', () => {
  it('saves a typed city under Anywhere and filters the station list to it', async () => {
    f.geocode.mockResolvedValueOnce(place('Naperville, Illinois'));
    await mount();
    await openMenu();
    expect(host.querySelector('.radio-search__menu')?.textContent).toContain('Anywhere');
    await savePlace('Naperville');
    expect(f.geocode).toHaveBeenCalledWith('Naperville');
    expect(lastPlaces()).toEqual(['Naperville, Illinois']);
    expect(host.querySelector('[aria-label="Country filter"]')?.textContent).toContain('Naperville');
    const box = host.querySelector<HTMLInputElement>('.radio-places input[type=checkbox]')!;
    expect(box.checked).toBe(true);
  });

  it('several places at once, each can be switched off, and the choices come back after the app reopens', async () => {
    f.geocode.mockResolvedValueOnce(place('Naperville, Illinois')).mockResolvedValueOnce(place('Toronto, Ontario', { id: 'area:CA:toronto', countryCode: 'CA', region: 'Ontario', lat: 43.65, lon: -79.38 }));
    await mount();
    await openMenu();
    await savePlace('Naperville');
    await savePlace('Toronto');
    expect(lastPlaces()).toEqual(['Naperville, Illinois', 'Toronto, Ontario']);
    expect(host.querySelector('[aria-label="Country filter"]')?.textContent).toMatch(/Naperville \+1/);
    const boxes = () => [...host.querySelectorAll<HTMLInputElement>('.radio-places input[type=checkbox]')];
    await act(async () => boxes()[0]!.click()); await flush();
    expect(lastPlaces()).toEqual(['Toronto, Ontario']);
    // Close and open the app again.
    await act(async () => root.unmount()); root = createRoot(host);
    f.search.mockClear();
    await mount();
    expect(lastPlaces()).toEqual(['Toronto, Ontario']);
    await openMenu();
    expect(boxes().map((b) => b.checked)).toEqual([false, true]);
    expect([...host.querySelectorAll('.radio-places__label')].map((x) => x.textContent)).toEqual(['Naperville, Illinois', 'Toronto, Ontario']);
  });

  it('Anywhere shows every station again but keeps the saved places; a place can be removed', async () => {
    f.geocode.mockResolvedValueOnce(place('Naperville, Illinois'));
    await mount();
    await openMenu();
    await savePlace('Naperville');
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('.radio-search__menu [role=option]')].find((b) => b.textContent === 'Anywhere')!.click()); await flush();
    expect(lastPlaces()).toEqual([]);
    await openMenu();
    expect(host.querySelector<HTMLInputElement>('.radio-places input[type=checkbox]')!.checked).toBe(false);
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Remove Naperville, Illinois"]')!.click()); await flush();
    expect(host.querySelectorAll('.radio-places input[type=checkbox]')).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem('airwave:radio-places') || '[]')).toEqual([]);
  });

  it('says so when nothing matches what was typed, and Enter in the box saves without searching stations by it', async () => {
    f.geocode.mockResolvedValueOnce(null);
    await mount();
    await openMenu();
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Add a place"]')!;
    await typeInto(input, 'zzqxw');
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    await flush();
    expect(f.geocode).toHaveBeenCalledWith('zzqxw');
    expect(host.querySelector('.radio-places__note')?.textContent).toMatch(/No place found/);
    expect(f.search).not.toHaveBeenLastCalledWith(expect.objectContaining({ query: 'zzqxw' }));
  });

  it('choosing a country switches the places off', async () => {
    f.geocode.mockResolvedValueOnce(place('Naperville, Illinois'));
    await mount();
    await openMenu();
    await savePlace('Naperville');
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('.radio-search__menu [role=option]')].find((b) => b.textContent?.includes('Canada'))!.click()); await flush();
    expect(f.search).toHaveBeenLastCalledWith(expect.objectContaining({ country: 'CA' }));
    expect(lastPlaces()).toEqual([]);
  });
});

describe('places reach Android Auto (CAR-RADIO-FILTERS-001)', () => {
  it('shares the saved places with the car when the tab opens and whenever they change', async () => {
    localStorage.setItem('airwave:radio-places', JSON.stringify([place('Chicago, Illinois', { selected: false })]));
    await mount();
    expect((f.sharePlaces.mock.calls.at(-1)?.[0] as RadioPlace[]).map((p) => p.label)).toEqual(['Chicago, Illinois']);
    f.geocode.mockResolvedValueOnce(place('Toronto, Ontario', { countryCode: 'CA' }));
    await openMenu();
    await savePlace('Toronto');
    expect((f.sharePlaces.mock.calls.at(-1)?.[0] as RadioPlace[]).map((p) => p.label)).toEqual(['Chicago, Illinois', 'Toronto, Ontario']);
  });
});
