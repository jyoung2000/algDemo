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
];

/** spotDL takes a Spotify track link and nothing else. */
export const SPOTDL_HOSTS: readonly string[] = ['open.spotify.com'];

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
}

declare global {
  interface Window {
    __awDl?: (id: number, json: string) => void;
  }
}

type Native = { downloads?: (id: number, json: string) => void };
const native = (): Native | undefined => (typeof window === 'undefined' ? undefined : (window as unknown as { AirwaveNative?: Native }).AirwaveNative);

/** True inside the Windows and Android apps. A plain browser has no downloader to talk to. */
export const downloadsAvailable = (): boolean => typeof native()?.downloads === 'function';

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
  start: (url: string, tool: DlTool, format: DlFormat, label: string) => call<{ job: DlJob }>({ op: 'start', url, tool, format, label }),
  jobs: () => call<{ jobs: DlJob[] }>({ op: 'jobs' }),
  cancel: (id: string) => call<{ ok: boolean }>({ op: 'cancel', id }),
  forget: (id: string) => call<{ ok: boolean }>({ op: 'forget', id }),
  reveal: (id: string) => call<{ ok: boolean }>({ op: 'reveal', id }),
  /** Whether the shell holds a finished download for a link (indexed by link, kept across restarts), or is fetching it. */
  local: (url: string) => call<{ file: DlFile | null; running: boolean }>({ op: 'local', url }),
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
  return YTDLP_HOSTS.includes(host);
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
  if (t.url && (t.provider === 'ytmusic' || t.provider === 'soundcloud') && urlAllowedFor('yt-dlp', t.url)) return { tool: 'yt-dlp', url: t.url };
  return null;
}

export const matchTarget = (videoId: string): Target | null => (/^[A-Za-z0-9_-]{11}$/.test(videoId) ? { tool: 'yt-dlp', url: `https://music.youtube.com/watch?v=${videoId}` } : null);
