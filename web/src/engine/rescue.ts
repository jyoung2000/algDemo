/**
 * Never leave a song with nowhere to play (NP-ALWAYS-001).
 *
 * The owner's screenshot: "No player here for this song. Open it in its app.", no progress bar, a
 * dead play button and a link out. It happens when YouTube's iframe refuses the video (age gate,
 * embedding off, a region) or when no video was found at all, and Deezer has no preview either —
 * the app had nothing left to try, so it gave up and said so.
 *
 * But it is not out of options: the shells carry yt-dlp, and the song is usually carrying a link to
 * a host yt-dlp can fetch. So instead of giving up, the app downloads the song and plays it on a
 * deck — the whole song, through the equaliser and mixer. This module decides which link to hand
 * the shell, and refuses the ones yt-dlp cannot turn into audio (a search page, a Spotify track,
 * an artist page).
 */

import { YTDLP_HOSTS } from './downloads';
import { sourceUrlFor } from './local-audio';

/** A YouTube video id as the watch links spell it. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * Is this a link yt-dlp can turn into one song's audio?
 *
 * Host *and* shape: music.youtube.com is allowed, but music.youtube.com/search?q=batman names no
 * video and a download of it fails, which would read to the listener as the app breaking rather
 * than as a song it cannot get.
 */
export const downloadableTrack = (url: string): boolean => {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname.toLowerCase();
  if (!YTDLP_HOSTS.includes(host)) return false;
  if (host === 'youtu.be') return VIDEO_ID.test(u.pathname.replace(/^\//, ''));
  if (host.endsWith('youtube.com')) {
    if (u.pathname === '/watch') return VIDEO_ID.test(u.searchParams.get('v') ?? '');
    // /shorts/<id> and /embed/<id> are the same video by another address.
    const m = /^\/(?:shorts|embed|v)\/([^/?#]+)/.exec(u.pathname);
    return m ? VIDEO_ID.test(m[1] ?? '') : false;
  }
  // soundcloud.com/<artist>/<track>, and nothing shorter: /<artist> is a profile, /search is a page.
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return false;
  return !['search', 'discover', 'stream', 'you', 'upload', 'tags'].includes((parts[0] ?? '').toLowerCase());
};

export interface RescueInput {
  /** The id YouTube's iframe refused, if it refused one: the surest link to this exact song. */
  badVideoId?: string | null;
  /** The links the song carries — its "open in …" list, best first. */
  links?: readonly { url: string }[];
  /** Whether a shell with yt-dlp is there at all. In a plain browser, nothing can be downloaded. */
  shell: boolean;
}

/**
 * The link to download so this song can play here, or null when there is genuinely nothing to try.
 *
 * The id YouTube refused comes first: it names this exact recording, where a provider link may be
 * an album or a different master.
 */
export const rescueSource = ({ badVideoId = null, links = [], shell }: RescueInput): string | null => {
  if (!shell) return null;
  const blocked = sourceUrlFor(badVideoId);
  if (blocked && downloadableTrack(blocked)) return blocked;
  for (const l of links) if (l?.url && downloadableTrack(l.url)) return l.url;
  return null;
};
