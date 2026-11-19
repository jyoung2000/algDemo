// PLAYER-BIG-001 (owner, 2026-11-19: "make the player taller and bigger and ensure the volume popup doesnt
// get cut off"). The desktop bar no longer clips what opens out of it, the volume card opens up and to the
// left of its icon (it sits at the bar's right end), and the bar's parts grow with the window.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./player-big.css', import.meta.url), 'utf8');
const player = readFileSync(new URL('./Player.tsx', import.meta.url), 'utf8');
const block = (sel: string) => {
  const i = css.indexOf(`${sel} {`);
  expect(i, sel).toBeGreaterThan(-1);
  return css.slice(i, css.indexOf('}', i));
};

describe('the desktop player is bigger and the volume card is never cut off', () => {
  it('is loaded after the earlier player rules', () => {
    expect(player.indexOf("import './player-big.css'")).toBeGreaterThan(player.indexOf("import './player-inline.css'"));
  });
  it('the bar does not clip the volume card', () => {
    expect(block('.np.np--panel')).toMatch(/overflow:\s*visible/);
  });
  it('the volume card is anchored to the right of its icon on the bar', () => {
    const pop = block('.np.np--panel .vol__pop');
    expect(pop).toMatch(/right:\s*-?\d+px/);
    expect(pop).toMatch(/left:\s*auto/);
    expect(pop).toMatch(/transform:\s*none/);
  });
  it('the cover, title, play disc and progress bar are larger than before (64px, 14px, 44px, 4px)', () => {
    expect(block('.np.np--panel .np__main .art')).toMatch(/clamp\(64px, [\d.]+vw, (8\d|9\d|1\d\d)px\)/);
    expect(block('.np.np--panel .np__title')).toMatch(/font-size:\s*clamp\(14px, [\d.]+vw, 1[6-9]px\)/);
    expect(block('.np.np--panel .tbtn.tbtn--main')).toMatch(/width:\s*clamp\(44px, [\d.]+vw, 5\dpx\)/);
    expect(block('.np.np--panel .prog__bar')).toMatch(/height:\s*6px/);
  });
});
