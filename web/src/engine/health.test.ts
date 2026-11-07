/**
 * SRC-PANEL-001: the Sources status panel must list every source the download engine actually
 * uses, not only the streaming providers. Bandcamp, Audius, HearThis and Internet Archive are
 * full-song fallback sources in the chain; before this they ran but were invisible on the panel,
 * which told the listener the app had four sources when it really had eight.
 */
import { describe, expect, it } from 'vitest';
import { LocalApi } from './local-api';
import { MemoryBackend, Store } from './store';

describe('sources health panel', () => {
  it('lists every full-song source the engine uses, with honest capabilities', async () => {
    const store = await Store.open(new MemoryBackend());
    const port = { request: async () => { throw new Error('offline'); } };
    const api = new LocalApi({ store, port, encoder: null, spotifySearch: () => async () => [] });

    const r = await api.handle('GET', '/api/health?refresh=1');
    const providers = (r.body as { providers: Record<string, Record<string, { state: string }>> }).providers;

    for (const p of ['deezer', 'ytmusic', 'soundcloud', 'spotify', 'bandcamp', 'audius', 'hearthis', 'archive']) {
      expect(Object.keys(providers), `missing provider ${p}`).toContain(p);
    }
    // The fallback sources find and play a full song; they do not resolve pasted links or supply
    // related / artist / new candidates, so those columns must read as unsupported, not working.
    for (const p of ['bandcamp', 'audius', 'hearthis', 'archive']) {
      expect(providers[p]!['search'], `${p}.search`).toBeDefined();
      expect(providers[p]!['playback_link'], `${p}.play`).toBeDefined();
      for (const cap of ['resolve_link', 'related_candidates', 'artist_candidates', 'recent_candidates']) {
        expect(providers[p]![cap]?.state, `${p}.${cap}`).toBe('unsupported');
      }
    }
  });
});
