import { splitOnAir } from './radio-icy';
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
export function heardCredit(x: { identified: boolean; kind: Broadcast['kind']; heard: number; duration: number | null }): { eligible: boolean; coverage: number } {
  const coverage = Math.max(0, Math.min(x.heard, x.duration || x.heard));
  return { eligible: x.identified && x.kind === 'song' && Number.isFinite(coverage) && coverage >= 30, coverage };
}
export type RadioRequest = (url: string) => Promise<string>;
export class RadioDirectory {
  constructor(private request: RadioRequest) {}
  async read(path: string): Promise<unknown> { let last: unknown; for (const host of DIRECTORY_SERVERS) { try { return JSON.parse(await this.request(host + path)); } catch (e) { last = e; } } throw last; }
  async search(opts: { query?: string; country?: string; language?: string; tag?: string; offset?: number }): Promise<RadioStation[]> {
    const q = new URLSearchParams({ hidebroken: 'true', order: 'clickcount', reverse: 'true', limit: '24', offset: String(Math.max(0, opts.offset || 0)) });
    if (opts.query) q.set('name', opts.query.slice(0, 100)); if (opts.country) q.set('countrycode', opts.country); if (opts.language) q.set('language', opts.language); if (opts.tag) q.set('tag', opts.tag);
    const data = await this.read('/json/stations/search?' + q); if (!Array.isArray(data)) throw Error('Station directory returned an invalid answer');
    const out = new Map<string, RadioStation>(); for (const o of data) { const s = normalizeStation(o); if (s) out.set(s.id, s); } return [...out.values()];
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

/** RADIO-PLAYER-002: publish provenance, never infer an item's start from the time we tuned in.
 * Broadcaster clocks describe the live edge. Subtract the transport's real timeshift so pause and
 * rewind move the displayed programme time too. Unpublished streaming latency is not measurable.
 */
export function broadcastTimeline(b: Broadcast | null, track: { duration?: number | null } | null, snap: { received: number; position: number; oldest: number } | null, now = Date.now(), bufferOffset?: number) {
  const positive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
  const behind = snap ? Math.max(0, snap.received - snap.position) : 0;
  const publishedDuration = positive(b?.duration) ? b.duration : null;
  const catalogueDuration = b?.kind === 'song' && positive(track?.duration) ? track.duration : null;
  const duration = publishedDuration ?? catalogueDuration;
  const hasStart = positive(b?.startedAt) && b.startedAt <= now;
  const rawElapsed = hasStart ? Math.max(0, Number.isFinite(bufferOffset) && snap ? snap.position + bufferOffset! : (now - b.startedAt!) / 1000 - behind) : null;
  // A catalogue edition can be shorter than the broadcast. Never clamp a real elapsed clock to
  // the wrong edition, nor present its length as the station's actual edit.
  const elapsed = rawElapsed === null ? null : publishedDuration ? Math.min(rawElapsed, publishedDuration) : rawElapsed;
  const max = elapsed !== null ? publishedDuration ?? Math.max(1, duration ?? 0, elapsed + behind) : Math.max(1, (snap?.received ?? 0) - (snap?.oldest ?? 0));
  const value = elapsed !== null ? elapsed : Math.max(0, (snap?.position ?? 0) - (snap?.oldest ?? 0));
  return { elapsed, duration, durationSource: publishedDuration ? 'broadcaster' : catalogueDuration ? 'catalogue' : null, behind, max, value, rewindable: Math.max(0, (snap?.position ?? 0) - (snap?.oldest ?? 0)) };
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
