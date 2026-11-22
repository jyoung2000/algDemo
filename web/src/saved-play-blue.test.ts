// SAVED-PLAY-BLUE-001 (owner, 2026-11-22): "on the saved tab ensure the play button gets blue filled with the white fill
// button". The Saved list has its own, more specific selector for the white disc, and the blue "ready" rule did not name
// it, so a downloaded song there kept a white disc with a blue arrow. Every list the white rule names must be named by
// the ready rule and the playing rule too, at the same or higher specificity.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./song-row.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
/** The selectors of the rule whose list ends with `last` and whose body holds `has`. */
function selectorsOf(last: string, has: RegExp): string[] {
  const rule = new RegExp(`((?:[^{}]+,\\n)*${last.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}) \\{([^}]*)\\}`, 'g');
  for (let m = rule.exec(css); m; m = rule.exec(css)) if (has.test(m[2]!)) return m[1]!.split(',').map((s) => s.trim());
  throw new Error(`no rule ending ${last}`);
}

describe('a ready or playing Play button is blue on every list, the Saved tab included', () => {
  const base = selectorsOf('ul.radio-stations .radio-station__actions.song-actions .iconbtn.playbtn', /background-color: #fff/);
  it('finds the white disc rule, with the Saved list in it', () => {
    expect(base).toContain('ul.tracks--saved .track__actions .iconbtn.playbtn');
  });
  for (const state of ['data-ready', 'data-playing']) {
    it(`names every one of those lists for ${state}`, () => {
      const blue = selectorsOf(`ul.radio-stations .radio-station__actions.song-actions .iconbtn.playbtn[${state}='true']`, /background-color: var\(--accent\)/);
      for (const sel of base) expect(blue, sel).toContain(`${sel}[${state}='true']`);
    });
  }
});
