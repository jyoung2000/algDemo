// CONTROL-SIZES-001 (owner, 2026-11-20): "Ensure UI and icons are polished, properly spaced, and production ready". A
// measured audit of every tab on Windows found controls off the app's sizes: song-row icons drawn at 14px beside 16px
// ones, 30px queue buttons beside 36/44px controls, 28px card-header buttons and a 24px segmented switch.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = (f: string) => readFileSync(resolve(process.cwd(), 'src', f), 'utf8');
const css = src('button-contract.css');
const rule = (sel: string) => { const i = css.indexOf(sel + ' {'); expect(i, sel).toBeGreaterThan(-1); return css.slice(i, css.indexOf('}', i)); };

describe('one set of control sizes', () => {
  it('every song-row icon is drawn at 16px', () => {
    expect(rule(':is(.rec__actions, .song-actions, .track__actions) :is(.iconbtn > svg, .iconbtn > .song-star > svg)')).toMatch(/width: 16px;\s*height: 16px;/);
  });
  it('the queue header buttons are 36px like the buttons beside them, with 16px icons', () => {
    expect(rule('.queue__actions > .iconbtn')).toMatch(/width: 36px;\s*height: 36px;/);
    expect(rule('.queue__actions > .iconbtn > svg')).toMatch(/width: 16px;\s*height: 16px;/);
  });
  it('card-header buttons and the segmented switch are 36px tall on Windows (the phone keeps 44px)', () => {
    expect(rule('body .card__head > .push')).toMatch(/height: 36px;\s*min-height: 36px;/);
    expect(rule('body .seg__btn')).toMatch(/height: 30px;/);
    const phone = css.slice(css.indexOf('@media (max-width: 899px), (pointer: coarse)'));
    expect(phone).toMatch(/body \.card__head > \.push,\s*body \.seg__btn,\s*\.queue__actions > \.iconbtn \{\s*height: var\(--btn-touch, 44px\);\s*min-height: var\(--btn-touch, 44px\);/);
    expect(phone).toMatch(/\.queue__actions > \.iconbtn \{\s*width: var\(--btn-touch, 44px\);/);
  });
  it('the phone radio player keeps its cover 24px from the screen edge like Windows (16px only on the narrowest screens), and Stop is a 44px target', () => {
    const radio = src('radio.css');
    const phone = radio.slice(radio.indexOf('/* RADIO-SHEET-INSET-001'));
    expect(phone).toMatch(/@media \(max-width: 899px\) \{\s*\.rail \.radio-player, \.np\.radio-player \{ padding-inline: clamp\(16px, calc\(\(100vw - 312px\) \/ 2\), 24px\); \}/);
    expect(phone).toMatch(/\.radio-player__close \{ top: 2px; right: 2px; width: 44px; height: 44px; \}\s*\.radio-player__close > svg \{ width: 16px; height: 16px; \}\s*\.radio-player__identity \{ padding-right: 28px; \}/);
  });
});
