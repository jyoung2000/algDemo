import type { AlbumMix } from './api';

/** The line under a Sound card for a list or an album: what it is read from, and how much it covers. */
export function listMixNote(m: AlbumMix, where: 'list' | 'album' = 'list'): string {
  const base = `From the genres of the ${m.songs} ${m.songs === 1 ? 'song' : 'songs'} ${where === 'album' ? 'on this album' : 'in this list'}`;
  if (m.placed >= m.songs) return `${base}. It redraws as you add or remove songs.`;
  const left = m.songs - m.placed;
  return `${base}. ${left} ${left === 1 ? 'has' : 'have'} no genre yet; ${left === 1 ? 'it fills' : 'they fill'} in as discovery looks ${left === 1 ? 'it' : 'them'} up.`;
}
