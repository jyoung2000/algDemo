/**
 * REMOVE-FOREVER-001 (owner, 2026-11-20): "Removing a song should remove it from your queue, storage, and it should not
 * persist or re appear in your discovery and the listening algorithm / taste map should take account and not recommend
 * similar songs or that song again unless the user likes / stars the song".
 *
 * Before: a removal hid the song for 30 days only, a later like or star did not bring it back, it stayed in the saved
 * queue, it counted less against its genres than a dislike and faded in two weeks, and nothing pushed down songs like it.
 */
import { describe, expect, it } from 'vitest';
import { LocalApi } from './local-api';
import { MemoryBackend, Store } from './store';
import type { HttpPort } from './net';
import { buildFeedback, buildFeedback2, removedPenalty } from './engine';
import { buildTaste, TASTE_EVENT_WEIGHTS } from './taste';

const tag = (name: string) => ({ name, label: name, source: 'test', scope: 'track', confidence: 1, inferred: false });
const song = (key: string, artist: string, genres: string[]) => ({ key, title: key, artists: [artist], provider: 'local', platform_id: key, tags: genres.map(tag), provenance: [{ seed: 'seed|start', relation: 'similar' }] });
const seed = { key: 'seed|start', title: 'Start', artists: ['Seed'], provider: 'local', platform_id: 'seed', tags: [tag('soul'), tag('trap')] };
const gone = song('gone|song', 'Gone', ['soul', 'trap']);
const sameArtist = song('gone|other', 'Gone', ['soul']);
const twin = song('twin|song', 'Twin', ['soul', 'trap']);
const far = song('far|song', 'Far', ['metal']);
const port = { request: async () => { throw new Error('no providers in this test'); } } as HttpPort;
const DAY = 86400;

async function open() {
  const store = await Store.open(new MemoryBackend());
  await store.put('last_pool', { cands: [gone, sameArtist, twin, far], seeds: [seed], related: [], settings: { adventurous: 0.5 } });
  await store.put('last_result', { phase: 'final', items: [gone, sameArtist, twin, far].map((t, i) => ({ track: t, rank: i + 1, reasons: [], playback: {} })), count: 4, asked: 4, sources: {}, audio: {}, timings: {}, transfer: {} });
  return { store, api: new LocalApi({ store, port, encoder: null }) };
}
type Ranked = { items: { track: { key: string }; score: number }[] };
const rank = async (api: LocalApi) => Object.fromEntries(((await api.handle('POST', '/api/rerank', {})).body as Ranked).items.map((x) => [x.track.key, x.score]));
let n = 0;
const send = (api: LocalApi, kind: string, t: Record<string, unknown>) => api.handle('POST', '/api/feedback', { kind, track: t, event_id: `e${++n}` });

describe('removing a song through the engine', () => {
  it('it leaves discovery and the saved queue; same-artist and same-sounding songs sink; others stay put', async () => {
    const { store, api } = await open();
    const before = await rank(api);
    expect(Object.keys(before)).toContain('gone|song');
    expect((await send(api, 'hide', gone)).status).toBe(200);
    const after = await rank(api);
    expect(after['gone|song']).toBeUndefined();
    expect(after['gone|other']!).toBeLessThan(before['gone|other']! * 0.75);
    expect(after['twin|song']!).toBeLessThan(before['twin|song']! * 0.75);
    expect(after['far|song']!).toBeGreaterThanOrEqual(before['far|song']! * 0.97);
    const saved = store.get<{ items: { track: { key: string } }[]; count: number }>('last_result')!;
    expect(saved.items.map((x) => x.track.key)).not.toContain('gone|song');
    expect(saved.count).toBe(3);
  });
  it('a like (or a star) afterwards brings it back and takes the removal out of the listening history', async () => {
    const { store, api } = await open();
    await send(api, 'hide', gone);
    await send(api, 'like', gone);
    expect(Object.keys(await rank(api))).toContain('gone|song');
    expect(store.feedback().some((f) => f.key === 'gone|song' && f.kind === 'hide')).toBe(false);
    await send(api, 'hide', gone);
    await send(api, 'save', gone);
    expect(store.feedback().some((f) => f.key === 'gone|song' && f.kind === 'hide')).toBe(false);
  });
});

describe('a removal is permanent until liked', () => {
  const t0 = 1_800_000_000;
  const hide = { event_id: 'h', key: 'k', kind: 'hide', artist: 'a', ts: t0, track: gone } as never;
  for (const [name, build] of [['v1', buildFeedback], ['v2', buildFeedback2]] as const) {
    it(`${name}: still hidden a year later; a later like or save lifts it`, () => {
      expect(build([hide], t0 + 365 * DAY).hidden.has('k')).toBe(true);
      expect(build([hide, { event_id: 'l', key: 'k', kind: 'like', artist: 'a', ts: t0 + DAY } as never], t0 + 2 * DAY).hidden.has('k')).toBe(false);
      expect(build([hide, { event_id: 's', key: 'k', kind: 'save', artist: 'a', ts: t0 + DAY } as never], t0 + 2 * DAY).hidden.has('k')).toBe(false);
    });
  }
  it('the removed songs are listed with their artist and genres for the similarity check', () => {
    const fb = buildFeedback2([hide], t0 + 400 * DAY);
    expect(fb.removed).toEqual([{ key: 'k', artist: 'a', tags: gone.tags }]);
  });
});

describe('removedPenalty', () => {
  const removed = [{ key: 'gone|song', artist: 'gone', tags: gone.tags as never }];
  it('same artist or the same sound: well down; unrelated: untouched', () => {
    expect(removedPenalty(sameArtist as never, removed, new Map())).toBeLessThanOrEqual(0.55);
    expect(removedPenalty(twin as never, removed, new Map())).toBeLessThanOrEqual(0.45);
    expect(removedPenalty(far as never, removed, new Map())).toBe(1);
    expect(removedPenalty(far as never, [], new Map())).toBe(1);
  });
  it('measured sound wins when both songs have it', () => {
    const v = (...x: number[]) => Float64Array.from(x);
    const vectors = new Map([['gone|song', v(1, 0)], ['far|song', v(1, 0)], ['twin|song', v(0, 1)]]);
    expect(removedPenalty(far as never, removed, vectors)).toBeLessThanOrEqual(0.45);
    expect(removedPenalty(twin as never, removed, vectors)).toBe(1);
  });
});

describe('the taste map counts a removal like a dislike, and it does not fade', () => {
  it('weight', () => expect(TASTE_EVENT_WEIGHTS['hide']).toBe(TASTE_EVENT_WEIGHTS['dislike']));
  it('a removal a year old still counts in full against its genres', () => {
    const t0 = 1_800_000_000;
    const now = buildTaste([{ key: 'k', kind: 'hide', ts: t0, track: gone as never }], t0);
    const later = buildTaste([{ key: 'k', kind: 'hide', ts: t0, track: gone as never }], t0 + 365 * DAY);
    expect(later.genres['soul']!.score).toBeCloseTo(now.genres['soul']!.score, 6);
    expect(now.genres['soul']!.score).toBeLessThan(0);
  });
});

// REMOVE-CONFIRM-001: the Discover X is a dislike that removes the song, so a dislike is a removal too.
describe('a dislike (the Discover X) removes a song the same way', () => {
  it('same-artist and same-sounding songs sink after a dislike', async () => {
    const { api } = await open();
    const before = await rank(api);
    await send(api, 'dislike', gone);
    const after = await rank(api);
    expect(after['gone|song']).toBeUndefined();
    expect(after['gone|other']!).toBeLessThan(before['gone|other']! * 0.75);
    expect(after['twin|song']!).toBeLessThan(before['twin|song']! * 0.75);
  });
  it('the dislike leaves the saved queue and does not fade from the taste map', async () => {
    const { store, api } = await open();
    await send(api, 'dislike', gone);
    expect(store.get<{ items: { track: { key: string } }[] }>('last_result')!.items.map((x) => x.track.key)).not.toContain('gone|song');
    const t0 = 1_800_000_000;
    const a = buildTaste([{ key: 'k', kind: 'dislike', ts: t0, track: gone as never }], t0);
    const b = buildTaste([{ key: 'k', kind: 'dislike', ts: t0, track: gone as never }], t0 + 365 * DAY);
    expect(b.genres['soul']!.score).toBeCloseTo(a.genres['soul']!.score, 6);
  });
  it('a like afterwards brings it back', async () => {
    const { api } = await open();
    await send(api, 'dislike', gone);
    await send(api, 'like', gone);
    expect(Object.keys(await rank(api))).toContain('gone|song');
  });
});
