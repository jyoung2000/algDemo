// CDISC-FILL-001 (owner, 2026-11-19): "the sliders in custom discovery dont have blue bars behind the player dots".
// The range input was 38px tall with 19px padding top and bottom under border-box sizing, so the content box the
// blue fill is clipped to was 0px tall and nothing painted.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src', 'custom-discovery.css'), 'utf8');
const rule = (sel: string) => { const i = css.indexOf(sel + ' {'); expect(i, sel).toBeGreaterThanOrEqual(0); return css.slice(i, css.indexOf('}', i)); };

describe('custom discovery sliders show the blue fill', () => {
  it('the content box the fill paints in is 6px tall', () => {
    const r = rule(".cdisc__track input[type='range']");
    expect(r).toMatch(/box-sizing:\s*content-box/);
    expect(r).toMatch(/height:\s*6px/);
    expect(r).toMatch(/padding:\s*19px 0/);
    expect(r).toMatch(/background-clip:\s*content-box/);
    expect(r).toMatch(/#0071e3 var\(--pct/);
  });
});
