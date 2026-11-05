import { describe, expect, it } from 'vitest';
import { findFullSong, searchVariants, type ChainSources } from './full-song-chain';
import type { Track } from '../api';

/**
 * SOURCE-CHAIN-001 — a song must not be undownloadable just because YouTube Music's first search
 * missed it.
 *
 * Owner: "fix any error that stops sources from downloading 97 out of 97 songs locally ... Ensure
 * sources can download needed data and actively trys different or retries sources. The downloader &
 * sources needs to download 100% of songs".
 *
 * Before this, `fullSong` asked `ytm.findMatch` once and, on no confident match, wrote
 * `{id: null, source: 'none'}` for six hours — with SoundCloud, Apple and Spotify clients sitting
 * unused on the same object. `matchRecordings` rejects a candidate whose duration differs by more
 * than 8s, so one long YouTube upload was enough to make a song permanently unavailable.
 */

const track = (o: Partial<Track> = {}): Track => ({
  key: 'k', provider: 'deezer', platform_id: '1', title: 'Wallpaper', artists: ['Kevin MacLeod'],
  duration: 180, url: undefined, ...o,
} as Track);

const cand = (o: Partial<Track> = {}): Track => ({
  key: 'c', provider: 'ytmusic', platform_id: 'abcdefghijk', title: 'Wallpaper', artists: ['Kevin MacLeod'],
  duration: 180, ...o,
} as Track);

/** A source set whose YTM leg answers per-query, so widening is observable. */
function sources(o: {
  ytm?: Record<string, Track[]>;
  sc?: Record<string, Track[]>;
  scPresent?: boolean;
}): { s: ChainSources; asked: { ytm: string[]; sc: string[] } } {
  const asked = { ytm: [] as string[], sc: [] as string[] };
  const s: ChainSources = {
    ytm: {
      search: async (q: string) => { asked.ytm.push(q); return o.ytm?.[q] ?? []; },
    },
    sc: o.scPresent === false ? null : {
      search: async (q: string) => { asked.sc.push(q); return o.sc?.[q] ?? []; },
    },
  };
  return { s, asked };
}

describe('search variants', () => {
  it('asks the plain artist-and-title question first, then widens', () => {
    const v = searchVariants(track({ title: 'Wallpaper (feat. Someone)', artists: ['Kevin MacLeod', 'Someone'] }));
    expect(v[0]).toBe('Kevin MacLeod Wallpaper (feat. Someone)');
    expect(v).toContain('Kevin MacLeod Wallpaper'); // the feature credit dropped
    expect(v).toContain('Wallpaper (feat. Someone)'); // title alone, for a mis-credited upload
    expect(new Set(v).size).toBe(v.length); // never asks the same question twice
  });

  it('still produces a question for a song with no artist', () => {
    expect(searchVariants(track({ artists: [] }))[0]).toBe('Wallpaper');
    expect(searchVariants(track({ artists: [] })).length).toBeGreaterThan(0);
  });
});

describe('the source chain', () => {
  it('uses an exact YouTube Music match and does not touch another source', async () => {
    const { s, asked } = sources({ ytm: { 'Kevin MacLeod Wallpaper': [cand()] } });
    const r = await findFullSong(track(), s, {});
    expect(r).toMatchObject({ id: 'abcdefghijk', source: 'match' });
    expect(asked.ytm).toEqual(['Kevin MacLeod Wallpaper']); // stopped at the first answer
    expect(asked.sc).toEqual([]); // no need to go further
  });

  it('finds the song on a widened query when the first question missed it', async () => {
    // The real case: the title carries a feature credit the upload does not.
    const t = track({ title: 'Wallpaper (feat. Someone)' });
    const { s, asked } = sources({
      ytm: { 'Kevin MacLeod Wallpaper': [cand({ title: 'Wallpaper (feat. Someone)' })] },
    });
    const r = await findFullSong(t, s, {});
    expect(r).toMatchObject({ id: 'abcdefghijk', source: 'match' });
    expect(asked.ytm.length).toBeGreaterThan(1); // it kept asking
    expect(asked.sc).toEqual([]);
  });

  it('falls back to SoundCloud, which both shells can download, when YouTube Music has nothing', async () => {
    const { s, asked } = sources({
      ytm: {},
      sc: { 'Kevin MacLeod Wallpaper': [cand({ provider: 'soundcloud', platform_id: '99', url: 'https://soundcloud.com/kmacleod/wallpaper' })] },
    });
    const r = await findFullSong(track(), s, {});
    expect(r.source).toBe('soundcloud');
    expect(r.url).toBe('https://soundcloud.com/kmacleod/wallpaper');
    expect(asked.ytm.length).toBeGreaterThan(1); // exhausted YouTube Music first
    expect(asked.sc.length).toBeGreaterThan(0);
  });

  it('accepts the closest near miss rather than leaving the song unavailable, and says so', async () => {
    // Nothing matches exactly: both candidates are the right song at a slightly different length.
    const { s } = sources({
      ytm: {
        'Kevin MacLeod Wallpaper': [cand({ platform_id: 'farfarfarfa', duration: 187 })],
        'Wallpaper': [cand({ platform_id: 'closeclosec', duration: 184 })],
      },
    });
    const r = await findFullSong(track(), s, {});
    expect(r.source).toBe('close');
    expect(r.id).toBe('closeclosec'); // the smallest gap wins, not the first seen
    expect(r.note).toMatch(/\d+s/); // the reason is carried, not hidden
  });

  it('never returns a candidate the matcher called a different recording', async () => {
    const { s } = sources({
      ytm: { 'Kevin MacLeod Wallpaper': [cand({ platform_id: 'wrongwrongw', artists: ['Somebody Else'], duration: 300 })] },
    });
    const r = await findFullSong(track(), s, {});
    expect(r).toMatchObject({ id: null, source: 'none' });
    expect(r.url).toBeUndefined();
  });

  it('reports no source without throwing when SoundCloud is unavailable', async () => {
    const { s, asked } = sources({ ytm: {}, scPresent: false });
    const r = await findFullSong(track(), s, {});
    expect(r).toMatchObject({ id: null, source: 'none' });
    expect(asked.sc).toEqual([]);
  });

  it('survives a source that throws and still tries the next one', async () => {
    const asked: string[] = [];
    const s: ChainSources = {
      ytm: { search: async () => { throw new Error('YouTube Music did not answer'); } },
      sc: { search: async (q: string) => { asked.push(q); return [cand({ provider: 'soundcloud', url: 'https://soundcloud.com/a/b' })]; } },
    };
    const r = await findFullSong(track(), s, {});
    expect(r.source).toBe('soundcloud'); // one dead provider is not the end of the search
    expect(asked.length).toBeGreaterThan(0);
  });

  it('stops asking once the budget of questions is spent', async () => {
    const { s, asked } = sources({ ytm: {}, sc: {} });
    await findFullSong(track({ title: 'A (feat. B) [Remix]', artists: ['X', 'Y'] }), s, { maxQueries: 2 });
    expect(asked.ytm.length).toBeLessThanOrEqual(2);
  });
});

describe('a source that already failed', () => {
  it('skips a link the caller says will not download and offers the next best', async () => {
    const { s } = sources({
      ytm: {
        'Kevin MacLeod Wallpaper': [
          cand({ platform_id: 'deaddeaddea' }), // exact, but this link keeps failing
          cand({ platform_id: 'aliveNowOk1' }), // equally exact
        ],
      },
    });
    const r = await findFullSong(track(), s, { exclude: ['https://music.youtube.com/watch?v=deaddeaddea'] });
    expect(r.id).toBe('aliveNowOk1');
  });

  it('skips an excluded SoundCloud link too', async () => {
    const { s } = sources({
      ytm: {},
      sc: {
        'Kevin MacLeod Wallpaper': [
          cand({ provider: 'soundcloud', url: 'https://soundcloud.com/a/dead' }),
          cand({ provider: 'soundcloud', url: 'https://soundcloud.com/a/good' }),
        ],
      },
    });
    const r = await findFullSong(track(), s, { exclude: ['https://soundcloud.com/a/dead'] });
    expect(r.url).toBe('https://soundcloud.com/a/good');
  });

  it('will not fall back to an excluded near miss either', async () => {
    const { s } = sources({
      ytm: { 'Kevin MacLeod Wallpaper': [cand({ platform_id: 'nearmissnea', duration: 185 })] },
    });
    const r = await findFullSong(track(), s, { exclude: ['https://music.youtube.com/watch?v=nearmissnea'] });
    expect(r).toMatchObject({ id: null, source: 'none' }); // honest: nothing left to try
  });
});
