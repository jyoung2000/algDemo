/**
 * ALGO-MANAGER-001. The one client-side view of the recommendation algorithms, shared by the Profile
 * tab and Settings' "Discovery algorithm" section. Both read the same settings keys
 * (`algorithms`, `active_algorithm`) through the same pure helpers, and every save is broadcast to
 * every mounted reader, so the two places cannot show different algorithms.
 */
import { useEffect, useMemo, useState } from 'react';
import { api, type Settings } from './api';
import { favArtistsStore } from './fav-artists-store';
import { allAlgorithms, findAlgorithm, migrateAlgorithmSettings, type Algorithm, type AlgorithmSettings } from './engine/algorithms';

export type AlgorithmView = { algorithms: Algorithm[]; active: string };
export type SettingsWithAlgorithms = Settings & AlgorithmSettings;

/** The algorithms a settings object holds (legacy keys migrate exactly as the engine migrates them). */
export function readAlgorithms(s: Partial<SettingsWithAlgorithms> | null | undefined): AlgorithmView | null {
  if (!s) return null;
  const m = migrateAlgorithmSettings(s as Record<string, unknown>);
  return { algorithms: m['algorithms'] as Algorithm[], active: m['active_algorithm'] as string };
}

export const sameView = (a: AlgorithmView | null, b: AlgorithmView | null): boolean => JSON.stringify(a) === JSON.stringify(b);

const listeners = new Set<(s: SettingsWithAlgorithms) => void>();

/** Saves algorithm keys and tells every mounted reader. Throws when the engine did not take the change. */
export async function saveAlgorithmSettings(patch: AlgorithmSettings): Promise<SettingsWithAlgorithms> {
  const next = (await api.putSettings(patch as unknown as Partial<Settings>)) as SettingsWithAlgorithms;
  const view = readAlgorithms(next);
  const accepted = view
    && (patch.active_algorithm === undefined || view.active === patch.active_algorithm)
    && (patch.algorithms === undefined || JSON.stringify(view.algorithms.map((a) => a.id)) === JSON.stringify(patch.algorithms.map((a) => a.id)))
    && Array.isArray(next.algorithms);
  if (!accepted) throw new Error('The running engine did not accept this algorithm change. Update the app before retrying.');
  for (const l of [...listeners]) l(next);
  // ARTIST-FAV-ALGO-001: starred artists belong to the active algorithm; a new one shows its own list.
  if (patch.active_algorithm !== undefined) await favArtistsStore.reload();
  return next;
}

export interface AlgorithmsState {
  view: AlgorithmView | null;
  /** Built-in first, then the listener's own. */
  all: Algorithm[];
  active: Algorithm;
}

/**
 * `seed` is the settings the parent already holds (may be stale or null). The hook also reads the
 * engine once on mount; `onFetched` hears that fresh copy when it differs from the seed.
 */
export function useAlgorithms(seed?: Settings | null, onFetched?: (fresh: SettingsWithAlgorithms) => void): AlgorithmsState {
  const seedView = useMemo(() => readAlgorithms(seed as SettingsWithAlgorithms | null), [seed]);
  const [view, setView] = useState<AlgorithmView | null>(seedView);
  useEffect(() => { if (seedView) setView((v) => (sameView(v, seedView) ? v : seedView)); }, [seedView]);
  useEffect(() => {
    let live = true;
    const hear = (s: SettingsWithAlgorithms) => { if (live) setView(readAlgorithms(s)); };
    listeners.add(hear);
    // Test doubles of `api` may omit settings(); the seed then stays the source.
    const fetchSettings = (api as { settings?: () => Promise<Settings> }).settings;
    if (typeof fetchSettings === 'function') {
      Promise.resolve()
        .then(() => fetchSettings())
        .then((s) => {
          if (!live || !s) return;
          const fresh = readAlgorithms(s as SettingsWithAlgorithms);
          setView(fresh);
          if (!sameView(fresh, seedView)) onFetched?.(s as SettingsWithAlgorithms);
        }, () => undefined);
    }
    return () => { live = false; listeners.delete(hear); };
    // Mount only: later changes arrive through `seed` and the save broadcast.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const algorithms = view?.algorithms ?? [];
  return { view, all: allAlgorithms(algorithms), active: findAlgorithm(algorithms, view?.active) };
}
