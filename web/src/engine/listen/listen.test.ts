/**
 * Song identification: the fingerprint port, the two providers against recorded answers, resolving named songs
 * to playable rows, and the two LocalApi routes the search bar calls on Windows and Android.
 *
 * Fixtures: chords12.wav is synthetic (ffmpeg aevalsrc, 12 s, 16 kHz mono) and chords12.core.sig is what the
 * ShazamIO Rust core (SongRec's algorithm) makes of it. genius-lyric.json and shazam-tag.json are recorded
 * answers, trimmed to the fields the adapters read.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalApi } from '../local-api';
import { HostPacer, Http, type HttpPort, type HttpRequest, type HttpResponse } from '../net';
import { MemoryBackend, Store } from '../store';
import { AUDIO_ACCEPT, BandScaler, CaptureError, listMics, looksLikeAudio, openMic, toMono16k } from './capture';
import { crc32, encodeSignature, makeSignature, peakCount, pickWindow, SAMPLE_RATE, signatureMillis, signatureUri, WINDOW_SECONDS } from './fingerprint';
import { resolveHits } from './identify';
import { Genius, parseGeniusLyrics, parseShazam, Shazam } from './providers';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const json = (name: string) => JSON.parse(fixture(name).toString('utf8'));
const enc = (s: string) => new TextEncoder().encode(s);
const ok = (body: unknown): HttpResponse => ({ status: 200, headers: {}, body: enc(JSON.stringify(body)) });

function wav16(buf: Buffer): Float32Array {
  // Walk the RIFF chunks to "data" (ffmpeg adds a LIST chunk, so the header is not always 44 bytes).
  let pos = 12;
  while (pos + 8 <= buf.length && buf.toString('ascii', pos, pos + 4) !== 'data') pos += 8 + buf.readUInt32LE(pos + 4);
  const start = pos + 8;
  const n = Math.floor(Math.min(buf.readUInt32LE(pos + 4), buf.length - start) / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(start + i * 2) / 32768;
  return out;
}

/** Reads a signature back into per-band (pass, bin) peaks, independently of the encoder. */
function decodeSig(buf: Uint8Array) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const bands: { pass: number; bin: number }[][] = [[], [], [], []];
  let pos = 56;
  while (pos < buf.length) {
    const id = v.getUint32(pos, true) - 0x60030040;
    const size = v.getUint32(pos + 4, true);
    let p = pos + 8;
    const end = p + size;
    let pass = 0;
    while (p < end) {
      const off = buf[p++]!;
      if (off === 0xff) {
        pass = v.getUint32(p, true);
        p += 4;
        continue;
      }
      pass += off;
      bands[id]!.push({ pass, bin: v.getUint16(p + 2, true) });
      p += 4;
    }
    pos = end + ((4 - (size % 4)) % 4);
  }
  return { magic: v.getUint32(0, true), crc: v.getUint32(4, true), samplesPlus: v.getUint32(40, true), bands };
}

/** Routes each request to a handler by host; records what was asked for. */
function routed(handlers: Record<string, (req: HttpRequest) => HttpResponse | Promise<HttpResponse>>) {
  const seen: HttpRequest[] = [];
  const port: HttpPort = {
    async request(req) {
      seen.push(req);
      const h = handlers[new URL(req.url).host];
      return h ? h(req) : { status: 404, headers: {}, body: enc('{}') };
    },
  };
  return { port, seen };
}

const deezerTrack = (id: number, title: string, artist: string, isrc: string) => ({
  id, title, title_short: title, link: `https://www.deezer.com/track/${id}`, duration: 320, isrc, rank: 900000,
  preview: 'https://cdns-preview-d.dzcdn.net/stream/c-x.mp3', artist: { id: 27, name: artist }, album: { id: 1, title: 'Discovery', cover_medium: null },
});

describe('fingerprint (TypeScript port of SongRec)', () => {
  it('matches the ShazamIO core on a synthetic 12 s clip: header, sample count and peaks', async () => {
    const samples = wav16(fixture('chords12.wav'));
    expect(samples.length).toBe(WINDOW_SECONDS * SAMPLE_RATE);
    const sig = await makeSignature(samples);
    const mine = encodeSignature(sig);
    const core = decodeSig(fixture('chords12.core.sig'));
    const ours = decodeSig(mine);
    expect(ours.magic).toBe(0xcafe2580);
    expect(ours.crc).toBe(crc32(mine.subarray(8)));
    expect(ours.samplesPlus).toBe(core.samplesPlus);
    const key = (x: { pass: number; bin: number }) => `${x.pass}:${x.bin}`;
    let total = 0;
    let close = 0;
    core.bands.forEach((c, b) => {
      total += c.length;
      for (const x of c) if (ours.bands[b]!.some((y) => Math.abs(y.pass - x.pass) <= 1 && Math.abs(y.bin - x.bin) <= 2)) close++;
    });
    expect(total).toBeGreaterThan(0);
    // Float rounding moves a few peaks by a bin or a pass; the bulk must land where SongRec puts them.
    expect(close / total).toBeGreaterThan(0.8);
    expect(key(ours.bands.flat()[0]!)).toBeTruthy();
  });

  it('builds the data URI and clip length Shazam expects', async () => {
    const sig = await makeSignature(wav16(fixture('chords12.wav')));
    expect(signatureUri(sig)).toMatch(/^data:audio\/vnd\.shazam\.sig;base64,[A-Za-z0-9+/]+=*$/);
    expect(signatureMillis(sig)).toBe(12000);
    expect(peakCount(sig)).toBeGreaterThan(20);
  });

  it('finds almost nothing in silence, so the UI can say "no match" without sending it', async () => {
    expect(peakCount(await makeSignature(new Float32Array(SAMPLE_RATE * 6)))).toBeLessThan(20);
  });

  it('pads a short clip to 12 s and takes the middle of a long one', () => {
    expect(pickWindow(new Float32Array(SAMPLE_RATE * 4)).length).toBe(SAMPLE_RATE * WINDOW_SECONDS);
    const long = new Float32Array(SAMPLE_RATE * 30).map((_, i) => i);
    const w = pickWindow(long);
    expect(w.length).toBe(SAMPLE_RATE * WINDOW_SECONDS);
    expect(w[0]).toBe(SAMPLE_RATE * 9);
  });

  it('stops when the search is cancelled', async () => {
    const c = new AbortController();
    c.abort();
    await expect(makeSignature(wav16(fixture('chords12.wav')), c.signal)).rejects.toThrow();
  });
});

describe('capture helpers', () => {
  it('mixes to mono and resamples 48 kHz to 16 kHz', () => {
    const n = 48000;
    const l = new Float32Array(n).map((_, i) => Math.sin((2 * Math.PI * 440 * i) / 48000));
    const out = toMono16k([l, l], 48000);
    expect(out.length).toBe(16000);
    expect(Math.max(...out.subarray(1000, 2000))).toBeGreaterThan(0.9);
  });

  it('recognises the containers the picker offers and refuses others', () => {
    const b = (s: string, at = 0) => {
      const a = new Uint8Array(16);
      [...s].forEach((c, i) => (a[at + i] = c.charCodeAt(0)));
      return a;
    };
    expect(looksLikeAudio(b('ID3'))).toBe(true);
    const wav = b('RIFF');
    [...'WAVE'].forEach((c, i) => (wav[8 + i] = c.charCodeAt(0)));
    expect(looksLikeAudio(wav)).toBe(true);
    for (const s of ['OggS', 'fLaC']) expect(looksLikeAudio(b(s))).toBe(true);
    expect(looksLikeAudio(b('ftyp', 4))).toBe(true);
    expect(looksLikeAudio(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]))).toBe(true);
    expect(looksLikeAudio(b('%PDF'))).toBe(false);
    expect(looksLikeAudio(b('\x89PNG'))).toBe(false);
    expect(AUDIO_ACCEPT).toContain('audio/*');
  });
});

describe('providers (recorded answers)', () => {
  it('parses a Genius lyric search: song, artist and highlighted ranges inside the snippet', () => {
    const hits = parseGeniusLyrics(json('genius-lyric.json'));
    expect(hits[0]).toMatchObject({ title: 'One More Time', artist: 'Daft Punk' });
    for (const h of hits) for (const [a, b] of h.ranges) expect(0 <= a && a < b && b <= h.snippet.length).toBe(true);
    expect(hits[0]!.ranges.length).toBeGreaterThan(0);
    expect(hits[0]!.snippet.slice(...hits[0]!.ranges[0]!).toLowerCase()).toMatch(/one|more|time|celebrate|gonna|we/);
  });

  it('parses a Shazam tag answer, and no track as no match', () => {
    expect(parseShazam(json('shazam-tag.json'))).toMatchObject({ title: 'One More Time', artist: 'Daft Punk', isrc: 'GBDUW0000053' });
    expect(parseShazam(json('shazam-tag.json'))!.offset).toBeCloseTo(57.16, 1);
    expect(parseShazam({ matches: [], timestamp: 1 })).toBeNull();
  });

  it('Genius is a keyless GET; Shazam gets a POST of the fingerprint only, with no retry', async () => {
    const { port, seen } = routed({ 'genius.com': () => ok(json('genius-lyric.json')), 'amp.shazam.com': () => ok(json('shazam-tag.json')) });
    const http = new Http(port, new HostPacer({}, 0));
    await new Genius(http).searchLyrics('  one more time  ');
    expect(seen[0]!.url).toBe('https://genius.com/api/search/lyric?q=one%20more%20time&per_page=8');
    expect(seen[0]!.method ?? 'GET').toBe('GET');
    await new Shazam(http).identify('data:audio/vnd.shazam.sig;base64,AAAA', 12000);
    const post = seen[1]!;
    expect(post.method).toBe('POST');
    const body = JSON.parse(post.body!);
    expect(body.signature).toEqual({ uri: 'data:audio/vnd.shazam.sig;base64,AAAA', samplems: 12000 });
    expect(body.timezone).toBe('UTC');
    expect(Object.keys(body).sort()).toEqual(['context', 'geolocation', 'signature', 'timestamp', 'timezone']);
  });
});

describe('resolveHits', () => {
  it('keeps a named song only when a catalogue has the same recording, and counts the rest', async () => {
    const dz = { search: async (q: string) => (/daft punk/i.test(q) ? [{ key: 'deezer:1', provider: 'deezer', title: 'One More Time', artist: 'Daft Punk', artists: ['Daft Punk'], isrc: 'GBDUW0000053' }] : []) };
    const r = await resolveHits(
      [
        { title: 'One More Time', artist: 'Daft Punk', artwork: null, url: '', snippet: 'One more time', ranges: [[0, 3]], evidence: { kind: 'lyrics', snippet: 'One more time', ranges: [[0, 3]] } },
        { title: 'Nowhere Song', artist: 'Nobody', artwork: null, url: '', snippet: 'x', ranges: [], evidence: { kind: 'lyrics', snippet: 'x', ranges: [] } },
      ],
      { deezer: dz as never },
      {},
    );
    expect(r.unplayable).toBe(1);
    expect(r.results).toHaveLength(1);
    expect(r.results[0]).toMatchObject({ key: 'deezer:1', evidence: { kind: 'lyrics', ranges: [[0, 3]] } });
  });
});

describe('LocalApi routes used by the search bar (same engine on Windows and Android)', () => {
  async function api(handlers: Parameters<typeof routed>[0]) {
    const store = await Store.open(new MemoryBackend());
    const r = routed(handlers);
    return { api: new LocalApi({ store, port: r.port, encoder: null, spotifySearch: () => async () => [] }), seen: r.seen };
  }
  const deezer = (req: HttpRequest) => {
    const u = new URL(req.url);
    if (u.pathname === '/search') return ok({ data: /daft/i.test(u.searchParams.get('q') ?? '') ? [deezerTrack(3135553, 'One More Time', 'Daft Punk', 'GBDUW0000053')] : [] });
    return ok({});
  };

  it('GET /api/search/lyrics answers playable rows with the lyric evidence', async () => {
    const { api: a } = await api({ 'genius.com': () => ok(json('genius-lyric.json')), 'api.deezer.com': deezer });
    const r = await a.handle('GET', '/api/search/lyrics?q=one%20more%20time%20we%27re%20gonna%20celebrate', null);
    expect(r.status).toBe(200);
    const body = r.body as { mode: string; named: number; unplayable: number; results: { title: string; evidence: { kind: string } }[] };
    expect(body.mode).toBe('lyrics');
    expect(body.named).toBe(3);
    expect(body.results[0]).toMatchObject({ title: 'One More Time', evidence: { kind: 'lyrics' } });
    expect(body.unplayable).toBe(body.named - body.results.length);
  });

  it('POST /api/identify/audio answers the heard song as a playable row', async () => {
    const { api: a, seen } = await api({ 'amp.shazam.com': () => ok(json('shazam-tag.json')), 'api.deezer.com': deezer });
    const sig = await makeSignature(wav16(fixture('chords12.wav')));
    const r = await a.handle('POST', '/api/identify/audio', { signature: signatureUri(sig), ms: signatureMillis(sig) });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ mode: 'audio', named: 1, heard: { title: 'One More Time', artist: 'Daft Punk' } });
    expect((r.body as { results: { evidence: unknown }[] }).results[0]!.evidence).toMatchObject({ kind: 'audio' });
    expect(seen.filter((q) => q.url.includes('amp.shazam.com'))).toHaveLength(1);
  });

  it('refuses anything that is not a fingerprint before any network call', async () => {
    const { api: a, seen } = await api({});
    expect((await a.handle('POST', '/api/identify/audio', { signature: 'data:audio/wav;base64,AAAA', ms: 12000 })).status).toBe(400);
    expect((await a.handle('POST', '/api/identify/audio', { signature: 'data:audio/vnd.shazam.sig;base64,AAAA', ms: 50 })).status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it('reports a throttled service as busy, once, without retrying', async () => {
    const { api: a, seen } = await api({ 'genius.com': () => ({ status: 429, headers: {}, body: enc('{}') }), 'amp.shazam.com': () => ({ status: 429, headers: {}, body: enc('{}') }) });
    const l = await a.handle('GET', '/api/search/lyrics?q=hello%20darkness', null);
    expect(l).toMatchObject({ status: 503, body: { code: 'busy' } });
    const s = await a.handle('POST', '/api/identify/audio', { signature: 'data:audio/vnd.shazam.sig;base64,AAAA', ms: 12000 });
    expect(s).toMatchObject({ status: 503, body: { code: 'busy' } });
    expect(seen).toHaveLength(2);
  });

  it('a refused request is "refused", and no match is an empty answer, not an error', async () => {
    const { api: a } = await api({ 'amp.shazam.com': () => ok({ matches: [], timestamp: 1, tagid: 'x' }), 'genius.com': () => ({ status: 403, headers: {}, body: enc('{}') }) });
    expect(await a.handle('POST', '/api/identify/audio', { signature: 'data:audio/vnd.shazam.sig;base64,AAAA', ms: 12000 })).toMatchObject({ status: 200, body: { results: [], named: 0 } });
    expect(await a.handle('GET', '/api/search/lyrics?q=hello', null)).toMatchObject({ status: 502, body: { code: 'refused' } });
  });
});

describe('live sound display', () => {
  const frame = (v: number[]) => Float32Array.from(v);

  it('draws nothing for a steady room tone and lifts a new sound above it', () => {
    const s = new BandScaler();
    const hum = () => frame([0.4, 0.4, 0.3, 0.2]);
    let last = hum();
    for (let i = 0; i < 30; i++) s.scale((last = hum()));
    expect(Math.max(...last)).toBeLessThan(0.05);
    const hit = frame([0.4, 0.9, 0.3, 0.2]);
    s.scale(hit);
    expect(hit[1]).toBeGreaterThan(0.9); // the band that rose fills the display
    expect(hit[0]).toBe(0);
  });

  it('does not blow a small ripple up to full height', () => {
    const s = new BandScaler();
    s.scale(frame([0.3, 0.3]));
    const ripple = frame([0.33, 0.3]);
    s.scale(ripple);
    expect(ripple[0]).toBeLessThan(0.2);
  });

  it('keeps a quiet-but-live microphone readable once something changes', () => {
    const s = new BandScaler();
    for (let i = 0; i < 10; i++) s.scale(frame([0.05, 0.05]));
    const f = frame([0.05, 0.3]);
    s.scale(f);
    expect(f[1]).toBeGreaterThan(0.9);
  });
});

describe('choosing a microphone', () => {
  afterEach(() => vi.unstubAllGlobals());
  const devices = (list: { kind: string; deviceId: string; label: string }[], gum: (c: MediaStreamConstraints) => Promise<unknown>) =>
    vi.stubGlobal('navigator', { mediaDevices: { enumerateDevices: async () => list, getUserMedia: gum } });

  it('lists inputs, hides the system aliases, and says when names are hidden', async () => {
    devices(
      [
        { kind: 'audioinput', deviceId: 'default', label: 'Default - Mic A' },
        { kind: 'audioinput', deviceId: 'communications', label: 'Communications - Mic A' },
        { kind: 'audioinput', deviceId: 'a', label: 'Mic A' },
        { kind: 'audiooutput', deviceId: 'o', label: 'Speakers' },
      ],
      async () => ({}),
    );
    expect(await listMics()).toEqual({ mics: [{ id: 'a', label: 'Mic A' }], named: true });
    devices([{ kind: 'audioinput', deviceId: 'x', label: '' }], async () => ({}));
    expect(await listMics()).toEqual({ mics: [{ id: 'x', label: 'Microphone 1' }], named: false });
  });

  it('asks for the chosen device exactly, and for the default when none is chosen', async () => {
    const seen: MediaStreamConstraints[] = [];
    devices([], async (c) => (seen.push(c), {}));
    await openMic('abc');
    await openMic('');
    expect((seen[0]!.audio as MediaTrackConstraints).deviceId).toEqual({ exact: 'abc' });
    expect((seen[1]!.audio as MediaTrackConstraints).deviceId).toBeUndefined();
    expect(seen.every((c) => (c.audio as MediaTrackConstraints).echoCancellation === false)).toBe(true);
  });

  it('falls back to the default when the remembered device is gone, and reports a blocked one', async () => {
    const seen: MediaStreamConstraints[] = [];
    devices([], async (c) => {
      seen.push(c);
      if ((c.audio as MediaTrackConstraints).deviceId) throw Object.assign(new Error('gone'), { name: 'OverconstrainedError' });
      return {};
    });
    await openMic('unplugged');
    expect(seen).toHaveLength(2);
    devices([], async () => {
      throw Object.assign(new Error('no'), { name: 'NotAllowedError' });
    });
    await expect(openMic('')).rejects.toMatchObject({ code: 'denied' } satisfies Partial<CaptureError>);
  });
});
