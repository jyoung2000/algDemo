import type { PlaylistMix } from './api';

/** The line under a saved list's Sound card: what it is read from, and how much of the list that covers. */
export function listMixNote(m: PlaylistMix): string {
  const base = `From the genres of the ${m.songs} ${m.songs === 1 ? 'song' : 'songs'} in this list`;
  if (m.placed >= m.songs) return `${base}. It redraws as you add or remove songs.`;
  const left = m.songs - m.placed;
  return `${base}. ${left} ${left === 1 ? 'has' : 'have'} no genre yet; ${left === 1 ? 'it fills' : 'they fill'} in as discovery looks ${left === 1 ? 'it' : 'them'} up.`;
}
