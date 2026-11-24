// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Results } from './Results';
import { SongStar } from './SongStar';
import { cacheStateOf } from './engine/queue-controls';
import type { RecItem, Track } from './api';
import type { CardCache } from './engine/queue-controls';

/**
 * ROW-CHECK-001 — owner: "do a design check of the songlist on both platforms to ensure the check mark
 * arent off center, and also remove the check mark from the play button".
 *
 * Measured before, on both apps: the "held on this device" tick was pinned to the row's bottom-left corner,
 * a position left over from an older row. In today's row that is the controls band, so on the phone it sat
 * on top of the Play button and on Windows it floated 90px under the artwork. It was also a text character,
 * which each platform's font seats differently inside the badge. The playlist tick beside the star pushed
 * the star 6px left of every other row's star.
 */
const here = dirname(fileURLToPath(import.meta.url));
const css = (name: string) => readFileSync(join(here, name), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
const rule = (sheet: string, selector: string) => {
  const m = new RegExp(`(?:^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css(sheet));
  return m?.[1] ?? '';
};

const track = { key: 'held-song', title: 'Held song', artists: ['Test artist'], provider: 'deezer', platform_id: '1', tags: [], preview: 'https://test.invalid/audio.mp3' } as unknown as Track;
const item = { track, rank: 1, playback: { preview: 'https://test.invalid/audio.mp3' }, reasons: [], characteristics: {} } as unknown as RecItem;
const ready = cacheStateOf({ status: 'ready', kept: false, percent: null, blocked: false, inTarget: true, error: null });
const inState = (state: CardCache['state']): CardCache => ({ ...ready, state });
const props = (c: CardCache | null) => ({
  seeds: [], items: [item], onRemoveSeed: vi.fn(), onEmphasis: vi.fn(), focusKey: null, playingKey: null,
  flags: {}, onFocus: vi.fn(), onPlay: vi.fn(), onPlayTrack: vi.fn(), onFeedback: vi.fn(), cacheOf: () => c,
});
afterEach(cleanup);

describe('the held-on-device mark sits on the artwork, never on Play (ROW-CHECK-001)', () => {
  it('puts the mark inside the artwork, as a drawn icon', () => {
    const { container } = render(<Results {...props(ready)} />);
    const marks = container.querySelectorAll('.rec__dl-mark');
    expect(marks.length).toBe(1);
    const mark = marks[0]!;
    expect(mark.closest('.rec__art')).not.toBeNull();
    // A drawing centres the same on both platforms; a text tick sits where each font puts it.
    expect(mark.querySelector('svg')).not.toBeNull();
    expect(mark.textContent).toBe('');
    expect(mark.getAttribute('data-dl')).toBe('ready');
    expect(mark.getAttribute('aria-hidden')).toBe('true');
  });

  it('leaves Play with its play icon alone', () => {
    const { container } = render(<Results {...props(ready)} />);
    const play = container.querySelector('.rec__actions .playbtn')!;
    expect(play.querySelectorAll('svg').length).toBe(1);
    expect(play.querySelector('.rec__dl-mark')).toBeNull();
    expect(play.textContent).toBe('');
    // Nothing the bottom rail carries can land on the controls any more.
    expect(container.querySelector('.rec__dl .rec__dl-mark')).toBeNull();
  });

  it('still tells a screen reader, and shows a mark for every state', () => {
    for (const state of ['ready', 'queued', 'downloading', 'failed', 'blocked'] as const) {
      const { container, unmount } = render(<Results {...props(inState(state))} />);
      expect(container.querySelector('.rec__dl .sr')?.textContent).toMatch(/\.$/);
      expect(container.querySelector(`.rec__art .rec__dl-mark[data-dl="${state}"] svg`), state).not.toBeNull();
      unmount();
    }
  });

  it('shows no mark when nothing is known about the song', () => {
    const { container } = render(<Results {...props(null)} />);
    expect(container.querySelector('.rec__dl-mark')).toBeNull();
  });

  it('pins the badge to the artwork corner and centres its icon', () => {
    const body = rule('styles.css', '.rec__dl-mark');
    expect(body).toMatch(/position: absolute;/);
    expect(body).toMatch(/right: -?\d+px;/);
    expect(body).toMatch(/bottom: -?\d+px;/);
    expect(body).not.toMatch(/left:/);
    expect(body).toMatch(/display: grid;/);
    expect(body).toMatch(/place-items: center;/);
    const [w, h] = [/width: (\d+)px;/.exec(body)?.[1], /height: (\d+)px;/.exec(body)?.[1]];
    expect(w).toBeDefined();
    expect(w).toBe(h);
    expect(body).toMatch(/border-radius: 50%;/);
  });
});

// HEART-NO-TICK-001 (owner, 2026-11-24): "Remove the check box near the heart icon". The heart stands alone; a song
// saved to a playlist says so in the button's name and tooltip only.
describe('the heart has no playlist tick (HEART-NO-TICK-001)', () => {
  it('draws only the heart, saved or not', () => {
    for (const saved of [true, false]) {
      const { container, unmount } = render(<SongStar saved={saved} />);
      const star = container.querySelector('.song-star')!;
      expect(star.querySelectorAll('svg').length).toBe(1);
      expect(star.querySelector('.song-star__check')).toBeNull();
      unmount();
    }
  });
});

describe('a starting song shows its genres like every other row (GENRE-LOAD-001)', () => {
  const TAGGED = { ...track, key: 'seed-song', title: 'Seed song', tags: [{ name: 'r&b', label: 'R&B' }, { name: 'neo-soul', label: 'neo soul' }] } as unknown as Track;

  it('draws a bubble for each genre the song is tagged with, main genre first', () => {
    const { container } = render(<Results {...props(null)} seeds={[TAGGED]} items={[]} />);
    const bubbles = [...container.querySelectorAll('.rec--seed .genre')];
    expect(bubbles.map((b) => b.textContent)).toEqual(['R&B', 'Neo-soul']);
    // Each in the Taste Picker's colour for its own genre.
    for (const b of bubbles) expect((b as HTMLElement).style.getPropertyValue('--tone')).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('draws none for a starting song nothing is known about', () => {
    const { container } = render(<Results {...props(null)} seeds={[{ ...track, key: 'bare', tags: [] } as unknown as Track]} items={[]} />);
    expect(container.querySelector('.rec--seed')).not.toBeNull();
    expect(container.querySelector('.rec--seed .genre')).toBeNull();
  });
});

describe('every row shows a main genre and a subgenre, and says when one is an estimate (GENRE-ALL-001)', () => {
  const withChars = (characteristics: object) => ({ ...item, characteristics }) as unknown as RecItem;
  const bubbles = (c: Element) => [...c.querySelectorAll('.rec:not(.rec--seed) .genre')] as HTMLElement[];

  it('draws the main genre, then the subgenre, each marked with which it is', () => {
    const { container } = render(<Results {...props(null)} items={[withChars({ genres: ['Pop'], styles: [], fill: [{ label: '80s pop', sub: true, guess: false, why: 'Released in 1982' }] })]} />);
    const b = bubbles(container);
    expect(b.map((x) => [x.textContent, x.getAttribute('data-kind')])).toEqual([['Pop', 'main'], ['80s pop', 'sub']]);
    expect(b[1]!.getAttribute('title')).toBe('Released in 1982');
    expect(b.some((x) => x.classList.contains('genre--guess'))).toBe(false);
  });

  it('draws an estimate differently and says where it came from, in words', () => {
    const { container } = render(<Results {...props(null)} items={[withChars({ genres: [], styles: [], fill: [{ label: 'Hip-hop', sub: false, guess: true, why: 'Most songs in this list' }] })]} />);
    const b = bubbles(container)[0]!;
    expect(b.classList.contains('genre--guess')).toBe(true);
    expect(b.getAttribute('title')).toBe('Estimated: most songs in this list');
    expect(b.getAttribute('aria-label')).toBe('Hip-hop, estimated: most songs in this list');
    // Never by colour alone: the outline is dashed.
    expect(rule('styles.css', '.genre--guess')).toMatch(/border:\s*1px dashed/);
  });

  it('draws a starting song from the same worked-out genres as a queue row', () => {
    const seed = { ...track, key: 'seed-2', tags: [{ name: 'pop', label: 'Pop' }], characteristics: { genres: ['Pop'], styles: [], fill: [{ label: '80s pop', sub: true, guess: false, why: 'Released in 1982' }] } } as unknown as Track;
    const { container } = render(<Results {...props(null)} seeds={[seed]} items={[]} />);
    expect([...container.querySelectorAll('.rec--seed .genre')].map((x) => x.textContent)).toEqual(['Pop', '80s pop']);
  });
});
