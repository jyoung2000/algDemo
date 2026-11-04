import React from 'react';
import type { Settings } from './api';
import { dl, downloadsAvailable } from './engine/downloads';
import { parallelRange } from './engine/queue-controls';
import { shellPlatform } from './engine/shell';

/**
 * QUEUE-CTRL-001: how much the app downloads ahead, how fast, and where kept music lands.
 *
 * Deliberately states the cost of parallelism instead of hiding it — each slot is a separate
 * yt-dlp process — and keeps the evictable queue cache verbally distinct from a kept copy.
 */
export function QueueDownloadSettings({ settings, onSettings }: {
  settings: Settings | null;
  onSettings: (patch: Partial<Settings>) => void;
}) {
  const [folder, setFolder] = React.useState<string | null>(null);
  const [picking, setPicking] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const available = downloadsAvailable();
  const range = parallelRange(shellPlatform());

  React.useEffect(() => {
    if (!available) return;
    let live = true;
    dl.health().then(h => { if (live) setFolder(h.saves_to ?? null); }).catch(() => undefined);
    return () => { live = false; };
  }, [available]);

  if (!available) return null;
  const parallel = settings?.dl_parallel && settings.dl_parallel > 0 ? settings.dl_parallel : range.def;
  const target = settings?.preload_target ?? 'all';
  const count = settings?.preload_count ?? 20;

  async function choose() {
    setPicking(true); setErr(null);
    try {
      const r = await dl.chooseFolder();
      if (r.saves_to) setFolder(r.saves_to);
    } catch (e) {
      setErr((e as Error).message || 'Could not change the folder.');
    } finally {
      setPicking(false);
    }
  }

  return (
    <>
      {range.max > 1 && (
        <>
          <div className="discovery-settings__heading">
            <label htmlFor="dl-parallel">Simultaneous downloads</label>
            <output id="dl-parallel-output" htmlFor="dl-parallel">{parallel}</output>
          </div>
          <div className="dial discovery-settings__range">
            <input id="dl-parallel" type="range" min={range.min} max={range.max} step={1} value={parallel}
              aria-describedby="dl-parallel-output dl-parallel-help"
              style={{ '--pct': `${((parallel - range.min) / (range.max - range.min)) * 100}%` } as React.CSSProperties}
              onChange={(e) => onSettings({ dl_parallel: Number(e.target.value) })} />
          </div>
          <p className="note" id="dl-parallel-help">
            How many list songs may download at once. Each one runs a separate yt-dlp process, so a
            higher number can increase processor, memory, battery and network use. A song you pick to
            play always gets its own slot and never waits behind these.
          </p>
        </>
      )}
      <div className="discovery-settings__heading">
        <span id="preload-target-label">Preload target</span>
      </div>
      {/* .seg__btn styles the selected state off aria-selected, so this is a tablist, not a radiogroup. */}
      <div className="seg" role="tablist" aria-labelledby="preload-target-label">
        <button type="button" role="tab" className="seg__btn" aria-selected={target === 'all'}
          onClick={() => onSettings({ preload_target: 'all' })}>All songs</button>
        <button type="button" role="tab" className="seg__btn" aria-selected={target === 'count'}
          onClick={() => onSettings({ preload_target: 'count' })}>Set a count</button>
      </div>
      {target === 'count' && (
        <div className="discovery-settings__heading">
          <label htmlFor="preload-count">Songs to preload</label>
          <input id="preload-count" className="num" type="number" min={1} max={500} step={1} value={count}
            aria-describedby="preload-help"
            onChange={(e) => onSettings({ preload_count: Number(e.target.value) })} />
        </div>
      )}
      <p className="note" id="preload-help">
        How much of the list to load ahead so it plays the moment you choose it. The storage limit
        above always wins: songs that will not fit say so instead of pushing others out.
      </p>
      <div className="discovery-settings__heading">
        <span id="kept-folder-label">Kept music folder</span>
        <button type="button" className="push" onClick={choose} disabled={picking}
          aria-describedby="kept-folder-help">{picking ? 'Choosing…' : 'Choose folder'}</button>
      </div>
      <p className="note" id="kept-folder-help">
        {/* The path can be long, and Android can only report a label, never a real path. */}
        <span className="qdl__path" title={folder ?? undefined}>{folder ? `Saves to ${folder}` : 'No folder selected'}</span>
        {' '}Songs you download are kept here permanently. The queue cache above is separate, lives in
        the app's own storage, and clears itself as it fills.
      </p>
      {err && <p className="note note--bad" role="alert">{err}</p>}
    </>
  );
}
