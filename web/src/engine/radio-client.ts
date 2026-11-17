import { api, type Characteristics, type Track } from '../api';
import { fold, parseTitle } from './identity';
import { RadioDirectory, parseBroadcast, freshBroadcast, heardCredit, pickShuffleIndex, type Broadcast, type RadioStation } from './radio';
import { publisherBroadcast, icecastBroadcast } from './radio-feeds';
import { ListenMeter } from '../util';
import { radioOutput } from '../audio-engine';

export interface RadioSnapshot { id: string; stationId: string; station?: RadioStation; paused: boolean; position: number; received: number; oldest: number; heard: number; dropped: boolean; state: string; error: string | null; native: boolean; pcm?: string }
export async function radioNative<T = RadioSnapshot>(q: Record<string, unknown>): Promise<T> {
  const c = new AbortController(), timeout = setTimeout(() => c.abort(), q.op === 'metadata' || q.op === 'request' ? 20000 : 15000);
  try { const r = await fetch('/radio-native?q=' + encodeURIComponent(JSON.stringify(q)), { cache: 'no-store', signal: c.signal }); const v = await r.json() as T & { error?: string }; if (!r.ok || v.error && !('state' in v)) throw Error(v.error || 'Radio request failed'); return v; } finally { clearTimeout(timeout); }
}
export const radioDirectory = new RadioDirectory(async u => (await radioNative<{ text: string }>({ op: 'request', url: u })).text);
const metadata = new Map<string, Broadcast>();
const probing = new Map<string, Promise<Broadcast>>();
export async function stationMetadata(s: RadioStation, force = false): Promise<Broadcast> {
  const old = metadata.get(s.id); if (!force && old && Date.now() - old.checkedAt < 20000) return freshBroadcast(old);
  if (probing.has(s.id)) return probing.get(s.id)!;
  const work = (async () => {
    let b: Broadcast | null = null, programme: Broadcast | null = null;
    const get = async (url: string) => (await radioNative<{ text: string }>({ op: 'request', url })).text;
    try { const p = await publisherBroadcast(s, get); if (p?.state === 'current' && p.kind === 'song') b = p; else if (p?.state === 'current') programme = p; } catch { /* ICY remains independent */ }
    if (!b) {
      try { const v = await radioNative<{ title: string | null; state: string; checkedAt: number; detail?: string }>({ op: 'metadata', url: s.url }); b = { ...parseBroadcast(v.title, v.detail || 'Broadcaster ICY', v.checkedAt), ...(v.state === 'failed' ? { state: 'failed' as const } : {}), detail: v.detail }; }
      catch (e) { b = { ...parseBroadcast(null, 'Broadcaster'), state: 'failed', detail: e instanceof Error ? e.message : 'Station did not answer' }; }
    }
    if (b.state !== 'current' && programme) b = programme;
    if (b.state !== 'current') { try { const ice = await icecastBroadcast(s, get); if (ice?.state === 'current') b = ice; } catch { /* genuine unavailability is shown */ } }
    // A failed refresh never erases what was last published, but never passes it off as current.
    if (b.state !== 'current' && old?.title) b = { ...old, state: 'stale', detail: b.detail };
    metadata.set(s.id, b); if (metadata.size > 400) metadata.delete(metadata.keys().next().value!); return b;
  })().finally(() => probing.delete(s.id)); probing.set(s.id, work); return work;
}
function floats(b64: string): Float32Array { const raw = atob(b64), out = new Float32Array(raw.length / 2); for (let i = 0; i < out.length; i++) { const n = raw.charCodeAt(i * 2) | raw.charCodeAt(i * 2 + 1) << 8; out[i] = (n >= 32768 ? n - 65536 : n) / 32768; } return out; }
export async function favouriteStations(): Promise<RadioStation[]> {
  try { const v = await radioNative<{ stations: RadioStation[] }>({ op: 'favourites' }); if (Array.isArray(v.stations)) { localStorage.setItem('airwave:radio-stations', JSON.stringify(v.stations)); return v.stations; } } catch { /* older shells retain local stations */ }
  try { return JSON.parse(localStorage.getItem('airwave:radio-stations') || '[]'); } catch { return []; }
}
export async function saveFavouriteStations(stations: RadioStation[]): Promise<RadioStation[]> {
  const v = await radioNative<{ stations: RadioStation[] }>({ op: 'favourites', stations });
  if (!Array.isArray(v.stations)) throw Error('The station list could not be saved');
  localStorage.setItem('airwave:radio-stations', JSON.stringify(v.stations)); window.dispatchEvent(new Event('airwave-radio-favourites')); return v.stations;
}
export function programmeTrack(s: RadioStation, b: Broadcast): Track {
  return { id: `radio:${s.id}:${b.title}`, key: `radio:${s.id}:${b.title}`, provider: 'radio', platform_id: s.id, title: b.title || s.name, artist: s.name, artists: [], album: 'Live programme bookmark — not a recording', url: s.url, artwork: b.artwork || s.image, kind: 'radio-programme', tags: [], radio_station: s };
}
export interface RadioState { station: RadioStation | null; snapshot: RadioSnapshot | null; broadcast: Broadcast | null; track: Track | null; identified: boolean; characteristics?: Characteristics | null; identifying: boolean; analysis: string; error: string | null; shuffle?: boolean }
type Marker = { at: number; broadcast: Broadcast; track: Track | null; identified: boolean; heardAt: number; characteristics?: Characteristics | null; meter?: ListenMeter };

/**
 * The station list tries to show real song information and cover art for what each station is
 * playing now, not only the broadcaster's text line. One catalogue match per broadcast title,
 * cached and lightly throttled, so a page of stations does not burst the music services.
 */
const matchCache = new Map<string, Track | null>();
let matchesInFlight = 0;
export async function matchSongBroadcast(b: Broadcast): Promise<Track | null> {
  if (b.kind !== 'song' || b.state === 'unavailable' || !b.artist || !b.title) return null;
  const key = `${fold(b.artist)}|${parseTitle(b.title).core}`;
  if (matchCache.has(key)) return matchCache.get(key) ?? null;
  if (matchesInFlight >= 2) return null; // retried on the next refresh; the cache keeps this cheap
  matchesInFlight++;
  try {
    const r = await api.search(`${b.artist} ${b.title}`);
    const t = r.results.find(t => parseTitle(t.title).core === parseTitle(b.title).core && (t.artists || [t.artist || '']).some(a => fold(a) === fold(b.artist!))) ?? null;
    matchCache.set(key, t); if (matchCache.size > 300) matchCache.delete(matchCache.keys().next().value!);
    return t;
  } catch { return null; } finally { matchesInFlight--; }
}
class RadioSession {
  private value: RadioState = { station: null, snapshot: null, broadcast: null, track: null, identified: false, identifying: false, analysis: '', error: null, shuffle: false };
  private listeners = new Set<() => void>(); private generation = 0; private markers: Marker[] = []; private credited = new Set<string>(); private timer: ReturnType<typeof setTimeout> | null = null; private metaTimer: ReturnType<typeof setInterval> | null = null;
  async restore() {
    if (this.value.station) return;
    try { const snap = await radioNative({ op: 'state' }); if (snap.native && snap.station) this.adopt(snap); } catch { /* no active native session */ }
  }
  private adopt(snap: RadioSnapshot) {
    if (!snap.station) return;
    const gen = ++this.generation; this.clear(); this.markers = []; this.credited.clear(); this.currentMarker = null; this.itemHeard = 0; this.lastIdentify = 0;
    this.put({ station: snap.station, snapshot: snap, track: null, broadcast: null, identified: false, error: snap.error, analysis: 'Reading current radio programme' });
    void favouriteStations().then(v => { if (!this.stationList.length) this.stationList = v; });
    void this.refreshMetadata(gen); this.metaTimer = setInterval(() => void this.refreshMetadata(gen), 20000); void this.poll(gen);
  }
  private lastNativeMetadata = '';
  private currentMarker: Marker | null = null;
  private stationList: RadioStation[] = [];
  setStations(stations: RadioStation[]) { this.stationList = stations; }
  canSkip(dir: 1 | -1): boolean {
    const i = this.stationList.findIndex(s => s.id === this.value.station?.id);
    if (this.value.shuffle) return this.stationList.length > 1 && i >= 0;
    return i >= 0 && i + dir >= 0 && i + dir < this.stationList.length;
  }
  /** RADIO-UI-005: with shuffle on, Next/Previous tune a random OTHER station from the tuned list. */
  async skip(dir: 1 | -1) {
    const i = this.stationList.findIndex(s => s.id === this.value.station?.id);
    const next = this.value.shuffle ? this.stationList[pickShuffleIndex(this.stationList.length, i, Math.random)] : this.stationList[i + dir];
    if (next) await this.start(next);
  }
  /** Shared with the native layer so Android Auto's shuffle button and the phone button agree. */
  private shuffleSync = 0;
  async setShuffle(on: boolean) {
    this.put({ shuffle: on });
    if (!this.value.snapshot) return;
    // A state poll already in flight still carries the OLD flag; don't let it undo this toggle.
    this.shuffleSync++;
    try { await radioNative({ op: 'shuffle', on }); } catch { /* native keeps its previous flag */ } finally { setTimeout(() => { this.shuffleSync = Math.max(0, this.shuffleSync - 1); }, 700); }
  }
  private graph: ReturnType<typeof radioOutput> | null = null; private nextAt = 0; private sources = new Set<AudioBufferSourceNode>(); private lastHeard = 0; private itemHeard = 0; private lastItem = ''; private lastIdentify = 0;
  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  get = () => this.value;
  private put(v: Partial<RadioState>) { this.value = { ...this.value, ...v }; this.listeners.forEach(l => l()); }
  async start(s: RadioStation) {
    const gen = ++this.generation; this.clear(); this.markers = []; this.credited.clear(); this.lastHeard = 0; this.itemHeard = 0; this.lastItem = ''; this.lastIdentify = 0; this.currentMarker = null;
    if (!this.stationList.some(x => x.id === s.id)) this.stationList = [s, ...this.stationList];
    this.put({ station: s, snapshot: null, broadcast: null, track: null, identified: false, error: null, analysis: 'Waiting for broadcast metadata', identifying: false });
    // Resume/create WebAudio inside the station click, before any asynchronous network operation.
    this.graph = radioOutput();
    try {
      const snap = await radioNative({ op: 'start', stationId: s.id, name: s.name, title: s.name, url: s.url, station: s, stations: this.stationList });
      if (gen !== this.generation) return;
      this.put({ snapshot: snap }); if (snap.native) { this.graph?.dispose(); this.graph = null; }
      void this.refreshMetadata(gen); this.metaTimer = setInterval(() => void this.refreshMetadata(gen), 20000); void this.poll(gen);
    } catch (e) { if (gen === this.generation) this.put({ error: e instanceof Error ? e.message : 'Radio could not start' }); }
  }
  private clear() { if (this.timer) clearTimeout(this.timer); if (this.metaTimer) clearInterval(this.metaTimer); this.timer = null; this.metaTimer = null; this.flushAudio(); this.graph?.dispose(); this.graph = null; }
  private flushAudio() { for (const s of this.sources) { try { s.stop(); s.disconnect(); } catch {} } this.sources.clear(); this.nextAt = 0; }
  volume(v: number) { this.graph?.volume(v); }
  async stop() { this.credit(); ++this.generation; this.clear(); await radioNative({ op: 'stop' }).catch(() => {}); this.put({ station: null, snapshot: null, broadcast: null, track: null, error: null }); }
  async pause() { const s = this.value.snapshot; if (!s) return; this.credit(); const paused = !s.paused;
    if (paused && this.graph && !s.native) { const ahead = Math.max(0, this.nextAt - this.graph.ctx.currentTime); if (ahead > 0) await radioNative({ op: 'rewind', id: s.id, seconds: ahead }); }
    this.flushAudio(); const snap = await radioNative({ op: 'pause', id: s.id, paused }); this.put({ snapshot: snap }); }
  async rewind(seconds = 15) { const s = this.value.snapshot; if (!s) return; this.credit(); this.flushAudio(); this.lastItem = ''; this.itemHeard = 0; const snap = await radioNative({ op: 'rewind', id: s.id, seconds: Math.max(0, Math.min(300, seconds)) }); this.put({ snapshot: snap }); this.selectItem(); }
  private selectItem() {
    const snap = this.value.snapshot; if (!snap) return;
    const m = [...this.markers].reverse().find(x => x.at <= snap.position + 0.5) || this.markers[0]; if (!m) return;
    if (this.currentMarker !== m) { this.credit(); this.itemHeard = 0; this.lastItem = m.broadcast.title; this.currentMarker = m;
 (m.meter ??= new ListenMeter()).seeked(snap.position); }
    if (snap.native) {
      const update = { op: 'nowplaying', id: snap.id, title: m.track?.title || m.broadcast.title || this.value.station?.name, artist: m.track?.artists?.join(', ') || m.broadcast.artist || this.value.station?.name,
        artwork: (m.identified ? m.track?.artwork : null) || m.broadcast.artwork || this.value.station?.image || '' };
      const key = JSON.stringify(update);
      if (this.lastNativeMetadata !== key) { this.lastNativeMetadata = key; void radioNative(update).catch(() => { if (this.lastNativeMetadata === key) this.lastNativeMetadata = ''; }); }
    }
    const shown = freshBroadcast(m.broadcast);
    if (this.value.analysis === 'Waiting for broadcast metadata' && shown.state !== 'unavailable') this.put({ analysis: shown.kind === 'song' ? `Now playing from ${shown.source}` : `Programme from ${shown.source}` });
    this.put({ broadcast: shown, track: m.track || (this.value.station ? programmeTrack(this.value.station, m.broadcast) : null), identified: m.identified, characteristics: m.characteristics });
    this.markers = this.markers.filter((m, i, all) => m.at >= snap.oldest || (all[i + 1]?.at ?? -1) > snap.oldest || i === all.length - 1);
  }
  private async poll(gen: number) {
    const s = this.value.snapshot; if (gen !== this.generation || !s) return;
    try {
      const room = this.graph ? this.nextAt - this.graph.ctx.currentTime < 0.65 : false;
      const snap = await radioNative({ op: !s.native && room ? 'pull' : 'state', ...(!s.native ? { id: s.id } : {}) }); if (gen !== this.generation) return;
      if (snap.native && snap.id !== s.id) { this.adopt(snap); return; }
      if (snap.pcm && this.graph && !snap.paused) {
        const f = floats(snap.pcm); const n = f.length / 2; if (n) { const g = this.graph, b = g.ctx.createBuffer(2, n, 48000); for (let ch = 0; ch < 2; ch++) { const v = b.getChannelData(ch); for (let i = 0; i < n; i++) v[i] = f[i * 2 + ch]!; } const node = g.ctx.createBufferSource(); node.buffer = b; node.connect(g.input); this.nextAt = Math.max(g.ctx.currentTime + 0.02, this.nextAt); node.start(this.nextAt); this.nextAt += b.duration; this.sources.add(node); node.onended = () => { node.disconnect(); this.sources.delete(node); }; }
      }
      if (this.graph && !snap.native && !snap.paused) snap.position = Math.max(snap.oldest, snap.position - Math.max(0, this.nextAt - this.graph.ctx.currentTime));
      // Native credit counts frames actually consumed, not wall clock. Ignore a counter reset.
      this.lastHeard = snap.heard;
      const nativeShuffle = (snap as { shuffle?: unknown }).shuffle;
      this.put({ snapshot: snap, ...(typeof nativeShuffle === 'boolean' && this.shuffleSync === 0 && nativeShuffle !== this.value.shuffle ? { shuffle: nativeShuffle } : {}), ...(snap.error ? { error: snap.error } : {}) }); this.selectItem();
      if (this.currentMarker) { const meter = this.currentMarker.meter ??= new ListenMeter(); meter.tick(snap.position, !snap.paused && this.value.identified && snap.heard > 0); this.itemHeard = meter.coverage; }
      if (this.itemHeard >= 30) this.credit();
      if (!snap.paused && snap.position >= 14 && Date.now() - this.lastIdentify > 60000 && !this.value.identifying && (!this.value.identified || this.value.broadcast?.kind === 'song')) void this.identify();
    } catch (e) { if (gen === this.generation) {
        if (e instanceof Error && /session has ended/.test(e.message)) { ++this.generation; this.clear(); this.put({ station: null, snapshot: null, error: null }); return; }
        this.put({ error: e instanceof Error ? e.message : 'Radio disconnected' });
      } }
    if (gen === this.generation) this.timer = setTimeout(() => void this.poll(gen), s.native ? 500 : 100);
  }
  private async credit() {
    const { track, broadcast, identified, snapshot } = this.value; if (!track || !broadcast || !snapshot) return;
    const qualified = heardCredit({ identified, kind: broadcast.kind, heard: this.currentMarker?.meter?.coverage ?? 0, duration: track.duration ?? null }); if (!qualified.eligible) return;
    const id = `${snapshot.id}:${track.key}:${this.lastItem}`; if (this.credited.has(id)) return; this.credited.add(id);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(track.key));
    const hash = [...new Uint8Array(digest)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
    void api.feedback('qualified', track, { event_id: `radio:${snapshot.id}:${hash}`, listened: qualified.coverage, coverage: qualified.coverage, duration: track.duration, medium: 'radio', origin: 'radio', confidence: 0.7 }).catch(() => {});
  }
  private async refreshMetadata(gen: number) {
    const s = this.value.station; if (!s || gen !== this.generation) return; const b = await stationMetadata(s); if (gen !== this.generation) return;
    const last = this.markers[this.markers.length - 1];
    if (last?.broadcast.title === b.title && last.broadcast.artist === b.artist) { last.broadcast = b; this.selectItem(); return; }
    const marker: Marker = { at: last ? this.value.snapshot?.received || 0 : 0, broadcast: b, track: null, identified: false, heardAt: 0 }; this.markers.push(marker); this.selectItem();
    if (b.kind !== 'song' || b.state !== 'current' || !b.artist) return;
    try { const r = await api.search(`${b.artist} ${b.title}`); const t = r.results.find(t => parseTitle(t.title).core === parseTitle(b.title).core && (t.artists || [t.artist || '']).some(a => fold(a) === fold(b.artist!))); if (gen !== this.generation || !t) return; marker.track = t; marker.identified = true; this.put({ analysis: 'Matched broadcaster title to catalogue' }); this.selectItem(); void this.genres(t, marker, gen); } catch { /* published programme/title stays visible, no speculative match */ }
  }
  private async genres(t: Track, marker: Marker, gen: number) { try { const got = await api.radioGenres(t); if (got && gen === this.generation) { marker.track = { ...t, ...got.track }; marker.characteristics = got.characteristics; this.selectItem(); } } catch {} }
  async identify() {
    const { snapshot, station } = this.value; if (!snapshot || !station || this.value.identifying) return; this.lastIdentify = Date.now(); const gen = this.generation; this.put({ identifying: true, analysis: 'Fingerprinting broadcast audio on this device…' });
    try {
      const sample = await radioNative<{ pcm: string; seconds: number }>({ op: 'sample', id: snapshot.id }); if (sample.seconds < 5) throw Error('Listen for at least five seconds first');
      const L = await import('./listen'); const y = floats(sample.pcm); const sig = await L.makeSignature(L.pickWindow(y)); const r = await api.identifyAudio(L.signatureUri(sig), L.signatureMillis(sig)); if (gen !== this.generation) return;
      const t = r.results[0]; if (!t) { this.put({ analysis: 'No music identified; the station may be broadcasting speech or a programme' }); return; }
      const b = parseBroadcast(`${t.artists?.[0] || t.artist} - ${t.title}`, 'Audio fingerprint');
      let marker = [...this.markers].reverse().find(x => x.at <= snapshot.position + 0.5);
      if (!marker || marker.track?.key !== t.key) { marker = { at: Math.max(0, snapshot.position - sample.seconds), broadcast: b, track: t, identified: true, heardAt: 0 }; this.markers.push(marker); this.markers.sort((a, b) => a.at - b.at); } else { marker.track = t; if (marker.broadcast.state !== 'current' || marker.broadcast.kind !== 'song') marker.broadcast = b; marker.identified = true; }
      this.put({ analysis: 'Music identified by audio fingerprint' }); this.selectItem(); void this.genres(t, marker, gen);
      const analysed = await api.radioAnalyse(t, snapshot.id); if (gen === this.generation) { marker.track = { ...marker.track!, ...(analysed.bpm ? { bpm: analysed.bpm } : {}) }; this.put({ analysis: analysed.embedded ? 'Audio identified · acoustic sample analysed' : analysed.note || 'Audio identified; acoustic model unavailable' }); }
    } catch (e) { if (gen === this.generation) this.put({ analysis: e instanceof Error ? e.message : 'Audio identification unavailable' }); }
    finally { if (gen === this.generation) this.put({ identifying: false }); }
  }
}
export const radioSession = new RadioSession();
