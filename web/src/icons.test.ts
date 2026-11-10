import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { REFRESH_PATHS, SHUFFLE_PATHS } from './icons';

/** ICON-SPACING-001: the shuffle's two arrowheads sit well apart, and refresh has a single head. */
const src = (f: string) => readFileSync(join(process.cwd(), 'src', f), 'utf8');

it('puts the shuffle arrowheads 12 units apart on the 24-unit grid', () => {
  const heads = SHUFFLE_PATHS.filter((d) => /^M17 \d+l3 3-3 3$/.test(d)).map((d) => Number(/^M17 (\d+)/.exec(d)![1]) + 3);
  expect(heads).toEqual([6, 18]);
  expect(heads[1]! - heads[0]!).toBeGreaterThanOrEqual(10);
});

it('draws refresh as one arc with one arrowhead', () => {
  expect(REFRESH_PATHS).toHaveLength(2);
  expect(REFRESH_PATHS.filter((d) => /a8 8/.test(d))).toHaveLength(1);
});

it('uses these icons, not the shared kit\u2019s cramped ones, in the player, search and Settings', () => {
  for (const f of ['Player.tsx', 'Search.tsx', 'Settings.tsx']) {
    expect(src(f), f).not.toMatch(/<Glyph name="(shuffle|refresh)"/);
  }
  expect(src('Player.tsx')).toMatch(/<ShuffleGlyph/);
  expect(src('Search.tsx')).toMatch(/<RefreshGlyph/);
});
