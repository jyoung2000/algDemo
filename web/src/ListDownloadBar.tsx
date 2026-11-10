import { useEffect, useState } from 'react';
import type { Track } from './api';
import { dl, downloadsAvailable } from './engine/downloads';
import { queueAudio } from './engine/queue-audio';
import { ListAvailability } from './ListAvailability';
import { Glyph } from '@now-playing/aqua-ui/icons';

/**
 * Both the meter card and the header button read the same preloader snapshot, so they can never
 * disagree about how much of the list is already local.
 */
function useListStatus(tracks: Track[]) {
  const [status, setStatus] = useState(() => queueAudio.snapshotFor(tracks));
  useEffect(() => {
    const read = () => setStatus(queueAudio.snapshotFor(tracks));
    read();
    return queueAudio.subscribe(read);
  }, [tracks]);
  return status;
}

/**
 * LIST-AVAILABILITY-001: the bar above one list, reading only that list's songs.
 *
 * It subscribes to the same preloader the background queue uses, so a song finishing anywhere
 * moves this bar, and a song evicted to make room moves it back down. The number is always the
 * current count of files the shell holds — never a high-water mark.
 */
export function ListDownloadBar({ tracks, label }: { tracks: Track[]; label?: string }) {
  const status = useListStatus(tracks);
  if (!downloadsAvailable() || !tracks.length) return null;
  return <ListAvailability
    total={status.total}
    ready={status.ready}
    active={status.active > 0}
    failed={status.failed}
    blocked={status.blocked}
    /* SPIN-TRUTH-001: booked attempts are reported in words; only real work spins the arrow. */
    retrying={status.retrying}
    label={label}
  />;
}

/**
 * LIST-METER-003: the list's download action, as an icon button for the list header next to Clear
 * list - the same `iconbtn` and download glyph used for a single song, so one song and a whole list
 * are asked for the same way. The caption moved into the accessible name and the tooltip; no state
 * is conveyed by the icon shape alone.
 */
export function ListDownloadButton({ tracks, label }: { tracks: Track[]; label?: string }) {
  const status = useListStatus(tracks);
  if (!downloadsAvailable() || !tracks.length) return null;
  const complete = status.total > 0 && status.ready === status.total;
  const busy = status.bulkActive && !status.blocked;
  const where = label ?? 'this list';
  const name = complete
    ? `All songs ready in ${where}`
    : busy ? `Downloading ${where}`
    : `Download all songs in ${where}`;
  return (
    <button
      type="button"
      className="iconbtn"
      onClick={() => queueAudio.downloadAll(tracks)}
      disabled={complete || busy}
      aria-label={name}
      title={name}
    >
      <Glyph name="download" size={14} />
    </button>
  );
}

/**
 * LIST-FOLDER-001. Owner: "add a button where the user can open the local folder with the current song
 * list / queue". The shell puts the list's downloaded songs in one folder named after the list,
 * numbered in play order (Windows: Music\Airwave Discovery\Song lists; Android: an "Airwave
 * Discovery" place in the Files app), and opens it. Songs not downloaded yet are left out, and the
 * tooltip says how many are in.
 */
export function ListFolderButton({ tracks, name, label }: { tracks: Track[]; name: string; label?: string }) {
  const status = useListStatus(tracks);
  const [note, setNote] = useState<string | null>(null);
  if (!downloadsAvailable() || !tracks.length) return null;
  const where = label ?? 'this list';
  const songs = tracks.flatMap((t) => {
    const url = queueAudio.readyUrl(t);
    return url ? [{ url, title: t.title, artist: t.artist ?? '' }] : [];
  });
  const title = songs.length
    ? `Open the folder with ${where}. ${songs.length} of ${tracks.length} songs are downloaded.`
    : `No song in ${where} is downloaded yet, so there is no folder to open.`;
  const open = async () => {
    try {
      const r = await dl.openList(name, songs);
      setNote(r.ok ? null : 'The folder could not be opened.');
    } catch (e) {
      setNote(`The folder could not be opened: ${(e as Error).message}`);
    }
  };
  return (
    <>
      <button
        type="button"
        className="iconbtn"
        onClick={() => void open()}
        disabled={!songs.length}
        aria-label={`Open the folder with ${where}`}
        title={title}
        data-ready={status.ready}
      >
        <Glyph name="folder" size={14} />
      </button>
      {note && <span className="list-folder__note" role="status">{note}</span>}
    </>
  );
}
