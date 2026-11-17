import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeStation, parseBroadcast, freshBroadcast, heardCredit, stationLocation, RadioDirectory, MetadataPoller } from './radio';
const raw = { stationuuid: 'abc', name: 'Radio Test', url_resolved: 'https://stream.example.com/live', country: 'Canada', state: 'Quebec', language: 'French', tags: 'jazz,news', lastcheckok: 1, geo_lat: 45, geo_long: -73 };
describe('world radio identity and metadata (RADIO-001)', () => {
  it('preserves real location, language and broadcaster URLs, rejects non-stream URLs', () => {
    const s = normalizeStation(raw)!; expect(stationLocation(s)).toBe('Quebec, Canada'); expect(s.language).toBe('French'); expect(s.tags).toEqual(['jazz', 'news']);
    expect(normalizeStation({ ...raw, url_resolved: 'file:///private' })).toBeNull();
    expect(normalizeStation({ ...raw, url_resolved: 'http://localhost:4000' })).toBeNull();
  });
  it('does not fabricate a song from station genre tags or a programme label', () => {
    expect(parseBroadcast('BBC World Service', 'broadcaster', 100).kind).toBe('programme');
    expect(parseBroadcast(null, 'broadcaster', 100).state).toBe('unavailable');
    expect(parseBroadcast('Artist - Title', 'broadcaster', 100)).toMatchObject({ kind: 'song', artist: 'Artist', title: 'Title', checkedAt: 100 });
  });
  it('marks expired now-playing info stale instead of calling it current', () => {
    const b = parseBroadcast('Artist - Title', 'ICY', 1000); expect(freshBroadcast(b, 50000).state).toBe('current'); expect(freshBroadcast(b, 200000).state).toBe('stale');
  });
  it('credits only recognised music actually heard, never pause time, programmes or duplicates', () => {
    expect(heardCredit({ identified: true, kind: 'song', heard: 65, duration: 200 })).toMatchObject({ eligible: true });
    expect(heardCredit({ identified: true, kind: 'song', heard: 2, duration: 200 }).eligible).toBe(false);
    expect(heardCredit({ identified: false, kind: 'song', heard: 180, duration: 200 }).eligible).toBe(false);
    expect(heardCredit({ identified: true, kind: 'programme', heard: 180, duration: 200 }).eligible).toBe(false);
  });
  it('falls over between directory servers; deduplicates paging; never hides later pages', async () => {
    const calls: string[] = []; const d = new RadioDirectory(async u => { calls.push(u); if (u.includes('de1.')) throw Error('offline'); return JSON.stringify([raw]); });
    const a = await d.search({ country: 'CA', query: 'Radio', offset: 24 }); expect(a[0]!.name).toBe('Radio Test'); expect(calls.some(u => u.includes('offset=24'))).toBe(true); expect(calls).toHaveLength(2);
  });
  it('polls every visible station, bounds concurrency, retains unavailable reasons', async () => {
    let active = 0, max = 0; const seen: string[] = [];
    const p = new MetadataPoller(async s => { active++; max = Math.max(max, active); seen.push(s.id); await new Promise(r => setTimeout(r, 1)); active--; return parseBroadcast(null, 'ICY', Date.now()); }, () => {});
    p.setStations(Array.from({ length: 9 }, (_, i) => ({ ...normalizeStation(raw)!, id: String(i) }))); await p.tick(); p.stop();
    expect(new Set(seen).size).toBe(9); expect(max).toBeLessThanOrEqual(3);
  });
});

it('initializes both bundled decoder runtimes before spawning radio on a first launch', () => {
  const source = readFileSync(new URL('../../../android/app/src/main/java/com/nowplaying/discovery/RadioNative.kt', import.meta.url), 'utf8');
  const start = source.slice(source.indexOf('private fun start('));
  const python = start.indexOf('YoutubeDL.getInstance().init('), ffmpeg = start.indexOf('FFmpeg.getInstance().init('), spawn = start.indexOf('ProcessBuilder(');
  expect(python).toBeGreaterThanOrEqual(0);
  expect(ffmpeg).toBeGreaterThan(python);
  expect(spawn).toBeGreaterThan(ffmpeg);
});

describe('station shuffle picks (RADIO-UI-005)', () => {
  it('never returns the current station and spreads across the list', async () => {
    const { pickShuffleIndex } = await import('./radio');
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) { const n = pickShuffleIndex(5, 2, Math.random); expect(n).not.toBe(2); expect(n).toBeGreaterThanOrEqual(0); expect(n).toBeLessThan(5); seen.add(n); }
    expect(seen.size).toBe(4);
  });
  it('declines when there is nowhere else to go', async () => {
    const { pickShuffleIndex } = await import('./radio');
    expect(pickShuffleIndex(1, 0, Math.random)).toBe(-1);
    expect(pickShuffleIndex(0, -1, Math.random)).toBe(-1);
  });
});
