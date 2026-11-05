// @vitest-environment node
/*
 * DL-GRADIENT-001 — the downloader visualizers read blue -> green across the whole track.
 *
 * One web bundle ships inside the APK and the Windows package, so a single rule covers both
 * platforms; the device checks in scripts/check-download-gradient.mjs measure the rendered pixels.
 *
 * The gradient is painted on a full-width layer and revealed by clip-path, NOT by sizing the layer
 * to the ready fraction. A gradient sized to the fill squeezes blue->green into whatever is ready,
 * so 10% ready and 100% ready would both end green and the colour would carry no information.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const read = (name: string) => readFileSync(join(here, name), 'utf8');
const block = (css: string, selector: string) => {
  const at = css.indexOf(selector);
  expect(at, `${selector} must exist`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf('}', at) + 1);
};

describe('DL-GRADIENT-001', () => {
  /**
   * LIST-METER-003, from the owner: "get rid of the black outline around the download visualizer".
   * The shared .meter carries a dark inset shadow that draws a hard dark edge round the bar; on a
   * download meter that frames the gradient and reads as a border. The Settings capacity meter keeps
   * its own look, exactly as it keeps --gel-thumb, because filling that one up is a warning.
   */
  it('draws no dark edge around a download meter', () => {
    const css = read('styles.css');
    const dl = block(css, '.meter--dl {');
    expect(dl, '.meter--dl needs its own block to clear the inherited edge').toMatch(/box-shadow\s*:\s*none/);
    expect(dl).not.toMatch(/border\s*:\s*\d/);
  });

  it('leaves no dark edge on the list availability meter either', () => {
    const css = read('list-availability.css');
    const meter = block(css, '.list-availability__meter {');
    expect(meter).not.toMatch(/border\s*:/);
    expect(meter).not.toMatch(/box-shadow\s*:\s*inset[^;]*rgba\(0,\s*0,\s*0/);
  });

  it('defines one shared blue -> green pair of tokens', () => {
    const css = read('styles.css');
    const root = block(css, ':root {');
    expect(root).toMatch(/--dl-from:\s*#[0-9a-f]{6}/i);
    expect(root).toMatch(/--dl-to:\s*#[0-9a-f]{6}/i);
    const from = root.match(/--dl-from:\s*(#[0-9a-f]{6})/i)?.[1] ?? '';
    const to = root.match(/--dl-to:\s*(#[0-9a-f]{6})/i)?.[1] ?? '';
    const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const [fr = 0, fg = 0, fb = 0] = rgb(from);
    const [tr = 0, tg = 0, tb = 0] = rgb(to);
    expect(fb, `${from} must be blue: blue channel highest`).toBeGreaterThan(fr);
    expect(fb).toBeGreaterThan(fg);
    expect(tg, `${to} must be green: green channel highest`).toBeGreaterThan(tr);
    expect(tg).toBeGreaterThan(tb);
  });

  it('paints the list availability meter left-to-right over the full track, clipped to what is ready', () => {
    const css = read('list-availability.css');
    const fill = block(css, '.list-availability__meter > span {');
    expect(fill).toMatch(/background:\s*linear-gradient\(\s*to right\s*,\s*var\(--dl-from\)[^)]*,\s*var\(--dl-to\)/);
    expect(fill).toMatch(/width:\s*100%/);
    expect(fill).toMatch(/clip-path:\s*inset\(0 calc\(100% - var\(--available\)\) 0 0\)/);
    // A fill sized to the ready fraction would rescale the gradient on every change.
    expect(fill).not.toMatch(/width:\s*var\(--available\)/);
  });

  it('paints the per-download progress bar with the same gradient', () => {
    const css = read('styles.css');
    // Scoped to .meter--dl: the Settings storage meter shares .meter, and a capacity meter must not
    // turn green as it fills up — approaching the cache limit is a warning, not a success.
    const fill = block(css, '.meter--dl span {');
    expect(fill).toMatch(/background:\s*linear-gradient\(\s*to right\s*,\s*var\(--dl-from\)[^)]*,\s*var\(--dl-to\)/);
    expect(fill).toMatch(/width:\s*100%/);
    expect(fill).toMatch(/clip-path:\s*inset\(0 calc\(100% - var\(--fill[^)]*\)\) 0 0\)/);
  });

  it('paints the per-song row rail with the same gradient while a song is downloading', () => {
    const css = read('styles.css');
    const rail = block(css, '.rec__dl-rail {');
    expect(rail).toMatch(/background:\s*linear-gradient\(\s*to right\s*,\s*var\(--dl-from\)[^)]*,\s*var\(--dl-to\)/);
    expect(rail).toMatch(/width:\s*100%/);
    expect(rail).toMatch(/clip-path:\s*inset\(0 calc\(100% - var\(--dl[^)]*\)\) 0 0\)/);
  });

  it('keeps the download job meter and the storage meter visually distinct', () => {
    expect(read('Downloads.tsx')).toMatch(/className="meter meter--dl"/);
    expect(read('Settings.tsx')).not.toMatch(/meter--dl/);
  });
});
