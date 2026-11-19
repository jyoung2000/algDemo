// @vitest-environment happy-dom
// PLAYER-ONE-SOURCE-001 (owner, 2026-11-19: "on the player only show 1 platform label at a time instead of
// putting all 3 at once, the platform label can cycle through the different platform the song is on").
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { OpenLinkCycle, OPEN_LINK_CYCLE_MS } from './OpenLinkCycle';

const links = [
  { provider: 'apple', label: 'Open in Apple Music', url: 'https://music.apple.com/x' },
  { provider: 'deezer', label: 'Open in Deezer', url: 'https://deezer.com/track/1' },
  { provider: 'spotify', label: 'Open in Spotify', url: 'https://open.spotify.com/track/1' },
];
const shown = (c: HTMLElement) => [...c.querySelectorAll('a')].map((a) => a.getAttribute('aria-label'));

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('OpenLinkCycle', () => {
  it('shows one platform at a time and cycles through all of them', () => {
    const { container } = render(<OpenLinkCycle links={links} />);
    expect(shown(container)).toEqual(['Open in Apple Music']);
    act(() => { vi.advanceTimersByTime(OPEN_LINK_CYCLE_MS); });
    expect(shown(container)).toEqual(['Open in Deezer']);
    act(() => { vi.advanceTimersByTime(OPEN_LINK_CYCLE_MS); });
    expect(shown(container)).toEqual(['Open in Spotify']);
    act(() => { vi.advanceTimersByTime(OPEN_LINK_CYCLE_MS); });
    expect(shown(container)).toEqual(['Open in Apple Music']);
  });
  it('the shown label is the whole platform name with its mark, opening that platform', () => {
    const { container } = render(<OpenLinkCycle links={links} />);
    const a = container.querySelector('a')!;
    expect(a.textContent).toContain('Apple Music');
    expect(a.getAttribute('href')).toBe('https://music.apple.com/x');
    expect(a.querySelector('svg, img')).not.toBeNull();
  });
  it('holds still while the pointer or keyboard is on it, so it can be pressed', () => {
    const { container } = render(<OpenLinkCycle links={links} />);
    const box = container.firstElementChild as HTMLElement;
    fireEvent.mouseEnter(box);
    act(() => { vi.advanceTimersByTime(OPEN_LINK_CYCLE_MS * 3); });
    expect(shown(container)).toEqual(['Open in Apple Music']);
    fireEvent.mouseLeave(box);
    act(() => { vi.advanceTimersByTime(OPEN_LINK_CYCLE_MS); });
    expect(shown(container)).toEqual(['Open in Deezer']);
    fireEvent.focus(container.querySelector('a')!);
    act(() => { vi.advanceTimersByTime(OPEN_LINK_CYCLE_MS * 2); });
    expect(shown(container)).toEqual(['Open in Deezer']);
  });
  it('a single platform just stays', () => {
    const { container } = render(<OpenLinkCycle links={links.slice(2)} />);
    act(() => { vi.advanceTimersByTime(OPEN_LINK_CYCLE_MS * 4); });
    expect(shown(container)).toEqual(['Open in Spotify']);
  });
  it('a new song starts again at its first platform', () => {
    const { container, rerender } = render(<OpenLinkCycle links={links} />);
    act(() => { vi.advanceTimersByTime(OPEN_LINK_CYCLE_MS); });
    rerender(<OpenLinkCycle links={[links[2]!, links[0]!]} />);
    expect(shown(container)).toEqual(['Open in Spotify']);
  });
  it('names every platform the song is on for screen readers and on hover', () => {
    const { container } = render(<OpenLinkCycle links={links} />);
    expect((container.firstElementChild as HTMLElement).getAttribute('title')).toBe('Also on Apple Music, Deezer and Spotify');
  });
});
