// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { MB_ARTIST_SOURCE, needsSub, subsFromArtist } from './infer';
import { classify, classifyAll } from './classify';
import type { Tag } from './genres';

/**
 * TAGS-MULTI-001 — a song can carry several genres and several subgenres.
 *
 * The owner's evidence: a Beyoncé song came back as hip-hop with no R&B anywhere. Two causes, both
 * fixed here:
 *
 *  - the artist lookup kept *hip-hop* subgenres only, so every R&B, soul and pop tag MusicBrainz
 *    knows about an artist was thrown away, and a song that had been placed in hip-hop stayed there;
 *  - classify() reported one family and one subgenre, so even when the tags named three genres the
 *    card could only show the strongest.
 */
const tag = (name: string, confidence = 0.6): Tag => ({ name, label: name, source: 'test', scope: 'track', confidence, inferred: false }) as Tag;

const mbBody = (artist: string, tags: string[]) => ({
  artists: [{ name: artist, score: 100, tags: tags.map((t, i) => ({ name: t, count: tags.length - i })) }],
});

describe('artist tags for any family, not only hip-hop (TAGS-MULTI-001)', () => {
  it("keeps an artist's R&B and soul tags, which the hip-hop-only lookup dropped", () => {
    const subs = subsFromArtist(mbBody('Beyoncé', ['r&b', 'soul', 'dance-pop', 'not-a-genre']), 'Beyoncé');
    const names = subs.map((t) => t.name);
    expect(names.length).toBeGreaterThan(1);
    expect(names).toContain('r&b');
    expect(names.some((n) => /soul|pop/.test(n))).toBe(true);
    expect(names).not.toContain('not-a-genre');
    for (const t of subs) expect(t.source).toBe(MB_ARTIST_SOURCE);
  });

  it('still names the kind of hip-hop it always did', () => {
    const subs = subsFromArtist(mbBody('Ken Carson', ['rage', 'trap', 'hip hop']), 'Ken Carson');
    expect(subs.map((t) => t.name)).toContain('rage');
  });

  it('asks about an artist whose song has a family but no finer genre, whatever the family', () => {
    expect(needsSub([tag('hip-hop')])).toBe(true);
    expect(needsSub([tag('r&b')])).toBe(true); // the case that used to be ignored
    expect(needsSub([tag('pop')])).toBe(true);
    // Already has a subgenre: nothing to ask.
    expect(needsSub([tag('hip-hop'), tag('rage')])).toBe(false);
    expect(needsSub([tag('r&b'), tag('neo-soul')])).toBe(false);
    // No genre at all is not an artist question — that song is simply unplaced (TASTE-ACCURACY-001).
    expect(needsSub([])).toBe(false);
  });

  it('trusts only an exact, top-scoring artist match, as before', () => {
    expect(subsFromArtist(mbBody('Beyoncé Knowles', ['r&b']), 'Beyoncé')).toEqual([]);
    const weak = { artists: [{ name: 'Beyoncé', score: 60, tags: [{ name: 'r&b', count: 9 }] }] };
    expect(subsFromArtist(weak, 'Beyoncé')).toEqual([]);
  });
});

describe('every genre a song’s tags name (TAGS-MULTI-001)', () => {
  it('reports each family and subgenre, strongest first, with its own colour', () => {
    // Canonical tag names, as makeTag stores them.
    const all = classifyAll([tag('r&b', 0.9), tag('pop', 0.7), tag('hip-hop', 0.5)], null);
    expect(all.length).toBe(3);
    expect(all[0]!.family).toMatch(/R&B|Afro|Latin/i);
    expect(all.map((c) => c.familySlug)).toEqual(['rnb-afro-latin', 'pop', 'hip-hop']);
    // Distinct colours: the bubbles are told apart by hue, so two families cannot share one.
    expect(new Set(all.map((c) => c.color)).size).toBe(3);
  });

  it('never repeats a genre, and drops a family its own subgenre already names', () => {
    // Neo-soul twice over, by key and by alias: one bubble.
    const soul = classifyAll([tag('neo-soul', 0.9), tag('neo-soul', 0.4)], null);
    expect(soul.filter((c) => c.subgenre === 'Neo-soul')).toHaveLength(1);
    // 'Hip-hop' beside 'Rage' is noise: the family goes, the subgenre stays.
    const rap = classifyAll([tag('rage', 0.9), tag('hip-hop', 0.8)], null);
    expect(rap.map((c) => [c.familySlug, c.subgenre])).toEqual([['hip-hop', 'Rage']]);
    // A different family keeps its own bubble, even with no subgenre of its own named.
    const mixed = classifyAll([tag('rage', 0.9), tag('r&b', 0.8)], null);
    expect(mixed.map((c) => c.familySlug)).toEqual(['hip-hop', 'rnb-afro-latin']);
  });

  it('agrees with classify() about the strongest genre, which stays the song’s place on the map', () => {
    const tags = [tag('rage', 0.9), tag('r&b', 0.6)];
    const one = classify(tags, 150);
    const all = classifyAll(tags, 150);
    expect(all[0]!.familySlug).toBe(one!.familySlug);
    expect(all[0]!.subgenre).toBe(one!.subgenre);
    expect(all[0]!.tempoFit).toBe(one!.tempoFit);
  });

  it('says nothing when the tags name nothing', () => {
    expect(classifyAll([], 120)).toEqual([]);
    expect(classifyAll([tag('not-a-genre')], 120)).toEqual([]);
  });
});
