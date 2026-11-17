// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RadioState } from './engine/radio-client';
const f = vi.hoisted(() => ({ state: {} as RadioState, rewind: vi.fn().mockResolvedValue(undefined), playlistEdit: vi.fn().mockResolvedValue({ lists: [] }), setShuffle: vi.fn().mockResolvedValue(undefined), skip: vi.fn().mockResolvedValue(undefined), stop: vi.fn(), openArtist: vi.fn() }));
vi.mock('./engine/radio-client', () => ({
  radioSession: { subscribe: () => () => {}, get: () => f.state, canSkip: () => true, rewind: (...args: unknown[]) => f.rewind(...args), pause: vi.fn(), stop: (...a: unknown[]) => f.stop(...a), skip: (...a: unknown[]) => f.skip(...a), setShuffle: (...a: unknown[]) => f.setShuffle(...a) },
  favouriteStations: async () => [], saveFavouriteStations: async (v: unknown) => v,
}));
vi.mock('./api', () => ({ api: { feedbackState: async () => ({ state: {} }), playlists: async () => ({ lists: [{ id: 'evening', name: 'Evening' }] }), playlistEdit: (...a: unknown[]) => f.playlistEdit(...a) }, newEventId: () => 'test' }));
vi.mock('./Results', () => ({ GenreBubbleView: () => null }));
vi.mock('./engine/native-engine', () => ({ engineSend: vi.fn() }));
const { RadioPlayer } = await import('./RadioPlayer');
const NOW = 1794873600000;
let root: Root, host: HTMLDivElement;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
beforeEach(() => {
  vi.clearAllMocks(); vi.spyOn(Date, 'now').mockReturnValue(NOW);
  f.state = {
    station: { id: 'world', name: 'World radio', url: 'https://radio.example/live', homepage: '', image: 'https://radio.example/logo.png', country: 'Canada', region: 'Quebec', countryCode: 'CA', language: 'French', tags: ['jazz'], codec: 'MP3', bitrate: 128, latitude: null, longitude: null },
    snapshot: { id: 'session', stationId: 'world', paused: false, position: 180, received: 190, oldest: 0, heard: 180, dropped: false, state: 'playing', error: null, native: true },
    broadcast: { state: 'current', kind: 'programme', title: 'Evening programme', artist: null, source: 'Broadcaster schedule', checkedAt: NOW, startedAt: NOW - 130000, duration: 3600, artwork: 'https://radio.example/programme.jpg' } as RadioState['broadcast'],
    track: null, identified: false, identifying: false, analysis: '', error: null,
  };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });
async function render() { await act(async () => { root.render(<RadioPlayer onOpenArtist={f.openArtist} />); }); }
describe('radio shares the normal player timeline and artwork (RADIO-PLAYER-002)', () => {
  it('shows programme art and a clear playhead at the published programme time minus live delay', async () => {
    await render();
    expect(host.querySelector('.radio-player__art img')?.getAttribute('src')).toBe('https://radio.example/programme.jpg');
    expect(host.querySelector('.radio-player__elapsed')?.textContent).toContain('2:00');
    expect(host.querySelector('.radio-player__duration')?.textContent).toContain('1:00:00');
    const bar = host.querySelector<HTMLInputElement>('.prog__bar')!;
    expect(bar).not.toBeNull(); expect(Number(bar.value)).toBe(120); expect(Number(bar.max)).toBe(3600);
    expect(host.textContent).toContain('Broadcaster timing');
  });
  it('uses the normal fixed dock class on phones so the live player is not below the station list', async () => {
    await act(async () => root.render(<RadioPlayer docked />));
    expect(host.querySelector('.radio-player')?.classList.contains('np--docked')).toBe(true);
  });
  it('uses identified song cover art before programme or station artwork', async () => {
    f.state.track = { id: 'song', key: 'song', provider: 'deezer', title: 'Music', artwork: 'https://catalogue.example/album.jpg', duration: 240 } as RadioState['track'];
    f.state.identified = true; await render();
    expect(host.querySelector('.radio-player__art img')?.getAttribute('src')).toBe('https://catalogue.example/album.jpg');
  });
  it('labels missing item timing honestly and never calls time since tuning the programme position', async () => {
    delete f.state.broadcast!.startedAt; delete f.state.broadcast!.duration; delete (f.state.broadcast as unknown as { artwork?: string }).artwork;
    await render(); expect(host.textContent).toContain('Duration not published'); expect(host.textContent).toContain('Start time not published');
    expect(host.querySelector('.radio-player__elapsed')?.textContent).toBe('--:--');
    expect(host.querySelector<HTMLInputElement>('.prog__bar')?.getAttribute('aria-label')).toBe('Rewind buffered radio');
    expect(host.querySelector('.radio-player__art img')?.getAttribute('src')).toBe('https://radio.example/logo.png');
    expect(host.textContent).toContain('Station artwork');
  });
  it('labels a catalogue length without pretending to know broadcast start or station edit length', async () => {
    f.state.broadcast!.kind = 'song'; delete f.state.broadcast!.startedAt; delete f.state.broadcast!.duration;
    f.state.track = { id: 'song', key: 'song', provider: 'deezer', title: 'Music', duration: 240 } as RadioState['track'];
    f.state.identified = true; await render(); expect(host.textContent).toContain('Catalogue length');
    expect(host.querySelector('.radio-player__duration')?.textContent).toContain('4:00');
    expect(host.querySelector('.radio-player__elapsed')?.textContent).toBe('--:--');
  });
  it('only permits backward slider movement and uses the same radio rewind operation', async () => {
    await render(); const bar = host.querySelector<HTMLInputElement>('.prog__bar')!;
    expect(bar).not.toBeNull();
    await act(async () => { bar.value = '90'; bar.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { bar.dispatchEvent(new Event('pointerup', { bubbles: true })); });
    expect(f.rewind).toHaveBeenCalledWith(30);
    f.rewind.mockClear();
    await act(async () => { bar.value = '180'; bar.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(f.rewind).not.toHaveBeenCalled(); expect(Number(bar.value)).toBe(120);
    expect(host.textContent).toContain('Live radio cannot seek forward');
  });
});

describe('radio playlist payloads use the real API contract', () => {
  const bookmark = () => ({ key: 'radio:world:evening', id: 'radio:world:evening', provider: 'radio', title: 'Evening programme', kind: 'radio-programme', radio_station: f.state.station });
  it('adds the current programme by key and retains its playable station snapshot', async () => {
    f.state.track = bookmark() as RadioState['track']; await render();
    await act(async () => { [...host.querySelectorAll('button')].find(b => b.textContent === 'Add to playlist')!.click(); });
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('.radio-playlists button')].find(b => b.textContent === 'Evening')!.click(); });
    expect(f.playlistEdit).toHaveBeenCalledWith('add', { id: 'evening', key: 'radio:world:evening', tracks: [bookmark()] });
    expect(host.textContent).toContain('Programme bookmark added');
  });
  it('creates a new playlist containing the current item in the same operation', async () => {
    f.state.track = bookmark() as RadioState['track']; await render();
    await act(async () => { [...host.querySelectorAll('button')].find(b => b.textContent === 'Add to playlist')!.click(); });
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('.radio-playlists button')].find(b => b.textContent === 'New playlist')!.click(); });
    const input = host.querySelector<HTMLInputElement>('[aria-label="New playlist name"]')!;
    expect(input).not.toBeNull();
    await act(async () => { input.value = 'Radio keep'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(f.playlistEdit).toHaveBeenCalledWith('create', { name: 'Radio keep', key: 'radio:world:evening', tracks: [bookmark()] });
  });
});

describe('radio player transport matches the music player and adds station shuffle (RADIO-UI-005)', () => {
  it('uses the shared transport buttons: shuffle, previous, play/pause main, next, rewind', async () => {
    f.state = { ...f.state, shuffle: false };
    await render();
    const transport = host.querySelector('.transport')!;
    expect(transport).not.toBeNull();
    const shuffle = transport.querySelector<HTMLButtonElement>('[aria-label="Shuffle stations"]')!;
    expect(shuffle.getAttribute('aria-pressed')).toBe('false');
    expect(shuffle.className).toContain('tbtn--mode');
    await act(async () => shuffle.click());
    expect(f.setShuffle).toHaveBeenCalledWith(true);
    expect(transport.querySelector('[aria-label="Previous radio station"]')?.className).toContain('tbtn');
    expect(transport.querySelector('[aria-label="Pause radio"]')?.className).toContain('tbtn--main');
    const next = transport.querySelector<HTMLButtonElement>('[aria-label="Next radio station"]')!;
    await act(async () => next.click());
    expect(f.skip).toHaveBeenCalledWith(1);
    expect(transport.querySelector('[aria-label="Rewind radio 15 seconds"]')).not.toBeNull();
    expect(transport.textContent).not.toContain('┃◀');
  });
  it('marks shuffle on and explains that next picks a random station', async () => {
    f.state = { ...f.state, shuffle: true };
    await render();
    const shuffle = host.querySelector<HTMLButtonElement>('[aria-label="Shuffle stations"]')!;
    expect(shuffle.getAttribute('aria-pressed')).toBe('true');
    expect(shuffle.title).toContain('random station');
    await act(async () => shuffle.click());
    expect(f.setShuffle).toHaveBeenCalledWith(false);
  });
  it('keeps identify and stop out of the action buttons: identification is a status, stop is the close icon', async () => {
    f.state = { ...f.state, identifying: true };
    await render();
    const labels = [...host.querySelectorAll('.radio-player__actions button')].map(b => b.textContent);
    expect(labels).not.toContain('Identify audio');
    expect(labels).not.toContain('Stop radio');
    expect(host.querySelector('.radio-player__status')?.textContent).toContain('Identifying');
    const close = host.querySelector<HTMLButtonElement>('button.radio-player__close[aria-label="Stop radio"]')!;
    expect(close).not.toBeNull();
    expect(close.textContent).not.toContain('Stop radio');
    await act(async () => close.click());
    expect(f.stop).toHaveBeenCalled();
  });
  it('opens the artist page from the identified artist name', async () => {
    f.state = { ...f.state, identified: true, track: { key: 'k', title: 'Song', artist: 'Nabihah Iqbal', artists: ['Nabihah Iqbal'], duration: 200 } as RadioState['track'] };
    await render();
    const link = host.querySelector<HTMLButtonElement>('button[aria-label="Open the artist Nabihah Iqbal"]')!;
    expect(link).not.toBeNull();
    expect(link.className).toContain('artistlink');
    await act(async () => link.click());
    expect(f.openArtist).toHaveBeenCalledWith({ name: 'Nabihah Iqbal' });
  });
});

describe('live chip without counters (RADIO-UI-007)', () => {
  it('shows BEHIND LIVE and the rewind note without any numeric countdowns', async () => {
    f.state = { ...f.state, snapshot: { ...f.state.snapshot!, position: 100, received: 190 } };
    await render();
    const chip = host.querySelector('.radio-live')!;
    expect(chip.textContent).toContain('BEHIND LIVE');
    expect(chip.textContent).not.toMatch(/\d+:\d+/);
    const buffer = host.querySelector('.radio-player__buffer')!;
    expect(buffer.textContent).not.toContain('available to rewind');
    expect(buffer.textContent).not.toContain('behind live');
    expect(buffer.textContent).toContain('Pause retains 5 minutes');
  });
});
