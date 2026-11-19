/**
 * CAR-SIMILAR-001 (owner, 2026-11-18): Android Auto's "Find similar songs" button, beside Repeat,
 * runs the same audio-verified sound match as the phone's "Find similar sound" button
 * (SIMILAR-SOUND-001) for the song the car is playing. Only songs that pass the listener's
 * similarity bar are added, at most ten, to the end of the now playing list, as on the phone; the car
 * is told how many were added, or the job's own reason when none were.
 */
import type { Track } from '../api';
import { decodeCarAlbumId, decodePlaylistMediaId, type NativeSong } from './media-native';

export interface CarSimilarAnswer { added: number; minimum: number; reason: string; songs: NativeSong[] }

interface JobStatus { done: boolean; error?: string | null; progress?: string; result?: unknown }

export interface CarSimilarDeps {
  /** The full Track behind a song key: the now playing list first, then anything else the engine holds. */
  findTrack: (key: string) => Track | null | Promise<Track | null>;
  similar: (track: Track) => Promise<{ job: string }>;
  job: (id: string) => Promise<JobStatus>;
  /** The song as the native side needs it (with the exact local file once it is downloaded). */
  song: (track: Track) => NativeSong;
  /** The list after the additions, for the page that shows it. */
  onQueue?: (queue: unknown) => void;
  wait: (ms: number) => Promise<void>;
}

/** The song key a car media id names; null for radio or anything that is not a song. */
export function similarSeedKey(id: string): string | null {
  if (!id || id.startsWith('radio')) return null;
  const album = decodeCarAlbumId(id);
  if (album) return album.key;
  const listed = decodePlaylistMediaId(id);
  if (listed) return listed.key;
  return id.includes('/') ? null : id;
}

const POLL_MS = 700;
/** Matching can analyse up to sixty songs; past this the car stops waiting (the job still finishes). */
const LIMIT_MS = 180_000;

export async function runCarSimilar(id: string, d: CarSimilarDeps): Promise<CarSimilarAnswer> {
  const key = similarSeedKey(id);
  const seed = key ? await d.findTrack(key) : null;
  if (!seed) throw new Error('Play a song from your list first, then try Find similar again.');
  const { job } = await d.similar(seed);
  const started = Date.now();
  for (;;) {
    const status = await d.job(job);
    if (status.done) {
      if (status.error) throw new Error(status.error);
      const out = (status.result ?? null) as { added?: number; minimum?: number; reason?: string; matches?: { key?: string }[]; queue?: { items?: { track?: Track }[] } } | null;
      if (!out) throw new Error('The sound comparison did not return a result.');
      const keys = new Set((out.matches ?? []).map((m) => String(m.key ?? '')));
      const tracks = (out.queue?.items ?? []).flatMap((it) => (it.track && keys.has(it.track.key) ? [it.track] : []));
      if (out.queue && tracks.length) d.onQueue?.(out.queue);
      return { added: Number(out.added) || 0, minimum: Number(out.minimum) || 0, reason: String(out.reason ?? ''), songs: tracks.slice(0, 10).map((t) => d.song(t)) };
    }
    if (Date.now() - started > LIMIT_MS) throw new Error('Still comparing sounds. The songs will be in your list when it finishes.');
    await d.wait(POLL_MS);
  }
}
