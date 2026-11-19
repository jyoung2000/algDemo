/**
 * RADIO-TASTE-001 through the real LocalApi: what a song heard on the radio does to the listener's
 * algorithm once the radio session reports it (see radio-taste.test.ts for when it reports).
 */
import { describe, expect, it } from 'vitest';
import * as E from './engine';
import { LocalApi } from './local-api';
import { MemoryBackend, Store } from './store';

const tag = (name: string) => ({ name, label: name, source: 'Deezer album genre', scope: 'track', confidence: 0.8, inferred: false });
const seed = { key: 'a|one', provider: 'deezer', platform_id: '1', title: 'One', artists: ['A'], artist: 'A', tags: [tag('rock')] };
const heard = { key: 'mara|night drive', provider: 'deezer', platform_id: '9', title: 'Night Drive', artists: ['Mara'], artist: 'Mara', duration: 220, bpm: 104, tags: [tag('synthwave')] };

const open = async () => {
  const store = await Store.open(new MemoryBackend());
  const api = new LocalApi({ store, port: { request: async () => { throw new Error('no network in this test'); } }, encoder: null, spotifySearch: () => async () => [] });
  await api.handle('PUT', '/api/seeds', { seeds: [seed] });
  return { api, store };
};
const post = (api: LocalApi, body: Record<string, unknown>) => api.handle('POST', '/api/feedback', body);
const NOTE = 'radio:0b9d2c1e-1111-4222-8333-444455556666:00112233aabbccdd';
const note = (api: LocalApi, over: Record<string, unknown> = {}) => post(api, { kind: 'qualified', track: heard, event_id: NOTE, listened: 30, coverage: 30, duration: 220, medium: 'radio', origin: 'radio', confidence: 0.7, ...over });
const full = (api: LocalApi, over: Record<string, unknown> = {}) => post(api, { kind: 'complete', track: heard, event_id: `${NOTE}:full`, supersedes: NOTE, listened: 212, coverage: 212, duration: 220, medium: 'radio', origin: 'radio', confidence: 0.7, ...over });
type Profile = { tracked: { counts: Record<string, number>; songs_played: number; radio_listens: number }; taste: { genres: { name: string; score: number }[] }; artists: { name: string; score: number }[]; played: { key: string; radio: boolean }[]; recent: { key: string; kind: string; radio: boolean }[] };
const profile = async (api: LocalApi) => (await api.handle('GET', '/api/profile')).body as Profile;

describe('a radio listen in the taste and feedback model (RADIO-TASTE-001)', () => {
  it('a full radio listen replaces the thirty-second note for the same song instead of adding to it', async () => {
    const { api, store } = await open();
    expect((await note(api)).body).toMatchObject({ recorded: true });
    expect((await full(api)).body).toMatchObject({ recorded: true });
    const rows = store.feedback().filter((r) => r.key === heard.key);
    expect(rows.map((r) => r.kind)).toEqual(['complete']);
    expect(rows[0]).toMatchObject({ medium: 'radio', origin: 'radio', confidence: 0.7, duration: 220, coverage: 212, listened: 212 });
    // Reported twice (the phone page and the service page both follow the station): still one listen.
    expect((await full(api)).body).toMatchObject({ recorded: false, duplicate: true });
    expect((await note(api)).body).toMatchObject({ recorded: false, duplicate: true }); // the late note cannot come back beside the full listen
    expect(store.feedback().filter((r) => r.key === heard.key)).toHaveLength(1);
  });

  it('keeps the fullest report of one radio listen: more heard replaces less, never the other way', async () => {
    const { api, store } = await open();
    await note(api);
    await full(api, { listened: 154, coverage: 154 });
    const ts = store.feedback()[0]!.ts;
    expect((await full(api, { listened: 212, coverage: 212 })).body).toMatchObject({ recorded: true });
    expect((await full(api, { listened: 160, coverage: 160 })).body).toMatchObject({ recorded: false, duplicate: true });
    const rows = store.feedback().filter((r) => r.key === heard.key);
    expect(rows.map((r) => [r.kind, r.coverage, r.listened, r.ts])).toEqual([['complete', 212, 212, ts]]); // one listen, at the time it happened
    // A listen in the player is never rewritten this way.
    await post(api, { kind: 'complete', track: heard, event_id: 'player-1', listened: 100, coverage: 100, duration: 220, medium: 'full', origin: 'queue' });
    expect((await post(api, { kind: 'complete', track: heard, event_id: 'player-1', listened: 220, coverage: 220, duration: 220, medium: 'full', origin: 'queue' })).body).toMatchObject({ recorded: false, duplicate: true });
    expect(store.feedback().find((r) => r.event_id === 'player-1')!.coverage).toBe(100);
  });

  it('replaces only the radio note it names: never a judgement, another song, or a listen in the player', async () => {
    const { api, store } = await open();
    await post(api, { kind: 'like', track: heard, event_id: 'like-1' });
    await post(api, { kind: 'qualified', track: { ...heard, key: 'other|song', title: 'Other' }, event_id: 'radio:x:other', listened: 40, medium: 'radio' });
    await post(api, { kind: 'complete', track: heard, event_id: 'player-1', listened: 200, duration: 220, medium: 'full', origin: 'queue' });
    for (const s of ['like-1', 'radio:x:other', 'player-1']) await full(api, { event_id: `f:${s}`, supersedes: s });
    expect(store.feedback().map((r) => r.event_id).sort()).toEqual(['f:like-1', 'f:player-1', 'f:radio:x:other', 'like-1', 'player-1', 'radio:x:other'].sort());
  });

  it('teaches the song, its artist and its genres, and lifts a like-sounding song in the ranking', async () => {
    const { api, store } = await open();
    const cand = (key: string, artist: string, genre: string): E.Track => ({ key, title: key, artists: [artist], tags: [tag(genre)] as never, provenance: [], release: null, bpm: 104 });
    const rank = () => {
      const fb = E.buildFeedback2(store.feedback() as never, Math.floor(Date.now() / 1000));
      const sc = E.scoreAll([cand('mara|other', 'Mara', 'synthwave'), cand('zed|other', 'Zed', 'polka')], {
        seeds: [seed as never], vectors: new Map(), relatedArtists: new Map(), feedback: fb, impressions: {},
        settings: { adventurous: 0.5, fresh: false, vocals: 'any' }, now: new Date(), rankV2: true, taste2: api.taste2(),
      } as E.Context);
      return Object.fromEntries(sc.map((s) => [s.track.key, s.final]));
    };
    const before = rank();
    await note(api); await full(api);
    const after = rank();
    expect(after['mara|other']! - before['mara|other']!).toBeGreaterThan(0.01); // heard on the radio: its artist and sound now count for it
    expect(after['mara|other']! - after['zed|other']!).toBeGreaterThan(before['mara|other']! - before['zed|other']!);
    const p = await profile(api);
    expect(p.taste.genres.find((g) => g.name === 'synthwave')?.score).toBeGreaterThan(0);
    expect(p.artists.find((a) => a.name === 'mara')?.score).toBeGreaterThan(0);
  });

  it('counts a full radio listen as most of a full listen in the player, and more than the thirty-second note', async () => {
    const weight = async (send: (api: LocalApi) => Promise<unknown>) => { const { api, store } = await open(); await send(api); return E.buildFeedback2(store.feedback() as never, Math.floor(Date.now() / 1000)).track[heard.key] ?? 0; };
    const noted = await weight((api) => note(api));
    const radio = await weight(async (api) => { await note(api); await full(api); });
    const player = await weight((api) => post(api, { kind: 'complete', track: heard, event_id: 'p1', listened: 220, coverage: 220, duration: 220, medium: 'full', origin: 'queue' }));
    expect(noted).toBeGreaterThan(0);
    expect(radio).toBeGreaterThan(noted * 1.5);
    expect(radio).toBeLessThan(player); // an identification is not as sure as the listener's own pick
    expect(radio).toBeGreaterThan(player * 0.6);
  });

  it('shows radio listens in the profile, marked as radio', async () => {
    const { api } = await open();
    await note(api, { event_id: 'radio:x:only-noted', track: { ...heard, key: 'mara|second', title: 'Second' } });
    await note(api); await full(api);
    await post(api, { kind: 'complete', track: seed, event_id: 'p1', listened: 180, duration: 180, medium: 'full', origin: 'queue' });
    const p = await profile(api);
    expect(p.tracked.radio_listens).toBe(2);
    expect(p.played.map((r) => [r.key, r.radio])).toEqual([[seed.key, false], [heard.key, true]]);
    expect(p.recent.filter((r) => r.radio).map((r) => [r.key, r.kind]).sort()).toEqual([[heard.key, 'complete'], ['mara|second', 'qualified']].sort());
  });

  it('records nothing for a radio programme, even if one is reported as a listen', async () => {
    const { api, store } = await open();
    const programme = { key: 'radio:s1:evening', title: 'Evening programme', artists: ['World radio'], artist: 'World radio', kind: 'radio-programme', tags: [tag('jazz')] };
    const r = await post(api, { kind: 'complete', track: programme, event_id: 'radio:x:prog', listened: 600, duration: 600, medium: 'radio', origin: 'radio' });
    expect(r.body).toMatchObject({ recorded: false });
    expect(store.feedback()).toHaveLength(0);
  });
});
