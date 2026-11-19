// @vitest-environment happy-dom
// RADIO-TASTE-001 (owner, 2026-11-18: "ensure songs played on radio affect the user algorithm as well").
// A song heard on a radio station is a listen like any other, once two things are true: the song is
// identified (by audio fingerprint, or by a broadcaster title the catalogue confirms) and enough of
// it was really heard. Thirty seconds is noted as a listen; most of the song is a full listen and
// replaces that note. A programme, an unnamed song and the station's own tags say nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RadioStation } from './radio';
const f = vi.hoisted(() => ({ search: vi.fn(), identifyAudio: vi.fn(), feedback: vi.fn(), genres: vi.fn(), snap: {} as Record<string, unknown>, title: 'Mara - Night Drive', sample: {} as Record<string, unknown> }));
vi.mock('../api', () => ({ api: { search: (...a: unknown[]) => f.search(...a), identifyAudio: (...a: unknown[]) => f.identifyAudio(...a), radioGenres: (...a: unknown[]) => f.genres(...a), radioAnalyse: async () => ({ embedded: false, note: '' }), feedback: (...a: unknown[]) => f.feedback(...a) } }));
vi.mock('../audio-engine', () => ({ radioOutput: () => null }));
vi.mock('./listen', () => ({ makeSignature: async () => ({}), pickWindow: (y: Float32Array) => y, signatureUri: () => 'data:audio/vnd.shazam.sig;base64,AA', signatureMillis: () => 12000 }));
vi.mock('./radio-feeds', () => ({ publisherBroadcast: async () => null, icecastBroadcast: async () => null }));
const { radioSession } = await import('./radio-client');

const station = (id: string): RadioStation => ({ id, name: 'World radio', url: 'https://radio.example/live', homepage: '', image: '', country: 'Canada', region: '', countryCode: 'CA', language: '', tags: ['jazz', 'talk'], codec: 'MP3', bitrate: 128, latitude: null, longitude: null });
const song = (key: string, title: string, artist: string, duration: number | null = 220) => ({ id: key, key, provider: 'deezer', platform_id: key, title, artists: [artist], artist, ...(duration ? { duration } : {}) });
const hit = (key: string, title: string, artist: string, offset: number | null, duration: number | null = 220) => ({ results: [{ ...song(key, title, artist, duration), evidence: { kind: 'audio', offset } }] });
let now = 1794873600000, n = 0;
const priv = () => radioSession as unknown as { generation: number; lastIdentify: number; refreshMetadata(g: number): Promise<void>; poll(g: number): Promise<void>; clear(): void };
const tick = async () => { await priv().poll(priv().generation); priv().clear(); };
/** Play the ring from one second to another, one second per state read, as real listening does. */
const listen = async (from: number, to: number) => { for (let p = from; p <= to; p++) { Object.assign(f.snap, { position: p, received: p + 10, heard: p }); await tick(); } };
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise<void>((r) => setTimeout(r, 0)); };
async function tune() {
  await radioSession.start(station(`taste${++n}`));
  priv().clear(); priv().lastIdentify = now;
  await priv().refreshMetadata(priv().generation);
}
type Call = [string, { key: string; tags?: unknown }, Record<string, unknown>];
const calls = () => f.feedback.mock.calls as unknown as Call[];

beforeEach(() => {
  now += 3_600_000; vi.spyOn(Date, 'now').mockImplementation(() => now);
  f.title = 'Mara - Night Drive'; f.search.mockReset().mockResolvedValue({ results: [] }); f.identifyAudio.mockReset();
  f.feedback.mockReset().mockResolvedValue({}); f.genres.mockReset().mockResolvedValue(null);
  f.snap = { id: 'ring', stationId: 'x', paused: false, position: 0, received: 0, oldest: 0, heard: 0, dropped: false, state: 'playing', error: null, native: true };
  f.sample = { pcm: '', seconds: 12, sampleRate: 16000 };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const q = JSON.parse(decodeURIComponent(String(url).split('?q=')[1]!)) as { op: string };
    const body = q.op === 'metadata' ? { title: f.title, state: 'current', checkedAt: now, detail: 'Broadcaster ICY' }
      : q.op === 'sample' ? f.sample : q.op === 'request' ? { text: '' } : q.op === 'favourites' ? { stations: [] } : { ...f.snap };
    return { ok: true, json: async () => body } as Response;
  }));
});
afterEach(async () => { await radioSession.stop(); await settle(); /* a report made on leaving must not land in the next test */ vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** Tune in, let 12 s play, and have the fingerprint name the song as starting at ring second 0. */
async function identified(duration: number | null = 220) {
  await tune();
  await listen(1, 12);
  f.identifyAudio.mockResolvedValue(hit('night', 'Night Drive', 'Mara', 0, duration));
  await radioSession.identify();
  expect(radioSession.get().track?.key).toBe('night');
}

describe('a song heard on the radio counts as a listen (RADIO-TASTE-001)', () => {
  it('notes a listen once thirty seconds of an identified song were heard', async () => {
    await identified();
    await listen(13, 40); await settle();
    expect(calls()).toHaveLength(0); // 28 s heard: not yet
    await listen(41, 45); await settle();
    expect(calls()).toHaveLength(1);
    const [kind, track, extra] = calls()[0]!;
    expect(kind).toBe('qualified');
    expect(track.key).toBe('night');
    expect(extra).toMatchObject({ medium: 'radio', origin: 'radio', confidence: 0.7, duration: 220 });
    expect(extra['coverage']).toBeGreaterThanOrEqual(30);
    expect(String(extra['event_id'])).toMatch(/^radio:ring:[0-9a-f]{16}$/);
    await listen(46, 90); await settle();
    expect(calls()).toHaveLength(1); // the same listen is not noted again
  });

  it('counts the song as a full listen once most of it was heard, in place of the thirty-second note', async () => {
    await identified();
    await listen(13, 60); await settle();
    const noted = String(calls()[0]![2]['event_id']);
    await listen(61, 160); await settle();
    expect(calls()).toHaveLength(1); // 148 s of 220 heard: under the 70% a full listen needs
    await listen(161, 170); await settle();
    expect(calls()).toHaveLength(2);
    const [kind, track, extra] = calls()[1]!;
    expect(kind).toBe('complete');
    expect(track.key).toBe('night');
    expect(extra).toMatchObject({ medium: 'radio', origin: 'radio', confidence: 0.7, duration: 220, supersedes: noted, event_id: `${noted}:full` });
    expect(extra['coverage']).toBeGreaterThanOrEqual(154);
    expect(extra['listened']).toBe(extra['coverage']);
    await listen(171, 215); await settle();
    expect(calls()).toHaveLength(2); // not again while the song is still playing
  });

  it('says how much was finally heard when the song is left, under the same full-listen event', async () => {
    await identified();
    await listen(13, 170); await settle();
    const first = calls()[1]![2];
    await listen(171, 228); await settle();
    await radioSession.stop(); await settle();
    expect(calls().map((c) => c[0])).toEqual(['qualified', 'complete', 'complete']);
    const last = calls()[2]![2];
    expect(last['event_id']).toBe(first['event_id']);
    expect(last['coverage']).toBeGreaterThan(Number(first['coverage']) + 40);
    expect(last['coverage']).toBeLessThanOrEqual(220); // never more than the recording itself
    expect(last).toMatchObject({ medium: 'radio', origin: 'radio', duration: 220, supersedes: first['supersedes'] });
  });

  it('does not report again on leaving when nothing more was heard', async () => {
    await identified();
    await listen(13, 170); await settle();
    await radioSession.stop(); await settle();
    expect(calls().map((c) => c[0])).toEqual(['qualified', 'complete']);
  });

  it('never calls a song of unknown length a full listen', async () => {
    await identified(null);
    await listen(13, 200); await settle();
    expect(calls().map((c) => c[0])).toEqual(['qualified']);
  });

  it('counts a song the broadcaster named when the catalogue confirms it, without a fingerprint', async () => {
    f.search.mockResolvedValue({ results: [song('night', 'Night Drive', 'Mara')] });
    await tune(); await settle();
    expect(radioSession.get().identified).toBe(true);
    await listen(1, 40); await settle();
    expect(calls().map((c) => [c[0], c[1].key])).toEqual([['qualified', 'night']]);
  });

  it('counts nothing for a programme or for a song nobody could identify', async () => {
    f.title = 'Evening programme';
    await tune();
    await listen(1, 90); await settle();
    expect(calls()).toHaveLength(0);
    await radioSession.stop();
    f.title = 'Mara - Night Drive'; // a title the catalogue does not confirm
    await tune();
    await listen(1, 90); await settle();
    await radioSession.stop(); await settle();
    expect(calls()).toHaveLength(0);
  });

  it('sends the song with its own genres and never the station\'s tags', async () => {
    f.genres.mockResolvedValue({ track: { tags: [{ name: 'synthwave', label: 'Synthwave', confidence: 0.8 }] }, characteristics: null });
    await identified();
    await listen(13, 45); await settle();
    expect(calls()).toHaveLength(1);
    expect((calls()[0]![1].tags as { name: string }[]).map((t) => t.name)).toEqual(['synthwave']);
    expect(JSON.stringify(calls()[0]![1])).not.toMatch(/jazz|talk/);
  });

  it('waits for the genre lookup before noting the listen, but not past the end of the song', async () => {
    let answer!: (v: unknown) => void;
    f.genres.mockReturnValue(new Promise((r) => { answer = r; }));
    await identified();
    await listen(13, 50); await settle();
    expect(calls()).toHaveLength(0); // 38 s heard, genres still being looked up
    answer({ track: { tags: [{ name: 'synthwave', label: 'Synthwave', confidence: 0.8 }] }, characteristics: null }); await settle();
    await listen(51, 52); await settle();
    expect(calls()).toHaveLength(1);
    expect((calls()[0]![1].tags as { name: string }[]).map((t) => t.name)).toEqual(['synthwave']);
  });

  it('notes the listen when the listener moves straight to another station', async () => {
    f.genres.mockReturnValue(new Promise(() => {}));
    await identified();
    await listen(13, 50); await settle();
    expect(calls()).toHaveLength(0);
    await radioSession.start(station('next')); priv().clear(); await settle();
    expect(calls().map((c) => [c[0], c[1].key])).toEqual([['qualified', 'night']]);
  });

  it('still notes the listen when the station is left before the genre lookup answers', async () => {
    f.genres.mockReturnValue(new Promise(() => {}));
    await identified();
    await listen(13, 50); await settle();
    expect(calls()).toHaveLength(0);
    await radioSession.stop(); await settle();
    expect(calls().map((c) => [c[0], c[1].key])).toEqual([['qualified', 'night']]);
  });
});
