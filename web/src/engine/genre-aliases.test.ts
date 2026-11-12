import { describe, expect, it } from 'vitest';
import { classify } from './classify';
import { makeTag } from './genres';
import type { Tag } from './genres';

/**
 * ALBUM-GENRE-DETAIL-001, correctness half. Owner: "album tag / genre & sub genre classification is
 * detailed and correct."
 *
 * Detail is only worth having when it is true. Two aliases in the table put albums in the wrong
 * place: "gangsta rap" is not by itself West Coast / G-funk (Ken Carson's A Great Chaos is Atlanta
 * rage), and "hardcore hip hop" is not conscious or jazz rap. A word that names no subgenre we can
 * stand behind must leave the song in its family rather than borrow a neighbouring cell.
 */
const place = (word: string) => {
  const tag = makeTag(word, 'test', 'album', 0.6);
  const c = tag ? classify([tag] as Tag[], null) : null;
  return c ? { family: c.family, sub: typeof c.subgenre === 'string' ? c.subgenre : (c.subgenre as { name?: string } | null)?.name ?? null } : null;
};

describe('a cell holds only the records it is named for', () => {
  it('does not call a Chicago drill record NY drill', () => {
    // The picker's drill cell is the NY one (Pop Smoke, Fivio, Ice Spice) with its own tempo range.
    // One 'chicago drill' tag on Ken Carson's More Chaos was enough to label it NY & Brooklyn drill.
    const p = place('chicago drill');
    expect(p?.family).toBe('Hip-hop');
    expect(p?.sub ?? '').not.toMatch(/NY|Brooklyn/i);
  });

  it('still places the drill the cell is for', () => {
    expect(place('brooklyn drill')?.sub).toMatch(/NY \/ Brooklyn drill/);
    expect(place('ny drill')?.sub).toMatch(/NY \/ Brooklyn drill/);
    expect(place('uk drill')?.sub).toBe('UK drill');
  });
});

describe('words that must not be given the wrong subgenre', () => {
  it('leaves gangsta rap in hip-hop without calling it West Coast', () => {
    const p = place('gangsta rap');
    expect(p?.family).toBe('Hip-hop');
    expect(p?.sub ?? '').not.toMatch(/West Coast/i);
  });

  it('leaves hardcore hip hop in hip-hop without calling it conscious or jazz rap', () => {
    const p = place('hardcore hip hop');
    expect(p?.family).toBe('Hip-hop');
    expect(p?.sub ?? '').not.toMatch(/Conscious|jazz/i);
  });

  it('still places the words that really do name those subgenres', () => {
    expect(place('g-funk')?.sub ?? '').toMatch(/West Coast/i);
    expect(place('west coast hip hop')?.sub ?? '').toMatch(/West Coast/i);
    expect(place('jazz rap')?.sub ?? '').toMatch(/Conscious/i);
    expect(place('conscious hip hop')?.sub ?? '').toMatch(/Conscious/i);
  });

  it('keeps the subgenres this record really carries', () => {
    expect(place('cloud rap')?.sub ?? '').toMatch(/Cloud/i);
    expect(place('rage')?.sub ?? '').toMatch(/Rage/i);
    expect(place('trap')?.sub ?? '').toMatch(/Trap/i);
  });
});
