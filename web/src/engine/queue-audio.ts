import { api, type Track } from '../api';
import { dl } from './downloads';
import { localLibrary, sourceUrlFor } from './local-audio';
import { rescueSource } from './rescue';
import { QueuePreloader } from './queue-preload';

/** Singleton: navigating between screens must not reset completed work or download twice. */
export const queueAudio = new QueuePreloader({
  library: localLibrary,
  known: track => track.provider === 'ytmusic' ? sourceUrlFor(track.platform_id) : null,
  configure: (gb, protectedUrls, wanted) => dl.cacheConfig(gb, protectedUrls, wanted),
  resolve: async (track: Track) => {
    const direct = track.provider === 'ytmusic' ? sourceUrlFor(track.platform_id) : null;
    if (direct) return direct;
    const match = await api.fullSong(track);
    return sourceUrlFor(match.id) ?? rescueSource({ links: track.url ? [{ url: track.url }] : [], shell: true });
  },
});
