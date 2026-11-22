// RADIO-PLAYING-NOW-002 (owner, 2026-11-21): "I tried searching by artist and by song name on the radio tab and it
// didnt return stations playing that artist or song even though the station i was actively listening to was playing
// the song i searched for".
//
// Measured the same day: TuneIn's station search returned no station at all for "sombr" or "barely know her" while
// Christmas FM Non-stop (a Radio Browser station) was playing sombr's "I Barely Know Her" in jPlay. TuneIn only knows
// the songs of stations that report to it, and it matches artists, not song titles. So the stations jPlay itself can
// hear are asked too: the station playing now (its in-band title, feed or fingerprint), the starred stations and the
// stations listed for the listener's places. A station counts only when its CURRENT song names every typed word.
import { fold } from './identity';
import { freshBroadcast, type Broadcast, type RadioStation } from './radio';
import { playingMatches, type PlayingStation } from './radio-tunein';

/** What is known about one station's song on air: the broadcaster's words and, once identified, the song itself. */
export interface HeardNow { station: RadioStation; broadcast: Broadcast | null; track?: { title?: string; artist?: string; artists?: string[] } | null }

/** The station as a "playing now" row when its current song names the search, else null. */
export function heardPlaying(query: string, h: HeardNow, now = Date.now()): PlayingStation | null {
  const b = h.broadcast ? freshBroadcast(h.broadcast, now) : null;
  const t = h.track?.title ? { artist: [h.track.artist, ...(h.track.artists ?? [])].filter(Boolean).join(' '), title: h.track.title } : null;
  const fromBroadcast = b && b.state === 'current' && b.kind === 'song' && b.title ? { artist: b.artist ?? '', title: b.title } : null;
  // The broadcaster's own words are shown when they name the search; an identified song stands when they do not.
  if (fromBroadcast && b && playingMatches(fromBroadcast, query)) return { station: h.station, broadcast: b };
  if (t && playingMatches(t, query)) return { station: h.station, broadcast: { state: 'current', kind: 'song', artist: h.track!.artist || h.track!.artists?.join(', ') || null, title: t.title, source: 'Identified by jPlay', checkedAt: now } };
  return null;
}

/** Stations to ask, each once, in order, at most [limit]: a station already listed by id or by name is skipped. */
export function stationsToAsk(lists: readonly (readonly RadioStation[])[], limit: number): RadioStation[] {
  const ids = new Set<string>(), names = new Set<string>(), out: RadioStation[] = [];
  for (const list of lists) for (const s of list) {
    const name = fold(s.name);
    if (ids.has(s.id) || (name && names.has(name))) continue;
    ids.add(s.id); if (name) names.add(name); out.push(s);
    if (out.length >= limit) return out;
  }
  return out;
}

/**
 * Asks each station what it is playing, a few at a time, and reports every one whose current song names the search
 * as soon as its answer arrives. A station that does not answer is simply not listed. Stops early once [gone] says so.
 */
export async function askStationsPlaying(query: string, stations: readonly RadioStation[], probe: (s: RadioStation) => Promise<Broadcast>,
  found: (row: PlayingStation) => void, opts: { concurrency?: number; gone?: () => boolean; timeoutMs?: number } = {}): Promise<void> {
  const wait = opts.timeoutMs ?? 8000;
  let next = 0;
  const worker = async () => {
    while (next < stations.length && !opts.gone?.()) {
      const s = stations[next++]!;
      let b: Broadcast | null = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { b = await Promise.race([probe(s), new Promise<null>(r => { timer = setTimeout(() => r(null), wait); })]); } catch { /* a silent station is not listed */ } finally { clearTimeout(timer); }
      if (opts.gone?.()) return;
      const row = heardPlaying(query, { station: s, broadcast: b });
      if (row) found(row);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 4, stations.length)) }, worker));
}
