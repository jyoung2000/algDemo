// @vitest-environment happy-dom
// RADIO-CLOCK-001: the live session turns a fingerprint answer into a song clock on the ring's own
// sample clock. The sampled audio is the last seconds BEFORE THE PLAYHEAD (ring.at on both shells),
// so the sample ends at the playhead, not at the live edge.
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

describe('the radio session measures the song clock from the audio (RADIO-CLOCK-001)', () => {
  it('anchors the song start where the fingerprint heard the sample, ending at the playhead', async () => {
    await tune();
    expect(radioSession.get().songStart ?? null).toBeNull(); // a title alone says nothing about when the song began
    Object.assign(f.snap, { position: 180, received: 190, heard: 180 }); await tick();
    f.identifyAudio.mockResolvedValue(hit('night', 'Night Drive', 'Mara', 60));
    await radioSession.identify();
    // 12 s ending at the playhead (ring second 180) were 60 s into the song: it began at 180 - 12 - 60.
    expect(radioSession.get().songStart).toBe(108);
    expect(radioSession.get().track?.duration).toBe(220);
  });
  it('uses the shell\'s own sample end when it reports one', async () => {
    await tune();
    Object.assign(f.snap, { position: 180, received: 190 }); await tick();
    f.sample = { pcm: '', seconds: 12, sampleRate: 16000, end: 179.5 };
    f.identifyAudio.mockResolvedValue(hit('night', 'Night Drive', 'Mara', 60));
    await radioSession.identify();
    expect(radioSession.get().songStart).toBe(107.5);
  });
  it('shows no clock when the fingerprint gives no position', async () => {
    await tune();
    Object.assign(f.snap, { position: 180, received: 190 }); await tick();
    f.identifyAudio.mockResolvedValue(hit('night', 'Night Drive', 'Mara', null));
    await radioSession.identify();
    expect(radioSession.get().track?.key).toBe('night');
    expect(radioSession.get().songStart ?? null).toBeNull();
  });
  it('a new title clears the clock, and that song is fingerprinted once its own audio fills a window', async () => {
    await tune();
    Object.assign(f.snap, { position: 180, received: 180 }); await tick();
    f.identifyAudio.mockResolvedValue(hit('night', 'Night Drive', 'Mara', 60));
    await radioSession.identify();
    expect(radioSession.get().songStart).toBe(108);
    // The station moves on; the next metadata read sees the new title at ring second 200.
    f.title = 'Rhea - Glass Houses'; now += 21_000;
    Object.assign(f.snap, { position: 200, received: 200 }); await tick();
    await priv().refreshMetadata(priv().generation);
    Object.assign(f.snap, { position: 201, received: 201 }); await tick();
    expect(radioSession.get().broadcast?.title).toBe('Glass Houses');
    expect(radioSession.get().songStart ?? null).toBeNull(); // never the previous song's clock
    f.identifyAudio.mockClear().mockResolvedValue(hit('glass', 'Glass Houses', 'Rhea', 9));
    Object.assign(f.snap, { position: 206, received: 206 }); await tick();
    expect(f.identifyAudio).not.toHaveBeenCalled(); // the last 12 s still hold the end of the old song
    Object.assign(f.snap, { position: 214, received: 214 }); await tick();
    await vi.waitFor(() => expect(radioSession.get().songStart).toBe(193)); // 214 - 12 - 9, well inside a minute
    expect(radioSession.get().track?.key).toBe('glass');
  });
  it('measures again once the measured song has outrun its own length, without waiting for a late broadcaster title (RADIO-CLOCK-002)', async () => {
    await tune();
    Object.assign(f.snap, { position: 180, received: 180 }); await tick();
    f.identifyAudio.mockResolvedValue(hit('night', 'Night Drive', 'Mara', 60));
    await radioSession.identify();
    expect(radioSession.get().songStart).toBe(108); // 220 s long: by its own clock it ends at ring second 328
    f.identifyAudio.mockClear().mockResolvedValue(hit('glass', 'Glass Houses', 'Rhea', 2, 200));
    Object.assign(f.snap, { position: 335, received: 335 }); await tick();
    expect(f.identifyAudio).not.toHaveBeenCalled(); // the last 12 s still hold the end of Night Drive
    Object.assign(f.snap, { position: 341, received: 341 }); await tick();
    await vi.waitFor(() => expect(radioSession.get().track?.key).toBe('glass'));
    expect(radioSession.get().songStart).toBe(327); // 341 - 12 - 2: the next song, on its own clock
    expect(radioSession.get().broadcast?.title).toBe('Glass Houses');
  });
  it('stops asking after three tries when the station plays a longer edit than the catalogue copy (RADIO-CLOCK-002)', async () => {
    await tune();
    Object.assign(f.snap, { position: 180, received: 180 }); await tick();
    f.identifyAudio.mockResolvedValue(hit('night', 'Night Drive', 'Mara', 60));
    await radioSession.identify();
    f.identifyAudio.mockClear().mockResolvedValue(hit('night', 'Night Drive', 'Mara', 215));
    for (let pos = 341; pos <= 461; pos += 3) { Object.assign(f.snap, { position: pos, received: pos }); await tick(); await vi.waitFor(() => expect(radioSession.get().identifying).toBe(false)); }
    expect(f.identifyAudio).toHaveBeenCalledTimes(3);
    expect(radioSession.get().track?.key).toBe('night');
  });
  it('ignores a fingerprint of the previous song heard just after the title changed', async () => {
    await tune();
    Object.assign(f.snap, { position: 180, received: 180 }); await tick();
    f.title = 'Rhea - Glass Houses'; now += 21_000;
    await priv().refreshMetadata(priv().generation);
    Object.assign(f.snap, { position: 185, received: 185 }); await tick();
    f.identifyAudio.mockResolvedValue(hit('night', 'Night Drive', 'Mara', 200));
    await radioSession.identify();
    expect(radioSession.get().broadcast?.title).toBe('Glass Houses'); // the title does not flip back
    expect(radioSession.get().songStart ?? null).toBeNull();
  });
});
