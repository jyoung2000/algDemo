// @vitest-environment happy-dom
/**
 * ROW-PLAY-001 (owner 2026-11-17): "allow a song ... to be played by double clicking the song listing
 * instead of the play button, also ensure the local songs have their play button filled, ensure songs
 * that are ready to be played have a light blue filled play button". SEARCH-CLEAN-001: "remove the
 * labels below" the search field (they stay for screen readers), and space the artist listings apart.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Results } from './Results';
import { TrackList } from './Search';
import { SavedView } from './SavedView';
import { RowPlayButton, isLocalTrack } from './RowPlay';
import { CardCacheContext } from './card-cache-context';
import type { RecItem, Track } from './api';

const t = (key: string, extra: Record<string, unknown> = {}) => ({ key, title: `Song ${key}`, artists: ['A'], provider: 'deezer', platform_id: key, preview: `/p/${key}`, ...extra } as unknown as Track);
const item = (key: string) => ({ track: t(key), rank: 1, reasons: [], playback: { preview: `/p/${key}`, embed: null, open: [] }, characteristics: {}, tier: 'related', evidence: 'thin' } as unknown as RecItem);
const row = (title: string) => screen.getByText(title).closest('li')!;
afterEach(() => cleanup());

describe('double-click a song listing to play it (ROW-PLAY-001)', () => {
  it('plays a queue row on double-click, not on a single click', () => {
    const onPlay = vi.fn();
    render(<Results seeds={[]} onRemoveSeed={() => {}} onEmphasis={() => {}} items={[item('a')]} focusKey={null} playingKey={null} flags={{}} onFocus={() => {}} onPlay={onPlay} onPlayTrack={() => {}} onFeedback={() => {}} />);
    fireEvent.click(row('Song a'));
    expect(onPlay).not.toHaveBeenCalled();
    fireEvent.doubleClick(row('Song a'));
    expect(onPlay).toHaveBeenCalledTimes(1);
  });
  it('plays a search row on double-click', () => {
    const onPreview = vi.fn();
    render(<TrackList tracks={[t('x')]} seedKeys={new Set()} onAdd={vi.fn()} onPreview={onPreview} label="Songs" />);
    fireEvent.doubleClick(row('Song x'));
    expect(onPreview).toHaveBeenCalledTimes(1);
  });
  it('plays a saved row on double-click', () => {
    const onPreview = vi.fn();
    render(<SavedView saved={[{ track: t('s'), ts: 1 }] as never} lists={[]} onLists={() => {}} onPreview={onPreview} onRemoveSaved={() => {}} />);
    fireEvent.doubleClick(row('Song s'));
    expect(onPreview).toHaveBeenCalledTimes(1);
  });
  it('ignores a double-click that lands on one of the row\'s own buttons', () => {
    const onPreview = vi.fn();
    render(<TrackList tracks={[t('x')]} seedKeys={new Set()} onAdd={vi.fn()} onPreview={onPreview} onDownload={vi.fn()} label="Songs" />);
    fireEvent.doubleClick(screen.getByRole('button', { name: 'Download Song x' }));
    expect(onPreview).not.toHaveBeenCalled();
  });
});

describe('the play button shows a song is ready (ROW-PLAY-001)', () => {
  it('a local (imported) song is ready and filled', () => {
    expect(isLocalTrack(t('l', { provider: 'imported', url: 'imported:C:/m/a.opus' }))).toBe(true);
    render(<RowPlayButton track={t('l', { provider: 'imported', url: 'imported:C:/m/a.opus' })} cache={null} onPlay={() => {}} />);
    const b = screen.getByRole('button', { name: 'Play Song l' });
    expect(b.dataset['ready']).toBe('true');
    expect(b.dataset['local']).toBe('true');
    expect(b.title).toMatch(/local file/i);
  });
  it('a song whose full file is downloaded is ready; an unready one is not', () => {
    render(<><RowPlayButton track={t('r')} cache={{ state: 'ready' } as never} onPlay={() => {}} /><RowPlayButton track={t('n')} cache={null} onPlay={() => {}} /></>);
    expect(screen.getByRole('button', { name: 'Play Song r' }).dataset['ready']).toBe('true');
    expect(screen.getByRole('button', { name: 'Play Song n' }).dataset['ready']).toBeUndefined();
  });
  it('search rows learn readiness from the app\'s download cache', () => {
    const cacheOf = (k: string) => (k === 'x' ? ({ state: 'ready' } as never) : null);
    render(<CardCacheContext.Provider value={cacheOf}><TrackList tracks={[t('x'), t('y')]} seedKeys={new Set()} onAdd={vi.fn()} onPreview={vi.fn()} label="Songs" /></CardCacheContext.Provider>);
    expect(screen.getByRole('button', { name: 'Play Song x' }).dataset['ready']).toBe('true');
    expect(screen.getByRole('button', { name: 'Play Song y' }).dataset['ready']).toBeUndefined();
  });
  it('saved rows mark a local song ready', () => {
    render(<SavedView saved={[{ track: t('l', { provider: 'imported', url: 'imported:C:/m/a.opus' }), ts: 1 }] as never} lists={[]} onLists={() => {}} onPreview={() => {}} onRemoveSaved={() => {}} />);
    expect(screen.getByRole('button', { name: 'Play Song l' }).dataset['ready']).toBe('true');
  });
  // PLAY-LIVE-001 (owner, 2026-11-21): "the play button when blue should have a white arrow" — a solid blue disc
  // with a white triangle replaces ROW-PLAY-001's light blue fill (a white arrow does not read on #bcd8ff).
  it('the ready look is a solid blue disc with a white arrow on every list, not only the queue', () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'row-play.css'), 'utf8');
    expect(css).toMatch(/\.iconbtn\.playbtn\[data-ready='true'\]\s*\{[^}]*background:\s*var\(--accent\)[^}]*color:\s*#fff/i);
    // Measured on Android: the queue's own older, more specific rule kept the faint #e6effb tint.
    const styles = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'styles.css'), 'utf8').replace(/\r\n/g, '\n');
    const queueRule = styles.match(/\.rec__actions \.iconbtn\.playbtn\[data-ready='true'\] \{[^}]*\}/)?.[0] ?? '';
    expect(queueRule).toMatch(/background:\s*var\(--accent\)[^}]*color:\s*#fff/i);
  });
});
