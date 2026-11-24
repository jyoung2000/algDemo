/**
 * WP0 step 4 (plan 2026-11-24-recsys-shuffle-mood.md): shared fakes for the quality tests. The diag/ files the plan
 * refers to were never supplied (docs/plans/diag/README.md); these fakes are written from plan sections 3 and 4.
 */
import type { RecItem } from '../../api';
import type { HttpPort } from '../net';

/** A seeded generator (LCG), so every count below is the same on every run. */
export function seeded(seed = 7): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** A queue row by `artist`, playable in a plain browser (it has a preview). */
export function row(key: string, artist: string, extra: Partial<RecItem> = {}): RecItem {
  return {
    rank: 0, score: 0.5, coverage: 1, tier: 'related', evidence: 'moderate', best_seed: null, reasons: [], uncertainty: [], new_release: false,
    factors: {}, weights: {}, sources: [],
    track: { key, title: key, artist, artists: [artist], provider: 'deezer' },
    playback: { preview: `https://cdn.example/${key}.mp3`, embed: null, open: [] },
    ...extra,
  } as unknown as RecItem;
}

const dzTrack = (id: number, artistId: number) => ({
  id, title: `Song ${id}`, duration: 180, rank: 1000, link: `https://www.deezer.com/track/${id}`, preview: `https://cdn.example/p${id}.mp3`, release_date: '2024-03-01',
  artist: { id: artistId, name: `Artist ${artistId}` }, contributors: [{ id: artistId, name: `Artist ${artistId}` }],
  album: { id: 7000 + id, title: `Album ${id}`, cover_xl: '', genres: { data: [{ id: 116, name: 'Rap/Hip Hop' }] } },
});

/**
 * A fake Deezer: every artist has related artists and top songs, searches and charts answer a few songs. Ids come from
 * one counter, so each run gathers songs it has not seen before (a top-up never re-finds a queued row).
 */
export function fakeDeezer(): HttpPort {
  let next = 100;
  const reply = (body: unknown) => ({ status: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(body)) });
  return {
    async delay() {},
    async request(req) {
      const u = new URL(req.url);
      if (u.hostname !== 'api.deezer.com') throw new Error('offline');
      const p = u.pathname;
      let m = /^\/artist\/(\d+)$/.exec(p);
      if (m) return reply({ id: Number(m[1]), name: `Artist ${m[1]}`, nb_fan: 10 });
      if (/^\/artist\/\d+\/related$/.test(p)) return reply({ data: [0, 1, 2, 3, 4].map(() => { const id = next++; return { id, name: `Artist ${id}`, nb_fan: 5 }; }) });
      m = /^\/artist\/(\d+)\/top$/.exec(p);
      if (m) { const a = Number(m[1]); return reply({ data: [0, 1, 2, 3].map(() => dzTrack(next++ * 10, a)) }); }
      m = /^\/track\/(\d+)$/.exec(p);
      if (m) return reply(dzTrack(Number(m[1]), 1));
      if (p.startsWith('/album/')) return reply({ id: 1, genres: { data: [{ id: 116, name: 'Rap/Hip Hop' }] }, tracks: { data: [] } });
      if (p.startsWith('/search') || p.startsWith('/chart')) return reply({ data: [0, 1, 2, 3].map(() => dzTrack(next++ * 10, next++)) });
      return reply({ data: [] });
    },
  } as HttpPort;
}

/** Longest run of equal neighbours in `xs`. */
export function longestRun<T>(xs: readonly T[]): number {
  let best = 0;
  let run = 0;
  for (let i = 0; i < xs.length; i++) {
    run = i > 0 && xs[i] === xs[i - 1] ? run + 1 : 1;
    best = Math.max(best, run);
  }
  return best;
}
