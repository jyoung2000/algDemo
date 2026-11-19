import { type Settings } from './api';
import { AlgorithmManager } from './AlgorithmManager';
import { useAlgorithms } from './useAlgorithms';

/**
 * Settings' "Discovery algorithm". ALGO-FORM-001: this is the Profile tab's algorithm form, the same
 * component over the same settings and the same unsaved draft, so the two cannot differ.
 */
export function RankingFormulaSettings({ settings, onSaved }: { settings: Settings | null; onSaved?: (next: Settings) => void }) {
  const algs = useAlgorithms(settings);
  return <AlgorithmManager place="settings" state={algs} onSaved={onSaved} />;
}
