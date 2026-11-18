// @vitest-environment happy-dom
/**
 * Owner report 2026-11-17 (screenshot): "the imported songs player does not look like the airwave
 * discovery music player". Measured live: an imported song has no cover, and the placeholder kept
 * an inline 196px size the player's 64px cover rule could not override, so the strip grew 196px
 * tall and the title was squeezed to 46px ("Imp... Song 3"); the player also offered "imported ↗".
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { Art } from './Art';

afterEach(cleanup);
const here = dirname(fileURLToPath(import.meta.url));
const css = (f: string) => readFileSync(join(here, f), 'utf8');

it('sizes the no-artwork placeholder through a CSS variable, so context rules can resize it', () => {
  const { container } = render(<Art src={null} size={196} />);
  const el = container.querySelector('.art--none') as HTMLElement;
  expect(el.style.width).toBe('');
  expect(el.style.height).toBe('');
  expect(el.style.getPropertyValue('--art-size')).toBe('196px');
  expect(css('./art.css')).toMatch(/\.art--none \{[^}]*width: var\(--art-size/);
});

it('lets the player cover rule (more specific) win over the placeholder size', () => {
  expect(css('./styles.css')).toMatch(/\.np--panel \.np__main \.art \{[^}]*width: 64px;/);
});

it('gives glyphs in push buttons the button text colour (white on blue), not SVG black', () => {
  expect(css('./button-contract.css')).toMatch(/\.push > \.aqua-icon \{[^}]*fill: currentColor;/);
});

it('offers no "open in service" link for an imported local file', () => {
  expect(readFileSync(join(here, 'Player.tsx'), 'utf8')).toMatch(/const openLinks = playing && !t\?\.url\?\.startsWith\('imported:'\)/);
});
