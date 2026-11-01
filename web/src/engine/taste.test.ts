/** Listening taste: learned from real playback events, and only scored when the context carries it. */
import { describe, expect, it } from 'vitest';
import * as E from './engine';
import * as G from './genres';
import { buildTaste, tasteFit, tasteSummary, type TasteRow } from './taste';

const NOW = new Date(Date.UTC(2026, 9, 26));
const NOW_TS = 1_793_000_000;

function track(key: string, artist: string, tags: string[], bpm: number | null, prov: [string, string, number][] = []): E.Track {
  return {
    key,
    title: key,
    artists: [artist],
    tags: tags.map((t) => G.makeTag(t, 'Deezer', 'album', 0.9)!),
    provenance: prov.map(([seed, relation, rank]) => ({ seed, relation, rank })),
    release: null,
    bpm,
  };
}

function ev(kind: string, t: E.Track, agoDays = 0): TasteRow {
  return { key: t.key, kind, ts: NOW_TS - agoDays * 86400, track: t as never };
}

function ctx(seeds: E.Track[], taste?: ReturnType<typeof buildTaste>): E.Context {
  return {
    seeds,
    vectors: new Map(),
    relatedArtists: new Map(),
    feedback: E.buildFeedback([], NOW_TS),
    impressions: {},
    settings: E.normaliseSettings({ fresh: false, adventurous: 0.5 }),
    now: NOW,
    ...(taste ? { taste } : {}),
  };
}

const hiphop = (k: string, bpm: number) => track(k, `HH ${k}`, ['hip hop'], bpm);
const metal = (k: string, bpm: number) => track(k, `MT ${k}`, ['metal'], bpm);

describe('listening taste', () => {
  it('finishing songs of a genre makes that genre liked; skipping makes it avoided', () => {
    const t = buildTaste([ev('complete', hiphop('a', 90)), ev('complete', hiphop('b', 92)), ev('skip', metal('c', 170)), ev('skip', metal('d', 180))], NOW_TS);
    const hh = Object.values(t.genres).find((g) => /hip/i.test(g.name))!;
    const mt = Object.values(t.genres).find((g) => /metal/i.test(g.name))!;
    expect(hh.score).toBeGreaterThan(0);
    expect(mt.score).toBeLessThan(0);
    const s = tasteSummary(t)!;
    expect((s['likes'] as { name: string }[]).some((g) => /hip/i.test(g.name))).toBe(true);
    expect((s['avoids'] as { name: string }[]).some((g) => /metal/i.test(g.name))).toBe(true);
  });

  it('learns the tempo of kept songs, weighted to recent listening', () => {
    const t = buildTaste([ev('complete', hiphop('a', 90)), ev('complete', hiphop('b', 94)), ev('complete', hiphop('old', 150), 120)], NOW_TS);
    expect(t.bpm).not.toBeNull();
    expect(t.bpm!).toBeGreaterThan(88);
    expect(t.bpm!).toBeLessThan(100); // the 4-month-old 150 BPM play has decayed to almost nothing
  });

  it('fits a song of a liked genre and tempo above a song of an avoided one', () => {
    const t = buildTaste([ev('complete', hiphop('a', 90)), ev('like', hiphop('b', 92)), ev('skip', metal('c', 170))], NOW_TS);
    const good = tasteFit(hiphop('x', 91), t)!;
    const bad = tasteFit(metal('y', 128), t)!; // 128 is neither near 91 nor double/half of it
    expect(good.value).toBeGreaterThan(0.6);
    expect(bad.value).toBeLessThan(0.4);
  });

  it('says nothing without events, and the score is unchanged without a taste (golden path)', () => {
    expect(tasteFit(hiphop('x', 90), buildTaste([], NOW_TS))).toBeNull();
    const seed = track('s', 'Seed', ['hip hop', 'metal'], 120);
    const c = hiphop('x', 90);
    c.provenance = [{ seed: 's', relation: 'related_song', rank: 0 }];
    const plain = E.scoreOne(c, ctx([seed]));
    const noEvents = E.scoreOne(c, ctx([seed], buildTaste([], NOW_TS)));
    expect(noEvents.final).toBeCloseTo(plain.final, 12);
    expect(plain.factors.taste ?? null).toBeNull();
  });

  it('re-ranks: after skipping metal and finishing hip hop, hip hop candidates move up', () => {
    const seed = track('s', 'Seed', ['hip hop', 'metal'], 120);
    const p: [string, string, number][] = [['s', 'related_song', 0]];
    const cands = [
      track('m1', 'M1', ['metal'], 170, p), track('m2', 'M2', ['metal'], 175, p), track('m3', 'M3', ['metal'], 168, p),
      track('h1', 'H1', ['hip hop'], 90, p), track('h2', 'H2', ['hip hop'], 92, p), track('h3', 'H3', ['hip hop'], 95, p),
    ];
    const meanRank = (order: E.Scored[], prefix: string) => {
      const r = order.map((x, i) => (x.track.key.startsWith(prefix) ? i : null)).filter((i): i is number => i !== null);
      return r.reduce((a, b) => a + b, 0) / r.length;
    };
    const before = E.scoreAll(cands, ctx([seed]));
    const taste = buildTaste(
      [ev('skip', metal('pm1', 172)), ev('skip', metal('pm2', 178)), ev('complete', hiphop('ph1', 91)), ev('complete', hiphop('ph2', 93))],
      NOW_TS,
    );
    const after = E.scoreAll(cands, ctx([seed], taste));
    expect(meanRank(after, 'h')).toBeLessThan(meanRank(after, 'm'));
    expect(meanRank(after, 'h')).toBeLessThanOrEqual(meanRank(before, 'h'));
    const h = after.find((x) => x.track.key === 'h1')!;
    const m = after.find((x) => x.track.key === 'm1')!;
    expect(h.final).toBeGreaterThan(m.final);
    // the reason names the listening
    const why = E.explain(h, ctx([seed], taste))[0];
    expect(why.some((r) => r.factor === 'taste' && /listening/i.test(r.text))).toBe(true);
  });
});
