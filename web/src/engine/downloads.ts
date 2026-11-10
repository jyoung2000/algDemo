/**
 * The page's side of the downloaders (yt-dlp and spotDL).
 *
 * The page never runs a tool and never names a flag. It hands the native shell a URL, a tool and a
 * format; the shell checks the URL against the lists below, builds every argument itself, and keeps
 * the files. The lists here are mirrored by windows/downloads.cjs and android/.../Downloads.kt;
 * download-hosts.test.ts fails when the three disagree.
 */

export type DlTool = 'yt-dlp' | 'spotdl';
export type DlFormat = 'mp3' | 'm4a' | 'opus' | 'flac' | 'wav' | 'original';

// "original" first: it is the default and the only choice that cannot lose quality. The rest follow
// in descending fidelity-per-byte. Downloads.tsx renders this order and Downloads.kt accepts all six.
export const DL_FORMATS: readonly DlFormat[] = ['original', 'opus', 'm4a', 'mp3', 'flac', 'wav'];

/** Hosts yt-dlp may be pointed at. */
export const YTDLP_HOSTS: readonly string[] = [
  'youtu.be',
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'soundcloud.com',
  'www.soundcloud.com',
  'm.soundcloud.com',
  'on.soundcloud.com',
  'audius.co',
];
/** Artist-owned Bandcamp subdomains only; the main site is not a track URL. */
export const YTDLP_SUFFIXES: readonly string[] = ['.bandcamp.com'];

/** spotDL takes a Spotify track link and nothing else. */
export const SPOTDL_HOSTS: readonly string[] = ['open.spotify.com'];

/** Only a direct, single audio file under an Archive item; never arbitrary Archive paths. */
function archiveAudioUrl(u: URL): boolean {
  if (u.hostname !== 'archive.org' || u.search || u.hash || (u.port && u.port !== '443')) return false;
  try {
    const path = decodeURIComponent(u.pathname);
    return !path.includes('..') && /^\/download\/[A-Za-z0-9][A-Za-z0-9._-]{1,100}\/[A-Za-z0-9][A-Za-z0-9._ ()&+-]{0,180}\.(?:mp3|m4a|flac)$/i.test(path);
  } catch { return false; }
}

/**
 * A single public HearThis track page, compared against the RAW link the page handed over.
 * `new URL()` normalises away dot segments and empty `?`/`#` delimiters, so matching only the
 * parsed path let `/a/b/../c/` and `/a/b/?` through on web/Windows while Android (java.net.URI,
 * which keeps both) rejected them. Requiring raw === canonical keeps all three shells identical.
 */
function hearThisTrackUrl(u: URL, raw: string): boolean {
  return u.hostname === 'hearthis.at' && !u.search && !u.hash && (!u.port || u.port === '443') &&
    raw === `https://hearthis.at${u.pathname}` &&
    /^\/[A-Za-z0-9][A-Za-z0-9._-]{0,100}\/[A-Za-z0-9][A-Za-z0-9._-]{0,180}\/$/.test(u.pathname);
}

export interface DlToolHealth {
  id: 'yt-dlp' | 'spotdl' | 'ffmpeg';
  present: boolean;
  version: string | null;
  /** What this app actually runs: the real tool, or a stated stand-in. */
  method: string;
  detail: string | null;
}

export interface DlFile {
  name: string;
  bytes: number;
}

export interface DlJob {
  id: string;
  url: string;
  tool: DlTool;
  format: DlFormat;
  label: string;
  state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  stage: string;
  percent: number | null;
  message: string | null;
  error: string | null;
  files: DlFile[];
  /** Human-readable place the files ended up, once done. */
  saved_to: string | null;
}

export interface DlHealth {
  ready: boolean;
  /** False on Android: the spotdl program cannot run there, so the page does spotDL's method with yt-dlp. */
  runs_spotdl: boolean;
  tools: DlToolHealth[];
  saves_to: string;
  /** Bytes in the shell's private queue-audio cache. Absent on shells older than this contract. */
  cache_bytes?: number;
  /** The size limit that cache is held under, in bytes. */
  cache_limit_bytes?: number;
}

declare global {
  interface Window {
    __awDl?: (id: number, json: string) => void;
  }
}

type Native = {
  downloads?: (id: number, json: string) => void;
  playback?: (playing: boolean) => void;
  playbackState?: (json: string) => void;
};
const native = (): Native | undefined => (typeof window === 'undefined' ? undefined : (window as unknown as { AirwaveNative?: Native }).AirwaveNative);

/** True inside the Windows and Android apps. A plain browser has no downloader to talk to. */
export const downloadsAvailable = (): boolean => typeof native()?.downloads === 'function';
/** Hints native shells to keep the playback process awake; this is not a native media player. */
export const playbackActive = (playing: boolean, title = 'Airwave Discovery'): void => {
  const n = native();
  if (n?.playbackState) n.playbackState(JSON.stringify({ playing, title }));
  else n?.playback?.(playing);
};

const waiting = new Map<number, { ok: (v: unknown) => void; no: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
let seq = 1;

function install(): void {
  window.__awDl = (id, json) => {
    const w = waiting.get(id);
    if (!w) return;
    waiting.delete(id);
    clearTimeout(w.timer);
    try {
      const out = JSON.parse(json) as { error?: string };
      if (out.error) w.no(new Error(out.error));
      else w.ok(out);
    } catch (e) {
      w.no(e as Error);
    }
  };
}

function call<T>(payload: Record<string, unknown>, waitMs = 30_000): Promise<T> {
  const n = native();
  if (!n?.downloads) return Promise.reject(new Error('Downloads are only available in the Windows and Android apps.'));
  if (!window.__awDl) install();
  return new Promise<T>((resolve, reject) => {
    const id = seq++;
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error('The downloader did not answer.'));
    }, waitMs);
    waiting.set(id, { ok: resolve as (v: unknown) => void, no: reject, timer });
    n.downloads!(id, JSON.stringify(payload));
  });
}

/** Whether the shell can run spotDL for Spotify search (Windows only). */
export const spotifySearchAvailable = (): boolean => downloadsAvailable();

/** Spotify search through spotDL in the Windows shell. Resolves to spotDL's saved-song records. */
export const spotifySearchRaw = (query: string, limit: number) =>
  call<{ songs: unknown[] }>({ op: 'spotify-search', query, limit }, 60_000);

export const dl = {
  health: () => call<DlHealth>({ op: 'health' }),
  start: (url: string, tool: DlTool, format: DlFormat, label: string, cache = false, background = false) => call<{ job: DlJob }>({ op: 'start', url, tool, format, label, cache, background }),
  keep: (url: string) => call<{ ok?: boolean; job?: DlJob | null; alreadyKept?: boolean; file?: DlFile | null; saved_to?: string | null }>({ op: 'keep', url }),
  /** RESET-APP-001: empty the evictable audio cache. Kept copies in the Music folder are untouched. */
  cacheClear: () => call<{ removed: number; bytes: number }>({ op: 'cache-clear' }, 120_000),
  cacheConfig: (limitGb: number, protectedUrls: string[], wanted?: string[], parallel?: number) => call<{ bytes: number; limitBytes: number }>({ op: 'cache-config', limitGb, protected: protectedUrls, ...(wanted ? { wanted } : {}), ...(parallel ? { parallel } : {}) }),
  chooseFolder: () => call<{ saves_to: string }>({ op: 'choose-folder' }, 120_000),
  jobs: () => call<{ jobs: DlJob[] }>({ op: 'jobs' }),
  cancel: (id: string) => call<{ ok: boolean }>({ op: 'cancel', id }),
  forget: (id: string) => call<{ ok: boolean }>({ op: 'forget', id }),
  reveal: (id: string) => call<{ ok: boolean }>({ op: 'reveal', id }),
  /**
   * LIST-FOLDER-001: lay a list's downloaded songs out in one folder named after it, numbered in play
   * order, and open that folder in the system's file manager. `held` is how many songs it holds.
   */
  openList: (name: string, songs: { url: string; title: string; artist: string }[]) =>
    call<{ ok: boolean; held: number; total: number; folder?: string }>({ op: 'open-list', name, songs }, 120_000),
  /** Whether the shell holds a finished download for a link (indexed by link, kept across restarts), or is fetching it. */
  /** `kept` is a permanent Music-folder copy; `cached` is the evictable queue cache. `file` is either. */
  local: (url: string) => call<{ file: DlFile | null; kept?: boolean; cached?: boolean; running: boolean; error?: string | null }>({ op: 'local', url }),
};

/** The same check the native shells make, so the button can say no before asking. */
export function urlAllowedFor(tool: DlTool, raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || raw.length > 500 || /[\s\x00-\x1f]/.test(raw)) return false;
  const host = u.hostname.toLowerCase();
  if (tool === 'spotdl') return SPOTDL_HOSTS.includes(host) && /^\/(intl-[a-z]{2}(-[a-z]{2})?\/)?track\/[A-Za-z0-9]{10,30}\/?$/.test(u.pathname);
  return archiveAudioUrl(u) || hearThisTrackUrl(u, String(raw)) || YTDLP_HOSTS.includes(host) || (YTDLP_SUFFIXES.some(s => host.endsWith(s)) && host !== 'www.bandcamp.com' && /^\/track\/[^/]+\/?$/.test(u.pathname));
}

export interface Target {
  tool: DlTool;
  url: string;
}

export interface TrackLike {
  provider: string;
  platform_id?: string;
  url?: string;
}

/**
 * Which tool and link can fetch a song, without a network call. Songs found on Deezer or Apple Music
 * have no link yt-dlp understands; those need a YouTube Music match first (`null` here).
 */
export function targetFor(t: TrackLike): Target | null {
  if (t.provider === 'spotify' && t.url && urlAllowedFor('spotdl', t.url)) return { tool: 'spotdl', url: t.url };
  if (t.provider === 'ytmusic' && t.platform_id && /^[A-Za-z0-9_-]{11}$/.test(t.platform_id)) return { tool: 'yt-dlp', url: `https://music.youtube.com/watch?v=${t.platform_id}` };
  if (t.url && ['ytmusic', 'soundcloud', 'bandcamp', 'audius', 'hearthis', 'archive'].includes(t.provider) && urlAllowedFor('yt-dlp', t.url)) return { tool: 'yt-dlp', url: t.url };
  return null;
}

export const matchTarget = (videoId: string): Target | null => (/^[A-Za-z0-9_-]{11}$/.test(videoId) ? { tool: 'yt-dlp', url: `https://music.youtube.com/watch?v=${videoId}` } : null);
