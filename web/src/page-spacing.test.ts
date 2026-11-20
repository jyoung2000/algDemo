// PAGE-SPACING-001 (owner, 2026-11-19): "ensure buttons on the artist and album page are properly spaced".
// Both pages are `.card.album` (the artist page adds `.artist`), so one file sets one rhythm for both.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src/album-spacing.css'), 'utf8');
const rule = (sel: string) => {
  const i = css.indexOf(sel + ' {');
  expect(i, sel).toBeGreaterThanOrEqual(0);
  return css.slice(i, css.indexOf('}', i));
};

describe('album and artist page button spacing', () => {
  it('the action row has the artist page’s rhythm on the album page too: 12px between buttons, 16px around the row', () => {
    const r = rule('.album .album__actions');
    expect(r).toMatch(/gap:\s*12px/);
    expect(r).toMatch(/margin:\s*16px 0/);
    expect(r).toMatch(/flex-wrap:\s*wrap/);
  });

  it('song-row buttons have 8px between them, not 6px', () => {
    expect(rule('.album .track__actions')).toMatch(/gap:\s*8px/);
  });

  it('the artist page’s filter chips are the same size as the search page’s', () => {
    const r = rule('.album .typefilter__btn');
    expect(r).toMatch(/min-width:\s*42px/);
    expect(r).toMatch(/min-height:\s*38px/);
  });

  it('both pages load the rules', () => {
    for (const f of ['src/Albums.tsx', 'src/Artists.tsx']) {
      expect(readFileSync(resolve(process.cwd(), f), 'utf8'), f).toMatch(/import '\.\/album-spacing\.css';/);
    }
  });
});
