// @vitest-environment happy-dom
// HISTORY-PICK-001 (owner, 2026-11-19): "fix the ui on the import listening history button". It was the browser's
// own file input: a grey "Choose File" and a cut-off "No fi...osen". Now an app button and the chosen file's name.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = (f: string) => readFileSync(resolve(process.cwd(), 'src', f), 'utf8');

describe('the listening history picker', () => {
  it('a real app button opens a hidden file input; the file name (or "No file chosen") sits beside it', () => {
    const s = src('Settings.tsx');
    const block = s.slice(s.indexOf('aria-label="Listening history import"'), s.indexOf('{history && ('));
    expect(block).toMatch(/<button className="push" type="button" aria-label="Choose history file" disabled=\{historyBusy\} onClick=\{\(\) => historyInput\.current\?\.click\(\)\}>/);
    expect(block).toMatch(/Choose file…/);
    expect(block).toMatch(/<span className="history-pick__name"[^>]*>\{historyName \|\| 'No file chosen'\}<\/span>/);
    expect(block).toMatch(/<input\s+ref=\{historyInput\}\s+className="sr"\s+type="file"\s+tabIndex=\{-1\}\s+aria-hidden="true"/);
    expect(block).toMatch(/setHistoryName\(f\?\.name \?\? ''\)/);
  });

  it('button and name share one row; a long name is shortened with an ellipsis, not cut mid-word', () => {
    const css = src('settings-buttons.css');
    const row = css.slice(css.indexOf('.history-pick {'), css.indexOf('}', css.indexOf('.history-pick {')));
    expect(row).toMatch(/display:\s*flex/);
    expect(row).toMatch(/gap:\s*12px/);
    const name = css.slice(css.indexOf('.history-pick__name {'), css.indexOf('}', css.indexOf('.history-pick__name {')));
    expect(name).toMatch(/text-overflow:\s*ellipsis/);
    expect(name).toMatch(/min-width:\s*0/);
    // .pref is a label | content grid; the picker fell into the 170px label column and cut the name off
    expect(row).toMatch(/grid-column:\s*-2 \/ -1/);
  });
});
