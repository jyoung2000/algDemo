// REMOVE-QUIET-001 (owner, 2026-11-19): "get rid of the message when removing a song".
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = (f: string) => readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');

describe('removing a song', () => {
  it('shows no notice: removing a queue row (hide) does not flash a message', () => {
    const app = src('App.tsx');
    const learn = app.slice(app.indexOf('const learnFeedback = async'), app.indexOf('const learnFeedback = async') + 2500);
    const hide = learn.slice(learn.indexOf("if (kind === 'hide')"), learn.indexOf("if (kind === 'hide')") + 200);
    expect(hide).not.toMatch(/flash\(/);
    expect(app).not.toMatch(/less likely to come back/);
  });
  it('removing a song from a saved list shows no notice either', () => {
    const saved = src('SavedView.tsx');
    expect(saved).not.toMatch(/Removed .* from/);
  });
});
