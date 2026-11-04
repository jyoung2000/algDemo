import { useEffect, useState } from 'react';
import type { Track } from './api';
import { dl, downloadsAvailable, targetFor } from './engine/downloads';

/**
 * QUEUE-CTRL-001: which songs the user has permanently KEPT in the Music folder.
 *
 * Distinct from the queue cache, which is automatic and evictable, and distinct from a saved
 * playlist, which records intent rather than a file on disk. Only the shell's own library index
 * knows this, so it is asked rather than inferred.
 */
export function useKeptKeys(tracks: Track[]): ReadonlySet<string> {
  const [kept, setKept] = useState<ReadonlySet<string>>(() => new Set());
  const available = downloadsAvailable();

  useEffect(() => {
    if (!available) return;
    let live = true;
    (async () => {
      const found = new Set<string>();
      for (const t of tracks) {
        const target = targetFor(t);
        if (!target) continue;
        try {
          const r = await dl.local(target.url);
          // A file the shell still holds for this link, not one merely being fetched.
          if (live && r.file && !r.running) found.add(t.key);
        } catch {
          // A shell that cannot answer is not evidence the song is kept.
        }
        if (!live) return;
      }
      if (live) setKept(found);
    })();
    return () => { live = false; };
  }, [available, tracks]);

  return kept;
}
