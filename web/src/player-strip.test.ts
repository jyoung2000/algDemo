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

  it('reserves a dock fallback height, then measures the real dock at runtime', () => {
    // The CSS value is only the first paint's estimate: App.tsx measures .np--docked and sets --dock-h,
    // because the dock's rows wrap differently by width, language and whether a song is playing.
    expect(css).toMatch(/@media \(max-width: 899px\) \{\s*\/\* Docked player[^}]*:root \{\s*--dock-h: 150px;/);
    const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
    expect(app).toMatch(/querySelector<HTMLElement>\('\.np--docked'\)/);
    expect(app).toMatch(/setProperty\('--dock-h', `\$\{dock\.offsetHeight\}px`\)/);
    expect(app).toMatch(/new ResizeObserver\(set\)/);
  });

  it('fixes the desktop player to the bottom of the window and leaves room under the list', () => {
    expect(css).toMatch(/@media \(min-width: 900px\) \{\s*\.rail \{[^}]*position: fixed;[^}]*bottom: 0;/);
    expect(css).toMatch(/\.app\.has-strip \{\s*padding-bottom:/);
  });

  it('keeps the phone dock inside the viewport: slim volume, always-visible playhead on touch (NP-STRIP-004)', () => {
    // The dock is one column: progress on a full row, then transport and volume that may shrink, never push past the edge.
    expect(css).toMatch(/\.np--docked \.np__dockctl \{[^}]*grid-template-columns: minmax\(0, 1fr\);/);
    expect(css).toMatch(/\.np__controls \.vol \{[^}]*flex: 1 1 auto;[^}]*min-width: 96px;/);
    // The volume channel is 4px; the touch area is padding, not a fat bar. 10px each side gives a
    // 24px hit box — the old 20px made a 44px-tall slider that dwarfed its own 4px channel.
    expect(css).toMatch(/\.np--docked \.vol__bar \{[^}]*height: 4px;[^}]*max-width: 72px;[^}]*padding: 10px 0;/);
    // Both sliders carry the Aqua gel thumb, so the volume has a draggable head like the progress bar.
    expect(css).toMatch(/\.vol__bar::-webkit-slider-thumb,\s*\.prog__bar::-webkit-slider-thumb \{/);
    expect(css).toMatch(/\.np--docked \.vol__bar::-webkit-slider-thumb \{\s*width: 12px;\s*height: 12px;/);
    // The volume carries .prog__bar too, so the "hidden until you hover .prog" rule used to hide its
    // head as well. Measured on the desktop app: no knob was drawn. It is now always shown.
    expect(css).toMatch(/\.np \.vol__bar::-webkit-slider-thumb \{\s*opacity: 1;/);
    // A touch screen has no hover: the playhead is drawn always, 18px, on a tall touch area.
    expect(css).toMatch(/@media \(hover: none\), \(pointer: coarse\) \{\s*\.np \.prog__bar \{[^}]*padding: 12px 0;/);
    expect(css).toMatch(/\.np \.prog__bar::-webkit-slider-thumb \{\s*width: 18px;\s*height: 18px;\s*opacity: 1;/);
  });
});
