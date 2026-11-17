// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RadioStation } from './engine/radio';
const f = vi.hoisted(() => ({ search: vi.fn(), countries: vi.fn(), favourites: vi.fn(), save: vi.fn(), probe: vi.fn(), setStations: vi.fn(), tune: vi.fn(), match: vi.fn() }));
vi.mock('./engine/radio-client', () => ({
  matchSongBroadcast: (...a: unknown[]) => f.match(...a),
  radioDirectory: { search: (...a: unknown[]) => f.search(...a), countries: () => f.countries() },
  radioSession: { subscribe: () => () => {}, get: () => ({ station: null }), setStations: (a: unknown) => f.setStations(a) },
  favouriteStations: () => f.favourites(), saveFavouriteStations: (s: unknown) => f.save(s), stationMetadata: (s: RadioStation) => f.probe(s),
}));
const { Radio } = await import('./Radio');
const station = (id: string): RadioStation => ({ id, name: `Station ${id}`, url: `https://station-${id}.example/live`, homepage: '', image: '', country: 'Canada', countryCode: 'CA', region: 'Quebec', language: 'french', tags: ['jazz'], codec: 'MP3', bitrate: 128, latitude: 45, longitude: -73 });
let root: Root, host: HTMLDivElement;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); vi.clearAllMocks(); localStorage.clear(); f.countries.mockResolvedValue([{ name: 'CA', code: 'CA', count: 3 }]); f.search.mockResolvedValue([station('a'), station('b')]); f.favourites.mockResolvedValue([]); f.save.mockImplementation(async v => v); f.probe.mockImplementation(async s => ({ state: 'current', kind: 'song', title: `Song ${s.id}`, artist: 'Artist', source: 'Broadcaster', checkedAt: Date.now() })); f.match.mockResolvedValue(null); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 10)); });
const type = (value: string) => act(async () => { const input = host.querySelector<HTMLInputElement>('.radio-search input[type=search]')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); await new Promise(r => setTimeout(r, 420)); });
async function mount() { await act(async () => root.render(<Radio onTune={f.tune} />)); await flush(); }
describe('world radio browse and favourites (RADIO-001)', () => {
  it('loads names, locations and current items for every listed station', async () => {
    await mount(); expect(host.querySelector('h1')?.textContent).toBe('Radio'); expect(host.querySelectorAll('.radio-station')).toHaveLength(2);
    expect(host.textContent).toContain('Quebec, Canada');
    expect(host.querySelector('.radio-station')!.textContent).toContain('French');
    expect(host.querySelector('.radio-station')!.textContent).not.toContain('french'); expect(host.textContent).toContain('Song a'); expect(host.textContent).toContain('Song b'); expect(f.probe).toHaveBeenCalledTimes(2);
  });
  it('searches live while typing in one discover-style bar, without pressing a button', async () => {
    await mount();
    const form = host.querySelector('.radio-search')!;
    expect(form.classList.contains('search__form')).toBe(true);
    expect(form.querySelector('.search__icon')).not.toBeNull();
    expect(host.querySelector('.radio-search button[type=submit]')).toBeNull();
    f.search.mockClear(); f.search.mockResolvedValue([station('kexp')]);
    await type('KEX'); await type('KEXP'); await flush();
    expect(f.search).toHaveBeenCalledWith(expect.objectContaining({ query: 'KEXP', offset: 0 }));
    expect(host.querySelector('.radio-station h2')?.textContent).toContain('Station kexp');
    const clear = host.querySelector<HTMLButtonElement>('.search__clear')!;
    expect(clear).not.toBeNull(); f.search.mockClear(); f.search.mockResolvedValue([station('a')]);
    await act(async () => clear.click()); await act(async () => { await new Promise(r => setTimeout(r, 420)); });
    expect(f.search).toHaveBeenCalledWith(expect.objectContaining({ query: '', offset: 0 }));
  });
  it('selects genre, country and language from menus inside the search bar (RADIO-UI-004)', async () => {
    await mount();
    const sections = host.querySelector('[aria-label="Station sections"]')!;
    expect([...sections.querySelectorAll('button')].map(b => b.textContent)).toEqual(expect.arrayContaining(['Worldwide', 'Starred stations (0)']));
    expect(host.querySelector('[aria-label="Preferred genres"]')).toBeNull();
    expect(host.querySelector('.radio-sections--refine')).toBeNull();
    const field = host.querySelector('.radio-search .search__field')!;
    const genreBtn = field.querySelector<HTMLButtonElement>('[aria-label="Genre filter"]')!;
    const countryBtn = field.querySelector<HTMLButtonElement>('[aria-label="Country filter"]')!;
    const langBtn = field.querySelector<HTMLButtonElement>('[aria-label="Language filter"]')!;
    expect(genreBtn.textContent).toContain('Genre'); expect(countryBtn.textContent).toContain('Country'); expect(langBtn.textContent).toContain('Language');
    await act(async () => genreBtn.click());
    const menu = host.querySelector('.radio-search__menu')!;
    const jazz = [...menu.querySelectorAll<HTMLButtonElement>('[role=option]')].find(b => b.textContent?.includes('Jazz'))!;
    expect((jazz.querySelector('.radio-search__dot') as HTMLElement).style.getPropertyValue('--tone')).toBeTruthy();
    f.search.mockClear(); await act(async () => jazz.click()); await flush();
    expect(f.search).toHaveBeenCalledWith(expect.objectContaining({ tag: 'jazz' }));
    expect(host.querySelector('.radio-search__menu')).toBeNull();
    expect(genreBtn.textContent).toContain('Jazz');
    await act(async () => countryBtn.click());
    const ca = [...host.querySelectorAll<HTMLButtonElement>('.radio-search__menu [role=option]')].find(b => /Canada/.test(b.textContent || ''))!;
    f.search.mockClear(); await act(async () => ca.click()); await flush();
    expect(f.search).toHaveBeenCalledWith(expect.objectContaining({ country: 'CA', tag: 'jazz' }));
    expect(countryBtn.textContent).toContain('Canada');
    await act(async () => langBtn.click());
    const langInput = host.querySelector<HTMLInputElement>('.radio-search__menu input[aria-label="Language"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(langInput, 'french');
    langInput.dispatchEvent(new Event('input', { bubbles: true }));
    f.search.mockClear();
    await act(async () => host.querySelector<HTMLButtonElement>('.radio-search__menu [aria-label="Apply language"]')!.click()); await flush();
    expect(f.search).toHaveBeenCalledWith(expect.objectContaining({ language: 'french' }));
    expect(langBtn.textContent).toContain('French');
    await act(async () => genreBtn.click());
    f.search.mockClear();
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('.radio-search__menu [role=option]')].find(b => b.textContent === 'All genres')!.click()); await flush();
    expect(f.search).toHaveBeenCalledWith(expect.objectContaining({ tag: '' }));
    expect(genreBtn.textContent).not.toContain('Jazz');
  });
  it('colours every directory tag, gives unknown topics a lively deterministic tone and drops codec noise', async () => {
    f.search.mockResolvedValue([{ ...station('a'), tags: ['jazz', 'rnb', 'local news', 'aac', '128', 'mp3'] }]);
    await mount();
    const row = host.querySelector('.radio-station')!;
    const bubbles = [...row.querySelectorAll('.radio-station__tags .genre')];
    expect(bubbles.map(b => b.textContent)).toEqual(['Jazz', 'R&B', 'Local news']);
    const tone = (i: number) => (bubbles[i] as HTMLElement).style.getPropertyValue('--tone');
    expect(tone(0)).toBeTruthy(); expect(tone(1)).toBeTruthy();
    expect(tone(2)).toBeTruthy(); expect(tone(2)).not.toBe('#8a8f98');
    expect(tone(2)).not.toBe(tone(0));
    const meta = row.querySelector('.radio-station__meta')!;
    expect(meta.textContent).toContain('MP3'); expect(meta.textContent).toContain('128 kbps');
    expect(row.querySelector('.radio-station__tags')!.textContent).not.toContain('Aac');
  });
  it('stars stations independently of songs and puts favourites first', async () => {
    f.favourites.mockResolvedValue([station('b')]); await mount(); expect(host.querySelector('.radio-station h2')?.textContent).toContain('Station b');
    await act(async () => (host.querySelector('[aria-label="Star station Station a"]') as HTMLButtonElement).click()); await flush();
    expect(f.save).toHaveBeenCalledWith([station('b'), station('a')]);
  });
  it('passes the ordered station context when tuning so previous/next switch stations', async () => {
    await mount(); const play = host.querySelector('[aria-label="Play Station b"]') as HTMLButtonElement;
    expect(play.textContent).toBe('Play');
    await act(async () => play.click());
    expect(f.setStations).toHaveBeenCalledWith([station('a'), station('b')]); expect(f.tune).toHaveBeenCalledWith(station('b'));
  });
  it('offers a dedicated starred-stations list', async () => {
    f.favourites.mockResolvedValue([station('b')]); await mount(); const button = [...host.querySelectorAll('button')].find(b => b.textContent?.startsWith('Starred stations'))!;
    await act(async () => button.click()); await flush(); expect(host.querySelectorAll('.radio-station')).toHaveLength(1); expect(host.querySelector('.radio-station h2')?.textContent).toContain('Station b');
  });
  it('never invents a programme if the broadcaster supplies none', async () => {
    f.probe.mockResolvedValue({ state: 'unavailable', kind: 'programme', title: '', artist: null, source: 'ICY', checkedAt: Date.now(), detail: 'No ICY metadata' });
    await mount(); expect(host.textContent).toContain('Programme information unavailable'); expect(host.textContent).not.toContain('Song a');
  });
});

describe('live information loading (RADIO-UI-006)', () => {
  it('spins a refresh arrow while station information is updating, then returns to the magnifier', async () => {
    const releases: (() => void)[] = [];
    f.probe.mockImplementation(() => new Promise(r => { releases.push(() => r({ state: 'current', kind: 'song', title: 'T', artist: 'A', source: 'B', checkedAt: Date.now() })); }));
    await mount();
    expect(host.querySelector('.radio-search .radio-refresh__icon')).not.toBeNull();
    await act(async () => { releases.splice(0).forEach(r => r()); await new Promise(r => setTimeout(r, 30)); });
    expect(host.querySelector('.radio-search .radio-refresh__icon')).toBeNull();
  });
  it('tries for cover art: broadcaster artwork first, then the matched song cover', async () => {
    f.search.mockResolvedValue([{ ...station('a'), image: '' }, { ...station('b'), image: '' }]);
    f.probe.mockImplementation(async s => ({ state: 'current', kind: 'song', title: `Song ${s.id}`, artist: 'Artist', source: 'B', checkedAt: Date.now(), artwork: s.id === 'a' ? 'https://cdn.example/broadcast-a.jpg' : undefined }));
    f.match.mockImplementation(async b => (b.title === 'Song b' ? { key: 'k', title: 'Song b', artist: 'Artist', artwork: 'https://cdn.example/cover-b.jpg' } : null));
    await mount(); await flush();
    const art = [...host.querySelectorAll<HTMLImageElement>('.radio-station__art img')].map(i => i.getAttribute('src'));
    expect(art).toEqual(['https://cdn.example/broadcast-a.jpg', 'https://cdn.example/cover-b.jpg']);
  });
});
