import { dl } from './downloads';
import { FolderSaves } from './list-save';
import { queueAudio } from './queue-audio';

const storage = (() => {
  try { return typeof window !== 'undefined' ? window.localStorage : undefined; }
  catch { return undefined; }
})();

/** LIST-SAVE-FOLDER-001: one saver for the app, so leaving a screen never stops or repeats a run. */
export const folderSaves = new FolderSaves({
  downloadAll: (tracks) => queueAudio.downloadAll(tracks),
  readyUrl: (t) => queueAudio.readyUrl(t),
  snapshot: (tracks) => queueAudio.snapshotFor(tracks),
  subscribe: (fn) => queueAudio.subscribe(fn),
  save: (kind, name, songs, total) => dl.saveList(kind, name, songs, total),
  open: (kind, name) => dl.openSaved(kind, name),
  storage,
});
