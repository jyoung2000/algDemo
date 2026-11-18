import { useMemo, useRef, useState } from 'react';
import { type Settings } from './api';
import { createFrom, formulaLines, MIGRATED_NAME, uniqueName } from './engine/algorithms';
import { applyRankingFormula, compileRankingFormula, DEFAULT_RANKING_FORMULA, FORMULA_FACTORS, MAX_FORMULA_LENGTH, rankingInputs } from './engine/ranking-formula';
import { saveAlgorithmSettings, useAlgorithms } from './useAlgorithms';
import './ranking-formula.css';

const EXAMPLES = [
  { name: 'Close match', affinity: 0.85, coverage: 0.9, factors: { audio: 0.9, genre: 0.9, artist: 1, provider: 0.8, feedback: 0.7, tempo: 0.8, freshness: 0.2, novelty: 0, taste: 0.8 } },
  { name: 'New artist', affinity: 0.6, coverage: 0.65, factors: { audio: null, genre: 0.6, artist: 0, provider: 0.5, feedback: null, tempo: 0.6, freshness: 0.9, novelty: 1, taste: 0.6 } },
];
/**
 * Settings' "Discovery algorithm": the SAME active algorithm as the Profile tab (ALGO-MANAGER-001).
 * Choosing an algorithm activates it; saving the final step writes into the active user algorithm,
 * or into a new copy named "My formula" when the read-only built-in is active.
 */
export function RankingFormulaSettings({ settings, onSaved }: { settings: Settings | null; onSaved?: (next: Settings) => void }) {
  const algs = useAlgorithms(settings, (fresh) => onSaved?.(fresh));
  const active = algs.active;
  const users = algs.view?.algorithms ?? [];
  const applied = active.finalFormula.trim() || DEFAULT_RANKING_FORMULA;
  // The draft belongs to one algorithm's saved final step; switching algorithm resets it in the same render.
  const owner = `${active.id}\u0000${applied}`;
  const [edit, setEdit] = useState<{ of: string; text: string } | null>(null);
  const draft = edit && edit.of === owner ? edit.text : applied;
  const setDraft = (text: string) => setEdit({ of: owner, text });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failure, setFailure] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);
  const checked = useMemo(() => {
    try {
      const source = draft.trim() || DEFAULT_RANKING_FORMULA;
      if (draft.length > MAX_FORMULA_LENGTH) throw new Error(`Formula is limited to ${MAX_FORMULA_LENGTH} characters.`);
      compileRankingFormula(source);
      return { source, error: '' };
    } catch (e) { return { source: null, error: (e as Error).message }; }
  }, [draft]);
  const dirty = !checked.error && checked.source !== applied;
  const change = (value: string) => { setDraft(value); setMessage(''); setFailure(''); };
  const save = async () => {
    if (checked.error || !checked.source || !dirty || busy) return;
    const source = checked.source;
    setBusy(true); setFailure(''); setMessage('');
    try {
      if (active.builtIn) {
        const copy = { ...createFrom(active, uniqueName(MIGRATED_NAME, users)), finalFormula: source };
        const next = await saveAlgorithmSettings({ algorithms: [...users, copy], active_algorithm: copy.id });
        onSaved?.(next);
        setMessage(`“${active.name}” is built in and read-only, so your formula was saved as a new algorithm “${copy.name}”, which is now active.`);
      } else {
        const next = await saveAlgorithmSettings({ algorithms: users.map((a) => (a.id === active.id ? { ...a, finalFormula: source } : a)) });
        onSaved?.(next);
        setMessage(`Formula saved to “${active.name}”. It will be used by the next discovery or listening re-rank.`);
      }
    } catch (e) { setFailure((e as Error).message); }
    finally { setBusy(false); }
  };
  const select = async (id: string) => {
    if (id === active.id || busy) return;
    setBusy(true); setFailure(''); setMessage('');
    try {
      const next = await saveAlgorithmSettings({ active_algorithm: id });
      onSaved?.(next);
      setMessage(`“${algs.all.find((a) => a.id === id)?.name ?? id}” is now the active algorithm.`);
    } catch (e) { setFailure((e as Error).message); }
    finally { setBusy(false); }
  };
  const copy = async () => {
    setFailure('');
    try { await navigator.clipboard.writeText(draft); setMessage('Formula copied.'); }
    catch {
      field.current?.focus(); field.current?.select();
      let copied = false; try { copied = document.execCommand('copy'); } catch { /* native selection remains available */ }
      setMessage(copied ? 'Formula copied.' : 'Formula selected. Use Copy or Ctrl+C.');
    }
  };
  const paste = async () => {
    setFailure('');
    try { change(await navigator.clipboard.readText()); field.current?.focus(); }
    catch { field.current?.focus(); setMessage('Paste directly into the formula field using Ctrl+V or the touch Paste menu.'); }
  };
  return <section className="ranking-formula" aria-labelledby="ranking-formula-heading">
    <div className="ranking-formula__heading"><h3 id="ranking-formula-heading">Discovery algorithm</h3><span>{active.builtIn ? 'Built-in algorithm' : 'Your algorithm'}</span></div>
    <p className="note">Choose the algorithm that ranks discoveries, or edit its final step. The Profile tab shows and edits the same algorithm. This changes ranking, not the audio DSP, full-song playback, hidden-song exclusions or artist-diversity rules.</p>
    <label htmlFor="ranking-algorithm-select">Active algorithm</label>
    <select id="ranking-algorithm-select" className="field ranking-formula__select" value={active.id} disabled={busy || !settings} onChange={e => void select(e.target.value)}>
      {algs.all.map(a => <option key={a.id} value={a.id}>{a.builtIn ? `${a.name} (built-in)` : a.name}</option>)}
    </select>
    <pre className="formula ranking-formula__lines" aria-label={`Formula of ${active.name}`}>{formulaLines(active).join('\n')}</pre>
    <label htmlFor="ranking-formula-input">Discovery ranking formula</label>
    <textarea ref={field} id="ranking-formula-input" className="field ranking-formula__input" rows={4} value={draft} spellCheck={false} autoCapitalize="off" autoCorrect="off" disabled={busy || !settings}
      aria-invalid={Boolean(checked.error)} aria-describedby="ranking-formula-help ranking-formula-message" onChange={e => change(e.target.value)} />
    <div className="ranking-formula__actions">
      <button type="button" className="push push--default" disabled={busy || !settings || !dirty || Boolean(checked.error)} onClick={() => void save()}>{busy ? 'Saving…' : 'Save formula'}</button>
      <button type="button" className="push" disabled={busy} onClick={() => void copy()}>Copy formula</button>
      <button type="button" className="push" disabled={busy || !settings} onClick={() => void paste()}>Paste formula</button>
      <button type="button" className="push" disabled={busy || !settings} onClick={() => change(DEFAULT_RANKING_FORMULA)}>Use default formula</button>
    </div>
    <div id="ranking-formula-message" aria-live="polite">
      {checked.error || failure ? <p className="ranking-formula__error" role="alert">{checked.error || failure}</p> : <p className="note" role="status">{message || (dirty ? (active.builtIn ? `Unsaved changes. Saving creates your own copy named “${MIGRATED_NAME}” because the built-in algorithm is read-only.` : 'Unsaved changes. Save to apply this formula.') : 'Your currently playing song and queue are not replaced when you save.')}</p>}
    </div>
    {!checked.error && <div className="ranking-formula__preview">
      <p className="note">Example scores — illustrative inputs, not actual songs</p>
      <table><thead><tr><th scope="col">Example</th><th scope="col">Built-in</th><th scope="col">Your formula</th></tr></thead><tbody>{EXAMPLES.map(example => {
        const floor = active.params.coverageFloor;
        const base = example.affinity * (floor + (1 - floor) * example.coverage);
        const preview = checked.source && checked.source !== DEFAULT_RANKING_FORMULA ? applyRankingFormula(checked.source, rankingInputs(base, example.affinity, example.coverage, example.factors, floor)) : { score: base };
        return <tr key={example.name}><th scope="row">{example.name}</th><td>{base.toFixed(3)}</td><td>{preview.error ? 'Invalid for this example' : preview.score.toFixed(3)}</td></tr>;
      })}</tbody></table>
    </div>}
    <details id="ranking-formula-help"><summary>Variables and formula syntax</summary>
      <p><code>base</code> is the existing engine score. The editable default combines <code>affinity</code> (seed and listening-taste fit), <code>coverage</code> (evidence coverage) and <code>coverage_floor</code> (the engine’s confidence floor).</p>
      <p>Individual signals: {FORMULA_FACTORS.map((key, i) => <span key={key}>{i > 0 && ', '}<code>{key}</code></span>)}. Each known signal is between 0 and 1. Missing signals are 0; <code>has_audio</code>, <code>has_genre</code>, and the other <code>has_</code> variables are 1 when known and 0 when missing. Zero is not proof of negative evidence.</p>
      <p>Use <code>+ - * / ^</code>, parentheses, or <code>min(a,b)</code>, <code>max(a,b)</code>, <code>abs(x)</code>, <code>sqrt(x)</code>, <code>pow(x,y)</code>, <code>log(x)</code>, <code>clamp(x,low,high)</code>. Example: <code>0.7 * genre + 0.3 * novelty</code>. <code>^</code> means exponentiation.</p>
      <p>Results are bounded to 0–1 before the engine’s existing repeat/exposure penalties and queue-selection rules. An unexpected non-finite result uses that song’s built-in score and reports the fallback in its evidence. Limits: {MAX_FORMULA_LENGTH} characters, 512 tokens, 32 nesting levels. JavaScript, network access and file access are not supported.</p>
    </details>
  </section>;
}
