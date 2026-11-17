// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCE_MARKS, SourceMark } from './SourceMark';
import { PROVIDER_LABEL } from './util';

/**
 * ARTIST-SRC-ICON-001 — owner: "on the artist page ensure the platforms and sources have there respective
 * app icons & colors".
 *
 * Measured before: the artist page handed the mark the raw source id, so YouTube Music fell through to a
 * grey tile with a letter on it, Deezer was a grey tile, and Audius, HearThis, Internet Archive and Apple
 * Music had no mark of their own at all. Each source now has a flat tile in its platform's own colour.
 * The tiles carry a plain glyph, not the platform's logo: see the note in SourceMark.tsx.
 */
const here = dirname(fileURLToPath(import.meta.url));
afterEach(cleanup);
const grey = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
  return Math.max(r, g, b) - Math.min(r, g, b) < 40;
};

describe('every source has its own mark and colour (ARTIST-SRC-ICON-001)', () => {
  it('has a mark for every source the app names', () => {
    expect(Object.keys(PROVIDER_LABEL).filter((id) => !SOURCE_MARKS[id])).toEqual([]);
  });

  it('gives each platform its own colour, and no two the same', () => {
    const colours = Object.entries(SOURCE_MARKS).filter(([id]) => id !== 'local').map(([, m]) => m.colour.toLowerCase());
    expect(new Set(colours).size).toBe(colours.length);
    // The platforms whose colour is their identity are never a grey tile.
    for (const id of ['deezer', 'ytmusic', 'soundcloud', 'bandcamp', 'audius', 'spotify', 'apple']) expect(grey(SOURCE_MARKS[id]!.colour), id).toBe(false);
    expect(SOURCE_MARKS['deezer']!.colour.toLowerCase()).toBe('#a238ff');
    expect(SOURCE_MARKS['ytmusic']!.colour.toLowerCase()).toBe('#ff0000');
    expect(SOURCE_MARKS['soundcloud']!.colour.toLowerCase()).toBe('#ff5500');
    expect(SOURCE_MARKS['spotify']!.colour.toLowerCase()).toBe('#1db954');
  });

  it('draws a flat tile in that colour with a white glyph', () => {
    const { container } = render(<SourceMark provider="deezer" size={13} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('data-provider')).toBe('deezer');
    expect(svg.getAttribute('class')).toMatch(/\baqua-icon\b/);
    expect(svg.getAttribute('width')).toBe('13');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.querySelector('rect')?.getAttribute('fill')?.toLowerCase()).toBe('#a238ff');
    // Flat, like the rest of the app: no gradient, no gloss.
    expect(svg.querySelector('linearGradient, radialGradient')).toBeNull();
    expect(svg.querySelectorAll('[opacity]').length).toBe(0);
    expect(svg.querySelector('path, circle, g')).not.toBeNull();
  });

  it('reads YouTube Music under either of its ids', () => {
    for (const id of ['ytmusic', 'youtube']) {
      const { container, unmount } = render(<SourceMark provider={id} />);
      expect(container.querySelector('rect')?.getAttribute('fill')?.toLowerCase(), id).toBe('#ff0000');
      unmount();
    }
  });

  it('still marks a source it has never heard of, with its initials on a neutral tile', () => {
    const { container } = render(<SourceMark provider="some-new-service" />);
    expect(container.querySelector('text')?.textContent).toBe('SN');
    expect(grey(container.querySelector('rect')!.getAttribute('fill')!)).toBe(true);
  });

  it('is the one mark every screen draws, the artist page included', () => {
    const sources = readdirSync(here).filter((f) => f.endsWith('.tsx') && !f.includes('.test.') && f !== 'SourceMark.tsx');
    const old = sources.filter((f) => /<ProviderMark\b/.test(readFileSync(join(here, f), 'utf8')));
    expect(old).toEqual([]);
    expect(readFileSync(join(here, 'Artists.tsx'), 'utf8')).toMatch(/<SourceMark provider=\{r\.provider\}/);
  });
});
