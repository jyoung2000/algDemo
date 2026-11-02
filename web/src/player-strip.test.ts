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

  it('draws the sliders in the Aqua blue and the glossy thumb', () => {
    expect(css).toMatch(/\.np \.prog__bar \{[^}]*var\(--aqua-top\)/);
    expect(css).toMatch(/\.np \.prog__bar::-webkit-slider-thumb \{/);
    expect(css).toMatch(/\.tbtn--main \{[^}]*var\(--aqua-top\)/);
  });
});
