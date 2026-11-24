import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeStation, parseBroadcast, freshBroadcast, heardCredit, stationLocation, RadioDirectory, MetadataPoller, STATION_SCAN_BATCH, STATION_SCAN_BUDGET } from './radio';
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
  it('calls it a full listen only when most of a song of known length was heard (RADIO-TASTE-001)', () => {
    expect(heardCredit({ identified: true, kind: 'song', heard: 65, duration: 200 }).full).toBe(false);
    expect(heardCredit({ identified: true, kind: 'song', heard: 139, duration: 200 }).full).toBe(false);
    expect(heardCredit({ identified: true, kind: 'song', heard: 140, duration: 200 })).toEqual({ eligible: true, coverage: 140, full: true });
    expect(heardCredit({ identified: true, kind: 'song', heard: 900, duration: 200 })).toEqual({ eligible: true, coverage: 200, full: true }); // never more than the song itself
    expect(heardCredit({ identified: true, kind: 'song', heard: 900, duration: null }).full).toBe(false);
    expect(heardCredit({ identified: false, kind: 'song', heard: 190, duration: 200 }).full).toBe(false);
    expect(heardCredit({ identified: true, kind: 'programme', heard: 190, duration: 200 }).full).toBe(false);
    expect(heardCredit({ identified: true, kind: 'song', heard: 25, duration: 30 }).full).toBe(false); // under thirty seconds heard is nothing at all
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

describe('station alphabet and directory cursors (RADIO-ALPHA-001)', () => {
  it('groups English initials case/diacritic-insensitively and puts digits and other scripts under #', async () => {
    const { stationInitial } = await import('./radio');
    expect(stationInitial('  kexp')).toBe('K'); expect(stationInitial('Énergie')).toBe('E');
    expect(stationInitial('107.5 WGCI')).toBe('W'); expect(stationInitial('日本ラジオ')).toBe('#');
  });
  it('queries the directory for a letter and advances through raw nonmatching rows, not just the displayed first page', async () => {
    const calls: URL[] = [];
    const d = new RadioDirectory(async url => { const u = new URL(url); calls.push(u); const off = Number(u.searchParams.get('offset')); return JSON.stringify(off === 0 ? Array.from({length:STATION_SCAN_BATCH},(_,i)=>({...raw,stationuuid:`other-${i}`,name:`Radio k ${i}`})) : [{...raw,stationuuid:'k1',name:'KEXP'}]); });
    const page = await d.page({ letter:'K', country:'US', tag:'jazz' });
    expect(page.stations.map(s=>s.name)).toEqual(['KEXP']); expect(page.nextOffset).toBeNull();
    expect(calls.map(u=>u.searchParams.get('offset'))).toEqual(['0',String(STATION_SCAN_BATCH)]);
    expect(calls[0]!.searchParams.get('name')).toBe('K'); expect(calls[0]!.searchParams.get('countrycode')).toBe('US');
  });
  it('does not lose matching records when a raw batch contains more than one visible page', async () => {
    const rows = Array.from({length:60},(_,i)=>({...raw,stationuuid:`k${i}`,name:`K ${i}`}));
    const d = new RadioDirectory(async url => JSON.stringify(rows.slice(Number(new URL(url).searchParams.get('offset')))));
    const one=await d.page({letter:'K'}), two=await d.page({letter:'K',offset:one.nextOffset!});
    expect(one.stations).toHaveLength(24); expect(two.stations).toHaveLength(24);
    expect(one.nextOffset).toBe(24); expect(two.nextOffset).toBe(48);
    expect(new Set([...one.stations,...two.stations].map(s=>s.id)).size).toBe(48);
  });
  it('keeps a raw cursor after a bounded empty scan, rather than falsely claiming there are no letter matches anywhere', async () => {
    let calls=0;const d=new RadioDirectory(async()=>{calls++;return JSON.stringify(Array.from({length:STATION_SCAN_BATCH},(_,i)=>({...raw,stationuuid:`n${i}`,name:'Radio K'})))});
    const page=await d.page({letter:'K'});expect(page.stations).toEqual([]);expect(page.nextOffset).toBe(STATION_SCAN_BUDGET);expect(calls).toBe(STATION_SCAN_BUDGET/STATION_SCAN_BATCH);
  });
});

describe('call-sign and frequency aliases (RADIO-ALPHA-002)', () => {
  it('keeps learned call-sign/frequency aliases reachable across index modes without leaking country filters', async () => {
    const d=new RadioDirectory(async url=>JSON.stringify(new URL(url).searchParams.get('name')==='WGCI' ? [{...raw,stationuuid:'real-wgci',name:'107.5 WGCI',countrycode:'US'}] : Array.from({length:120},(_,i)=>({...raw,stationuuid:`n${i}`,name:`Radio 1 ${i}`,countrycode:'CA'}))));
    await d.page({query:'WGCI'});
    expect((await d.page({letter:'1'})).stations.some(s=>s.id==='real-wgci')).toBe(true);
    expect((await d.page({letter:'1',country:'CA'})).stations.some(s=>s.id==='real-wgci')).toBe(false);
  });

  it('uses the call sign for letters but allows all numeric frequency prefixes in either display order', async () => {
    const { stationMatchesInitial, stationMatchesQuery } = await import('./radio');
    for (const name of ['107.5 WGCI', 'WGCI 107.5', '107.5 FM - WGCI', 'WGCI-FM 107,5']) {
      expect(stationMatchesInitial(name,'W')).toBe(true); expect(stationMatchesInitial(name,'1')).toBe(true);
      expect(stationMatchesQuery(name,'wgci')).toBe(true); expect(stationMatchesQuery(name,'107')).toBe(true);
      expect(stationMatchesQuery(name,'WGCI 107.5')).toBe(true); expect(stationMatchesQuery(name,'W G C I')).toBe(true);
      expect(stationMatchesInitial(name,'2')).toBe(false); expect(stationMatchesQuery(name,'106.5')).toBe(false);
    }
    expect(stationMatchesInitial('KEXP 90.3 (MP3 128kbps)','1')).toBe(false);
    expect(stationMatchesInitial('KEXP 90.3 (MP3 128kbps)','9')).toBe(true);
    expect(stationMatchesInitial('Énergie 98,9','E')).toBe(true);
  });
  it('searches by a call sign or number without hardcoding a station, preserving the other filters', async () => {
    const seen:URL[]=[];const d=new RadioDirectory(async url=>{seen.push(new URL(url));return JSON.stringify([{...raw,name:'107.5 WGCI'},{...raw,stationuuid:'other',name:'Radio 9107'}])});
    expect((await d.page({letter:'W',query:'wgci',country:'US',tag:'hip hop'})).stations.map(s=>s.name)).toEqual(['107.5 WGCI']);
    expect((await d.page({letter:'1',query:'107'})).stations.map(s=>s.name)).toEqual(['107.5 WGCI']);
    expect((await d.page({query:'107.5 WGCI'})).stations.map(s=>s.name)).toEqual(['107.5 WGCI']);
    expect(seen.filter(u=>!u.hostname.endsWith('iheart.com')).at(-1)!.searchParams.get('name')).toBe('WGCI');
    expect(seen[0]!.searchParams.get('countrycode')).toBe('US');expect(seen[0]!.searchParams.get('tag')).toBe('hip hop');
  });
});
