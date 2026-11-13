// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { GLYPH_PATHS } from '@now-playing/aqua-ui/icons';
import { TrackList } from './Search';
import { Results } from './Results';
import { PlayerActions } from './PlayerActions';
import type { PlaylistSummary, RecItem, Track } from './api';

const t = { key: 'star-song', title: 'Star song', artists: ['Test artist'], provider: 'deezer', platform_id: '123', duration: 180 } as Track;
const item = { track: t, rank: 1, reasons: [], playback: { kind: 'none' }, characteristics: {} } as unknown as RecItem;
const list = (keys: string[], album = false): PlaylistSummary => ({ id: 'p1', name: 'Night drive', created: 1, count: keys.length, unplayed: keys.length, discovery_ready: false,
  items: keys.map(key => ({ key, track: t, played: false })), ...(album ? { album: { title: 'Record' } } : {}) } as PlaylistSummary);
const paths = (el: Element) => [...el.querySelectorAll('svg path')].map(p => p.getAttribute('d'));
afterEach(cleanup);

for (const surface of ['search', 'queue', 'player'] as const) {
  const view = (lists: PlaylistSummary[], liked = false, onFeedback = vi.fn()) => {
    if (surface === 'search') return <TrackList tracks={[t]} seedKeys={new Set(liked ? [t.key] : [])} onAdd={() => {}} onPreview={() => {}} label="Results" lists={lists} onLists={() => {}} onLike={onFeedback} />;
    if (surface === 'queue') return <Results seeds={[]} onRemoveSeed={() => {}} onEmphasis={() => {}} items={[item]} focusKey={null} playingKey={null} flags={{ [t.key]: { like: liked } }} onFocus={() => {}} onPlay={() => {}} onPlayTrack={() => {}} onFeedback={onFeedback} lists={lists} onLists={() => {}} />;
    return <PlayerActions flags={{ like: liked }} downloadState="idle" downloadAvailable={false} onFeedback={onFeedback} onDownload={async () => false} onDownloads={() => {}} songKey={t.key} lists={lists} />;
  };
  const button = () => screen.getAllByRole('button').find(b => /like/i.test(b.getAttribute('aria-label') ?? '') && !/dislike/i.test(b.getAttribute('aria-label') ?? ''))!;
  describe(`star and real playlist membership: ${surface}`, () => {
    it('uses a star, never thumbs-up; liked alone is not saved to a playlist', () => {
      render(view([], true));
      expect(paths(button())).toContain(GLYPH_PATHS.star);
      expect(paths(button())).not.toContain(GLYPH_PATHS['thumb-up']);
      expect(paths(button())).not.toContain(GLYPH_PATHS.check);
    });
    it('shows star AND check when saved, even if not currently liked', () => {
      render(view([list([t.key])], false));
      expect(paths(button())).toContain(GLYPH_PATHS.star);
      expect(paths(button())).toContain(GLYPH_PATHS.check);
      expect(button().getAttribute('aria-label')).toMatch(/saved to a playlist/i);
    });
    it('updates immediately when added and when removed from the last playlist', () => {
      const { rerender } = render(view([list([])]));
      expect(paths(button())).not.toContain(GLYPH_PATHS.check);
      rerender(view([list([t.key])]));
      expect(paths(button())).toContain(GLYPH_PATHS.check);
      rerender(view([list([])]));
      expect(paths(button())).not.toContain(GLYPH_PATHS.check);
    });
    it('does not show a check for another song or an album-only save', () => {
      render(view([list(['other-song']), list([t.key], true)]));
      expect(paths(button())).not.toContain(GLYPH_PATHS.check);
    });
    it('preserves the existing like action', () => {
      const feedback = vi.fn().mockResolvedValue(undefined);
      render(view([], false, feedback));
      fireEvent.click(button());
      expect(feedback).toHaveBeenCalled();
    });
  });
}
