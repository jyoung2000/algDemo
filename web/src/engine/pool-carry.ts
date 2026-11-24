/**
 * WP2 (plan 2026-11-24, A2): evidence survives a top-up.
 * The re-rank pool used to store carried-over queue rows as the cleaned UI track (no provenance, dz_id, links), so the
 * next re-rank scored them as if no service had recommended them. These helpers keep each row's raw candidate.
 */
type Dict = Record<string, unknown>;
const keyOf = (x: Dict) => String(x['key'] ?? '');

/**
 * The pool after a run: the queue's rows (raw candidate from the old pool or old bench when there is one, else the
 * cleaned track) plus the rows this run chose, and a separate `bench` of the best non-chosen candidates (WP10 uses it).
 * The pool is capped at the queue rows + `benchMax`.
 */
export function carryPool(
  previous: readonly { track: Dict }[],
  oldRows: readonly Dict[],
  chosenKeys: readonly string[],
  cands: readonly Dict[],
  rankedKeys: readonly string[],
  benchMax = 100,
): { cands: Dict[]; bench: Dict[] } {
  const old = new Map<string, Dict>();
  for (const r of oldRows) if (keyOf(r) && !old.has(keyOf(r))) old.set(keyOf(r), r);
  const fresh = new Map<string, Dict>();
  for (const c of cands) if (keyOf(c) && !fresh.has(keyOf(c))) fresh.set(keyOf(c), c);
  const inQueue = new Set<string>();
  const out: Dict[] = [];
  for (const p of previous) {
    const k = keyOf(p.track);
    if (!k || inQueue.has(k)) continue;
    inQueue.add(k);
    out.push(old.get(k) ?? fresh.get(k) ?? p.track);
  }
  for (const k of chosenKeys) {
    const c = fresh.get(k);
    if (!c || inQueue.has(k)) continue;
    inQueue.add(k);
    out.push(c);
  }
  const bench: Dict[] = [];
  for (const k of rankedKeys) {
    if (bench.length >= benchMax) break;
    const c = fresh.get(k);
    if (c && !inQueue.has(k) && !bench.includes(c)) bench.push(c);
  }
  return { cands: out, bench };
}

/** Related artists per seed key, unioned across runs (newest run first). */
export function unionRelated(newer: ReadonlyMap<string, ReadonlySet<string>>, older?: ReadonlyMap<string, ReadonlySet<string>> | null): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const m of [newer, older ?? new Map()]) for (const [k, v] of m) {
    const s = out.get(k) ?? new Set<string>();
    for (const a of v) s.add(a);
    if (s.size) out.set(k, s);
  }
  return out;
}

/** Seed views unioned across runs, newest first, at most `max`. */
export function unionSeeds<T extends Dict>(newer: readonly T[], older: readonly T[] | null | undefined, max = 40): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const s of [...newer, ...(older ?? [])]) {
    const k = keyOf(s);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}
