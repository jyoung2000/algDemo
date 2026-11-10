import { useEffect, useState } from 'react';
import { Glyph } from '@now-playing/aqua-ui/icons';
import type { Track } from './api';
import { downloadsAvailable } from './engine/downloads';
import { folderSaves } from './engine/folder-saves';
import type { SaveKind } from './engine/list-save';

const songs = (n: number) => `${n} ${n === 1 ? 'song' : 'songs'}`;

/**
 * LIST-SAVE-FOLDER-001. Owner: "add an option to quick download entire saved playlist / album and
 * download into seperated folder for just those tracks". One press downloads every song of a saved list
 * or album into a folder of its own; the folder button beside it opens that folder. The run belongs to
 * the app, not this button, so it carries on when the screen changes.
 */
export function ListSaveButton({ tracks, kind, name, label }: { tracks: Track[]; kind: SaveKind; name: string; label: string }) {
  const [, redraw] = useState(0);
  useEffect(() => folderSaves.subscribe(() => redraw((n) => n + 1)), []);
  const [note, setNote] = useState<string | null>(null);
  if (!downloadsAvailable() || !tracks.length) return null;
  const s = folderSaves.state(kind, name, tracks.length);
  const running = s.phase === 'running';
  const complete = s.held >= tracks.length;
  const text = running ? `Downloading ${s.held} of ${tracks.length}` : complete ? 'In its folder' : s.held > 0 ? 'Download the rest' : 'Download to folder';
  const status = s.error
    ? `The folder could not be written: ${s.error}`
    : s.phase === 'done' && s.folder
      ? `${s.held} of ${songs(tracks.length)} ${s.held === 1 ? 'is' : 'are'} in ${s.folder}.${s.missing ? ` ${s.missing === 1 ? '1 song had' : `${s.missing} songs had`} no full version to download.` : ''}`
      : null;
  const open = async () => {
    try {
      const r = await folderSaves.open(kind, name);
      setNote(r.ok ? null : 'Nothing is in the folder yet.');
    } catch (e) {
      setNote(`The folder could not be opened: ${(e as Error).message}`);
    }
  };
  return (
    <>
      <button
        className="push"
        type="button"
        // A finished folder can still be pressed: it puts back any song deleted from the folder since.
        // While it runs the button stays focusable (aria-disabled, not disabled), so a keyboard user's
        // focus is not dropped to the page when they press it.
        aria-disabled={running || undefined}
        aria-busy={running}
        title={complete ? `Check the folder with ${label} and put back any missing song` : `Download every song in ${label} into a folder of its own`}
        onClick={() => { if (running) return; setNote(null); folderSaves.start(kind, name, tracks); }}
      >
        <Glyph name={complete ? 'check' : 'download'} size={14} /> {text}
      </button>
      <button
        type="button"
        className="iconbtn list-save__folder"
        disabled={s.held === 0}
        onClick={() => void open()}
        aria-label={`Open the folder with ${label}`}
        title={s.held ? `Open the folder with ${label} (${songs(s.held)})` : `Download ${label} to its folder first`}
      >
        <Glyph name="folder" size={14} />
      </button>
      {(status || note) && <span className="list-save__note" role="status">{note ?? status}</span>}
    </>
  );
}
