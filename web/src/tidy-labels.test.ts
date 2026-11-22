// RADIO-REFRESH-ICON-001 (owner, 2026-11-22): "on radio the refresh stations button should just be a spining arrow icon
// thats inline with the label".
// DISCOVER-QUIET-001 (owner, 2026-11-22): "get rid of labels under a mix of familar and new and the label under prefer
// new releases button but keep the spacing".
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (f: string) => readFileSync(new URL(`./${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

describe('the Radio refresh is an arrow on the heading\u2019s line', () => {
  const src = read('Radio.tsx');
  const h1 = /<h1 id="radio-h"[^>]*>([\s\S]*?)<\/h1>/.exec(src)?.[1] ?? '';
  it('sits inside the heading, named for screen readers, with no words printed', () => {
    expect(h1).toMatch(/<button className="iconbtn radio-page__refresh" type="button" aria-label="Refresh stations"/);
    const button = /<button className="iconbtn radio-page__refresh"[\s\S]*?<\/button>/.exec(h1)![0];
    expect(button.replace(/\{[\s\S]*\}/g, '').replace(/<[^>]*>/g, '').trim()).toBe('');
    expect(src).not.toMatch(/>Refresh stations<\/button>/);
  });
  it('turns only while the stations are being read again', () => {
    expect(h1).toMatch(/<RadioRefreshGlyph size=\{16\} className=\{busy \|\| refreshing \? 'radio-refresh__icon' : 'radio-refresh__still'\} \/>/);
    const css = read('radio.css');
    expect(css).toMatch(/\.radio-refresh__icon \{ animation: radio-spin/);
    expect(css).not.toMatch(/\.radio-refresh__still[^{]*\{[^}]*animation/);
    expect(css).toMatch(/\.radio-page__title \{ display:flex; align-items:center;/);
    expect(css).toMatch(/\.iconbtn\.radio-page__refresh:hover:not\(:disabled\)/);
    // Just the arrow: no ring, no fill.
    expect(css).toMatch(/\.iconbtn\.radio-page__refresh \{ flex:none; color:var\(--ink-2\); border:0; background:transparent; box-shadow:none; \}/);
  });
});

describe('the two Discover lines keep their room and print nothing', () => {
  const app = read('App.tsx');
  it('hides them without taking them out of the layout', () => {
    expect(app).toMatch(/<p className="go__hint go__gone" aria-hidden="true">/);
    expect(app).toMatch(/<span className="go__freshnote go__gone" aria-hidden="true">/);
    expect(read('styles.css')).toMatch(/\.go__gone \{ visibility: hidden; \}/);
  });
});
