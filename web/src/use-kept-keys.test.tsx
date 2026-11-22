// @vitest-environment happy-dom
// ROW-DL-KEPT-001 (owner, 2026-11-22): a song's Download icon goes only when the song is saved for good. Most songs come
// from a service that is matched to a link later, so "is it kept?" has to be asked again once that link is known, and
// again when a download of the listener's own finishes.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from './api';

const shell = vi.hoisted(() => ({ kept: new Set<string>(), asked: [] as string[], told: [] as string[], hints: new Map<string, string>(), listeners: new Set<() => void>() }));
vi.mock('./engine/downloads', () => ({
  downloadsAvailable: () => true,
  targetFor: (t: { provider: string; platform_id: string }) => (t.provider === 'ytmusic' ? { tool: 'yt-dlp', url: `https://music.youtube.com/watch?v=${t.platform_id}` } : null),
  dl: { local: vi.fn(async (url: string) => { shell.asked.push(url); return { file: null, kept: shell.kept.has(url), cached: true, running: false }; }) },
}));
vi.mock('./engine/local-audio', () => ({ localLibrary: { refresh: vi.fn(async (url: string) => { shell.told.push(url); }) } }));
vi.mock('./engine/queue-audio', () => ({
  queueAudio: {
    sourceHint: (t: { key: string }) => shell.hints.get(t.key) ?? null,
    subscribe: (fn: () => void) => { shell.listeners.add(fn); return () => shell.listeners.delete(fn); },
  },
}));
import { KEPT_SETTLE_MS, useKeptKeys } from './useKeptKeys';
import { songSources } from './engine/song-sources';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const yt = { key: 'ytmusic:aaaaaaaaaaa', provider: 'ytmusic', platform_id: 'aaaaaaaaaaa', title: 'Y' } as Track;
const dz = { key: 'deezer:1', provider: 'deezer', platform_id: '1', title: 'D' } as Track;
const list = [yt, dz];
let seen: ReadonlySet<string> = new Set();
function Probe({ rev }: { rev?: number }) { seen = useKeptKeys(list, rev); return null; }
let root: Root, host: HTMLDivElement;
beforeEach(() => { vi.useFakeTimers(); songSources.reset(); shell.kept.clear(); shell.asked = []; shell.told = []; shell.hints.clear(); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe('which songs are saved for good', () => {
  it('asks by the song\u2019s own link, and a cached-only song is not kept', async () => {
    await act(async () => root.render(<Probe />));
    await tick(0);
    expect(shell.asked).toEqual(['https://music.youtube.com/watch?v=aaaaaaaaaaa']);
    expect([...seen]).toEqual([]);
  });

  it('finds a kept song from another service once its link is known', async () => {
    shell.kept.add('https://music.youtube.com/watch?v=matched1');
    await act(async () => root.render(<Probe />));
    await tick(0);
    expect([...seen]).toEqual([]);
    shell.hints.set('deezer:1', 'https://music.youtube.com/watch?v=matched1');
    await act(async () => { shell.listeners.forEach((l) => l()); });
    await tick(KEPT_SETTLE_MS);
    expect([...seen]).toEqual(['deezer:1']);
    // Only the newly known link was asked about: the first song was not asked again.
    expect(shell.asked.filter((u) => u.endsWith('aaaaaaaaaaa'))).toHaveLength(1);
  });

  it('uses the link the player found for a pressed song', async () => {
    shell.kept.add('https://music.youtube.com/watch?v=pressed1');
    await act(async () => root.render(<Probe />));
    await tick(0);
    await act(async () => { songSources.set('deezer:1', 'https://music.youtube.com/watch?v=pressed1'); });
    await tick(KEPT_SETTLE_MS);
    expect([...seen]).toEqual(['deezer:1']);
  });

  // Measured after reopening the app: a saved song had no Download icon (right) but a white Play button (wrong),
  // because nothing had told the page the file is on the device. A kept answer says so.
  it('tells the library a kept song is on the device, so its Play button is blue; and says nothing of the others', async () => {
    shell.kept.add('https://music.youtube.com/watch?v=saved000001');
    songSources.keep('deezer:1', 'https://music.youtube.com/watch?v=saved000001');
    await act(async () => root.render(<Probe />));
    await tick(0);
    expect([...seen]).toEqual(['deezer:1']);
    expect(shell.told).toEqual(['https://music.youtube.com/watch?v=saved000001']);
  });

  it('asks everything again when a download of the listener\u2019s own finishes', async () => {
    await act(async () => root.render(<Probe rev={0} />));
    await tick(0);
    expect([...seen]).toEqual([]);
    shell.kept.add('https://music.youtube.com/watch?v=aaaaaaaaaaa');
    await act(async () => root.render(<Probe rev={1} />));
    await tick(0);
    expect([...seen]).toEqual(['ytmusic:aaaaaaaaaaa']);
  });
});
