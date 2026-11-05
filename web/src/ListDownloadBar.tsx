import { useEffect, useState } from 'react';
import type { Track } from './api';
import { downloadsAvailable } from './engine/downloads';
import { queueAudio } from './engine/queue-audio';
import { ListAvailability } from './ListAvailability';

/**
 * LIST-AVAILABILITY-001: the bar above one list, reading only that list's songs.
 *
 * It subscribes to the same preloader the background queue uses, so a song finishing anywhere
 * moves this bar, and a song evicted to make room moves it back down. The number is always the
 * current count of files the shell holds — never a high-water mark.
 */
export function ListDownloadBar({ tracks, label }: { tracks: Track[]; label?: string }) {
  const [status, setStatus] = useState(() => queueAudio.snapshotFor(tracks));
  useEffect(() => {
    const read = () => setStatus(queueAudio.snapshotFor(tracks));
    read();
    return queueAudio.subscribe(read);
  }, [tracks]);
  if (!downloadsAvailable() || !tracks.length) return null;
  return <ListAvailability
    total={status.total}
    ready={status.ready}
    active={status.bulkActive}
    failed={status.failed}
    blocked={status.blocked}
    label={label}
    onDownload={() => queueAudio.downloadAll(tracks)}
  />;
}
