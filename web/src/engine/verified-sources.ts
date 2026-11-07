import { fold } from './identity';
import type { Track } from '../api';

/**
 * Owner-verified full-song sources (SOURCE-VERIFIED-001).
 *
 * The strict recording matcher protects discovery: it will not accept an upload whose artist does
 * not match, which is correct for the general case. But some exact recordings only exist under a
 * re-uploader's name — the owner has listened and confirmed the audio IS the recording they asked
 * for. This is a short, hand-checked list of those confirmations. An entry overrides search and
 * identity for ONE song only; it does not loosen matching for anything else.
 *
 * Each entry names a public, streamable URL the app already downloads from through its normal path
 * (today: SoundCloud via yt-dlp, a public HLS stream — no DRM or access-control bypass). The target
 * duration is kept so a mistaken paste cannot silently stand in for a different-length recording.
 */
export interface VerifiedSource {
  /** The owner's recording, matched against the queue song. */
  isrc?: string;
  title: string;
  artist: string;
  duration: number;
  /** The confirmed public source URL. */
  url: string;
  source: 'soundcloud';
  note: string;
}

export const VERIFIED_SOURCES: readonly VerifiedSource[] = [
  {
    isrc: 'USHM81262832',
    title: 'Plant Island',
    artist: 'My Singing Monsters',
    duration: 219,
    url: 'https://soundcloud.com/ghostmeow/my-singing-monsters-plant',
    source: 'soundcloud',
    note: 'Owner-verified: the exact 219.334s Plant Island recording, public SoundCloud stream.',
  },
];

/** Match within two seconds so a confirmation cannot stand in for a different-length recording. */
const DURATION_TOLERANCE = 2;

/**
 * The owner-confirmed source for this queue song, or null. Matches by ISRC when the song carries
 * one; otherwise by exact folded title AND folded artist AND duration within tolerance, so a
 * same-title different song (or a different-length edit) is never swapped in.
 */
export function verifiedSourceFor(t: Pick<Track, 'title' | 'artists' | 'artist' | 'duration' | 'isrc'>): VerifiedSource | null {
  const isrc = (t.isrc ?? '').trim().toUpperCase();
  const title = fold(String(t.title ?? ''));
  const artistText = fold([...(t.artists ?? []), t.artist ?? ''].join(' '));
  const dur = Number(t.duration);
  for (const v of VERIFIED_SOURCES) {
    if (isrc && v.isrc && isrc === v.isrc.toUpperCase()) return v;
    if (!title || !artistText) continue;
    const sameTitle = title === fold(v.title);
    const sameArtist = artistText.includes(fold(v.artist));
    const sameLength = Number.isFinite(dur) && Math.abs(dur - v.duration) <= DURATION_TOLERANCE;
    if (sameTitle && sameArtist && sameLength) return v;
  }
  return null;
}
