/**
 * NEXT-FAV-CUSTOM-001 (owner, 2026-11-19): "Find my next favorite" with the listener's own criteria.
 *
 * The listener picks any genres and subgenres, any artists (and for each: their own songs, songs they feature on,
 * songs by their frequent collaborators, songs by similar artists), how many songs (up to 100), Familiar or
 * Adventurous, and Older or Newer. Songs are gathered from those sources on every platform, kept only when they meet
 * the chosen genres, ranked with the listener's taste in mind, and added to the end of Now playing.
 *
 * Rules (Astra design review, 2026-11-19):
 * - Genres match ANY chosen tag; artist sources match ANY enabled source; with both, a song must meet both.
 * - Taste ranks songs, it never overrides a chosen genre. Nothing is silently relaxed: a short result says so.
 * - No genre and no artist: the listener's strongest taste genres are asked for instead.
 */
import type { Tag } from './genres';
import { genreIdentity, subShortName } from './genre-identity';
import { FAMILIES, SUBS } from './genre-table';
import { colourArtists } from './taste-gather';
import { collaboratorsOf } from './artist-circle';
import type { SimilarArtist } from './artist-circle';
import { fold, parseTitle } from './identity';
import { tasteFit, type TasteProfile } from './taste';

export const CUSTOM_MAX_SONGS = 100;
/** How many collaborators and similar artists each chosen artist lends songs from. */
export const CIRCLE_ARTISTS = 6;
/** Songs taken from each of those artists. */
export const CIRCLE_SONGS = 5;
/** Searches per run for genres: enough variety, without spending a provider's daily allowance on one press. */
export const GENRE_ASKS_MAX = 8;
/** Each further song by the same lead artist counts this much less, so one artist cannot fill the list. */
export const SAME_ARTIST_DECAY = 0.82;
/** Reference artists followed out to their related artists per run, how many each, and songs from each. */
export const WIDEN_ASKS = 3;
export const WIDEN_ARTISTS = 3;
export const WIDEN_SONGS = 4;

export interface CustomArtist {
  id?: string;
  name: string;
  own: boolean;
  features: boolean;
  collaborators: boolean;
  similar: boolean;
}

export interface CustomCriteria {
  /** 'family:<slug>' or 'sub:<key>' (also 'genre:<canon>' for a main genre word). */
  genres: string[];
  artists: CustomArtist[];
  count: number;
  /** 0 familiar .. 1 adventurous. */
  adventurous: number;
  /** -1 older .. 0 any era .. +1 newer. */
  era: number;
}

type Loose = { genres?: unknown; artists?: unknown; count?: unknown; adventurous?: unknown; era?: unknown };
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const FAMILY_SLUGS = new Set(FAMILIES.map((f) => f.slug));
const SUB_BY_KEY = new Map(SUBS.map((s) => [s.key, s] as const));

/** Whether a genre key names something the picker knows. */
export function knownGenreKey(k: string): boolean {
  const [kind, rest] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)];
  if (kind === 'family') return FAMILY_SLUGS.has(rest);
  if (kind === 'sub') return SUB_BY_KEY.has(rest);
  if (kind === 'genre') return genreIdentity(rest)?.key === k;
  return false;
}

/** The family a genre key belongs to. */
export function familyOfKey(k: string): string | null {
  if (k.startsWith('family:')) return k.slice(7);
  if (k.startsWith('sub:')) return SUB_BY_KEY.get(k.slice(4))?.family ?? null;
  return genreIdentity(k.slice(k.indexOf(':') + 1))?.family ?? null;
}

/** The name a genre key goes by on a bubble. */
export function genreKeyLabel(k: string): string {
  if (k.startsWith('family:')) return FAMILIES.find((f) => f.slug === k.slice(7))?.name.split(/\s*\/\s*/)[0] ?? k;
  if (k.startsWith('sub:')) { const s = SUB_BY_KEY.get(k.slice(4)); return s ? subShortName(s) : k; }
  return genreIdentity(k.slice(k.indexOf(':') + 1))?.label ?? k;
}

export function normaliseCriteria(raw: Loose | null | undefined): CustomCriteria {
  const r = raw ?? {};
  const genres = [...new Set((Array.isArray(r.genres) ? r.genres : []).filter((g): g is string => typeof g === 'string' && knownGenreKey(g)))].slice(0, 40);
  const seen = new Set<string>();
  const artists: CustomArtist[] = [];
  for (const a of Array.isArray(r.artists) ? (r.artists as Record<string, unknown>[]) : []) {
    const name = String(a?.['name'] ?? '').trim().slice(0, 120);
    const f = fold(name);
    if (!f || seen.has(f)) continue;
    seen.add(f);
    const pick = (k: string, d: boolean) => (typeof a[k] === 'boolean' ? (a[k] as boolean) : d);
    const one: CustomArtist = { name, own: pick('own', true), features: pick('features', true), collaborators: pick('collaborators', false), similar: pick('similar', false) };
    if (typeof a['id'] === 'string' && /^(dz:\d{1,15}|yt:UC[A-Za-z0-9_-]{22})$/.test(a['id'])) one.id = a['id'];
    if (!one.own && !one.features && !one.collaborators && !one.similar) one.own = true;
    artists.push(one);
    if (artists.length >= 12) break;
  }
  return {
    genres,
    artists,
    count: Math.round(clamp(num(r.count, 25), 1, CUSTOM_MAX_SONGS)),
    adventurous: clamp(num(r.adventurous, 0.5), 0, 1),
    era: clamp(num(r.era, 0), -1, 1),
  };
}

/** DISCOVER-TIDY-002: custom discovery is chosen once a genre or an artist is picked; then Find needs no starting song. */
export const hasCustomChoices = (c: CustomCriteria): boolean => c.genres.length > 0 || c.artists.length > 0;

/* ------------------------------------------------------------------------------------------- genres */

export interface GenreAsk { kind: 'artist' | 'words'; term: string; genre: string }

/** What to search for a set of genres: each subgenre's reference artists and its own name, spread across them. */
export function genreAsks(keys: readonly string[], max = GENRE_ASKS_MAX, turn = 0): GenreAsk[] {
  const pools: GenreAsk[][] = keys.map((k) => {
    const subs = k.startsWith('family:') ? SUBS.filter((s) => s.family === k.slice(7)) : k.startsWith('sub:') ? [SUB_BY_KEY.get(k.slice(4))].filter(Boolean) as typeof SUBS : [];
    const out: GenreAsk[] = [];
    if (!subs.length) out.push({ kind: 'words', term: genreKeyLabel(k), genre: k });
    // Interleave across the subgenres so a family's asks are not all one subgenre.
    const per = subs.map((s) => [...colourArtists(s.key).map((a) => ({ kind: 'artist' as const, term: a, genre: k })), { kind: 'words' as const, term: subShortName(s), genre: k }]);
    for (let i = 0; per.some((p) => i < p.length); i++) for (const p of per) if (p[i]) out.push(p[i]!);
    return out;
  });
  const asks: GenreAsk[] = [];
  const seen = new Set<string>();
  // Each chosen genre takes turns; `turn` starts later runs further into each pool.
  for (let i = 0; asks.length < max && pools.some((p) => i < p.length); i++) {
    for (const p of pools) {
      if (!p.length || asks.length >= max) continue;
      const a = p[(i + turn) % p.length]!;
      if (i >= p.length) continue;
      const f = `${a.kind}:${fold(a.term)}`;
      if (seen.has(f)) continue;
      seen.add(f);
      asks.push(a);
    }
  }
  return asks;
}

type Tagged = { tags?: readonly (Tag | { name: string; label?: string })[] | null };

function identitiesOf(t: Tagged) {
  const out: { key: string; family: string }[] = [];
  for (const g of t.tags ?? []) {
    const id = genreIdentity(g.label || g.name) ?? genreIdentity(g.name);
    if (id) out.push({ key: id.key, family: id.family });
  }
  return out;
}

/**
 * Whether a song meets the chosen genres: 'tag' when one of its genres is chosen (a family takes any of its genres),
 * 'asked' when it was found by asking for a chosen genre and none of its genres says otherwise, 'any' when no genre
 * is chosen, and null when it does not meet them.
 */
export function matchesGenres(t: Tagged, keys: readonly string[], askedFor?: string): 'tag' | 'asked' | 'any' | null {
  if (!keys.length) return 'any';
  const ids = identitiesOf(t);
  for (const k of keys) {
    if (k.startsWith('family:')) { if (ids.some((i) => i.family === k.slice(7))) return 'tag'; }
    else if (ids.some((i) => i.key === k)) return 'tag';
  }
  if (askedFor && keys.includes(askedFor)) {
    const fam = familyOfKey(askedFor);
    if (!ids.length || ids.some((i) => i.family === fam)) return 'asked';
  }
  return null;
}

/* ------------------------------------------------------------------------------------ real songs */

/** Uploads that are not a song to discover: beats for sale and the like. */
const UPLOAD = /\btype\s*beat\b|\bfree\s+\w*\s*beat\b|\bbeat\s+for\s+sale\b|\bscrewed\b|\bchopped\b|\bnightcore\b|\b8d\s+audio\b|\bbass\s*boosted\b|\bmashup\b/i;
/** Versions of a song rather than the song: discovery is for the original. */
const NOT_ORIGINAL = new Set(['remix', 'sped-up', 'slowed', 'instrumental', 'cover', 'a-cappella', 'demo']);

/** True for a type beat, a bootleg remix, a sped-up or slowed edit and the like (seen on Windows, 2026-11-19). */
export function notTheRealSong(title: string): boolean {
  if (UPLOAD.test(title)) return true;
  return [...parseTitle(title).versions].some((v) => NOT_ORIGINAL.has(v));
}

/* ---------------------------------------------------------------------------------------- ranking */

/** 0..1: how well a release year suits Older (-1) .. Newer (+1). Any era and unknown years are 0.5. */
export function eraFit(year: number | null | undefined, era: number, now: number, oldest = 1960): number {
  if (!era || !year || !Number.isFinite(year)) return 0.5;
  const t = clamp((year - oldest) / Math.max(1, now - oldest), 0, 1);
  const lean = era > 0 ? t : 1 - t;
  return 0.5 + (lean - 0.5) * Math.abs(era);
}

export type CustomSource = 'own' | 'feature' | 'collab' | 'similar' | 'genre' | 'taste';

export interface CustomCandidate {
  track: CandidateTrack;
  source: CustomSource;
  /** The chosen artist (or genre key) it came from. */
  from: string;
  /** The genre ask that found it. */
  genre?: string;
}

export type CandidateTrack = Tagged & {
  key: string;
  title: string;
  artists?: string[];
  artist?: string;
  release?: { date?: string } | null;
  bpm?: number | null;
};

export interface Picked extends CustomCandidate { score: number; reason: string }

export interface PickOpts {
  /** Keys already in the queue (or hidden): never added again. */
  exclude: ReadonlySet<string>;
  /** The same songs by identity (songIdOf): a queued song can carry another service's key. */
  excludeSongs?: ReadonlySet<string>;
  /** Folded names of artists the listener already plays. */
  known: ReadonlySet<string>;
  taste: TasteProfile | null;
  year: number;
}

const lead = (t: CandidateTrack) => fold(t.artists?.[0] ?? t.artist ?? '');
const songId = (t: CandidateTrack) => `${parseTitle(t.title).core || fold(t.title)}|${lead(t)}`;
/** One id per song whatever service it came from: its title without versions or features, and its lead artist. */
export const songIdOf = (t: { title: string; artists?: string[]; artist?: string }) => songId(t as CandidateTrack);
const yearOf = (t: CandidateTrack) => { const y = Number(String(t.release?.date ?? '').slice(0, 4)); return y > 1900 ? y : null; };

function reasonFor(c: CustomCandidate, genreHit: string | null): string {
  const g = genreHit ? `${genreKeyLabel(genreHit)} · ` : '';
  switch (c.source) {
    case 'own': return `${g}By ${c.from}, an artist you chose.`;
    case 'feature': return `${g}Features ${c.from}, an artist you chose.`;
    case 'collab': return `${g}By a frequent collaborator of ${c.from}.`;
    case 'similar': return `${g}By an artist similar to ${c.from}.`;
    case 'genre': return `${genreKeyLabel(c.genre ?? c.from)} · found for the genres you chose.`;
    default: return `${g}From your strongest taste genres.`;
  }
}

/** Rank and choose. Every pick meets the genres; taste and era rank; one artist cannot fill the list. */
export function pickCustom(pool: readonly CustomCandidate[], crit: CustomCriteria, o: PickOpts): Picked[] {
  const scored: (Picked & { id: string; lead: string })[] = [];
  const ids = new Set<string>();
  for (const c of pool) {
    const t = c.track;
    if (!t?.key || o.exclude.has(t.key) || notTheRealSong(t.title)) continue;
    const id = songId(t);
    if (ids.has(id) || o.excludeSongs?.has(id)) continue;
    const hit = matchesGenres(t, crit.genres, c.genre);
    if (!hit) continue;
    ids.add(id);
    const fit = tasteFit({ tags: (t.tags ?? []) as Tag[], bpm: t.bpm ?? null }, o.taste)?.value ?? 0.5;
    const known = (t.artists?.length ? t.artists : [t.artist ?? '']).some((a) => o.known.has(fold(a)));
    const familiar = 0.6 * fit + 0.4 * (known ? 1 : 0);
    // Adventurous still keeps the taste in mind: it prefers new names, and only partly moves away from the taste.
    const novel = 0.7 * (known ? 0 : 1) + 0.3 * (1 - fit);
    const tasteScore = (1 - crit.adventurous) * familiar + crit.adventurous * novel;
    const e = Math.abs(crit.era);
    const score = tasteScore * (1 - 0.5 * e) + eraFit(yearOf(t), crit.era, o.year) * 0.5 * e + (hit === 'tag' ? 0.02 : 0);
    const genreHit = crit.genres.find((k) => matchesGenres(t, [k], c.genre)) ?? null;
    scored.push({ ...c, score, reason: reasonFor(c, genreHit), id, lead: lead(t) });
  }
  const out: Picked[] = [];
  const perLead = new Map<string, number>();
  const left = [...scored];
  while (out.length < crit.count && left.length) {
    let best = 0, bestScore = -Infinity;
    for (let i = 0; i < left.length; i++) {
      const s = left[i]!.score * SAME_ARTIST_DECAY ** (perLead.get(left[i]!.lead) ?? 0);
      if (s > bestScore) { bestScore = s; best = i; }
    }
    const [p] = left.splice(best, 1);
    perLead.set(p!.lead, (perLead.get(p!.lead) ?? 0) + 1);
    const { id: _id, lead: _lead, ...keep } = p!;
    out.push(keep);
  }
  return out;
}

/** What the listener is told after a run. "No matching songs" only when the services were actually searched. */
export function customOutcome(added: number, asked: number, sources: Record<string, { state: string }>, missed: readonly string[]): string {
  const states = Object.values(sources).map((s) => s.state);
  const ok = states.includes('ok');
  const budget = states.includes('budget');
  if (added === 0 && !ok && budget) return 'The daily transfer allowance is used up, so no service could be searched. Raise it in Settings (Daily allowance) or try again tomorrow.';
  if (added === 0 && !ok && states.length) return 'No service answered. Check the connection and try again.';
  if (added === 0) return 'No matching songs found. Try fewer genre restrictions or more artist sources.';
  if (added >= asked) return '';
  const parts = [`Only ${added} matching ${added === 1 ? 'song was' : 'songs were'} available.`];
  if (budget) parts.push('Some services were skipped: the daily transfer allowance is used up.');
  if (missed.length) parts.push(`Could not read: ${missed.slice(0, 4).join(', ')}${missed.length > 4 ? '\u2026' : ''}.`);
  return parts.join(' ');
}

/* -------------------------------------------------------------------------------------------- run */

export interface ArtistRead {
  name: string;
  songs: CandidateTrack[];
  features: CandidateTrack[];
  similar?: SimilarArtist[];
}

export interface CustomPorts {
  openArtist(target: { id?: string; name: string }): Promise<ArtistRead>;
  /** Another artist's best known songs, by name (and id when known). */
  artistTop(name: string, id?: string): Promise<CandidateTrack[]>;
  /** Search: an artist on every platform; a genre's own words on the catalogue services only (an upload's title is
   *  not its genre). */
  search(term: string, kind: 'artist' | 'words'): Promise<CandidateTrack[]>;
  /** A reference artist's related artists (Deezer), to reach past the few names the genre table lists. */
  related?(name: string): Promise<{ name: string; id?: string }[]>;
  /** Fill in genres for songs that have none yet, in place. */
  enrichGenres(tracks: CandidateTrack[]): Promise<void>;
  progress?(text: string): void;
  check?(): void;
}

export interface CustomResult {
  picked: Picked[];
  candidates: number;
  /** Sources that could not be read, in the listener's words. */
  missed: string[];
}

/** Gather from the chosen sources, then pick. `tasteGenres` stand in when nothing is chosen. */
export async function runCustomDiscovery(crit: CustomCriteria, ports: CustomPorts, o: PickOpts & { tasteGenres?: string[]; turn?: number }): Promise<CustomResult> {
  const pool: CustomCandidate[] = [];
  const missed: string[] = [];
  const say = (s: string) => ports.progress?.(s);
  for (const a of crit.artists) {
    ports.check?.();
    say(`Reading ${a.name}\u2019s songs`);
    let view: ArtistRead;
    try { view = await ports.openArtist({ ...(a.id ? { id: a.id } : {}), name: a.name }); } catch { missed.push(a.name); continue; }
    const name = view.name || a.name;
    if (a.own) for (const t of view.songs) pool.push({ track: t, source: 'own', from: name });
    if (a.features) for (const t of view.features) pool.push({ track: t, source: 'feature', from: name });
    if (a.collaborators) {
      const circle = collaboratorsOf(name, [...view.songs, ...view.features], { min: 1, max: CIRCLE_ARTISTS });
      for (const c of circle) {
        ports.check?.();
        say(`Songs by ${c.name}, who works with ${name}`);
        try { for (const t of (await ports.artistTop(c.name)).slice(0, CIRCLE_SONGS)) pool.push({ track: t, source: 'collab', from: name }); } catch { missed.push(c.name); }
      }
    }
    if (a.similar) {
      for (const s of (view.similar ?? []).slice(0, CIRCLE_ARTISTS)) {
        ports.check?.();
        say(`Songs by ${s.name}, similar to ${name}`);
        try { for (const t of (await ports.artistTop(s.name, s.id)).slice(0, CIRCLE_SONGS)) pool.push({ track: t, source: 'similar', from: name }); } catch { missed.push(s.name); }
      }
    }
  }
  // Genres are searched for directly only when no artist narrows them: with artists, genres filter those artists'
  // songs ("songs must satisfy both").
  const keys = crit.genres.length ? crit.genres : crit.artists.length ? [] : (o.tasteGenres ?? []);
  if (keys.length && !crit.artists.length) {
    const asks = genreAsks(keys, GENRE_ASKS_MAX, o.turn ?? 0);
    for (const ask of asks) {
      ports.check?.();
      say(`Searching every platform for ${genreKeyLabel(ask.genre)}`);
      try {
        const who = fold(ask.term);
        for (const t of await ports.search(ask.term, ask.kind)) {
          // A reference artist's search: only that artist's songs. Anything else is an upload that names them.
          if (ask.kind === 'artist' && !(t.artists?.length ? t.artists : [t.artist ?? '']).some((a) => fold(a) === who)) continue;
          // A genre's own word is weak evidence: a song merely named "Trap" proves nothing, and a word hit counts only
          // when its real genre tags say so (no `genre`, so matchesGenres never takes it on trust).
          if (ask.kind === 'words' && fold(t.title) === who) continue;
          pool.push({ track: t, source: crit.genres.length ? 'genre' : 'taste', from: ask.genre, ...(ask.kind === 'artist' ? { genre: ask.genre } : {}) });
        }
      } catch { missed.push(ask.term); }
    }
  }
  // Widening: a subgenre lists only a few reference artists, so each of the first few is followed out to the artists
  // Deezer relates to it. They count as found for that genre, and a genre tag that says otherwise still rules them out.
  if (keys.length && !crit.artists.length && ports.related) {
    for (const ask of genreAsks(keys, GENRE_ASKS_MAX, o.turn ?? 0).filter((a) => a.kind === 'artist').slice(0, WIDEN_ASKS)) {
      ports.check?.();
      say(`Artists like ${ask.term}`);
      let near: { name: string; id?: string }[] = [];
      try { near = (await ports.related(ask.term)).slice(0, WIDEN_ARTISTS); } catch { continue; }
      for (const n of near) {
        try {
          for (const t of (await ports.artistTop(n.name, n.id)).slice(0, WIDEN_SONGS)) pool.push({ track: t, source: crit.genres.length ? 'genre' : 'taste', from: ask.genre, genre: ask.genre });
        } catch { missed.push(n.name); }
      }
    }
  }
  // Songs whose genre is not known yet cannot be shown to meet the chosen genres: look them up first.
  if (crit.genres.length) {
    const unknown = pool.filter((c) => !c.genre && !(c.track.tags ?? []).length).map((c) => c.track);
    if (unknown.length) { say('Checking genres'); await ports.enrichGenres(unknown.slice(0, 60)); }
  }
  ports.check?.();
  const effective = crit.genres.length || !keys.length ? crit : { ...crit, genres: [] };
  return { picked: pickCustom(pool, effective, o), candidates: pool.length, missed };
}
