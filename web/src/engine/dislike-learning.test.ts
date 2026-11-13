/** Real feedback routes + persistent Store + real reranker; no provider or scorer mocks. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalApi } from './local-api';
import { MemoryBackend, Store } from './store';
import * as E from './engine';
import type { HttpPort } from './net';

const NOW = new Date('2026-11-13T18:00:00Z');
const tag = (name: string) => ({ name, label: name, source: 'test', scope: 'track', confidence: 1, inferred: false });
const seed = {
  key: 'seed artist|starting song', title: 'Starting song', artists: ['Seed Artist'],
  provider: 'local', platform_id: 'seed', tags: [tag('metalcore'), tag('soul')],
  bpm: 120, release: null, provenance: [],
};
const song = (key: string, artist: string, genre: string) => ({
  key, title: key.split('|')[1]!, artists: [artist], provider: 'local', platform_id: key,
  tags: [tag(genre)], bpm: 120, release: null,
  provenance: [{ seed: seed.key, relation: 'radio', rank: 0, source: 'test' }],
});
const rejected = song('reject artist|rejected', 'Reject Artist', 'metalcore');
const sibling = song('reject artist|another song', 'Reject Artist', 'metalcore');
const genrePeer = song('a metal peer|unheard metal', 'A Metal Peer', 'metalcore');
const control = song('z soul peer|unheard soul', 'Z Soul Peer', 'soul');
const candidates = [rejected, sibling, genrePeer, control];
type Item = { track: { key: string }; score: number; factors: Record<string, number | null> };
type State = {
  events: number; state: Record<string, Record<string, boolean>>;
  taste: null | { negatives: number; avoids: { name: string; score: number }[] };
};

let offline: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  offline = vi.fn(async () => { throw new Error('This test must never contact a provider'); });
});
afterEach(() => {
  vi.useRealTimers();
  expect(offline).not.toHaveBeenCalled();
});

function local(store: Store) {
  return new LocalApi({ store, port: { request: offline } as HttpPort, encoder: null });
}
async function open(rankV2: boolean) {
  const backend = new MemoryBackend();
  const store = await Store.open(backend);
  // Restore the actual persisted discovery-pool format: only gathering is bypassed.
  await store.put('settings', { rank_v2: rankV2 });
  await store.put('last_pool', { cands: candidates, seeds: [seed], related: [], settings: { adventurous: 0.5, fresh: false, vocals: 'any' } });
  await store.flush();
  return { backend, store, api: local(store) };
}
async function feedback(api: LocalApi, kind: string) {
  const res = await api.handle('POST', '/api/feedback', {
    kind, event_id: `${kind}:rejected`, track: rejected,
  });
  expect(res.status).toBe(200);
  return res.body;
}
async function state(api: LocalApi): Promise<State> {
  const res = await api.handle('GET', '/api/feedback/state');
  expect(res.status).toBe(200);
  return res.body as State;
}
async function rerank(api: LocalApi): Promise<Item[]> {
  // No caller-side exclusion: the engine must learn the exclusion from feedback itself.
  const res = await api.handle('POST', '/api/rerank', { exclude: [] });
  expect(res.status).toBe(200);
  const out = res.body as { items: Item[]; count: number };
  expect(out.count).toBe(out.items.length);
  return out.items;
}
function item(items: Item[], key: string) {
  const found = items.find((x) => x.track.key === key);
  expect(found, `rerank must retain ${key}`).toBeDefined();
  return found!;
}
function feedbackView(store: Store, rankV2: boolean) {
  return (rankV2 ? E.buildFeedback2 : E.buildFeedback)(store.feedback(), NOW.getTime() / 1000);
}

for (const rankV2 of [false, true]) {
  describe(`dislike teaches the real LocalApi/Store (ranking ${rankV2 ? 'v2' : 'v1'})`, () => {
    it('learns negative tagged genre taste in v1 and both persistent v2 horizons', async () => {
      const { api, store } = await open(rankV2);
      expect((await state(api)).taste).toBeNull();
      expect(await feedback(api, 'dislike')).toMatchObject({ recorded: true, duplicate: false });
      const learned = await state(api);
      expect(learned.events).toBe(1);
      expect(learned.state[rejected.key]).toMatchObject({ dislike: true });
      expect(learned.taste?.negatives).toBe(1);
      expect(learned.taste?.avoids).toContainEqual({ name: 'metalcore', label: 'metalcore', score: -1.5, skips: 1 });
      expect(store.feedback()[0]).toMatchObject({ kind: 'dislike', artist: 'reject artist', track: { tags: rejected.tags, bpm: 120 } });
      expect(api.taste().genres.metalcore!.score).toBeLessThan(0);
      expect(api.taste2().long.genres.metalcore!.score).toBeLessThan(0);
      expect(api.taste2().recent.genres.metalcore!.score).toBeLessThan(0);
      expect(api.taste2().weight).toBeGreaterThan(0);
      // A duplicate transport retry must not teach the dislike twice.
      expect(await feedback(api, 'dislike')).toMatchObject({ recorded: false, duplicate: true });
      expect((await state(api)).events).toBe(1);
      expect(api.taste().genres.metalcore!.score).toBe(-1.5);
    });

    it('lowers the song and artist feedback and the actual score of another song by that artist', async () => {
      const { api, store } = await open(rankV2);
      const before = await rerank(api);
      expect(item(before, sibling.key).factors.feedback).toBeNull();
      await feedback(api, 'dislike');
      const fb = feedbackView(store, rankV2);
      expect(fb.track[rejected.key]).toBeLessThan(0);
      expect(fb.artist['reject artist']).toBeLessThan(0);
      expect(E.feedbackFit(rejected, fb)).toBeLessThan(0.5);
      expect(E.feedbackFit(sibling, fb)).toBeLessThan(0.5);
      const after = await rerank(api);
      expect(item(after, sibling.key).factors.feedback).toBeLessThan(0.5);
      expect(item(after, sibling.key).score).toBeLessThan(item(before, sibling.key).score);
      expect(item(after, control.key).factors.feedback).toBeNull();
    });

    it('excludes the rejected song and demotes an unheard same-genre song by a different artist', async () => {
      const { api } = await open(rankV2);
      const before = await rerank(api);
      expect(before.map((x) => x.track.key).sort()).toEqual(candidates.map((x) => x.key).sort());
      expect(item(before, genrePeer.key).score).toBe(item(before, control.key).score);
      await feedback(api, 'dislike');
      const after = await rerank(api);
      expect(after.map((x) => x.track.key).sort()).toEqual([sibling.key, genrePeer.key, control.key].sort());
      expect(item(after, genrePeer.key).factors.feedback).toBeNull();
      expect(item(after, genrePeer.key).factors.taste).toBeLessThan(0.5);
      expect(item(after, genrePeer.key).score).toBeLessThan(item(before, genrePeer.key).score);
      expect(item(after, control.key).score).toBe(item(before, control.key).score);
      expect(after.findIndex((x) => x.track.key === genrePeer.key)).toBeGreaterThan(after.findIndex((x) => x.track.key === control.key));
    });

    it('undo restores taste, feedback, eligibility and the original scores/order', async () => {
      const { api, store } = await open(rankV2);
      const baseline = await rerank(api);
      await feedback(api, 'dislike');
      expect((await rerank(api)).some((x) => x.track.key === rejected.key)).toBe(false);
      expect(await feedback(api, 'undislike')).toMatchObject({ removed: 1 });
      expect(await state(api)).toEqual({ state: {}, events: 0, taste: null });
      expect(api.taste().events).toBe(0);
      expect(api.taste2().weight).toBe(0);
      expect(feedbackView(store, rankV2).excluded.size).toBe(0);
      expect(feedbackView(store, rankV2).track).toEqual({});
      expect(feedbackView(store, rankV2).artist).toEqual({});
      expect(await rerank(api)).toEqual(baseline);
    });

    it('persists learning and reranking across both Store and LocalApi recreation, including undo', async () => {
      const { api, store, backend } = await open(rankV2);
      const baseline = await rerank(api);
      await feedback(api, 'dislike');
      const learnedState = await state(api);
      const learnedTaste = api.taste();
      const learnedBlend = api.taste2();
      const learnedRanking = await rerank(api);
      await store.flush();
      const reopened = await Store.open(backend);
      const restarted = local(reopened);
      expect(await state(restarted)).toEqual(learnedState);
      expect(restarted.taste()).toEqual(learnedTaste);
      expect(restarted.taste2()).toEqual(learnedBlend);
      expect(await rerank(restarted)).toEqual(learnedRanking);
      expect(await feedback(restarted, 'undislike')).toMatchObject({ removed: 1 });
      await reopened.flush();
      const afterUndoRestart = local(await Store.open(backend));
      expect(await state(afterUndoRestart)).toEqual({ state: {}, events: 0, taste: null });
      expect(afterUndoRestart.taste2().weight).toBe(0);
      expect(await rerank(afterUndoRestart)).toEqual(baseline);
    });
  });
}
