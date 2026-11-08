// @vitest-environment happy-dom
/**
 * Inside the Android app the service's native engine plays (plan ruling 2026-11-08, Task 2). The
 * page chooses the song and what follows, and mirrors what the engine reports: it must never also
 * play the song itself (double audio), it must hand the engine the exact local file, and when the
 * engine moves on by itself the page must follow — not reload — and still learn from the listen.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Player, type Playing } from './Player';
import { resetEngineForTests as resetAudio, setLocalMix, setMixSlider } from './audio-engine';
import { resetEngineForTests as resetNative } from './engine/native-engine';
import type * as DownloadsModule from './engine/downloads';

type Downloads = typeof DownloadsModule;

const { held, readyUrls } = vi.hoisted(() => ({
  held: new Set<string>(),
  readyUrls: new Map<string, string>(),
}));

vi.mock('./engine/downloads', async (importOriginal) => {
  const mod: Downloads = await importOriginal();
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
    readyUrl: (t: { key: string }) => readyUrls.get(t.key) ?? null,
    sourceHint: (t: { key: string }) => readyUrls.get(t.key) ?? null,
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

const SRC_ONE = 'https://music.youtube.com/watch?v=aaaaaaaaaaa';
const SRC_TWO = 'https://music.youtube.com/watch?v=bbbbbbbbbbb';

type Cmd = { op: string; [k: string]: unknown };
let sent: Cmd[] = [];
const ops = (op: string) => sent.filter((c) => c.op === op);
const report = (over: Record<string, unknown>) =>
  act(() => {
    (window as unknown as { __awEngine: (j: string) => void }).__awEngine(JSON.stringify({
      rev: 0, id: 'one', mediaId: 'one', playing: true, playWhenReady: true, buffering: false, waiting: false,
      ended: false, error: null, positionMs: 0, durationMs: 180000, blending: null, ...over,
    }));
  });

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
const upNext = (key: string) => [{ key, title: `Song ${key}`, artist: 'A', artwork: null, preview: null, track: song(key).track }];
const settle = async () => { await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); }); };

beforeEach(() => {
  sent = [];
  held.clear(); readyUrls.clear();
  (window as unknown as { AirwaveNative: unknown }).AirwaveNative = { engine: (json: string) => void sent.push(JSON.parse(json) as Cmd) };
  const g = globalThis as unknown as Record<string, unknown>;
  g['fetch'] = vi.fn(async () => ({ ok: true, blob: async () => new Blob([new Uint8Array(4)]) }) as unknown as Response);
  (globalThis.URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => 'blob:local';
  (globalThis.URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {};
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  resetAudio();
  resetNative();
  setMixSlider(0);
  setLocalMix(true);
  for (const f of Object.values(props)) if (typeof f === 'function') (f as ReturnType<typeof vi.fn>).mockClear?.();
});
afterEach(() => {
  cleanup();
  delete (window as unknown as { AirwaveNative?: unknown }).AirwaveNative;
  resetAudio();
  resetNative();
  vi.unstubAllGlobals();
});

it('hands the engine the exact local file and never plays the song in the page as well', async () => {
  readyUrls.set('one', SRC_ONE);
  held.add(SRC_ONE);
  render(createElement(Player, { ...props, playing: song('one') }));
  await settle();
  await settle();
  const load = ops('load').at(-1)!;
  expect(load).toMatchObject({ play: true, rev: 0, positionMs: 0 });
  expect(load['song']).toMatchObject({ id: 'one', ready: true, source: SRC_ONE });
  for (const deck of document.querySelectorAll('audio')) expect(deck.getAttribute('src'), 'a page deck got a source: double audio').toBeNull();
  // The sound settings go to the engine too.
  expect(ops('settings').some((c) => 'eq' in c && 'mix' in c && 'playThrough' in c)).toBe(true);
  expect(ops('settings').some((c) => 'volume' in c)).toBe(true);
});

it('mirrors the engine: progress, play/pause, and the controls act on the engine', async () => {
  readyUrls.set('one', SRC_ONE);
  held.add(SRC_ONE);
  render(createElement(Player, { ...props, playing: song('one') }));
  await settle();
  await report({ positionMs: 61000 });
  expect(screen.getAllByText('1:01').length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
  expect(ops('pause')).toHaveLength(1);
  await report({ positionMs: 61500, playing: false, playWhenReady: false });
  fireEvent.click(screen.getByRole('button', { name: 'Play' }));
  expect(ops('play')).toHaveLength(1);
});

it('cues the next song once its file is here, so the engine can blend or hand over without the page', async () => {
  readyUrls.set('one', SRC_ONE);
  readyUrls.set('two', SRC_TWO);
  held.add(SRC_ONE);
  render(createElement(Player, { ...props, playing: song('one'), upNext: upNext('two') }));
  await settle();
  const cue = ops('cue').at(-1)!;
  expect(cue['song']).toMatchObject({ id: 'two', ready: true, source: SRC_TWO });
});

it('follows the engine when it moves on by itself, records the listen, and does not reload', async () => {
  readyUrls.set('one', SRC_ONE);
  readyUrls.set('two', SRC_TWO);
  held.add(SRC_ONE);
  held.add(SRC_TWO);
  const { rerender } = render(createElement(Player, { ...props, playing: song('one'), upNext: upNext('two') }));
  await settle();
  // A whole song, heard: the page's meter ticks from the engine's reports.
  for (let t = 0; t <= 180; t += 1) await report({ positionMs: t * 1000 });
  await report({ rev: 1, id: 'two', mediaId: 'two', positionMs: 4000, event: { seq: 1, cause: 'blend', advanced: true, from: { id: 'one', heardMs: 180000, durationMs: 180000 } } });
  expect(props.onPickUpNext).toHaveBeenCalledWith('two');
  expect(props.onListen).toHaveBeenCalledWith('complete', expect.objectContaining({ key: 'one' }), expect.any(Number), expect.objectContaining({ medium: 'full' }));
  expect(ops('ack')).toEqual([{ op: 'ack', seq: 1 }]);
  const loadsBefore = ops('load').length;
  rerender(createElement(Player, { ...props, playing: song('two') }));
  await settle();
  expect(ops('load').length, 'the song the engine is already playing was loaded again').toBe(loadsBefore);
});

it('a page opened part-way through still credits the whole song the engine played', async () => {
  readyUrls.set('one', SRC_ONE);
  held.add(SRC_ONE);
  render(createElement(Player, { ...props, playing: song('one') }));
  await settle();
  // This page only saw the last 40 s; the engine played all 180.
  for (let t = 140; t <= 180; t += 1) await report({ positionMs: t * 1000 });
  await report({ playing: false, ended: true, positionMs: 180000, event: { seq: 3, cause: 'end', advanced: false, from: { id: 'one', heardMs: 180000, durationMs: 180000 } } });
  expect(props.onListen).toHaveBeenCalledWith('complete', expect.objectContaining({ key: 'one' }), 180, expect.objectContaining({ coverage: 180, medium: 'full' }));
});

it('when a song plays out with nothing cued, the page chooses what follows', async () => {
  readyUrls.set('one', SRC_ONE);
  held.add(SRC_ONE);
  render(createElement(Player, { ...props, playing: song('one') }));
  await settle();
  await report({ playing: false, ended: true, positionMs: 180000, event: { seq: 2, cause: 'end', advanced: false, from: { id: 'one', heardMs: 180000, durationMs: 180000 } } });
  expect(props.onNext).toHaveBeenCalledTimes(1);
  // Played out: the button offers Play (the engine keeps playWhenReady set at its end), and
  // pressing it asks the engine to play, which starts the song again from the top.
  await report({ playing: false, ended: true, positionMs: 180000 });
  fireEvent.click(screen.getByRole('button', { name: 'Play' }));
  expect(ops('play')).toHaveLength(1);
});

it('a song chosen before its file is here waits in the engine and gets its file when it lands', async () => {
  // Its own link: the local library is shared by the whole file, and other tests made theirs ready.
  const SRC_LATE = 'https://music.youtube.com/watch?v=ccccccccccc';
  readyUrls.set('one', SRC_LATE);
  render(createElement(Player, { ...props, playing: song('one') }));
  await settle();
  // The link goes with it at once: the service watches for that file itself, page asleep or not.
  expect(ops('load')[0]!['song']).toMatchObject({ id: 'one', ready: false, source: SRC_LATE });
  await report({ playing: false, buffering: true, waiting: true });
  held.add(SRC_LATE);
  // The download finishing is announced by the library; the player re-reads it.
  const { localLibrary } = await import('./engine/local-audio');
  await act(async () => { await localLibrary.ensure(SRC_LATE, 'Song one — A', true); });
  await settle();
  await settle();
  const last = ops('load').at(-1)!;
  expect(last['song']).toMatchObject({ id: 'one', ready: true, source: SRC_LATE });
});
