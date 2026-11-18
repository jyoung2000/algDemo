/**
 * ALGO-MANAGER-001. The algorithm toolbar at the top of the Profile tab: choose the active
 * algorithm, create a copy, reset, import and export, then read (and for your own algorithms edit)
 * every parameter and the six-line formula. Reads and writes the same settings as Settings.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BUILT_IN_ALGORITHM, BUILT_IN_ID, PARAM_FIELDS, createFrom, formulaLines, formulaNotes, getParam, nameError, paramErrors, parseAlgorithm,
  serializeAlgorithm, setParam, uniqueName, type Algorithm, type AlgorithmParams,
} from './engine/algorithms';
import { saveAlgorithmSettings, type AlgorithmsState } from './useAlgorithms';
import './algorithm-manager.css';

type Panel = null | 'create' | 'reset' | 'import';

const draftOf = (p: AlgorithmParams): Record<string, string> => Object.fromEntries(PARAM_FIELDS.map((f) => [f.path, String(getParam(p, f.path))]));

function paramsFromDraft(base: AlgorithmParams, draft: Record<string, string>): AlgorithmParams {
  let p = base;
  for (const f of PARAM_FIELDS) {
    const raw = (draft[f.path] ?? '').trim();
    p = setParam(p, f.path, raw === '' ? Number.NaN : Number(raw));
  }
  return p;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'algorithm';
}

export function AlgorithmManager({ state, onChanged }: { state: AlgorithmsState; onChanged?: () => void }) {
  const { view, all, active } = state;
  const users = view?.algorithms ?? [];
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failure, setFailure] = useState('');
  const [newName, setNewName] = useState('');
  const [importText, setImportText] = useState('');
  // A draft belongs to one algorithm object: when the active algorithm (or its saved values) changes,
  // the draft resets in the same render, so a stale draft never shows as "unsaved changes".
  const [edit, setEdit] = useState<{ of: Algorithm; values: Record<string, string> } | null>(null);
  const draft = edit && edit.of === active ? edit.values : draftOf(active.params);
  const setDraft = (values: Record<string, string>) => setEdit({ of: active, values });
  const nameField = useRef<HTMLInputElement>(null);
  useEffect(() => { if (panel === 'create') nameField.current?.focus(); }, [panel]);

  const editable = !active.builtIn;
  const draftParams = useMemo(() => paramsFromDraft(active.params, draft), [active, draft]);
  const errors = useMemo(() => (editable ? paramErrors(draftParams) : []), [editable, draftParams]);
  const dirty = editable && PARAM_FIELDS.some((f) => (draft[f.path] ?? '') !== String(getParam(active.params, f.path)));
  const shown = dirty && !errors.length ? { params: draftParams, finalFormula: active.finalFormula } : active;

  const run = async (work: () => Promise<string>) => {
    setBusy(true); setFailure(''); setMessage('');
    try { setMessage(await work()); onChanged?.(); }
    catch (e) { setFailure((e as Error).message); }
    finally { setBusy(false); }
  };
  const open = (next: Panel) => { setPanel((p) => (p === next ? null : next)); setFailure(''); setMessage(''); };

  const select = (id: string) => {
    if (id === active.id || busy) return;
    const name = all.find((a) => a.id === id)?.name ?? id;
    setPanel(null);
    void run(async () => { await saveAlgorithmSettings({ active_algorithm: id }); return `“${name}” is now the active algorithm.`; });
  };

  const create = () => {
    const err = nameError(newName);
    if (err) { setFailure(err); return; }
    void run(async () => {
      const copy = createFrom(active, newName);
      await saveAlgorithmSettings({ algorithms: [...users, copy], active_algorithm: copy.id });
      setPanel(null); setNewName('');
      return `Created “${copy.name}” from “${active.name}”. It is now active and editable.`;
    });
  };

  const resetClick = () => {
    if (active.builtIn) { setPanel(null); setFailure(''); setMessage(`“${BUILT_IN_ALGORITHM.name}” is already the active algorithm.`); return; }
    open('reset');
  };
  const useBuiltIn = () => void run(async () => {
    await saveAlgorithmSettings({ active_algorithm: BUILT_IN_ID });
    setPanel(null);
    return `“${BUILT_IN_ALGORITHM.name}” is active again. “${active.name}” is kept in the list.`;
  });
  const resetValues = () => void run(async () => {
    const reset: Algorithm = { ...active, params: { ...BUILT_IN_ALGORITHM.params, seedWeights: { ...BUILT_IN_ALGORITHM.params.seedWeights }, globalWeights: { ...BUILT_IN_ALGORITHM.params.globalWeights } }, finalFormula: BUILT_IN_ALGORITHM.finalFormula };
    await saveAlgorithmSettings({ algorithms: users.map((a) => (a.id === active.id ? reset : a)) });
    setPanel(null);
    return `“${active.name}” now uses the built-in values.`;
  });

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    setFailure(''); setMessage('');
    try {
      if (file.size > 16_384) throw new Error('This file is too large to be an algorithm (16 KB maximum).');
      setImportText(await file.text());
      setMessage(`Loaded ${file.name}. Check it, then choose Import algorithm.`);
    } catch (e) { setFailure((e as Error).message); }
  };
  const doImport = () => {
    let alg: Algorithm;
    try { alg = parseAlgorithm(importText); }
    catch (e) { setFailure((e as Error).message); setMessage(''); return; }
    void run(async () => {
      const named = { ...alg, name: uniqueName(alg.name, users) };
      await saveAlgorithmSettings({ algorithms: [...users, named], active_algorithm: named.id });
      setPanel(null); setImportText('');
      return `Imported “${named.name}”. It is now the active algorithm.`;
    });
  };

  const doExport = () => {
    setFailure('');
    const file = `${slug(active.name)}.airwave-algorithm.json`;
    try {
      const text = serializeAlgorithm(active);
      const a = document.createElement('a');
      const blobUrl = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(new Blob([text], { type: 'application/json' })) : null;
      a.href = blobUrl ?? `data:application/json;charset=utf-8,${encodeURIComponent(text)}`;
      a.download = file;
      a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
      if (blobUrl) window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
      setMessage(`Exported “${active.name}” as ${file}.`);
    } catch (e) { setFailure(`Export failed: ${(e as Error).message}`); }
  };

  const save = () => {
    if (!dirty || errors.length) return;
    void run(async () => {
      const next: Algorithm = { ...active, params: draftParams };
      await saveAlgorithmSettings({ algorithms: users.map((a) => (a.id === active.id ? next : a)) });
      return `Saved “${active.name}”. The next discovery or re-rank uses it.`;
    });
  };

  return (
    <section className="card algo" aria-labelledby="pf-algorithm">
      <h2 id="pf-algorithm">Recommendation algorithm</h2>
      <p className="note">The active algorithm ranks every discovery and re-rank. Settings’ Discovery algorithm shows the same one.</p>
      <div className="algo__toolbar">
        <label htmlFor="algo-select" className="algo__label">Algorithm</label>
        <select id="algo-select" className="field algo__select" value={active.id} disabled={busy || !view} onChange={(e) => select(e.target.value)}>
          {all.map((a) => <option key={a.id} value={a.id}>{a.builtIn ? `${a.name} (built-in)` : a.name}</option>)}
        </select>
        <div className="algo__buttons">
          <button type="button" className="push" disabled={busy || !view} aria-expanded={panel === 'create'} onClick={() => { setNewName(uniqueName(`${active.name} copy`, users)); open('create'); }}>Create</button>
          <button type="button" className="push" disabled={busy || !view} aria-expanded={panel === 'reset'} onClick={resetClick}>Reset</button>
          <button type="button" className="push" disabled={busy || !view} aria-expanded={panel === 'import'} onClick={() => open('import')}>Import</button>
          <button type="button" className="push" disabled={busy || !view} onClick={doExport}>Export</button>
        </div>
      </div>

      {panel === 'create' && (
        <div className="algo__panel">
          <label htmlFor="algo-new-name">Name for the new algorithm</label>
          <input ref={nameField} id="algo-new-name" className="field" value={newName} maxLength={60} disabled={busy}
            onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') create(); if (e.key === 'Escape') setPanel(null); }} />
          <p className="note">Copies every value of “{active.name}” into a new algorithm you can edit.</p>
          <div className="algo__buttons">
            <button type="button" className="push push--default" disabled={busy || Boolean(nameError(newName))} onClick={create}>Create algorithm</button>
            <button type="button" className="push" disabled={busy} onClick={() => setPanel(null)}>Cancel</button>
          </div>
        </div>
      )}

      {panel === 'reset' && !active.builtIn && (
        <div className="algo__panel" role="group" aria-label="Reset options">
          <p>Make “{BUILT_IN_ALGORITHM.name}” active again, or put the built-in values into “{active.name}”?</p>
          <div className="algo__buttons">
            <button type="button" className="push push--default" disabled={busy} onClick={useBuiltIn}>Use {BUILT_IN_ALGORITHM.name}</button>
            <button type="button" className="push" disabled={busy} onClick={resetValues}>Reset “{active.name}” to built-in values</button>
            <button type="button" className="push" disabled={busy} onClick={() => setPanel(null)}>Cancel</button>
          </div>
        </div>
      )}

      {panel === 'import' && (
        <div className="algo__panel">
          <label htmlFor="algo-import-file">Algorithm file (.json)</label>
          <input id="algo-import-file" type="file" accept=".json,application/json" disabled={busy} onChange={(e) => void readFile(e.target.files?.[0])} />
          <label htmlFor="algo-import-text">Or paste algorithm JSON</label>
          <textarea id="algo-import-text" className="field algo__json" rows={6} spellCheck={false} value={importText} disabled={busy}
            onChange={(e) => { setImportText(e.target.value); setFailure(''); }} />
          <div className="algo__buttons">
            <button type="button" className="push push--default" disabled={busy || !importText.trim()} onClick={doImport}>Import algorithm</button>
            <button type="button" className="push" disabled={busy} onClick={() => setPanel(null)}>Cancel</button>
          </div>
        </div>
      )}

      <div aria-live="polite">
        {failure ? <p className="algo__error" role="alert">{failure}</p> : message ? <p className="note" role="status">{message}</p> : null}
      </div>

      <h3 className="algo__subhead">Data</h3>
      <p className="note">{editable ? 'Your algorithm: edit any value, then save.' : 'The built-in algorithm is read-only. Use Create to make an editable copy.'}</p>
      <div className="algo__scroll">
        <table className="ptable algo__table">
          <thead><tr><th scope="col">Parameter</th><th scope="col">Value</th><th scope="col">Meaning</th></tr></thead>
          <tbody>
            {PARAM_FIELDS.map((f) => (
              <tr key={f.path}>
                <th scope="row">{f.label}</th>
                <td>
                  {editable ? (
                    <input className="field algo__num" type="number" inputMode="decimal" step="0.01" min={0} max={f.kind === 'share' ? 1 : undefined}
                      aria-label={f.label} value={draft[f.path] ?? ''} disabled={busy}
                      onChange={(e) => { setDraft({ ...draft, [f.path]: e.target.value }); setMessage(''); }} />
                  ) : <span className="num">{getParam(active.params, f.path)}</span>}
                </td>
                <td>{f.meaning}</td>
              </tr>
            ))}
            <tr>
              <th scope="row">Final step</th>
              <td colSpan={2}><code>{active.finalFormula}</code> <span className="note">Edit it in Settings › Discovery algorithm.</span></td>
            </tr>
          </tbody>
        </table>
      </div>
      {editable && errors.length > 0 && <ul className="algo__error" role="alert">{errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      {dirty && (
        <div className="algo__buttons">
          <button type="button" className="push push--default" disabled={busy || errors.length > 0} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
          <button type="button" className="push" disabled={busy} onClick={() => { setEdit(null); setMessage(''); }}>Cancel</button>
        </div>
      )}

      <h3 className="algo__subhead">Formula{dirty && !errors.length ? ' (unsaved changes)' : ''}</h3>
      <pre className="formula algo__formula" aria-label={`Formula of ${active.name}`}>{formulaLines(shown).join('\n')}</pre>
      <h3 className="algo__subhead" id="algo-notes">How the engine applies this formula</h3>
      <ul className="algo__notes" aria-labelledby="algo-notes">{formulaNotes(shown).map((n) => <li key={n}>{n}</li>)}</ul>
    </section>
  );
}
