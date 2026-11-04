import { useEffect, useMemo, useState } from 'react';
import type { Track } from './api';
import { dl, downloadsAvailable } from './engine/downloads';
import { localLibrary, sourceUrlFor } from './engine/local-audio';
import { queueAudio } from './engine/queue-audio';
import type { CardCache } from './engine/queue-controls';

/**
 * QUEUE-CTRL-001: per-song cache state for the song cards.
 *
 * Progress comes from the shell's own job records, never interpolated — a smooth animation over an
 * unknown percent would be a fabricated number. Polling only runs while something is downloading,
 * so an idle list costs nothing.
 */
export function useCardCache(tracks: Track[], kept: ReadonlySet<string>): (key: string) => CardCache | null {
  const available = downloadsAvailable();
  const [, bump] = useState(0);
  const [pct, setPct] = useState<Record<string, number | null>>({});

  // The library tells us when a file lands; that is also when a card flips to ready.
  useEffect(() => {
    if (!available) return localLibrary.subscribe(() => undefined);
    return localLibrary.subscribe(() => bump(n => n + 1));
  }, [available]);

  useEffect(() => {
    if (!available) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
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
        setPct(next);
        // Idle lists must not poll: nothing is moving, so nothing can change the number.
        timer = setTimeout(poll, running ? 1000 : 4000);
      } catch {
        timer = setTimeout(poll, 8000);
      }
    };
    void poll();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [available]);

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
      const url = urls.get(key);
      return queueAudio.cardOf(key, { kept: kept.has(key), percent: url ? pct[url] ?? null : null });
    };
  }, [available, urls, kept, pct]);
}
