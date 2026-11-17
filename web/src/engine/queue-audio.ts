import { api, type Track } from '../api';
import { dl } from './downloads';
import { localLibrary, sourceUrlFor } from './local-audio';
import { rescueSource } from './rescue';
import { QueuePreloader } from './queue-preload';
import { RemoteQueue, type QueueAudioPort, type ServiceQueue } from './queue-remote';
import { DiscoveryExpiryMap, ReadySourceMap } from './ready-source';
import { onSwitchToLocal, serviceClient } from './service-client';

function localQueue(): QueuePreloader {
  const storage = (() => {
    try { return typeof window !== 'undefined' ? window.localStorage : undefined; }
    catch { return undefined; }
  })();
  const sources = new ReadySourceMap(storage);
  const unavailable = new DiscoveryExpiryMap(storage);
  return new QueuePreloader({
    library: localLibrary,
    known: track => track.provider === 'ytmusic' ? sourceUrlFor(track.platform_id) : sources.get(track.key),
    expiredKeys: () => unavailable.keys(),
    rememberExpired: (key, expired) => unavailable.remember(key, expired),
    remember: (track, url) => sources.remember(track.key, url),
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
      const url = match.url ?? sourceUrlFor(match.id) ?? rescueSource({ links: track.url ? [{ url: track.url }] : [], shell: true });
      // The final track-link fallback must honour exclusions too, not resurrect the rejected link.
      return url && !exclude.includes(url) ? url : null;
    },
  });
}

/**
 * SERVICE-API-001: the UI page's view of the service's loader, until the page switches to its own
 * engine (the service never opened the original database): then the loader runs here, and listeners
 * carry over. Nothing is downloaded by the view itself.
 */
export class SwitchingQueue implements QueueAudioPort {
  private target: QueueAudioPort;
  private off: () => void;
  private readonly listeners = new Set<() => void>();

  constructor(first: QueueAudioPort) {
    this.target = first;
    this.off = first.subscribe(() => this.fire());
  }

  get current(): QueueAudioPort { return this.target; }

  switchTo(next: QueueAudioPort): void {
    if (next === this.target) return;
    this.off();
    this.target.dispose();
    this.target = next;
    this.off = next.subscribe(() => this.fire());
    this.fire();
  }

  private fire(): void { for (const f of this.listeners) f(); }

  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  sourceHint(t: Track) { return this.target.sourceHint(t); }
  readyUrl(t: Track) { return this.target.readyUrl(t); }
  isReady(t: Track) { return this.target.isReady(t); }
  look(tracks: readonly Track[]) { return this.target.look(tracks); }
  expiredKeys() { return this.target.expiredKeys(); }
  snapshot() { return this.target.snapshot(); }
  snapshotFor(tracks: readonly Track[]) { return this.target.snapshotFor(tracks); }
  downloadAll(...a: Parameters<QueueAudioPort['downloadAll']>) { return this.target.downloadAll(...a); }
  update(...a: Parameters<QueueAudioPort['update']>) { return this.target.update(...a); }
  protect(...a: Parameters<QueueAudioPort['protect']>) { return this.target.protect(...a); }
  limits(...a: Parameters<QueueAudioPort['limits']>) { return this.target.limits(...a); }
  cardOf(...a: Parameters<QueueAudioPort['cardOf']>) { return this.target.cardOf(...a); }
  retryFailed() { return this.target.retryFailed(); }
  dispose() { this.off(); this.target.dispose(); this.listeners.clear(); }
}

const client = serviceClient();

function remoteView(c: NonNullable<typeof client>): QueueAudioPort {
  const view = new SwitchingQueue(new RemoteQueue(c));
  onSwitchToLocal(() => view.switchTo(localQueue()));
  return view;
}

/**
 * Singleton: navigating between screens must not reset completed work or download twice.
 * SERVICE-API-001: in the Android UI page with the service engine, this is a view of the service's
 * one loader; everywhere else (Windows, browser, old APKs, the service page itself) the loader runs here.
 */
export const queueAudio: QueueAudioPort = client ? remoteView(client) : localQueue();

/** The loader itself when it runs in this page (the service page owns it); null for the UI's view. */
export const localQueueAudio = (): ServiceQueue | null => (queueAudio instanceof QueuePreloader ? queueAudio : null);
