import { familyColor, subColorOf } from './engine/genre-palette';
import { FAMILIES, SUBS } from './engine/genre-table';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The song cards in the discovery list are styled in styles.css and built in Results.tsx. These checks read
// both so a change that brings back the wrapped action row, the flat title/artist hierarchy, the art floating
// below its own title, or the glossy slider track fails here.
// Design sources: Fable (.card/.card__top/.icon-btn) and Astra (56px list artwork, 44px targets, one accent).
const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, 'styles.css'), 'utf8');
const results = readFileSync(join(here, 'Results.tsx'), 'utf8');

describe('the song card (SONG-CARD-001)', () => {
  it('never cuts off a title with its features, in the played log either', () => {
    // Found on the Android emulator: the "Last N played" entry
    // "Mamacita (feat. Rich Homie Quan & Young Thug) — Travis Scott" measured 363px in a 367px
    // box and ellipsised, which breaks the owner's rule that a title and its "artist & features"
    // must never be cut off. It wraps instead; it already owns a full row on a phone.
    const plog = /\.plog__what \{([^}]+)\}/.exec(css)?.[1] ?? '';
    expect(plog, 'the played-log entry must not be a single clipped line').not.toMatch(/white-space: nowrap/);
    expect(plog).not.toMatch(/text-overflow: ellipsis/);
    expect(plog, 'a long unbroken title still has to fit its box').toMatch(/overflow-wrap: anywhere/);
  });

  it('uses slightly larger, borderless genre and subgenre pills', () => {
    const genre = /\.genre \{([^}]+)\}/.exec(css)?.[1] ?? '';
    expect(genre).toMatch(/font-size: 11px;/);
    expect(genre).toMatch(/line-height: 18px;/);
    expect(genre).toMatch(/padding: 1px 8px;/);
    expect(genre).toMatch(/border: 0;/);
    expect(genre).toMatch(/background: color-mix\([^;]+var\(--tone/);
    // TAGS-COLOR-001: enough of the colour that a subgenre reads apart from its family.
    expect(genre).toMatch(/var\(--tone, var\(--accent\)\) 45%/);
    expect(/\.genre::before \{([^}]+)\}/.exec(css)?.[1] ?? '').toMatch(/width: 10px;[^}]*height: 10px;/);
  });

  it('keeps bubble text at 4.5:1 or better on every genre colour at the bubble’s tint (TAGS-COLOR-001)', () => {
    const tint = Number(/var\(--tone, var\(--accent\)\) (\d+)%/.exec(css)?.[1]) / 100;
    const rgb = (h: string) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
    const lum = (c: number[]) => { const t = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * t[0]! + 0.7152 * t[1]! + 0.0722 * t[2]!; };
    const pearl = rgb('#efeee9'), ink = lum(rgb('#161616'));
    for (const hex of [...FAMILIES.map((f) => familyColor(f.slug)), ...SUBS.map((x) => subColorOf(x.key)!)]) {
      const bg = lum(rgb(hex).map((v, i) => Math.round(v * tint + pearl[i]! * (1 - tint))));
      expect((Math.max(ink, bg) + 0.05) / (Math.min(ink, bg) + 0.05), hex).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('puts every control on one line: play, like, dislike, download, remove, why', () => {
    // nowrap is the whole point: with wrap, "Why this song?" dropped to a second row on a phone.
    expect(css).toMatch(/\.rec__actions \{[^}]*flex-wrap: nowrap;/);
    // The row must still never push the page sideways, so the one flexible child absorbs the squeeze.
    expect(css).toMatch(/\.rec__actions \{[^}]*min-width: 0;/);
  });

  it('keeps the six controls in the markup order the owner asked for', () => {
    const actions = results.slice(results.indexOf('<div className="rec__actions">', results.indexOf('items.map')));
    const order = ['Play', 'Like', 'Dislike', 'Download', 'Hide', 'Why this song?'];
    let at = -1;
    for (const label of order) {
      const next = actions.indexOf(label, at + 1);
      expect(next, `${label} should follow the previous control`).toBeGreaterThan(at);
      at = next;
    }
  });

  it('draws the icon controls as circles that keep the full 44px touch height', () => {
    // 36px wide (Fable's painted icon button) and a real 44px tall. The 8px extra height is
    // carried by transparent top and bottom BORDERS over an explicit content box, so the
    // painted chrome is the 36x36 content box only: background-clip keeps the fill there and
    // the 999px radius clamps to a true circle, while the border area still takes the tap.
    // An ::after overlay was measured and does NOT work: adjacent buttons' inflated areas
    // steal each other's hits (41px at best, 36px at a 4px gap).
    const rec = /\.rec__actions \.iconbtn,\s*\.track__actions \.iconbtn \{([^}]+)\}/.exec(css)?.[1] ?? '';
    expect(rec).toMatch(/box-sizing: content-box;/);
    expect(rec).toMatch(/width: 36px;/);
    expect(rec).toMatch(/height: 36px;/);
    expect(rec).toMatch(/border: 4px solid transparent;/);
    expect(rec).toMatch(/border-left-width: 0;/);
    expect(rec).toMatch(/border-right-width: 0;/);
    expect(rec).toMatch(/background-clip: content-box;/);
    expect(rec).toMatch(/border-radius: 999px;/);
    // No square or softly-rounded corners left anywhere, phone rules included.
    const iconRules = [...css.matchAll(/\.rec__actions \.iconbtn[^{}]*\{([^{}]*)\}/g)];
    for (const rule of iconRules) {
      expect(rule[1]).not.toMatch(/border-radius: (?!999px)/);
      // The ring is drawn inside the padding box, so hover and pressed must not colour the
      // transparent border: a 4px coloured band would reappear above and below the circle.
      if (/border-color/.test(rule[1] ?? '')) expect(rule[1]).toMatch(/border-color: transparent;/);
    }
    expect(css).toMatch(/\.rec__actions \.iconbtn:hover[^{]*\{[^}]*border-color: transparent;/);
    expect(css).toMatch(/\.rec__actions \.iconbtn,\s*\.track__actions \.iconbtn \{[^}]*box-shadow: inset 0 0 0 1px/);
    expect(css).not.toMatch(/\.rec__actions \.iconbtn::after/);
    // The why pill shares the row, so it must be the same height to tap reliably.
    expect(css).toMatch(/\.rec__actions \.whybtn \{\s*min-height: 44px;/);
  });

  it('gives the title a bigger, tighter face than the artist under it', () => {
    expect(css).toMatch(/\.rec__title \{[^}]*font-size: 15px;/);
    expect(css).toMatch(/\.rec__title \{[^}]*letter-spacing: -0\.01em;/);
    expect(css).toMatch(/\.rec__artist \{[^}]*font-size: 13px;[^}]*font-weight: 500;/);
  });

  it('wraps the complete title and artist/features at every width without clipping', () => {
    const identity = /\.rec__title,\s*\.rec__artist \{([^}]+)\}/.exec(css)?.[1] ?? '';
    expect(identity).toMatch(/white-space: normal;/);
    expect(identity).toMatch(/overflow-wrap: anywhere;/);
    // Inspect every matching rule, including media overrides: the old phone clamp also hid text.
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) =>
      m[1]?.split(',').some((selector) => /^\.rec__(title|artist)$/.test(selector.trim())),
    );
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule[2]).not.toMatch(
        /overflow(?:-x|-y)?:\s*(?:hidden|clip)|text-overflow:\s*ellipsis|white-space:\s*nowrap|line-clamp|(?:^|[;{\s])(?:max-)?height:\s*\d/,
      );
    }
    expect(results).toContain('{s.title}');
    expect(results).toContain('{t.title}');
    expect(results).toContain('{artistOf(s)}');
    expect(results).toContain('{artistOf(t)}');
  });

  it('levels the artwork with the title and artist, not with the whole row', () => {
    // Title and artist share row 1 with the art; the secondary line and the actions sit below it.
    expect(css).toMatch(
      /\.rec \{[^}]*grid-template-areas:\s*'rank art text tier dur'\s*'\. \. sub sub sub'\s*'\. \. actions actions actions';/,
    );
    expect(css).toMatch(/\.rec__rank \{[^}]*align-self: center;/);
    expect(css).toMatch(/\.rec__art \{[^}]*align-self: center;/);
    expect(css).toMatch(/\.rec__text \{[^}]*align-self: center;/);
  });

  it('keeps the rank beside the cover and title on a phone, only in their row', () => {
    // The point is the rank's POSITION, not one exact set of areas: it belongs in the first row
    // next to the artwork and title, and must not be given a cell in any row below.
    const phone = css.slice(css.indexOf('@media (max-width: 899px)'));
    const rule = /\.rec \{\s*grid-template-columns: ([^;]+);\s*grid-template-areas:\s*((?:'[^']*'\s*)+)/.exec(phone);
    if (!rule) throw new Error('the phone .rec rule should declare grid-template-columns and -areas');
    const rows = (rule[2] ?? '').match(/'[^']*'/g) ?? [];
    const cells = rows.map((r) => r.slice(1, -1).trim().split(/\s+/));
    expect(cells[0], 'the rank shares the first row with the art and the title').toEqual(['rank', 'art', 'text', 'dur']);
    for (const row of cells.slice(1)) expect(row, 'no row below may claim the rank').not.toContain('rank');
    // It must still be drawn: hiding it was the old phone behaviour the owner asked to change.
    expect(css).not.toMatch(/\.rec__rank \{[^}]*display: none;/);
  });

  it('names every placed child in the phone areas, so no implicit column steals the row', () => {
    // Leaving 'tier' out of the phone areas made the grid invent two extra columns. The action row
    // then spanned three of five and squeezed the why pill down to an icon's width.
    const phone = css.slice(css.indexOf('@media (max-width: 899px)'));
    const rule = /\.rec \{\s*grid-template-columns: ([^;]+);\s*grid-template-areas:\s*((?:'[^']*'\s*)+)/.exec(phone);
    if (!rule) throw new Error('the phone .rec rule should declare grid-template-columns and -areas');
    const columns = rule[1] ?? '';
    const areaText = rule[2] ?? '';
    // Count track definitions, not words: minmax(0, 1fr) is one track but contains a space.
    const columnCount = columns.trim().replace(/\([^)]*\)/g, '()').split(/\s+/).length;
    const rows = areaText.match(/'[^']*'/g) ?? [];
    expect(rows.length, 'the phone rule should name some rows').toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.slice(1, -1).trim().split(/\s+/), `${row} should name ${columnCount} columns`).toHaveLength(columnCount);
    }
    const named = new Set(rows.flatMap((r) => r.slice(1, -1).trim().split(/\s+/)));
    const placed = [...css.matchAll(/\.rec__\w+ \{[^}]*grid-area: (\w+);/g)].map((m) => m[1]);
    for (const area of placed) {
      expect(named, `${area} needs a cell in the phone areas`).toContain(area);
    }
  });

  it('carries the secondary line and tags in their own block, below the title', () => {
    expect(results).toMatch(/className="rec__sub"/);
    expect(css).toMatch(/\.rec__sub \{[^}]*grid-area: sub;/);
  });

  it('asks for artwork at the size Astra specifies for a list row', () => {
    expect(results).toMatch(/<Art src=\{[^}]*\} size=\{56\} \/>/);
    expect(css).toMatch(/\.rec__art \.art \{[^}]*width: 56px;[^}]*height: 56px;/);
  });

  it('keeps the why control readable when the row is narrow, and named in full for AT', () => {
    expect(results).toMatch(/aria-label=\{`Why \$\{t\.title\}\?`\}/);
    expect(results).toMatch(/className="whybtn__short"/);
    expect(css).toMatch(/\.whybtn \{[^}]*text-overflow: ellipsis;/);
    // Below 480px the phrase is replaced by "Why?" rather than ellipsised to nothing.
    expect(css).toMatch(/@media \(max-width: 480px\) \{\s*\.whybtn__full \{\s*display: none;/);
  });

  it('draws the familiar-to-adventurous track flat, with no inset shadow box', () => {
    const dial = css.slice(css.indexOf('.dial input,'), css.indexOf('.dial input::-webkit-slider-thumb'));
    expect(dial).not.toMatch(/box-shadow: inset/);
    expect(dial).toMatch(/box-shadow: none;/);
  });

  it('draws the card from the token accent and no Aqua gel', () => {
    // One chromatic colour, per Astra. The row keeps using the --accent token rather than a literal.
    expect(css).toMatch(/\.rec\.is-playing \.rec__title \{[^}]*color: var\(--accent\);/);
    const actions = css.slice(css.indexOf('.rec__actions {'), css.indexOf('.openlink {'));
    expect(actions).not.toMatch(/var\(--aqua-top\)|var\(--aqua-mid\)|radial-gradient/);
  });

  it('gives the reason line and tags the row’s width on a phone, not one column', () => {
    // Measured: confined to the text column the tag line had 170px for 497px of chips and wrapped
    // onto four lines, making rows 200-248px tall. Spanning the row takes it to two.
    const phone = css.slice(css.indexOf('@media (max-width: 899px)'));
    expect(phone).toMatch(/\.rec \{[^}]*'sub sub sub tier'/);
  });
});
