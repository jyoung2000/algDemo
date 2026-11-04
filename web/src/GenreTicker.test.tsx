// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { GenreTicker } from './GenreTicker';
import type { LeafView } from './taste-view';

/**
 * TICKER-MARQUEE-001 — the "Your sound" header scrolls through the genres, most to least dominant.
 *
 * The owner asked for a marquee. The risk a marquee brings is that the duplicated run needed for a
 * seamless wrap gets read out twice, so these render it for real and check the accessible shape as
 * well as the order.
 */
const leaf = (label: string, pct: number, color = '#abc'): LeafView => ({ label, color, share: pct / 100, pct, family: 'Rap' });

// The order soundView() produces: strongest first.
const leaves = [leaf('Rap', 52), leaf('Rage', 28), leaf('Trap metal', 20)];

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const draw = (entries: LeafView[]) => {
  act(() => root.render(<GenreTicker entries={entries} />));
};

describe('the Your sound marquee (TICKER-MARQUEE-001)', () => {
  it('shows every genre, strongest first, in the order the taste view gave them', () => {
    draw(leaves);
    const items = [...host.querySelectorAll('[role="listitem"]')].map((li) => li.textContent);
    expect(items).toEqual(['Rap52%', 'Rage28%', 'Trap metal20%']);
  });

  it('exposes the run once even when it is duplicated for a seamless wrap', () => {
    // happy-dom reports every scrollWidth/clientWidth as 0, so the component's measurement would
    // never find an overflow and the decorative copy would not exist — a test that merely looped
    // over the copies here would pass without ever seeing one. Force the measurement to overflow.
    const sw = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollWidth');
    const cw = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth');
    Object.defineProperty(Element.prototype, 'scrollWidth', { configurable: true, get: () => 900 });
    Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get: () => 300 });
    try {
      draw(leaves);
      const copies = host.querySelectorAll('.genre-ticker__run');
      expect(copies.length).toBe(2); // the run, plus the copy that makes the wrap seamless
      expect(host.querySelector('.genre-ticker')!.className).toContain('is-scrolling');
      // One list only: the second copy is aria-hidden and carries no roles, so a screen reader
      // reads each genre once rather than twice.
      expect(host.querySelectorAll('[role="list"]')).toHaveLength(1);
      expect(host.querySelectorAll('[role="listitem"]')).toHaveLength(leaves.length);
      const decorative = host.querySelectorAll('.genre-ticker__run[aria-hidden="true"]');
      expect(decorative).toHaveLength(1);
      expect(decorative[0]!.querySelectorAll('[role="listitem"]')).toHaveLength(0);
      // The copy says the same thing, or the wrap would visibly jump to different text.
      expect(decorative[0]!.textContent).toBe('Rap52%Rage28%Trap metal20%');
    } finally {
      if (sw) Object.defineProperty(Element.prototype, 'scrollWidth', sw);
      if (cw) Object.defineProperty(Element.prototype, 'clientWidth', cw);
    }
  });

  it('sits still and does not duplicate itself when the genres already fit', () => {
    // The common desktop case: two genres in a wide header should be read, not scrolled.
    draw(leaves);
    expect(host.querySelectorAll('.genre-ticker__run')).toHaveLength(1);
    expect(host.querySelector('.genre-ticker')!.className).not.toContain('is-scrolling');
  });

  it('says it is still learning rather than drawing an empty scrolling line', () => {
    draw([]);
    expect(host.textContent).toContain('Still learning your sound');
    expect(host.querySelector('.genre-ticker__track')).toBeNull();
  });

  it('offers no play, pause or next control: the scroll rests on its own', () => {
    draw(leaves);
    expect(host.querySelectorAll('button')).toHaveLength(0);
  });

  it('paces the scroll by the number of genres instead of a fixed duration', () => {
    draw(leaves);
    const track = host.querySelector('.genre-ticker__track') as HTMLElement;
    // 3 genres: max(12, 3 * 3.4 * 2) = 20.4s. Twelve genres would get 81.6s, so the pace per genre
    // stays the same rather than the whole line speeding up as the mix grows.
    expect(track.style.getPropertyValue('--ticker-duration')).toBe('20.4s');
    draw([...leaves, leaf('Drill', 11), leaf('Phonk', 9)]);
    const wider = host.querySelector('.genre-ticker__track') as HTMLElement;
    expect(wider.style.getPropertyValue('--ticker-duration')).toBe('34s');
  });

  it('restarts at the strongest genre when the mix itself changes', () => {
    draw(leaves);
    const first = host.querySelector('.genre-ticker__track');
    draw([leaf('Drill', 60), leaf('Rap', 40)]);
    // A new element, so the animation starts from the beginning rather than resuming mid-scroll
    // with a different, shorter run under it.
    expect(host.querySelector('.genre-ticker__track')).not.toBe(first);
    expect([...host.querySelectorAll('[role="listitem"]')].map((li) => li.textContent)).toEqual(['Drill60%', 'Rap40%']);
  });
});
