// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Track, RecItem, RecResult } from './api';
import { api } from './api';
import { App } from './App';
import { resetShuffleNextForTests } from './util';
import { installMediaCommands } from './engine/media-native';

const tracks = ['a', 'b', 'c', 'd'].map(key => ({ key, title: key.toUpperCase(), artists: ['Test'], provider: 'deezer', platform_id: key, preview: `/fixture/${key}`, tags: [] } as unknown as Track));
const rows = tracks.map((track, i) => ({ track, rank: i + 1, reasons: [], playback: { preview: track.preview, embed: null, open: [] }, characteristics: {} } as unknown as RecItem));
const lists = ['p', 'q'].map(id => ({ id, name: id, items: tracks.map(track => ({ key: track.key, track, played: false })), count: tracks.length, unplayed: tracks.length }));
const shell = vi.hoisted(() => ({ on: false, ready: new Set<string>() }));
vi.mock('./engine/downloads', async orig => ({ ...await orig<typeof import('./engine/downloads')>(), downloadsAvailable: () => shell.on }));
vi.mock('./engine/queue-audio', () => ({ queueAudio: {
  subscribe: () => () => {}, expiredKeys: () => new Set<string>(), cardOf: () => null,
  isReady: (t: Track) => shell.ready.has(t.key), readyUrl: (t: Track) => shell.ready.has(t.key) ? `/fixture/${t.key}` : null,
  sourceHint: () => null,
} }));
vi.mock('./QueuePreparation', () => ({ QueuePreparation: () => null }));
vi.mock('./ListDownloadBar', () => ({ ListDownloadBar: () => null, ListDownloadButton: () => null, ListFolderButton: () => null, ListLoadedNote: () => null }));
vi.mock('./api', async orig => {
  const real = await orig<typeof import('./api')>();
  return { ...real, api: { ...real.api,
    seeds: vi.fn().mockResolvedValue({ seeds: [] }), settings: vi.fn().mockResolvedValue(null),
    feedbackState: vi.fn().mockResolvedValue({ state: {}, events: 0, taste: null }), last: vi.fn(),
    playlists: vi.fn(), saved: vi.fn(), impressions: vi.fn().mockResolvedValue({ recorded: 0 }),
    health: vi.fn(() => new Promise(() => {})), status: vi.fn(() => new Promise(() => {})),
  } };
});
// Keep the real App queue/round/history decisions; replace only audio and list-view boundaries.
vi.mock('./Player', () => ({ Player: (p: { playing: { track: Track } | null; onNext: () => void; onPrev: () => void; onShuffle: () => void; canNext: boolean; upNext: { key: string }[] }) => <div>
  <output data-testid="current">{p.playing?.track.key ?? '-'}</output>
  <output data-testid="upnext">{p.upNext.map(x => x.key).join(',')}</output>
  <button onClick={p.onNext} disabled={!p.canNext}>Fixture Next</button>
  <button onClick={p.onPrev}>Fixture Previous</button>
  <button onClick={p.onShuffle}>Fixture Shuffle</button>
</div> }));
vi.mock('./SavedView', () => ({ SavedView: (p: { onPreview: (t: Track, id?: string) => void }) => <div>{['p', 'q'].flatMap(id => tracks.map(t => <button key={id + t.key} onClick={() => p.onPreview(t, id)}>Saved {id} {t.key}</button>))}</div> }));
vi.mock('./Results', async orig => ({ ...await orig<typeof import('./Results')>(), Results: (p: { onPlay: (r: RecItem) => void; items?: RecItem[] }) => <div>{(p.items?.length ? p.items : rows).map(r => <button key={r.track.key} onClick={() => p.onPlay(r)}>Queue {r.track.key}</button>)}</div> }));
vi.mock('./Search', async orig => ({ ...await orig<typeof import('./Search')>(), Search: (p: { onPreview: (t: Track, list: Track[]) => void }) => <div>{tracks.map(t => <button key={t.key} onClick={() => p.onPreview(t, tracks)}>Search {t.key}</button>)}</div> }));
const current = () => screen.getByTestId('current').textContent;
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
beforeEach(() => {
  vi.clearAllMocks(); resetShuffleNextForTests(); localStorage.clear();
  shell.on = false; shell.ready.clear();
  localStorage.setItem('airwave.shuffle', 'on');
  vi.spyOn(Math, 'random').mockReturnValue(0);
  vi.mocked(api.last).mockResolvedValue({ items: rows, count: tracks.length, asked: tracks.length, phase: 'final', sources: {}, transfer: {} } as unknown as RecResult);
  vi.mocked(api.playlists).mockResolvedValue({ lists } as never);
  vi.mocked(api.saved).mockResolvedValue({ items: tracks.map(track => ({ track })) } as never);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });

// SHUFFLE-ONCE-001 (owner, 2026-11-24): "shuffle repeats and plays the same songs over and over again, shuffle should
// only play a song once before finding a new song". Songs heard before (finished or skipped, on record from any
// earlier session or from the car) are not shuffled to again in the now playing queue.
describe('SHUFFLE-ONCE-001: the queue shuffle plays a song once', () => {
  it('skips songs heard in an earlier session', async () => {
    vi.mocked(api.feedbackState).mockResolvedValue({ state: { a: { complete: true }, c: { skip: true } }, events: 2, taste: null } as never);
    render(<App />);
    await waitFor(() => expect(api.feedbackState).toHaveBeenCalled());
    await screen.findByRole('button', { name: 'Queue b' });
    await new Promise((r) => setTimeout(r, 0));
    click('Queue b'); expect(current()).toBe('b');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Fixture Next' }).hasAttribute('disabled')).toBe(false));
    click('Fixture Next'); expect(current()).toBe('d');
    // Everything has been heard now: no song comes round again.
    expect(screen.getByRole('button', { name: 'Fixture Next' }).hasAttribute('disabled')).toBe(true);
  });
  it('a song started and left mid-way (the app closed) is not shuffled to again after a restart', async () => {
    const first = render(<App />);
    await waitFor(() => expect(api.feedbackState).toHaveBeenCalled());
    await screen.findByRole('button', { name: 'Queue b' });
    click('Queue b'); expect(current()).toBe('b');
    first.unmount();
    render(<App />);
    await screen.findByRole('button', { name: 'Queue a' });
    await new Promise((r) => setTimeout(r, 0));
    click('Queue a'); expect(current()).toBe('a');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Fixture Next' }).hasAttribute('disabled')).toBe(false));
    click('Fixture Next');
    expect(current()).not.toBe('b');
  });
  it('a saved playlist keeps its own rounds: songs heard before still play there', async () => {
    vi.mocked(api.feedbackState).mockResolvedValue({ state: { b: { complete: true }, c: { complete: true }, d: { complete: true } }, events: 3, taste: null } as never);
    render(<App />);
    await waitFor(() => expect(api.feedbackState).toHaveBeenCalled());
    click('Saved');
    await waitFor(() => expect(api.playlists).toHaveBeenCalled());
    click('Saved p a');
    await waitFor(() => expect(current()).toBe('a'));
    click('Fixture Next'); expect(current()).toBe('b');
  });
});

// BUG1 regression guard (commit 3d689d5, SHUFFLE-STAY-001): with shuffle on, a song tapped in the middle of the list
// stays in the queue after Next, and Next moves on to another song rather than coming back to it.
describe('SHUFFLE-STAY-001: a tapped mid-list song stays queued after Next', () => {
  it('tap c, press Next once: c is still in the list and is not the next pick', async () => {
    vi.mocked(api.feedbackState).mockResolvedValue({ state: {}, events: 0, taste: null } as never);
    render(<App />);
    await waitFor(() => expect(api.feedbackState).toHaveBeenCalled());
    await screen.findByRole('button', { name: 'Queue c' });
    await new Promise((r) => setTimeout(r, 0));
    click('Queue c'); expect(current()).toBe('c');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Fixture Next' }).hasAttribute('disabled')).toBe(false));
    click('Fixture Next');
    expect(current()).not.toBe('c');
    expect(current()).not.toBe('-');
    expect(screen.getByRole('button', { name: 'Queue c' })).toBeTruthy();
    expect(screen.getByTestId('upnext').textContent!.split(',')).not.toContain('c');
  });
});

// CAR-X-001 (owner, 2026-11-24): "ensure the X button works on android auto". With no other song downloaded yet the X
// still moves on (the next song fetches and starts); it only stops the song when there is no other song at all.
describe('CAR-X-001: the X moves on even before the next song is downloaded', () => {
  beforeEach(() => { (window as unknown as { AirwaveNative?: unknown }).AirwaveNative = { media: vi.fn() }; installMediaCommands(); });
  afterEach(() => { delete (window as unknown as { AirwaveNative?: unknown }).AirwaveNative; });
  it('the car X on the only downloaded song plays a song still to download', async () => {
    shell.on = true; shell.ready.add('a');
    vi.mocked(api.feedbackState).mockResolvedValue({ state: {}, events: 0, taste: null } as never);
    render(<App />);
    await screen.findByRole('button', { name: 'Queue a' });
    await new Promise((r) => setTimeout(r, 0));
    click('Queue a'); expect(current()).toBe('a');
    await act(async () => { ((window as unknown as Record<string, (j: string) => void>)['__awMediaCmd'])!(JSON.stringify({ type: 'leave', id: 'a' })); });
    await waitFor(() => expect(current()).not.toBe('a'));
    expect(current()).not.toBe('-');
  });
});
