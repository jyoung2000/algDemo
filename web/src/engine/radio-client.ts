import { api, type Characteristics, type Track } from '../api';
import { parseTitle } from './identity';
import { RadioDirectory, parseBroadcast, freshBroadcast, heardCredit, pickShuffleIndex, radioItemClock, songStartFromFingerprint, type Broadcast, type RadioStation } from './radio';
import { publisherBroadcast, icecastBroadcast } from './radio-feeds';
import { geocodePlace, type RadioPlace } from './radio-places';
import { normaliseRadioArtist, radioArtistKey, radioSongFits } from './radio-artist';
import { ListenMeter } from '../util';
import { radioOutput } from '../audio-engine';
import { songFromTrack, type NativeSong } from './media-native';

export interface RadioSnapshot { id: string; stationId: string; station?: RadioStation; paused: boolean; position: number; received: number; oldest: number; heard: number; dropped: boolean; state: string; error: string | null; native: boolean; pcm?: string }
export async function radioNative<T = RadioSnapshot>(q: Record<string, unknown>): Promise<T> {
  const c = new AbortController(), timeout = setTimeout(() => c.abort(), q.op === 'metadata' || q.op === 'request' ? 20000 : 15000);
  try { const r = await fetch('/radio-native?q=' + encodeURIComponent(JSON.stringify(q)), { cache: 'no-store', signal: c.signal }); const v = await r.json() as T & { error?: string }; if (!r.ok || v.error && !('state' in v)) throw Error(v.error || 'Radio request failed'); return v; } finally { clearTimeout(timeout); }
}
export const radioDirectory = new RadioDirectory(async u => (await radioNative<{ text: string }>({ op: 'request', url: u })).text);
/** RADIO-PLACES-001: look up a typed city, address or region (OpenStreetMap), through the same native request path. */
export const radioGeocode = (query: string) => geocodePlace(query, async u => (await radioNative<{ text: string }>({ op: 'request', url: u })).text);
const metadata = new Map<string, Broadcast>();
const probing = new Map<string, Promise<Broadcast>>();
/** `maxAge`: how old a remembered answer may be and still be reused (RADIO-LIVE-001 asks for under 15 s). */
export async function stationMetadata(s: RadioStation, force = false, maxAge = 20000): Promise<Broadcast> {
  const old = metadata.get(s.id); if (!force && old && Date.now() - old.checkedAt < maxAge) return freshBroadcast(old);
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
/** CAR-RADIO-FILTERS-001: the places saved in the Radio tab, so Android Auto can offer them as location presets.
 *  Best effort: a shell without the op (Windows, older Android) simply has no car to tell. */
export async function shareRadioPlaces(places: readonly RadioPlace[]): Promise<void> {
  try { await radioNative({ op: 'places', places: places.map(({ selected: _s, ...p }) => p) }); } catch { /* no car on this shell */ }
}
export function programmeTrack(s: RadioStation, b: Broadcast): Track {
  return { id: `radio:${s.id}:${b.title}`, key: `radio:${s.id}:${b.title}`, provider: 'radio', platform_id: s.id, title: b.title || s.name, artist: s.name, artists: [], album: 'Live programme bookmark — not a recording', url: s.url, artwork: b.artwork || s.image, kind: 'radio-programme', tags: [], radio_station: s };
}
export interface RadioState { station: RadioStation | null; snapshot: RadioSnapshot | null; broadcast: Broadcast | null; track: Track | null; identified: boolean; characteristics?: Characteristics | null; identifying: boolean; analysis: string; error: string | null; shuffle?: boolean;
  /** RADIO-CLOCK-001: where the current song's first second lies on the ring clock (seconds), measured from the audio; null when not measured. */
  songStart?: number | null;
  /** RADIO-BEHIND-TRUE-001: the listener paused or rewound since tuning in or last going live; only then can they be behind live. */
  timeshifted?: boolean }
type Marker = { at: number; broadcast: Broadcast; track: Track | null; identified: boolean; heardAt: number; /** CAR-RADIO-CONTROLS-001: a published start, pinned to the ring clock once audio arrived. */ carStart?: number | null; characteristics?: Characteristics | null; meter?: ListenMeter; startAt?: number | null; overruns?: number; /** RADIO-TASTE-001: the song's own genres are still being looked up. */ genresPending?: boolean };

/**
 * The station list tries to show real song information and cover art for what each station is
 * playing now, not only the broadcaster's text line. One catalogue match per broadcast title,
 * cached and lightly throttled, so a page of stations does not burst the music services.
 */
const matchCache = new Map<string, Track | null>();
let matchesInFlight = 0;
export async function matchSongBroadcast(b: Broadcast, opts?: { force?: boolean }): Promise<Track | null> {
  if (b.kind !== 'song' || b.state === 'unavailable' || !b.artist || !b.title) return null;
  const key = `${radioArtistKey(normaliseRadioArtist(b.artist) ?? b.artist)}|${parseTitle(b.title).core}`;
  const cached = matchCache.get(key) ?? null;
  // RADIO-ART-002: a forced (manual-refresh) pass re-asks only while the cached answer still has
  // no cover art; a resolved cover is reused without a new search.
  if (matchCache.has(key) && !(opts?.force && !cached?.artwork)) return cached;
  if (matchesInFlight >= 2) return cached; // retried on the next refresh; the cache keeps this cheap
  matchesInFlight++;
  try {
    const r = await api.search(`${normaliseRadioArtist(b.artist) ?? b.artist} ${b.title}`);
    // RADIO-ARTIST-001: the same song when the title core matches and the catalogue credits an
    // artist the station named, read through its "X, The" / capitals / "feat." spellings.
    const sameSong = (t: Track) => radioSongFits(t, b);
    let t = r.results.find(sameSong) ?? null;
    // The best match may carry no cover; borrow artwork from ANOTHER platform's result for the
    // SAME song (same folded artist + title core) — e.g. a Deezer cover for a YouTube Music hit.
    if (t && !t.artwork) { const art = r.results.find(x => sameSong(x) && !!x.artwork); if (art) t = { ...t, artwork: art.artwork }; }
    matchCache.set(key, t); if (matchCache.size > 300) matchCache.delete(matchCache.keys().next().value!);
    return t;
  } catch { return cached; } finally { matchesInFlight--; }
}
class RadioSession {
  private value: RadioState = { station: null, snapshot: null, broadcast: null, track: null, identified: false, identifying: false, analysis: '', error: null, shuffle: false };
  private listeners = new Set<() => void>(); private generation = 0; private markers: Marker[] = []; private credited = new Map<string, { kind: 'qualified' | 'complete'; coverage: number }>(); private timer: ReturnType<typeof setTimeout> | null = null; private metaTimer: ReturnType<typeof setInterval> | null = null;
  async restore() {
    if (this.value.station) return;
    try { const snap = await radioNative({ op: 'state' }); if (snap.native && snap.station) this.adopt(snap); } catch { /* no active native session */ }
  }
  private adopt(snap: RadioSnapshot) {
    if (!snap.station) return;
    const gen = ++this.generation; this.clear(); this.markers = []; this.credited.clear(); this.currentMarker = null; this.itemHeard = 0; this.lastIdentify = 0;
    this.identifyAfter = Infinity; this.overrunAfter = 0;
    this.put({ station: snap.station, snapshot: snap, track: null, broadcast: null, identified: false, characteristics: null, identifying: false, error: snap.error, analysis: 'Reading current radio programme', songStart: null });
    void favouriteStations().then(v => { if (!this.stationList.length) this.stationList = v; });
    void this.refreshMetadata(gen); this.metaTimer = setInterval(() => void this.refreshMetadata(gen), 20000); void this.poll(gen);
  }
  private lastNativeMetadata = '';
  /** RADIO-CLOCK-001: fingerprint again once this much of the ring has arrived (a new song's own audio fills a window). */
  private identifyAfter = Infinity;
  /** RADIO-CLOCK-002: the ring second before which an outrun song is not measured again. */
  private overrunAfter = 0;
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
  /** What the live radio EQ graph is doing right now (Windows renderer path), for gates and QA. */
  eqPeek() { return this.graph?.peek?.() ?? null; }
  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  get = () => this.value;
  private put(v: Partial<RadioState>) { this.value = { ...this.value, ...v }; this.listeners.forEach(l => l()); }
  async start(s: RadioStation) {
    void this.credit(true); // RADIO-TASTE-001: moving straight to another station still counts what was heard on this one
    const gen = ++this.generation; this.clear(); this.markers = []; this.credited.clear(); this.lastHeard = 0; this.itemHeard = 0; this.lastItem = ''; this.lastIdentify = 0; this.currentMarker = null;
    if (!this.stationList.some(x => x.id === s.id)) this.stationList = [s, ...this.stationList];
    this.identifyAfter = Infinity; this.overrunAfter = 0;
    this.put({ station: s, snapshot: null, broadcast: null, track: null, identified: false, characteristics: null, error: null, analysis: 'Waiting for broadcast metadata', identifying: false, songStart: null, timeshifted: false });
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
  async stop() { void this.credit(true); ++this.generation; this.clear(); await radioNative({ op: 'stop' }).catch(() => {}); this.put({ station: null, snapshot: null, broadcast: null, track: null, error: null, songStart: null }); }
  async pause() { const s = this.value.snapshot; if (!s) return; void this.credit(); const paused = !s.paused;
    if (paused && this.graph && !s.native) { const ahead = Math.max(0, this.nextAt - this.graph.ctx.currentTime); if (ahead > 0) await radioNative({ op: 'rewind', id: s.id, seconds: ahead }); }
    this.flushAudio(); const snap = await radioNative({ op: 'pause', id: s.id, paused }); this.put(paused ? { snapshot: snap, timeshifted: true } : { snapshot: snap }); }
  /** RADIO-GO-LIVE-001 (owner, 2026-11-19): "a button to go to live so the user can ... instantly hear what the station
   *  is live playing". Resumes if paused and jumps to just before the newest audio received (2 s cushion). */
  async goLive() { const s = this.value.snapshot; if (!s) return; void this.credit(true); this.flushAudio(); this.lastItem = ''; this.itemHeard = 0; const snap = await radioNative({ op: 'live', id: s.id }); this.put({ snapshot: snap, timeshifted: false }); this.selectItem(); }
  async downloadRecording(): Promise<{ saved_to: string; file: string; seconds: number; partial: boolean }> {
    const snap = this.value.snapshot, m = this.currentMarker;
    if (!snap || !this.value.station) throw Error('No radio is playing');
    const next = m ? this.markers[this.markers.indexOf(m) + 1] : null;
    return radioNative({ op: 'export', id: snap.id, from: Math.max(snap.oldest, m?.at ?? snap.oldest), to: Math.min(snap.received, next?.at ?? snap.received), title: m?.broadcast.title || this.value.station.name });
  }
  async rewind(seconds = 15) { const s = this.value.snapshot; if (!s) return; void this.credit(true); this.flushAudio(); this.lastItem = ''; this.itemHeard = 0; const snap = await radioNative({ op: 'rewind', id: s.id, seconds: Math.max(0, Math.min(600, seconds)) }); this.put({ snapshot: snap, timeshifted: true }); this.selectItem(); }
  private selectItem() {
    const snap = this.value.snapshot; if (!snap) return;
    const m = [...this.markers].reverse().find(x => x.at <= snap.position + 0.5) || this.markers[0]; if (!m) return;
    if (this.currentMarker !== m) { void this.credit(true); this.itemHeard = 0; this.lastItem = m.broadcast.title; this.currentMarker = m;
 (m.meter ??= new ListenMeter()).seeked(snap.position); }
    if (snap.native) {
      // CAR-RADIO-CONTROLS-001: the car's star, playlist pick and elapsed/length follow what the phone shows.
      // A published start drifts with network bursts if recomputed, so it is pinned once per item (as the phone's bufferOffset is).
      if (m.carStart === undefined && snap.received > 0 && m.broadcast.startedAt) m.carStart = radioItemClock(m.broadcast, null, false, snap).start;
      const clock = radioItemClock(m.broadcast, m.track, m.identified, snap, Date.now(), m.startAt ?? null);
      const update = radioNowPlaying(snap.id, m, this.value.station, { start: m.startAt != null ? clock.start : m.carStart ?? null, duration: clock.duration });
      const key = JSON.stringify(update);
      if (this.lastNativeMetadata !== key) { this.lastNativeMetadata = key; void radioNative(update).catch(() => { if (this.lastNativeMetadata === key) this.lastNativeMetadata = ''; }); }
    }
    const shown = freshBroadcast(m.broadcast);
    if (this.value.analysis === 'Waiting for broadcast metadata' && shown.state !== 'unavailable') this.put({ analysis: shown.kind === 'song' ? `Now playing from ${shown.source}` : `Programme from ${shown.source}` });
    this.put({ broadcast: shown, track: m.track || (this.value.station ? programmeTrack(this.value.station, m.broadcast) : null), identified: m.identified, characteristics: m.characteristics, songStart: m.startAt ?? null });
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
      if (this.itemHeard >= 30) void this.credit();
      const due = Date.now() - this.lastIdentify > 60000 && (!this.value.identified || this.value.broadcast?.kind === 'song');
      // A song that began while listening is measured as soon as a whole window of it has played, not up to a minute later.
      const newSong = snap.position >= this.identifyAfter;
      // RADIO-CLOCK-002: a song measured from the audio has a known end on the ring clock. Broadcaster titles arrive late
      // (about 20 s on a real station), so once a whole window past that end has played, measure again instead of
      // counting on past the song's length. A station playing a longer edit is asked three times, then the minute rule resumes.
      const cur = this.currentMarker, len = cur?.track?.duration;
      const outrun = !!cur && typeof cur.startAt === 'number' && typeof len === 'number' && len > 0 && (cur.overruns ?? 0) < 3
        && snap.position >= cur.startAt + len + 12 && snap.position >= this.overrunAfter;
      if (!snap.paused && snap.position >= 14 && !this.value.identifying && (due || newSong || outrun)) {
        if (outrun && !due && !newSong) { cur!.overruns = (cur!.overruns ?? 0) + 1; this.overrunAfter = snap.position + 12; }
        void this.identify();
      }
    } catch (e) { if (gen === this.generation) {
        if (e instanceof Error && /session has ended/.test(e.message)) { ++this.generation; this.clear(); this.put({ station: null, snapshot: null, error: null }); return; }
        this.put({ error: e instanceof Error ? e.message : 'Radio disconnected' });
      } }
    if (gen === this.generation) this.timer = setTimeout(() => void this.poll(gen), s.native ? 500 : 100);
  }
  /**
   * RADIO-TASTE-001: a song heard on the radio counts towards the listener's taste like any other
   * listen, once it is identified and really heard. Thirty seconds is noted as a listen; most of
   * the recording heard is a full listen and replaces that note. Programmes, unnamed songs and the
   * station's tags never count. `leaving` is the last chance to report this item.
   */
  private async credit(leaving = false) {
    const { track, broadcast, identified, snapshot } = this.value; const marker = this.currentMarker; if (!track || !broadcast || !snapshot || !marker) return;
    const heard = heardCredit({ identified, kind: broadcast.kind, heard: marker.meter?.coverage ?? 0, duration: track.duration ?? null }); if (!heard.eligible) return;
    // Taste learns from the song's own genres, so the note waits for that lookup, but never past the listen itself.
    if (marker.genresPending && !leaving && !heard.full) return;
    const kind = heard.full ? 'complete' : 'qualified';
    const id = `${snapshot.id}:${track.key}:${this.lastItem}`; const had = this.credited.get(id);
    // Each stage is reported once; on leaving, a full listen is reported again when more of the song was heard since.
    if (had && (had.kind === kind || had.kind === 'complete') && !(leaving && kind === 'complete' && heard.coverage >= had.coverage + 5)) return;
    this.credited.set(id, { kind, coverage: heard.coverage });
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(track.key));
    const hash = [...new Uint8Array(digest)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
    const noted = `radio:${snapshot.id}:${hash}`; const coverage = Math.round(heard.coverage * 10) / 10;
    void api.feedback(kind, track, { event_id: kind === 'complete' ? `${noted}:full` : noted, ...(kind === 'complete' ? { supersedes: noted } : {}), listened: coverage, coverage, duration: track.duration, medium: 'radio', origin: 'radio', confidence: 0.7 }).catch(() => {});
  }
  private async refreshMetadata(gen: number) {
    const s = this.value.station; if (!s || gen !== this.generation) return; const b = await stationMetadata(s); if (gen !== this.generation) return;
    const last = this.markers[this.markers.length - 1];
    if (last?.broadcast.title === b.title && last.broadcast.artist === b.artist) { last.broadcast = b; this.selectItem(); return; }
    const marker: Marker = { at: last ? this.value.snapshot?.received || 0 : 0, broadcast: b, track: null, identified: false, heardAt: 0 }; this.markers.push(marker); this.selectItem();
    // RADIO-CLOCK-001: the title changed while listening. Its clock is measured once 13 s of the new item have been played
    // (a 12 s fingerprint window that no longer holds the end of the previous song).
    if (last && b.kind === 'song' && b.state === 'current') this.identifyAfter = marker.at + 13;
    if (b.kind !== 'song' || b.state !== 'current' || !b.artist) return;
    try { const r = await api.search(`${normaliseRadioArtist(b.artist) ?? b.artist} ${b.title}`); const t = r.results.find(t => radioSongFits(t, b)); /* RADIO-ARTIST-001: "JACKSON 5, THE" is the catalogue's "Jackson 5" */ if (gen !== this.generation || !t) return; marker.track = t; marker.identified = true; this.put({ analysis: 'Matched broadcaster title to catalogue' }); this.selectItem(); void this.genres(t, marker, gen); } catch { /* published programme/title stays visible, no speculative match */ }
  }
  private async genres(t: Track, marker: Marker, gen: number) { marker.genresPending = true; try { const got = await api.radioGenres(t); if (got && gen === this.generation) { marker.track = { ...(marker.track?.key === t.key ? marker.track : t), ...got.track }; marker.characteristics = got.characteristics; } } catch { /* the listen still counts, without genres */ } finally { marker.genresPending = false; if (gen === this.generation) this.selectItem(); } }
  async identify() {
    const { snapshot, station } = this.value; if (!snapshot || !station || this.value.identifying) return; this.lastIdentify = Date.now(); const gen = this.generation; this.put({ identifying: true, analysis: 'Fingerprinting broadcast audio on this device…' });
    try {
      this.identifyAfter = Infinity;
      const sample = await radioNative<{ pcm: string; seconds: number; end?: number }>({ op: 'sample', id: snapshot.id }); if (sample.seconds < 5) throw Error('Listen for at least five seconds first');
      // RADIO-CLOCK-001: the sample is the audio just before the PLAYHEAD (ring.at on both shells). A shell that
      // does not say where it ended is asked for its playhead straight away; the two reads are milliseconds apart.
      let sampleEnd = typeof sample.end === 'number' && Number.isFinite(sample.end) ? sample.end : NaN;
      if (!Number.isFinite(sampleEnd)) { try { sampleEnd = (await radioNative({ op: 'state', ...(snapshot.native ? {} : { id: snapshot.id }) })).position; } catch { sampleEnd = NaN; } }
      const L = await import('./listen'); const y = floats(sample.pcm); const sig = await L.makeSignature(L.pickWindow(y)); const r = await api.identifyAudio(L.signatureUri(sig), L.signatureMillis(sig)); if (gen !== this.generation) return;
      const t = r.results[0]; if (!t) { this.put({ analysis: 'No music identified; the station may be broadcasting speech or a programme' }); return; }
      const b = parseBroadcast(`${t.artists?.[0] || t.artist} - ${t.title}`, 'Audio fingerprint');
      const heardAt = Number.isFinite(sampleEnd) ? sampleEnd : snapshot.position;
      const startAt = songStartFromFingerprint({ sampleEnd, sampleSeconds: sample.seconds, offset: t.evidence?.kind === 'audio' ? t.evidence.offset : null, duration: t.duration ?? null });
      let marker = [...this.markers].reverse().find(x => x.at <= heardAt + 0.5);
      const sameItem = !!marker && (marker.track?.key === t.key || (marker.broadcast.kind === 'song' && marker.broadcast.state !== 'unavailable' && radioSongFits(t, marker.broadcast)));
      // The broadcaster has just named a different song: this sample still held the end of the previous one.
      // Do not flip the title back; measure again when the new song fills a window.
      if (marker && !sameItem && marker.broadcast.kind === 'song' && marker.broadcast.state === 'current' && marker.broadcast.source !== 'Audio fingerprint' && marker.at > 0 && heardAt - marker.at < 30) {
        this.identifyAfter = heardAt + 12; this.put({ analysis: 'Waiting for the new song to play before measuring it' }); return;
      }
      if (!marker || !sameItem) {
        // A song that began inside the retained audio starts exactly where it was measured to start.
        const at = startAt !== null && startAt > Math.max(snapshot.oldest, marker?.at ?? 0) ? startAt : Math.max(0, heardAt - sample.seconds);
        marker = { at, broadcast: b, track: t, identified: true, heardAt: 0, startAt }; this.markers.push(marker); this.markers.sort((a, b) => a.at - b.at);
      } else {
        marker.track = t; if (marker.broadcast.state !== 'current' || marker.broadcast.kind !== 'song') marker.broadcast = b; marker.identified = true;
        // Re-measured every minute: keep a steady clock unless the new answer really differs (a radio edit or a repeat).
        if (startAt !== null && (marker.startAt == null || Math.abs(marker.startAt - startAt) > 1.5)) marker.startAt = startAt;
      }
      this.put({ analysis: 'Music identified by audio fingerprint' }); this.selectItem(); void this.genres(t, marker, gen);
      const analysed = await api.radioAnalyse(t, snapshot.id); if (gen === this.generation) { marker.track = { ...marker.track!, ...(analysed.bpm ? { bpm: analysed.bpm } : {}) }; this.put({ analysis: analysed.embedded ? 'Audio identified · acoustic sample analysed' : analysed.note || 'Audio identified; acoustic model unavailable' }); }
    } catch (e) { if (gen === this.generation) this.put({ analysis: e instanceof Error ? e.message : 'Audio identification unavailable' }); }
    finally { if (gen === this.generation) this.put({ identifying: false }); }
  }
}
export const radioSession = new RadioSession();
/**
 * CAR-RADIO-CONTROLS-001: what the native player (and so Android Auto) is told about the item on air.
 * `song`/`track` only for a song identified by fingerprint or catalogue match: programmes and
 * unmatched titles never get a star (programmes never train taste). `start` is where the item began
 * on the ring clock and `duration` its length, both seconds or null when not known.
 */
export function radioNowPlaying(id: string, m: { broadcast: Broadcast; track: Track | null; identified: boolean }, station: RadioStation | null, clock: { start: number | null; duration: number | null }) {
  const named = m.identified && m.track && m.track.provider !== 'radio' ? m.track : null;
  let track: Track | null = named;
  try { if (named && JSON.stringify(named).length > 16_000) track = null; } catch { track = null; }
  const song: NativeSong | null = track ? songFromTrack(track, false) : null;
  return { op: 'nowplaying', id, title: m.track?.title || m.broadcast.title || station?.name, artist: m.track?.artists?.join(', ') || m.broadcast.artist || station?.name,
    artwork: (m.identified ? m.track?.artwork : null) || m.broadcast.artwork || station?.image || '', song, track, start: clock.start, duration: clock.duration };
}
// RADIO-PEEK-001: a read-only picture of the live session for checks on a real build, beside
// __airwaveEngine (ENGINE-PEEK-001). No station link and no audio: only what the player shows or why not.
if (typeof window !== 'undefined') {
  Object.defineProperty(window, '__airwaveRadio', { configurable: true, enumerable: false, writable: false, value: { peek: () => {
    const v = radioSession.get();
    return { analysis: v.analysis, identifying: v.identifying, identified: v.identified, songStart: v.songStart ?? null, error: v.error,
      broadcast: v.broadcast && { title: v.broadcast.title, artist: v.broadcast.artist, kind: v.broadcast.kind, state: v.broadcast.state, source: v.broadcast.source },
      track: v.track && { key: v.track.key, title: v.track.title, duration: v.track.duration ?? null },
      snapshot: v.snapshot && { position: v.snapshot.position, received: v.snapshot.received, oldest: v.snapshot.oldest, paused: v.snapshot.paused } };
  } } });
}
