// @vitest-environment happy-dom
/**
 * SWIPE-DIR-001 (owner 2026-11-17): "swipe left on a song to add it to a saved list or swipe right
 * on a song to remove the song from the queue". Left opens the save-to-list menu and keeps the row;
 * right removes from the queue. Earlier request (2026-11-15): "the android app should also have a swipe left or right gesture to
 * remove a song from the songlist". A horizontal touch swipe on a queue row does what the row's
 * Hide (X) button does; on a starting-song row it removes the starting song. Short drags, vertical
 * drags and mouse drags remove nothing, and a swipe never also plays the row.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Results } from './Results';
import { TrackList } from './Search';
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

const lists = [{ id: 'l1', name: 'Gym', count: 0, items: [] }] as never;

describe('swipe right removes from the now playing queue', () => {
  it('a right swipe on a queue row hides that song, exactly like its X button', async () => {
    const f = view();
    await swipe(row('Song a'), 180);
    expect(f.onFeedback).toHaveBeenCalledTimes(1);
    expect(f.onFeedback).toHaveBeenCalledWith(expect.objectContaining({ track: expect.objectContaining({ key: 'a' }) }), 'hide');
    expect(f.onPlay).not.toHaveBeenCalled();
  });
  it('removes a starting song that is also a queue result, instead of letting it reappear', async () => {
    const f = view({ items: [item('seed'), item('b')] });
    await swipe(row('Song seed'), 180);
    expect(f.onFeedback).toHaveBeenCalledWith(expect.objectContaining({ track: expect.objectContaining({ key: 'seed' }) }), 'hide');
    expect(f.onRemoveSeed).toHaveBeenCalledWith('seed');
  });
  it('a right swipe on a starting-song row removes the starting song', async () => {
    const f = view();
    await swipe(row('Song seed'), 180);
    expect(f.onRemoveSeed).toHaveBeenCalledWith('seed');
  });
  it('a short drag snaps back and does nothing', async () => {
    const f = view({ lists, onLists: vi.fn() });
    await swipe(row('Song b'), 30);
    await swipe(row('Song b'), -30);
    expect(f.onFeedback).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('a mostly vertical drag is a scroll, not a gesture', async () => {
    const f = view({ lists, onLists: vi.fn() });
    await swipe(row('Song b'), 120, 240);
    await swipe(row('Song b'), -120, 240);
    expect(f.onFeedback).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('a mouse drag does nothing (desktop keeps the buttons)', async () => {
    const f = view({ lists, onLists: vi.fn() });
    await swipe(row('Song b'), 200, 0, 'mouse');
    await swipe(row('Song b'), -200, 0, 'mouse');
    expect(f.onFeedback).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('a click that follows a swipe does not also play the row', async () => {
    const f = view({ lists, onLists: vi.fn() });
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

describe('swipe left adds the song to a saved list', () => {
  it('a left swipe on a queue row opens its save-to-list menu and keeps the song in the queue', async () => {
    const f = view({ lists, onLists: vi.fn() });
    await swipe(row('Song a'), -180);
    expect(f.onFeedback).not.toHaveBeenCalled();
    expect(f.onRemoveSeed).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog').textContent).toMatch(/Save\s*Song a\s*to/);
    expect(screen.getByTitle('Song a')).toBeTruthy(); // the queue row is still there
  });
  it('a left swipe on a starting-song row opens the save menu, not a removal', async () => {
    const f = view({ lists, onLists: vi.fn() });
    await swipe(row('Song seed'), -180);
    expect(f.onRemoveSeed).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog').textContent).toMatch(/Save\s*Song seed\s*to/);
  });
  it('a left swipe on a search, artist or saved song row opens the save menu', async () => {
    render(<TrackList tracks={[t('x')]} seedKeys={new Set()} onAdd={vi.fn()} onPreview={vi.fn()} lists={lists} onLists={vi.fn()} label="Songs" />);
    await swipe(screen.getByText('Song x').closest('li')!, -180);
    expect(screen.getByRole('dialog').textContent).toMatch(/Save\s*Song x\s*to/);
  });
  it('a right swipe on a search row removes nothing (it is not the queue)', async () => {
    const onAdd = vi.fn();
    render(<TrackList tracks={[t('x')]} seedKeys={new Set()} onAdd={onAdd} onPreview={vi.fn()} lists={lists} onLists={vi.fn()} label="Songs" />);
    await swipe(screen.getByText('Song x').closest('li')!, 180);
    expect(screen.getByText('Song x')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onAdd).not.toHaveBeenCalled();
  });
});

// SWIPE-FAST-001: measured on the Android emulator (adb input swipe, 250 ms): the WebView sent only a
// few pointermoves (-76 px) and the finger lifted at -229 px. The row judged the swipe by the last move,
// so a real fast swipe snapped back. The lift position is where the finger really ended.
describe('a fast swipe is judged where the finger lifts (SWIPE-FAST-001)', () => {
  it('a left flick whose moves stop short but lifts far opens the save menu', async () => {
    render(<TrackList tracks={[t('x')]} seedKeys={new Set()} onAdd={vi.fn()} onPreview={vi.fn()} lists={lists} onLists={vi.fn()} label="Songs" />);
    const el = row('Song x');
    fireEvent.pointerDown(el, { pointerId: 1, pointerType: 'touch', clientX: 343, clientY: 100, isPrimary: true, button: 0 });
    for (const x of [322, 299, 283, 267]) fireEvent.pointerMove(el, { pointerId: 1, pointerType: 'touch', clientX: x, clientY: 100 });
    fireEvent.pointerUp(el, { pointerId: 1, pointerType: 'touch', clientX: 114, clientY: 100 });
    await act(async () => { await new Promise((r) => setTimeout(r, 260)); });
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
  it('a right flick that only moved once still removes the queue row', async () => {
    const f = view();
    const el = row('Song a');
    fireEvent.pointerDown(el, { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 100, isPrimary: true, button: 0 });
    fireEvent.pointerMove(el, { pointerId: 1, pointerType: 'touch', clientX: 130, clientY: 101 });
    fireEvent.pointerUp(el, { pointerId: 1, pointerType: 'touch', clientX: 330, clientY: 102 });
    await act(async () => { await new Promise((r) => setTimeout(r, 260)); });
    expect(f.onFeedback).toHaveBeenCalledWith(expect.objectContaining({ track: expect.objectContaining({ key: 'a' }) }), 'hide');
  });
});
