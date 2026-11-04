/**
 * Full songs the decks can play.
 *
 * The equaliser and crossfader are Web Audio, and Web Audio can only touch audio the page itself
 * plays. A full song normally plays in YouTube's iframe, which no page script can reach — so with
 * the owner's rule that the full song always wins, the mixer reached almost nothing. The way to
 * have both is a full song the page plays itself: the bundled yt-dlp downloads it (to the same
 * Music folder the Downloads tab uses), the shell serves the file at the app's own origin, and the
 * player puts it on a deck like a preview — except it is the whole song.
 *
 * Same origin on purpose: a cross-origin element without CORS routed through Web Audio is silent.
 *
 * Both shells index finished downloads by the link they were fetched from, so the page never
 * learns a file path; it asks "do you have this link?" and, if so, plays `/local-audio?u=<link>`.
 */

import { dl, matchTarget, type DlFile } from './downloads';

export const LOCAL_AUDIO_PATH = '/local-audio';

/** The link yt-dlp would be given for a YouTube video id — and the key the shells index on. */
export const sourceUrlFor = (videoId: string | null | undefined): string | null => (videoId ? matchTarget(videoId)?.url ?? null : null);

/** Where the shell serves a finished download, at the page's own origin. */
export const localAudioUrl = (sourceUrl: string): string => `${LOCAL_AUDIO_PATH}?u=${encodeURIComponent(sourceUrl)}`;

export type LocalStatus = 'unknown' | 'ready' | 'running' | 'missing';

/**
 * How many songs' bytes are kept as Blobs: the one playing, the one cued for a blend, and one
 * spare for a quick back. A song is a few megabytes, so the ceiling matters on a phone.
 */
export const BLOB_CACHE = 3;

/** How often a running download is asked about. A song is a few megabytes; seconds, not minutes. */
export const POLL_MS = 3000;

export interface LocalApi {
  /** What the shell holds for a link: a finished file, or whether a download for it is in flight. */
  local: (url: string) => Promise<{ file: DlFile | null; running: boolean }>;
  start: (url: string, label: string) => Promise<unknown>;
}

const shellApi: LocalApi = {
  local: (url) => dl.local(url),
  // 'original' keeps the source bytes (Opus from YouTube Music) — the only format that cannot lose quality.
  start: (url, label) => dl.start(url, 'yt-dlp', 'original', label),
};

/**
 * The page's picture of which songs the shell holds. Nothing here is believed until the shell has
 * answered: `unknown` means "ask first", and the player holds the song back for that moment rather
 * than starting it in YouTube's player and having to yank it over.
 */
export class LocalLibrary {
  private readonly entries = new Map<string, { status: LocalStatus; error: string | null }>();
  private readonly listeners = new Set<() => void>();
  private readonly inFlight = new Map<string, Promise<void>>();
  /** Source link to Blob URL, oldest first (a Map keeps insertion order), capped at BLOB_CACHE. */
  private readonly blobs = new Map<string, string>();
  private readonly blobbing = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly api: LocalApi = shellApi) {}

  /** While any download runs, ask the shell again every few seconds; stop when nothing is running. */
  private schedule(): void {
    if (this.timer) return;
    const running = [...this.entries].filter(([, e]) => e.status === 'running').map(([url]) => url);
    if (running.length === 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void Promise.all(running.map((url) => this.refresh(url))).then(() => this.schedule());
    }, POLL_MS);
  }

  status(url: string): LocalStatus {
    return this.entries.get(url)?.status ?? 'unknown';
  }

  error(url: string): string | null {
    return this.entries.get(url)?.error ?? null;
  }

  /**
   * The playable address, once the shell has said it holds the file: a Blob URL (LOCAL-AUDIO-002).
   *
   * Not the `/local-audio` address itself. Android's WebView answers a Range request with 200 and
   * no Content-Range, so Chromium calls the stream non-seekable: duration stays Infinity, the
   * progress bar never fills and there is no total time. The file is a few megabytes on local
   * disk, so it is fetched once in full (19ms, measured) and the deck gets the whole thing.
   *
   * Returns null on the first call for a song and notifies subscribers when the blob is ready.
   */
  src(url: string): string | null {
    if (this.status(url) !== 'ready') return null;
    const have = this.blobs.get(url);
    if (have) {
      // Freshen its place in the queue: the song being asked for is the one to keep.
      this.blobs.delete(url);
      this.blobs.set(url, have);
      return have;
    }
    if (!this.blobbing.has(url)) {
      this.blobbing.add(url);
      void this.fetchBlob(url);
    }
    return null;
  }

  private async fetchBlob(url: string): Promise<void> {
    try {
      const r = await fetch(localAudioUrl(url));
      if (!r.ok) throw new Error(`the song could not be read (${r.status})`);
      const blobUrl = URL.createObjectURL(await r.blob());
      this.blobs.set(url, blobUrl);
      while (this.blobs.size > BLOB_CACHE) {
        const oldest = this.blobs.keys().next().value as string;
        const gone = this.blobs.get(oldest)!;
        this.blobs.delete(oldest);
        URL.revokeObjectURL(gone);
      }
      for (const l of [...this.listeners]) l();
    } catch (e) {
      this.set(url, 'missing', e instanceof Error ? e.message : String(e));
    } finally {
      this.blobbing.delete(url);
    }
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Ask the shell about one link. Concurrent asks for the same link share one answer. */
  refresh(url: string): Promise<void> {
    const pending = this.inFlight.get(url);
    if (pending) return pending;
    const p = this.api
      .local(url)
      .then((r) => this.set(url, r.file ? 'ready' : r.running ? 'running' : 'missing', null))
      .catch((e: unknown) => this.set(url, 'missing', e instanceof Error ? e.message : String(e)))
      .finally(() => this.inFlight.delete(url));
    this.inFlight.set(url, p);
    return p;
  }

  /** Make sure a link is held or on its way: ask, and start a download only if the shell has nothing. */
  async ensure(url: string, label: string): Promise<void> {
    await this.refresh(url);
    if (this.status(url) !== 'missing' || this.error(url)) return;
    try {
      await this.api.start(url, label);
      this.set(url, 'running', null);
    } catch (e) {
      this.set(url, 'missing', e instanceof Error ? e.message : String(e));
    }
  }

  private set(url: string, status: LocalStatus, error: string | null): void {
    const before = this.entries.get(url);
    if (before?.status === status && before.error === error) return;
    this.entries.set(url, { status, error });
    for (const l of [...this.listeners]) l();
    if (status === 'running') this.schedule();
  }
}

/** The one library the app shares; tests build their own. */
export const localLibrary = new LocalLibrary();
