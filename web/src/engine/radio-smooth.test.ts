import { describe, expect, it } from 'vitest';
import { RADIO_AHEAD_S, radioWantsPull } from './radio-client';
// RADIO-SMOOTH-001 (owner, 2026-11-20): "the radio sometimes plays back really choppy". On Windows the page plays the
// shell's audio through Web Audio and kept only 0.65 s scheduled: blocking the page for 0.7 s or more (measured: 0.7,
// 0.9 and 1.2 s blocks) left a gap every time. It now keeps 2.5 s scheduled.
describe('how far ahead the Windows page schedules radio audio', () => {
  it('keeps two and a half seconds queued', () => {
    expect(RADIO_AHEAD_S).toBe(2.5);
    expect(radioWantsPull(0)).toBe(true);
    expect(radioWantsPull(2.4)).toBe(true);
    expect(radioWantsPull(2.5)).toBe(false);
  });
});
