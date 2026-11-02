import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The desktop player strip and the phone dock are styled in styles.css. These checks read the stylesheet
// so a change that brings back the overlap, the clipped phone title, or the non-Aqua slider fails here.
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'styles.css'), 'utf8');

describe('the player strip (NP-STRIP-001)', () => {
  it('keeps the desktop title column from reaching the progress column', () => {
    expect(css).toMatch(/\.np--panel \{[^}]*grid-template-areas: 'main prog vol' 'main tx links';/);
    expect(css).toMatch(/\.np--panel \.np__text \{[^}]*min-width: 0;[^}]*overflow: hidden;/);
  });

  it('gives the phone dock title real width under the 96px preview', () => {
    expect(css).toMatch(/\.np--docked \.np__embed \{\s*width: 96px;/);
    expect(css).toMatch(/\.np--docked \.np__text \{[^}]*flex: 1 1 0;/);
  });

  it('draws the player flat: no gradient gloss on the progress track or the play disc (flat redesign)', () => {
    expect(css).toMatch(/\.np \.prog__bar \{[^}]*height: 4px;[^}]*box-shadow: none;/);
    expect(css).toMatch(/\.np \.prog__bar \{[^}]*linear-gradient\(to right, #0071e3 var\(--pct, 0%\)/);
    expect(css).toMatch(/\.tbtn--main \{[^}]*background: #0071e3;/);
    expect(css).not.toMatch(/\.tbtn--main \{[^}]*var\(--aqua-top\)/);
  });

  it('shows the progress bar on the phone dock, above the controls', () => {
    expect(css).not.toMatch(/\.np--docked \.prog \{\s*display: none;/);
    expect(css).toMatch(/\.np--docked \.prog \{\s*width: 100%;/);
  });

  it('draws shuffle and repeat as small flat toggles, accent when on (NP-STRIP-002)', () => {
    expect(css).toMatch(/\.tbtn--mode \{[^}]*width: 32px;/);
    expect(css).toMatch(/\.tbtn--mode\.is-on \{[^}]*color: #0071e3;/);
  });

  it('gives the volume slider a finger- and mouse-sized hit area around its thin channel', () => {
    expect(css).toMatch(/\.vol__bar \{[^}]*padding: 8px 0;[^}]*background-clip: content-box;/);
  });

  it('stacks the docked controls on every docked width so five buttons fit', () => {
    expect(css).toMatch(/@media \(max-width: 899px\) \{\s*\/\* Docked player[^}]*:root \{\s*--dock-h: 132px;/);
  });

  it('fixes the desktop player to the bottom of the window and leaves room under the list', () => {
    expect(css).toMatch(/@media \(min-width: 900px\) \{\s*\.rail \{[^}]*position: fixed;[^}]*bottom: 0;/);
    expect(css).toMatch(/\.app\.has-strip \{\s*padding-bottom:/);
  });
});
