import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * VTAG-GAP-001 (owner, 2026-11-19: "the new tag and remix tag still hug the title"). The title text and
 * its tags are siblings with no space between them in the markup, so the gap must come from the tag.
 */
const css = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');

describe('version and New tags keep a gap from the title (VTAG-GAP-001)', () => {
  it('gives every tag a left margin of at least 6px', () => {
    const rule = /(?:^|\n)\.vtag \{([^}]*)\}/.exec(css)![1]!;
    const m = /margin-inline-start: (\d+)px/.exec(rule) ?? /margin-left: (\d+)px/.exec(rule);
    expect(m, '.vtag has a left margin').toBeTruthy();
    expect(Number(m![1])).toBeGreaterThanOrEqual(6);
  });
});
