/** Ranking v2: the improved scorer behind ctx.rankV2. Each test pins one audited defect fix. */
import { describe, expect, it } from 'vitest';
import * as E from './engine';
import { DEFAULT_ENGINE } from './config';
import { buildTasteBlend, collapseRows, tasteFit2, TASTE2_MAX_WEIGHT } from './taste2';
import type { Tag } from './genres';

const NOW = new Date('2026-06-15T00:00:00Z');
const NOW_TS = Math.floor(NOW.getTime() / 1000);

const tag = (name: string, over: Partial<Tag> = {}): Tag => ({ name, label: name, source: 'Deezer album genre', scope: 'track', confidence: 0.8, inferred: false, ...over });

const track = (key: string, over: Partial<E.Track> = {}): E.Track => ({
  key, title: key, artists: [key.split('|')[0] ?? 'a'], tags: [], provenance: [], release: null, bpm: null, ...over,
});

const ctxOf = (over: Partial<E.Context> = {}): E.Context => ({
  seeds: [track('seed|song', { tags: [tag('rock')] })],
  vectors: new Map(),
  relatedArtists: new Map(),
  feedback: { track: {}, artist: {}, excluded: new Set(), hidden: new Set(), likedArtists: new Set(), events: 0 },
  impressions: {},
  settings: { adventurous: 0.5, fresh: false, vocals: 'any' },
  now: NOW,
  rankV2: true,
  ...over,
});

const ev = (kind: string, key: string, over: Partial<E.FeedbackEvent> = {}): E.FeedbackEvent => ({
  event_id: over.event_id ?? `${kind}:${key}:${Math.random().toString(36).slice(2)}`,
  key, kind, artist: key.split('|')[0] ?? '', ts: NOW_TS - 3600, ...over,
});

describe('v2 provider factor', () => {
  it('a candidate whose only provenance is non-counting stays null, not 0 (defect 1)', () => {
    const s = track('seed|song');
    const c = track('x|hit', { provenance: [{ seed: s.key, relation: 'search_match', source: 'apple-search' }] });
    const f1 = E.seedFactors(c, s, ctxOf({ rankV2: false, seeds: [s] }));
    const f2 = E.seedFactors(c, s, ctxOf({ seeds: [s] }));
    expect(f1.provider).toBe(0); // v1: punished for being found by catalogue search
    expect(f2.provider).toBeNull(); // v2: unknown is neutral
  });

  it('absence from consulted relatedness lists is still weak negative evidence (kept from v1)', () => {
    const s = track('seed|song');
    const c = track('x|hit', { provenance: [{ seed: s.key, relation: 'related_song', rank: 0, source: 'ytmusic-related' }] });
    const other = track('y|other'); // no provenance at all, but the seed's lists were consulted
    const ctx = ctxOf({ seeds: [s], relatedArtists: new Map([[s.key, new Set(['someone'])]]) });
    expect(E.seedFactors(c, s, ctx).provider).toBeGreaterThan(0);
    expect(E.seedFactors(other, s, ctx).provider).toBe(0);
  });

  it('independent provider families corroborate, duplicates of one family do not (defect 2)', () => {
    const s = track('seed|song');
    const one = track('x|a', { provenance: [{ seed: s.key, relation: 'related_song', rank: 0, source: 'ytmusic-related' }] });
    const dup = track('x|b', {
      provenance: [
        { seed: s.key, relation: 'related_song', rank: 0, source: 'ytmusic-related' },
        { seed: s.key, relation: 'radio', rank: 0, source: 'ytmusic-radio' },
      ],
    });
    const three = track('x|c', {
      provenance: [
        { seed: s.key, relation: 'related_song', rank: 0, source: 'ytmusic-related' },
        { seed: s.key, relation: 'sc_recommended', rank: 0, source: 'soundcloud-recommended' },
        { seed: s.key, relation: 'artist_radio', rank: 0, source: 'deezer-artist-radio' },
      ],
    });
    const ctx = ctxOf({ seeds: [s] });
    const p1 = E.seedFactors(one, s, ctx).provider!;
    const pDup = E.seedFactors(dup, s, ctx).provider!;
    const p3 = E.seedFactors(three, s, ctx).provider!;
    expect(pDup).toBe(p1); // same family twice: no bonus
    expect(p3).toBeCloseTo(Math.min(1, p1 + 0.16), 10); // two extra families: +0.08 each
  });

  it('same-artist candidates do not double-dip artist and seed_artist_top provider credit (defect 4)', () => {
    const s = track('seed|song');
    const sameArtist = track('seed|deeper cut', { provenance: [{ seed: s.key, relation: 'seed_artist_top', rank: 0, source: 'deezer-artist-top' }] });
    const v1 = E.seedFactors(sameArtist, s, ctxOf({ rankV2: false, seeds: [s] }));
    const v2 = E.seedFactors(sameArtist, s, ctxOf({ seeds: [s] }));
    expect(v1.artist).toBe(1);
    expect(v2.artist).toBe(1);
    expect(v2.provider).toBeCloseTo((v1.provider as number) * 0.5, 10);
  });
});

describe('v2 genre factor and inferred tags', () => {
  it('a seed-donated tag no longer scores the candidate against that same seed (defect 3)', () => {
    const s = track('seed|song', { tags: [tag('rock')] });
    const donated = tag('rock', { inferred: true, source: 'Guessed from the starting song', scope: 'artist', confidence: 0.25 });
    const c = track('x|unknown', { tags: [donated] });
    expect(E.seedFactors(c, s, ctxOf({ rankV2: false, seeds: [s] })).genre).toBeGreaterThan(0);
    expect(E.seedFactors(c, s, ctxOf({ seeds: [s] })).genre).toBeNull();
    // but a REAL tag still scores
    const real = track('y|known', { tags: [tag('rock')] });
    expect(E.seedFactors(real, s, ctxOf({ seeds: [s] })).genre).toBeGreaterThan(0);
  });
});

describe('v2 coverage (defect 5)', () => {
  it('audio leaves the coverage denominator when no seed has a vector', () => {
    const s = track('seed|song', { tags: [tag('rock')] });
    const c = track('x|hit', { tags: [tag('rock')], provenance: [{ seed: s.key, relation: 'related_song', rank: 0, source: 'ytmusic-related' }] });
    const base = { seeds: [s], relatedArtists: new Map([[s.key, new Set<string>()]]) };
    const v1 = E.scoreAll([c], ctxOf({ ...base, rankV2: false }))[0]!;
    const v2 = E.scoreAll([c], ctxOf(base))[0]!;
    expect(v2.coverage).toBeGreaterThan(v1.coverage);
    // with a seed vector present, audio counts as missing evidence again (same denominator as v1)
    const withVec = ctxOf({ ...base, vectors: new Map([[s.key, Float64Array.from([1, 0])]]) });
    expect(E.scoreAll([c], withVec)[0]!.coverage).toBeCloseTo(v1.coverage, 10);
  });
});

describe('buildFeedback2 (defects 7, 8, 9)', () => {
  const cfg = { ...DEFAULT_ENGINE };

  it('same-day behavioural repeats collapse: first full, second half, rest nothing', () => {
    const one = E.buildFeedback2([ev('complete', 'a|x', { event_id: 'e1' })], NOW_TS, cfg);
    const spam = E.buildFeedback2(
      [1, 2, 3, 4, 5].map((i) => ev('complete', 'a|x', { event_id: `e${i}` })),
      NOW_TS, cfg,
    );
    expect(spam.track['a|x']!).toBeCloseTo(one.track['a|x']! * 1.5, 5);
  });

  it('replays on different days still add (with decay), so re-listening across days means more', () => {
    const twoDays = E.buildFeedback2(
      [ev('complete', 'a|x', { event_id: 'd1', ts: NOW_TS - 86400 * 2 }), ev('complete', 'a|x', { event_id: 'd2' })],
      NOW_TS, cfg,
    );
    const oneDay = E.buildFeedback2([ev('complete', 'a|x', { event_id: 'd2' })], NOW_TS, cfg);
    expect(twoDays.track['a|x']!).toBeGreaterThan(oneDay.track['a|x']! * 1.5);
  });

  it('duplicate event ids stay deduplicated', () => {
    const fb = E.buildFeedback2([ev('complete', 'a|x', { event_id: 'same' }), ev('complete', 'a|x', { event_id: 'same' })], NOW_TS, cfg);
    expect(fb.events).toBe(1);
  });

  it('a preview completion weighs less than a full-track completion (defect 7)', () => {
    const prev = E.buildFeedback2([ev('complete', 'a|x', { event_id: 'p', medium: 'preview', listened: 28, duration: 30 })], NOW_TS, cfg);
    const full = E.buildFeedback2([ev('complete', 'a|x', { event_id: 'f', medium: 'full', listened: 200, duration: 210 })], NOW_TS, cfg);
    expect(prev.track['a|x']!).toBeLessThan(full.track['a|x']!);
  });

  it('uses unique content coverage rather than elapsed loops to qualify a completion', () => {
    const fb = E.buildFeedback2([ev('complete', 'a|x', { event_id: 'cov', listened: 30, coverage: 24, duration: 30, medium: 'preview' })], NOW_TS, cfg);
    const full = E.buildFeedback2([ev('complete', 'a|x', { event_id: 'whole', listened: 30, coverage: 30, duration: 30, medium: 'preview' })], NOW_TS, cfg);
    expect(fb.track['a|x']!).toBeCloseTo(full.track['a|x']! * 0.8, 5);
  });

  it('unknown duration does not manufacture a completion ratio', () => {
    const unk = E.buildFeedback2([ev('complete', 'a|x', { event_id: 'u', medium: 'full', listened: 200 })], NOW_TS, cfg);
    const known = E.buildFeedback2([ev('complete', 'a|x', { event_id: 'k', medium: 'full', listened: 200, duration: 205 })], NOW_TS, cfg);
    expect(unk.track['a|x']!).toBeCloseTo(known.track['a|x']!, 5);
  });

  it('artist spillover: distinct endorsed songs beat one song replayed many times (defect 8)', () => {
    const sameSong = E.buildFeedback2(
      [1, 2, 3, 4].map((i) => ev('complete', 'band|one', { event_id: `s${i}`, ts: NOW_TS - 86400 * i })),
      NOW_TS, cfg,
    );
    const spread = E.buildFeedback2(
      [1, 2, 3, 4].map((i) => ev('complete', `band|song${i}`, { event_id: `d${i}`, artist: 'band' })),
      NOW_TS, cfg,
    );
    expect(spread.artist['band']!).toBeGreaterThan(sameSong.artist['band']!);
  });

  it('one accidental skip never colours the artist; explicit dislike still excludes the song', () => {
    const fb = E.buildFeedback2([ev('skip', 'band|x', { artist: 'band' }), ev('dislike', 'band|y', { artist: 'band' })], NOW_TS, cfg);
    expect(fb.artist['band'] ?? 0).toBeLessThan(0); // dislike spillover, halved — allowed
    const skipOnly = E.buildFeedback2([ev('skip', 'band|x', { artist: 'band' })], NOW_TS, cfg);
    expect(skipOnly.artist['band']).toBeUndefined();
    expect(fb.excluded.has('band|y')).toBe(true);
  });

  it('import confidence scales the event', () => {
    const live = E.buildFeedback2([ev('complete', 'a|x', { event_id: 'l' })], NOW_TS, cfg);
    const imported = E.buildFeedback2([ev('complete', 'a|x', { event_id: 'i', confidence: 0.5 })], NOW_TS, cfg);
    expect(imported.track['a|x']!).toBeCloseTo(live.track['a|x']! * 0.5, 5);
  });
});

describe('taste2 horizons', () => {
  const rockTrack = { tags: [tag('rock')], bpm: 120 };
  const row = (kind: string, key: string, ts: number, over: Record<string, unknown> = {}) => ({
    key, kind, ts, track: { tags: [tag('rock')], bpm: 120 }, event_id: `${kind}:${key}:${ts}`, ...over,
  });

  it('no events -> no taste vote at all', () => {
    const blend = buildTasteBlend([], NOW_TS, 's1');
    expect(blend.weight).toBe(0);
    expect(tasteFit2(rockTrack, blend)).toBeNull();
  });

  it('weight grows with evidence and stays below the ceiling', () => {
    const few = buildTasteBlend([row('complete', 'a|1', NOW_TS - 3600)], NOW_TS, 's1');
    const many = buildTasteBlend(
      Array.from({ length: 30 }, (_, i) => row('complete', `a|${i}`, NOW_TS - 3600 * (i + 1))),
      NOW_TS, 's1',
    );
    expect(few.weight).toBeGreaterThan(0);
    expect(many.weight).toBeGreaterThan(few.weight);
    expect(many.weight).toBeLessThanOrEqual(TASTE2_MAX_WEIGHT);
  });

  it('recent listening moves the recent horizon more than the long one', () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => row('complete', `old|${i}`, NOW_TS - 86400 * 100, { track: { tags: [tag('jazz')], bpm: 90 } })),
      ...Array.from({ length: 5 }, (_, i) => row('complete', `new|${i}`, NOW_TS - 86400, { track: { tags: [tag('rock')], bpm: 140 } })),
    ];
    const blend = buildTasteBlend(rows, NOW_TS, 's1');
    // 100-day-old jazz: at the 10-day recent half-life it is ~2^-10 (gone); at the 120-day long
    // half-life it is still more than half-strength. So jazz must look much better long than recent.
    const jazzFit = tasteFit2({ tags: [tag('jazz')] }, blend)!;
    expect(jazzFit.parts.long!).toBeGreaterThan(jazzFit.parts.recent! + 0.1);
    // and the fresh rock keeps a strong recent fit
    const rockFit = tasteFit2({ tags: [tag('rock')] }, blend)!;
    expect(rockFit.parts.recent!).toBeGreaterThan(0.7);
  });

  it('collapseRows: one day of looping one song is at most two rows, second at half confidence', () => {
    // all six plays inside the same UTC day (midday anchor so the minute spacing cannot straddle midnight)
    const mid = NOW_TS - 43200;
    const rows = Array.from({ length: 6 }, (_, i) => row('complete', 'a|x', mid - 60 * i, { event_id: `r${i}` }));
    const out = collapseRows(rows);
    expect(out.length).toBe(2);
    const tags2 = (out[1]!.track as Record<string, unknown>)['tags'] as Tag[];
    expect(tags2[0]!.confidence).toBeCloseTo(0.4, 5); // 0.8 * 0.5
  });
});

describe('determinism', () => {
  it('same inputs give the same queue, v2 on', () => {
    const s = track('seed|song', { tags: [tag('rock')] });
    const cands = Array.from({ length: 12 }, (_, i) =>
      track(`a${i}|c${i}`, {
        tags: i % 2 ? [tag('rock')] : [tag('jazz')],
        provenance: [{ seed: s.key, relation: 'related_song', rank: i, source: 'ytmusic-related' }],
      }),
    );
    const mk = () => {
      const ctx = ctxOf({ seeds: [s], relatedArtists: new Map([[s.key, new Set<string>()]]) });
      return E.select(E.scoreAll(cands, ctx), ctx).map((x) => [x.track.key, x.final]);
    };
    expect(mk()).toEqual(mk());
  });
});
