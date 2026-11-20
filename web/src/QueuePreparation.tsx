import { useEffect } from 'react';
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
  const enabled = downloadsAvailable();
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
  // DISCOVER-TIDY-001 (owner, 2026-11-19): the count shows once, as the small line above the Now playing queue
  // (ListLoadedNote). This keeps preparing the songs and draws nothing above the player.
  return null;
}
