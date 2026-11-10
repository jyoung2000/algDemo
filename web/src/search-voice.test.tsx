// @vitest-environment happy-dom
/**
 * VOICE-SEARCH-001. Owner: "allow the user to voice search song names using the same mic icon they can
 * search for songs via song lyrics, a user should be able to search via song name or song lyric".
 * Owner's choice: one tap does both. The mic listens once; what it heard is fingerprinted (music
 * playing) and written down (speech). A fingerprint match wins; otherwise the words go into the search
 * box and run as an ordinary search, which asks for titles and lyrics together.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { IdentifyResponse, SearchResponse, Track } from './api';
import type * as Api from './api';
import { queryFromSpeech as realQuery } from './engine/speech/whisper';

const track = (k: string): Track =>
  ({ key: k, title: `Song ${k}`, artist: 'Queen', artists: ['Queen'], album: null, duration: 300, artwork: null, preview: null,
    provider: 'ytmusic', platform_id: k, url: null, release: null }) as unknown as Track;

let clipSeconds = 4;
let heard = '';
let shazam: IdentifyResponse = { results: [], query: '', named: 0, unplayable: 0 } as unknown as IdentifyResponse;
const search = vi.fn((_q: string, _s?: AbortSignal) => Promise.resolve({ query: _q, results: [track('t1')], sources: { ytmusic: { state: 'ok', count: 1 } }, ms: 5, bytes: 0 } as unknown as SearchResponse));
const lyrics = vi.fn((_q: string, _s?: AbortSignal) => Promise.resolve({ results: [track('l1')], query: _q, named: 1, unplayable: 0 } as unknown as IdentifyResponse));
const identifyAudio = vi.fn(() => Promise.resolve(shazam));
const transcribe = vi.fn(async () => heard);

vi.mock('./api', async (orig) => {
  const real = await orig<typeof Api>();
  return { ...real, api: { ...real.api, search: (q: string, s?: AbortSignal) => search(q, s), searchLyrics: (q: string, s?: AbortSignal) => lyrics(q, s), identifyAudio: () => identifyAudio() } };
});
// A synchronous factory: an async one raced the mic's two concurrent imports of this module, and the
// first test got the real module.
vi.mock('./engine/speech', () => ({
  prepareSpeech: () => {},
  transcribe: () => transcribe(),
  queryFromSpeech: (t: string) => realQuery(t),
}));
vi.mock('./engine/listen', () => ({
  SAMPLE_RATE: 16_000,
  SILENT_PEAK: 0.01,
  recordMic: async () => ({ done: Promise.resolve(new Float32Array(clipSeconds * 16_000)), stop: () => {}, cancel: () => {}, device: 'Test mic' }),
  pickWindow: (s: Float32Array) => s,
  makeSignature: async () => ({}),
  peakCount: () => 100,
  signatureUri: () => 'data:audio/vnd.shazam.sig;base64,AA',
  signatureMillis: () => 4000,
}));
const { Search } = await import('./Search');

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  for (const f of [search, lyrics, identifyAudio, transcribe]) f.mockClear();
  clipSeconds = 4;
  heard = '';
  shazam = { results: [], query: '', named: 0, unplayable: 0 } as unknown as IdentifyResponse;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const tapMic = async () => {
  await act(async () => root.render(<Search seeds={[]} onAdd={() => {}} onPreview={() => {}} />));
  const mic = host.querySelector<HTMLButtonElement>('.find__act--mic')!;
  expect(mic.getAttribute('aria-label')).toBe('Search by voice: say a song name or lyrics, or let it hear the song');
  await act(async () => mic.click());
  // The mic's modules load on first use; give them time, then let the search settle.
  for (let i = 0; i < 40 && !search.mock.calls.length && !/Song match|too short/i.test(host.textContent ?? ''); i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  }
};
const box = () => host.querySelector<HTMLInputElement>('input[type="search"], .find input')!;

it('searches titles and lyrics for a spoken song name when no music was recognised', async () => {
  heard = 'Bohemian Rhapsody by Queen.';
  await tapMic();
  expect(box().value).toBe('Bohemian Rhapsody by Queen');
  expect(search).toHaveBeenCalledWith('Bohemian Rhapsody by Queen', expect.anything());
  await act(async () => { await new Promise((r) => setTimeout(r, 900)); });
  expect(lyrics).toHaveBeenCalledWith('Bohemian Rhapsody by Queen', expect.anything());
  expect(host.textContent).toMatch(/Song t1/);
});

it('searches a spoken lyric the same way', async () => {
  heard = 'Is this the real life? Is this just fantasy?';
  await tapMic();
  expect(box().value).toBe('Is this the real life Is this just fantasy');
  expect(search).toHaveBeenCalledWith('Is this the real life Is this just fantasy', expect.anything());
});

it('shows the recognised song when the music itself matched, whatever was said', async () => {
  shazam = { results: [track('match')], query: 'Bohemian Rhapsody Queen', named: 1, unplayable: 0 } as unknown as IdentifyResponse;
  heard = 'Mama, just killed a man.';
  await tapMic();
  expect(host.textContent).toMatch(/Song match/);
  expect(search).not.toHaveBeenCalled();
  expect(box().value).toBe('');
});

it('takes a short spoken name that is too short to fingerprint', async () => {
  clipSeconds = 1.5;
  heard = 'Yale, Ken Carson.';
  await tapMic();
  expect(identifyAudio).not.toHaveBeenCalled();
  expect(search).toHaveBeenCalledWith('Yale Ken Carson', expect.anything());
});

it('still says the clip was too short when nothing was said in it', async () => {
  clipSeconds = 1.5;
  heard = '';
  await tapMic();
  expect(search).not.toHaveBeenCalled();
  expect(host.textContent).toMatch(/too short/i);
});
