/**
 * ARTIST-ALL-SOURCES-001. Owner: "ensure the artist / discography page pulls from all sources".
 *
 * An artist page is built from Deezer and YouTube Music. This reads the other platforms that have a
 * page of the artist's own and adds what the page lacks: SoundCloud uploads and sets, Apple Music
 * albums, Bandcamp releases, Audius uploads.
 *
 * The hard part is whose page it is. Measured 2026-11-16: Apple Music has four artists named "Sade"
 * and four named "Ken Carson"; Bandcamp has "kencarsonxperiment" and "kencarson1", neither his;
 * SoundCloud and Audius are full of accounts that took a famous name. A page is read as this artist's
 * only when the platform vouches for it (SoundCloud `verified`, Audius `is_verified`) or its
 * releases are ones the artist is already known for. No page is better than a stranger's.
 *
 * HearThis and the Internet Archive have no artist page to vouch for anything (a search by name finds
 * DJ mixes and bootlegs), and Spotify has none this app can read without an account, so none of the
 * three is asked. Every song added plays whole: a SoundCloud clip keeps its real length and loses the
 * clip link, a gated Audius upload and a purchase-only Bandcamp song are left out.
 */
import { BudgetExceeded, Cancelled, type Http } from './net';
import { cleanAlbumTitle } from './album-key';
import { parseItunesAlbums, parseScAlbums, type Albums, type AlbumSummary } from './albums';
import { artistCache, whyNotRead, type Ctx, type SourceWhy } from './artists';
export type { Ctx } from './artists';
import type { Audius } from './audius';
import type { Bandcamp, BandcampBand } from './bandcamp';
import { fold, parseTitle } from './identity';
import type { SoundCloud } from './soundcloud';
import { songKey } from './song-key';
import type { Store } from './store';
import type { Track } from './track';

type Json = Record<string, any>;


/** The platforms read here, in the order their songs and records are kept when two have the same one. */
export const EXTRA_SOURCES = ['soundcloud', 'apple', 'bandcamp', 'audius'] as const;
export type ExtraSourceName = (typeof EXTRA_SOURCES)[number];

/**
 * What one platform did. `none`: it answered and has no page that can be shown to be this artist's.
 * `checked`: how many uploads or releases its page holds, whether or not the page already had them.
 * `note: 'unverified'`: the account is not vouched for by the platform; its uploads matched.
 */
export interface ExtraSource {
  state: 'ok' | 'none' | 'failed';
  why?: SourceWhy;
  checked?: number;
  note?: 'unverified';
}

export interface ArtistExtras {
  /** Songs the page does not have, each once. */
  songs: Track[];
  albums: AlbumSummary[];
  singles: AlbumSummary[];
  sources: Record<string, ExtraSource>;
}

/** What is already on the page: enough to tell the artist from a namesake, and to add nothing twice. */
export interface ExtrasPage {
  id: string;
  name: string;
  songs: readonly Pick<Track, 'title'>[];
  features: readonly Pick<Track, 'title'>[];
  albums: readonly Pick<AlbumSummary, 'title'>[];
  singles: readonly Pick<AlbumSummary, 'title'>[];
}

const SC_PAGES = 3;
const SC_PAGE_SIZE = 200;
const APPLE_CANDIDATES = 3;
const BANDCAMP_CANDIDATES = 2;
/** Releases opened per look: each is one small request, and the newest come first. */
const BANDCAMP_READS = 20;
const BANDCAMP_AT_ONCE = 4;
const DAY = 86400;

const compact = (s: string) => fold(s).replace(/\s+/g, '');
const albumTitleKey = (title: string) => fold(cleanAlbumTitle(regionless(title)));

const REGION_WORDS = new Set(['world', 'worldwide', 'ex', 'excl', 'excluding', 'except', 'outside', 'n', 's', 'north', 'south', 'latin', 'america', 'americas', 'europe', 'eu', 'uk', 'us', 'usa', 'japan', 'asia', 'australia', 'canada', 'rest', 'of', 'the', 'row', 'and', 'edition', 'version', 'release', 'only', 'territories']);
const REGIONS = new Set(['america', 'americas', 'europe', 'eu', 'uk', 'us', 'usa', 'japan', 'asia', 'australia', 'canada', 'world', 'worldwide', 'row']);

/**
 * EDITIONS-001. Measured 2026-11-16 on khruangbin.bandcamp.com: one record is listed once per sales
 * region, "Con Todo El Mundo (World ex N & S America)" beside "Con Todo El Mundo (N & S America
 * Edition)", and both stood on the page next to the "Con Todo El Mundo" it already had. A closing
 * note that says nothing but where the record is sold is not part of its name. Anything else in
 * brackets ("Remixes", "Live in America") is left alone.
 */
export function regionless(title: string): string {
  const m = /^(.+?)\s*(?:\(([^()]+)\)|\s[-\u2013\u2014]\s+([^()]+))\s*$/.exec(title.trim());
  if (!m) return title;
  const words = fold(m[2] ?? m[3] ?? '').split(' ').filter(Boolean);
  if (!words.length || !words.every((w) => REGION_WORDS.has(w)) || !words.some((w) => REGIONS.has(w))) return title;
  return m[1]!.trim();
}

/** An account that is this artist under the name it uses there: "SadeOfficial", "Kendrick Lamar Music". */
export function sameAccount(account: string, name: string): boolean {
  const a = compact(account);
  const n = compact(name);
  if (!n || !a) return false;
  return a === n || a.replace(/(?:official|music|vevo)+$/, '') === n || a.replace(/^official/, '') === n;
}

/** The titles this artist is known for: their records and songs, as each would be written anywhere. */
export function knownTitles(page: ExtrasPage): Set<string> {
  const out = new Set<string>();
  const add = (k: string) => { if (k.length >= 3) out.add(k); };
  for (const a of [...page.albums, ...page.singles]) {
    add(albumTitleKey(a.title));
    add(parseTitle(a.title).core);
  }
  for (const t of [...page.songs, ...page.features]) add(parseTitle(t.title).core);
  return out;
}

/**
 * Whether the page already has this record. Measured: Bandcamp lists "Khruangbin: Live at Sydney Opera
 * House" and "Khruangbin & Toro y Moi: Live at The Fillmore Miami" where Deezer has "Live at ...", so
 * a title that is the artist's name and then a record the page has is that record.
 */
export function hasRecord(known: ReadonlySet<string>, title: string, name: string): boolean {
  const k = albumTitleKey(title);
  if (!k) return false;
  if (known.has(k)) return true;
  const n = fold(name);
  if (!n || !(k === n || k.startsWith(`${n} `))) return false;
  for (const h of known) if (h.length >= 3 && k.endsWith(` ${h}`)) return true;
  return false;
}

/** Whether the artist is one of those a release is credited to: "HXG & Ken Carson", not "Southside (feat. ...)". */
const creditedTo = (credit: string, name: string): boolean =>
  credit.split(/\s*(?:,|&|\band\b|\bx\b|\bwith\b)\s*/i).some((p) => fold(p) === fold(name)) || fold(credit) === fold(name);

const overlap = (titles: readonly string[], known: ReadonlySet<string>): number =>
  new Set(titles.flatMap((t) => [albumTitleKey(t), parseTitle(t).core]).filter((k) => known.has(k))).size;

/** The verified account that is this artist, else same-named accounts with uploads to compare, most followed first. */
export function pickSoundCloud(users: readonly Json[], name: string): { verified: Json | null; maybe: Json[] } {
  const rows = users.filter((u) => u && u['id'] && typeof u['username'] === 'string');
  const verified = rows.find((u) => u['verified'] === true && sameAccount(String(u['username']), name)) ?? null;
  if (verified) return { verified, maybe: [] };
  const maybe = rows
    .filter((u) => fold(String(u['username'])) === fold(name) && Number(u['track_count']) > 0)
    .sort((a, b) => Number(b['followers_count'] ?? 0) - Number(a['followers_count'] ?? 0))
    .slice(0, 2);
  return { verified: null, maybe };
}

/** Audius vouches for an account with `is_verified`; nothing else there says whose it is. */
export function pickAudius(users: readonly Json[], name: string): Json | null {
  return users.find((u) => u && u['id'] && u['is_verified'] === true && (sameAccount(String(u['name'] ?? ''), name) || compact(String(u['handle'] ?? '')) === compact(name))) ?? null;
}

/** Bandcamp pages of exactly this name at an address that is the name: "khruangbin.bandcamp.com". */
export function pickBandcamp(bands: readonly Json[] | readonly BandcampBand[], name: string): BandcampBand[] {
  const out: BandcampBand[] = [];
  for (const b of bands as readonly Json[]) {
    const url = String(b?.['url'] ?? b?.['item_url_root'] ?? '');
    const slug = /^https:\/\/([a-z0-9-]+)\.bandcamp\.com\/?$/i.exec(url)?.[1];
    const id = Number(b?.['id']);
    if (!slug || !Number.isSafeInteger(id) || id <= 0) continue;
    if (fold(String(b['name'] ?? '')) !== fold(name) || !sameAccount(slug.replace(/-/g, ' '), name)) continue;
    out.push({ id, name: String(b['name']), url });
  }
  return out.slice(0, BANDCAMP_CANDIDATES);
}

/** Every Apple Music artist of exactly this name; which one is meant is decided by their records. */
export function appleCandidates(resp: unknown, name: string): string[] {
  const rows = ((resp as Json)?.['results'] as Json[] | undefined) ?? [];
  const ids = rows
    .filter((x) => x && x['wrapperType'] === 'artist' && /^\d{1,15}$/.test(String(x['artistId'] ?? '')) && fold(String(x['artistName'] ?? '')) === fold(name))
    .map((x) => String(x['artistId']));
  return [...new Set(ids)].slice(0, APPLE_CANDIDATES);
}

interface Part {
  source: ExtraSource;
  songs: Track[];
  albums: AlbumSummary[];
}
const NONE: Part = { source: { state: 'none' }, songs: [], albums: [] };

export class ArtistExtrasReader {
  constructor(
    private readonly http: Http,
    private readonly store: Store | undefined,
    private readonly deps: { sc?: SoundCloud; bandcamp?: Bandcamp; audius?: Audius; albums?: Albums },
  ) {}

  private opts(c: Ctx, category: 'metadata' | 'search', maxBytes: number): Parameters<Http['getJson']>[1] {
    const o: Parameters<Http['getJson']>[1] = { category, maxBytes };
    if (c.meter) o.meter = c.meter;
    if (c.token) o.token = c.token;
    return o;
  }

  /**
   * The four platforms asked together; one that cannot be read keeps what the others gave and says
   * why. A whole answer is kept a day; one with a failure in it is asked again the next time.
   */
  async read(page: ExtrasPage, c: Ctx = {}): Promise<ArtistExtras> {
    const store = artistCache(this.store, c);
    const key = `artistextra3:${page.id}:${fold(page.name)}`;
    const hit = store?.cacheGet(key)?.value as ArtistExtras | undefined;
    if (hit) return hit;
    const known = knownTitles(page);
    const guard = (fn: () => Promise<Part>): Promise<Part> =>
      fn().catch((e): Part => {
        if (e instanceof Cancelled) throw e;
        return { source: { state: 'failed', why: e instanceof BudgetExceeded ? 'allowance' : whyNotRead(e) }, songs: [], albums: [] };
      });
    const name = page.name.trim();
    const parts: Record<ExtraSourceName, Part> = name
      ? Object.fromEntries(await Promise.all([
        guard(() => this.soundcloud(name, known, c)).then((p) => ['soundcloud', p] as const),
        guard(() => this.apple(name, known, c)).then((p) => ['apple', p] as const),
        guard(() => this.bandcampPage(name, known, c)).then((p) => ['bandcamp', p] as const),
        guard(() => this.audiusPage(name, c)).then((p) => ['audius', p] as const),
      ])) as Record<ExtraSourceName, Part>
      : { soundcloud: NONE, apple: NONE, bandcamp: NONE, audius: NONE };

    const haveSong = new Set([...page.songs, ...page.features].map(songKey));
    const songs: Track[] = [];
    for (const p of EXTRA_SOURCES) {
      for (const t of parts[p].songs) {
        const k = songKey(t);
        if (!t.title || haveSong.has(k)) continue;
        haveSong.add(k);
        songs.push(t);
      }
    }
    const haveAlbum = new Set([...page.albums, ...page.singles].map((a) => albumTitleKey(a.title)));
    const added: AlbumSummary[] = [];
    // A record the platform itself plays whole comes before one whose songs must be found elsewhere.
    for (const p of ['soundcloud', 'bandcamp', 'apple', 'audius'] as const) {
      for (const a of parts[p].albums) {
        const k = albumTitleKey(a.title);
        if (!k || hasRecord(haveAlbum, a.title, name)) continue;
        haveAlbum.add(k);
        added.push(a);
      }
    }
    const newest = (list: AlbumSummary[]) => list.map((a, i) => ({ a, i })).sort((x, y) => Number(y.a.year ?? 0) - Number(x.a.year ?? 0) || x.i - y.i).map((x) => x.a);
    const out: ArtistExtras = {
      songs,
      albums: newest(added.filter((a) => a.kind !== 'single')),
      singles: newest(added.filter((a) => a.kind === 'single')),
      sources: Object.fromEntries(EXTRA_SOURCES.map((p) => [p, parts[p].source])),
    };
    if (!Object.values(out.sources).some((s) => s.state === 'failed')) await store?.cachePut(key, 'artist', out, DAY);
    return out;
  }

  // ---- SoundCloud ---------------------------------------------------------------------------------

  private async scUploads(sc: SoundCloud, id: string, pages: number, c: Ctx): Promise<Json[]> {
    const rows: Json[] = [];
    let path: string | null = `/users/${id}/tracks?limit=${SC_PAGE_SIZE}&linked_partitioning=1`;
    for (let p = 0; path && p < pages; p++) {
      const d: Json = await sc.api(path, c);
      rows.push(...(((d?.['collection'] as Json[] | undefined) ?? []).filter((t) => t && t['kind'] === 'track' && t['title'])));
      path = null;
      // Only a later page of this same list, on SoundCloud's own api host, is ever followed.
      const next = typeof d?.['next_href'] === 'string' ? d['next_href'] : '';
      if (!next) break;
      try {
        const u = new URL(next);
        if (u.protocol === 'https:' && u.hostname === 'api-v2.soundcloud.com' && u.pathname === `/users/${id}/tracks`) path = u.pathname + u.search;
      } catch { /* not an address: the list ends here */ }
    }
    return rows;
  }

  private async soundcloud(name: string, known: ReadonlySet<string>, c: Ctx): Promise<Part> {
    const sc = this.deps.sc;
    if (!sc) return NONE;
    const found: Json = await sc.api(`/search/users?q=${encodeURIComponent(name)}&limit=10`, c);
    const pick = pickSoundCloud((found?.['collection'] as Json[] | undefined) ?? [], name);
    let account = pick.verified;
    let uploads: Json[] | null = null;
    if (!account) {
      // Not vouched for: it is this artist only when its own uploads are songs they are known for.
      for (const u of pick.maybe) {
        const rows = await this.scUploads(sc, String(u['id']), 1, c);
        const n = overlap(rows.map((t) => sc.toTrack(t).title), known);
        // Two titles: one in common is what a fan's re-upload of a known song looks like.
        if (n >= 2) {
          account = u;
          uploads = rows;
          break;
        }
      }
      if (!account) return NONE;
    }
    const id = String(account['id']);
    if (!/^\d{1,15}$/.test(id)) return NONE;
    uploads ??= await this.scUploads(sc, id, SC_PAGES, c);
    const songs = uploads.map((t) => sc.toTrack(t));
    let albums: AlbumSummary[] = [];
    if (pick.verified) {
      // The sets are extra: failing to read them keeps the uploads.
      albums = await sc.api(`/users/${id}/albums?limit=${SC_PAGE_SIZE}`, c).then((d: Json) => parseScAlbums(d), (e: unknown) => {
        if (e instanceof BudgetExceeded || e instanceof Cancelled) throw e;
        return [];
      });
    }
    return { source: { state: 'ok', checked: songs.length + albums.length, ...(pick.verified ? {} : { note: 'unverified' as const }) }, songs, albums };
  }

  // ---- Apple Music --------------------------------------------------------------------------------

  private async apple(name: string, known: ReadonlySet<string>, c: Ctx): Promise<Part> {
    // With nothing to compare, a same-named artist could be anyone.
    if (!known.size) return NONE;
    const found = await this.http.getJson<Json>(`https://itunes.apple.com/search?term=${encodeURIComponent(name)}&entity=musicArtist&limit=10`, this.opts(c, 'search', 300_000));
    const ids = appleCandidates(found, name);
    if (!ids.length) return NONE;
    const read = await Promise.all(ids.map(async (id) => {
      const albums = parseItunesAlbums(await this.http.getJson<Json>(`https://itunes.apple.com/lookup?id=${id}&entity=album&limit=200`, this.opts(c, 'search', 1_500_000)));
      return { albums, n: overlap(albums.map((a) => a.title), known) };
    }));
    const best = Math.max(...read.map((r) => r.n));
    if (best < 1) return NONE;
    // The one whose records are this artist's; a second profile of theirs must show it twice over.
    const theirs = read.filter((r) => r.n === best || r.n >= 2);
    // Apple Music also lists the singles other artists have them on; those are features, not releases.
    const albums = theirs.flatMap((r) => r.albums).filter((a) => creditedTo(a.artist, name));
    return { source: { state: 'ok', checked: albums.length }, songs: [], albums };
  }

  // ---- Bandcamp -----------------------------------------------------------------------------------

  private async bandcampPage(name: string, known: ReadonlySet<string>, c: Ctx): Promise<Part> {
    const bc = this.deps.bandcamp;
    const albums = this.deps.albums;
    if (!bc || !albums || !known.size) return NONE;
    for (const band of pickBandcamp(await bc.bands(name, c), name)) {
      const items = await bc.discography(band.id, c);
      if (overlap(items.map((x) => x.title), known) < 1) continue;
      const fresh = items.filter((x) => !hasRecord(known, x.title, name)).slice(0, BANDCAMP_READS);
      const out: (AlbumSummary & { tracks: Track[] } | null)[] = new Array(fresh.length).fill(null);
      let next = 0;
      const worker = async () => {
        while (next < fresh.length) {
          const i = next++;
          const x = fresh[i]!;
          const view = await albums.open(`bc:${x.bandId}:${x.type}${x.id}`, c).catch((e: unknown) => {
            if (e instanceof BudgetExceeded || e instanceof Cancelled) throw e;
            return null;
          });
          if (view && view.tracks.length) out[i] = { ...view, year: view.year ?? x.year };
        }
      };
      await Promise.all(Array.from({ length: Math.min(BANDCAMP_AT_ONCE, fresh.length) }, worker));
      // EDITIONS-001: a record sold by region is one record, the edition with the most that plays
      // in full, under its own name.
      const best = new Map<string, AlbumSummary & { tracks: Track[] }>();
      for (const v of out) {
        if (!v) continue;
        const k = albumTitleKey(v.title);
        const had = best.get(k);
        if (!had || v.tracks.length > had.tracks.length) best.set(k, { ...v, title: regionless(v.title) });
      }
      const got = [...best.values()];
      return {
        source: { state: 'ok', checked: items.length },
        // COMPILATION-001: a mix the artist put together is theirs to list; the songs on it are
        // their makers'. Only what is credited to this artist joins this artist's songs.
        songs: got.flatMap((v) => v.tracks.filter((t) => t.artists.some((a) => creditedTo(a, name)))),
        albums: got.map(({ id, provider, title, artist, artwork, year, kind, count, url }) => ({ id, provider, title, artist, artwork, year, kind, count, url })),
      };
    }
    return NONE;
  }

  // ---- Audius -------------------------------------------------------------------------------------

  private async audiusPage(name: string, c: Ctx): Promise<Part> {
    const au = this.deps.audius;
    if (!au) return NONE;
    const account = pickAudius(await au.users(name, c), name);
    if (!account) return NONE;
    const songs = await au.userTracks(String(account['id']), c);
    return { source: { state: 'ok', checked: songs.length }, songs, albums: [] };
  }
}
