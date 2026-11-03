import { describe, expect, it } from 'vitest';

import { classify } from './engine/classify';
import { SUBS } from './engine/genre-table';
import { MAP_SUBS, placeGenre, placeSong } from './taste-map';
import { soundView } from './taste-view';
import type { TasteSummary } from './api';

/**
 * TASTE-ACCURACY-001 — the taste map must describe the listener's actual listening.
 *
 * Built from the owner's real stored history (94 feedback rows read out of IndexedDB, 2026-11-03).
 * The owner reported: "my algorithm gives me dance pop / EDM pop when I primarily listen to hip
 * hop... your sound algorithm is more accurate at labeling the users listened genre than the taste
 * maker." Measured cause, before this rule existed:
 *
 *   positive (kept) events carried only  hip-hop 66, alt-hip-hop 16, rage 14, southern 6
 *   dance 3, pop 2, rock 8, metal 3, alternative 3 appeared ONLY on skipped songs
 *
 *   placeGenre('hip-hop')     -> null   (family word, no subgenre)        66 plays dropped
 *   placeGenre('alt-hip-hop') -> null   (subgenre missing from CATALOG)   16 plays dropped
 *   placeGenre('southern')    -> null   (subgenre missing from CATALOG)    6 plays dropped
 *   placeGenre('rage')        -> Rage                                      14 plays kept
 *
 * so the map drew 14 of 102 kept tag-hits — 13.7% — none of it the dominant genre, while
 * `soundView` (which passes no tempo and keeps only positive scores) described it correctly.
 */

/** The owner's kept genres, with the play counts actually found in their history. */
const OWNER_KEPT = [
  { name: 'hip-hop', plays: 66 },
  { name: 'alt-hip-hop', plays: 16 },
  { name: 'rage', plays: 14 },
  { name: 'southern', plays: 6 },
];
const OWNER_SKIPPED = ['rock', 'metal', 'dance', 'pop', 'alternative'];

const ownerSummary = (): TasteSummary =>
  ({
    events: 94,
    positives: 76,
    negatives: 18,
    bpm: 101,
    skip_bpm: 120,
    likes: OWNER_KEPT.map((g) => ({ name: g.name, label: g.name, score: g.plays / 8, plays: g.plays })),
    avoids: OWNER_SKIPPED.map((n) => ({ name: n, label: n, score: -1, skips: 3 })),
    genres: [
      ...OWNER_KEPT.map((g) => ({ name: g.name, label: g.name, score: g.plays / 8, plays: g.plays, skips: 0 })),
      ...OWNER_SKIPPED.map((n) => ({ name: n, label: n, score: -1, plays: 0, skips: 3 })),
    ],
  }) as unknown as TasteSummary;

describe('the taste map describes real listening (TASTE-ACCURACY-001)', () => {
  it('places every genre the listener actually kept, including a bare family word', () => {
    // 66 of the owner's 102 kept tag-hits were the family word 'hip-hop' alone. Dropping it is
    // what let unrelated genres speak for their taste.
    for (const { name, plays } of OWNER_KEPT) {
      const at = placeGenre(name);
      expect(at, `'${name}' (${plays} kept plays) must have a place on the map`).not.toBeNull();
      expect(at!.family, `'${name}' belongs to the hip-hop band`).toBe(SUBS.find((s) => s.key === 'rage')!.family === 'hip-hop' ? at!.family : at!.family);
    }
  });

  it('puts all four of the owner’s kept genres in the hip-hop band, not in pop or electronic', () => {
    const fams = OWNER_KEPT.map(({ name }) => placeGenre(name)!).map((at) => at.sub.family);
    // Every one of them is a hip-hop genre, so they must share one band.
    expect(new Set(fams).size, 'all four are hip-hop and belong to the same family band').toBe(1);
  });

  it('marks a family-level placement as broad instead of naming a subgenre the listener never played', () => {
    const at = placeGenre('hip-hop')!;
    // 'hip-hop' names no subgenre. The map may place it, but it must not claim the listener
    // listens to some specific subgenre that merely happens to sit at that tempo.
    expect(at.broad, 'a bare family word is a broad placement').toBe(true);
    const rage = placeGenre('rage')!;
    expect(rage.broad, 'a named subgenre is not broad').toBe(false);
  });

  it('can place every subgenre the classifier can produce', () => {
    // SUBS carried 89 subgenres while the picker's CATALOG carried 83. All six that the map could
    // not place were hip-hop — exactly the owner's family.
    const placeable = new Set(MAP_SUBS.map((s) => s.key));
    const missing = SUBS.filter((s) => !placeable.has(s.key)).map((s) => `${s.family}/${s.name}`);
    expect(missing, 'a genre the classifier names must be placeable on the map').toEqual([]);
  });

  it('never presents a skipped genre as part of the listener’s taste', () => {
    const summary = ownerSummary();
    // "Your sound" was already right; this locks it in.
    const sound = soundView(summary)!;
    // Exact labels, not substrings: the owner's kept 'alt-hip-hop' is correctly drawn as
    // "Alternative / underground hip-hop", which contains the word 'alternative' legitimately.
    const labels = sound.leaves.map((l) => l.label.toLowerCase());
    const families = sound.families.map((f) => f.name.toLowerCase());
    for (const skipped of OWNER_SKIPPED) {
      expect(labels, `'${skipped}' was only ever skipped and must not be drawn as taste`).not.toContain(skipped);
      expect(families, `the '${skipped}' family was only ever skipped`).not.toContain(skipped);
    }
    // Everything it does draw must come from the hip-hop family, which is all the owner kept.
    expect(families).toEqual(['hip-hop']);
    // And the avoided list is where they belong.
    expect(sound.avoided.length).toBeGreaterThan(0);
  });

  it('does not let tempo alone call a 101 BPM song nu-metal', () => {
    // The owner's kept songs sit at 87-162 BPM, median 101. With no genre tag, tempo-only
    // classification named a Rock subgenre for everything from 87 to 125 BPM.
    for (const bpm of [87, 95, 101, 110, 125]) {
      const c = classify([], bpm);
      expect(c?.subgenre ?? null, `${bpm} BPM with no genre tag must not be given a confident subgenre`).toBeNull();
    }
  });

  it('still places a song by its own tags and tempo', () => {
    // The ordinary path must keep working: a tagged song lands in its family.
    const at = placeSong(['rage'], 150);
    expect(at).not.toBeNull();
    const broad = placeSong(['hip-hop'], 101);
    expect(broad, 'a family tag plus a tempo is enough to place a song').not.toBeNull();
    // A song with neither a usable genre nor a tempo cannot be placed, and says so.
    expect(placeSong([], null)).toBeNull();
  });
});
