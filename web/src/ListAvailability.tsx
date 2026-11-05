import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import './list-availability.css';

export interface ListAvailabilityProps {
  total: number;
  ready: number;
  active: boolean;
  failed: number;
  blocked: boolean;
  /**
   * Songs that failed and have another attempt booked (RETRY-SPIN-001).
   *
   * Owner: "i dont see a spinning arrow indicating active retrying." Between attempts nothing is
   * downloading, so `active` alone made the card look idle while the app was still working on it.
   */
  retrying?: number;
  /** Names the list for assistive tech, e.g. 'Road Trip'. */
  label?: string;
  /**
   * LIST-METER-003: kept for the callers that still pass it, but the card no longer renders an
   * action - the download icon lives in the list header beside Clear list.
   */
  onDownload?: () => void;
}

/**
 * LIST-METER-002: an incomplete list never fills the whole track.
 *
 * At 91 of 97 the proportional fill is 93.8%, which on a phone is indistinguishable from done - the
 * owner read a bar at "max width" while six songs were missing. The fill stays proportional (more
 * ready songs is still a longer bar) but is squeezed into the first 92% of the track until the list
 * is genuinely complete, so "finished" has a look nothing else can borrow. The exact counts are in
 * the text above the bar; the bar's job is to show at a glance whether there is work left.
 */
const PARTIAL_CEILING = 92;

/** LIST-AVAILABILITY-001: current local-file availability, NOT cumulative download progress. */
export function ListAvailability({ total, ready, active, failed, blocked, retrying = 0 }: ListAvailabilityProps) {
  const id = useId();
  const complete = total > 0 && ready === total;
  const count = total ? `${ready} of ${total} songs ready locally` : 'No songs in this list';
  const fill = !total ? 0 : complete ? 100 : (ready / total) * PARTIAL_CEILING;
  /**
   * Which way the cache is moving right now, for the spinning arrow. Loading is reported by the
   * engine; unloading has no event of its own, so it is inferred from the ready count falling -
   * which is exactly what an eviction looks like from here.
   */
  const previousReady = useRef(ready);
  const [spin, setSpin] = useState<'load' | 'unload' | null>(null);
  // Waiting for the next attempt is work in progress, so the arrow keeps turning. A song parked for
  // want of cache space is not retrying: it waits for room, and the blocked note explains that.
  const working = active || (retrying > 0 && !blocked);
  useEffect(() => {
    const fell = ready < previousReady.current;
    previousReady.current = ready;
    if (working) { setSpin('load'); return; }
    if (fell) {
      setSpin('unload');
      // Unloading is instant on disk; hold the arrow long enough to be seen, then rest.
      const timer = setTimeout(() => setSpin(null), 1200);
      return () => clearTimeout(timer);
    }
    setSpin(null);
    return;
  }, [ready, working]);
  const message = blocked
    ? 'Waiting for cache space. Resumes automatically when space allows; you can also raise the limit in Settings.'
    // LIST-METER-002: the owner moved the unavailable-songs warning to Settings. The card says what
    // the app is doing; the per-source detail belongs with the other runtime status.
    // RETRY-SPIN-001: when a retry is actually booked, say so and say how many, so the spinning
    // arrow has words to match. "Still fetching" is kept for a failure with nothing scheduled.
    : retrying > 0 ? `Retrying ${retrying} ${retrying === 1 ? 'song' : 'songs'} no source has answered for yet. This keeps going while the app is open.`
    : failed ? 'Still fetching some songs. Retrying automatically while the app is running.'
    : active ? 'Downloading missing songs using your cache and speed settings.'
    : complete ? 'All songs are on this device. Cached songs may be removed to free space.'
    : 'Loads songs automatically within your preload and cache limits. The download button prioritizes this list, not your permanent Music folder.';
  // The visual count changes on every event. Batch announcements, not the meter, to avoid chatter.
  const [announced, setAnnounced] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setAnnounced(`${count}. ${message}`), 700);
    return () => clearTimeout(timer);
  }, [count, message]);
  return <section className="list-availability" aria-label="List downloads" data-testid="list-availability"
    data-state={blocked ? 'blocked' : complete ? 'ready' : working ? 'loading' : 'idle'}>
    <div className="list-availability__head">
      <strong className="list-availability__count">{count}</strong>
      {spin && <span className="list-availability__spin" data-dir={spin} aria-hidden="true" />}
    </div>
    {total > 0 && <div className="list-availability__meter" role="meter" aria-label="Current list local availability"
      aria-valuemin={0} aria-valuemax={total} aria-valuenow={ready} aria-valuetext={count}
      style={{ '--available': `${fill}%` } as CSSProperties}>
      <span aria-hidden="true" />
    </div>}
    <p id={`${id}-help`} className="list-availability__help">{message}</p>
    <span className="sr" role="status" aria-live="polite" aria-atomic="true">{announced}</span>
  </section>;
}
