import { useEffect, useState } from 'react';
import { api, type Characteristics, type Track } from './api';
import { genreBubbles } from './util';
import { GenreBubbleView } from './Results';
import { TagStrip } from './TagStrip';

/**
 * TAGS-ALWAYS-001 (owner, 2026-11-19: "all music should be tagged"): the genre bubbles of a song shown
 * outside the engine's lists (search results). Rows ask together: one request per screenful, answered
 * from what the engine knows, with a few unknown songs looked up. An answer is kept for the session.
 */
const known = new Map<string, Characteristics | null>();
/**
 * Rows the engine is still looking up (it says so in `pending`) are asked again until the answer
 * lands; a row the engine has nothing for and is not looking up is settled at once.
 */
const tries = new Map<string, number>();
const MAX_TRIES = 30;
/** Waits before asking again: lookups run in the background on the engine and can take seconds each. */
const AGAIN_MS = [1500, 3000, 6000];
const AGAIN_LATER_MS = 10_000;
const waiting = new Map<string, { track: Track; cbs: ((c: Characteristics | null) => void)[] }>();
let timer: ReturnType<typeof setTimeout> | null = null;

function flush(): void {
  timer = null;
  const batch = [...waiting.values()].slice(0, 30);
  for (const b of batch) waiting.delete(b.track.key);
  // `pending` null = the engine did not answer (asked again, as if pending).
  const done = (pick: (key: string) => Characteristics | null, pending: Set<string> | null) => {
    for (const b of batch) {
      const key = b.track.key;
      const c = pick(key);
      const n = (tries.get(key) ?? 0) + 1;
      tries.set(key, n);
      const lookingUp = pending ? pending.has(key) : true;
      const again = !c && lookingUp && n < MAX_TRIES;
      if (!again) known.set(key, c);
      for (const cb of b.cbs) cb(c);
      if (again) setTimeout(() => ask(b.track, (v) => { for (const cb of b.cbs) cb(v); }), AGAIN_MS[n - 1] ?? AGAIN_LATER_MS);
    }
  };
  Promise.resolve().then(() => api.genres(batch.map((b) => b.track))).then(
    (r) => done((k) => r.items?.[k] ?? null, new Set(r.pending ?? [])),
    () => done(() => null, null),
  );
  if (waiting.size) timer = setTimeout(flush, 60);
}

function ask(track: Track, cb: (c: Characteristics | null) => void): void {
  const w = waiting.get(track.key);
  if (w) w.cbs.push(cb);
  else waiting.set(track.key, { track, cbs: [cb] });
  if (!timer) timer = setTimeout(flush, 60);
}

/** For tests: forget what was asked. */
export function resetRowGenres(): void { known.clear(); tries.clear(); waiting.clear(); if (timer) clearTimeout(timer); timer = null; }

export function RowGenres({ track }: { track: Track }) {
  const own = track.characteristics ?? null;
  const [c, setC] = useState<Characteristics | null>(() => own ?? known.get(track.key) ?? null);
  useEffect(() => {
    if (own) { setC(own); return; }
    if (known.has(track.key)) { setC(known.get(track.key) ?? null); return; }
    let live = true;
    ask(track, (v) => { if (live) setC(v); });
    return () => { live = false; };
  }, [track.key, own]);
  const bubbles = genreBubbles(c);
  if (!bubbles.length) return null;
  return (
    <TagStrip className="rec__facts list-strip__facts">
      {bubbles.map((g) => <GenreBubbleView key={g.label} bubble={g} />)}
    </TagStrip>
  );
}
