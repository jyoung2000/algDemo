// @vitest-environment happy-dom
/**
 * PLAYER-SIMILAR-001 / DISLIKE-X-001 (owner, 2026-11-19): "on the player controls add the find similar
 * songs button inline with the other buttons, also make the dislike button an X instead of thumbs down".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { GLYPH_PATHS } from '@now-playing/aqua-ui/icons';
import { PlayerActions } from './PlayerActions';
import { Results } from './Results';
import type { RecItem, Track } from './api';

const here = dirname(fileURLToPath(import.meta.url));
const t = { key: 'k1', title: 'Song one', artists: ['A'], provider: 'deezer', platform_id: '1', duration: 180 } as Track;
const item = { track: t, rank: 1, reasons: [], playback: { kind: 'none' }, characteristics: {} } as unknown as RecItem;
const paths = (el: Element) => [...el.querySelectorAll('svg path')].map((p) => p.getAttribute('d'));
const actions = (over: Partial<Parameters<typeof PlayerActions>[0]> = {}) => (
  <PlayerActions flags={{}} downloadState="idle" downloadAvailable onFeedback={vi.fn()} onDownload={async () => true} onDownloads={() => {}} songKey={t.key} {...over} />
);
afterEach(cleanup);

describe('the player controls', () => {
  it('have Find similar songs inline with Star, Dislike and Download, in the same group and order as a song row', () => {
    render(actions({ onSimilar: vi.fn() }));
    const group = screen.getByRole('group', { name: 'This song' });
    const labels = [...group.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? '');
    expect(labels.map((l) => l.split(' ')[0])).toEqual(['Like', 'Dislike', 'Download', 'Find']);
    expect(labels[3]).toBe('Find similar songs to this one');
    expect(group.querySelectorAll('button')[3]!.className).toContain('quiet-control');
  });

  it('runs Find similar for the song playing, and shows it is busy while it searches', () => {
    const onSimilar = vi.fn();
    const { rerender } = render(actions({ onSimilar }));
    fireEvent.click(screen.getByRole('button', { name: 'Find similar songs to this one' }));
    expect(onSimilar).toHaveBeenCalledTimes(1);
    rerender(actions({ onSimilar, similarBusy: true }));
    const busy = screen.getByRole('button', { name: /^Finding similar songs/ });
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect((busy as HTMLButtonElement).disabled).toBe(true);
  });

  it('leave Find similar out when there is nothing to compare (no handler, e.g. the radio)', () => {
    render(actions());
    expect(screen.queryByRole('button', { name: /similar/i })).toBeNull();
  });

  it('draw Dislike as an X, never a thumbs down', () => {
    render(actions({ onSimilar: vi.fn() }));
    const d = screen.getByRole('button', { name: 'Dislike this song' });
    expect(paths(d)).toContain(GLYPH_PATHS.close);
    expect(paths(d)).not.toContain(GLYPH_PATHS['thumb-down']);
  });
});

describe('the song rows', () => {
  it('draw Dislike as the same X (it also removes the song from the queue)', () => {
    render(<Results seeds={[]} onRemoveSeed={() => {}} onEmphasis={() => {}} items={[item]} focusKey={null} playingKey={null} flags={{}} onFocus={() => {}} onPlay={() => {}} onPlayTrack={() => {}} onFeedback={vi.fn()} lists={[]} onLists={() => {}} />);
    const d = screen.getByRole('button', { name: /^Dislike Song one/ });
    expect(paths(d)).toContain(GLYPH_PATHS.close);
    expect(paths(d)).not.toContain(GLYPH_PATHS['thumb-down']);
  });
});

describe('Android Auto', () => {
  it('draws the car Dislike as an X too (custom icons; Media3 only offers thumbs)', () => {
    const svc = readFileSync(join(here, '../../android/app/src/main/java/com/nowplaying/discovery/PlaybackService.kt'), 'utf8');
    expect(svc).not.toMatch(/ICON_THUMB_DOWN/);
    expect(svc).toMatch(/R\.drawable\.car_dislike_on/);
    expect(svc).toMatch(/R\.drawable\.car_dislike\b/);
  });
});
