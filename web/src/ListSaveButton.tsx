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
export function ListSaveButton({ tracks, kind, name, label, icon = false }: { tracks: Track[]; kind: SaveKind; name: string; label: string; /** ARTIST-SAVE-ICON-001: the download arrow alone, no words. */ icon?: boolean }) {
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
  // LIST-FOLDER-002 (owner, 2026-11-19): "If an album or playlist has already been downloaded locally 100%
  // then remove the download icon and replace it with a folder icon to open the local folder".
  if (complete && !running) {
    return (
      <>
        <button type="button" className="iconbtn list-save__folder" onClick={() => void open()}
          aria-label={`Open the folder with ${label}`} title={`All ${songs(tracks.length)} of ${label} are downloaded. Open the folder.`}>
          <Glyph name="folder" size={14} />
        </button>
        {note && <span className="list-save__note" role="status">{note}</span>}
      </>
    );
  }
  return (
    <>
      <button
        className={icon ? 'iconbtn list-save__go' : 'push'}
        type="button"
        aria-label={icon ? `${text}: ${label}` : undefined}
        // A finished folder can still be pressed: it puts back any song deleted from the folder since.
        // While it runs the button stays focusable (aria-disabled, not disabled), so a keyboard user's
        // focus is not dropped to the page when they press it.
        aria-disabled={running || undefined}
        aria-busy={running}
        title={s.held > 0 ? `Download the ${songs(Math.max(0, tracks.length - s.held))} of ${label} not in its folder yet` : `Download every song in ${label} into a folder of its own`}
        onClick={() => { if (running) return; setNote(null); folderSaves.start(kind, name, tracks); }}
      >
        <Glyph name={complete ? 'check' : 'download'} size={14} />{icon ? null : <> {text}</>}
      </button>
      {/* ALBUM-TIDY-001 (owner, 2026-11-22): "turn the download to folder icon into just a download icon". As an icon, the
          folder button waits until the folder holds a song; a greyed-out folder beside the arrow said nothing. */}
      {(!icon || s.held > 0) && <button
        type="button"
        className="iconbtn list-save__folder"
        disabled={s.held === 0}
        onClick={() => void open()}
        aria-label={`Open the folder with ${label}`}
        title={s.held ? `Open the folder with ${label} (${songs(s.held)})` : `Download ${label} to its folder first`}
      >
        <Glyph name="folder" size={14} />
      </button>}
      {(status || note) && <span className="list-save__note" role="status">{note ?? status}</span>}
    </>
  );
}
