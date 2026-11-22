// @vitest-environment happy-dom
// RING-CLOSE-001 (owner, 2026-11-22): "...then the outline resets the animation flashes to blue which isnt what I want".
// Measured on the phone build: after a Download press the row read started, then plain again for ~275 ms (the job
// existed but the next look at the job list had not happened), then started again. The press must read as one
// unbroken download; and a song the press saved must stay saved in the row, whatever the job list later holds.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from './api';

const shell = vi.hoisted(() => ({ jobs: [] as Record<string, unknown>[], startState: 'queued', held: false, listLag: false, release: null as null | (() => void) }));
vi.mock('./engine/downloads', async (orig) => ({
  ...(await orig<typeof import('./engine/downloads')>()),
  downloadsAvailable: () => true,
  dl: {
    jobs: vi.fn(async () => ({ jobs: shell.jobs })),
    health: vi.fn(async () => ({ runs_spotdl: false })),
    keep: vi.fn(async () => null),
    local: vi.fn(async () => ({ file: shell.held ? { name: 'a.opus', bytes: 1 } : null, kept: shell.held, cached: false, running: false })),
    start: vi.fn(async (url: string, tool: string, format: string, label: string) => {
      // The shell answers after a moment, as a real one does.
      await new Promise<void>((r) => { shell.release = r; });
      const job = { id: 'job-1', url, tool, format, label, state: shell.startState, stage: 'queued', percent: null, message: null, error: null, files: [], saved_to: null };
      // The shell lists the job from the moment it answers; `listLag` holds the list back, as a slow bridge would.
      if (!shell.listLag) shell.jobs = [job];
      return { job };
    }),
  },
}));
import { FRESH_MAX_MS, useDownloads } from './Downloads';
import { SAVED_LINKS_KEY, songSources } from './engine/song-sources';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const song = { key: 'ytmusic:aaaaaaaaaaa', provider: 'ytmusic', platform_id: 'aaaaaaaaaaa', title: 'Song', artists: ['A'] } as Track;
let api: ReturnType<typeof useDownloads>;
const seen: (string | null)[] = [];
function Probe() { api = useDownloads(() => undefined); seen.push(api.jobOf(song.key)?.state ?? null); return null; }
let root: Root, host: HTMLDivElement;
beforeEach(async () => {
  vi.useFakeTimers(); seen.length = 0; shell.jobs = []; shell.startState = 'queued'; shell.held = false; shell.listLag = false; shell.release = null;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<Probe />));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });

describe('a Download press reads as one unbroken download', () => {
  it('never falls back to "not started" between the press and the job showing in the list', async () => {
    expect(api.jobOf(song.key)).toBeNull();
    seen.length = 0;
    shell.listLag = true; // as measured: the list did not show the new job for about a quarter of a second
    let done: Promise<unknown>;
    await act(async () => { done = api.downloadTrack(song); });
    await settle();
    expect(api.jobOf(song.key)).toMatchObject({ state: 'queued' });
    await act(async () => { shell.release!(); await done; });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(api.jobOf(song.key)).toMatchObject({ state: 'queued' });
    // Then the list shows it, with a percent, and the row follows.
    shell.jobs = [{ id: 'job-1', url: 'u', tool: 'yt-dlp', format: 'original', label: 'Song', state: 'running', stage: 'fetching', percent: 40, message: null, error: null, files: [], saved_to: null }];
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(api.jobOf(song.key)).toMatchObject({ state: 'running', percent: 40 });
    expect(seen.filter((s) => s === null)).toEqual([]);
  });

  it('lets go after a few seconds if the job never shows in the list', async () => {
    shell.listLag = true;
    let done: Promise<unknown>;
    await act(async () => { done = api.downloadTrack(song); });
    await settle();
    await act(async () => { shell.release!(); await done; });
    await act(async () => { await vi.advanceTimersByTimeAsync(FRESH_MAX_MS + 700); });
    expect(api.jobOf(song.key)).toBeNull();
  });

  it('keeps a song saved by the press saved, though no job for it is in the list', async () => {
    // Already in the Music folder: the press answers with a finished record that the shell never lists.
    shell.held = true;
    await act(async () => { await api.downloadTrack(song); });
    await settle();
    expect(api.jobOf(song.key)).toMatchObject({ state: 'done', percent: 100 });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(api.jobOf(song.key)).toMatchObject({ state: 'done', percent: 100 });
  });

  // ROW-DL-KEPT-001: the link the press used is what the app asks the shell about next time it is opened.
  it('remembers the link the song was saved under', async () => {
    let done: Promise<unknown>;
    await act(async () => { done = api.downloadTrack(song); });
    await settle();
    await act(async () => { shell.release!(); await done; });
    expect(songSources.get(song.key)).toBe('https://music.youtube.com/watch?v=aaaaaaaaaaa');
    expect(window.localStorage.getItem(SAVED_LINKS_KEY)).toContain('aaaaaaaaaaa');
  });
});
