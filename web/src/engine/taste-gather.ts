/**
 * COLOR-DISCOVERY-001: the listener's colours as a source of new music.
 *
 * Every other gather source hangs off a starting song, and those pools are finite - ask twice and
 * the second answer is the first one. The colours are not finite: each strong colour is a cell in
 * the Taste Picker, each cell names real reference artists, and a cursor walks further through them
 * (and deeper into each artist's catalogue) on every run, so there is always something new to ask
 * for. What the listener skips away from is never asked for, and a listener with no colours yet asks
 * nothing, because inventing a genre for someone is worse than finding nothing.
 */
import { CATALOG } from './taste-catalog';
import { genreIdentity } from './genre-identity';
import { SUBS } from './genre-table';
import { FAMILIES } from './genre-table';

/** The relation stamped on a song a colour found. Exploration, like the genre chart: not relatedness. */
export const TASTE_RELATION = 'taste_colour';

/** A colour has to be meant before it is acted on; a single stray play is not a taste. */
export const COLOUR_FLOOR = 0.15;

/**
 * Asks per run. Six searches is a handful of kilobytes against the day's allowance, and it is
 * enough for the queue to keep growing on colours alone when every seed source is spent.
 */
export const TASTE_ASKS_PER_RUN = 6;

export interface Colour {
  name: string;
  label: string;
  score: number;
}

export interface TasteAsk {
  /** `artist` searches a named reference artist of that cell; `words` searches the cell's own name. */
  kind: 'artist' | 'words';
  /** What to ask the services for. */
  term: string;
  /** How deep into that term's results to read; the same term twice never returns the same page. */
  page: number;
  /** The colour this came from, for the reason shown to the listener. */
  genre: string;
  label: string;
  /** Where the next run should carry on from. */
  nextCursor: number;
}

/** Reference artists for a colour, from the picker cell it names. [] when the catalogue has no cell. */
export function colourArtists(key: string): string[] {
  const sub = SUBS.find((s) => s.key === key);
  if (!sub) return [];
  for (const fam of CATALOG) {
    const cell = fam.subs.find((s) => s.name === sub.name);
    if (cell) return cell.artists;
  }
  return [];
}

/** The words to search for a colour the catalogue has no cell for: its own name, and its family's. */
function colourWords(c: Colour): string[] {
  const fam = FAMILIES.find((f) => f.slug === c.name);
  const base = (fam?.name ?? c.label ?? c.name).replace(/\s*\/\s*/g, ' ').trim();
  return [base, `${base} 2026`, `${base} new`, `best ${base}`];
}

/**
 * Up to `want` things to ask the music services for, built from the listener's colours.
 *
 * `cursor` is carried in the store and advances every run, so run two asks for what run one did not.
 * The strongest colour gets the most asks, in proportion to how strongly the listening says it.
 */
export function tasteAsks(colours: Colour[], cursor: number, want: number): TasteAsk[] {
  const liked = colours.filter((c) => c.score >= COLOUR_FLOOR).sort((a, b) => b.score - a.score).slice(0, 6);
  if (!liked.length || want <= 0) return [];
  const total = liked.reduce((a, c) => a + c.score, 0);
  // Shares in proportion to the colour, but every colour that made the floor gets at least one ask.
  const shares = liked.map((c) => Math.max(1, Math.round((c.score / total) * want)));
  const asks: TasteAsk[] = [];
  const step = Math.max(0, Math.trunc(cursor));
  for (let i = 0; i < liked.length && asks.length < want; i++) {
    const c = liked[i] as Colour;
    const artists = colourArtists(c.name);
    const words = colourWords(c);
    const pool: { kind: 'artist' | 'words'; term: string }[] = [
      ...artists.map((a) => ({ kind: 'artist' as const, term: a })),
      ...words.map((w) => ({ kind: 'words' as const, term: w })),
    ];
    if (!pool.length) continue;
    for (let k = 0; k < (shares[i] as number) && asks.length < want; k++) {
      // Every colour reads its pool from a different place, so one run's asks are spread across it.
      const at = step * want + i * 3 + k;
      const pick = pool[at % pool.length] as { kind: 'artist' | 'words'; term: string };
      // Once the pool has been walked through, the same terms are read a page deeper instead.
      const page = Math.trunc(at / pool.length);
      // The colour is named the way its bubble names it (TAGS-CANON-001), so the reason shown to the
      // listener reads "Your sound leans Soul", not a service's own spelling.
      const label = genreIdentity(c.label || c.name)?.label ?? genreIdentity(c.name)?.label ?? c.label ?? c.name;
      asks.push({ ...pick, page, genre: c.name, label, nextCursor: step + 1 });
    }
  }
  // A term is asked once per run, however the shares landed.
  const seen = new Set<string>();
  return asks.filter((a) => {
    const id = `${a.term}#${a.page}`;
    return seen.has(id) ? false : (seen.add(id), true);
  });
}

/** The words shown to the listener for a colour-found song. */
export function tasteAskReason(label: string): string {
  return `Your sound leans ${label}, so the services were asked for more of it`;
}

export interface TasteWideAsk {
  /** A reference artist of one of the listener's colours, as the starting point. */
  term: string;
  /** 0 = that artist's own neighbours; deeper walks a step further out each time round. */
  depth: number;
  genre: string;
  label: string;
}

/**
 * One widening ask per run. Three reference artists per colour read a page deeper every run would
 * fade: the depth grows but the breadth does not. So each run also follows one of those artists out
 * to the artists the service puts beside them, which is how a colour keeps finding music nobody
 * named in the catalogue.
 */
export function tasteWideAsk(colours: Colour[], cursor: number): TasteWideAsk | null {
  const liked = colours.filter((c) => c.score >= COLOUR_FLOOR).sort((a, b) => b.score - a.score).slice(0, 6);
  if (!liked.length) return null;
  const step = Math.max(0, Math.trunc(cursor));
  // The colours take turns, strongest first, so one run never spends the whole widening budget on one.
  const c = liked[step % liked.length] as Colour;
  const names = colourArtists(c.name);
  const pool = names.length ? names : colourWords(c);
  const round = Math.trunc(step / liked.length);
  const term = pool[round % pool.length] as string;
  const label = genreIdentity(c.label || c.name)?.label ?? genreIdentity(c.name)?.label ?? c.label ?? c.name;
  return { term, depth: Math.trunc(round / pool.length), genre: c.name, label };
}
