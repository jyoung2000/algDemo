// ARTIST-SIZE-001 and ARTIST-FAV-001 in the scorer (owner, 2026-11-21).
import { describe, expect, it } from 'vitest';
import * as E from './engine';

const NOW = new Date('2026-11-21T00:00:00Z');
const track = (key: string, over: Partial<E.Track> = {}): E.Track => ({ key, title: key, artists: [key.split('|')[0] ?? 'a'], tags: [], provenance: [], release: null, bpm: null, ...over });
const ctxOf = (over: Partial<E.Context> = {}): E.Context => ({
  seeds: [track('osamason|song')], vectors: new Map(), relatedArtists: new Map(),
  feedback: { track: {}, artist: {}, excluded: new Set(), hidden: new Set(), likedArtists: new Set(), events: 0 },
  impressions: {}, settings: { adventurous: 0.5, fresh: false, vocals: 'any' }, now: NOW, rankV2: true, ...over,
});

describe('the scorer weighs an artist’s size (ARTIST-SIZE-001)', () => {
  const s = track('osamason|song');
  const big = track('ken carson|ss', { provenance: [{ seed: s.key, relation: 'related_song', rank: 0, source: 'ytmusic-related' }] });
  const small = track('summrs|x', { provenance: [{ seed: s.key, relation: 'related_song', rank: 0, source: 'ytmusic-related' }] });
  it('scales a song’s score by its artist’s size fit, and says so in its factors', () => {
    const plain = E.scoreOne(big, ctxOf({ seeds: [s] }));
    const sized = E.scoreOne(big, ctxOf({ seeds: [s], artistFit: (c) => (c.artists[0] === 'ken carson' ? 0.3 : 1) }));
    expect(sized.final).toBeCloseTo(plain.final * 0.3, 6);
    expect(sized.factors['size']).toBe(0.3);
    expect(plain.factors['size']).toBeUndefined();
  });
  it('a mainstream act falls below an equally related act of the listener’s size', () => {
    const ctx = ctxOf({ seeds: [s], artistFit: (c) => (c.artists[0] === 'ken carson' ? 0.2 : 1) });
    const ranked = E.scoreAll([big, small], ctx).sort((a, b) => b.final - a.final).map((x) => x.track.artists[0]);
    expect(ranked).toEqual(['summrs', 'ken carson']);
  });
});
