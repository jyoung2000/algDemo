import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { api, type Characteristics, type RecItem, type RecResult, type Track } from './api';
import { wantsAlbum } from './engine/album-name';

/**
 * GENRE-LOAD-001 — owner: "ensure genre & sub genre tags load on both apps".
 *
 * A queue row shows genre bubbles from what the discovery run worked out. Rows that never went through
 * a run (a song the listener added, a queue brought back after a restart) or that the run could not place
 * had none. The engine can look those up (/api/queue/genres); this asks it for a few at a time until
 * nothing is left, and puts each answer on its row.
 */
export interface GenreAnswer {
  key: string;
  tags: Track['tags'];
  characteristics: Characteristics;
  /** ALBUM-NAME-001: the album the song is on, when its row only had its single. */
  album?: string | null;
  album_id?: string | null;
  album_looked?: boolean | number;
  album_confirmed?: boolean;
}

/**
 * A row is placed once it names a genre or a family that a service or a listener gave it. One placed
 * only by a guess of ours ("pop, lent by the starting song") still shows it, and is still asked about.
 */
export function rowPlaced(item: RecItem): boolean {
  // ALBUM-NAME-001: a row still showing only its single's name waits for its album to be looked up.
  if (wantsAlbum(item.track as never)) return false;
  const c = item.characteristics;
  if (!c || !((c.genres ?? []).length || c.family)) return false;
  // GENRE-ALL-001: the engine says a lookup can still name this row's subgenre.
  if (c.genre_pending) return false;
  const tags = item.track.tags ?? [];
  return !(tags.length > 0 && tags.every((g) => g.inferred));
}

/** The queue with each answer on its row. The same object back when nothing changed, so nothing redraws. */
export function mergeGenres(result: RecResult, rows: readonly GenreAnswer[]): RecResult {
  const by = new Map(rows.map((r) => [r.key, r]));
  let changed = false;
  const items = result.items.map((item) => {
    const got = by.get(item.track.key);
    if (!got) return item;
    changed = true;
    // The engine's answer is the row's whole state: a "can still be improved" mark it no longer sends is gone.
    const { genre_pending: _was, ...kept } = (item.characteristics ?? {}) as Characteristics;
    const album = got.album_looked ? { album_looked: got.album_looked, ...(got.album ? { album: got.album, album_id: got.album_id ?? undefined } : {}), ...(got.album_confirmed ? { album_confirmed: true } : {}) } : {};
    return { ...item, track: { ...item.track, tags: got.tags, ...album }, characteristics: { ...kept, ...got.characteristics } };
  });
  return changed ? { ...result, items } : result;
}

export function useQueueGenres(result: RecResult | null, running: boolean, setResult: Dispatch<SetStateAction<RecResult | null>>): void {
  // The rows still to place, as one string: asking again is tied to that set changing.
  const wanted = (result?.items ?? []).filter((x) => !rowPlaced(x)).map((x) => x.track.key).join('\n');
  const [again, setAgain] = useState(0);
  const busy = useRef(false);
  /** The set the engine last said it could do no more for; not asked about again until it changes. */
  const settled = useRef('');

  useEffect(() => {
    if (!wanted || running || busy.current || settled.current === wanted) return;
    busy.current = true;
    let live = true;
    api.queueGenres().then(
      (r) => {
        busy.current = false;
        if (!live) return;
        const rows = Array.isArray(r?.items) ? r.items : [];
        if (rows.length) setResult((prev) => (prev ? mergeGenres(prev, rows) : prev));
        // More to ask: go round again (the rows just placed are no longer in the set).
        if (r?.left > 0 && !r.spent) return setAgain((n) => n + 1);
        // Nothing more can be asked: the rows still unplaced wait for the queue to change.
        settled.current = wanted.split('\n').filter((k) => !rows.some((x) => x.key === k)).join('\n');
      },
      () => {
        busy.current = false;
        if (live) settled.current = wanted;
      },
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, running, again]);
}
