/**
 * NEXT-FAV-COLD-001 (owner, 2026-11-23): Find my next favorite with no starting song and an empty queue reads the
 * listener's stars, their listening and their taste map.
 */
import { describe, expect, it } from 'vitest';
import { coldReason, coldStarters, listeningArtists, tasteArtists } from './cold-start';
import { colourArtists } from './taste-gather';

const DAY = 86400;
const now = 1_800_000_000;
const row = (kind: string, artist: string, daysAgo = 1) => ({ kind, ts: now - daysAgo * DAY, track: { artists: [artist] } });

describe('what a run with no starting song begins from', () => {
  it('reads the artists the listening algorithm learned, strongest judgement first', () => {
    const rows = [
      row('like', 'OsamaSon'), row('save', 'OsamaSon'),
      row('complete', 'Summrs'), row('complete', 'Summrs'), row('complete', 'Summrs'),
      row('qualified', 'Ken Carson'),
      { kind: 'dislike', ts: now, track: { artists: ['Nobody'] } },
      { kind: 'skip', ts: now, track: { artists: ['Nobody'] } },
    ];
    expect(listeningArtists(rows, now)).toEqual(['OsamaSon', 'Summrs', 'Ken Carson']);
  });

  it('prefers what was liked lately over what was liked a year ago', () => {
    const old = [row('like', 'Last year', 365), row('like', 'Last year', 360), row('like', 'Last year', 355)];
    expect(listeningArtists([...old, row('like', 'This week', 3)], now)[0]).toBe('This week');
  });

  it('a dislike-only history starts nothing: there is nothing it says the listener likes', () => {
    expect(listeningArtists([{ kind: 'dislike', ts: now, track: { artists: ['Nope'] } }], now)).toEqual([]);
  });

  it('falls back to the taste map: the strongest colours name real reference artists', () => {
    const colours = [{ name: 'rage', label: 'Rage', score: 0.9 }, { name: 'soul', label: 'Soul', score: 0.4 }];
    const picked = tasteArtists(colours, 4);
    expect(picked.length).toBeGreaterThan(0);
    expect(new Set(picked).size).toBe(picked.length);
    const known = new Set([...colourArtists('rage'), ...colourArtists('soul')]);
    for (const name of picked) expect(known.has(name)).toBe(true);
    // The strongest colour leads.
    if (colourArtists('rage').length) expect(colourArtists('rage')).toContain(picked[0]);
  });

  it('puts the listener\u2019s own stars first, then listening, then the taste map, never repeating a name', () => {
    const colours = [{ name: 'rage', label: 'Rage', score: 0.9 }];
    const starters = coldStarters({ starred: ['OsamaSon'], rows: [row('like', 'Summrs'), row('like', 'OsamaSon')], colours, now }, 4);
    expect(starters[0]).toEqual({ name: 'OsamaSon', from: 'starred' });
    expect(starters[1]).toEqual({ name: 'Summrs', from: 'listening' });
    expect(starters.filter((s) => s.from === 'taste').length).toBeGreaterThan(0);
    expect(new Set(starters.map((s) => s.name.toLowerCase())).size).toBe(starters.length);
    expect(starters.length).toBeLessThanOrEqual(4);
  });

  it('has nothing to start from on a fresh install', () => {
    expect(coldStarters({ starred: [], rows: [], colours: [], now })).toEqual([]);
    expect(coldReason([])).toBe('');
  });

  it('says where the songs came from', () => {
    expect(coldReason([{ name: 'OsamaSon', from: 'starred' }])).toBe('Started from your starred artists: OsamaSon.');
    expect(coldReason([{ name: 'Summrs', from: 'listening' }, { name: 'Nettspend', from: 'taste' }]))
      .toBe('Started from your listening and your sound: Summrs and Nettspend.');
  });
});
