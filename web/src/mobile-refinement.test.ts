import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { historyStops } from './TasteHistory';
import type { Snapshot } from './taste-view';

const css = readFileSync(new URL('./mobile-refinement.css', import.meta.url), 'utf8');
const ticker = readFileSync(new URL('./GenreTicker.tsx', import.meta.url), 'utf8');
const actions = readFileSync(new URL('./PlayerActions.tsx', import.meta.url), 'utf8');
const history = readFileSync(new URL('./TasteHistory.tsx', import.meta.url), 'utf8');
const card = readFileSync(new URL('./SoundCard.tsx', import.meta.url), 'utf8');

const snap = (segs: { slug: string; share: number; label?: string; color?: string }[]): Snapshot => ({ t: 1, events: 3, segs });

describe('taste history is a blended field, not columns', () => {
  it('places each colour at the middle of its share so neighbours blend', () => {
    const stops = historyStops(snap([
      { slug: 'hip-hop', share: 0.5, color: '#a' },
      { slug: 'pop', share: 0.5, color: '#b' },
    ]));
    expect(stops.map((s) => s.color)).toEqual(['#a', '#b']);
    // Outer stops are pulled to the ends so no flat block reads as a box.
    expect(stops[0]!.at).toBeLessThanOrEqual(8);
    expect(stops[1]!.at).toBeGreaterThanOrEqual(92);
  });

  it('ignores zero and non-finite shares rather than drawing an invisible band', () => {
    const stops = historyStops(snap([
      { slug: 'hip-hop', share: 1, color: '#a' },
      { slug: 'pop', share: 0, color: '#b' },
      { slug: 'rock', share: Number.NaN, color: '#c' },
    ]));
    expect(stops).toHaveLength(1);
  });

  it('falls back to the family colour for updates saved before labels were recorded', () => {
    expect(historyStops(snap([{ slug: 'hip-hop', share: 1 }]))[0]!.color).toMatch(/^(#|hsl|oklch|rgb)/);
  });

  it('blurs across columns and keeps the exact shares in a readout, not in the picture', () => {
    expect(history).toMatch(/feGaussianBlur/);
    expect(history).toContain('Blended colours; exact saved shares below.');
    expect(history).toMatch(/Math\.round\(s\.share \* 100\)/);
  });

  it('lets the user inspect an update, and follows the newest state until they do', () => {
    expect(history).toMatch(/type="range"/);
    expect(history).toMatch(/aria-label="Inspect taste history"/);
    expect(history).toMatch(/useState<number \| null>\(null\)/);
  });
});

describe('the Your sound header shows one genre at a time, strongest first', () => {
  it('reads the ordered rows and starts at the strongest', () => {
    expect(card).toContain('<GenreTicker entries={view?.leaves ?? []} />');
    expect(ticker).toMatch(/useState\(0\)/);
    expect(ticker).toMatch(/\(i \+ 1\) % entries\.length/);
  });

  it('holds still for reduced motion, a hidden tab, hover, focus or a pause press', () => {
    expect(ticker).toMatch(/prefers-reduced-motion: reduce/);
    expect(ticker).toMatch(/const still = paused \|\| focused \|\| hovered \|\| hidden \|\| reduced;/);
    expect(ticker).toMatch(/if \(still \|\| entries\.length < 2\) return;/);
  });

  it('restarts at the strongest genre when the mix itself changes', () => {
    expect(ticker).toMatch(/useEffect\(\(\) => setIndex\(0\), \[signature\]\)/);
  });
});

describe('the player carries like, dislike and download for the song playing', () => {
  it('labels each control and shows which are on', () => {
    for (const label of ['Like this song', 'Dislike this song', 'Download this song']) expect(actions).toContain(label);
    expect(actions).toMatch(/aria-pressed=\{Boolean\(flags\.like\)\}/);
  });

  it('cannot fire twice at once and says so when a request fails', () => {
    expect(actions).toMatch(/if \(pending\.current\) return;/);
    expect(actions).toContain('Could not save. Try again.');
    expect(actions).toContain('Download failed. Open Downloads to retry.');
  });

  it('turns into a way to see the file once the download is running or done', () => {
    expect(actions).toMatch(/downloadState === 'done' \|\| downloadState === 'working'/);
    expect(actions).toMatch(/name=\{downloadState === 'done' \? 'check' : 'download'\}/);
  });
});

describe('the controls are flat and reachable', () => {
  it('gives every quiet control a 44px target, no gloss and a visible press', () => {
    expect(css).toMatch(/\.quiet-control \{[^}]*min-width: 44px;[^}]*min-height: 44px;/);
    expect(css).toMatch(/\.quiet-control \{[^}]*background: transparent;/);
    expect(css).toMatch(/\.quiet-control:active:not\(:disabled\) \{[^}]*transform: scale\(0\.94\);/);
    expect(css).toMatch(/\.quiet-control:focus-visible \{[^}]*outline: 2px solid var\(--focus\);/);
  });

  it('keeps the phone action buttons inside the dock row', () => {
    expect(css).toMatch(/@media \(max-width: 899px\) \{[\s\S]*?\.np--docked \.np__track-actions \{[^}]*flex: none;/);
  });

  it('drops the panel around the search sliders on a phone only', () => {
    expect(css).toMatch(/@media \(max-width: 899px\) \{\s*\.go \{[^}]*box-shadow: none;/);
  });

  it('stops its own animations when the user asks for less motion', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*animation: none;/);
  });
});
