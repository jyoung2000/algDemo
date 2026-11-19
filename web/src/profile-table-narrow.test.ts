// PROFILE-NARROW-001: on a narrow phone the Profile's genre table left its card and, at 320 px, pushed
// the page 13 px sideways. The rule that lets the score bars shrink sat before the general phone rule, so
// the general rule (72 px bars) won, and the shared 64 px number box was never narrowed. A rule for a
// narrower screen must come after the rule for a wider one, or it never applies.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/** The phone rules that size the profile's score bars: the widest screen each covers, the bar's least width, and the rule text, in file order. */
function barRules(): { upTo: number; px: number; block: string }[] {
  const out: { upTo: number; px: number; block: string }[] = [];
  const media = /@media \(max-width: (\d+)px\) \{/g;
  for (let m = media.exec(css); m; m = media.exec(css)) {
    const block = css.slice(m.index, css.indexOf('\n}\n', m.index)); // a block ends at a closing brace in column 0
    const rule = /\.pcell \.sbar,\s*\.pcell \.pbar \{\s*min-width: (\d+)px;/.exec(block);
    if (rule) out.push({ upTo: Number(m[1]), px: Number(rule[1]), block });
  }
  return out;
}
/** What a screen of this width ends up with: the last matching rule in the file wins. */
const at = (width: number) => { const r = barRules().filter((x) => width <= x.upTo); return r[r.length - 1]!; };

describe('the profile tables on a narrow phone (PROFILE-NARROW-001)', () => {
  it('lets the score bars shrink on 320, 360 and 390 px screens, and keeps the readable bars at 412 px', () => {
    for (const w of [320, 360, 375, 390]) expect(at(w).px).toBeLessThanOrEqual(40);
    expect(at(412).px).toBe(72);
  });
  it('narrows the number beside each bar on those screens, where the shared 64 px box does not fit', () => {
    expect(at(320).block).toMatch(/\.ptable \.num \{\s*width: 48px;/);
    expect(at(412).block).not.toMatch(/\.ptable \.num \{\s*width:/);
  });
  it('orders the narrow-phone rules after the general phone rules', () => {
    const rules = barRules();
    expect(rules.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < rules.length; i++) expect(rules[i]!.upTo).toBeLessThanOrEqual(rules[i - 1]!.upTo);
  });
});
