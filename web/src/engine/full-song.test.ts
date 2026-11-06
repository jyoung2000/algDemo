import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * SOURCE-CHAIN-002 — the SoundCloud leg of `fullSong` must be able to pay for the client-id bundle.
 *
 * Live trace of the packaged app: for every stuck song the chain reached `soundcloud.com` and
 * `a-v2.sndcdn.com` but NEVER `api-v2.soundcloud.com`, so no SoundCloud search ever ran. The id
 * lives in a 2,950,727-byte uncompressed bundle (measured 2026-11-05), while `fullSong` ran on the
 * 3 MB-cap/3 MB-day playback meter — after the YouTube searches there was never room, and the
 * reserve inherits what is left of the day. Provider searching belongs on the search meter, whose
 * own comment says it is sized for exactly this bundle; the owner's daily_mb remains the real limit.
 */
it('can pay for the SoundCloud client-id bundle while resolving a full song', async () => {
  const store = await Store.open(new MemoryBackend());
  const bundle = new TextEncoder().encode(
    // A real bundle is minified, so the id is preceded by punctuation (`,client_id:`), which the
    // word-boundary in the pattern needs; filler alone would read as `xxxclient_id`.
    'x'.repeat(2_950_000) + ',client_id:"N5nHxilyZaG4XKY57pV0M6qx6JysgIFW"',
  );
  const asked: string[] = [];
  // Real sizes, or the budget this test is about never actually binds: a recorded YouTube Music
  // search response is 62,705 bytes and the chain asks up to eight (songs + videos filters), and the
  // SoundCloud home page is read up to its 600 KB cap. Together with the bundle that is ~4 MB.
  const ytmReal = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'golden', 'ytm-search.json'));
  const scHome = new TextEncoder().encode(
    '<script src="https://a-v2.sndcdn.com/assets/55-37fbc1b1.js"></script>' + '<!--' + 'p'.repeat(550_000) + '-->',
  );
  const api = new LocalApi({ store, encoder: null, spotifySearch: () => async () => [], port: {
    request: async (req: { url: string }) => {
      asked.push(new URL(req.url).host);
      const json = (o: unknown) => ({ status: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(o)) });
      if (req.url.includes('music.youtube.com')) return { status: 200, headers: { 'content-type': 'application/json' }, body: new Uint8Array(ytmReal) };
      if (req.url.startsWith('https://soundcloud.com/')) {
        return { status: 200, headers: { 'content-type': 'text/html' }, body: scHome };
      }
      if (req.url.includes('a-v2.sndcdn.com')) return { status: 200, headers: { 'content-type': 'application/javascript' }, body: bundle };
      if (req.url.includes('api-v2.soundcloud.com')) {
        return json({ collection: [{ kind: 'track', id: 42, title: 'Wallpaper', duration: 180_000, permalink_url: 'https://soundcloud.com/kmacleod/wallpaper', user: { username: 'Kevin MacLeod' } }] });
      }
      return json({});
    },
  } });
  const track = { key: 'sc-pay', provider: 'deezer', platform_id: '9', title: 'Wallpaper', artists: ['Kevin MacLeod'], duration: 180 };
  const r = await api.handle('POST', '/api/full-song', { track });
  expect(asked).toContain('api-v2.soundcloud.com'); // the search actually ran
  expect(r.body).toMatchObject({ source: 'soundcloud', url: 'https://soundcloud.com/kmacleod/wallpaper' });
});

it('does not hand back a rejected own YouTube link when an alternative was requested', async () => {
  const store = await Store.open(new MemoryBackend());
  const asked: string[] = [];
  const api = new LocalApi({ store, encoder: null, spotifySearch: () => async () => [], port: {
    request: async (req: { url: string }) => {
      asked.push(req.url);
      return { status: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(ytmusicSearch) };
    },
  } });
  const track = { key: 'dead-own', provider: 'ytmusic', platform_id: 'qapK8Gx6ZTo', title: 'Unavailable song', artists: ['Artist'], duration: 101 };
  const r = await api.handle('POST', '/api/full-song', { track, retry: true, exclude: ['https://music.youtube.com/watch?v=qapK8Gx6ZTo'] });
  expect(asked.length).toBeGreaterThan(0);
  expect(r.body).toMatchObject({ id: null, source: 'none' });
});

it('does not reuse a previously cached uncertain near miss as a full song', async () => {
  const store = await Store.open(new MemoryBackend());
  const asked: string[] = [];
  const api = new LocalApi({ store, encoder: null, spotifySearch: () => async () => [], port: {
    request: async (req: { url: string }) => {
      asked.push(req.url);
      return { status: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(ytmusicSearch) };
    },
  } });
  const track = { key: 'near', provider: 'deezer', platform_id: '1', title: 'Unavailable song', artists: ['Artist'], duration: 101 };
  await store.cachePut(`fullsong:${track.title}|${track.artists.join('|')}|${track.duration}`, 'meta',
    { id: 'qapK8Gx6ZTo', source: 'close', note: 'durations differ by 5s' }, 3600);
  const r = await api.handle('POST', '/api/full-song', { track });
  expect(r.body).toMatchObject({ id: null, source: 'none' });
  expect(asked.length).toBeGreaterThan(0);
});

it('passive retry bypasses BOTH cached source misses and cached provider searches, but keeps good matches', async () => {
  const store = await Store.open(new MemoryBackend());
  const asked: string[] = [];
  const api = new LocalApi({ store, encoder: null, spotifySearch: () => async () => [], port: {
    request: async (req: { url: string }) => {
      asked.push(req.url);
      return { status: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(ytmusicSearch) };
    },
  } });
  const track = { key: 'retry-k', provider: 'deezer', platform_id: '1', title: 'Retry song', artists: ['Artist'], duration: 101 };
  await api.handle('POST', '/api/full-song', { track });
  const first = asked.length;
  expect(first).toBeGreaterThan(0);
  await api.handle('POST', '/api/full-song', { track });
  expect(asked.length).toBe(first); // ordinary callers retain caching
  await api.handle('POST', '/api/full-song', { track, retry: true });
  expect(asked.length).toBeGreaterThan(first); // really talks to provider again
  const key = `fullsong:${track.title}|${track.artists.join('|')}|${track.duration}`;
  await store.cachePut(key, 'meta', { id: 'qapK8Gx6ZTo', source: 'match' }, 3600);
  const beforePositive = asked.length;
  const result = await api.handle('POST', '/api/full-song', { track, retry: true });
  expect(result.body).toMatchObject({ id: 'qapK8Gx6ZTo' });
  expect(asked.length).toBe(beforePositive); // don't churn good cached sources
});
import { LocalApi } from './local-api';
import { MemoryBackend, Store } from './store';

/**
 * SOURCE-CHAIN-001 — when YouTube Music has nothing, the engine must go on to ask a source whose
 * links the shells can actually download, instead of recording "no source" and stopping.
 */
it('asks SoundCloud for a song YouTube Music cannot match, instead of giving up', async () => {
  const store = await Store.open(new MemoryBackend());
  const asked: string[] = [];
  const api = new LocalApi({ store, encoder: null, spotifySearch: () => async () => [], port: {
    request: async (req: { url: string }) => {
      asked.push(req.url);
      return { status: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(ytmusicSearch) };
    },
  } });
  const track = { key: 'sc-k', provider: 'deezer', platform_id: '7', title: 'Nowhere Song', artists: ['Obscure Act'], duration: 212 };
  const r = await api.handle('POST', '/api/full-song', { track });
  const ytmAsks = asked.filter((u) => u.includes('youtube.com')).length;
  expect(ytmAsks).toBeGreaterThan(1); // more than one phrasing of the question
  expect(asked.some((u) => u.includes('soundcloud.com'))).toBe(true); // a second source was tried
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ source: 'none' }); // honest when genuinely nobody has it
});

/** A "nobody has it" answer must expire soon, so a song uploaded later is still picked up. */
it('re-asks for a song nobody had once the short no-source answer expires', async () => {
  let clock = 1_700_000_000;
  const store = await Store.open(new MemoryBackend(), { now: () => clock });
  const asked: string[] = [];
  const api = new LocalApi({ store, encoder: null, spotifySearch: () => async () => [], port: {
    request: async (req: { url: string }) => {
      asked.push(req.url);
      return { status: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(ytmusicSearch) };
    },
  } });
  const track = { key: 'ttl-k', provider: 'deezer', platform_id: '8', title: 'Later Upload', artists: ['Act'], duration: 200 };
  await api.handle('POST', '/api/full-song', { track });
  const first = asked.length;
  expect(first).toBeGreaterThan(0);

  clock += 10 * 60; // ten minutes later the answer still stands
  await api.handle('POST', '/api/full-song', { track });
  expect(asked.length).toBe(first);

  clock += 25 * 60; // past half an hour it asks again, without anyone forcing a retry
  await api.handle('POST', '/api/full-song', { track });
  expect(asked.length).toBeGreaterThan(first);
});


// A spent daily discovery allowance must not stop a song from playing: finding the YouTube video for a
// song reads a few kilobytes and the song itself streams from YouTube's own player.
const ytmusicSearch = JSON.stringify({
  contents: { tabbedSearchResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [] } } } }] } },
});

it('looks up the full song even when the day\'s discovery allowance is used up', async () => {
  const store = await Store.open(new MemoryBackend());
  const asked: string[] = [];
  const port = {
    request: async (req: { url: string }) => {
      asked.push(req.url);
      return { status: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(ytmusicSearch) };
    },
  };
  const api = new LocalApi({ store, port, encoder: null, spotifySearch: () => async () => [] });
  await api.handle('PUT', '/api/settings', { daily_mb: 5 });
  store.addTransfer('metadata', 6_000_000); // more than the 5 MB day
  const r = await api.handle('POST', '/api/full-song', { track: { key: 'k', provider: 'deezer', platform_id: '1', title: 'Alia Vita', artists: ['slayr'], duration: 101 } });
  expect(asked.some((u) => u.includes('music.youtube.com'))).toBe(true); // the lookup was allowed to run
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ id: null, source: 'none' }); // no match in this empty answer, but it was asked, not refused
});
