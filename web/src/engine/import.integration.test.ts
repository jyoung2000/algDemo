import { expect, it } from 'vitest';
import { LocalApi } from './local-api';
import { MemoryBackend, Store } from './store';
import { parseHistoryFile } from './import';

it('local import persists original time, deduplicates, and never upgrades a submitted listen to completion', async () => {
  const be = new MemoryBackend();
  const store = await Store.open(be);
  const port = { request: async () => { throw new Error('no network in this test'); } };
  const api = new LocalApi({ store, port, encoder: null, spotifySearch: () => async () => [] });
  const jsonl = JSON.stringify({ listened_at: 1750000000, track_metadata: { artist_name: 'Daft Punk', track_name: 'Get Lucky' } });
  const events = parseHistoryFile(jsonl).events;
  expect(events).toHaveLength(1);
  const first = await api.handle('POST', '/api/import/history', { events });
  expect(first).toMatchObject({ status: 200, body: { recorded: 1, duplicates: 0, skipped: 0 } });
  const again = await api.handle('POST', '/api/import/history', { events });
  expect(again).toMatchObject({ status: 200, body: { recorded: 0, duplicates: 1, skipped: 0 } });
  expect(store.feedback()[0]).toMatchObject({ kind: 'qualified', ts: 1750000000, listened: null, confidence: 0.6 });
  await store.flush();
  const reopened = await Store.open(be);
  expect(reopened.feedback()[0]).toMatchObject({ kind: 'qualified', ts: 1750000000, listened: null });
  const invalid = await api.handle('POST', '/api/import/history', { events: [{ ...events[0], event_id: 'imp-bad', kind: 'dislike' }] });
  expect(invalid).toMatchObject({ status: 200, body: { recorded: 0, skipped: 1 } });
});

it('reset/taste forgets feedback and impressions but keeps starting songs and settings', async () => {
  const be = new MemoryBackend();
  const store = await Store.open(be);
  const port = { request: async () => { throw new Error('no network in this test'); } };
  const api = new LocalApi({ store, port, encoder: null, spotifySearch: () => async () => [] });
  const seed = { key: 'daft punk|get lucky', provider: 'deezer', platform_id: '123', title: 'Get Lucky', artists: ['Daft Punk'] };
  await api.handle('PUT', '/api/seeds', { seeds: [seed] });
  await api.handle('PUT', '/api/settings', { adventurous: 0.9 });
  await api.handle('POST', '/api/feedback', { kind: 'like', event_id: 'e1', track: seed });
  await api.handle('POST', '/api/impressions', { keys: [seed.key] });
  expect(store.feedback()).toHaveLength(1);
  const r = await api.handle('POST', '/api/reset/taste', {});
  expect(r).toMatchObject({ status: 200, body: { ok: true } });
  expect(store.feedback()).toHaveLength(0);
  expect(store.seeds()).toHaveLength(1); // starting songs survive
  const settings = await api.handle('GET', '/api/settings', null);
  expect((settings.body as { adventurous: number }).adventurous).toBe(0.9); // settings survive
  await store.flush();
  const reopened = await Store.open(be); // and the forgetting is persistent
  expect(reopened.feedback()).toHaveLength(0);
  expect(reopened.seeds()).toHaveLength(1);
});
