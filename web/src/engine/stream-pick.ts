/**
 * STREAM-DL-001. Owner: "can we listen to a song while downloading it from source platforms".
 *
 * Whether the player plays the song it was asked for straight from its source while the download
 * runs. The stream and the download race; the first to make the song playable wins:
 *   - nothing streams once the file is here, or where the shell cannot stream (the Android app's
 *     native engine streams for itself), or for a source that offers no single audio file;
 *   - a stream starts while the song's download is running or about to start;
 *   - a stream that has not made a sound yet gives way to a file that lands first;
 *   - a stream that has started keeps playing to the end of the song: swapping to the file then
 *     would restart the song from zero;
 *   - a stream that failed is not tried again for that song; the player waits for the file.
 */
import type { LocalStatus } from './local-audio';

export interface StreamInputs {
  /** The shell serves /stream-audio and this player plays through its own deck. */
  canStream: boolean;
  /** The download link the player would fetch (null when there is none yet). */
  source: string | null;
  localStatus: LocalStatus;
  /** The finished file's playable address, once held. */
  localSrc: string | null;
  /** This song's stream so far, if one was chosen. */
  current: { url: string | null; started: boolean; failed: boolean } | null;
}

/** YouTube links name one progressive audio file; SoundCloud and others hand out segment lists. */
export function streamableSource(source: string | null | undefined): boolean {
  if (!source) return false;
  try {
    const u = new URL(source);
    return u.protocol === 'https:' && ['youtu.be', 'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export const STREAM_AUDIO_PATH = '/stream-audio';
export const streamAudioUrl = (source: string): string => `${STREAM_AUDIO_PATH}?u=${encodeURIComponent(source)}`;

export function pickStream(i: StreamInputs): string | null {
  if (!i.canStream || !i.source || !streamableSource(i.source) || i.current?.failed) return null;
  if (i.current?.url && i.current.started) return i.current.url;
  // A held file is 'ready', so this also lets a file that landed first win.
  if (i.localStatus !== 'running' && i.localStatus !== 'missing') return null;
  return streamAudioUrl(i.source);
}
