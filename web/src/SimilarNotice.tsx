import { Glyph } from '@now-playing/aqua-ui/icons';
import './similar-notice.css';

/**
 * SIMILAR-NOTICE-001 (owner, 2026-11-20): "find similar songs needs a pop up or indicator on how many new similar songs
 * it found and added on all platforms". One small card over whatever page is open (Windows and the phone app share
 * this page; the car shows its own message, PlaybackService.findSimilar): while it looks, what it is doing; when it
 * is done, how many new songs joined the Now playing queue, with a way to go and see them.
 */
export type SimilarNote =
  | { phase: 'busy'; title: string; progress: string }
  | { phase: 'done'; title: string; added: number; detail: string }
  | { phase: 'none' | 'error'; title: string; detail: string };

const songs = (n: number) => `${n} new similar song${n === 1 ? '' : 's'}`;

/** The headline: what happened, with the number first. */
export function similarHeadline(note: SimilarNote): string {
  if (note.phase === 'busy') return `Finding songs like “${note.title}”`;
  if (note.phase === 'done') return `${songs(note.added)} added`;
  if (note.phase === 'none') return 'No new similar songs found';
  return 'Could not find similar songs';
}

/** How the songs that were added match, in a few words: "5 at 65% or more · 2 closest below 65%". */
export function similarDetail(out: { added: number; reached?: number; below?: number; unmeasured?: number; minimum: number }): string {
  const reached = out.reached ?? out.added;
  // All of them reached the chosen match: the number is already in the headline.
  if (reached === out.added && !out.below && !out.unmeasured) return `at least ${out.minimum}% sound match`;
  const parts: string[] = [];
  if (reached) parts.push(`${reached} at ${out.minimum}% sound match or more`);
  if (out.below) parts.push(`${out.below} closest below ${out.minimum}%`);
  if (out.unmeasured) parts.push(`${out.unmeasured} related, sound not compared`);
  return parts.join(' · ');
}

export function SimilarNotice({ note, onShow, onClose }: { note: SimilarNote; onShow?: () => void; onClose: () => void }) {
  return (
    <div className={`similar-notice similar-notice--${note.phase}`} role="status" aria-live="polite" aria-label="Find similar songs">
      {note.phase === 'done' ? (
        <span className="similar-notice__count" aria-hidden="true">+{note.added}</span>
      ) : note.phase === 'busy' ? (
        <span className="sdot sdot--busy similar-notice__dot" aria-hidden="true" />
      ) : (
        <span className="similar-notice__icon" aria-hidden="true"><Glyph name="info" size={16} /></span>
      )}
      <div className="similar-notice__text">
        <strong className="similar-notice__head">{similarHeadline(note)}</strong>
        <span className="similar-notice__sub">
          {note.phase === 'busy'
            ? note.progress
            : note.phase === 'done'
              ? `to your Now playing queue, like “${note.title}”${note.detail ? ` · ${note.detail}` : ''}`
              : note.detail}
        </span>
      </div>
      {note.phase === 'done' && onShow && (
        <button className="push similar-notice__show" type="button" onClick={onShow} aria-label={`Show the ${songs(note.added)} in the Now playing queue`}>
          Show
        </button>
      )}
      {note.phase !== 'busy' && (
        <button className="iconbtn similar-notice__close" type="button" onClick={onClose} aria-label="Close">
          <Glyph name="close" size={14} />
        </button>
      )}
    </div>
  );
}
