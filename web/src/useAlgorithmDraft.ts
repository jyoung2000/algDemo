/**
 * ALGO-FORM-001 (owner, 2026-11-18: "if it changes 1 place it changes on the other places").
 * The unsaved edits of an algorithm, held ONCE for the whole app instead of once per form. Every
 * algorithm form (Profile, Settings) and every read-out of the formula reads this store, so a value
 * typed in one place is the value shown in all of them before it is saved, and Save or Cancel in
 * any place settles it for all.
 */
import { useMemo, useSyncExternalStore } from 'react';
import { PARAM_FIELDS, getParam, paramErrors, setParam, type Algorithm, type AlgorithmParams } from './engine/algorithms';
import { compileRankingFormula, DEFAULT_RANKING_FORMULA, MAX_FORMULA_LENGTH } from './engine/ranking-formula';

interface Draft { values?: Record<string, string>; final?: string }

const drafts = new Map<string, Draft>();
const listeners = new Set<() => void>();
let version = 0;
const changed = () => { version += 1; for (const l of [...listeners]) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const snapshot = () => version;

function patch(id: string, next: Draft): void {
  const merged = { ...drafts.get(id), ...next };
  if (merged.values === undefined && merged.final === undefined) drafts.delete(id);
  else drafts.set(id, merged);
  changed();
}

/** Forget every unsaved edit (the active algorithm changed, or its values were replaced wholesale). */
export function clearAlgorithmDrafts(): void {
  if (!drafts.size) return;
  drafts.clear();
  changed();
}

const savedValues = (p: AlgorithmParams): Record<string, string> => Object.fromEntries(PARAM_FIELDS.map((f) => [f.path, String(getParam(p, f.path))]));

function paramsFrom(base: AlgorithmParams, values: Record<string, string>): AlgorithmParams {
  let p = base;
  for (const f of PARAM_FIELDS) {
    const raw = (values[f.path] ?? '').trim();
    p = setParam(p, f.path, raw === '' ? Number.NaN : Number(raw));
  }
  return p;
}

export interface AlgorithmDraft {
  /** What each value field shows: the unsaved text, or the saved number. */
  values: Record<string, string>;
  setValue: (path: string, text: string) => void;
  /** Drop the unsaved values (Cancel, or after they were saved). */
  clearValues: () => void;
  params: AlgorithmParams;
  errors: string[];
  valuesDirty: boolean;
  /** What the final-step field shows. */
  final: string;
  setFinal: (text: string) => void;
  clearFinal: () => void;
  /** The final step as it would be saved, or why it cannot be. */
  finalSource: string | null;
  finalError: string;
  finalDirty: boolean;
  /** Something valid is waiting to be saved. */
  unsaved: boolean;
  /** The algorithm as it would read once the valid unsaved edits are saved. Every read-out shows this. */
  shown: Algorithm;
}

export function useAlgorithmDraft(active: Algorithm): AlgorithmDraft {
  const v = useSyncExternalStore(subscribe, snapshot, snapshot);
  return useMemo(() => {
    const id = active.id;
    const d = drafts.get(id) ?? {};
    const editable = !active.builtIn;
    const saved = savedValues(active.params);
    const values = editable && d.values ? d.values : saved;
    const params = paramsFrom(active.params, values);
    const errors = editable ? paramErrors(params) : [];
    const valuesDirty = editable && PARAM_FIELDS.some((f) => (values[f.path] ?? '') !== saved[f.path]);
    const applied = active.finalFormula.trim() || DEFAULT_RANKING_FORMULA;
    const final = d.final ?? applied;
    let finalSource: string | null = null;
    let finalError = '';
    try {
      const source = final.trim() || DEFAULT_RANKING_FORMULA;
      if (final.length > MAX_FORMULA_LENGTH) throw new Error(`Formula is limited to ${MAX_FORMULA_LENGTH} characters.`);
      compileRankingFormula(source);
      finalSource = source;
    } catch (e) { finalError = (e as Error).message; }
    const finalDirty = !finalError && finalSource !== applied;
    const valuesReady = valuesDirty && !errors.length;
    const shown: Algorithm = valuesReady || finalDirty
      ? { ...active, params: valuesReady ? params : active.params, finalFormula: finalDirty ? finalSource! : active.finalFormula }
      : active;
    return {
      values, params, errors, valuesDirty, final, finalSource, finalError, finalDirty, shown,
      unsaved: valuesReady || finalDirty,
      setValue: (path, text) => patch(id, { values: { ...values, [path]: text } }),
      clearValues: () => patch(id, { values: undefined }),
      setFinal: (text) => patch(id, { final: text }),
      clearFinal: () => patch(id, { final: undefined }),
    };
    // `v` is the store version: a draft change anywhere recomputes every reader.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, v]);
}
