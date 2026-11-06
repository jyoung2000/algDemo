// @vitest-environment happy-dom
/**
 * FAST-PLAY-001: a row the queue already holds as a finished local file starts from that file.
 *
 * The owner: "the music on both apps needs to load faster when playing songs from song list". The
 * player was asking the source chain for a video id on every play, even for a song the preloader had
 * already resolved and downloaded — a network round trip in front of audio that was on disk. When
 * the preloader can name the ready file, nothing is looked up: the deck loads it straight away.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import { Player, type Playing } from './Player';
import { resetEngineForTests, setLocalMix, setMixSlider } from './audio-engine';

const { lookedUp, held, readyUrls, sourceHints } = vi.hoisted(() => ({
  lookedUp: [] as string[],
  /** Links the fake shell holds a finished download for. */
  held: new Set<string>(),
  /** What the preloader already knows: song key -> verified local link. */
  readyUrls: new Map<string, string>(),
  sourceHints: new Map<string, string>(),
}));

vi.mock('./engine/downloads', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./engine/downloads')>();
  return {
    ...mod,
    downloadsAvailable: () => true,
    playbackActive: () => undefined,
    dl: {
      ...mod.dl,
      cacheConfig: vi.fn(async () => ({ bytes: 0, limitBytes: 1024 ** 3 })),
      local: (url: string) => Promise.resolve({ file: held.has(url) ? { name: 'song.opus', bytes: 1 } : null, running: false }),
      start: () => Promise.resolve({ job: { id: 'j' } }),
    },
  };
});
vi.mock('./engine/queue-audio', () => ({
  queueAudio: {
    /** The parent's public readiness API: the verified local link, or null. */
    readyUrl: (t: { key: string }) => readyUrls.get(t.key) ?? null,
    sourceHint: (t: { key: string }) => sourceHints.get(t.key) ?? null,
    protect: async () => undefined,
    subscribe: () => () => {},
  },
}));
vi.mock('./api', () => ({
  api: {
    previewUrl: (route: string) => Promise.resolve({ url: `https://cdn.test/${route}.mp3` }),
    fullSong: (t: { key: string }) => {
      lookedUp.push(t.key);
      return Promise.resolve({ id: null, confident: false });
    },
    embedLocal: () => Promise.resolve({ embedded: true, already: false, source: 'local', segments: 1, seconds: 1 }),
  },
}));

const LOCAL = 'blob:ready-song';
const SRC = 'https://music.youtube.com/watch?v=dQw4w9WgXcQ';

function param() {
  const p: Record<string, unknown> = {};
  Object.assign(p, {
    value: 1,
    setValueAtTime: () => p, linearRampToValueAtTime: () => p, exponentialRampToValueAtTime: () => p,
    setValueCurveAtTime: () => p, cancelScheduledValues: () => p, cancelAndHoldAtTime: () => p,
  });
  return p;
}
const node = () => ({ connect: (d: unknown) => d, disconnect: () => {}, gain: param(), frequency: param(), Q: param(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(), detune: param(), type: 'peaking' });
class FakeContext {
  state = 'running';
  currentTime = 0;
  destination = node();
  resume = async () => { this.state = 'running'; };
  createGain = () => node();
  createBiquadFilter = () => node();
  createDynamicsCompressor = () => node();
  createAnalyser = () => ({ ...node(), fftSize: 2048, frequencyBinCount: 1024 });
  createMediaElementSource = () => node();
}
/** happy-dom has no media pipeline: give the elements the parts the player reads and writes. */
function stubMedia() {
  const proto = globalThis.HTMLMediaElement.prototype as unknown as Record<string, unknown>;
  const own = new WeakMap<object, Record<string, unknown>>();
  const bag = (el: object) => {
    let b = own.get(el);
    if (!b) own.set(el, (b = { paused: true, currentTime: 0, duration: 180, readyState: 4, seeking: false, ended: false }));
    return b;
  };
  for (const k of ['paused', 'currentTime', 'duration', 'readyState', 'seeking', 'ended']) {
    Object.defineProperty(proto, k, { configurable: true, get(this: object) { return bag(this)[k]; }, set(this: object, v: unknown) { bag(this)[k] = v; } });
  }
  proto['play'] = async function (this: object) { bag(this)['paused'] = false; };
  proto['pause'] = function (this: object) { bag(this)['paused'] = true; };
  proto['load'] = () => {};
}

const props = {
  upNext: [], docked: false, canPrev: true, canNext: true, shuffle: false, repeat: 'off' as const,
  actions: { flags: {}, downloadState: 'idle' as const, downloadAvailable: true, onFeedback: vi.fn(), onDownload: vi.fn(), onDownloads: vi.fn() },
  onShuffle: vi.fn(), onRepeat: vi.fn(), onPrev: vi.fn(), onNext: vi.fn(), onListen: vi.fn(),
  onWheel: vi.fn(), onSelect: vi.fn(), onMenu: vi.fn(), onPickUpNext: vi.fn(),
};
/** A row with no YouTube id and no preview of its own: today that always costs a lookup. */
const song = (key: string): Playing => ({
  track: { key, title: `Song ${key}`, artist: 'A', provider: 'deezer', platform_id: key, url: null, duration: 180 } as unknown as Playing['track'],
  playback: { open: [], preview: null, embed: null } as unknown as Playing['playback'],
});
const settle = async () => { await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); }); };

beforeEach(() => {
  lookedUp.length = 0; held.clear(); readyUrls.clear(); sourceHints.clear();
  stubMedia();
  const g = globalThis as unknown as Record<string, unknown>;
  g['fetch'] = vi.fn(async () => ({ ok: true, blob: async () => new Blob([new Uint8Array(4)]) }) as unknown as Response);
  (globalThis.URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => LOCAL;
  (globalThis.URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {};
  vi.stubGlobal('AudioContext', FakeContext);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  resetEngineForTests();
  setMixSlider(0);
  setLocalMix(true);
});
afterEach(() => { cleanup(); resetEngineForTests(); vi.unstubAllGlobals(); });

it('plays the file the queue already holds without asking any source for it again', async () => {
  readyUrls.set('one', SRC);
  held.add(SRC);
  render(createElement(Player, { ...props, playing: song('one') }));
  await settle();
  await settle();
  expect(lookedUp, 'a song already on disk was looked up again').toEqual([]);
  const deck = document.querySelector('audio');
  expect(deck?.getAttribute('src')).toBe(LOCAL);
});

it('uses a previously verified link after cold start before the background poll marks it ready', async () => {
  sourceHints.set('one', SRC);
  held.add(SRC);
  render(createElement(Player, { ...props, playing: song('one') }));
  await settle();
  await settle();
  expect(lookedUp, 'a known local link must not trigger another catalog search').toEqual([]);
  expect(document.querySelector('audio')?.getAttribute('src')).toBe(LOCAL);
});

it('still resolves a song the queue has no file for', async () => {
  render(createElement(Player, { ...props, playing: song('two') }));
  await settle();
  expect(lookedUp).toContain('two');
});
