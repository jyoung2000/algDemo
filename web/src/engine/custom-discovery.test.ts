// NEXT-FAV-CUSTOM-001 (owner, 2026-11-19): Find my next favorite with chosen genres and subgenres, artists (their own
// songs, features, frequent collaborators, similar artists), a song count up to 100, Familiar/Adventurous, and
// Older/Newer, keeping the listener's taste in mind.
import { describe, expect, it } from 'vitest';
import {
  customOutcome, notTheRealSong, CUSTOM_MAX_SONGS, eraFit, genreAsks, matchesGenres, normaliseCriteria, pickCustom, runCustomDiscovery,
  type CustomCandidate, type CustomPorts,
} from './custom-discovery';

const tag = (name: string) => ({ name, label: name, source: 'test', scope: 'album', confidence: 0.9, inferred: false });
const tr = (title: string, artist: string, o: { tags?: string[]; year?: number; key?: string; artists?: string[] } = {}) => ({
  id: o.key ?? `dz:${title}`, key: o.key ?? `dz:${title}`, provider: 'deezer', platform_id: title, title,
  artists: o.artists ?? [artist], artist,
  tags: (o.tags ?? []).map(tag), ...(o.year ? { release: { date: `${o.year}-01-01`, precision: 'day', kind: 'release', source: 't' } } : {}),
});

describe('criteria', () => {
  it('clamps everything and keeps at most 100 songs, one entry per genre and per artist', () => {
    const c = normaliseCriteria({ genres: ['sub:trap', 'sub:trap', 'nonsense', 'family:rock'], artists: [{ name: 'Ken Carson', own: true }, { name: 'ken carson' }, { name: '' }], count: 500, adventurous: 3, era: -9 });
    expect(c.genres).toEqual(['sub:trap', 'family:rock']);
    expect(c.artists.map((a) => a.name)).toEqual(['Ken Carson']);
    expect(c.artists[0]).toMatchObject({ own: true, features: true, collaborators: false, similar: false });
    expect(c.count).toBe(CUSTOM_MAX_SONGS);
    expect(c.adventurous).toBe(1);
    expect(c.era).toBe(-1);
  });
  it('an artist with every source switched off keeps their own songs', () => {
    const c = normaliseCriteria({ artists: [{ name: 'A', own: false, features: false, collaborators: false, similar: false }] });
    expect(c.artists[0]!.own).toBe(true);
  });
});

describe('genres', () => {
  it('a subgenre asks for its reference artists and its own name; a family asks across its subgenres', () => {
    const sub = genreAsks(['sub:trap']);
    expect(sub.some((a) => a.kind === 'artist')).toBe(true);
    expect(sub.some((a) => a.kind === 'words' && /trap/i.test(a.term))).toBe(true);
    expect(sub.every((a) => a.genre === 'sub:trap')).toBe(true);
    const fam = genreAsks(['family:hip-hop']);
    expect(new Set(fam.map((a) => a.term)).size).toBe(fam.length);
    expect(fam.length).toBeGreaterThan(3);
  });
  it('a song matches a family through any of its genres, and a subgenre exactly; songs with no genre prove nothing', () => {
    expect(matchesGenres(tr('a', 'x', { tags: ['trap'] }), ['family:hip-hop'])).toBe('tag');
    expect(matchesGenres(tr('a', 'x', { tags: ['trap'] }), ['sub:trap'])).toBe('tag');
    expect(matchesGenres(tr('a', 'x', { tags: ['country'] }), ['sub:trap'])).toBe(null);
    expect(matchesGenres(tr('a', 'x'), ['sub:trap'])).toBe(null);
    // found by asking for that genre (its reference artist) and nothing says otherwise: it counts
    expect(matchesGenres(tr('a', 'x'), ['sub:trap'], 'sub:trap')).toBe('asked');
    expect(matchesGenres(tr('a', 'x', { tags: ['rap'] }), ['sub:trap'], 'sub:trap')).toBe('asked');
    expect(matchesGenres(tr('a', 'x', { tags: ['country'] }), ['sub:trap'], 'sub:trap')).toBe(null);
    expect(matchesGenres(tr('a', 'x', { tags: ['country'] }), [])).toBe('any');
  });
});

describe('older or newer', () => {
  it('newer prefers recent releases, older prefers old ones, any era and unknown dates are neutral', () => {
    expect(eraFit(2025, 1, 2026)).toBeGreaterThan(0.9);
    expect(eraFit(1975, 1, 2026)).toBeLessThan(0.3);
    expect(eraFit(1975, -1, 2026)).toBeGreaterThan(0.7);
    expect(eraFit(2025, 0, 2026)).toBe(0.5);
    expect(eraFit(null, 1, 2026)).toBe(0.5);
  });
});

describe('picking', () => {
  const cand = (t: ReturnType<typeof tr>, source: CustomCandidate['source'] = 'own', genre?: string): CustomCandidate => ({ track: t, source, from: t.artist, genre });
  it('never repeats a song, skips what is already queued, and spreads across artists', () => {
    const pool = [
      cand(tr('One', 'A')), cand(tr('One (Remix)', 'A', { key: 'yt:1' })), cand(tr('Two', 'A')), cand(tr('Three', 'A')),
      cand(tr('Four', 'B')), cand(tr('Five', 'B')), cand(tr('Queued', 'C')),
    ];
    const got = pickCustom(pool, normaliseCriteria({ count: 4 }), { exclude: new Set(['dz:Queued']), known: new Set(), taste: null, year: 2026 });
    const titles = got.map((g) => g.track.title);
    expect(titles).toHaveLength(4);
    expect(titles).not.toContain('Queued');
    expect(titles.filter((t) => t.startsWith('One'))).toHaveLength(1);
    expect(titles.filter((t) => ['Four', 'Five'].includes(t)).length).toBeGreaterThanOrEqual(1);
  });
  it('familiar favours artists the listener knows; adventurous favours new names', () => {
    const pool = [cand(tr('Known song', 'Known')), cand(tr('New song', 'Stranger'))];
    const known = new Set(['known']);
    const fam = pickCustom(pool, normaliseCriteria({ count: 1, adventurous: 0 }), { exclude: new Set(), known, taste: null, year: 2026 });
    const adv = pickCustom(pool, normaliseCriteria({ count: 1, adventurous: 1 }), { exclude: new Set(), known, taste: null, year: 2026 });
    expect(fam[0]!.track.title).toBe('Known song');
    expect(adv[0]!.track.title).toBe('New song');
  });
  it('newer music first when asked', () => {
    const pool = [cand(tr('Old', 'A', { year: 1980 })), cand(tr('New', 'B', { year: 2025 }))];
    expect(pickCustom(pool, normaliseCriteria({ count: 1, era: 1 }), { exclude: new Set(), known: new Set(), taste: null, year: 2026 })[0]!.track.title).toBe('New');
    expect(pickCustom(pool, normaliseCriteria({ count: 1, era: -1 }), { exclude: new Set(), known: new Set(), taste: null, year: 2026 })[0]!.track.title).toBe('Old');
  });
  it('with genres chosen, a song outside them is never added, whatever its source', () => {
    const pool = [cand(tr('Country', 'A', { tags: ['country'] })), cand(tr('Trap', 'A', { tags: ['trap'] }))];
    const got = pickCustom(pool, normaliseCriteria({ count: 5, genres: ['family:hip-hop'] }), { exclude: new Set(), known: new Set(), taste: null, year: 2026 });
    expect(got.map((g) => g.track.title)).toEqual(['Trap']);
  });
});

describe('a whole run', () => {
  const ports = (log: string[]): CustomPorts => ({
    openArtist: async (t) => {
      log.push(`open ${t.name}`);
      return {
        name: 'Ken Carson',
        songs: [tr('Own 1', 'Ken Carson', { tags: ['trap'] }), tr('Own 2', 'Ken Carson', { tags: ['trap'], artists: ['Ken Carson', 'Destroy Lonely'] }), tr('Own 3', 'Ken Carson', { tags: ['trap'], artists: ['Ken Carson', 'Destroy Lonely'] })],
        features: [tr('Feat 1', 'Someone', { tags: ['trap'], artists: ['Someone', 'Ken Carson'] })],
        similar: [{ id: 'dz:9', provider: 'deezer', name: 'Yeat', picture: null, detail: null, url: '', from: ['deezer'] }],
      };
    },
    artistTop: async (name) => { log.push(`top ${name}`); return [tr(`${name} hit`, name, { tags: ['trap'] }), tr(`${name} deep cut`, name, { tags: ['trap'] })]; },
    search: async (term) => { log.push(`search ${term}`); return [tr(`${term} result`, `${term} artist`, { tags: ['trap'] })]; },
    enrichGenres: async () => { log.push('enrich'); },
  });
  it('reads only the sources asked for, then picks from them', async () => {
    const log: string[] = [];
    const res = await runCustomDiscovery(normaliseCriteria({ artists: [{ name: 'Ken Carson', own: true, features: false, collaborators: true, similar: true }], count: 10 }), ports(log), { exclude: new Set(), known: new Set(), taste: null, year: 2026 });
    expect(log).toContain('open Ken Carson');
    expect(log).toContain('top Destroy Lonely');
    expect(log).toContain('top Yeat');
    expect(log.some((l) => l.startsWith('search'))).toBe(false);
    const titles = res.picked.map((p) => p.track.title);
    expect(titles).not.toContain('Feat 1');
    expect(titles).toEqual(expect.arrayContaining(['Own 1', 'Destroy Lonely hit', 'Yeat hit']));
    expect(res.picked.find((p) => p.track.title === 'Destroy Lonely hit')!.reason).toMatch(/collaborat.*Ken Carson/i);
    expect(res.picked.find((p) => p.track.title === 'Yeat hit')!.reason).toMatch(/similar to Ken Carson/i);
  });
  it('genres alone search every platform for them', async () => {
    const log: string[] = [];
    const res = await runCustomDiscovery(normaliseCriteria({ genres: ['sub:trap'], count: 3 }), ports(log), { exclude: new Set(), known: new Set(), taste: null, year: 2026 });
    expect(log.filter((l) => l.startsWith('search')).length).toBeGreaterThan(0);
    expect(res.picked.length).toBeGreaterThan(0);
    expect(res.picked[0]!.reason).toMatch(/Trap/);
  });
});

describe('what the listener is told', () => {
  it('never says "no matching songs" when the services could not be searched', () => {
    expect(customOutcome(0, 10, { a: { state: 'budget' }, b: { state: 'budget' } }, [])).toBe("The daily transfer allowance is used up, so no service could be searched. Raise it in Settings (Daily allowance) or try again tomorrow.");
    expect(customOutcome(0, 10, { a: { state: 'failed' } }, [])).toBe('No service answered. Check the connection and try again.');
    expect(customOutcome(0, 10, { a: { state: 'ok' } }, [])).toBe('No matching songs found. Try fewer genre restrictions or more artist sources.');
  });
  it('a short result says how many, and which part could not be read', () => {
    expect(customOutcome(10, 10, { a: { state: 'ok' } }, [])).toBe('');
    expect(customOutcome(4, 10, { a: { state: 'ok' } }, [])).toBe('Only 4 matching songs were available.');
    expect(customOutcome(4, 10, { a: { state: 'ok' }, b: { state: 'budget' } }, [])).toBe('Only 4 matching songs were available. Some services were skipped: the daily transfer allowance is used up.');
    expect(customOutcome(1, 10, { a: { state: 'ok' } }, ['Yeat'])).toBe('Only 1 matching song was available. Could not read: Yeat.');
  });
});

describe('only real songs (seen on Windows: "Travis Scott Dark Trap Type Beat", bootleg remixes)', () => {
  it('type beats, remixes, sped-up and other alternate versions are not the songs to discover', () => {
    for (const t of ['Travis Scott Dark Trap Type Beat - Brickmaster', 'Essa Mi Boujee (Migos - Bad and Boujee Remix)', 'Pamela (Screwed) (feat. Migos)', 'Song (Sped Up)', 'Song (Instrumental)', 'Free Trap Beat 2024', 'Song (Slowed + Reverb)']) expect(notTheRealSong(t), t).toBe(true);
    for (const t of ['WAIT FOR U (feat. Drake & Tems)', 'Mask Off', 'Ya Hit (feat. Drake, Travis Scott & Loe Shimmy)', 'Trap Queen']) expect(notTheRealSong(t), t).toBe(false);
  });
  it("a reference artist's search keeps only songs by that artist; word searches only ask the catalogue services", async () => {
    const asked: string[] = [];
    const ports: CustomPorts = {
      openArtist: async () => { throw new Error('unused'); },
      artistTop: async () => [],
      search: async (term, kind) => { asked.push(kind); return kind === 'artist'
        ? [tr(`${term} real`, term, { tags: ['trap'] }), tr('Random upload', 'someone', { tags: ['trap'] }), tr(`${term} Type Beat`, 'producer', { tags: ['trap'] })]
        : [tr('Word hit', 'Catalog Artist', { tags: ['trap'] }), tr('Trap', 'Film Composer'), tr('Untagged word hit', 'Someone Else')]; },
      enrichGenres: async () => {},
    };
    const res = await runCustomDiscovery(normaliseCriteria({ genres: ['sub:trap'], count: 20 }), ports, { exclude: new Set(), known: new Set(), taste: null, year: 2026 });
    const titles = res.picked.map((p) => p.track.title);
    expect(titles).not.toContain('Random upload');
    expect(titles.some((t) => /Type Beat/.test(t))).toBe(false);
    expect(titles.some((t) => / real$/.test(t))).toBe(true);
    expect(titles).toContain('Word hit');
    // A word search is weak evidence: only a real genre tag counts, and a song merely named "Trap" proves nothing.
    expect(titles).not.toContain('Trap');
    expect(titles).not.toContain('Untagged word hit');
  });
});

describe('genres reach past their reference artists', () => {
  it("asks for each reference artist's related artists too, so Adventurous has new names to choose", async () => {
    const ports: CustomPorts = {
      openArtist: async () => { throw new Error('unused'); },
      artistTop: async (name) => [tr(`${name} song`, name, { tags: ['trap'] })],
      related: async (name) => [{ name: `${name} protege` }],
      search: async (term, kind) => (kind === 'artist' ? [tr(`${term} hit`, term, { tags: ['trap'] })] : []),
      enrichGenres: async () => {},
    };
    const res = await runCustomDiscovery(normaliseCriteria({ genres: ['sub:trap'], count: 10, adventurous: 1 }), ports, { exclude: new Set(), known: new Set(), taste: null, year: 2026 });
    expect(res.picked.some((p) => /protege song/.test(p.track.title))).toBe(true);
  });
});
