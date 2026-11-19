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
  /** CAR-SEARCH-TYPES-001: what kind of result a car search song is, for the car's icons. */
  kinds?: CarKind[];
}

/** CAR-SEARCH-TYPES-001: the kinds the car's search icons narrow to. */
export type CarKind = 'single' | 'album' | 'feature' | 'lyrics' | 'artist';
/** CAR-SEARCH-TYPES-001: the kind a car search asked for (spoken lead words or the Search tab). */
export type CarSearchMode = 'all' | 'artists' | 'singles' | 'albums' | 'features' | 'lyrics';
const CAR_MODES: readonly string[] = ['all', 'artists', 'singles', 'albums', 'features', 'lyrics'];

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
  repeat: number; // REPEAT-COUNT-001: 0 off, 1 infinite, 3 one extra play, 4 two extra plays (2 was repeat-list, retired)
  queue: NativeSong[];
  queueIndex: number;
  /** CAR-ACTIONS-001: the song now playing is starred (liked) / disliked, for the car's buttons. */
  liked: boolean;
  disliked: boolean;
}

/** CAR-ACTIONS-001: the judgements the car's Star and Dislike buttons can send. */
export type CarFeedbackKind = 'like' | 'unlike' | 'dislike' | 'undislike';
const CAR_FEEDBACK: readonly string[] = ['like', 'unlike', 'dislike', 'undislike'];

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
  catalogSearch?: (query: string, opts: { album: boolean; mode?: CarSearchMode }) => Promise<NativeSong[] | CatalogAnswer> | NativeSong[] | CatalogAnswer;
  /** CAR-SEARCH-TYPES-001: the car's Identify icon: name the music in this 16 kHz mono clip. */
  identifyAudio?: (samples: Float32Array) => Promise<NativeSong[]>;
  shuffle?: (on: boolean) => void;
  repeat?: (mode: number) => void;
  /** CAR-ACTIONS-001: Star or Dislike pressed in the car (or queued while the app was closed). */
  /** CAR-RADIO-CONTROLS-001: `track` is the radio song's own Track when the car starred a song on air. */
  feedback?: (id: string, kind: CarFeedbackKind, track?: Track) => void;
  /** CAR-CONTROLS-001: the car's playlist picker (after a row's star) chose playlist `list` for song `id`. */
  playlistAdd?: (id: string, list: string, track?: Track) => void;
  /** CAR-SIMILAR-001: the car's Find similar button: add songs that sound like song `id` to the list. */
  findSimilar?: (id: string) => Promise<{ added: number; minimum: number; reason: string; songs: NativeSong[] }>;
  /** CAR-MOOD-001: the mood order of the car's movable songs (media ids), with the phone app closed. */
  moodOrder?: (req: { current: string | null; upcoming: string[]; signal: { id: string; kind: string } | null }) => Promise<{ order: string[]; moved: string[]; changed: boolean; leading: string[] }>;
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

/**
 * SERVICE-API-001: the song a car id names in the context the service engine answered for it, with
 * the whole list; null unless the answer is well formed and its song at `index` is exactly that id's
 * track (a stale or mismatched answer plays nothing).
 */
export function pickCarContext(ctx: unknown, id: string): { track: Track; tracks: Track[] } | null {
  const c = ctx as { tracks?: unknown; ids?: unknown; index?: unknown } | null;
  if (!c || !Array.isArray(c.tracks) || !Array.isArray(c.ids) || c.tracks.length !== c.ids.length || c.tracks.length > 2000) return null;
  if (typeof c.index !== 'number' || !Number.isInteger(c.index) || c.index < 0 || c.index >= c.tracks.length) return null;
  const tracks = c.tracks as Track[];
  if (!tracks.every(t => t && typeof t === 'object' && typeof t.key === 'string' && t.key && typeof t.title === 'string')) return null;
  const key = decodeCarAlbumId(id)?.key ?? decodePlaylistMediaId(id)?.key ?? (id.includes('/') ? null : id);
  const track = tracks[c.index]!;
  if (key === null || track.key !== key || c.ids[c.index] !== id) return null;
  return { track, tracks };
}

/** CAR-LOCAL-001: the car's "On this phone" list id (MediaHub.PHONE_LIST): songs held on the phone. */
export const PHONE_LIST = 'airwave:on-this-phone';

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
  title: 'jPlay',
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
  liked: false,
  disliked: false,
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

function send(payload: { state: NativeState; library?: { songs: NativeSong[]; playlists: NativeFolder[] }; search?: { requestId: string; query: string; songs: NativeSong[]; albums?: NativeAlbum[]; play?: string; error?: string }; identify?: { requestId: string; songs: NativeSong[]; error?: string };
  similar?: { requestId: string; id: string; added: number; minimum?: number; reason?: string; songs: NativeSong[]; error?: string };
  mood?: { requestId: string; order: string[]; moved: string[]; changed: boolean; leading: string[]; error?: string } }): void {
  const n = nativeMedia();
  if (typeof n?.media !== 'function') return;
  try {
    n.media(JSON.stringify(payload));
  } catch {
    /* serialisation failed or the snapshot was too large: drop it rather than crash the page */
  }
}

/**
 * SERVICE-API-001: complete files the service's queue cache now holds (or no longer holds) for songs
 * in the car-selected list, so the native player can swap in the local file for those known ids.
 */
export function pushSourceUpdates(updates: { id: string; key: string; ready: boolean; source: string | null }[]): void {
  const n = nativeMedia();
  if (typeof n?.media !== 'function' || !updates.length) return;
  try {
    n.media(JSON.stringify({ sourceUpdates: updates }));
  } catch {
    /* as send(): drop rather than crash */
  }
}

/** What the native side was last given for each track key (bounded), so only new or changed Tracks are sent. */
const rememberedTracks = new Map<string, string>();
const TRACK_CHUNK = 100;
const MAX_TRACK_CHARS = 16_000;

/**
 * NATIVE-COLD-STATE-001: the original Tracks of the library's songs, kept natively by exact key so
 * the service engine can acquire a saved song's full recording after a cold car start without
 * rebuilding it from its title. Sent apart from the library push (in chunks), new or changed only.
 */
export function pushMediaTracks(tracks: readonly Track[]): void {
  const n = nativeMedia();
  if (typeof n?.media !== 'function') return;
  const fresh: Track[] = [];
  for (const t of tracks) {
    if (!t?.key) continue;
    let json: string;
    try { json = JSON.stringify(t); } catch { continue; }
    if (json.length > MAX_TRACK_CHARS || rememberedTracks.get(t.key) === json) continue;
    rememberedTracks.delete(t.key);
    rememberedTracks.set(t.key, json);
    fresh.push(t);
  }
  while (rememberedTracks.size > 5000) rememberedTracks.delete(rememberedTracks.keys().next().value!);
  for (let i = 0; i < fresh.length; i += TRACK_CHUNK) {
    try {
      n.media(JSON.stringify({ rememberTracks: fresh.slice(i, i + TRACK_CHUNK) }));
    } catch {
      /* as send(): drop rather than crash */
    }
  }
}

/** CAR-RADIO-CONTROLS-001: a Track the native side carried with a car command, only if it is the song named. */
function carTrack(raw: unknown, id: string): Track | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const t = raw as Track;
  return typeof t.key === 'string' && t.key === id && typeof t.title === 'string' && t.title ? t : undefined;
}

/** For tests: forget what was sent. */
export function resetRememberedTracksForTest(): void { rememberedTracks.clear(); }

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
/** CAR-SEARCH-TYPES-001: the car's clip (base64 of 16-bit little-endian mono PCM) as samples in -1..1. */
export function samplesFromPcm16(b64: string): Float32Array {
  const bin = atob(b64);
  const n = bin.length >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    if (v >= 0x8000) v -= 0x10000;
    out[i] = v / 32768;
  }
  return out;
}

export function installMediaCommands(): void {
  if (typeof window === 'undefined') return;
  (window as unknown as { __awMediaCmd?: (json: string) => void }).__awMediaCmd = (json: string) => {
    let cmd: { type?: string; requestId?: string; positionMs?: number; index?: number; id?: string; query?: string; on?: boolean; mode?: number | string; album?: boolean; kind?: string; pcm?: string; list?: string; track?: unknown; current?: unknown; upcoming?: unknown; signal?: unknown };
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
            if (!handlers.catalogSearch) throw new Error('Open jPlay on your phone to search music.');
            const mode = typeof cmd.mode === 'string' && CAR_MODES.includes(cmd.mode) ? (cmd.mode as CarSearchMode) : 'all';
            const answer = await handlers.catalogSearch(query, { album: cmd.album === true, mode });
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
      case 'identifyAudio': {
        const requestId = String(cmd.requestId ?? '');
        if (!requestId || requestId.length > 100 || typeof cmd.pcm !== 'string' || cmd.pcm.length > 2_000_000) break;
        const pcm = cmd.pcm;
        void (async () => {
          try {
            if (!handlers.identifyAudio) throw new Error('Open jPlay on your phone to identify music.');
            const songs = (await handlers.identifyAudio(samplesFromPcm16(pcm))).slice(0, 10);
            send({ state: lastState, identify: { requestId, songs } });
          } catch (e) {
            send({ state: lastState, identify: { requestId, songs: [], error: String((e as Error)?.message ?? 'Could not identify the music').slice(0, 200) } });
          }
        })();
        break;
      }
      case 'findSimilar': {
        const requestId = String(cmd.requestId ?? '');
        const id = typeof cmd.id === 'string' ? cmd.id : '';
        if (!requestId || requestId.length > 100 || !id || id.length > 500) break;
        void (async () => {
          try {
            if (!handlers.findSimilar) throw new Error('Open jPlay on your phone to find similar songs.');
            const out = await handlers.findSimilar(id);
            send({ state: lastState, similar: { requestId, id, added: out.added, minimum: out.minimum, reason: out.reason, songs: out.songs.slice(0, 10) } });
          } catch (e) {
            send({ state: lastState, similar: { requestId, id, added: 0, songs: [], error: String((e as Error)?.message ?? 'Could not find similar songs').slice(0, 200) } });
          }
        })();
        break;
      }
      case 'moodOrder': {
        const requestId = String(cmd.requestId ?? '');
        const upcoming = Array.isArray(cmd.upcoming) ? (cmd.upcoming as unknown[]).filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 500).slice(0, 500) : [];
        if (!requestId || requestId.length > 100) break;
        const current = typeof cmd.current === 'string' && cmd.current.length <= 500 ? cmd.current : null;
        const s = cmd.signal as { id?: unknown; kind?: unknown } | null | undefined;
        const signal = s && typeof s.id === 'string' && typeof s.kind === 'string' && s.id.length <= 500 ? { id: s.id, kind: s.kind.slice(0, 20) } : null;
        void (async () => {
          try {
            if (!handlers.moodOrder) throw new Error('The listening mood needs the app engine.');
            const out = await handlers.moodOrder({ current, upcoming, signal });
            send({ state: lastState, mood: { requestId, order: out.order.slice(0, 500), moved: out.moved.slice(0, 500), changed: out.changed, leading: out.leading.slice(0, 3) } });
          } catch (e) {
            send({ state: lastState, mood: { requestId, order: upcoming, moved: [], changed: false, leading: [], error: String((e as Error)?.message ?? 'Could not arrange the queue').slice(0, 200) } });
          }
        })();
        break;
      }
      case 'shuffle': handlers.shuffle?.(Boolean(cmd.on)); break;
      case 'repeat': handlers.repeat?.(Number(cmd.mode) || 0); break;
      case 'feedback':
        if (cmd.id && typeof cmd.kind === 'string' && CAR_FEEDBACK.includes(cmd.kind)) {
          const t = carTrack(cmd.track, String(cmd.id));
          if (t) handlers.feedback?.(String(cmd.id), cmd.kind as CarFeedbackKind, t); else handlers.feedback?.(String(cmd.id), cmd.kind as CarFeedbackKind);
        }
        break;
      case 'playlistAdd':
        if (typeof cmd.id === 'string' && cmd.id && typeof cmd.list === 'string' && cmd.list && cmd.list.length <= 200) {
          const t = carTrack(cmd.track, cmd.id);
          if (t) handlers.playlistAdd?.(cmd.id, cmd.list, t); else handlers.playlistAdd?.(cmd.id, cmd.list);
        }
        break;
      default: break;
    }
  };
}

// Installed on import so the native command sink always finds the hook, even before React mounts.
installMediaCommands();
