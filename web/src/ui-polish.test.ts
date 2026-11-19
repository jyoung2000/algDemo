// UI-POLISH-001 (owner, 2026-11-18): "ensure icons and text dont overlap ... when items overlap or
// appear off center it makes the app feel sloppy". Each rule here was found by measuring the live
// apps (Windows CDP and the Android WebView, 320-1164px, touch emulated); these checks keep the
// stylesheet from sliding back. The geometry itself is re-measured live, not in jsdom.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const read = (f: string) => readFileSync(join(here, f), 'utf8').replace(/\r\n/g, '\n');
const styles = read('styles.css');
const audio = read('audio-settings.css');
const credits = read('song-credits.css');
const lists = read('saved-lists.css');
const app = read('App.tsx');
/** The declarations of the last rule whose selector list is exactly `selector`. */
const rule = (css: string, selector: string): string => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&');
  const all = [...css.matchAll(new RegExp(`(?:^|\\n|\\})\\s*${esc}\\s*\\{([^}]*)\\}`, 'g'))];
  expect(all.length, `no rule for ${selector}`).toBeGreaterThan(0);
  return all[all.length - 1]![1]!;
};

describe('UI-POLISH-001 layout contract', () => {
  it('the equaliser preamp takes only its own width, so the ten bands are not pushed to one side', () => {
    // Measured before: at 1164px the Pre column was 394px wide and each band 37px, a wide empty gap.
    expect(rule(audio, '.eqr__band--preamp')).toMatch(/flex:\s*0 0 auto/);
  });

  it('a banner icon sits on the first line of its words, not between two wrapped lines', () => {
    // Measured before: icon centre 553px, first line centre 542px when the note wrapped at 768px.
    expect(rule(styles, '.banner')).toMatch(/align-items:\s*flex-start/);
    expect(rule(styles, '.banner:not(.banner--list) > .aqua-icon')).toMatch(/margin-top:\s*calc\(\(1lh - 14px\) \/ 2\)/);
  });

  it('the station star no longer sits in the name line, where it reached over the location (ROW-UNIFY-001)', () => {
    // Measured before UI-POLISH: the star's 44px box reached 7px into the location text. UI-MOOD-001
    // (owner, 2026-11-19) moved it into the row of buttons under the text, so the name line has none.
    expect(styles).not.toMatch(/\.radio-station__info > h2 > \.radio-station__star/);
  });

  it("the player's artist link does not reach up over the song title", () => {
    // Measured before (Android, 412px): the artist link's 6px-padded box began at 607.6px while the
    // title's letters ran to 611px, so a tap on the bottom of the title opened the artist page.
    const link = rule(credits, '.np__artist .artistlink');
    expect(link).toMatch(/margin:\s*0/);
    expect(link).toMatch(/padding:\s*2px 0/);
  });

  it('status notes and the saved-list banner keep their icon on the first line when they wrap', () => {
    // Measured before (Windows, 412px): the Lyrics filter's empty note had its icon 10.5px below the
    // first line, between the two lines of words.
    expect(rule(styles, '.state:not(:has(> button))')).toMatch(/align-items:\s*flex-start/);
    expect(rule(styles, '.state:not(:has(> button)) > svg:first-child')).toMatch(/margin-top:\s*calc\(\(1lh - 14px\) \/ 2\)/);
    // The list banner also holds a 44px button, so its icon moves into the words as a hanging indent.
    expect(app).toMatch(/<div className="banner banner--list" role="note">\s*<span>\s*<Glyph name="info"/);
    expect(rule(lists, '.banner--list > span')).toMatch(/text-indent:\s*-22px/);
  });

  it('the small icon before a row reason sits level with its words', () => {
    // Measured before (Android WebView, 412px): the starting-song star sat 2.1px above the words'
    // centre on the baseline; -2px brings it to 0.1px.
    expect(rule(styles, '.rec__why1 > svg')).toMatch(/vertical-align:\s*-2px/);
  });
});
