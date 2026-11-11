// @vitest-environment happy-dom
/**
 * STREAM-DL-001 in the player. Owner: "can we listen to a song while downloading it from source
 * platforms". A chosen song whose download is still running plays straight from its source on this
 * page's own deck (so the EQ and mixer still apply); the download carries on for next time.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import { Player, type Playing } from './Player';
import { resetEngineForTests, setLocalMix, setMixSlider } from './audio-engine';
import { localLibrary } from './engine/local-audio';
import { streamAudioUrl } from './engine/stream-pick';
import type * as Downloads from './engine/downloads';

const { held, sourceHints, canStream, started, gate, hlsStarts } = vi.hoisted(() => ({
  held: new Set<string>(),
  sourceHints: new Map<string, string>(),
  canStream: { yes: true },
  started: [] as string[],
  /** When set, the shell's answer about a link waits for this. */
  gate: { wait: null as Promise<void> | null },
  hlsStarts: [] as { media: HTMLAudioElement; source: string; failed: () => void; stopped: boolean }[],
}));

vi.mock('./engine/hls', () => ({
  startHls: (media: HTMLAudioElement, source: string, failed: () => void) => {
    const started = { media, source, failed, stopped: false };
    hlsStarts.push(started);
    return () => { started.stopped = true; };
  },
}));

vi.mock('./engine/downloads', async (importOriginal) => {
  const mod = await importOriginal<typeof Downloads>();
  return {
    ...mod,
    downloadsAvailable: () => true,
    playbackActive: () => undefined,
    dl: {
      ...mod.dl,
      health: () => Promise.resolve({ ready: true, runs_spotdl: true, tools: [], saves_to: '', stream: canStream.yes }),
      cacheConfig: vi.fn(async () => ({ bytes: 0, limitBytes: 1024 ** 3 })),
      // Not held yet means its download is running.
      local: async (url: string) => {
        if (gate.wait) await gate.wait;
        return { file: held.has(url) ? { name: 'song.opus', bytes: 1 } : null, running: !held.has(url) };
      },
      start: (url: string) => { started.push(url); return Promise.resolve({ job: { id: 'j' } }); },
    },
  };
});
vi.mock('./engine/queue-audio', () => ({
  queueAudio: {
    readyUrl: () => null,
    sourceHint: (t: { key: string }) => sourceHints.get(t.key) ?? null,
    protect: async () => undefined,
    subscribe: () => () => {},
  },
}));
vi.mock('./api', () => ({
  api: {
    previewUrl: (route: string) => Promise.resolve({ url: `https://cdn.test/${route}.mp3` }),
    fullSong: () => Promise.resolve({ id: null, confident: false }),
    embedLocal: () => Promise.resolve({ embedded: true, already: false, source: 'local', segments: 1, seconds: 1 }),
  },
}));

const LOCAL = 'blob:the-finished-file';
const node = () => {
  const p: Record<string, unknown> = { value: 1 };
  for (const k of ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime', 'setValueCurveAtTime', 'cancelScheduledValues', 'cancelAndHoldAtTime']) p[k] = () => p;
  return { connect: (d: unknown) => d, disconnect: () => {}, gain: p, frequency: p, Q: p, threshold: p, knee: p, ratio: p, attack: p, release: p, detune: p, type: 'peaking' };
};
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
const song = (key: string): Playing => ({
  track: { key, title: `Song ${key}`, artist: 'A', provider: 'deezer', platform_id: key, url: null, duration: 180 } as unknown as Playing['track'],
  playback: { open: [], preview: null, embed: null } as unknown as Playing['playback'],
});
const settle = async () => { await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); }); };
const deckSrc = () => document.querySelector('audio')?.getAttribute('src') ?? null;
const note = () => document.querySelector('.np__note')?.textContent ?? '';
const fire = (type: string) => act(async () => { document.querySelector('audio')!.dispatchEvent(new Event(type)); });

beforeEach(() => {
  held.clear(); sourceHints.clear(); started.length = 0; hlsStarts.length = 0; canStream.yes = true; gate.wait = null;
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

it('plays a song from its source while its download runs, through this page\u2019s own deck', async () => {
  const SRC = 'https://music.youtube.com/watch?v=aaaaaaaaaaa';
  sourceHints.set('one', SRC);
  render(createElement(Player, { ...props, playing: song('one') }));
  await settle();
  await settle();
  expect(deckSrc()).toBe(streamAudioUrl(SRC));
  await fire('playing');
  expect(note()).toContain('streaming from its source while it downloads');
  expect(note()).toContain('equaliser');
});

it('keeps playing the stream when the download lands, rather than restarting the song', async () => {
  const SRC = 'https://music.youtube.com/watch?v=bbbbbbbbbbb';
  sourceHints.set('two', SRC);
  render(createElement(Player, { ...props, playing: song('two') }));
  await settle();
  await settle();
  await fire('playing');
  held.add(SRC);
  await act(async () => { await localLibrary.refresh(SRC); });
  await settle();
  await settle();
  expect(deckSrc()).toBe(streamAudioUrl(SRC));
  expect(note()).toContain('Download finished');
});

it('plays the file instead when it lands before the stream makes a sound', async () => {
  const SRC = 'https://music.youtube.com/watch?v=ccccccccccc';
  sourceHints.set('three', SRC);
  render(createElement(Player, { ...props, playing: song('three') }));
  await settle();
  await settle();
  expect(deckSrc()).toBe(streamAudioUrl(SRC));
  held.add(SRC);
  await act(async () => { await localLibrary.refresh(SRC); });
  await settle();
  await settle();
  expect(deckSrc()).toBe(LOCAL);
});

it('falls back to waiting for the download, without an error, when the stream fails', async () => {
  const SRC = 'https://music.youtube.com/watch?v=ddddddddddd';
  sourceHints.set('four', SRC);
  render(createElement(Player, { ...props, playing: song('four') }));
  await settle();
  await settle();
  await fire('error');
  await settle();
  expect(hlsStarts).toHaveLength(1);
  await act(async () => { hlsStarts[0]!.failed(); });
  await settle();
  expect(deckSrc()).toBeNull();
  expect(note()).toContain('Downloading the full song');
  expect(document.querySelector('.np__note--bad')).toBeNull();
  // A retried download passes through "asking the shell" and back to running: the failed stream
  // stays off rather than being tried again.
  let release = () => {};
  gate.wait = new Promise<void>((r) => (release = r));
  let retried: Promise<void> = Promise.resolve();
  await act(async () => { retried = localLibrary.retry(SRC, 'Song four'); });
  await settle();
  expect(note()).toContain('Loading the full song');
  gate.wait = null;
  release();
  await act(async () => { await retried; });
  await settle();
  await settle();
  expect(deckSrc()).toBeNull();
});

it('tries HLS on the same deck after progressive fails, then waits for download on fatal HLS error', async () => {
  const SRC = 'https://soundcloud.com/someone/a-song';
  sourceHints.set('five', SRC);
  render(createElement(Player, { ...props, playing: song('five') }));
  await settle();
  await settle();
  expect(deckSrc()).toBe(streamAudioUrl(SRC));
  await fire('error');
  await settle();
  expect(hlsStarts).toHaveLength(1);
  expect(hlsStarts[0]!.source).toBe(SRC);
  expect(hlsStarts[0]!.media).toBe(document.querySelector('audio'));
  await act(async () => { hlsStarts[0]!.failed(); });
  await settle();
  expect(hlsStarts[0]!.stopped).toBe(true);
  expect(deckSrc()).toBeNull();
  expect(note()).toContain('Downloading the full song');
});
