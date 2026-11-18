/**
 * LIST-STRIP-001: the colour strip for a saved or imported list, read from its songs' own tags.
 *
 * Reuses the Sound card's mapping end to end: the songs' tags become a TasteSummary (every song
 * counts once, each of its genres once - "Rap" and "Hip Hop" are one tag because the engine's tags
 * are already canonical), `soundView` places them in Taste Picker families and subgenres with the
 * one palette, and `gradientOf` draws the same gradient the "Your sound" bar animates. There is no
 * second colour table here. Estimated (inferred) tags are not counted, so the strip only shows what
 * a service stated; a list none of whose songs has a stated genre has no strip.
 */
import type { TasteGenre, TasteSummary, Track } from './api';
import { describeSound, gradientOf, soundView, type SoundView } from './taste-view';

type TagLike = { name?: unknown; label?: unknown; inferred?: unknown };

/** The canonical stated genres of one song, each once. */
function statedOf(t: { tags?: unknown } | null | undefined): { name: string; label: string }[] {
  const seen = new Set<string>();
  const out: { name: string; label: string }[] = [];
  for (const g of (Array.isArray(t?.tags) ? t.tags : []) as TagLike[]) {
    if (!g || typeof g.name !== 'string' || !g.name || g.inferred || seen.has(g.name)) continue;
    seen.add(g.name);
    out.push({ name: g.name, label: typeof g.label === 'string' && g.label ? g.label : g.name });
  }
  return out;
}

/** A list's songs as the TasteSummary the Sound card reads, or null when none has a stated genre. */
export function listTaste(tracks: readonly ({ tags?: unknown } | null | undefined)[]): { taste: TasteSummary | null; songs: number; placed: number } {
  const by = new Map<string, TasteGenre>();
  let placed = 0;
  let songs = 0;
  for (const t of tracks) {
    if (!t) continue;
    songs++;
    const tags = statedOf(t);
    if (!tags.length) continue;
    placed++;
    for (const g of tags) {
      const have = by.get(g.name) ?? { name: g.name, label: g.label, score: 0, plays: 0, skips: 0 };
      have.score += 1;
      have.plays = (have.plays ?? 0) + 1;
      by.set(g.name, have);
    }
  }
  if (!placed) return { taste: null, songs, placed };
  const genres = [...by.values()].map((g) => ({ ...g, score: g.score / placed })).sort((a, b) => b.score - a.score);
  return { taste: { events: placed, positives: placed, negatives: 0, bpm: null, skip_bpm: null, likes: genres, avoids: [], genres }, songs, placed };
}

export interface ListStrip {
  /** CSS background for the strip, or null when no song has a stated genre yet. */
  gradient: string | null;
  /** Plain words for assistive tech: "Rage 50%, General hip-hop 50%" or an honest empty state. */
  label: string;
  songs: number;
  placed: number;
  view: SoundView | null;
}

/** The strip for a list: the Sound card's gradient for the list's songs, or an honest empty state. */
export function listStrip(tracks: readonly (Pick<Track, 'tags'> | { tags?: unknown } | null | undefined)[]): ListStrip {
  const { taste, songs, placed } = listTaste(tracks);
  const view = soundView(taste);
  if (!view || !view.bar.length) return { gradient: null, label: songs ? 'No genres known yet' : 'No songs yet', songs, placed, view: null };
  return { gradient: gradientOf(view.bar), label: describeSound(view, 3), songs, placed, view };
}
