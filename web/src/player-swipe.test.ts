// @vitest-environment happy-dom
// PLAYER-SWIPE-001 (owner, 2026-11-19: "On the player on android we should be able to swipe left and right on
// song to skip or go back a song"). Swipe left = next song, swipe right = previous; touch only; judged where
// the finger lifts (SWIPE-FAST-001: a fast flick sends few moves).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
import { usePlayerSwipe, PLAYER_SWIPE_MIN_PX } from './usePlayerSwipe';

afterEach(cleanup);
function Strip(p: { onNext: () => void; onPrev: () => void; canNext?: boolean; canPrev?: boolean; enabled?: boolean }) {
  const swipe = usePlayerSwipe({ onNext: p.onNext, onPrev: p.onPrev, canNext: p.canNext ?? true, canPrev: p.canPrev ?? true, enabled: p.enabled ?? true });
  return createElement('div', { 'data-testid': 'strip', ...swipe }, createElement('button', { type: 'button' }, 'artist'));
}
const touch = (el: Element, type: 'pointerDown' | 'pointerMove' | 'pointerUp', x: number, y = 100, pointerType = 'touch') =>
  fireEvent[type](el, { pointerId: 1, pointerType, isPrimary: true, clientX: x, clientY: y });

describe('swiping the player', () => {
  it('a swipe to the left plays the next song; to the right goes back a song', () => {
    const onNext = vi.fn(); const onPrev = vi.fn();
    const { getByTestId } = render(createElement(Strip, { onNext, onPrev }));
    const el = getByTestId('strip');
    touch(el, 'pointerDown', 300); touch(el, 'pointerMove', 260); touch(el, 'pointerUp', 300 - PLAYER_SWIPE_MIN_PX - 10);
    expect(onNext).toHaveBeenCalledTimes(1); expect(onPrev).not.toHaveBeenCalled();
    touch(el, 'pointerDown', 100); touch(el, 'pointerMove', 140); touch(el, 'pointerUp', 100 + PLAYER_SWIPE_MIN_PX + 10);
    expect(onPrev).toHaveBeenCalledTimes(1);
  });
  it('a fast flick with a single move is judged where the finger lifted', () => {
    const onNext = vi.fn();
    const { getByTestId } = render(createElement(Strip, { onNext, onPrev: vi.fn() }));
    const el = getByTestId('strip');
    touch(el, 'pointerDown', 300); touch(el, 'pointerMove', 290); touch(el, 'pointerUp', 120);
    expect(onNext).toHaveBeenCalledTimes(1);
  });
  it('a short drag, a vertical scroll or a mouse drag does nothing', () => {
    const onNext = vi.fn(); const onPrev = vi.fn();
    const { getByTestId } = render(createElement(Strip, { onNext, onPrev }));
    const el = getByTestId('strip');
    touch(el, 'pointerDown', 300); touch(el, 'pointerMove', 280); touch(el, 'pointerUp', 270);
    touch(el, 'pointerDown', 300, 100); touch(el, 'pointerMove', 290, 160); touch(el, 'pointerUp', 200, 300);
    touch(el, 'pointerDown', 300, 100, 'mouse'); touch(el, 'pointerMove', 200, 100, 'mouse'); touch(el, 'pointerUp', 100, 100, 'mouse');
    expect(onNext).not.toHaveBeenCalled(); expect(onPrev).not.toHaveBeenCalled();
  });
  it('does nothing where there is no next or previous song, and only where it is turned on', () => {
    const onNext = vi.fn(); const onPrev = vi.fn();
    const { getByTestId, rerender } = render(createElement(Strip, { onNext, onPrev, canNext: false, canPrev: false }));
    let el = getByTestId('strip');
    touch(el, 'pointerDown', 300); touch(el, 'pointerMove', 260); touch(el, 'pointerUp', 100);
    touch(el, 'pointerDown', 100); touch(el, 'pointerMove', 140); touch(el, 'pointerUp', 300);
    rerender(createElement(Strip, { onNext, onPrev, enabled: false }));
    el = getByTestId('strip');
    touch(el, 'pointerDown', 300); touch(el, 'pointerMove', 260); touch(el, 'pointerUp', 100);
    expect(onNext).not.toHaveBeenCalled(); expect(onPrev).not.toHaveBeenCalled();
  });
  it('the tap that ends a swipe does not also press what is under the finger', () => {
    const onClick = vi.fn();
    const { getByTestId, getByText } = render(createElement(Strip, { onNext: vi.fn(), onPrev: vi.fn() }));
    const el = getByTestId('strip');
    getByText('artist').addEventListener('click', onClick);
    touch(el, 'pointerDown', 300); touch(el, 'pointerMove', 250); touch(el, 'pointerUp', 100);
    fireEvent.click(getByText('artist'));
    expect(onClick).not.toHaveBeenCalled();
  });
  it('lets the page scroll up and down over the player', () => {
    const { getByTestId } = render(createElement(Strip, { onNext: vi.fn(), onPrev: vi.fn() }));
    expect((getByTestId('strip') as HTMLElement).style.touchAction).toBe('pan-y');
  });
});
