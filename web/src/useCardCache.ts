import { useEffect, useMemo, useRef, useState } from 'react';
import type { Track } from './api';
import { dl, downloadsAvailable } from './engine/downloads';
import { localLibrary, sourceUrlFor } from './engine/local-audio';
import { queueAudio } from './engine/queue-audio';
import { songSources } from './engine/song-sources';
import type { CardCache } from './engine/queue-controls';

export const POLL_BUSY_MS = 300;
export const POLL_IDLE_MS = 4000;
/** RING-CLOSE-001: how long a finished job's ring waits, closed, for the file to be reported before letting go. */
export const FINISH_HOLD_MS = 6000;

/** One download a row is following: its highest reported percent, and whether the job has stopped running. */
export interface RingJob { percent: number | null; over: boolean; until: number }
type Rings = Record<string, RingJob>;
const sameRings = (a: Rings, b: Rings): boolean => {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => { const x = a[k]!, y = b[k]; return !!y && x.percent === y.percent && x.over === y.over && x.until === y.until; });
};
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null);

/**
 * RING-CLOSE-001 (owner, 2026-11-22): "the ring animation doesnt progress to close with the download, it quickly plays
 * then the outline resets the animation flashes to blue". The percent of a job only ever rises; a job that finishes
 * closes its ring at 100 and holds it until the file is reported (the old code dropped the number the moment the job
 * stopped, so the ring fell back to nothing just before turning blue); a failed one lets go at once.
 */
export function nextRings(prev: Rings, jobs: readonly { url: string; state: string; percent: number | null }[], now: number): Rings {
  const next: Rings = {};
  for (const j of jobs) {
    if (j.state !== 'running' && j.state !== 'queued') continue;
    const was = prev[j.url], p = num(j.percent);
    const held = was && !was.over ? was.percent : null;
    next[j.url] = { percent: held === null ? p : p === null ? held : Math.max(held, p), over: false, until: 0 };
  }
  for (const [url, was] of Object.entries(prev)) {
    if (url in next) continue;
    if (was.over) { if (now < was.until) next[url] = was; continue; }
    const mine = jobs.filter((j) => j.url === url);
    if (mine.some((j) => j.state === 'done')) next[url] = { percent: 100, over: true, until: now + FINISH_HOLD_MS };
    // Gone from the list without a word: keep the place for a moment, the file is usually about to be reported.
    else if (!mine.length) next[url] = { percent: was.percent, over: true, until: now + FINISH_HOLD_MS };
  }
  return next;
}

/**
 * QUEUE-CTRL-001: per-song cache state for the song cards.
 *
 * Progress comes from the shell's own job records, never interpolated — a smooth animation over an
 * unknown percent would be a fabricated number. Polling only runs while something is downloading,
 * so an idle list costs nothing.
 */
export function useCardCache(tracks: Track[], kept: ReadonlySet<string>): (key: string) => CardCache | null {
  const available = downloadsAvailable();
  // PLAY-LIVE-001: counts files landing. It is part of the answer below, so every list re-reads its rows the moment
  // a song finishes; without it the rows kept their old state until the listener did something else.
  const [landed, bump] = useState(0);
  const [rings, setRings] = useState<Rings>({});
  const held = useRef<Rings>({});

  // The library tells us when a file lands; that is also when a card flips to ready.
  useEffect(() => {
    if (!available) return localLibrary.subscribe(() => undefined);
    return localLibrary.subscribe(() => bump(n => n + 1));
  }, [available]);

  // The service's loader (Android) reports its songs through the queue view, not the page's library.
  useEffect(() => (available ? queueAudio.subscribe(() => bump(n => n + 1)) : undefined), [available]);

  // PLAY-RING-004: asked often while a file is moving (the ring follows the real percent), rarely when nothing is; and
  // asked at once when the loader says something changed, so a short download is not over before the first look.
  const kick = useRef<() => void>(() => undefined);
  useEffect(() => {
    if (!available) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let asking = false, again = false;
    const poll = async () => {
      if (asking) { again = true; return; }
      asking = true;
      if (timer) clearTimeout(timer);
      let wait = POLL_IDLE_MS;
      try {
        const { jobs } = await dl.jobs();
        if (!live) return;
        const before = held.current;
        const next = nextRings(before, jobs, Date.now());
        // A download just stopped: ask the shell whether it holds the file now. That answer, not the loader's list
        // (which was never asked about a song the player fetched itself), is what turns the button blue.
        for (const [u, r] of Object.entries(next)) if (r.over && !before[u]?.over) void localLibrary.refresh(u).catch(() => undefined);
        if (!sameRings(before, next)) { held.current = next; setRings(next); }
        // Idle lists must not poll often: nothing is moving, so nothing can change the number.
        // While the player is fetching a pressed song its download is about to appear: keep looking for it.
        wait = Object.keys(next).length || songSources.anyFetching() ? POLL_BUSY_MS : POLL_IDLE_MS;
      } catch {
        wait = 8000;
      } finally {
        asking = false;
        if (live) { if (again) { again = false; void poll(); } else timer = setTimeout(poll, wait); }
      }
    };
    kick.current = () => void poll();
    void poll();
    return () => { live = false; kick.current = () => undefined; if (timer) clearTimeout(timer); };
  }, [available]);
  useEffect(() => { if (landed) kick.current(); }, [landed]);
  // The player found the link a pressed song is being fetched from: look for its job now.
  useEffect(() => (available ? songSources.subscribe(() => bump(n => n + 1)) : undefined), [available]);

  const urls = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of tracks) {
      const u = t.provider === 'ytmusic' ? sourceUrlFor(t.platform_id) : null;
      if (u) m.set(t.key, u);
    }
    return m;
  }, [tracks]);

  return useMemo(() => {
    if (!available) return () => null;
    return (key: string) => {
      // Any song the loader has a link for, not only YouTube Music's own: most songs come from another service and
      // are matched to a link, and those showed no progress at all.
      const url = urls.get(key) ?? songSources.get(key) ?? queueAudio.sourceHint({ key } as Track);
      const ring = url ? rings[url] : undefined;
      const card = queueAudio.cardOf(key, { kept: kept.has(key), percent: ring ? ring.percent : null });
      if (card.state === 'ready') return card;
      // RING-CLOSE-001: the shell holds this song's file (the player fetched it, or a download just finished). The
      // ring reached 100 and then fell back to an empty outline, because only the loader's list was consulted.
      if (url && localLibrary.status(url) === 'ready') return { ...card, state: 'ready', glyph: '✓', text: 'Ready in queue cache', progress: 100, indeterminate: false };
      if (card.state === 'downloading') return card;
      // The listener pressed this song and the player is still finding or fetching it: started, no number yet.
      if (!ring) return songSources.isFetching(key) ? { ...card, state: 'downloading', glyph: '↓', text: 'Caching', progress: 0, indeterminate: true } : card;
      // RING-CLOSE-001: a job for this very song is running (the player is fetching it), whatever the loader's own
      // list says of it, so the row shows that download.
      const p = ring.percent;
      return { ...card, state: 'downloading', glyph: '↓', text: p === null ? 'Caching' : `Caching · ${p}%`, progress: p ?? 0, indeterminate: p === null };
    };
  }, [available, urls, kept, rings, landed]);
}
