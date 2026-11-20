// @vitest-environment happy-dom
// TAG-STRIP-001 (owner, 2026-11-19): "on the discover, radio, and saved music sections only show 1-2 tags at a time
// depending on screen space, the tags should be inline and scroll or marquis through all tags if it goes past 2 tags".
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TagStrip, twoTagCap } from './TagStrip';

const src = (f: string) => readFileSync(resolve(process.cwd(), 'src', f), 'utf8');
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); });

describe('the tag strip', () => {
  it('is one line: every tag inside one marquee, never wrapped', async () => {
    const host = document.createElement('div'); document.body.append(host);
    await act(async () => createRoot(host).render(<TagStrip className="rec__facts">{['Hip-hop', 'Trap', 'NY drill', 'Chicago drill', 'Chicago rap'].map((t) => <span key={t} className="genre">{t}</span>)}</TagStrip>));
    const strip = host.querySelector('.tag-strip.rec__facts')!;
    expect(strip.getAttribute('aria-label')).toBe('Song details');
    expect(strip.querySelectorAll(':scope > .mq > .mq__inner > .genre')).toHaveLength(5);
    const css = src('tag-strip.css');
    expect(css).toMatch(/\.tag-strip \.mq__inner \{[^}]*display: inline-flex;[^}]*flex-wrap: nowrap;/);
    expect(css).toMatch(/max-width: min\(100%, var\(--tag-cap, 100%\)\)/);
  });
  it('is as wide as the first two tags; a third or more glides into view', () => {
    const rect = (left: number, right: number) => ({ left, right }) as DOMRect;
    expect(twoTagCap([rect(10, 70), rect(78, 120), rect(128, 200)])).toBe(110);
    expect(twoTagCap([rect(10, 70), rect(78, 120)])).toBeNull(); // two fit as they are
    expect(twoTagCap([])).toBeNull();
  });
  it('Discover, Saved, Radio rows, the radio player and search rows all use it', () => {
    expect(src('Results.tsx').match(/<TagStrip className="rec__facts"/g)).toHaveLength(2);
    expect(src('SavedView.tsx')).toMatch(/<TagStrip className="rec__facts list-strip__facts">/);
    expect(src('RowGenres.tsx')).toMatch(/<TagStrip className="rec__facts list-strip__facts">/);
    expect(src('Radio.tsx')).toMatch(/<TagStrip className="radio-station__tags"/);
    expect(src('RadioPlayer.tsx')).toMatch(/<TagStrip className="radio-player__tags"/);
  });
});
