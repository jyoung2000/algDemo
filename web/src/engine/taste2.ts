/**
 * Taste v2: three horizons instead of one.
 *
 *  - long:   half-life 120 days — what the listener keeps coming back to over months;
 *  - recent: half-life 10 days  — what they are into lately;
 *  - session: this app session only (no decay) — what they are in the mood for right now.
 *
 * Each horizon is a TasteProfile built by the same `buildTaste` fold (shared genre/BPM handling),
 * fed with v2-shaped rows so one listening session cannot write three independent endorsements:
 * complete+replay(+like) of one song in one day collapse behaviourally the same way as
 * `buildFeedback2` (first full, second half, later ones nothing; explicit events untouched).
 *
 * The blend is confidence-aware: each horizon's vote is weighted by how much evidence it holds
 * (events, saturating) and the overall taste weight grows from 0 (no events) to TASTE2_MAX_WEIGHT
 * (well-evidenced) instead of the fixed 0.15 of v1. A brand-new profile changes nothing; a
 * long-lived one speaks with a louder, but still bounded, voice.
 */
import type { Tag } from './genres';
import { buildTaste, tasteFit, type TasteProfile, type TasteRow } from './taste';

export const LONG_HALF_LIFE_DAYS = 120;
export const RECENT_HALF_LIFE_DAYS = 10;
/** Ceiling of the taste share of the final affinity; v1's fixed TASTE_WEIGHT was 0.15. */
export const TASTE2_MAX_WEIGHT = 0.25;
/** Events at which a horizon's confidence reaches ~63% of its ceiling. */
const EVIDENCE_SCALE = 12;

/** Horizon mixing when every horizon is fully evidenced. */
const HORIZON_SHARES = { long: 0.45, recent: 0.35, session: 0.2 } as const;

export interface TasteRow2 extends TasteRow {
  event_id?: string;
  medium?: string | null;
  confidence?: number | null;
  session?: string | null;
}

export interface TasteBlend {
  long: TasteProfile;
  recent: TasteProfile;
  session: TasteProfile;
  /** 0..TASTE2_MAX_WEIGHT — how much of the affinity the blended taste may claim. */
  weight: number;
  events: number;
}

/** Collapse one day's behavioural repeats of one song (complete/replay) to first=1, second=0.5, rest=0. */
export function collapseRows(rows: TasteRow2[]): TasteRow2[] {
  const perDay = new Map<string, number>();
  const out: TasteRow2[] = [];
  const sorted = [...rows].sort((x, y) => x.ts - y.ts || String(x.event_id ?? '').localeCompare(String(y.event_id ?? '')));
  for (const r of sorted) {
    if (r.kind === 'complete' || r.kind === 'replay') {
      const slot = `${r.key}|${Math.floor(r.ts / 86400)}`;
      const had = perDay.get(slot) ?? 0;
      perDay.set(slot, had + 1);
      if (had >= 2) continue;
      // The half-strength second endorsement is approximated by halving tag confidence downstream
      // (buildTaste multiplies by tag confidence); simplest faithful encoding: skip every other row
      // would lose BPM evidence, so instead mark it via a cloned track with halved tag confidence.
      if (had === 1 && r.track) {
        const tags = ((r.track['tags'] as Tag[] | undefined) ?? []).map((t) => ({ ...t, confidence: (t.confidence ?? 1) * 0.5 }));
        out.push({ ...r, track: { ...r.track, tags } });
        continue;
      }
    }
    out.push(r);
  }
  return out;
}

export function buildTasteBlend(rows: TasteRow2[], nowTs: number, sessionId: string | null): TasteBlend {
  const collapsed = collapseRows(rows);
  const scaled = collapsed.map((r) => {
    const conf = r.confidence === null || r.confidence === undefined ? 1 : Math.min(1, Math.max(0, r.confidence));
    if (conf >= 1 || !r.track) return r;
    const tags = ((r.track['tags'] as Tag[] | undefined) ?? []).map((t) => ({ ...t, confidence: (t.confidence ?? 1) * conf }));
    return { ...r, track: { ...r.track, tags } };
  });
  const long = buildTasteWithHalfLife(scaled, nowTs, LONG_HALF_LIFE_DAYS);
  const recent = buildTasteWithHalfLife(scaled, nowTs, RECENT_HALF_LIFE_DAYS);
  const sessionRows = sessionId ? scaled.filter((r) => r.session === sessionId) : [];
  const session = buildTaste(sessionRows, nowTs); // decay inside one session is negligible
  const evidence = (p: TasteProfile) => 1 - Math.exp(-p.events / EVIDENCE_SCALE);
  const w = TASTE2_MAX_WEIGHT * Math.max(evidence(long), evidence(recent));
  return { long, recent, session, weight: Math.round(w * 1000) / 1000, events: long.events };
}

/** `buildTaste` with a different half-life: shift timestamps so taste.ts's 14-day constant acts like `hl`. */
function buildTasteWithHalfLife(rows: TasteRow2[], nowTs: number, hl: number): TasteProfile {
  const k = 14 / hl; // taste.ts hard-codes TASTE_HALF_LIFE_DAYS=14; age*k gives the wanted decay
  const shifted = rows.map((r) => ({ ...r, ts: nowTs - (nowTs - r.ts) * k }));
  return buildTaste(shifted, nowTs);
}

export interface TasteFit2 {
  value: number; // 0..1
  weight: number; // share of affinity this vote may claim (already evidence-scaled)
  parts: { long: number | null; recent: number | null; session: number | null };
}

/** Confidence-aware blend of the three horizons' fits; null when none of them knows the song. */
export function tasteFit2(t: { tags?: Tag[] | null; bpm?: number | null }, blend: TasteBlend): TasteFit2 | null {
  if (!blend || blend.weight <= 0) return null;
  const f = {
    long: tasteFit(t, blend.long),
    recent: tasteFit(t, blend.recent),
    session: blend.session.events ? tasteFit(t, blend.session) : null,
  };
  let num = 0, den = 0;
  const ev = (p: TasteProfile) => 1 - Math.exp(-p.events / EVIDENCE_SCALE);
  if (f.long) { const w = HORIZON_SHARES.long * ev(blend.long); num += w * f.long.value; den += w; }
  if (f.recent) { const w = HORIZON_SHARES.recent * ev(blend.recent); num += w * f.recent.value; den += w; }
  if (f.session) { const w = HORIZON_SHARES.session * ev(blend.session); num += w * f.session.value; den += w; }
  if (den <= 0) return null;
  return {
    value: Math.min(1, Math.max(0, num / den)),
    weight: blend.weight,
    parts: { long: f.long?.value ?? null, recent: f.recent?.value ?? null, session: f.session?.value ?? null },
  };
}
