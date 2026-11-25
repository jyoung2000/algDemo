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

/** Count the surviving rows of each gather source, by the provenance the merge wrote. */
async function survival(cap = DEFAULT_ENGINE.mergedCap): Promise<{ counts: Record<string, number>; relations: Record<string, string>; total: number; asked: Asked }> {
  const asked: Asked = { apple: [], spotify: [] };
  const today = new Date().toISOString().slice(0, 10);
  const dz = {
    artistRadio: async () => full('radio'),
    artistTop: async (id: string) => full(`top-${id}`),
    relatedArtists: async (_id: string, k: number) => Array.from({ length: k }, (_, i) => ({ id: `rel${k}-${i}`, name: `Related ${k}-${i}` })),
    recentAlbums: async (id: string) => Array.from({ length: 5 }, (_, i) => ({ id: `${id}-alb${i}`, release_date: today })),
    album: async (id: string) => ({ id, tracks: [row(`recent-${id}`, 0), row(`recent-${id}`, 1), row(`recent-${id}`, 2)] }),
    toTrack: (t: Dict) => t,
    genreIds: async () => ({ 'Rap/Hip Hop': 116, Pop: 132 }),
    genreChart: async (gid: number) => full(`chart-${gid}`),
    search: async (q: string, _limit: number, _c: unknown, page = 0) => full(`search-${q}-${page}`),
  };
  const ytm = {
    related: async () => ({ songs: full('ytm-related'), artists: [{ name: 'Similar One' }] }),
    radio: async () => full('ytm-radio'),
  };
  const apple = {
    search: async (_term: string, limit: number) => {
      asked.apple.push(limit);
      return full('apple');
    },
  };
  const spotify = async (_q: string, limit: number) => {
    asked.spotify.push(limit);
    return full('spotify');
  };
  const store = await Store.open(new MemoryBackend());
  const p = new Pipeline(store, null as never, dz as never, ytm as never, null as never, apple as never, spotify as never, null);
  const seed = { key: 'ken carson|green room', title: 'Green Room', artists: ['Ken Carson'], provider: 'local', platform_id: '1' };
  const profiles = {
    [seed.key]: {
      ytm_vid: 'vid1',
      dz: { artist_ids: { deezer: '77' }, album_id: null, tags: [{ name: 'Rap/Hip Hop' }, { name: 'Pop' }] },
      dz_uncertain: [],
    },
  };
  const out = await p.gather(new Job('measure'), [seed], profiles, { ...DEFAULT_ENGINE, mergedCap: cap }, true, undefined, new Set(), {
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
  return { counts, relations, total: out.cands.length, asked };
}

/**
 * Measured per-source survival after the `mergedCap` (200) cut, with all twelve sources full at 40
 * rows each (480 rows asked, 200 kept).
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
 */
const AFTER: Record<string, number> = {
  'ytmusic-related': 18,
  'ytmusic-radio': 18,
  'apple-search': 10,
  'spotify-search': 10,
  'deezer-artist-radio': 18,
  'deezer-artist-top': 18,
  'deezer-related-artists': 18,
  'deezer-recent': 18,
  'deezer-genre-chart': 18,
  'taste-artist': 18,
  'taste-words': 18,
  'taste-wide': 18,
};

describe('the candidate cut keeps a share of every source (WP8 / A6)', () => {
  it('asks twelve sources and every one of them answers a full forty rows', async () => {
    // The cap is raised out of the way here, so what survives is what the sources gave, trimmed only
    // by the per-seed catalogue-search cap.
    const { counts, total } = await survival(100_000);
    const uncut = Object.fromEntries(Object.keys(AFTER).map((s) => [s, s.endsWith('-search') ? SEARCH_MATCH_PER_SEED : 40]));
    expect(counts).toEqual(uncut);
    expect(total).toBe(10 * 40 + 2 * SEARCH_MATCH_PER_SEED);
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
      'deezer-artist-radio', 'deezer-artist-top', 'deezer-recent', 'deezer-related-artists',
      'taste-artist', 'taste-wide', 'taste-words', 'ytmusic-radio', 'ytmusic-related',
    ]);
    for (const [source] of kinds) expect(counts[source] ?? 0, source).toBeGreaterThanOrEqual(10);
    // The catalogue search is neither: it is the source the cap is aimed at.
    expect(RELATION['search_match']?.[2]).toBe(false);
    expect(EXPLORATION_RELATIONS.has(TASTE_RELATION)).toBe(true);
  });
});
