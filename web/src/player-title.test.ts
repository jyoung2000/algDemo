import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// The owner's rule: a song's title and artist are never cut off. On a phone the player is the
// docked strip above the tabs, and the search, saved and downloads lists are `.track` rows; each
// must wrap a long title rather than end it in an ellipsis.
const here = dirname(fileURLToPath(import.meta.url));
const sheets = ['styles.css', 'saved-lists.css', 'mobile-refinement.css'].map((f) => [f, readFileSync(join(here, f), 'utf8')] as const);
const css = sheets[0]![1];
const CUT = /line-clamp|text-overflow:\s*ellipsis|white-space:\s*nowrap/;

it('the docked player wraps a long title and artist instead of cutting them off', () => {
  const rule = css.match(/\.np--docked \.np__title,\s*\.np--docked \.np__artist \{([^}]*)\}/);
  expect(rule, 'no docked title/artist rule').not.toBeNull();
  const body = rule![1]!;
  expect(body).toMatch(/white-space:\s*normal/);
  expect(body).toMatch(/overflow:\s*visible/);
  expect(body).not.toMatch(CUT);
  // Nothing later in the file may cut it back off for the docked strip.
  const later = css.slice(rule!.index! + rule![0].length);
  for (const m of later.matchAll(/([^{}]*\.np--docked[^{}]*\.np__(?:title|artist)[^{}]*)\{([^}]*)\}/g)) {
    expect(m[2], m[1]!.trim()).not.toMatch(CUT);
  }
});

it('no song list cuts a title or artist off', () => {
  let rules = 0;
  for (const [file, text] of sheets) {
    for (const m of text.matchAll(/([^{}]*\.track__(?:title|artist)\b[^{}]*)\{([^}]*)\}/g)) {
      rules++;
      expect(m[2], `${file}: ${m[1]!.trim()}`).not.toMatch(CUT);
    }
  }
  expect(rules).toBeGreaterThan(0);
});
