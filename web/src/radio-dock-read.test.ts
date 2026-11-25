// RADIO-DOCK-READ-001 / RADIO-STAR-ON-001 (owner, 2026-11-22): "On radio on android make the title and tag slots taller
// so their legible, everything on the radio player should be readable and nothing cut off, also when active make the
// star fill white". The layout is measured on the emulator; this pins the rules that give it.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./radio.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const block = css.slice(css.indexOf('/* RADIO-DOCK-READ-001'));
const phone = /@media \(max-width:760px\) \{([\s\S]*?)\n\}/.exec(block)?.[1] ?? '';
const rule = (sel: string) => new RegExp(`\\n ${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(phone)?.[1] ?? '';

describe('the phone radio player\u2019s words are readable and whole', () => {
  it('comes after the compact layout, so it is the one that applies', () => {
    expect(css.indexOf('/* RADIO-DOCK-READ-001')).toBeGreaterThan(css.indexOf('/* RADIO-DOCK-SIZE-001'));
    expect(rule('.np.radio-player .radio-player__main')).toMatch(/height:auto/);
    expect(rule('.np.radio-player .radio-player__identity')).toMatch(/grid-template-rows:none; grid-auto-rows:auto/);
  });
  it('gives the title a 16px line of its own and the genres their full-size bubbles', () => {
    expect(rule('.np.radio-player .radio-player__titleline strong')).toMatch(/font-size:16px; line-height:22px/);
    expect(rule('.np.radio-player .radio-player__tags .genre')).toMatch(/font-size:11\.5px; line-height:18px/);
    expect(rule('.np.radio-player .radio-player__tags')).toMatch(/min-height:22px/);
    expect(rule('.np.radio-player .radio-player__identity small')).toMatch(/font-size:12px; line-height:17px/);
  });
  it('keeps a long title, artist or place on one gliding line instead of stacking or cutting it with dots (RADIO-INLINE-MARQUEE-001)', () => {
    for (const sel of ['.np.radio-player .radio-player__titleline strong', '.np.radio-player .radio-player__song',
      '.np.radio-player .radio-player__identity > span:not(.radio-live):not(.radio-player__tags)', '.np.radio-player .radio-player__identity small']) {
      expect(rule(sel), sel).toMatch(/white-space:nowrap; overflow:hidden; text-overflow:clip; min-width:0/);
    }
    expect(phone).not.toMatch(/text-overflow:ellipsis|display:none|visibility:hidden/);
  });
});

describe('a starred station\u2019s heart is white on blue', () => {
  const rowStar = "ul.radio-stations .radio-station__actions.song-actions .iconbtn.radio-station__star[aria-pressed='true']";
  const on = /\n([^{}]*)\{ background:var\(--accent\); border-color:transparent; box-shadow:none; color:#fff; \}/.exec(block)?.[1] ?? '';
  it('in the player and in the station rows', () => {
    expect(on).toContain(".iconbtn.radio-player__starbtn[aria-pressed='true']");
    expect(block).toMatch(/\.iconbtn\.radio-station__star\[aria-pressed='true'\] svg path \{ fill:#fff; \}/);
    expect(block).toMatch(/\.iconbtn\.radio-player__starbtn\[aria-pressed='true'\]:hover:not\(:disabled\)/);
  });
  // Measured on the phone build: the row's heart went white while its disc stayed the pale blue of every other pressed
  // row icon, a white heart nobody could see. The station list's own pressed rule (song-row.css) is the stronger one,
  // so the blue has to be said at least as strongly, and after it.
  it('says the row\u2019s blue as strongly as the station list\u2019s own pressed rule', () => {
    const rows = readFileSync(new URL('./song-row.css', import.meta.url), 'utf8');
    expect(rows).toContain("ul.radio-stations .radio-station__actions.song-actions .iconbtn[aria-pressed='true']");
    expect(on.split(',').map((s) => s.trim())).toContain(rowStar);
    expect(block).toContain(`${rowStar}:hover:not(:disabled)`);
  });
});

describe('RADIO-INLINE-MARQUEE-001: the radio player\u2019s words glide instead of stacking', () => {
  const tsx = readFileSync(new URL('./RadioPlayer.tsx', import.meta.url), 'utf8');
  it('puts the title, the artists with the station, and the place each in a Marquee', () => {
    expect(tsx).toMatch(/<strong title=\{[^}]*\}><Marquee>/);
    expect(tsx).toContain('<span className="radio-player__credit"><Marquee>');
    expect(tsx).toContain('<b className="radio-player__station">{s.name}</b></Marquee></span>');
    expect(tsx).toContain('<small><Marquee>{stationLocation(s)}');
  });
  it('never lets the phone player wrap a line', () => {
    expect(phone).not.toMatch(/white-space:normal/);
  });
});
