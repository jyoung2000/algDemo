/**
 * WP8 / A6: the candidate mix. Measurement first.
 *
 * Finding A6: `gather` merges its sources in task order and then cuts the merged list at
 * `cfg.mergedCap` (200). Apple's and Spotify's catalogue searches for the seed's own "artist title"
 * are asked early, return up to 40 rows each of mostly the same song by the same artist, and do not
 * count as relatedness - yet they sit in front of Deezer's related artists, recent releases, the
 * genre charts and the listener's own colour sources, which are asked last and so are the first to
 * be cut away entirely.
 *
 * This file measures that: every source answers with 40 rows (the fakes ignore the ask limit on
 * purpose, so every source is full), and the test records how many rows of each source survive the
 * cut. The numbers are the point of the test; see SURVIVAL below for the before and after state.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_ENGINE } from './config';
import { EXPLORATION_RELATIONS, RELATION } from './engine';
import { albumKeyOf } from './album-key';
import { matchRecordings } from './identity';
import { Job, Pipeline, SEARCH_MATCH_PER_SEED } from './pipeline';
import { MemoryBackend, Store } from './store';
import { TASTE_RELATION } from './taste-gather';
import type { Dict } from './shape';

const colour = (name: string, score: number, label = name) => ({ name, label, score, plays: Math.max(1, Math.round(score)), skips: 0 });
const RAGE = colour('rage', 4, 'Rage');
const PLUGG = colour('plugg', 2, 'Plugg / pluggnb');

/** One candidate row, unique per source and index so nothing is de-duplicated by the merge. */
const row = (tag: string, i: number): Dict => ({
  id: `${tag}:${i}`,
  provider: 'deezer',
  platform_id: `${tag}-${i}`,
  key: `${tag} artist ${i}|${tag} song ${i}`,
  title: `${tag} song ${i}`,
  artists: [`${tag} artist ${i}`],
  artist: `${tag} artist ${i}`,
  album: null,
  version: null,
  versions: [],
  duration: 180,
  artwork: null,
  url: `https://example.test/${tag}/${i}`,
  isrc: null,
  release: null,
  tags: [],
  artist_ids: { deezer: `${tag}-a${i}` },
  artistIds: { deezer: '99' },
  preview: null,
  explicit: null,
  bpm: null,
  kind: 'song',
  readable: true,
});

/** A full source: 40 rows, whatever limit the caller asked for. */
const full = (tag: string): Dict[] => Array.from({ length: 40 }, (_, i) => row(tag, i));

interface Asked {
  apple: number[];
  spotify: number[];
}

interface Fixture {
  /** The merged cap; raised out of the way to see what the sources gave. */
  cap?: number;
  /** A second starting song beside Green Room (WP8 / A7: the search cap is per seed). */
  twoSeeds?: boolean;
  /** YouTube Music's radio answers with exactly the rows of its related list (duplicates across sources). */
  dupe?: boolean;
  /** What Apple's catalogue search answers, instead of forty rows of its own. */
  apple?: Dict[];
  /** Green Room's starting-song fields beyond title and artist (duration, ISRC). */
  seedExtra?: Dict;
}

/** The seed's album, so the same_album source (deezer-album) is asked too. */
const SEED_DZ = { album: 'A Great Chaos', title: 'Green Room', artists: ['Ken Carson'], album_id: '555' };

/** Count the surviving rows of each gather source, by the provenance the merge wrote. */
async function survival(fx: Fixture = {}): Promise<{ counts: Record<string, number>; relations: Record<string, string>; total: number; asked: Asked; cands: Dict[] }> {
  const cap = fx.cap ?? DEFAULT_ENGINE.mergedCap;
  const asked: Asked = { apple: [], spotify: [] };
  const today = new Date().toISOString().slice(0, 10);
  const dz = {
    artistRadio: async () => full('radio'),
    artistTop: async (id: string) => full(`top-${id}`),
    relatedArtists: async (_id: string, k: number) => Array.from({ length: k }, (_, i) => ({ id: `rel${k}-${i}`, name: `Related ${k}-${i}` })),
    recentAlbums: async (id: string) => Array.from({ length: 5 }, (_, i) => ({ id: `${id}-alb${i}`, release_date: today })),
    album: async (id: string) => (id === SEED_DZ.album_id ? { id, tracks: full('album') } : { id, tracks: [row(`recent-${id}`, 0), row(`recent-${id}`, 1), row(`recent-${id}`, 2)] }),
    toTrack: (t: Dict) => t,
    genreIds: async () => ({ 'Rap/Hip Hop': 116, Pop: 132 }),
    genreChart: async (gid: number) => full(`chart-${gid}`),
    search: async (q: string, _limit: number, _c: unknown, page = 0) => full(`search-${q}-${page}`),
  };
  const ytm = {
    related: async () => ({ songs: full('ytm-related'), artists: [{ name: 'Similar One' }] }),
    radio: async () => full(fx.dupe ? 'ytm-related' : 'ytm-radio'),
  };
  const apple = {
    search: async (term: string, limit: number) => {
      asked.apple.push(limit);
      return fx.apple ?? full(`apple ${term}`);
    },
  };
  const spotify = async (q: string, limit: number) => {
    asked.spotify.push(limit);
    return full(`spotify ${q}`);
  };
  const store = await Store.open(new MemoryBackend());
  const p = new Pipeline(store, null as never, dz as never, ytm as never, null as never, apple as never, spotify as never, null);
  const seed = { key: 'ken carson|green room', title: 'Green Room', artists: ['Ken Carson'], provider: 'local', platform_id: '1', ...(fx.seedExtra ?? {}) };
  const second = { key: 'ken carson|rock n roll', title: 'Rock N Roll', artists: ['Ken Carson'], provider: 'local', platform_id: '2' };
  const seeds: Dict[] = fx.twoSeeds ? [seed, second] : [seed];
  const profiles: Record<string, Dict> = {
    [seed.key]: {
      ytm_vid: 'vid1',
      dz: { ...SEED_DZ, artist_ids: { deezer: '77' }, tags: [{ name: 'Rap/Hip Hop' }, { name: 'Pop' }] },
      dz_uncertain: [],
    },
    [second.key]: { ytm_vid: null, dz: { artist_ids: {}, album_id: null, tags: [] }, dz_uncertain: [] },
  };
  // The seed's album is one the listener keeps playing, so its other songs are asked (same_album).
  const deepAlbums = new Set([albumKeyOf(SEED_DZ) as string]);
  const out = await p.gather(new Job('measure'), seeds, profiles, { ...DEFAULT_ENGINE, mergedCap: cap }, true, undefined, deepAlbums, {
    colours: [RAGE, PLUGG],
    cursor: 0,
  });
  const counts: Record<string, number> = {};
  const relations: Record<string, string> = {};
  for (const c of out.cands) {
    for (const prov of (c['provenance'] as Dict[]) ?? []) {
      const s = String(prov['source']);
      counts[s] = (counts[s] ?? 0) + 1;
      relations[s] = String(prov['relation']);
    }
  }
  return { counts, relations, total: out.cands.length, asked, cands: out.cands };
}

/**
 * Measured per-source survival after the `mergedCap` (200) cut, with all twelve sources full at 40
 * rows each (480 rows asked, 200 kept; thirteen and 520 with the album source, see below).
 *
 * BEFORE - the task-order cut at commit 1549324, which is finding A6:
 *   ytmusic-related 40, ytmusic-radio 40, apple-search 40, spotify-search 40, deezer-artist-radio 40,
 *   deezer-artist-top 0, deezer-related-artists 0, deezer-recent 0, deezer-genre-chart 0,
 *   taste-artist 0, taste-words 0, taste-wide 0
 *   -> the five sources that happen to be asked first take the whole cap, and every source after
 *      them - every remaining relatedness list and every one of the listener's colour sources - is
 *      cut away completely. Apple and Spotify were also each asked for 40 rows of the seed's own
 *      "artist title".
 *
 * AFTER - the round-robin cut plus the per-seed catalogue-search cap:
 *   apple-search 10, spotify-search 10 (the cap), and 18 rows each of the other ten sources.
 *   Apple and Spotify are now asked for 10 rows rather than 40.
 *
 * WP8 coverage: the fixture now also asks the seed's album (same_album, `deezer-album`, a relatedness
 * source), so thirteen sources share the cap: the 180 rows left after the two capped searches split
 * 17/17/17/17 then 16 for the other seven (round-robin, task order breaks the tie).
 */
const AFTER: Record<string, number> = {
  'ytmusic-related': 17,
  'ytmusic-radio': 17,
  'apple-search': 10,
  'spotify-search': 10,
  'deezer-album': 17,
  'deezer-artist-radio': 17,
  'deezer-artist-top': 16,
  'deezer-related-artists': 16,
  'deezer-recent': 16,
  'deezer-genre-chart': 16,
  'taste-artist': 16,
  'taste-words': 16,
  'taste-wide': 16,
};

describe('the candidate cut keeps a share of every source (WP8 / A6)', () => {
  it('asks thirteen sources and every one of them answers a full forty rows', async () => {
    // The cap is raised out of the way here, so what survives is what the sources gave, trimmed only
    // by the per-seed catalogue-search cap.
    const { counts, total } = await survival({ cap: 100_000 });
    const uncut = Object.fromEntries(Object.keys(AFTER).map((s) => [s, s.endsWith('-search') ? SEARCH_MATCH_PER_SEED : 40]));
    expect(counts).toEqual(uncut);
    expect(total).toBe(11 * 40 + 2 * SEARCH_MATCH_PER_SEED);
  });

  it('records how many rows of each source survive the mergedCap cut', async () => {
    const { counts, total, asked } = await survival();
    expect(counts).toEqual(AFTER);
    expect(total).toBe(DEFAULT_ENGINE.mergedCap);
    // A7: the keyless catalogue search is asked for what it may keep, not for a full page.
    expect(asked).toEqual({ apple: [SEARCH_MATCH_PER_SEED], spotify: [SEARCH_MATCH_PER_SEED] });
  });

  it('leaves every relatedness source and every taste source at least ten rows', async () => {
    const { counts, relations } = await survival();
    const kinds = Object.entries(relations).filter(([, r]) => RELATION[r]?.[2] === true || r === TASTE_RELATION);
    // The relatedness lists and the colour sources, named so a future change cannot quietly drop one.
    expect(kinds.map(([s]) => s).sort()).toEqual([
      'deezer-album', 'deezer-artist-radio', 'deezer-artist-top', 'deezer-recent', 'deezer-related-artists',
      'taste-artist', 'taste-wide', 'taste-words', 'ytmusic-radio', 'ytmusic-related',
    ]);
    for (const [source] of kinds) expect(counts[source] ?? 0, source).toBeGreaterThanOrEqual(10);
    // The catalogue search is neither: it is the source the cap is aimed at.
    expect(RELATION['search_match']?.[2]).toBe(false);
    expect(EXPLORATION_RELATIONS.has(TASTE_RELATION)).toBe(true);
  });
});

/** One song for the same-recording test, by Ken Carson unless told otherwise. */
const song = (id: string, title: string, extra: Dict = {}): Dict => ({ ...row(`kc-${id}`, 0), key: `ken carson|${id}`, title, artists: ['Ken Carson'], artist: 'Ken Carson', ...extra });

describe('the candidate mix leaves out the seed itself (WP8 / A7)', () => {
  const SEED_ISRC = 'USUM72300001';
  // The seed's own recording, three ways round: the same ISRC under a remaster title, the same title and
  // length from another catalogue with no ISRC, and a "2023 Remaster" edition of the same length.
  const sameRecording = [
    song('remastered', 'Green Room (Remastered)', { isrc: SEED_ISRC, duration: 181 }),
    song('copy', 'Green Room', { duration: 179 }),
    song('edition', 'Green Room - 2023 Remaster', { duration: 180 }),
  ];
  // Songs that are not the seed: a different song by the same artist, and a live cut of the same song.
  const other = [song('jennifer', "Jennifer's Body", { duration: 180 }), song('live', 'Green Room (Live)', { duration: 180 })];
  const fillers = Array.from({ length: 10 }, (_, i) => song(`filler${i}`, `Filler ${i}`, { duration: 150 + i }));
  const seedExtra = { duration: 180, isrc: SEED_ISRC };

  it('the fixture is what it says: matchRecordings calls the first three the seed and the rest not', () => {
    const seed = { title: 'Green Room', artists: ['Ken Carson'], ...seedExtra };
    for (const t of sameRecording) expect(matchRecordings(seed, t as never).verdict, String(t['title'])).toBe('same');
    for (const t of [...other, ...fillers]) expect(matchRecordings(seed, t as never).verdict, String(t['title'])).not.toBe('same');
  });

  it('drops rows matchRecordings calls the same recording as the seed, and they take no search slot', async () => {
    const { cands } = await survival({ cap: 100_000, seedExtra, apple: [...sameRecording, ...other, ...fillers] });
    const titles = (src: string) => cands.filter((c) => ((c['provenance'] as Dict[]) ?? []).some((pv) => pv['source'] === src)).map((c) => String(c['title']));
    const apple = titles('apple-search');
    for (const t of sameRecording) expect(apple, String(t['title'])).not.toContain(t['title']);
    // The different song by the same artist survives, and so does the live cut (another recording).
    expect(apple).toContain("Jennifer's Body");
    expect(apple).toContain('Green Room (Live)');
    // The dropped rows did not count against the per-seed search cap: ten of the twelve others are kept.
    expect(apple).toHaveLength(SEARCH_MATCH_PER_SEED);
  });
});

describe('the catalogue-search cap and the merged cap, more closely (WP8 / A6, A7)', () => {
  it('caps the catalogue search at ten PER SEED: two seeds keep up to twenty, not ten in all', async () => {
    const { counts, asked } = await survival({ cap: 100_000, twoSeeds: true });
    expect(counts['apple-search']).toBe(2 * SEARCH_MATCH_PER_SEED);
    expect(counts['spotify-search']).toBe(2 * SEARCH_MATCH_PER_SEED);
    expect(asked).toEqual({ apple: [SEARCH_MATCH_PER_SEED, SEARCH_MATCH_PER_SEED], spotify: [SEARCH_MATCH_PER_SEED, SEARCH_MATCH_PER_SEED] });
  });

  it('rows one source repeats from another take no mergedCap slot away from the other sources', async () => {
    const plain = await survival();
    const duped = await survival({ dupe: true });
    // YouTube Music's radio now answers only songs its related list already holds: they merge into
    // those songs and cost nothing, so the cap is still filled with distinct songs ...
    expect(duped.total).toBe(DEFAULT_ENGINE.mergedCap);
    expect(duped.cands.some((c) => String(c['id']).startsWith('ytm-radio:'))).toBe(false);
    // ... and the radio's freed share goes to the other sources, none of which loses a row.
    for (const [source, n] of Object.entries(plain.counts)) {
      if (source === 'ytmusic-radio' || source === 'ytmusic-related') continue;
      expect(duped.counts[source] ?? 0, source).toBeGreaterThanOrEqual(n);
    }
  });
});
