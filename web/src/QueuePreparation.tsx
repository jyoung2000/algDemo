import { useEffect, useState } from 'react';
import type { Track } from './api';
import { downloadsAvailable } from './engine/downloads';
import { queueAudio } from './engine/queue-audio';
import type { PreloadSetting } from './engine/queue-controls';

/** Fetch the whole list even before Play is pressed; only deck audio becomes an in-memory Blob. */
export function QueuePreparation({ tracks, parallel, preload }: {
  tracks: Track[];
  /** 0 = let the shell's platform default stand. */
  parallel?: number;
  preload?: PreloadSetting;
}) {
  const [status, setStatus] = useState(() => queueAudio.snapshot());
  const enabled = downloadsAvailable();
  useEffect(() => queueAudio.subscribe(() => setStatus(queueAudio.snapshot())), []);
  useEffect(() => {
    queueAudio.update(enabled ? tracks : []);
  }, [enabled, tracks]);
  useEffect(() => {
    // Settings arrive after the first paint, so the limits are applied when they land.
    void queueAudio.limits({ ...(parallel ? { parallel } : {}), ...(preload ? { preload } : {}) }).catch(() => undefined);
  }, [parallel, preload?.target, preload?.count]);
  useEffect(() => {
    const online = () => queueAudio.retryFailed();
    window.addEventListener('online', online);
    return () => { window.removeEventListener('online', online); queueAudio.update([]); };
  }, []);
  if (!enabled || !status.total) return null;
  return <p className="muted" data-testid="queue-preparation" role="status">
    {status.ready} of {status.total} songs ready locally
    {status.active > 0 ? ` · Preparing ${status.active}` : ''}
    {status.queued > 0 && status.active === 0 && !status.blocked ? ` · ${status.queued} waiting` : ''}
    {status.blocked ? ' · Cache full — increase queue storage in Settings to prepare the rest.' : ''}
    {status.failed > 0 && !status.blocked ? ` · ${status.failed} unavailable; select a song to retry.` : ''}
  </p>;
}
