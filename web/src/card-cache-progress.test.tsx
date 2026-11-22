// @vitest-environment happy-dom
// PLAY-RING-004 (owner, 2026-11-22): "I dont see the download outline animation playing on the play button or album
// button, or artist button, it looks to not happen or be stuck. Ensure this animation plays and works to accurately
// show the download progress on the buttons before turning blue".
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from './api';
import type { CardCache } from './engine/queue-controls';

const jobs = vi.hoisted(() => ({ list: [] as { url: string; state: string; percent: number | null }[], asked: 0 }));
const queue = vi.hoisted(() => ({ listeners: new Set<() => void>(), status: 'running' as string }));
vi.mock('./engine/downloads', () => ({
  downloadsAvailable: () => true,
  dl: { jobs: vi.fn(async () => { jobs.asked++; return { jobs: jobs.list }; }) },
}));
const lib = vi.hoisted(() => ({ status: new Map<string, string>(), held: new Set<string>(), asked: [] as string[], listeners: new Set<() => void>() }));
vi.mock('./engine/local-audio', () => ({
  localLibrary: {
    subscribe: (fn: () => void) => { lib.listeners.add(fn); return () => lib.listeners.delete(fn); },
    status: (url: string) => lib.status.get(url) ?? 'unknown',
    // Asks the shell about one link; it answers "held" only if the file is really there.
    refresh: async (url: string) => { lib.asked.push(url); if (lib.held.has(url)) { lib.status.set(url, 'ready'); lib.listeners.forEach((l) => l()); } },
  },
  sourceUrlFor: (id: string) => `https://music.youtube.com/watch?v=${id}`,
}));
vi.mock('./engine/queue-audio', () => ({
  queueAudio: {
    subscribe: (fn: () => void) => { queue.listeners.add(fn); return () => queue.listeners.delete(fn); },
    // The loader matched this Deezer song to a link of its own.
    sourceHint: (t: { key: string }) => (t.key === 'deezer:1' ? 'https://music.youtube.com/watch?v=matched1' : null),
    cardOf: (_key: string, o: { kept: boolean; percent: number | null }): CardCache => {
      const p = o.percent;
      if (queue.status === 'queued') return { state: 'queued', glyph: '', text: 'Queued', keptText: null, kept: false, progress: 0, indeterminate: false };
      return queue.status === 'ready'
        ? { state: 'ready', glyph: '', text: '', keptText: null, kept: false, progress: 100, indeterminate: false }
        : { state: 'downloading', glyph: '', text: '', keptText: null, kept: false, progress: p ?? 0, indeterminate: p === null };
    },
  },
}));
import { FINISH_HOLD_MS, POLL_BUSY_MS, useCardCache } from './useCardCache';
import { FETCH_GRACE_MS, songSources } from './engine/song-sources';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const deezer = { id: 'deezer:1', key: 'deezer:1', provider: 'deezer', platform_id: '1', title: 'Song', artist: 'A', artists: ['A'] } as Track;
const kept = new Set<string>();
let seen: (CardCache | null)[] = [];
function Probe({ tracks }: { tracks: Track[] }) {
  const of = useCardCache(tracks, kept);
  seen.push(of('deezer:1'));
  return null;
}
let root: Root, host: HTMLDivElement;
beforeEach(() => { vi.useFakeTimers(); songSources.reset(); lib.status.clear(); lib.held.clear(); lib.asked = []; lib.listeners.clear(); seen = []; jobs.list = []; jobs.asked = 0; queue.status = 'running'; host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe('a song matched from another service shows its real download percent', () => {
  it('reads the percent of the job for the link the loader matched, and follows it as it rises', async () => {
    jobs.list = [{ url: 'https://music.youtube.com/watch?v=matched1', state: 'running', percent: 12 }];
    await act(async () => root.render(<Probe tracks={[deezer]} />));
    await tick(0);
    expect(seen.at(-1)).toMatchObject({ state: 'downloading', progress: 12, indeterminate: false });
    jobs.list = [{ url: 'https://music.youtube.com/watch?v=matched1', state: 'running', percent: 57 }];
    await tick(POLL_BUSY_MS);
    expect(seen.at(-1)).toMatchObject({ progress: 57 });
    jobs.list = [{ url: 'https://music.youtube.com/watch?v=matched1', state: 'running', percent: 93 }];
    await tick(POLL_BUSY_MS);
    expect(seen.at(-1)).toMatchObject({ progress: 93 });
  });

  it('looks at once when the loader says something changed, instead of waiting out the idle interval', async () => {
    await act(async () => root.render(<Probe tracks={[deezer]} />));
    await tick(0);
    const before = jobs.asked;
    jobs.list = [{ url: 'https://music.youtube.com/watch?v=matched1', state: 'running', percent: 30 }];
    await act(async () => { queue.listeners.forEach((l) => l()); });
    await tick(0);
    expect(jobs.asked).toBeGreaterThan(before);
    expect(seen.at(-1)).toMatchObject({ progress: 30 });
  });
});

// RING-CLOSE-001 (owner, 2026-11-22): "When I click on a song in android the ring animation doesnt progress to close
// with the download, it quickly plays then the outline resets the animation flashes to blue which isnt what I want".
describe('the ring follows a download to its end and never goes back', () => {
  const url = 'https://music.youtube.com/watch?v=matched1';
  const run = (percent: number | null) => { jobs.list = [{ url, state: 'running', percent }]; };

  it('shows the percent of a song the player itself is fetching, though the loader only has it queued', async () => {
    const other = { ...deezer, id: 'deezer:9', key: 'deezer:9' } as Track;
    function P() { const of = useCardCache([other], kept); seen.push(of('deezer:9')); return null; }
    queue.status = 'queued';
    songSources.set('deezer:9', 'https://music.youtube.com/watch?v=clicked9');
    jobs.list = [{ url: 'https://music.youtube.com/watch?v=clicked9', state: 'running', percent: 41 }];
    await act(async () => root.render(<P />));
    await tick(0);
    expect(seen.at(-1)).toMatchObject({ state: 'downloading', progress: 41, indeterminate: false });
  });

  it('never steps back when a later report is lower or has no number', async () => {
    run(62);
    await act(async () => root.render(<Probe tracks={[deezer]} />));
    await tick(0);
    expect(seen.at(-1)).toMatchObject({ progress: 62 });
    run(null);
    await tick(POLL_BUSY_MS);
    expect(seen.at(-1)).toMatchObject({ progress: 62, indeterminate: false });
    run(30);
    await tick(POLL_BUSY_MS);
    expect(seen.at(-1)).toMatchObject({ progress: 62 });
  });

  it('closes at 100 when the job finishes, and holds there until the file is reported, instead of resetting', async () => {
    run(70);
    await act(async () => root.render(<Probe tracks={[deezer]} />));
    await tick(0);
    jobs.list = [{ url, state: 'done', percent: 100 }];
    await tick(POLL_BUSY_MS);
    // The loader has not said "ready" yet: before, the percent vanished here and the ring fell back to nothing.
    expect(seen.at(-1)).toMatchObject({ state: 'downloading', progress: 100, indeterminate: false });
    await tick(POLL_BUSY_MS * 3);
    expect(seen.at(-1)).toMatchObject({ state: 'downloading', progress: 100 });
    queue.status = 'ready';
    await act(async () => { queue.listeners.forEach((l) => l()); });
    await tick(0);
    expect(seen.at(-1)).toMatchObject({ state: 'ready' });
  });

  it('keeps its place for a moment when the job leaves the list, and lets go if the file never comes', async () => {
    queue.status = 'queued';
    run(55);
    await act(async () => root.render(<Probe tracks={[deezer]} />));
    await tick(0);
    jobs.list = [];
    await tick(POLL_BUSY_MS);
    expect(seen.at(-1)).toMatchObject({ state: 'downloading', progress: 55 });
    await tick(FINISH_HOLD_MS + POLL_BUSY_MS * 2);
    expect(seen.at(-1)).toMatchObject({ state: 'queued', progress: 0 });
  });

  it('drops the ring at once when the download failed', async () => {
    queue.status = 'queued';
    run(55);
    await act(async () => root.render(<Probe tracks={[deezer]} />));
    await tick(0);
    jobs.list = [{ url, state: 'failed', percent: 55 }];
    await tick(POLL_BUSY_MS);
    expect(seen.at(-1)).toMatchObject({ state: 'queued', progress: 0 });
  });
});

// RING-CLOSE-001, measured on the phone build: after a press the row showed nothing for 0.4-3 s (the player was still
// finding the full recording, so no download existed yet), which reads as a dead button and makes the ring look as if
// it jumps. From the press the row says "started, no number yet"; it never invents a percent.
describe('a pressed song shows it has started from the press itself', () => {
  beforeEach(() => { queue.status = 'queued'; });

  it('breathes while the player is finding or fetching the song, before any download exists', async () => {
    await act(async () => root.render(<Probe tracks={[deezer]} />));
    await tick(0);
    expect(seen.at(-1)).toMatchObject({ state: 'queued' });
    await act(async () => { songSources.fetching('deezer:1'); });
    expect(seen.at(-1)).toMatchObject({ state: 'downloading', progress: 0, indeterminate: true });
    // The download appears and reports: the ring takes the real number.
    await act(async () => { songSources.set('deezer:1', 'https://music.youtube.com/watch?v=pressed9'); });
    jobs.list = [{ url: 'https://music.youtube.com/watch?v=pressed9', state: 'running', percent: 22 }];
    await tick(POLL_BUSY_MS);
    expect(seen.at(-1)).toMatchObject({ state: 'downloading', progress: 22, indeterminate: false });
  });

  it('goes back to plain when the player gives up on the song, and only that song breathes', async () => {
    await act(async () => root.render(<Probe tracks={[deezer]} />));
    await tick(0);
    await act(async () => { songSources.fetching('deezer:2'); });
    expect(seen.at(-1)).toMatchObject({ state: 'queued' });
    await act(async () => { songSources.fetching('deezer:1'); });
    expect(seen.at(-1)).toMatchObject({ state: 'downloading', indeterminate: true });
    await act(async () => { songSources.fetching(null); });
    await tick(FETCH_GRACE_MS);
    expect(seen.at(-1)).toMatchObject({ state: 'queued' });
  });

  // Measured: the breathing outline stopped for 38 ms and started over while the player went from "finding the song"
  // to "fetching it". A restarted animation is the "outline resets" the owner saw.
  it('does not blink when the player lets go for a moment between finding the song and fetching it', async () => {
    await act(async () => root.render(<Probe tracks={[deezer]} />));
    await tick(0);
    await act(async () => { songSources.fetching('deezer:1'); });
    seen = [];
    await act(async () => { songSources.fetching(null); });
    await tick(40);
    await act(async () => { songSources.fetching('deezer:1'); });
    await tick(FETCH_GRACE_MS * 2);
    // Drawn again or not in between, it was never anything but "started"; and it still is.
    await act(async () => root.render(<Probe tracks={[deezer]} />));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((c) => c?.state === 'downloading' && c.indeterminate)).toBe(true);
  });
});

// RING-CLOSE-001, measured on the phone build with "Digital Love": the ring reached 100, sat there for 7.6 s, then
// fell back to an empty outline and the button never turned blue, though the song was on the device and playing.
// The service's loader was never asked about a song the player fetched itself, so nothing told the row. The shell
// knows: when a song's download finishes the row asks it, and a file it holds makes the button blue.
describe('a finished download turns the button blue, and it does not reset', () => {
  const url = 'https://music.youtube.com/watch?v=matched1';
  beforeEach(() => { queue.status = 'queued'; });

  it('asks the shell when the job finishes, and is ready as soon as the shell holds the file', async () => {
    jobs.list = [{ url, state: 'running', percent: 80 }];
    await act(async () => root.render(<Probe tracks={[deezer]} />));
    await tick(0);
    expect(seen.at(-1)).toMatchObject({ state: 'downloading', progress: 80 });
    lib.held.add(url);
    jobs.list = [{ url, state: 'done', percent: 100 }];
    await tick(POLL_BUSY_MS);
    expect(lib.asked).toContain(url);
    expect(seen.at(-1)).toMatchObject({ state: 'ready', progress: 100 });
    // And it stays blue: the loader still says nothing of this song, long after the ring's hold has run out.
    await tick(FINISH_HOLD_MS + 2000);
    expect(seen.at(-1)).toMatchObject({ state: 'ready' });
    expect(seen.slice(seen.findIndex((c) => c?.state === 'ready')).every((c) => c?.state === 'ready')).toBe(true);
  });

  it('is ready at once for a song the page already holds, with no job at all', async () => {
    lib.status.set(url, 'ready');
    await act(async () => root.render(<Probe tracks={[deezer]} />));
    await tick(0);
    expect(seen.at(-1)).toMatchObject({ state: 'ready' });
  });

  it('does not turn blue when the shell does not hold the file', async () => {
    jobs.list = [{ url, state: 'running', percent: 80 }];
    await act(async () => root.render(<Probe tracks={[deezer]} />));
    await tick(0);
    jobs.list = [{ url, state: 'done', percent: 100 }];
    await tick(POLL_BUSY_MS);
    expect(lib.asked).toContain(url);
    expect(seen.at(-1)).toMatchObject({ state: 'downloading', progress: 100 });
    await tick(FINISH_HOLD_MS + 2000);
    expect(seen.at(-1)).toMatchObject({ state: 'queued' });
  });
});
