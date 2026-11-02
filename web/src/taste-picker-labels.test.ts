import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync(new URL('./TastePicker.tsx', import.meta.url), 'utf8');

/**
 * Measured on the device at 412px and 2.5x zoom: the family band at the edge of the view kept
 * 20px of its 114px width, so "Indie" rendered as the ellipsised fragment "In...".
 */
describe('the taste map never shows a half-word family label', () => {
  it('hides a band too narrow to hold its name instead of ellipsising it', () => {
    expect(src).toMatch(/const whole = 1 \/ 8 \/ view\.size;/);
    expect(src).toMatch(/visibility: shown < whole \* 0\.55 \? 'hidden' : undefined/);
  });

  it('clamps a band that starts left of the view to the view edge', () => {
    expect(src).toMatch(/const left = Math\.max\(0, \(i \/ 8 - view\.x\) \/ view\.size\);/);
    expect(src).toMatch(/const shown = Math\.max\(0, right - left\);/);
  });
});
