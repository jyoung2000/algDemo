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
vi.mock('./engine/local-audio', () => ({
  localLibrary: { subscribe: () => () => undefined },
  sourceUrlFor: (id: string) => `https://music.youtube.com/watch?v=${id}`,
}));
vi.mock('./engine/queue-audio', () => ({
  queueAudio: {
    subscribe: (fn: () => void) => { queue.listeners.add(fn); return () => queue.listeners.delete(fn); },
    // The loader matched this Deezer song to a link of its own.
    sourceHint: (t: { key: string }) => (t.key === 'deezer:1' ? 'https://music.youtube.com/watch?v=matched1' : null),
    cardOf: (_key: string, o: { kept: boolean; percent: number | null }): CardCache => {
      const p = o.percent;
      return queue.status === 'ready'
        ? { state: 'ready', glyph: '', text: '', keptText: null, kept: false, progress: 100, indeterminate: false }
        : { state: 'downloading', glyph: '', text: '', keptText: null, kept: false, progress: p ?? 0, indeterminate: p === null };
    },
  },
}));
import { POLL_BUSY_MS, useCardCache } from './useCardCache';

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
beforeEach(() => { vi.useFakeTimers(); seen = []; jobs.list = []; jobs.asked = 0; queue.status = 'running'; host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
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
