// @vitest-environment happy-dom
// PLAY-LIVE-001, ALBUM-PLAY-STATE-001 and SEARCH-DBL-NEXT-001 (owner, 2026-11-21).
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from './api';
import { CardCacheContext } from './card-cache-context';
import type { CardCache } from './engine/queue-controls';
import { ListPlayButton, RowPlayButton } from './RowPlay';
import { TrackList } from './Search';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const t = (k: string): Track => ({ id: k, key: k, provider: 'deezer', platform_id: k, title: `Song ${k}`, artist: 'A', artists: ['A'] } as Track);
const card = (state: CardCache['state'], progress = 0): CardCache => ({ state, glyph: '', text: '', keptText: null, kept: false, progress, indeterminate: false });
let root: Root, host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const render = (el: React.ReactElement) => act(async () => root.render(el));
const btn = (name: string) => [...host.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === name) as HTMLButtonElement;

describe('a song’s Play button shows its download (PLAY-LIVE-001)', () => {
  it('a song still downloading has a ring filled to its progress, and no blue fill', async () => {
    await render(<RowPlayButton track={t('x')} cache={card('downloading', 40)} onPlay={() => {}} />);
    const b = btn('Play Song x');
    expect(b.dataset['ready']).toBeUndefined(); expect(b.dataset['progress']).toBe('true');
    expect(b.style.getPropertyValue('--dl')).toBe('40');
  });
  it('a song not yet downloaded shows an empty ring; a ready one a blue disc with no ring', async () => {
    await render(<><RowPlayButton track={t('q')} cache={card('queued')} onPlay={() => {}} /><RowPlayButton track={t('r')} cache={card('ready')} onPlay={() => {}} /></>);
    expect(btn('Play Song q').style.getPropertyValue('--dl')).toBe('0');
    expect(btn('Play Song r').dataset['ready']).toBe('true'); expect(btn('Play Song r').dataset['progress']).toBeUndefined();
  });
  it('the row flips to ready as soon as the cache says so, without any other action', async () => {
    let state: CardCache = card('downloading', 90);
    const view = () => <CardCacheContext.Provider value={() => state}><TrackList tracks={[t('x')]} seedKeys={new Set()} onAdd={vi.fn()} onPreview={vi.fn()} label="Songs" /></CardCacheContext.Provider>;
    await render(view());
    expect(btn('Play Song x').dataset['ready']).toBeUndefined();
    state = card('ready', 100); await render(view());
    expect(btn('Play Song x').dataset['ready']).toBe('true');
  });
  it('the app folds each Download job into the rows’ state and re-reads it when a file lands', () => {
    const app = readFileSync(`${process.cwd()}/src/App.tsx`, 'utf8');
    expect(app).toMatch(/withJob\(queueCache\(key\), dls\.jobOf\(key\)\)/);
    const hook = readFileSync(`${process.cwd()}/src/useCardCache.ts`, 'utf8');
    expect(hook).toMatch(/\}, \[available, urls, kept, pct, landed\]\);/);
  });
  it('blue means a white arrow', () => {
    const css = readFileSync(`${process.cwd()}/src/row-play.css`, 'utf8');
    expect(css).toMatch(/\.iconbtn\.playbtn\[data-ready='true'\]\s*\{[^}]*background:\s*var\(--accent\)[^}]*color:\s*#fff/);
  });
  // PLAY-RING-BLACK-001 (owner, 2026-11-21): "Change the blue ring around the undownloaded play button to be black ring
  // and have the download progress make the outline ring get thicker from left to right, same with the album and
  // artist play buttons".
  it('a song still to download has a thin black ring that grows thicker from left to right with its download', () => {
    const css = readFileSync(`${process.cwd()}/src/play-state.css`, 'utf8');
    const thin = /\.iconbtn\.playbtn\.playbtn\[data-progress='true'\],\s*button\.listplay\.listplay\[data-progress='true'\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(thin).toMatch(/box-shadow:\s*inset 0 0 0 1\.5px var\(--ink\)/);
    const thick = /\[data-progress='true'\]::before\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(thick).toMatch(/background:\s*var\(--ink\)/);
    expect(thick).toMatch(/padding:\s*4px/);
    expect(thick).toMatch(/clip-path:\s*inset\(0 calc\(100% - var\(--dl, 0\) \* 1%\) 0 0\)/);
    // No blue anywhere in a ring: blue is kept for ready.
    expect(css.split('/* A list').shift()!.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/--accent|31, 111, 209/);
    expect(/\.iconbtn\.playbtn\.playbtn\[data-progress='true'\]\s*\{[^}]*color:\s*var\(--ink\)/.test(css)).toBe(true);
  });
});

describe('a list’s Play button is blue only when every song is downloaded (ALBUM-PLAY-STATE-001)', () => {
  const list = [t('a'), t('b')];
  it('stays neutral with a ring for the share downloaded, then turns blue', async () => {
    let states: Record<string, CardCache> = { a: card('ready'), b: card('downloading', 50) };
    const view = () => <CardCacheContext.Provider value={(k) => states[k] ?? null}><ListPlayButton tracks={list} className="push push--default" label="Play album" onClick={() => {}}>Play album</ListPlayButton></CardCacheContext.Provider>;
    await render(view());
    const b = btn('Play album');
    expect(b.dataset['ready']).toBeUndefined(); expect(b.dataset['progress']).toBe('true'); expect(b.style.getPropertyValue('--dl')).toBe('75');
    expect(b.title).toBe('Play album — 1 of 2 songs downloaded');
    states = { a: card('ready'), b: card('ready') }; await render(view());
    expect(btn('Play album').dataset['ready']).toBe('true'); expect(btn('Play album').dataset['progress']).toBeUndefined();
    expect(btn('Play album').title).toBe('Play album — every song downloaded');
  });
  it('album pages, saved albums and the artist page’s play buttons all use it', () => {
    for (const f of ['Albums.tsx', 'SavedView.tsx']) expect(readFileSync(`${process.cwd()}/src/${f}`, 'utf8')).toMatch(/<ListPlayButton tracks=[\s\S]{0,260}label="Play album"/);
    const artist = readFileSync(`${process.cwd()}/src/Artists.tsx`, 'utf8');
    expect(artist.match(/<ListPlayButton/g)?.length).toBe(2);
    const css = readFileSync(`${process.cwd()}/src/play-state.css`, 'utf8');
    expect(css).toMatch(/\.listplay:not\(\[data-ready='true'\]\)\s*\{[^}]*background:\s*#fff[^}]*color:\s*var\(--ink\)/);
    // The artist's Play and its most played Play wear the same black outline (PLAY-RING-BLACK-001).
    expect(css).not.toMatch(/inset 0 0 0 1px var\(--hair\)/);
  });
});

describe('double-tapping a search song puts it next in Now playing (SEARCH-DBL-NEXT-001)', () => {
  it('queues the song right after the playing one instead of playing it', async () => {
    const onQueueNext = vi.fn(), onPreview = vi.fn();
    await render(<TrackList tracks={[t('x')]} seedKeys={new Set()} onAdd={vi.fn()} onPreview={onPreview} onQueueNext={onQueueNext} label="Results" />);
    await act(async () => { host.querySelector('.track .track__text')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    expect(onQueueNext).toHaveBeenCalledWith(expect.objectContaining({ key: 'x' })); expect(onPreview).not.toHaveBeenCalled();
  });
  it('other lists keep double-click to play', async () => {
    const onPreview = vi.fn();
    await render(<TrackList tracks={[t('x')]} seedKeys={new Set()} onAdd={vi.fn()} onPreview={onPreview} label="Album" />);
    await act(async () => { host.querySelector('.track .track__text')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    expect(onPreview).toHaveBeenCalled();
  });
  it('the app inserts it after the playing song and leaves the playing song where it is', () => {
    const app = readFileSync(`${process.cwd()}/src/App.tsx`, 'utf8').replace(/\r/g, '');
    expect(app).toMatch(/const queueNext = \(t: Track\) => \{[\s\S]*?insertAfter\(prev\.items, row, after\)/);
    expect(app).toMatch(/onQueueNext=\{queueNext\}/);
    expect(readFileSync(`${process.cwd()}/src/Search.tsx`, 'utf8')).toMatch(/const common = \{[^}]*onQueueNext/);
  });
});
