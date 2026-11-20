// @vitest-environment happy-dom
// RADIO-NO-BACKTRACK-001 (owner, 2026-11-19): "power92 ... its actually going back to the previous song". A published
// title that this session already moved past (the fingerprint or a newer title named the next song) is a source running
// behind the air, not a new song: the player never steps back to it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RadioStation } from './radio';
const f = vi.hoisted(() => ({ search: vi.fn(), identifyAudio: vi.fn(), snap: {} as Record<string, unknown>, title: 'Mara - Night Drive', sample: {} as Record<string, unknown>, ops: [] as string[] }));
vi.mock('../api', () => ({ api: { search: (...a: unknown[]) => f.search(...a), identifyAudio: (...a: unknown[]) => f.identifyAudio(...a), radioGenres: async () => null, radioAnalyse: async () => ({ embedded: false, note: '' }), feedback: async () => ({}) } }));
vi.mock('../audio-engine', () => ({ radioOutput: () => null }));
vi.mock('./listen', () => ({ makeSignature: async () => ({}), pickWindow: (y: Float32Array) => y, signatureUri: () => 'data:audio/vnd.shazam.sig;base64,AA', signatureMillis: () => 12000 }));
vi.mock('./radio-feeds', () => ({ publisherBroadcast: async () => null, icecastBroadcast: async () => null }));
const { radioSession } = await import('./radio-client');

const station = (id: string): RadioStation => ({ id, name: 'World radio', url: 'https://radio.example/live', homepage: '', image: '', country: 'Canada', region: '', countryCode: 'CA', language: '', tags: [], codec: 'MP3', bitrate: 128, latitude: null, longitude: null });
const hit = (key: string, title: string, artist: string, offset: number | null, duration = 220) => ({ results: [{ id: key, key, provider: 'deezer', platform_id: key, title, artists: [artist], artist, duration, evidence: { kind: 'audio', offset } }] });
let now = 1794873600000, n = 0;
const priv = () => radioSession as unknown as { generation: number; lastIdentify: number; refreshMetadata(g: number): Promise<void>; poll(g: number): Promise<void>; clear(): void };
/** One native state read, as the 100-500 ms poll does, without leaving its timer running. */
const tick = async () => { await priv().poll(priv().generation); priv().clear(); };
async function tune() {
  await radioSession.start(station(`s${++n}`)); // a fresh station id each time: the metadata cache is per station
  priv().clear(); // stop the poll and metadata timers; the tests drive both by hand
  priv().lastIdentify = now; // the once-a-minute fingerprint is not under test; each test asks for its own
  await priv().refreshMetadata(priv().generation);
}
beforeEach(() => {
  now += 3_600_000; vi.spyOn(Date, 'now').mockImplementation(() => now);
  f.ops.length = 0; f.title = 'Mara - Night Drive'; f.search.mockReset().mockResolvedValue({ results: [] }); f.identifyAudio.mockReset();
  f.snap = { id: 'ring', stationId: 'x', paused: false, position: 0, received: 0, oldest: 0, heard: 0, dropped: false, state: 'playing', error: null, native: true };
  f.sample = { pcm: '', seconds: 12, sampleRate: 16000 };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const q = JSON.parse(decodeURIComponent(String(url).split('?q=')[1]!)) as { op: string };
    f.ops.push(q.op);
    const body = q.op === 'metadata' ? { title: f.title, state: 'current', checkedAt: now, detail: 'Broadcaster ICY' }
      : q.op === 'sample' ? f.sample : q.op === 'request' ? { text: '' } : q.op === 'favourites' ? { stations: [] } : { ...f.snap };
    return { ok: true, json: async () => body } as Response;
  }));
});
afterEach(async () => { await radioSession.stop(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const later = async (title: string) => { now += 10_000; f.title = title; await priv().refreshMetadata(priv().generation); };
const shown = () => `${radioSession.get().broadcast?.artist} - ${radioSession.get().broadcast?.title}`;

describe('the radio never steps back to a song it already moved past', () => {
  it('a newer title, then the older one again: the newer one stays', async () => {
    f.title = 'Electro Band - Electro City'; await tune();
    Object.assign(f.snap, { position: 30, received: 32 }); await tick();
    await later('Belly Gang Kushington - WTF GOIN'); Object.assign(f.snap, { position: 40, received: 42 }); await tick();
    expect(shown()).toBe('Belly Gang Kushington - WTF GOIN');
    await later('Electro Band - Electro City'); Object.assign(f.snap, { position: 50, received: 52 }); await tick();
    expect(shown()).toBe('Belly Gang Kushington - WTF GOIN');
  });
  it('the fingerprint named the song on air; the station\'s older title does not replace it', async () => {
    f.title = 'Belly Gang Kushington - WTF GOIN'; await tune();
    Object.assign(f.snap, { position: 180, received: 182, heard: 180 }); await tick();
    f.identifyAudio.mockResolvedValue(hit('text', 'Text', 'Chief Keef', 20, 228));
    await radioSession.identify();
    expect(shown()).toBe('Chief Keef - Text');
    await later('Belly Gang Kushington - WTF GOIN'); Object.assign(f.snap, { position: 190, received: 192 }); await tick();
    expect(shown()).toBe('Chief Keef - Text');
    await later('Lil Durk - All My Life'); Object.assign(f.snap, { position: 200, received: 202 }); await tick();
    Object.assign(f.snap, { position: 203, received: 205 }); await tick();
    expect(shown()).toBe('Lil Durk - All My Life'); // a genuinely new title still shows
  });
});
