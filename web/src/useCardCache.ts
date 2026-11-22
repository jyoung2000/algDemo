import { useEffect, useMemo, useRef, useState } from 'react';
import type { Track } from './api';
import { dl, downloadsAvailable } from './engine/downloads';
import { localLibrary, sourceUrlFor } from './engine/local-audio';
import { queueAudio } from './engine/queue-audio';
import type { CardCache } from './engine/queue-controls';

export const POLL_BUSY_MS = 300;
export const POLL_IDLE_MS = 4000;
const samePct = (a: Record<string, number | null>, b: Record<string, number | null>): boolean => {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => k in b && a[k] === b[k]);
};

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
  const [pct, setPct] = useState<Record<string, number | null>>({});

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
        const next: Record<string, number | null> = {};
        let running = false;
        for (const j of jobs) {
          if (j.state !== 'running' && j.state !== 'queued') continue;
          running = true;
          next[j.url] = j.percent;
        }
        setPct((prev) => (samePct(prev, next) ? prev : next));
        // Idle lists must not poll often: nothing is moving, so nothing can change the number.
        wait = running ? POLL_BUSY_MS : POLL_IDLE_MS;
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
      const url = urls.get(key) ?? queueAudio.sourceHint({ key } as Track);
      return queueAudio.cardOf(key, { kept: kept.has(key), percent: url ? pct[url] ?? null : null });
    };
  }, [available, urls, kept, pct, landed]);
}
