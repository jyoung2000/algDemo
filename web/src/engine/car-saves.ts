/**
 * CAR-SAVE-HIDDEN-001 (owner, 2026-11-23): "on android auto hearting a song doesnt bring up the playlist sub menu
 * like desired" and "the playlist dont load or save the music".
 *
 * The saves the car asks for, done by the engine the playback service owns. With jPlay's screen not in front the
 * phone page is frozen (measured: no timer and no task runs in it), so a star or a playlist choice handed to it was
 * saved only when the app was next opened, or never. The service engine is the one that keeps running in a car.
 *
 * Pure of the page: everything it needs is passed in, so the same rules are tested without a browser.
 */
import type { FeedbackKind, PlaylistSummary, Track } from '../api';
import { CAR_NEW_LIST, CAR_NEW_LIST_NAME, type CarFeedbackKind } from './media-native';

type EditAction = 'add' | 'create';
interface EditBody { ids?: string[]; name?: string; key: string; tracks: Track[] }

export interface CarSaveDeps {
  /** The song behind a car id, from the queue, the catalogue or the saved library; null when unknown. */
  findTrack(id: string): Promise<Track | null>;
  feedback(kind: FeedbackKind, track: Track, extra: { event_id: string; origin: string }): Promise<unknown>;
  playlists(): Promise<{ lists: PlaylistSummary[] }>;
  playlistEdit(action: EditAction, body: EditBody): Promise<{ lists: PlaylistSummary[] }>;
  eventId(kind: string, key: string): string;
  /**
   * A save this engine could not make (it cannot name the song, or the write failed). The press is handed back to
   * be kept for the phone app, as it was before this engine saved anything; it is never dropped.
   */
  unsaved?(cmd: UnsavedCarCommand): void;
}

export type UnsavedCarCommand =
  | { type: 'feedback'; id: string; kind: CarFeedbackKind; track?: Track }
  | { type: 'playlistAdd'; id: string; list: string; track?: Track };

/** A star, its removal, a dislike or its removal, pressed in the car. False when the song cannot be named. */
export async function carFeedback(id: string, kind: CarFeedbackKind, carTrack: Track | undefined, deps: CarSaveDeps): Promise<boolean> {
  const t = (await deps.findTrack(id).catch(() => null)) ?? carTrack ?? null;
  if (!t) { deps.unsaved?.({ type: 'feedback', id, kind }); return false; }
  try {
    await deps.feedback(kind, t, { event_id: deps.eventId(kind, t.key), origin: 'explicit' });
    return true;
  } catch {
    deps.unsaved?.({ type: 'feedback', id, kind, track: t });
    return false;
  }
}

/**
 * The playlist the driver picked for a song (CAR-CONTROLS-001), or the one the car offers to start when there is
 * none (CAR-HEART-ALWAYS-001: made once, found by its name after). Saved exactly as the phone's own add: the song
 * is saved, then joins the list. Albums are never added to.
 */
export async function carPlaylistAdd(id: string, listId: string, carTrack: Track | undefined, deps: CarSaveDeps): Promise<{ saved: boolean; list?: string }> {
  const t = (await deps.findTrack(id).catch(() => null)) ?? carTrack ?? null;
  if (!t) { deps.unsaved?.({ type: 'playlistAdd', id, list: listId }); return { saved: false }; }
  try {
    const starting = listId === CAR_NEW_LIST;
    const { lists } = await deps.playlists();
    const list = lists.find((l) => !l.album && (starting ? l.name === CAR_NEW_LIST_NAME : l.id === listId));
    if (!list && !starting) return { saved: false };
    await deps.feedback('save', t, { event_id: deps.eventId('save', t.key), origin: 'explicit' });
    if (list) await deps.playlistEdit('add', { ids: [list.id], key: t.key, tracks: [t] });
    else await deps.playlistEdit('create', { name: CAR_NEW_LIST_NAME, key: t.key, tracks: [t] });
    return { saved: true, list: list?.name ?? CAR_NEW_LIST_NAME };
  } catch {
    deps.unsaved?.({ type: 'playlistAdd', id, list: listId, track: t });
    return { saved: false };
  }
}
