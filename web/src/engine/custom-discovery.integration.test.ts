/**
 * NEXT-FAV-CUSTOM-001 through the real LocalApi: a fake Deezer answers the artist page, its related artists and
 * their top songs; the found songs land at the end of Now playing and nothing already there is repeated.
 */
import { describe, expect, it } from 'vitest';
import { LocalApi } from './local-api';
import { MemoryBackend, Store } from './store';
import type { HttpPort } from './net';

const dzTrack = (id: number, title: string, artist: string, artistId: number, extra: string[] = [], year = 2024) => ({
  id, title, duration: 180, rank: 1000, link: `https://www.deezer.com/track/${id}`, preview: '', release_date: `${year}-03-01`,
  artist: { id: artistId, name: artist }, contributors: [{ id: artistId, name: artist }, ...extra.map((n, i) => ({ id: 900 + i, name: n }))],
  album: { id: 7000 + id, title: `${title} album`, cover_xl: '', genres: { data: [{ id: 116, name: 'Rap/Hip Hop' }] } },
});

function deezer(): HttpPort {
  const reply = (body: unknown) => ({ status: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(body)) });
  return {
    async delay() {},
    async request(req) {
      const u = new URL(req.url);
      if (u.hostname !== 'api.deezer.com') throw new Error('offline');
      const p = u.pathname;
      if (p === '/artist/1') return reply({ id: 1, name: 'Ken Carson', nb_fan: 10, link: 'https://www.deezer.com/artist/1' });
      if (p === '/artist/1/top') return reply({ data: [dzTrack(11, 'Own one', 'Ken Carson', 1), dzTrack(12, 'Own two', 'Ken Carson', 1, ['Destroy Lonely']), dzTrack(13, 'Own three', 'Ken Carson', 1, ['Destroy Lonely']), dzTrack(14, 'Own four', 'Ken Carson', 1, ['Obscure Guest'])] });
      if (p === '/artist/1/albums') return reply({ data: [] });
      if (p === '/artist/1/related') return reply({ data: [{ id: 2, name: 'Yeat', nb_fan: 5, link: 'https://www.deezer.com/artist/2' }] });
      if (p === '/artist/2/top') return reply({ data: [dzTrack(21, 'Yeat one', 'Yeat', 2), dzTrack(22, 'Yeat two', 'Yeat', 2)] });
      if (p === '/search/artist' && /Destroy Lonely/.test(u.searchParams.get('q') ?? '')) return reply({ data: [{ id: 3, name: 'Destroy Lonely', nb_fan: 9 }] });
      if (p === '/search/artist' && /Obscure Guest/.test(u.searchParams.get('q') ?? '')) return reply({ data: [{ id: 4, name: 'Nature Sounds Relaxation', nb_fan: 9 }] });
      if (p === '/search' && /Destroy Lonely/.test(u.searchParams.get('q') ?? '')) return reply({ data: [dzTrack(31, 'Lonely one', 'Destroy Lonely', 3)] });
      // A name Deezer does not have: its search answers someone else entirely.
      if (p === '/search' && /Obscure Guest/.test(u.searchParams.get('q') ?? '')) return reply({ data: [dzTrack(41, 'Wave Serenity', 'Nature Sounds Relaxation', 4)] });
      if (p === '/artist/4/top') return reply({ data: [dzTrack(41, 'Wave Serenity', 'Nature Sounds Relaxation', 4)] });
      if (p === '/artist/3/top') return reply({ data: [dzTrack(31, 'Lonely one', 'Destroy Lonely', 3), dzTrack(32, 'Lonely two', 'Destroy Lonely', 3)] });
      if (p.startsWith('/album/')) return reply({ id: 1, genres: { data: [{ id: 116, name: 'Rap/Hip Hop' }] } });
      return reply({ data: [] });
    },
  } as HttpPort;
}

async function settle(api: LocalApi, job: string) {
  for (let i = 0; i < 400; i++) {
    const s = (await api.handle('GET', `/api/jobs/${job}`)).body as { done: boolean; error?: string | null; result?: Record<string, unknown> | null };
    if (s.done) return s;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('job never finished');
}

describe('POST /api/discover/custom', () => {
  it('adds the chosen artist\u2019s songs and their circle to the end of Now playing', async () => {
    const store = await Store.open(new MemoryBackend());
    await store.put('settings', { adventurous: 0.3 });
    await store.put('last_result', { phase: 'final', items: [{ rank: 1, track: { key: 'dz:11', title: 'Own one', artists: ['Ken Carson'], provider: 'deezer' } }], count: 1 });
    const api = new LocalApi({ store, port: deezer(), encoder: null, spotifySearch: () => async () => [] });
    const start = await api.handle('POST', '/api/discover/custom', {
      criteria: { artists: [{ id: 'dz:1', name: 'Ken Carson', own: true, features: false, collaborators: true, similar: true }], count: 10, adventurous: 0.5, era: 0 },
    });
    expect(start.status).toBe(200);
    const s = await settle(api, (start.body as { job: string }).job);
    expect(s.error ?? null).toBeNull();
    const r = s.result as { added: number; reason: string };
    expect(r.added).toBeGreaterThan(3);
    const items = (store.get<{ items: { track: { key: string; title: string }; reasons: { text: string }[] }[] }>('last_result'))!.items;
    expect(items[0]!.track.key).toBe('dz:11');
    const titles = items.map((it) => it.track.title);
    expect(titles.filter((t) => t === 'Own one')).toHaveLength(1);
    expect(titles).toEqual(expect.arrayContaining(['Own two', 'Yeat one', 'Lonely one']));
    expect(items.find((it) => it.track.title === 'Yeat one')!.reasons[0]!.text).toMatch(/similar to Ken Carson/);
    // A collaborator Deezer does not know by that name never lends another artist's songs.
    expect(titles).not.toContain('Wave Serenity');
  });

  it('says so when nothing matches, and leaves the queue alone', async () => {
    const store = await Store.open(new MemoryBackend());
    await store.put('settings', {});
    const api = new LocalApi({ store, port: deezer(), encoder: null, spotifySearch: () => async () => [] });
    const start = await api.handle('POST', '/api/discover/custom', { criteria: { artists: [{ id: 'dz:1', name: 'Ken Carson' }], genres: ['family:ambient-chill'], count: 5 } });
    const s = await settle(api, (start.body as { job: string }).job);
    expect((s.result as { added: number; reason: string }).added).toBe(0);
    expect((s.result as { reason: string }).reason).toMatch(/No matching songs found/);
    expect(store.get('last_result') ?? null).toBeNull();
  });
});
