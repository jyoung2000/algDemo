// ALGO-ACTIONS-LABEL-001 / PREF-CHECK-INLINE-001 (owner, 2026-11-19): "add a label on top of these buttons in settings so
// we know what data these buttons are responsible for. a single title or label for the section for all 3 buttons" and
// "ensure the check boxes are inline with the label in settings".
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = (f: string) => readFileSync(resolve(process.cwd(), 'src', f), 'utf8');

describe('settings labels', () => {
  it('the Create / Reset / Import / Export buttons sit under one title naming what they act on', () => {
    const s = src('AlgorithmManager.tsx');
    expect(s).toMatch(/<span id=\{`\$\{id\}-manage`\} className="algo__label algo__manage-label">Selected algorithm’s settings: create, reset, import or export<\/span>\s*<div className="algo__buttons" role="group" aria-labelledby=\{`\$\{id\}-manage`\}>/);
    // the title takes its own line inside the toolbar, directly above the buttons
    expect(src('algorithm-manager.css')).toMatch(/\.algo__manage-label \{[^}]*flex-basis: 100%;/);
  });
  it('a setting\'s name lines up with its checkbox on the first line, not centred on a long description', () => {
    expect(src('settings-buttons.css')).toMatch(/\.pref > \.k:has\(\+ \.chk\) \{\s*align-self: start;/);
  });
  it('on a phone (one column) the checkbox moves up onto its name\'s line, before the name', () => {
    const css = src('settings-buttons.css');
    const phone = css.slice(css.indexOf('@media (max-width: 899px)'));
    expect(phone).toMatch(/\.settings \.pref > \.k:has\(\+ \.chk\) \{\s*padding-left: 26px;/);
    // name row 20px + 3px row gap above the checkbox row: box (16px) centred on the name's line
    expect(phone).toMatch(/\.settings \.pref > \.k \+ \.chk > \.box \{\s*position: absolute;\s*left: 0;\s*top: -23px;/);
    expect(phone).toMatch(/\.settings \.pref > \.k \+ \.chk > input \{\s*top: -24px;\s*left: -3px;/);
  });
});
