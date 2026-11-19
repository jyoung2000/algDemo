// ALGO-INLINE-001 (owner, 2026-11-18): "on the profile page ensure the algorithm buttons for create,
// import, export, and etc are always inline and on the same line". Measured in the real app at
// 320 px: four buttons at their natural size need about 330 px and the card offers 255, so the
// row wrapped. Below 480 px the row is a four-column grid whose columns may shrink; above it the
// row simply never wraps. Only the toolbar's row is held to one line: the confirmation buttons in
// the panels carry long sentences (and a name the listener typed) and must keep wrapping.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./algorithm-manager.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
const tsx = readFileSync(new URL('./AlgorithmManager.tsx', import.meta.url), 'utf8');

/** Declarations of every rule with exactly this selector, outside any @media, joined. */
function base(selector: string): string {
  const top = css.replace(/@media[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  return [...top.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1]!.trim().split(/\s*,\s*/).includes(selector)).map((m) => m[2]).join(';');
}
/** The same, inside the @media (max-width: N) blocks that cover a screen of this width. */
function phone(selector: string, width: number): string {
  return [...css.matchAll(/@media \(max-width: (\d+)px\) \{((?:[^{}]*\{[^{}]*\})*)[^{}]*\}/g)]
    .filter((m) => width <= Number(m[1]))
    .flatMap((m) => [...m[2]!.matchAll(/([^{}]+)\{([^{}]*)\}/g)])
    .filter((m) => m[1]!.trim().split(/\s*,\s*/).includes(selector)).map((m) => m[2]).join(';');
}

const ROW = '.algo__toolbar > .algo__buttons';
const BUTTON = '.algo__toolbar > .algo__buttons .push';

describe('the algorithm toolbar actions stay on one line (ALGO-INLINE-001)', () => {
  it('has exactly the four permanent actions in the toolbar row, in order', () => {
    const row = /<div className="algo__toolbar">[\s\S]*?<div className="algo__buttons">([\s\S]*?)<\/div>/.exec(tsx)![1]!;
    expect([...row.matchAll(/>([A-Za-z]+)<\/button>/g)].map((m) => m[1])).toEqual(['Create', 'Reset', 'Import', 'Export']);
  });

  it('never wraps the row or a label, at any width', () => {
    expect(base(ROW)).toMatch(/flex-wrap:\s*nowrap/);
    expect(base(BUTTON)).toMatch(/white-space:\s*nowrap/);
  });

  it('on a phone gives the row its own full line as four equal columns that are allowed to shrink', () => {
    for (const w of [320, 360, 412, 480]) {
      expect(phone(ROW, w)).toMatch(/grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
      expect(phone(ROW, w)).toMatch(/flex:\s*1 1 100%/);
      expect(phone(BUTTON, w)).toMatch(/min-width:\s*0/);
      // 255 px of card at 320 px, less three 6 px gaps, is 59 px a button: "Create" at 12 px needs 38.
      expect(phone(BUTTON, w)).toMatch(/padding-inline:\s*4px/);
      expect(phone(BUTTON, w)).toMatch(/font-size:\s*12px/);
    }
    expect(phone(ROW, 481)).toBe('');
  });

  it('does not scroll the row sideways to make it fit', () => {
    expect(base(ROW) + phone(ROW, 320)).not.toMatch(/overflow(-x)?:\s*(auto|scroll)/);
  });

  it('leaves the panels\' confirmation buttons free to wrap, so a long label cannot leave the card', () => {
    expect(base('.algo__buttons')).toMatch(/flex-wrap:\s*wrap/);
    expect(base('.algo__buttons .push')).not.toMatch(/white-space:\s*nowrap/);
    expect(base('.algo__buttons .push')).toMatch(/max-width:\s*100%/);
  });

  it('sizes a panel to its card, not to the file chooser inside it', () => {
    // An implicit grid column is as wide as its widest item's minimum: the Import panel's file
    // input made it 280 px in a 229 px card and pushed the page 13 px sideways at 320 px.
    expect(base('.algo__panel')).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });
});
