// @vitest-environment happy-dom
// ROW-DL-STATE-001 (owner, 2026-11-22): "If a song is already downloaded remove the download icon, while a song is
// downloading give it the same outline progress bar animation the play button has wile it downloads".
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TrackList } from './Search';
import { SavedView } from './SavedView';
import { Results } from './Results';
import { RowDownloadButton } from './RowPlay';
import { CardCacheContext } from './card-cache-context';
import type { CardCache } from './engine/queue-controls';
import type { RecItem, Track } from './api';

const t = (key: string, extra: Record<string, unknown> = {}) => ({ key, title: `Song ${key}`, artists: ['A'], provider: 'deezer', platform_id: key, ...extra } as unknown as Track);
const item = (key: string) => ({ track: t(key), rank: 1, reasons: [], playback: { preview: null, embed: null, open: [] }, characteristics: {}, tier: 'related', evidence: 'thin' } as unknown as RecItem);
const card = (state: CardCache['state'], progress = 0, indeterminate = false) => ({ state, glyph: '', text: '', keptText: null, kept: false, progress, indeterminate } as CardCache);
const cards: Record<string, CardCache> = { ready: card('ready', 100), half: card('downloading', 46), wait: card('downloading', 0, true) };
const cacheOf = (key: string) => cards[key] ?? null;
const dl = (key: string) => screen.queryByRole('button', { name: `Download Song ${key}` });
afterEach(() => cleanup());

describe('one song\u2019s Download icon', () => {
  it('is gone once the song is downloaded, and for a local file', () => {
    render(<><RowDownloadButton track={t('ready')} cache={cards['ready']} onDownload={() => {}} /><RowDownloadButton track={t('loc', { provider: 'imported' })} cache={null} onDownload={() => {}} /></>);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
  it('wears a ring at the real percent while the song downloads', () => {
    render(<RowDownloadButton track={t('half')} cache={cards['half']} onDownload={() => {}} />);
    const b = dl('half')!;
    expect(b.dataset['progress']).toBe('true');
    expect(b.style.getPropertyValue('--dl')).toBe('46');
    expect(b.dataset['moving']).toBeUndefined();
    expect(b.title).toBe('Downloading, 46%');
    expect(b.getAttribute('aria-busy')).toBe('true');
  });
  it('breathes while a download has started and reports no percent yet', () => {
    render(<RowDownloadButton track={t('wait')} cache={cards['wait']} onDownload={() => {}} />);
    expect(dl('wait')!.dataset['moving']).toBe('true');
    expect(dl('wait')!.style.getPropertyValue('--dl')).toBe('0');
  });
  it('is the plain icon before anything is asked, and asks for the song when pressed', () => {
    const onDownload = vi.fn();
    render(<RowDownloadButton track={t('new')} cache={null} onDownload={onDownload} />);
    const b = dl('new')!;
    expect(b.dataset['progress']).toBeUndefined();
    expect(b.title).toBe('Download');
    fireEvent.click(b);
    expect(onDownload).toHaveBeenCalledWith(expect.objectContaining({ key: 'new' }));
  });
});

describe('every song list uses it', () => {
  it('search, album and artist rows', () => {
    render(<CardCacheContext.Provider value={cacheOf}><TrackList tracks={[t('ready'), t('half'), t('new')]} seedKeys={new Set()} onAdd={vi.fn()} onPreview={vi.fn()} onDownload={vi.fn()} label="Songs" /></CardCacheContext.Provider>);
    expect(dl('ready')).toBeNull();
    expect(dl('half')!.dataset['progress']).toBe('true');
    expect(dl('new')!.dataset['progress']).toBeUndefined();
  });
  it('the queue', () => {
    render(<Results seeds={[]} onRemoveSeed={() => {}} onEmphasis={() => {}} items={[item('ready'), item('half')]} focusKey={null} playingKey={null} flags={{}} onFocus={() => {}} onPlay={() => {}} onPlayTrack={() => {}} onFeedback={() => {}} onDownload={() => {}} cacheOf={cacheOf} />);
    expect(dl('ready')).toBeNull();
    expect(dl('half')!.style.getPropertyValue('--dl')).toBe('46');
  });
  it('the Saved tab', () => {
    render(<SavedView saved={[{ track: t('ready'), ts: 1 }, { track: t('half'), ts: 2 }] as never} lists={[]} onLists={() => {}} onPreview={() => {}} onRemoveSaved={() => {}} onDownload={() => {}} cacheOf={cacheOf} />);
    expect(dl('ready')).toBeNull();
    expect(dl('half')!.dataset['progress']).toBe('true');
  });
  it('draws the ring with the Play button\u2019s own rule', () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'play-state.css'), 'utf8').replace(/\r\n/g, '\n');
    expect(css).toMatch(/\.iconbtn\.playbtn\[data-progress='true'\]::before,\n\.iconbtn\.rowdl\[data-progress='true'\]::before,/);
    expect(css).toMatch(/\.iconbtn\.rowdl\.rowdl\[data-moving='true'\],\nbutton\.listplay\.listplay\[data-moving='true'\] \{\n  animation: dl-wait/);
  });
});
