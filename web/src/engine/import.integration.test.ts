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
