// @vitest-environment happy-dom
/**
 * Owner request (2026-11-15): "the android app should also have a swipe left or right gesture to
 * remove a song from the songlist". A horizontal touch swipe on a queue row does what the row's
 * Hide (X) button does; on a starting-song row it removes the starting song. Short drags, vertical
 * drags and mouse drags remove nothing, and a swipe never also plays the row.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Results } from './Results';
import type { RecItem, Track } from './api';

const t = (key: string) => ({ key, title: `Song ${key}`, artists: ['A'], provider: 'deezer', platform_id: key, preview: `/p/${key}` } as unknown as Track);
const item = (key: string) => ({ track: t(key), rank: 1, reasons: [], playback: { preview: `/p/${key}`, embed: null, open: [] }, characteristics: {}, tier: 'related', evidence: 'thin' } as unknown as RecItem);
afterEach(() => { cleanup(); vi.useRealTimers(); });

function view(over: Partial<Parameters<typeof Results>[0]> = {}) {
  const fns = { onFeedback: vi.fn(), onRemoveSeed: vi.fn(), onPlay: vi.fn(), onPlayTrack: vi.fn() };
  render(<Results seeds={[t('seed')]} onEmphasis={() => {}} items={[item('a'), item('b')]} focusKey={null} playingKey={null} flags={{}} onFocus={() => {}} {...fns} {...over} />);
  return fns;
}
const row = (title: string) => screen.getByText(title).closest('li')!;
async function swipe(el: Element, dx: number, dy = 0, pointerType = 'touch') {
  fireEvent.pointerDown(el, { pointerId: 1, pointerType, clientX: 200, clientY: 100, isPrimary: true, button: 0 });
  for (let s = 1; s <= 5; s++) fireEvent.pointerMove(el, { pointerId: 1, pointerType, clientX: 200 + (dx * s) / 5, clientY: 100 + (dy * s) / 5 });
  fireEvent.pointerUp(el, { pointerId: 1, pointerType, clientX: 200 + dx, clientY: 100 + dy });
  await act(async () => { await new Promise((r) => setTimeout(r, 260)); });
}

describe('swipe to remove from the now playing queue', () => {
  for (const dx of [-180, 180]) {
    it(`a ${dx < 0 ? 'left' : 'right'} swipe on a queue row hides that song, exactly like its X button`, async () => {
      const f = view();
      await swipe(row('Song a'), dx);
      expect(f.onFeedback).toHaveBeenCalledTimes(1);
      expect(f.onFeedback).toHaveBeenCalledWith(expect.objectContaining({ track: expect.objectContaining({ key: 'a' }) }), 'hide');
      expect(f.onPlay).not.toHaveBeenCalled();
    });
  }
  it('removes a starting song that is also a queue result, instead of letting it reappear', async () => {
    const f = view({ items: [item('seed'), item('b')] });
    await swipe(row('Song seed'), -180);
    expect(f.onFeedback).toHaveBeenCalledWith(expect.objectContaining({ track: expect.objectContaining({ key: 'seed' }) }), 'hide');
    expect(f.onRemoveSeed).toHaveBeenCalledWith('seed');
    expect(f.onPlay).not.toHaveBeenCalled();
  });
  it('a swipe on a starting-song row removes the starting song', async () => {
    const f = view();
    await swipe(row('Song seed'), -180);
    expect(f.onRemoveSeed).toHaveBeenCalledWith('seed');
  });
  it('a short drag snaps back and removes nothing', async () => {
    const f = view();
    await swipe(row('Song b'), 30);
    expect(f.onFeedback).not.toHaveBeenCalled();
  });
  it('a mostly vertical drag is a scroll, not a removal', async () => {
    const f = view();
    await swipe(row('Song b'), 120, 240);
    expect(f.onFeedback).not.toHaveBeenCalled();
  });
  it('a mouse drag does not remove (desktop keeps the X button)', async () => {
    const f = view();
    await swipe(row('Song b'), 200, 0, 'mouse');
    expect(f.onFeedback).not.toHaveBeenCalled();
  });
  it('a click that follows a swipe does not also play the row', async () => {
    const f = view();
    const el = row('Song a');
    await swipe(el, -180);
    fireEvent.click(el.querySelector('.rec__art')!);
    expect(f.onPlay).not.toHaveBeenCalled();
  });
  it('lets the browser keep vertical scrolling on rows', () => {
    view();
    expect(row('Song a').getAttribute('data-swipe')).toBe('remove');
  });
});
