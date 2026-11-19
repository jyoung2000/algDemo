import { describe, expect, it, vi } from 'vitest';
import { DIM, MODEL_ID, PREPROCESS_ID } from './audio';
import { LocalApi, songVectorKey } from './local-api';
import { makeTrack, type Track } from './track';
import { MemoryBackend, Store } from './store';

/**
 * SIMILAR-SOUND-001: a real LocalApi route, local persisted settings and last_result, all seven
 * provider adapters, model-tagged vectors; no network and no made-up audio match. This exercises the
 * add/no-repeat path rather than just the cosine arithmetic. (A separate live run uses the real model.)
 */
const song = (provider: string, i: number, title: string): Track => makeTrack({ provider, platformId: String(i), title, artists: ['Actual Artist'], url: `https://example.invalid/${provider}/${i}`, duration: 210 });
const vector = (cos: number) => Float64Array.from({ length: DIM }, (_, i) => i === 0 ? cos : i === 1 ? Math.sqrt(1 - cos * cos) : 0);
async function setup() {
  const backend = new MemoryBackend();
  const store = await Store.open(backend);
  const api = new LocalApi({ store, port: { request: async () => { throw Error('no network'); } }, encoder: null });
  const seed = song('deezer', 1, 'Seed Song');
  const providers = ['deezer','ytmusic','soundcloud','bandcamp','audius','hearthis','internet-archive'] as const;
  const hits = providers.map((p, i) => song(p, i+2, `Different Song ${i}`));
  const existing = song('deezer', 99, 'Already on my list');
  const duplicate = song('soundcloud', 80, 'Already on my list');
  // The actual 512-element embeddings are persisted with the same model and preprocessing id as
  // production, so the implementation must retrieve them rather than guess from a track's tags.
  await store.vectorPut(songVectorKey(seed.key), MODEL_ID, PREPROCESS_ID, vector(1), 'test-full-song');
  for (const t of [...hits, duplicate]) await store.vectorPut(songVectorKey(t.key), MODEL_ID, PREPROCESS_ID, vector(0.8), 'test-full-song');
  const item = { rank: 1, track: existing, score: 0.6, reasons: [], characteristics: {}, sources: [], factors: {}, playback: {} };
  await store.put('last_result', { phase: 'final', items: [item], count: 1, asked: 30, sources: {}, audio: {}, timings: {}, transfer: {} });
  vi.spyOn(api.pipeline, 'profileSeed').mockResolvedValue({ dz: null });
  vi.spyOn(api.pipeline, 'seedView').mockImplementation((t) => t);
  vi.spyOn(api.pipeline, 'gather').mockResolvedValue({ cands: [duplicate], related: new Map() });
  providers.forEach((name, i) => vi.spyOn(api[({ deezer: 'dz', ytmusic: 'ytm', soundcloud: 'sc', 'internet-archive': 'archive' } as Record<string, 'dz' | 'ytm' | 'sc' | 'archive'>)[name] ?? name as keyof LocalApi] as { search: (...x: unknown[]) => Promise<Track[]> }, 'search').mockResolvedValue([hits[i]!]));
  const handle = async (m: string, path: string, body?: Record<string, unknown>) => {
    const r = await api.handle(m, path, body ?? {}); return { status: r.status, body: r.body as Record<string, any> };
  };
  const done = async (track: Track) => {
    const req = await handle('POST','/api/similar',{ track }); expect(req.status).toBe(200); expect(req.body.job).toBeTruthy();
    let r = await handle('GET',`/api/jobs/${req.body.job}`);
    for (let i=0; i<100 && !r.body.done; i++) { await new Promise((resolve) => setTimeout(resolve, 5)); r = await handle('GET',`/api/jobs/${req.body.job}`); }
    expect(r.body.done).toBe(true); expect(r.body.error).toBeNull(); return r.body.result;
  };
  return { api, store, backend, seed, existing, hits, providers, handle, done };
}

describe('find and add by measured sound', () => {
  it('searches every full-song platform and appends only new songs with actual matched vectors', async () => {
    const { api, seed, providers, handle, done } = await setup();
    const result = await done(seed);
    expect(result.added).toBe(7);
    expect(result.minimum).toBe(70);
    expect(result.matches).toHaveLength(7);
    expect(Object.keys(result.sources)).toEqual(expect.arrayContaining(providers.map((p) => `similar-${p}`)));
    expect(result.matches.every((m: { match: number }) => m.match >= 70)).toBe(true);
    expect(result.queue.items.map((i: { track: Track }) => i.track.title)).toEqual(['Already on my list', ...providers.map((_, i) => `Different Song ${i}`)]);
    expect((await handle('GET','/api/last')).body.items).toHaveLength(8);
    expect(api.pipeline.gather).toHaveBeenCalled();
    const again = await done(seed);
    expect(again.added).toBe(0); // the same songs from all seven platforms cannot be re-added
    expect((await handle('GET','/api/last')).body.items).toHaveLength(8);
  });

  it('persists the slider, validates it, and rejects anything below it without appending', async () => {
    const { store, backend, seed, handle, done } = await setup();
    expect((await handle('PUT','/api/settings',{ similar_percent: 101 })).status).toBe(400);
    expect((await handle('PUT','/api/settings',{ similar_percent: NaN })).status).toBe(400);
    expect((await handle('PUT','/api/settings',{ similar_percent: 95 })).status).toBe(200);
    expect((await handle('GET','/api/settings')).body.similar_percent).toBe(95);
    expect(new LocalApi({ store: await Store.open(backend), port: { request: async () => { throw Error('no network'); } }, encoder: null }).settings().similar_percent).toBe(95);
    const out = await done(seed);
    // SIMILAR-MIN-001 (owner, 2026-11-19): at least three songs; none reached 95%, so the three closest
    // measured ones are added, each marked below the bar with its real percentage.
    expect(out.added).toBe(3);
    expect(out.reached).toBe(0);
    expect(out.below).toBe(3);
    expect(out.matches.every((m: { match: number; below?: boolean }) => m.below === true && m.match < 95)).toBe(true);
    expect((await handle('GET','/api/last')).body.items).toHaveLength(4);
  });

  it('refuses to spend provider work when audio matching is turned off in Settings', async () => {
    const { api, seed, handle, done } = await setup();
    await handle('PUT','/api/settings',{ audio: false });
    const result = await done(seed);
    expect(result.added).toBe(0);
    expect(result.reason).toMatch(/off in Settings/);
    expect(api.pipeline.gather).not.toHaveBeenCalled();
  });

  it('adds three related songs but never a made-up percentage if the seed has no real sound embedding', async () => {
    const { api, seed, store, handle, done } = await setup();
    // A new seed has the same metadata, but no vector. A source declaring it "related" cannot
    // turn that into a fake percentage when the model cannot hear it.
    const unanalysed = song('ytmusic', 500, 'Unknown sound');
    vi.mocked(api.pipeline.seedView).mockReturnValue(unanalysed);
    const out = await done(unanalysed);
    // SIMILAR-MIN-001: still three songs, each said to be related with its sound not compared.
    expect(out.added).toBe(3);
    expect(out.unmeasured).toBe(3);
    expect(out.matches.every((m: { match: number | null; unmeasured?: boolean }) => m.match === null && m.unmeasured === true)).toBe(true);
    expect(out.reason).toMatch(/No analysed audio.*not compared/);
    expect(store.get<Record<string, unknown>>('last_result')?.count).toBe(4);
  });
});
