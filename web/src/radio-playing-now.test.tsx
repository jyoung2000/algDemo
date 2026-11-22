// @vitest-environment happy-dom
// RADIO-PLAYING-NOW-001 (owner, 2026-11-20): "You should also be able to search by artist name or song name the
// radio tab to find any station playing that artist or song currently".
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Broadcast, RadioStation } from './engine/radio';
import type { PlayingStation } from './engine/radio-tunein';
const f = vi.hoisted(() => ({ search: vi.fn(), playing: vi.fn(), probe: vi.fn(), tune: vi.fn(), setStations: vi.fn(), session: vi.fn(), stars: vi.fn() }));
vi.mock('./engine/radio-client', () => ({
  matchSongBroadcast: async () => null,
  radioDirectory: { page: async (...a: unknown[]) => ({ stations: await f.search(...a), nextOffset: null }), search: (...a: unknown[]) => f.search(...a), countries: async () => [] },
  radioSession: { subscribe: () => () => {}, get: () => f.session(), setStations: (a: unknown) => f.setStations(a) },
  favouriteStations: async () => f.stars(), saveFavouriteStations: async (s: unknown) => s, stationMetadata: (s: RadioStation) => f.probe(s), shareRadioPlaces: async () => {},
}));
vi.mock('./engine/radio-playing-client', () => ({ radioPlayingNow: { search: (q: string) => f.playing(q) } }));
const { Radio } = await import('./Radio');

const station = (id: string, name: string, more: Partial<RadioStation> = {}): RadioStation => ({ id, name, url: `https://${id}.example/live`, homepage: '', image: '', country: '', countryCode: 'US', region: 'Chicago, IL', language: 'english', tags: [], codec: 'MP3', bitrate: 128, latitude: null, longitude: null, ...more });
const song = (artist: string, title: string): Broadcast => ({ state: 'current', kind: 'song', artist, title, source: 'TuneIn', checkedAt: Date.now() });
const WCRX: PlayingStation = { station: station('ti-s28032', 'WCRX'), broadcast: song('Drake', 'NOKIA') };
const FOX: PlayingStation = { station: station('ti-s31121', 'The Fox 99.9'), broadcast: song('Drake', 'Hotline Bling') };
const NAMED = station('rb-drake', 'Drake Radio');

let root: Root, host: HTMLDivElement;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); vi.clearAllMocks(); localStorage.clear();
  f.search.mockImplementation(async (o: { query: string }) => o.query ? [NAMED] : [station('rb-a', 'Alpha FM')]);
  f.playing.mockResolvedValue([WCRX, FOX]);
  f.session.mockReturnValue({ station: null }); f.stars.mockResolvedValue([]);
  f.probe.mockImplementation(async (s: RadioStation) => s.id === WCRX.station.id ? WCRX.broadcast : s.id === FOX.station.id ? FOX.broadcast : { ...song('', ''), state: 'unavailable', kind: 'programme', artist: null });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 10)); });
const type = (value: string) => act(async () => { const input = host.querySelector<HTMLInputElement>('.radio-search input[type=search]')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); await new Promise(r => setTimeout(r, 420)); });
const names = () => [...host.querySelectorAll('.radio-station h2')].map(x => x.textContent);
const note = () => host.querySelector('.radio-playing-note')?.textContent ?? null;
async function mount() { await act(async () => root.render(<Radio onTune={f.tune} />)); await flush(); }

describe('search the radio by the artist or song on air (RADIO-PLAYING-NOW-001)', () => {
  it('says the search box takes artists and songs too', async () => {
    await mount();
    expect(host.querySelector<HTMLInputElement>('#radio-q')!.placeholder).toBe('Search stations, artists or songs');
  });
  it('lists the stations playing the artist now first, with the song on air, then stations named like it', async () => {
    await mount(); expect(f.playing).not.toHaveBeenCalled();
    await type('drake'); await flush();
    expect(f.playing).toHaveBeenLastCalledWith('drake');
    expect(names()).toEqual(['WCRX', 'The Fox 99.9', 'Drake Radio']);
    expect(note()).toBe('2 stations are playing “drake” right now');
    const first = host.querySelector('.radio-station')!;
    expect(first.classList.contains('radio-station--playing')).toBe(true);
    expect(first.querySelector('.radio-now')?.textContent).toContain('Drake — NOKIA');
    expect(host.querySelectorAll('.radio-station--playing')).toHaveLength(2);
  });
  it('plays a found station like any other row, with the found stations as the next and previous ones', async () => {
    await mount(); await type('drake'); await flush();
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Play WCRX"]')!.click());
    expect(f.tune).toHaveBeenCalledWith(expect.objectContaining({ id: 'ti-s28032', url: 'https://ti-s28032.example/live' }));
    expect((f.setStations.mock.calls.at(-1)![0] as RadioStation[]).map(s => s.name)).toEqual(['WCRX', 'The Fox 99.9', 'Drake Radio']);
  });
  it('says plainly when no station is playing it now and still lists stations named like it', async () => {
    f.playing.mockResolvedValue([]);
    await mount(); await type('drake'); await flush();
    expect(note()).toBe('No station is playing “drake” right now');
    expect(names()).toEqual(['Drake Radio']);
  });
  it('drops a found station once it is heard playing something else', async () => {
    await mount(); await type('drake'); await flush();
    f.probe.mockImplementation(async (s: RadioStation) => s.id === WCRX.station.id ? song('SZA', 'Saturn') : FOX.broadcast);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await new Promise(r => setTimeout(r, 20)); });
    expect(names()).toEqual(['The Fox 99.9', 'Drake Radio']);
    expect(note()).toBe('1 station is playing “drake” right now');
  });
  it('clears the found stations with the search, and does not mix them into starred stations', async () => {
    await mount(); await type('drake'); await flush();
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Station sections"] button')].find(b => b.textContent?.startsWith('Starred'))!.click()); await flush();
    expect(host.querySelectorAll('.radio-station--playing')).toHaveLength(0); expect(note()).toBeNull();
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Station sections"] button')].find(b => b.textContent === 'All stations')!.click()); await flush();
    expect(names()[0]).toBe('WCRX');
    await type(''); await flush();
    expect(names()).toEqual(['Alpha FM']); expect(note()).toBeNull();
  });
  it('ignores an answer that arrives after the search changed', async () => {
    let late: (v: PlayingStation[]) => void = () => {};
    f.playing.mockImplementationOnce(() => new Promise(r => { late = r; })).mockResolvedValue([]);
    await mount(); await type('drake'); await type('sade'); await flush();
    await act(async () => { late([WCRX]); await new Promise(r => setTimeout(r, 10)); });
    expect(names()).not.toContain('WCRX');
    expect(note()).toBe('No station is playing “sade” right now');
  });
});

// RADIO-PLAYING-NOW-002 (owner, 2026-11-21): "it didnt return stations playing that artist or song even though the
// station i was actively listening to was playing the song i searched for". Measured: TuneIn returned no station for
// "sombr" while Christmas FM Non-stop (Radio Browser) played sombr's "I Barely Know Her" in jPlay.
describe('stations jPlay hears itself count too (RADIO-PLAYING-NOW-002)', () => {
  const XMAS = station('rb-xmas', 'Christmas FM Non-stop!', { countryCode: 'FI', region: '' });
  const KEXP = station('rb-kexp', 'KEXP 90.3 FM');
  const NEAR = station('rb-near', 'Hot 97');
  const playingSombr = (s: RadioStation) => ({ station: s, broadcast: song('canal street, sombr', 'I Barely Know Her'), track: null, identified: false });
  beforeEach(() => { f.playing.mockResolvedValue([]); });
  it('lists the station being listened to when its song is the artist searched for, though TuneIn knows nothing', async () => {
    f.session.mockReturnValue(playingSombr(XMAS));
    await mount(); await type('sombr'); await flush();
    expect(names()[0]).toBe('Christmas FM Non-stop!');
    expect(host.querySelector('.radio-station')!.classList.contains('radio-station--playing')).toBe(true);
    expect(host.querySelector('.radio-station .radio-now')?.textContent).toContain('canal street, sombr — I Barely Know Her');
    expect(note()).toBe('1 station is playing “sombr” right now');
  });
  it('finds it by the song name as well', async () => {
    f.session.mockReturnValue(playingSombr(XMAS));
    await mount(); await type('barely know her'); await flush();
    expect(names()[0]).toBe('Christmas FM Non-stop!');
    expect(note()).toBe('1 station is playing “barely know her” right now');
  });
  it('uses the song the station was identified as playing when its stream names something else', async () => {
    f.session.mockReturnValue({ station: XMAS, broadcast: song('Christmas FM', 'Non-stop!'), identified: true, track: { id: 't', provider: 'deezer', platform_id: '1', key: 'k', title: 'back to friends', artist: 'sombr', artists: ['sombr'] } });
    await mount(); await type('back to friends'); await flush();
    expect(names()[0]).toBe('Christmas FM Non-stop!');
  });
  it('does not list the station being listened to when it plays something else', async () => {
    f.session.mockReturnValue({ station: XMAS, broadcast: song('Mariah Carey', 'All I Want for Christmas Is You'), track: null, identified: false });
    await mount(); await type('sombr'); await flush();
    expect(names()).not.toContain('Christmas FM Non-stop!'); expect(note()).toBe('No station is playing “sombr” right now');
  });
  it('asks the starred stations and the stations listed for the listener’s places what they are playing', async () => {
    f.stars.mockResolvedValue([KEXP]);
    f.search.mockImplementation(async (o: { query: string }) => o.query ? [NAMED] : [station('rb-a', 'Alpha FM'), NEAR]);
    f.probe.mockImplementation(async (s: RadioStation) => s.id === KEXP.id ? song('sombr', 'undressed') : s.id === NEAR.id ? song('sombr', 'back to friends') : song('SZA', 'Saturn'));
    await mount(); await type('sombr'); await flush(); await flush();
    expect(names().slice(0, 2).sort()).toEqual(['Hot 97', 'KEXP 90.3 FM']);
    expect(note()).toBe('2 stations are playing “sombr” right now');
    expect(f.probe).toHaveBeenCalledWith(expect.objectContaining({ id: 'rb-a' }));
  });
  it('lists TuneIn’s stations after the ones jPlay heard itself, each station once', async () => {
    f.session.mockReturnValue({ station: XMAS, broadcast: song('Drake', 'NOKIA'), track: null, identified: false });
    f.playing.mockResolvedValue([WCRX, FOX]);
    await mount(); await type('drake'); await flush();
    expect(names()).toEqual(['Christmas FM Non-stop!', 'WCRX', 'The Fox 99.9', 'Drake Radio']);
    expect(note()).toBe('3 stations are playing “drake” right now');
  });
  it('keeps showing TuneIn’s song for a found station whose own feed says nothing about the song (measured: 96 RADIO read “Programme information unavailable”)', async () => {
    f.probe.mockImplementation(async () => ({ ...song('', ''), state: 'unavailable', kind: 'programme', artist: null, title: '' }));
    f.playing.mockResolvedValue([WCRX, FOX]);
    await mount(); await type('drake'); await flush(); await flush();
    expect(names().slice(0, 2)).toEqual(['WCRX', 'The Fox 99.9']);
    expect(host.querySelector('.radio-station .radio-now')?.textContent).toContain('Drake — NOKIA');
  });
});
