/**
 * FAST-PLAY-002. Owner: "I want to be able to play a song instantly when i click on it on all platforms".
 *
 * The one warmer the page uses, wired to whichever shell it is running in:
 *   - the Windows app names the file in its own stream resolver (`AirwaveNative.warmStream`);
 *   - the Android app hands it to the service, which runs yt-dlp off the main thread (`op: 'warm'`);
 *   - a plain browser has neither, so nothing is asked of it.
 *
 * Only links the downloader itself accepts are ever sent (`urlAllowedFor('yt-dlp', …)`), the same
 * gate the stream endpoint applies, so warming can never widen what the app will fetch.
 */
import { api, type Track } from '../api';
import { urlAllowedFor } from './downloads';
import { localLibrary, sourceUrlFor } from './local-audio';
import { PlayWarmer } from './warm-play';

type Shell = { warmStream?: (url: string) => void; engine?: (json: string) => void };
const shell = (): Shell | undefined =>
  typeof window === 'undefined' ? undefined : (window as unknown as { AirwaveNative?: Shell }).AirwaveNative;

/** Ask this shell to name a source's audio file now. Fire and forget; nothing waits on it. */
export function warmSource(source: string | null | undefined): void {
  if (!source || !urlAllowedFor('yt-dlp', source)) return;
  const s = shell();
  try {
    if (typeof s?.warmStream === 'function') s.warmStream(source);
    else if (typeof s?.engine === 'function') s.engine(JSON.stringify({ op: 'warm', sources: [source] }));
  } catch {
    /* a closed bridge: warming is an optimisation, never an error the listener should see */
  }
}

let instance: PlayWarmer | null = null;

/** The page's warmer. One per page, so a row hovered on two screens is still warmed once. */
export function warmer(): PlayWarmer {
  instance ??= new PlayWarmer({
    known: (track: Track) => (track.provider === 'ytmusic' ? sourceUrlFor(track.platform_id) : null),
    find: async (track: Track) => {
      const r = await api.fullSong(track);
      return r.url ?? sourceUrlFor(r.id);
    },
    resolve: warmSource,
    held: (source: string) => localLibrary.status(source) === 'ready',
  });
  return instance;
}

/** For tests: forget the warmer so the next call builds a fresh one. */
export function resetWarmerForTests(): void {
  instance = null;
}
