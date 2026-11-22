// RADIO-PLAYING-NOW-002: stations jPlay can hear itself count in the "playing now" search, not only TuneIn's.
import { describe, expect, it, vi } from 'vitest';
import type { Broadcast, RadioStation } from './radio';
import { askStationsPlaying, heardPlaying, stationsToAsk } from './radio-playing-local';

const station = (id: string, name = id): RadioStation => ({ id, name, url: `https://${id}.example/live`, homepage: '', image: '', country: '', countryCode: 'FI', region: '', language: '', tags: [], codec: 'MP3', bitrate: 128, latitude: null, longitude: null });
const NOW = 1_800_000_000_000;
const song = (artist: string | null, title: string, more: Partial<Broadcast> = {}): Broadcast => ({ state: 'current', kind: 'song', artist, title, source: 'Broadcaster ICY', checkedAt: NOW - 5000, ...more });
const XMAS = station('rb-xmas', 'Christmas FM Non-stop!');

describe('a station jPlay hears playing the artist or song (RADIO-PLAYING-NOW-002)', () => {
  it('matches the artist and the song title the station is sending now (measured: sombr on Christmas FM)', () => {
    const h = { station: XMAS, broadcast: song('canal street, sombr', 'I Barely Know Her') };
    expect(heardPlaying('sombr', h, NOW)?.broadcast.title).toBe('I Barely Know Her');
    expect(heardPlaying('barely know her', h, NOW)?.station.id).toBe('rb-xmas');
    expect(heardPlaying('i barely know her sombr', h, NOW)).not.toBeNull();
    expect(heardPlaying('drake', h, NOW)).toBeNull();
  });
  it('matches words with or without their apostrophes (measured: "please dont call" missed Bleachers on Christmas FM)', () => {
    const h = { station: XMAS, broadcast: song('Bleachers', "Merry Christmas, Please Don't Call") };
    expect(heardPlaying('please dont call', h, NOW)).not.toBeNull();
    expect(heardPlaying("please don't call", h, NOW)).not.toBeNull();
    expect(heardPlaying('please don’t call', h, NOW)).not.toBeNull();
    expect(heardPlaying('please don call', h, NOW)).toBeNull();
  });
  it('matches a song the stream sends as one line with no artist field', () => {
    expect(heardPlaying('sombr', { station: XMAS, broadcast: song(null, 'sombr - back to friends') }, NOW)).not.toBeNull();
  });
  it('uses the identified song when the broadcaster names something else (a slogan or the show)', () => {
    const r = heardPlaying('back to friends', { station: XMAS, broadcast: song('Christmas FM', 'Non-stop Christmas hits'), track: { title: 'back to friends', artist: 'sombr' } }, NOW);
    expect(r?.broadcast).toMatchObject({ artist: 'sombr', title: 'back to friends', state: 'current', kind: 'song' });
  });
  it('never counts a programme, a stale answer, an old song past its end or the station name', () => {
    expect(heardPlaying('sombr', { station: station('rb-1', 'sombr Radio'), broadcast: null }, NOW)).toBeNull();
    expect(heardPlaying('sombr', { station: XMAS, broadcast: song('sombr', 'undressed', { kind: 'programme' }) }, NOW)).toBeNull();
    expect(heardPlaying('sombr', { station: XMAS, broadcast: song('sombr', 'undressed', { checkedAt: NOW - 120000 }) }, NOW)).toBeNull();
    expect(heardPlaying('sombr', { station: XMAS, broadcast: song('sombr', 'undressed', { startedAt: NOW - 400000, duration: 180 }) }, NOW)).toBeNull();
  });
  it('asks each station once, by id and by name, up to a limit, in the order given', () => {
    const a = station('a', 'Alpha'), a2 = station('a2', 'ALPHA'), b = station('b', 'Beta'), c = station('c', 'Gamma');
    expect(stationsToAsk([[a, b], [a, a2, c]], 9).map(s => s.id)).toEqual(['a', 'b', 'c']);
    expect(stationsToAsk([[a, b, c]], 2).map(s => s.id)).toEqual(['a', 'b']);
  });
  it('reports each matching station as its answer arrives, a few at a time, and skips silent ones', async () => {
    const list = ['s1', 's2', 's3', 's4', 's5', 's6'].map(id => station(id));
    let running = 0, most = 0;
    const probe = vi.fn(async (s: RadioStation) => {
      running++; most = Math.max(most, running); await new Promise(r => setTimeout(r, 5)); running--;
      if (s.id === 's3') throw new Error('no answer');
      return s.id === 's2' || s.id === 's5' ? { ...song('sombr', 'undressed'), checkedAt: Date.now() } : { ...song('SZA', 'Saturn'), checkedAt: Date.now() };
    });
    const found: string[] = [];
    await askStationsPlaying('sombr', list, probe, r => found.push(r.station.id), { concurrency: 3 });
    expect(found.sort()).toEqual(['s2', 's5']); expect(probe).toHaveBeenCalledTimes(6); expect(most).toBe(3);
  });
  it('gives up on a station that does not answer in time, so the search can say it is finished', async () => {
    const probe = vi.fn((s: RadioStation) => s.id === 'slow' ? new Promise<Broadcast>(() => {}) : Promise.resolve({ ...song('sombr', 'undressed'), checkedAt: Date.now() }));
    const found: string[] = []; const t0 = Date.now();
    await askStationsPlaying('sombr', [station('slow'), station('fast')], probe, r => found.push(r.station.id), { concurrency: 1, timeoutMs: 30 });
    expect(found).toEqual(['fast']); expect(Date.now() - t0).toBeLessThan(1000);
  });
  it('stops asking once the search has moved on', async () => {
    let gone = false; const probe = vi.fn(async () => { gone = true; return song('sombr', 'undressed', { checkedAt: Date.now() }); });
    const found: string[] = [];
    await askStationsPlaying('sombr', ['s1', 's2', 's3'].map(id => station(id)), probe, r => found.push(r.station.id), { concurrency: 1, gone: () => gone });
    expect(probe).toHaveBeenCalledTimes(1); expect(found).toEqual([]);
  });
});
