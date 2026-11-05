import { useEffect, useId, useState, type CSSProperties } from 'react';
import './list-availability.css';

export interface ListAvailabilityProps {
  total: number;
  ready: number;
  active: boolean;
  failed: number;
  blocked: boolean;
  /** Names the list in the button's accessible label, e.g. 'Download all in Road Trip'. */
  label?: string;
  onDownload: () => void;
}

/** LIST-AVAILABILITY-001: current local-file availability, NOT cumulative download progress. */
export function ListAvailability({ total, ready, active, failed, blocked, label, onDownload }: ListAvailabilityProps) {
  const id = useId();
  const complete = total > 0 && ready === total;
  const count = total ? `${ready} of ${total} songs ready locally` : 'No songs in this list';
  const message = blocked
    ? 'Cache limit reached. Increase the limit in Settings, then retry.'
    : failed ? `${failed} songs unavailable. Download all retries missing songs.`
    : active ? 'Downloading missing songs using your cache and speed settings.'
    : complete ? 'All songs are on this device. Cached songs may be removed to free space.'
    : 'Downloads this list to the queue cache, not your permanent Music folder.';
  // The visual count changes on every event. Batch announcements, not the meter, to avoid chatter.
  const [announced, setAnnounced] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setAnnounced(`${count}. ${message}`), 700);
    return () => clearTimeout(timer);
  }, [count, message]);
  return <section className="list-availability" aria-label="List downloads" data-testid="list-availability"
    data-state={blocked ? 'blocked' : complete ? 'ready' : active ? 'loading' : 'idle'}>
    <div className="list-availability__head">
      <strong className="list-availability__count">{count}</strong>
      <button type="button" className="push" onClick={onDownload} disabled={!total || complete || (active && !blocked)}
        aria-describedby={`${id}-help`}
        aria-label={label ? `${complete ? 'All songs ready in' : 'Download all songs in'} ${label}` : undefined}>
        {complete ? 'All ready' : active && !blocked ? 'Downloading…' : 'Download all'}</button>
    </div>
    {total > 0 && <div className="list-availability__meter" role="meter" aria-label="Current list local availability"
      aria-valuemin={0} aria-valuemax={total} aria-valuenow={ready} aria-valuetext={count}
      style={{ '--available': `${ready / total * 100}%` } as CSSProperties}>
      <span aria-hidden="true" />
    </div>}
    <p id={`${id}-help`} className="list-availability__help">{message}</p>
    <span className="sr" role="status" aria-live="polite" aria-atomic="true">{announced}</span>
  </section>;
}
