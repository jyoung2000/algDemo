import { useEffect, useRef, useState } from 'react';
import type { Track } from './api';
import { dl, downloadsAvailable, targetFor } from './engine/downloads';
import { localLibrary } from './engine/local-audio';
import { queueAudio } from './engine/queue-audio';
import { songSources } from './engine/song-sources';

/** How long new links are gathered before the shell is asked about them. */
export const KEPT_SETTLE_MS = 800;

/** The link a song's file is stored under: its own, the one the player found, or the one the loader matched. */
const linkOf = (t: Track): string | null => targetFor(t)?.url ?? songSources.get(t.key) ?? queueAudio.sourceHint(t);

/**
 * QUEUE-CTRL-001: which songs the user has permanently KEPT in the Music folder.
 *
 * Distinct from the queue cache, which is automatic and evictable, and distinct from a saved
 * playlist, which records intent rather than a file on disk. Only the shell's own library index
 * knows this, so it is asked rather than inferred.
 *
 * ROW-DL-KEPT-001 (owner, 2026-11-22): this is what removes a song's Download icon, so it has to be right for every
 * song: one matched from another service is asked about once its link is known, and `rev` (the count of the
 * listener's finished downloads) asks about every song again.
 */
export function useKeptKeys(tracks: Track[], rev: unknown = 0): ReadonlySet<string> {
  const [kept, setKept] = useState<ReadonlySet<string>>(() => new Set());
  const available = downloadsAvailable();
  // The list by its songs, not by the array handed in: a caller that builds a new array each time it draws must not
  // set off a round of questions each time.
  const sig = tracks.map((t) => t.key).join('\n');
  const list = useRef(tracks);
  list.current = tracks;
  /** song key -> the link it was asked about, and the answer; for one list and one `rev`. */
  const asked = useRef<{ sig: string; rev: unknown; book: Map<string, { url: string; kept: boolean }> } | null>(null);
  const [links, setLinks] = useState(0);

  // New links arrive as songs are matched; gather them for a moment rather than asking on every one.
  useEffect(() => {
    if (!available) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const later = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        const book = asked.current?.book;
        if (list.current.some((t) => { const u = linkOf(t); return u !== null && book?.get(t.key)?.url !== u; })) setLinks((n) => n + 1);
      }, KEPT_SETTLE_MS);
    };
    const offA = songSources.subscribe(later), offB = queueAudio.subscribe(later);
    return () => { offA(); offB(); if (timer) clearTimeout(timer); };
  }, [available, sig]);

  useEffect(() => {
    if (!available) return;
    // A different list, or a finished download: forget the answers.
    if (!asked.current || asked.current.sig !== sig || asked.current.rev !== rev) asked.current = { sig, rev, book: new Map() };
    const mine = asked.current, book = mine.book, songs = list.current;
    let live = true;
    (async () => {
      for (const t of songs) {
        const url = linkOf(t);
        if (!url || book.get(t.key)?.url === url) continue;
        try {
          const r = await dl.local(url);
          // `kept` only: `file` is also true for an evictable queue-cache entry, and calling that
          // "Kept in Music folder" would erase the very distinction this badge exists to draw.
          book.set(t.key, { url, kept: Boolean(r.kept) });
          // A kept song is on the device: let the library learn it, so the song's Play button is blue wherever it is
          // listed (the library goes on checking the file is still there).
          if (r.kept) void localLibrary.refresh(url).catch(() => undefined);
        } catch {
          // A shell that cannot answer is not evidence the song is kept.
        }
        if (!live) return;
      }
      if (!live || asked.current !== mine) return;
      const found = new Set<string>();
      for (const t of songs) if (book.get(t.key)?.kept) found.add(t.key);
      setKept((prev) => (prev.size === found.size && [...found].every((k) => prev.has(k)) ? prev : found));
    })();
    return () => { live = false; };
  }, [available, sig, rev, links]);

  return kept;
}
