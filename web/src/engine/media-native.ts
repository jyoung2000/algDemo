/**
 * Bridge from the web player to the Android native MediaSession / Android Auto (MEDIA-NATIVE-001).
 *
 * The native side ([MediaHub]/[WebPlayer]/[PlaybackService] in the Android shell) never renders audio.
 * It mirrors the snapshot this module pushes — now playing, the playhead, the up-next queue and the
 * browsable library (song list + playlists) — and forwards transport commands back here, where the
 * Web Audio engine (with the equaliser, crossfade and mixer) actually plays. That is how the lock
 * screen, Bluetooth, the quick-panel card and Android Auto all control the one real playback.
 *
 * Only active inside the Android app, where `AirwaveNative.media` exists. In a browser or the Windows
 * shell every call here is a no-op, so it is safe to wire unconditionally.
 */
import type { Track } from '../api';

export interface NativeSong {
  id: string;
  title: string;
  artist: string;
  album?: string | null;
  artwork?: string | null;
  durationMs: number;
  ready: boolean;
  /** The download link of the complete audio held on the phone, so the native engine can play this
   *  exact file without the page. Sent only while `ready`. */
  source?: string | null;
}

export interface NativeFolder {
  id: string;
  title: string;
  songs: NativeSong[];
  /** ALBUM-SAVE-001: a saved album, listed under Albums in the car rather than Playlists. */
  album?: boolean;
  artist?: string;
  artwork?: string | null;
}

/** ALBUM-CAR-001: an album found by a car search, opened, its songs carrying the album as context. */
export interface NativeAlbum {
  id: string;
  title: string;
  artist: string;
  artwork: string | null;
  songs: NativeSong[];
}

/** What the page answers a car search with: songs, albums, and the song to play for a voice request. */
export interface CatalogAnswer {
  songs: NativeSong[];
  albums?: NativeAlbum[];
  /** Set when the words name an album (or the request asked for one): play the album from this song. */
  play?: string | null;
}

export interface NativeState {
  playing: boolean;
  hasTrack: boolean;
  mediaId: string | null;
  title: string;
  artist: string;
  album: string | null;
  artwork: string | null;
  durationMs: number;
  positionMs: number;
  canNext: boolean;
  canPrev: boolean;
  shuffle: boolean;
  repeat: number; // 0 off, 1 one, 2 all
  queue: NativeSong[];
  queueIndex: number;
}

/** Transport the native surfaces (lock screen, Bluetooth, car, voice) ask the page to perform. */
export interface MediaHandlers {
  play?: () => void;
  pause?: () => void;
  next?: () => void;
  prev?: () => void;
  seek?: (positionMs: number) => void;
  /** Play a specific library song by its track key (an Android Auto tap, or a resolved voice query). */
  playId?: (id: string) => void;
  /** Play the queue item at this index. */
  playIndex?: (index: number) => void;
  /** A raw search query (voice), when the native side could not resolve it to a song itself. */
  search?: (query: string) => void;
  /** Catalogue lookup for typed/voice car search; results are metadata, not automatic queue adds. */
  catalogSearch?: (query: string, opts: { album: boolean }) => Promise<NativeSong[] | CatalogAnswer> | NativeSong[] | CatalogAnswer;
  shuffle?: (on: boolean) => void;
  repeat?: (mode: number) => void;
}

type NativeMedia = { media?: (json: string) => void };
const nativeMedia = (): NativeMedia | undefined =>
  typeof window === 'undefined' ? undefined : (window as unknown as { AirwaveNative?: NativeMedia }).AirwaveNative;

/** True only inside the Android shell, where a native MediaSession and Android Auto exist. */
export const mediaNativeAvailable = (): boolean => typeof nativeMedia()?.media === 'function';

/** ALBUM-CAR-001: an album song's car id names the album, so a tap plays the album around it. */
export const carAlbumTrackId = (albumId: string, key: string): string => `calbum/${encodeURIComponent(albumId)}/track/${encodeURIComponent(key)}`;

export function decodeCarAlbumId(id: string): { albumId: string; key: string } | null {
  const match = /^calbum\/([^/]+)\/track\/([^/]+)$/.exec(id);
  if (!match) return null;
  try {
    return { albumId: decodeURIComponent(match[1]!), key: decodeURIComponent(match[2]!) };
  } catch {
    return null;
  }
}

/** Playlist rows carry context in their Android Auto mediaId; a plain track key has none. */
export function decodePlaylistMediaId(id: string): { listId: string; key: string } | null {
  const match = /^playlist\/([^/]+)\/track\/([^/]+)$/.exec(id);
  if (!match) return null;
  try {
    const listId = decodeURIComponent(match[1]!);
    const key = decodeURIComponent(match[2]!);
    return listId && key ? { listId, key } : null;
  } catch { return null; }
}

let handlers: MediaHandlers = {};
/** Register transport handlers. Partial and merged, so App (queue/library) and Player (play/seek) can
 *  each register their own slice without clobbering the other. */
export function setMediaHandlers(partial: MediaHandlers): void {
  handlers = { ...handlers, ...partial };
}

const DEFAULT_STATE: NativeState = {
  playing: false,
  hasTrack: false,
  mediaId: null,
  title: 'Airwave Discovery',
  artist: '',
  album: null,
  artwork: null,
  durationMs: -1,
  positionMs: 0,
  canNext: false,
  canPrev: false,
  shuffle: false,
  repeat: 0,
  queue: [],
  queueIndex: 0,
};

let lastState: NativeState = { ...DEFAULT_STATE };
let lastLibrary: { songs: NativeSong[]; playlists: NativeFolder[] } = { songs: [], playlists: [] };

/** Push now playing + the up-next queue. Small and frequent (play/pause, seek, skip, track change). */
export function pushMediaState(partial: Partial<NativeState>): void {
  lastState = { ...lastState, ...partial };
  send({ state: lastState });
}

/** Push the browsable library (the song list and the playlists). Larger and rare (list changes). */
export function pushMediaLibrary(songs: NativeSong[], playlists: NativeFolder[]): void {
  lastLibrary = { songs, playlists };
  send({ state: lastState, library: lastLibrary });
}

function send(payload: { state: NativeState; library?: { songs: NativeSong[]; playlists: NativeFolder[] }; search?: { requestId: string; query: string; songs: NativeSong[]; albums?: NativeAlbum[]; play?: string; error?: string } }): void {
  const n = nativeMedia();
  if (typeof n?.media !== 'function') return;
  try {
    n.media(JSON.stringify(payload));
  } catch {
    /* serialisation failed or the snapshot was too large: drop it rather than crash the page */
  }
}

/** Map an app [Track] to the native song shape. Duration is seconds in the app, milliseconds here. */
export function songFromTrack(track: Track, ready: boolean, source?: string | null): NativeSong {
  return {
    id: track.key,
    title: track.title,
    artist: track.artist ?? track.artists?.join(', ') ?? '',
    album: track.album ?? null,
    artwork: track.artwork ?? null,
    durationMs: typeof track.duration === 'number' && track.duration > 0 ? Math.round(track.duration * 1000) : -1,
    ready,
    source: ready ? source ?? null : null,
  };
}

/** Install the entry point the native layer calls to drive the page (`window.__awMediaCmd`). */
export function installMediaCommands(): void {
  if (typeof window === 'undefined') return;
  (window as unknown as { __awMediaCmd?: (json: string) => void }).__awMediaCmd = (json: string) => {
    let cmd: { type?: string; requestId?: string; positionMs?: number; index?: number; id?: string; query?: string; on?: boolean; mode?: number; album?: boolean };
    try {
      cmd = JSON.parse(json);
    } catch {
      return;
    }
    switch (cmd.type) {
      case 'play': handlers.play?.(); break;
      case 'pause': handlers.pause?.(); break;
      case 'next': handlers.next?.(); break;
      case 'prev': handlers.prev?.(); break;
      case 'seek': handlers.seek?.(Math.max(0, Number(cmd.positionMs) || 0)); break;
      case 'playId': if (cmd.id) handlers.playId?.(String(cmd.id)); break;
      case 'playIndex': handlers.playIndex?.(Math.max(0, Number(cmd.index) || 0)); break;
      case 'search': handlers.search?.(String(cmd.query ?? '')); break;
      case 'catalogSearch': {
        const requestId = String(cmd.requestId ?? '');
        const query = String(cmd.query ?? '');
        if (!requestId || requestId.length > 100 || query.length > 200) break;
        void (async () => {
          try {
            if (!handlers.catalogSearch) throw new Error('Open Airwave on your phone to search music.');
            const answer = await handlers.catalogSearch(query, { album: cmd.album === true });
            const songs = (Array.isArray(answer) ? answer : answer.songs).slice(0, 25);
            const albums = Array.isArray(answer) ? [] : (answer.albums ?? []).slice(0, 5);
            const play = Array.isArray(answer) ? null : answer.play ?? null;
            send({ state: lastState, search: { requestId, query, songs, ...(albums.length ? { albums } : {}), ...(play ? { play } : {}) } });
          } catch (e) {
            send({ state: lastState, search: { requestId, query, songs: [], error: String((e as Error)?.message ?? 'Music search failed').slice(0, 200) } });
          }
        })();
        break;
      }
      case 'shuffle': handlers.shuffle?.(Boolean(cmd.on)); break;
      case 'repeat': handlers.repeat?.(Number(cmd.mode) || 0); break;
      default: break;
    }
  };
}

// Installed on import so the native command sink always finds the hook, even before React mounts.
installMediaCommands();
