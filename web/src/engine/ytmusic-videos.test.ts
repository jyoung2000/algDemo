import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { YouTubeMusic } from './ytmusic';

/**
 * SOURCE-VIDEO-001 — YouTube Music's songs catalogue is not all of YouTube.
 *
 * Measured against the live InnerTube endpoint for the owner's stuck songs: the songs-only filter
 * cannot see "ManePear's Official Theme Song" by Nombra101 at all, while the videos filter returns
 * it at exactly the right length. Game soundtracks and small-creator uploads live as videos, so a
 * songs-only search leaves them permanently unavailable however often it is retried.
 */
const search = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'golden', 'ytm-search.json'), 'utf8');
const SONGS_FILTER = 'EgWKAQIIAWoMEA4QChADEAQQCRAF';
const VIDEOS_FILTER = 'EgWKAQIQAWoMEA4QChADEAQQCRAF'; // ytmusicapi get_search_params('videos')

it('asks YouTube with the videos filter, not the songs filter', async () => {
  const sent: Record<string, unknown>[] = [];
  const http = { getJson: async (_u: string, o: { body: string }) => { sent.push(JSON.parse(o.body)); return JSON.parse(search); } };
  const rows = await new YouTubeMusic(http as never).searchVideos('Nombra101 ManePear', 8, {});
  expect(sent).toHaveLength(1);
  expect(sent[0]!['params']).toBe(VIDEOS_FILTER);
  expect(sent[0]!['params']).not.toBe(SONGS_FILTER);
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) expect(r.provider).toBe('ytmusic'); // downloadable by video id, like any YTM hit
});

it('keeps the songs search on the songs filter', async () => {
  const sent: Record<string, unknown>[] = [];
  const http = { getJson: async (_u: string, o: { body: string }) => { sent.push(JSON.parse(o.body)); return JSON.parse(search); } };
  await new YouTubeMusic(http as never).search('q', 8, {});
  expect(sent[0]!['params']).toBe(SONGS_FILTER);
});

it('does not serve a videos search from the songs search cache', async () => {
  // A REAL cache: a store whose cacheGet always misses could never catch a shared key.
  let calls = 0;
  const entries = new Map<string, { value: unknown }>();
  const http = { getJson: async () => { calls++; return JSON.parse(search); } };
  const store = {
    cacheGet: (k: string) => entries.get(k),
    cachePut: async (k: string, _kind: string, value: unknown) => { entries.set(k, { value }); },
    addTransfer: () => undefined,
  };
  const ytm = new YouTubeMusic(http as never, store as never);
  await ytm.search('same question', 8, {});
  expect(calls).toBe(1);
  await ytm.search('same question', 8, {});
  expect(calls).toBe(1); // proves the cache really is serving hits
  await ytm.searchVideos('same question', 8, {});
  expect(calls).toBe(2); // two different catalogues, two different questions
  expect([...entries.keys()].some(k => k.startsWith('yt:videos:'))).toBe(true);
});
