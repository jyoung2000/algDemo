// RADIO-AZ-ALL-001 (owner, 2026-11-24): "radio list does not load all the stations, the radio list needs to load all
// stations across the world from A-Z". Every initial (A-Z, # and 0-9) must reach every station the directory holds.
import { describe, expect, it } from 'vitest';
import { RadioDirectory, STATION_LETTERS, STATION_NUMBERS, compareStations, normalizeStation, stationInitial, stationMatchesInitial, type RadioStation } from './radio';

const fold = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toUpperCase();
type Raw = { stationuuid: string; name: string; url_resolved: string; countrycode: string };
const row = (id: string, name: string, url = `https://streams.example/${id}`): Raw => ({ stationuuid: id, name, url_resolved: url, countrycode: 'XX' });

/** Radio Browser as measured: name= is an accent/case-insensitive SUBSTRING match, order=name, offset/limit paging. */
function fakeDirectory(rows: Raw[], opts: { failAt?: number; failures?: number } = {}) {
  const sorted = [...rows].sort((a, b) => fold(a.name.trim()) < fold(b.name.trim()) ? -1 : fold(a.name.trim()) > fold(b.name.trim()) ? 1 : 0);
  const stats = { calls: 0, raw: 0 }; let failures = opts.failures ?? 0;
  const request = async (url: string) => {
    const q = new URL(url).searchParams, offset = Number(q.get('offset') || 0), limit = Number(q.get('limit') || 100000), name = q.get('name');
    stats.calls++;
    if (offset === opts.failAt && failures > 0) { failures--; throw new Error('mirror down'); }
    const hits = name ? sorted.filter(r => fold(r.name).includes(fold(name))) : sorted;
    const page = hits.slice(offset, offset + limit); stats.raw += page.length;
    return JSON.stringify(page);
  };
  return { request, stats };
}

/** Deterministic world: Latin names (accents, lower case, call signs), digit-only names, then non-Latin names last. */
function world(): Raw[] {
  const out: Raw[] = [], words = ['Alpha', 'Bravo', 'Écho', 'delta', 'Øresund', 'zeta', 'Kilo', 'Radio', 'Ümit', 'yankee', 'Quebec', 'Xray'];
  for (let i = 0; i < 4200; i++) out.push(row(`l${i}`, `${words[i % words.length]} ${String.fromCharCode(65 + (i * 7) % 26)}${i}`));
  for (let i = 0; i < 26; i++) out.push(row(`c${i}`, `10${i}.5 W${String.fromCharCode(65 + i)}CI`));
  for (let i = 0; i < 150; i++) out.push(row(`d${i}`, `${100 + i}.${i % 10}`));
  for (let i = 0; i < 120; i++) out.push(row(`n${i}`, [`Радио ${i}`, `평양 ${i}`, `日本ラジオ ${i}`, `📻 ${i}`][i % 4]!));
  for (let i = 0; i < 30; i++) out.push(row(`l${i * 13}`, out.find(r => r.stationuuid === `l${i * 13}`)!.name)); // duplicate rows
  for (let i = 0; i < 12; i++) out.push(row(`bad${i}`, `Broken ${i}`, 'file:///nope'));
  return out;
}
const expected = (rows: Raw[], initial: string) => new Set(rows.map(r => normalizeStation(r)).filter((s): s is RadioStation => !!s && stationMatchesInitial(s.name, initial)).map(s => s.id));

async function walk(rows: Raw[], letter: string) {
  const fake = fakeDirectory(rows), d = new RadioDirectory(fake.request), ids: string[] = [], pages: { shown: number; raw: number; next: number | null }[] = [];
  let offset: number | null = 0;
  while (offset !== null && pages.length < 200) {
    const before = fake.stats.raw, page = await d.page({ letter, offset });
    ids.push(...page.stations.map(s => s.id)); pages.push({ shown: page.stations.length, raw: fake.stats.raw - before, next: page.nextOffset });
    if (page.nextOffset !== null) expect(page.nextOffset).toBeGreaterThan(offset);
    offset = page.nextOffset;
  }
  return { ids, pages };
}

describe('A-Z browse reaches every station in the directory (RADIO-AZ-ALL-001)', () => {
  it('offers # for other scripts and symbols beside A-Z, and 0-9 separately', () => {
    expect(STATION_LETTERS).toContain('#'); expect(STATION_LETTERS.slice(1, 27).join('')).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    expect(STATION_NUMBERS.join('')).toBe('0123456789');
    expect(stationInitial('평양 1')).toBe('#'); expect(stationInitial('Øresund')).toBe('#'); expect(stationInitial('Écho')).toBe('E');
  });
  it('pages every initial to the end with no station skipped or repeated, across thousands of raw rows', async () => {
    const rows = world();
    for (const letter of [...STATION_LETTERS.filter(Boolean), ...STATION_NUMBERS.filter(Boolean)]) {
      const { ids, pages } = await walk(rows, letter);
      const twice = new Set(rows.map(r => r.stationuuid).filter((id, i, a) => a.indexOf(id) !== i));
      for (const id of ids.filter((id, i, a) => a.indexOf(id) !== i)) expect(twice, `${letter} repeats ${id}`).toContain(id);
      expect(new Set(ids), `${letter} complete`).toEqual(expected(rows, letter));
      // A page may come back short only when it is the last one, or when it has spent its whole raw-row budget.
      for (const p of pages.slice(0, -1)) if (p.shown < 24) expect(p.raw, `${letter} gave up early`).toBeGreaterThanOrEqual(4000);
    }
  }, 60_000);
  it('reaches the non-Latin stations at the far end of the directory in a few requests, not hundreds of clicks', async () => {
    const rows = [...Array.from({ length: 5000 }, (_, i) => row(`l${i}`, `Latin ${i}`)), ...Array.from({ length: 20 }, (_, i) => row(`n${i}`, `평양 ${i}`))];
    const { ids, pages } = await walk(rows, '#');
    expect(new Set(ids)).toEqual(expected(rows, '#')); expect(pages.length).toBeLessThanOrEqual(3);
  });
  it('keeps the stations already found and resumes at the failed batch when a later batch fails', async () => {
    const filler = Array.from({ length: 2498 }, (_, i) => row(`r${i}`, `Radio k ${String(i).padStart(4, '0')}`));
    const ordered = [...filler.slice(0, 100), row('k1', 'Kilo 1'), ...filler.slice(100, 1699), row('k2', 'Kilo 2'), ...filler.slice(1699)];
    const fake = { failures: 3, request: async (url: string) => {
      const q = new URL(url).searchParams, offset = Number(q.get('offset')), limit = Number(q.get('limit'));
      if (offset === 1000 && fake.failures > 0) { fake.failures--; throw new Error('mirror down'); }
      return JSON.stringify(ordered.slice(offset, offset + limit));
    } };
    const d = new RadioDirectory(fake.request);
    const one = await d.page({ letter: 'K' });
    expect(one.stations.map(s => s.id)).toEqual(['k1']); expect(one.nextOffset).toBe(1000);
    const two = await d.page({ letter: 'K', offset: one.nextOffset! });
    expect(two.stations.map(s => s.id)).toEqual(['k2']); expect(two.nextOffset).toBeNull();
  });
  it('sorts names case- and accent-insensitively with the station id as the tiebreak', () => {
    const s = (id: string, name: string) => normalizeStation(row(id, name))!;
    const list = [s('5', 'zeta'), s('4', 'Énergie'), s('3', 'echo'), s('1', 'Echo'), s('2', 'ECHO'), s('6', 'Energie')];
    expect(list.sort(compareStations).map(x => x.id)).toEqual(['1', '2', '3', '4', '6', '5']);
  });
});
