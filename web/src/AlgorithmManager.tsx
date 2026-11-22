/**
 * ALGO-MANAGER-001 / ALGO-FORM-001. THE algorithm form. The Profile tab and Settings' "Discovery
 * algorithm" both render this one component over the same settings and the same unsaved draft
 * (useAlgorithmDraft), so they cannot look or read differently: choose the active algorithm, create
 * a copy, reset, import and export, edit every value and the final step, and read the six-line
 * formula. A place differs only in its title and heading level.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { FavArtist, Settings } from './api';
import { favArtistsStore } from './fav-artists-store';
import {
  BUILT_IN_ALGORITHM, BUILT_IN_ID, MIGRATED_NAME, PARAM_FIELDS, createFrom, formulaLines, formulaNotes, getParam, nameError, parseAlgorithmFile,
  serializeAlgorithm, uniqueName, type Algorithm, type AlgorithmSettings,
} from './engine/algorithms';
import { applyRankingFormula, DEFAULT_RANKING_FORMULA, FORMULA_FACTORS, MAX_FORMULA_LENGTH, rankingInputs } from './engine/ranking-formula';
import { saveAlgorithmSettings, type AlgorithmsState } from './useAlgorithms';
import { clearAlgorithmDrafts, useAlgorithmDraft } from './useAlgorithmDraft';
import './algorithm-manager.css';

type Panel = null | 'create' | 'reset' | 'import';

const EXAMPLES = [
  { name: 'Close match', affinity: 0.85, coverage: 0.9, factors: { audio: 0.9, genre: 0.9, artist: 1, provider: 0.8, feedback: 0.7, tempo: 0.8, freshness: 0.2, novelty: 0, taste: 0.8 } },
  { name: 'New artist', affinity: 0.6, coverage: 0.65, factors: { audio: null, genre: 0.6, artist: 0, provider: 0.5, feedback: null, tempo: 0.6, freshness: 0.9, novelty: 1, taste: 0.6 } },
];

/** Where the form is drawn. Only the title, the heading level and the element ids differ. */
const PLACES = {
  profile: { title: 'Recommendation algorithm', level: 2, id: 'algo', heading: 'pf-algorithm', wrap: 'card algo' },
  settings: { title: 'Discovery algorithm', level: 3, id: 'set-algo', heading: 'ranking-formula-heading', wrap: 'algo algo--inset' },
} as const;
export type AlgorithmPlace = keyof typeof PLACES;

function Heading({ level, ...rest }: { level: number } & React.HTMLAttributes<HTMLHeadingElement>) {
  const Tag = `h${level}` as 'h2';
  return <Tag {...rest} />;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'algorithm';
}

export interface AlgorithmFormProps {
  state: AlgorithmsState;
  place?: AlgorithmPlace;
  /** After any change the engine accepted (the caller refreshes what it derived from the algorithm). */
  onChanged?: () => void;
  /** The settings the engine now holds, for a parent that keeps its own copy. */
  onSaved?: (next: Settings) => void;
}

export function AlgorithmManager({ state, place = 'profile', onChanged, onSaved }: AlgorithmFormProps) {
  const { view, all, active } = state;
  const at = PLACES[place];
  const users = view?.algorithms ?? [];
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failure, setFailure] = useState('');
  const [finalNote, setFinalNote] = useState('');
  const [finalFailure, setFinalFailure] = useState('');
  const [newName, setNewName] = useState('');
  const [importText, setImportText] = useState('');
  // ALGO-FORM-001: the unsaved edits live outside this component, once for every form on screen.
  const draft = useAlgorithmDraft(active);
  const nameField = useRef<HTMLInputElement>(null);
  const finalField = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (panel === 'create') nameField.current?.focus(); }, [panel]);

  const editable = !active.builtIn;
  const { errors, shown } = draft;
  const dirty = draft.valuesDirty;
  const idle = busy || !view;
  // ARTIST-FAV-ALGO-001: kept loaded so Export carries the active algorithm's starred artists.
  useSyncExternalStore(favArtistsStore.subscribe, favArtistsStore.get);
  const persist = async (patch: AlgorithmSettings) => { const next = await saveAlgorithmSettings(patch); onSaved?.(next); return next; };

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
    void run(async () => { await persist({ active_algorithm: id }); clearAlgorithmDrafts(); return `“${name}” is now the active algorithm.`; });
  };

  const create = () => {
    const err = nameError(newName);
    if (err) { setFailure(err); return; }
    void run(async () => {
      const copy = createFrom(active, newName);
      const artists = favArtistsStore.get(); // ARTIST-FAV-ALGO-001: a copy starts with the same starred artists
      await persist({ algorithms: [...users, copy], active_algorithm: copy.id });
      if (artists.length) await favArtistsStore.setAll(artists);
      clearAlgorithmDrafts(); setPanel(null); setNewName('');
      return `Created “${copy.name}” from “${active.name}”. It is now active and editable.`;
    });
  };

  const resetClick = () => {
    if (active.builtIn) { setPanel(null); setFailure(''); setMessage(`“${BUILT_IN_ALGORITHM.name}” is already the active algorithm.`); return; }
    open('reset');
  };
  const useBuiltIn = () => void run(async () => {
    await persist({ active_algorithm: BUILT_IN_ID });
    clearAlgorithmDrafts(); setPanel(null);
    return `“${BUILT_IN_ALGORITHM.name}” is active again. “${active.name}” is kept in the list.`;
  });
  const resetValues = () => void run(async () => {
    const reset: Algorithm = { ...active, params: { ...BUILT_IN_ALGORITHM.params, seedWeights: { ...BUILT_IN_ALGORITHM.params.seedWeights }, globalWeights: { ...BUILT_IN_ALGORITHM.params.globalWeights } }, finalFormula: BUILT_IN_ALGORITHM.finalFormula };
    await persist({ algorithms: users.map((a) => (a.id === active.id ? reset : a)) });
    clearAlgorithmDrafts(); setPanel(null);
    return `“${active.name}” now uses the built-in values.`;
  });

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    setFailure(''); setMessage('');
    try {
      if (file.size > 65_536) throw new Error('This file is too large to be an algorithm (64 KB maximum).');
      setImportText(await file.text());
      setMessage(`Loaded ${file.name}. Check it, then choose Import algorithm.`);
    } catch (e) { setFailure((e as Error).message); }
  };
  const doImport = () => {
    let alg: Algorithm;
    let artists: FavArtist[];
    try { ({ algorithm: alg, artists } = parseAlgorithmFile(importText)); }
    catch (e) { setFailure((e as Error).message); setMessage(''); return; }
    void run(async () => {
      const named = { ...alg, name: uniqueName(alg.name, users) };
      await persist({ algorithms: [...users, named], active_algorithm: named.id });
      // ARTIST-FAV-ALGO-001: the file's starred artists become the new algorithm's own.
      if (artists.length) await favArtistsStore.setAll(artists);
      clearAlgorithmDrafts(); setPanel(null); setImportText('');
      const n = artists.length;
      return `Imported “${named.name}”${n ? ` with ${n} starred ${n === 1 ? 'artist' : 'artists'}` : ''}. It is now the active algorithm.`;
    });
  };

  const doExport = () => {
    setFailure('');
    const file = `${slug(active.name)}.airwave-algorithm.json`;
    try {
      const text = serializeAlgorithm(active, favArtistsStore.get());
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
      // Only the values: an unsaved final step stays a draft until its own Save.
      const next: Algorithm = { ...active, params: draft.params };
      await persist({ algorithms: users.map((a) => (a.id === active.id ? next : a)) });
      draft.clearValues();
      return `Saved “${active.name}”. The next discovery or re-rank uses it.`;
    });
  };

  // ---- final step (the one expression the listener can write) ----------------------------------
  const changeFinal = (text: string) => { draft.setFinal(text); setFinalNote(''); setFinalFailure(''); };
  const saveFinal = async () => {
    const source = draft.finalSource;
    if (draft.finalError || !source || !draft.finalDirty || busy) return;
    setBusy(true); setFinalFailure(''); setFinalNote('');
    try {
      if (active.builtIn) {
        const copy = { ...createFrom(active, uniqueName(MIGRATED_NAME, users)), finalFormula: source };
        await persist({ algorithms: [...users, copy], active_algorithm: copy.id });
        clearAlgorithmDrafts();
        setFinalNote(`“${active.name}” is built in and read-only, so your formula was saved as a new algorithm “${copy.name}”, which is now active.`);
      } else {
        // Only the final step: unsaved values stay a draft until their own Save.
        await persist({ algorithms: users.map((a) => (a.id === active.id ? { ...a, finalFormula: source } : a)) });
        draft.clearFinal();
        setFinalNote(`Formula saved to “${active.name}”. It will be used by the next discovery or listening re-rank.`);
      }
      onChanged?.();
    } catch (e) { setFinalFailure((e as Error).message); }
    finally { setBusy(false); }
  };
  const copyFinal = async () => {
    setFinalFailure('');
    try { await navigator.clipboard.writeText(draft.final); setFinalNote('Formula copied.'); }
    catch {
      finalField.current?.focus(); finalField.current?.select();
      let copied = false; try { copied = document.execCommand('copy'); } catch { /* native selection remains available */ }
      setFinalNote(copied ? 'Formula copied.' : 'Formula selected. Use Copy or Ctrl+C.');
    }
  };
  const pasteFinal = async () => {
    setFinalFailure('');
    try { changeFinal(await navigator.clipboard.readText()); finalField.current?.focus(); }
    catch { finalField.current?.focus(); setFinalNote('Paste directly into the formula field using Ctrl+V or the touch Paste menu.'); }
  };
  const finalStatus = finalNote || (draft.finalDirty
    ? (active.builtIn ? `Unsaved changes. Saving creates your own copy named “${MIGRATED_NAME}” because the built-in algorithm is read-only.` : 'Unsaved changes. Save to apply this formula.')
    : 'Your currently playing song and queue are not replaced when you save.');
  const id = at.id;
  const sub = at.level + 1;

  return (
    <section className={at.wrap} aria-labelledby={at.heading} data-algorithm-form={place}>
      <Heading level={at.level} id={at.heading}>{at.title}</Heading>
      <p className="note">The active algorithm ranks every discovery and re-rank. Profile and Settings show this same form: a change in one appears in the other. It changes ranking, not the audio DSP, full-song playback, hidden-song exclusions or artist-diversity rules.</p>
      <div className="algo__toolbar">
        <label htmlFor={`${id}-select`} className="algo__label">Algorithm</label>
        <select id={`${id}-select`} className="field algo__select" value={active.id} disabled={idle} onChange={(e) => select(e.target.value)}>
          {all.map((a) => <option key={a.id} value={a.id}>{a.builtIn ? `${a.name} (built-in)` : a.name}</option>)}
        </select>
        {/* ALGO-ACTIONS-LABEL-001 (owner): one title above the buttons saying what they act on. */}
        <span id={`${id}-manage`} className="algo__label algo__manage-label">Selected algorithm’s settings: create, reset, import or export</span>
        <div className="algo__buttons" role="group" aria-labelledby={`${id}-manage`}>
          <button type="button" className="push" disabled={idle} aria-expanded={panel === 'create'} onClick={() => { setNewName(uniqueName(`${active.name} copy`, users)); open('create'); }}>Create</button>
          <button type="button" className="push" disabled={idle} aria-expanded={panel === 'reset'} onClick={resetClick}>Reset</button>
          <button type="button" className="push" disabled={idle} aria-expanded={panel === 'import'} onClick={() => open('import')}>Import</button>
          <button type="button" className="push" disabled={idle} onClick={doExport}>Export</button>
        </div>
      </div>

      {panel === 'create' && (
        <div className="algo__panel">
          <label htmlFor={`${id}-new-name`}>Name for the new algorithm</label>
          <input ref={nameField} id={`${id}-new-name`} className="field" value={newName} maxLength={60} disabled={busy}
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
          <label htmlFor={`${id}-import-file`}>Algorithm file (.json)</label>
          <input id={`${id}-import-file`} type="file" accept=".json,application/json" disabled={busy} onChange={(e) => void readFile(e.target.files?.[0])} />
          <label htmlFor={`${id}-import-text`}>Or paste algorithm JSON</label>
          <textarea id={`${id}-import-text`} className="field algo__json" rows={6} spellCheck={false} value={importText} disabled={busy}
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

      <Heading level={sub} className="algo__subhead">Data</Heading>
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
                      aria-label={f.label} value={draft.values[f.path] ?? ''} disabled={busy}
                      onChange={(e) => { draft.setValue(f.path, e.target.value); setMessage(''); }} />
                  ) : <span className="num">{getParam(active.params, f.path)}</span>}
                </td>
                <td>{f.meaning}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editable && errors.length > 0 && <ul className="algo__error" role="alert">{errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      {dirty && (
        <div className="algo__buttons">
          <button type="button" className="push push--default" disabled={busy || errors.length > 0} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
          <button type="button" className="push" disabled={busy} onClick={() => { draft.clearValues(); setMessage(''); }}>Cancel</button>
        </div>
      )}

      <Heading level={sub} className="algo__subhead">Final step</Heading>
      <label htmlFor={`${id}-final`} className="algo__label">Discovery ranking formula</label>
      <textarea ref={finalField} id={`${id}-final`} className="field algo__final" rows={4} value={draft.final} spellCheck={false} autoCapitalize="off" autoCorrect="off" disabled={idle}
        aria-invalid={Boolean(draft.finalError)} aria-describedby={`${id}-final-help ${id}-final-message`} onChange={(e) => changeFinal(e.target.value)} />
      <div className="algo__buttons">
        <button type="button" className="push push--default" disabled={idle || !draft.finalDirty || Boolean(draft.finalError)} onClick={() => void saveFinal()}>{busy ? 'Saving…' : 'Save formula'}</button>
        <button type="button" className="push" disabled={busy} onClick={() => void copyFinal()}>Copy formula</button>
        <button type="button" className="push" disabled={idle} onClick={() => void pasteFinal()}>Paste formula</button>
        <button type="button" className="push" disabled={idle} onClick={() => changeFinal(DEFAULT_RANKING_FORMULA)}>Use default formula</button>
      </div>
      <div id={`${id}-final-message`} aria-live="polite">
        {draft.finalError || finalFailure ? <p className="algo__error" role="alert">{draft.finalError || finalFailure}</p> : <p className="note" role="status">{finalStatus}</p>}
      </div>
      {!draft.finalError && (
        <div className="algo__scroll">
          <table className="ptable algo__examples">
            <caption>Example scores — illustrative inputs, not actual songs</caption>
            <thead><tr><th scope="col">Example</th><th scope="col">Built-in</th><th scope="col">Your formula</th></tr></thead>
            <tbody>
              {EXAMPLES.map((example) => {
                const floor = shown.params.coverageFloor;
                const base = example.affinity * (floor + (1 - floor) * example.coverage);
                const source = draft.finalSource;
                const preview = source && source !== DEFAULT_RANKING_FORMULA ? applyRankingFormula(source, rankingInputs(base, example.affinity, example.coverage, example.factors, floor)) : { score: base };
                return <tr key={example.name}><th scope="row">{example.name}</th><td>{base.toFixed(3)}</td><td>{preview.error ? 'Invalid for this example' : preview.score.toFixed(3)}</td></tr>;
              })}
            </tbody>
          </table>
        </div>
      )}
      <details id={`${id}-final-help`} className="algo__help"><summary>Variables and formula syntax</summary>
        <p><code>base</code> is the existing engine score. The editable default combines <code>affinity</code> (seed and listening-taste fit), <code>coverage</code> (evidence coverage) and <code>coverage_floor</code> (the engine’s confidence floor).</p>
        <p>Individual signals: {FORMULA_FACTORS.map((key, i) => <span key={key}>{i > 0 && ', '}<code>{key}</code></span>)}. Each known signal is between 0 and 1. Missing signals are 0; <code>has_audio</code>, <code>has_genre</code>, and the other <code>has_</code> variables are 1 when known and 0 when missing. Zero is not proof of negative evidence.</p>
        <p>Use <code>+ - * / ^</code>, parentheses, or <code>min(a,b)</code>, <code>max(a,b)</code>, <code>abs(x)</code>, <code>sqrt(x)</code>, <code>pow(x,y)</code>, <code>log(x)</code>, <code>clamp(x,low,high)</code>. Example: <code>0.7 * genre + 0.3 * novelty</code>. <code>^</code> means exponentiation.</p>
        <p>Results are bounded to 0–1 before the engine’s existing repeat/exposure penalties and queue-selection rules. An unexpected non-finite result uses that song’s built-in score and reports the fallback in its evidence. Limits: {MAX_FORMULA_LENGTH} characters, 512 tokens, 32 nesting levels. JavaScript, network access and file access are not supported.</p>
      </details>

      <Heading level={sub} className="algo__subhead">Formula{draft.unsaved ? ' (unsaved changes)' : ''}</Heading>
      <pre className="formula algo__formula" aria-label={`Formula of ${active.name}`}>{formulaLines(shown).join('\n')}</pre>
      <Heading level={sub} className="algo__subhead" id={`${id}-notes`}>How the engine applies this formula</Heading>
      <ul className="algo__notes" aria-labelledby={`${id}-notes`}>{formulaNotes(shown).map((n) => <li key={n}>{n}</li>)}</ul>
    </section>
  );
}
