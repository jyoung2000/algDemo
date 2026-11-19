import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Glyph } from '@now-playing/aqua-ui/icons';
import type { FeedbackKind, PlaylistSummary } from './api';
import type { FeedbackFlags } from './Results';
import { SongStar, inPlaylist } from './SongStar';
import { SimilarGlyph } from './icons';
import { SaveMenu } from './SaveMenu';

export type PlayerDownloadState = 'idle' | 'working' | 'done' | 'error';
export interface TrackActionProps {
  songKey?: string;
  /** STAR-MENU-001: the song's title for the save menu's heading. */
  songTitle?: string;
  lists?: PlaylistSummary[];
  /** STAR-MENU-001: with this, the star opens the saved-list menu (as on every song row). */
  onLists?: (lists: PlaylistSummary[]) => void;
  flags: FeedbackFlags;
  downloadState: PlayerDownloadState;
  downloadAvailable: boolean;
  onFeedback: (kind: FeedbackKind) => Promise<void>;
  onDownload: () => Promise<boolean>;
  onDownloads: () => void;
  /** PLAYER-SIMILAR-001: Find similar songs for the song playing; absent = no button (nothing to compare). */
  onSimilar?: () => void;
  similarBusy?: boolean;
}

/** These controls stay with the current song, not whichever row happens to be focused. */
export function PlayerActions({ flags, songKey, songTitle, lists, onLists, downloadState, downloadAvailable, onFeedback, onDownload, onDownloads, onSimilar, similarBusy }: TrackActionProps) {
  const saved = inPlaylist(songKey, lists);
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const [menu, setMenu] = useState(false);
  const [menuBottom, setMenuBottom] = useState(120);
  const group = useRef<HTMLDivElement | null>(null);
  /** STAR-MENU-001 (owner, 2026-11-19): "the star icon ... brings up the saved playlist submenu, even if
   *  its pressed via player controls". A first press stars the song; every press opens the menu, and a
   *  starred song is unstarred from the menu, the same as a song row. */
  const star = () => {
    if (!onLists || !songKey) { void feedback(flags.like ? 'unlike' : 'like'); return; }
    if (menu) { setMenu(false); return; }
    if (!flags.like) void feedback('like');
    const np = group.current?.closest('.np')?.getBoundingClientRect();
    setMenuBottom(np ? Math.max(8, Math.round(window.innerHeight - np.top + 8)) : 120);
    setMenu(true);
  };
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
    try { if (!(await onDownload())) setError('Download failed. Open Settings → Downloads to retry.'); }
    catch { setError('Download failed. Open Settings → Downloads to retry.'); }
    finally { setStarting(false); }
  };
  const menuOn = Boolean(onLists && songKey);
  const starLabel = menuOn
    ? `${flags.like ? 'Liked: choose lists for this song' : 'Like this song and choose lists'}${saved ? ' — saved to a playlist' : ''}`
    : `${flags.like ? 'Unlike this song' : 'Like this song'}${saved ? ' — saved to a playlist' : ''}`;
  return <div className="np__track-actions" role="group" aria-label="This song" ref={group}>
    <button className="quiet-control" type="button" aria-label={starLabel} title={saved ? 'Saved to a playlist' : flags.like ? 'Liked — choose lists' : 'Like and choose lists'} aria-pressed={Boolean(flags.like)} aria-expanded={menuOn ? menu : undefined} disabled={feedbackBusy} onClick={star}><SongStar saved={saved} size={17} /></button>
    <button className="quiet-control" type="button" aria-label={flags.dislike ? 'Undo dislike for this song' : 'Dislike this song'} aria-pressed={Boolean(flags.dislike)} disabled={feedbackBusy} title={flags.dislike ? 'Disliked' : 'Not for me'} onClick={() => void feedback(flags.dislike ? 'undislike' : 'dislike')}><Glyph name="close" size={17} /></button>
    <button className="quiet-control" type="button" aria-label={busy ? 'Downloading: view progress' : downloadState === 'done' ? 'Downloaded: view file' : downloadState === 'error' ? 'Retry song download' : 'Download this song'} data-download-state={busy ? 'working' : downloadState} disabled={starting} onClick={() => void download()}>
      <Glyph name={downloadState === 'done' ? 'check' : 'download'} size={17} />
      {busy && <span className="action-progress" aria-hidden="true" />}
    </button>
    {/* PLAYER-SIMILAR-001 (owner, 2026-11-19): inline with the other controls, the same icon as a song row and the car. */}
    {onSimilar && <button className="quiet-control" type="button" aria-label={similarBusy ? 'Finding similar songs…' : 'Find similar songs to this one'} title={similarBusy ? 'Finding similar songs…' : 'Find similar songs'} aria-busy={similarBusy || undefined} disabled={similarBusy} onClick={onSimilar}>
      <SimilarGlyph size={17} />
      {similarBusy && <span className="action-progress" aria-hidden="true" />}
    </button>}
    {error && <span className="np__action-error" role="status">{error}</span>}
    {menu && onLists && songKey && typeof document !== 'undefined' && createPortal(
      <div className="np__savemenu" style={{ '--np-menu-bottom': `${menuBottom}px` } as React.CSSProperties}>
        <SaveMenu songKey={songKey} title={songTitle ?? 'this song'} lists={lists ?? []} onLists={onLists} onClose={() => setMenu(false)}
          onUnstar={flags.like ? () => void feedback('unlike') : undefined} />
      </div>, document.body)}
  </div>;
}
