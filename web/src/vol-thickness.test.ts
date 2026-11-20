// VOL-THICKNESS-001 (owner, 2026-11-19): "fix the volume slider thickness". Above 100% the boosted rule set the
// `background` shorthand, which resets background-clip to border-box, so the colour filled the slider's padded hit
// area (22px on Windows, 28px on touch) instead of its thin channel. Measured on Windows: 6px channel at 80%,
// a 22px-tall bar at 200%.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src/volume-pop.css'), 'utf8');

describe('volume slider thickness', () => {
  it('the boosted fill stays inside the channel, not the padded hit area', () => {
    const i = css.indexOf('.vol.is-boosted .vol__pop .vol__bar {');
    expect(i).toBeGreaterThanOrEqual(0);
    const rule = css.slice(i, css.indexOf('}', i));
    expect(rule).toMatch(/background-clip:\s*content-box/);
    expect(rule).toMatch(/background-origin:\s*content-box/);
    expect(rule).toMatch(/background-size:\s*100% 100%/);
    // the shorthand must come first, or it would reset the clip again
    expect(rule.indexOf('background-clip')).toBeGreaterThan(rule.indexOf('background:'));
  });
});
