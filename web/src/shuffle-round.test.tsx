// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Track, RecItem, RecResult } from './api';
import { api } from './api';
import { App } from './App';
import { resetShuffleNextForTests } from './util';

const tracks = ['a', 'b', 'c', 'd'].map(key => ({ key, title: key.toUpperCase(), artists: ['Test'], provider: 'deezer', platform_id: key, preview: `/fixture/${key}`, tags: [] } as unknown as Track));
const rows = tracks.map((track, i) => ({ track, rank: i + 1, reasons: [], playback: { preview: track.preview, embed: null, open: [] }, characteristics: {} } as unknown as RecItem));
const lists = ['p', 'q'].map(id => ({ id, name: id, items: tracks.map(track => ({ key: track.key, track, played: false })), count: tracks.length, unplayed: tracks.length }));
const shell = vi.hoisted(() => ({ on: false, ready: new Set<string>() }));
vi.mock('./engine/downloads', async orig => ({ ...await orig<typeof import('./engine/downloads')>(), downloadsAvailable: () => shell.on }));
vi.mock('./engine/queue-audio', () => ({ queueAudio: {
  subscribe: () => () => {}, expiredKeys: () => new Set<string>(), cardOf: () => null,
  isReady: (t: Track) => shell.ready.has(t.key), readyUrl: (t: Track) => shell.ready.has(t.key) ? `/fixture/${t.key}` : null,
} }));
vi.mock('./QueuePreparation', () => ({ QueuePreparation: () => null }));
vi.mock('./ListDownloadBar', () => ({ ListDownloadBar: () => null, ListDownloadButton: () => null, ListFolderButton: () => null }));
vi.mock('./api', async orig => {
  const real = await orig<typeof import('./api')>();
  return { ...real, api: { ...real.api,
    seeds: vi.fn().mockResolvedValue({ seeds: [] }), settings: vi.fn().mockResolvedValue(null),
    feedbackState: vi.fn().mockResolvedValue({ state: {}, taste: null }), last: vi.fn(),
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
vi.mock('./Results', async orig => ({ ...await orig<typeof import('./Results')>(), Results: (p: { onPlay: (r: RecItem) => void }) => <div>{rows.map(r => <button key={r.track.key} onClick={() => p.onPlay(r)}>Queue {r.track.key}</button>)}</div> }));
vi.mock('./Search', async orig => ({ ...await orig<typeof import('./Search')>(), Search: (p: { onPreview: (t: Track, list: Track[]) => void }) => <div>{tracks.map(t => <button key={t.key} onClick={() => p.onPreview(t, tracks)}>Search {t.key}</button>)}</div> }));
const current = () => screen.getByTestId('current').textContent;
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
async function savedStart() {
  render(<App />);
  click('Saved');
  await waitFor(() => expect(api.saved).toHaveBeenCalled());
  await waitFor(() => expect(api.playlists).toHaveBeenCalled());
  click('Saved p a');
  await waitFor(() => expect(current()).toBe('a'));
}
beforeEach(() => {
  vi.clearAllMocks(); resetShuffleNextForTests(); localStorage.clear();
  shell.on = false; shell.ready.clear();
  localStorage.setItem('airwave.shuffle', 'on'); localStorage.setItem('airwave.repeat', 'all');
  vi.spyOn(Math, 'random').mockReturnValue(0);
  vi.mocked(api.last).mockResolvedValue({ items: rows, count: tracks.length, asked: tracks.length, phase: 'final', sources: {}, transfer: {} } as unknown as RecResult);
  vi.mocked(api.playlists).mockResolvedValue({ lists } as never);
  vi.mocked(api.saved).mockResolvedValue({ items: tracks.map(track => ({ track })) } as never);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });

describe('SHUFFLE-ROUND-001: real App transitions keep the round', () => {
  it('does not shuffle to an unready search hit inside an installed shell', () => {
    shell.on = true; ['a', 'c', 'd'].forEach(k => shell.ready.add(k));
    render(<App />); click('Search a'); click('Fixture Next'); expect(current()).toBe('c');
    click('Fixture Next'); expect(current()).toBe('d');
  });
  it('keeps ordinary sequential search Next available to fetch its selected full song', () => {
    shell.on = true; shell.ready.add('a'); localStorage.setItem('airwave.shuffle', 'off');
    render(<App />); click('Search a'); click('Fixture Next'); expect(current()).toBe('b');
  });
  it('does not forget a played song when the current saved row is tapped again', async () => {
    await savedStart(); click('Fixture Next'); expect(current()).toBe('b');
    click('Saved p b'); // Explicit replay is allowed, but cannot reset the automatic round.
    click('Fixture Next'); expect(current()).toBe('c');
    click('Fixture Next'); expect(current()).toBe('d');
  });
  it('does not forget played search-list songs on another tap in that same list', async () => {
    render(<App />); click('Search a'); click('Fixture Next'); expect(current()).toBe('b');
    click('Search b'); click('Fixture Next'); expect(current()).toBe('c');
    click('Fixture Next'); expect(current()).toBe('d');
  });
  it('starts a separate round on switching from a saved list to the queue', async () => {
    await savedStart(); click('Fixture Next'); expect(current()).toBe('b');
    click('Discover'); click('Queue b'); click('Fixture Next'); expect(current()).toBe('a');
  });
  it('does not carry another playlist\'s heard set into a newly selected playlist', async () => {
    await savedStart(); click('Fixture Next'); click('Saved q b');
    click('Fixture Next'); expect(current()).toBe('a');
  });
  it('keeps played songs accounted for when shuffle is turned off and back on', async () => {
    await savedStart(); click('Fixture Next'); expect(current()).toBe('b');
    click('Fixture Shuffle'); click('Fixture Shuffle');
    click('Fixture Next'); expect(current()).toBe('c');
    click('Fixture Next'); expect(current()).toBe('d');
  });
  // REPEAT-COUNT-001: the repeat button now counts extra plays of ONE song (off, 1, 2, infinity) and
  // no longer offers "repeat the list". beforeEach saves the old `all` setting on purpose: an app
  // updated from the older version must treat it as off, so a round still plays every song once and
  // then ends instead of starting another. (stepQueue's own multi-round rule stays covered in
  // util.test.ts, queue-readiness.test.ts and shuffle-commit.test.ts.)
  it('plays each of four tracks exactly once, then the round is over', async () => {
    await savedStart(); const seen = [current()];
    const next = () => screen.getByRole('button', { name: 'Fixture Next' }) as HTMLButtonElement;
    for (let i = 0; i < 3; i++) { expect(next().disabled).toBe(false); click('Fixture Next'); seen.push(current()); }
    expect(new Set(seen).size).toBe(4);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).not.toBe(seen[i - 1]);
    expect(next().disabled, 'every song has played: there is no fifth').toBe(true);
    click('Fixture Next'); expect(current()).toBe(seen[3]);
  });
});
