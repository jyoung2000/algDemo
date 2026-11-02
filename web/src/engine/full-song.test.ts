import { expect, it } from 'vitest';
import { LocalApi } from './local-api';
import { MemoryBackend, Store } from './store';

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
