// @vitest-environment happy-dom
/**
 * UI-MOOD-001 (owner, 2026-11-19): one song row across Discover, Saved and Radio; "Find similar
 * sound" is an icon; no Why button; one Dislike button that also removes the song from the queue;
 * a volume icon whose tap opens a slider and double tap mutes; overflowing titles scroll (marquee).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Results } from './Results';
import { Volume } from './Volume';
import { marqueeShift } from './Marquee';
import type { RecItem, Track } from './api';

afterEach(cleanup);
const here = dirname(fileURLToPath(import.meta.url));
const track = (key: string, title: string) => ({ key, title, artists: ['Artist'], provider: 'deezer', platform_id: key, tags: [] } as unknown as Track);
const item = (key: string, title: string) => ({ track: track(key, title), rank: 1, reasons: [{ factor: 'x', text: 'Because.' }], uncertainty: [], sources: [], evidence: 'strong', tier: 'strong', playback: { preview: 'https://p/x.mp3', embed: null, open: [] }, characteristics: { genres: [] } } as unknown as RecItem);

function list(onFeedback = vi.fn(), onSimilar = vi.fn()) {
  render(<Results seeds={[]} onRemoveSeed={() => undefined} onEmphasis={() => undefined} items={[item('a', 'Alpha'), item('b', 'Beta')]}
    focusKey={null} playingKey={null} flags={{}} onFocus={() => undefined} onPlay={() => undefined} onPlayTrack={() => undefined}
    onFeedback={onFeedback} onSimilar={onSimilar} similarBusy={false} cacheOf={() => null} lists={[]} />);
  return { onFeedback, onSimilar };
}

describe('the now playing queue row', () => {
  it('has no Why button and no separate Hide button', () => {
    list();
    expect(screen.queryByRole('button', { name: /^Why / })).toBeNull();
    expect(screen.queryByText('Why this song?')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Hide / })).toBeNull();
  });

  it('shows Find similar sound as an icon in the row of buttons, not as words', () => {
    const { onSimilar } = list();
    const b = screen.getByRole('button', { name: 'Find similar sound to Alpha' });
    expect(b.textContent?.trim()).toBe('');
    expect(b.querySelector('svg')).toBeTruthy();
    expect(b.closest('.rec__actions')).toBeTruthy();
    fireEvent.click(b);
    expect(onSimilar).toHaveBeenCalledWith(expect.objectContaining({ key: 'a' }));
  });

  it('one Dislike button teaches the algorithm and removes the song from the queue', () => {
    const { onFeedback } = list();
    const row = screen.getByText('Alpha').closest('li')!;
    const b = within(row).getByRole('button', { name: 'Dislike Alpha and remove it from the queue' });
    fireEvent.click(b);
    expect(onFeedback).toHaveBeenCalledWith(expect.objectContaining({ track: expect.objectContaining({ key: 'a' }) }), 'dislike');
  });

  it('puts Play, Star, Dislike, Download and Find similar in one row, in that order', () => {
    render(<Results seeds={[]} onRemoveSeed={() => undefined} onEmphasis={() => undefined} items={[item('a', 'Alpha')]}
      focusKey={null} playingKey={null} flags={{}} onFocus={() => undefined} onPlay={() => undefined} onPlayTrack={() => undefined}
      onFeedback={vi.fn()} onSimilar={vi.fn()} similarBusy={false} cacheOf={() => null} lists={[]} onDownload={() => undefined} />);
    const names = [...document.querySelectorAll('.rec__actions button')].map((b) => b.getAttribute('aria-label')!.split(' ')[0]);
    expect(names).toEqual(['Play', 'Like', 'Dislike', 'Download', 'Find']);
  });
});

describe('volume', () => {
  it('is one icon: a tap opens a slider, a double tap mutes', () => {
    vi.useFakeTimers();
    const onToggleMute = vi.fn();
    render(<Volume value={0.6} muted={false} onChange={() => undefined} onToggleMute={onToggleMute} />);
    expect(screen.queryByRole('slider', { name: 'Volume' })).toBeNull();
    const b = screen.getByRole('button', { name: /Volume 60%/ });
    fireEvent.click(b);
    act(() => { vi.advanceTimersByTime(400); });
    expect(screen.getByRole('slider', { name: 'Volume' })).toBeTruthy();
    expect(onToggleMute).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('slider', { name: 'Volume' })).toBeNull();
    fireEvent.click(b);
    fireEvent.click(b);
    act(() => { vi.advanceTimersByTime(400); });
    expect(onToggleMute).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('slider', { name: 'Volume' })).toBeNull();
    vi.useRealTimers();
  });
});

describe('marquee', () => {
  it('scrolls only text that is cut off, by exactly the hidden part', () => {
    expect(marqueeShift(200, 200)).toBe(0);
    expect(marqueeShift(201, 200)).toBe(0);
    expect(marqueeShift(260, 200)).toBe(60);
  });
});

describe('one row style across Discover, Saved and Radio', () => {
  const css = readFileSync(join(here, 'song-row.css'), 'utf8');
  it('Saved and Radio rows use the same play disc and cover size as the queue', () => {
    const saved = readFileSync(join(here, 'SavedView.tsx'), 'utf8');
    const radio = readFileSync(join(here, 'Radio.tsx'), 'utf8');
    expect(saved).toMatch(/<RowPlayButton/);
    expect(radio).toMatch(/<PlayDisc/);
    expect(saved).toMatch(/size=\{ROW_COVER\}/);
    expect(css).toMatch(/--row-cover:\s*64px/);
  });
  it('the preload target control hugs its two segments', () => {
    expect(css).toMatch(/\[aria-labelledby='preload-target-label'\][^}]*width:\s*fit-content/);
  });
});
