import { splitOnAir } from './radio-icy';
import type { RadioPlace } from './radio-places';
// RADIO-001. A station is a broadcast, not a song. Only broadcaster metadata or audio recognition
// may identify its current item. Directory genre labels never become song or preference evidence.
export interface RadioStation { id: string; name: string; url: string; homepage: string; image: string; country: string; countryCode: string; region: string; language: string; tags: string[]; codec: string; bitrate: number; latitude: number | null; longitude: number | null }
export interface Broadcast { state: 'current' | 'stale' | 'unavailable' | 'failed'; kind: 'song' | 'programme'; title: string; artist: string | null; source: string; checkedAt: number; detail?: string; startedAt?: number | null; duration?: number | null; validUntil?: number | null; artwork?: string | null }
export const DIRECTORY_SERVERS = ['https://de1.api.radio-browser.info', 'https://nl1.api.radio-browser.info', 'https://at1.api.radio-browser.info'];
export function publicUrl(raw: string): boolean {
  try { const u = new URL(raw); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password && !/^(localhost|127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[|.*\.local$)/i.test(u.hostname); } catch { return false; }
}
const txt = (v: unknown) => String(v ?? '').trim().slice(0, 500);
export function normalizeStation(o: Record<string, unknown>): RadioStation | null {
  const url = txt(o.url_resolved || o.url), id = txt(o.stationuuid), name = txt(o.name);
  if (!id || !name || !publicUrl(url)) return null;
  return { id, name, url, homepage: publicUrl(txt(o.homepage)) ? txt(o.homepage) : '', image: publicUrl(txt(o.favicon)) ? txt(o.favicon) : '', country: txt(o.country), countryCode: txt(o.countrycode), region: txt(o.state), language: txt(o.language), tags: txt(o.tags).split(',').map(x => x.trim()).filter(Boolean).slice(0, 10), codec: txt(o.codec), bitrate: Number(o.bitrate) || 0, latitude: o.geo_lat == null ? null : Number(o.geo_lat), longitude: o.geo_long == null ? null : Number(o.geo_long) };
}
export const stationLocation = (s: RadioStation) => [...new Set([s.region, s.country].filter(Boolean))].join(', ') || 'Location not supplied';
export function parseBroadcast(raw: string | null, source: string, checkedAt = Date.now()): Broadcast {
  const t = txt(raw).replace(/\u0000/g, '').replace(/<[^>]*>/g, '').trim();
  if (!t || /^(unknown|undefined|null|stream offline|no title|auto ?dj|advertisement)$/i.test(t)) return { state: 'unavailable', kind: 'programme', title: '', artist: null, source, checkedAt };
  const item = splitOnAir(t);
  if (!item) return { state: 'unavailable', kind: 'programme', title: '', artist: null, source, checkedAt };
  return { state: 'current', kind: item.artist ? 'song' : 'programme', title: item.title, artist: item.artist, source, checkedAt };
}
export function freshBroadcast(b: Broadcast, now = Date.now()): Broadcast { return b.state === 'current' && (now - b.checkedAt > 90000 || !!b.validUntil && now > b.validUntil || !!b.startedAt && !!b.duration && now > b.startedAt + (b.duration + 15) * 1000) ? { ...b, state: 'stale' } : b; }
/** RADIO-TASTE-001: this share of a song's own length heard on the radio is a full listen. */
export const RADIO_FULL_LISTEN_SHARE = 0.7;
/**
 * What a stretch of radio listening is worth to the listener's taste. Nothing unless the song is
 * identified and thirty seconds of it were really heard; a full listen once most of the recording
 * was heard. A song of unknown length can never be called a full listen.
 */
export function heardCredit(x: { identified: boolean; kind: Broadcast['kind']; heard: number; duration: number | null }): { eligible: boolean; coverage: number; full: boolean } {
  const coverage = Math.max(0, Math.min(x.heard, x.duration || x.heard));
  const eligible = x.identified && x.kind === 'song' && Number.isFinite(coverage) && coverage >= 30;
  const dur = Number(x.duration);
  return { eligible, coverage, full: eligible && Number.isFinite(dur) && dur > 0 && coverage >= dur * RADIO_FULL_LISTEN_SHARE };
}
export type RadioRequest = (url: string) => Promise<string>;
export interface RadioSearch { query?: string; country?: string; language?: string; tag?: string; letter?: string; offset?: number;
  /** RADIO-PLACES-001: the listener's chosen places; when any are given they replace `country`. */
  places?: readonly RadioPlace[] }
export const STATION_LETTERS = ['', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'] as const;
export const STATION_NUMBERS = ['', ...'0123456789'] as const;
const foldedStationName = (name: string) => name.normalize('NFKD').replace(/\p{M}/gu, '').toUpperCase();
const stationCalls = (name: string): string[] => [...foldedStationName(name).matchAll(/(?:^|[^A-Z])([WK][A-Z]{2,3})(?=$|[^A-Z])/g)].map(m => m[1]!);
/** Frequency/number aliases come from the real name, never a fabricated dial mapping. */
export function stationNumbers(name: string): string[] {
  const clean = foldedStationName(name).replace(/\b(?:MP3|AAC\d*|HD\d+)\b/g, ' ').replace(/\b\d+\s*(?:KBPS|KBIT(?:\/S)?|KB\/S)\b/g, ' ');
  return [...new Set((clean.match(/\d+(?:[.,]\d+)?/g) || []).map(n => n.replace(',', '.')))];
}
export function stationQueryParts(query: string): { call: string | null; frequency: string | null } | null {
  const compact = foldedStationName(query.trim()).replace(/(?:\s+|-)(?:FM|AM)$/, '').replace(/[\s-]+/g, '');
  const callFirst = compact.match(/^([WK][A-Z]{2,3})(\d+(?:[.,]\d*)?)?$/), numberFirst = compact.match(/^(\d+(?:[.,]\d*)?)([WK][A-Z]{2,3})$/);
  if (callFirst) return { call: callFirst[1]!, frequency: callFirst[2]?.replace(',', '.') || null };
  if (numberFirst) return { call: numberFirst[2]!, frequency: numberFirst[1]!.replace(',', '.') };
  if (/^\d{1,4}(?:[.,]\d*)?$/.test(compact)) return { call: null, frequency: compact.replace(',', '.') };
  return null;
}
export function stationQuerySource(query: string): string {
  const p = stationQueryParts(query); return p?.call || p?.frequency?.split('.')[0] || query.trim();
}
export function stationMatchesQuery(name: string, query: string): boolean {
  if (!query.trim()) return true;
  const p = stationQueryParts(query);
  if (!p) return foldedStationName(name).includes(foldedStationName(query.trim()));
  return (!p.call || stationCalls(name).includes(p.call)) && (!p.frequency || stationNumbers(name).some(n => n.startsWith(p.frequency!)));
}
/** Letter index follows the call sign/brand even if the directory puts a frequency first. */
export function stationInitial(name: string): string {
  const call = stationCalls(name)[0]; if (call) return call[0]!;
  const brand = foldedStationName(name.trimStart()).replace(/^[^\p{L}]+/u, '').replace(/^(?:FM|AM|HD)\b[\s:-]*/, '');
  const first = brand.charAt(0); return /^[A-Z]$/.test(first) ? first : '#';
}
export function stationMatchesInitial(name: string, initial: string): boolean {
  return !initial || (/^[0-9]$/.test(initial) ? stationNumbers(name).some(n => n.startsWith(initial)) : stationInitial(name) === initial);
}

export class RadioDirectory {
  private aliases = new Map<string, RadioStation>();
  private namedMatches: RadioStation[] = [];
  private rememberAlias(station: RadioStation) {
    const p = stationQueryParts(station.name);
    this.namedMatches = this.namedMatches.map(s => s.id === station.id ? station : s);
    this.aliases.delete(station.id);
    if (p?.call && p.frequency) this.aliases.set(station.id, station);
    while (this.aliases.size > 128) this.aliases.delete(this.aliases.keys().next().value!);
  }
  constructor(private request: RadioRequest) {}
  async read(path: string): Promise<unknown> { let last: unknown; for (const host of DIRECTORY_SERVERS) { try { return JSON.parse(await this.request(host + path)); } catch (e) { last = e; } } throw last; }
  async search(opts: RadioSearch = {}): Promise<RadioStation[]> { return (await this.page(opts)).stations; }
  /** Prefix filtering is local because Radio Browser's name parameter is a substring search.
   * Scan bounded candidate batches and return a RAW cursor, including when no match was found yet. */
  async page(opts: RadioSearch = {}): Promise<{ stations: RadioStation[]; nextOffset: number | null }> {
    if (opts.places?.length) return this.placesPage(opts, opts.places);
    const letter = opts.letter || '';
    if (letter && !/^[A-Z0-9#]$/.test(letter)) throw new Error('Invalid station initial');
    let offset = Math.max(0, Math.floor(opts.offset || 0));
    const narrowed = !!letter || !!stationQueryParts(opts.query || '');
    const limit = narrowed ? 120 : 24, visibleLimit = (stationQueryParts(opts.query || '')?.frequency?.length || 0) >= 2 ? 48 : 24, out: RadioStation[] = [], seen = new Set<string>();
    if (narrowed && offset === 0) {
      const cached = [...this.namedMatches, ...[...this.aliases.values()].reverse()];
      for (const station of cached) {
        if (out.length >= 12) break;
        if (seen.has(station.id) || !stationMatchesInitial(station.name, letter) || !stationMatchesQuery(station.name, opts.query || '') ||
          (opts.country && station.countryCode.toUpperCase() !== opts.country.toUpperCase()) ||
          (opts.language && !station.language.toLowerCase().includes(opts.language.toLowerCase())) ||
          (opts.tag && !station.tags.some(t => t.toLowerCase() === opts.tag!.toLowerCase()))) continue;
        seen.add(station.id); out.push(station);
      }
    }
    for (let batch = 0; batch < (narrowed ? 2 : 1); batch++) {
      const q = new URLSearchParams({ hidebroken: 'true', order: narrowed ? 'name' : 'clickcount', reverse: narrowed ? 'false' : 'true', limit: String(limit), offset: String(offset) });
      const name = opts.query?.trim() ? stationQuerySource(opts.query) : letter === '#' ? '' : letter;
      if (name) q.set('name', name);
      if (opts.country) q.set('countrycode', opts.country);
      if (opts.language) q.set('language', opts.language);
      if (opts.tag) { q.set('tag', opts.tag); q.set('tagExact', 'true'); }
      const data = await this.read(`/json/stations/search?${q}`);
      if (!Array.isArray(data)) throw new Error('The station directory returned an invalid page');
      for (let index = 0; index < data.length; index++) {
        const station = normalizeStation(data[index]);
        if (!station || !stationMatchesInitial(station.name, letter) || !stationMatchesQuery(station.name, opts.query || '')) continue;
        this.rememberAlias(station);
        if (seen.has(station.id)) { const at = out.findIndex(s => s.id === station.id); if (at >= 0) out[at] = station; continue; }
        seen.add(station.id); out.push(station);
        if (stationQueryParts(opts.query || '')?.call) this.namedMatches = out.slice(0, 12);
        if (out.length === visibleLimit) return { stations: out, nextOffset: index + 1 < data.length || data.length === limit ? offset + index + 1 : null };
      }
      offset += data.length;
      if (data.length < limit) return { stations: out, nextOffset: null };
    }
    return { stations: out, nextOffset: offset };
  }

  /**
   * RADIO-PLACES-001: stations for the chosen places. Each place is asked for itself — an area by distance
   * (stations with coordinates) and by the city named as the station's location (stations without), a region by
   * state and country, a country by country — and the answers are interleaved so every place shows near the top.
   */
  private async placesPage(opts: RadioSearch, places: readonly RadioPlace[]): Promise<{ stations: RadioStation[]; nextOffset: number | null }> {
    const letter = opts.letter || '';
    if (letter && !/^[A-Z0-9#]$/.test(letter)) throw new Error('Invalid station initial');
    const offset = Math.max(0, Math.floor(opts.offset || 0)), limit = 24;
    const base = () => {
      const q = new URLSearchParams({ hidebroken: 'true', order: 'clickcount', reverse: 'true', limit: String(limit), offset: String(offset) });
      const name = opts.query?.trim() ? stationQuerySource(opts.query) : letter === '#' ? '' : letter;
      if (name) q.set('name', name);
      if (opts.language) q.set('language', opts.language);
      if (opts.tag) { q.set('tag', opts.tag); q.set('tagExact', 'true'); }
      return q;
    };
    const asks: URLSearchParams[] = [];
    for (const p of places.slice(0, 8)) {
      if (p.kind === 'country') { const q = base(); q.set('countrycode', p.countryCode); asks.push(q); continue; }
      if (p.kind === 'region') { const q = base(); q.set('state', p.region); if (p.countryCode) q.set('countrycode', p.countryCode); asks.push(q); continue; }
      const near = base(); near.set('geo_lat', p.lat.toFixed(5)); near.set('geo_long', p.lon.toFixed(5)); near.set('geo_distance', String(Math.round(p.radiusKm * 1000))); asks.push(near);
      if (p.city) { const named = base(); named.set('state', p.city); if (p.countryCode) named.set('countrycode', p.countryCode); asks.push(named); }
    }
    const lists = await Promise.all(asks.map(async (q) => {
      const data = await this.read(`/json/stations/search?${q}`).catch(() => []);
      return Array.isArray(data) ? data : [];
    }));
    const out: RadioStation[] = [], seen = new Set<string>();
    for (let i = 0; lists.some((l) => i < l.length); i++) {
      for (const l of lists) {
        const station = i < l.length ? normalizeStation(l[i]) : null;
        if (!station || seen.has(station.id) || !stationMatchesInitial(station.name, letter) || !stationMatchesQuery(station.name, opts.query || '')) continue;
        seen.add(station.id); out.push(station);
      }
    }
    return { stations: out, nextOffset: lists.some((l) => l.length === limit) ? offset + limit : null };
  }

  async countries(): Promise<{ name: string; code: string; count: number }[]> { const v = await this.read('/json/countrycodes'); return Array.isArray(v) ? v.filter(x => /^[A-Z]{2}$/.test(String(x.iso_3166_1 || x.name))).map(x => ({ name: txt(x.name), code: txt(x.iso_3166_1 || x.name), count: Number(x.stationcount) || 0 })).sort((a, b) => a.name.localeCompare(b.name)) : []; }
}
// Each loaded row is checked, three at a time. No background crawl of the world's directory. A
// visibility pause stops new work; checkedAt is retained so old data is never presented as live.
export class MetadataPoller {
  private stations: RadioStation[] = []; private stopped = false; private running = false; private generation = 0;
  constructor(private probe: (s: RadioStation) => Promise<Broadcast>, private update: (id: string, b: Broadcast) => void) {}
  setStations(s: RadioStation[]) { this.stations = s; this.generation++; }
  stop() { this.stopped = true; }
  async tick() {
    if (this.running || this.stopped) return; this.running = true; const gen = this.generation, stations = this.stations; let i = 0;
    try { await Promise.all(Array.from({ length: 3 }, async () => { while (!this.stopped && gen === this.generation && i < stations.length) { const s = stations[i++]!; let b: Broadcast; try { b = await this.probe(s); } catch (e) { b = { ...parseBroadcast(null, 'Broadcaster'), state: 'failed', detail: e instanceof Error ? e.message : 'Station did not answer' }; } if (!this.stopped && gen === this.generation) this.update(s.id, b); } })); } finally { this.running = false; }
  }
}

/**
 * RADIO-ART-003: passive re-pull for a row that is missing data — a current song with no cover
 * art, art whose URL failed to load, or a failed broadcast probe. One pending attempt per id:
 * a fast first retry, then a bounded backoff in seconds, and a hard stop once the schedule is
 * spent. settle() forgets an id's history when its data arrives, so a later gap starts fresh.
 * Pure scheduling; the caller decides what to fetch, and station tags are never an input here.
 */
export const RETRY_DELAYS = [500, 2500, 5000, 15000] as const;
export class BackgroundRetry {
  private attempts = new Map<string, number>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(private run: (id: string) => void, private delays: readonly number[] = RETRY_DELAYS) {}
  /** Schedule the next background attempt for this id; false once the attempts are spent. */
  ask(id: string): boolean {
    if (this.timers.has(id)) return true;
    const n = this.attempts.get(id) ?? 0;
    if (n >= this.delays.length) return false;
    this.attempts.set(id, n + 1);
    this.timers.set(id, setTimeout(() => { this.timers.delete(id); this.run(id); }, this.delays[n]!));
    return true;
  }
  /** The data arrived (or the row left the page): cancel and forget this id. */
  settle(id: string) { this.attempts.delete(id); const t = this.timers.get(id); if (t !== undefined) { clearTimeout(t); this.timers.delete(id); } }
  stop() { for (const t of this.timers.values()) clearTimeout(t); this.timers.clear(); this.attempts.clear(); }
}

/** RADIO-PLAYER-002: publish provenance, never infer an item's start from the time we tuned in.
 * Broadcaster clocks describe the live edge. Subtract the transport's real timeshift so pause and
 * rewind move the displayed programme time too. Unpublished streaming latency is not measurable.
 */
export function broadcastTimeline(b: Broadcast | null, track: { duration?: number | null } | null, snap: { received: number; position: number; oldest: number } | null, now = Date.now(), bufferOffset?: number, measuredStart?: number | null) {
  const positive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
  const behind = snap ? Math.max(0, snap.received - snap.position) : 0;
  const publishedDuration = positive(b?.duration) ? b.duration : null;
  const catalogueDuration = b?.kind === 'song' && positive(track?.duration) ? track.duration : null;
  const duration = publishedDuration ?? catalogueDuration;
  // RADIO-CLOCK-001: a start measured from the audio itself (fingerprint offset, on the ring's sample
  // clock) is exact for what is being heard; a published start describes the schedule, and the
  // stream runs an unknown delay behind it. Measured wins.
  const measured = !!snap && typeof measuredStart === 'number' && Number.isFinite(measuredStart);
  const hasStart = !measured && positive(b?.startedAt) && b.startedAt <= now;
  const rawElapsed = measured ? Math.max(0, snap!.position - measuredStart!)
    : hasStart ? Math.max(0, Number.isFinite(bufferOffset) && snap ? snap.position + bufferOffset! : (now - b!.startedAt!) / 1000 - behind) : null;
  // A catalogue edition can be shorter than the broadcast. Never clamp a real elapsed clock to
  // the wrong edition, nor present its length as the station's actual edit.
  // RADIO-CLOCK-002: a measured clock belongs to the recording the fingerprint named, so that recording's length is
  // where it ends; the session measures again from there. A broadcaster's clock keeps running past a catalogue length.
  const elapsed = rawElapsed === null ? null : publishedDuration ? Math.min(rawElapsed, publishedDuration) : measured && duration ? Math.min(rawElapsed, duration) : rawElapsed;
  // With no item clock the bar is EMPTY: the playhead's place in the retained buffer sat near the end
  // and read as "this song is almost over". Rewinding stays on the rewind button.
  const max = elapsed !== null ? publishedDuration ?? Math.max(1, duration ?? 0, measured ? elapsed : elapsed + behind) : 1;
  const value = elapsed !== null ? elapsed : 0;
  return { elapsed, duration, durationSource: publishedDuration ? 'broadcaster' : catalogueDuration ? 'catalogue' : null, clockSource: elapsed === null ? null : measured ? 'audio' as const : 'broadcaster' as const, behind, max, value, rewindable: Math.max(0, (snap?.position ?? 0) - (snap?.oldest ?? 0)) };
}
/**
 * CAR-RADIO-CONTROLS-001: the on-air item's clock for Android Auto, on the ring's sample clock: where
 * the item began (seconds; the car shows position minus this) and its length, with the same sources
 * and precedence as [broadcastTimeline]: a start measured from the audio, else a published start;
 * a published length, else the identified recording's (songs only). Unknown stays null; a guess is
 * never shown as a time.
 */
export function radioItemClock(b: Broadcast | null, track: { duration?: number | null } | null, identified: boolean, snap: { received: number; position: number } | null, now = Date.now(), measuredStart?: number | null): { start: number | null; duration: number | null } {
  const positive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
  const published = positive(b?.duration) ? b.duration : null;
  const catalogue = b?.kind === 'song' && identified && positive(track?.duration) ? track.duration : null;
  const round = (n: number) => Math.round(n * 100) / 100;
  const start = snap && typeof measuredStart === 'number' && Number.isFinite(measuredStart) ? round(measuredStart)
    : snap && snap.received > 0 && positive(b?.startedAt) && b.startedAt <= now ? round(snap.received - (now - b.startedAt) / 1000) : null;
  return { start, duration: published ?? catalogue };
}
/**
 * RADIO-CLOCK-001: where a song's first second lies on the ring's sample clock (seconds), from one
 * fingerprint answer: the sampled window ended at `sampleEnd`, lasted `sampleSeconds`, and its first
 * sample was heard `offset` seconds into the song. May be negative (the song began before tuning in).
 * Null when the answer cannot be a position in this song.
 */
export function songStartFromFingerprint(m: { sampleEnd: number; sampleSeconds: number; offset: number | null | undefined; duration?: number | null }): number | null {
  const { sampleEnd, sampleSeconds, offset, duration } = m;
  if (typeof offset !== 'number' || !Number.isFinite(offset) || offset < 0) return null;
  if (!Number.isFinite(sampleEnd) || !Number.isFinite(sampleSeconds) || sampleSeconds < 3 || sampleSeconds > 13) return null;
  if (typeof duration === 'number' && Number.isFinite(duration) && duration > 0 && offset > duration + 10) return null;
  return Math.round((sampleEnd - sampleSeconds - offset) * 100) / 100;
}
export function radioClock(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '--:--';
  const n = Math.floor(Math.max(0, seconds)), s = String(n % 60).padStart(2, '0');
  return n >= 3600 ? `${Math.floor(n / 3600)}:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${s}` : `${Math.floor(n / 60)}:${s}`;
}

/**
 * RADIO-UI-005: shuffle across stations picks any OTHER station, uniformly; -1 when there is no
 * other station to go to. Pure so both the phone player and tests share one rule.
 */
export function pickShuffleIndex(length: number, current: number, rnd: () => number): number {
  if (length < 2) return -1;
  let n = Math.floor(rnd() * (length - 1)); if (n < 0) n = 0; if (n >= length - 1) n = length - 2;
  return n >= current && current >= 0 ? n + 1 : n;
}
/**
 * RADIO-UI-003: the live edge advances at wall-clock rate while audio ARRIVES in bursts, so
 * received-minus-position sawtooths across whole seconds and the "behind live" number flickers.
 * Estimate the edge as max(previous edge + elapsed, received): smooth, never behind what has
 * actually arrived, and reset for a new session or a shrunk buffer (reconnect).
 */
export function liveEdgeTracker(): (session: string, received: number, now: number) => number {
  let id: string | null = null, at = 0, edge = 0;
  return (session, received, now) => {
    if (id !== session || received < edge - 400 || now < at) { id = session; edge = received; }
    else edge = Math.max(edge + Math.max(0, now - at), received);
    at = now;
    return edge;
  };
}
