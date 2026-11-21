// @vitest-environment happy-dom
// RADIO-TITLE-INBAND-001 (owner, 2026-11-20): "The radio tab is not updating the song on the player fast enough, it lags
// almost a full minute behind, the radio needs to update song information and the current song playing as frequently as
// viably possible". Measured over 12 minutes against each stream's own in-band titles: V103's iHeart feed named each song
// 27-28 s late, Power 92's Futuri feed 30-31 s early and 103.5 KISS's iHeart feed about 3 minutes early. The titles inside
// the playing stream are placed on the ring clock by both shells (`icy` in the state); the player follows them as the
// audio reaches them, and a feed only adds detail to the song they name.
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


const shown = () => `${radioSession.get().broadcast?.artist} - ${radioSession.get().broadcast?.title}`;
const feed = async (title: string) => { now += 5_000; f.title = title; await priv().refreshMetadata(priv().generation); };
const at = async (position: number, icy: { at: number; title: string; first?: boolean }[]) => { Object.assign(f.snap, { position, received: position + 5, heard: position, icy }); await tick(); };

describe("the player follows the stream's own titles", () => {
  it('a title change in the stream shows as the audio reaches it, with its clock starting there', async () => {
    f.title = 'Usher - U Don\'t Have To Call'; await tune();
    const icy = [{ at: 0, title: 'Usher - text="U Don\'t Have To Call" song_spot="M" MediaBaseId="1"', first: true }, { at: 46.6, title: 'Womack And Womack - text="Baby I\'m Scared Of You" song_spot="M" MediaBaseId="2"' }];
    await at(30, icy); expect(shown()).toBe("Usher - U Don't Have To Call");
    await at(46, icy); expect(shown()).toBe("Usher - U Don't Have To Call"); // the change is still 0.6 s ahead in the audio
    await at(47.2, icy); expect(shown()).toBe("Womack And Womack - Baby I'm Scared Of You");
    expect(radioSession.get().songStart).toBe(46.6);
  });
  it('a feed running late does not take the player back, and one running early does not jump ahead', async () => {
    f.title = 'Usher - U Don\'t Have to Call'; await tune();
    const icy = [{ at: 0, title: 'Usher - text="U Don\'t Have To Call" song_spot="M"', first: true }, { at: 46.6, title: 'Womack And Womack - text="Baby I\'m Scared Of You" song_spot="M"' }];
    await at(50, icy); expect(shown()).toBe("Womack And Womack - Baby I'm Scared Of You");
    await feed('Usher - U Don\'t Have to Call'); await at(55, icy);      // V103's feed, 28 s late
    expect(shown()).toBe("Womack And Womack - Baby I'm Scared Of You");
    await feed('Mary J. Blige - Be Without You'); await at(60, icy);     // a feed naming the next song early
    expect(shown()).toBe("Womack And Womack - Baby I'm Scared Of You");
  });
  it('station imaging between songs is not a song; the song before it is not kept on screen', async () => {
    f.title = 'Usher - U Don\'t Have to Call'; await tune();
    const icy = [{ at: 0, title: 'Usher - text="U Don\'t Have To Call" song_spot="M"', first: true }, { at: 25.3, title: 'Today\'s R&B & Throwbacks - text="V103" song_spot="T" MediaBaseId="0"' }];
    await at(30, icy);
    expect(radioSession.get().broadcast?.kind).toBe('programme'); expect(radioSession.get().broadcast?.title).not.toBe("U Don't Have To Call");
  });
  it('the song in the stream is matched to the catalogue like a feed title', async () => {
    f.search.mockResolvedValue({ results: [{ id: 'w', key: 'womack|baby', provider: 'deezer', platform_id: 'w', title: "Baby I'm Scared of You", artists: ['Womack & Womack'], artist: 'Womack & Womack', duration: 300 }] });
    f.title = 'Usher - U Don\'t Have to Call'; await tune();
    await at(50, [{ at: 0, title: 'Usher - text="U Don\'t Have To Call" song_spot="M"', first: true }, { at: 46.6, title: 'Womack And Womack - text="Baby I\'m Scared Of You" song_spot="M"' }]);
    await new Promise(r => setTimeout(r, 0)); await at(51, [{ at: 0, title: 'Usher - text="U Don\'t Have To Call" song_spot="M"', first: true }, { at: 46.6, title: 'Womack And Womack - text="Baby I\'m Scared Of You" song_spot="M"' }]);
    expect(f.search).toHaveBeenCalledWith(expect.stringContaining("Baby I'm Scared Of You"));
    expect(radioSession.get().track?.key).toBe('womack|baby');
  });
  it('a station with no titles in its stream still follows its feed, shown as soon as it changes', async () => {
    f.title = 'Electro Band - Electro City'; await tune();
    await at(30, []); expect(shown()).toBe('Electro Band - Electro City');
    await feed('Lil Durk - All My Life'); await at(30.5, []);
    expect(shown()).toBe('Lil Durk - All My Life'); // not 5 s later when the newest audio is reached
  });
});

describe('the fingerprint and the stream naming the same song (measured on KEXP: stream titles 10-19 s after the audio)', () => {
  it('one song, starting where the fingerprint measured it, not where its title arrived', async () => {
    f.title = 'Chalk - Heaven'; await tune();
    const icy = [{ at: 0, title: 'Chalk - Heaven', first: true }, { at: 381.1, title: 'Elastica - Connection' }];
    await at(373, icy);                                          // the title is in the received audio, 8 s ahead
    f.sample = { pcm: '', seconds: 12, sampleRate: 16000, end: 377.9 };
    f.identifyAudio.mockResolvedValue(hit('elastica', 'Connection', 'Elastica', 3.42, 140));
    Object.assign(f.snap, { position: 377.9 }); await radioSession.identify();
    expect(shown()).toBe('Elastica - Connection'); expect(radioSession.get().songStart).toBeCloseTo(362.48, 1);
    await at(381.5, icy); await at(390, icy);
    expect(shown()).toBe('Elastica - Connection'); expect(radioSession.get().songStart).toBeCloseTo(362.48, 1);
  });
});

describe('when the stream names nothing new (measured: V103 sent no title for 4 minutes over a song change)', () => {
  it("a feed's new song is taken once the stream's song has run past its length", async () => {
    f.search.mockResolvedValue({ results: [{ id: 'u', key: 'usher|call', provider: 'deezer', platform_id: 'u', title: "U Don't Have to Call", artists: ['Usher'], artist: 'Usher', duration: 60 }] });
    f.title = 'Usher - U Don\'t Have To Call'; await tune();
    const icy = [{ at: 0, title: 'Usher - text="U Don\'t Have To Call" song_spot="M"', first: true }, { at: 10, title: 'Usher - text="U Don\'t Have To Call" song_spot="M"' }];
    await at(20, icy); await new Promise(r => setTimeout(r, 0)); await at(21, icy);
    await feed('Eve - Gotta Man'); await at(40, icy); expect(shown()).toBe("Usher - U Don't Have To Call"); // 30 s into a 60 s song
    await at(76, icy); await feed('Eve - Gotta Man'); await at(77, icy); expect(shown()).toBe('Eve - Gotta Man'); // past its length (10 + 60 + 5)
  });
  it("a feed's song is taken after 45 s of a stream item that is not a song", async () => {
    f.title = 'Usher - U Don\'t Have To Call'; await tune();
    const icy = [{ at: 0, title: 'Usher - text="U Don\'t Have To Call" song_spot="M"', first: true }, { at: 10, title: ' - text="Spot Block End" amgTrackId="9876543"' }];
    await at(30, icy); await feed('Eve - Gotta Man'); await at(31, icy); expect(radioSession.get().broadcast?.kind).toBe('programme');
    await at(56, icy); await feed('Eve - Gotta Man'); await at(57, icy); expect(shown()).toBe('Eve - Gotta Man');
  });
  it('an ad marker already in the stream at connect does not replace the song the feed named', async () => {
    f.title = 'Digable Planets - Rebirth Of Slick'; await tune();
    await at(16, [{ at: 0, title: ' - text="Spot Block End" amgTrackId="9876543"', first: true }]);
    expect(shown()).toBe('Digable Planets - Rebirth Of Slick');
  });
});

describe('how often the song is asked for', () => {
  it('a station without stream titles is asked every 5 seconds', async () => {
    const { RADIO_META_EVERY_MS } = await import('./radio-client');
    expect(RADIO_META_EVERY_MS).toBe(5000);
  });
});
