// RADIO-ROW-STRIPE-001 (owner, 2026-11-20): "On android on mobile the radio cover still collides with the blue side".
// Measured on the phone: the playing station's row draws a 3 px blue stripe on its left (inset box-shadow) and its cover
// started at the row's very left edge (x 28.8 = row left), on top of the stripe. radio.css gives the playing row 12 px of
// left padding, but song-row.css's `ul.radio-stations > li.radio-station { padding: 14px 0 }` is more specific and
// reset it to 0. The playing row's padding now wins at that same specificity, on every screen size.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src', 'song-row.css'), 'utf8');

describe('the playing station row keeps its cover clear of the blue stripe', () => {
  it('a rule as specific as the row padding gives the playing row 12 px on the left, after it', () => {
    const base = css.indexOf('ul.radio-stations > li.radio-station { padding: 14px 0; }');
    const on = css.search(/ul\.radio-stations > li\.radio-station\.is-on \{ padding-left: 12px; \}/);
    expect(base).toBeGreaterThanOrEqual(0);
    expect(on).toBeGreaterThan(base);
  });
});
