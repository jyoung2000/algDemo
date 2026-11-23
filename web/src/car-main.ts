/**
 * CAR-CATALOG-SERVICE-001: the entry of car.html, the page the Android service's own catalogue
 * engine runs (never shown, no React, no audio). It answers the car's catalogue searches and Identify
 * with the same LocalApi and CarCatalog the phone page uses, over the same guarded native HTTP.
 *
 * SERVICE-API-001: when the service's native bridge reports `serviceApiVersion() === 1`, this page is
 * the ONE engine: the original database through startLocal, the one queue cache, and the UI page's
 * requests answered here. Without that (older native builds) it stays the metadata-only first slice,
 * with a separate bounded database so it can never be a second writer on the phone page's Store.
 */
import { api, newEventId, type Track } from './api';
import { radioSession } from './engine/radio-client';
import { CarCatalog } from './engine/car-catalog';
import { openIdbBackend } from './engine/idb';
import { LocalApi } from './engine/local-api';
import { runCarSimilar } from './engine/car-similar';
import { runCarMood } from './engine/car-mood';
import { carFeedback, carPlaylistAdd, type CarSaveDeps } from './engine/car-saves';
import { artistNamesOf, pushCarUnsaved, pushQueueTopUp, pushSourceUpdates, setMediaHandlers, songFromTrack } from './engine/media-native';
import { ServiceListening } from './engine/service-listening';
import { applyCarSettings } from './engine/car-settings';
import { engineSend } from './engine/native-engine';
import { defaultHttpPort, phoneWait } from './engine/native-http';
import { provideLocal, spotifySearchFor, startLocal } from './engine/runtime';
import { CarSources, ChainedContexts, LibraryContexts, parseLibrary, ServiceActor, type LibrarySnapshot } from './engine/service-actor';
import { Store } from './engine/store';

/** Not the phone page's `airwave-discovery`: this engine must never be a second writer there. */
export const CAR_CATALOG_DB = 'airwave-car-catalog';

interface ServiceBridge {
  serviceApiVersion?: () => number;
  /** Before opening the original database: true = it is this page's (EngineOwner, ServiceApi.kt). */
  claimEngine?: () => boolean;
  apiReady?: () => void;
  engineFailed?: (opened: boolean) => void;
  apiReply?: (id: string, json: string) => void;
  library?: () => string;
  catalogReady?: () => void;
}

type FullBridge = ServiceBridge & Required<Pick<ServiceBridge, 'apiReply' | 'claimEngine' | 'apiReady' | 'engineFailed'>>;

type ServiceWindow = { AirwaveNative?: ServiceBridge; __awServiceApi?: (json: string) => void; __awServiceState?: (json: string) => void };

/** True only when the final native plumbing (claim, requests in, replies out, failure) exists. */
export function fullServiceBridge(n: ServiceBridge | undefined): n is FullBridge {
  try {
    return typeof n?.serviceApiVersion === 'function' && n.serviceApiVersion() === 1 && typeof n.apiReply === 'function' &&
      typeof n.claimEngine === 'function' && typeof n.apiReady === 'function' && typeof n.engineFailed === 'function';
  } catch {
    return false;
  }
}

/** The service may open the original database only after native granted it (never beside the UI page). */
export function claimEngine(n: FullBridge): boolean {
  try { return n.claimEngine() === true; } catch { return false; }
}

/** The saved library and original Tracks for the bootstrap; empty when there are none. */
export function savedLibrary(n: ServiceBridge): LibrarySnapshot {
  try { return parseLibrary(typeof n.library === 'function' ? n.library() : null); } catch { return parseLibrary(null); }
}

function catalogFor(ready: (track: Track) => boolean): CarCatalog {
  return new CarCatalog(
    api.search, ready, api.searchLyrics, api.searchAlbums, (id) => api.album({ id }),
    (signature, ms) => api.identifyAudio(signature, ms), () => import('./engine/listen'),
  );
}

async function startMetadataOnly(): Promise<void> {
  const store = await Store.open(await openIdbBackend(CAR_CATALOG_DB), {
    cacheBudget: 20_000_000,
    freeBytes: async () => {
      const e = await navigator.storage?.estimate?.();
      return e?.quota != null && e.usage != null ? e.quota - e.usage : null;
    },
    freeFloor: 50_000_000,
  });
  // `api` calls in this page reach this engine, not a second default one.
  provideLocal(Promise.resolve(new LocalApi({ store, port: defaultHttpPort(), encoder: null, spotifySearch: spotifySearchFor })));
  const catalog = catalogFor(() => false);
  setMediaHandlers({
    catalogSearch: (query, opts) => catalog.searchAll(query, opts),
    identifyAudio: (samples) => catalog.identifyClip(samples),
  });
}

async function startService(n: FullBridge): Promise<void> {
  // Counted as opened from the moment opening starts: a failure after that never lets the UI open it too.
  let opened = false;
  try {
    opened = true;
    // The original engine, exactly as the phone page used to open it; `api` in this page reaches it too.
    const local = await startLocal();
    const { localQueueAudio } = await import('./engine/queue-audio');
    const queue = localQueueAudio();
    if (!queue) throw new Error('The service page must own the queue cache.');
    const catalog = catalogFor((t) => queue.isReady(t));
    // Car-found songs first, then the saved queue and playlists by their original Tracks.
    const library = savedLibrary(n);
    const contexts = new ChainedContexts([catalog, new LibraryContexts(library)]);
    const cars = new CarSources({ contexts, queue, emit: pushSourceUpdates });
    const actor = new ServiceActor({ local, queue, cars, reply: (id, json) => n.apiReply(id, json) });
    const w = window as unknown as ServiceWindow;
    w.__awServiceApi = (json) => { void actor.onRequest(json); };
    const carSong = (t: Track) => { const ready = queue.isReady(t); return songFromTrack(t, ready, ready ? queue.readyUrl(t) : null); };
    // QUEUE-HEARD-001: with the phone app closed, songs the engine finishes are recorded and the Discover queue is
    // topped up here, as the phone page does when it is open.
    const listening = new ServiceListening({
      findTrack: async (key) => (await api.last().catch(() => null))?.items.find((it) => it.track.key === key)?.track ?? null,
      feedback: (kind, t, extra) => api.feedback(kind, t, extra),
      recommend: (o) => api.recommend(o),
      job: (id) => api.job(id),
      last: () => api.last().catch(() => null),
      song: carSong,
      append: pushQueueTopUp,
      wait: phoneWait,
    });
    w.__awServiceState = (json) => { cars.onState(json); listening.onState(json); };
    let similarBusy = false;
    const carTrackFor = async (key: string) => (await api.last().catch(() => null))?.items.find((it) => it.track.key === key)?.track
      ?? catalog.find(key) ?? library.tracks.find((t) => t.key === key) ?? null;
    // CAR-SAVE-HIDDEN-001: the car's star and playlist choice are saved by this engine whenever the phone page is
    // not in front. A page behind the lock screen is frozen and saved them late, or never.
    const saves: CarSaveDeps = {
      findTrack: carTrackFor,
      feedback: (kind, t, extra) => api.feedback(kind, t, extra),
      playlists: () => api.playlists(),
      playlistEdit: (action, body) => api.playlistEdit(action, body),
      eventId: newEventId,
      unsaved: pushCarUnsaved,
    };
    setMediaHandlers({
      catalogSearch: (query, opts) => catalog.searchAll(query, opts),
      identifyAudio: (samples) => catalog.identifyClip(samples),
      feedback: (id, kind, carTrack) => { void carFeedback(id, kind, carTrack, saves).catch(() => undefined); },
      playlistAdd: (id, listId, carTrack) => { void carPlaylistAdd(id, listId, carTrack, saves).catch(() => undefined); },
      // CAR-SIMILAR-001: with the phone closed, the car's Find similar runs here, on the same engine.
      findSimilar: async (id) => {
        if (similarBusy) throw new Error('Already looking for similar songs. Try again when that finishes.');
        similarBusy = true;
        try {
          return await runCarSimilar(id, {
            findTrack: carTrackFor,
            similar: api.similar, job: api.job, wait: phoneWait,
            song: carSong,
          });
        } finally { similarBusy = false; }
      },
      // ARTIST-FAV-CAR-001: with the phone closed, the car's Star the artist button is saved by this engine.
      starArtists: async (id, credit, carTrack) => {
        const t = (await carTrackFor(id)) ?? carTrack ?? null;
        // CAR-ANSWERABLE-001: the car hears which artists this engine really saved.
        const saved: string[] = [];
        for (const name of artistNamesOf(t, credit)) {
          if (await api.editFavArtists({ op: 'add', artist: { name } }).then(() => true).catch(() => false)) saved.push(name);
        }
        return saved;
      },
      // CAR-SETTINGS-001: with the phone closed, the car's EQ / discovery / mood choice is saved by this engine.
      carSettings: (change) => { void applyCarSettings(change, { save: api.putSettings, send: engineSend }).catch(() => { /* resent on the next hello */ }); },
      // CAR-MOOD-001: with the phone closed, the car's queue follows the listening mood from this engine.
      // The queue's songs are looked up once per question (up to 500 of them), not one api.last() each.
      moodOrder: async (req) => {
        const last = await api.last().catch(() => null);
        const known = new Map((last?.items ?? []).map((it) => [it.track.key, it.track] as const));
        const findTrack = (key: string) => known.get(key) ?? catalog.find(key) ?? library.tracks.find((t) => t.key === key) ?? null;
        return runCarMood(req, { findTrack, mood: api.mood });
      },
    });
    n.apiReady();
    // RADIO-001: the service page remains alive with the phone closed, naming broadcasts and
    // crediting only unique, recognised music actually consumed by the same native engine.
    void radioSession.restore();
    setInterval(() => void radioSession.restore(), 5000);
  } catch (e) {
    try { n.engineFailed(opened); } catch { /* the bridge is gone with the page */ }
    throw e;
  }
}

async function start(): Promise<void> {
  const n = (window as unknown as ServiceWindow).AirwaveNative;
  if (fullServiceBridge(n) && claimEngine(n)) await startService(n);
  else await startMetadataOnly();
  n?.catalogReady?.();
}

void start().catch((e) => console.error('car catalogue engine failed to start', e));
