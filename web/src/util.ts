import { classify } from './engine/classify';
import { downloadsAvailable } from './engine/downloads';
import { FAMILY_TAGS } from './engine/genre-table';
import type { Tag } from './engine/genres';
import type { Characteristics, Playback, ProviderId, RecItem, Release, TasteSummary, Track } from './api';

export const PROVIDER_LABEL: Record<string, string> = {
  ytmusic: 'YouTube Music',
  deezer: 'Deezer',
  soundcloud: 'SoundCloud',
  spotify: 'Spotify',
  apple: 'Apple Music',
};

/**
 * Whether the list can start this song here.
 *
 * Inside the Windows and Android apps the player does not stream: it looks the song up and
 * downloads the full track onto its own deck (Player.tsx mode 'local'), which needs nothing but the
 * track itself. So every song in the list can be played, and a missing streaming preview says
 * nothing about it — asking for one hid Play on whole queue rows and told the listener a song they
 * were being recommended "has no player here" (QUEUE-PLAY-001).
 *
 * A plain browser has no downloader, so there a preview or an embed really is the whole story and
 * offering Play would be offering a dead button.
 */
export function canPlayHere(p: Pick<Playback, 'preview' | 'embed'>): boolean {
  return downloadsAvailable() || Boolean(p.preview || p.embed);
}

/** How a song that is not a recommendation (a search hit or a starting song) plays: preview first, else the provider's own player. */
export function playbackOfTrack(t: Track): Playback {
  const open: Playback['open'] = [];
  const seen = new Set<string>();
  const add = (provider: string, url: string) => {
    // one link per service: the same service can appear more than once in also_on
    if (!url || seen.has(provider)) return;
    seen.add(provider);
    open.push({ provider: provider as ProviderId, label: `Open in ${PROVIDER_LABEL[provider] ?? provider}`, url });
  };
  if (t.url) add(t.provider, t.url);
  for (const a of t.also_on ?? []) add(a.provider, a.url);
  if (t.preview) return { open, preview: t.preview, embed: null };
  if (t.provider === 'ytmusic') return { open, preview: null, embed: { provider: 'ytmusic', url: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(t.platform_id)}?autoplay=1&rel=0` } };
  if (t.provider === 'soundcloud' && t.url)
    return { open, preview: null, embed: { provider: 'soundcloud', url: `https://w.soundcloud.com/player/?url=${encodeURIComponent(t.url)}&auto_play=true&visual=false` } };
  return { open, preview: null, embed: null };
}

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

/** Adds a seed unless the same recording is already there. There is no limit on how many. The newest goes first so it is visible at the top of the list. */
export function addSeed(seeds: Track[], t: Track): { seeds: Track[]; added: boolean; reason?: string } {
  if (seeds.some((s) => s.key === t.key)) return { seeds, added: false, reason: 'Already one of your starting songs.' };
  return { seeds: [{ ...t, emphasis: t.emphasis ?? 1 }, ...seeds], added: true };
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
  const ok = items.filter((x) => !hidden.has(x.track.key) && canPlayHere(x.playback));
  if (!ok.length) return null;
  const i = fromKey ? ok.findIndex((x) => x.track.key === fromKey) : -1;
  if (i === -1) return dir === 1 ? ok[0]! : ok[ok.length - 1]!;
  return ok[i + dir] ?? null;
}

export interface VolumeState {
  /** 0 to 1. */
  value: number;
  muted: boolean;
}
/** Sound is off when muted or the slider sits at 0. YouTube's player ignores setVolume(0), so 0 must mute. */
export const isSilent = (v: VolumeState): boolean => v.muted || v.value <= 0;
/**
 * The speaker button. Silent -> sound back on (from slider 0 it returns to the last level, or half);
 * playing -> muted, the level kept so unmuting returns to it.
 */
export function toggleMuteState(v: VolumeState, lastLevel: number): VolumeState {
  if (!isSilent(v)) return { value: v.value, muted: true };
  return { value: v.value > 0 ? v.value : lastLevel > 0 ? lastLevel : 0.5, muted: false };
}

/** What happens when a song ends: stop at the end of the list, loop the list, or loop the song. */
export type RepeatMode = 'off' | 'all' | 'one';
export const REPEAT_ORDER: readonly RepeatMode[] = ['off', 'all', 'one'];
export const nextRepeat = (m: RepeatMode): RepeatMode => REPEAT_ORDER[(REPEAT_ORDER.indexOf(m) + 1) % REPEAT_ORDER.length]!;

export interface QueueStep {
  item: RecItem;
  /** The list ran out and started over (repeat all), so a shuffle begins a new round. */
  wrapped: boolean;
}

/**
 * The song after (dir 1) or before (dir -1) the current one. In order it walks the list and, with repeat
 * all, wraps round its ends. Shuffled it picks at random from the songs not yet heard this round, so no
 * song comes twice before every other has played; repeat all then starts a new round, otherwise the
 * round's end is the end of playback. Going back while shuffled uses the play history instead (historyBack).
 */
/**
 * The shuffle's committed next pick: from which song, to which. Once a next song has been announced
 * (cued, downloaded, blended into) the same one must come back until it plays (SHUFFLE-NEXT-001).
 */
let shuffleNext: { from: string | null; key: string } | null = null;
export function resetShuffleNextForTests(): void {
  shuffleNext = null;
}

export function stepQueue(
  items: RecItem[],
  fromKey: string | null,
  dir: 1 | -1,
  hidden: Set<string>,
  o: { shuffle: boolean; repeat: RepeatMode; heard: ReadonlySet<string>; rand?: () => number },
): QueueStep | null {
  const ok = items.filter((x) => !hidden.has(x.track.key) && canPlayHere(x.playback));
  if (!ok.length) return null;
  const rand = o.rand ?? Math.random;
  const pick = (from: RecItem[]) => from[Math.min(from.length - 1, Math.floor(rand() * from.length))]!;
  if (o.shuffle && dir === 1) {
    const fresh = ok.filter((x) => x.track.key !== fromKey && !o.heard.has(x.track.key));
    if (fresh.length) {
      const kept = shuffleNext && shuffleNext.from === fromKey ? fresh.find((x) => x.track.key === shuffleNext!.key) : undefined;
      const item = kept ?? pick(fresh);
      shuffleNext = { from: fromKey, key: item.track.key };
      return { item, wrapped: false };
    }
    if (o.repeat !== 'all') return null;
    const others = ok.filter((x) => x.track.key !== fromKey);
    return { item: pick(others.length ? others : ok), wrapped: true };
  }
  const i = fromKey ? ok.findIndex((x) => x.track.key === fromKey) : -1;
  if (i === -1) return { item: dir === 1 ? ok[0]! : ok[ok.length - 1]!, wrapped: false };
  const n = ok[i + dir];
  if (n) return { item: n, wrapped: false };
  if (o.repeat === 'all') return { item: dir === 1 ? ok[0]! : ok[ok.length - 1]!, wrapped: true };
  return null;
}

/** The song played before the current one, from the play history; `keep` is how much of the history stays. */
export function historyBack(history: readonly string[], currentKey: string | null, items: RecItem[], hidden: Set<string>): { item: RecItem; keep: number } | null {
  let end = history.length;
  if (end && history[end - 1] === currentKey) end -= 1;
  for (let i = end - 1; i >= 0; i--) {
    const item = items.find((x) => x.track.key === history[i] && !hidden.has(x.track.key) && canPlayHere(x.playback));
    if (item && item.track.key !== currentKey) return { item, keep: i + 1 };
  }
  return null;
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
  if (c.subgenre) return c.subgenre;
  const fam = (c.family as string).toLowerCase();
  if (genreNames(c).some((g) => g.toLowerCase() === fam)) return null;
  return c.family as string;
}

/** Each genre name on its own, split on the separators providers use ("Rap / Hip Hop"), blanks dropped. */
export function genreNames(c?: Characteristics | null): string[] {
  return (c?.genres ?? []).flatMap((g) => g.split(/\s*[\/·,]\s*/)).map((g) => g.trim()).filter(Boolean);
}

/** Tag ids that name the same thing ("Hip-hop", "hip hop", "Hip Hop") collapse to one. */
const tagKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * The genre bubbles for a row, in reading order: main genres first (the family, or a bare genre such as
 * "Rap"), then subgenres. Each bubble is one name with no separators. A name already named by a longer
 * bubble is dropped ("Hip Hop" beside "underground hip hop"), and "Rap" and "Hip Hop" count as one.
 */
export function genreTags(c?: Characteristics | null): string[] {
  // Every family and subgenre the tags name (TAGS-MULTI-001), not only the strongest pair: a song
  // that is R&B and pop shows both. Older answers without the list fall back to the single pair.
  const list = c?.families ?? [];
  const family = list.length ? list.flatMap((f) => splitTag(f.family)) : c?.family ? splitTag(c.family) : [];
  const sub = list.length
    ? list.flatMap((f) => (f.subgenre ? splitTag(f.subgenre) : []))
    : c?.subgenre
      ? splitTag(c.subgenre)
      : [];
  const provider = genreNames(c).slice(0, 3);
  const isSub = (n: string) => sub.some((x) => tagKey(x) === tagKey(n));
  // The provider's own main genre ("Rap") is the main bubble; the family ("Hip-hop") only fills in when there is none.
  const main = [...provider, ...family].filter((n) => !isSub(n));
  // A subgenre wins over a main-genre copy of the same name ("underground hip hop" vs "underground hip-hop").
  const ordered = [...sub, ...main];

  const keys: string[] = [];
  const unique: string[] = [];
  for (const name of ordered) {
    const k = tagKey(name);
    if (!k || keys.includes(k)) continue;
    keys.push(k);
    unique.push(name);
  }
  // Drop a bubble whose words are all inside a longer bubble's words (e.g. "Hip Hop" inside "underground hip hop").
  const covered = unique.filter((name) => {
    const words = tagKey(name);
    return !unique.some((other) => other !== name && tagKey(other).length > words.length && tagKey(other).includes(words));
  });
  // "Rap" and "Hip Hop" name the same thing: a song keeps only the first of them.
  let rapSeen = false;
  const dedup = covered.filter((name) => {
    if (!/hiphop|^rap$/.test(tagKey(name))) return true;
    if (rapSeen) return false;
    rapSeen = true;
    return true;
  });
  return [...dedup.filter((n) => !isSub(n)), ...dedup.filter((n) => isSub(n))];
}

/**
 * The Taste Picker colour for one genre name: the same colour the picker gives a song with that genre
 * (classify: family hue band, shaded by the subgenre's energy and brightness). Null when the name is
 * not a picker family or subgenre.
 */
export function pickerColorFor(name: string): string | null {
  const tag = [{ name, label: name, confidence: 1 }] as Tag[];
  const sub = classify(tag, null);
  if (sub?.color && sub.subgenre) return sub.color;
  // A main genre with no subgenre of its own ("Rap") takes its family's band colour.
  const fam = FAMILY_TAGS[name.toLowerCase()];
  if (!fam) return null;
  return classify([{ name: fam, label: fam, confidence: 1 }] as Tag[], null)?.color ?? null;
}

/** Split a provider string on the separators it uses ("A / B", "A · B") so each part is its own bubble. */
const splitTag = (s: string): string[] => s.split(/\s*[\/·,]\s*/).map((x) => x.trim()).filter(Boolean);

/** The facts shown on a row so the listener can see why a song was picked: tempo, genres, year, fit. */
export function describeCharacteristics(c?: Characteristics | null): string[] {
  if (!c) return [];
  const out: string[] = [];
  if (c.bpm && c.bpm > 0) out.push(`${c.bpm} BPM`);
  if (c.release_year) out.push(String(c.release_year));
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
