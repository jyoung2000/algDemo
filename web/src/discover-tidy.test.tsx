// @vitest-environment happy-dom
// DISCOVER-TIDY-001 (owner, 2026-11-19): "find my next favorite and customize discovery should be inline the find my
// favorite should be 75% and the customize discovery button should be 25% and just the icon, also remove the label
// [Your last now playing queue ...]. Also remove the border around the ready locally bar. Get rid of the download
// locally bar and just put small sub grey text on how many songs loaded out of how many songs found ... ontop of the
// now playing queue".
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { Track } from './api';

const snap = vi.hoisted(() => ({ ready: 41, total: 63 }));
vi.mock('./engine/downloads', () => ({ downloadsAvailable: () => true, dl: {} }));
vi.mock('./engine/queue-audio', () => ({
  queueAudio: {
    snapshotFor: (t: Track[]) => ({ total: t.length ? snap.total : 0, ready: snap.ready, active: 1, failed: 0, blocked: false, retrying: 0 }),
    subscribe: () => () => {},
  },
}));
import { ListLoadedNote } from './ListDownloadBar';

const src = (f: string) => readFileSync(resolve(process.cwd(), 'src', f), 'utf8');
const rule = (css: string, sel: string) => { const i = css.indexOf(sel + ' {'); expect(i, sel).toBeGreaterThanOrEqual(0); return css.slice(i, css.indexOf('}', i)); };
afterEach(cleanup);

describe('Discover: one row of discovery buttons, a quiet loaded count', () => {
  it('Find my next favorite takes 90% and an icon-only Customize button 10%, side by side (DISCOVER-TIDY-002)', () => {
    const app = src('App.tsx');
    const pair = app.slice(app.indexOf('className="go__pair"'), app.indexOf('id="go-why"'));
    expect(pair).toMatch(/Find my next favorite/);
    const custom = pair.slice(pair.indexOf('go__custom'));
    expect(custom).toMatch(/aria-label="Customize discovery"/);
    expect(custom.slice(0, custom.indexOf('</button>'))).not.toMatch(/>\s*Customize discovery\s*</);
    expect(app).not.toMatch(/className="go__more"/);
    const css = src('discover-tidy.css');
    expect(rule(css, '.go__pair')).toMatch(/grid-template-columns:\s*9fr 1fr/);
    // the same height as Find (the older .go__custom rule forced 44px beside a 36px Find on Windows)
    expect(rule(css, '.go__pair > .go__custom')).toMatch(/min-height:\s*0/);
  });

  it('no “Add at least one starting song first” label; Find works with no starting song at all', () => {
    const app = src('App.tsx');
    expect(app).not.toMatch(/Add at least one starting song first/);
    const find = app.slice(app.indexOf('className="go__pair"'));
    const btn = find.slice(0, find.indexOf('</button>'));
    // NEXT-FAV-COLD-001 (owner, 2026-11-23): "should work without a starting song and with no songs in queue" —
    // only a run in progress, or an engine that has not loaded, stops the press.
    expect(btn).toMatch(/disabled=\{running \|\| !loaded\}/);
    expect(btn).toMatch(/onClick=\{findNext\}/);
    // with no starting songs, Find runs the saved custom discovery choices
    expect(app).toMatch(/const findNext = \(\) => \{ if \(!seeds\.length && customSet\) void runCustom\(readCustom\(customDefaults\)\); else void run\(\); \};/);
    expect(app).toMatch(/const customSet = hasCustomChoices\(readCustom\(customDefaults\)\)/);
  });

  it('the “Your last now playing queue” note is gone', () => {
    expect(src('App.tsx')).not.toMatch(/Your last now playing queue/);
  });

  it('the ready-locally card has no border', () => {
    expect(rule(src('list-availability.css'), '.list-availability')).toMatch(/border:\s*0/);
  });

  it('the queue shows a small grey “loaded of found” line above it instead of the download bar', () => {
    const app = src('App.tsx');
    expect(app).not.toMatch(/<ListDownloadBar tracks=\{queueTracks\}/);
    const note = app.indexOf('<ListLoadedNote tracks={queueTracks}');
    expect(note).toBeGreaterThan(0);
    expect(note).toBeLessThan(app.indexOf('<div className="queue__head">'));
    const r = rule(src('discover-tidy.css'), '.queue__loaded');
    expect(r).toMatch(/font-size:\s*12px/);
    expect(r).toMatch(/color:\s*var\(--ink-3\)/);
  });

  it('the heading counts each song once, as the line does (a starting song also found by discovery counted twice)', () => {
    const app = src('App.tsx');
    expect(app).toMatch(/Now playing queue <span className="count">\{queueSongCount\}<\/span>/);
    expect(app).toMatch(/const queueSongCount = useMemo\(\(\) => new Set\(queueTracks\.map\(\(t\) => t\.key\)\)\.size/);
    expect(app).not.toMatch(/Now playing queue <span className="count">\{visibleSeeds\.length \+ items\.length\}/);
  });

  it('the line counts the queue’s songs that are loaded', () => {
    render(<ListLoadedNote tracks={[{ key: 'a' } as Track]} />);
    expect(screen.getByRole('status').textContent).toBe('41 of 63 songs loaded');
    expect(screen.getByRole('status').className).toBe('queue__loaded');
  });

  it('nothing is shown for an empty queue', () => {
    const { container } = render(<ListLoadedNote tracks={[]} />);
    expect(container.textContent).toBe('');
  });
});
