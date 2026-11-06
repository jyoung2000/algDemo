/**
 * SOURCE-CHAIN-001 — finding a downloadable full song, by asking more than once.
 *
 * Owner: "The downloader & sources needs to download 100% of songs ... Ensure sources can download
 * needed data and actively trys different or retries sources."
 *
 * The old path asked YouTube Music one question — `"<first artist> <title>"` — and if no result
 * passed `matchRecordings` it recorded "no source" for six hours. That is a thin search for a
 * permanent verdict: the matcher rejects a candidate whose duration differs by more than 8s, so a
 * single long upload (or an upload credited to the label rather than the artist) made a song
 * undownloadable forever.
 *
 * This widens the search in order of confidence and stops at the first thing worth downloading:
 *
 *   1. YouTube Music, several phrasings of the question — a confident match is still a confident match.
 *   2. YouTube's videos, which the songs catalogue does not contain — game soundtracks and
 *      small-creator uploads live there. Only a confident match counts: a user upload is accepted
 *      solely when the matcher calls it the same recording, never as a near miss.
 *   3. SoundCloud, the same phrasings — both shells already allow yt-dlp to fetch soundcloud.com,
 *      so a match there is genuinely downloadable rather than merely identified.
 *   3. The closest near miss anyone offered, labelled `close` with its reason, because a song the
 *      owner can play at a slightly different length beats a song that never arrives. A candidate
 *      the matcher called a *different* recording is never returned, at any stage.
 *
 * Nothing here relaxes `matchRecordings`. Only the number of questions changes, plus the explicit,
 * labelled decision to accept an uncertain answer last rather than nothing at all.
 */
import type { Track } from '../api';
import { matchRecordings } from './identity';

export interface SearchSource {
  search(q: string, limit: number, c?: unknown): Promise<Track[]>;
}

export interface ChainSources {
  ytm: SearchSource;
  /** Null when the shell cannot reach SoundCloud; the chain then simply has one fewer leg. */
  sc: SearchSource | null;
  /** YouTube's videos, outside the songs catalogue (SOURCE-VIDEO-001). Optional: an older shell has none. */
  videos?: SearchSource | null;
  bandcamp?: SearchSource | null;
  audius?: SearchSource | null;
}

export interface FullSongResult {
  id: string | null;
  source: 'match' | 'video' | 'soundcloud' | 'bandcamp' | 'audius' | 'close' | 'none';
  /** A direct link for a source that is not a YouTube video id (SoundCloud). */
  url?: string;
  /** Why an uncertain answer was accepted, in the matcher's own words. */
  note?: string;
}

export interface ChainOptions {
  /** Passed through to the provider clients (metering, cache refresh). */
  ctx?: unknown;
  /** Upper bound on searches per provider, so one song cannot spend the whole beat. */
  maxQueries?: number;
  /** Results to ask each provider for. */
  limit?: number;
  /**
   * Links already known not to work for this song (SOURCE-SWAP-001). A candidate resolving to one
   * of these is skipped at every stage, including the last-resort near miss, so a retry genuinely
   * tries something else instead of re-offering the upload that just failed.
   */
  exclude?: readonly string[];
}

const DEFAULT_MAX_QUERIES = 4;
const DEFAULT_LIMIT = 8;

/** Drop a trailing "(feat. …)" / "[feat. …]" credit, and bare "feat. …" after the title. */
const withoutFeature = (title: string): string =>
  title.replace(/\s*[([]\s*(?:feat|ft|featuring|with)\.?\s[^)\]]*[)\]]/gi, '')
    .replace(/\s+(?:feat|ft|featuring)\.?\s+.*$/i, '')
    .trim();

/**
 * The questions to ask about one song, most specific first. A different phrasing finds uploads the
 * first one missed; the matcher still decides what counts, so widening the question cannot widen
 * what is accepted.
 */
export function searchVariants(t: Pick<Track, 'title' | 'artists'>): string[] {
  const title = String(t.title ?? '').trim();
  const artists = (t.artists ?? []).map(a => String(a).trim()).filter(Boolean);
  const first = artists[0] ?? '';
  const plain = withoutFeature(title);
  const out = [
    `${first} ${title}`,
    `${first} ${plain}`,
    title,
    `${artists.join(' ')} ${plain}`,
    plain,
  ].map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return [...new Set(out)];
}

interface NearMiss { track: Track; reason: string; gap: number }

/** How far apart two durations are; a missing duration sorts after any known gap. */
const gapOf = (a: Track, b: Track): number => {
  const da = Number(a.duration), db = Number(b.duration);
  return Number.isFinite(da) && Number.isFinite(db) && da > 0 && db > 0 ? Math.abs(da - db) : Number.MAX_SAFE_INTEGER;
};

const resultFor = (t: Track, source: 'match' | 'video' | 'soundcloud' | 'bandcamp' | 'audius' | 'close', note?: string): FullSongResult => {
  // Site uploads use their validated track links; YouTube Music uses the video id.
  const url = ['soundcloud', 'bandcamp', 'audius'].includes(t.provider) && t.url ? String(t.url) : undefined;
  return { id: url ? null : (t.platform_id ?? null), source, ...(url ? { url } : {}), ...(note ? { note } : {}) };
};

/**
 * Ask one provider every phrasing until something confident turns up. Near misses are collected
 * rather than discarded, so the last resort has something to choose from. A provider that throws
 * ends its own leg only — the next source still gets its turn.
 */
async function ask(
  src: SearchSource, t: Track, variants: string[], limit: number, ctx: unknown, misses: NearMiss[],
  dead: (c: Track) => boolean,
): Promise<Track | null> {
  for (const q of variants) {
    let results: Track[];
    try {
      results = await src.search(q, limit, ctx);
    } catch {
      return null; // this provider is not answering; the chain moves on
    }
    for (const r of results) {
      if (dead(r)) continue; // this one has already been tried and could not be downloaded
      const v = matchRecordings(t as never, r as never);
      if (v.verdict === 'same') return r;
      if (v.verdict === 'uncertain') misses.push({ track: r, reason: v.reason, gap: gapOf(t, r) });
    }
  }
  return null;
}

/**
 * The best downloadable source for one song, or `{id: null, source: 'none'}` when nobody has it.
 * `none` is a report that every source was asked — it is not a reason to stop retrying later, since
 * uploads appear over time.
 */
export async function findFullSong(t: Track, s: ChainSources, o: ChainOptions = {}): Promise<FullSongResult> {
  const limit = o.limit ?? DEFAULT_LIMIT;
  const variants = searchVariants(t).slice(0, Math.max(1, o.maxQueries ?? DEFAULT_MAX_QUERIES));
  const misses: NearMiss[] = [];
  // Compare on the link the downloader would actually be given, which is what failed.
  const excluded = new Set(o.exclude ?? []);
  const dead = (c: Track): boolean => {
    if (!excluded.size) return false;
    const r = resultFor(c, 'match');
    return (!!r.url && excluded.has(r.url)) || (!!r.id && [...excluded].some(x => x.includes(r.id!)));
  };

  const exact = await ask(s.ytm, t, variants, limit, o.ctx, misses, dead);
  if (exact) return resultFor(exact, 'match');

  // A user upload is held to the strict bar: confident matches only, never a near miss. The
  // matcher's own version tokens (slowed, reverb, remix, cover) reject the re-uploads that make up
  // most of what a video search returns.
  if (s.videos) {
    const onVideo = await ask(s.videos, t, variants, limit, o.ctx, [], dead);
    if (onVideo) return resultFor(onVideo, 'video');
  }

  if (s.sc) {
    const onSc = await ask(s.sc, t, variants, limit, o.ctx, misses, dead);
    if (onSc) return resultFor(onSc, 'soundcloud');
  }

  // Community uploads are not offered as uncertain near misses: same recording or no match.
  if (s.bandcamp) {
    const onBandcamp = await ask(s.bandcamp, t, variants, limit, o.ctx, [], dead);
    if (onBandcamp) return resultFor(onBandcamp, 'bandcamp');
  }
  if (s.audius) {
    const onAudius = await ask(s.audius, t, variants, limit, o.ctx, [], dead);
    if (onAudius) return resultFor(onAudius, 'audius');
  }

  // Last resort: the closest thing anyone had, labelled so the rest of the app can be honest.
  const best = misses.sort((a, b) => a.gap - b.gap)[0];
  return best ? resultFor(best.track, 'close', best.reason) : { id: null, source: 'none' };
}
