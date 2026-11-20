// RADIO-ALL-STATIONS-001: iHeart's live-station directory as a second source beside Radio Browser.
// Radio Browser is volunteer-edited and misses big commercial stations (no V103/WVAZ, no Power 92/WPWX in
// Chicago). iHeart lists every station it carries around a US place — its own and other broadcasters' —
// with logo, website, genres and a playable stream. Records are station facts only; genre names are
// directory labels and never song or taste evidence (RADIO-001).
import { publicUrl, stationMatchesInitial, stationMatchesQuery, type RadioStation } from './radio';

export const IHEART_API = 'https://api.iheart.com/api';
export interface IheartStation extends RadioStation { call: string; frequency: string }

const text = (v: unknown, max = 300) => String(v ?? '').trim().slice(0, max);
const web = (v: unknown) => { const t = text(v, 500); if (!t) return ''; const u = /^https?:\/\//i.test(t) ? t : 'https://' + t; return publicUrl(u) ? u : ''; };

/** A direct stream first (secure, then plain) so the ICY titles and the iHeart song feed keep working; HLS last. */
export function streamOf(streams: unknown): string {
  const s = (streams && typeof streams === 'object' ? streams : {}) as Record<string, unknown>;
  for (const k of ['secure_shoutcast_stream', 'shoutcast_stream', 'secure_hls_stream', 'hls_stream']) {
    const u = text(s[k], 1000);
    if (u && publicUrl(u)) return u;
  }
  return '';
}

const genreTags = (genres: unknown): string[] => (Array.isArray(genres) ? genres : [])
  .flatMap((g) => text((g as { name?: unknown })?.name, 80).toLowerCase().split(/\s+(?:and|&)\s+/))
  .map((t) => t.trim()).filter(Boolean).filter((t, i, a) => a.indexOf(t) === i).slice(0, 10);

const SPANISH = /\b(spanish|mexican|tejano|regional mexicano|latin|tropical|reggaeton|bachata|salsa|cumbia)\b/;

export function stationFromIheart(o: unknown): IheartStation | null {
  const r = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
  const n = Number(r.id), name = text(r.name, 200), url = streamOf(r.streams);
  if (!Number.isInteger(n) || n <= 0 || !name || !url) return null;
  const market = (Array.isArray(r.markets) ? r.markets : []).find((m: Record<string, unknown>) => m?.origin) ?? (Array.isArray(r.markets) ? r.markets[0] : null) ?? {};
  const m = market as Record<string, unknown>;
  const cc = text(m.country || r.countries, 2).toUpperCase();
  const tags = genreTags(r.genres);
  const logo = web(r.logo).replace(/\?.*$/, '');
  return {
    id: `ihr-${n}`, name, url, homepage: web(r.website), image: logo,
    country: cc === 'US' ? 'The United States Of America' : '', countryCode: cc,
    region: [text(m.city, 80), text(m.stateAbbreviation, 4)].filter(Boolean).join(', '),
    language: tags.some((t) => SPANISH.test(t)) ? 'spanish' : cc === 'US' ? 'english' : '',
    tags, codec: 'AAC', bitrate: 0, latitude: null, longitude: null,
    call: text(r.callLetters, 12).toUpperCase().replace(/-(FM|AM|HD\d*)$/, ''), frequency: text(r.freq, 8),
  };
}

export function parseIheartStations(raw: string): IheartStation[] {
  try {
    const hits = (JSON.parse(raw) as { hits?: unknown })?.hits;
    const out: IheartStation[] = [], seen = new Set<string>();
    for (const h of Array.isArray(hits) ? hits.slice(0, 300) : []) { const s = stationFromIheart(h); if (s && !seen.has(s.id)) { seen.add(s.id); out.push(s); } }
    return out;
  } catch { return []; }
}

export const iheartNearUrl = (lat: number, lon: number) => `${IHEART_API}/v2/content/liveStations?limit=200&lat=${lat.toFixed(4)}&lng=${lon.toFixed(4)}`;
export const iheartIdsUrl = (ids: readonly string[]) => `${IHEART_API}/v2/content/liveStations?${new URLSearchParams({ limit: '12', id: ids.slice(0, 12).join(',') })}`;
export const iheartSearchUrl = (q: string) => `${IHEART_API}/v3/search/all?${new URLSearchParams({ keywords: q.trim().slice(0, 80), bundle: 'false', station: 'true', artist: 'false', track: 'false', playlist: 'false', podcast: 'false', keyword: 'true', countryCode: 'US', startIndex: '0', maxRows: '12' })}`;
export function parseIheartSearch(raw: string): string[] {
  try {
    const st = (JSON.parse(raw) as { results?: { stations?: unknown } })?.results?.stations;
    return (Array.isArray(st) ? st : []).map((s: { id?: unknown }) => s?.id).filter((id): id is number => Number.isInteger(id) && (id as number) > 0).slice(0, 12).map(String);
  } catch { return []; }
}

/** A typed search matches the brand name, the call letters or the dial number. */
export function iheartMatches(s: IheartStation, query: string): boolean {
  if (!query.trim()) return true;
  return [s.name, `${s.call} ${s.frequency}`, `${s.frequency} ${s.call}`].some((n) => stationMatchesQuery(n, query));
}
export const iheartMatchesInitial = (s: IheartStation, letter: string) => !letter || stationMatchesInitial(s.name, letter) || stationMatchesInitial(s.call, letter);

/** Directory filters applied here, because iHeart's list is not filtered by the server. */
export function iheartFits(s: IheartStation, f: { query?: string; letter?: string; language?: string; tag?: string }): boolean {
  if (!iheartMatches(s, f.query || '') || !iheartMatchesInitial(s, f.letter || '')) return false;
  if (f.language && !s.language.toLowerCase().includes(f.language.toLowerCase())) return false;
  if (f.tag && !s.tags.some((t) => t === f.tag!.toLowerCase())) return false;
  return true;
}

const host = (u: string) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
const callsIn = (name: string) => [...name.toUpperCase().matchAll(/(?:^|[^A-Z])([WK][A-Z]{2,3})(?=$|[^A-Z])/g)].map((m) => m[1]!);

/** The same broadcast in both directories: the call letters in the name, or the same website. */
function same(a: RadioStation, b: IheartStation): boolean {
  if (b.call && callsIn(a.name).includes(b.call)) return true;
  const ha = host(a.homepage), hb = host(b.homepage);
  return !!ha && ha === hb;
}

/** One row per station. A Radio Browser row wins (so starred ids keep working), borrows a missing logo and plays iHeart's stream. */
export function mergeStations(directory: RadioStation[], iheart: IheartStation[]): RadioStation[] {
  const out = directory.slice();
  for (const s of iheart) {
    const at = out.findIndex((x) => x.id === s.id || (!x.id.startsWith('ihr-') && same(x, s)));
    if (at < 0) { out.push(s); continue; }
    // RADIO-IHEART-META-001: iHeart's stream is the one the broadcaster keeps working for iHeart's app; the volunteer
    // directory's link can go stale (WXRT). The row keeps its id (starred stations), name and tags.
    if (out[at]!.id === s.id) continue;
    out[at] = { ...out[at]!, url: s.url, iheartId: s.id.replace(/^ihr-/, ''), image: out[at]!.image || s.image };
  }
  return out;
}
