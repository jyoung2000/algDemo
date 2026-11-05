import { api, type Track } from '../api';
import { dl } from './downloads';
import { localLibrary, sourceUrlFor } from './local-audio';
import { rescueSource } from './rescue';
import { QueuePreloader } from './queue-preload';

/** Singleton: navigating between screens must not reset completed work or download twice. */
export const queueAudio = new QueuePreloader({
  library: localLibrary,
  known: track => track.provider === 'ytmusic' ? sourceUrlFor(track.platform_id) : null,
  configure: (gb, protectedUrls, wanted, parallel) => dl.cacheConfig(gb, protectedUrls, wanted, parallel),
  capacity: async () => {
    const h = await dl.health();
    const bytes = h.cache_bytes, limit = h.cache_limit_bytes;
    if (bytes === undefined || limit === undefined || !Number.isFinite(bytes) || !Number.isFinite(limit) || bytes < 0 || limit <= 0) {
      throw new Error('Queue cache capacity is unavailable');
    }
    return { bytes, limit };
  },
  resolve: async (track: Track, retry = false, exclude: readonly string[] = []) => {
    // A song the app already knows a YouTube id for needs no search at all — unless that very link
    // is the one that keeps failing, in which case it has to go looking like any other (SOURCE-SWAP-001).
    const direct = track.provider === 'ytmusic' ? sourceUrlFor(track.platform_id) : null;
    if (direct && !exclude.includes(direct)) return direct;
    const match = await api.fullSong(track, retry, exclude);
    // SOURCE-CHAIN-001: a SoundCloud match arrives as a link, a YouTube Music one as a video id.
    return match.url ?? sourceUrlFor(match.id) ?? rescueSource({ links: track.url ? [{ url: track.url }] : [], shell: true });
  },
});
