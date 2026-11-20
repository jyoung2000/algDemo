/**
 * TAGS-SAME-001 (owner, 2026-11-20): the tags a song or station shows come from ONE rule per kind, so a row and the
 * player can never disagree (Discover, Radio, Saved, search).
 *
 * - A song: its genres from what is measured about it, else its stated tags.
 * - A station: when a song it is playing has been identified, that song's own genres (exactly what a song row for it
 *   shows); otherwise what the station plays, led by the playing song's genres when those are known.
 */
import type { Characteristics, Tag } from '../api';
import { genreBubbles, type GenreBubble } from '../util';
import { classifyStation, type StationGenre } from './radio-genres';

export function songTagBubbles(c?: Characteristics | null, tags?: readonly Tag[] | null): GenreBubble[] {
  if (c) return genreBubbles(c);
  if (tags?.length) return genreBubbles({ genres: tags.map((g) => g.label || g.name) } as Characteristics);
  return [];
}

export interface RadioTagStation { tags?: string[]; name: string; language?: string; countryCode?: string }
/** The live state of the playing station (radioSession), when this is the station playing. */
export interface RadioTagLive { identified?: boolean; characteristics?: Characteristics | null }

export function radioTagBubbles(s: RadioTagStation, live?: RadioTagLive | null): (GenreBubble | StationGenre)[] {
  if (live?.identified && live.characteristics) return songTagBubbles(live.characteristics);
  const now = live?.characteristics?.genres;
  return classifyStation({ tags: s.tags ?? [], name: s.name, language: s.language, countryCode: s.countryCode, ...(now?.length ? { nowPlaying: now } : {}) });
}
