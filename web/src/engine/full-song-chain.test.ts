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
  videos?: Record<string, Track[]>;
  scPresent?: boolean;
}): { s: ChainSources; asked: { ytm: string[]; sc: string[]; videos: string[] } } {
  const asked = { ytm: [] as string[], sc: [] as string[], videos: [] as string[] };
  const s: ChainSources = {
    ytm: {
      search: async (q: string) => { asked.ytm.push(q); return o.ytm?.[q] ?? []; },
    },
    sc: o.scPresent === false ? null : {
      search: async (q: string) => { asked.sc.push(q); return o.sc?.[q] ?? []; },
    },
    videos: {
      search: async (q: string) => { asked.videos.push(q); return o.videos?.[q] ?? []; },
    },
  };
  return { s, asked };
}

/**
 * SOURCE-VIDEO-001 — YouTube Music's songs catalogue is not all of YouTube.
 *
 * Measured against the live InnerTube endpoint for the owner's four stuck songs: the songs-only
 * filter (ytmusicapi `EgWKAQIIAW…`) cannot see "ManePear's Official Theme Song" by Nombra101 at all,
 * while the videos filter returns it at exactly the right length (195s, 0s gap). Game soundtracks
 * and small-creator tracks are uploaded as videos, so a songs-only search makes them permanently
 * unavailable however often it is retried.
 */
describe('owner-verified sources', () => {
  it('downloads Plant Island from the owner-confirmed SoundCloud link, ahead of every search leg', async () => {
    const t = track({ title: 'Plant Island', artists: ['My Singing Monsters'], duration: 219, isrc: 'USHM81262832' });
    const { s, asked } = sources({ ytm: {}, sc: {} });
    const r = await findFullSong(t, s, {});
    expect(r).toMatchObject({ id: null, source: 'soundcloud', url: 'https://soundcloud.com/ghostmeow/my-singing-monsters-plant' });
    expect(asked.ytm).toEqual([]); // the confirmation wins before any provider is asked
    expect(asked.sc).toEqual([]);
  });
  it('leaves every other song to the normal strict search', async () => {
    const { s, asked } = sources({ ytm: { 'Kevin MacLeod Wallpaper': [cand()] } });
    expect(await findFullSong(track(), s, {})).toMatchObject({ source: 'match' });
    expect(asked.ytm.length).toBeGreaterThan(0);
  });
});

describe('YouTube beyond the songs catalogue', () => {
  it('finds a song that only exists as a YouTube video', async () => {
    const t = track({ title: "ManePear's Official Theme Song", artists: ['Nombra101'], duration: 195 });
    const { s, asked } = sources({
      ytm: {},
      videos: { "Nombra101 ManePear's Official Theme Song": [cand({ platform_id: 'videoidvid1', title: "ManePear's Official Theme Song", artists: ['Nombra101'], duration: 195 })] },
    });
    const r = await findFullSong(t, s, {});
    expect(r).toMatchObject({ id: 'videoidvid1', source: 'video' });
    expect(asked.ytm.length).toBeGreaterThan(0); // the songs catalogue is still asked first
    expect(asked.videos.length).toBeGreaterThan(0);
  });

  it('prefers the songs catalogue and never asks for videos when a song matches', async () => {
    const { s, asked } = sources({ ytm: { 'Kevin MacLeod Wallpaper': [cand()] }, videos: {} });
    const r = await findFullSong(track(), s, {});
    expect(r.source).toBe('match');
    expect(asked.videos).toEqual([]);
  });

  it('refuses a user upload that is not the same recording', async () => {
    // Real results for "Plant Island": slowed and fan-made re-uploads at the wrong length.
    const t = track({ title: 'Plant Island', artists: ['My Singing Monsters'], duration: 219 });
    const { s } = sources({
      ytm: {},
      videos: { 'My Singing Monsters Plant Island': [
        cand({ platform_id: 'slowedslowe', title: 'My Singing Monsters - Plant Island [ slowed + reverbed ]', artists: ['ela'], duration: 199 }),
        cand({ platform_id: 'fanmadefanm', title: 'Plant Island COLOSSOUL ( fanmade ) - My Singing Monsters', artists: ['Ewubbz'], duration: 250 }),
      ] },
    });
    const r = await findFullSong(t, s, {});
    expect(r.id).not.toBe('slowedslowe');
    expect(r.id).not.toBe('fanmadefanm');
  });

  it('will not offer a user upload as a near miss, only as a confident match', async () => {
    // Same artist, same title, 5s out: `matchRecordings` calls this *uncertain*. For the songs
    // catalogue that is good enough to offer as `close`; for an unverified re-upload it is not.
    const { s } = sources({
      ytm: {},
      videos: { 'Kevin MacLeod Wallpaper': [cand({ platform_id: 'uncertainup', duration: 185 })] },
    });
    const r = await findFullSong(track(), s, {});
    expect(r).toMatchObject({ id: null, source: 'none' });
  });

  it('skips an excluded video link', async () => {
    const { s } = sources({
      ytm: {},
      videos: { 'Kevin MacLeod Wallpaper': [cand({ platform_id: 'deadvideoid' })] },
    });
    const r = await findFullSong(track(), s, { exclude: ['https://music.youtube.com/watch?v=deadvideoid'] });
    expect(r.id).not.toBe('deadvideoid');
  });

  it('works unchanged when the shell has no videos leg', async () => {
    const { s } = sources({ ytm: { 'Kevin MacLeod Wallpaper': [cand()] } });
    delete (s as { videos?: unknown }).videos;
    expect(await findFullSong(track(), s, {})).toMatchObject({ source: 'match' });
  });
});

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

  it('refuses a near miss rather than counting a different-duration upload as the full recording', async () => {
    // A title and artist alone cannot certify that a 184s upload is the target 180s recording.
    const { s } = sources({
      ytm: {
        'Kevin MacLeod Wallpaper': [cand({ platform_id: 'farfarfarfa', duration: 187 })],
        'Wallpaper': [cand({ platform_id: 'closeclosec', duration: 184 })],
      },
    });
    const r = await findFullSong(track(), s, {});
    expect(r).toMatchObject({ id: null, source: 'none' });
    expect(r.url).toBeUndefined();
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

/**
 * SOURCE-MORE-001 — two more sources that hand over whole songs.
 *
 * Bandcamp (artist-uploaded, `is_streamable` tracks) and Audius (keyless public API) both answer
 * with a real track length and both are downloadable in full by yt-dlp, verified live on
 * 2026-11-05. They are asked after YouTube and SoundCloud, so they only cost requests for the songs
 * nothing else had, and they are held to the same strict bar as a user video upload: a confident
 * match or nothing. No "close enough" substitute comes from either.
 */
describe('licensed HearThis leg', () => {
  const url = 'https://hearthis.at/kmacleod/wallpaper/';
  const candidate = (title = 'Wallpaper', duration = 180) => cand({ provider: 'hearthis', title, duration, url });
  const chain = (track: Track): ChainSources => ({
    ytm: { search: async () => [] }, sc: null,
    hearthis: { search: async () => [track] },
  });
  it('offers an exact creator-downloadable CC recording by its track page', async () => {
    expect(await findFullSong(track(), chain(candidate()), {})).toMatchObject({ id: null, source: 'hearthis', url });
  });
  it('rejects another rendition and an already failed link', async () => {
    expect(await findFullSong(track(), chain(candidate('Wallpaper (Remix)')), {})).toMatchObject({ source: 'none' });
    expect(await findFullSong(track(), chain(candidate()), { exclude: [url] })).toMatchObject({ source: 'none' });
  });
  it('bounds an unavailable HearThis search to two distinct queries', async () => {
    let calls = 0;
    const s: ChainSources = { ytm: { search: async () => [] }, sc: null,
      hearthis: { search: async () => { calls++; return []; } } };
    expect(await findFullSong(track(), s, {})).toMatchObject({ source: 'none' });
    expect(calls).toBeLessThanOrEqual(2);
  });
});

describe('licensed Internet Archive leg', () => {
  const url = 'https://archive.org/download/wallpaper-by-kevin-macleod/wallpaper-by-kevin-macleod.mp3';
  const archive = (title = 'Wallpaper', duration = 180) => cand({ provider: 'archive', title, duration, url });
  const chain = (candidate: Track): ChainSources => ({
    ytm: { search: async () => [] }, sc: null,
    archive: { search: async () => [candidate] },
  });
  it('offers the exact recording by its direct audio URL', async () => {
    expect(await findFullSong(track(), chain(archive()), {})).toMatchObject({ id: null, source: 'archive', url });
  });
  it('does not offer a different rendition or an excluded URL', async () => {
    expect(await findFullSong(track(), chain(archive('Wallpaper (Remix)')), {})).toMatchObject({ source: 'none' });
    expect(await findFullSong(track(), chain(archive('Wallpaper', 195)), {})).toMatchObject({ source: 'none' });
    expect(await findFullSong(track(), chain(archive()), { exclude: [url] })).toMatchObject({ source: 'none' });
  });
});

describe('Bandcamp and Audius legs', () => {
  const chain = (o: { bandcamp?: Record<string, Track[]>; audius?: Record<string, Track[]> }) => {
    const asked = { bandcamp: [] as string[], audius: [] as string[] };
    const s: ChainSources = {
      ytm: { search: async () => [] },
      sc: { search: async () => [] },
      videos: { search: async () => [] },
      bandcamp: { search: async (q: string) => { asked.bandcamp.push(q); return o.bandcamp?.[q] ?? []; } },
      audius: { search: async (q: string) => { asked.audius.push(q); return o.audius?.[q] ?? []; } },
    };
    return { s, asked };
  };

  it('downloads from Bandcamp by link when nothing else has the song', async () => {
    const { s, asked } = chain({
      bandcamp: { 'Kevin MacLeod Wallpaper': [cand({ provider: 'bandcamp', platform_id: '2133171372', url: 'https://kmacleod.bandcamp.com/track/wallpaper' })] },
    });
    const r = await findFullSong(track(), s, {});
    expect(r).toMatchObject({ id: null, source: 'bandcamp', url: 'https://kmacleod.bandcamp.com/track/wallpaper' });
    expect(asked.bandcamp.length).toBeGreaterThan(0);
    expect(asked.audius).toEqual([]); // stopped as soon as something was downloadable
  });

  it('downloads from Audius by link when Bandcamp has nothing either', async () => {
    const { s, asked } = chain({
      audius: { 'Kevin MacLeod Wallpaper': [cand({ provider: 'audius', platform_id: '95wro', url: 'https://audius.co/kmacleod/wallpaper' })] },
    });
    const r = await findFullSong(track(), s, {});
    expect(r).toMatchObject({ id: null, source: 'audius', url: 'https://audius.co/kmacleod/wallpaper' });
    expect(asked.bandcamp.length).toBeGreaterThan(0); // Bandcamp was asked first
    expect(asked.audius.length).toBeGreaterThan(0);
  });

  it('never substitutes a different version from either source, even with nothing else left', async () => {
    const { s } = chain({
      bandcamp: { 'Kevin MacLeod Wallpaper': [cand({ provider: 'bandcamp', platform_id: '1', url: 'https://x.bandcamp.com/track/a', duration: 185 })] },
      audius: { 'Kevin MacLeod Wallpaper': [cand({ provider: 'audius', platform_id: '2', url: 'https://audius.co/x/b', title: 'Wallpaper (Remix)' })] },
    });
    expect(await findFullSong(track(), s, {})).toMatchObject({ id: null, source: 'none' });
  });

  it('skips a Bandcamp or Audius link that already failed to download', async () => {
    const { s } = chain({
      bandcamp: { 'Kevin MacLeod Wallpaper': [cand({ provider: 'bandcamp', platform_id: '1', url: 'https://x.bandcamp.com/track/dead' })] },
      audius: { 'Kevin MacLeod Wallpaper': [cand({ provider: 'audius', platform_id: '2', url: 'https://audius.co/x/dead' })] },
    });
    const r = await findFullSong(track(), s, { exclude: ['https://x.bandcamp.com/track/dead', 'https://audius.co/x/dead'] });
    expect(r).toMatchObject({ id: null, source: 'none' });
  });

  it('works unchanged on a shell that has neither leg, and survives one that throws', async () => {
    const plain: ChainSources = { ytm: { search: async () => [cand()] }, sc: null };
    expect(await findFullSong(track(), plain, {})).toMatchObject({ source: 'match' });
    const throwing: ChainSources = {
      ytm: { search: async () => [] },
      sc: null,
      bandcamp: { search: async () => { throw new Error('Bandcamp changed its site'); } },
      audius: { search: async () => [cand({ provider: 'audius', platform_id: '95wro', url: 'https://audius.co/a/b' })] },
    };
    expect(await findFullSong(track(), throwing, {})).toMatchObject({ source: 'audius' });
  });
});
