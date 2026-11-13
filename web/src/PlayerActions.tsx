import { useRef, useState } from 'react';
import { Glyph } from '@now-playing/aqua-ui/icons';
import type { FeedbackKind, PlaylistSummary } from './api';
import type { FeedbackFlags } from './Results';
import { SongStar, inPlaylist } from './SongStar';

export type PlayerDownloadState = 'idle' | 'working' | 'done' | 'error';
export interface TrackActionProps {
  songKey?: string;
  lists?: PlaylistSummary[];
  flags: FeedbackFlags;
  downloadState: PlayerDownloadState;
  downloadAvailable: boolean;
  onFeedback: (kind: FeedbackKind) => Promise<void>;
  onDownload: () => Promise<boolean>;
  onDownloads: () => void;
}

/** These controls stay with the current song, not whichever row happens to be focused. */
export function PlayerActions({ flags, songKey, lists, downloadState, downloadAvailable, onFeedback, onDownload, onDownloads }: TrackActionProps) {
  const saved = inPlaylist(songKey, lists);
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const busy = starting || downloadState === 'working';
  const feedback = async (kind: FeedbackKind) => {
    if (pending.current) return;
    pending.current = true;
    setFeedbackBusy(true);
    setError('');
    try { await onFeedback(kind); }
    catch { setError('Could not save. Try again.'); }
    finally { pending.current = false; setFeedbackBusy(false); }
  };
  const download = async () => {
    if (starting) return;
    if (downloadState === 'done' || downloadState === 'working' || !downloadAvailable) { onDownloads(); return; }
    setStarting(true);
    setError('');
    try { if (!(await onDownload())) setError('Download failed. Open Downloads to retry.'); }
    catch { setError('Download failed. Open Downloads to retry.'); }
    finally { setStarting(false); }
  };
  return <div className="np__track-actions" role="group" aria-label="This song">
    <button className="quiet-control" type="button" aria-label={`${flags.like ? 'Unlike this song' : 'Like this song'}${saved ? ' — saved to a playlist' : ''}`} title={saved ? 'Saved to a playlist' : 'Like this song'} aria-pressed={Boolean(flags.like)} disabled={feedbackBusy} onClick={() => void feedback(flags.like ? 'unlike' : 'like')}><SongStar saved={saved} size={17} /></button>
    <button className="quiet-control" type="button" aria-label={flags.dislike ? 'Undo dislike for this song' : 'Dislike this song'} aria-pressed={Boolean(flags.dislike)} disabled={feedbackBusy} onClick={() => void feedback(flags.dislike ? 'undislike' : 'dislike')}><Glyph name="thumb-down" size={17} /></button>
    <button className="quiet-control" type="button" aria-label={busy ? 'Downloading: view progress' : downloadState === 'done' ? 'Downloaded: view file' : downloadState === 'error' ? 'Retry song download' : 'Download this song'} data-download-state={busy ? 'working' : downloadState} disabled={starting} onClick={() => void download()}>
      <Glyph name={downloadState === 'done' ? 'check' : 'download'} size={17} />
      {busy && <span className="action-progress" aria-hidden="true" />}
    </button>
    {error && <span className="np__action-error" role="status">{error}</span>}
  </div>;
}
