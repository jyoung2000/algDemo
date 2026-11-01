import type { Characteristics, ProviderId, RecItem, Release, TasteSummary, Track } from './api';

export const PROVIDER_LABEL: Record<string, string> = {
  ytmusic: 'YouTube Music',
  deezer: 'Deezer',
  soundcloud: 'SoundCloud',
  spotify: 'Spotify',
  apple: 'Apple Music',
};

/** The aqua-ui provider marks key YouTube Music under the YouTube mark. */
export function markKey(p: ProviderId | string): string {
  return p === 'ytmusic' ? 'youtube' : p;
}

export function artistOf(t: Pick<Track, 'artist' | 'artists'>): string {
  return t.artist || (t.artists ?? []).join(', ') || 'Unknown artist';
}

export function fmtDuration(sec?: number | null): string {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return '';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtBytes(n?: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n < 1000) return `${n} B`;
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)} kB`;
  if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB`;
  return `${(n / 1e9).toFixed(2)} GB`;
}

export function fmtRelease(r?: Release): string {
  if (!r) return '';
  const what = r.kind === 'upload' ? 'Uploaded' : 'Released';
  if (r.precision === 'year') return `${what} ${r.date.slice(0, 4)}`;
  const d = new Date(r.precision === 'day' ? `${r.date}T12:00:00` : `${r.date}-15T12:00:00`);
  if (Number.isNaN(d.getTime())) return `${what} ${r.date}`;
  const opts: Intl.DateTimeFormatOptions = r.precision === 'day' ? { day: 'numeric', month: 'short', year: 'numeric' } : { month: 'short', year: 'numeric' };
  return `${what} ${d.toLocaleDateString(undefined, opts)}`;
}

export function looksLikeUrl(q: string): boolean {
  const s = q.trim();
  return /^https?:\/\//i.test(s) || /^(www\.|open\.spotify\.com|spotify\.link|soundcloud\.com|on\.soundcloud\.com|youtu\.be|(m\.|music\.)?youtube\.com|deezer\.(com|page\.link)|link\.deezer\.com)\//i.test(s);
}

export const TIER_LABEL: Record<RecItem['tier'], string> = {
  strong: 'Close match',
  related: 'Related',
  emerging: 'Something new',
  experimental: 'Exploration',
};

/** Adds a seed unless the same recording is already there. There is no limit on how many. Never reorders. */
export function addSeed(seeds: Track[], t: Track): { seeds: Track[]; added: boolean; reason?: string } {
  if (seeds.some((s) => s.key === t.key)) return { seeds, added: false, reason: 'Already one of your starting songs.' };
  return { seeds: [...seeds, { ...t, emphasis: t.emphasis ?? 1 }], added: true };
}

/**
 * When a newer result arrives (metadata first, then audio refinement), keep the row the user was on.
 * Focus follows the recording, not the position; if it has gone, stay at the same position.
 */
export function keepFocus(prevKeys: string[], prevFocus: string | null, nextKeys: string[]): string | null {
  if (!nextKeys.length) return null;
  if (prevFocus == null) return null;
  if (nextKeys.includes(prevFocus)) return prevFocus;
  const at = prevKeys.indexOf(prevFocus);
  return nextKeys[Math.min(Math.max(at, 0), nextKeys.length - 1)] ?? null;
}

/** The next/previous playable row from the given one (skipping hidden and unplayable rows). */
export function stepPlayable(items: RecItem[], fromKey: string | null, dir: 1 | -1, hidden: Set<string>): RecItem | null {
  const ok = items.filter((x) => !hidden.has(x.track.key) && (x.playback.preview || x.playback.embed));
  if (!ok.length) return null;
  const i = fromKey ? ok.findIndex((x) => x.track.key === fromKey) : -1;
  if (i === -1) return dir === 1 ? ok[0]! : ok[ok.length - 1]!;
  return ok[i + dir] ?? null;
}

/**
 * Listening accumulator for a preview. Counts time actually played (timeupdate deltas while not
 * seeking and under ~1.5 s per tick), never the seek position, so scrubbing to the end is not a listen.
 */
export class ListenMeter {
  listened = 0;
  private last: number | null = null;
  private ranges: [number, number][] = [];

  /** Unique seconds of content actually heard (rewinds never increase it twice). */
  get coverage(): number {
    return this.ranges.reduce((sum, [start, end]) => sum + end - start, 0);
  }

  tick(currentTime: number, playing: boolean): void {
    if (playing && this.last != null) {
      const d = currentTime - this.last;
      if (d > 0 && d < 1.5) {
        this.listened += d;
        // Merge only measured playback intervals. Seeking and waiting cannot create coverage.
        let start = this.last, end = currentTime;
        const keep: [number, number][] = [];
        for (const [a, b] of this.ranges) {
          if (b < start || a > end) keep.push([a, b]);
          else { start = Math.min(start, a); end = Math.max(end, b); }
        }
        keep.push([start, end]);
        keep.sort((x, y) => x[0] - y[0]);
        this.ranges = keep;
      }
    }
    this.last = currentTime;
  }

  seeked(currentTime: number): void {
    this.last = currentTime;
  }
}

export function qualifiesCompletion(medium: 'full' | 'preview', coverage: number, duration: number | null): boolean {
  if (duration !== null && Number.isFinite(duration) && duration > 0) {
    const share = medium === 'preview' ? 0.8 : 0.7;
    return coverage >= Math.min(duration, Math.max(20, duration * share));
  }
  // Unknown duration: at least 20 seconds were genuinely heard; do not infer a completion ratio.
  return coverage >= 20;
}

export function classNames(...xs: (string | false | null | undefined)[]): string {
  return xs.filter(Boolean).join(' ');
}

/** How many new songs one discovery run may add. Mirrors QUEUE_SIZE_MIN/MAX in engine/local-api.ts, which enforces it. */
export const QUEUE_SIZE_MIN = 5;
export const QUEUE_SIZE_MAX = 60;

/** The facts-line entry that names the song's family/subgenre; it carries the song's Taste Picker colour.
 *  A family alone is dropped when a genre label already says it ("Rock" next to "Rock"). */
export function toneLabel(c?: Characteristics | null): string | null {
  if (!c || !(c.subgenre || c.family)) return null;
  if (c.subgenre) return c.family ? `${c.family} · ${c.subgenre}` : c.subgenre;
  const fam = (c.family as string).toLowerCase();
  if ((c.genres ?? []).some((g) => g.toLowerCase().split(/\s*\/\s*/).includes(fam))) return null;
  return c.family as string;
}

/** The facts shown on a row so the listener can see why a song was picked: tempo, genres, year, fit. */
export function describeCharacteristics(c?: Characteristics | null): string[] {
  if (!c) return [];
  const out: string[] = [];
  if (c.bpm && c.bpm > 0) out.push(`${c.bpm} BPM`);
  if (c.genres?.length) out.push(c.genres.slice(0, 2).join(' / ') + (c.genre_inferred ? ' (guessed)' : ''));
  const tone = toneLabel(c);
  if (tone) out.push(tone);
  if (c.release_year) out.push(c.release_year);
  if (c.explicit) out.push('Explicit');
  if (c.taste_fit != null) out.push(`${Math.round(c.taste_fit * 100)}% fit to your listening`);
  return out;
}

/** One plain sentence on what listening has taught the engine; '' until there is something to say. */
export function describeTaste(t?: TasteSummary | null): string {
  if (!t || !t.events) return '';
  const names = (l: { label: string; name: string }[]) => l.map((g) => g.label || g.name).join(', ');
  const parts: string[] = [];
  if (t.likes.length) parts.push(`you keep ${names(t.likes.slice(0, 3))}`);
  if (t.avoids.length) parts.push(`you skip ${names(t.avoids.slice(0, 2))}`);
  if (t.bpm) parts.push(`you stay near ${t.bpm} BPM`);
  const base = `Learned from ${t.events} ${t.events === 1 ? 'song' : 'songs'} you played`;
  return parts.length ? `${base}: ${parts.join('; ')}.` : `${base}. Not enough yet to change the order.`;
}

/**
 * The queue after a live re-rank: songs already played stay where they were (in order), the rest is
 * the new ranking, and ranks are renumbered so the list reads 1..n.
 */
export function mergeRerank(prev: RecItem[], next: RecItem[], played: ReadonlySet<string>): RecItem[] {
  const kept = prev.filter((x) => played.has(x.track.key));
  const keptKeys = new Set(kept.map((x) => x.track.key));
  return [...kept, ...next.filter((x) => !keptKeys.has(x.track.key))].map((x, i) => ({ ...x, rank: i + 1 }));
}
