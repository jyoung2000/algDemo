// RADIO-SHUFFLE-NO-REPEAT-001 (owner, 2026-11-25): "shuffle on radio shouldnt repeat stations and shuffle should be able
// to load new stations". The pure picker never returns the station on air or one already played this round.
import { describe, expect, it } from 'vitest';
import { pickUnseenStation, RadioDirectory, type RadioStation } from './radio';

const st = (id: string): RadioStation => ({ id, name: id, url: `https://example.com/${id}` } as unknown as RadioStation);

describe('pickUnseenStation', () => {
  it('walks every other station once before running out', () => {
    const pool = ['a', 'b', 'c', 'd', 'e'].map(st);
    for (let seed = 0; seed < 25; seed++) {
      let x = seed + 1; const rnd = () => ((x = (x * 9301 + 49297) % 233280) / 233280);
      const seen = new Set<string>(['a']); let on = 'a'; const order: string[] = [];
      for (let k = 0; k < 4; k++) { const n = pickUnseenStation(pool, seen, on, rnd)!; order.push(n.id); seen.add(n.id); on = n.id; }
      expect(new Set(order)).toEqual(new Set(['b', 'c', 'd', 'e']));
      expect(pickUnseenStation(pool, seen, on, rnd)).toBeNull();
    }
  });
  it('ignores duplicate rows and the station on air', () => {
    const pool = [st('a'), st('a'), st('b')];
    expect(pickUnseenStation(pool, new Set(), 'a', () => 0.99)?.id).toBe('b');
  });
});

describe('RadioDirectory.worldPage', () => {
  it('reads a random page of the whole directory by name, with no filter', async () => {
    const urls: string[] = [];
    const dir = new RadioDirectory(async (u) => {
      urls.push(u);
      if (u.includes('/json/stats')) return JSON.stringify({ stations: 50000 });
      return JSON.stringify([{ stationuuid: 'w-1', name: 'World One', url_resolved: 'https://example.com/w1', url: 'https://example.com/w1' }]);
    });
    const page = await dir.worldPage(() => 0.5);
    const search = urls.find((u) => u.includes('/json/stations/search'))!;
    expect(search).toContain('order=name');
    expect(search).toContain('offset=24950');
    expect(search).not.toMatch(/country|tag=|language|hidebroken/);
    expect(page.map((s) => s.id)).toContain('w-1');
  });
});
