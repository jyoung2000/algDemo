/**
 * PLAYER-TRUTH-001 (owner, 2026-11-19): "I clicked on another song that wasnt loaded while playing a song and
 * ... the new song replaced the current song in the player even though the audio was ... still the current
 * song. The player should be representative of the audio currently playing."
 *
 * On Android the engine keeps playing the old song until the chosen one's audio opens. Its state names the
 * chosen song (`id`) and, separately, the song its deck is sounding (`sounding`). While the deck still sounds
 * the song shown before, the player keeps showing that song (and its real position); the chosen one is shown
 * as loading next. A pause keeps it shown; the old song ending (the engine stops by itself, so it still wants
 * to play) or the chosen song starting lets the chosen song take over.
 */
export interface SoundingState {
  id: string | null;
  playWhenReady: boolean;
  sounding?: string | null;
  soundingPlaying?: boolean;
}

export function heldOverKey(st: SoundingState | null | undefined, chosenKey: string | null, shownBefore: string | null): string | null {
  if (!st || !chosenKey || !shownBefore || shownBefore === chosenKey) return null;
  if (st.id !== chosenKey) return null;
  const s = st.sounding ?? null;
  if (!s || s !== shownBefore || s === chosenKey) return null;
  // Still audible, or paused by the listener. Stopped while still wanting to play = it ended.
  return st.soundingPlaying || !st.playWhenReady ? s : null;
}
