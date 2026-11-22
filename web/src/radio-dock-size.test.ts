// RADIO-DOCK-SIZE-001 (owner, 2026-11-22): "On android can we make the radio player the same size as the discover player
// but keep all the same features and ui elements". Measured on a 411px phone before: radio 325px, song player 152px.
// The layout itself is measured on the emulator; this pins the rules that give it, and that nothing is hidden to get there.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./radio.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const block = css.slice(css.indexOf('/* RADIO-DOCK-SIZE-001'));
const phone = /@media \(max-width:760px\) \{([\s\S]*?)\n\}/.exec(block)?.[1] ?? '';
const rule = (sel: string) => new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(phone)?.[1] ?? '';

describe('the phone radio player is laid out like the song player', () => {
  it('has three rows: the words, the progress bar, and one row for every control', () => {
    expect(rule('.np.radio-player')).toMatch(/grid-template-areas:"main main" "timeline timeline" "controls side" "status status" "lists lists"/);
    expect(rule('.np.radio-player')).toMatch(/padding-block:8px 9\.5px; gap:0;/);
    expect(rule('.np.radio-player .radio-player__main')).toMatch(/height:48px/);
    expect(rule('.np.radio-player .radio-player__identity')).toMatch(/grid-template-rows:15px 18px 15px/);
    expect(rule('.np.radio-player .radio-player__timeline')).toMatch(/margin-top:7px/);
    // The title's link carries -6px margins elsewhere; left in, its 18px line was clipped to a 6px strip.
    expect(rule('.np.radio-player .radio-player__song')).toMatch(/min-height:0; margin:0; padding:0; line-height:18px/);
    expect(rule('.np.radio-player .prog__bar')).toMatch(/padding:12px 0/);
    expect(phone).toMatch(/\.np\.radio-player \.radio-player__controls,\n \.np\.radio-player \.radio-player__side \{ margin-top:6px; height:44px; \}/);
  });
  it('gives the controls the song player\u2019s sizes: 38px wide, 44px tall, a 48px main button', () => {
    expect(rule('.np.radio-player .radio-player__transport .tbtn')).toMatch(/width:38px; flex:0 0 38px; height:44px/);
    expect(rule('.np.radio-player .radio-player__transport .tbtn--main')).toMatch(/width:48px; flex-basis:48px; height:48px/);
  });
  it('hides nothing to fit: only an empty status line takes no room', () => {
    const hidden = [...phone.matchAll(/([^{}\n]+)\{[^}]*display:none[^}]*\}/g)].map((m) => m[1]!.trim());
    expect(hidden).toEqual(['.np.radio-player .radio-player__status:empty']);
    expect(phone).not.toMatch(/visibility:hidden/);
  });
  it('comes after the older phone rules, so it is the one that applies', () => {
    expect(css.indexOf('/* RADIO-DOCK-SIZE-001')).toBeGreaterThan(css.indexOf('/* RADIO-SHEET-INSET-001'));
    expect(css.indexOf('/* RADIO-DOCK-SIZE-001')).toBeGreaterThan(css.lastIndexOf('.radio-player__tags { display:flex; }'));
  });
});
