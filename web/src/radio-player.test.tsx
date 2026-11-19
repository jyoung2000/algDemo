// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RadioState } from './engine/radio-client';
const f = vi.hoisted(() => ({ state: {} as RadioState, rewind: vi.fn().mockResolvedValue(undefined), goLive: vi.fn().mockResolvedValue(undefined), playlistEdit: vi.fn().mockResolvedValue({ lists: [] }), setShuffle: vi.fn().mockResolvedValue(undefined), skip: vi.fn().mockResolvedValue(undefined), stop: vi.fn(), openArtist: vi.fn(), playSong: vi.fn(), downloadSong: vi.fn().mockResolvedValue(undefined), recording: vi.fn().mockResolvedValue({ saved_to: 'Music', partial: true }), volume: vi.fn() }));
vi.mock('./engine/radio-client', () => ({
  radioSession: { subscribe: () => () => {}, get: () => f.state, canSkip: () => true, downloadRecording: () => f.recording(), rewind: (...args: unknown[]) => f.rewind(...args), goLive: (...args: unknown[]) => f.goLive(...args), pause: vi.fn(), stop: (...a: unknown[]) => f.stop(...a), skip: (...a: unknown[]) => f.skip(...a), volume: (...a: unknown[]) => f.volume(...a), setShuffle: (...a: unknown[]) => f.setShuffle(...a) },
  favouriteStations: async () => [], saveFavouriteStations: async (v: unknown) => v, shareRadioPlaces: async () => {},
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
async function render() { await act(async () => { root.render(<RadioPlayer onOpenArtist={f.openArtist} onPlaySong={f.playSong} onDownloadSong={f.downloadSong} />); }); }
describe('radio shares the normal player timeline and artwork (RADIO-PLAYER-002)', () => {
  it('shows programme art and a clear playhead at the published programme time minus live delay', async () => {
    await render();
    expect(host.querySelector('.radio-player__art img')?.getAttribute('src')).toBe('https://radio.example/programme.jpg');
    expect(host.querySelector('.radio-player__elapsed')?.textContent).toContain('2:00');
    expect(host.querySelector('.radio-player__duration')?.textContent).toContain('1:00:00');
    const bar = host.querySelector<HTMLInputElement>('.prog__bar')!;
    expect(bar).not.toBeNull(); expect(Number(bar.value)).toBe(120); expect(Number(bar.max)).toBe(3600);
    expect(host.querySelector('.radio-player__elapsed')?.getAttribute('title')).toBe('Broadcaster timing');
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
    await render(); expect(host.querySelector('.radio-player__duration')?.getAttribute('title')).toBe('Duration not published'); expect(host.querySelector('.radio-player__elapsed')?.getAttribute('title')).toBe('Start time not published');
    expect(host.querySelector('.radio-player__elapsed')?.textContent).toBe('--:--');
    expect(host.querySelector<HTMLInputElement>('.prog__bar')?.getAttribute('aria-label')).toBe('Track progress unavailable');
    expect(host.querySelector('.radio-player__art img')?.getAttribute('src')).toBe('https://radio.example/logo.png');
    expect(host.querySelector('.radio-player__art img')?.getAttribute('alt')).toContain('Station artwork'); // caption removed (RADIO-UI-009); provenance stays in the alt text
  });
  it('labels a catalogue length without pretending to know broadcast start or station edit length', async () => {
    f.state.broadcast!.kind = 'song'; delete f.state.broadcast!.startedAt; delete f.state.broadcast!.duration;
    f.state.track = { id: 'song', key: 'song', provider: 'deezer', title: 'Music', duration: 240 } as RadioState['track'];
    f.state.identified = true; await render(); expect(host.querySelector('.radio-player__duration')?.getAttribute('title')).toBe('Catalogue length');
    expect(host.querySelector('.radio-player__duration')?.textContent).toContain('4:00');
    expect(host.querySelector('.radio-player__elapsed')?.textContent).toBe('--:--');
  });
  it('shows the measured song elapsed time on the left, its catalogue length on the right, and rewinds only as far as the buffer permits', async () => {
    f.state.broadcast = { state: 'current', kind: 'song', title: 'Night Drive', artist: 'Mara', source: 'Broadcaster ICY', checkedAt: NOW } as RadioState['broadcast'];
    f.state.track = { key: 'night', title: 'Night Drive', duration: 220 } as RadioState['track'];
    f.state.identified = true; f.state.songStart = 108;
    await render();
    expect(host.querySelector('.radio-player__elapsed')?.textContent).toBe('1:12');
    expect(host.querySelector('.radio-player__duration')?.textContent).toBe('3:40');
    expect(host.querySelector<HTMLInputElement>('.prog__bar')?.value).toBe('72');
    expect(host.querySelector<HTMLInputElement>('.prog__bar')?.getAttribute('aria-label')).toBe('Rewind current radio track');
  });
  it('never mistakes buffer position for track progress when the track has no audio clock', async () => {
    f.state.broadcast = { state: 'current', kind: 'song', title: 'Night Drive', artist: 'Mara', source: 'Broadcaster ICY', checkedAt: NOW } as RadioState['broadcast'];
    f.state.track = { key: 'night', title: 'Night Drive', duration: 220 } as RadioState['track'];
    f.state.identified = true;
    await render();
    const bar = host.querySelector<HTMLInputElement>('.prog__bar')!;
    expect(bar.value).toBe('0'); expect(bar.max).toBe('1'); expect(bar.disabled).toBe(true);
    expect(host.querySelector('.radio-player__elapsed')?.textContent).toBe('--:--');
    expect(host.querySelector('.radio-player__duration')?.textContent).toBe('3:40');
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
    await act(async () => { [...host.querySelectorAll('button')].find(b => b.textContent === 'Add song to playlist')!.click(); });
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('.radio-playlists button')].find(b => b.textContent === 'Evening')!.click(); });
    expect(f.playlistEdit).toHaveBeenCalledWith('add', { id: 'evening', key: 'radio:world:evening', tracks: [bookmark()] });
    expect(host.textContent).toContain('Programme bookmark added');
  });
  it('creates a new playlist containing the current item in the same operation', async () => {
    f.state.track = bookmark() as RadioState['track']; await render();
    await act(async () => { [...host.querySelectorAll('button')].find(b => b.textContent === 'Add song to playlist')!.click(); });
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
    expect(host.querySelector('.radio-player__status')?.textContent).toBe('');
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
  it('opens the cleaned primary artist for raw broadcaster text (RADIO-ARTIST-001)', async () => {
    f.state = { ...f.state, broadcast: { state: 'current', kind: 'song', title: 'ABC', artist: 'JACKSON 5, THE', source: 'Broadcaster ICY', checkedAt: NOW } as RadioState['broadcast'] };
    await render();
    const link = host.querySelector<HTMLButtonElement>('button[aria-label="Open the artist The Jackson 5"]')!;
    expect(link).not.toBeNull();
    expect(link.textContent).toBe('JACKSON 5, THE');
    await act(async () => link.click());
    expect(f.openArtist).toHaveBeenCalledWith({ name: 'The Jackson 5' });
  });
  it('opens an identified song lead artist with the provider id (RADIO-ARTIST-001)', async () => {
    f.state = { ...f.state, identified: true, track: { key: 'k', title: 'ABC', artist: 'Jackson 5', artists: ['Jackson 5'], artist_ids: { deezer: '75332' }, duration: 180 } as unknown as RadioState['track'] };
    await render();
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Open the artist Jackson 5"]')!.click());
    expect(f.openArtist).toHaveBeenCalledWith({ id: 'dz:75332', name: 'Jackson 5' });
  });
});

describe('live chip without counters (RADIO-UI-007)', () => {
  it('shows BEHIND LIVE and the rewind note without any numeric countdowns', async () => {
    f.state = { ...f.state, timeshifted: true, snapshot: { ...f.state.snapshot!, position: 100, received: 190 } };
    await render();
    const chip = host.querySelector('.radio-live')!;
    expect(chip.textContent).toContain('BEHIND LIVE');
    expect(chip.textContent).not.toMatch(/\d+:\d+/);
    const buffer = host.querySelector('.radio-player__buffer')!;
    expect(buffer.textContent).not.toContain('available to rewind');
    expect(buffer.textContent).not.toContain('behind live');
    expect(buffer.textContent).not.toContain('Pause retains');
  });
});

describe('song title opens the real song (RADIO-UI-008)', () => {
  it('plays the identified song from its title on the player', async () => {
    const track = { key: 'k', title: 'Song', artist: 'Nabihah Iqbal', artists: ['Nabihah Iqbal'], duration: 200 } as RadioState['track'];
    f.state = { ...f.state, identified: true, track };
    await render();
    const btn = host.querySelector<HTMLButtonElement>('button[aria-label="Play the song Song"]')!;
    expect(btn).not.toBeNull();
    await act(async () => btn.click());
    expect(f.playSong).toHaveBeenCalledWith(track);
  });
});

describe('inline radio action icons (RADIO-UI-011)', () => {
  it('stacks the radio timeline and centred transport like the song player, with actions and speaker in a side cluster', async () => {
    await render();
    const player = host.querySelector('.radio-player')!;
    expect(player.querySelector('.radio-player__timeline')).not.toBeNull();
    expect(player.querySelector('.radio-player__controls > .transport')).not.toBeNull();
    expect(player.querySelector('.radio-player__side > .radio-player__actions')).not.toBeNull();
    expect(player.querySelector('.radio-player__side > .vol')).not.toBeNull();
    expect(player.querySelector('.radio-player__side')?.textContent).not.toContain('Volume');
  });

  it('uses the music player speaker control: a double tap mutes, unmutes and restores the last chosen level (VOLUME-POP-001)', async () => {
    await render();
    const speaker = host.querySelector<HTMLButtonElement>('.vol__btn')!;
    expect(speaker).not.toBeNull();
    expect(speaker.getAttribute('aria-label')).toMatch(/double tap to mute/);
    await act(async () => { speaker.click(); speaker.click(); });
    expect(f.volume).toHaveBeenLastCalledWith(0);
    expect(speaker.getAttribute('aria-label')).toMatch(/double tap to unmute/);
    await act(async () => { speaker.click(); speaker.click(); });
    expect(f.volume).toHaveBeenLastCalledWith(1);
    // A single tap opens the slider.
    await act(async () => { speaker.click(); await new Promise((r) => setTimeout(r, 350)); });
    expect(host.querySelector<HTMLInputElement>('.vol__bar')?.getAttribute('aria-label')).toBe('Volume');
  });

  it('adds a star to the playlist action and makes download icon-only without losing its accessible name', async () => {
    await render();
    const playlist = host.querySelector<HTMLButtonElement>('.radio-player__playlist')!;
    expect(playlist).not.toBeNull(); expect(playlist.textContent).toBe('Add song to playlist');
    expect(playlist.querySelector('svg')).not.toBeNull();
    const download = host.querySelector<HTMLButtonElement>('[aria-label="Download radio recording"]')!;
    expect(download.querySelector('svg')).not.toBeNull(); expect(download.textContent).toBe('');
  });
});

describe('quiet radio chrome and download (RADIO-DL-001)', () => {
  it('downloads a matched full song with the existing song downloader, never a live excerpt', async () => {
    f.state.track = { key: 'full', title: 'Full song' } as RadioState['track']; f.state.identified = true;
    await render(); await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Download current song"]')!.click());
    expect(f.downloadSong).toHaveBeenCalledWith(f.state.track); expect(f.recording).not.toHaveBeenCalled();
  });

  it('removes redundant labels and offers a recording download for programmes', async () => {
    await render();
    for (const label of ['Pause retains', 'Station artwork', 'Broadcaster timing', 'Published duration', 'Music identified', 'Live programme']) expect(host.textContent).not.toContain(label);
    const button = host.querySelector<HTMLButtonElement>('[aria-label="Download radio recording"]')!;
    expect(button).not.toBeNull(); await act(async () => button.click());
    expect(f.recording).toHaveBeenCalledOnce(); expect(f.downloadSong).not.toHaveBeenCalled();
    expect(host.querySelector('.radio-player__status')?.textContent).toContain('Recording excerpt saved to Music');
    expect(host.querySelector('.radio-player__titleline strong')).not.toBeNull();
    expect(host.querySelector('.radio-player__titleline .radio-player__starbtn')).not.toBeNull();
  });
});

describe('station star and clean art (RADIO-UI-009)', () => {
  it('the player star stars the station, the playlist button names the song, and no art caption shows', async () => {
    await render();
    const star = host.querySelector<HTMLButtonElement>('.radio-player__starbtn')!;
    expect(star.getAttribute('aria-label')).toBe('Star station World radio');
    expect(host.querySelector('[aria-label="Star current radio item"]')).toBeNull();
    const labels = [...host.querySelectorAll('.radio-player__actions button')].map(b => b.textContent);
    expect(labels).toContain('Add song to playlist');
    expect(labels).not.toContain('Add to playlist');
    expect(host.querySelector('.radio-player__art figcaption')).toBeNull();
  });
});

describe('Go live, and BEHIND LIVE only when it is true (RADIO-GO-LIVE-001 / RADIO-BEHIND-TRUE-001)', () => {
  it('a station that sent a burst of audio ahead is still LIVE RADIO: nothing was paused or rewound', async () => {
    f.state = { ...f.state, timeshifted: false, snapshot: { ...f.state.snapshot!, position: 100, received: 190 } };
    await render();
    expect(host.querySelector('.radio-live')!.textContent).toContain('LIVE RADIO');
    expect(host.querySelector('.radio-live')!.textContent).not.toContain('BEHIND');
    const live = host.querySelector<HTMLButtonElement>('button[aria-label="Go live"]')!;
    expect(live).not.toBeNull();
    expect(live.getAttribute('aria-pressed')).toBe('true');
  });
  it('after a rewind it says BEHIND LIVE, and Go live jumps to the station live', async () => {
    f.state = { ...f.state, timeshifted: true, snapshot: { ...f.state.snapshot!, position: 160, received: 190 } };
    await render();
    expect(host.querySelector('.radio-live')!.textContent).toContain('BEHIND LIVE');
    const live = host.querySelector<HTMLButtonElement>('button[aria-label="Go live"]')!;
    expect(live.getAttribute('aria-pressed')).toBe('false');
    await act(async () => live.click());
    expect(f.goLive).toHaveBeenCalledTimes(1);
  });
  it('the BEHIND LIVE chip itself goes live when tapped', async () => {
    f.state = { ...f.state, timeshifted: true, snapshot: { ...f.state.snapshot!, position: 160, received: 190 } };
    await render();
    await act(async () => host.querySelector<HTMLButtonElement>('.radio-live')!.click());
    expect(f.goLive).toHaveBeenCalledTimes(1);
  });
  it('a rewind that has caught up with live again (within a few seconds) reads LIVE RADIO', async () => {
    f.state = { ...f.state, timeshifted: true, snapshot: { ...f.state.snapshot!, position: 187, received: 190 } };
    await render();
    expect(host.querySelector('.radio-live')!.textContent).toContain('LIVE RADIO');
  });
  it('paused reads PAUSED, and Go live resumes at the live point', async () => {
    f.state = { ...f.state, timeshifted: true, snapshot: { ...f.state.snapshot!, paused: true, position: 160, received: 190 } };
    await render();
    expect(host.querySelector('.radio-live')!.textContent).toContain('PAUSED');
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Go live"]')!.click());
    expect(f.goLive).toHaveBeenCalledTimes(1);
  });
});
