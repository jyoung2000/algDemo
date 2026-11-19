import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Glyph } from '@now-playing/aqua-ui/icons';
import { api } from './api';
import type { ArtistSummary } from './engine/artists';
import { CUSTOM_MAX_SONGS, normaliseCriteria, type CustomArtist, type CustomCriteria } from './engine/custom-discovery';
import { FAMILIES, SUBS } from './engine/genre-table';
import { familyIdentity, subIdentity, subShortName } from './engine/genre-identity';
import { fold } from './engine/identity';
import './custom-discovery.css';

/**
 * NEXT-FAV-CUSTOM-001 (owner, 2026-11-19): Find my next favorite with the listener's own genres, artists, song count,
 * Familiar/Adventurous and Older/Newer. Layout and copy from the Astra design review (2026-11-19): a bottom sheet on a
 * phone, a centred dialog on a wide window (custom-discovery.css), fixed header and footer, one scrolling body.
 */
export const CUSTOM_KEY = 'jplay.custom-discovery';

export interface CustomStatus {
  running: boolean;
  /** Progress while running, or the outcome once done. */
  text: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** First-time defaults: Settings' queue size and Discover's Familiar/Adventurous. */
  defaults: { count: number; adventurous: number };
  status: CustomStatus;
  onRun: (c: CustomCriteria) => void;
  onStop: () => void;
}

/** "Soul/Jazz/Funk" is "Soul, Jazz & Funk": no slashes on a bubble (TAGS-CANON-001). */
export function familyDisplay(name: string): string {
  const parts = name.split(/\s*\/\s*/);
  return parts.length < 2 ? name : `${parts.slice(0, -1).join(', ')} & ${parts[parts.length - 1]}`;
}

export function readCustom(defaults: { count: number; adventurous: number }): CustomCriteria {
  try {
    const raw = window.localStorage.getItem(CUSTOM_KEY);
    if (raw) return normaliseCriteria(JSON.parse(raw));
  } catch { /* fall through to the defaults */ }
  return normaliseCriteria({ count: Math.min(CUSTOM_MAX_SONGS, defaults.count), adventurous: defaults.adventurous, era: 0 });
}

export function eraLabel(era: number): string {
  const p = Math.round(Math.abs(era) * 100);
  return p === 0 ? 'Any era' : era < 0 ? `Older bias: ${p}%` : `Newer bias: ${p}%`;
}

export function customSummary(c: CustomCriteria): string {
  const g = c.genres.length ? `${c.genres.length} genre ${c.genres.length === 1 ? 'tag' : 'tags'}` : 'Any genre';
  const a = c.artists.length ? `${c.artists.length} ${c.artists.length === 1 ? 'artist' : 'artists'}` : c.genres.length ? null : 'Your taste';
  return [g, a, `${c.count} ${c.count === 1 ? 'song' : 'songs'}`].filter(Boolean).join(' \u00B7 ');
}

const famKey = (slug: string) => `family:${slug}`;
const subKey = (key: string) => `sub:${key}`;
const subsOf = (slug: string) => SUBS.filter((s) => s.family === slug);

export function CustomDiscovery({ open, onClose, defaults, status, onRun, onStop }: Props) {
  const [crit, setCrit] = useState<CustomCriteria>(() => readCustom(defaults));
  const [gq, setGq] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [aq, setAq] = useState('');
  const [found, setFound] = useState<{ state: 'idle' | 'loading' | 'ready' | 'failed'; list: ArtistSummary[]; why?: string }>({ state: 'idle', list: [] });
  const [retry, setRetry] = useState(0);
  const [openArtist, setOpenArtist] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  const heading = useId();

  // Saved as it changes, across restarts.
  useEffect(() => { try { window.localStorage.setItem(CUSTOM_KEY, JSON.stringify(crit)); } catch { /* private mode */ } }, [crit]);

  // Focus moves in on open and back to the button that opened it on close; Tab stays inside.
  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    box.current?.querySelector<HTMLElement>('.cdisc__close')?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (found.list.length && aq) { setAq(''); setFound({ state: 'idle', list: [] }); return; }
        onClose();
      }
      if (e.key !== 'Tab' || !box.current) return;
      const f = [...box.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex="0"]')];
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1]!.focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0]!.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); (opener.current as HTMLElement | null)?.focus?.(); };
  }, [open, onClose, found.list.length, aq]);

  // Artist search: two letters, 300 ms after typing stops.
  useEffect(() => {
    const q = aq.trim();
    if (q.length < 2) { setFound({ state: 'idle', list: [] }); return; }
    const ctl = new AbortController();
    const t = window.setTimeout(() => {
      setFound((f) => ({ state: 'loading', list: f.list }));
      api.searchArtists(q, ctl.signal).then(
        (r) => setFound(r.why && !r.artists.length ? { state: 'failed', list: [], why: r.why } : { state: 'ready', list: r.artists.slice(0, 8) }),
        (e) => { if ((e as Error).name !== 'AbortError') setFound({ state: 'failed', list: [] }); },
      );
    }, 300);
    return () => { window.clearTimeout(t); ctl.abort(); };
  }, [aq, retry]);

  const genres = useMemo(() => new Set(crit.genres), [crit.genres]);
  const set = (patch: Partial<CustomCriteria>) => setCrit((c) => normaliseCriteria({ ...c, ...patch }));
  const toggleGenre = (k: string) => set({ genres: genres.has(k) ? crit.genres.filter((g) => g !== k) : [...crit.genres, k] });
  const toggleFamily = (slug: string) => {
    const k = famKey(slug);
    // A whole family replaces its subgenres; unticking it clears it.
    const inFam = new Set(subsOf(slug).map((s) => subKey(s.key)));
    set({ genres: genres.has(k) ? crit.genres.filter((g) => g !== k) : [...crit.genres.filter((g) => !inFam.has(g)), k] });
  };
  const q = fold(gq);
  const visible = FAMILIES.map((f) => {
    const famHit = !q || fold(familyDisplay(f.name)).includes(q);
    const subs = subsOf(f.slug).filter((s) => famHit || fold(subShortName(s)).includes(q) || fold(s.name).includes(q));
    return { f, subs, show: famHit || subs.length > 0 };
  }).filter((x) => x.show);

  const addArtist = (a: ArtistSummary) => {
    if (crit.artists.some((x) => fold(x.name) === fold(a.name))) return;
    const one: CustomArtist = { id: a.id, name: a.name, own: true, features: true, collaborators: false, similar: false };
    set({ artists: [...crit.artists, one] });
    setOpenArtist(fold(a.name));
  };
  const patchArtist = (name: string, k: 'own' | 'features' | 'collaborators' | 'similar') => {
    const next = crit.artists.map((a) => {
      if (a.name !== name) return a;
      const flipped = { ...a, [k]: !a[k] };
      if (!flipped.own && !flipped.features && !flipped.collaborators && !flipped.similar) { setNote('Keep at least one option, or remove this artist.'); return a; }
      setNote('');
      return flipped;
    });
    set({ artists: next });
  };
  const pictures = useRef(new Map<string, string | null>());
  for (const a of found.list) pictures.current.set(fold(a.name), a.picture);

  if (!open) return null;
  const running = status.running;
  const eraPct = Math.round(crit.era * 100);
  const eraFill = { ['--from' as string]: `${50 + Math.min(0, eraPct) / 2}%`, ['--to' as string]: `${50 + Math.max(0, eraPct) / 2}%` };
  return (
    <div className="cdisc-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cdisc" role="dialog" aria-modal="true" aria-labelledby={heading} ref={box}>
        <header className="cdisc__head">
          <h2 id={heading}>Customize discovery</h2>
          <button type="button" className="cdisc__close" aria-label="Close custom discovery" title="Close" onClick={onClose}>
            <Glyph name="close" size={16} />
          </button>
        </header>
        <div className="cdisc__body">
          <fieldset className="cdisc__frozen" disabled={running}>
            <p className="cdisc__intro">Choose what to explore. Your taste helps rank matches without excluding genres you select.</p>

            <section className="cdisc__sec" aria-labelledby={`${heading}-g`}>
              <div className="cdisc__sec-head">
                <h3 id={`${heading}-g`}>Genres</h3>
                {crit.genres.length > 0 && <button type="button" className="linkbtn" onClick={() => set({ genres: [] })}>Clear genres</button>}
              </div>
              <p className="cdisc__help">Choose any families or subgenres. Leave empty for no genre filter.</p>
              {crit.genres.length > 0 && (
                <ul className="cdisc__chips" aria-label="Chosen genres">
                  {FAMILIES.map((f) => {
                    const fam = genres.has(famKey(f.slug));
                    const subs = subsOf(f.slug).filter((s) => genres.has(subKey(s.key)));
                    if (!fam && !subs.length) return null;
                    const fc = familyIdentity(f.name)?.color;
                    return (
                      <li key={f.slug} className="cdisc__chipgroup">
                        <span className={`gchip${fam ? ' is-chosen' : ' gchip--context'}`} style={{ ['--c' as string]: fc }}>
                          {familyDisplay(f.name)}
                          {fam && <button type="button" aria-label={`Remove ${familyDisplay(f.name)}`} onClick={() => toggleFamily(f.slug)}><Glyph name="close" size={10} /></button>}
                        </span>
                        {subs.map((s) => (
                          <span key={s.key} className="gchip is-chosen" style={{ ['--c' as string]: subIdentity(s.name)?.color }}>
                            {subShortName(s)}
                            <button type="button" aria-label={`Remove ${subShortName(s)}`} onClick={() => toggleGenre(subKey(s.key))}><Glyph name="close" size={10} /></button>
                          </span>
                        ))}
                      </li>
                    );
                  })}
                </ul>
              )}
              <input className="cdisc__search" type="search" value={gq} placeholder="Search genres or subgenres" aria-label="Search genres or subgenres" onChange={(e) => setGq(e.target.value)} />
              {visible.length === 0 && <p className="cdisc__empty">No matching genres.</p>}
              <ul className="cdisc__fams">
                {visible.map(({ f, subs }) => {
                  const fam = genres.has(famKey(f.slug));
                  const isOpen = Boolean(q) || expanded.has(f.slug);
                  const shown = familyDisplay(f.name);
                  const picked = subsOf(f.slug).filter((s) => genres.has(subKey(s.key))).length;
                  return (
                    <li key={f.slug} className="cdisc__fam">
                      <div className="cdisc__famrow">
                        <label className="cdisc__check">
                          <input type="checkbox" checked={fam} onChange={() => toggleFamily(f.slug)} aria-label={`Select entire family ${shown}`} />
                          <span className="gdot" style={{ ['--c' as string]: familyIdentity(f.name)?.color }} aria-hidden="true" />
                          <span className="cdisc__famname">{shown}</span>
                          {!fam && picked > 0 && <span className="cdisc__count">{picked} chosen</span>}
                        </label>
                        <button type="button" className="cdisc__expand" aria-expanded={isOpen} aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${shown}`}
                          onClick={() => setExpanded((s) => { const n = new Set(s); if (n.has(f.slug)) n.delete(f.slug); else n.add(f.slug); return n; })}>
                          <Glyph name={isOpen ? 'chevron-up' : 'chevron-down'} size={14} />
                        </button>
                      </div>
                      {isOpen && (
                        <ul className="cdisc__subs">
                          {subs.map((s) => (
                            <li key={s.key}>
                              <label className="cdisc__check cdisc__check--sub">
                                <input type="checkbox" checked={fam || genres.has(subKey(s.key))} disabled={fam} onChange={() => toggleGenre(subKey(s.key))} />
                                <span className="gchip" style={{ ['--c' as string]: subIdentity(s.name)?.color }}>{subShortName(s)}</span>
                              </label>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>

            <section className="cdisc__sec" aria-labelledby={`${heading}-a`}>
              <div className="cdisc__sec-head">
                <h3 id={`${heading}-a`}>Artists</h3>
                {crit.artists.length > 0 && <button type="button" className="linkbtn" onClick={() => set({ artists: [] })}>Clear artists</button>}
              </div>
              <p className="cdisc__help">Add artists, then choose how each connects to your discoveries.</p>
              {crit.artists.length > 0 && (
                <ul className="cdisc__artists" aria-label="Chosen artists">
                  {crit.artists.map((a) => {
                    const f = fold(a.name);
                    const isOpen = openArtist === f;
                    const pic = pictures.current.get(f);
                    return (
                      <li key={f} className="cdisc__artist">
                        <div className="cdisc__artistrow">
                          {pic ? <img className="cdisc__pic" src={pic} alt="" /> : <span className="cdisc__pic cdisc__pic--none" aria-hidden="true">{a.name.slice(0, 1)}</span>}
                          <span className="cdisc__aname">{a.name}</span>
                          <button type="button" className="cdisc__include" aria-expanded={isOpen} onClick={() => setOpenArtist(isOpen ? null : f)}>
                            Include <Glyph name={isOpen ? 'chevron-up' : 'chevron-down'} size={12} />
                          </button>
                          <button type="button" className="cdisc__remove" aria-label={`Remove ${a.name}`} title={`Remove ${a.name}`} onClick={() => set({ artists: crit.artists.filter((x) => x !== a) })}>
                            <Glyph name="close" size={14} />
                          </button>
                        </div>
                        {isOpen && (
                          <div className="cdisc__opts" role="group" aria-label={`Include for ${a.name}`}>
                            {([['own', 'Own songs'], ['features', 'Features'], ['collaborators', 'Frequent collaborators'], ['similar', 'Similar artists']] as const).map(([k, label]) => (
                              <label key={k} className="cdisc__check cdisc__opt">
                                <input type="checkbox" checked={a[k]} onChange={() => patchArtist(a.name, k)} />
                                <span>{label}</span>
                              </label>
                            ))}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {note && <p className="cdisc__note" role="status">{note}</p>}
              <input className="cdisc__search" type="search" value={aq} placeholder="Search artists" aria-label="Search artists" onChange={(e) => setAq(e.target.value)} />
              {found.state === 'loading' && <p className="cdisc__empty" role="status">Searching artists{'\u2026'}</p>}
              {found.state === 'failed' && (found.why === 'allowance'
                ? <p className="cdisc__empty" role="status">Today’s download allowance is used up, so artists cannot be searched. Raise it in Settings.</p>
                : <p className="cdisc__empty" role="status">{found.why === 'offline' ? 'Artist search could not connect.' : 'Artist search failed.'} <button type="button" className="linkbtn" onClick={() => setRetry((n) => n + 1)}>Retry</button></p>)}
              {found.state === 'ready' && !found.list.length && <p className="cdisc__empty" role="status">No artists found. Try another name.</p>}
              {found.list.length > 0 && found.state !== 'failed' && (
                <ul className="cdisc__results" aria-label="Artist results">
                  {found.list.map((a) => {
                    const added = crit.artists.some((x) => fold(x.name) === fold(a.name));
                    return (
                      <li key={a.id} className="cdisc__artistrow">
                        {a.picture ? <img className="cdisc__pic" src={a.picture} alt="" /> : <span className="cdisc__pic cdisc__pic--none" aria-hidden="true">{a.name.slice(0, 1)}</span>}
                        <span className="cdisc__aname">{a.name}{a.detail && <small>{a.detail}</small>}</span>
                        <button type="button" className="push cdisc__add" disabled={added} aria-label={added ? `${a.name} added` : `Add ${a.name}`} onClick={() => addArtist(a)}>{added ? 'Added' : 'Add'}</button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <section className="cdisc__sec" aria-labelledby={`${heading}-s`}>
              <h3 id={`${heading}-s`}>Discovery settings</h3>
              <div className="cdisc__slider">
                <div className="cdisc__slider-head"><span>Number of songs</span><output>{crit.count} {crit.count === 1 ? 'song' : 'songs'}</output></div>
                <div className="cdisc__track"><span>1</span>
                  <input type="range" min={1} max={CUSTOM_MAX_SONGS} step={1} value={crit.count} aria-label="Number of songs" aria-valuetext={`${crit.count} songs`}
                    style={{ ['--pct' as string]: `${((crit.count - 1) / (CUSTOM_MAX_SONGS - 1)) * 100}%` }} onChange={(e) => set({ count: Number(e.target.value) })} />
                  <span>100</span></div>
                <p className="cdisc__help">Up to this many matching songs will be added.</p>
              </div>
              <div className="cdisc__slider">
                <div className="cdisc__slider-head"><span>Familiar or adventurous</span><output>Adventure: {Math.round(crit.adventurous * 100)}%</output></div>
                <div className="cdisc__track"><span>Familiar</span>
                  <input type="range" min={0} max={100} step={1} value={Math.round(crit.adventurous * 100)} aria-label="Familiar or adventurous" aria-valuetext={`Adventure ${Math.round(crit.adventurous * 100)}%`}
                    style={{ ['--pct' as string]: `${crit.adventurous * 100}%` }} onChange={(e) => set({ adventurous: Number(e.target.value) / 100 })} />
                  <span>Adventurous</span></div>
              </div>
              <div className="cdisc__slider">
                <div className="cdisc__slider-head"><span>Release era</span><output>{eraLabel(crit.era)}</output>
                  {crit.era !== 0 && <button type="button" className="push cdisc__any" onClick={() => set({ era: 0 })}>Any era</button>}</div>
                <div className="cdisc__track"><span>Older</span>
                  <input className="cdisc__era" type="range" min={-100} max={100} step={1} value={eraPct} aria-label="Release era" aria-valuetext={eraLabel(crit.era)}
                    style={eraFill} onChange={(e) => { const v = Number(e.target.value); set({ era: Math.abs(v) <= 4 ? 0 : v / 100 }); }} />
                  <span>Newer</span></div>
                <p className="cdisc__help">A release-date preference, not a strict year filter.</p>
              </div>
              <button type="button" className="push cdisc__reset" onClick={() => setCrit(normaliseCriteria({ count: Math.min(CUSTOM_MAX_SONGS, defaults.count), adventurous: defaults.adventurous, era: 0 }))}>Reset custom choices</button>
            </section>
          </fieldset>
        </div>
        <footer className="cdisc__foot">
          <p className="cdisc__summary" aria-live="polite">{status.text || customSummary(crit)}</p>
          {running ? (
            <button type="button" className="push push--big cdisc__go" onClick={onStop}>Stop</button>
          ) : (
            <button type="button" className="push push--default push--big cdisc__go" onClick={() => onRun(crit)}>Find {crit.count} {crit.count === 1 ? 'song' : 'songs'}</button>
          )}
        </footer>
      </div>
    </div>
  );
}
